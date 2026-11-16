'use strict';

// The account balance each trading session opened with.
//
// Every figure here is SYNTHETIC apart from the SHAPE: TVCM-36 measured, at 14:24:52 on
// 2026-11-16 with the account flat, Purchasing power 5,640.14 == Account balance
// 5,640.14, having opened at 4,510.14. These tests use round numbers of the same shape.

const test   = require('node:test');
const assert = require('node:assert');
const path   = require('path');

const ob = require(path.join(__dirname, '../../src/shared/opening-balance.js'));
const { suggestMissingFill } = require(path.join(__dirname, '../../src/shared/corrections.js'));
const { brokerSessionGross } = require(path.join(__dirname, '../../src/shared/live-feed.js'));

/** One feed reading at the start of a session, with overridable fields. */
function reading(over = {}) {
  return {
    sessionDate: '2026-11-16', mode: 'live', brokerId: 'amp',
    purchasingPower: 4510.14, totalMargin: 0, brokerQty: 0,
    fillsInSession: 0, existing: null, at: 1_794_800_000_000, ...over,
  };
}

// ── Recorded at the session open ─────────────────────────────────────────

test('a flat account with no fills yet has its balance recorded', () => {
  const out = ob.observeReading(reading());
  assert.strictEqual(out.action, 'record');
  assert.strictEqual(out.record.balance, 4510.14);
  assert.strictEqual(out.record.known, true);
  assert.strictEqual(out.record.source, 'feed');
  assert.strictEqual(out.record.sessionDate, '2026-11-16');
});

test('once a session is settled no later reading touches it', () => {
  const settled = ob.observeReading(reading()).record;
  // Flat again at 14:24 with a different balance — the classic way to record the wrong one.
  const later = ob.observeReading(reading({ purchasingPower: 5640.14, fillsInSession: 12, existing: settled }));
  assert.strictEqual(later.action, 'keep');
  assert.strictEqual(later.record, null);
});

test('a reading with no balance in it yet is simply skipped, not refused', () => {
  for (const pp of [null, undefined, NaN, 'n/a']) {
    assert.strictEqual(ob.observeReading(reading({ purchasingPower: pp })).action, 'keep');
  }
});

// ── Never guessed ────────────────────────────────────────────────────────

test('a session first seen after it had traded is marked unknown, not guessed', () => {
  const out = ob.observeReading(reading({ fillsInSession: 4, purchasingPower: 5640.14 }));
  assert.strictEqual(out.action, 'unknown');
  assert.strictEqual(out.record.balance, null);
  assert.strictEqual(out.record.known, false);
  assert.match(out.record.reason, /already traded/);
});

test('the refusal is written down, so a later flat moment cannot overwrite it', () => {
  const refusal = ob.observeReading(reading({ fillsInSession: 4 })).record;
  const later = ob.observeReading(reading({ purchasingPower: 5640.14, existing: refusal }));
  assert.strictEqual(later.action, 'keep', 'the session stays unknown for the rest of the day');
});

test('a position carried into the session is unknown — purchasing power is not the balance', () => {
  const out = ob.observeReading(reading({ brokerQty: -5, totalMargin: 2750 }));
  assert.strictEqual(out.action, 'unknown');
  assert.match(out.record.reason, /carried/);
});

test('margin held against the account counts as not flat even with no position row', () => {
  assert.strictEqual(ob.observeReading(reading({ brokerQty: null, totalMargin: 2750 })).action, 'unknown');
  assert.strictEqual(ob.observeReading(reading({ brokerQty: null, totalMargin: 0 })).action, 'record');
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
  const r = ob.resolveOpeningBalance({ sessionDate: '2026-11-16', record, legacy: 9999 });
  assert.strictEqual(r.balance, 4510.14);
  assert.strictEqual(r.source, 'feed');
});

test('a manual override for this session wins over everything', () => {
  const record = ob.observeReading(reading()).record;
  const r = ob.resolveOpeningBalance({
    sessionDate: '2026-11-16', record, legacy: 9999,
    override: { sessionDate: '2026-11-16', balance: 4600.00 },
  });
  assert.strictEqual(r.balance, 4600.00);
  assert.strictEqual(r.source, 'override');
});

test('an override stamped with another session is ignored', () => {
  const record = ob.observeReading(reading()).record;
  const r = ob.resolveOpeningBalance({
    sessionDate: '2026-11-16', record,
    override: { sessionDate: '2026-11-13', balance: 4600.00 },
  });
  assert.strictEqual(r.source, 'feed');
  assert.strictEqual(r.balance, 4510.14);
});

