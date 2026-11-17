'use strict';

/**
 * The one place TVCM's connection to TradingView is opened, used and rebuilt.
 *
 * Every reader — the live feed, pnl-reader, the analysis pipeline, the scheduler's bar
 * peek, the annotator — goes through `withReader()`. That is the whole point: TVCM-40's
 * fourteen-hour outage happened because ONE call site called the reader outside the
 * try/catch that drops a dead connection, and nothing else in the app could tell.
 *
 *     // before
 *     try { await ensureConnected(); } catch (e) { connected = false; reader = null; throw e; }
 *     return reader.evalPage(expression);   // a rejection here changed nothing, forever
 *
 * With one entry point there is no second place to forget. The policy — what counts as a
 * dead pipe, how long to wait, when to log — lives in cdp-connection.js; this file owns
 * the socket and nothing else.
 *
 * Electron-free on purpose: `createReader`, the config and the clock are all injected, so
 * the real manager can be driven against a fake CDP target in a test rather than only
 * against TradingView.
 */

const conn = require('./cdp-connection.js');

/** How often to re-check that the attached target is still the live TradingView page. */
const DEFAULT_TARGET_CHECK_MS = 30_000;

/**
 * Builds a connection manager. `createReader(config, logger)` makes the CDP client;
 * `config()` is re-read on every connect so a hot-edited port takes effect.
 */
function createCdpManager(options) {
  const opts = options || {};
  const makeReader = opts.createReader;
  const readConfig = opts.config || (() => ({}));
  const logger = opts.logger || console;
  const now = opts.now || (() => Date.now());
  const targetCheckMs = opts.targetCheckMs == null ? DEFAULT_TARGET_CHECK_MS : opts.targetCheckMs;
  const onStatus = opts.onStatus || (() => {});

  let reader = null;
  let connected = false;
  let state = conn.createState(now());
  let targetCheckedAt = 0;

  /** Logs the one line an outage or a recovery is allowed, and nothing per poll. */
  function emit(events) {
    for (const e of events) logger.info(`[cdp] ${e.code}: ${e.message}`);
  }

  /** Drops the socket and records the outage, so the next call rebuilds the connection. */
  function markLost(err) {
    const r = conn.noteLost(state, now(), err);
    state = r.state;
    connected = false;
    const dying = reader;
    reader = null;
    if (dying && typeof dying.disconnect === 'function') {
      Promise.resolve().then(() => dying.disconnect()).catch(() => {});
    }
    emit(r.events);
  }

  /**
   * Occasionally confirms the attached target is still the live TradingView page. A
   * reload that keeps the same target needs nothing; a page that was REPLACED leaves this
   * reader talking to a window that no longer exists, and only a new connection fixes it.
   */
  async function verifyTarget() {
    const at = now();
    if (at - targetCheckedAt < targetCheckMs) return;
    targetCheckedAt = at;
    if (!reader || typeof reader.liveTargetId !== 'function' || typeof reader.targetId !== 'function') return;
    try {
      const live = await reader.liveTargetId();
      const mine = reader.targetId();
      if (live && mine && live !== mine) {
        markLost(new Error('Inspected target navigated or closed — TradingView opened a new page'));
      }
    } catch (err) {
      // A listing that fails is itself a dead pipe; anything else is left alone.
      if (conn.isTransportError(err)) markLost(err);
    }
  }

  /** Opens the connection if it is not up, respecting the backoff after an outage. */
  async function ensureConnected() {
    if (connected && reader) {
      await verifyTarget();
      if (connected) return;
    }
    if (!conn.mayAttempt(state, now())) {
      throw new Error(conn.describe(state, now()));
    }
    if (!reader) {
      reader = makeReader(readConfig(), logger);
      if (typeof reader.onDisconnect === 'function') {
        // Only the first close of a connection we still believe in is news; a socket we
        // have already given up on closing again is not.
        reader.onDisconnect(() => { if (connected) markLost(new Error('WebSocket connection closed')); });
      }
    }
    if (!connected) {
      onStatus('Connecting to TradingView...');
      try {
        await reader.connect();
        connected = true;
        targetCheckedAt = now();
        const r = conn.noteConnected(state, now());
        state = r.state;
        emit(r.events);
      } catch (err) {
        markLost(err);
        throw err;
      }
    }
  }

  /** Runs one call against the reader, with the connection managed around it. */
  async function withReader(fn) {
    await ensureConnected();
    try {
      return await fn(reader);
    } catch (err) {
      if (conn.isTransportError(err)) markLost(err);
      throw err;
    }
  }

  /** Throws the connection away deliberately — a port change, not an outage. */
  function reset() {
    const dying = reader;
    reader = null;
    connected = false;
    state = conn.createState(now());
    targetCheckedAt = 0;
    if (dying && typeof dying.disconnect === 'function') {
      Promise.resolve().then(() => dying.disconnect()).catch(() => {});
    }
  }

  /** Closes the connection on shutdown, leaving nothing to reconnect. */
  async function close() {
    const dying = reader;
    reader = null;
    connected = false;
    if (dying && typeof dying.disconnect === 'function') {
      try { await dying.disconnect(); } catch { /* already gone */ }
    }
  }

  return {
    withReader,
    ensureConnected,
    reset,
    close,
    /** True only when a socket is believed to be open right now. */
    isConnected: () => connected,
    /** The connection's state plus a sentence describing it, for the tooltip. */
    status: () => ({ ...state, connected, description: conn.describe(state, now()) }),
    /** The reader itself, for the few callers that legitimately hold it between calls. */
    peekReader: () => reader,
  };
}

module.exports = { createCdpManager, DEFAULT_TARGET_CHECK_MS };
