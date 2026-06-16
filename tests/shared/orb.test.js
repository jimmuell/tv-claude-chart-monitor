'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { computeOrbState, parseOrbConfig, toLocalParts, parseTime } = require('../../src/shared/strategies/orb');

// Fixed date: Mon 2026-06-15, America/Chicago = CDT (UTC-5). So UTC = CT + 5.
// ctBar builds a bar at a given Chicago wall-clock time on that date.
const ctBar = (h, m, high, low, close, open = close) => ({
  time: Date.UTC(2026, 5, 15, h + 5, m, 0) / 1000,
  open, high, low, close,
});

const CONFIG = {
  sessionStart: '08:30',
  sessionEnd: '11:00',
  rangeMinutes: 15,           // range window 08:30–08:45
  directionFilter: 'both',
  breakoutBufferTicks: 0,
  timezone: 'America/Chicago',
  tickSize: 0.25,
};

// Range bars (08:30–08:44) establish high=101, low=99.
const rangeBars = () => [
  ctBar(8, 30, 100, 99, 99.5),
  ctBar(8, 35, 101, 99.5, 100.5),
  ctBar(8, 40, 100.5, 99, 100),
];

// ── helpers ────────────────────────────────────────────────────────────────

test('parseTime parses HH:MM with a sensible default', () => {
  assert.deepStrictEqual(parseTime('08:30'), { hour: 8, minute: 30 });
  assert.deepStrictEqual(parseTime(), { hour: 0, minute: 0 });
});

test('toLocalParts converts epoch seconds to Chicago wall-clock', () => {
  // 2026-06-15 14:00 UTC = 09:00 CDT
  const epoch = Date.UTC(2026, 5, 15, 14, 0, 0) / 1000;
  const p = toLocalParts(epoch, 'America/Chicago');
  assert.strictEqual(p.hour, 9);
  assert.strictEqual(p.minute, 0);
  assert.strictEqual(p.day, 15);
  assert.strictEqual(p.month, 6);
});

test('parseOrbConfig fills defaults and reads overrides', () => {
  assert.deepStrictEqual(parseOrbConfig({}), {
    sessionStart: '08:30', sessionEnd: '11:00', rangeMinutes: 15,
    directionFilter: 'both', breakoutBufferTicks: 1,
    timezone: 'America/Chicago', tickSize: 0.25,
  });
  const custom = parseOrbConfig({ orb_session_start: '09:00', orb_direction_filter: 'long_only' });
  assert.strictEqual(custom.sessionStart, '09:00');
  assert.strictEqual(custom.directionFilter, 'long_only');
});

// ── computeOrbState ──────────────────────────────────────────────────────────

test('returns empty state with insufficient candles', () => {
  const s = computeOrbState({ candles: [] }, CONFIG);
  assert.strictEqual(s.phase, 'pre-session');
  assert.strictEqual(s.range, null);
  assert.strictEqual(s.signal, null);
});

test('phase is pre-session before the open', () => {
  const candles = [ctBar(8, 0, 100, 99, 99.5), ctBar(8, 5, 100, 99, 99.5), ctBar(8, 10, 0, 0, 0)];
  const s = computeOrbState({ candles }, CONFIG);
  assert.strictEqual(s.phase, 'pre-session');
  assert.strictEqual(s.range, null);
});

test('phase is in-range during the opening range, no range yet', () => {
  const candles = [ctBar(8, 30, 100, 99, 99.5), ctBar(8, 35, 101, 99.5, 100.5), ctBar(8, 40, 0, 0, 0)];
  const s = computeOrbState({ candles }, CONFIG);
  assert.strictEqual(s.phase, 'in-range');
  assert.strictEqual(s.range, null);
});

test('computes the ORB range and fires a long breakout signal', () => {
  const candles = [
    ...rangeBars(),
    ctBar(8, 45, 102, 101.5, 102),   // closes above range high (101) → long breakout
    ctBar(8, 50, 102, 101, 101.5),   // forming bar (excluded)
  ];
  const s = computeOrbState({ candles }, CONFIG);
  assert.strictEqual(s.phase, 'post-range');
  assert.strictEqual(s.range.high, 101);
  assert.strictEqual(s.range.low, 99);
  assert.ok(s.signal && s.signal.active);
  assert.strictEqual(s.signal.direction, 'long');
  assert.strictEqual(s.signal.entry, 102);
  assert.strictEqual(s.signal.stop, 99);   // range low for a long
});

test('direction filter suppresses an off-direction signal', () => {
  const candles = [
    ...rangeBars(),
    ctBar(8, 45, 102, 101.5, 102),
    ctBar(8, 50, 102, 101, 101.5),
  ];
  const s = computeOrbState({ candles }, { ...CONFIG, directionFilter: 'short_only' });
  assert.strictEqual(s.signal, null);        // long breakout filtered out
  assert.ok(s.breakouts.some((b) => b.direction === 'long')); // still recorded
});

test('flags a confirmation bar after the first breakout', () => {
  const candles = [
    ...rangeBars(),
    ctBar(8, 45, 102, 101.5, 102),   // first breakout
    ctBar(8, 50, 103, 102, 103),     // closes higher → confirmation
    ctBar(8, 55, 103, 102, 102.5),   // forming bar (excluded)
  ];
  const s = computeOrbState({ candles }, CONFIG);
  assert.ok(s.signal && s.signal.active);
  assert.strictEqual(s.signal.direction, 'long');
  assert.strictEqual(s.signal.isConfirmation, true);
});
