'use strict';

// The balance each trading session opened with.
//
// TVCM-37 captured it at 17:00 from Purchasing power. TVCM-42 replaced the source with
// AMP's own "Prev day balance", because the two are not the same number: AMP debits the
// previous day's commissions AFTER 17:00, so the 17:00 capture is taken before the debit.
//
// The figures below are REAL, and they are the whole reason this file changed:
//   Monday 2026-11-16 closed at Purchasing power  5,693.89   (TVCM-37's capture)
//   Tuesday 2026-11-17 prev day balance            5,474.29   (AMP's own figure)
//   the difference                                   219.60   = Monday's fees, to the cent
//   Monday opening 4,510.14 + Monday net 964.15 =  5,474.29   — the engine, validated

const test   = require('node:test');
const assert = require('node:assert');
const path   = require('path');

const ob = require(path.join(__dirname, '../../src/shared/opening-balance.js'));
const { suggestMissingFill } = require(path.join(__dirname, '../../src/shared/corrections.js'));
const { brokerSessionGross } = require(path.join(__dirname, '../../src/shared/live-feed.js'));

const MONDAY_CLOSE_PP   = 5693.89;
const TUESDAY_PREV_DAY  = 5474.29;
const MONDAY_FEES       = 219.60;
const TUESDAY_BALANCE   = 6414.29;
const TUESDAY_TRUE_GROSS = 940.00;

/** One feed reading, with overridable fields. */
function reading(over = {}) {
  return {
    sessionDate: '2026-11-17', mode: 'live', brokerId: 'amp',
    prevDayBalance: TUESDAY_PREV_DAY,
    purchasingPower: TUESDAY_BALANCE, totalMargin: 0, brokerQty: 0,
    fillsInSession: 0, existing: null, at: 1_794_900_000_000, ...over,
  };
}

// ── The arithmetic that forced the change ────────────────────────────────

test('the 17:00 capture and AMP’s own figure differ by exactly a day of fees', () => {
  assert.strictEqual(Math.round((MONDAY_CLOSE_PP - TUESDAY_PREV_DAY) * 100) / 100, MONDAY_FEES);
});

test('solving against the 17:00 capture is low by that day of fees', () => {
  const payload = { summary: { 'Purchasing power': TUESDAY_BALANCE, 'Total margin': 0 } };
  const wrong = brokerSessionGross(payload, MONDAY_CLOSE_PP);
  assert.strictEqual(wrong, 720.40, 'what TVCM-37 computed all day');
  assert.strictEqual(Math.round((TUESDAY_TRUE_GROSS - wrong) * 100) / 100, MONDAY_FEES);
});

test('AMP’s Balances table gives the right gross, and beats anything handed in', () => {
  const payload = {
    balances: { accountBalance: TUESDAY_BALANCE, prevDayBalance: TUESDAY_PREV_DAY, brokerPl: 940 },
    summary:  { 'Purchasing power': TUESDAY_BALANCE, 'Total margin': 0 },
  };
  assert.strictEqual(brokerSessionGross(payload, MONDAY_CLOSE_PP), TUESDAY_TRUE_GROSS,
    'the live figure must win over a stale opening balance');
  assert.strictEqual(brokerSessionGross(payload, null), TUESDAY_TRUE_GROSS,
    'and it needs no opening balance handed in at all');
});

test('the old route survives only for an opening balance supplied on purpose', () => {
  const payload = { summary: { 'Purchasing power': TUESDAY_BALANCE, 'Total margin': 0 } };
  assert.strictEqual(brokerSessionGross(payload, TUESDAY_PREV_DAY), TUESDAY_TRUE_GROSS);
  assert.strictEqual(brokerSessionGross(payload, null), null, 'and never without one');
  assert.strictEqual(brokerSessionGross({}, null), null);
});

test('the old route still refuses while a position is open', () => {
  const open = { summary: { 'Purchasing power': TUESDAY_BALANCE, 'Total margin': 2750 } };
  assert.strictEqual(brokerSessionGross(open, TUESDAY_PREV_DAY), null,
    'margin is held against purchasing power, so it is not the balance');
});

// ── Recording it ─────────────────────────────────────────────────────────

