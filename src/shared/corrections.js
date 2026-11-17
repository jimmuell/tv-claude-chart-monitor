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
 *   4. **A correction supplements a day's records; it never constitutes them.** Applied to
 *      a day the source does not cover at all, it would not patch a session — it would
 *      invent one. On 2026-11-17 that put a lone Buy 5 into the menu bar as "-$3.00": one
 *      contract-side of fees, no P&L and no trade behind it, because the newest export
 *      stopped on the Friday and the only row it had for Monday was the correction
 *      (TVCM-38). Such a correction is WITHHELD, not dropped — it stays in the file and
 *      applies the moment a source covering that day arrives.
 *
 * Pure: no Electron, no filesystem, no clock of its own.
 */

const { analyseFills, DEFAULT_PER_CONTRACT_SIDE_FEE, MES_POINT_VALUE } = require('./order-history.js');
const { chicagoParts, nextDay, SESSION_ROLLOVER_HOUR } = require('./session-clock.js');

/** Where a correction's numbers came from, worst-evidence first. */
const SOURCES = ['inferred from balance', 'entered by Jim', 'AMP statement'];

/** A correction's life: suggested by TVCM, added by Jim, confirmed by a real record. */
const STATUSES = ['suggested', 'added', 'confirmed'];

/** Raised when a correction is held back because its day has no records to correct. */
const NO_DAY_CODE = 'TVCM-CORR-NO-DAY';

/** Raised when a stored correction no longer passes the rules a suggestion must pass. */
const REVIEW_CODE = 'TVCM-CORR-REVIEW';

/**
 * The smallest price increment MES trades in. A price that is not a multiple of this
 * never happened, whatever the arithmetic says.
 *
 * TVCM-42: the solve offered Buy 1 @ 7,375.67 and Jim accepted it. No such price exists —
 * and the only reason it came out was that the broker gross it was solved against was
 * wrong by a day of fees. An off-tick answer is a loud signal that an input is wrong, and
 * it was being presented as a recommendation instead.
 */
const MES_TICK = 0.25;

/** True when a price lands exactly on the instrument's tick, within a cent of rounding. */
function onTick(price, tick) {
  const t = Number(tick) || MES_TICK;
  const n = Number(price);
  if (!Number.isFinite(n) || !(t > 0)) return false;
  const steps = n / t;
  return Math.abs(steps - Math.round(steps)) < 1e-6;
}

/** The bar covering a moment, from a chart's bars, or null when none does. */
function barFor(bars, timeMs) {
  const at = Number(timeMs);
  if (!Array.isArray(bars) || !Number.isFinite(at)) return null;
  let best = null;
  for (const b of bars) {
    if (!b) continue;
    // Bar times are the OPEN of the bar, in seconds, as TradingView reports them.
    const start = Number(b.time) * 1000;
    if (!Number.isFinite(start) || start > at) continue;
    if (!best || start > Number(best.time) * 1000) best = b;
  }
  return best;
}

/** True when a price traded inside a bar — at or between its low and its high. */
function priceInBar(price, bar) {
  if (!bar) return true;                     // no bar is not a refusal, only no evidence
  const lo = Number(bar.low), hi = Number(bar.high), n = Number(price);
  if (!Number.isFinite(lo) || !Number.isFinite(hi) || !Number.isFinite(n)) return true;
  return n >= lo && n <= hi;
}

/**
 * Checks a proposed fill against the three things that make it possible rather than
 * merely arithmetically convenient. Returns the reasons it fails, so the banner and the
 * corrections list can say which rule was broken rather than just "no".
 */
function validateSuggestion(input) {
  const i = input || {};
  const problems = [];
  const price = Number(i.price);
  const tick = i.tick == null ? MES_TICK : i.tick;
  if (!Number.isFinite(price) || price <= 0) {
    problems.push('the price is not a number');
  } else if (!onTick(price, tick)) {
    problems.push(`${price} is not on a ${tick} tick, so it is not a price that ever traded`);
  }
  const qty = Number(i.qty);
  const need = i.imbalanceQty === null || i.imbalanceQty === undefined ? null : Math.abs(Number(i.imbalanceQty));
  if (!Number.isFinite(qty) || qty <= 0) {
    problems.push('the size is not a quantity');
  } else if (need !== null && Number.isFinite(need) && qty !== need) {
    problems.push(`the size is ${qty} but the rows are out by ${need}`);
  }
  if (i.bar && Number.isFinite(price) && !priceInBar(price, i.bar)) {
    problems.push(`${price} is outside the bar's range of ${i.bar.low}–${i.bar.high} at that time`);
  }
  return { ok: problems.length === 0, problems };
}

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

/** True when the supplied rows actually cover a day, so there is something to correct. */
function dayIsCovered(fills, sessionDate) {
  return (fills || []).some(f => f && f.sessionDate === sessionDate);
}

