'use strict';

// The order-history watcher. Everything runs against a throwaway temp folder —
// never ~/Downloads, never the repo — and every fixture is synthetic.
//
// The scan is driven by calling scanOnce() directly rather than by waiting on a
// timer, so these tests assert on behaviour instead of on timing luck.

const test   = require('node:test');
const assert = require('node:assert');
const fs     = require('fs');
const os     = require('os');
const path   = require('path');

const { OrderImportWatcher, isLiveExportFileName, isOrderHistoryFileName,
        resolveWatchFolder, emptyState } =
  require(path.join(__dirname, '../../dist/main/main/order-import'));

// The menu-bar title is asserted directly, because "an ignored file must not change
// the number" is a statement about what Jim sees, not about the watcher's internals.
const { trayTitle } = require(path.join(__dirname, '../../src/shared/tray-title.js'));

const HEADER = 'Symbol,Side,Type,Quantity,Limit price,Stop price,Active at,Fill quantity,' +
               'Avg fill price,Commission,Placing time,Status,Status time,Order ID,Duration';

/** Builds one CSV line in the real export's column order. */
function row({ side, qty = 1, fillQty = qty, price, time, status = 'Filled', id, type = 'Market' }) {
  return ['F.US.MESZ26', side, type, qty, '', '', '', fillQty, price, '', time, status, time, id, 'GTC'].join(',');
}
/** Builds a whole CSV, newest-first like TradingView's real export. */
function csv(rows) { return [HEADER, ...rows.slice().reverse()].join('\n'); }

/** A one-round-trip session on 2026-11-12 worth `points` MES points. */
function sessionCsv(points, idSuffix = '') {
  return csv([
    row({ side: 'Buy',  qty: 1, price: 7000,          time: '2026-11-12 09:00:00', id: 'A' + idSuffix }),
    row({ side: 'Sell', qty: 1, price: 7000 + points, time: '2026-11-12 10:00:00', id: 'B' + idSuffix }),
  ]);
}

/** A temp watch folder, well away from ~/Downloads and the repo. */
function tmpFolder() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'tvcm-oi-'));
}

/** A watcher pinned to a fixed "now" inside the 2026-11-12 session. */
function makeWatcher(folder, extra = {}) {
  return new OrderImportWatcher({
    folder,
    now: () => Date.parse('2026-11-12T15:00:00Z'), // 09:00 CT on 2026-11-12
    ...extra,
  });
}

/** Writes a file and nudges its mtime, so two writes are never indistinguishable. */
function write(folder, name, text, mtimeMs) {
  const p = path.join(folder, name);
  fs.writeFileSync(p, text);
  if (mtimeMs != null) fs.utimesSync(p, new Date(mtimeMs), new Date(mtimeMs));
  return p;
}

/** Scans until the file settles (deferred on first sighting by design). */
async function settle(w, times = 2) {
  let out;
  for (let i = 0; i < times; i++) out = await w.scanOnce();
  return out;
}

// ── Filename matching: live AMP exports only ────────────────────
test('accepts the live AMP export names TradingView actually produces', () => {
  for (const name of [
    'amp-order-history-all-2026-11-14T16_29_00.671Z_8b14b.csv',
    'amp-order-history-all.csv',
    'amp-order-history-.csv',
    'AMP-ORDER-HISTORY-ALL.CSV',
  ]) assert.ok(isLiveExportFileName(name), `should accept ${name}`);
});

test('refuses every order-history export that is not a live AMP one', () => {
  for (const name of [
    'paper-order-history-2026-11-01.csv',
    'replaybroker-order-history-all.csv',
    'order-history.csv',
    'something-order-history-export.csv',
    'ORDER-HISTORY-ALL.CSV',
    'copy-of-amp-order-history-all.csv',   // amp, but not at the start
    'amp-order-history-all.csv.part',      // not finished downloading
    'amp-order-history.csv',               // no trailing dash: not the real shape
    'amp-orders-history-all.csv',
  ]) assert.ok(!isLiveExportFileName(name), `should refuse ${name}`);
});

