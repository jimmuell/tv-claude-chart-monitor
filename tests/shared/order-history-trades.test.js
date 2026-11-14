'use strict';

// Flat-to-flat trades. A TRADE opens when the position leaves zero and closes when it
// returns; a fill that reverses through zero is split between two trades.
//
// Fixtures are synthetic — no real trade row is in the repo. The session totals these
// trades sit inside are the ones TVCM-13 reconciled against AMP's statement, so the
// tests here also pin that the trade view never silently disagrees with them.

const test   = require('node:test');
const assert = require('node:assert');
const path   = require('path');

const oh = require(path.join(__dirname, '../../src/shared/order-history.js'));
const { analyseOrderHistory, sessionTrades, sessionSummary } = oh;

const HEADER = 'Symbol,Side,Type,Quantity,Limit price,Stop price,Active at,Fill quantity,' +
               'Avg fill price,Commission,Placing time,Status,Status time,Order ID,Duration';

/** Builds one CSV line in the real export's column order. */
function row({ side, qty = 1, fillQty = qty, price, time, status = 'Filled', id, type = 'Market' }) {
  return ['F.US.MESZ26', side, type, qty, '', '', '', fillQty, price, '', time, status, time, id, 'GTC'].join(',');
}
/** Builds a whole CSV, newest-first like TradingView's real export. */
function csv(rows) { return [HEADER, ...rows.slice().reverse()].join('\n'); }
/** Runs the engine over one synthetic export. */
const run = (rows, opts) => analyseOrderHistory(csv(rows), opts);

// ── Simple long ───────────────────────────────────────────────────────────
test('a simple long is one trade with entry, exit and net', () => {
  const r = run([
    row({ side: 'Buy',  qty: 2, price: 7000, time: '2026-11-12 09:00:00', id: 'A' }),
    row({ side: 'Sell', qty: 2, price: 7010, time: '2026-11-12 09:30:00', id: 'B' }),
  ]);
  assert.strictEqual(r.trades.length, 1);
  const t = r.trades[0];
  assert.strictEqual(t.status, 'CLOSED');
  assert.strictEqual(t.direction, 'long');
  assert.strictEqual(t.sessionDate, '2026-11-12');
  assert.strictEqual(t.openTime, '2026-11-12 09:00:00');
  assert.strictEqual(t.closeTime, '2026-11-12 09:30:00');
  assert.strictEqual(t.avgEntry, 7000);
  assert.strictEqual(t.avgExit, 7010);
  assert.strictEqual(t.maxPositionSize, 2);
  assert.strictEqual(t.contractSides, 4);
  assert.strictEqual(t.gross, 100);      // 10 pts x 2 x $5
  assert.strictEqual(t.fees, 2.40);      // 4 sides x $0.60
  assert.strictEqual(t.net, 97.60);
  assert.deepStrictEqual(t.orderIds, ['A', 'B']);
  assert.strictEqual(t.crossesBoundary, false);
});

// ── Simple short ──────────────────────────────────────────────────────────
test('a simple short profits when covered lower and is marked short', () => {
  const r = run([
    row({ side: 'Sell', qty: 3, price: 7050, time: '2026-11-12 09:00:00', id: 'S' }),
    row({ side: 'Buy',  qty: 3, price: 7040, time: '2026-11-12 09:30:00', id: 'C' }),
  ]);
  const t = r.trades[0];
  assert.strictEqual(t.direction, 'short');
  assert.strictEqual(t.avgEntry, 7050);
  assert.strictEqual(t.avgExit, 7040);
  assert.strictEqual(t.gross, 150);      // 10 pts x 3 x $5
  assert.strictEqual(t.contractSides, 6);
  assert.strictEqual(t.fees, 3.60);
  assert.strictEqual(t.net, 146.40);
});

// ── Scale-in ──────────────────────────────────────────────────────────────
test('a scale-in stays one trade and averages the entry', () => {
  const r = run([
    row({ side: 'Buy',  qty: 1, price: 7000, time: '2026-11-12 09:00:00', id: 'A' }),
    row({ side: 'Buy',  qty: 3, price: 7020, time: '2026-11-12 09:05:00', id: 'B' }),
    row({ side: 'Sell', qty: 4, price: 7030, time: '2026-11-12 09:10:00', id: 'C' }),
  ]);
  assert.strictEqual(r.trades.length, 1, 'a scale-in must not start a second trade');
  const t = r.trades[0];
  assert.strictEqual(t.entryQty, 4);
  assert.strictEqual(t.avgEntry, (1 * 7000 + 3 * 7020) / 4);  // 7015
  assert.strictEqual(t.avgExit, 7030);
  assert.strictEqual(t.maxPositionSize, 4);
  assert.strictEqual(t.contractSides, 8);
  assert.strictEqual(t.gross, 300);      // (30 x1 + 10 x3) pts x $5
  assert.strictEqual(t.fees, 4.80);
  assert.strictEqual(t.net, 295.20);
  assert.deepStrictEqual(t.orderIds, ['A', 'B', 'C']);
});

