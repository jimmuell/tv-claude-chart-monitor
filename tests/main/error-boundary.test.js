'use strict';

// Known-positive for the blank-panel fix: force a render throw and prove the
// panel shows an error card instead of nothing, and that TVCM-UI-RENDER plus
// the component stack ends up in the always-on log file.
//
// The boundary is a .tsx file in the renderer bundle, so it is transpiled here
// with esbuild rather than read from dist/ (which only holds the main process).

const test    = require('node:test');
const assert  = require('node:assert');
const fs      = require('fs');
const os      = require('os');
const path    = require('path');
const Module  = require('module');
const esbuild = require('esbuild');

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'tvcm-eb-'));
const originalLoad = Module._load;
Module._load = function (request) {
  if (request === 'electron') return { app: { getPath: () => userData } };
  return originalLoad.apply(this, arguments);
};

const React        = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const logger       = require(path.join(__dirname, '../../dist/main/main/logger'));

/** Compile the real ErrorBoundary.tsx and hand back its exports. */
function loadBoundary() {
  const file = path.join(__dirname, '../../src/renderer/ErrorBoundary.tsx');
  const { code } = esbuild.transformSync(fs.readFileSync(file, 'utf8'), {
    loader: 'tsx', format: 'cjs', target: 'node18',
  });
  const mod = { exports: {} };
  new Function('require', 'module', 'exports', code)(require, mod, mod.exports);
  return mod.exports.ErrorBoundary;
}

const ErrorBoundary = loadBoundary();

/** A boundary instance with setState stubbed, since nothing is mounted here. */
function makeInstance(props) {
  const inst = new ErrorBoundary(props);
  inst.setState = (patch) => { inst.state = { ...inst.state, ...patch }; };
  return inst;
}

test('with no error the boundary is transparent — children render untouched', () => {
  const inst = makeInstance({ section: 'analysis card', children: 'THE REAL CARD' });
  assert.strictEqual(inst.render(), 'THE REAL CARD');
});

test('a render throw swaps in the error card instead of a blank panel', () => {
  const state = ErrorBoundary.getDerivedStateFromError(new Error('boom'));
  assert.ok(state.error instanceof Error, 'the boundary must capture the error');
  assert.ok(state.at, 'the card must carry the time it failed');

  const inst = makeInstance({ section: 'analysis card', children: 'THE REAL CARD' });
  inst.state = { error: new Error('Cannot read properties of undefined'), stack: '', at: '07:30:00' };
  const html = renderToStaticMarkup(inst.render());

  assert.ok(html.includes('TVCM-UI-RENDER'), 'the card must show the error code');
  assert.ok(html.includes('07:30:00'), 'the card must show the time');
  assert.ok(html.includes('Reload panel'), 'the card must offer a reload');
  assert.ok(html.includes('analysis card'), 'the card must name the section that failed');
  assert.ok(!html.includes('THE REAL CARD'), 'the throwing children must not be rendered');
  assert.ok(html.length > 0, 'the panel is not blank');
});

test('TVCM-UI-RENDER and the component stack reach the log file', () => {
  // Silence the console first, then let the logger wrap it, so the forced
  // error is written to the file without polluting the test output.
  console.error = () => {};
  logger.initLogger();

  const inst = makeInstance({ section: 'analysis card', children: null });
  const err  = new Error('Cannot read properties of undefined (reading \'toFixed\')');
  inst.componentDidCatch(err, { componentStack: '\n    at CommentaryCard\n    at App' });

  const text = fs.readFileSync(logger.logFilePath(), 'utf8');
  assert.ok(text.includes('TVCM-UI-RENDER'), 'the code must be in the log');
  assert.ok(text.includes('analysis card'), 'the failing section must be in the log');
  assert.ok(text.includes("reading 'toFixed'"), 'the error message must be in the log');
  assert.ok(text.includes('component stack:'), 'the component stack must be in the log');
  assert.ok(text.includes('at CommentaryCard'), 'the stack frames must be in the log');
});

test('the component stack is recorded on state so a retry can show it', () => {
  const inst = makeInstance({ section: 'panel', children: null });
  inst.componentDidCatch(new Error('x'), { componentStack: '\n    at Thing' });
  assert.ok(inst.state.stack.includes('at Thing'));
});
