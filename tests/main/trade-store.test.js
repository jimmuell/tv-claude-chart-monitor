'use strict';

const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');
const fs = require('fs');

// The compiled trade-store lives in dist/main/ after tsc.
// For tests we load the TypeScript source via ts-node, but since this project
// uses tsconfig.main.json (CommonJS) we compile first. Instead, we load via
// require with ts-node/register if available, or fall back to the compiled output.
// Actually, let's compile on-demand and require from dist.
// The simpler approach: require the compiled JS (must run after tsc).

// We compile trade-store.ts to a temp location for testing.
// Since the project has tsconfig.main.json that outputs to dist/main/,
// we just build first and require from dist/.
// BUT: the task says "run node --test tests/main/trade-store.test.js" directly.
// We need to handle compilation ourselves or use ts-node.
// Check if ts-node is available; if not, require from dist/main/.

// The compiled output goes to dist/main/main/ because tsconfig.main.json has
// outDir=dist/main and rootDir=src, so src/main/trade-store.ts → dist/main/main/trade-store.js
const TradeStore = require('../../dist/main/main/trade-store').TradeStore;

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'trade-store-test-'));
}

function makeEntry(overrides = {}) {
  return {
    symbol:        'MES',
    timeframe:     '5',
    direction:     'long',
    entry_price:   5000.0,
    stop_price:    4985.0,
    target_price:  5030.0,
    trailing_stop: false,
    rr_planned:    2.0,
    verdict:       'valid_long',
    headline:      'Bullish breakout above VWAP',
    objective:     'Market trending up on light pullback.',
    steps_json:    JSON.stringify(['Price held support', 'Volume spike on breakout']),
    structure:     'Higher highs and higher lows',
    rationale:     'Clean breakout with volume confirmation',
    patterns_json: JSON.stringify(['Bullish Engulfing', 'Inside Bar']),
    confidence:    0.8,
    ...overrides,
  };
}

function makeExit(overrides = {}) {
  return {
    exit_at:   Date.now(),
    pnl_gross: 150.0,   // $150 profit
    pnl_net:   148.76,
    // r_multiple is NOT in TradeExit — computed internally by TradeStore
    ...overrides,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

test('recordEntry — inserts a row and returns an integer id', () => {
  const dir = makeTmpDir();
  const store = new TradeStore(dir);
  try {
    const id = store.recordEntry(makeEntry());
    assert.ok(typeof id === 'number', 'id should be a number');
    assert.ok(id >= 1, 'id should be >= 1 (AUTOINCREMENT)');
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true });
  }
});

test('recordEntry — second insert returns a higher id', () => {
  const dir = makeTmpDir();
  const store = new TradeStore(dir);
  try {
    const id1 = store.recordEntry(makeEntry());
    const id2 = store.recordEntry(makeEntry({ direction: 'short', verdict: 'valid_short' }));
    assert.ok(id2 > id1, 'second id should be greater than first');
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true });
  }
});

test('recordExitForOpenTrade — updates exit fields on the open trade', () => {
  const dir = makeTmpDir();
  const store = new TradeStore(dir);
  try {
    const id = store.recordEntry(makeEntry()); // symbol='MES', long, entry=5000, stop=4985
    const exit = makeExit();                   // pnl_gross=150
    const updated = store.recordExitForOpenTrade(exit, 'MES');
    assert.strictEqual(updated, true);

    const record = store.getById(id);
    assert.ok(record, 'record should exist');
    assert.strictEqual(record.pnl_gross, exit.pnl_gross);
    assert.strictEqual(record.pnl_net, exit.pnl_net);
    // r_multiple computed from entry/stop: 150 / (|5000-4985| * 5 * 1) = 150/75 = 2.0
    assert.ok(Math.abs(record.r_multiple - 2.0) < 0.001, `r_multiple should be 2.0, got ${record.r_multiple}`);
    assert.ok(record.exit_at != null, 'exit_at should be set');
    // exit_price: entry_price + pnl_gross / (POINT_VALUE * qty) = 5000 + 150/5 = 5030
    assert.strictEqual(record.exit_price, 5000 + 150 / 5.0);
    assert.strictEqual(record.exit_source, 'derived');
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true });
  }
});

