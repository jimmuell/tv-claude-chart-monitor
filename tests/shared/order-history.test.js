'use strict';

// Order-history P&L engine. Fixtures here are synthetic — no real trade rows in the repo.
//
// The two rules under test came from reconciling a real export against AMP's
// statement by hand, so these tests are the thing that stops a future refactor
// quietly re-breaking a number that already agrees with the broker.

const test   = require('node:test');
const assert = require('node:assert');
const path   = require('path');

const oh = require(path.join(__dirname, '../../src/shared/order-history.js'));
const { sessionDateFor, parseOrderHistoryCsv, analyseOrderHistory, sessionSummary } = oh;

const HEADER = 'Symbol,Side,Type,Quantity,Limit price,Stop price,Active at,Fill quantity,' +
               'Avg fill price,Commission,Placing time,Status,Status time,Order ID,Duration';

/** Builds one CSV line in the real export's column order. */
function row({ side, qty = 5, fillQty = qty, price, time, status = 'Filled', id, type = 'Market' }) {
  return ['F.US.MESZ26', side, type, qty, '', '', '', fillQty, price, '', time, status, time, id, 'GTC'].join(',');
}
/** Builds a whole CSV, newest-first like TradingView's real export. */
function csv(rows) {
  return [HEADER, ...rows.slice().reverse()].join('\n');
}
const one = (rows, opts) => analyseOrderHistory(csv(rows), opts);

// ── RULE 1: the 17:00 America/Chicago session boundary ────────────────────
test('RULE 1: 16:59 belongs to today, 17:00 belongs to tomorrow', () => {
  assert.strictEqual(sessionDateFor('2026-11-12 16:59:59'), '2026-11-12');
  assert.strictEqual(sessionDateFor('2026-11-12 17:00:00'), '2026-11-13');
  assert.strictEqual(sessionDateFor('2026-11-12 23:59:59'), '2026-11-13');
  assert.strictEqual(sessionDateFor('2026-11-13 00:00:00'), '2026-11-13');
  assert.strictEqual(sessionDateFor('2026-11-13 16:59:59'), '2026-11-13');
});

test('RULE 1: the boundary splits two fills one second apart into different sessions', () => {
  const r = one([
    row({ side: 'Buy',  qty: 1, price: 7000, time: '2026-11-12 16:59:59', id: 'A' }),
    row({ side: 'Sell', qty: 1, price: 7000, time: '2026-11-12 17:00:00', id: 'B' }),
  ]);
  assert.deepStrictEqual(r.sessions.map(s => s.sessionDate), ['2026-11-12', '2026-11-13']);
  assert.strictEqual(sessionSummary(r, '2026-11-12').buys, 1);
  assert.strictEqual(sessionSummary(r, '2026-11-12').sells, 0);
  assert.strictEqual(sessionSummary(r, '2026-11-13').sells, 1);
});

test('RULE 1: a month-end rollover lands on the first of the next month', () => {
  assert.strictEqual(sessionDateFor('2026-11-30 18:00:00'), '2026-12-01');
  assert.strictEqual(sessionDateFor('2026-12-31 18:00:00'), '2027-01-01');
});

// ── RULE 2: fills count regardless of Status ──────────────────────────────
test('RULE 2: a Cancelled order that partially filled still counts', () => {
  const r = one([
    row({ side: 'Sell', qty: 5, price: 7620, time: '2026-11-12 21:00:00', id: 'S1' }),
    row({ side: 'Buy', qty: 5, fillQty: 2, price: 7615, time: '2026-11-12 21:52:14',
          id: '333202840', status: 'Cancelled', type: 'Take Profit' }),
  ]);
  const s = sessionSummary(r, '2026-11-13');
  assert.strictEqual(s.buys, 2, 'the 2 filled contracts of a Cancelled order were dropped');
  assert.strictEqual(s.contractSides, 7);
  assert.strictEqual(s.grossPnl, 50); // short 2 from 7620, covered at 7615 => 5 pts x 2 x $5
});

test('RULE 2: a Cancelled order that filled nothing is ignored, and is not an error', () => {
  const r = one([
    row({ side: 'Buy',  qty: 1, price: 7000, time: '2026-11-12 09:00:00', id: 'A' }),
    row({ side: 'Sell', qty: 5, fillQty: 0, price: '', time: '2026-11-12 09:30:00', id: 'TP', status: 'Cancelled' }),
    row({ side: 'Sell', qty: 1, price: 7001, time: '2026-11-12 10:00:00', id: 'B' }),
  ]);
  assert.strictEqual(r.fills.length, 2);
  assert.strictEqual(r.skipped.length, 0, 'an unfilled order is normal, not a bad row');
  assert.strictEqual(sessionSummary(r, '2026-11-12').contractSides, 2);
});