test('AMP’s prev day balance is recorded as the opening balance', () => {
  const out = ob.observeReading(reading());
  assert.strictEqual(out.action, 'record');
  assert.strictEqual(out.record.balance, TUESDAY_PREV_DAY);
  assert.strictEqual(out.record.known, true);
  assert.strictEqual(out.record.source, ob.SOURCE_PREV_DAY);
});

test('it no longer matters when in the day TVCM first looks', () => {
  // The prev day balance is STATIC for the session. TVCM-37 could only capture it at
  // 17:00 while flat and before any fill; those gates are gone because the number cannot
  // move. A session first seen at noon, mid-trade, holding a position, records fine.
  for (const over of [{ fillsInSession: 57 }, { brokerQty: -5, totalMargin: 2750 },
                      { fillsInSession: 57, brokerQty: 3, totalMargin: 1650 }]) {
    const out = ob.observeReading(reading(over));
    assert.strictEqual(out.action, 'record', JSON.stringify(over));
    assert.strictEqual(out.record.balance, TUESDAY_PREV_DAY);
  }
});

test('a session recorded the TVCM-37 way is repaired by AMP’s own figure', () => {
  // This is what fixes Jim's stored 2026-11-17 on the next poll, with nobody editing a file.
  const stale = { sessionDate: '2026-11-17', balance: MONDAY_CLOSE_PP, known: true,
                  source: ob.SOURCE_PP, reason: null, capturedAt: 1 };
  // UPDATED in TVCM-43: repairing a TVCM-37 record is a CHANGE of value, so it reports as
  // one — which is the point, because anything solved from the old figure gets flagged.
  const out = ob.observeReading(reading({ existing: stale }));
  assert.strictEqual(out.action, 'changed');
  assert.strictEqual(out.previousBalance, MONDAY_CLOSE_PP);
  assert.strictEqual(out.record.balance, TUESDAY_PREV_DAY);
  assert.strictEqual(out.record.source, ob.SOURCE_PREV_DAY);
  assert.ok(out.record.changedAt > 0, 'dated, so what was solved from 5693.89 can be found');
});

test('an unknown session is filled in the moment the figure can be read', () => {
  const unknown = { sessionDate: '2026-11-17', balance: null, known: false, source: null,
                    reason: ob.REASONS.unreadable, capturedAt: 1 };
  assert.strictEqual(ob.observeReading(reading({ existing: unknown })).record.balance, TUESDAY_PREV_DAY);
});

test('a balance already from AMP’s own figure is left alone', () => {
  const good = { sessionDate: '2026-11-17', balance: TUESDAY_PREV_DAY, known: true,
                 source: ob.SOURCE_PREV_DAY, reason: null, capturedAt: 1 };
  // UPDATED in TVCM-43: supersedes() no longer refuses on source — refusing is exactly
  // what locked a stale roll-time reading in for a whole day. The behaviour this test
  // cared about is unchanged and still asserted: the same figure read again writes nothing.
  assert.strictEqual(ob.observeReading(reading({ existing: good })).action, 'keep');
  assert.strictEqual(ob.observeReading(reading({ existing: good })).record, null);
});

// ── Never guessed ────────────────────────────────────────────────────────

test('a figure that cannot be read is unknown, not zero', () => {
  // Number(null) is 0, which would record an opening balance of nothing and then solve a
  // missing fill's price from it — the trap TVCM-36 found and TVCM-37 nearly repeated.
  for (const bad of [null, undefined, '', NaN, 'n/a']) {
    const out = ob.observeReading(reading({ prevDayBalance: bad }));
    assert.strictEqual(out.action, 'unknown', JSON.stringify(bad));
    assert.strictEqual(out.record.balance, null);
    assert.strictEqual(out.record.known, false);
    assert.match(out.record.reason, /did not report/);
  }
});

test('a session already given up on is not re-judged every poll', () => {
  const unknown = ob.observeReading(reading({ prevDayBalance: null })).record;
  assert.strictEqual(ob.observeReading(reading({ prevDayBalance: null, existing: unknown })).action, 'keep');
});

test('paper money and any broker but AMP Live are never recorded', () => {
  assert.strictEqual(ob.observeReading(reading({ mode: 'paper' })).action, 'keep');
  assert.strictEqual(ob.observeReading(reading({ brokerId: 'paper' })).action, 'keep');
  assert.strictEqual(ob.observeReading(reading({ brokerId: 'replaybroker' })).action, 'keep');
  assert.strictEqual(ob.observeReading(reading({ sessionDate: null })).action, 'keep');
});

