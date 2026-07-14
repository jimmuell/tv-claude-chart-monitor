'use strict';

const test   = require('node:test');
const assert = require('node:assert');
const os     = require('os');
const path   = require('path');
const fs     = require('fs');
const Module = require('module');

const DIST_DIR = path.join(__dirname, '../../dist/main/main');

// ── Stubs for Electron + heavy dependencies ────────────────────────────────────

const electronStub = {
  app: {
    getPath: () => os.tmpdir(),
    getVersion: () => '1.0.0',
    isPackaged: false,
  },
  Notification: class {
    constructor() {}
    show() {}
    static isSupported() { return false; }
  },
  ipcMain: { handle: () => {}, on: () => {} },
};

// Controlled readAccountData mock — overridden per test
let mockAccountData = null;
const pnlReaderStub = {
  readAccountData: async () => mockAccountData,
};

const feeCalcStub = {
  calculateFees:     () => ({ perContractRate: 0, contractCount: 0, variableFees: 0, dailyFixed: 0, totalFees: 0 }),
  getBreakevenPoints: () => 0,
  dailyFixedFee:     0,
};

const settingsStub = {
  getSettings: () => ({
    subtractCommissions: false,
    autoTradeStopDollars: 75,
    feePerContract: 0,
    feeLiquidationDaily: 0,
    feeDataMonthly: 0,
    feeTradingDays: 21,
  }),
};

// Install stubs BEFORE requiring any compiled module
const originalLoad = Module._load;
Module._load = function(request, parent, isMain) {
  if (request === 'electron') return electronStub;
  if (parent && parent.filename) {
    const parentDir = path.dirname(parent.filename);
    if (parentDir.startsWith(DIST_DIR)) {
      const resolved = path.resolve(parentDir, request);
      if (resolved === path.join(DIST_DIR, 'pnl-reader'))  return pnlReaderStub;
      if (resolved === path.join(DIST_DIR, 'fee-calculator')) return feeCalcStub;
      if (resolved === path.join(DIST_DIR, 'settings'))    return settingsStub;
      // bridge is required by pnl-reader stub (not the real one), so no-op
      if (resolved === path.join(DIST_DIR, 'bridge'))      return { evalPage: async () => null };
    }
  }
  return originalLoad.apply(this, arguments);
};

const { TradeStore }  = require(path.join(DIST_DIR, 'trade-store'));
const { PnlTracker }  = require(path.join(DIST_DIR, 'pnl-tracker'));

// Restore loader after all requires
Module._load = originalLoad;

// ── Helpers ────────────────────────────────────────────────────────────────────

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'pnl-tracker-test-'));
}

function makeAccountData(overrides = {}) {
  return {
    accountBalance:       null,
    prevDayBalance:       null,
    realizedPnl:          0,
    unrealizedPnl:        null,
    purchasingPower:      null,
    roundTrips:           0,
    buyFills:             0,
    sellFills:            0,
    openingFillDirection: null,
    positionsTabCount:    null,
    openPosition:         null,
    accountType:          'paper',
    ...overrides,
  };
}

// ── Tests ──────────────────────────────────────────────────────────────────────

test('PnlTracker rescue — direction unknown when all signals dark: writes "unknown" NOT "long"', async () => {
  const tmpDir = makeTmpDir();
  const store  = new TradeStore(tmpDir);
  const feeConfig = { perContractFee: 0, liquidationFee: 0, dataFeeMonthly: 0, tradingDaysPerMonth: 21 };

  const tracker = new PnlTracker(
    () => {},              // onUpdate
    () => feeConfig,       // getConfig
    store,
  );

  try {
    // Poll 1: gross=0, flat — sets lastGrossPnl=0, no trade detected
    mockAccountData = makeAccountData({ realizedPnl: 0, unrealizedPnl: null });
    await tracker.poll();

    // Poll 2: gross=50, flat, ALL direction signals null — rescue must fire
    mockAccountData = makeAccountData({
      realizedPnl:          50,
      unrealizedPnl:        null,
      buyFills:             0,
      sellFills:            0,
      openingFillDirection: null,
      positionsTabCount:    null,
      openPosition:         null,
    });
    await tracker.poll();

    const all = store.getAll();
    assert.strictEqual(all.length, 1, 'rescue should create exactly one trade');
    const trade = all[0];

    assert.strictEqual(trade.direction, 'unknown',
      `direction must be 'unknown' when all signals are null, got '${trade.direction}'`);
    assert.strictEqual(trade.needs_review, true,
      'needs_review must be true for unknown-direction rescue');
    assert.ok(trade.exit_at !== null, 'rescue trade must be closed (exit_at set)');
    assert.strictEqual(trade.entry_source, 'rescued');
    assert.strictEqual(trade.direction_source, 'unknown');
  } finally {
    store.close();
    fs.rmSync(tmpDir, { recursive: true });
  }
});

test('PnlTracker rescue — direction recorded correctly when lastKnownDirection is set', async () => {
  const tmpDir = makeTmpDir();
  const store  = new TradeStore(tmpDir);
  const feeConfig = { perContractFee: 0, liquidationFee: 0, dataFeeMonthly: 0, tradingDaysPerMonth: 21 };

  const tracker = new PnlTracker(() => {}, () => feeConfig, store);

  try {
    // Poll 1: active position seen (short) — sets lastKnownDirection
    mockAccountData = makeAccountData({
      realizedPnl:   0,
      unrealizedPnl: -25,
      openPosition:  { symbol: 'MES', direction: 'short', entryPrice: 5000 },
      positionsTabCount: 1,
    });
    await tracker.poll();
    store.clearAll(); // remove the entry so rescue fires on next close

    // Poll 2: gross changed, flat — direction signals now absent (Balances tab), but cache has 'short'
    mockAccountData = makeAccountData({
      realizedPnl:          -25,
      unrealizedPnl:        null,
      buyFills:             0,
      sellFills:            0,
      openingFillDirection: null,
      positionsTabCount:    null,
      openPosition:         null,
    });
    await tracker.poll();

    const all = store.getAll();
    assert.strictEqual(all.length, 1, 'rescue should create exactly one trade');
    assert.strictEqual(all[0].direction, 'short',
      `direction should be 'short' from cache, got '${all[0].direction}'`);
    assert.strictEqual(all[0].needs_review, false);
    assert.strictEqual(all[0].direction_source, 'cached');
  } finally {
    store.close();
    fs.rmSync(tmpDir, { recursive: true });
  }
});