test('recordExitForOpenTrade — SHORT direction: exit_price = entry - pnl/pointValue', () => {
  const dir = makeTmpDir();
  const store = new TradeStore(dir);
  try {
    const id = store.recordEntry(makeEntry({ direction: 'short', verdict: 'valid_short' }));
    const exit = makeExit({ pnl_gross: 100.0 });
    store.recordExitForOpenTrade(exit, 'MES');
    const record = store.getById(id);
    // exit_price: 5000 - 100/5 = 4980
    assert.strictEqual(record.exit_price, 5000 - 100 / 5.0);
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true });
  }
});

test('recordExitForOpenTrade — returns false when no open trade exists', () => {
  const dir = makeTmpDir();
  const store = new TradeStore(dir);
  try {
    // Close the only trade first
    store.recordEntry(makeEntry()); // symbol='MES'
    store.recordExitForOpenTrade(makeExit(), 'MES');
    // Now try again — no open trade for 'MES'
    const result = store.recordExitForOpenTrade(makeExit(), 'MES');
    assert.strictEqual(result, false);
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true });
  }
});

test('recordExitForOpenTrade — returns false on empty table', () => {
  const dir = makeTmpDir();
  const store = new TradeStore(dir);
  try {
    const result = store.recordExitForOpenTrade(makeExit(), 'MES');
    assert.strictEqual(result, false);
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true });
  }
});

test('addNotes — updates notes and tags_json', () => {
  const dir = makeTmpDir();
  const store = new TradeStore(dir);
  try {
    const id = store.recordEntry(makeEntry());
    store.addNotes(id, 'Great entry, held through noise', ['breakout', 'vwap']);
    const record = store.getById(id);
    assert.strictEqual(record.notes, 'Great entry, held through noise');
    assert.deepStrictEqual(JSON.parse(record.tags_json), ['breakout', 'vwap']);
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true });
  }
});

test('addCritique — updates critique_json with correct JSON shape', () => {
  const dir = makeTmpDir();
  const store = new TradeStore(dir);
  try {
    const id = store.recordEntry(makeEntry());
    const before = Date.now();
    store.addCritique(id, 'Entry was slightly early, but structure was valid.');
    const record = store.getById(id);
    assert.ok(record.critique_json != null, 'critique_json should be set');
    const critique = JSON.parse(record.critique_json);
    assert.strictEqual(critique.text, 'Entry was slightly early, but structure was valid.');
    assert.ok(typeof critique.created_at === 'number', 'created_at should be a number');
    assert.ok(critique.created_at >= before, 'created_at should be >= time before call');
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true });
  }
});

test('getById — returns the correct trade', () => {
  const dir = makeTmpDir();
  const store = new TradeStore(dir);
  try {
    const entry = makeEntry({ symbol: 'ES', timeframe: '15' });
    const id = store.recordEntry(entry);
    const record = store.getById(id);
    assert.ok(record, 'record should be found');
    assert.strictEqual(record.id, id);
    assert.strictEqual(record.symbol, 'ES');
    assert.strictEqual(record.timeframe, '15');
    assert.strictEqual(record.direction, 'long');
    assert.strictEqual(record.entry_price, 5000.0);
    assert.strictEqual(record.verdict, 'valid_long');
    assert.strictEqual(record.confidence, 0.8);
    assert.strictEqual(record.trailing_stop, false);
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true });
  }
});

test('getById — returns undefined for a missing id', () => {
  const dir = makeTmpDir();
  const store = new TradeStore(dir);
  try {
    const result = store.getById(999);
    assert.strictEqual(result, undefined);
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true });
  }
});

test('getAll — returns array newest first', () => {
  const dir = makeTmpDir();
  const store = new TradeStore(dir);
  try {
    const id1 = store.recordEntry(makeEntry({ symbol: 'MES' }));
    // Small delay to ensure different created_at values
    const id2 = store.recordEntry(makeEntry({ symbol: 'ES', direction: 'short', verdict: 'valid_short' }));
    const all = store.getAll();
    assert.ok(Array.isArray(all), 'getAll should return an array');
    assert.strictEqual(all.length, 2);
    // Newest first: id2 was inserted after id1
    assert.strictEqual(all[0].id, id2);
    assert.strictEqual(all[1].id, id1);
    assert.strictEqual(all[0].symbol, 'ES');
    assert.strictEqual(all[1].symbol, 'MES');
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true });
  }
});

