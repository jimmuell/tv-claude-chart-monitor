'use strict';

/**
 * The account balance each trading session OPENED with.
 *
 * TVCM-36 solved a missing fill's price from the broker's own money: while the account is
 * flat, Purchasing power equals the account balance, so the session's realized gross is
 * today's balance minus the balance the session started with. That second number was a
 * hand-typed setting (4,510.14, off the 11-13 statement). A hand-typed number that must
 * be retyped every evening is a number that will be stale, and a stale one does not
 * announce itself — it just makes the next suggested fill confidently wrong.
 *
 * So TVCM records it itself, once per session, under one condition it will not relax:
 *
 *   **The balance is only ever recorded before the session has traded.**
 *
 * Once a fill has happened the balance has moved, and nothing in the feed can say by how
 * much — that is the very quantity being solved for. If TVCM first sees a session after
 * trading has begun (it was asleep, or Jim traded from the iPhone), the opening balance
 * is marked UNKNOWN and stays unknown for that session. The missing-fill banner then
 * asks for the price instead of solving one, which is the whole point: a refusal is
 * cheap, a wrong fill is not.
 *
 * Pure: no Electron, no filesystem, no clock of its own.
 */

/** Only AMP Live has real money to read a balance from. */
const LIVE_BROKER = 'amp';

/** Why an opening balance could not be recorded, in the order the checks run. */
const REASONS = {
  traded:  'the session had already traded when TVCM first saw it',
  carried: 'a position was carried into the session, so Purchasing power is not the balance',
};

/**
 * What to do with one feed reading. Returns the record to store, or nothing when the
 * session's opening balance is already settled or this reading cannot settle it.
 *
 * `action` is 'keep' (nothing to write), 'record' (a balance) or 'unknown' (a refusal,
 * written down so a later flat moment in the same session cannot quietly overwrite it
 * with a balance that trading has already moved).
 */
function observeReading(input) {
  const i = input || {};
  const sessionDate = i.sessionDate;
  if (!sessionDate) return { action: 'keep', record: null };
  // A session is settled once, either way. This is what stops a mid-session flat moment
  // being mistaken for the start of the day.
  if (i.existing) return { action: 'keep', record: null };
  if (i.mode === 'paper' || i.brokerId !== LIVE_BROKER) return { action: 'keep', record: null };

  const base = { sessionDate, capturedAt: Number(i.at) || null };
  if (Number(i.fillsInSession) > 0) {
    return { action: 'unknown', record: { ...base, balance: null, known: false, source: null, reason: REASONS.traded } };
  }
  const qty = i.brokerQty;
  const margin = Number(i.totalMargin);
  const flat = (qty === null || qty === undefined ? true : Number(qty) === 0)
            && (Number.isFinite(margin) ? margin === 0 : true);
  if (!flat) {
    return { action: 'unknown', record: { ...base, balance: null, known: false, source: null, reason: REASONS.carried } };
  }
  // Number(null) is 0, which would record an opening balance of nothing and then solve
  // a missing fill's price from it. The same trap TVCM-36 found in brokerSessionGross.
  const raw = i.purchasingPower;
  if (raw === null || raw === undefined || raw === '') return { action: 'keep', record: null };
  const pp = Number(raw);
  // Nothing readable yet is not a refusal — the next poll may do better.
  if (!Number.isFinite(pp)) return { action: 'keep', record: null };

  return { action: 'record', record: { ...base, balance: Math.round(pp * 100) / 100, known: true, source: 'feed', reason: null } };
}

/**
 * The opening balance to actually use, and where it came from.
 *
 * Order: a manual override for THIS session wins outright, because it is Jim correcting
 * TVCM with a statement in front of him. Then what the feed recorded. Then the legacy
 * hand-typed setting, which carries no session of its own and so is only ever a last
 * resort. Anything else is unknown, and unknown must be returned, never defaulted.
 */
function resolveOpeningBalance(input) {
  const i = input || {};
  const sessionDate = i.sessionDate;
  const ov = i.override;
  if (ov && ov.sessionDate === sessionDate && Number.isFinite(Number(ov.balance))) {
    return { balance: Number(ov.balance), source: 'override', known: true, reason: null };
  }
  const rec = i.record;
  if (rec && rec.known && Number.isFinite(Number(rec.balance))) {
    return { balance: Number(rec.balance), source: 'feed', known: true, reason: null };
  }
  // The legacy setting is deliberately beaten by a recorded balance: it is the number
  // that goes stale, and TVCM-36's whole complaint was that nothing notices when it does.
  if (!rec && i.legacy !== null && i.legacy !== undefined && i.legacy !== '' && Number.isFinite(Number(i.legacy))) {
    return { balance: Number(i.legacy), source: 'manual', known: true, reason: null };
  }
  return { balance: null, source: null, known: false, reason: rec ? rec.reason : 'no opening balance has been recorded for this session' };
}

/** One plain-English line about a session's opening balance, for Settings and the log. */
function openingBalanceText(sessionDate, resolved) {
  if (!resolved || !resolved.known) {
    return `${sessionDate}: opening balance unknown — ${(resolved && resolved.reason) || 'not recorded'}.`;
  }
  const where = resolved.source === 'override' ? 'entered by Jim'
              : resolved.source === 'feed'     ? 'recorded at the session open'
              : 'the manual setting';
  return `${sessionDate}: opened at $${resolved.balance.toFixed(2)} (${where}).`;
}

module.exports = {
  LIVE_BROKER, REASONS,
  observeReading, resolveOpeningBalance, openingBalanceText,
};
