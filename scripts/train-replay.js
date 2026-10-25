#!/usr/bin/env node
'use strict';

// train-replay.js — drive TradingView Bar Replay to collect graded calls fast.
//
//   npm run train -- --days 3 --from 2026-10-22 --max-calls 200
//
// For each trading day it seeks replay to the start of the window, then steps
// ONE bar at a time, waiting for the running app to analyse and save that bar
// before stepping again. That wait is the whole point: stepping faster than the
// analysis means bars go by with no call, and the gap is invisible afterwards.
//
// The runner never analyses anything itself. It moves the replay cursor and
// watches the database for the row the app writes, which keeps the two
// processes decoupled — the app's own scheduler does the work it always does.
//
// It never touches orders. The only TradingView calls are replay navigation.
//
// Coded errors: TVCM-TRAIN-NO-CHART, TVCM-TRAIN-NO-REPLAY, TVCM-TRAIN-SEEK-FAILED,
// TVCM-TRAIN-STALLED, TVCM-TRAIN-BARS-SKIPPED.

const path = require('path');
const fs   = require('fs');
const os   = require('os');
const { DatabaseSync } = require('node:sqlite');

const ROOT = path.join(__dirname, '..');
const { createReader } = require(path.join(ROOT, 'src/shared/tv-reader.js'));
const { barSeconds }   = require(path.join(ROOT, 'src/shared/pacing.js'));
const cfg = require(path.join(ROOT, 'config/config.json'));

const DB_PATH = process.env.JOURNAL_DB_PATH
  || path.join(os.homedir(), 'Library/Application Support/trading-analyzer/trades.db');
const STATE_PATH = path.join(os.homedir(), 'Library/Application Support/trading-analyzer/train-state.json');

// ── arguments ────────────────────────────────────────────────────────────────

/** Parse `--flag value` pairs into an object with defaults. */
function parseArgs(argv) {
  const out = {
    days: 1, from: null, maxCalls: 200,
    start: '08:30', end: '11:00',
    barTimeoutMs: 180000,      // how long to wait for one analysis before giving up
    settleBars: 60,            // bars stepped after the window so calls can resolve
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--days')        out.days = Number(next());
    else if (a === '--from')   out.from = next();
    else if (a === '--max-calls') out.maxCalls = Number(next());
    else if (a === '--start')  out.start = next();
    else if (a === '--end')    out.end = next();
    else if (a === '--settle-bars') out.settleBars = Number(next());
    else if (a === '--bar-timeout') out.barTimeoutMs = Number(next()) * 1000;
    else if (a === '--reset')  out.reset = true;
  }
  return out;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Minutes past midnight for "HH:MM". */
function hhmmToMinutes(text) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(text).trim());
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

/** Chicago wall-clock minutes for an epoch-seconds bar time. */
function chicagoMinutes(epochSeconds) {
  const p = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago', hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(new Date(epochSeconds * 1000));
  const h = Number(p.find((x) => x.type === 'hour').value);
  const m = Number(p.find((x) => x.type === 'minute').value);
  return (h % 24) * 60 + m;
}

/** Chicago calendar date (YYYY-MM-DD) for an epoch-seconds bar time. */
function chicagoDate(epochSeconds) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago' })
    .format(new Date(epochSeconds * 1000));
}

// ── resumable state ──────────────────────────────────────────────────────────

/** Days already completed, so a re-run picks up where it stopped. */
function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8')); } catch { return { done: [] }; }
}
function saveState(state) {
  try { fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2)); } catch { /* best effort */ }
}

// ── chart access ─────────────────────────────────────────────────────────────

const EXPR = {
  chart: `(() => { try {
    const c = window.TradingViewApi.activeChart(); const s = c.getSeries();
    const rv = s.isInReplay(); const replay = (rv && typeof rv.value === 'function') ? rv.value() : !!rv;
    const m = s.data().m_bars; const l = m.last();
    return JSON.stringify({ symbol: c.symbol(), timeframe: c.resolution(), replay,
      lastTime: l && l.value && l.value[0], size: m.size() });
  } catch (e) { return JSON.stringify({ _error: String(e) }); } })()`,

  step: `(async () => { try { const ra = await window.TradingViewApi.replayApi();
    ra.doStep(); return 'ok'; } catch (e) { return 'ERR ' + e; } })()`,

  stop: `(async () => { try { const ra = await window.TradingViewApi.replayApi();
    ra.stopReplay(); ra.hideReplayToolbar(); return 'ok'; } catch (e) { return 'ERR ' + e; } })()`,
};

/**
 * UTC offset string ("-05:00"/"-06:00") for a date in Chicago. Computed rather
 * than hardcoded: CDT ends on 1 Nov 2026, and a fixed offset would silently
 * shift the whole training window by an hour after that.
 */
