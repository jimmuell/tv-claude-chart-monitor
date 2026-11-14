'use strict';

// The macOS menu-bar title. The two things that must never happen: a fabricated
// $0.00 when nothing has been imported, and a silently stale number during live
// trading.

const test   = require('node:test');
const assert = require('node:assert');
const path   = require('path');

const tt = require(path.join(__dirname, '../../src/shared/tray-title.js'));
const { trayTitle, trayTooltip, formatNet, isStale, NO_DATA_TITLE } = tt;

const at = (iso) => Date.parse(iso);

// Reference instants, all written as UTC with their Chicago meaning noted.
const FRI_OPEN    = at('2026-11-13T20:00:00Z'); // Fri 14:00 CT — trading
const FRI_CLOSED  = at('2026-11-13T23:00:00Z'); // Fri 17:00 CT — shut for the week
const SAT         = at('2026-11-14T16:00:00Z'); // Sat 10:00 CT — weekend
const SUN_OPEN    = at('2026-11-15T23:30:00Z'); // Sun 17:30 CT — week reopened
const WED_BREAK   = at('2026-11-11T22:30:00Z'); // Wed 16:30 CT — daily break
const MIN = 60_000;

/** An import state holding one finished session. */
function state({ net = 896.65, importedAt = FRI_OPEN, fallback = false, session = true } = {}) {
  return {
    session: session ? {
      sessionDate: '2026-11-13', fillCount: 145, buys: 333, sells: 333,
      avgBuy: 7605.2192, avgSell: 7605.9977, grossPnl: 1296.25,
      contractSides: 666, roundTrips: 333, fees: 399.60, netPnl: net,
      openPositionAtStart: 0, openPositionAtEnd: 0,
    } : null,
    isFallback: fallback, currentSession: '2026-11-13',
    importedAt, fileName: 'amp-order-history-all.csv', filePath: '/tmp/x.csv',
    fillCount: 707, skippedRows: 0, sessionCount: 10,
    errorCode: null, errorMessage: null, lastAttemptAt: importedAt, watchFolder: '/tmp',
  };
}

// ── The number itself ─────────────────────────────────────────────────────
test('a profit is signed and a loss is signed', () => {
  assert.strictEqual(formatNet(896.65), '+$896.65');
  assert.strictEqual(formatNet(-810.49), '-$810.49');
  assert.strictEqual(formatNet(0), '+$0.00');
  assert.strictEqual(formatNet(-0.004), '+$0.00'); // rounds to zero, stays positive-signed
  assert.strictEqual(formatNet(1234.5), '+$1234.50');
});

test('the title is the session net', () => {
  assert.strictEqual(trayTitle(state({ net: 896.65 }), { now: FRI_OPEN }), '+$896.65');
  assert.strictEqual(trayTitle(state({ net: -810.49 }), { now: FRI_OPEN }), '-$810.49');
});

// ── Never a fabricated zero ───────────────────────────────────────────────
test('with no import at all the title is a dash, never $0.00', () => {
  assert.strictEqual(trayTitle(null, { now: FRI_OPEN }), NO_DATA_TITLE);
  assert.strictEqual(trayTitle(undefined, { now: FRI_OPEN }), NO_DATA_TITLE);
  assert.strictEqual(trayTitle({}, { now: FRI_OPEN }), NO_DATA_TITLE);
  assert.strictEqual(NO_DATA_TITLE, 'P&L —');
});

test('a state with no session for today is a dash, not a zero', () => {
  assert.strictEqual(trayTitle(state({ session: false }), { now: FRI_OPEN }), NO_DATA_TITLE);
});

test('an import time with no session is still a dash', () => {
  assert.strictEqual(trayTitle(state({ session: false, importedAt: FRI_OPEN }), { now: FRI_OPEN }), NO_DATA_TITLE);
});

test('a genuinely flat session shows $0.00, which is not the same as no data', () => {
  assert.strictEqual(trayTitle(state({ net: 0 }), { now: FRI_OPEN }), '+$0.00');
});

// ── The stale rule ────────────────────────────────────────────────────────
test('a fresh import carries no warning', () => {
  assert.strictEqual(trayTitle(state({ importedAt: FRI_OPEN - 5 * MIN }), { now: FRI_OPEN }), '+$896.65');
});

test('an import older than the threshold warns while the market is open', () => {
  assert.strictEqual(trayTitle(state({ importedAt: FRI_OPEN - 31 * MIN }), { now: FRI_OPEN }), '+$896.65 ⚠');
});

