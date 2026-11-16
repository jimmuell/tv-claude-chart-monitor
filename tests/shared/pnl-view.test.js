'use strict';

// Display rules for the Order History & P&L window. Two of these are not cosmetic:
// the headline must be the statement-matching session total, and "no import" must
// never render as a zero.

const { test, before } = require('node:test');
const assert = require('node:assert');
const path   = require('path');
const url    = require('url');

// pnl-view is ESM (the window loads it natively through Vite), so it is imported
// rather than required.
let v;
before(async () => {
  v = await import(url.pathToFileURL(path.join(__dirname, '../../src/shared/pnl-view.mjs')).href);
});

/** A session summary shaped like the engine's, with overridable fields. */
function session(over = {}) {
  return {
    sessionDate: '2026-11-13', fillCount: 145, buys: 333, sells: 333,
    avgBuy: 7605.2192, avgSell: 7605.9977, grossPnl: 1296.25, contractSides: 666,
    roundTrips: 333, fees: 399.60, netPnl: 896.65,
    openPositionAtStart: 0, openPositionAtEnd: 0, ...over,
  };
}
/** A boundary block shaped like the watcher's. */
function boundary(over = {}) {
  return { boundaryNet: 0, outboundTradeIds: [], inboundTradeIds: [], tradeCount: 71, openTradeIds: [], ...over };
}
const detail = (over = {}) => ({ sessionDate: '2026-11-13', session: session(), trades: [], fills: [], boundary: boundary(), ...over });
const state   = (over = {}) => ({ importedAt: Date.parse('2026-11-14T17:45:00Z'), fileName: 'amp.csv', watchFolder: '/tmp/x', errorCode: null, ...over });

// ── Money ─────────────────────────────────────────────────────────────────
test('money is signed, to the cent, with thousands separators', () => {
  assert.strictEqual(v.fmtMoney(896.65), '+$896.65');
  assert.strictEqual(v.fmtMoney(1296.25), '+$1,296.25');
  assert.strictEqual(v.fmtMoney(-272), '-$272.00');
  assert.strictEqual(v.fmtMoney(-1139.2), '-$1,139.20');
  assert.strictEqual(v.fmtMoney(0), '+$0.00');
});

test('fees print unsigned, because a cost has no direction', () => {
  assert.strictEqual(v.fmtMoney(399.6, { signed: false }), '$399.60');
  assert.strictEqual(v.fmtMoney(0, { signed: false }), '$0.00');
});

test('a value that rounds to zero never renders as minus zero', () => {
  assert.strictEqual(v.fmtMoney(-0.004), '+$0.00');
});

test('colour follows the rounded value', () => {
  assert.strictEqual(v.moneyClass(0.01), 'gain');
  assert.strictEqual(v.moneyClass(-0.01), 'loss');
  assert.strictEqual(v.moneyClass(0), 'flat');
  assert.strictEqual(v.moneyClass(-0.001), 'flat');
});

// ── Times and contracts ───────────────────────────────────────────────────
test('times come straight from the export, which is already Central', () => {
  assert.strictEqual(v.fmtClock('2026-11-13 09:14:22'), '09:14:22');
  assert.strictEqual(v.fmtStamp('2026-11-12 23:51:25'), '11-12 23:51:25');
  assert.strictEqual(v.fmtClock(null), '—');
  assert.strictEqual(v.fmtStamp(undefined), '—');
});

test('the import time is rendered in Central', () => {
  // 17:45 UTC on 2026-11-14 is 11:45 CT.
  assert.strictEqual(v.fmtImportedAt(Date.parse('2026-11-14T17:45:00Z')), '11:45 AM CT');
  assert.strictEqual(v.fmtImportedAt(null), '—');
});

test('contracts are shown as sides and round trips', () => {
  assert.strictEqual(v.fmtContracts(666), '666 sides (333 RT)');
  assert.strictEqual(v.fmtContracts(1770), '1,770 sides (885 RT)');
});

// ── The headline is the session total ─────────────────────────────────────
test('the headline row is the session net, not a sum of trades', () => {
  const rows = v.summaryRows(detail(), state());
  const head = rows.find(r => r.headline);
  assert.strictEqual(head.key, 'net');
  assert.strictEqual(head.label, 'Net');
  assert.strictEqual(head.value, '+$896.65');
  assert.strictEqual(head.tone, 'gain');
  assert.strictEqual(rows[0].key, 'net', 'net must lead the summary');
});