// ── Partial exits ─────────────────────────────────────────────────────────
test('partial exits stay one trade until the position is flat', () => {
  const r = run([
    row({ side: 'Buy',  qty: 4, price: 7000, time: '2026-11-12 09:00:00', id: 'A' }),
    row({ side: 'Sell', qty: 1, price: 7010, time: '2026-11-12 09:05:00', id: 'B' }),
    row({ side: 'Sell', qty: 2, price: 7020, time: '2026-11-12 09:10:00', id: 'C' }),
    row({ side: 'Sell', qty: 1, price: 6990, time: '2026-11-12 09:15:00', id: 'D' }),
  ]);
  assert.strictEqual(r.trades.length, 1, 'a partial exit must not close the trade');
  const t = r.trades[0];
  assert.strictEqual(t.closeTime, '2026-11-12 09:15:00', 'the trade closes on the fill that reaches flat');
  assert.strictEqual(t.exitQty, 4);
  assert.strictEqual(t.avgExit, (1 * 7010 + 2 * 7020 + 1 * 6990) / 4);
  assert.strictEqual(t.maxPositionSize, 4);
  assert.strictEqual(t.contractSides, 8);
  assert.strictEqual(t.gross, 200);      // (10 + 20+20 + -10) pts x $5
  assert.strictEqual(t.net, 195.20);
  assert.deepStrictEqual(t.orderIds, ['A', 'B', 'C', 'D']);
});

test('max position size is the peak exposure, not the total contracts entered', () => {
  // Scales in and out so the peak (3) is deliberately lower than the 4 entered.
  const r = run([
    row({ side: 'Buy',  qty: 2, price: 7000, time: '2026-11-12 09:00:00', id: 'A' }),
    row({ side: 'Sell', qty: 1, price: 7010, time: '2026-11-12 09:05:00', id: 'B' }),
    row({ side: 'Buy',  qty: 2, price: 7005, time: '2026-11-12 09:10:00', id: 'C' }),
    row({ side: 'Sell', qty: 3, price: 7020, time: '2026-11-12 09:15:00', id: 'D' }),
  ]);
  assert.strictEqual(r.trades.length, 1);
  const t = r.trades[0];
  assert.strictEqual(t.entryQty, 4, 'four contracts were entered in total');
  assert.strictEqual(t.maxPositionSize, 3, 'but exposure never exceeded three');
  assert.notStrictEqual(t.maxPositionSize, t.entryQty);
  assert.strictEqual(t.contractSides, 8);
});

// ── Reversal through zero ─────────────────────────────────────────────────
test('a reversal through zero is two trades sharing the reversing fill', () => {
  const r = run([
    row({ side: 'Buy',  qty: 2, price: 7000, time: '2026-11-12 09:00:00', id: 'A' }),
    row({ side: 'Sell', qty: 5, price: 7010, time: '2026-11-12 09:05:00', id: 'FLIP' }),
    row({ side: 'Buy',  qty: 3, price: 7005, time: '2026-11-12 09:10:00', id: 'C' }),
  ]);
  assert.strictEqual(r.trades.length, 2, 'a reversal must split into two trades');
  const [long, short] = r.trades;

  assert.strictEqual(long.direction, 'long');
  assert.strictEqual(long.entryQty, 2);
  assert.strictEqual(long.exitQty, 2, 'only the closing part of the reversing fill belongs to the long');
  assert.strictEqual(long.maxPositionSize, 2);
  assert.strictEqual(long.gross, 100);   // 10 pts x 2 x $5
  assert.strictEqual(long.contractSides, 4);
  assert.deepStrictEqual(long.orderIds, ['A', 'FLIP']);

  assert.strictEqual(short.direction, 'short');
  assert.strictEqual(short.entryQty, 3, 'the opening part of the reversing fill belongs to the short');
  assert.strictEqual(short.exitQty, 3);
  assert.strictEqual(short.maxPositionSize, 3);
  assert.strictEqual(short.gross, 75);   // 5 pts x 3 x $5
  assert.strictEqual(short.contractSides, 6);
  assert.deepStrictEqual(short.orderIds, ['FLIP', 'C']);

  // The reversing fill's 5 contracts are split 2/3 and counted exactly once overall.
  assert.strictEqual(long.contractSides + short.contractSides, 10);
  assert.strictEqual(sessionSummary(r, '2026-11-12').contractSides, 10);
});