// ── Which number is used ─────────────────────────────────────────────────

test('a recorded balance is used instead of the hand-typed setting', () => {
  const record = ob.observeReading(reading()).record;
  const r = ob.resolveOpeningBalance({ sessionDate: '2026-11-17', record, legacy: 9999 });
  assert.strictEqual(r.balance, TUESDAY_PREV_DAY);
  assert.strictEqual(r.source, ob.SOURCE_PREV_DAY);
});

test('a manual override for this session wins over everything', () => {
  const record = ob.observeReading(reading()).record;
  const r = ob.resolveOpeningBalance({
    sessionDate: '2026-11-17', record, legacy: 9999,
    override: { sessionDate: '2026-11-17', balance: 5400 },
  });
  assert.strictEqual(r.balance, 5400);
  assert.strictEqual(r.source, 'override');
});

test('an override stamped with another session is ignored', () => {
  const record = ob.observeReading(reading()).record;
  const r = ob.resolveOpeningBalance({
    sessionDate: '2026-11-17', record, override: { sessionDate: '2026-11-13', balance: 5400 },
  });
  assert.strictEqual(r.balance, TUESDAY_PREV_DAY);
});

test('the legacy setting is the last resort, used only when nothing was recorded', () => {
  const r = ob.resolveOpeningBalance({ sessionDate: '2026-11-17', record: null, legacy: TUESDAY_PREV_DAY });
  assert.strictEqual(r.balance, TUESDAY_PREV_DAY);
  assert.strictEqual(r.source, 'manual');
});

test('an unknown session resolves to nothing, and says why', () => {
  const record = ob.observeReading(reading({ prevDayBalance: null })).record;
  const r = ob.resolveOpeningBalance({ sessionDate: '2026-11-17', record, legacy: TUESDAY_PREV_DAY });
  assert.strictEqual(r.known, false);
  assert.strictEqual(r.balance, null);
  assert.match(r.reason, /did not report/);
  const none = ob.resolveOpeningBalance({ sessionDate: '2026-11-17', record: null, legacy: null });
  assert.strictEqual(none.known, false);
  assert.strictEqual(none.balance, null);
});

// ── What it is for: the missing-fill solve ───────────────────────────────

/** Tuesday's shape: one more sell than buy, the broker flat. Synthetic prices. */
const SHORT_ONE = [
  { orderId: 'A', side: 'Sell', qty: 5, price: 7400.00, fillTime: '2026-11-17 09:00:00', sessionDate: '2026-11-17' },
  { orderId: 'B', side: 'Buy',  qty: 5, price: 7392.00, fillTime: '2026-11-17 09:30:00', sessionDate: '2026-11-17' },
  { orderId: 'C', side: 'Sell', qty: 1, price: 7380.00, fillTime: '2026-11-17 13:53:56', sessionDate: '2026-11-17' },
];

test('with AMP’s figure the solve lands on a real tick', () => {
  const payload = { balances: { accountBalance: 7420 + 40, prevDayBalance: 7420 } };
  const gross = brokerSessionGross(payload, null);
  assert.strictEqual(gross, 40);
  const s = suggestMissingFill({ fills: SHORT_ONE, brokerQty: 0, brokerGross: gross });
  assert.strictEqual(s.side, 'Buy');
  assert.strictEqual(s.qty, 1);
  assert.strictEqual(s.price, 7412.00);   // 7420 notional gap - 40/5 points
  assert.strictEqual(Math.round(s.price * 100) % 25, 0, 'and it is on a quarter-point tick');
});

test('without a readable figure the banner asks for the price instead of solving one', () => {
  const record = ob.observeReading(reading({ prevDayBalance: null })).record;
  const opening = ob.resolveOpeningBalance({ sessionDate: '2026-11-17', record });
  assert.strictEqual(opening.balance, null);
  const gross = brokerSessionGross({ summary: { 'Purchasing power': 6414.29, 'Total margin': 0 } }, opening.balance);
  assert.strictEqual(gross, null, 'a null opening balance must not be read as zero');
  const s = suggestMissingFill({ fills: SHORT_ONE, brokerQty: 0, brokerGross: gross });
  assert.strictEqual(s.needsPrice, true);
  assert.strictEqual(s.price, null);
});