test('getAll — returns empty array when no trades', () => {
  const dir = makeTmpDir();
  const store = new TradeStore(dir);
  try {
    assert.deepStrictEqual(store.getAll(), []);
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true });
  }
});

test('getStats — basic sanity: counts, winRate, totalNetPnl', () => {
  const dir = makeTmpDir();
  const store = new TradeStore(dir);
  try {
    // 3 trades: 2 wins, 1 loss, 1 open
    const id1 = store.recordEntry(makeEntry({ patterns_json: JSON.stringify(['Bullish Engulfing']) }));
    const id2 = store.recordEntry(makeEntry({ patterns_json: JSON.stringify(['Bullish Engulfing', 'Inside Bar']) }));
    const id3 = store.recordEntry(makeEntry({ patterns_json: JSON.stringify(['Inside Bar']) }));
    const id4 = store.recordEntry(makeEntry()); // open trade

    // Win (pnl_net=100, pnl_gross=150 default → r = 150/75 = 2.0)
    store.recordExitForOpenTrade(makeExit({ pnl_net: 100 }), 'MES');
    // Win (pnl_net=75, pnl_gross=150 default → r = 150/75 = 2.0)
    store.recordExitForOpenTrade(makeExit({ pnl_net: 75 }), 'MES');
    // Loss (pnl_gross=-50 → r = -50/75 ≈ -0.667)
    store.recordExitForOpenTrade(makeExit({ pnl_gross: -50, pnl_net: -51.24 }), 'MES');
    // id4 stays open

    const stats = store.getStats();

    assert.strictEqual(stats.totalTrades, 4);
    assert.strictEqual(stats.winCount, 2);   // pnl_net > 0
    assert.strictEqual(stats.lossCount, 1);  // pnl_net < 0
    assert.strictEqual(stats.openCount, 1);

    // winRate = 2 / (2 + 1) ≈ 0.667 (scratches not counted)
    assert.ok(Math.abs(stats.winRate - 2 / 3) < 0.001, `winRate should be ~0.667, got ${stats.winRate}`);

    // totalNetPnl = 100 + 75 + (-51.24) = 123.76
    assert.ok(Math.abs(stats.totalNetPnl - 123.76) < 0.01, `totalNetPnl should be ~123.76, got ${stats.totalNetPnl}`);

    // avgR computed from entry/stop: (2.0 + 2.0 + (-50/75)) / 3
    const expectedAvgR = (2.0 + 2.0 + (-50 / 75)) / 3;
    assert.ok(Math.abs(stats.avgR - expectedAvgR) < 0.001, `avgR should be ~${expectedAvgR.toFixed(3)}, got ${stats.avgR}`);

    // byPattern: should include 'Bullish Engulfing' and 'Inside Bar'
    assert.ok(Array.isArray(stats.byPattern));
    const engulfing = stats.byPattern.find(p => p.pattern === 'Bullish Engulfing');
    assert.ok(engulfing, 'should have Bullish Engulfing pattern');
    assert.strictEqual(engulfing.count, 2);

    // equityCurve should have at least one entry
    assert.ok(Array.isArray(stats.equityCurve));
    assert.ok(stats.equityCurve.length >= 1);
    // Last cumulative value should match totalNetPnl
    const lastCumulative = stats.equityCurve[stats.equityCurve.length - 1].cumulativeNet;
    assert.ok(Math.abs(lastCumulative - stats.totalNetPnl) < 0.01, `last equityCurve value should match totalNetPnl`);
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true });
  }
});

