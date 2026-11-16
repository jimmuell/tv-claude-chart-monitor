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

// ── AMP reads orders(), not allExecutions() (TVCM-29) ─────────────────────
// TVCM-28 found allExecutions() is ALWAYS empty on AMP. 46 real fills sat in
// orders() for fourteen hours while the feed reported itself healthy. These fix
// the source per broker, and every payload below is synthetic.

const { feedSourceFor, ordersToFills, detectOrderShape, fillsFromPayload,
        analyseFeed, crossCheck, sumBrokerProfit, sumOpenQty,
        REQUIRED_ORDER_FIELDS, HISTORY_LIMIT } = lf;

/** One synthetic AMP order, in the shape orders() returns. */
function order(over = {}) {
  const { statusTime, ...rest } = over;
  return {
    id: '336625414', symbol: 'CME_MINI:MESZ2026',
    side: -1, qty: 5, filledQty: 5, avgPrice: 7598.5,
    cqgStatus: 'Filled', status: 2,
    statusTime: statusTime === undefined ? '2026-11-15T23:10:00.575Z' : statusTime, // 17:10:00 CT
    ...rest,
  };
}

test('the source is chosen by broker, because the two do not agree', () => {
  assert.strictEqual(feedSourceFor('amp'), 'orders');
  assert.strictEqual(feedSourceFor('paper'), 'executions');
});

test('an AMP order becomes the same fill the CSV row would have produced', () => {
  const { fills, skipped } = ordersToFills([order()]);
  assert.deepStrictEqual(skipped, []);
  assert.deepStrictEqual(fills[0], {
    orderId: '336625414', symbol: 'CME_MINI:MESZ2026', side: 'Sell',
    qty: 5, price: 7598.5,
    fillTime: '2026-11-15 17:10:00', sessionDate: '2026-11-16',
    status: 'Filled', orderType: '', source: 'live-feed', line: 0,
  });
});

test('RULE 2 holds: a Cancelled order that filled part of its size still counts', () => {
  // Jim's own AMP history contains exactly this: qty 5, filledQty 2, Cancelled.
  const { fills } = ordersToFills([order({ id: '333202840', qty: 5, filledQty: 2, cqgStatus: 'Cancelled', status: 1 })]);
  assert.strictEqual(fills.length, 1, 'filtering on status would throw away 2 real contracts');
  assert.strictEqual(fills[0].qty, 2, 'the FILLED quantity is the one that counts');
});

test('an order that filled nothing is skipped silently, not reported as bad', () => {
  const { fills, skipped } = ordersToFills([order({ filledQty: 0, cqgStatus: 'Cancelled' })]);
  assert.deepStrictEqual(fills, []);
  assert.deepStrictEqual(skipped, [], 'a working or cancelled order is normal, not an error');
});

test('fill time comes from extra.status_utc_time and never from when_utc_time', () => {
  const f = ordersToFills([order({ when_utc_time: 688454553 })]).fills[0];
  assert.strictEqual(f.fillTime, '2026-11-15 17:10:00');
  const bad = ordersToFills([order({ statusTime: null, when_utc_time: 688454553 })]);
  assert.strictEqual(bad.fills.length, 0, 'no usable stamp means no fill, never a guess from when_utc_time');
  assert.match(bad.skipped[0].reason, /TVCM-LF-BAD-ORDER.*time/i);
});

test('a fill after 17:00 CT belongs to the next session', () => {
  assert.strictEqual(ordersToFills([order({ statusTime: '2026-11-15T23:10:00.575Z' })]).fills[0].sessionDate, '2026-11-16');
  assert.strictEqual(ordersToFills([order({ statusTime: '2026-11-16T06:19:39.602Z' })]).fills[0].sessionDate, '2026-11-16');
  assert.strictEqual(ordersToFills([order({ statusTime: '2026-11-16T20:00:00.000Z' })]).fills[0].sessionDate, '2026-11-16');
});

test('sides are decoded, and an unknown side is never guessed', () => {
  assert.strictEqual(ordersToFills([order({ side: 1 })]).fills[0].side, 'Buy');
  assert.strictEqual(ordersToFills([order({ side: -1 })]).fills[0].side, 'Sell');
  const odd = ordersToFills([order({ side: 0 })]);
  assert.strictEqual(odd.fills.length, 0);
  assert.match(odd.skipped[0].reason, /TVCM-LF-BAD-ORDER/);
});

