'use strict';

// The policy that keeps TVCM's connection to TradingView alive.
//
// Every fixture is SYNTHETIC, but the error texts are the real ones: "WebSocket is not
// open: readyState 3 (CLOSED)" is verbatim what TVCM-40 found in the log of an app that
// had been blind for fourteen and a half hours.

const test   = require('node:test');
const assert = require('node:assert');
const path   = require('path');

const c = require(path.join(__dirname, '../../src/shared/cdp-connection.js'));

const T0 = 1_000_000;
const SEC = 1000;

// ── What counts as a dead pipe ───────────────────────────────────────────

test('the error TVCM-40 actually saw is recognised as a dead pipe', () => {
  assert.strictEqual(c.isTransportError(new Error('WebSocket is not open: readyState 3 (CLOSED)')), true);
});

test('every layer that can drop the connection is recognised', () => {
  for (const text of [
    'connect ECONNREFUSED 127.0.0.1:9222',
    'read ECONNRESET',
    'socket hang up',
    'write EPIPE',
    'WebSocket connection closed',
    'Inspected target navigated or closed',
    'No inspectable targets',
    'Not connected. Call connect() first.',
    'Could not find a TradingView page target via CDP.',
  ]) {
    assert.strictEqual(c.isTransportError(new Error(text)), true, text);
  }
});

test('a page that merely said no is NOT a dead pipe', () => {
  // These must not drop the socket: the connection is fine, the answer was not.
  for (const text of [
    'CDP eval failed: TypeError: Cannot read properties of undefined (reading ‘id’)',
    'TVCM-LF-NO-BROKER-OBJECT',
    'setStudyInputs: studyId is required',
    'Object reference chain is too long',
  ]) {
    assert.strictEqual(c.isTransportError(new Error(text)), false, text);
  }
  assert.strictEqual(c.isTransportError(null), false);
  assert.strictEqual(c.isTransportError(undefined), false);
});

// ── One line per outage, not one per poll ────────────────────────────────

test('an outage logs once on the way in and once on the way out', () => {
  let s = c.createState(T0);
  const lost = c.noteLost(s, T0, new Error('WebSocket is not open: readyState 3 (CLOSED)'));
  s = lost.state;
  assert.deepStrictEqual(lost.events.map(e => e.code), [c.LOST_CODE]);
  assert.match(lost.events[0].message, /readyState 3/);

  // The feed polls every 5s. Fourteen hours of that is ten thousand failures.
  for (let n = 1; n <= 10_000; n++) {
    const again = c.noteLost(s, T0 + n * 5 * SEC, new Error('WebSocket is not open: readyState 3 (CLOSED)'));
    s = again.state;
    assert.deepStrictEqual(again.events, [], `poll ${n} must say nothing`);
  }

  const back = c.noteConnected(s, T0 + 14 * 3600 * SEC);
  assert.deepStrictEqual(back.events.map(e => e.code), [c.RECOVERED_CODE]);
  assert.match(back.events[0].message, /14h 0m/);
});

test('a first connection is not a recovery from anything', () => {
  const first = c.noteConnected(c.createState(T0), T0);
  assert.deepStrictEqual(first.events, []);
  assert.strictEqual(first.state.state, 'connected');
});

test('recovery reports how long the outage lasted', () => {
  const lost = c.noteLost(c.createState(T0), T0, new Error('socket hang up'));
  const back = c.noteConnected(lost.state, T0 + 49 * SEC);
  assert.strictEqual(back.events[0].outageMs, 49 * SEC);
  assert.match(back.events[0].message, /after 49s/);
});

// ── Backoff: it slows down, it never gives up ────────────────────────────

test('the wait grows and then stops growing', () => {
  assert.deepStrictEqual([0, 1, 2, 3, 4].map(c.backoffFor), [2000, 4000, 8000, 16000, 30000]);
});

test('it keeps trying forever at the ceiling, never stopping', () => {
  for (const n of [5, 50, 10_000, 1_000_000]) {
    assert.strictEqual(c.backoffFor(n), c.MAX_BACKOFF_MS, `attempt ${n} must still be allowed`);
  }
});

test('an attempt is refused until its backoff has run, then allowed', () => {
  const lost = c.noteLost(c.createState(T0), T0, new Error('ECONNRESET'));
  assert.strictEqual(c.mayAttempt(lost.state, T0 + 1 * SEC), false);
  assert.strictEqual(c.mayAttempt(lost.state, T0 + 2 * SEC), true, 'the first retry is 2s away');
});

test('a connected state never waits — a call must never be delayed by backoff', () => {
  const up = c.noteConnected(c.createState(T0), T0);
  assert.strictEqual(c.mayAttempt(up.state, T0), true);
  assert.strictEqual(c.mayAttempt(null, T0), true, 'nothing known yet means try');
});

test('each failure pushes the next attempt further out', () => {
  let s = c.noteLost(c.createState(T0), T0, new Error('x')).state;
  assert.strictEqual(s.nextAttemptAt, T0 + 2000);
  s = c.noteLost(s, T0 + 2000, new Error('x')).state;
  assert.strictEqual(s.nextAttemptAt, T0 + 2000 + 4000);
  s = c.noteLost(s, T0 + 6000, new Error('x')).state;
  assert.strictEqual(s.nextAttemptAt, T0 + 6000 + 8000);
});

test('recovering resets the backoff, so the next outage starts fast again', () => {
  let s = c.createState(T0);
  for (let n = 0; n < 6; n++) s = c.noteLost(s, T0 + n * SEC, new Error('x')).state;
  assert.strictEqual(c.backoffFor(s.attempts), c.MAX_BACKOFF_MS);
  s = c.noteConnected(s, T0 + 60 * SEC).state;
  assert.strictEqual(s.attempts, 0);
  s = c.noteLost(s, T0 + 61 * SEC, new Error('x')).state;
  assert.strictEqual(s.nextAttemptAt - (T0 + 61 * SEC), 2000, 'back to a 2-second first retry');
});

// ── The state itself ─────────────────────────────────────────────────────

test('an outage remembers when it started, across every later failure', () => {
  let s = c.noteLost(c.createState(T0), T0, new Error('x')).state;
  assert.strictEqual(s.lostAt, T0);
  for (let n = 1; n < 50; n++) s = c.noteLost(s, T0 + n * 5 * SEC, new Error('x')).state;
  assert.strictEqual(s.lostAt, T0, 'the tooltip must say when it went, not when it last tried');
});

test('a connected state has nothing to apologise for', () => {
  const s = c.noteConnected(c.createState(T0), T0).state;
  assert.strictEqual(s.lostAt, null);
  assert.strictEqual(s.lastError, null);
  assert.strictEqual(s.attempts, 0);
});

test('the description says what is happening, in words', () => {
  assert.match(c.describe(c.createState(T0), T0), /not connected/);
  assert.match(c.describe(c.noteConnected(c.createState(T0), T0).state, T0), /^connected/);
  const lost = c.noteLost(c.createState(T0), T0, new Error('x')).state;
  assert.match(c.describe(lost, T0), /retrying in 2s/);
});

test('durations read the way a person says them', () => {
  assert.strictEqual(c.formatDuration(0), '0s');
  assert.strictEqual(c.formatDuration(49 * SEC), '49s');
  assert.strictEqual(c.formatDuration(5 * 60 * SEC), '5m');
  assert.strictEqual(c.formatDuration(14.5 * 3600 * SEC), '14h 30m');
});