test('the two sides of a reversal still sum to the session total', () => {
  const r = run([
    row({ side: 'Buy',  qty: 2, price: 7000, time: '2026-11-12 09:00:00', id: 'A' }),
    row({ side: 'Sell', qty: 5, price: 7010, time: '2026-11-12 09:05:00', id: 'FLIP' }),
    row({ side: 'Buy',  qty: 3, price: 7005, time: '2026-11-12 09:10:00', id: 'C' }),
  ]);
  const s = sessionSummary(r, '2026-11-12');
  const x = s.tradeReconciliation;
  assert.strictEqual(x.tradeCount, 2);
  assert.strictEqual(x.tradesNet, s.netPnl);
  assert.strictEqual(x.netDelta, 0);
  assert.strictEqual(x.balanced, true);
});

// ── Crossing the 17:00 boundary ───────────────────────────────────────────
test('a trade held through 17:00 belongs to the session it CLOSES in', () => {
  const r = run([
    row({ side: 'Buy',  qty: 2, price: 7000, time: '2026-11-10 16:00:00', id: 'OPEN'  }),
    row({ side: 'Sell', qty: 2, price: 7010, time: '2026-11-10 18:00:00', id: 'CLOSE' }),
  ]);
  const t = r.trades[0];
  assert.strictEqual(t.openSessionDate, '2026-11-10');
  assert.strictEqual(t.sessionDate, '2026-11-11', 'a crossing trade belongs to its closing session');
  assert.strictEqual(t.crossesBoundary, true);
  assert.strictEqual(sessionTrades(r, '2026-11-10').length, 0);
  assert.strictEqual(sessionTrades(r, '2026-11-11').length, 1);
});

test('a boundary-crossing trade makes the session difference explicit, not absorbed', () => {
  // Opens 11-10 with 4, takes 1 off before 17:00, closes the rest after.
  const r = run([
    row({ side: 'Buy',  qty: 4, price: 7000, time: '2026-11-10 15:00:00', id: 'A' }),
    row({ side: 'Sell', qty: 1, price: 7020, time: '2026-11-10 16:00:00', id: 'B' }), // books +100 into 11-10
    row({ side: 'Sell', qty: 3, price: 7010, time: '2026-11-10 18:00:00', id: 'C' }), // books +150 into 11-11
  ]);
  const t = r.trades[0];
  assert.strictEqual(t.sessionDate, '2026-11-11');
  assert.strictEqual(t.gross, 250);
  assert.deepStrictEqual(t.grossBySession, { '2026-11-10': 100, '2026-11-11': 150 });
  assert.deepStrictEqual(t.sidesBySession, { '2026-11-10': 5, '2026-11-11': 3 });

  // Session totals keep matching the statement: the P&L lands where it was realized.
  assert.strictEqual(sessionSummary(r, '2026-11-10').grossPnl, 100);
  assert.strictEqual(sessionSummary(r, '2026-11-11').grossPnl, 150);

  // 11-10 has no trade of its own; the P&L it holds is attributed as INBOUND.
  const x10 = sessionSummary(r, '2026-11-10').tradeReconciliation;
  assert.strictEqual(x10.tradeCount, 0);
  assert.deepStrictEqual(x10.inbound.tradeIds, [t.id]);
  assert.strictEqual(x10.inbound.gross, 100);
  assert.strictEqual(x10.inbound.sides, 5);
  assert.strictEqual(x10.explained, true, 'the gap must be explained, not absorbed');

  // 11-11 counts the whole trade and declares the part it did not realize as OUTBOUND.
  const x11 = sessionSummary(r, '2026-11-11').tradeReconciliation;
  assert.deepStrictEqual(x11.outbound.tradeIds, [t.id]);
  assert.strictEqual(x11.outbound.gross, 100);
  assert.strictEqual(x11.outbound.sides, 5);
  assert.deepStrictEqual(x11.crossingTradeIds, [t.id]);
  assert.strictEqual(x11.netDelta, x11.boundaryNet, 'the whole delta is the boundary');
  assert.strictEqual(x11.roundingDelta, 0);
  assert.strictEqual(x11.explained, true);
});

