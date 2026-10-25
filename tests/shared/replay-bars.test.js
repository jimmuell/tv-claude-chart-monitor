'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { READ_BARS_FN } = require('../../src/shared/tv-reader');

// READ_BARS_FN is a source fragment injected into CDP page expressions, so it
// can't be required directly. Compile it here and hand back the function.
// Safe: READ_BARS_FN is a module-level string literal in our own source — no
// caller input reaches this, and it is test-only code.
const readBars = new Function(`${READ_BARS_FN}\nreturn readBars;`)();

// Build a fake TradingView m_bars collection.
//
// Measured shape (TVCM-1-HEALTH probe, TV Desktop 3.4.1, 2026-10-24):
//   size()      => total bar count
//   valueAt(i)  => [time, open, high, low, close, volume] — keyed by BAR INDEX,
//                  not by 0-based position, and null outside the index range.
//   first()     => { index, value }   last() => { index, value }
// Live charts start at bar index 0; in Bar Replay the range is shifted and the
// first index is negative (observed -247..326 for size 574).
function fakeBars(firstIndex, count) {
  const items = [];
  for (let k = 0; k < count; k++) {
    const t = 1792600000 + k * 120;      // 2-minute bars
    items.push([t, 100 + k, 101 + k, 99 + k, 100.5 + k, 1000 + k]);
  }
  const lo = firstIndex;
  const hi = firstIndex + count - 1;
  return {
    size: () => count,
    // null outside the real index range — this is what breaks a 0..size-1 loop.
    valueAt: (i) => (i >= lo && i <= hi ? items[i - lo] : null),
    first: () => ({ index: lo, value: items[0] }),
    last: () => ({ index: hi, value: items[count - 1] }),
    each(cb) { for (let k = 0; k < count; k++) cb(lo + k, items[k]); },
    _items: items,
  };
}

test('reads the most recent bars from a live, zero-based chart', () => {
  const m = fakeBars(0, 300);
  const got = readBars(m, 5);

  assert.strictEqual(got.length, 5, 'should return exactly `want` bars');
  // Last bar must be the newest one in the collection.
  assert.deepStrictEqual(got[got.length - 1], {
    time: 1792600000 + 299 * 120, open: 399, high: 400, low: 398, close: 399.5, volume: 1299,
  });
  // Ascending time order, oldest first.
  for (let i = 1; i < got.length; i++) {
    assert.ok(got[i].time > got[i - 1].time, 'bars must be in ascending time order');
  }
});

test('reads bars in Bar Replay, where the index range is not zero-based', () => {
  // The regression: m_bars is keyed by bar index, so a 0..size-1 loop asks for
  // indices past last().index, valueAt returns null for every one, and the
  // snapshot silently reports zero candles while dataReady is still true.
  const m = fakeBars(-247, 574); // measured replay range: -247..326

  // Sanity: the naive loop really does read nothing here.
  const naive = [];
  for (let i = Math.max(0, m.size() - 5); i < m.size(); i++) {
    const v = m.valueAt(i);
    if (Array.isArray(v)) naive.push(v);
  }
  assert.strictEqual(naive.length, 0, 'sanity: the 0..size-1 loop reads nothing in replay');

  const got = readBars(m, 5);

  assert.strictEqual(got.length, 5, 'should still return 5 bars in replay');
  assert.deepStrictEqual(got[got.length - 1], {
    time: 1792600000 + 573 * 120, open: 673, high: 674, low: 672, close: 673.5, volume: 1573,
  });
  for (let i = 1; i < got.length; i++) {
    assert.ok(got[i].time > got[i - 1].time, 'bars must be in ascending time order');
  }
});

test('reads bars when every index is negative', () => {
  const m = fakeBars(-500, 10); // -500..-491, no non-negative index at all
  const got = readBars(m, 4);

  assert.strictEqual(got.length, 4);
  assert.strictEqual(got[got.length - 1].time, 1792600000 + 9 * 120);
  assert.strictEqual(got[0].time, 1792600000 + 6 * 120);
});

test('returns every available bar when fewer exist than requested', () => {
  const got = readBars(fakeBars(-3, 7), 200);
  assert.strictEqual(got.length, 7);
  assert.strictEqual(got[0].time, 1792600000);
});

test('returns an empty array for an unusable collection instead of throwing', () => {
  assert.deepStrictEqual(readBars(null, 10), []);
  assert.deepStrictEqual(readBars(undefined, 10), []);
  assert.deepStrictEqual(readBars({}, 10), []);
  assert.deepStrictEqual(readBars({ size: () => 5 }, 10), [], 'no valueAt');
  assert.deepStrictEqual(readBars(fakeBars(0, 0), 10), [], 'empty collection');
  assert.deepStrictEqual(
    readBars({ size() { throw new Error('boom'); }, valueAt: () => null }, 10), [],
    'a throwing collection must not propagate',
  );
});

// --- the empty-bar guard -----------------------------------------------------
// readSnapshot() must not hand analysis a silent empty candle array when the
// chart claims its data is loaded. Drive the real method with a stubbed
// evalPage so no CDP connection is needed.
function readerWithPageResult(raw, logged) {
  const { TvReader } = require('../../src/shared/tv-reader');
  const r = new TvReader(
    { tv: { cdpHost: 'localhost', cdpPort: 9222 } },
    { info() {}, warn() {}, error: (m) => logged.push(m), debug() {} },
  );
  r.client = {};                 // readSnapshot only checks truthiness
  r.evalPage = async () => raw;  // stand in for the page expression
  return r;
}

test('flags TVCM-READ-EMPTY-BARS when dataReady is true but no bars were read', async () => {
  const logged = [];
  const r = readerWithPageResult(
    { symbol: 'CME_MINI:MES1!', timeframe: '2', dataReady: true, candles: [], replayMode: true },
    logged,
  );

  const snap = await r.readSnapshot({ barCount: 300 });

  assert.strictEqual(snap.readError, 'TVCM-READ-EMPTY-BARS');
  assert.strictEqual(logged.length, 1, 'should log the coded error exactly once');
  assert.match(logged[0], /TVCM-READ-EMPTY-BARS/);
});

test('does not flag an empty read when the chart data is not ready', async () => {
  const logged = [];
  const r = readerWithPageResult(
    { symbol: 'CME_MINI:MES1!', timeframe: '2', dataReady: false, candles: [] }, logged);

  const snap = await r.readSnapshot({ barCount: 300 });

  assert.strictEqual(snap.readError, undefined, 'a not-ready chart is not a read fault');
  assert.strictEqual(logged.length, 0);
});

test('leaves a healthy snapshot untouched', async () => {
  const logged = [];
  const candles = [{ time: 1, open: 1, high: 2, low: 0, close: 1.5, volume: 10 }];
  const r = readerWithPageResult(
    { symbol: 'CME_MINI:MES1!', timeframe: '2', dataReady: true, candles }, logged);

  const snap = await r.readSnapshot({ barCount: 300 });

  assert.strictEqual(snap.readError, undefined);
  assert.strictEqual(snap.candles.length, 1);
  assert.ok(typeof snap.fetchedAt === 'number', 'fetchedAt is still stamped');
  assert.strictEqual(logged.length, 0);
});
