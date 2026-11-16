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
 * TVCM-28 then found the two brokers do not agree about where the data lives. On AMP,
 * `allExecutions()` is ALWAYS empty: 46 real fills sat in `orders()` for fourteen hours
 * while the feed reported itself healthy. So the source is chosen by broker —
 * `orders()` + `ordersHistory()` on AMP, `allExecutions()` on paper — and an empty read is
 * no longer allowed to pass for a healthy one.
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

/** Which collection holds this broker's fills. The two brokers genuinely differ. */
function feedSourceFor(brokerId) {
  return brokerId === BROKER_LIVE ? 'orders' : 'executions';
}

/** Fields the conversion cannot work without. A missing one means a build we cannot read. */
const REQUIRED_EXECUTION_FIELDS = ['id', 'orderId', 'symbol', 'side', 'qty', 'price', 'time'];

/**
 * The same, for an AMP order. `statusTime` is `extra.status_utc_time` flattened by the page
 * expression — an ISO string. `when_utc_time` is deliberately absent: it is not an epoch
 * (TVCM-28 measured it as an offset from a connection-relative origin, and it goes negative).
 */
const REQUIRED_ORDER_FIELDS = ['id', 'side', 'filledQty', 'avgPrice', 'statusTime'];

/** Which fields of an order must be numbers. */
const NUMERIC_ORDER_FIELDS = ['side', 'filledQty', 'avgPrice'];

/**
 * How many history rows the page may ship back per poll. AMP's `ordersHistory()` holds
 * 1356 rows and grows; the feed only needs enough to cover the current session and the
 * market-shut fallback, so the newest N are taken IN THE PAGE rather than over the wire.
 */
const HISTORY_LIMIT = 500;

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
    // A shape judged on no rows has not passed — it has not been judged. Letting an
    // empty list read as "OK" is what hid AMP's blindness for fourteen hours (TVCM-28).
    empty: sample.length === 0,
    missing: Array.from(missing),
    badTypes: Array.from(badTypes),
    pointValueMissing,
    sampled: sample.length,
  };
}

/** The same check for AMP orders: does this build still look like what we measured? */
function detectOrderShape(orders) {
  if (!Array.isArray(orders)) {
    return { ok: false, notAnArray: true, empty: true, missing: [], badTypes: [], sampled: 0 };
  }
  const sample = orders.filter(Boolean).slice(0, SHAPE_SAMPLE);
  const missing = new Set();
  const badTypes = new Set();
  for (const o of sample) {
    if (!o || typeof o !== 'object') { badTypes.add('<order>'); continue; }
    for (const f of REQUIRED_ORDER_FIELDS) {
      if (!(f in o) || o[f] === null || o[f] === undefined) { missing.add(f); continue; }
      if (NUMERIC_ORDER_FIELDS.includes(f) && typeof o[f] !== 'number') badTypes.add(f);
    }
  }
  return {
    ok: missing.size === 0 && badTypes.size === 0,
    notAnArray: false,
    empty: sample.length === 0,
    missing: Array.from(missing),
    badTypes: Array.from(badTypes),
    sampled: sample.length,
  };
}

/** "YYYY-MM-DD HH:MM:SS" Chicago wall clock, the only stamp format the engine reads. */
function chicagoStamp(epochMs) {
  const p = chicagoParts(epochMs);
  const pad = (n) => String(n).padStart(2, '0');
  return `${p.date} ${pad(p.hour)}:${pad(p.minute)}:${pad(p.second)}`;
}