test('a non-live export is still recognised as an order-history file, so it can be named in a log', () => {
  for (const name of [
    'paper-order-history-2026-11-01.csv',
    'order-history.csv',
    'ORDER-HISTORY-ALL.CSV',
    'amp-order-history-all.csv',
  ]) assert.ok(isOrderHistoryFileName(name), `should recognise ${name}`);
  for (const name of [
    'paper-trading-balance-history-2026-07-02.csv',
    'order-history.csv.part',
    'orders.csv',
    'amp-order-history-all.xlsx',
    'export5500.csv',
    'history.csv',
  ]) assert.ok(!isOrderHistoryFileName(name), `should not recognise ${name}`);
});

test('an unset folder means ~/Downloads, and ~ is expanded', () => {
  assert.strictEqual(resolveWatchFolder(''), path.join(os.homedir(), 'Downloads'));
  assert.strictEqual(resolveWatchFolder(undefined), path.join(os.homedir(), 'Downloads'));
  assert.strictEqual(resolveWatchFolder('  '), path.join(os.homedir(), 'Downloads'));
  assert.strictEqual(resolveWatchFolder('~/exports'), path.join(os.homedir(), 'exports'));
  assert.strictEqual(resolveWatchFolder('/tmp/x'), '/tmp/x');
});

// ── 1. A new file is imported ─────────────────────────────────────────────
test('a new export is imported and its session becomes the state', async () => {
  const folder = tmpFolder();
  const w = makeWatcher(folder);
  assert.deepStrictEqual(await w.scanOnce(), { action: 'none', reason: `no amp-order-history-*.csv in ${folder}` });

  write(folder, 'amp-order-history-all-1.csv', sessionCsv(10));
  const out = await settle(w);
  assert.strictEqual(out.action, 'imported');

  const s = w.getState();
  assert.strictEqual(s.session.sessionDate, '2026-11-12');
  assert.strictEqual(s.session.grossPnl, 50);        // 10 pts x 1 x $5
  assert.strictEqual(s.session.contractSides, 2);
  assert.strictEqual(s.session.roundTrips, 1);
  assert.strictEqual(s.session.fees, 1.20);
  assert.strictEqual(s.session.netPnl, 48.80);
  assert.strictEqual(s.fileName, 'amp-order-history-all-1.csv');
  assert.strictEqual(s.errorCode, null);
  assert.ok(s.importedAt > 0);
  assert.strictEqual(s.isFallback, false);
});

test('an empty folder leaves the state empty rather than inventing zeros', async () => {
  const w = makeWatcher(tmpFolder());
  await w.scanOnce();
  assert.strictEqual(w.getState().session, null);
  assert.strictEqual(w.getState().importedAt, null);
});

// ── 2. A partial write is not read early ──────────────────────────────────
test('a file still being written is deferred, not parsed', async () => {
  const folder = tmpFolder();
  const w = makeWatcher(folder);
  const full = sessionCsv(10);

  // Half the file on disk, as a download in progress would be.
  write(folder, 'amp-order-history-all-1.csv', full.slice(0, Math.floor(full.length / 2)));
  const first = await w.scanOnce();
  assert.strictEqual(first.action, 'deferred', 'a first sighting must never be read immediately');
  assert.strictEqual(w.getState().session, null, 'a partial file was parsed');

  // The writer finishes before the next scan: size moved, so still not stable.
  write(folder, 'amp-order-history-all-1.csv', full, Date.now() + 1000);
  const second = await w.scanOnce();
  assert.strictEqual(second.action, 'deferred', 'a file that changed since the last scan must wait');
  assert.strictEqual(w.getState().session, null);

  // Now it has stopped moving.
  const third = await w.scanOnce();
  assert.strictEqual(third.action, 'imported');
  assert.strictEqual(w.getState().session.grossPnl, 50);
});

