'use strict';

// Where the displayed number comes from when there are two sources: the live feed
// (current session) and the CSV import (past days, and the current session too if Jim
// happened to export mid-session).
//
// The rule that matters: when both have the current session and they disagree, the CSV
// wins, because that is the path reconciled against AMP's statement (TVCM-13). The feed
// is faster, not more authoritative.

const test   = require('node:test');
const assert = require('node:assert');
const path   = require('path');

const { mergePnl, feedUsable, DISAGREE_TOLERANCE } =
  require(path.join(__dirname, '../../src/shared/pnl-merge.js'));

const CT_OPEN = Date.parse('2026-11-13T20:00:00Z'); // Fri 14:00 CT — trading
const SAT     = Date.parse('2026-11-14T16:00:00Z'); // Sat 10:00 CT — shut
const MIN = 60_000;

/** A session summary in the shape both sources produce. */
function session(date, net, over = {}) {
  return {
    sessionDate: date, fillCount: 10, buys: 5, sells: 5, avgBuy: 7000, avgSell: 7010,
    grossPnl: net + 6, contractSides: 10, roundTrips: 5, fees: 6, netPnl: net,
    openPositionAtStart: 0, openPositionAtEnd: 0, ...over,
  };
}

/** A healthy live-feed state holding the current session. */
function feed(over = {}) {
  return {
    mode: 'live', brokerId: 'amp', available: true, state: 'ok',
    session: session('2026-11-13', 100), currentSession: '2026-11-13',
    executionCount: 10, readAt: CT_OPEN, lastAttemptAt: CT_OPEN,
    errorCode: null, errorMessage: null, reason: null, warn: false, ...over,
  };
}

/** A CSV import state holding the same or an earlier session. */
function csv(over = {}) {
  return {
    session: session('2026-11-13', 100), isFallback: false, currentSession: '2026-11-13',
    importedAt: CT_OPEN - 10 * MIN, fileName: 'amp-order-history-all.csv',
    errorCode: null, errorMessage: null, lastAttemptAt: CT_OPEN - 10 * MIN, ...over,
  };
}

// ── Which source wins ─────────────────────────────────────────────────────

test('they agree: the feed drives the current session and says so', () => {
  const m = mergePnl({ feed: feed(), csv: csv(), now: CT_OPEN });
  assert.strictEqual(m.source, 'feed');
  assert.strictEqual(m.session.netPnl, 100);
  assert.strictEqual(m.disagreement, null);
  assert.strictEqual(m.asOf, CT_OPEN, 'as of = the feed\'s last successful read');
  assert.strictEqual(m.warn, false);
});

test('they disagree: the CSV wins and the disagreement is reported, not hidden', () => {
  const m = mergePnl({ feed: feed({ session: session('2026-11-13', 250) }), csv: csv(), now: CT_OPEN });
  assert.strictEqual(m.source, 'csv', 'the statement-proven path must win');
  assert.strictEqual(m.session.netPnl, 100);
  assert.ok(m.disagreement, 'a silent disagreement is the one thing that must not happen');
  assert.strictEqual(m.disagreement.feedNet, 250);
  assert.strictEqual(m.disagreement.csvNet, 100);
  assert.strictEqual(m.disagreement.code, 'TVCM-PNL-DISAGREE');
  assert.strictEqual(m.errorCode, 'TVCM-PNL-DISAGREE');
  assert.strictEqual(m.warn, true);
});

test('a rounding-sized difference is not a disagreement', () => {
  const m = mergePnl({ feed: feed({ session: session('2026-11-13', 100.004) }), csv: csv(), now: CT_OPEN });
  assert.strictEqual(m.disagreement, null);
  assert.strictEqual(m.source, 'feed');
  assert.ok(DISAGREE_TOLERANCE > 0 && DISAGREE_TOLERANCE < 0.01, `tolerance=${DISAGREE_TOLERANCE}`);
});

test('a difference just past the tolerance IS a disagreement', () => {
  const m = mergePnl({ feed: feed({ session: session('2026-11-13', 100.02) }), csv: csv(), now: CT_OPEN });
  assert.ok(m.disagreement);
  assert.strictEqual(m.session.netPnl, 100);
});