test('the same order id is counted once, however many collections it arrives in', () => {
  const { fills } = ordersToFills([order(), order()]);
  assert.strictEqual(fills.length, 1);
  assert.strictEqual(fills[0].qty, 5, 'a repeated order doubled the quantity');
});

test('holes in the array do not crash the conversion — the TVCM-27 bug', () => {
  const withHoles = [order({ id: 'A' }), null, undefined, order({ id: 'B' })];
  assert.doesNotThrow(() => ordersToFills(withHoles));
  assert.strictEqual(ordersToFills(withHoles).fills.length, 2);
  assert.doesNotThrow(() => executionsToFills([exec({ id: 'x' }), null, undefined]));
  assert.strictEqual(executionsToFills([exec({ id: 'x' }), null, undefined]).fills.length, 1);
});

test('an unusable price or quantity is dropped with a reason, the rest survive', () => {
  const { fills, skipped } = ordersToFills([
    order({ id: 'ok' }),
    order({ id: 'noprice', avgPrice: 0 }),
    order({ id: 'nan', avgPrice: NaN }),
    order({ id: 'noid', id: '' }),
  ]);
  assert.strictEqual(fills.length, 1);
  assert.strictEqual(fills[0].orderId, 'ok');
  assert.strictEqual(skipped.length, 3, JSON.stringify(skipped));
});

// ── Shape detection for orders ────────────────────────────────────────────

test('the AMP order shape we measured is accepted', () => {
  const r = detectOrderShape([order()]);
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(r.missing, []);
});

test('every field the order conversion depends on is required', () => {
  assert.deepStrictEqual(REQUIRED_ORDER_FIELDS.slice().sort(),
    ['avgPrice', 'filledQty', 'id', 'side', 'statusTime']);
  for (const field of REQUIRED_ORDER_FIELDS) {
    const bad = order(); delete bad[field];
    const r = detectOrderShape([bad]);
    assert.strictEqual(r.ok, false, `a payload with no ${field} must be refused`);
    assert.ok(r.missing.includes(field));
  }
});

test('a shape judged on no rows is reported as empty, not quietly "OK"', () => {
  // This is what let the AMP blindness go unnoticed for fourteen hours.
  for (const r of [detectOrderShape([]), detectExecutionShape([])]) {
    assert.strictEqual(r.ok, true, 'an empty list is not a BROKEN shape');
    assert.strictEqual(r.empty, true, 'but it must never be reported as a shape that passed');
    assert.strictEqual(r.sampled, 0);
  }
  assert.strictEqual(detectOrderShape([order()]).empty, false);
});

// ── Picking the source from a whole payload ───────────────────────────────

test('on AMP the fills come from orders() unioned with ordersHistory()', () => {
  const p = {
    brokerId: 'amp',
    executions: [],
    orders: [order({ id: 'NEW', statusTime: '2026-11-15T23:10:00.575Z' })],
    ordersHistory: [order({ id: 'OLD', statusTime: '2026-11-10T20:00:00.000Z' })],
  };
  const r = fillsFromPayload(p);
  assert.strictEqual(r.source, 'orders');
  assert.strictEqual(r.fills.length, 2);
  assert.deepStrictEqual(r.fills.map(f => f.orderId).sort(), ['NEW', 'OLD']);
});

test('an order in both collections is counted once', () => {
  const r = fillsFromPayload({ brokerId: 'amp', orders: [order({ id: 'SAME' })], ordersHistory: [order({ id: 'SAME' })] });
  assert.strictEqual(r.fills.length, 1);
});

test('on paper the fills still come from allExecutions(), untouched', () => {
  const r = fillsFromPayload({ brokerId: 'paper', executions: [exec()], orders: [], ordersHistory: [] });
  assert.strictEqual(r.source, 'executions');
  assert.strictEqual(r.fills.length, 1);
  assert.strictEqual(r.fills[0].orderId, '3720527804');
});

test('a paper payload ignores any orders that happen to be present', () => {
  const r = fillsFromPayload({ brokerId: 'paper', executions: [], orders: [order()], ordersHistory: [] });
  assert.strictEqual(r.fills.length, 0, 'mixing the two sources is how a number gets double counted');
});

test('missing collections are survivable, not a crash', () => {
  for (const p of [{ brokerId: 'amp' }, { brokerId: 'paper' }, { brokerId: 'amp', orders: null, ordersHistory: null }]) {
    assert.doesNotThrow(() => fillsFromPayload(p));
    assert.deepStrictEqual(fillsFromPayload(p).fills, []);
  }
});

