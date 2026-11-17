'use strict';

// Recording fills that really happened but are missing from TradingView's records.
//
// Every fixture here is SYNTHETIC. It reproduces the SHAPE of what TVCM-34/35 found on
// Jim's account — an orphaned sell whose closing buy never arrived, which re-pairs every
// later FIFO match — without putting a single real trade row in the repo.

const test   = require('node:test');
const assert = require('node:assert');
const path   = require('path');

const c = require(path.join(__dirname, '../../src/shared/corrections.js'));
const { analyseFills } = require(path.join(__dirname, '../../src/shared/order-history.js'));

/** One engine fill. */
function fill(side, qty, price, fillTime, orderId) {
  return { orderId, symbol: 'MES', side, qty, price, fillTime,
           sessionDate: c.sessionDateForStamp(fillTime), status: 'Filled', orderType: '', source: 'test', line: 0 };
}

// The shape of the fault: a sell at 11:10 whose exit never arrived, then a second short
// that DID get its take-profit. FIFO pairs the orphan against the later buy.
const DAY = [
  fill('Sell', 5, 7482.75, '2026-11-16 11:10:09', 'A'),
  fill('Sell', 5, 7469.00, '2026-11-16 11:46:23', 'B'),
  fill('Buy',  5, 7465.00, '2026-11-16 12:00:33', 'C'),
];

/** The correction that puts the missing exit back. */
function missingExit(over = {}) {
  return c.makeCorrection({
    side: 'Buy', qty: 5, price: 7480.50, fillTime: '2026-11-16 11:10:09',
    source: 'inferred from balance', status: 'added', symbol: 'MES', ...over,
  });
}

const price = (fills) => analyseFills(fills, { perContractSideFee: 0.60 }).sessions
  .find(s => s.sessionDate === '2026-11-16');

// ── The fault, reproduced ─────────────────────────────────────────────────

test('without the missing fill the day does not balance and FIFO mispairs', () => {
  const s = price(DAY);
  assert.strictEqual(s.openPositionAtEnd, -5, 'the orphaned sell is left open');
  // The buy at 7465 closes the 11:10 sell at 7482.75 instead of the 11:46 one.
  assert.strictEqual(s.grossPnl, 443.75);   // 17.75 pts x 5 x $5
});

test('adding the missing fill makes the day flat and restores the pairing', () => {
  const { result } = c.analyseWithCorrections(DAY, [missingExit()], { perContractSideFee: 0.60 });
  const s = result.sessions.find(x => x.sessionDate === '2026-11-16');
  assert.strictEqual(s.openPositionAtEnd, 0, 'the day must balance');
  // 7482.75 -> 7480.50 = +2.25 pts, and 7469 -> 7465 = +4 pts, each 5 lots at $5.
  assert.strictEqual(s.grossPnl, 156.25);
  assert.strictEqual(s.contractSides, 20);
  assert.strictEqual(s.fees, 12.00);
  assert.strictEqual(s.netPnl, 144.25);
});

test('removing the correction restores the old numbers exactly', () => {
  const list = [missingExit()];
  const before = price(DAY);
  const after = c.analyseWithCorrections(DAY, c.removeCorrection(list, missingExit().id),
    { perContractSideFee: 0.60 }).result.sessions.find(x => x.sessionDate === '2026-11-16');
  assert.strictEqual(after.grossPnl, before.grossPnl);
  assert.strictEqual(after.openPositionAtEnd, before.openPositionAtEnd);
  assert.strictEqual(after.contractSides, before.contractSides);
});

test('nothing from TradingView is ever removed by a correction', () => {
  const { fills } = c.applyCorrections(DAY, [missingExit()]);
  for (const f of DAY) assert.ok(fills.some(x => x.orderId === f.orderId), `lost ${f.orderId}`);
  assert.strictEqual(fills.length, DAY.length + 1);
});

// ── Nothing is added without Jim ──────────────────────────────────────────

test('a suggestion is never applied — only an added or confirmed correction is', () => {
  for (const status of ['suggested']) {
    const { fills, appliedIds } = c.applyCorrections(DAY, [missingExit({ status })]);
    assert.strictEqual(fills.length, DAY.length, `${status} must not change the numbers`);
    assert.deepStrictEqual(appliedIds, []);
  }
  for (const status of ['added', 'confirmed']) {
    assert.strictEqual(c.applyCorrections(DAY, [missingExit({ status })]).fills.length, DAY.length + 1);
  }
});