/**
 * Adds the corrections Jim has accepted to a set of real fills. Suggestions are not
 * applied — only 'added' and 'confirmed' are — any correction a real fill has overtaken is
 * dropped, so the same trade can never be counted twice, and any correction whose day the
 * rows do not cover at all is withheld rather than allowed to become a session of its own.
 */
function applyCorrections(fills, corrections, options) {
  const opts = options || {};
  const mode = opts.mode || 'live';
  const real = (fills || []).filter(Boolean);
  const applied = [];
  const superseded = [];
  const withheld = [];
  for (const c of (corrections || []).filter(Boolean)) {
    if (c.mode !== mode) continue;
    if (c.status !== 'added' && c.status !== 'confirmed') continue;
    // Rule 4. Checked before anything else: a day with no records has nothing to
    // supersede the correction either, and nothing for it to supplement.
    if (!dayIsCovered(real, c.sessionDate)) { withheld.push(c.id); continue; }
    if (real.some(f => fillSupersedes(f, c))) { superseded.push(c.id); continue; }
    applied.push(correctionToFill(c));
  }
  return { fills: real.concat(applied), appliedIds: applied.map(f => f.correctionId), superseded, withheld };
}

/** The same fills priced through the engine, with Jim's accepted corrections included. */
function analyseWithCorrections(fills, corrections, options) {
  const opts = options || {};
  const { fills: merged, appliedIds, superseded, withheld } = applyCorrections(fills, corrections, opts);
  const result = analyseFills(merged, {
    pointValue:         opts.pointValue == null ? MES_POINT_VALUE : opts.pointValue,
    perContractSideFee: opts.perContractSideFee == null ? DEFAULT_PER_CONTRACT_SIDE_FEE : opts.perContractSideFee,
    skipped: opts.skipped || [], errors: [],
  });
  return { result, appliedIds, superseded, withheld };
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

  const rounded = Math.round(price * 100) / 100;
  const window = {
    windowFrom: unmatched ? unmatched.fillTime : null,
    windowTo:   next ? next.fillTime : null,
    unmatchedOrderId: unmatched ? unmatched.orderId : null,
  };

  // A solved price is an inference, not an observation. It only becomes a suggestion if
  // it is a price that could have traded: on a tick, the right size, and inside the bar
  // if TVCM has one. TVCM-42: without this, a broker gross that was wrong by a day of
  // fees produced 7,375.67 — a price MES has never printed — and it was offered as advice.
  const check = validateSuggestion({
    price: rounded, qty, imbalanceQty: run, tick: i.tick,
    bar: i.bar || barFor(i.bars, unmatched ? Date.parse(String(unmatched.fillTime).replace(' ', 'T')) : NaN),
  });
  if (!check.ok) {
    return { side, qty, price: null, needsPrice: true, ...window,
             brokerGross: Number(brokerGross), rejected: check.problems,
             reason: `the solved price could not be offered — ${check.problems.join('; ')}` };
  }

  return {
    side, qty,
    price: rounded,
    needsPrice: false,
    ...window,
    brokerGross: Number(brokerGross),
  };
}

/**
 * Re-checks a correction Jim has already accepted against the rules a suggestion must
 * pass today. Nothing is ever removed — that is Jim's call — but one that fails is
 * flagged so the window can say so and he can decide.
 */
function reviewCorrection(correction, context) {
  const c = correction || {};
  const ctx = context || {};
  const check = validateSuggestion({
    price: c.price, qty: c.qty, tick: ctx.tick,
    imbalanceQty: ctx.imbalanceQty,
    bar: ctx.bar || barFor(ctx.bars, Date.parse(String(c.fillTime).replace(' ', 'T'))),
  });
  return { id: c.id, needsReview: !check.ok, problems: check.problems };
}

/** The same check over a whole list, returning only the ones that need Jim's attention. */
function reviewCorrections(corrections, context) {
  return (corrections || []).filter(Boolean)
    .map(c => reviewCorrection(c, context))
    .filter(r => r.needsReview);
}

/** The sentence shown beside a correction that no longer passes the rules. */
function reviewText(review) {
  if (!review || !review.needsReview) return null;
  return `Needs review — ${review.problems.join('; ')}`;
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
  SOURCES, STATUSES, MATCH_PRICE_TOLERANCE, MATCH_TIME_TOLERANCE_MS, NO_DAY_CODE,
  REVIEW_CODE, MES_TICK,
  onTick, barFor, priceInBar, validateSuggestion,
  reviewCorrection, reviewCorrections, reviewText,
  dayIsCovered,
  sessionDateForStamp, chicagoStamp,
  makeCorrection, correctionToFill, fillSupersedes,
  applyCorrections, analyseWithCorrections, removeCorrection,
  suggestMissingFill, suggestionText,
};
