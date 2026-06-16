'use strict';

const test = require('node:test');
const assert = require('node:assert');
const {
  sma,
  detectTrend,
  nearestZone,
  zoneInteraction,
  dedupZones,
  normalizeZones,
  buildContext,
} = require('../../src/shared/context');

const C = (open, high, low, close, time = 0) => ({ time, open, high, low, close });

// ── sma ──────────────────────────────────────────────────────────────────

test('sma averages the last N closes; null when too few', () => {
  const candles = [C(0, 0, 0, 1), C(0, 0, 0, 2), C(0, 0, 0, 3)];
  assert.strictEqual(sma(candles, 3), 2);
  assert.strictEqual(sma(candles, 5), null);
});

// ── detectTrend ──────────────────────────────────────────────────────────

const series = (closes) => closes.map((c, i) => C(c, c + 0.5, c - 0.5, c, i));

test('detectTrend reports "unknown" without enough data', () => {
  assert.strictEqual(detectTrend(series([1, 2, 3]), 20).trend, 'unknown');
});

test('detectTrend reports "up" for a rising series', () => {
  assert.strictEqual(detectTrend(series([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]), 3).trend, 'up');
});

test('detectTrend reports "down" for a falling series', () => {
  assert.strictEqual(detectTrend(series([10, 9, 8, 7, 6, 5, 4, 3, 2, 1]), 3).trend, 'down');
});

test('detectTrend reports "sideways" for a flat series', () => {
  assert.strictEqual(detectTrend(series([5, 5, 5, 5, 5, 5, 5, 5, 5, 5]), 3).trend, 'sideways');
});

// ── nearestZone ──────────────────────────────────────────────────────────

test('nearestZone returns the closest zone by edge distance', () => {
  const zones = [{ id: 'a', lo: 90, hi: 91 }, { id: 'b', lo: 100, hi: 101 }];
  const r = nearestZone(95, zones);
  assert.strictEqual(r.zone.id, 'a');
  assert.strictEqual(r.distance, 4);
  assert.strictEqual(nearestZone(100.5, zones).distance, 0); // inside b
  assert.strictEqual(nearestZone(95, []), null);
});

// ── zoneInteraction ──────────────────────────────────────────────────────

test('zoneInteraction classifies the closed bar vs a zone', () => {
  const zone = { lo: 100, hi: 102 };
  assert.strictEqual(zoneInteraction(C(0, 0, 0, 99), C(0, 0, 0, 101), zone), 'inside');
  assert.strictEqual(zoneInteraction(C(0, 0, 0, 99), C(0, 0, 0, 103), zone), 'broke_up');
  assert.strictEqual(zoneInteraction(C(0, 0, 0, 103), C(0, 0, 0, 99), zone), 'broke_down');
  // rejected_top: wick into/above zone but close back below the midpoint
  assert.strictEqual(zoneInteraction(C(0, 0, 0, 101), C(99, 102.5, 99, 99.5), zone), 'rejected_top');
  // rejected_bottom: wick below zone but close back above the midpoint
  assert.strictEqual(zoneInteraction(C(0, 0, 0, 101), C(102, 102.6, 99.5, 102.5), zone), 'rejected_bottom');
  // none: stays above with no interaction
  assert.strictEqual(zoneInteraction(C(0, 0, 0, 105), C(105, 106.5, 104, 106), zone), 'none');
});

// ── dedupZones (cross-source priority) ────────────────────────────────────

test('dedupZones keeps the higher-priority source within tolerance', () => {
  const zones = [
    { id: 'd', price: 100, source: 'drawing' },
    { id: 't', price: 100.1, source: 'tvcm' },
  ];
  const out = dedupZones(zones, 0.5);
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].source, 'tvcm');
});

test('dedupZones keeps same-source duplicates and out-of-tolerance zones', () => {
  const sameSource = dedupZones(
    [{ price: 100, source: 'drawing' }, { price: 100, source: 'drawing' }], 0.5);
  assert.strictEqual(sameSource.length, 2);
  const farApart = dedupZones(
    [{ price: 100, source: 'drawing' }, { price: 105, source: 'tvcm' }], 0.5);
  assert.strictEqual(farApart.length, 2);
});

// ── normalizeZones ─────────────────────────────────────────────────────────

test('normalizeZones converts drawings (line + rectangle)', () => {
  const drawings = [
    { id: 'l1', type: 'horizontal_line', points: [{ price: 100 }] },
    { id: 'r1', type: 'rectangle', points: [{ price: 105 }, { price: 107 }] },
  ];
  const zones = normalizeZones(drawings, 0.25);
  const line = zones.find((z) => z.id === 'l1');
  const rect = zones.find((z) => z.id === 'r1');
  assert.strictEqual(line.kind, 'level');
  assert.strictEqual(line.price, 100);
  assert.strictEqual(rect.lo, 105);
  assert.strictEqual(rect.hi, 107);
  assert.strictEqual(rect.price, 106);
});

test('normalizeZones merges TVCM levels and dedups a coincident drawing', () => {
  const drawings = [{ id: 'l1', type: 'horizontal_line', points: [{ price: 100 }] }];
  const tvcm = [{ id: 's1', levels: [{ n: 1, kind: 'resistance', price: 100 }], zones: [] }];
  const zones = normalizeZones(drawings, 0.25, tvcm);
  // drawing@100 and tvcm@100 are within the 2-tick default tolerance → tvcm wins
  assert.strictEqual(zones.length, 1);
  assert.strictEqual(zones[0].source, 'tvcm');
  assert.strictEqual(zones[0].kind, 'resistance');
});

// ── buildContext integration ──────────────────────────────────────────────

test('buildContext returns a populated context object', () => {
  const candles = series(Array.from({ length: 30 }, (_, i) => 100 + i)); // rising
  const snapshot = { symbol: 'MES', timeframe: '1', candles, drawings: [] };
  const ctx = buildContext(snapshot, { maPeriod: 20 });
  assert.ok(ctx);
  assert.strictEqual(ctx.symbol, 'MES');
  assert.strictEqual(ctx.closedBar, candles[candles.length - 2]); // last is forming
  assert.ok(Array.isArray(ctx.zones));
  assert.ok(Array.isArray(ctx.candidateLevels));
  assert.ok(ctx.classification && Array.isArray(ctx.classification.tags));
  assert.strictEqual(typeof ctx.notable, 'boolean');
  assert.strictEqual(ctx.trend.trend, 'up');
});

test('buildContext returns null with fewer than 2 candles', () => {
  assert.strictEqual(buildContext({ symbol: 'X', timeframe: '1', candles: [C(0, 0, 0, 1)] }), null);
});