test('a correction never crosses modes', () => {
  const paper = missingExit({ mode: 'paper' });
  assert.strictEqual(c.applyCorrections(DAY, [paper], { mode: 'live' }).fills.length, DAY.length);
  assert.strictEqual(c.applyCorrections(DAY, [paper], { mode: 'paper' }).fills.length, DAY.length + 1);
});

// ── A real fill always wins ───────────────────────────────────────────────

test('a later real fill supersedes an inferred correction, never counted twice', () => {
  const real = DAY.concat([fill('Buy', 5, 7480.50, '2026-11-16 11:20:00', 'REAL')]);
  const { fills, appliedIds, superseded } = c.applyCorrections(real, [missingExit()]);
  assert.strictEqual(fills.length, real.length, 'the correction was added on top of the real fill');
  assert.deepStrictEqual(appliedIds, []);
  assert.deepStrictEqual(superseded, [missingExit().id]);
});

test('a real fill one tick away still supersedes; a very different one does not', () => {
  const close = DAY.concat([fill('Buy', 5, 7480.25, '2026-11-16 11:20:00', 'R1')]);
  assert.strictEqual(c.applyCorrections(close, [missingExit()]).superseded.length, 1);
  const far = DAY.concat([fill('Buy', 5, 7450.00, '2026-11-16 11:20:00', 'R2')]);
  assert.strictEqual(c.applyCorrections(far, [missingExit()]).superseded.length, 0);
});

test('a real fill hours away is a different trade, not the same one', () => {
  const late = DAY.concat([fill('Buy', 5, 7480.50, '2026-11-16 15:30:00', 'R3')]);
  assert.strictEqual(c.applyCorrections(late, [missingExit()]).superseded.length, 0);
});

test('the wrong side or size never supersedes', () => {
  for (const f of [fill('Sell', 5, 7480.50, '2026-11-16 11:20:00', 'X'),
                   fill('Buy',  1, 7480.50, '2026-11-16 11:20:00', 'Y')]) {
    assert.strictEqual(c.applyCorrections(DAY.concat([f]), [missingExit()]).superseded.length, 0);
  }
});

// ── Building a correction ─────────────────────────────────────────────────

test('a correction knows its session, which is not its calendar day', () => {
  const evening = c.makeCorrection({ side: 'Buy', qty: 5, price: 7000, fillTime: '2026-11-15 17:10:00', status: 'added' });
  assert.strictEqual(evening.sessionDate, '2026-11-16', 'Sunday evening belongs to Monday');
});

test('nonsense is refused rather than stored', () => {
  for (const bad of [{}, { side: 'Long', qty: 5, price: 1, fillTime: '2026-11-16 11:00:00' },
                     { side: 'Buy', qty: 0, price: 1, fillTime: '2026-11-16 11:00:00' },
                     { side: 'Buy', qty: 5, price: 0, fillTime: '2026-11-16 11:00:00' },
                     { side: 'Buy', qty: 5, price: 1, fillTime: 'nonsense' }]) {
    assert.strictEqual(c.makeCorrection(bad), null, JSON.stringify(bad));
  }
});

test('a correction defaults to suggested and to the weakest source', () => {
  const made = c.makeCorrection({ side: 'Buy', qty: 5, price: 7480.5, fillTime: '2026-11-16 11:10:09' });
  assert.strictEqual(made.status, 'suggested');
  assert.strictEqual(made.source, 'inferred from balance');
  assert.strictEqual(made.mode, 'live');
});

test('a correction fill is marked so the window can label the row', () => {
  const f = c.correctionToFill(missingExit());
  assert.strictEqual(f.isCorrection, true);
  assert.ok(String(f.orderId).startsWith('correction:'));
  assert.ok(String(f.source).includes('inferred from balance'));
});

// ── The suggestion ────────────────────────────────────────────────────────

test('the solve names side, size, window and a price that matches the broker', () => {
  const s = c.suggestMissingFill({ fills: DAY, brokerQty: 0, brokerGross: 156.25 });
  assert.strictEqual(s.side, 'Buy');
  assert.strictEqual(s.qty, 5);
  assert.strictEqual(s.price, 7480.50);
  assert.strictEqual(s.windowFrom, '2026-11-16 11:10:09');
  assert.strictEqual(s.windowTo, '2026-11-16 11:46:23');
  assert.strictEqual(s.unmatchedOrderId, 'A');
});