test('getStats — empty database returns zeros', () => {
  const dir = makeTmpDir();
  const store = new TradeStore(dir);
  try {
    const stats = store.getStats();
    assert.strictEqual(stats.totalTrades, 0);
    assert.strictEqual(stats.winCount, 0);
    assert.strictEqual(stats.lossCount, 0);
    assert.strictEqual(stats.openCount, 0);
    assert.strictEqual(stats.winRate, 0);
    assert.strictEqual(stats.avgR, 0);
    assert.strictEqual(stats.totalNetPnl, 0);
    assert.strictEqual(stats.needsReviewCount, 0);
    assert.deepStrictEqual(stats.byPattern, []);
    assert.deepStrictEqual(stats.byHour, []);
    assert.deepStrictEqual(stats.equityCurve, []);
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true });
  }
});

// ── New tests for Task 2 truth guarantees ──────────────────────────────────────

test('recordExitForOpenTrade — exit_price is NULL when entry_price is NULL', () => {
  const dir = makeTmpDir();
  const store = new TradeStore(dir);
  try {
    store.recordEntry(makeEntry({ entry_price: null, stop_price: null }));
    store.recordExitForOpenTrade(makeExit(), 'MES');
    const all = store.getAll();
    assert.strictEqual(all.length, 1);
    assert.strictEqual(all[0].exit_price, null, 'exit_price must be NULL when entry_price is NULL');
    assert.strictEqual(all[0].exit_source, null, 'exit_source must be NULL when exit_price not derived');
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true });
  }
});

test('recordExitForOpenTrade — r_multiple is NULL when stop_price is NULL', () => {
  const dir = makeTmpDir();
  const store = new TradeStore(dir);
  try {
    store.recordEntry(makeEntry({ stop_price: null }));
    store.recordExitForOpenTrade(makeExit(), 'MES');
    const all = store.getAll();
    assert.strictEqual(all[0].r_multiple, null, 'r_multiple must be NULL when stop_price is NULL');
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true });
  }
});

test('getStats — excludes needs_review=true trades', () => {
  const dir = makeTmpDir();
  const store = new TradeStore(dir);
  try {
    // 1 good closed trade (win)
    store.recordEntry(makeEntry());
    store.recordExitForOpenTrade(makeExit({ pnl_net: 100 }), 'MES');

    // 1 needs_review closed trade
    store.recordEntry(makeEntry({ needs_review: true }));
    store.recordExitForOpenTrade(makeExit({ pnl_net: 200 }), 'MES');

    const stats = store.getStats();
    assert.strictEqual(stats.totalTrades, 1, 'needs_review trade must be excluded from totalTrades');
    assert.strictEqual(stats.winCount, 1);
    assert.strictEqual(stats.needsReviewCount, 1);
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true });
  }
});

test("getStats — direction='unknown' trade is excluded from stats", () => {
  const dir = makeTmpDir();
  const store = new TradeStore(dir);
  try {
    store.recordEntry(makeEntry({ direction: 'unknown', needs_review: true }));
    store.recordExitForOpenTrade(makeExit({ pnl_net: 100 }), 'MES');

    const stats = store.getStats();
    assert.strictEqual(stats.totalTrades, 0, "direction='unknown' trade must be excluded");
    assert.strictEqual(stats.needsReviewCount, 1);
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true });
  }
});

test('getStats — scratch (pnl_net=0) is neither a win nor a loss', () => {
  const dir = makeTmpDir();
  const store = new TradeStore(dir);
  try {
    store.recordEntry(makeEntry());
    store.recordExitForOpenTrade(makeExit({ pnl_gross: 0, pnl_net: 0 }), 'MES');

    const stats = store.getStats();
    assert.strictEqual(stats.winCount, 0, 'scratch should not be a win');
    assert.strictEqual(stats.lossCount, 0, 'scratch should not be a loss');
    assert.strictEqual(stats.winRate, 0);
    assert.strictEqual(stats.totalNetPnl, 0);
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true });
  }
});

test('recordExitForOpenTrade — scoped by symbol: does not close trade for different symbol', () => {
  const dir = makeTmpDir();
  const store = new TradeStore(dir);
  try {
    store.recordEntry(makeEntry({ symbol: 'MES' }));
    const result = store.recordExitForOpenTrade(makeExit(), 'ES'); // wrong symbol
    assert.strictEqual(result, false, 'should not close MES trade when ES symbol given');
    assert.strictEqual(store.hasOpenTrade('MES'), true, 'MES trade should still be open');
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true });
  }
});