test('a truncated export is reported as bad rather than read as a short day', async () => {
  const folder = tmpFolder();
  const w = makeWatcher(folder);
  write(folder, 'amp-order-history-all-1.csv', HEADER.slice(0, 20)); // header cut mid-column
  const out = await settle(w);
  assert.strictEqual(out.action, 'failed');
  assert.strictEqual(out.code, 'TVCM-OH-BAD-HEADER');
  assert.strictEqual(w.getState().session, null);
});

// ── 3. A newer file replaces an older one ─────────────────────────────────
test('the newest export wins, even when an older one is still in the folder', async () => {
  const folder = tmpFolder();
  const w = makeWatcher(folder);
  const t0 = Date.now() - 60_000;

  write(folder, 'amp-order-history-all-old.csv', sessionCsv(10), t0);
  await settle(w);
  assert.strictEqual(w.getState().session.grossPnl, 50);

  // A fresh export of the FULL history, with a different outcome.
  write(folder, 'amp-order-history-all-new.csv', sessionCsv(30), t0 + 30_000);
  const out = await settle(w);
  assert.strictEqual(out.action, 'imported');
  const s = w.getState();
  assert.strictEqual(s.fileName, 'amp-order-history-all-new.csv');
  assert.strictEqual(s.session.grossPnl, 150, 'the older export was still being used');
  assert.strictEqual(s.session.contractSides, 2, 'the two exports were added together');
});

test('an older file appearing later does not displace the newer one', async () => {
  const folder = tmpFolder();
  const w = makeWatcher(folder);
  const t0 = Date.now();

  write(folder, 'amp-order-history-all-new.csv', sessionCsv(30), t0);
  await settle(w);
  assert.strictEqual(w.getState().session.grossPnl, 150);

  write(folder, 'amp-order-history-all-stale.csv', sessionCsv(10), t0 - 120_000);
  await settle(w);
  assert.strictEqual(w.getState().session.grossPnl, 150, 'an older file by mtime took over');
  assert.strictEqual(w.getState().fileName, 'amp-order-history-all-new.csv');
});

// ── 4. A malformed file keeps the previous good result ────────────────────
test('a malformed export records the error and leaves the good numbers alone', async () => {
  const folder = tmpFolder();
  const clock = { t: Date.parse('2026-11-12T15:00:00Z') };
  const w = makeWatcher(folder, { now: () => clock.t });
  const t0 = Date.now() - 60_000;

  write(folder, 'amp-order-history-all-good.csv', sessionCsv(10), t0);
  await settle(w);
  const good = w.getState();
  assert.strictEqual(good.session.grossPnl, 50);

  clock.t += 60_000; // the failed attempt happens a minute later
  write(folder, 'amp-order-history-all-bad.csv', 'Symbol,Side,Quantity\nF.US.MESZ26,Buy,5', t0 + 30_000);
  const out = await settle(w);
  assert.strictEqual(out.action, 'failed');

  const after = w.getState();
  assert.strictEqual(after.session.grossPnl, 50, 'the bad file wiped out the good result');
  assert.strictEqual(after.fileName, 'amp-order-history-all-good.csv');
  assert.strictEqual(after.errorCode, 'TVCM-OH-BAD-HEADER');
  assert.ok(after.errorMessage.includes('Fill quantity'));
  assert.strictEqual(after.importedAt, good.importedAt, 'a failed attempt must not move importedAt');
  assert.ok(after.lastAttemptAt > good.importedAt, 'a failed attempt should still record an attempt time');
});

test('an export with no fills is an error, not a silent $0 day', async () => {
  const folder = tmpFolder();
  const w = makeWatcher(folder);
  write(folder, 'amp-order-history-all-1.csv', HEADER);
  const out = await settle(w);
  assert.strictEqual(out.action, 'failed');
  assert.strictEqual(out.code, 'TVCM-OH-NO-ROWS');
  assert.strictEqual(w.getState().session, null);
});

// ── 5. The same file re-saved does not double-count ───────────────────────
test('re-scanning an untouched file does not re-import it', async () => {
  const folder = tmpFolder();
  const w = makeWatcher(folder);
  write(folder, 'amp-order-history-all-1.csv', sessionCsv(10));
  assert.strictEqual((await settle(w)).action, 'imported');

  for (let i = 0; i < 5; i++) {
    assert.strictEqual((await w.scanOnce()).action, 'unchanged');
  }
  const s = w.getState();
  assert.strictEqual(s.session.contractSides, 2);
  assert.strictEqual(s.session.grossPnl, 50);
});