test('the Nov 13 summary reads exactly the reconciled figures', () => {
  const byKey = Object.fromEntries(v.summaryRows(detail(), state()).map(r => [r.key, r.value]));
  assert.strictEqual(byKey.net, '+$896.65');
  assert.strictEqual(byKey.gross, '+$1,296.25');
  assert.strictEqual(byKey.fees, '$399.60');
  assert.strictEqual(byKey.contracts, '666 sides (333 RT)');
  assert.strictEqual(byKey.trades, '71');
  assert.strictEqual(byKey.asof, '11:45 AM CT');
});

// ── The carried line ──────────────────────────────────────────────────────
test('no carried line on a session where nothing crossed 17:00', () => {
  const rows = v.summaryRows(detail(), state());
  assert.strictEqual(rows.find(r => r.key === 'carried'), undefined);
  assert.strictEqual(v.carriedExplanation(detail()), null);
});

test('a carried line appears, labelled, when P&L crossed a boundary', () => {
  const d = detail({
    session: session({ sessionDate: '2026-11-03', netPnl: -522.30, grossPnl: -457.50, fees: 64.80, contractSides: 108 }),
    boundary: boundary({ boundaryNet: 312.30, inboundTradeIds: [58], tradeCount: 10 }),
  });
  const row = v.summaryRows(d, state()).find(r => r.key === 'carried');
  assert.ok(row, 'the carried line must be shown');
  assert.strictEqual(row.label, 'Carried from/to other sessions');
  assert.strictEqual(row.value, '+$312.30');
  assert.strictEqual(row.tone, 'gain');
  // The headline is still the statement figure, not the trade sum.
  assert.strictEqual(v.summaryRows(d, state())[0].value, '-$522.30');
});

