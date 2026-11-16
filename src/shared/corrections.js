'use strict';

/**
 * Corrections: fills that really happened but are missing from TradingView's records.
 *
 * TVCM-34/35 found one on Jim's live account. A Sell 5 at 11:10:09 was closed by the
 * broker — AMP's balance proves it — but no closing Buy ever appeared in `orders()`,
 * `ordersHistory()` or the Notifications log. One missing row does not merely lose its own
 * trade: FIFO pairs the orphaned sell against the NEXT buy, which shifts every later
 * pairing, so the day's total was out by more than a thousand dollars.
 *
 * A correction records the missing fill so the totals match the broker again. Three rules
 * keep it honest:
 *
 *   1. **Nothing is ever deleted from TradingView's data.** Corrections are added on top
 *      and can be removed, which restores the old numbers exactly.
 *   2. **Nothing is added without Jim.** TVCM can only ever *suggest*; `status` starts at
 *      'suggested' and only an explicit action makes it 'added'.
 *   3. **A real fill always wins.** When an export or statement later contains the fill,
 *      the inferred correction is superseded rather than counted twice.
 *
 * Pure: no Electron, no filesystem, no clock of its own.
 */

const { analyseFills, DEFAULT_PER_CONTRACT_SIDE_FEE, MES_POINT_VALUE } = require('./order-history.js');
const { chicagoParts, nextDay, SESSION_ROLLOVER_HOUR } = require('./session-clock.js');

/** Where a correction's numbers came from, worst-evidence first. */
const SOURCES = ['inferred from balance', 'entered by Jim', 'AMP statement'];

/** A correction's life: suggested by TVCM, added by Jim, confirmed by a real record. */
const STATUSES = ['suggested', 'added', 'confirmed'];

/** How close a real fill must be to supersede an inferred one. */
const MATCH_PRICE_TOLERANCE = 0.25;      // one MES tick
const MATCH_TIME_TOLERANCE_MS = 60 * 60 * 1000;

/** The session a Chicago wall-clock stamp belongs to, named for the day it ends. */
function sessionDateForStamp(stamp) {
  const m = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}):/.exec(String(stamp || ''));
  if (!m) return null;
  return Number(m[2]) >= SESSION_ROLLOVER_HOUR ? nextDay(m[1]) : m[1];
}

/** "YYYY-MM-DD HH:MM:SS" Chicago wall clock from an epoch, for a solved fill time. */
function chicagoStamp(epochMs) {
  const p = chicagoParts(epochMs);
  const pad = (n) => String(n).padStart(2, '0');
  return `${p.date} ${pad(p.hour)}:${pad(p.minute)}:${pad(p.second)}`;
}

/** Builds one correction record, normalised and with everything it needs to be audited. */
function makeCorrection(input) {
  const i = input || {};
  const side = i.side === 'Buy' || i.side === 'Sell' ? i.side : null;
  const qty = Number(i.qty);
  const price = Number(i.price);
  if (!side || !Number.isFinite(qty) || qty <= 0 || !Number.isFinite(price) || price <= 0) return null;
  const fillTime = String(i.fillTime || '');
  const sessionDate = sessionDateForStamp(fillTime);
  if (!sessionDate) return null;
  return {
    id:          String(i.id || `c-${sessionDate}-${fillTime.slice(11)}-${side}-${qty}`),
    mode:        i.mode === 'paper' ? 'paper' : 'live',
    side, qty, price, fillTime, sessionDate,
    symbol:      String(i.symbol || ''),
    reason:      String(i.reason || 'missing from TradingView’s records'),
    source:      SOURCES.includes(i.source) ? i.source : 'inferred from balance',
    status:      STATUSES.includes(i.status) ? i.status : 'suggested',
    /** The window the fill must have happened in, for the banner and for auditing. */
    windowFrom:  i.windowFrom || null,
    windowTo:    i.windowTo || null,
    createdAt:   Number(i.createdAt) || null,
  };
}

/** A correction as the fill the engine prices, tagged so the UI can mark the row. */
function correctionToFill(c) {
  return {
    orderId:     `correction:${c.id}`,
    symbol:      c.symbol || '',
    side:        c.side,
    qty:         c.qty,
    price:       c.price,
    fillTime:    c.fillTime,
    sessionDate: c.sessionDate,
    status:      'Filled',
    orderType:   '',
    source:      `correction:${c.source}`,
    line:        0,
    /** Set so Fills and Trades can show "Added — missing from TradingView's records". */
    isCorrection: true,
    correctionId: c.id,
  };
}

/** True when a real fill is plainly the same trade an inferred correction stood in for. */
function fillSupersedes(fill, c) {
  if (!fill || !c) return false;
  if (fill.isCorrection) return false;
  if (fill.side !== c.side || Number(fill.qty) !== Number(c.qty)) return false;
  if (Math.abs(Number(fill.price) - Number(c.price)) > MATCH_PRICE_TOLERANCE) return false;
  const a = Date.parse(String(fill.fillTime).replace(' ', 'T'));
  const b = Date.parse(String(c.fillTime).replace(' ', 'T'));
  if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
  return Math.abs(a - b) <= MATCH_TIME_TOLERANCE_MS;
}