// ── Open trade at the end ─────────────────────────────────────────────────
test('a trade still open at the end is returned OPEN with nothing guessed', () => {
  const r = run([
    row({ side: 'Buy',  qty: 3, price: 7000, time: '2026-11-12 09:00:00', id: 'A' }),
    row({ side: 'Sell', qty: 1, price: 7020, time: '2026-11-12 10:00:00', id: 'B' }),
  ]);
  assert.strictEqual(r.trades.length, 1);
  const t = r.trades[0];
  assert.strictEqual(t.status, 'OPEN');
  assert.strictEqual(t.closeTime, null);
  assert.strictEqual(t.sessionDate, null, 'an open trade has not closed in any session');
  assert.strictEqual(t.gross, null, 'unrealized P&L must never be guessed');
  assert.strictEqual(t.net, null);
  assert.strictEqual(t.avgExit, null);
  assert.strictEqual(t.avgEntry, 7000);
  assert.strictEqual(t.entryQty, 3);
  assert.strictEqual(t.exitQty, 1);
  assert.strictEqual(t.maxPositionSize, 3);
  assert.strictEqual(t.fees, 2.40, 'fees on sides already filled are a cost, not a forecast');
  assert.strictEqual(t.crossesBoundary, false);
});

test('an open trade is excluded from the session trade list but reported as open', () => {
  const r = run([
    row({ side: 'Buy',  qty: 2, price: 7000, time: '2026-11-12 09:00:00', id: 'A' }),
    row({ side: 'Sell', qty: 2, price: 7010, time: '2026-11-12 09:30:00', id: 'B' }),
    row({ side: 'Buy',  qty: 1, price: 7005, time: '2026-11-12 10:00:00', id: 'C' }),
  ]);
  assert.strictEqual(sessionTrades(r, '2026-11-12').length, 1, 'only the closed trade counts');
  assert.strictEqual(sessionTrades(r, '2026-11-12', { includeOpen: true }).length, 2);
  const x = sessionSummary(r, '2026-11-12').tradeReconciliation;
  assert.strictEqual(x.tradeCount, 1);
  assert.deepStrictEqual(x.openTradeIds, [2]);
});

// ── Matches are retained ──────────────────────────────────────────────────
test('every FIFO match is kept with both ends of the pairing', () => {
  const r = run([
    row({ side: 'Buy',  qty: 1, price: 7000, time: '2026-11-12 09:00:00', id: 'OPEN'  }),
    row({ side: 'Sell', qty: 1, price: 7010, time: '2026-11-12 09:30:00', id: 'CLOSE' }),
  ]);
  assert.strictEqual(r.matches.length, 1);
  const m = r.matches[0];
  assert.deepStrictEqual(
    { qty: m.qty, side: m.side, openOrderId: m.openOrderId, openTime: m.openTime, openPrice: m.openPrice,
      closeOrderId: m.closeOrderId, closeTime: m.closeTime, closePrice: m.closePrice, pnl: m.pnl,
      sessionDate: m.sessionDate, tradeId: m.tradeId },
    { qty: 1, side: 'long', openOrderId: 'OPEN', openTime: '2026-11-12 09:00:00', openPrice: 7000,
      closeOrderId: 'CLOSE', closeTime: '2026-11-12 09:30:00', closePrice: 7010, pnl: 50,
      sessionDate: '2026-11-12', tradeId: 1 });
});

test('one exit closing two entry lots produces two matches in FIFO order', () => {
  const r = run([
    row({ side: 'Buy',  qty: 1, price: 7000, time: '2026-11-12 09:00:00', id: 'L1' }),
    row({ side: 'Buy',  qty: 1, price: 7100, time: '2026-11-12 09:05:00', id: 'L2' }),
    row({ side: 'Sell', qty: 2, price: 7050, time: '2026-11-12 09:10:00', id: 'X'  }),
  ]);
  assert.strictEqual(r.matches.length, 2);
  assert.deepStrictEqual(r.matches.map(m => m.openOrderId), ['L1', 'L2'], 'oldest lot must close first');
  assert.deepStrictEqual(r.matches.map(m => m.pnl), [250, -250]);
  assert.strictEqual(r.trades.length, 1);
  assert.strictEqual(r.trades[0].gross, 0);
});