// ── How it reads ─────────────────────────────────────────────────────────

test('the status line says the number and where it came from', () => {
  const record = ob.observeReading(reading()).record;
  const known = ob.openingBalanceText('2026-11-17', ob.resolveOpeningBalance({ sessionDate: '2026-11-17', record }));
  assert.match(known, /\$5474\.29/);
  const unknown = ob.openingBalanceText('2026-11-17', ob.resolveOpeningBalance({
    sessionDate: '2026-11-17', record: ob.observeReading(reading({ prevDayBalance: null })).record }));
  assert.match(unknown, /unknown/);
  assert.ok(!/\$/.test(unknown), 'it must not show a balance it does not have: ' + unknown);
});

// ── The 17:00 roll (TVCM-43) ─────────────────────────────────────────────
//
// TVCM-42 locked a session's FIRST prev-day-balance reading in for the day. AMP's
// Balances table rolls its statement some time AFTER 17:00 — the same back-office lag
// that debits the previous day's fees after the session ends — so the first reading of a
// new session is the PREVIOUS session's figure. The review reproduced it: 17:00:05 reads
// 5,474.29 and is locked; 17:20 AMP rolls and the correct figure is refused. The error is
// a whole day's P&L, and silent, because the stored source says it came from AMP.

const TUE_OPEN  = 5474.29;    // Tuesday's opening — what AMP still shows at 17:00:05
const TUE_CLOSE = 6252.89;    // Tuesday's close after fees — Wednesday's true opening

/** A reading for the new Wednesday session. */
function wed(over = {}) {
  return { sessionDate: '2026-11-18', mode: 'live', brokerId: 'amp',
           fillsInSession: 0, at: 1_795_000_000_000, ...over };
}

test('the first reading after the roll is refused while AMP still shows the old pair', () => {
  // 17:00:05. AMP has not rolled: account balance is Tuesday's close, prev day is
  // Tuesday's open, and the gap between them is Tuesday's whole P&L.
  const out = ob.observeReading(wed({ prevDayBalance: TUE_OPEN, accountBalance: TUE_CLOSE }));
  assert.strictEqual(out.action, 'unknown');
  assert.strictEqual(out.code, ob.NOT_ROLLED_CODE);
  assert.strictEqual(out.record.balance, null, 'the wrong day’s figure must not be stored');
  // REWORDED in TVCM-46: the reason now says when to come back, because the roll is in
  // the morning rather than minutes away.
  assert.match(out.record.reason, /overnight/);
  assert.match(out.record.reason, /check back in the morning/);
});

test('once AMP rolls, the correct figure is recorded', () => {
  // 17:20. Nothing has traded, so the two agree, which is what proves the roll happened.
  const out = ob.observeReading(wed({ prevDayBalance: TUE_CLOSE, accountBalance: TUE_CLOSE, at: 2 }));
  assert.strictEqual(out.action, 'record');
  assert.strictEqual(out.record.balance, TUE_CLOSE);
  assert.strictEqual(out.record.source, ob.SOURCE_PREV_DAY);
});

test('the exact scenario the review reproduced no longer locks anything in', () => {
  // 17:00:05 — refused rather than stored.
  const first = ob.observeReading(wed({ prevDayBalance: TUE_OPEN, accountBalance: TUE_CLOSE, at: 1 }));
  assert.strictEqual(first.record.known, false);
  // 17:20 — AMP rolls, and the reading is taken.
  const second = ob.observeReading(wed({ prevDayBalance: TUE_CLOSE, accountBalance: TUE_CLOSE,
                                         at: 2, existing: first.record }));
  assert.strictEqual(second.action, 'record');
  assert.strictEqual(second.record.balance, TUE_CLOSE);
  // Under TVCM-42 this returned {"action":"keep"} and 5,474.29 stood for the day.
  assert.strictEqual(Math.round((TUE_CLOSE - TUE_OPEN) * 100) / 100, 778.60,
    'the error this avoids is a whole day of P&L');
});

