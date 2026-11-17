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
 * TVCM-37 recorded it itself at 17:00 from Purchasing power, under one condition: only
 * before the session had traded. **TVCM-42 replaced the source.** AMP publishes the number
 * directly, in the Balances table, as "Prev day balance" — and crucially it is the figure
 * AFTER the previous day's commissions have been debited, which Purchasing power at 17:00
 * is not. Measured 2026-11-17: Monday closed at PP 5,693.89, Tuesday's prev day balance
 * was 5,474.29, and the 219.60 between them is Monday's fees to the cent. Solving a
 * missing fill against the wrong one of those produced a price of 7,375.67, which is not
 * even on a quarter-point tick.
 *
 * Reading AMP's own figure makes the old gating unnecessary as well as wrong: the prev
 * day balance is STATIC for the session, so there is no moment at which it must be caught
 * and no way for trading to move it. A session first seen at noon is as readable as one
 * first seen at 17:00.
 *
 * What has not changed is the refusal. If the figure cannot be read, the opening balance
 * is UNKNOWN, and the missing-fill banner asks for a price rather than solving a wrong
 * one. A refusal is cheap; a wrong fill is not.
 *
 * Pure: no Electron, no filesystem, no clock of its own.
 */

/** Only AMP Live has real money to read a balance from. */
const LIVE_BROKER = 'amp';

/** Why an opening balance could not be recorded, in the order the checks run. */
const REASONS = {
  unreadable: 'AMP did not report a previous day balance',
  traded:     'the session had already traded when TVCM first saw it',
  carried:    'a position was carried into the session, so Purchasing power is not the balance',
};

/** Where a recorded balance came from, best first. */
const SOURCE_PREV_DAY = 'prev-day-balance';   // AMP's own figure, net of yesterday's fees
const SOURCE_PP       = 'feed';               // TVCM-37's 17:00 Purchasing power capture

/**
 * True when a stored record should be replaced by a reading from a better source. The
 * 17:00 capture is superseded by AMP's own figure the moment one can be read, which is
 * what repairs a session recorded before TVCM-42 without anybody editing a file.
 */
function supersedes(existing) {
  if (!existing) return true;
  if (!existing.known) return true;                       // an unknown is always worth filling in
  return existing.source !== SOURCE_PREV_DAY;             // anything older yields to AMP's own
}

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
  if (i.mode === 'paper' || i.brokerId !== LIVE_BROKER) return { action: 'keep', record: null };
  if (!supersedes(i.existing)) return { action: 'keep', record: null };

  const base = { sessionDate, capturedAt: Number(i.at) || null };

  // AMP's own number, which is static for the session and already net of the previous
  // day's commissions. Number(null) is 0, so the absent cases are refused by name before
  // the conversion — the trap TVCM-36 found in brokerSessionGross and TVCM-37 here.
  const raw = i.prevDayBalance;
  if (raw !== null && raw !== undefined && raw !== '') {
    const prev = Number(raw);
    if (Number.isFinite(prev)) {
      return { action: 'record',
               record: { ...base, balance: Math.round(prev * 100) / 100, known: true,
                         source: SOURCE_PREV_DAY, reason: null } };
    }
  }

  // Nothing readable yet is not a refusal while a session has never been judged — the
  // next poll may do better. Only a session TVCM has already given up on stays given up.
  if (!i.existing) {
    return { action: 'unknown',
             record: { ...base, balance: null, known: false, source: null, reason: REASONS.unreadable } };
  }
  return { action: 'keep', record: null };
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
    return { balance: Number(rec.balance), source: rec.source || 'feed', known: true, reason: null };
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
  LIVE_BROKER, REASONS, SOURCE_PREV_DAY, SOURCE_PP,
  supersedes, observeReading, resolveOpeningBalance, openingBalanceText,
};
