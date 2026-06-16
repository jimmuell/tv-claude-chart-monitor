'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { detectSwingPivots, roundToTick } = require('../../src/shared/detectors/swing-pivots');

// Helper: candle with explicit high/low (open/close don't affect pivot logic).
const C = (high, low, time) => ({ time, open: low, high, low, close: high });

// A series with three swing-high pivots clustered near 100 and two swing-low
// pivots near 94 (below the default minTouches of 3 so they don't qualify).
function clusteredSeries() {
  return [
    C(98, 95, 1),
    C(100, 96, 2),     // swing high (100)
    C(97, 94, 3),      // swing low (94)
    C(100.25, 96, 4),  // swing high (100.25)
    C(97, 94, 5),      // swing low (94)
    C(99.75, 96, 6),   // swing high (99.75)
    C(98, 95, 7),
  ];
}

test('returns [] for empty or too-short input', () => {
  assert.deepStrictEqual(detectSwingPivots([]), []);
  assert.deepStrictEqual(detectSwingPivots([C(100, 99, 1), C(101, 100, 2)]), []);
});

test('returns [] for a flat / monotonic series with no local extrema', () => {
  const rising = Array.from({ length: 10 }, (_, i) => C(100 + i, 99 + i, i));
  assert.deepStrictEqual(detectSwingPivots(rising), []);
});

test('detects a 3-touch resistance cluster near 100', () => {
  const res = detectSwingPivots(clusteredSeries());
  const resistance = res.find((r) => r.kind === 'resistance');
  assert.ok(resistance, 'expected a resistance cluster');
  assert.strictEqual(resistance.touchCount, 3);
  assert.ok(Math.abs(resistance.price - 100) <= 0.5, `price ${resistance.price} ~ 100`);
  assert.ok(resistance.firstTouchTime < resistance.lastTouchTime);
});

test('minTouches gate excludes the 2-touch support cluster by default', () => {
  const res = detectSwingPivots(clusteredSeries());
  assert.ok(!res.some((r) => r.kind === 'support'), 'support has only 2 touches — should be excluded');
});

test('lowering minTouches to 2 admits the support cluster', () => {
  const res = detectSwingPivots(clusteredSeries(), { minTouches: 2 });
  const support = res.find((r) => r.kind === 'support');
  assert.ok(support, 'expected support cluster at minTouches=2');
  assert.strictEqual(support.touchCount, 2);
});

test('tolerance controls clustering width', () => {
  // Two highs 1.0 apart: within 4 ticks (1.0) they merge; with 1 tick (0.25) they don't.
  const series = [
    C(98, 95, 1), C(100, 96, 2), C(97, 94, 3), C(101, 96, 4), C(97, 94, 5),
    C(100.0, 96, 6), C(98, 95, 7),
  ];
  const wide = detectSwingPivots(series, { minTouches: 2, toleranceTicks: 8 });
  assert.ok(wide.some((r) => r.kind === 'resistance' && r.touchCount >= 2));
  const tight = detectSwingPivots(series, { minTouches: 3, toleranceTicks: 1 });
  assert.ok(!tight.some((r) => r.kind === 'resistance'), 'tight tolerance should not reach 3 touches');
});

test('roundToTick snaps to the nearest tick', () => {
  assert.strictEqual(roundToTick(100.13, 0.25), 100.25);
  assert.strictEqual(roundToTick(100.10, 0.25), 100.0);
  assert.strictEqual(roundToTick(99.99, 0.25), 100.0);
});
