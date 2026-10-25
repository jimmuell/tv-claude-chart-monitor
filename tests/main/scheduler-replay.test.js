'use strict';

// The replay throttle (TVCM-9 defect 4).
//
// When an analysis fails in Bar Replay BEFORE the first successful one, the
// scheduler used to fall back to the live bar-close interval — 120s on a
// 2-minute chart — instead of the 3-second replay poll. One early failure
// (common right after seeking, while the chart is still loading) therefore
// throttled replay to roughly one analysis per bar length.

const test   = require('node:test');
const assert = require('node:assert');
const path   = require('path');
const Module = require('module');

const DIST_DIR = path.join(__dirname, '../../dist/main/main');

// Controllable bridge stand-ins.
let analysisImpl = async () => { throw new Error('not set'); };
let barStateImpl = async () => null;

const originalLoad = Module._load;
Module._load = function (request, parent) {
  if (request === 'electron') return { app: {}, ipcMain: { handle: () => {}, on: () => {} } };
  if (parent && parent.filename && path.dirname(parent.filename).startsWith(DIST_DIR)) {
    if (path.resolve(path.dirname(parent.filename), request) === path.join(DIST_DIR, 'bridge')) {
      return {
        runAnalysis:   (...a) => analysisImpl(...a),
        peekBarState:  (...a) => barStateImpl(...a),
        setStatusCallback: () => {},
      };
    }
  }
  return originalLoad.apply(this, arguments);
};

const { Scheduler } = require(path.join(DIST_DIR, 'scheduler'));

/** Capture what delay the scheduler asks for, without actually waiting. */
function withCapturedTimers(fn) {
  const realSetTimeout = global.setTimeout;
  const delays = [];
  global.setTimeout = (cb, ms) => { delays.push(ms); return realSetTimeout(() => {}, 0); };
  try { return fn(delays); } finally { global.setTimeout = realSetTimeout; }
}

const flush = () => new Promise(r => setImmediate(r));

test('a failed analysis in replay retries on the 3s replay poll, not the live interval', async () => {
  analysisImpl = async () => { throw new Error('Not enough bar data to build context'); };
  barStateImpl = async () => ({ replayMode: true, closedBarTime: 1000, lastBarTime: 1060 });

  const delays = [];
  const realSetTimeout = global.setTimeout;
  global.setTimeout = (cb, ms) => { delays.push(ms); return realSetTimeout(() => {}, 0); };
  try {
    const s = new Scheduler(() => {}, () => {}, () => {}, () => {});
    s.start();                       // start() executes immediately
    for (let i = 0; i < 8; i++) await flush();
    s.stop();
  } finally { global.setTimeout = realSetTimeout; }

  assert.ok(delays.length > 0, 'the scheduler rescheduled after the failure');
  assert.ok(delays.includes(3000),
    `expected a 3000ms replay poll, got ${JSON.stringify(delays)}`);
  assert.ok(!delays.some(d => d >= 60000),
    `must NOT fall back to a bar-length interval, got ${JSON.stringify(delays)}`);
});

test('a failed analysis in LIVE mode still backs off to the normal interval', async () => {
  // The fix must not make live mode retry every 3 seconds — that would hammer
  // the LLM on every transient error.
  analysisImpl = async () => { throw new Error('CDP eval failed'); };
  barStateImpl = async () => ({ replayMode: false, closedBarTime: 1000, lastBarTime: 1060 });

  const delays = [];
  const realSetTimeout = global.setTimeout;
  global.setTimeout = (cb, ms) => { delays.push(ms); return realSetTimeout(() => {}, 0); };
  try {
    const s = new Scheduler(() => {}, () => {}, () => {}, () => {});
    s.start();
    for (let i = 0; i < 8; i++) await flush();
    s.stop();
  } finally { global.setTimeout = realSetTimeout; }

  assert.ok(delays.length > 0, 'it rescheduled');
  assert.ok(!delays.includes(3000) || delays.some(d => d > 3000),
    `live mode must not settle on the 3s replay cadence: ${JSON.stringify(delays)}`);
});

test('a successful replay analysis keeps the replay cadence', async () => {
  analysisImpl = async () => ({
    symbol: 'CME_MINI:MES1!', timeframe: '2', closedBarPrice: 100,
    barCloseMs: 0, replayMode: true, closedBarTime: 2000,
    commentary: { setup_verdict: 'wait', confidence: 0.5 },
  });
  barStateImpl = async () => ({ replayMode: true, closedBarTime: 2000, lastBarTime: 2120 });

  const delays = [];
  const realSetTimeout = global.setTimeout;
  global.setTimeout = (cb, ms) => { delays.push(ms); return realSetTimeout(() => {}, 0); };
  try {
    const s = new Scheduler(() => {}, () => {}, () => {}, () => {});
    s.start();
    for (let i = 0; i < 8; i++) await flush();
    s.stop();
  } finally { global.setTimeout = realSetTimeout; }

  assert.ok(delays.includes(3000), `expected the 3s replay poll, got ${JSON.stringify(delays)}`);
});
