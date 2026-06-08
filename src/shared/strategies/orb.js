// src/strategies/orb.js
// Opening Range Breakout (ORB) strategy — pure functions, no state.
//
// The module computes the ORB state for the most recently closed bar:
//   - phase: where we are in the trading day relative to the ORB window
//   - range: the ORB high/low (null until the range period is complete)
//   - breakouts[]: all bars that have closed beyond the ORB boundary + buffer
//   - signal: what's actionable on THIS bar (null if nothing new)
//   - levels[]/zones[]: ORB-derived context entries for the shared zone pool
//
// Time is always taken from bar timestamps — never from Date.now(). This makes
// the module deterministic and correct in TradingView replay mode.
//
// Confirmation buffer decision: the buffer is NOT applied to confirmation bars.
// The buffer filters noise at the level; confirmation only needs continued
// directional momentum (close > breakout_close for longs). Applying it twice
// would make confirmations harder to get without meaningful benefit.
//
// Cooldown semantics: this module reports a signal for every breakout bar.
// Suppressing duplicate same-direction signals within a session is delegated
// to filter.js (orb_long / orb_short cooldown). This keeps the separation
// between "what happened" (orb.js) and "should we fire" (filter.js) clean.

'use strict';

// ── timezone helpers ─────────────────────────────────────────────────────────

// Convert epoch seconds to a local-time parts object for the given timezone.
// Returns { year, month (1-12), day, hour (0-23), minute, second }.
function toLocalParts(epochSec, timezone) {
  const d = new Date(epochSec * 1000);
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(d);
  const p = {};
  for (const { type, value } of parts) {
    if (type !== 'literal') p[type] = Number(value);
  }
  // Normalize midnight (some environments return 24 instead of 0).
  if (p.hour === 24) p.hour = 0;
  return p;
}

// Convert a local wall-clock time (year/month/day/hour/minute in the given
// timezone) to epoch seconds. Uses a single-correction approximation that is
// accurate for any time well away from a DST transition — safe for ORB
// sessions (08:30–11:00 CT; DST transitions occur at 02:00).
function localPartsToEpoch(year, month, day, hour, minute, timezone) {
  // Start with the naive UTC interpretation of the local time.
  const naiveMs = Date.UTC(year, month - 1, day, hour, minute, 0);
  // Find what local time the naive UTC corresponds to.
  const local = toLocalParts(naiveMs / 1000, timezone);
  // Compute the offset in minutes between naive local and target local.
  const naiveMin  = (local.day - day) * 24 * 60 + local.hour * 60 + local.minute;
  const targetMin = hour * 60 + minute;
  const corrMs    = (naiveMin - targetMin) * 60 * 1000;
  return (naiveMs - corrMs) / 1000;
}

// ── time parsing ─────────────────────────────────────────────────────────────

function parseTime(str) {
  const parts = String(str || '00:00').split(':');
  return { hour: Number(parts[0]) || 0, minute: Number(parts[1]) || 0 };
}

// Add minutes to a parsed {hour, minute} — does not overflow past 23:59.
function addMinutes(time, minutes) {
  const total = time.hour * 60 + time.minute + minutes;
  return { hour: Math.floor(total / 60), minute: total % 60 };
}

// ── session boundary calculation ─────────────────────────────────────────────

function sessionBoundsForDay(epochSec, config) {
  const tz = config.timezone || 'America/Chicago';
  const p  = toLocalParts(epochSec, tz);
  const { year, month, day } = p;

  const sessionStart = parseTime(config.sessionStart);
  const sessionEnd   = parseTime(config.sessionEnd);
  const rangeEnd     = addMinutes(sessionStart, config.rangeMinutes || 15);

  return {
    sessionStartEpoch: localPartsToEpoch(year, month, day, sessionStart.hour, sessionStart.minute, tz),
    rangeEndEpoch:     localPartsToEpoch(year, month, day, rangeEnd.hour, rangeEnd.minute, tz),
    sessionEndEpoch:   localPartsToEpoch(year, month, day, sessionEnd.hour, sessionEnd.minute, tz),
  };
}

// ── main ─────────────────────────────────────────────────────────────────────

function emptyState() {
  return { phase: 'pre-session', range: null, breakouts: [], signal: null, levels: [], zones: [] };
}