// ── Duplicate Order IDs across re-imports ─────────────────────────────────
test('a repeated Order ID is counted once, with the later export winning', () => {
  const first  = csv([row({ side: 'Buy',  qty: 2, price: 7000, time: '2026-11-12 09:00:00', id: 'DUP' })]);
  const second = csv([row({ side: 'Buy',  qty: 2, price: 7010, time: '2026-11-12 09:00:00', id: 'DUP' }),
                      row({ side: 'Sell', qty: 2, price: 7020, time: '2026-11-12 10:00:00', id: 'X' })]);
  const r = analyseOrderHistory([first, second]);
  const s = sessionSummary(r, '2026-11-12');
  assert.strictEqual(s.buys, 2, 'the duplicate was double-counted');
  assert.strictEqual(s.contractSides, 4);
  assert.strictEqual(s.avgBuy, 7010, 'the later export should have replaced the earlier row');
  assert.strictEqual(s.grossPnl, 100); // (7020-7010) x 2 x $5
  assert.strictEqual(r.replaced.length, 1);
});

test('re-importing the identical file changes nothing', () => {
  const text = csv([
    row({ side: 'Buy',  qty: 1, price: 7000, time: '2026-11-12 09:00:00', id: 'A' }),
    row({ side: 'Sell', qty: 1, price: 7005, time: '2026-11-12 10:00:00', id: 'B' }),
  ]);
  const once  = analyseOrderHistory(text);
  const twice = analyseOrderHistory([text, text]);
  assert.deepStrictEqual(twice.sessions, once.sessions);
});

// ── Positions held across the 17:00 boundary ──────────────────────────────
test('a position held through 17:00 carries forward and books P&L in the closing session', () => {
  const r = one([
    row({ side: 'Buy',  qty: 2, price: 7000, time: '2026-11-10 16:00:00', id: 'OPEN'  }),
    row({ side: 'Sell', qty: 2, price: 7010, time: '2026-11-10 18:00:00', id: 'CLOSE' }),
  ]);
  const d10 = sessionSummary(r, '2026-11-10');
  const d11 = sessionSummary(r, '2026-11-11');
  assert.strictEqual(d10.grossPnl, 0, 'an open position must not be booked as profit');
  assert.strictEqual(d10.openPositionAtEnd, 2, 'the position was dropped instead of carried');
  assert.strictEqual(d11.openPositionAtStart, 2);
  assert.strictEqual(d11.grossPnl, 100); // (7010-7000) x 2 x $5, booked where it closed
  assert.strictEqual(d11.openPositionAtEnd, 0);
  assert.strictEqual(r.positionAtEnd, 0);
  assert.deepStrictEqual(r.openLotsAtEnd, []);
});

test('a position still open at the end of the file is reported, not realized', () => {
  const r = one([
    row({ side: 'Buy', qty: 3, price: 7000, time: '2026-11-12 09:00:00', id: 'A' }),
    row({ side: 'Sell', qty: 1, price: 7020, time: '2026-11-12 10:00:00', id: 'B' }),
  ]);
  const s = sessionSummary(r, '2026-11-12');
  assert.strictEqual(s.grossPnl, 100);  // only the 1 contract that closed
  assert.strictEqual(s.openPositionAtEnd, 2);
  assert.strictEqual(s.flatToFlat, false);
  assert.deepStrictEqual(r.openLotsAtEnd, [{ side: 'long', qty: 2, price: 7000 }]);
});

// ── Short-first round trips ───────────────────────────────────────────────
test('a short-first round trip profits when it is covered lower', () => {
  const r = one([
    row({ side: 'Sell', qty: 2, price: 7050, time: '2026-11-12 09:00:00', id: 'S' }),
    row({ side: 'Buy',  qty: 2, price: 7040, time: '2026-11-12 09:30:00', id: 'C' }),
  ]);
  const s = sessionSummary(r, '2026-11-12');
  assert.strictEqual(s.grossPnl, 100); // 10 pts x 2 x $5
  assert.strictEqual(s.contractSides, 4);
  assert.strictEqual(s.fees, 2.40);
  assert.strictEqual(s.netPnl, 97.60);
  assert.strictEqual(s.openPositionAtEnd, 0);
});