test('analyseFeed prices an AMP payload through the real engine', () => {
  const r = analyseFeed({
    brokerId: 'amp',
    orders: [
      order({ id: 'A', side: 1,  qty: 1, filledQty: 1, avgPrice: 7000, statusTime: '2026-11-15T23:30:00.000Z' }),
      order({ id: 'B', side: -1, qty: 1, filledQty: 1, avgPrice: 7010, statusTime: '2026-11-16T00:30:00.000Z' }),
    ],
  }, { perContractSideFee: 0.60 });
  assert.strictEqual(r.source, 'orders');
  assert.strictEqual(r.result.sessions.length, 1);
  const s = r.result.sessions[0];
  assert.strictEqual(s.sessionDate, '2026-11-16');
  assert.strictEqual(s.grossPnl, 50);
  assert.strictEqual(s.fees, 1.20);
  assert.strictEqual(s.netPnl, 48.80);
});

// ── The page expression ───────────────────────────────────────────────────

test('the expression reads orders and ordersHistory as well as executions', () => {
  const e = liveFeedExpression();
  // Named rather than literal-call, because the expression reads them through one
  // hole-guarding helper. Dropping a collection still fails this.
  for (const needed of ["'orders'", "'ordersHistory'", "'allExecutions'", "'positions'", 'status_utc_time']) {
    assert.ok(e.includes(needed), `the expression must read ${needed}`);
  }
  assert.ok(!e.includes('when_utc_time'), 'when_utc_time is not an epoch and must never be read');
});

test('the expression still calls nothing that could place, change or cancel an order', () => {
  const e = liveFeedExpression();
  for (const forbidden of ['placeOrder', 'modifyOrder', 'cancelOrder', 'cancelOrders',
                           'closePosition', 'closeIndividualPosition', 'reversePosition',
                           'editPositionBrackets', 'previewOrder', '.click(']) {
    assert.ok(!e.includes(forbidden), `the feed expression must never contain ${forbidden}`);
  }
});

test('the expression bounds how much history it ships back', () => {
  assert.ok(HISTORY_LIMIT > 0 && HISTORY_LIMIT <= 2000, `HISTORY_LIMIT=${HISTORY_LIMIT}`);
  assert.ok(liveFeedExpression().includes(String(HISTORY_LIMIT)),
    'the cap must be applied in the page, not after 1356 rows have crossed the wire');
});

// ── Never silently blind, and never falsely loud (TVCM-29 / TVCM-33) ─────
// TVCM-29 cross-checked the engine against positions()[*].profit. TVCM-31 found
// that field absent, then frozen across a closed round trip, then drifting — so
// the ⚠ it raised was false, and a ⚠ that is always on is a ⚠ that gets ignored.
//
// The cross-check is now INFORMATIONAL: it still reports, it never warns.
// BLIND still warns, on evidence that does not touch `profit` at all.

/** A cross-check input with everything agreeing; override one thing per test. */
function cc(over = {}) {
  return { fillCount: 46, engineGross: 302.50, brokerProfit: 302.50,
           openQty: 0, positionsAvailable: true,
           rawRowsThisSession: 46, otherCollectionRows: 0, ...over };
}

test('agreeing numbers raise nothing', () => {
  const r = crossCheck(cc());
  assert.strictEqual(r.state, 'ok');
  assert.strictEqual(r.code, null);
  assert.strictEqual(r.warn, false);
  assert.strictEqual(r.delta, 0);
});

test('a difference is reported but NEVER warns — the broker figure is not trustworthy', () => {
  const r = crossCheck(cc({ engineGross: 250 }));
  assert.strictEqual(r.state, 'differs');
  assert.strictEqual(r.warn, false, 'TVCM-31: this ⚠ was false and sat on the menu bar for hours');
  assert.strictEqual(r.code, null, 'an informational note must not carry an error code');
  assert.strictEqual(r.delta, -52.5);
  assert.ok(r.message.includes('250') && r.message.includes('302.5'), r.message);
});

test('a cent of difference is not even worth reporting', () => {
  assert.strictEqual(crossCheck(cc({ engineGross: 302.51 })).state, 'ok');
  assert.strictEqual(crossCheck(cc({ engineGross: 302.49 })).state, 'ok');
  assert.strictEqual(crossCheck(cc({ engineGross: 302.52 })).state, 'differs');
});

