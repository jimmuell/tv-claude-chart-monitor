'use strict';
// grader.js
// Grades a saved recommendation against the bars that came AFTER it.
//
// Pure functions only — no DB, no Electron, no CDP. The caller supplies the
// call and the later bars (as readBars() returns them) and gets a verdict back.
//
// WHY BARS AND NOT P&L: a recommendation is graded on what price did, not on
// what the account did. Most calls are never traded at all, and the P&L reader's
// field mapping is still unverified (TVCM-1-HEALTH), so grading from P&L would
// both miss most calls and inherit an open bug.
//
// Outcomes:
//   PENDING       not enough later bars to decide yet — ask again next bar
//   UNGRADEABLE   the call has no direction/entry/stop/target to grade
//   NOT_TRIGGERED entry was never touched inside the trigger window
//   WIN           target touched first
//   LOSS          stop touched first
//   AMBIGUOUS     one bar touched BOTH levels — order inside a bar is unknowable
//   EXPIRED       triggered, but neither level was touched before the limit
//
// AMBIGUOUS and EXPIRED carry no R. Guessing which level came first inside a bar
// is the single easiest way to manufacture a fake edge, so it is never scored.

// MES contract economics. $5 per point; one round trip of fees costs $1.24.
const DEFAULTS = {
  pointValue:    5.0,
  feePerRt:      1.24,
  triggerWindow: 5,    // bars in which entry must be touched
  expireBars:    60,   // bars after which an unresolved call is abandoned
};

/** True when the bar's range contains the price, i.e. price traded there. */
function touched(bar, price) {
  return bar.low <= price && bar.high >= price;
}

/** True when this bar reached the call's profit target. */
function hitTarget(bar, call) {
  return call.direction === 'long' ? bar.high >= call.target : bar.low <= call.target;
}

/** True when this bar reached the call's stop. */
function hitStop(bar, call) {
  return call.direction === 'long' ? bar.low <= call.stop : bar.high >= call.stop;
}

/** True when the call carries everything the grader needs to score it. */
function isGradeable(call) {
  if (!call) return false;
  if (call.direction !== 'long' && call.direction !== 'short') return false;
  return [call.entry, call.stop, call.target].every(
    (v) => typeof v === 'number' && Number.isFinite(v),
  );
}

/** Merge caller options over the defaults, ignoring keys explicitly set to undefined. */
function withDefaults(opts) {
  const out = { ...DEFAULTS };
  for (const [k, v] of Object.entries(opts || {})) {
    if (v !== undefined) out[k] = v;
  }
  return out;
}

/** Fee cost of one round trip expressed in R, given the risk distance in points. */
function feeInR(riskPoints, opts) {
  const o = withDefaults(opts);
  const riskDollars = Math.abs(riskPoints) * o.pointValue;
  return riskDollars > 0 ? o.feePerRt / riskDollars : 0;
}

/**
 * Win rate a strategy must beat to break even, given planned R:R and fees.
 * At 1:1 on a 3.25-point MES stop this is ~53.9%, not 50%.
 */
function breakEvenWinRate({ rrPlanned, riskPoints, feePerRt, pointValue } = {}) {
  const rr = typeof rrPlanned === 'number' && rrPlanned > 0 ? rrPlanned : 1;
  const f  = feeInR(riskPoints ?? 1, { feePerRt, pointValue });
  // p*(rr - f) = (1 - p)*(1 + f)  ->  p = (1 + f) / (rr + 1)
  return (1 + f) / (rr + 1);
}

/** Grade one call against the bars that followed it. Returns a verdict object. */
function gradeCall(call, barsAfter, opts) {
  const o    = withDefaults(opts);
  const bars = Array.isArray(barsAfter) ? barsAfter : [];
  const none = { outcome: null, barsToOutcome: null, rGross: null, rNet: null, triggerBarIndex: null };

  if (!isGradeable(call)) return { ...none, outcome: 'UNGRADEABLE' };

  const riskPoints = Math.abs(call.entry - call.stop);
  if (riskPoints <= 0) return { ...none, outcome: 'UNGRADEABLE' };
  const fee = feeInR(riskPoints, o);

  // Session end, when supplied, cuts a call off before the bar limit.
  const pastSessionEnd = (bar) =>
    typeof o.sessionEndTime === 'number' && bar.time >= o.sessionEndTime;

  // ── Phase 1: did price come back to the entry? ───────────────────────────
  let triggerIndex = -1;
  for (let i = 0; i < bars.length && i < o.triggerWindow; i++) {
    if (touched(bars[i], call.entry)) { triggerIndex = i; break; }
    if (pastSessionEnd(bars[i])) {
      return { ...none, outcome: 'NOT_TRIGGERED', barsToOutcome: i + 1 };
    }
  }
  if (triggerIndex === -1) {
    // Only a settled answer once the whole window has been seen.
    if (bars.length < o.triggerWindow) return { ...none, outcome: 'PENDING' };
    return { ...none, outcome: 'NOT_TRIGGERED', barsToOutcome: o.triggerWindow };
  }

  // ── Phase 2: which level did price reach first? ──────────────────────────
  for (let i = triggerIndex; i < bars.length; i++) {
    const b    = bars[i];
    const tHit = hitTarget(b, call);
    const sHit = hitStop(b, call);

    // Both in one bar — including a gap that opens through one and runs to the
    // other. Which came first is not knowable from OHLC, so refuse to score it.
    if (tHit && sHit) {
      return { ...none, outcome: 'AMBIGUOUS', barsToOutcome: i + 1, triggerBarIndex: triggerIndex };
    }
    if (tHit) {
      const rGross = Math.abs(call.target - call.entry) / riskPoints;
      return { outcome: 'WIN', barsToOutcome: i + 1, rGross, rNet: rGross - fee, triggerBarIndex: triggerIndex };
    }
    if (sHit) {
      return { outcome: 'LOSS', barsToOutcome: i + 1, rGross: -1, rNet: -1 - fee, triggerBarIndex: triggerIndex };
    }

    if (pastSessionEnd(b)) {
      return { ...none, outcome: 'EXPIRED', barsToOutcome: i + 1, triggerBarIndex: triggerIndex };
    }
    if (i + 1 >= o.expireBars) {
      return { ...none, outcome: 'EXPIRED', barsToOutcome: i + 1, triggerBarIndex: triggerIndex };
    }
  }

  // Triggered, still running, and the limit has not been reached.
  return { ...none, outcome: 'PENDING', triggerBarIndex: triggerIndex };
}

module.exports = { gradeCall, breakEvenWinRate, feeInR, DEFAULTS };