test('the carried line is explained in one plain sentence', () => {
  const expected = "Part of this day's P&L came from a trade that closed on another day.";
  const inbound  = v.carriedExplanation(detail({ boundary: boundary({ boundaryNet: 312.30, inboundTradeIds: [58] }) }));
  const outbound = v.carriedExplanation(detail({ boundary: boundary({ boundaryNet: 49.60, outboundTradeIds: [157] }) }));
  assert.strictEqual(inbound, expected);
  assert.strictEqual(outbound, expected, 'both directions read the same to the trader');
  assert.ok(!/\$/.test(inbound), 'the amount belongs on its own row, not in the sentence');
  assert.ok(!/#\d/.test(inbound), 'internal trade ids do not belong in the note');
});

test('per-trade cent rounding is never presented as a difference', () => {
  // A session whose trades round to 2c off still shows no carried line.
  const d = detail({ boundary: boundary({ boundaryNet: 0 }) });
  const keys = v.summaryRows(d, state()).map(r => r.key);
  assert.ok(!keys.includes('carried'));
  assert.ok(!keys.some(k => /round/i.test(k)), 'roundingDelta must not reach the UI');
});

// ── Open position ─────────────────────────────────────────────────────────
test('an open position is shown only when there is one', () => {
  assert.strictEqual(v.summaryRows(detail(), state()).find(r => r.key === 'open'), undefined);
  const d = detail({ session: session({ openPositionAtEnd: -2 }) });
  const row = v.summaryRows(d, state()).find(r => r.key === 'open');
  assert.strictEqual(row.value, '-2 contracts');
  const one = v.summaryRows(detail({ session: session({ openPositionAtEnd: 1 }) }), state()).find(r => r.key === 'open');
  assert.strictEqual(one.value, '+1 contract');
});

// ── No import: words, never zeros ─────────────────────────────────────────
test('with no session there are no summary rows at all', () => {
  assert.deepStrictEqual(v.summaryRows({ session: null, boundary: null }, state()), []);
  assert.deepStrictEqual(v.summaryRows(null, null), []);
});

test('the empty message explains instead of showing a number', () => {
  const msg = v.emptyMessage(state({ importedAt: null }));
  assert.ok(/No order-history import yet/.test(msg), msg);
  assert.ok(/\/tmp\/x/.test(msg), 'it should name the folder being watched');
  assert.ok(!/\$/.test(msg), 'an empty state must never contain a money figure');
});

test('a failed import says so rather than showing stale numbers', () => {
  const msg = v.emptyMessage(state({ errorCode: 'TVCM-OH-BAD-HEADER' }));
  assert.ok(msg.includes('TVCM-OH-BAD-HEADER'), msg);
  assert.ok(!/\$/.test(msg));
});

test('a null state still produces a sentence', () => {
  assert.strictEqual(typeof v.emptyMessage(null), 'string');
  assert.ok(v.emptyMessage(null).length > 0);
});

// ── Trade rows ────────────────────────────────────────────────────────────
const trade = (over = {}) => ({
  id: 321, status: 'CLOSED', direction: 'short', sessionDate: '2026-11-13',
  openSessionDate: '2026-11-13', crossesBoundary: false,
  openTime: '2026-11-13 14:02:11', closeTime: '2026-11-13 14:08:40',
  entryQty: 5, exitQty: 5, avgEntry: 7570.25, avgExit: 7560.5,
  maxPositionSize: 5, contractSides: 10, gross: 243.75, fees: 6, net: 237.75,
  orderIds: ['A', 'B'], ...over,
});

test('a closed trade row is fully formatted', () => {
  const r = v.tradeRow(trade());
  assert.strictEqual(r.id, 321);
  assert.strictEqual(r.time, 'Fri 11/13 14:02:11 – 14:08:40');  // TVCM-32 2a: the date is always shown
  assert.strictEqual(r.direction, 'short');
  assert.strictEqual(r.size, '5');
  assert.strictEqual(r.avgEntry, '7570.25');
  assert.strictEqual(r.avgExit, '7560.50');
  assert.strictEqual(r.fees, '$6.00');
  assert.strictEqual(r.net, '+$237.75');
  assert.strictEqual(r.tone, 'gain');
  assert.strictEqual(r.isOpen, false);
});

test('an open trade shows dashes, not guesses', () => {
  const r = v.tradeRow(trade({ status: 'OPEN', closeTime: null, avgExit: null, gross: null, net: null }));
  assert.strictEqual(r.time, 'Fri 11/13 14:02:11 – open');      // TVCM-32 2a
  assert.strictEqual(r.avgExit, '—');
  assert.strictEqual(r.net, '—');
  assert.strictEqual(r.tone, 'flat');
  assert.strictEqual(r.isOpen, true);
  assert.strictEqual(r.fees, '$6.00', 'fees already incurred are still shown');
});

test('a losing trade is toned as a loss', () => {
  assert.strictEqual(v.tradeRow(trade({ net: -118.5 })).tone, 'loss');
  assert.strictEqual(v.tradeRow(trade({ net: -118.5 })).net, '-$118.50');
});

test('a boundary-crossing trade is flagged on its row', () => {
  assert.strictEqual(v.tradeRow(trade({ crossesBoundary: true })).crosses, true);
  assert.strictEqual(v.tradeRow(trade()).crosses, false);
});

// ── Expanding a trade ─────────────────────────────────────────────────────
test('expanding a trade shows exactly its own fills', () => {
  const fills = [
    { orderId: 'A', fillTime: '2026-11-13 14:02:11', side: 'Sell', qty: 5, price: 7570.25, status: 'Filled', orderType: 'Market', symbol: 'X', sessionDate: '2026-11-13' },
    { orderId: 'B', fillTime: '2026-11-13 14:08:40', side: 'Buy',  qty: 5, price: 7560.50, status: 'Filled', orderType: 'Market', symbol: 'X', sessionDate: '2026-11-13' },
    { orderId: 'C', fillTime: '2026-11-13 15:00:00', side: 'Buy',  qty: 5, price: 7555.00, status: 'Filled', orderType: 'Market', symbol: 'X', sessionDate: '2026-11-13' },
  ];
  const mine = v.fillsForTrade(trade(), fills);
  assert.deepStrictEqual(mine.map(f => f.orderId), ['A', 'B'], 'a fill from another trade leaked in');
});

test('a trade with no matching fills yields an empty list, not a throw', () => {
  assert.deepStrictEqual(v.fillsForTrade(trade(), []), []);
  assert.deepStrictEqual(v.fillsForTrade(trade(), null), []);
});

// ── Session-local trade numbering ─────────────────────────────────────────
test('trades are numbered #1..N within the session, keeping the global id', () => {
  // Nov 13's trades carry global ids 279..349; the trader should see 1, 2, 3.
  const rows = v.tradeRows([trade({ id: 279 }), trade({ id: 280 }), trade({ id: 281 })]);
  assert.deepStrictEqual(rows.map(r => r.number), [1, 2, 3]);
  assert.deepStrictEqual(rows.map(r => r.id), [279, 280, 281], 'the engine id must survive');
});

test('numbering restarts for each session, rather than continuing globally', () => {
  const nov13 = v.tradeRows([trade({ id: 279 }), trade({ id: 280 })]);
  const nov12 = v.tradeRows([trade({ id: 229 }), trade({ id: 230 })]);
  assert.deepStrictEqual(nov13.map(r => r.number), nov12.map(r => r.number));
  assert.strictEqual(nov13[0].number, 1);
});

test('an empty or missing trade list numbers nothing and does not throw', () => {
  assert.deepStrictEqual(v.tradeRows([]), []);
  assert.deepStrictEqual(v.tradeRows(null), []);
});

// ── Dates on every row (TVCM-32 Task 2a) ─────────────────────────────────
// Jim, 2026-11-16: the Trades tab showed only times, so it was not clear that
// trade #1 happened on SUNDAY EVENING while the header said 2026-11-16. A
// trading day runs 17:00–17:00 CT, so that is normal — but it has to be visible.

test('a fill stamp carries the weekday and the calendar date', () => {
  assert.strictEqual(v.fmtDayStamp('2026-11-15 17:10:00'), 'Sun 11/15 17:10:00');
  assert.strictEqual(v.fmtDayStamp('2026-11-16 09:00:05'), 'Mon 11/16 09:00:05');
  assert.strictEqual(v.fmtDayStamp(null), '—');
  assert.strictEqual(v.fmtDayStamp(''), '—');
});

test('a trade inside one calendar day shows the date once', () => {
  const row = v.tradeRow({ id: 1, openTime: '2026-11-16 09:00:05', closeTime: '2026-11-16 09:30:00',
                           maxPositionSize: 5, status: 'CLOSED', net: 10, fees: 6 });
  assert.strictEqual(row.time, 'Mon 11/16 09:00:05 – 09:30:00');
});

test('the Sunday-evening trade that started this reads unambiguously', () => {
  const row = v.tradeRow({ id: 1, openTime: '2026-11-15 17:10:00', closeTime: '2026-11-15 17:23:30',
                           maxPositionSize: 5, status: 'CLOSED', net: 10, fees: 6 });
  assert.strictEqual(row.time, 'Sun 11/15 17:10:00 – 17:23:30',
    'the header says 2026-11-16; the row must say which evening it was');
});

test('a trade spanning midnight shows BOTH dates', () => {
  const row = v.tradeRow({ id: 2, openTime: '2026-11-15 23:28:14', closeTime: '2026-11-16 00:19:39',
                           maxPositionSize: 1, status: 'CLOSED', net: -5, fees: 1.2 });
  assert.strictEqual(row.time, 'Sun 11/15 23:28:14 – Mon 11/16 00:19:39');
});

test('an open trade shows its open date and says it is open', () => {
  const row = v.tradeRow({ id: 3, openTime: '2026-11-16 10:37:33', closeTime: null,
                           maxPositionSize: 5, status: 'OPEN', net: null, fees: 3 });
  assert.strictEqual(row.time, 'Mon 11/16 10:37:33 – open');
  assert.strictEqual(row.isOpen, true);
});

test('a trade with no times at all does not render undefined', () => {
  const row = v.tradeRow({ id: 4, openTime: null, closeTime: null, maxPositionSize: 1, status: 'OPEN', net: null, fees: 0 });
  assert.strictEqual(row.time, '— – open');
});

test('every weekday renders, so the shortcut is not just Sun/Mon', () => {
  const days = ['2026-11-15', '2026-11-16', '2026-11-17', '2026-11-18', '2026-11-19', '2026-11-20', '2026-11-21']
    .map(d => v.fmtDayStamp(`${d} 12:00:00`).slice(0, 3));
  assert.deepStrictEqual(days, ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']);
});

test('the date is shown always, not only inside a range', () => {
  // There is no "range" argument: a row knows its own date and always says it.
  assert.strictEqual(v.tradeRow.length, 1, 'tradeRow must not need a range to format a date');
});
