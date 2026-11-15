'use strict';

// The live order feed: broker gating, shape detection and the conversion from
// TradingView executions to the engine's fills.
//
// Every payload here is SYNTHETIC and paper-shaped — the field names and value
// encodings are the ones TVCM-25 measured on the paper broker, but no real trade
// row is in this file. The AMP shape is unproven, which is exactly why
// detectExecutionShape() exists and is tested hard.

const test   = require('node:test');
const assert = require('node:assert');
const path   = require('path');

const lf = require(path.join(__dirname, '../../src/shared/live-feed.js'));
const { brokerAvailability, detectExecutionShape, executionsToFills,
        analyseExecutions, liveFeedExpression,
        REQUIRED_EXECUTION_FIELDS } = lf;

/** One synthetic execution in the shape the paper broker returns. */
function exec(over = {}) {
  return {
    id: '2688261817', orderId: '3720527804', symbol: 'CME_MINI:MES1!',
    price: 7734.5, qty: 5, side: -1,
    time: Date.parse('2026-10-26T15:07:25Z'),   // 10:07:25 CT
    commission: null, currencyRate: 1, pointValue: 5,
    ...over,
  };
}

// ── Broker gating ─────────────────────────────────────────────────────────
// Off = live, reads only when _brokerId is "amp". On = paper, only when "paper".

test('live mode reads the AMP account and nothing else', () => {
  const a = brokerAvailability('amp', false);
  assert.strictEqual(a.available, true);
  assert.strictEqual(a.state, 'ok');
  assert.strictEqual(a.errorCode, null);
  assert.strictEqual(a.warn, false);
});

test('paper mode reads the paper account and nothing else', () => {
  const a = brokerAvailability('paper', true);
  assert.strictEqual(a.available, true);
  assert.strictEqual(a.state, 'ok');
  assert.strictEqual(a.warn, false);
});

test('replay is "not available", not an error — no code and no warning marker', () => {
  for (const paper of [false, true]) {
    const a = brokerAvailability('replaybroker', paper);
    assert.strictEqual(a.available, false, 'replay must never be read');
    assert.strictEqual(a.state, 'replay');
    assert.strictEqual(a.errorCode, null, 'replay is a normal state, not a fault');
    assert.strictEqual(a.warn, false, 'replay must not put a warning in the menu bar');
    assert.match(a.reason, /replay/i);
  }
});

test('an account that does not match the toggle warns, and says which way to switch', () => {
  const live = brokerAvailability('paper', false);   // toggle off, TradingView on paper
  assert.strictEqual(live.available, false);
  assert.strictEqual(live.state, 'mismatch');
  assert.strictEqual(live.errorCode, 'TVCM-LF-ACCOUNT-MISMATCH');
  assert.strictEqual(live.warn, true);
  assert.match(live.switchHint, /paper mode on|switch TradingView to.*AMP/i);

  const paper = brokerAvailability('amp', true);     // toggle on, TradingView on AMP
  assert.strictEqual(paper.available, false);
  assert.strictEqual(paper.state, 'mismatch');
  assert.strictEqual(paper.errorCode, 'TVCM-LF-ACCOUNT-MISMATCH');
  assert.strictEqual(paper.warn, true);
  assert.match(paper.switchHint, /paper mode off|switch TradingView to.*paper/i);
});

test('an unrecognised broker id does nothing and warns', () => {
  for (const id of ['tradestation', 'DUMMY', 'amp_live', '']) {
    const a = brokerAvailability(id, false);
    assert.strictEqual(a.available, false, `must not read broker ${JSON.stringify(id)}`);
    assert.strictEqual(a.state, id === '' ? 'absent' : 'unknown');
    assert.strictEqual(a.errorCode, id === '' ? 'TVCM-LF-NO-BROKER' : 'TVCM-LF-UNKNOWN-BROKER');
    assert.strictEqual(a.warn, true);
  }
});

test('a missing broker id is never read as "probably fine"', () => {
  for (const id of [null, undefined]) {
    const a = brokerAvailability(id, false);
    assert.strictEqual(a.available, false);
    assert.strictEqual(a.errorCode, 'TVCM-LF-NO-BROKER');
    assert.strictEqual(a.warn, true);
  }
});

// ── Shape detection ───────────────────────────────────────────────────────
// The AMP adapter is unproven. If it does not look like what we measured, the
// feed must say "can't read this TradingView version" rather than guess.

test('the paper shape we measured is accepted', () => {
  const r = detectExecutionShape([exec(), exec({ id: '2', orderId: '2' })]);
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(r.missing, []);
  assert.deepStrictEqual(r.badTypes, []);
});