function chicagoOffset(isoDate) {
  const noonUtc = new Date(isoDate + 'T18:00:00Z');       // midday Chicago either way
  const name = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago', timeZoneName: 'longOffset',
  }).formatToParts(noonUtc).find((p) => p.type === 'timeZoneName')?.value || 'GMT-06:00';
  const m = /GMT([+-]\d{2}:\d{2})/.exec(name);
  return m ? m[1] : '-06:00';
}

/** Seek replay to a given Chicago date+time. */
function seekExpr(isoDate, hhmm) {
  // Build the instant in Chicago time, then hand TradingView a Date.
  const offset = chicagoOffset(isoDate);
  return `(async () => { try {
    const ra = await window.TradingViewApi.replayApi();
    const started = (() => { const v = ra.isReplayStarted();
      return (v && typeof v.value === 'function') ? v.value() : !!v; })();
    if (!started) { ra.selectFirstAvailableDate(); await new Promise(r => setTimeout(r, 9000)); }
    ra.selectDate(new Date(${JSON.stringify(isoDate + 'T' + hhmm + ':00' + offset)}));
    return 'ok';
  } catch (e) { return 'ERR ' + e; } })()`;
}

/** Read the chart's identity and replay cursor. */
async function readChart(reader) {
  const raw = await reader.evalPage(EXPR.chart);
  const o = JSON.parse(raw);
  if (o._error) throw new Error(`TVCM-TRAIN-NO-CHART: ${o._error}`);
  return o;
}

// ── database watching ────────────────────────────────────────────────────────

/** Open the journal database read-only; the app remains the writer. */
function openDbRead() {
  const db = new DatabaseSync(DB_PATH, { readOnly: true });
  db.exec('PRAGMA busy_timeout = 5000');
  return db;
}

/** True once the app has saved a call for this exact bar. */
function hasRowFor(symbol, timeframe, barTime) {
  const db = openDbRead();
  try {
    const row = db.prepare(`
      SELECT id, blocked, verdict FROM recommendations
      WHERE symbol = ? AND timeframe = ? AND bar_time = ? AND replay_mode = 1
      ORDER BY id DESC LIMIT 1`).get(symbol, timeframe, barTime);
    return row || null;
  } finally { db.close(); }
}

/** Count replay calls, for the per-day summary. */
function countReplayCalls() {
  const db = openDbRead();
  try { return db.prepare('SELECT COUNT(*) AS n FROM recommendations WHERE replay_mode = 1').get().n; }
  finally { db.close(); }
}

// ── the run ──────────────────────────────────────────────────────────────────

let stopping = false;
process.on('SIGINT', () => {
  if (stopping) process.exit(130);
  stopping = true;
  console.log('\n[train] Ctrl-C — finishing the current bar, then stopping cleanly…');
});

/** One line per bar, so a long run is auditable afterwards. */
function logBar(day, n, barTime, waitedMs, row) {
  // Must be Chicago time — the label says CT, so printing UTC here would make
  // every training log quietly wrong by an hour.
  const t = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago', hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(new Date(barTime * 1000));
  const state = row ? (row.blocked ? `blocked` : row.verdict) : 'NO ROW';
  console.log(`[train] ${day} bar ${String(n).padStart(3)} ${t}CT  waited ${String(waitedMs).padStart(6)}ms  ${state}`);
}

/**
 * Step one bar and wait for the app to save its call. Returns how long the
 * analysis took, or null when it never arrived.
 */