test('the solved price reproduces the broker figure when applied', () => {
  const s = c.suggestMissingFill({ fills: DAY, brokerQty: 0, brokerGross: 156.25 });
  const made = c.makeCorrection({ side: s.side, qty: s.qty, price: s.price,
                                  fillTime: s.windowFrom, status: 'added' });
  const out = c.analyseWithCorrections(DAY, [made], { perContractSideFee: 0.60 })
    .result.sessions.find(x => x.sessionDate === '2026-11-16');
  assert.strictEqual(out.grossPnl, 156.25, 'the solve must be self-consistent');
  assert.strictEqual(out.openPositionAtEnd, 0);
});

test('nothing is suggested when the rows already balance', () => {
  const balanced = DAY.concat([fill('Buy', 5, 7480.50, '2026-11-16 11:20:00', 'R')]);
  assert.strictEqual(c.suggestMissingFill({ fills: balanced, brokerQty: 0, brokerGross: 156.25 }), null);
});

test('nothing is suggested while the broker also has a position open', () => {
  assert.strictEqual(c.suggestMissingFill({ fills: DAY, brokerQty: -5, brokerGross: 443.75 }), null,
    'then TVCM is right and there is nothing missing');
});

test('with no broker figure it asks for the price instead of guessing one', () => {
  for (const g of [null, undefined, NaN]) {
    const s = c.suggestMissingFill({ fills: DAY, brokerQty: 0, brokerGross: g });
    assert.strictEqual(s.needsPrice, true);
    assert.strictEqual(s.price, null);
    assert.strictEqual(s.side, 'Buy');
    assert.strictEqual(s.qty, 5);
  }
});

test('a missing SELL is suggested just as readily as a missing buy', () => {
  const longDay = [
    fill('Buy',  5, 7000, '2026-11-16 11:10:00', 'A'),
    fill('Buy',  5, 7010, '2026-11-16 11:46:00', 'B'),
    fill('Sell', 5, 7020, '2026-11-16 12:00:00', 'C'),
  ];
  const s = c.suggestMissingFill({ fills: longDay, brokerQty: 0, brokerGross: 500 });
  assert.strictEqual(s.side, 'Sell');
  assert.strictEqual(s.qty, 5);
});

test('the banner sentence reads the way Jim will see it', () => {
  const s = c.suggestMissingFill({ fills: DAY, brokerQty: 0, brokerGross: 156.25 });
  const text = c.suggestionText(s);
  assert.match(text, /A fill is missing from TradingView/);
  assert.match(text, /Buy 5 @ 7480\.50/);
  assert.match(text, /between 11:10 and 11:46/);
});

test('the no-price banner says a price has to be entered', () => {
  const text = c.suggestionText(c.suggestMissingFill({ fills: DAY, brokerQty: 0, brokerGross: null }));
  assert.match(text, /entered/i);
  assert.ok(!/@/.test(text), 'it must not show a made-up price: ' + text);
});

test('no suggestion yields no banner', () => {
  assert.strictEqual(c.suggestionText(null), null);
});

// ── Rule 4: a correction never becomes a session on its own (TVCM-38/39) ──
//
// Jim's export stopped on the Friday. His Monday correction was the only row the export
// path had for Monday, so applyCorrections() did not patch a session — it invented one:
// a lone Buy 5, gross $0.00, fees $3.00, and "-$3.00" in the menu bar with no trade
// behind it. These fixtures reproduce that shape.

/** A Friday the export DOES cover, flat to flat. */
const FRIDAY = [
  fill('Buy',  5, 7600.00, '2026-11-13 09:00:00', 'F1'),
  fill('Sell', 5, 7605.00, '2026-11-13 09:30:00', 'F2'),
];

test('a correction never becomes a session on its own', () => {
  const { fills, appliedIds, withheld } = c.applyCorrections(FRIDAY, [missingExit()]);
  assert.strictEqual(fills.length, FRIDAY.length, 'nothing was added');
  assert.deepStrictEqual(appliedIds, []);
  assert.deepStrictEqual(withheld, [missingExit().id]);

  const priced = analyseFills(fills, { perContractSideFee: 0.60 });
  assert.strictEqual(priced.sessions.find(s => s.sessionDate === '2026-11-16'), undefined,
    'a day the source does not cover must not acquire a session');
});

