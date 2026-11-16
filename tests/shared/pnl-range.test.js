'use strict';

// Combining several trading days in the Order History & P&L window.
//
// The rule that is not negotiable: a combined total is the SUM of each day's
// statement-matching session total. FIFO is never re-run across days — the per-day
// figures are what AMP reports, and they must add up exactly.

const { test, before } = require('node:test');
const assert = require('node:assert');
const path   = require('path');
const url    = require('url');

let r;
before(async () => {
  r = await import(url.pathToFileURL(path.join(__dirname, '../../src/shared/pnl-range.mjs')).href);
});

/** A session list item shaped like the engine's, with overridable fields. */
function day(date, net, over = {}) {
  return {
    sessionDate: date, netPnl: net, grossPnl: net + 6, fees: 6,
    contractSides: 10, tradeCount: 2, openPositionAtEnd: 0, ...over,
  };
}

/** The real shape of Jim's two days, used by the acceptance check. */
const FRI = day('2026-11-13', 896.65, { grossPnl: 1296.25, fees: 399.60, contractSides: 666, tradeCount: 71 });
const MON = day('2026-11-16', 514.15, { grossPnl: 673.75,  fees: 159.60, contractSides: 266, tradeCount: 133 });

// ── Which days a period covers ────────────────────────────────────────────

test('Today is just today, even when today has no data yet', () => {
  assert.deepStrictEqual(r.rangeFor('today', { today: '2026-11-16', available: [] }).dates, ['2026-11-16']);
  assert.deepStrictEqual(r.rangeFor('today', { today: '2026-11-16', available: ['2026-11-13', '2026-11-16'] }).dates,
    ['2026-11-16']);
});

test('Last 2 days crosses the weekend, because it counts TRADING days', () => {
  // Friday 13th and Monday 16th are consecutive trading days; Sat and Sun are not days.
  const got = r.rangeFor('last2', { today: '2026-11-16', available: ['2026-11-11', '2026-11-12', '2026-11-13', '2026-11-16'] });
  assert.deepStrictEqual(got.dates, ['2026-11-13', '2026-11-16']);
  assert.strictEqual(got.from, '2026-11-13');
  assert.strictEqual(got.to, '2026-11-16');
});

test('Last 2 days with only one day of data returns the one day', () => {
  assert.deepStrictEqual(r.rangeFor('last2', { today: '2026-11-16', available: ['2026-11-16'] }).dates, ['2026-11-16']);
});

test('This week starts at the Monday session — Sunday evening already belongs to Monday', () => {
  const got = r.rangeFor('week', { today: '2026-11-19',
    available: ['2026-11-12', '2026-11-13', '2026-11-16', '2026-11-17', '2026-11-18', '2026-11-19'] });
  assert.deepStrictEqual(got.dates, ['2026-11-16', '2026-11-17', '2026-11-18', '2026-11-19'],
    'the previous week must not leak in');
  assert.strictEqual(got.from, '2026-11-16', 'Monday 16th is the week start');
});

test('This week on a Monday is just that Monday', () => {
  const got = r.rangeFor('week', { today: '2026-11-16', available: ['2026-11-13', '2026-11-16'] });
  assert.deepStrictEqual(got.dates, ['2026-11-16']);
});

test('This month covers the calendar month of the current session only', () => {
  const got = r.rangeFor('month', { today: '2026-11-16',
    available: ['2026-10-30', '2026-11-02', '2026-11-13', '2026-11-16', '2026-12-01'] });
  assert.deepStrictEqual(got.dates, ['2026-11-02', '2026-11-13', '2026-11-16']);
});

test('Custom takes the days between From and To inclusive', () => {
  const got = r.rangeFor('custom', { today: '2026-11-16', from: '2026-11-12', to: '2026-11-16',
    available: ['2026-11-11', '2026-11-12', '2026-11-13', '2026-11-16'] });
  assert.deepStrictEqual(got.dates, ['2026-11-12', '2026-11-13', '2026-11-16']);
});

test('Custom with the dates the wrong way round is read as a range, not as nothing', () => {
  const got = r.rangeFor('custom', { today: '2026-11-16', from: '2026-11-16', to: '2026-11-12',
    available: ['2026-11-12', '2026-11-13', '2026-11-16'] });
  assert.deepStrictEqual(got.dates, ['2026-11-12', '2026-11-13', '2026-11-16']);
});