test('feed down: the CSV carries it alone', () => {
  const m = mergePnl({ feed: feed({ available: false, session: null, state: 'replay', reason: 'not available in replay' }),
                       csv: csv(), now: CT_OPEN });
  assert.strictEqual(m.source, 'csv');
  assert.strictEqual(m.session.netPnl, 100);
  assert.strictEqual(m.asOf, CT_OPEN - 10 * MIN, 'as of = the CSV import time');
  assert.strictEqual(m.disagreement, null);
});

test('no CSV at all: the feed carries it alone', () => {
  const m = mergePnl({ feed: feed(), csv: { session: null, isFallback: false, currentSession: null,
                                            importedAt: null, errorCode: null, errorMessage: null }, now: CT_OPEN });
  assert.strictEqual(m.source, 'feed');
  assert.strictEqual(m.session.netPnl, 100);
});

test('neither has anything: no number is invented', () => {
  const m = mergePnl({
    feed: feed({ available: false, session: null }),
    csv:  { session: null, isFallback: false, currentSession: '2026-11-13', importedAt: null, errorCode: null, errorMessage: null },
    now: CT_OPEN });
  assert.strictEqual(m.source, 'none');
  assert.strictEqual(m.session, null);
  assert.strictEqual(m.asOf, null);
});

// ── The feed only ever owns the CURRENT session ───────────────────────────

test('a feed session that is not the current one is never shown as today', () => {
  const m = mergePnl({
    feed: feed({ session: session('2026-11-12', 999), currentSession: '2026-11-13' }),
    csv: csv(), now: CT_OPEN });
  assert.strictEqual(m.source, 'csv', 'the feed had no current-session result');
  assert.strictEqual(m.session.netPnl, 100);
});

test('with the market shut the CSV fallback still shows the last session with fills', () => {
  const m = mergePnl({
    feed: feed({ session: null, currentSession: '2026-11-16' }),
    csv:  csv({ session: session('2026-11-13', 896.65), isFallback: true, currentSession: '2026-11-16' }),
    now: SAT });
  assert.strictEqual(m.source, 'csv');
  assert.strictEqual(m.isFallback, true);
  assert.strictEqual(m.session.netPnl, 896.65);
});

test('a CSV fallback is never compared against the feed as if it were today', () => {
  const m = mergePnl({
    feed: feed({ session: session('2026-11-13', 100) }),
    csv:  csv({ session: session('2026-11-12', 7777), isFallback: true }),
    now: CT_OPEN });
  assert.strictEqual(m.disagreement, null, 'different sessions are not a disagreement');
  assert.strictEqual(m.source, 'feed');
  assert.strictEqual(m.session.netPnl, 100);
});

// ── Staleness now applies to the feed ─────────────────────────────────────

test('a feed that stopped reading goes stale during market hours and hands over to the CSV', () => {
  const stale = feed({ readAt: CT_OPEN - 31 * MIN });
  assert.strictEqual(feedUsable(stale, CT_OPEN, 30), false);
  const m = mergePnl({ feed: stale, csv: csv(), now: CT_OPEN, staleMinutes: 30 });
  assert.strictEqual(m.source, 'csv');
  assert.strictEqual(m.feedStale, true);
});

test('the same gap outside market hours is not stale — nothing was happening', () => {
  const quiet = feed({ readAt: SAT - 10 * 60 * MIN, currentSession: '2026-11-16', session: session('2026-11-16', 5) });
  assert.strictEqual(feedUsable(quiet, SAT, 30), true);
});

test('the staleness threshold is the setting, not a constant', () => {
  const f = feed({ readAt: CT_OPEN - 10 * MIN });
  assert.strictEqual(feedUsable(f, CT_OPEN, 5), false);
  assert.strictEqual(feedUsable(f, CT_OPEN, 60), true);
});

test('a feed that has never read is not usable', () => {
  assert.strictEqual(feedUsable(feed({ readAt: null, session: null }), CT_OPEN, 30), false);
  assert.strictEqual(feedUsable(null, CT_OPEN, 30), false);
  assert.strictEqual(feedUsable(undefined, CT_OPEN, 30), false);
});

test('a read error does not drop the feed instantly — it goes stale like anything else', () => {
  const blip = feed({ errorCode: 'TVCM-LF-READ-FAILED', lastAttemptAt: CT_OPEN, readAt: CT_OPEN - 2 * MIN });
  assert.strictEqual(feedUsable(blip, CT_OPEN, 30), true, 'one failed poll must not flip the source');
  const m = mergePnl({ feed: blip, csv: csv(), now: CT_OPEN });
  assert.strictEqual(m.source, 'feed');
  assert.strictEqual(m.errorCode, 'TVCM-LF-READ-FAILED', 'but the failure is still reported');
});

