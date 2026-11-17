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

// REWORDED in TVCM-39: "(last session with fills)" became a line that leads with the day,
// because the day is the part that stops the number being read as today's. The assertion
// is strengthened, not relaxed — it now also requires the day to be named.
test('the tooltip says when it is showing an earlier session', () => {
  const t = trayTooltip(state({ fallback: true }), { now: SAT });
  assert.ok(t.includes('Fri 11/13'), t);
  assert.ok(t.includes('last session with fills'), t);
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

// ── Colour, for the number-only menu bar ──────────────────────────────────
test('a gain is wrapped in green, a loss in red', () => {
  const green = tt.trayTitleColoured(state({ net: 896.65 }), { now: FRI_OPEN });
  const red   = tt.trayTitleColoured(state({ net: -810.49 }), { now: FRI_OPEN });
  assert.ok(green.startsWith(tt.ANSI.green), 'a gain should be green');
  assert.ok(red.startsWith(tt.ANSI.red), 'a loss should be red');
  assert.ok(green.endsWith(tt.ANSI.reset));
  assert.ok(red.endsWith(tt.ANSI.reset));
});

test('colour never changes what the number says', () => {
  for (const n of [896.65, -810.49, 0, -0.004, 1234.5]) {
    const s = state({ net: n });
    assert.strictEqual(tt.stripAnsi(tt.trayTitleColoured(s, { now: FRI_OPEN })), tt.trayTitle(s, { now: FRI_OPEN }));
  }
});

test('a flat day is left uncoloured rather than painted green', () => {
  const t = tt.trayTitleColoured(state({ net: 0 }), { now: FRI_OPEN });
  assert.strictEqual(t, '+$0.00');
  assert.strictEqual(tt.ansiFor(0), '');
});

test('the no-data title carries no colour escapes at all', () => {
  const t = tt.trayTitleColoured(null, { now: FRI_OPEN });
  assert.strictEqual(t, 'P&L —');
  assert.strictEqual(tt.stripAnsi(t), t);
});

test('the stale marker survives colouring', () => {
  const t = tt.trayTitleColoured(state({ importedAt: FRI_OPEN - 45 * MIN }), { now: FRI_OPEN });
  assert.ok(tt.stripAnsi(t).endsWith(' ⚠'), tt.stripAnsi(t));
});

test('the title is never empty, in any state — an empty tray cannot be clicked', () => {
  const cases = [null, undefined, {}, state({ session: false }), state({ net: 0 }), state({ net: -1 })];
  for (const s of cases) {
    for (const fn of [tt.trayTitle, tt.trayTitleColoured]) {
      const out = fn(s, { now: FRI_OPEN });
      assert.ok(typeof out === 'string' && tt.stripAnsi(out).trim().length > 0,
        `empty title for ${JSON.stringify(s)}`);
    }
  }
});

test('stripAnsi survives nothing and non-strings', () => {
  assert.strictEqual(tt.stripAnsi(null), '');
  assert.strictEqual(tt.stripAnsi(undefined), '');
  assert.strictEqual(tt.stripAnsi('plain'), 'plain');
});

// ── TEST prefix for a non-default userData profile ────────────────────────
// A test copy runs alongside the everyday one (the single-instance lock is per
// profile) and puts a second tray in the menu bar. Three prompts running, the two
// were read as the same thing; the prefix is what stops that.

test('the everyday profile shows no prefix', () => {
  assert.strictEqual(tt.trayTitle(state(), { now: FRI_OPEN }), '+$896.65');
  assert.strictEqual(tt.trayTitle(state(), { now: FRI_OPEN, isTestProfile: false }), '+$896.65');
});

test('a test profile is prefixed with "TEST "', () => {
  assert.strictEqual(tt.trayTitle(state(), { now: FRI_OPEN, isTestProfile: true }), 'TEST +$896.65');
  assert.strictEqual(tt.TEST_PREFIX, 'TEST ');
});

test('the prefix applies to a loss and to the no-data dash too', () => {
  assert.strictEqual(tt.trayTitle(state({ net: -810.49 }), { now: FRI_OPEN, isTestProfile: true }), 'TEST -$810.49');
  assert.strictEqual(tt.trayTitle(null, { now: FRI_OPEN, isTestProfile: true }), 'TEST P&L —');
  assert.strictEqual(tt.trayTitle(null, { now: FRI_OPEN }), 'P&L —');
});

test('the prefix survives the stale marker and the colour wrapper', () => {
  const stale = tt.trayTitle(state({ importedAt: FRI_OPEN - 45 * MIN }), { now: FRI_OPEN, isTestProfile: true });
  assert.strictEqual(stale, 'TEST +$896.65 ⚠');
  const coloured = tt.trayTitleColoured(state(), { now: FRI_OPEN, isTestProfile: true });
  assert.strictEqual(tt.stripAnsi(coloured), 'TEST +$896.65');
});

test('the prefix never produces an empty or ambiguous title', () => {
  for (const s of [null, undefined, {}, state(), state({ net: 0 })]) {
    const out = tt.trayTitle(s, { now: FRI_OPEN, isTestProfile: true });
    assert.ok(out.startsWith('TEST '), `missing prefix: ${out}`);
    assert.ok(out.length > 'TEST '.length, `nothing after the prefix: ${out}`);
  }
});

test('the tooltip says which copy this is', () => {
  const real = tt.trayTooltip(state(), { now: FRI_OPEN });
  const test = tt.trayTooltip(state(), { now: FRI_OPEN, isTestProfile: true });
  assert.ok(!/TEST PROFILE/.test(real), real);
  assert.ok(test.startsWith('TEST PROFILE — not your everyday TVCM'), test);
  assert.ok(test.includes('Net +$896.65'), 'the rest of the tooltip must survive');
});

test('the empty tooltip is labelled on a test profile too', () => {
  assert.strictEqual(tt.trayTooltip(null, { now: FRI_OPEN, isTestProfile: true }),
    'TEST PROFILE — Trading Analyzer — no order-history import yet');
  assert.strictEqual(tt.trayTooltip(null, { now: FRI_OPEN }),
    'Trading Analyzer — no order-history import yet');
});

// ── A failed import is visible in the menu bar at once (TVCM-24) ───────────
// Before this, a failed import only reached the tray TOOLTIP. The menu bar kept
// showing the last good number with nothing to say it was no longer being
// refreshed — and the stale marker could not cover for it, because that one waits
// 30 minutes and is suppressed outside market hours.

/** The same state, but with the most recent import attempt having failed. */
function failedState(extra = {}) {
  const s = state(extra);
  s.errorCode    = extra.errorCode    || 'TVCM-OH-BAD-HEADER';
  s.errorMessage = extra.errorMessage || 'TVCM-OH-BAD-HEADER: missing column Fill quantity';
  s.lastAttemptAt = (extra.importedAt ?? FRI_OPEN) + 60_000;
  return s;
}

test('a failed import marks the title immediately, not after 30 minutes', () => {
  const s = failedState({ importedAt: FRI_OPEN - 2 * MIN });
  assert.strictEqual(tt.isStale(s.importedAt, FRI_OPEN, 30), false, 'this one is nowhere near stale');
  assert.strictEqual(trayTitle(s, { now: FRI_OPEN }), '+$896.65 ⚠');
});

test('the failure marker is not gated on market hours the way the stale marker is', () => {
  assert.strictEqual(trayTitle(failedState({ importedAt: SAT - 60 * MIN }), { now: SAT }), '+$896.65 ⚠');
  assert.strictEqual(trayTitle(failedState({ importedAt: WED_BREAK - 5 * MIN }), { now: WED_BREAK }), '+$896.65 ⚠');
  assert.strictEqual(trayTitle(failedState({ importedAt: FRI_CLOSED - 5 * MIN }), { now: FRI_CLOSED }), '+$896.65 ⚠');
});

test('a failure and a stale import together produce one marker, not two', () => {
  const s = failedState({ importedAt: FRI_OPEN - 45 * MIN });
  assert.strictEqual(trayTitle(s, { now: FRI_OPEN }), '+$896.65 ⚠');
});

test('turning the stale threshold off does not silence a failed import', () => {
  const s = failedState({ importedAt: FRI_OPEN - 2 * MIN });
  assert.strictEqual(trayTitle(s, { now: FRI_OPEN, staleMinutes: 0 }), '+$896.65 ⚠');
});

test('a later successful import clears the marker', () => {
  const failed = failedState({ importedAt: FRI_OPEN - 2 * MIN });
  assert.strictEqual(trayTitle(failed, { now: FRI_OPEN }), '+$896.65 ⚠');

  // What importFile() writes on success: a new importedAt and no error.
  const recovered = { ...failed, importedAt: FRI_OPEN, lastAttemptAt: FRI_OPEN,
                      errorCode: null, errorMessage: null };
  assert.strictEqual(trayTitle(recovered, { now: FRI_OPEN }), '+$896.65');
  assert.strictEqual(tt.hasFailedImport(recovered), false);
});

test('hasFailedImport is true only when the most recent attempt failed', () => {
  assert.strictEqual(tt.hasFailedImport(failedState()), true);
  assert.strictEqual(tt.hasFailedImport(state()), false);
  assert.strictEqual(tt.hasFailedImport(null), false);
  assert.strictEqual(tt.hasFailedImport(undefined), false);
  assert.strictEqual(tt.hasFailedImport({}), false);
});

test('the failure marker survives colouring and the TEST prefix', () => {
  const s = failedState({ importedAt: FRI_OPEN - 2 * MIN });
  assert.ok(tt.stripAnsi(tt.trayTitleColoured(s, { now: FRI_OPEN })).endsWith(' ⚠'));
  assert.strictEqual(tt.trayTitle(s, { now: FRI_OPEN, isTestProfile: true }), 'TEST +$896.65 ⚠');
});

test('the tooltip says what failed and why, not just that something did', () => {
  const t = trayTooltip(failedState({ importedAt: FRI_OPEN - 2 * MIN }), { now: FRI_OPEN });
  assert.ok(t.includes('TVCM-OH-BAD-HEADER'), t);
  assert.ok(t.includes('missing column Fill quantity'), 'the tooltip must carry the reason: ' + t);
  assert.ok(t.includes('Net +$896.65'), 'the last good numbers must still be there');
});

test('the tooltip carries whatever code and file the watcher reported', () => {
  const t = trayTooltip(failedState({
    errorCode:    'TVCM-OI-UNREADABLE',
    errorMessage: "EACCES: permission denied, open 'amp-order-history-all-2.csv'",
  }), { now: FRI_OPEN });
  assert.ok(t.includes('TVCM-OI-UNREADABLE'), t);
  assert.ok(t.includes('amp-order-history-all-2.csv'), t);
});

test('a failure with no good numbers yet is marked too, and the tooltip stops claiming nothing was tried', () => {
  const s = failedState({ session: false, importedAt: FRI_OPEN });
  s.importedAt = null;
  assert.strictEqual(trayTitle(s, { now: FRI_OPEN }), 'P&L — ⚠');
  const t = trayTooltip(s, { now: FRI_OPEN });
  assert.ok(!t.includes('no order-history import yet'), 'an import WAS tried and failed: ' + t);
  assert.ok(t.includes('TVCM-OH-BAD-HEADER'), t);
});

test('a very long error message is truncated so the tooltip stays readable', () => {
  const t = trayTooltip(failedState({ errorMessage: 'x'.repeat(400) }), { now: FRI_OPEN });
  const line = t.split('\n').find(l => l.includes('TVCM-OH-BAD-HEADER'));
  assert.ok(line.length < 200, `tooltip line is ${line.length} chars`);
  assert.ok(line.includes('…'), 'a truncated message should say so: ' + line);
});

// ── Paper mode in the menu bar (TVCM-26) ──────────────────────────────────
// Paper money must be impossible to mistake for real money at a glance, and a
// toggle that disagrees with TradingView's actual account must say so — in both
// directions, because either way the number on screen is the wrong account's.

test('paper mode prefixes the number, so play money never reads as real', () => {
  assert.strictEqual(trayTitle(state(), { now: FRI_OPEN, paperMode: true }), 'PAPER +$896.65');
  assert.strictEqual(tt.PAPER_PREFIX, 'PAPER ');
});

test('the everyday live view carries no paper prefix', () => {
  assert.strictEqual(trayTitle(state(), { now: FRI_OPEN, paperMode: false }), '+$896.65');
  assert.strictEqual(trayTitle(state(), { now: FRI_OPEN }), '+$896.65');
});

test('a test profile and paper mode are both labelled, and in a fixed order', () => {
  assert.strictEqual(trayTitle(state(), { now: FRI_OPEN, paperMode: true, isTestProfile: true }),
    'TEST PAPER +$896.65');
});

test('paper mode labels the dash and a loss too', () => {
  assert.strictEqual(trayTitle(null, { now: FRI_OPEN, paperMode: true }), 'PAPER P&L —');
  assert.strictEqual(trayTitle(state({ net: -12.5 }), { now: FRI_OPEN, paperMode: true }), 'PAPER -$12.50');
});

test('the paper prefix survives the warning marker and the colour wrapper', () => {
  const s = state({ importedAt: FRI_OPEN - 45 * MIN });
  assert.strictEqual(trayTitle(s, { now: FRI_OPEN, paperMode: true }), 'PAPER +$896.65 ⚠');
  assert.strictEqual(tt.stripAnsi(tt.trayTitleColoured(state(), { now: FRI_OPEN, paperMode: true })),
    'PAPER +$896.65');
});

test('an account mismatch is marked in the menu bar, whichever way round it is', () => {
  const onPaperToggleOff = state();
  onPaperToggleOff.errorCode    = 'TVCM-LF-ACCOUNT-MISMATCH';
  onPaperToggleOff.errorMessage = 'TradingView is on Paper Trading but Paper mode is off';
  assert.strictEqual(trayTitle(onPaperToggleOff, { now: FRI_OPEN, paperMode: false }), '+$896.65 ⚠');

  const onLiveToggleOn = state();
  onLiveToggleOn.errorCode    = 'TVCM-LF-ACCOUNT-MISMATCH';
  onLiveToggleOn.errorMessage = 'TradingView is on AMP Live but Paper mode is on';
  assert.strictEqual(trayTitle(onLiveToggleOn, { now: FRI_OPEN, paperMode: true }), 'PAPER +$896.65 ⚠');
});

test('the tooltip tells Jim which way to switch', () => {
  const s = state();
  s.errorCode    = 'TVCM-LF-ACCOUNT-MISMATCH';
  s.errorMessage = 'TradingView is on Paper Trading but Paper mode is off';
  const t = trayTooltip(s, { now: FRI_OPEN, switchHint: 'Turn Paper mode on, or switch TradingView to AMP Live.' });
  assert.ok(t.includes('TVCM-LF-ACCOUNT-MISMATCH'), t);
  assert.ok(t.includes('Turn Paper mode on'), 'the tooltip must say what to do: ' + t);
});

test('the tooltip says plainly that a paper number is not real money', () => {
  const t = trayTooltip(state(), { now: FRI_OPEN, paperMode: true });
  assert.ok(/PAPER/.test(t), t);
  assert.ok(/not real money/i.test(t), 'a paper tooltip must say so in words: ' + t);
  assert.ok(!/not real money/i.test(trayTooltip(state(), { now: FRI_OPEN })), 'the live tooltip must not');
});

test('the empty tooltip is labelled in paper mode too', () => {
  const t = trayTooltip(null, { now: FRI_OPEN, paperMode: true });
  assert.ok(t.startsWith('PAPER —'), t);
});

test('replay is explained in the tooltip without marking the menu bar', () => {
  const s = state();
  const t = trayTooltip(s, { now: FRI_OPEN, feedReason: 'not available in replay — TradingView is in Bar Replay' });
  assert.ok(/replay/i.test(t), t);
  assert.strictEqual(trayTitle(s, { now: FRI_OPEN }), '+$896.65', 'replay must not warn');
});

test('the "as of" line names which source produced the number', () => {
  const live = trayTooltip(state(), { now: FRI_OPEN, source: 'feed' });
  assert.ok(/live feed/i.test(live), live);
  const csv = trayTooltip(state(), { now: FRI_OPEN, source: 'csv' });
  assert.ok(/export/i.test(csv), csv);
});

// ── The tooltip names the collection and the cross-check (TVCM-29) ────────
// "Live feed" alone is not enough once the two brokers read different
// collections: AMP's fills are in orders(), paper's in allExecutions(), and
// reading the wrong one is what TVCM-28 failed on.

test('the tooltip names which collection the feed read', () => {
  const amp = trayTooltip(state(), { now: FRI_OPEN, source: 'feed', feedSource: 'orders' });
  assert.ok(/live feed \(orders\)/i.test(amp), amp);
  const paper = trayTooltip(state(), { now: FRI_OPEN, source: 'feed', feedSource: 'executions' });
  assert.ok(/live feed \(executions\)/i.test(paper), paper);
});

test('an unnamed collection still reads sensibly', () => {
  const t = trayTooltip(state(), { now: FRI_OPEN, source: 'feed' });
  assert.ok(/live feed/i.test(t), t);
  assert.ok(!/\(\)/.test(t), 'no empty brackets: ' + t);
});

test('a passing broker cross-check is stated, not left to be assumed', () => {
  const t = trayTooltip(state(), { now: FRI_OPEN, source: 'feed', feedSource: 'orders',
                                   crossCheck: { state: 'ok', code: null, delta: 0, message: null } });
  assert.ok(/cross-check/i.test(t), t);
  assert.ok(/OK/.test(t), t);
});

test('a failing cross-check says what went wrong instead of "OK"', () => {
  // TVCM-33: BLIND is a real fault, so it is reported through the failure line —
  // which is what the reader sets — rather than twice, as a cross-check note too.
  const s = state();
  s.errorCode = 'TVCM-LF-BLIND';
  s.errorMessage = 'the feed found no fills but 5 contract(s) are open';
  const t = trayTooltip(s, { now: FRI_OPEN, source: 'feed', feedSource: 'orders',
    crossCheck: { state: 'blind', code: 'TVCM-LF-BLIND', delta: null,
                  message: 'the feed found no fills but 5 contract(s) are open' } });
  assert.ok(/no fills/.test(t), t);
  assert.ok(!/cross-check: OK/i.test(t), 'a broken check must never read as OK: ' + t);
  assert.strictEqual(t.split('\n').filter(l => /no fills/.test(l)).length, 1, 'said twice:\n' + t);
});

test('a cross-check that could not run says so rather than claiming a pass', () => {
  const t = trayTooltip(state(), { now: FRI_OPEN, source: 'feed',
    crossCheck: { state: 'unavailable', code: null, delta: null, message: 'the broker reports no position rows' } });
  assert.ok(/no position rows|not available|cannot be cross-checked/i.test(t), t);
  assert.ok(!/cross-check: OK/i.test(t), t);
});

test('a CSV-sourced tooltip carries no cross-check line at all', () => {
  const t = trayTooltip(state(), { now: FRI_OPEN, source: 'csv',
                                   crossCheck: { state: 'ok', code: null, delta: 0, message: null } });
  assert.ok(/export/i.test(t), t);
  assert.ok(!/cross-check/i.test(t), 'the export is not cross-checked against the broker: ' + t);
});

// ── Feed status and import failure are different things (TVCM-33) ─────────
// TVCM-29 routed the cross-check through errorCode, and hasFailedImport() reads
// ANY errorCode as a failed import. TVCM-31 caught the result: the same sentence
// printed twice, followed by "the number above is not being refreshed" — about a
// number that had been read that same second.

/** The state as it looks when the last read SUCCEEDED but the broker figure differs. */
function differsState() {
  const s = state({ importedAt: FRI_OPEN });
  s.errorCode = null;          // a difference is informational: never an error code
  s.errorMessage = null;
  return s;
}

test('an informational cross-check prints once, and claims no failure', () => {
  const t = trayTooltip(differsState(), {
    now: FRI_OPEN, source: 'feed', feedSource: 'orders',
    crossCheck: { state: 'differs', code: null, delta: -87.5,
                  message: 'this session reads 473.75 gross here and 561.25 at the broker' },
  });
  const hits = t.split('\n').filter(l => /561\.25/.test(l));
  assert.strictEqual(hits.length, 1, 'the message was printed twice:\n' + t);
  assert.ok(!/Last import failed/i.test(t), 'a difference is not an import failure: ' + t);
  assert.ok(!/not being refreshed/i.test(t), 'the number WAS refreshed: ' + t);
});

test('a successful read never claims the number is not being refreshed', () => {
  for (const cc of [{ state: 'ok' }, { state: 'differs', message: 'x' }, { state: 'unavailable', message: 'y' }]) {
    const t = trayTooltip(differsState(), { now: FRI_OPEN, source: 'feed', feedSource: 'orders', crossCheck: cc });
    assert.ok(!/not being refreshed/i.test(t), `${cc.state}: ` + t);
  }
});

// REWORDED in TVCM-41: a lost connection used to arrive as "Last import failed:
// TVCM-LF-NOT-CONNECTED — WebSocket is not open", which named a code and left Jim to
// work out whether it was his to fix. It now says what happened and that TVCM is already
// dealing with it. The "not being refreshed" half — the part that keeps a stale number
// honest — is unchanged, and still asserted to appear exactly once.
test('a real read failure DOES say the number is not being refreshed, once', () => {
  const s = state({ importedAt: FRI_OPEN - 10 * MIN });
  s.errorCode = 'TVCM-LF-NOT-CONNECTED';
  s.errorMessage = 'WebSocket is not open';
  const t = trayTooltip(s, { now: FRI_OPEN, source: 'feed', feedSource: 'orders',
                             cdpLostAt: FRI_OPEN - 10 * MIN,
                             crossCheck: { state: 'unavailable', message: 'no figure' } });
  assert.ok(/Lost connection to TradingView at .* — reconnecting/.test(t), t);
  assert.ok(/not being refreshed/i.test(t), t);
  assert.strictEqual(t.split('\n').filter(l => /not being refreshed/i.test(l)).length, 1);
});

test('BLIND is a real failure and still says so', () => {
  const s = state({ importedAt: FRI_OPEN - 10 * MIN });
  s.errorCode = 'TVCM-LF-BLIND';
  s.errorMessage = 'the feed found no fills but 5 contract(s) are open';
  const t = trayTooltip(s, { now: FRI_OPEN, source: 'csv',
                             crossCheck: { state: 'blind', code: 'TVCM-LF-BLIND',
                                           message: 'the feed found no fills but 5 contract(s) are open' } });
  assert.ok(/TVCM-LF-BLIND/.test(t), t);
  assert.strictEqual(t.split('\n').filter(l => /no fills but 5 contract/.test(l)).length, 1,
    'blind printed twice:\n' + t);
});

test('the cross-check line never duplicates the failure line', () => {
  const s = state({ importedAt: FRI_OPEN - 10 * MIN });
  s.errorCode = 'TVCM-LF-BLIND';
  s.errorMessage = 'same sentence';
  const t = trayTooltip(s, { now: FRI_OPEN, source: 'feed', feedSource: 'orders',
                             crossCheck: { state: 'blind', code: 'TVCM-LF-BLIND', message: 'same sentence' } });
  assert.strictEqual(t.split('\n').filter(l => /same sentence/.test(l)).length, 1, t);
});

test('each cross-check state reads correctly on its own line', () => {
  const mk = (cc) => trayTooltip(differsState(), { now: FRI_OPEN, source: 'feed', feedSource: 'orders', crossCheck: cc });
  assert.match(mk({ state: 'ok' }), /Broker cross-check: OK/);
  assert.match(mk({ state: 'unavailable', message: 'no figure' }), /not available/i);
  assert.match(mk({ state: 'differs', message: 'reads 1 here and 2 at the broker' }),
               /Broker cross-check: for information/i);
});

// ── "Last known" is not "live" (TVCM-32 Task 2b) ─────────────────────────

test('a last-known number says so, and still says when it was read', () => {
  const t = trayTooltip(state(), { now: FRI_OPEN, source: 'feed', feedSource: 'orders', lastKnown: true });
  assert.ok(/last known/i.test(t), t);
  assert.ok(!/Live feed \(orders\) read/.test(t), 'it must not claim to be live: ' + t);
  assert.ok(/\d+:\d\d (AM|PM) CT/.test(t), 'the as-of time must still be there: ' + t);
});

test('a live number is not labelled last known', () => {
  const t = trayTooltip(state(), { now: FRI_OPEN, source: 'feed', feedSource: 'orders', lastKnown: false });
  assert.ok(/Live feed \(orders\) read/.test(t), t);
  assert.ok(!/last known/i.test(t), t);
});

// ── A live fault is not a stale number (TVCM-35) ─────────────────────────
// TVCM-33 fixed this for the cross-check by removing its error code. The
// position mismatch is a genuine fault that DOES set one — and the numbers it
// complains about were read that same second.

test('a position mismatch is reported without claiming the number is stale', () => {
  const s = state({ importedAt: FRI_OPEN });
  s.errorCode = 'TVCM-LF-POSITION-MISMATCH';
  s.errorMessage = "TradingView's records and its live position disagree (orders say -5, it reports 0) — a fill may be missing";
  const t = trayTooltip(s, { now: FRI_OPEN, source: 'feed', feedSource: 'orders', lastKnown: false });
  assert.ok(/live position disagree/.test(t), t);
  assert.ok(/fill may be missing/.test(t), t);
  assert.ok(!/not being refreshed/i.test(t), 'the number was read this second: ' + t);
  assert.ok(!/Last import failed/i.test(t), 'a live fault is not an import failure: ' + t);
  assert.strictEqual(t.split('\n').filter(l => /fill may be missing/.test(l)).length, 1);
});

test('a genuinely stale number still says so', () => {
  const s = state({ importedAt: FRI_OPEN - 90 * MIN });
  s.errorCode = 'TVCM-LF-NOT-CONNECTED';
  s.errorMessage = 'WebSocket is not open';
  const t = trayTooltip(s, { now: FRI_OPEN, source: 'feed', feedSource: 'orders', lastKnown: true,
                             cdpState: 'lost', cdpLostAt: FRI_OPEN - 90 * MIN });
  assert.ok(/Lost connection to TradingView/i.test(t), t);
  assert.ok(/not being refreshed/i.test(t), t);
  assert.ok(/— stale/.test(t), 'the age of the reading is still called out');
});

// ── An active correction is declared (TVCM-36) ───────────────────────────

test('the tooltip says when a number includes a fill TVCM added', () => {
  const t = trayTooltip(state(), { now: FRI_OPEN, source: 'feed', feedSource: 'orders',
                                   appliedCorrections: ['c-1'] });
  assert.match(t, /includes 1 added fill/i);
});

test('several added fills are counted', () => {
  const t = trayTooltip(state(), { now: FRI_OPEN, source: 'feed', appliedCorrections: ['a', 'b'] });
  assert.match(t, /includes 2 added fills/i);
});

test('with no corrections the tooltip says nothing about them', () => {
  for (const v of [[], null, undefined]) {
    assert.ok(!/added fill/i.test(trayTooltip(state(), { now: FRI_OPEN, source: 'feed', appliedCorrections: v })));
  }
});

// ── A past day never wears the current session's clothes (TVCM-38/39) ────
//
// At 17:00 on 2026-11-16 the menu bar read a bare "-$3.00" for a session nobody had
// traded. The number belonged to the day before; the only thing that said so was a
// tooltip. The day now travels with the number.

/** The state the merge produces when the new session is empty and yesterday is shown. */
function yesterday(over = {}) {
  return {
    session: {
      sessionDate: '2026-11-16', fillCount: 78, buys: 183, sells: 183,
      avgBuy: 7534.98, avgSell: 7536.27, grossPnl: 1183.75,
      contractSides: 366, roundTrips: 183, fees: 219.60, netPnl: 964.15,
      openPositionAtStart: 0, openPositionAtEnd: 0,
    },
    isFallback: true, currentSession: '2026-11-17',
    importedAt: at('2026-11-16T23:05:00Z'), fileName: 'live feed (live)', filePath: null,
    fillCount: 78, skippedRows: 0, sessionCount: 1,
    errorCode: null, errorMessage: null, lastAttemptAt: at('2026-11-16T23:05:00Z'),
    watchFolder: null, ...over,
  };
}

const NEW_SESSION = at('2026-11-16T23:09:00Z');  // Mon 17:09 CT — the new session, open

test('a fallback number carries its day in the menu bar, not just the tooltip', () => {
  const title = trayTitle(yesterday(), { now: NEW_SESSION });
  assert.strictEqual(title, 'Mon 11/16 +$964.15');
  assert.ok(!/^\+\$/.test(title), 'a bare number is what was misread as today');
});

test('the tooltip says the session just ended', () => {
  const t = trayTooltip(yesterday(), { now: NEW_SESSION, source: 'feed', feedSource: 'orders' });
  assert.ok(t.startsWith('Mon 11/16 — the session just ended'), t);
});

test('the current session keeps a bare number, with no day in front of it', () => {
  const today = yesterday({ isFallback: false, currentSession: '2026-11-16' });
  assert.strictEqual(trayTitle(today, { now: NEW_SESSION }), '+$964.15');
  assert.ok(trayTooltip(today, { now: NEW_SESSION }).startsWith('Session 2026-11-16'));
});

test('the stale marker still lands on a fallback number', () => {
  const old = yesterday({ importedAt: NEW_SESSION - 40 * MIN });
  assert.strictEqual(trayTitle(old, { now: NEW_SESSION, staleMinutes: 30 }),
    'Mon 11/16 +$964.15 ⚠', 'the ⚠ behaviour is unchanged');
});

test('a gap of more than three days is not "just ended"', () => {
  // Friday to Monday is three days and IS the previous session; a week is not.
  assert.ok(tt.fallbackNote('2026-11-13', '2026-11-16').endsWith('the session just ended'));
  assert.ok(tt.fallbackNote('2026-11-09', '2026-11-17').endsWith('the last session with fills'));
  assert.ok(tt.fallbackNote('2026-11-16', '2026-11-17').endsWith('the session just ended'));
});

test('the day label reads off the calendar, with no timezone conversion', () => {
  assert.strictEqual(tt.dayLabel('2026-11-16'), 'Mon 11/16');
  assert.strictEqual(tt.dayLabel('2026-11-15'), 'Sun 11/15');
  assert.strictEqual(tt.dayLabel(''), '');
  assert.strictEqual(tt.dayLabel(null), '');
});

test('an unusable date never produces a confident label', () => {
  assert.strictEqual(tt.daysBetween('nonsense', '2026-11-17'), null);
  assert.strictEqual(tt.daysBetween(null, null), null);
  // With no current session to compare against, the cautious wording is used.
  assert.ok(tt.fallbackNote('2026-11-16', null).endsWith('the last session with fills'));
});

test('a coloured fallback title still strips back to the plain one', () => {
  const plain = trayTitle(yesterday(), { now: NEW_SESSION });
  assert.strictEqual(tt.stripAnsi(tt.trayTitleColoured(yesterday(), { now: NEW_SESSION })), plain);
});

// ── Two different problems, two different sentences (TVCM-41) ────────────
//
// "TVCM cannot reach TradingView" and "TradingView is not logged in to AMP" need opposite
// actions: the first is already being fixed and Jim need do nothing; the second will never
// fix itself and he has to press Connect. Before TVCM-41 both arrived as
// "Last import failed: <code> — <reason>", which told him neither.

const LOST_AT = at('2026-11-17T01:04:00Z');   // Mon 19:04 CT — the TVCM-40 outage began

test('a lost connection says so, with the time it went, and that it is reconnecting', () => {
  const t = trayTooltip(state({ importedAt: LOST_AT }),
    { now: LOST_AT + 60 * MIN, source: 'feed', cdpState: 'lost', cdpLostAt: LOST_AT });
  assert.ok(t.includes('Lost connection to TradingView at 7:04 PM CT — reconnecting'), t);
  assert.ok(/not being refreshed/i.test(t), t);
  assert.ok(!/press Connect/i.test(t), 'there is nothing for Jim to do: ' + t);
});

test('no broker connected tells Jim to press Connect, and does not claim to be reconnecting', () => {
  const s = state({ importedAt: LOST_AT });
  s.errorCode = 'TVCM-LF-NO-BROKER-OBJECT';
  s.errorMessage = 'TradingView could not be read';
  const t = trayTooltip(s, { now: LOST_AT + 10 * MIN, source: 'feed' });
  assert.ok(t.includes('TradingView has no broker connected — press Connect in TradingView'), t);
  assert.ok(!/Lost connection/i.test(t), 'the pipe is fine — saying otherwise sends him to the wrong place: ' + t);
  assert.ok(/not being refreshed/i.test(t), t);
});

test('the two are never shown together, and the pipe outranks the broker', () => {
  // With no connection, what the broker is doing is simply unknown.
  const s = state({ importedAt: LOST_AT });
  s.errorCode = 'TVCM-LF-NO-BROKER-OBJECT';
  const t = trayTooltip(s, { now: LOST_AT + MIN, source: 'feed', cdpState: 'lost', cdpLostAt: LOST_AT });
  assert.ok(/Lost connection to TradingView/.test(t), t);
  assert.ok(!/press Connect/i.test(t), t);
});

test('a healthy connection says nothing about connections at all', () => {
  const t = trayTooltip(state(), { now: FRI_OPEN, source: 'feed', cdpState: 'connected' });
  assert.ok(!/Lost connection/i.test(t), t);
  assert.ok(!/press Connect/i.test(t), t);
  assert.ok(!/not being refreshed/i.test(t), t);
});

test('an outage with no recorded start still reads as a sentence', () => {
  const note = tt.connectionNote({ cdpState: 'lost', cdpLostAt: null });
  assert.strictEqual(note, 'Lost connection to TradingView — reconnecting');
});

test('connectionNote answers for the codes that mean each thing, and no others', () => {
  for (const code of ['TVCM-CDP-LOST', 'TVCM-LF-NOT-CONNECTED']) {
    assert.match(tt.connectionNote({ errorCode: code, cdpLostAt: LOST_AT }), /Lost connection/, code);
  }
  assert.match(tt.connectionNote({ errorCode: 'TVCM-LF-NO-BROKER-OBJECT' }), /press Connect/);
  // Everything else is somebody else's problem and must not be dressed up as a connection.
  for (const code of ['TVCM-OH-BAD-HEADER', 'TVCM-LF-BLIND', 'TVCM-LF-POSITION-MISMATCH',
                      'TVCM-LF-SHAPE', 'TVCM-OI-NOT-LIVE', null, undefined]) {
    assert.strictEqual(tt.connectionNote({ errorCode: code }), null, String(code));
  }
  assert.strictEqual(tt.connectionNote({}), null);
  assert.strictEqual(tt.connectionNote(null), null);
});

test('a connection fault replaces the generic failure pair, never doubles it', () => {
  const s = state({ importedAt: LOST_AT });
  s.errorCode = 'TVCM-LF-NOT-CONNECTED';
  s.errorMessage = 'WebSocket is not open: readyState 3 (CLOSED)';
  const t = trayTooltip(s, { now: LOST_AT + MIN, source: 'feed', cdpState: 'lost', cdpLostAt: LOST_AT });
  assert.ok(!/Last import failed/.test(t), 'the vague line must be gone, not added to: ' + t);
  assert.strictEqual(t.split('\n').filter(l => /not being refreshed/i.test(l)).length, 1);
});

test('a fault that is not about the connection keeps its own wording', () => {
  // TVCM-33/35: a position mismatch is about numbers read this second, and must not be
  // described as a connection problem or as a stale number.
  const s = state();
  s.errorCode = 'TVCM-LF-POSITION-MISMATCH';
  s.errorMessage = 'TradingView’s records and its live position disagree';
  const t = trayTooltip(s, { now: FRI_OPEN, source: 'feed', cdpState: 'connected' });
  assert.ok(t.includes('TVCM-LF-POSITION-MISMATCH'), t);
  assert.ok(!/not being refreshed/i.test(t), t);
  assert.ok(!/Lost connection/i.test(t), t);
});

test('the clock reads in Chicago time, which is the only clock TVCM uses', () => {
  assert.strictEqual(tt.clockAt(at('2026-11-17T01:04:00Z')), '7:04 PM CT');
  assert.strictEqual(tt.clockAt(at('2026-11-17T15:30:00Z')), '9:30 AM CT');
  assert.strictEqual(tt.clockAt(null), null);
});