test('the invented session was exactly what reached the menu bar', () => {
  // What the old behaviour produced, pinned so it can never come back unnoticed.
  const invented = analyseFills(FRIDAY.concat([c.correctionToFill(missingExit())]),
    { perContractSideFee: 0.60 }).sessions.find(s => s.sessionDate === '2026-11-16');
  assert.strictEqual(invented.netPnl, -3);
  assert.strictEqual(invented.grossPnl, 0);
  assert.strictEqual(invented.openPositionAtEnd, 5);
  // And what the fix produces instead: no such session at all.
  const now = c.analyseWithCorrections(FRIDAY, [missingExit()], { perContractSideFee: 0.60 });
  assert.strictEqual(now.result.sessions.find(s => s.sessionDate === '2026-11-16'), undefined);
  assert.deepStrictEqual(now.withheld, [missingExit().id]);
});

test('a withheld correction is kept, and applies the moment the day is covered', () => {
  const list = [missingExit()];
  assert.deepStrictEqual(c.applyCorrections(FRIDAY, list).withheld, [missingExit().id]);
  // The same list, unchanged, against a source that does cover Monday.
  const covered = c.applyCorrections(FRIDAY.concat(DAY), list);
  assert.deepStrictEqual(covered.withheld, []);
  assert.deepStrictEqual(covered.appliedIds, [missingExit().id]);
  assert.strictEqual(list.length, 1, 'the correction was never removed from the file');
});

test('a day with records but no matching fill is still corrected, as before', () => {
  // Rule 4 must not swallow the case the whole feature exists for.
  const { appliedIds, withheld } = c.applyCorrections(DAY, [missingExit()]);
  assert.deepStrictEqual(appliedIds, [missingExit().id]);
  assert.deepStrictEqual(withheld, []);
});

test('withholding is judged per day, not across the whole set', () => {
  const alsoFriday = c.makeCorrection({ side: 'Buy', qty: 1, price: 7601, status: 'added',
                                        fillTime: '2026-11-13 09:15:00' });
  const { appliedIds, withheld } = c.applyCorrections(FRIDAY, [missingExit(), alsoFriday]);
  assert.deepStrictEqual(appliedIds, [alsoFriday.id], 'the covered day is corrected');
  assert.deepStrictEqual(withheld, [missingExit().id], 'the uncovered day is not');
});

test('a correction held back is not reported as superseded', () => {
  // The two outcomes mean different things: superseded is finished with, withheld is waiting.
  const { superseded, withheld } = c.applyCorrections(FRIDAY, [missingExit()]);
  assert.deepStrictEqual(superseded, []);
  assert.deepStrictEqual(withheld, [missingExit().id]);
});

test('dayIsCovered answers the one question rule 4 asks', () => {
  assert.strictEqual(c.dayIsCovered(DAY, '2026-11-16'), true);
  assert.strictEqual(c.dayIsCovered(FRIDAY, '2026-11-16'), false);
  assert.strictEqual(c.dayIsCovered([], '2026-11-16'), false);
  assert.strictEqual(c.dayIsCovered(null, '2026-11-16'), false);
});

// ── A suggestion must be a price that could have traded (TVCM-42) ────────
//
// On 2026-11-17 the solve offered **Buy 1 @ 7,375.67** and Jim accepted it. MES trades in
// quarter points; 7,375.67 has never printed. It came out because the broker gross it was
// solved against was wrong by a day of fees (219.60) — and an impossible answer is the
// loudest possible signal that an input is wrong, so it must never be offered as advice.

test('the price that was actually offered is rejected', () => {
  const v = c.validateSuggestion({ price: 7375.67, qty: 1, imbalanceQty: -1 });
  assert.strictEqual(v.ok, false);
  assert.match(v.problems.join(' '), /not on a 0\.25 tick/);
});

test('quarter points pass and anything between them does not', () => {
  for (const p of [7375.00, 7375.25, 7375.50, 7375.75, 7376.00, 0.25, 12345.75]) {
    assert.strictEqual(c.onTick(p), true, String(p));
  }
  for (const p of [7375.67, 7375.1, 7375.3, 7375.99, 7375.125]) {
    assert.strictEqual(c.onTick(p), false, String(p));
  }
});

