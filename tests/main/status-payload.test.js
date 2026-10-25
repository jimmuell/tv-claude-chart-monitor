'use strict';

const test   = require('node:test');
const assert = require('node:assert');
const path   = require('path');
const Module = require('module');

const DIST_DIR = path.join(__dirname, '../../dist/main/main');
const originalLoad = Module._load;
Module._load = function (request) {
  if (request === 'electron') return { app: {}, ipcMain: { handle: () => {}, on: () => {} } };
  return originalLoad.apply(this, arguments);
};
const { analysisErrorPayload, errorMessage } = require(path.join(DIST_DIR, 'status-payload'));

test('a coded read error reaches the panel with its message, not just a red dot', () => {
  // This is exactly what bridge.runAnalysis throws when the chart reports its
  // data as loaded but no bars could be read.
  const err = new Error('TVCM-READ-EMPTY-BARS: TradingView reported its data as loaded but no bars could be read');

  const payload = analysisErrorPayload(err);

  assert.strictEqual(payload.status, 'error');
  assert.match(payload.message, /TVCM-READ-EMPTY-BARS/,
    'the code must survive into the panel message');
  assert.match(payload.message, /no bars could be read/);
});

test('an ordinary failure still produces a usable message', () => {
  assert.strictEqual(analysisErrorPayload(new Error('Not enough bar data to build context')).message,
    'Not enough bar data to build context');
});

test('never sends an empty message — a blank panel is worse than a red dot', () => {
  for (const thrown of [new Error(''), null, undefined, '', '   ']) {
    const p = analysisErrorPayload(thrown);
    assert.strictEqual(p.status, 'error');
    assert.ok(p.message.length > 0, `empty message for ${JSON.stringify(thrown)}`);
  }
  assert.strictEqual(analysisErrorPayload(null).message, 'Unknown error');
});

test('handles non-Error throws', () => {
  assert.strictEqual(errorMessage('plain string problem'), 'plain string problem');
  assert.strictEqual(errorMessage({ toString: () => 'object problem' }), 'object problem');
});