test('the threshold boundary is exclusive — exactly 30 minutes is not yet stale', () => {
  assert.strictEqual(trayTitle(state({ importedAt: FRI_OPEN - 30 * MIN }), { now: FRI_OPEN }), '+$896.65');
  assert.strictEqual(trayTitle(state({ importedAt: FRI_OPEN - 30 * MIN - 1 }), { now: FRI_OPEN }), '+$896.65 ⚠');
});

test('the threshold comes from settings', () => {
  const s = state({ importedAt: FRI_OPEN - 10 * MIN });
  assert.strictEqual(trayTitle(s, { now: FRI_OPEN, staleMinutes: 5 }), '+$896.65 ⚠');
  assert.strictEqual(trayTitle(s, { now: FRI_OPEN, staleMinutes: 60 }), '+$896.65');
});

test('a zero or negative threshold disables the warning rather than warning always', () => {
  const s = state({ importedAt: FRI_OPEN - 10 * 60 * MIN });
  assert.strictEqual(trayTitle(s, { now: FRI_OPEN, staleMinutes: 0 }), '+$896.65');
  assert.strictEqual(trayTitle(s, { now: FRI_OPEN, staleMinutes: -5 }), '+$896.65');
});

// ── Stale only matters while the market is open ───────────────────────────
test('a day-old import on Saturday is not stale — it is just Friday', () => {
  assert.strictEqual(trayTitle(state({ importedAt: SAT - 20 * 60 * MIN }), { now: SAT }), '+$896.65');
  assert.strictEqual(isStale(SAT - 20 * 60 * MIN, SAT, 30), false);
});

test('an old import during the 16:00-17:00 daily break does not warn', () => {
  assert.strictEqual(trayTitle(state({ importedAt: WED_BREAK - 90 * MIN }), { now: WED_BREAK }), '+$896.65');
  assert.strictEqual(isStale(WED_BREAK - 90 * MIN, WED_BREAK, 30), false);
});

test('an old import after Friday 16:00 CT does not warn', () => {
  assert.strictEqual(trayTitle(state({ importedAt: FRI_CLOSED - 120 * MIN }), { now: FRI_CLOSED }), '+$896.65');
});

test('the same age warns again once Sunday 17:00 CT reopens the week', () => {
  assert.strictEqual(trayTitle(state({ importedAt: SUN_OPEN - 120 * MIN }), { now: SUN_OPEN }), '+$896.65 ⚠');
});

test('a missing import time is never stale', () => {
  assert.strictEqual(isStale(null, FRI_OPEN, 30), false);
  assert.strictEqual(isStale(undefined, FRI_OPEN, 30), false);
});

// ── Tooltip ───────────────────────────────────────────────────────────────
test('the tooltip names the session, the money and the import time', () => {
  const t = trayTooltip(state(), { now: FRI_OPEN });
  assert.ok(t.includes('Session 2026-11-13'), t);
  assert.ok(t.includes('Net +$896.65'), t);
  assert.ok(t.includes('Gross +$1296.25'), t);
  assert.ok(t.includes('Fees $399.60'), t);
  assert.ok(t.includes('666 contract-sides (333 RT)'), t);
  assert.ok(/Imported \d+:\d\d (AM|PM) CT/.test(t), t);
});

test('the tooltip says when it is showing an earlier session', () => {
  const t = trayTooltip(state({ fallback: true }), { now: SAT });
  assert.ok(t.includes('(last session with fills)'), t);
});

test('the tooltip surfaces a failed import and an open position', () => {
  const s = state();
  s.errorCode = 'TVCM-OH-BAD-HEADER';
  s.session.openPositionAtEnd = -2;
  const t = trayTooltip(s, { now: FRI_OPEN });
  assert.ok(t.includes('Last import failed: TVCM-OH-BAD-HEADER'), t);
  assert.ok(t.includes('Open position -2'), t);
});

test('the tooltip says plainly when nothing has been imported', () => {
  assert.strictEqual(trayTooltip(null, { now: FRI_OPEN }), 'Trading Analyzer — no order-history import yet');
});

test('the tooltip marks a stale import', () => {
  const t = trayTooltip(state({ importedAt: FRI_OPEN - 45 * MIN }), { now: FRI_OPEN });
  assert.ok(t.includes('— stale'), t);
});