test('every field the conversion depends on is required', () => {
  assert.deepStrictEqual(REQUIRED_EXECUTION_FIELDS.slice().sort(),
    ['id', 'orderId', 'price', 'qty', 'side', 'symbol', 'time']);
  for (const field of REQUIRED_EXECUTION_FIELDS) {
    const bad = exec();
    delete bad[field];
    const r = detectExecutionShape([bad]);
    assert.strictEqual(r.ok, false, `a payload with no ${field} must be refused`);
    assert.ok(r.missing.includes(field), `${field} should be reported missing: ${JSON.stringify(r.missing)}`);
  }
});

test('a field of the wrong type is refused as loudly as a missing one', () => {
  const r = detectExecutionShape([exec({ price: '7734.5', qty: '5', time: '2026-10-26' })]);
  assert.strictEqual(r.ok, false);
  assert.deepStrictEqual(r.badTypes.slice().sort(), ['price', 'qty', 'time']);
});

test('an empty list is a shape we cannot judge, not a broken one', () => {
  const r = detectExecutionShape([]);
  assert.strictEqual(r.ok, true, 'no executions is a normal flat day, not a bad version');
  assert.strictEqual(r.sampled, 0);
});

test('something that is not an array at all is refused', () => {
  for (const v of [null, undefined, {}, 'nope', 7]) {
    const r = detectExecutionShape(v);
    assert.strictEqual(r.ok, false, `${JSON.stringify(v)} must be refused`);
    assert.strictEqual(r.notAnArray, true);
  }
});

test('pointValue is noted when absent but does not fail the shape', () => {
  const noPv = exec(); delete noPv.pointValue;
  const r = detectExecutionShape([noPv]);
  assert.strictEqual(r.ok, true, 'the fee model supplies a point value, so this is survivable');
  assert.strictEqual(r.pointValueMissing, true);
});

// ── Conversion to engine fills ────────────────────────────────────────────

test('an execution becomes a fill the engine already knows how to price', () => {
  const { fills, skipped } = executionsToFills([exec()]);
  assert.deepStrictEqual(skipped, []);
  assert.strictEqual(fills.length, 1);
  assert.deepStrictEqual(fills[0], {
    orderId:     '3720527804',
    symbol:      'CME_MINI:MES1!',
    side:        'Sell',
    qty:         5,
    price:       7734.5,
    fillTime:    '2026-10-26 10:07:25',
    sessionDate: '2026-10-26',
    status:      'Filled',
    orderType:   '',
    source:      'live-feed',
    line:        0,
  });
});

test('side is decoded the way TradingView encodes it, and nothing else is guessed', () => {
  assert.strictEqual(executionsToFills([exec({ side: 1 })]).fills[0].side, 'Buy');
  assert.strictEqual(executionsToFills([exec({ side: -1 })]).fills[0].side, 'Sell');
  const odd = executionsToFills([exec({ side: 0 })]);
  assert.strictEqual(odd.fills.length, 0, 'an unknown side must never be guessed as Buy');
  assert.strictEqual(odd.skipped[0].reason.startsWith('TVCM-LF-BAD-EXECUTION'), true);
});

test('a fill after 17:00 CT belongs to the next session, exactly as the CSV path says', () => {
  // 2026-11-08 17:00:20 CT -> session 2026-11-09
  const late = exec({ time: Date.parse('2026-11-08T23:00:20Z') });
  const f = executionsToFills([late]).fills[0];
  assert.strictEqual(f.fillTime, '2026-11-08 17:00:20');
  assert.strictEqual(f.sessionDate, '2026-11-09');
});

test('several executions of one order become the single fill the CSV would have shown', () => {
  // A 5-lot that filled 2 then 3, which the CSV reports as one row: qty 5 at the
  // weighted average, timed when the order finished.
  const { fills } = executionsToFills([
    exec({ id: 'x1', orderId: 'O1', side: 1, qty: 2, price: 7000, time: Date.parse('2026-11-12T15:00:00Z') }),
    exec({ id: 'x2', orderId: 'O1', side: 1, qty: 3, price: 7010, time: Date.parse('2026-11-12T15:00:05Z') }),
  ]);
  assert.strictEqual(fills.length, 1, 'partial fills of one order must not become two orders');
  assert.strictEqual(fills[0].qty, 5);
  assert.strictEqual(fills[0].price, 7006);            // (2*7000 + 3*7010) / 5
  assert.strictEqual(fills[0].fillTime, '2026-11-12 09:00:05', 'timed when the order finished');
  assert.strictEqual(fills[0].executionCount, undefined, 'the fill shape stays exactly the CSV shape');
});

test('a partial fill on each side of one order keeps them apart', () => {
  const { fills, skipped } = executionsToFills([
    exec({ id: 'x1', orderId: 'O1', side: 1,  qty: 2, price: 7000 }),
    exec({ id: 'x2', orderId: 'O1', side: -1, qty: 3, price: 7010 }),
  ]);
  assert.strictEqual(fills.length, 0, 'one order cannot be both bought and sold');
  assert.strictEqual(skipped.length, 1);
  assert.match(skipped[0].reason, /TVCM-LF-BAD-EXECUTION.*side/i);
});