test('a tick check survives floating point', () => {
  // 0.1 + 0.15 is not exactly 0.25 in binary, and the solve divides before it rounds.
  assert.strictEqual(c.onTick(0.1 + 0.15), true);
  assert.strictEqual(c.onTick(7331.7499999999), true);
  assert.strictEqual(c.onTick(7331.74), false);
});

test('the size must equal the imbalance, not merely be a number', () => {
  assert.strictEqual(c.validateSuggestion({ price: 7331.75, qty: 1, imbalanceQty: -1 }).ok, true);
  const v = c.validateSuggestion({ price: 7331.75, qty: 5, imbalanceQty: -1 });
  assert.strictEqual(v.ok, false);
  assert.match(v.problems.join(' '), /size is 5 but the rows are out by 1/);
});

test('a price outside the bar it claims to have traded in is rejected', () => {
  const bar = { time: Date.parse('2026-11-17T19:53:00Z') / 1000, low: 7340, high: 7350 };
  assert.strictEqual(c.validateSuggestion({ price: 7345.00, qty: 1, imbalanceQty: -1, bar }).ok, true);
  assert.strictEqual(c.validateSuggestion({ price: 7340.00, qty: 1, imbalanceQty: -1, bar }).ok, true, 'the low itself traded');
  assert.strictEqual(c.validateSuggestion({ price: 7350.00, qty: 1, imbalanceQty: -1, bar }).ok, true, 'and the high');
  const v = c.validateSuggestion({ price: 7331.75, qty: 1, imbalanceQty: -1, bar });
  assert.strictEqual(v.ok, false);
  assert.match(v.problems.join(' '), /outside the bar/);
});

test('no bars is no evidence, not a refusal', () => {
  assert.strictEqual(c.priceInBar(7331.75, null), true);
  assert.strictEqual(c.validateSuggestion({ price: 7331.75, qty: 1, imbalanceQty: -1, bar: null }).ok, true);
  assert.strictEqual(c.barFor(null, Date.now()), null);
  assert.strictEqual(c.barFor([], Date.now()), null);
});

test('the bar covering a moment is the last one that opened before it', () => {
  const t = (iso) => Date.parse(iso) / 1000;
  const bars = [
    { time: t('2026-11-17T19:51:00Z'), low: 7330, high: 7335 },
    { time: t('2026-11-17T19:52:00Z'), low: 7331, high: 7336 },
    { time: t('2026-11-17T19:53:00Z'), low: 7340, high: 7350 },
  ];
  assert.strictEqual(c.barFor(bars, Date.parse('2026-11-17T19:53:56Z')).low, 7340);
  assert.strictEqual(c.barFor(bars, Date.parse('2026-11-17T19:52:30Z')).low, 7331);
  assert.strictEqual(c.barFor(bars, Date.parse('2026-11-17T19:50:00Z')), null, 'before every bar');
});

// ── The solve refuses rather than offering the impossible ────────────────

test('a solve that lands off-tick asks Jim instead of suggesting it', () => {
  // DAY is short 5; 156.50 puts the solved price at 7480.49, between two ticks.
  const s = c.suggestMissingFill({ fills: DAY, brokerQty: 0, brokerGross: 156.50 });
  assert.strictEqual(s.needsPrice, true);
  assert.strictEqual(s.price, null);
  assert.strictEqual(s.side, 'Buy');
  assert.strictEqual(s.qty, 5, 'it still knows WHAT is missing, only not at what price');
  assert.match(s.rejected.join(' '), /not on a 0\.25 tick/);
});

test('a solve that lands on a tick is offered as before', () => {
  const s = c.suggestMissingFill({ fills: DAY, brokerQty: 0, brokerGross: 156.25 });
  assert.strictEqual(s.needsPrice, false);
  assert.strictEqual(s.price, 7480.50);
  assert.strictEqual(s.rejected, undefined);
});

test('a solve outside the bars is refused even when it is on a tick', () => {
  // Two bars, so the interval is knowable — since TVCM-43 a lone bar covers nothing,
  // because there is no way to say how long it lasted.
  const t = (iso) => Date.parse(iso) / 1000;
  const bars = [
    { time: t('2026-11-16T17:09:00Z'), low: 7489, high: 7499 },
    { time: t('2026-11-16T17:10:00Z'), low: 7490, high: 7500 },
  ];
  const s = c.suggestMissingFill({ fills: DAY, brokerQty: 0, brokerGross: 156.25, bars });
  assert.strictEqual(s.needsPrice, true);
  assert.match(s.rejected.join(' '), /outside the bar/);
});

