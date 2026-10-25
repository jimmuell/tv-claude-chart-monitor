'use strict';

const test   = require('node:test');
const assert = require('node:assert');
const os     = require('os');
const path   = require('path');
const fs     = require('fs');
const Module = require('module');

const DIST_DIR = path.join(__dirname, '../../dist/main/main');

// better-sqlite3's prebuilt binary is compiled for Electron's ABI (NODE_MODULE_VERSION
// 123), so it cannot load under plain Node 24 (137) — see TVCM-1-HEALTH. Node's own
// node:sqlite exposes the same synchronous surface the stores use (exec / prepare /
// run / get / all, named @params, PRAGMA), so we swap it in and exercise the REAL
// compiled TradeStore and RecommendationStore rather than a reimplementation.
const { DatabaseSync } = require('node:sqlite');
class BetterSqliteShim {
  constructor(file) { return new DatabaseSync(file); }
}

// Install stubs BEFORE requiring any compiled module.
const electronStub = {
  app: { getPath: () => os.tmpdir(), getVersion: () => '1.0.0', isPackaged: false },
  Notification: class { constructor() {} show() {} static isSupported() { return false; } },
  ipcMain: { handle: () => {}, on: () => {} },
  shell: { beep: () => {} },
};
const originalLoad = Module._load;
Module._load = function (request) {
  if (request === 'electron') return electronStub;
  if (request === 'better-sqlite3') return BetterSqliteShim;
  return originalLoad.apply(this, arguments);
};

const { TradeStore }          = require(path.join(DIST_DIR, 'trade-store'));
const { RecommendationStore } = require(path.join(DIST_DIR, 'recommendation-store'));

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'tvcm6-'));
}

const SAMPLE_TRADE = {
  symbol: 'CME_MINI:MES1!', timeframe: '1', direction: 'long',
  entry_price: 100, stop_price: 96.75, target_price: 103.25,
  trailing_stop: false, rr_planned: 1, verdict: 'valid_long',
  headline: 'h', objective: null, steps_json: null, structure: null,
  rationale: null, patterns_json: '["hammer"]', confidence: 0.7,
  account_type: 'paper',
};

const rec = (over = {}) => ({
  created_at: 1792600000000, symbol: 'CME_MINI:MES1!', timeframe: '1',
  bar_time: 1792600000, bar_price: 100, verdict: 'valid_long', direction: 'long',
  confidence: 0.7, entry: 100, stop: 96.75, target: 103.25, rr_planned: 1,
  setups_json: '["hammer"]', structure: null, replay_mode: 0,
  account_type: 'paper', app_version: '0.1.0', model_id: 'claude-haiku-4-5',
  raw_json: '{}', ...over,
});

// ── the central safety property ──────────────────────────────────────────────

test('adding the recommendations table leaves trades and its rows untouched', () => {
  const dir = tmpDir();
  const trades = new TradeStore(dir);
  const id1 = trades.recordEntry(SAMPLE_TRADE);
  const id2 = trades.recordEntry({ ...SAMPLE_TRADE, direction: 'short' });
  assert.ok(id1 > 0 && id2 > 0, 'seed trades were written');

  const db = trades.database;
  const before = {
    count:   db.prepare('SELECT COUNT(*) AS n FROM trades').get().n,
    version: db.prepare('PRAGMA user_version').get().user_version,
    ids:     db.prepare('SELECT id FROM trades ORDER BY id').all().map(r => r.id),
  };
  assert.strictEqual(before.count, 2);

  // The change under test.
  new RecommendationStore(db);

  const after = {
    count:   db.prepare('SELECT COUNT(*) AS n FROM trades').get().n,
    version: db.prepare('PRAGMA user_version').get().user_version,
    ids:     db.prepare('SELECT id FROM trades ORDER BY id').all().map(r => r.id),
  };

  assert.strictEqual(after.count, before.count, 'trades rows must survive');
  assert.deepStrictEqual(after.ids, before.ids, 'trade ids must be unchanged');
  assert.strictEqual(after.version, before.version,
    'user_version must NOT move — bumping it would trigger trade-store DROP TABLE');
  assert.ok(
    db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='recommendations'").get(),
    'recommendations table should now exist',
  );
  trades.close();
});

test('re-opening TradeStore after the new table still does not drop trades', () => {
  // The real risk is the SECOND launch: schema init runs again on an existing DB.
  const dir = tmpDir();
  const first = new TradeStore(dir);
  first.recordEntry(SAMPLE_TRADE);
  new RecommendationStore(first.database).save(rec());
  first.close();

  const second = new TradeStore(dir);           // simulates an app restart
  const db = second.database;
  assert.strictEqual(db.prepare('SELECT COUNT(*) AS n FROM trades').get().n, 1,
    'the trade must still be there after a restart');
  assert.strictEqual(db.prepare('SELECT COUNT(*) AS n FROM recommendations').get().n, 1,
    'the saved call must still be there too');
  second.close();
});