test('the message says the broker figure is the unreliable one, not ours', () => {
  const r = crossCheck(cc({ engineGross: 250 }));
  assert.match(r.message, /broker/i);
  assert.ok(!/wrong|error|fail/i.test(r.message), 'informational wording only: ' + r.message);
});

// ── BLIND: still warns, and never depends on positions().profit ──────────

test('an open position with no fills found is BLIND, with no reference to profit', () => {
  const r = crossCheck(cc({ fillCount: 0, engineGross: 0, brokerProfit: null,
                            positionsAvailable: true, openQty: 5, rawRowsThisSession: 0 }));
  assert.strictEqual(r.state, 'blind');
  assert.strictEqual(r.code, 'TVCM-LF-BLIND');
  assert.strictEqual(r.warn, true);
});

test('rows the broker returned that we converted into nothing is BLIND', () => {
  const r = crossCheck(cc({ fillCount: 0, engineGross: 0, brokerProfit: null,
                            openQty: 0, rawRowsThisSession: 12 }));
  assert.strictEqual(r.state, 'blind');
  assert.match(r.message, /12/, 'the message should say how many rows were ignored: ' + r.message);
});

test('the collection we did NOT read having rows is BLIND — this is exactly TVCM-28', () => {
  // allExecutions() empty on AMP while orders() held 46 fills, for fourteen hours.
  const r = crossCheck(cc({ fillCount: 0, engineGross: 0, brokerProfit: null,
                            openQty: 0, rawRowsThisSession: 0, otherCollectionRows: 46 }));
  assert.strictEqual(r.state, 'blind');
  assert.strictEqual(r.code, 'TVCM-LF-BLIND');
  assert.strictEqual(r.warn, true);
  assert.match(r.message, /other|wrong collection/i, r.message);
});

test('BLIND does not need the broker profit at all', () => {
  for (const bp of [null, undefined, 0, 302.5]) {
    const r = crossCheck(cc({ fillCount: 0, engineGross: 0, brokerProfit: bp, openQty: 5 }));
    assert.strictEqual(r.state, 'blind', `brokerProfit=${bp} must not change the verdict`);
  }
});

test('a genuinely flat day with nothing anywhere is not blind', () => {
  const r = crossCheck(cc({ fillCount: 0, engineGross: 0, brokerProfit: 0,
                            openQty: 0, rawRowsThisSession: 0, otherCollectionRows: 0 }));
  assert.strictEqual(r.state, 'ok');
  assert.strictEqual(r.warn, false);
});

test('blind outranks differs — it is the only one that warns', () => {
  const r = crossCheck(cc({ fillCount: 0, engineGross: 0, brokerProfit: 999, openQty: 5 }));
  assert.strictEqual(r.code, 'TVCM-LF-BLIND');
  assert.strictEqual(r.warn, true);
});

test('no broker figure means no comparison, and still no warning', () => {
  for (const over of [{ positionsAvailable: false }, { brokerProfit: null }]) {
    const r = crossCheck(cc(over));
    assert.strictEqual(r.state, 'unavailable');
    assert.strictEqual(r.code, null);
    assert.strictEqual(r.warn, false);
  }
});

test('the only code crossCheck can ever produce is TVCM-LF-BLIND', () => {
  const codes = new Set();
  for (const over of [{}, { engineGross: 1 }, { brokerProfit: null }, { positionsAvailable: false },
                      { fillCount: 0, engineGross: 0, openQty: 5 },
                      { fillCount: 0, engineGross: 0, rawRowsThisSession: 3 }]) {
    const c = crossCheck(cc(over)).code;
    if (c) codes.add(c);
  }
  assert.deepStrictEqual(Array.from(codes), ['TVCM-LF-BLIND']);
});

test('the broker profit is summed across symbols, not taken from the first row', () => {
  assert.strictEqual(sumBrokerProfit([{ profit: 100 }, { profit: 202.5 }]), 302.5);
  assert.strictEqual(sumBrokerProfit([]), null, 'no rows means no comparison, not zero');
  assert.strictEqual(sumBrokerProfit(null), null);
  assert.strictEqual(sumBrokerProfit([{ profit: null }, { profit: 5 }]), 5);
  assert.strictEqual(sumBrokerProfit([{ profit: null }]), null, 'all-null is still no answer');
});

