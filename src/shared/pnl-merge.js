'use strict';

/**
 * Choosing which number to show when there are two sources.
 *
 * The live feed reads TradingView's own executions and knows about a fill seconds after
 * it happens, but it has never been reconciled against a broker statement. The CSV import
 * has — TVCM-13 matched it to AMP's 13-NOV-26 statement by hand. So the split is:
 *
 *   - the CURRENT session comes from the feed, because that is the number that has to be
 *     right *now* and the CSV cannot know it until Jim exports;
 *   - PAST DAYS come from the CSV, which is the record;
 *   - and when both have the current session and they disagree, the CSV wins and the
 *     disagreement is shown. Fast is not the same as authoritative.
 *
 * Paper and live are never mixed. A feed reading taken in paper mode cannot reach a live
 * display, and the AMP CSV — which holds real money — cannot supply a number while the
 * paper toggle is on. Both are enforced here rather than left to the caller.
 *
 * Pure: no Electron, no CDP, no clock of its own.
 */

const { isMarketOpen } = require('./session-clock.js');

/**
 * How far the two sources may differ before it counts as a disagreement. Both round to
 * cents, so anything at or below half a cent is arithmetic, not a discrepancy.
 */
const DISAGREE_TOLERANCE = 0.005;

/** Default minutes before a feed that has stopped reading stops being trusted. */
const DEFAULT_STALE_MINUTES = 30;

/**
 * Whether the feed's last reading is still worth using: it has one, and it is not older
 * than the threshold *while the market is open*. Outside market hours a quiet feed is
 * just a quiet market, exactly as the menu bar's stale rule already treats the CSV.
 * A single failed poll does not drop the feed — the number only goes when it goes stale.
 */
function feedUsable(feed, now, staleMinutes) {
  if (!feed || !feed.session || feed.readAt == null) return false;
  const minutes = staleMinutes == null ? DEFAULT_STALE_MINUTES : staleMinutes;
  if (!(minutes > 0)) return true;
  if (!isMarketOpen(now)) return true;
  return (Number(now) - Number(feed.readAt)) <= minutes * 60_000;
}

/** The first non-null complaint from a list, so one error cannot hide behind another. */
function firstError(candidates) {
  for (const c of candidates) if (c && c.code) return c;
  return null;
}

/**
 * Decides the displayed session and where it came from. Returns the merged view the tray,
 * the panel and the Order History window all read, including why anything is wrong.
 */
