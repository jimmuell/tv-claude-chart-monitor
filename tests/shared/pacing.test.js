'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { detectSkippedBars, barSeconds } = require('../../src/shared/pacing');

const T = 1792600000;

test('stepping one bar at a time is never a warning', () => {
  assert.strictEqual(detectSkippedBars(T, T + 60, '1', 4000), null);
  assert.strictEqual(detectSkippedBars(T, T + 300, '5', 4000), null);
});

test('skipping bars warns and says how many were missed', () => {
  const w = detectSkippedBars(T, T + 180, '1', 4000);   // 3 bars advanced
  assert.ok(w, 'should warn');
  assert.strictEqual(w.skipped, 2);
  assert.strictEqual(w.barsAdvanced, 3);
  assert.match(w.message, /2 bars skipped/);
});

test('the warning quotes the measured analysis time and a safe pace', () => {
  const w = detectSkippedBars(T, T + 120, '1', 6000);   // 6s analysis
  assert.strictEqual(w.skipped, 1);
  assert.strictEqual(w.safeSeconds, 9, '50% headroom over 6s');
  assert.match(w.message, /6\.0s/);
  assert.match(w.message, /about 9s per bar/);
});

test('no analysis timing yet still produces a usable warning', () => {
  const w = detectSkippedBars(T, T + 120, '1', null);
  assert.ok(w);
  assert.strictEqual(w.safeSeconds, null);
  assert.match(w.message, /1 bar skipped/);
  assert.doesNotMatch(w.message, /NaN|undefined/);
});

test('going backwards or standing still is not a skip', () => {
  assert.strictEqual(detectSkippedBars(T, T, '1', 4000), null);
  assert.strictEqual(detectSkippedBars(T, T - 300, '1', 4000), null);
});

test('unknown or unparseable timeframes are ignored rather than guessed', () => {
  assert.strictEqual(detectSkippedBars(T, T + 999, '', 4000), null);
  assert.strictEqual(detectSkippedBars(T, T + 999, '3M', 4000), null, 'months vary in length');
  assert.strictEqual(detectSkippedBars(null, T + 120, '1', 4000), null);
});

test('barSeconds understands the resolutions this app uses', () => {
  assert.strictEqual(barSeconds('1'), 60);
  assert.strictEqual(barSeconds('2'), 120);
  assert.strictEqual(barSeconds('5'), 300);
  assert.strictEqual(barSeconds('1D'), 86400);
  assert.strictEqual(barSeconds('30S'), 30);
  assert.strictEqual(barSeconds('4H'), 14400);
  assert.strictEqual(barSeconds('garbage'), null);
});