test('re-saving identical content re-imports but produces identical numbers', async () => {
  const folder = tmpFolder();
  const w = makeWatcher(folder);
  const text = sessionCsv(10);

  write(folder, 'amp-order-history-all-1.csv', text, Date.now() - 10_000);
  await settle(w);
  const first = w.getState().session;

  write(folder, 'amp-order-history-all-1.csv', text, Date.now());
  const out = await settle(w);
  assert.strictEqual(out.action, 'imported', 'a touched file should be re-read');

  const second = w.getState().session;
  assert.strictEqual(second.contractSides, first.contractSides, 'contracts doubled on re-import');
  assert.strictEqual(second.buys, first.buys);
  assert.strictEqual(second.sells, first.sells);
  assert.strictEqual(second.grossPnl, first.grossPnl);
  assert.strictEqual(second.fees, first.fees);
});

test('only the newest export is read, so two exports never add up', async () => {
  const folder = tmpFolder();
  const w = makeWatcher(folder);
  const t0 = Date.now() - 60_000;

  // Deliberately DIFFERENT Order IDs, so the engine's own dedupe cannot mask a
  // watcher that reads both files. Each export is the full history: the newer one
  // simply has one more round trip in it.
  const older = csv([
    row({ side: 'Buy',  qty: 1, price: 7000, time: '2026-11-12 09:00:00', id: 'A' }),
    row({ side: 'Sell', qty: 1, price: 7010, time: '2026-11-12 10:00:00', id: 'B' }),
  ]);
  const newer = csv([
    row({ side: 'Buy',  qty: 1, price: 7000, time: '2026-11-12 09:00:00', id: 'C' }),
    row({ side: 'Sell', qty: 1, price: 7010, time: '2026-11-12 10:00:00', id: 'D' }),
    row({ side: 'Buy',  qty: 1, price: 7020, time: '2026-11-12 11:00:00', id: 'E' }),
    row({ side: 'Sell', qty: 1, price: 7030, time: '2026-11-12 12:00:00', id: 'F' }),
  ]);

  write(folder, 'amp-order-history-all-1.csv', older, t0);
  write(folder, 'amp-order-history-all-2.csv', newer, t0 + 30_000);
  await settle(w);

  const s = w.getState();
  assert.strictEqual(s.fileName, 'amp-order-history-all-2.csv');
  assert.strictEqual(s.session.contractSides, 4, 'both exports were read and added together');
  assert.strictEqual(s.session.grossPnl, 100); // two 10-point round trips
});

// ── Session choice and persistence ────────────────────────────────────────
test('with the market shut and no fills today, the newest session is shown as a fallback', async () => {
  const folder = tmpFolder();
  // Saturday 2026-11-14 10:00 CT — market closed, current session has no fills.
  const w = makeWatcher(folder, { now: () => Date.parse('2026-11-14T16:00:00Z') });
  write(folder, 'amp-order-history-all-1.csv', sessionCsv(10));
  await settle(w);

  const s = w.getState();
  assert.strictEqual(s.currentSession, '2026-11-14');
  assert.strictEqual(s.session.sessionDate, '2026-11-12');
  assert.strictEqual(s.isFallback, true, 'an earlier session must be flagged as a fallback');
});

test('the last good result is cached and restored on the next start', async () => {
  const folder = tmpFolder();
  const statePath = path.join(tmpFolder(), 'order-import.json');

  const first = makeWatcher(folder, { statePath });
  write(folder, 'amp-order-history-all-1.csv', sessionCsv(10));
  await settle(first);
  assert.strictEqual(first.getState().session.grossPnl, 50);

  // A fresh watcher, as after a restart — numbers before any scan runs.
  const second = makeWatcher(folder, { statePath });
  const s = second.getState();
  assert.strictEqual(s.session.grossPnl, 50, 'the cached result was not restored');
  assert.strictEqual(s.fileName, 'amp-order-history-all-1.csv');
});

