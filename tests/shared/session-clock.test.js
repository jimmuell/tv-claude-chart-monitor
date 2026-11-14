'use strict';

// The Chicago session clock. Every instant below is written as UTC and asserted
// against its Chicago wall-clock meaning, so the test cannot pass by accident on
// a machine whose own timezone happens to agree.

const test   = require('node:test');
const assert = require('node:assert');
const path   = require('path');

const clock = require(path.join(__dirname, '../../src/shared/session-clock.js'));
const { chicagoParts, currentSessionDate, isMarketOpen, marketClosedReason, chicagoTimeLabel } = clock;

const at = (iso) => new Date(iso);

// ── Chicago wall clock ────────────────────────────────────────────────────
test('UTC instants are read as Chicago wall-clock time', () => {
  const p = chicagoParts(at('2026-11-13T21:30:00Z')); // CST = UTC-6
  assert.strictEqual(p.date, '2026-11-13');
  assert.strictEqual(p.hour, 15);
  assert.strictEqual(p.minute, 30);
  assert.strictEqual(p.weekday, 'Fri');
  assert.strictEqual(p.dow, 5);
});

test('midnight Chicago is hour 0, not hour 24', () => {
  const p = chicagoParts(at('2026-11-13T06:00:00Z')); // 00:00 CT
  assert.strictEqual(p.hour, 0);
  assert.strictEqual(p.date, '2026-11-13');
});

test('the clock follows DST, not a fixed offset', () => {
  const summer = chicagoParts(at('2026-07-01T19:00:00Z')); // CDT = UTC-5 -> 14:00
  const winter = chicagoParts(at('2026-12-01T19:00:00Z')); // CST = UTC-6 -> 13:00
  assert.strictEqual(summer.hour, 14);
  assert.strictEqual(winter.hour, 13);
});

// ── Session assignment (17:00 CT rollover) ────────────────────────────────
test('a session is named for the day it ends', () => {
  assert.strictEqual(currentSessionDate(at('2026-11-12T22:59:59Z')), '2026-11-12'); // 16:59 CT
  assert.strictEqual(currentSessionDate(at('2026-11-12T23:00:00Z')), '2026-11-13'); // 17:00 CT
  assert.strictEqual(currentSessionDate(at('2026-11-13T05:00:00Z')), '2026-11-13'); // 23:00 CT Thu
  assert.strictEqual(currentSessionDate(at('2026-11-13T15:00:00Z')), '2026-11-13'); // 09:00 CT Fri
});

test('the session rolls over a month end', () => {
  assert.strictEqual(currentSessionDate(at('2026-11-30T23:30:00Z')), '2026-12-01'); // 17:30 CT Nov 30
});

// ── Market open / closed ──────────────────────────────────────────────────
test('Saturday is closed all day', () => {
  for (const t of ['2026-11-14T06:00:00Z', '2026-11-14T16:00:00Z', '2026-11-14T23:59:00Z']) {
    assert.strictEqual(isMarketOpen(at(t)), false, t);
    assert.strictEqual(marketClosedReason(at(t)), 'weekend');
  }
});

test('Sunday opens at 17:00 CT and not a minute before', () => {
  assert.strictEqual(isMarketOpen(at('2026-11-15T22:59:00Z')), false); // 16:59 CT Sun
  assert.strictEqual(isMarketOpen(at('2026-11-15T23:00:00Z')), true);  // 17:00 CT Sun
  assert.strictEqual(marketClosedReason(at('2026-11-15T22:59:00Z')), 'weekend');
  assert.strictEqual(marketClosedReason(at('2026-11-15T23:00:00Z')), null);
});

test('Friday closes at 16:00 CT and stays shut', () => {
  assert.strictEqual(isMarketOpen(at('2026-11-13T21:59:00Z')), true);  // 15:59 CT Fri
  assert.strictEqual(isMarketOpen(at('2026-11-13T22:00:00Z')), false); // 16:00 CT Fri
  assert.strictEqual(isMarketOpen(at('2026-11-13T23:30:00Z')), false); // 17:30 CT Fri — no reopen
  assert.strictEqual(marketClosedReason(at('2026-11-13T23:30:00Z')), 'weekend');
});

test('the 16:00-17:00 CT daily break is closed on a weekday', () => {
  assert.strictEqual(isMarketOpen(at('2026-11-11T21:59:00Z')), true);  // 15:59 CT Wed
  assert.strictEqual(isMarketOpen(at('2026-11-11T22:00:00Z')), false); // 16:00 CT Wed
  assert.strictEqual(isMarketOpen(at('2026-11-11T22:59:00Z')), false); // 16:59 CT Wed
  assert.strictEqual(isMarketOpen(at('2026-11-11T23:00:00Z')), true);  // 17:00 CT Wed
  assert.strictEqual(marketClosedReason(at('2026-11-11T22:30:00Z')), 'daily break');
});

test('the overnight session is open', () => {
  assert.strictEqual(isMarketOpen(at('2026-11-12T08:00:00Z')), true); // 02:00 CT Thu
  assert.strictEqual(isMarketOpen(at('2026-11-12T13:00:00Z')), true); // 07:00 CT Thu
});

// ── Labels ────────────────────────────────────────────────────────────────
test('the Chicago time label reads as a human clock', () => {
  assert.strictEqual(chicagoTimeLabel(at('2026-11-13T15:41:00Z')), '9:41 AM CT');
  assert.strictEqual(chicagoTimeLabel(at('2026-11-13T21:05:00Z')), '3:05 PM CT');
  assert.strictEqual(chicagoTimeLabel(at('2026-11-13T18:00:00Z')), '12:00 PM CT');
  assert.strictEqual(chicagoTimeLabel(at('2026-11-13T06:07:00Z')), '12:07 AM CT');
});