test('the legacy setting is the last resort, used only when nothing was recorded', () => {
  const r = ob.resolveOpeningBalance({ sessionDate: '2026-11-16', record: null, legacy: 4510.14 });
  assert.strictEqual(r.balance, 4510.14);
  assert.strictEqual(r.source, 'manual');
});

test('an unknown session resolves to nothing, and says why', () => {
  const record = ob.observeReading(reading({ fillsInSession: 4 })).record;
  const r = ob.resolveOpeningBalance({ sessionDate: '2026-11-16', record, legacy: 4510.14 });
  assert.strictEqual(r.known, false);
  assert.strictEqual(r.balance, null);
  assert.match(r.reason, /already traded/);
  const none = ob.resolveOpeningBalance({ sessionDate: '2026-11-16', record: null, legacy: null });
  assert.strictEqual(none.known, false);
  assert.strictEqual(none.balance, null);
});

// ── What it is for: the missing-fill solve ───────────────────────────────

const PAYLOAD = { summary: { 'Purchasing power': 5640.14, 'Total margin': 0 } };

/** The fills of a day whose closing buy never arrived, as TVCM-34 found. */
const ORPHANED = [
  { orderId: 'A', side: 'Sell', qty: 5, price: 7482.75, fillTime: '2026-11-16 11:10:09', sessionDate: '2026-11-16' },
  { orderId: 'B', side: 'Sell', qty: 5, price: 7469.00, fillTime: '2026-11-16 11:46:23', sessionDate: '2026-11-16' },
  { orderId: 'C', side: 'Buy',  qty: 5, price: 7465.00, fillTime: '2026-11-16 12:00:33', sessionDate: '2026-11-16' },
];

test('with a recorded opening balance the missing fill is solved', () => {
  const record = ob.observeReading(reading()).record;
  const opening = ob.resolveOpeningBalance({ sessionDate: '2026-11-16', record });
  const gross = brokerSessionGross(PAYLOAD, opening.balance);
  assert.strictEqual(gross, 1130.00);
  const s = suggestMissingFill({ fills: ORPHANED, brokerQty: 0, brokerGross: gross });
  assert.strictEqual(s.needsPrice, false);
  assert.strictEqual(s.side, 'Buy');
  assert.strictEqual(s.qty, 5);
});

test('without one the banner asks for the price instead of solving a wrong one', () => {
  const record = ob.observeReading(reading({ fillsInSession: 4 })).record;
  const opening = ob.resolveOpeningBalance({ sessionDate: '2026-11-16', record });
  assert.strictEqual(opening.balance, null);
  const gross = brokerSessionGross(PAYLOAD, opening.balance);
  assert.strictEqual(gross, null, 'a null opening balance must not be read as zero');
  const s = suggestMissingFill({ fills: ORPHANED, brokerQty: 0, brokerGross: gross });
  assert.strictEqual(s.needsPrice, true);
  assert.strictEqual(s.price, null);
});

test('a stale opening balance would have been wrong, and that is the point', () => {
  // Yesterday's figure against today's account: the solve would have been out by the
  // difference, and nothing on screen would have said so.
  const stale = ob.resolveOpeningBalance({ sessionDate: '2026-11-17', record: null, legacy: 4510.14 });
  const fresh = ob.resolveOpeningBalance({ sessionDate: '2026-11-17', legacy: 4510.14,
    record: ob.observeReading(reading({ sessionDate: '2026-11-17', purchasingPower: 5640.14 })).record });
  assert.notStrictEqual(stale.balance, fresh.balance);
  assert.strictEqual(fresh.balance, 5640.14);
});

// ── How it reads ─────────────────────────────────────────────────────────

test('the status line says the number and where it came from', () => {
  const record = ob.observeReading(reading()).record;
  const known = ob.openingBalanceText('2026-11-16', ob.resolveOpeningBalance({ sessionDate: '2026-11-16', record }));
  assert.match(known, /\$4510\.14/);
  assert.match(known, /recorded at the session open/);
  const unknown = ob.openingBalanceText('2026-11-16',
    ob.resolveOpeningBalance({ sessionDate: '2026-11-16', record: ob.observeReading(reading({ fillsInSession: 2 })).record }));
  assert.match(unknown, /unknown/);
  assert.ok(!/\$/.test(unknown), 'it must not show a balance it does not have: ' + unknown);
});