// ── dedup ────────────────────────────────────────────────────────────────────

test('dedup: the same bar cannot produce two calls', () => {
  const dir = tmpDir();
  const trades = new TradeStore(dir);
  const store = new RecommendationStore(trades.database);

  const firstId = store.save(rec());
  assert.ok(firstId !== null && firstId > 0, 'first save should insert');

  // A manual refresh on the same bar — index.ts has two analysis entry points.
  const secondId = store.save(rec({ confidence: 0.9, verdict: 'wait' }));
  assert.strictEqual(secondId, null, 'second save on the same bar must be ignored');
  assert.strictEqual(store.count(), 1, 'still exactly one row for that bar');
  trades.close();
});

test('dedup key separates mode, bar, timeframe and symbol', () => {
  const dir = tmpDir();
  const trades = new TradeStore(dir);
  const store = new RecommendationStore(trades.database);

  assert.ok(store.save(rec()) !== null, 'live call');
  assert.ok(store.save(rec({ replay_mode: 1 })) !== null, 'replay is a separate row, never merged');
  assert.ok(store.save(rec({ bar_time: 1792600060 })) !== null, 'next bar');
  assert.ok(store.save(rec({ timeframe: '5' })) !== null, 'other timeframe');
  assert.ok(store.save(rec({ symbol: 'CME_MINI:MNQ1!' })) !== null, 'other symbol');
  assert.strictEqual(store.count(), 5);
  assert.strictEqual(store.count(0), 4, 'four live calls');
  assert.strictEqual(store.count(1), 1, 'one replay call');
  trades.close();
});

test('every verdict is saved, including the ones the app declines', () => {
  const dir = tmpDir();
  const trades = new TradeStore(dir);
  const store = new RecommendationStore(trades.database);

  const verdicts = ['valid_long', 'valid_short', 'no_trade', 'wait', 'valid_long_was'];
  verdicts.forEach((v, i) => {
    assert.ok(store.save(rec({ verdict: v, bar_time: 1792600000 + i * 60 })) !== null, v);
  });
  assert.strictEqual(store.count(), verdicts.length,
    'no_trade and wait must be stored too — they are how filter quality is measured');
  trades.close();
});

// ── grading writes ───────────────────────────────────────────────────────────

test('applyGrade is idempotent and never overwrites a settled outcome', () => {
  const dir = tmpDir();
  const trades = new TradeStore(dir);
  const store = new RecommendationStore(trades.database);
  const id = store.save(rec());

  store.applyGrade(id, { outcome: 'WIN', barsToOutcome: 3, rGross: 1, rNet: 0.92 });
  const first = trades.database.prepare('SELECT * FROM recommendations WHERE id = ?').get(id);
  assert.strictEqual(first.outcome, 'WIN');
  assert.strictEqual(first.bars_to_outcome, 3);

  // Re-running the grader must change nothing.
  store.applyGrade(id, { outcome: 'WIN', barsToOutcome: 3, rGross: 1, rNet: 0.92 });
  // And a later, different verdict must not clobber a settled one.
  store.applyGrade(id, { outcome: 'LOSS', barsToOutcome: 9, rGross: -1, rNet: -1.08 });

  const after = trades.database.prepare('SELECT * FROM recommendations WHERE id = ?').get(id);
  assert.strictEqual(after.outcome, 'WIN', 'settled outcome must be stable');
  assert.strictEqual(after.bars_to_outcome, 3);
  assert.strictEqual(after.graded_at, first.graded_at, 'graded_at must not move either');
  trades.close();
});

test('PENDING leaves the row ungraded so it is picked up again', () => {
  const dir = tmpDir();
  const trades = new TradeStore(dir);
  const store = new RecommendationStore(trades.database);
  const id = store.save(rec());

  store.applyGrade(id, { outcome: 'PENDING', barsToOutcome: null, rGross: null, rNet: null });

  assert.strictEqual(store.getUngraded().length, 1, 'still ungraded');
  const row = trades.database.prepare('SELECT outcome FROM recommendations WHERE id = ?').get(id);
  assert.strictEqual(row.outcome, null);
  trades.close();
});

// ── scorecard ────────────────────────────────────────────────────────────────

