'use strict';

const test   = require('node:test');
const assert = require('node:assert');
const path   = require('path');
const Module = require('module');

const originalLoad = Module._load;
Module._load = function (request) {
  if (request === 'electron') return { app: {}, ipcMain: { handle: () => {}, on: () => {} } };
  return originalLoad.apply(this, arguments);
};
const { liveSafetyBanner } = require(path.join(__dirname, '../../dist/main/shared/live-safety'));

test('a live account with both order paths off says so plainly', () => {
  const b = liveSafetyBanner({ accountType: 'amp_live', autoTrade: false, autoTradeTestMode: false });
  assert.strictEqual(b.level, 'ok');
  assert.strictEqual(b.text, 'LIVE ACCOUNT — auto-trade OFF');
});

test('KNOWN-POSITIVE: flipping autoTrade on turns the banner red on a live account', () => {
  const b = liveSafetyBanner({ accountType: 'amp_live', autoTrade: true, autoTradeTestMode: false });
  assert.strictEqual(b.level, 'danger');
  assert.match(b.text, /LIVE ACCOUNT/);
  assert.match(b.text, /auto-trade/);
  assert.match(b.text, /real order/);
  assert.deepStrictEqual(b.armed, ['auto-trade']);
});

test('KNOWN-POSITIVE: test-mode order buttons count as armed too', () => {
  // This is the flag that was actually left on: one click = one market order.
  const b = liveSafetyBanner({ accountType: 'amp_live', autoTrade: false, autoTradeTestMode: true });
  assert.strictEqual(b.level, 'danger');
  assert.match(b.text, /test-mode order buttons/);
  assert.deepStrictEqual(b.armed, ['test-mode order buttons']);
});

test('both flags armed are both named', () => {
  const b = liveSafetyBanner({ accountType: 'amp_live', autoTrade: true, autoTradeTestMode: true });
  assert.strictEqual(b.level, 'danger');
  assert.deepStrictEqual(b.armed, ['auto-trade', 'test-mode order buttons']);
  assert.match(b.text, /auto-trade and test-mode order buttons/);
});

test('a paper account with a flag on still warns, but not in red', () => {
  const b = liveSafetyBanner({ accountType: 'paper', autoTrade: true, autoTradeTestMode: false });
  assert.strictEqual(b.level, 'warn');
  assert.match(b.text, /paper account/);
  assert.match(b.text, /before trading live/);
});

test('a quiet paper account says nothing at all', () => {
  assert.strictEqual(liveSafetyBanner({ accountType: 'paper', autoTrade: false, autoTradeTestMode: false }), null);
  assert.strictEqual(liveSafetyBanner({ accountType: null, autoTrade: false, autoTradeTestMode: false }), null);
  assert.strictEqual(liveSafetyBanner({}), null);
});

test('only an exact true arms a flag — a stray truthy value does not', () => {
  assert.strictEqual(liveSafetyBanner({ accountType: 'amp_live', autoTrade: 'false' }).level, 'ok');
  assert.strictEqual(liveSafetyBanner({ accountType: 'amp_live', autoTrade: 1 }).level, 'ok');
});