test('a later reading replaces an earlier one, and says that it moved', () => {
  const first = ob.observeReading(wed({ prevDayBalance: TUE_OPEN, accountBalance: TUE_OPEN, at: 1 })).record;
  assert.strictEqual(first.balance, TUE_OPEN, 'recorded: the two agreed, so it looked rolled');
  const out = ob.observeReading(wed({ prevDayBalance: TUE_CLOSE, accountBalance: TUE_CLOSE,
                                      at: 9, existing: first }));
  assert.strictEqual(out.action, 'changed');
  assert.strictEqual(out.code, ob.CHANGED_CODE);
  assert.strictEqual(out.previousBalance, TUE_OPEN);
  assert.strictEqual(out.record.balance, TUE_CLOSE);
  assert.strictEqual(out.record.changedAt, 9, 'dated, so what was solved from the old one can be found');
  assert.strictEqual(out.record.previousBalance, TUE_OPEN);
});

test('the same figure read again is not news, and does not churn the file', () => {
  const first = ob.observeReading(wed({ prevDayBalance: TUE_CLOSE, accountBalance: TUE_CLOSE, at: 1 })).record;
  const again = ob.observeReading(wed({ prevDayBalance: TUE_CLOSE, accountBalance: TUE_CLOSE,
                                        at: 2, existing: first }));
  assert.strictEqual(again.action, 'keep');
  assert.strictEqual(again.record, null);
});

test('once the session has traded the roll check cannot and need not apply', () => {
  // The gap is now the day's own P&L and proves nothing. By the time a session has
  // traded, AMP has long since rolled.
  assert.strictEqual(ob.hasRolled({ fillsInSession: 57, accountBalance: 6414.29, prevDayBalance: 5474.29 }), true);
  const out = ob.observeReading(wed({ prevDayBalance: TUE_CLOSE, accountBalance: 9999, fillsInSession: 57 }));
  assert.strictEqual(out.action, 'record');
  assert.strictEqual(out.record.balance, TUE_CLOSE);
});

test('a cent of rounding is not a failed roll', () => {
  assert.strictEqual(ob.hasRolled({ fillsInSession: 0, accountBalance: 6252.89, prevDayBalance: 6252.89 }), true);
  assert.strictEqual(ob.hasRolled({ fillsInSession: 0, accountBalance: 6252.90, prevDayBalance: 6252.89 }), true);
  assert.strictEqual(ob.hasRolled({ fillsInSession: 0, accountBalance: 6252.99, prevDayBalance: 6252.89 }), false);
});

test('with no account balance to check against, the guard does not block', () => {
  // Half a Balances row is better than none: the figure is still AMP's own.
  for (const acct of [null, undefined, '', 'n/a']) {
    assert.strictEqual(ob.hasRolled({ fillsInSession: 0, accountBalance: acct, prevDayBalance: TUE_CLOSE }), true, String(acct));
  }
});

test('a session already holding a good figure is not blanked by an unrolled read', () => {
  // Defensive: if AMP ever goes backwards mid-session, what is known is kept.
  const good = ob.observeReading(wed({ prevDayBalance: TUE_CLOSE, accountBalance: TUE_CLOSE, at: 1 })).record;
  const out = ob.observeReading(wed({ prevDayBalance: TUE_OPEN, accountBalance: 9999, at: 2, existing: good }));
  assert.strictEqual(out.action, 'keep');
});

test('while AMP has not rolled, the gross is unknown too — not yesterday’s', () => {
  // The other half of the roll guard. Between 17:00 and AMP rolling, the live Balances
  // pair is the PREVIOUS session's, and subtracting it yields yesterday's P&L. The store
  // refuses to record it; main's brokerGrossForSolve() refuses to solve from it. This
  // pins the arithmetic the refusal avoids.
  const unrolled = { balances: { accountBalance: TUE_CLOSE, prevDayBalance: TUE_OPEN } };
  assert.strictEqual(brokerSessionGross(unrolled, null), 778.60,
    'read straight, the pair gives TUESDAY’s P&L on a Wednesday');
  // Which is why the record is withheld: an unknown opening balance is the signal.
  const out = ob.observeReading(wed({ prevDayBalance: TUE_OPEN, accountBalance: TUE_CLOSE }));
  assert.strictEqual(out.record.known, false);
  assert.strictEqual(out.code, ob.NOT_ROLLED_CODE);
});

