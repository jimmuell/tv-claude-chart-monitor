'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { REPLAY_FLAG_FN } = require('../../src/shared/tv-reader');

// REPLAY_FLAG_FN is a source fragment injected into CDP page expressions, so it
// can't be required directly. Compile it here and hand back the function.
// Safe: REPLAY_FLAG_FN is a module-level string literal in our own source — no
// caller input reaches this, and it is test-only code.
const readReplayFlag = new Function(`${REPLAY_FLAG_FN}\nreturn readReplayFlag;`)();

// TradingView's series.isInReplay() returns a WatchedValue, NOT a boolean.
// Probed shape: { subscribe, unsubscribe, value, when, ownership, ... }.
const watchedValue = (v) => ({
  subscribe() {}, unsubscribe() {}, when() {}, value: () => v,
});

test('reads through the WatchedValue instead of coercing the wrapper', () => {
  // The regression: `!!series.isInReplay()` is true for ANY object, so live
  // mode reported replayMode === true and every prompt said "Mode: REPLAY".
  const liveSeries = { isInReplay: () => watchedValue(false) };
  assert.strictEqual(!!liveSeries.isInReplay(), true, 'sanity: naive coercion is truthy');
  assert.strictEqual(readReplayFlag(liveSeries), false);

  const replaySeries = { isInReplay: () => watchedValue(true) };
  assert.strictEqual(readReplayFlag(replaySeries), true);
});

test('still handles a plain boolean, in case TV changes the shape back', () => {
  assert.strictEqual(readReplayFlag({ isInReplay: () => false }), false);
  assert.strictEqual(readReplayFlag({ isInReplay: () => true }), true);
});

test('defaults to false when the flag is unreadable', () => {
  assert.strictEqual(readReplayFlag(null), false);
  assert.strictEqual(readReplayFlag(undefined), false);
  assert.strictEqual(readReplayFlag({}), false);
  assert.strictEqual(readReplayFlag({ isInReplay: 'not-a-function' }), false);
  assert.strictEqual(readReplayFlag({ isInReplay() { throw new Error('boom'); } }), false);
  assert.strictEqual(readReplayFlag({ isInReplay: () => ({ value() { throw new Error('boom'); } }) }), false);
});
