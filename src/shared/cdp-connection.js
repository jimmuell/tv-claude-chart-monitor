'use strict';

/**
 * Keeping TVCM's connection to TradingView alive.
 *
 * TVCM-40 measured the failure this file exists to stop. From 19:04 on 2026-11-16 to
 * 09:3x the next morning the menu bar sat at +$40.25 while the broker held 57 fills and
 * $511.90. TradingView was fine; AMP was fine; a FRESH CDP connection worked first time.
 * TVCM's own client held a WebSocket in `readyState 3 (CLOSED)` and never replaced it,
 * because the one call that mattered was outside the try/catch that drops the connection:
 *
 *     export async function evalPage(expression) {
 *       try { await ensureConnected(); } catch (err) { connected = false; reader = null; throw err; }
 *       return reader.evalPage(expression);        // <- a rejection here changed nothing
 *     }
 *
 * `connected` stayed true, so `ensureConnected()` had nothing to do, forever. Only a full
 * app restart recovered it. The ⚠ was correct throughout — nothing stale was ever shown as
 * current — but a warning is not a recovery.
 *
 * This module is the policy, and only the policy: when a failure means the pipe is gone,
 * how long to wait before trying again, and when to say so. It holds no socket, imports
 * no CDP and reads no clock of its own, so every rule below is testable in milliseconds
 * rather than in hours of real outage.
 *
 * Two rules it will not bend:
 *
 *   1. **A transport failure always drops the connection.** Whatever the caller was doing,
 *      a dead pipe means the next call rebuilds. There is no state in which TVCM believes
 *      it is connected while the socket is closed.
 *   2. **One line per outage, not one per poll.** The feed polls every 5 seconds; a
 *      fourteen-hour outage is 10,000 polls. `TVCM-CDP-LOST` is emitted on the transition
 *      into an outage and `TVCM-CDP-RECOVERED` on the way out, and nothing in between.
 */

/** Waits between reconnection attempts, growing to a ceiling and then staying there. */
const BACKOFF_MS = [2_000, 4_000, 8_000, 16_000, 30_000];

/** The ceiling. Reconnection is attempted forever — it never gives up, only slows down. */
const MAX_BACKOFF_MS = 30_000;

const LOST_CODE      = 'TVCM-CDP-LOST';
const RECOVERED_CODE = 'TVCM-CDP-RECOVERED';

/**
 * Error text that means the pipe is gone rather than the page having said no.
 *
 * Deliberately matched on substrings: these come from three different layers (the `ws`
 * client, Node's socket, and CDP itself) and none of them carries a stable code.
 */
const TRANSPORT_SIGNS = [
  'websocket is not open',          // ws, the exact text of TVCM-40's outage
  'readystate 3',
  'websocket connection closed',
  'socket hang up',
  'econnrefused',
  'econnreset',
  'epipe',
  'etimedout',
  'not connected',                  // tv-reader's own guard
  'connection closed',
  'target closed',
  'inspected target navigated or closed',
  'no inspectable targets',
  'could not find a tradingview page target',
];

/** True when an error means the connection is gone, not that the page refused. */
function isTransportError(err) {
  if (!err) return false;
  const text = String(err.message || err).toLowerCase();
  return TRANSPORT_SIGNS.some(sign => text.includes(sign));
}

/** A fresh connection state, before anything has been tried. */
function createState(now) {
  return {
    state:         'idle',          // 'idle' | 'connected' | 'lost'
    since:         Number(now) || null,
    lostAt:        null,
    attempts:      0,
    nextAttemptAt: 0,
    lastError:     null,
  };
}

/** How long to wait before the next attempt: 2s, 4s, 8s, 16s, then 30s forever. */
function backoffFor(attempts) {
  const n = Math.max(0, Number(attempts) || 0);
  return n < BACKOFF_MS.length ? BACKOFF_MS[n] : MAX_BACKOFF_MS;
}

/** Whether a reconnection may be attempted yet, or the backoff still has time to run. */
function mayAttempt(state, now) {
  if (!state) return true;
  if (state.state === 'connected') return true;
  return (Number(now) || 0) >= (Number(state.nextAttemptAt) || 0);
}

/**
 * The connection is up. Returns the new state and the lines to log — one
 * TVCM-CDP-RECOVERED when this ends an outage, and nothing at all on a first connect,
 * which is not a recovery from anything.
 */
function noteConnected(state, now) {
  const at = Number(now) || 0;
  const was = state || createState(at);
  const events = [];
  if (was.state === 'lost') {
    const outage = was.lostAt == null ? null : at - was.lostAt;
    events.push({
      code: RECOVERED_CODE,
      outageMs: outage,
      message: `reconnected to TradingView${outage == null ? '' : ` after ${formatDuration(outage)}`}`,
    });
  }
  return {
    state: { state: 'connected', since: at, lostAt: null, attempts: 0, nextAttemptAt: 0, lastError: null },
    events,
  };
}

/**
 * The connection is gone. Returns the new state and the lines to log — one TVCM-CDP-LOST
 * on the way in, and silence for every failure after it, however many there are.
 */
function noteLost(state, now, error) {
  const at = Number(now) || 0;
  const was = state || createState(at);
  const message = error ? String(error.message || error) : 'the connection to TradingView was lost';
  const firstTime = was.state !== 'lost';
  const attempts = firstTime ? 0 : (Number(was.attempts) || 0) + 1;
  const events = [];
  if (firstTime) {
    events.push({ code: LOST_CODE, message: `lost the connection to TradingView — ${message}; reconnecting` });
  }
  return {
    state: {
      state:         'lost',
      since:         firstTime ? at : was.since,
      lostAt:        firstTime ? at : was.lostAt,
      attempts,
      nextAttemptAt: at + backoffFor(attempts),
      lastError:     message,
    },
    events,
  };
}

/** A duration as the shortest thing a human reads without counting zeros. */
function formatDuration(ms) {
  const s = Math.round((Number(ms) || 0) / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

/** One plain-English line about the connection, for a log or a status read-out. */
function describe(state, now) {
  const s = state || createState(now);
  if (s.state === 'connected') return 'connected to TradingView';
  if (s.state === 'idle')      return 'not connected to TradingView yet';
  const waiting = Math.max(0, (Number(s.nextAttemptAt) || 0) - (Number(now) || 0));
  return `lost the connection to TradingView — retrying in ${formatDuration(waiting)}`;
}

module.exports = {
  BACKOFF_MS, MAX_BACKOFF_MS, LOST_CODE, RECOVERED_CODE, TRANSPORT_SIGNS,
  isTransportError, createState, backoffFor, mayAttempt,
  noteConnected, noteLost, formatDuration, describe,
};