test('a corrupt cache starts empty instead of throwing', () => {
  const statePath = path.join(tmpFolder(), 'order-import.json');
  fs.writeFileSync(statePath, '{not json');
  let w;
  assert.doesNotThrow(() => { w = makeWatcher(tmpFolder(), { statePath }); });
  assert.strictEqual(w.getState().session, null);
});

test('a missing watch folder is survivable, not fatal', async () => {
  const w = makeWatcher(path.join(os.tmpdir(), 'tvcm-oi-does-not-exist-' + Date.now()));
  const out = await w.scanOnce();
  assert.strictEqual(out.action, 'none');
  assert.strictEqual(w.getState().session, null);
});

test('emptyState carries the folder and no numbers', () => {
  const s = emptyState('/tmp/x');
  assert.strictEqual(s.watchFolder, '/tmp/x');
  assert.strictEqual(s.session, null);
  assert.strictEqual(s.importedAt, null);
  assert.strictEqual(s.errorCode, null);
});

// ── What the Order History window reads over IPC ──────────────────────────
test('listSessions returns every session newest first, with its trade count', async () => {
  const folder = tmpFolder();
  const w = makeWatcher(folder);
  write(folder, 'amp-order-history-all-1.csv', csv([
    row({ side: 'Buy',  qty: 1, price: 7000, time: '2026-11-11 09:00:00', id: 'A' }),
    row({ side: 'Sell', qty: 1, price: 7010, time: '2026-11-11 10:00:00', id: 'B' }),
    row({ side: 'Sell', qty: 2, price: 7020, time: '2026-11-12 09:00:00', id: 'C' }),
    row({ side: 'Buy',  qty: 2, price: 7000, time: '2026-11-12 10:00:00', id: 'D' }),
  ]));
  await settle(w);

  const list = w.listSessions();
  assert.deepStrictEqual(list.map(s => s.sessionDate), ['2026-11-12', '2026-11-11'], 'newest first');
  assert.strictEqual(list[0].tradeCount, 1);
  assert.strictEqual(list[0].netPnl, 197.60);   // 200 gross - 2.40 fees
  assert.strictEqual(list[1].netPnl, 48.80);    //  50 gross - 1.20 fees
  assert.strictEqual(list[0].contractSides, 4);
});

test('getSessionDetail returns that session only — headline, trades and fills', async () => {
  const folder = tmpFolder();
  const w = makeWatcher(folder);
  write(folder, 'amp-order-history-all-1.csv', csv([
    row({ side: 'Buy',  qty: 1, price: 7000, time: '2026-11-11 09:00:00', id: 'A' }),
    row({ side: 'Sell', qty: 1, price: 7010, time: '2026-11-11 10:00:00', id: 'B' }),
    row({ side: 'Sell', qty: 2, price: 7020, time: '2026-11-12 09:00:00', id: 'C' }),
    row({ side: 'Buy',  qty: 2, price: 7000, time: '2026-11-12 10:00:00', id: 'D' }),
  ]));
  await settle(w);

  const d = w.getSessionDetail('2026-11-12');
  assert.strictEqual(d.sessionDate, '2026-11-12');
  assert.strictEqual(d.session.netPnl, 197.60);
  assert.strictEqual(d.trades.length, 1);
  assert.strictEqual(d.trades[0].direction, 'short');
  assert.strictEqual(d.fills.length, 2, 'only this session\'s fills');
  assert.ok(d.fills.every(f => f.sessionDate === '2026-11-12'));
  assert.strictEqual(d.boundary.boundaryNet, 0);
});

test('a session that nothing traded in returns empty rather than null fields', async () => {
  const folder = tmpFolder();
  const w = makeWatcher(folder);
  write(folder, 'amp-order-history-all-1.csv', sessionCsv(10));
  await settle(w);
  const d = w.getSessionDetail('2026-01-01');
  assert.strictEqual(d.session, null);
  assert.deepStrictEqual(d.trades, []);
  assert.deepStrictEqual(d.fills, []);
  assert.strictEqual(d.boundary, null);
});