test('a short covered higher is a loss, not a gain', () => {
  const r = one([
    row({ side: 'Sell', qty: 1, price: 7000, time: '2026-11-12 09:00:00', id: 'S' }),
    row({ side: 'Buy',  qty: 1, price: 7008, time: '2026-11-12 09:30:00', id: 'C' }),
  ]);
  assert.strictEqual(sessionSummary(r, '2026-11-12').grossPnl, -40);
});

test('FIFO closes the oldest lot first, not the cheapest', () => {
  const r = one([
    row({ side: 'Buy',  qty: 1, price: 7000, time: '2026-11-12 09:00:00', id: 'L1' }),
    row({ side: 'Buy',  qty: 1, price: 7100, time: '2026-11-12 09:10:00', id: 'L2' }),
    row({ side: 'Sell', qty: 1, price: 7050, time: '2026-11-12 09:20:00', id: 'X'  }),
  ]);
  // FIFO closes the 7000 lot: +50 pts. LIFO would close 7100 and show -50 pts.
  assert.strictEqual(sessionSummary(r, '2026-11-12').grossPnl, 250);
  assert.deepStrictEqual(r.openLotsAtEnd, [{ side: 'long', qty: 1, price: 7100 }]);
});

test('one fill can close several lots and still flip the position', () => {
  const r = one([
    row({ side: 'Buy',  qty: 1, price: 7000, time: '2026-11-12 09:00:00', id: 'L1' }),
    row({ side: 'Buy',  qty: 1, price: 7010, time: '2026-11-12 09:05:00', id: 'L2' }),
    row({ side: 'Sell', qty: 3, price: 7020, time: '2026-11-12 09:10:00', id: 'FLIP' }),
  ]);
  const s = sessionSummary(r, '2026-11-12');
  assert.strictEqual(s.grossPnl, 150); // (20 + 10) pts x $5
  assert.strictEqual(s.openPositionAtEnd, -1);
  assert.deepStrictEqual(r.openLotsAtEnd, [{ side: 'short', qty: 1, price: 7020 }]);
});

// ── Fees and totals ───────────────────────────────────────────────────────
test('fees are contract-sides x $0.60, and net is gross minus fees', () => {
  const r = one([
    row({ side: 'Buy',  qty: 5, price: 7000, time: '2026-11-12 09:00:00', id: 'A' }),
    row({ side: 'Sell', qty: 5, price: 7001, time: '2026-11-12 09:30:00', id: 'B' }),
  ]);
  const s = sessionSummary(r, '2026-11-12');
  assert.strictEqual(s.contractSides, 10);
  assert.strictEqual(s.fees, 6.00);
  assert.strictEqual(s.grossPnl, 25);
  assert.strictEqual(s.netPnl, 19.00);
});

test('the fee rate is overridable without touching the module', () => {
  const r = one([
    row({ side: 'Buy',  qty: 1, price: 7000, time: '2026-11-12 09:00:00', id: 'A' }),
    row({ side: 'Sell', qty: 1, price: 7000, time: '2026-11-12 09:30:00', id: 'B' }),
  ], { perContractSideFee: 1.00 });
  assert.strictEqual(sessionSummary(r, '2026-11-12').fees, 2.00);
});

// ── Empty and malformed input ─────────────────────────────────────────────
test('an empty file is reported, not thrown', () => {
  const r = analyseOrderHistory('');
  assert.deepStrictEqual(r.sessions, []);
  assert.strictEqual(r.warning, 'TVCM-OH-NO-ROWS');
  assert.ok(r.errors.some(e => e.startsWith('TVCM-OH-EMPTY-FILE')));
});

test('a header with no rows yields no sessions and no error', () => {
  const r = analyseOrderHistory(HEADER);
  assert.deepStrictEqual(r.sessions, []);
  assert.strictEqual(r.warning, 'TVCM-OH-NO-ROWS');
  assert.deepStrictEqual(r.errors, []);
});

test('a file missing a required column names the column', () => {
  const r = analyseOrderHistory('Symbol,Side,Quantity\nF.US.MESZ26,Buy,5');
  assert.strictEqual(r.sessions.length, 0);
  assert.ok(r.errors[0].startsWith('TVCM-OH-BAD-HEADER'), r.errors[0]);
  assert.ok(/Fill quantity/.test(r.errors[0]) && /Order ID/.test(r.errors[0]), r.errors[0]);
});