/** The same, from the ISO string AMP puts in `extra.status_utc_time`. */
function chicagoStampFromIso(iso) {
  const ms = Date.parse(String(iso));
  return Number.isFinite(ms) ? chicagoStamp(ms) : null;
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

  for (const e of (Array.isArray(executions) ? executions : []).filter(Boolean)) {
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

/**
 * Turns AMP orders into the fills the engine prices.
 *
 * An AMP order row already IS what a CSV row is — one order, a filled quantity and an
 * average fill price — so no aggregation is needed, unlike paper's per-fill executions.
 *
 * RULE 2 from the engine applies and is the thing most easily got wrong: count every row
 * with `filledQty > 0` **regardless of status**. Jim's own history contains an order with
 * qty 5, filledQty 2 and status "Cancelled" — a take-profit that filled part of its size
 * and was then pulled. Those 2 contracts are real. Filtering on status would lose them.
 */
function ordersToFills(orders, options) {
  const opts = options || {};
  const source = opts.source || 'live-feed';
  const skipped = [];
  const byOrder = new Map();

  // .filter(Boolean) is the TVCM-27 fix: a hole in the array used to throw on `.id`
  // during a broker switch, which took the whole read down.
  for (const o of (Array.isArray(orders) ? orders : []).filter(Boolean)) {
    if (typeof o !== 'object') continue;
    const note = (reason) => skipped.push({ reason, orderId: o.id, source });

    // An order that filled nothing is normal — working, cancelled, rejected — not an error.
    const qty = Number(o.filledQty);
    if (!Number.isFinite(qty) || qty <= 0) continue;

    const orderId = String(o.id == null ? '' : o.id).trim();
    if (!orderId) { note('TVCM-LF-BAD-ORDER: no order id, cannot dedupe'); continue; }

    const side = decodeSide(o.side);
    if (!side) { note(`TVCM-LF-BAD-ORDER: unrecognised side ${JSON.stringify(o.side)}`); continue; }

    const price = Number(o.avgPrice);
    if (!Number.isFinite(price) || price === 0) { note(`TVCM-LF-BAD-ORDER: unusable avgPrice ${JSON.stringify(o.avgPrice)}`); continue; }

    const fillTime = chicagoStampFromIso(o.statusTime);
    if (!fillTime) { note(`TVCM-LF-BAD-ORDER: unusable status time ${JSON.stringify(o.statusTime)}`); continue; }

    byOrder.set(orderId, {
      orderId,
      symbol:      String(o.symbol || ''),
      side,
      qty,
      price,
      fillTime,
      sessionDate: sessionDateForEpoch(Date.parse(String(o.statusTime))),
      status:      o.cqgStatus ? String(o.cqgStatus) : 'Filled',
      orderType:   '',
      source,
      line:        0,
    });
  }
  return { fills: Array.from(byOrder.values()), skipped };
}

/**
 * Picks the right collection for the broker and converts it. On AMP the current session
 * lives in `orders()` and past sessions in `ordersHistory()`; they are unioned and deduped
 * by order id (TVCM-28 measured zero overlap, but a union that assumes none would be a bug
 * waiting for TradingView to change its mind).
 */
function fillsFromPayload(payload, options) {
  const p = payload || {};
  const source = feedSourceFor(p.brokerId);
  if (source === 'orders') {
    const a = ordersToFills(p.orders, options);
    const b = ordersToFills(p.ordersHistory, options);
    const byId = new Map();
    for (const f of b.fills) byId.set(f.orderId, f);   // history first…
    for (const f of a.fills) byId.set(f.orderId, f);   // …so a live row wins a tie
    return { source, fills: Array.from(byId.values()), skipped: [...a.skipped, ...b.skipped] };
  }
  const r = executionsToFills(p.executions, options);
  return { source, fills: r.fills, skipped: r.skipped };
}

/** A whole payload priced through the engine, whichever collection it came from. */
function analyseFeed(payload, options) {
  const opts = options || {};
  const { source, fills, skipped } = fillsFromPayload(payload, opts);
  return {
    source,
    fills,
    skipped,
    result: analyseFills(fills, {
      pointValue:         opts.pointValue == null ? MES_POINT_VALUE : opts.pointValue,
      perContractSideFee: opts.perContractSideFee == null ? DEFAULT_PER_CONTRACT_SIDE_FEE : opts.perContractSideFee,
      skipped,
      errors: [],
    }),
  };
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

/** How far the engine and the broker may differ before it counts as a disagreement. */
const CROSS_CHECK_TOLERANCE = 0.01;

/** The broker's own realized figure, summed across symbols. Null when it has no answer. */
function sumBrokerProfit(positions) {
  if (!Array.isArray(positions)) return null;
  const rows = positions.filter(Boolean).filter(p => p.profit !== null && p.profit !== undefined);
  if (rows.length === 0) return null;
  return rows.reduce((n, p) => n + (Number(p.profit) || 0), 0);
}

/** Contracts actually held open, summed across symbols — not the number of symbol rows. */
function sumOpenQty(positions) {
  if (!Array.isArray(positions)) return null;
  return positions.filter(Boolean).reduce((n, p) => n + Math.abs(Number(p.qty) || 0), 0);
}

/**
 * Checks the feed's own arithmetic against the broker's — and decides, separately,
 * whether the feed is BLIND.
 *
 * These were one thing in TVCM-29 and are now two, because TVCM-31 showed the broker's
 * figure cannot carry a warning. `positions()[*].profit` was observed absent, then frozen
 * across a closed round trip, then drifting by an amount that changed with every trade:
 * the broker matches lots at its own prices (7597.50 where the order's avgPrice is
 * 7597.55), so it is not like-for-like with order-level FIFO even when it is fresh. The
 * ⚠ it raised sat on the menu bar for hours being wrong, and a ⚠ that is always on is a
 * ⚠ that gets ignored — including the one that matters.
 *
 * So the comparison is now INFORMATIONAL: reported in the tooltip, never a warning.
 *
 * BLIND still warns, and deliberately does not look at `profit` at all. It fires on three
 * pieces of evidence that are each independently damning when no fills were found:
 *   1. the account is holding contracts;
 *   2. the broker returned rows for this session that we converted into nothing;
 *   3. the collection we did NOT read has rows for this session — which is exactly how
 *      TVCM-28 failed, reading allExecutions() on AMP while orders() held 46 fills.
 */
function crossCheck(input) {
  const i = input || {};
  const fillCount = Number(i.fillCount) || 0;
  const openQty   = Math.abs(Number(i.openQty) || 0);
  const rawRows   = Number(i.rawRowsThisSession) || 0;
  const otherRows = Number(i.otherCollectionRows) || 0;

  // --- blind, first and loudest. Nothing here reads brokerProfit. -----------
  if (fillCount === 0) {
    const why = [];
    if (openQty > 0)   why.push(`${openQty} contract(s) are open`);
    if (rawRows > 0)   why.push(`the broker returned ${rawRows} filled row(s) for this session that produced no fills`);
    if (otherRows > 0) why.push(`the collection we are not reading has ${otherRows} row(s) for this session — the wrong collection is being read`);
    if (why.length > 0) {
      return {
        state: 'blind', code: 'TVCM-LF-BLIND', warn: true, delta: null,
        message: `the feed found no fills but ${why.join('; and ')}`,
      };
    }
  }

  // --- the informational comparison ----------------------------------------
  const brokerProfit = i.brokerProfit;
  if (i.positionsAvailable === false || brokerProfit === null || brokerProfit === undefined) {
    return { state: 'unavailable', code: null, warn: false, delta: null,
             message: 'the broker reports no figure to compare against' };
  }
  const gross = Number(i.engineGross) || 0;
  const delta = Math.round((gross - brokerProfit) * 100) / 100;
  if (Math.abs(delta) > CROSS_CHECK_TOLERANCE) {
    return {
      state: 'differs', code: null, warn: false, delta,
      message: `this session reads ${gross} gross here and ${brokerProfit} at the broker`
             + " — the broker's figure is known to lag and to match lots at its own prices",
    };
  }
  return { state: 'ok', code: null, warn: false, delta, message: null };
}

/**
 * How long TVCM's open quantity and the broker's may differ before it is a fault. A fill
 * and the position update that follows it do not land in the same instant, so a momentary
 * gap is normal; half a minute of it is not.
 */
const POSITION_GRACE_MS = 30_000;

/** The broker's SIGNED open quantity, summed across symbols. Null when it has no answer. */
function sumPositionQty(positions) {
  if (!Array.isArray(positions)) return null;
  return positions.filter(Boolean).reduce((n, p) => n + (Number(p.qty) || 0), 0);
}

/**
 * Compares TVCM's open quantity with the broker's live one.
 *
 * TVCM-34: the rows implied short 5 while the broker's live position said flat, because a
 * fill never reached orders(). Nothing noticed for hours. This is the check that notices.
 *
 * `positions().qty` is the field used because it is the only one that is both live and a
 * direct answer: margin is a dollar amount that depends on contract count and broker
 * rules, and OTE reads 0.00 both when flat and when price happens to equal entry. The
 * Account summary tab is not used at all — it freezes (TVCM-34).
 */
function positionMismatch(input) {
  const i = input || {};
  const brokerQty = i.brokerQty;
  const now = Number(i.now) || Date.now();
  const grace = i.graceMs == null ? POSITION_GRACE_MS : i.graceMs;

  if (brokerQty === null || brokerQty === undefined) {
    return { mismatch: false, warn: false, code: null, since: null, message: null };
  }
  const engineQty = Number(i.engineQty) || 0;
  if (engineQty === Number(brokerQty)) {
    return { mismatch: false, warn: false, code: null, since: null, message: null };
  }
  const since = i.mismatchSince == null ? now : Number(i.mismatchSince);
  const held = now - since;
  if (held <= grace) {
    return { mismatch: true, warn: false, code: null, since, message: null };
  }
  return {
    mismatch: true, warn: true, code: 'TVCM-LF-POSITION-MISMATCH', since,
    message: `TradingView's records and its live position disagree — its orders add up to `
           + `${engineQty} contract(s) open but it reports ${brokerQty}; a fill may be missing`,
  };
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
/**
 * The page expression the reader evaluates. The broker id is read in the SAME expression
 * as the data, so the gate cannot go stale between two round trips — the account could
 * change in the gap. It returns a JSON string because returning live broker objects by
 * value makes CDP fail with "Object reference chain is too long" (TVCM-25).
 *
 * It reads `orders()`, `ordersHistory()`, `allExecutions()`, `positions()` and
 * `currentAccount()`. Nothing here can place, modify or cancel an order.
 *
 * Three things it does in the PAGE rather than over the wire, deliberately:
 *   - every array is hole-guarded, because a `null` element during a broker switch used
 *     to throw on `.id` and take the whole read down (TVCM-27);
 *   - history is sorted newest-first and capped at HISTORY_LIMIT, because AMP's is 1356
 *     rows and growing and the feed only needs the recent end of it;
 *   - `extra.status_utc_time` is flattened to `statusTime`. `when_utc_time` is never read:
 *     it is not an epoch (TVCM-28).
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
    if (!broker) { out.error = 'TVCM-LF-NO-BROKER-OBJECT'; return JSON.stringify(out); }

    const call = async (name) => {
      if (typeof broker[name] !== 'function') return null;
      let v = broker[name]();
      if (v && typeof v.then === 'function') v = await v;
      return Array.isArray(v) ? v.filter(Boolean) : null;
    };

    out.account = typeof broker.currentAccount === 'function' ? String(broker.currentAccount()) : null;

    const mapOrder = (o) => ({
      id: o.id, symbol: o.symbol, side: o.side,
      qty: o.qty, filledQty: o.filledQty, avgPrice: o.avgPrice,
      cqgStatus: o.cqg_status,
      statusTime: o.extra ? o.extra.status_utc_time : null,
    });

    const orders = await call('orders');
    out.ordersAvailable = orders !== null;
    out.orders = (orders || []).map(mapOrder);

    const hist = await call('ordersHistory');
    out.historyAvailable = hist !== null;
    out.historyTotal = (hist || []).length;
    // Newest first, then capped: the feed needs the recent end, not 1356 rows every 5s.
    const histSorted = (hist || []).slice().sort((a, b) => {
      const ta = a.extra ? Date.parse(a.extra.status_utc_time) : 0;
      const tb = b.extra ? Date.parse(b.extra.status_utc_time) : 0;
      return (tb || 0) - (ta || 0);
    });
    out.historyTruncated = histSorted.length > ${HISTORY_LIMIT};
    out.ordersHistory = histSorted.slice(0, ${HISTORY_LIMIT}).map(mapOrder);

    const execs = await call('allExecutions');
    out.executionsAvailable = execs !== null;
    out.executions = (execs || []).map(e => ({
      id: e.id, orderId: e.orderId, symbol: e.symbol,
      side: e.side, qty: e.qty, price: e.price, time: e.time,
      commission: e.commission == null ? null : e.commission,
      pointValue: e.pointValue,
    }));

    // The broker's own realized figure, for the cross-check that stops a silent zero.
    const pos = await call('positions');
    out.positionsAvailable = pos !== null;
    out.positions = (pos || []).map(p => ({
      symbol: p.symbol,
      qty: Number(p.qty) || 0,
      profit: p.profit == null ? null : Number(p.profit),
      openCount: Array.isArray(p.open_positions) ? p.open_positions.length : null,
    }));
  } catch (err) {
    out.error = 'TVCM-LF-READ-FAILED';
    out.message = String(err && err.message ? err.message : err).slice(0, 300);
  }
  return JSON.stringify(out);
})()`;
}

module.exports = {
  BROKER_LIVE, BROKER_PAPER, BROKER_REPLAY, HISTORY_LIMIT,
  REQUIRED_EXECUTION_FIELDS, NUMERIC_EXECUTION_FIELDS,
  REQUIRED_ORDER_FIELDS, NUMERIC_ORDER_FIELDS,
  CROSS_CHECK_TOLERANCE,
  brokerAvailability, feedSourceFor, detectExecutionShape, detectOrderShape,
  crossCheck, sumBrokerProfit, sumOpenQty, sumPositionQty, positionMismatch, POSITION_GRACE_MS,
  chicagoStamp, chicagoStampFromIso, sessionDateForEpoch, decodeSide,
  executionsToFills, ordersToFills, fillsFromPayload,
  analyseExecutions, analyseFeed, liveFeedExpression,
};
