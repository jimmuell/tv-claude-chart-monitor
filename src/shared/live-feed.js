'use strict';

/**
 * The live order feed: TradingView's own execution list, read over CDP instead of
 * waiting for a CSV export.
 *
 * TVCM-25 established the route. `_tradingService.trading()._activeBroker.allExecutions()`
 * returns every fill the account has — with an epoch-millisecond time, price, qty, side,
 * orderId and pointValue — with no tab switch, nothing drawn on screen and no focus steal.
 * This module is the pure half of that: broker gating, shape detection and the conversion
 * into the fills the TVCM-13/17 engine already prices. No CDP, no Electron, no timers.
 *
 * Two things were measured on the PAPER broker only and must be treated as unproven:
 *
 *   1. That `allExecutions()` refreshes by itself when a new fill arrives. The market was
 *      shut, so it could not be observed. `scripts/check-live-feed.js` exists to settle it
 *      on the first live session.
 *   2. That the AMP adapter has the same shape. It is a different implementation — the two
 *      brokers already emit different CSV schemas — so every read is shape-checked and a
 *      surprise is reported as "can't read this TradingView version", never guessed past.
 *
 * Commission is null on paper and is not trusted anywhere: fees come from the configured
 * per-contract-side rate, exactly as the CSV path computes them.
 */

const { chicagoParts, nextDay, SESSION_ROLLOVER_HOUR } = require('./session-clock.js');
const { analyseFills, DEFAULT_PER_CONTRACT_SIDE_FEE, MES_POINT_VALUE } = require('./order-history.js');

/** `_brokerId` values this build knows how to read, and the one it must refuse. */
const BROKER_LIVE   = 'amp';
const BROKER_PAPER  = 'paper';
const BROKER_REPLAY = 'replaybroker';

/** Fields the conversion cannot work without. A missing one means a build we cannot read. */
const REQUIRED_EXECUTION_FIELDS = ['id', 'orderId', 'symbol', 'side', 'qty', 'price', 'time'];

/** Which fields must be numbers, so a string price cannot silently become NaN later. */
const NUMERIC_EXECUTION_FIELDS = ['qty', 'price', 'time'];

/** How many executions to inspect when judging the shape — enough to catch a bad build. */
const SHAPE_SAMPLE = 5;

/**
 * Whether the feed may read right now, given TradingView's broker and the paper toggle.
 * Replay is "not available", not a fault; a mismatch or an unrecognised broker is a fault
 * and must reach the menu bar, because the alternative is showing the wrong account's money.
 */
function brokerAvailability(brokerId, paperMode) {
  const want = paperMode ? BROKER_PAPER : BROKER_LIVE;
  const wantLabel = paperMode ? 'Paper Trading' : 'AMP Live';

  if (brokerId === null || brokerId === undefined || brokerId === '') {
    return {
      available: false, state: 'absent', warn: true,
      errorCode: 'TVCM-LF-NO-BROKER',
      reason: 'TradingView has no broker connected',
      switchHint: `Connect ${wantLabel} in TradingView's bottom panel.`,
    };
  }
  if (brokerId === want) {
    return { available: true, state: 'ok', warn: false, errorCode: null, reason: null, switchHint: null };
  }
  if (brokerId === BROKER_REPLAY) {
    return {
      available: false, state: 'replay', warn: false, errorCode: null,
      reason: 'not available in replay — TradingView is in Bar Replay',
      switchHint: 'Leave Bar Replay to resume the live feed.',
    };
  }
  if (brokerId === BROKER_LIVE || brokerId === BROKER_PAPER) {
    const onPaper = brokerId === BROKER_PAPER;
    return {
      available: false, state: 'mismatch', warn: true,
      errorCode: 'TVCM-LF-ACCOUNT-MISMATCH',
      reason: onPaper
        ? 'TradingView is on Paper Trading but Paper mode is off'
        : 'TradingView is on AMP Live but Paper mode is on',
      switchHint: onPaper
        ? 'Turn Paper mode on, or switch TradingView to AMP Live.'
        : 'Turn Paper mode off, or switch TradingView to Paper Trading.',
    };
  }
  return {
    available: false, state: 'unknown', warn: true,
    errorCode: 'TVCM-LF-UNKNOWN-BROKER',
    reason: `unrecognised TradingView broker "${brokerId}"`,
    switchHint: `TVCM reads only AMP Live and Paper Trading. Switch to ${wantLabel}.`,
  };
}