function mergePnl(input) {
  const opts  = input || {};
  const feed  = opts.feed || null;
  const csv   = opts.csv  || null;
  const now   = opts.now == null ? Date.now() : Number(opts.now);
  const mode  = opts.mode || (feed && feed.mode) || 'live';
  const staleMinutes = opts.staleMinutes;

  // A reading taken in the other mode is not a lesser source — it is the wrong account's
  // money, and it must not be shown under any circumstances.
  const modeMismatch = !!(feed && feed.mode && feed.mode !== mode);

  // In paper mode the AMP CSV is off the table entirely: it is live money. That includes
  // its idea of which session is current — the feed's clock is the only one that applies.
  const csvAllowed = mode !== 'paper';
  const csvState   = csvAllowed ? csv : null;

  const currentSession = (feed && feed.currentSession)
    || (csvState && csvState.currentSession) || null;

  const stale = !!(feed && feed.session && !feedUsable(feed, now, staleMinutes));
  const feedOk = !modeMismatch && !!feed && feed.available !== false && feed.readAt != null;
  const feedCurrent = (feedOk && feedUsable(feed, now, staleMinutes)
      && feed.session && feed.session.sessionDate === currentSession)
    ? feed.session : null;

  /**
   * The feed's last reading for TODAY, however old it is.
   *
   * On 2026-11-16 the Mac lost its AMP connection (the iPhone holds Jim's single
   * allowed one) and the menu bar fell back to the CSV's last session — FRIDAY —
   * instead of today's last known live number. A stale figure for today is honest and
   * can be marked; a different day's figure in the menu bar is simply wrong. So once
   * the feed has a result for the current session it keeps it until the feed recovers
   * or the session itself ends.
   */
  const feedLastKnown = (feedOk && !feedCurrent
      && feed.session && feed.session.sessionDate === currentSession)
    ? feed.session : null;

  // The same rule the CSV path uses: with the market SHUT and nothing in the current
  // session, show the newest session that has fills — on a Saturday a trader wants
  // Friday's result, not a dash. While the market is open an empty current session stays
  // empty, because an earlier number mid-session would be read as today's.
  const feedFallback = (feedOk && !feedCurrent && !feed.session
      && feed.fallbackSession && !isMarketOpen(now))
    ? feed.fallbackSession : null;

  const csvCurrent = (csvState && csvState.session && !csvState.isFallback
      && csvState.session.sessionDate === currentSession) ? csvState.session : null;

  // --- the disagreement check, before anything is chosen ---------------------
  let disagreement = null;
  if (feedCurrent && csvCurrent) {
    const delta = Number(feedCurrent.netPnl) - Number(csvCurrent.netPnl);
    if (Math.abs(delta) > DISAGREE_TOLERANCE) {
      disagreement = {
        code: 'TVCM-PNL-DISAGREE',
        feedNet: feedCurrent.netPnl,
        csvNet:  csvCurrent.netPnl,
        delta:   Math.round(delta * 100) / 100,
        sessionDate: currentSession,
      };
    }
  }

  // --- choose the session ----------------------------------------------------
  let session = null, source = 'none', isFallback = false, asOf = null, lastKnown = false;
  if (disagreement) {
    session = csvCurrent; source = 'csv'; asOf = csvState.importedAt;
  } else if (feedCurrent) {
    session = feedCurrent; source = 'feed'; asOf = feed.readAt;
  } else if (csvCurrent) {
    session = csvCurrent; source = 'csv'; asOf = csvState.importedAt;
  } else if (feedLastKnown) {
    session = feedLastKnown; source = 'feed'; asOf = feed.readAt; lastKnown = true;
  } else if (csvState && csvState.session) {
    session = csvState.session; source = 'csv'; isFallback = !!csvState.isFallback; asOf = csvState.importedAt;
  } else if (feedFallback) {
    session = feedFallback; source = 'feed'; isFallback = true; asOf = feed.readAt;
  }

  // --- what to complain about, strongest first -------------------------------
  const problem = firstError([
    lastKnown && { code: feed.errorCode || 'TVCM-LF-LAST-KNOWN',
      message: `TradingView disconnected — showing the last known figure for ${currentSession}` },
    disagreement && { code: disagreement.code,
      message: `the live feed says ${disagreement.feedNet} and the export says ${disagreement.csvNet} for ${currentSession} — showing the export` },
    modeMismatch && { code: 'TVCM-LF-MODE-MISMATCH',
      message: `a ${feed.mode} feed reading was refused while TVCM is in ${mode} mode` },
    feed && feed.errorCode && { code: feed.errorCode, message: feed.errorMessage || feed.reason },
    csvState && csvState.errorCode && { code: csvState.errorCode, message: csvState.errorMessage },
  ]);

  return {
    mode,
    session,
    source,
    isFallback,
    currentSession,
    asOf,
    asOfSource:   source === 'none' ? null : source,
    disagreement,
    /** True when the number is the feed's last reading for today, not a live one. */
    lastKnown,
    feedStale:    stale,
    feedState:    feed ? feed.state : null,
    feedReason:   feed ? feed.reason : null,
    switchHint:   feed ? feed.switchHint || null : null,
    /** Past days always come from the CSV, and never while paper mode is on. */
    pastSessionsSource: csvAllowed ? 'csv' : null,
    errorCode:    problem ? problem.code : null,
    errorMessage: problem ? problem.message || null : null,
    warn:         !!(disagreement || modeMismatch || lastKnown || (feed && feed.warn)),
  };
}

/**
 * Flattens the merged view back into the OrderImportState shape the tray, the panel and
 * the Order History window already read. Keeping one shape means the live feed did not
 * have to be threaded through three renderers to be displayed.
 */
function mergedToImportState(merged, csv, feed) {
  const m = merged || {};
  const c = csv || {};
  const f = feed || {};
  const fromFeed = m.source === 'feed';
  return {
    session:        m.session || null,
    isFallback:     !!m.isFallback,
    currentSession: m.currentSession || null,
    // "Imported at" is really "as of": the feed read, or the export import.
    importedAt:     m.asOf == null ? null : m.asOf,
    fileName:       fromFeed ? `live feed (${m.mode})` : (m.source === 'csv' ? (c.fileName || null) : null),
    filePath:       fromFeed ? null : (m.source === 'csv' ? (c.filePath || null) : null),
    fillCount:      fromFeed ? (f.fillCount || 0) : (c.fillCount || 0),
    skippedRows:    fromFeed ? (f.skippedCount || 0) : (c.skippedRows || 0),
    sessionCount:   fromFeed ? 1 : (c.sessionCount || 0),
    errorCode:      m.errorCode || null,
    errorMessage:   m.errorMessage || null,
    lastAttemptAt:  Math.max(Number(c.lastAttemptAt || 0), Number(f.lastAttemptAt || 0)) || null,
    watchFolder:    c.watchFolder || null,
  };
}

module.exports = { mergePnl, feedUsable, mergedToImportState, DISAGREE_TOLERANCE, DEFAULT_STALE_MINUTES };