test('a future day is never in range', () => {
  const got = r.rangeFor('month', { today: '2026-11-16', available: ['2026-11-16', '2026-11-17'] });
  assert.deepStrictEqual(got.dates, ['2026-11-16'], 'tomorrow has not happened');
});

test('an unknown period falls back to today rather than showing everything', () => {
  assert.deepStrictEqual(r.rangeFor('nonsense', { today: '2026-11-16', available: ['2026-11-13', '2026-11-16'] }).dates,
    ['2026-11-16']);
});

// ── Combining ─────────────────────────────────────────────────────────────

test('two days add exactly — this is the whole point', () => {
  const c = r.combineSessions([FRI, MON], ['2026-11-13', '2026-11-16']);
  assert.strictEqual(c.totals.netPnl, 1410.80);          // 896.65 + 514.15
  assert.strictEqual(c.totals.grossPnl, 1970.00);        // 1296.25 + 673.75
  assert.strictEqual(c.totals.fees, 559.20);             // 399.60 + 159.60
  assert.strictEqual(c.totals.contractSides, 932);
  assert.strictEqual(c.totals.roundTrips, 466);
  assert.strictEqual(c.totals.tradeCount, 204);
  assert.strictEqual(c.dayCount, 2);
});

test('the combined net is the sum of the per-day nets, to the cent', () => {
  const c = r.combineSessions([FRI, MON], ['2026-11-13', '2026-11-16']);
  const sum = c.perDay.reduce((n, d) => n + d.netPnl, 0);
  assert.strictEqual(Math.round(sum * 100) / 100, c.totals.netPnl);
});

test('the per-day breakdown is newest first and carries each day net', () => {
  const c = r.combineSessions([FRI, MON], ['2026-11-13', '2026-11-16']);
  assert.deepStrictEqual(c.perDay.map(d => d.sessionDate), ['2026-11-16', '2026-11-13']);
  assert.strictEqual(c.perDay[0].netPnl, 514.15);
});

test('cents add without floating-point dust', () => {
  const c = r.combineSessions(
    [day('2026-11-12', 0.1), day('2026-11-13', 0.2)], ['2026-11-12', '2026-11-13']);
  assert.strictEqual(c.totals.netPnl, 0.30, 'got ' + c.totals.netPnl);
});

test('a day with no session counts as zero and is still listed', () => {
  const c = r.combineSessions([MON], ['2026-11-13', '2026-11-16']);
  assert.strictEqual(c.totals.netPnl, 514.15);
  assert.strictEqual(c.dayCount, 2, 'the empty day is still a day in the range');
  const empty = c.perDay.find(d => d.sessionDate === '2026-11-13');
  assert.ok(empty, 'the empty day must appear in the breakdown');
  assert.strictEqual(empty.netPnl, 0);
  assert.strictEqual(empty.hasData, false);
});

test('a session outside the range is never counted', () => {
  const c = r.combineSessions([FRI, MON], ['2026-11-16']);
  assert.strictEqual(c.totals.netPnl, 514.15);
  assert.strictEqual(c.dayCount, 1);
});

test('a carried trade is counted once, on the day its own session reports it', () => {
  // The 12th ends short 5 and the 13th closes it. Each day's session total already
  // accounts for the carry, so adding them must not double-count the carried amount.
  const d12 = day('2026-11-12', 100, { openPositionAtEnd: -5 });
  const d13 = day('2026-11-13', 250, { openPositionAtEnd: 0 });
  const c = r.combineSessions([d12, d13], ['2026-11-12', '2026-11-13']);
  assert.strictEqual(c.totals.netPnl, 350, 'the carried amount was counted twice');
  assert.strictEqual(c.perDay.find(d => d.sessionDate === '2026-11-12').netPnl, 100);
});

test('the same day supplied twice is still counted once', () => {
  const c = r.combineSessions([MON, MON], ['2026-11-16']);
  assert.strictEqual(c.totals.netPnl, 514.15);
});

test('the same DATE asked for twice is still counted once', () => {
  // The dangerous direction: a caller that builds a range with a repeated day would
  // otherwise add that day's money in twice.
  const c = r.combineSessions([FRI, MON], ['2026-11-16', '2026-11-13', '2026-11-16']);
  assert.strictEqual(c.totals.netPnl, 1410.80);
  assert.strictEqual(c.dayCount, 2);
  assert.strictEqual(c.perDay.length, 2);
});