test('scorecard counts ambiguous, expired and not-triggered outside the win rate', () => {
  const dir = tmpDir();
  const trades = new TradeStore(dir);
  const store = new RecommendationStore(trades.database);

  const add = (outcome, over = {}, rNet = null) => {
    const id = store.save(rec({ bar_time: 1792600000 + store.count() * 60, ...over }));
    store.applyGrade(id, { outcome, barsToOutcome: 2, rGross: rNet, rNet });
    return id;
  };
  add('WIN',  {}, 0.92);
  add('WIN',  {}, 0.92);
  add('LOSS', {}, -1.08);
  add('AMBIGUOUS');
  add('EXPIRED');
  add('NOT_TRIGGERED');

  const sc = store.getScorecard();
  assert.strictEqual(sc.wins, 2);
  assert.strictEqual(sc.losses, 1);
  assert.strictEqual(sc.graded, 3, 'only wins + losses are graded for the win rate');
  assert.ok(Math.abs(sc.winRate - 2 / 3) < 1e-9);
  assert.strictEqual(sc.ambiguous, 1);
  assert.strictEqual(sc.expired, 1);
  assert.strictEqual(sc.notTriggered, 1);
  assert.strictEqual(sc.total, 6);
  assert.ok(sc.avgNetR !== null && sc.avgNetR > 0);
  trades.close();
});

test('scorecard never mixes replay calls into the live view', () => {
  const dir = tmpDir();
  const trades = new TradeStore(dir);
  const store = new RecommendationStore(trades.database);

  const live = store.save(rec({ replay_mode: 0 }));
  store.applyGrade(live, { outcome: 'LOSS', barsToOutcome: 2, rGross: -1, rNet: -1.08 });
  // Five replay wins must not flatter the live number.
  for (let i = 0; i < 5; i++) {
    const r = store.save(rec({ replay_mode: 1, bar_time: 1792600000 + i * 60 }));
    store.applyGrade(r, { outcome: 'WIN', barsToOutcome: 2, rGross: 1, rNet: 0.92 });
  }

  const liveCard = store.getScorecard({ replayMode: 0 });
  assert.strictEqual(liveCard.wins, 0, 'replay wins must not leak into live');
  assert.strictEqual(liveCard.losses, 1);
  assert.strictEqual(liveCard.winRate, 0);

  const replayCard = store.getScorecard({ replayMode: 1 });
  assert.strictEqual(replayCard.wins, 5);
  assert.strictEqual(replayCard.winRate, 1);
  trades.close();
});

test('scorecard buckets by setup, hour and direction', () => {
  const dir = tmpDir();
  const trades = new TradeStore(dir);
  const store = new RecommendationStore(trades.database);

  const mk = (outcome, setups, direction, i) => {
    const id = store.save(rec({
      bar_time: 1792600000 + i * 60, setups_json: JSON.stringify(setups), direction,
    }));
    store.applyGrade(id, { outcome, barsToOutcome: 2, rGross: outcome === 'WIN' ? 1 : -1, rNet: outcome === 'WIN' ? 0.92 : -1.08 });
  };
  mk('WIN',  ['hammer'], 'long', 0);
  mk('WIN',  ['hammer'], 'long', 1);
  mk('LOSS', ['hammer', 'doji'], 'short', 2);

  const sc = store.getScorecard();
  const hammer = sc.bySetup.find(b => b.label === 'hammer');
  assert.ok(hammer, 'hammer bucket exists');
  assert.strictEqual(hammer.graded, 3);
  assert.ok(Math.abs(hammer.winRate - 2 / 3) < 1e-9);

  const doji = sc.bySetup.find(b => b.label === 'doji');
  assert.strictEqual(doji.graded, 1);
  assert.strictEqual(doji.winRate, 0);

  const long = sc.byDirection.find(b => b.label === 'long');
  assert.strictEqual(long.wins, 2);
  const short = sc.byDirection.find(b => b.label === 'short');
  assert.strictEqual(short.losses, 1);

  assert.ok(sc.byHour.length >= 1, 'at least one hour bucket');
  assert.ok(sc.breakEven !== null && sc.breakEven > 0.5,
    `break-even must exceed 50% once fees are counted, got ${sc.breakEven}`);
  trades.close();
});

test('seeded test rows can be removed by app_version', () => {
  const dir = tmpDir();
  const trades = new TradeStore(dir);
  const store = new RecommendationStore(trades.database);

  store.save(rec({ app_version: 'TVCM-6-SEED', bar_time: 1 }));
  store.save(rec({ app_version: 'TVCM-6-SEED', bar_time: 2 }));
  store.save(rec({ app_version: '0.1.0',       bar_time: 3 }));

  assert.strictEqual(store.deleteByAppVersion('TVCM-6-SEED'), 2);
  assert.strictEqual(store.count(), 1, 'only the real row remains');
  trades.close();
});