/**
 * Checks that an execution list looks like the one TVCM-25 measured. An empty list is
 * accepted — a flat day is normal and says nothing about the build.
 */
function detectExecutionShape(executions) {
  if (!Array.isArray(executions)) {
    return { ok: false, notAnArray: true, missing: [], badTypes: [], sampled: 0 };
  }
  const sample = executions.slice(0, SHAPE_SAMPLE);
  const missing = new Set();
  const badTypes = new Set();
  let pointValueMissing = false;

  for (const e of sample) {
    if (!e || typeof e !== 'object') { badTypes.add('<execution>'); continue; }
    for (const f of REQUIRED_EXECUTION_FIELDS) {
      if (!(f in e) || e[f] === null || e[f] === undefined) { missing.add(f); continue; }
      if (NUMERIC_EXECUTION_FIELDS.includes(f) && typeof e[f] !== 'number') badTypes.add(f);
    }
    if (e.pointValue === undefined || e.pointValue === null) pointValueMissing = true;
  }
  return {
    ok: missing.size === 0 && badTypes.size === 0,
    notAnArray: false,
    missing: Array.from(missing),
    badTypes: Array.from(badTypes),
    pointValueMissing,
    sampled: sample.length,
  };
}

/** "YYYY-MM-DD HH:MM:SS" Chicago wall clock, the only stamp format the engine reads. */
function chicagoStamp(epochMs) {
  const p = chicagoParts(epochMs);
  const pad = (n) => String(n).padStart(2, '0');
  return `${p.date} ${pad(p.hour)}:${pad(p.minute)}:${pad(p.second)}`;
}

/** The session a Chicago wall-clock instant belongs to, named for the day it ends. */
function sessionDateForEpoch(epochMs) {
  const p = chicagoParts(epochMs);
  return p.hour >= SESSION_ROLLOVER_HOUR ? nextDay(p.date) : p.date;
}

/** 1 and -1 are the only side encodings TradingView uses; anything else is not guessed. */
function decodeSide(side) {
  if (side === 1) return 'Buy';
  if (side === -1) return 'Sell';
  return null;
}

/**
 * Turns executions into the fills the engine prices.
 *
 * Executions are PER FILL, so one order that filled 2 then 3 arrives as two records. The
 * CSV reports that same order as ONE row — quantity 5 at the average fill price, stamped
 * when the order finished. They are aggregated per order here for exactly that reason: it
 * makes a feed fill structurally identical to a CSV fill, so the engine's dedupe-by-order
 * works across both sources and the two paths cannot disagree about what a row is.
 */
function executionsToFills(executions, options) {
  const opts = options || {};
  const source = opts.source || 'live-feed';
  const skipped = [];
  const seenExecutions = new Set();
  const byOrder = new Map();

  for (const e of (Array.isArray(executions) ? executions : [])) {
    const note = (reason) => skipped.push({ reason, executionId: e && e.id, orderId: e && e.orderId, source });
    if (!e || typeof e !== 'object') { note('TVCM-LF-BAD-EXECUTION: not an object'); continue; }

    // A poll returns the whole list, so the same execution arrives every time. Counting it
    // once per id is what stops a 5-second poll multiplying the day's size by 12 a minute.
    const execId = String(e.id == null ? '' : e.id);
    if (!execId) { note('TVCM-LF-BAD-EXECUTION: no execution id, cannot dedupe'); continue; }
    if (seenExecutions.has(execId)) continue;
    seenExecutions.add(execId);

    const orderId = String(e.orderId == null ? '' : e.orderId).trim();
    if (!orderId) { note('TVCM-LF-BAD-EXECUTION: no order id'); continue; }

    const side = decodeSide(e.side);
    if (!side) { note(`TVCM-LF-BAD-EXECUTION: unrecognised side ${JSON.stringify(e.side)}`); continue; }

    const qty = Number(e.qty);
    if (!Number.isFinite(qty) || qty <= 0) { note(`TVCM-LF-BAD-EXECUTION: unusable qty ${JSON.stringify(e.qty)}`); continue; }

    const price = Number(e.price);
    if (!Number.isFinite(price)) { note(`TVCM-LF-BAD-EXECUTION: unusable price ${JSON.stringify(e.price)}`); continue; }

    const time = Number(e.time);
    if (!Number.isFinite(time) || time <= 0) { note(`TVCM-LF-BAD-EXECUTION: unusable time ${JSON.stringify(e.time)}`); continue; }

    let agg = byOrder.get(orderId);
    if (!agg) {
      agg = { orderId, symbol: String(e.symbol || ''), side, qty: 0, notional: 0, lastTime: time, mixedSide: false };
      byOrder.set(orderId, agg);
    }
    // One order cannot be both bought and sold; a payload claiming so is not understood.
    if (agg.side !== side) { agg.mixedSide = true; continue; }
    agg.qty      += qty;
    agg.notional += qty * price;
    if (time > agg.lastTime) agg.lastTime = time;
  }

  const fills = [];
  for (const agg of byOrder.values()) {
    if (agg.mixedSide) {
      skipped.push({ reason: 'TVCM-LF-BAD-EXECUTION: one order reported both sides', orderId: agg.orderId, source });
      continue;
    }
    fills.push({
      orderId:     agg.orderId,
      symbol:      agg.symbol,
      side:        agg.side,
      qty:         agg.qty,
      price:       agg.notional / agg.qty,
      fillTime:    chicagoStamp(agg.lastTime),
      sessionDate: sessionDateForEpoch(agg.lastTime),
      status:      'Filled',
      orderType:   '',
      source,
      line:        0,
    });
  }
  return { fills, skipped };
}

