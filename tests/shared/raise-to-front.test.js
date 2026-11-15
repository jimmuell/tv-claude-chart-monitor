'use strict';

// Bringing a window in front of every other app. The order of the calls is the whole
// behaviour, so that is what these assert — against a fake window, with no Electron.

const test   = require('node:test');
const assert = require('node:assert');
const path   = require('path');

const { raiseToFront, RAISE_SETTLE_MS } =
  require(path.join(__dirname, '../../src/shared/raise-to-front.js'));

/** A BrowserWindow stand-in that records every call made to it, in order. */
function fakeWindow({ minimized = false, alwaysOnTop = false, destroyed = false } = {}) {
  const calls = [];
  return {
    calls,
    isMinimized:    () => minimized,
    isAlwaysOnTop:  () => alwaysOnTop,
    isDestroyed:    () => destroyed,
    destroy()       { destroyed = true; },
    restore()       { minimized = false; calls.push('restore'); },
    setAlwaysOnTop(on, level) { alwaysOnTop = on; calls.push(`setAlwaysOnTop(${on}${level ? ',' + level : ''})`); },
    show()          { calls.push('show'); },
    focus()         { calls.push('focus'); },
  };
}

/** Runs raiseToFront with a schedule the test drives by hand instead of a real timer. */
function raise(win, opts = {}) {
  const deferred = [];
  const activations = [];
  raiseToFront(win, () => activations.push('activate'), {
    schedule: (fn, ms) => deferred.push({ fn, ms }),
    ...opts,
  });
  return { deferred, activations, settle: () => deferred.forEach(d => d.fn()) };
}

test('the window is lifted above every other app BEFORE it is shown', () => {
  const win = fakeWindow();
  raise(win);
  assert.deepStrictEqual(win.calls, ['setAlwaysOnTop(true,floating)', 'show', 'focus']);
});

test('activation is still requested, after the window is in front', () => {
  const win = fakeWindow();
  const { activations } = raise(win);
  assert.deepStrictEqual(activations, ['activate'],
    'keyboard focus still needs the app to be activated');
});

test('the window goes back to being an ordinary one once it is in front', () => {
  const win = fakeWindow();
  const r = raise(win);
  assert.ok(!win.calls.includes('setAlwaysOnTop(false)'), 'dropped the level too early');
  assert.strictEqual(r.deferred.length, 1);
  assert.strictEqual(r.deferred[0].ms, RAISE_SETTLE_MS);
  r.settle();
  assert.strictEqual(win.calls[win.calls.length - 1], 'setAlwaysOnTop(false)');
  assert.strictEqual(win.isAlwaysOnTop(), false, 'the window must not stay pinned on top');
});

test('a minimized window is restored first, or show() would leave it in the Dock', () => {
  const win = fakeWindow({ minimized: true });
  raise(win);
  assert.strictEqual(win.calls[0], 'restore');
  assert.deepStrictEqual(win.calls, ['restore', 'setAlwaysOnTop(true,floating)', 'show', 'focus']);
});

test('a window the user pinned on top is left pinned', () => {
  const win = fakeWindow({ alwaysOnTop: true });
  const r = raise(win);
  assert.deepStrictEqual(win.calls, ['show', 'focus'], 'a pinned window needs no lifting');
  assert.strictEqual(r.deferred.length, 0, 'nothing may unpin a window the user pinned');
  r.settle();
  assert.strictEqual(win.isAlwaysOnTop(), true);
});

test('a window destroyed before the level is restored is left alone', () => {
  const win = fakeWindow();
  const r = raise(win);
  const before = win.calls.length;
  win.destroy();
  assert.doesNotThrow(() => r.settle());
  assert.strictEqual(win.calls.length, before, 'a destroyed window was still called');
});

test('a destroyed window is not raised at all', () => {
  const win = fakeWindow({ destroyed: true });
  const { activations, deferred } = raise(win);
  assert.deepStrictEqual(win.calls, []);
  assert.deepStrictEqual(activations, []);
  assert.strictEqual(deferred.length, 0);
});

test('a missing window is survivable, not a crash in a menu handler', () => {
  assert.doesNotThrow(() => raiseToFront(null, () => {}, { schedule: () => {} }));
  assert.doesNotThrow(() => raiseToFront(undefined, () => {}, { schedule: () => {} }));
});

test('no activate callback is not a crash either', () => {
  const win = fakeWindow();
  assert.doesNotThrow(() => raiseToFront(win, null, { schedule: () => {} }));
  assert.ok(win.calls.includes('show'), 'the window must still come forward');
});

test('the settle delay is short enough not to be seen and long enough to land', () => {
  assert.ok(RAISE_SETTLE_MS > 0 && RAISE_SETTLE_MS <= 1000, `RAISE_SETTLE_MS=${RAISE_SETTLE_MS}`);
});

test('a real timer is used when no schedule is injected', async () => {
  const win = fakeWindow();
  raiseToFront(win, () => {}, { settleMs: 1 });
  await new Promise(r => setTimeout(r, 30));
  assert.ok(win.calls.includes('setAlwaysOnTop(false)'), 'the default schedule never fired');
});