// ── The account gate reaches the merged state ─────────────────────────────

test('an account mismatch warns and keeps the feed out of the number entirely', () => {
  const m = mergePnl({
    feed: feed({ available: false, session: null, state: 'mismatch', warn: true,
                 errorCode: 'TVCM-LF-ACCOUNT-MISMATCH',
                 reason: 'TradingView is on Paper Trading but Paper mode is off',
                 switchHint: 'Turn Paper mode on, or switch TradingView to AMP Live.' }),
    csv: csv(), now: CT_OPEN });
  assert.strictEqual(m.source, 'csv');
  assert.strictEqual(m.warn, true);
  assert.strictEqual(m.errorCode, 'TVCM-LF-ACCOUNT-MISMATCH');
  assert.match(m.errorMessage, /Paper mode/);
  assert.match(m.switchHint, /Turn Paper mode on/);
});

test('replay warns about nothing — it is a normal state', () => {
  const m = mergePnl({
    feed: feed({ available: false, session: null, state: 'replay', warn: false, errorCode: null,
                 reason: 'not available in replay — TradingView is in Bar Replay' }),
    csv: csv(), now: CT_OPEN });
  assert.strictEqual(m.warn, false);
  assert.strictEqual(m.errorCode, null);
  assert.strictEqual(m.source, 'csv');
  assert.match(m.feedReason, /replay/);
});

test('a CSV import failure is reported even when the feed is carrying the number', () => {
  const m = mergePnl({ feed: feed(), csv: csv({ errorCode: 'TVCM-OH-BAD-HEADER', errorMessage: 'missing column Fill quantity' }),
                       now: CT_OPEN });
  assert.strictEqual(m.source, 'feed');
  assert.strictEqual(m.errorCode, 'TVCM-OH-BAD-HEADER');
  assert.match(m.errorMessage, /Fill quantity/);
});

test('a disagreement outranks a lesser complaint from either source', () => {
  const m = mergePnl({
    feed: feed({ session: session('2026-11-13', 250), errorCode: 'TVCM-LF-READ-FAILED', errorMessage: 'blip' }),
    csv:  csv({ errorCode: 'TVCM-OI-SKIPPED-ROWS', errorMessage: 'some rows' }),
    now: CT_OPEN });
  assert.strictEqual(m.errorCode, 'TVCM-PNL-DISAGREE');
});

// ── Paper and live are never mixed ────────────────────────────────────────

test('a paper feed result can never be merged into a live view', () => {
  const m = mergePnl({ feed: feed({ mode: 'paper' }), csv: csv(), now: CT_OPEN, mode: 'live' });
  assert.strictEqual(m.source, 'csv', 'a paper reading must not reach a live display');
  assert.strictEqual(m.errorCode, 'TVCM-LF-MODE-MISMATCH');
  assert.strictEqual(m.warn, true);
});

test('in paper mode the live CSV never supplies the number', () => {
  const m = mergePnl({ feed: feed({ mode: 'paper', brokerId: 'paper' }), csv: csv(), now: CT_OPEN, mode: 'paper' });
  assert.strictEqual(m.source, 'feed');
  assert.strictEqual(m.session.netPnl, 100);
  assert.strictEqual(m.pastSessionsSource, null, 'the AMP CSV holds live money and has no place in paper mode');
});

test('in paper mode with no feed result there is no number at all, not the live one', () => {
  const m = mergePnl({ feed: feed({ mode: 'paper', available: false, session: null }), csv: csv(), now: CT_OPEN, mode: 'paper' });
  assert.strictEqual(m.source, 'none');
  assert.strictEqual(m.session, null, 'showing the live CSV while in paper mode would be the worst possible bug');
});

// ── Back into the shape the three renderers already read ──────────────────

const { mergedToImportState } = require(path.join(__dirname, '../../src/shared/pnl-merge.js'));

test('a feed-sourced view reports the feed as its source and its read time as "as of"', () => {
  const f = feed();
  const m = mergePnl({ feed: f, csv: csv(), now: CT_OPEN });
  const st = mergedToImportState(m, csv(), f);
  assert.strictEqual(st.session.netPnl, 100);
  assert.strictEqual(st.importedAt, CT_OPEN, '"as of" must be the feed read, not the CSV import');
  assert.match(st.fileName, /live feed/);
  assert.strictEqual(st.errorCode, null);
});

