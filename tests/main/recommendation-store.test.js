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
  setups_json: '["hammer"]', setup_key: 'hammer', structure: null, replay_mode: 0,
  blocked: 0, blocked_reason: null, rules_version: 'testver1',
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

test('scorecard buckets by setup_key, hour and direction', () => {
  const dir = tmpDir();
  const trades = new TradeStore(dir);
  const store = new RecommendationStore(trades.database);

  // One bucket per call now, keyed by setup_key — the raw labels below differ in
  // spelling on purpose, exactly as the model writes them.
  const mk = (outcome, rawLabel, key, direction, i) => {
    const id = store.save(rec({
      bar_time: 1792600000 + i * 60,
      setups_json: JSON.stringify([rawLabel]),
      setup_key: key,
      direction,
    }));
    store.applyGrade(id, {
      outcome, barsToOutcome: 2,
      rGross: outcome === 'WIN' ? 1 : -1,
      rNet:   outcome === 'WIN' ? 0.92 : -1.08,
    });
  };
  mk('WIN',  'Bearish Outside Bar',                        'outside_bar', 'long',  0);
  mk('WIN',  'Bearish Outside-Bar',                        'outside_bar', 'long',  1);
  mk('LOSS', 'Bearish outside bar short at swing low break','outside_bar', 'short', 2);
  mk('LOSS', 'Bullish Engulfing',                          'engulfing',   'short', 3);

  const sc = store.getScorecard();

  const outside = sc.bySetup.find(b => b.label === 'outside_bar');
  assert.ok(outside, 'outside_bar bucket exists');
  assert.strictEqual(outside.graded, 3,
    'all three spellings land in ONE bucket, not three');
  assert.ok(Math.abs(outside.winRate - 2 / 3) < 1e-9);

  const engulfing = sc.bySetup.find(b => b.label === 'engulfing');
  assert.strictEqual(engulfing.graded, 1);
  assert.strictEqual(sc.bySetup.length, 2, 'exactly two setup buckets');

  const long = sc.byDirection.find(b => b.label === 'long');
  assert.strictEqual(long.wins, 2);
  const short = sc.byDirection.find(b => b.label === 'short');
  assert.strictEqual(short.losses, 2);

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

// ── setup_key column (TVCM-7 defect 3) ───────────────────────────────────────

test('adding setup_key does not disturb trades or user_version', () => {
  const dir = tmpDir();
  const trades = new TradeStore(dir);
  trades.recordEntry(SAMPLE_TRADE);
  const db = trades.database;
  const before = {
    n:       db.prepare('SELECT COUNT(*) AS n FROM trades').get().n,
    version: db.prepare('PRAGMA user_version').get().user_version,
  };

  new RecommendationStore(db);          // runs the ALTER TABLE path

  assert.strictEqual(db.prepare('SELECT COUNT(*) AS n FROM trades').get().n, before.n);
  assert.strictEqual(db.prepare('PRAGMA user_version').get().user_version, before.version,
    'ALTER TABLE must be used instead of a schema-version bump');
  const cols = db.prepare('PRAGMA table_info(recommendations)').all().map(c => c.name);
  assert.ok(cols.includes('setup_key'), 'setup_key column exists');
  trades.close();
});

test('initRecommendationsSchema is safe to run twice (ALTER is not repeated)', () => {
  const dir = tmpDir();
  const trades = new TradeStore(dir);
  new RecommendationStore(trades.database);
  assert.doesNotThrow(() => new RecommendationStore(trades.database),
    'a second init must not fail with "duplicate column name"');
  trades.close();
});

test('backfillSetupKeys fills only NULL keys and is idempotent', () => {
  const dir = tmpDir();
  const trades = new TradeStore(dir);
  const store = new RecommendationStore(trades.database);
  const db = trades.database;

  // Two rows written as if before the column existed.
  store.save(rec({ bar_time: 10, setups_json: '["Bearish Outside Bar"]' }));
  store.save(rec({ bar_time: 20, setups_json: '["Bearish Outside-Bar"]' }));
  db.prepare('UPDATE recommendations SET setup_key = NULL').run();

  const mapper = (json) => (String(json).toLowerCase().includes('outside') ? 'outside_bar' : 'other');
  assert.strictEqual(store.backfillSetupKeys(mapper), 2, 'both rows filled');
  assert.strictEqual(store.backfillSetupKeys(mapper), 0, 'second run touches nothing');

  const keys = db.prepare('SELECT DISTINCT setup_key FROM recommendations').all().map(r => r.setup_key);
  assert.deepStrictEqual(keys, ['outside_bar'], 'both spellings collapsed to one key');
  trades.close();
});

// ── rules lever + rules_version (TVCM-8) ─────────────────────────────────────

test('same bar + same rules_version is deduped', () => {
  const dir = tmpDir();
  const trades = new TradeStore(dir);
  const store = new RecommendationStore(trades.database);

  assert.ok(store.save(rec({ rules_version: 'aaaa1111' })) !== null, 'first save');
  assert.strictEqual(store.save(rec({ rules_version: 'aaaa1111', confidence: 0.9 })), null,
    're-running the same day under the same rules must not double count');
  assert.strictEqual(store.count(), 1);
  trades.close();
});

test('same bar + NEW rules_version saves a new row (a fair re-test)', () => {
  const dir = tmpDir();
  const trades = new TradeStore(dir);
  const store = new RecommendationStore(trades.database);

  assert.ok(store.save(rec({ rules_version: 'aaaa1111' })) !== null);
  assert.ok(store.save(rec({ rules_version: 'bbbb2222' })) !== null,
    'changing the rules must allow the same day to be re-tested');
  assert.strictEqual(store.count(), 2);
  trades.close();
});

test('blocked calls are stored with their reason and still gradeable', () => {
  const dir = tmpDir();
  const trades = new TradeStore(dir);
  const store = new RecommendationStore(trades.database);

  const id = store.save(rec({ blocked: 1, blocked_reason: 'setup "hammer" is blocked' }));
  const row = trades.database.prepare('SELECT * FROM recommendations WHERE id = ?').get(id);
  assert.strictEqual(row.blocked, 1);
  assert.match(row.blocked_reason, /hammer/);

  // Shadow grading: a blocked call is graded exactly like an allowed one.
  assert.strictEqual(store.getUngraded().length, 1, 'blocked calls are still queued for grading');
  store.applyGrade(id, { outcome: 'WIN', barsToOutcome: 3, rGross: 1, rNet: 0.92 });
  assert.strictEqual(store.outcomeOf(id), 'WIN');
  trades.close();
});

test('scorecard separates allowed from blocked and never blends them', () => {
  const dir = tmpDir();
  const trades = new TradeStore(dir);
  const store = new RecommendationStore(trades.database);

  const add = (blocked, outcome, i) => {
    const id = store.save(rec({ bar_time: 500 + i, blocked, rules_version: 'v1',
                                blocked_reason: blocked ? 'blocked' : null }));
    store.applyGrade(id, { outcome, barsToOutcome: 2,
      rGross: outcome === 'WIN' ? 1 : -1, rNet: outcome === 'WIN' ? 0.92 : -1.08 });
  };
  // allowed: 1 win / 1 loss = 50%.  blocked: 3 wins = 100% (blocking these cost money).
  add(0, 'WIN', 1); add(0, 'LOSS', 2);
  add(1, 'WIN', 3); add(1, 'WIN', 4); add(1, 'WIN', 5);

  const sc = store.getScorecard({ rulesVersion: 'v1' });
  assert.strictEqual(sc.wins, 1, 'blocked wins must not inflate the allowed win rate');
  assert.strictEqual(sc.losses, 1);
  assert.ok(Math.abs(sc.winRate - 0.5) < 1e-9);
  assert.strictEqual(sc.blocked.graded, 3, 'blocked calls are counted on their own');
  assert.strictEqual(sc.blocked.wins, 3);
  assert.strictEqual(sc.blocked.winRate, 1);
  trades.close();
});

test('scorecard can filter by rules_version and list the versions present', () => {
  const dir = tmpDir();
  const trades = new TradeStore(dir);
  const store = new RecommendationStore(trades.database);

  const add = (ver, outcome, i) => {
    const id = store.save(rec({ bar_time: 900 + i, rules_version: ver }));
    store.applyGrade(id, { outcome, barsToOutcome: 2,
      rGross: outcome === 'WIN' ? 1 : -1, rNet: outcome === 'WIN' ? 0.92 : -1.08 });
  };
  add('v1', 'WIN', 1); add('v1', 'WIN', 2);
  add('v2', 'LOSS', 3);

  assert.strictEqual(store.getScorecard({ rulesVersion: 'v1' }).winRate, 1);
  assert.strictEqual(store.getScorecard({ rulesVersion: 'v2' }).winRate, 0);
  assert.strictEqual(store.getScorecard({ rulesVersion: 'v1' }).graded, 2,
    'v2 results must not leak into v1');

  const versions = store.listRulesVersions();
  assert.ok(versions.some(v => v.rules_version === 'v1' && v.n === 2));
  assert.ok(versions.some(v => v.rules_version === 'v2' && v.n === 1));
  trades.close();
});

test('the rules columns are added without disturbing trades or user_version', () => {
  const dir = tmpDir();
  const trades = new TradeStore(dir);
  trades.recordEntry(SAMPLE_TRADE);
  const db = trades.database;
  const before = {
    n: db.prepare('SELECT COUNT(*) AS n FROM trades').get().n,
    v: db.prepare('PRAGMA user_version').get().user_version,
  };

  new RecommendationStore(db);

  assert.strictEqual(db.prepare('SELECT COUNT(*) AS n FROM trades').get().n, before.n);
  assert.strictEqual(db.prepare('PRAGMA user_version').get().user_version, before.v,
    'ALTER TABLE only — a version bump would drop trades');
  const cols = db.prepare('PRAGMA table_info(recommendations)').all().map(c => c.name);
  for (const c of ['blocked', 'blocked_reason', 'rules_version']) {
    assert.ok(cols.includes(c), `${c} column exists`);
  }
  trades.close();
});

// ── rules_version is never null (TVCM-9) ─────────────────────────────────────

test('save() never writes a null or blank rules_version', () => {
  const dir = tmpDir();
  const trades = new TradeStore(dir);
  const store = new RecommendationStore(trades.database);
  const db = trades.database;

  for (const [i, bad] of [null, undefined, '', '   '].entries()) {
    const id = store.save(rec({ bar_time: 7000 + i, rules_version: bad }));
    assert.ok(id, `saved for ${JSON.stringify(bad)}`);
    const row = db.prepare('SELECT rules_version FROM recommendations WHERE id = ?').get(id);
    assert.strictEqual(row.rules_version, 'unversioned',
      `a ${JSON.stringify(bad)} version must become "unversioned", never NULL`);
  }
  assert.strictEqual(db.prepare('SELECT COUNT(*) n FROM recommendations WHERE rules_version IS NULL').get().n, 0);
  trades.close();
});

test('dedup still works for calls saved without a rules version', () => {
  // The TVCM-8 failure mode: NULLs are DISTINCT in a unique index, so one
  // null-versioned row turned dedup off for that bar entirely.
  const dir = tmpDir();
  const trades = new TradeStore(dir);
  const store = new RecommendationStore(trades.database);

  assert.ok(store.save(rec({ bar_time: 8000, rules_version: null })), 'first save');
  assert.strictEqual(store.save(rec({ bar_time: 8000, rules_version: null })), null,
    'the second save of the same bar must be rejected, not silently duplicated');
  assert.strictEqual(store.count(), 1);
  trades.close();
});