// computeOrbState(snapshot, config) → ORB state object.
//
// snapshot: { candles: [{time, open, high, low, close, volume}], ... }
// config:   { sessionStart, sessionEnd, rangeMinutes, directionFilter,
//             breakoutBufferTicks, timezone, tickSize }
function computeOrbState(snapshot, config) {
  const candles = snapshot.candles || [];
  if (candles.length < 2) return emptyState();

  // Exclude the live forming bar; operate only on closed bars.
  const closedBars  = candles.slice(0, -1);
  const latestClosed = closedBars[closedBars.length - 1];
  if (!latestClosed) return emptyState();

  const tz = config.timezone || 'America/Chicago';
  const { sessionStartEpoch, rangeEndEpoch, sessionEndEpoch } =
    sessionBoundsForDay(latestClosed.time, config);

  // ── phase ──
  const t = latestClosed.time;
  let phase;
  if      (t < sessionStartEpoch) phase = 'pre-session';
  else if (t < rangeEndEpoch)     phase = 'in-range';
  else if (t <= sessionEndEpoch)  phase = 'post-range';
  else                            phase = 'post-window';

  // ── filter to today's bars only (handles weekend/holiday gaps) ──
  const latestParts = toLocalParts(latestClosed.time, tz);
  const todayBars = closedBars.filter(b => {
    const p = toLocalParts(b.time, tz);
    return p.year === latestParts.year && p.month === latestParts.month && p.day === latestParts.day;
  });

  // ── ORB range ──
  const rangeBars = todayBars.filter(b => b.time >= sessionStartEpoch && b.time < rangeEndEpoch);
  let range = null;
  if ((phase === 'post-range' || phase === 'post-window') && rangeBars.length > 0) {
    range = {
      high:      Math.max(...rangeBars.map(b => b.high)),
      low:       Math.min(...rangeBars.map(b => b.low)),
      startTime: rangeBars[0].time,
      endTime:   rangeBars[rangeBars.length - 1].time,
    };
  }

  // ── breakouts and signal ──
  const breakouts = [];
  let   signal    = null;

  if (range) {
    const buffer       = (config.breakoutBufferTicks || 0) * (config.tickSize || 0.25);
    const postRangeBars = todayBars.filter(
      b => b.time >= rangeEndEpoch && b.time <= sessionEndEpoch
    );

    let firstLongBar  = null; // bar of the first long breakout
    let firstShortBar = null;

    for (let i = 0; i < postRangeBars.length; i++) {
      const bar     = postRangeBars[i];
      const prevBar = i > 0 ? postRangeBars[i - 1] : null;

      // Confirmation: bar immediately after the first breakout, closes further.
      const isLongConfirm  = !!(firstLongBar  && prevBar && prevBar.time === firstLongBar.time  && bar.close > firstLongBar.close);
      const isShortConfirm = !!(firstShortBar && prevBar && prevBar.time === firstShortBar.time && bar.close < firstShortBar.close);

      if (isLongConfirm) {
        breakouts.push({ time: bar.time, direction: 'long',  closePrice: bar.close, isConfirmation: true });
      } else if (bar.close > range.high + buffer) {
        breakouts.push({ time: bar.time, direction: 'long',  closePrice: bar.close, isConfirmation: false });
        if (!firstLongBar) firstLongBar = bar;
      }

      if (isShortConfirm) {
        breakouts.push({ time: bar.time, direction: 'short', closePrice: bar.close, isConfirmation: true });
      } else if (bar.close < range.low - buffer) {
        breakouts.push({ time: bar.time, direction: 'short', closePrice: bar.close, isConfirmation: false });
        if (!firstShortBar) firstShortBar = bar;
      }
    }

    // Signal: is the current (latest closed) bar a breakout?
    const currentBreakout = breakouts.find(b => b.time === latestClosed.time);
    if (currentBreakout) {
      const dir           = currentBreakout.direction;
      const filterAllows  =
        config.directionFilter === 'both' ||
        (config.directionFilter === 'long_only'  && dir === 'long') ||
        (config.directionFilter === 'short_only' && dir === 'short');

      if (filterAllows) {
        const rangeSize = range.high - range.low;
        signal = {
          active:         true,
          direction:      dir,
          isConfirmation: currentBreakout.isConfirmation,
          closePrice:     currentBreakout.closePrice,
          entry:          currentBreakout.closePrice,
          stop:           dir === 'long' ? range.low : range.high,
          target:         dir === 'long' ? range.high + rangeSize : range.low - rangeSize,
          reason:         currentBreakout.isConfirmation
            ? `ORB ${dir} confirmed by follow-through`
            : `ORB ${dir} breakout — watching for confirmation`,
        };
      }
    }
  }

  // ── ORB-derived levels and zones ──
  const levels = [];
  const zones  = [];
  if (range) {
    const rangeEnd = addMinutes(parseTime(config.sessionStart), config.rangeMinutes || 15);
    const rangeEndStr = `${String(rangeEnd.hour).padStart(2, '0')}:${String(rangeEnd.minute).padStart(2, '0')}`;
    const zoneLabel = `Opening Range ${config.sessionStart}–${rangeEndStr}`;

    levels.push({ kind: 'resistance', price: range.high, label: 'ORB high' });
    levels.push({ kind: 'support',    price: range.low,  label: 'ORB low'  });
    zones.push({ kind: 'opening_range', low: range.low, high: range.high, label: zoneLabel });
  }

  return { phase, range, breakouts, signal, levels, zones };
}

// parseOrbConfig: maps raw TVCM inputs (from orbStudy.inputs in context.js)
// into the normalized config object for computeOrbState.
function parseOrbConfig(inputs, tickSize = 0.25) {
  return {
    sessionStart:       String(inputs.orb_session_start         || '08:30'),
    sessionEnd:         String(inputs.orb_session_end           || '11:00'),
    rangeMinutes:       Number(inputs.orb_range_minutes)        || 15,
    directionFilter:    String(inputs.orb_direction_filter      || 'both'),
    breakoutBufferTicks:Number(inputs.orb_breakout_buffer_ticks)|| 1,
    timezone:           String(inputs.orb_timezone              || 'America/Chicago'),
    tickSize,
  };
}

module.exports = { computeOrbState, parseOrbConfig, toLocalParts, parseTime };
