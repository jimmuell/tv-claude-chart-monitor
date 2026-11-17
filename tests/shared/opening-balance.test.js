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
  assert.strictEqual(ob.supersedes(stale), true);
  const out = ob.observeReading(reading({ existing: stale }));
  assert.strictEqual(out.action, 'record');
  assert.strictEqual(out.record.balance, TUESDAY_PREV_DAY);
  assert.strictEqual(out.record.source, ob.SOURCE_PREV_DAY);
});

test('an unknown session is filled in the moment the figure can be read', () => {
  const unknown = { sessionDate: '2026-11-17', balance: null, known: false, source: null,
                    reason: ob.REASONS.unreadable, capturedAt: 1 };
  assert.strictEqual(ob.supersedes(unknown), true);
  assert.strictEqual(ob.observeReading(reading({ existing: unknown })).record.balance, TUESDAY_PREV_DAY);
});

test('a balance already from AMP’s own figure is left alone', () => {
  const good = { sessionDate: '2026-11-17', balance: TUESDAY_PREV_DAY, known: true,
                 source: ob.SOURCE_PREV_DAY, reason: null, capturedAt: 1 };
  assert.strictEqual(ob.supersedes(good), false);
  assert.strictEqual(ob.observeReading(reading({ existing: good })).action, 'keep');
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
