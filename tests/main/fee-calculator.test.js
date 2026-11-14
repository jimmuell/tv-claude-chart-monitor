'use strict';

// AMP fee model: $0.60 per contract PER SIDE, no daily fixed charges.
// The units are the whole point — the old model charged $1.24 per "trade" plus a
// phantom $4.64/day, and disagreed with AMP's statement on both counts.

const test   = require('node:test');
const assert = require('node:assert');
const path   = require('path');

const fc = require(path.join(__dirname, '../../dist/main/main/fee-calculator'));
const {
  DEFAULT_FEE_CONFIG, AMP_SIDE_FEE_COMPONENTS, AMP_PER_CONTRACT_SIDE_FEE,
  SIDES_PER_ROUND_TRIP, dailyFixedFee, calculateFees, calculateNetPnl,
  contractSidesFromRoundTrips, roundTripFee, getBreakevenPoints,
} = fc;

const cents = (n) => Math.round(n * 100) / 100;

// ── The rate itself ───────────────────────────────────────────────────────
test('AMP per-side rate is its components summed', () => {
  const { exchange, clearing, cqg, nfa, commission } = AMP_SIDE_FEE_COMPONENTS;
  assert.deepStrictEqual(
    [exchange, clearing, cqg, nfa, commission],
    [0.35, 0.13, 0.10, 0.01, 0.01],
    'statement components changed'
  );
  assert.strictEqual(cents(AMP_PER_CONTRACT_SIDE_FEE), 0.60);
});

test('defaults are the AMP model: 0.60/side, no daily fixed charges', () => {
  assert.strictEqual(cents(DEFAULT_FEE_CONFIG.perContractSideFee), 0.60);
  assert.strictEqual(DEFAULT_FEE_CONFIG.liquidationDaily, 0);
  assert.strictEqual(DEFAULT_FEE_CONFIG.dataFeedMonthly, 0);
  assert.strictEqual(cents(dailyFixedFee(DEFAULT_FEE_CONFIG)), 0);
});

// ── The acceptance number from the prompt ─────────────────────────────────
test('666 contract-sides cost $399.60', () => {
  const fees = calculateFees(666, DEFAULT_FEE_CONFIG);
  assert.strictEqual(cents(fees.totalFees), 399.60);
  assert.strictEqual(cents(fees.variableFees), 399.60);
  assert.strictEqual(fees.contractCount, 666);
  assert.strictEqual(cents(fees.perContractRate), 0.60);
});

test('a 5-lot round trip is 10 sides and costs $6.00', () => {
  assert.strictEqual(SIDES_PER_ROUND_TRIP, 2);
  assert.strictEqual(contractSidesFromRoundTrips(1, 5), 10);
  assert.strictEqual(cents(roundTripFee(5, DEFAULT_FEE_CONFIG)), 6.00);
  assert.strictEqual(cents(roundTripFee(1, DEFAULT_FEE_CONFIG)), 1.20); // $1.20 round trip
});

test('round trips convert to sides at 1 contract each by default', () => {
  assert.strictEqual(contractSidesFromRoundTrips(333), 666);
  assert.strictEqual(contractSidesFromRoundTrips(0), 0);
});

// ── Daily fixed charges are reported but never charged ────────────────────
test('daily fixed fees are excluded from totalFees even when configured', () => {
  const cfg = { ...DEFAULT_FEE_CONFIG, liquidationDaily: 2.50, dataFeedMonthly: 45, tradingDaysPerMonth: 21 };
  const fees = calculateFees(10, cfg);
  assert.strictEqual(cents(fees.variableFees), 6.00);
  assert.strictEqual(cents(fees.totalFees), 6.00, 'daily fixed leaked into the total');
  assert.ok(fees.dailyFixed > 4.6 && fees.dailyFixed < 4.7, 'dailyFixed should still be reported');
});

test('dailyFixedFee does not divide by zero trading days', () => {
  const cfg = { ...DEFAULT_FEE_CONFIG, dataFeedMonthly: 45, tradingDaysPerMonth: 0 };
  assert.strictEqual(dailyFixedFee(cfg), 0);
});

// ── Net and breakeven ─────────────────────────────────────────────────────
test('net P&L subtracts only the variable fees', () => {
  const r = calculateNetPnl(1296.25, 666, DEFAULT_FEE_CONFIG);
  assert.strictEqual(cents(r.totalFees), 399.60);
  assert.strictEqual(cents(r.netPnl), 896.65);
});

test('breakeven points are MES dollars at $5/point, zero when green', () => {
  assert.strictEqual(getBreakevenPoints(50), 0);
  assert.strictEqual(getBreakevenPoints(0), 0);
  assert.strictEqual(getBreakevenPoints(-10), 2);
});

test('zero sides costs nothing', () => {
  assert.strictEqual(calculateFees(0, DEFAULT_FEE_CONFIG).totalFees, 0);
});

// ── The order-history engine must charge the same rate ────────────────────
test('order-history default rate has not drifted from the fee config', () => {
  const oh = require(path.join(__dirname, '../../src/shared/order-history.js'));
  assert.strictEqual(
    cents(oh.DEFAULT_PER_CONTRACT_SIDE_FEE),
    cents(DEFAULT_FEE_CONFIG.perContractSideFee),
    'src/shared/order-history.js and src/main/fee-calculator.ts disagree on the per-side rate'
  );
});

test('order-history uses the same MES point value', () => {
  const oh = require(path.join(__dirname, '../../src/shared/order-history.js'));
  assert.strictEqual(oh.MES_POINT_VALUE, 5.0);
  assert.strictEqual(getBreakevenPoints(-oh.MES_POINT_VALUE), 1);
});