test('garbage input does not throw', () => {
  for (const bad of [null, undefined, 'not a csv at all', '\n\n\n', '{"json":true}']) {
    assert.doesNotThrow(() => analyseOrderHistory(bad), `threw on ${JSON.stringify(bad)}`);
  }
});

test('a filled row with an unusable price or time is skipped and reported', () => {
  const r = one([
    row({ side: 'Buy',  qty: 1, price: 'abc',  time: '2026-11-12 09:00:00', id: 'BADPX' }),
    row({ side: 'Sell', qty: 1, price: 7000,   time: 'yesterday',           id: 'BADTIME' }),
    row({ side: 'Hold', qty: 1, price: 7000,   time: '2026-11-12 09:00:00', id: 'BADSIDE' }),
    row({ side: 'Buy',  qty: 1, price: 7000,   time: '2026-11-12 09:00:00', id: 'GOOD' }),
  ]);
  assert.strictEqual(r.fills.length, 1);
  assert.strictEqual(r.skipped.length, 3);
  assert.ok(r.skipped.every(s => s.reason.startsWith('TVCM-OH-BAD-ROW')));
});

test('quoted fields containing commas are parsed as one field', () => {
  assert.deepStrictEqual(oh.splitCsvLine('a,"b,c",d'), ['a', 'b,c', 'd']);
  assert.deepStrictEqual(oh.splitCsvLine('a,"say ""hi""",c'), ['a', 'say "hi"', 'c']);
});

// ── Row ordering ──────────────────────────────────────────────────────────
test('newest-first and oldest-first exports give the same answer', () => {
  const rows = [
    row({ side: 'Buy',  qty: 1, price: 7000, time: '2026-11-12 09:00:00', id: 'A' }),
    row({ side: 'Sell', qty: 1, price: 7010, time: '2026-11-12 10:00:00', id: 'B' }),
  ];
  const newestFirst = [HEADER, ...rows.slice().reverse()].join('\n');
  const oldestFirst = [HEADER, ...rows].join('\n');
  assert.deepStrictEqual(
    analyseOrderHistory(oldestFirst).sessions,
    analyseOrderHistory(newestFirst).sessions
  );
  assert.strictEqual(analyseOrderHistory(newestFirst).sessions[0].grossPnl, 50);
});

test('fills sharing a timestamp keep their true order in a newest-first export', () => {
  // Both buys stamp 09:00. The export lists them newest-first, so the 7000 buy
  // (last line) is the earlier fill and FIFO must close it, not the 7100 one.
  const text = [HEADER,
    row({ side: 'Sell', qty: 1, price: 7050, time: '2026-11-12 09:20:00', id: 'X'  }),
    row({ side: 'Buy',  qty: 1, price: 7100, time: '2026-11-12 09:00:00', id: 'L2' }),
    row({ side: 'Buy',  qty: 1, price: 7000, time: '2026-11-12 09:00:00', id: 'L1' }),
  ].join('\n');
  const r = analyseOrderHistory(text);
  assert.strictEqual(sessionSummary(r, '2026-11-12').grossPnl, 250, 'tied timestamps were matched in file order, not time order');
  assert.deepStrictEqual(r.openLotsAtEnd, [{ side: 'long', qty: 1, price: 7100 }]);
});

test('CRLF line endings parse the same as LF', () => {
  const rows = [
    row({ side: 'Buy',  qty: 1, price: 7000, time: '2026-11-12 09:00:00', id: 'A' }),
    row({ side: 'Sell', qty: 1, price: 7010, time: '2026-11-12 10:00:00', id: 'B' }),
  ];
  const lf   = [HEADER, ...rows].join('\n');
  const crlf = [HEADER, ...rows].join('\r\n');
  assert.deepStrictEqual(analyseOrderHistory(crlf).sessions, analyseOrderHistory(lf).sessions);
  // Splitting on \n alone leaves a carriage return on the end of every line, which
  // silently corrupts whichever column happens to be last.
  assert.deepStrictEqual(oh.splitCsvLines('a\r\nb\r\nc'), ['a', 'b', 'c']);
  assert.deepStrictEqual(oh.splitCsvLines('a\nb\n'), ['a', 'b']);
  assert.deepStrictEqual(oh.splitCsvLines('a\rb'), ['a', 'b']);
});
