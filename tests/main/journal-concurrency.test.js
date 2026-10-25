'use strict';

// The journal server and the Electron app hold trades.db at the same time.
// These tests pin the property that makes that safe: a write by one process
// must not be erased by the other closing its handle.
//
// The helpers below mirror scripts/start-journal.js:
//   openDb()/saveAndClose()  — the node:sqlite versions now in use
//   exportWholeFile()        — the sql.js pattern they replaced, kept here ONLY
//                              so the test can prove it detects the old defect.

const test   = require('node:test');
const assert = require('node:assert');
const os     = require('os');
const path   = require('path');
const fs     = require('fs');
const Module = require('module');

const { DatabaseSync } = require('node:sqlite');
const DIST_DIR = path.join(__dirname, '../../dist/main/main');

class BetterSqliteShim { constructor(file) { return new DatabaseSync(file); } }
const originalLoad = Module._load;
Module._load = function (request) {
  if (request === 'electron') {
    return { app: { getPath: () => os.tmpdir(), getVersion: () => '0.0.0' },
             Notification: class { show() {} static isSupported() { return false; } },
             ipcMain: { handle: () => {}, on: () => {} }, shell: { beep: () => {} } };
  }
  if (request === 'better-sqlite3') return BetterSqliteShim;
  return originalLoad.apply(this, arguments);
};

const { TradeStore }          = require(path.join(DIST_DIR, 'trade-store'));
const { RecommendationStore } = require(path.join(DIST_DIR, 'recommendation-store'));

/** Fresh temp database with the app's own schema, plus one trade to edit. */
function freshDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tvcm7-'));
  const trades = new TradeStore(dir);
  new RecommendationStore(trades.database);
  trades.recordEntry({
    symbol: 'CME_MINI:MES1!', timeframe: '1', direction: 'long',
    entry_price: 100, stop_price: 96.75, target_price: 103.25, trailing_stop: false,
    rr_planned: 1, verdict: 'valid_long', headline: 'h', objective: null, steps_json: null,
    structure: null, rationale: null, patterns_json: null, confidence: 0.7, account_type: 'paper',
  });
  trades.close();
  return path.join(dir, 'trades.db');
}

/** What the journal server does now — scripts/start-journal.js openDb(). */
function openDb(dbPath) {
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA busy_timeout = 5000');
  return db;
}

/** The app saving one recommendation at bar close. Returns its id. */
function appSavesRecommendation(dbPath, barTime) {
  const db = new DatabaseSync(dbPath);
  const id = new RecommendationStore(db).save({
    created_at: Date.now(), symbol: 'CME_MINI:MES1!', timeframe: '1',
    bar_time: barTime, bar_price: 100, verdict: 'valid_long', direction: 'long',
    confidence: 0.8, entry: 100, stop: 96.75, target: 103.25, rr_planned: 1,
    setups_json: '["hammer"]', setup_key: 'hammer', structure: null, replay_mode: 0,
    account_type: 'paper', app_version: 'test', model_id: 'test', raw_json: '{}',
    blocked: 0, blocked_reason: null, rules_version: 'testver1',
  });
  db.close();
  return id;
}

/** Count rows with an independent read-only handle. */
function counts(dbPath) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  const out = {
    recs:   db.prepare('SELECT COUNT(*) AS n FROM recommendations').get().n,
    trades: db.prepare('SELECT COUNT(*) AS n FROM trades').get().n,
  };
  db.close();
  return out;
}

test('a journal write does not erase rows the app wrote while it was open', () => {
  const dbPath = freshDb();

  const jdb = openDb(dbPath);                       // journal begins a request
  const id  = appSavesRecommendation(dbPath, 1000); // app saves a call meanwhile
  assert.ok(id > 0, 'app wrote its row');
  assert.strictEqual(counts(dbPath).recs, 1);

  jdb.prepare("UPDATE trades SET notes = 'note' WHERE id = 1").run();
  jdb.close();                                      // journal saveAndClose()

  assert.strictEqual(counts(dbPath).recs, 1,
    'the recommendation must survive the journal closing its handle');

  const check = new DatabaseSync(dbPath, { readOnly: true });
  assert.strictEqual(check.prepare('SELECT notes FROM trades WHERE id = 1').get().notes, 'note',
    "the journal's own write must persist too");
  check.close();
});

test('the sql.js whole-file pattern this replaced would have lost the row', () => {
  // Guards the test above: proves it is actually sensitive to the defect rather
  // than passing for every implementation.
  const dbPath = freshDb();

  const snapshot = fs.readFileSync(dbPath);         // sql.js openDb(): whole file in memory
  appSavesRecommendation(dbPath, 2000);
  assert.strictEqual(counts(dbPath).recs, 1, 'row is on disk before the rewrite');

  fs.writeFileSync(dbPath, snapshot);                // sql.js saveAndClose(): whole file back

  assert.strictEqual(counts(dbPath).recs, 0,
    'the old pattern erases it — which is why the journal no longer does this');
});

test('both processes can write concurrently without losing either write', () => {
  const dbPath = freshDb();
  const jdb = openDb(dbPath);

  // Interleave ten app saves with ten journal note updates on one open handle.
  for (let i = 0; i < 10; i++) {
    appSavesRecommendation(dbPath, 3000 + i);
    jdb.prepare('UPDATE trades SET notes = ? WHERE id = 1').run(`note ${i}`);
  }
  jdb.close();

  assert.strictEqual(counts(dbPath).recs, 10, 'every app write survived');
  const check = new DatabaseSync(dbPath, { readOnly: true });
  assert.strictEqual(check.prepare('SELECT notes FROM trades WHERE id = 1').get().notes, 'note 9',
    'the last journal write survived');
  check.close();
});

test('trades and user_version are untouched by journal activity', () => {
  const dbPath = freshDb();
  const before = new DatabaseSync(dbPath, { readOnly: true });
  const version = before.prepare('PRAGMA user_version').get().user_version;
  before.close();

  const jdb = openDb(dbPath);
  appSavesRecommendation(dbPath, 4000);
  jdb.prepare("UPDATE trades SET notes = 'x' WHERE id = 1").run();
  jdb.close();

  const after = new DatabaseSync(dbPath, { readOnly: true });
  assert.strictEqual(after.prepare('PRAGMA user_version').get().user_version, version,
    'user_version must not move — a bump would drop trades on next app start');
  assert.strictEqual(after.prepare('SELECT COUNT(*) AS n FROM trades').get().n, 1);
  after.close();
});
