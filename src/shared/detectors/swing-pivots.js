// detectors/swing-pivots.js
// Phase 4b.2 — emerging-level detector. Pure function: given a list of closed
// candles, return clusters of 3-bar swing pivots that repeated at (≈) the same
// price. The filter consumes the result and decides whether to fire a
// "💡 suggest a level" event to nudge the trader to draw a horizontal line.
//
// Deliberately simple algorithm — phase 4c will refine (volume weight,
// recency decay, breakout invalidation). Cf. design handoff
// docs/handoff/2026-05-10-phase-4b-design.md § "Sub-sprint 4b.2 — Swing-pivot
// detection algorithm" for the contract.

'use strict';

/**
 * Detect swing-pivot price clusters in a candle series.
 *
 * A "swing pivot high" is a bar whose high is strictly greater than the
 * highs of its immediate neighbours (a 3-bar swing). Pivot lows mirror this.
 * Pivots that fall within `toleranceTicks * tickSize` of each other are
 * grouped into a cluster. Clusters with at least `minTouches` distinct pivots
 * are returned as candidate levels.
 *
 * The caller is expected to pass only CLOSED bars — a forming/live bar can
 * produce a transient pivot that disappears the moment the next tick prints.
 * In context.js this maps to `candles.slice(0, -1)`.
 *
 * @param {Array<{time:number, open:number, high:number, low:number, close:number}>} candles
 * @param {object} [opts]
 * @param {number} [opts.lookback=50]       bars from the tail of candles to scan
 * @param {number} [opts.minTouches=3]      minimum pivot count to qualify
 * @param {number} [opts.toleranceTicks=4]  cluster radius in ticks
 * @param {number} [opts.tickSize=0.25]     instrument tick size (MES = 0.25)
 * @returns {Array<{
 *   kind: 'support'|'resistance',
 *   price: number,
 *   touchCount: number,
 *   firstTouchTime: number,
 *   lastTouchTime: number,
 *   strength: number
 * }>}
 */
function detectSwingPivots(candles, opts = {}) {
  const lookback       = opts.lookback       || 50;
  const minTouches     = opts.minTouches     || 3;
  const toleranceTicks = opts.toleranceTicks || 4;
  const tickSize       = opts.tickSize       || 0.25;

  if (!Array.isArray(candles) || candles.length < 3) return [];

  const recent = candles.slice(-lookback);

  // 1. Find local extrema (3-bar swing). i in [1, recent.length-2] inclusive
  //    so both neighbours exist.
  const pivots = [];
  for (let i = 1; i < recent.length - 1; i++) {
    const prev = recent[i - 1];
    const curr = recent[i];
    const next = recent[i + 1];
    if (curr.high > prev.high && curr.high > next.high) {
      pivots.push({ kind: 'high', price: curr.high, time: curr.time });
    }
    if (curr.low < prev.low && curr.low < next.low) {
      pivots.push({ kind: 'low', price: curr.low, time: curr.time });
    }
  }

  // 2. Cluster pivots within tolerance. priceMean is recomputed each merge so
  //    a long chain of touches drifts naturally toward the centroid.
  const tolerance = toleranceTicks * tickSize;
  const clusters = [];
  for (const p of pivots) {
    const matched = clusters.find(
      (c) => c.kind === p.kind && Math.abs(c.priceMean - p.price) <= tolerance
    );
    if (matched) {
      matched.touches.push(p);
      const sum = matched.touches.reduce((s, t) => s + t.price, 0);
      matched.priceMean = sum / matched.touches.length;
    } else {
      clusters.push({ kind: p.kind, priceMean: p.price, touches: [p] });
    }
  }

  // 3. Filter and project. Round priceMean to nearest tick so downstream
  //    label/dedup math doesn't deal with fractional sub-ticks.
  return clusters
    .filter((c) => c.touches.length >= minTouches)
    .map((c) => ({
      kind: c.kind === 'high' ? 'resistance' : 'support',
      price: roundToTick(c.priceMean, tickSize),
      touchCount: c.touches.length,
      firstTouchTime: Math.min(...c.touches.map((t) => t.time)),
      lastTouchTime:  Math.max(...c.touches.map((t) => t.time)),
      strength: c.touches.length, // v1: simple count. v2 may weight by recency.
    }));
}

function roundToTick(price, tickSize) {
  return Math.round(price / tickSize) * tickSize;
}

module.exports = { detectSwingPivots, roundToTick };