test('the banner for a refused solve names what is missing and asks for a price', () => {
  const s = c.suggestMissingFill({ fills: DAY, brokerQty: 0, brokerGross: 156.50 });
  const text = c.suggestionText(s);
  assert.match(text, /Buy 5/);
  assert.match(text, /entered/i);
  assert.ok(!/@/.test(text), 'it must not show a made-up price: ' + text);
});

// ── Corrections already accepted are re-checked, never removed ───────────

test('the correction Jim accepted is flagged, and not touched', () => {
  const bad = c.makeCorrection({ side: 'Buy', qty: 1, price: 7375.67, status: 'added',
                                 fillTime: '2026-11-17 13:53:56' });
  const r = c.reviewCorrection(bad, { imbalanceQty: -1 });
  assert.strictEqual(r.needsReview, true);
  assert.match(c.reviewText(r), /^Needs review — 7375\.67 is not on a 0\.25 tick/);
  // The correction object itself is untouched: flagging is not editing.
  assert.strictEqual(bad.price, 7375.67);
  assert.strictEqual(bad.status, 'added');
});

test('a correction that still passes is not flagged', () => {
  const good = c.makeCorrection({ side: 'Buy', qty: 1, price: 7331.75, status: 'added',
                                  fillTime: '2026-11-17 13:53:56' });
  const r = c.reviewCorrection(good, { imbalanceQty: -1 });
  assert.strictEqual(r.needsReview, false);
  assert.strictEqual(c.reviewText(r), null);
});

test('a list is reviewed and only the failures come back', () => {
  const bad  = c.makeCorrection({ side: 'Buy', qty: 1, price: 7375.67, status: 'added', fillTime: '2026-11-17 13:53:56' });
  const good = c.makeCorrection({ side: 'Buy', qty: 5, price: 7480.50, status: 'added', fillTime: '2026-11-16 11:10:09' });
  const out = c.reviewCorrections([good, bad], {});
  assert.deepStrictEqual(out.map(r => r.id), [bad.id]);
  assert.strictEqual(c.reviewCorrections([good], {}).length, 0);
  assert.deepStrictEqual(c.reviewCorrections(null, {}), []);
});

test('reviewing never changes what is applied — that stays Jim’s decision', () => {
  const bad = c.makeCorrection({ side: 'Buy', qty: 5, price: 7480.67, status: 'added',
                                 fillTime: '2026-11-16 11:10:09' });
  assert.strictEqual(c.reviewCorrection(bad, {}).needsReview, true);
  const { appliedIds } = c.applyCorrections(DAY, [bad]);
  assert.deepStrictEqual(appliedIds, [bad.id], 'a flagged correction still applies until Jim says otherwise');
});

// ── A solved price is only as good as the balance it came from (TVCM-43) ─

/** A correction whose price was inferred, not seen. */
function inferred(over = {}) {
  return { id: 'c1', side: 'Buy', qty: 1, price: 7331.75, fillTime: '2026-11-17 13:53:56',
           sessionDate: '2026-11-17', source: 'inferred from balance', status: 'added',
           createdAt: 100, ...over };
}

test('a correction solved before the opening balance moved is flagged', () => {
  const r = c.reviewCorrection(inferred(), {
    openingChangedAt: 200, previousBalance: 5474.29, openingBalance: 6252.89 });
  assert.strictEqual(r.needsReview, true);
  assert.match(r.problems.join(' '), /opening balance this price was solved from has changed/);
  assert.match(r.problems.join(' '), /5474\.29 to 6252\.89/);
});

test('a correction made AFTER the move is not flagged', () => {
  const r = c.reviewCorrection(inferred({ createdAt: 300 }), {
    openingChangedAt: 200, previousBalance: 5474.29, openingBalance: 6252.89 });
  assert.strictEqual(r.needsReview, false);
});

test('a price Jim saw himself does not depend on any balance', () => {
  for (const source of ['entered by Jim', 'AMP statement']) {
    const r = c.reviewCorrection(inferred({ source }), {
      openingChangedAt: 200, previousBalance: 1, openingBalance: 2 });
    assert.strictEqual(r.needsReview, false, source);
  }
});