/**
 * Adds the corrections Jim has accepted to a set of real fills. Suggestions are not
 * applied — only 'added' and 'confirmed' are — and any correction a real fill has
 * overtaken is dropped, so the same trade can never be counted twice.
 */
function applyCorrections(fills, corrections, options) {
  const opts = options || {};
  const mode = opts.mode || 'live';
  const real = (fills || []).filter(Boolean);
  const applied = [];
  const superseded = [];
  for (const c of (corrections || []).filter(Boolean)) {
    if (c.mode !== mode) continue;
    if (c.status !== 'added' && c.status !== 'confirmed') continue;
    if (real.some(f => fillSupersedes(f, c))) { superseded.push(c.id); continue; }
    applied.push(correctionToFill(c));
  }
  return { fills: real.concat(applied), appliedIds: applied.map(f => f.correctionId), superseded };
}

/** The same fills priced through the engine, with Jim's accepted corrections included. */
function analyseWithCorrections(fills, corrections, options) {
  const opts = options || {};
  const { fills: merged, appliedIds, superseded } = applyCorrections(fills, corrections, opts);
  const result = analyseFills(merged, {
    pointValue:         opts.pointValue == null ? MES_POINT_VALUE : opts.pointValue,
    perContractSideFee: opts.perContractSideFee == null ? DEFAULT_PER_CONTRACT_SIDE_FEE : opts.perContractSideFee,
    skipped: opts.skipped || [], errors: [],
  });
  return { result, appliedIds, superseded };
}

/** Removes one correction by id, leaving everything else untouched. */
function removeCorrection(corrections, id) {
  return (corrections || []).filter(c => c && c.id !== id);
}

/**
 * Works out the fill that must be missing, when TVCM's rows say a position is open and
 * the broker says it is flat.
 *
 * Side and quantity come from the imbalance. The time window runs from the first fill the
 * ledger could not match to the next fill after it — the fill is placed at the start of
 * that window, and the window itself is shown so Jim can judge it. The price is solved so
 * that the session's gross equals the broker's own figure, which is the only number in
 * this situation that is known to be right.
 *
 * Returns null when there is nothing to suggest, or when the broker figure is missing —
 * in which case the caller must ask Jim for the price rather than guess one.
 */
function suggestMissingFill(input) {
  const i = input || {};
  const fills = (i.fills || []).filter(Boolean)
    .slice().sort((a, b) => String(a.fillTime) < String(b.fillTime) ? -1 : 1);
  if (fills.length === 0) return null;
  if (Number(i.brokerQty) !== 0) return null;          // only solved against a flat broker

  let run = 0, lastFlat = -1;
  fills.forEach((f, n) => { run += (f.side === 'Buy' ? 1 : -1) * Number(f.qty); if (run === 0) lastFlat = n; });
  if (run === 0) return null;                          // the rows already balance

  const unmatched = fills[lastFlat + 1];
  const next = fills[lastFlat + 2] || null;
  const side = run < 0 ? 'Buy' : 'Sell';
  const qty = Math.abs(run);

  const brokerGross = i.brokerGross;
  if (brokerGross === null || brokerGross === undefined || !Number.isFinite(Number(brokerGross))) {
    return { side, qty, price: null, needsPrice: true,
             windowFrom: unmatched ? unmatched.fillTime : null,
             windowTo: next ? next.fillTime : null,
             reason: 'no broker figure to solve the price from' };
  }

  const pv = i.pointValue == null ? MES_POINT_VALUE : i.pointValue;
  let buyN = 0, sellN = 0;
  for (const f of fills) {
    const n = Number(f.qty) * Number(f.price);
    if (f.side === 'Buy') buyN += n; else sellN += n;
  }
  // With the missing fill added the day is flat, so gross is simply the notional
  // difference. Solve that for the one unknown price.
  const signed = side === 'Buy' ? qty : -qty;
  const price = (sellN - buyN - Number(brokerGross) / pv) / signed;

  return {
    side, qty,
    price: Math.round(price * 100) / 100,
    needsPrice: false,
    windowFrom: unmatched ? unmatched.fillTime : null,
    windowTo:   next ? next.fillTime : null,
    unmatchedOrderId: unmatched ? unmatched.orderId : null,
    brokerGross: Number(brokerGross),
  };
}

/** The banner sentence shown in the window's Summary. */
function suggestionText(s) {
  if (!s) return null;
  const when = s.windowFrom
    ? ` between ${String(s.windowFrom).slice(11, 16)} and ${s.windowTo ? String(s.windowTo).slice(11, 16) : 'now'}`
    : '';
  if (s.needsPrice) {
    return `A fill is missing from TradingView’s records — ${s.side} ${s.qty}${when}. `
         + 'The broker gives no figure to solve the price from, so it has to be entered.';
  }
  return `A fill is missing from TradingView’s records — suggested: `
       + `${s.side} ${s.qty} @ ${s.price.toFixed(2)}${when}.`;
}

module.exports = {
  SOURCES, STATUSES, MATCH_PRICE_TOLERANCE, MATCH_TIME_TOLERANCE_MS,
  sessionDateForStamp, chicagoStamp,
  makeCorrection, correctionToFill, fillSupersedes,
  applyCorrections, analyseWithCorrections, removeCorrection,
  suggestMissingFill, suggestionText,
};