test('a boundary-crossing trade is surfaced to the window on both sessions', async () => {
  const folder = tmpFolder();
  const w = makeWatcher(folder, { now: () => Date.parse('2026-11-11T15:00:00Z') });
  write(folder, 'amp-order-history-all-1.csv', csv([
    row({ side: 'Buy',  qty: 4, price: 7000, time: '2026-11-10 15:00:00', id: 'A' }),
    row({ side: 'Sell', qty: 1, price: 7020, time: '2026-11-10 16:00:00', id: 'B' }),
    row({ side: 'Sell', qty: 3, price: 7010, time: '2026-11-10 18:00:00', id: 'C' }),
  ]));
  await settle(w);

  const d10 = w.getSessionDetail('2026-11-10');
  const d11 = w.getSessionDetail('2026-11-11');
  assert.strictEqual(d10.trades.length, 0, 'the trade closed on the 11th');
  assert.ok(d10.boundary.inboundTradeIds.length === 1, 'the 10th must declare the inbound trade');
  assert.strictEqual(d11.trades.length, 1);
  assert.deepStrictEqual(d11.boundary.outboundTradeIds, d10.boundary.inboundTradeIds);
  assert.notStrictEqual(d11.boundary.boundaryNet, 0, 'the carried amount must be non-zero');
});

test('an open trade is listed under the session it opened in', async () => {
  const folder = tmpFolder();
  const w = makeWatcher(folder);
  write(folder, 'amp-order-history-all-1.csv', csv([
    row({ side: 'Buy', qty: 3, price: 7000, time: '2026-11-12 09:00:00', id: 'A' }),
    row({ side: 'Sell', qty: 1, price: 7020, time: '2026-11-12 10:00:00', id: 'B' }),
  ]));
  await settle(w);
  const d = w.getSessionDetail('2026-11-12');
  assert.strictEqual(d.trades.length, 1);
  assert.strictEqual(d.trades[0].status, 'OPEN');
  assert.strictEqual(d.trades[0].net, null, 'an open trade must not carry a guessed net');
});

test('trades and fills survive a restart through the cache', async () => {
  const folder = tmpFolder();
  const statePath = path.join(tmpFolder(), 'order-import.json');
  const first = makeWatcher(folder, { statePath });
  write(folder, 'amp-order-history-all-1.csv', sessionCsv(10));
  await settle(first);
  assert.strictEqual(first.getSessionDetail('2026-11-12').trades.length, 1);

  const second = makeWatcher(folder, { statePath });
  const d = second.getSessionDetail('2026-11-12');
  assert.strictEqual(d.trades.length, 1, 'trades were not cached');
  assert.strictEqual(d.fills.length, 2, 'fills were not cached');
  assert.strictEqual(second.listSessions().length, 1);
});

// ── Live-only imports (TVCM-24) ──────────────────────────────────
// A paper or replay export in the watch folder used to be imported and shown in the
// menu bar as real money. These assert it cannot happen, including when the paper file
// is the newest thing in the folder.

test('a newer paper export is ignored and cannot displace the live numbers', async () => {
  const folder = tmpFolder();
  const logs = [];
  const w = makeWatcher(folder, { log: (l) => logs.push(l) });
  const t0 = Date.now() - 60_000;

  write(folder, 'amp-order-history-all-live.csv', sessionCsv(10), t0);
  assert.strictEqual((await settle(w)).action, 'imported');
  const before = w.getState();
  const titleBefore = trayTitle(before, { now: before.importedAt });
  assert.strictEqual(titleBefore, '+$48.80');

  // A paper export lands LATER, with a wildly different outcome.
  write(folder, 'paper-order-history-2026-11-12.csv', sessionCsv(400), t0 + 30_000);
  const out = await settle(w, 3);
  assert.strictEqual(out.action, 'unchanged', 'the paper file was treated as a candidate');
  assert.strictEqual(out.filePath, path.join(folder, 'amp-order-history-all-live.csv'));

  const after = w.getState();
  assert.strictEqual(after.fileName, 'amp-order-history-all-live.csv');
  assert.strictEqual(after.session.netPnl, 48.80, 'paper P&L replaced the live numbers');
  assert.strictEqual(trayTitle(after, { now: after.importedAt }), titleBefore,
    'the menu-bar number moved because of a paper export');
  assert.strictEqual(after.errorCode, null, 'an ignored file is not an import failure');
  assert.strictEqual(after.importedAt, before.importedAt);
  assert.ok(logs.some(l => l.includes('TVCM-OI-NOT-LIVE') && l.includes('paper-order-history-2026-11-12.csv')),
    'nothing told Jim the paper file had been refused: ' + JSON.stringify(logs));
});

