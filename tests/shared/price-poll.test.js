'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { PRICE_POLL_EXPR } = require('../../src/shared/tv-reader');

// PRICE_POLL_EXPR is the real page expression the alert poller evaluates over
// CDP. Compile it here with a fake `window` so the production string itself is
// under test, not a copy of it.
// Safe: PRICE_POLL_EXPR is a module-level string literal in our own source — no
// caller input reaches this, and it is test-only code.
const runPoll = (win) => new Function('window', `return ${PRICE_POLL_EXPR};`)(win);

// Fake TradingView m_bars. Measured shape (TVCM-1/TVCM-2, TV Desktop 3.4.1):
// valueAt() is keyed by BAR INDEX and returns null outside the real range.
// Live charts start at index 0; in Bar Replay the range is shifted and the
// first index is negative (measured -235..299 live).
function fakeBars(firstIndex, count) {
  const items = [];
  for (let k = 0; k < count; k++) {
    items.push([1792600000 + k * 120, 100 + k, 101 + k, 99 + k, 100.5 + k, 1000 + k]);
  }
  const lo = firstIndex;
  const hi = firstIndex + count - 1;
  return {
    size: () => count,
    valueAt: (i) => (i >= lo && i <= hi ? items[i - lo] : null),
    first: () => ({ index: lo, value: items[0] }),
    last: () => ({ index: hi, value: items[count - 1] }),
  };
}

function fakeWindow(bars, symbol = 'CME_MINI:MES1!') {
  return {
    TradingViewApi: {
      activeChart: () => ({
        symbol: () => symbol,
        getSeries: () => ({ data: () => ({ m_bars: bars }) }),
      }),
    },
  };
}

test('reads the newest price on a live, zero-based chart', () => {
  const got = runPoll(fakeWindow(fakeBars(0, 300)));

  // close of the last bar: 100.5 + 299
  assert.strictEqual(got.price, 399.5);
  assert.strictEqual(got.symbol, 'CME_MINI:MES1!');
});

test('reads the newest price in Bar Replay, where indices run negative to positive', () => {
  // The regression: the poller used bars.valueAt(bars.size() - 1). With a
  // shifted range that index is past last().index, valueAt returns null,
  // last[4] throws, and the catch returned null — so price-crossing alerts
  // silently stopped firing for the whole of replay.
  const bars = fakeBars(-235, 535); // measured live replay range: -235..299

  // Sanity: the old lookup really does fail on this shape.
  assert.strictEqual(bars.valueAt(bars.size() - 1), null,
    'sanity: valueAt(size-1) is out of range in replay');

  const got = runPoll(fakeWindow(bars));

  assert.ok(got, 'poller must return a result in replay, not null');
  assert.strictEqual(got.price, 100.5 + 534, 'must be the close of the newest bar');
  assert.strictEqual(got.symbol, 'CME_MINI:MES1!');
});

test('reads the newest price when every bar index is negative', () => {
  const got = runPoll(fakeWindow(fakeBars(-400, 10)));

  assert.ok(got, 'poller must return a result');
  assert.strictEqual(got.price, 100.5 + 9);
});

test('reports TVCM-ALERT-NO-BAR when the chart is readable but no bar can be read', () => {
  // Chart and series resolve, but the bar collection yields nothing. That is a
  // read fault and must be named, not silently skipped.
  const got = runPoll(fakeWindow(fakeBars(0, 0)));

  assert.ok(got, 'must not return null for a readable chart with no bars');
  assert.strictEqual(got.error, 'TVCM-ALERT-NO-BAR');
  assert.strictEqual(got.price, undefined);
});

test('returns null when TradingView is not reachable at all', () => {
  // Not a read fault — the app polls every 5s and TV may simply not be running.
  // This must stay a quiet skip so the log is not flooded.
  assert.strictEqual(runPoll({}), null, 'no TradingViewApi');
  assert.strictEqual(runPoll({ TradingViewApi: { activeChart: () => null } }), null,
    'activeChart() returned null');
});