test('with no move recorded, nothing is flagged for it', () => {
  assert.strictEqual(c.reviewCorrection(inferred(), {}).needsReview, false);
  assert.strictEqual(c.reviewCorrection(inferred(), { openingChangedAt: 0 }).needsReview, false);
  assert.strictEqual(c.reviewCorrection(inferred(), { openingChangedAt: null }).needsReview, false);
});

test('a correction with no timestamp is not flagged forever', () => {
  // It cannot be shown to pre-date the move, and a flag that never clears teaches Jim
  // to ignore flags.
  const r = c.reviewCorrection(inferred({ createdAt: null }), { openingChangedAt: 200 });
  assert.strictEqual(r.needsReview, false);
});

test('a moved balance is reported alongside a bad price, not instead of it', () => {
  const r = c.reviewCorrection(inferred({ price: 7375.67 }), {
    openingChangedAt: 200, previousBalance: 5474.29, openingBalance: 6252.89 });
  assert.strictEqual(r.problems.length, 2);
  assert.match(r.problems[0], /not on a 0\.25 tick/);
  assert.match(r.problems[1], /opening balance/);
});

test('flagging still never changes what is applied', () => {
  const made = c.makeCorrection({ side: 'Buy', qty: 5, price: 7480.50, status: 'added',
                                  source: 'inferred from balance', fillTime: '2026-11-16 11:10:09',
                                  createdAt: 100 });
  assert.strictEqual(c.reviewCorrection(made, { openingChangedAt: 200 }).needsReview, true);
  assert.deepStrictEqual(c.applyCorrections(DAY, [made]).appliedIds, [made.id],
    'a flagged correction still applies until Jim says otherwise');
});

// ── A bar covers its own interval, and no more (TVCM-43) ────────────────

test('a moment after a bar has closed is not inside it', () => {
  const t = (iso) => Date.parse(iso) / 1000;
  const bars = [
    { time: t('2026-11-17T14:00:00Z'), low: 7400, high: 7410 },
    { time: t('2026-11-17T14:01:00Z'), low: 7401, high: 7411 },
  ];
  assert.strictEqual(c.barInterval(bars), 60_000);
  assert.strictEqual(c.barFor(bars, Date.parse('2026-11-17T14:01:30Z')).low, 7401, 'inside the second bar');
  assert.strictEqual(c.barFor(bars, Date.parse('2026-11-17T14:00:59Z')).low, 7400, 'the last instant of the first');
  assert.strictEqual(c.barFor(bars, Date.parse('2026-11-17T14:02:00Z')), null, 'one interval past the last bar');
  // The review's case: a fill 5h49m after the only bars still matched one before TVCM-43.
  assert.strictEqual(c.barFor(bars, Date.parse('2026-11-17T19:53:56Z')), null);
});

test('with too few bars to know the interval, nothing is claimed to cover anything', () => {
  const one = [{ time: Date.parse('2026-11-17T14:00:00Z') / 1000, low: 7400, high: 7410 }];
  assert.strictEqual(c.barInterval(one), null);
  assert.strictEqual(c.barFor(one, Date.parse('2026-11-17T14:00:30Z')), null,
    'no interval means no evidence, which is not a refusal');
  assert.strictEqual(c.validateSuggestion({ price: 7331.75, qty: 1, imbalanceQty: -1,
    bar: c.barFor(one, Date.parse('2026-11-17T14:00:30Z')) }).ok, true);
});

test('the interval is the smallest gap, so a gap in the data does not widen a bar', () => {
  const t = (iso) => Date.parse(iso) / 1000;
  const bars = [
    { time: t('2026-11-17T14:00:00Z'), low: 7400, high: 7410 },
    { time: t('2026-11-17T14:01:00Z'), low: 7401, high: 7411 },
    { time: t('2026-11-17T14:30:00Z'), low: 7450, high: 7460 },   // a 29-minute hole
  ];
  assert.strictEqual(c.barInterval(bars), 60_000);
  assert.strictEqual(c.barFor(bars, Date.parse('2026-11-17T14:15:00Z')), null, 'the hole is not covered');
  assert.strictEqual(c.barFor(bars, Date.parse('2026-11-17T14:30:30Z')).low, 7450);
});
