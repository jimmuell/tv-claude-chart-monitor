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
const { describeStartupFailure, startupFailureText, runStartupStep } =
  require(path.join(DIST_DIR, 'startup-guard'));

test('a schema-init throw becomes a coded, actionable failure', () => {
  // The TVCM-8 bug, verbatim: this threw inside whenReady and killed startup.
  const err = new Error('UNIQUE constraint failed: recommendations.symbol, recommendations.timeframe');

  const f = describeStartupFailure('schema', err);

  assert.strictEqual(f.code, 'TVCM-START-SCHEMA');
  assert.strictEqual(f.step, 'schema');
  assert.match(f.message, /UNIQUE constraint failed/);
  assert.ok(f.advice.length > 0, 'a failure the user can see must say what to do');

  const text = startupFailureText(f);
  assert.match(text, /TVCM-START-SCHEMA/);
  assert.match(text, /UNIQUE constraint failed/);
  assert.match(text, /backup/i, 'the advice reaches the displayed line');
});

test('runStartupStep reports instead of letting the throw escape', () => {
  const seen = [];
  const ok = runStartupStep('schema', () => { throw new Error('boom'); }, f => seen.push(f));

  assert.strictEqual(ok, false, 'the caller learns the step failed');
  assert.strictEqual(seen.length, 1, 'and it is reported exactly once');
  assert.strictEqual(seen[0].code, 'TVCM-START-SCHEMA');
  // The crucial property: startup continues rather than dying silently.
});

test('a successful step reports nothing and returns true', () => {
  const seen = [];
  let ran = false;
  const ok = runStartupStep('store', () => { ran = true; }, f => seen.push(f));

  assert.strictEqual(ok, true);
  assert.strictEqual(ran, true);
  assert.strictEqual(seen.length, 0);
});

test('every startup step has its own code; unknown steps still get one', () => {
  assert.strictEqual(describeStartupFailure('schema', new Error('x')).code, 'TVCM-START-SCHEMA');
  assert.strictEqual(describeStartupFailure('store', new Error('x')).code, 'TVCM-START-STORE');
  assert.strictEqual(describeStartupFailure('scheduler', new Error('x')).code, 'TVCM-START-SCHEDULER');
  assert.strictEqual(describeStartupFailure('something-new', new Error('x')).code, 'TVCM-START-UNKNOWN');
});

test('non-Error throws still produce a usable message', () => {
  for (const thrown of ['a string problem', null, undefined, 42]) {
    const f = describeStartupFailure('store', thrown);
    assert.ok(f.message.length > 0, `empty message for ${JSON.stringify(thrown)}`);
    assert.doesNotMatch(startupFailureText(f), /undefined|null\./);
  }
});