/** Executions straight through the statement-proven engine — same sessions, FIFO and fees. */
function analyseExecutions(executions, options) {
  const opts = options || {};
  const { fills, skipped } = executionsToFills(executions, opts);
  return analyseFills(fills, {
    pointValue:         opts.pointValue == null ? MES_POINT_VALUE : opts.pointValue,
    perContractSideFee: opts.perContractSideFee == null ? DEFAULT_PER_CONTRACT_SIDE_FEE : opts.perContractSideFee,
    skipped,
    errors: [],
  });
}

/**
 * The page expression the reader evaluates. The broker id is read in the SAME expression
 * as the executions, so the gate cannot go stale between two round trips — the account
 * could change in the gap. It returns a JSON string because returning live broker objects
 * by value makes CDP fail with "Object reference chain is too long" (TVCM-25).
 *
 * It calls only `trading()`, `_activeBroker`, `allExecutions()`, `positions()` and
 * `currentAccount()`. Nothing here can place, modify or cancel an order.
 */
function liveFeedExpression() {
  return `(async () => {
  const out = { ts: Date.now() };
  try {
    const api = window.TradingViewApi;
    const ci = api && api._chartApiInstance;
    out.brokerId = ci ? (ci._brokerId == null ? null : ci._brokerId) : null;
    if (!api || !api._tradingService || typeof api._tradingService.trading !== 'function') {
      out.error = 'TVCM-LF-NO-API';
      return JSON.stringify(out);
    }
    let trading = api._tradingService.trading();
    if (trading && typeof trading.then === 'function') trading = await trading;
    const broker = trading && trading._activeBroker;
    if (!broker || typeof broker.allExecutions !== 'function') {
      out.error = 'TVCM-LF-NO-API';
      return JSON.stringify(out);
    }
    out.account = typeof broker.currentAccount === 'function' ? String(broker.currentAccount()) : null;
    let execs = broker.allExecutions();
    if (execs && typeof execs.then === 'function') execs = await execs;
    out.executions = (Array.isArray(execs) ? execs : []).map(e => ({
      id: e.id, orderId: e.orderId, symbol: e.symbol,
      side: e.side, qty: e.qty, price: e.price, time: e.time,
      commission: e.commission == null ? null : e.commission,
      pointValue: e.pointValue,
    }));
    let pos = broker.positions();
    if (pos && typeof pos.then === 'function') pos = await pos;
    out.openPositionCount = Array.isArray(pos) ? pos.length : null;
  } catch (err) {
    out.error = 'TVCM-LF-READ-FAILED';
    out.message = String(err && err.message ? err.message : err).slice(0, 300);
  }
  return JSON.stringify(out);
})()`;
}

module.exports = {
  BROKER_LIVE, BROKER_PAPER, BROKER_REPLAY,
  REQUIRED_EXECUTION_FIELDS, NUMERIC_EXECUTION_FIELDS,
  brokerAvailability, detectExecutionShape,
  chicagoStamp, sessionDateForEpoch, decodeSide,
  executionsToFills, analyseExecutions, liveFeedExpression,
};