async function stepAndWait(reader, chart, opts, deps = {}) {
  // Dependencies are injectable so the stepping/waiting logic can be tested
  // against a mock reader without TradingView or a database.
  const readChartFn = deps.readChart || readChart;
  const hasRowFn    = deps.hasRow    || hasRowFor;
  const sleepFn     = deps.sleep     || sleep;
  const now         = deps.now       || (() => Date.now());

  const before = await readChartFn(reader);
  await reader.evalPage(EXPR.step);

  // Wait for the cursor to actually advance.
  const cursorDeadline = now() + 30000;
  let after = before;
  while (now() < cursorDeadline) {
    await sleepFn(400);
    after = await readChartFn(reader);
    if (after.lastTime !== before.lastTime) break;
  }
  if (after.lastTime === before.lastTime) {
    return { advanced: false, barTime: before.lastTime, waitedMs: 0, row: null };
  }

  // Then wait for the row the app writes for that bar.
  const started = now();
  const deadline = started + opts.barTimeoutMs;
  let row = null;
  while (now() < deadline && !stopping) {
    row = hasRowFn(chart.symbol, chart.timeframe, after.lastTime);
    if (row) break;
    await sleepFn(500);
  }
  return { advanced: true, barTime: after.lastTime, waitedMs: now() - started, row };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.reset) { saveState({ done: [] }); console.log('[train] state reset'); }
  const state = loadState();

  const reader = createReader(cfg, { info() {}, warn() {}, error() {}, debug() {} });
  await reader.connect();

  const chart0 = await readChart(reader);
  const span = barSeconds(chart0.timeframe);
  if (!span) throw new Error(`TVCM-TRAIN-NO-CHART: unsupported timeframe ${chart0.timeframe}`);
  console.log(`[train] chart ${chart0.symbol} @ ${chart0.timeframe} (${span}s bars)`);
  console.log(`[train] window ${opts.start}–${opts.end} CT, max ${opts.maxCalls} calls`);

  const windowStart = hhmmToMinutes(opts.start);
  const windowEnd   = hhmmToMinutes(opts.end);
  const days = resolveDays(opts);
  const summary = [];
  let totalCalls = 0;

  for (const day of days) {
    if (stopping || totalCalls >= opts.maxCalls) break;
    if (state.done.includes(day)) { console.log(`[train] ${day} already done — skipping`); continue; }

    const dayStartedAt = Date.now();
    const before = countReplayCalls();
    console.log(`[train] === ${day} — seeking to ${opts.start} CT ===`);

    const seek = await reader.evalPage(seekExpr(day, opts.start));
    if (String(seek).startsWith('ERR')) throw new Error(`TVCM-TRAIN-SEEK-FAILED: ${day}: ${seek}`);
    await sleep(14000);

    let chart = await readChart(reader);
    if (!chart.replay) throw new Error('TVCM-TRAIN-NO-REPLAY: replay did not start');

    let n = 0, skipped = 0, stalls = 0;
    // ── window: one bar at a time, waiting for each analysis ──────────────
    while (!stopping && totalCalls < opts.maxCalls) {
      const mins = chicagoMinutes(chart.lastTime);
      const onDay = chicagoDate(chart.lastTime) === day;
      if (onDay && mins >= windowEnd) break;
      if (onDay && mins < windowStart) { await reader.evalPage(EXPR.step); await sleep(1200); chart = await readChart(reader); continue; }

      const res = await stepAndWait(reader, chart, opts);
      if (!res.advanced) {
        console.warn(`[train] TVCM-TRAIN-STALLED: cursor did not advance at ${res.barTime}`);
        break;
      }
      n++;
      if (!res.row) { stalls++; skipped++; }
      else totalCalls++;
      logBar(day, n, res.barTime, res.waitedMs, res.row);
      chart = await readChart(reader);
    }

    // ── settle: step on so open calls can resolve. Bars past the window are
    //    blocked by the window rule, so they do not pollute the allowed set.
    if (!stopping && opts.settleBars > 0) {
      console.log(`[train] ${day} settling (${opts.settleBars} bars, no waiting)`);
      for (let i = 0; i < opts.settleBars && !stopping; i++) {
        await reader.evalPage(EXPR.step);
        await sleep(900);
      }
    }

    const after = countReplayCalls();
    const wall = Math.round((Date.now() - dayStartedAt) / 1000);
    summary.push({ day, bars: n, saved: after - before, skipped, stalls, wallSeconds: wall });
    console.log(`[train] ${day} done — ${n} bars stepped, ${after - before} calls saved, ${skipped} without a row, ${wall}s`);

    if (!stopping) { state.done.push(day); saveState(state); }
  }

  await reader.evalPage(EXPR.stop).catch(() => {});
  await reader.disconnect().catch(() => {});

  console.log('\n[train] ==== summary ====');
  for (const s of summary) {
    console.log(`  ${s.day}: bars=${s.bars} saved=${s.saved} skipped=${s.skipped} wall=${s.wallSeconds}s`);
  }
  console.log(JSON.stringify({ summary, totalCalls, stopped: stopping }));
}

/** Days to run: either --from forwards, or the N most recent weekdays. */
function resolveDays(opts) {
  const out = [];
  if (opts.from) {
    const d = new Date(opts.from + 'T12:00:00Z');
    while (out.length < opts.days) {
      const iso = d.toISOString().slice(0, 10);
      const dow = d.getUTCDay();
      if (dow !== 0 && dow !== 6) out.push(iso);
      d.setUTCDate(d.getUTCDate() + 1);
    }
  } else {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() - 1);
    while (out.length < opts.days) {
      const dow = d.getUTCDay();
      if (dow !== 0 && dow !== 6) out.unshift(d.toISOString().slice(0, 10));
      d.setUTCDate(d.getUTCDate() - 1);
    }
  }
  return out;
}

if (require.main === module) {
  main().catch((err) => { console.error('[train]', err.message); process.exit(1); });
}

module.exports = { parseArgs, hhmmToMinutes, chicagoMinutes, chicagoDate, resolveDays, stepAndWait, chicagoOffset, seekExpr };