test('a CSV-sourced view keeps the file name, so the window still says which export', () => {
  const m = mergePnl({ feed: feed({ available: false, session: null }), csv: csv(), now: CT_OPEN });
  const st = mergedToImportState(m, csv(), feed({ available: false, session: null }));
  assert.strictEqual(st.fileName, 'amp-order-history-all.csv');
  assert.strictEqual(st.importedAt, CT_OPEN - 10 * MIN);
});

test('a disagreement reaches the tray through the flattened shape', () => {
  const f = feed({ session: session('2026-11-13', 250) });
  const m = mergePnl({ feed: f, csv: csv(), now: CT_OPEN });
  const st = mergedToImportState(m, csv(), f);
  assert.strictEqual(st.errorCode, 'TVCM-PNL-DISAGREE');
  assert.strictEqual(st.session.netPnl, 100, 'the CSV number must be the one shown');
});

test('nothing anywhere flattens to an empty state, not a zero', () => {
  const empty = { session: null, isFallback: false, currentSession: null, importedAt: null,
                  errorCode: null, errorMessage: null };
  const m = mergePnl({ feed: feed({ available: false, session: null }), csv: empty, now: CT_OPEN });
  const st = mergedToImportState(m, empty, feed({ available: false, session: null }));
  assert.strictEqual(st.session, null);
  assert.strictEqual(st.importedAt, null);
});

// ── The feed needs the same "market shut" fallback the CSV has ────────────
// On a Saturday a trader wants Friday's result, not a dash. The CSV path has
// always done this; without it, paper mode — which has no CSV to fall back on —
// shows a dash all weekend even though the account has a history.

test('with the market shut the feed falls back to its newest session', () => {
  const m = mergePnl({
    mode: 'paper',
    feed: feed({ mode: 'paper', brokerId: 'paper', session: null, currentSession: '2026-11-16',
                 fallbackSession: session('2026-11-11', 275), readAt: SAT }),
    csv: csv(), now: SAT });
  assert.strictEqual(m.source, 'feed');
  assert.strictEqual(m.session.netPnl, 275);
  assert.strictEqual(m.isFallback, true, 'an earlier session must be flagged as a fallback');
});

test('while the market is OPEN an empty current session stays empty', () => {
  const m = mergePnl({
    mode: 'paper',
    feed: feed({ mode: 'paper', brokerId: 'paper', session: null, currentSession: '2026-11-13',
                 fallbackSession: session('2026-11-11', 275), readAt: CT_OPEN }),
    csv: csv(), now: CT_OPEN });
  assert.strictEqual(m.source, 'none',
    'showing an earlier session mid-session would be read as today');
  assert.strictEqual(m.session, null);
});

test('a real current session always outranks the fallback', () => {
  const m = mergePnl({
    mode: 'paper',
    feed: feed({ mode: 'paper', brokerId: 'paper', session: session('2026-11-16', 10),
                 currentSession: '2026-11-16', fallbackSession: session('2026-11-11', 275), readAt: SAT }),
    csv: csv(), now: SAT });
  assert.strictEqual(m.session.netPnl, 10);
  assert.strictEqual(m.isFallback, false);
});

test('the feed fallback never overrides the CSV in live mode', () => {
  const m = mergePnl({
    mode: 'live',
    feed: feed({ session: null, currentSession: '2026-11-16', fallbackSession: session('2026-11-11', 275), readAt: SAT }),
    csv:  csv({ session: session('2026-11-13', 896.65), isFallback: true, currentSession: '2026-11-16' }),
    now: SAT });
  assert.strictEqual(m.source, 'csv', 'the export is the record for anything but today');
  assert.strictEqual(m.session.netPnl, 896.65);
});

test('in paper mode the live export file name never reaches the display', () => {
  const m = mergePnl({ mode: 'paper', feed: feed({ mode: 'paper', available: false, session: null }), csv: csv(), now: CT_OPEN });
  const st = mergedToImportState(m, csv(), feed({ mode: 'paper' }));
  assert.strictEqual(st.fileName, null, 'naming the AMP export in a paper view is a leak');
  assert.strictEqual(st.session, null);
});
