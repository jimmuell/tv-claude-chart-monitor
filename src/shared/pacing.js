'use strict';
// pacing.js
//
// Detects when Bar Replay is being stepped by hand faster than the analysis can
// keep up. Each analysis takes seconds (an LLM round trip); if Jim steps two
// bars in that time the app never sees the bar in between, so that bar produces
// no call and the scorecard silently has a hole in it.
//
// A skipped bar is invisible by nature — nothing errors, the panel just shows
// the newer bar — so it has to be inferred by comparing consecutive analysed
// bar times against the timeframe.

/** Bar length in seconds for a TradingView resolution string ("1", "5", "1D"). */
function barSeconds(timeframe) {
  const tf = String(timeframe ?? '').trim().toUpperCase();
  if (/^\d+$/.test(tf)) return Number(tf) * 60;          // minutes
  const m = /^(\d+)([SHDWM])$/.exec(tf);
  if (!m) return null;
  const n = Number(m[1]);
  switch (m[2]) {
    case 'S': return n;
    case 'H': return n * 3600;
    case 'D': return n * 86400;
    case 'W': return n * 604800;
    default:  return null;                                // months vary
  }
}

/**
 * Compare two consecutive analysed bars. Returns null when pacing is fine, or a
 * warning describing how many bars were missed and how slowly to step.
 */
function detectSkippedBars(prevBarTime, currBarTime, timeframe, analysisMs) {
  const span = barSeconds(timeframe);
  if (!span || typeof prevBarTime !== 'number' || typeof currBarTime !== 'number') return null;
  if (currBarTime <= prevBarTime) return null;            // same bar, or went backwards

  const barsAdvanced = Math.round((currBarTime - prevBarTime) / span);
  if (barsAdvanced <= 1) return null;                     // stepped one bar: correct

  const skipped = barsAdvanced - 1;
  // Leave 50% headroom over the measured analysis time; an LLM call is variable.
  const safeSeconds = typeof analysisMs === 'number' && analysisMs > 0
    ? Math.ceil((analysisMs * 1.5) / 1000)
    : null;

  return {
    skipped,
    barsAdvanced,
    analysisMs: typeof analysisMs === 'number' ? analysisMs : null,
    safeSeconds,
    message:
      `Replay is moving faster than analysis: ${skipped} bar${skipped === 1 ? '' : 's'} skipped `
      + `with no call recorded.`
      + (safeSeconds
          ? ` The last analysis took ${(analysisMs / 1000).toFixed(1)}s — wait about ${safeSeconds}s per bar.`
          : ''),
  };
}

module.exports = { detectSkippedBars, barSeconds };
