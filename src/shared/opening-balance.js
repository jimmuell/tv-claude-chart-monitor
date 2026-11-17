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
  notRolled:  'AMP updates its balance overnight — check back in the morning',
};

/** Raised while AMP's Balances table still carries the previous session's figures. */
const NOT_ROLLED_CODE = 'TVCM-OB-NOT-ROLLED';

/** Raised when a session's opening balance changes after it was first recorded. */
const CHANGED_CODE = 'TVCM-OB-CHANGED';

/**
 * How far `account balance − prev day balance` may sit from zero at a session that has
 * not traded yet. Both are cents, so anything past a cent is a real difference.
 */
const ROLL_TOLERANCE = 0.01;

/** Where a recorded balance came from, best first. */
const SOURCE_PREV_DAY = 'prev-day-balance';   // AMP's own figure, net of yesterday's fees
const SOURCE_PP       = 'feed';               // TVCM-37's 17:00 Purchasing power capture

/**
 * True when a stored record should be replaced by a fresh prev-day-balance reading.
 *
 * TVCM-42 locked a session's first reading in for the day, and TVCM-43 found what that
 * costs: AMP's Balances table rolls its statement some time AFTER 17:00, so a reading
 * taken in the first seconds of a session is the PREVIOUS session's figure. Locked in,
 * that is an error of a whole day's P&L — reproduced at 778.60 — and it is silent,
 * because the stored source says it came from AMP.
 *
 * So within a session the LATEST reading wins. TVCM's own session clock rolls exactly at
 * 17:00 and is the authority for which session this is; the only thing that can move
 * AMP's figure inside one session is AMP catching up, and catching up is an improvement.
 */
function supersedes(existing) {
  return true;
}

/**
 * Whether AMP has rolled its statement into this session yet.
 *
 * TVCM-43 assumed the roll happens around 17:00, and so only checked before the first
 * fill — "by then AMP has long since rolled". **That is false.** Jim (2026-11-17 15:54):
 * AMP updates its Balances table early the NEXT MORNING, and on Monday at 17:07 it was
 * still showing a prev day balance of 4,510.14. Measured again on 2026-11-17 at 17:05,
 * five minutes after the session rolled: AMP still reported 5,474.29, Tuesday's opening.
 *
 * Jim often trades from 17:00. Under TVCM-43 his first evening fill would have switched
 * the guard off — `fillsInSession > 0` meant "too late to tell" — and the next poll would
 * have recorded YESTERDAY's opening balance as tonight's, silently, until the morning.
 *
 * So the primary evidence is no longer the clock or the fills. It is that **AMP's figure
 * has visibly moved**: a prev day balance that still equals the PREVIOUS session's
 * recorded opening balance is the previous session's figure, whatever time it is and
 * however much has traded since.
 *
 * The no-fill equality check is kept as corroboration, and as the only evidence available
 * when there is no previous session on record to compare against.
 */
function hasRolled(input) {
  const i = input || {};
  const prev = Number(i.prevDayBalance);
  const priorRaw = i.previousSessionOpening;
  const priorKnown = priorRaw !== null && priorRaw !== undefined && priorRaw !== ''
    && Number.isFinite(Number(priorRaw));

  if (priorKnown) {
    // AMP still showing the previous session's opening means it has not rolled, whether
    // or not anything has traded since.
    if (Math.abs(prev - Number(priorRaw)) <= ROLL_TOLERANCE) return false;
    // It has moved. With no fills yet, the pair must also agree — a rolled table at an
    // untraded session has nothing to separate its two numbers.
    return noFillsAgree(i);
  }
  // Nothing to compare against: the no-fill check is all the evidence there is.
  return noFillsAgree(i);
}

/**
 * The corroborating check: at a session that has not traded, the account balance and the
 * previous day's balance are the same number. Once it HAS traded the difference is the
 * day's own P&L and proves nothing either way.
 */
function noFillsAgree(input) {
  const i = input || {};
  if (Number(i.fillsInSession) > 0) return true;
  const acct = i.accountBalance;
  if (acct === null || acct === undefined || acct === '') return true;   // nothing to check against
  const a = Number(acct), p = Number(i.prevDayBalance);
  if (!Number.isFinite(a) || !Number.isFinite(p)) return true;
  return Math.abs(a - p) <= ROLL_TOLERANCE;
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
  const existing = i.existing || null;
  if (!sessionDate) return { action: 'keep', record: null };
  if (i.mode === 'paper' || i.brokerId !== LIVE_BROKER) return { action: 'keep', record: null };

  const at = Number(i.at) || null;
  const base = { sessionDate, capturedAt: at };

  // AMP's own number, which is already net of the previous day's commissions. Number(null)
  // is 0, so the absent cases are refused by name before the conversion — the trap
  // TVCM-36 found in brokerSessionGross and TVCM-37 repeated here.
  const raw = i.prevDayBalance;
  const readable = raw !== null && raw !== undefined && raw !== '' && Number.isFinite(Number(raw));

  if (readable) {
    // The roll guard. Recording a figure AMP has not rolled yet is how a whole day's P&L
    // gets stored as an opening balance (TVCM-43).
    if (!hasRolled(i)) {
      if (existing && existing.known) return { action: 'keep', record: null };
      return { action: 'unknown', code: NOT_ROLLED_CODE,
               record: { ...base, balance: null, known: false, source: null, reason: REASONS.notRolled } };
    }
    const prev = Math.round(Number(raw) * 100) / 100;
    // Unchanged is not news: rewriting the same number every five seconds would churn
    // the file and make every poll look like a correction.
    if (existing && existing.known && Number(existing.balance) === prev) {
      return { action: 'keep', record: null };
    }
    const changed = !!(existing && existing.known) && Number(existing.balance) !== prev;
    return {
      action: changed ? 'changed' : 'record',
      code: changed ? CHANGED_CODE : null,
      previousBalance: changed ? Number(existing.balance) : null,
      record: { ...base, balance: prev, known: true, source: SOURCE_PREV_DAY, reason: null,
                // When the figure moved, everything inferred from the old one is suspect.
                changedAt: changed ? at : (existing && existing.changedAt) || null,
                previousBalance: changed ? Number(existing.balance) : null },
    };
  }

  // Nothing readable yet is not a refusal while a session has never been judged — the
  // next poll may do better. Only a session TVCM has already given up on stays given up.
  if (!existing) {
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
  NOT_ROLLED_CODE, CHANGED_CODE, ROLL_TOLERANCE,
  supersedes, hasRolled, noFillsAgree, observeReading, resolveOpeningBalance, openingBalanceText,
};
