'use strict';

const test = require('node:test');
const assert = require('node:assert');
const {
  classifySingle,
  classifyPair,
  classifyTriple,
  classifyLatest,
  isNotable,
} = require('../../src/shared/patterns');

// Helper: build a candle.
const C = (open, high, low, close, time = 0) => ({ time, open, high, low, close });

// ── classifySingle ──────────────────────────────────────────────────────────

test('classifySingle tags direction bullish / bearish / flat', () => {
  assert.ok(classifySingle(C(10, 11, 9, 10.5)).tags.includes('bullish'));
  assert.ok(classifySingle(C(10, 11, 9, 9.5)).tags.includes('bearish'));
  assert.ok(classifySingle(C(10, 11, 9, 10)).tags.includes('flat'));
});

test('classifySingle flags zero-range candle', () => {
  const r = classifySingle(C(10, 10, 10, 10));
  assert.ok(r.tags.includes('zero-range'));
});

test('classifySingle detects a doji (tiny body relative to range)', () => {
  const r = classifySingle(C(10, 11, 9, 10.05));
  assert.ok(r.tags.includes('doji'));
});

test('classifySingle detects dragonfly doji (long lower wick, no upper)', () => {
  const r = classifySingle(C(10, 10.05, 8, 10.02));
  assert.ok(r.tags.includes('doji'));
  assert.ok(r.tags.includes('dragonfly-doji'));
});

test('classifySingle detects a hammer (bull, long lower wick, small upper)', () => {
  const r = classifySingle(C(10, 10.25, 9, 10.2));
  assert.ok(r.tags.includes('hammer'));
});

test('classifySingle detects a shooting star (bear, long upper wick, small lower)', () => {
  const r = classifySingle(C(10, 11, 9.75, 9.8));
  assert.ok(r.tags.includes('shooting-star'));
});

test('classifySingle detects a bullish marubozu (near-full body)', () => {
  const r = classifySingle(C(10, 11.02, 9.98, 11));
  assert.ok(r.tags.includes('bullish-marubozu'));
});

test('classifySingle flags pin bars by wick ratio', () => {
  assert.ok(classifySingle(C(10, 10.25, 9, 10.2)).tags.includes('bullish-pin-bar'));
  assert.ok(classifySingle(C(10, 11, 9.75, 9.8)).tags.includes('bearish-pin-bar'));
});

// ── classifyPair ──────────────────────────────────────────────────────────

test('classifyPair detects bullish engulfing', () => {
  const prev = C(10, 10.5, 7.5, 8);   // bear body 10→8
  const curr = C(7, 11, 6.5, 11);     // bull body engulfs prev body
  assert.ok(classifyPair(prev, curr).includes('bullish-engulfing'));
});

test('classifyPair detects bearish engulfing', () => {
  const prev = C(8, 10.5, 7.5, 10);   // bull body 8→10
  const curr = C(11, 11.5, 6.5, 7);   // bear body engulfs prev body
  assert.ok(classifyPair(prev, curr).includes('bearish-engulfing'));
});

test('classifyPair detects inside and outside bars', () => {
  const prev = C(10, 12, 8, 11);
  const inside = C(10.5, 11.5, 8.5, 11);
  const outside = C(10, 13, 7, 11);
  assert.ok(classifyPair(prev, inside).includes('inside-bar'));
  assert.ok(classifyPair(prev, outside).includes('outside-bar'));
});

test('classifyPair detects tweezer bottom (matching lows, bear then bull)', () => {
  const prev = C(10, 10.5, 8, 9);     // bear, low 8
  const curr = C(9, 10.5, 8, 10);     // bull, low 8
  assert.ok(classifyPair(prev, curr).includes('tweezer-bottom'));
});

// ── classifyTriple ──────────────────────────────────────────────────────────

test('classifyTriple detects three white soldiers', () => {
  const a = C(10, 11.2, 9.9, 11);
  const b = C(10.5, 12.2, 10.4, 12);
  const c = C(11.5, 13.2, 11.4, 13);
  assert.ok(classifyTriple(a, b, c).includes('three-white-soldiers'));
});

test('classifyTriple detects a morning star', () => {
  const a = C(12, 12.1, 9.9, 10);     // bear, mid = 11
  const b = C(9.9, 10.0, 9.7, 9.95);  // small body
  const c = C(10, 11.6, 9.9, 11.5);   // bull closing above a's midpoint
  assert.ok(classifyTriple(a, b, c).includes('morning-star'));
});

// ── classifyLatest + isNotable ──────────────────────────────────────────────

test('classifyLatest returns null on empty input and merges tags otherwise', () => {
  assert.strictEqual(classifyLatest([]), null);
  const candles = [C(12, 12.1, 9.9, 10), C(9.9, 10, 9.7, 9.95), C(10, 11.6, 9.9, 11.5)];
  const r = classifyLatest(candles);
  assert.ok(r.tags.includes('morning-star'));      // from triple
  assert.ok(Array.isArray(r.pairTags));
  assert.ok(Array.isArray(r.tripleTags));
});

test('isNotable is true for a hammer, false for a plain bullish candle', () => {
  assert.strictEqual(isNotable(classifySingle(C(10, 10.25, 9, 10.2))), true);
  assert.strictEqual(isNotable(classifySingle(C(10, 11, 9, 10.5))), false);
  assert.strictEqual(isNotable(null), false);
});