test('a newer live export IS imported, over an older live one', async () => {
  const folder = tmpFolder();
  const w = makeWatcher(folder);
  const t0 = Date.now() - 60_000;

  write(folder, 'amp-order-history-all-1.csv', sessionCsv(10), t0);
  await settle(w);
  assert.strictEqual(w.getState().session.netPnl, 48.80);

  write(folder, 'amp-order-history-all-2.csv', sessionCsv(30), t0 + 30_000);
  assert.strictEqual((await settle(w)).action, 'imported');
  const s = w.getState();
  assert.strictEqual(s.fileName, 'amp-order-history-all-2.csv');
  assert.strictEqual(s.session.grossPnl, 150);
  assert.strictEqual(trayTitle(s, { now: s.importedAt }), '+$148.80');
});

test('a folder holding only non-live exports imports nothing at all', async () => {
  const folder = tmpFolder();
  const logs = [];
  const w = makeWatcher(folder, { log: (l) => logs.push(l) });

  write(folder, 'paper-order-history-2026-11-12.csv', sessionCsv(400));
  write(folder, 'order-history.csv',                  sessionCsv(400));
  const out = await settle(w, 3);
  assert.strictEqual(out.action, 'none');
  assert.ok(out.reason.includes('2'), 'the reason should count what was refused: ' + out.reason);

  const s = w.getState();
  assert.strictEqual(s.session, null);
  assert.strictEqual(s.importedAt, null);
  assert.strictEqual(trayTitle(s, { now: Date.now() }), 'P&L \u2014');
});

test('a refused file is logged once, not on every poll', async () => {
  const folder = tmpFolder();
  const logs = [];
  const w = makeWatcher(folder, { log: (l) => logs.push(l) });

  const refusals = (name) => logs.filter(l => l.includes('TVCM-OI-NOT-LIVE') && l.includes(name));

  write(folder, 'paper-order-history-2026-11-12.csv', sessionCsv(400));
  for (let i = 0; i < 6; i++) await w.scanOnce();
  assert.strictEqual(refusals('paper-order-history-2026-11-12.csv').length, 1,
    'the refusal was logged on every poll: ' + JSON.stringify(logs));

  // A different refused file gets its own line.
  write(folder, 'replay-order-history-2026-11-12.csv', sessionCsv(400));
  for (let i = 0; i < 3; i++) await w.scanOnce();
  assert.strictEqual(refusals('replay-order-history-2026-11-12.csv').length, 1);
  assert.strictEqual(refusals('paper-order-history-2026-11-12.csv').length, 1);
});

test('changing folder forgets which refusals were already logged', async () => {
  const a = tmpFolder();
  const b = tmpFolder();
  const logs = [];
  const w = makeWatcher(a, { log: (l) => logs.push(l) });
  const refusals = () => logs.filter(l => l.includes('TVCM-OI-NOT-LIVE'));
  write(a, 'paper-order-history-x.csv', sessionCsv(400));
  await w.scanOnce();
  assert.strictEqual(refusals().length, 1);

  w.setFolder(b);
  write(b, 'paper-order-history-x.csv', sessionCsv(400));
  await w.scanOnce();
  assert.strictEqual(refusals().length, 2, 'the same name in a new folder is a new file');
});