test('open quantity counts contracts, not symbol rows', () => {
  assert.strictEqual(sumOpenQty([{ qty: 0 }]), 0, 'one flat symbol row is not one open position');
  assert.strictEqual(sumOpenQty([{ qty: 5 }, { qty: -3 }]), 8, 'a short is still an open position');
  assert.strictEqual(sumOpenQty([]), 0);
  assert.strictEqual(sumOpenQty(null), null);
});

// ── Position mismatch (TVCM-35 Task 2) ───────────────────────────────────
// TVCM-34: TVCM's rows implied short 5 while the broker's live position said
// flat, because a fill never reached orders(). Nothing noticed. positions().qty
// is the one broker field that is both LIVE and a direct answer — margin is a
// dollar amount, and OTE reads 0.00 both when flat and when price equals entry.

const { positionMismatch, sumPositionQty, POSITION_GRACE_MS } = lf;

const T0 = Date.parse('2026-11-16T19:00:00Z');

test('agreement is silent', () => {
  const r = positionMismatch({ engineQty: -5, brokerQty: -5, mismatchSince: null, now: T0 });
  assert.strictEqual(r.mismatch, false);
  assert.strictEqual(r.warn, false);
  assert.strictEqual(r.code, null);
  assert.strictEqual(r.since, null);
});

test('a fresh disagreement starts the clock but does not warn yet', () => {
  const r = positionMismatch({ engineQty: -5, brokerQty: 0, mismatchSince: null, now: T0 });
  assert.strictEqual(r.mismatch, true);
  assert.strictEqual(r.warn, false, 'a momentary gap between a fill and its position update is normal');
  assert.strictEqual(r.since, T0);
});

test('a disagreement that outlives the grace period warns', () => {
  const r = positionMismatch({ engineQty: -5, brokerQty: 0, mismatchSince: T0, now: T0 + 31_000 });
  assert.strictEqual(r.warn, true);
  assert.strictEqual(r.code, 'TVCM-LF-POSITION-MISMATCH');
  assert.match(r.message, /-5/);
  assert.match(r.message, /fill may be missing/i);
});

test('the grace period is 30 seconds, and the boundary is exclusive', () => {
  assert.strictEqual(POSITION_GRACE_MS, 30_000);
  assert.strictEqual(positionMismatch({ engineQty: 5, brokerQty: 0, mismatchSince: T0, now: T0 + 30_000 }).warn, false);
  assert.strictEqual(positionMismatch({ engineQty: 5, brokerQty: 0, mismatchSince: T0, now: T0 + 30_001 }).warn, true);
});

test('agreeing again clears the clock, so a later gap starts fresh', () => {
  const r = positionMismatch({ engineQty: 0, brokerQty: 0, mismatchSince: T0, now: T0 + 90_000 });
  assert.strictEqual(r.mismatch, false);
  assert.strictEqual(r.since, null);
  assert.strictEqual(r.warn, false);
});

test('a broker that reports no position is not a mismatch', () => {
  for (const q of [null, undefined]) {
    const r = positionMismatch({ engineQty: -5, brokerQty: q, mismatchSince: null, now: T0 });
    assert.strictEqual(r.mismatch, false, 'no answer is not a disagreement');
    assert.strictEqual(r.warn, false);
  }
});

test('the sign matters — long 5 against short 5 is a mismatch', () => {
  assert.strictEqual(positionMismatch({ engineQty: 5, brokerQty: -5, mismatchSince: T0, now: T0 + 31_000 }).warn, true);
});

test('the broker quantity is signed and summed across symbols', () => {
  assert.strictEqual(sumPositionQty([{ qty: -5 }, { qty: 2 }]), -3);
  assert.strictEqual(sumPositionQty([{ qty: 0 }]), 0);
  assert.strictEqual(sumPositionQty([]), 0);
  assert.strictEqual(sumPositionQty(null), null, 'no rows means no answer, not flat');
  assert.strictEqual(sumPositionQty([null, { qty: -5 }]), -5, 'holes must not throw');
});

test('the TVCM-34 situation would now be caught', () => {
  // Engine short 5 from its rows; broker live position flat; held for minutes.
  const r = positionMismatch({ engineQty: -5, brokerQty: 0, mismatchSince: T0, now: T0 + 10 * 60_000 });
  assert.strictEqual(r.code, 'TVCM-LF-POSITION-MISMATCH');
  assert.strictEqual(r.warn, true);
});