// ── Trades never disagree with the session unless a boundary says so ──────
test('with no crossing trade, trade nets sum exactly to the session net', () => {
  const r = run([
    row({ side: 'Buy',  qty: 2, price: 7000, time: '2026-11-12 09:00:00', id: 'A' }),
    row({ side: 'Sell', qty: 2, price: 7010, time: '2026-11-12 09:30:00', id: 'B' }),
    row({ side: 'Sell', qty: 1, price: 7020, time: '2026-11-12 10:00:00', id: 'C' }),
    row({ side: 'Buy',  qty: 1, price: 7015, time: '2026-11-12 10:30:00', id: 'D' }),
  ]);
  const s = sessionSummary(r, '2026-11-12');
  const trades = sessionTrades(r, '2026-11-12');
  assert.strictEqual(trades.length, 2);
  assert.strictEqual(oh.toCents(trades.reduce((x, t) => x + t.net, 0)), s.netPnl);
  assert.strictEqual(oh.toCents(trades.reduce((x, t) => x + t.fees, 0)), s.fees);
  assert.strictEqual(s.tradeReconciliation.balanced, true);
  assert.strictEqual(s.tradeReconciliation.roundingDelta, 0);
});

test('an export with no fills has no trades and does not throw', () => {
  const r = analyseOrderHistory(HEADER);
  assert.deepStrictEqual(r.trades, []);
  assert.strictEqual(r.warning, 'TVCM-OH-NO-ROWS');
});

test('trade ids are unique and assigned in the order trades opened', () => {
  const r = run([
    row({ side: 'Buy',  qty: 1, price: 7000, time: '2026-11-12 09:00:00', id: 'A' }),
    row({ side: 'Sell', qty: 1, price: 7010, time: '2026-11-12 09:30:00', id: 'B' }),
    row({ side: 'Sell', qty: 1, price: 7020, time: '2026-11-12 10:00:00', id: 'C' }),
    row({ side: 'Buy',  qty: 1, price: 7015, time: '2026-11-12 10:30:00', id: 'D' }),
  ]);
  assert.deepStrictEqual(r.trades.map(t => t.id), [1, 2]);
  assert.deepStrictEqual(r.trades.map(t => t.direction), ['long', 'short']);
});

test('a balanced session carries no unexplained-gap warning', () => {
  const r = run([
    row({ side: 'Buy',  qty: 2, price: 7000, time: '2026-11-12 09:00:00', id: 'A' }),
    row({ side: 'Sell', qty: 2, price: 7010, time: '2026-11-12 09:30:00', id: 'B' }),
  ]);
  const x = sessionSummary(r, '2026-11-12').tradeReconciliation;
  assert.strictEqual(x.warning, null);
  assert.strictEqual(x.explained, true);
});

test('a boundary-crossing session is explained, so it carries no warning either', () => {
  const r = run([
    row({ side: 'Buy',  qty: 4, price: 7000, time: '2026-11-10 15:00:00', id: 'A' }),
    row({ side: 'Sell', qty: 1, price: 7020, time: '2026-11-10 16:00:00', id: 'B' }),
    row({ side: 'Sell', qty: 3, price: 7010, time: '2026-11-10 18:00:00', id: 'C' }),
  ]);
  for (const d of ['2026-11-10', '2026-11-11']) {
    const x = sessionSummary(r, d).tradeReconciliation;
    assert.strictEqual(x.warning, null, `${d} should be explained`);
  }
});

test('the reconciler raises TVCM-OH-TRADE-UNEXPLAINED when the split really is wrong', () => {
  // Fed directly, because a correct ledger cannot produce this state from any input —
  // the guard exists for a future regression in the trade split, so it is tested here
  // rather than through the engine.
  const session = { sessionDate: '2026-11-12', grossPnl: 100, fees: 2.40, netPnl: 97.60 };
  const bogus = [{
    id: 1, status: 'CLOSED', sessionDate: '2026-11-12', openSessionDate: '2026-11-12',
    crossesBoundary: false, gross: 500, fees: 2.40, contractSides: 4,
    grossBySession: { '2026-11-12': 500 }, sidesBySession: { '2026-11-12': 4 },
  }];
  const x = oh.reconcileTrades(session, bogus, 0.60);
  assert.strictEqual(x.netDelta, 400);
  assert.strictEqual(x.boundaryNet, 0, 'no boundary trade, so the boundary explains nothing');
  assert.strictEqual(x.roundingDelta, 400);
  assert.strictEqual(x.explained, false);
  assert.strictEqual(x.warning, 'TVCM-OH-TRADE-UNEXPLAINED');
});