// ── The roll happens in the MORNING, not at 17:00 (TVCM-46) ─────────────
//
// Jim (2026-11-17 15:54): AMP updates its Balances table early the next morning. Measured
// on 2026-11-17 at 17:05 CT, five minutes after the session rolled, AMP still reported a
// prev day balance of 5,474.29 — Tuesday's opening — with account balance 6,414.29.
//
// TVCM-43 switched its guard off as soon as a session had traded ("by then AMP has long
// since rolled"). Jim often trades from 17:00, so his first evening fill would have let
// TVCM record YESTERDAY's opening balance as tonight's, silently, until the morning.

const WED = '2026-11-18';
const TUE_OPENING = 5474.29;    // what AMP still reports all evening
const TUE_SETTLED = 6252.89;    // what it will report once it rolls

/** A reading for the Wednesday session, with Tuesday's opening on record. */
function evening(over = {}) {
  return { sessionDate: WED, mode: 'live', brokerId: 'amp', at: 2,
           previousSessionOpening: TUE_OPENING, ...over };
}

test('an evening fill no longer unlocks the guard', () => {
  // The exact shape measured at 17:05, plus the evening trading Jim does.
  const out = ob.observeReading(evening({
    prevDayBalance: TUE_OPENING, accountBalance: 6500, fillsInSession: 4 }));
  assert.strictEqual(out.action, 'unknown');
  assert.strictEqual(out.code, ob.NOT_ROLLED_CODE);
  assert.strictEqual(out.record.known, false);
  assert.match(out.record.reason, /overnight/);
});

test('AMP still showing the previous session’s opening means it has not rolled', () => {
  for (const fills of [0, 1, 57]) {
    assert.strictEqual(
      ob.hasRolled({ prevDayBalance: TUE_OPENING, previousSessionOpening: TUE_OPENING,
                     accountBalance: 6414.29, fillsInSession: fills }),
      false, `fills=${fills}`);
  }
});

test('the morning roll is recorded, even with the night’s trading on the books', () => {
  const out = ob.observeReading(evening({
    prevDayBalance: TUE_SETTLED, accountBalance: 6600, fillsInSession: 12, at: 9 }));
  assert.strictEqual(out.action, 'record');
  assert.strictEqual(out.record.balance, TUE_SETTLED);
  assert.strictEqual(out.record.source, ob.SOURCE_PREV_DAY);
});

test('a rolled table at an untraded session must also have its pair agree', () => {
  // The figure moved, but the two numbers disagree with nothing traded — something is
  // mid-update, so wait for the next poll rather than record half an update.
  assert.strictEqual(
    ob.hasRolled({ prevDayBalance: TUE_SETTLED, previousSessionOpening: TUE_OPENING,
                   accountBalance: 9999, fillsInSession: 0 }), false);
  assert.strictEqual(
    ob.hasRolled({ prevDayBalance: TUE_SETTLED, previousSessionOpening: TUE_OPENING,
                   accountBalance: TUE_SETTLED, fillsInSession: 0 }), true);
});

test('with no previous session on record, the no-fill check is all there is', () => {
  for (const prior of [null, undefined, '', 'n/a']) {
    assert.strictEqual(
      ob.hasRolled({ prevDayBalance: TUE_SETTLED, previousSessionOpening: prior,
                     accountBalance: TUE_SETTLED, fillsInSession: 0 }), true, String(prior));
    assert.strictEqual(
      ob.hasRolled({ prevDayBalance: TUE_SETTLED, previousSessionOpening: prior,
                     accountBalance: 9999, fillsInSession: 0 }), false, String(prior));
  }
});

test('nothing is solved while the opening balance is unknown', () => {
  const out = ob.observeReading(evening({
    prevDayBalance: TUE_OPENING, accountBalance: 6500, fillsInSession: 4 }));
  const r = ob.resolveOpeningBalance({ sessionDate: WED, record: out.record });
  assert.strictEqual(r.known, false);
  assert.strictEqual(r.balance, null);
  assert.match(r.reason, /overnight/);
});

test('the wait is explained in words Jim can act on', () => {
  assert.match(ob.REASONS.notRolled, /check back in the morning/);
});