test('a duplicate execution id is counted once, however often it is polled', () => {
  const { fills } = executionsToFills([exec({ id: 'dup' }), exec({ id: 'dup' })]);
  assert.strictEqual(fills.length, 1);
  assert.strictEqual(fills[0].qty, 5, 'a repeated execution doubled the quantity');
});

test('an unusable execution is dropped with a reason, and the rest still convert', () => {
  const { fills, skipped } = executionsToFills([
    exec({ id: 'good', orderId: 'G' }),
    exec({ id: 'bad', orderId: 'B', qty: 0 }),
    exec({ id: 'bad2', orderId: 'B2', price: NaN }),
    exec({ id: 'bad3', orderId: 'B3', time: -1 }),
  ]);
  assert.strictEqual(fills.length, 1);
  assert.strictEqual(fills[0].orderId, 'G');
  assert.strictEqual(skipped.length, 3, JSON.stringify(skipped));
});

test('an empty execution list converts to no fills and no complaints', () => {
  assert.deepStrictEqual(executionsToFills([]), { fills: [], skipped: [] });
});

// ── Through the engine ────────────────────────────────────────────────────

test('a round trip through the real engine prices exactly as the CSV path does', () => {
  const r = analyseExecutions([
    exec({ id: 'a', orderId: 'A', side: 1,  qty: 1, price: 7000, time: Date.parse('2026-11-12T15:00:00Z') }),
    exec({ id: 'b', orderId: 'B', side: -1, qty: 1, price: 7010, time: Date.parse('2026-11-12T16:00:00Z') }),
  ]);
  assert.strictEqual(r.sessions.length, 1);
  const s = r.sessions[0];
  assert.strictEqual(s.sessionDate, '2026-11-12');
  assert.strictEqual(s.grossPnl, 50);        // 10 pts x 1 x $5
  assert.strictEqual(s.contractSides, 2);
  assert.strictEqual(s.fees, 1.20);          // $0.60 per contract per side
  assert.strictEqual(s.netPnl, 48.80);
});

test('paper commissions are null, so fees still come from the rate and never from the feed', () => {
  const r = analyseExecutions([
    exec({ id: 'a', orderId: 'A', side: 1,  qty: 2, price: 7000, commission: null, time: Date.parse('2026-11-12T15:00:00Z') }),
    exec({ id: 'b', orderId: 'B', side: -1, qty: 2, price: 7000, commission: null, time: Date.parse('2026-11-12T16:00:00Z') }),
  ]);
  assert.strictEqual(r.sessions[0].fees, 2.40, '4 contract-sides x $0.60');
  assert.strictEqual(r.sessions[0].netPnl, -2.40);
});

test('the fee rate is configurable, so it cannot drift from the fee calculator', () => {
  const r = analyseExecutions([
    exec({ id: 'a', orderId: 'A', side: 1,  qty: 1, price: 7000, time: Date.parse('2026-11-12T15:00:00Z') }),
    exec({ id: 'b', orderId: 'B', side: -1, qty: 1, price: 7000, time: Date.parse('2026-11-12T16:00:00Z') }),
  ], { perContractSideFee: 1.00 });
  assert.strictEqual(r.sessions[0].fees, 2.00);
});

test('no executions yields no sessions rather than a fabricated flat day', () => {
  const r = analyseExecutions([]);
  assert.deepStrictEqual(r.sessions, []);
  assert.strictEqual(r.warning, 'TVCM-OH-NO-ROWS');
});

// ── The page expression ───────────────────────────────────────────────────

test('the read expression checks the broker in the same expression as the read', () => {
  const expr = liveFeedExpression();
  assert.ok(expr.includes('_brokerId'), 'the gate must be in the expression');
  assert.ok(expr.includes('allExecutions'), 'it must read allExecutions, not ordersHistory');
  const gateAt = expr.indexOf('_brokerId');
  const readAt = expr.indexOf('allExecutions');
  assert.ok(gateAt < readAt, 'the gate must be read before the executions, in one round trip');
});

test('the read expression calls nothing that could place, change or cancel an order', () => {
  const expr = liveFeedExpression();
  for (const forbidden of ['placeOrder', 'modifyOrder', 'cancelOrder', 'cancelOrders',
                           'closePosition', 'closeIndividualPosition', 'reversePosition',
                           'editPositionBrackets', 'previewOrder', '.click(']) {
    assert.ok(!expr.includes(forbidden), `the feed expression must never contain ${forbidden}`);
  }
});

test('the read expression returns a string, because deep objects break CDP transfer', () => {
  assert.ok(liveFeedExpression().includes('JSON.stringify'),
    'TVCM-25 hit "Object reference chain is too long" returning live broker objects by value');
});