test('an empty range produces zeros, not nulls', () => {
  const c = r.combineSessions([FRI, MON], []);
  assert.strictEqual(c.totals.netPnl, 0);
  assert.strictEqual(c.dayCount, 0);
  assert.deepStrictEqual(c.perDay, []);
});

// ── Rows in range ─────────────────────────────────────────────────────────

test('trades and fills in range are newest first and carry their day', () => {
  const trades = [
    { id: 1, sessionDate: '2026-11-13', openSessionDate: '2026-11-13', status: 'CLOSED', closeTime: '2026-11-13 09:00:00' },
    { id: 2, sessionDate: '2026-11-16', openSessionDate: '2026-11-16', status: 'CLOSED', closeTime: '2026-11-16 10:00:00' },
    { id: 3, sessionDate: '2026-11-11', openSessionDate: '2026-11-11', status: 'CLOSED', closeTime: '2026-11-11 10:00:00' },
  ];
  const got = r.rowsInRange(trades, ['2026-11-13', '2026-11-16'], 'trades');
  assert.deepStrictEqual(got.map(t => t.id), [2, 1], 'newest first');
});

test('an OPEN trade is listed under the day it opened in', () => {
  const trades = [{ id: 9, status: 'OPEN', openSessionDate: '2026-11-16', sessionDate: null, openTime: '2026-11-16 10:00:00' }];
  assert.strictEqual(r.rowsInRange(trades, ['2026-11-16'], 'trades').length, 1);
  assert.strictEqual(r.rowsInRange(trades, ['2026-11-13'], 'trades').length, 0);
});

test('fills in range are filtered by their own session date', () => {
  const fills = [
    { orderId: 'a', sessionDate: '2026-11-13', fillTime: '2026-11-13 09:00:00' },
    { orderId: 'b', sessionDate: '2026-11-16', fillTime: '2026-11-16 10:00:00' },
    { orderId: 'c', sessionDate: '2026-11-11', fillTime: '2026-11-11 10:00:00' },
  ];
  assert.deepStrictEqual(r.rowsInRange(fills, ['2026-11-13', '2026-11-16'], 'fills').map(f => f.orderId), ['b', 'a']);
});

// ── Paper and live never mix ──────────────────────────────────────────────

test('a range only ever covers the days it was given, which are one mode', () => {
  // The caller supplies the current mode's sessions. A paper day the caller did not
  // supply cannot appear, however it is asked for.
  const liveOnly = [MON];
  const c = r.combineSessions(liveOnly, ['2026-11-16', '2026-11-15']);
  assert.strictEqual(c.totals.netPnl, 514.15);
  assert.strictEqual(c.perDay.find(d => d.sessionDate === '2026-11-15').hasData, false,
    'a day with no supplied session must read as empty, never borrow from elsewhere');
});

test('available days come from the supplied sessions only', () => {
  const got = r.rangeFor('month', { today: '2026-11-16', available: r.availableDates([FRI, MON]) });
  assert.deepStrictEqual(got.dates, ['2026-11-13', '2026-11-16']);
  assert.deepStrictEqual(r.availableDates([]), []);
  assert.deepStrictEqual(r.availableDates(null), []);
});

// ── The header label ──────────────────────────────────────────────────────

test('one day reads as that day, not as a range', () => {
  assert.strictEqual(r.rangeLabel({ from: '2026-11-16', to: '2026-11-16', dates: ['2026-11-16'] }), '2026-11-16');
});

test('several days read as a range with a day count', () => {
  assert.strictEqual(
    r.rangeLabel({ from: '2026-11-13', to: '2026-11-16', dates: ['2026-11-13', '2026-11-16'] }),
    '2026-11-13 → 2026-11-16 · 2 trading days');
});

test('an empty range says so rather than rendering undefined', () => {
  assert.strictEqual(r.rangeLabel({ from: null, to: null, dates: [] }), 'no trading days');
});

test('every period has a label for the selector', () => {
  const keys = r.PERIODS.map(p => p.key);
  assert.deepStrictEqual(keys, ['today', 'last2', 'week', 'month', 'custom']);
  for (const p of r.PERIODS) assert.ok(p.label && p.label.length > 0, p.key);
  assert.strictEqual(r.PERIODS[0].label, 'Today');
});
