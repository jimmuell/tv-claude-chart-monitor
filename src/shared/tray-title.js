'use strict';

/**
 * The text in the macOS menu bar. There is no icon beside it: macOS draws a status
 * item's title to the RIGHT of its image and Electron's TitleOptions exposes only
 * `fontType`, so the only way to put the number first is to have nothing before it.
 *
 * Because the title is the whole status item, it must never be empty — an empty
 * title with no image leaves nothing to see or click.
 *
 * Two further rules drive it. First, never show a number the trader could mistake for
 * today's: with no usable import the title is a dash, never "$0.00", because a
 * fake flat day and a real flat day look identical and only one of them is safe
 * to act on. Second, a warning marker when the number cannot be trusted — either the
 * numbers have gone stale *while the market is open* (a stale figure on a Saturday is
 * simply Friday's result and needs no warning), or the most recent import ATTEMPT
 * failed, which is marked at once: a failure that only reached the tooltip left the
 * menu bar showing an old number with nothing to say it had stopped being refreshed.
 */

const { isMarketOpen } = require('./session-clock.js');

/** The dash shown when there is nothing trustworthy to display. */
const NO_DATA_TITLE = 'P&L —';

/** Appended when the number cannot be trusted — stale during trading, or a failed import. */
const STALE_MARKER = ' ⚠';

/** How much of an error message the tooltip will carry before cutting it short. */
const MAX_TOOLTIP_REASON = 120;

/**
 * Prefixed when TVCM is running on a non-default userData profile. A test copy puts a
 * second tray in the menu bar next to the real one, and three prompts running they were
 * read as the same thing. This makes them impossible to confuse.
 */
const TEST_PREFIX = 'TEST ';

/**
 * Prefixed while Paper mode is on. Paper money and real money render identically
 * otherwise, and the whole point of the menu bar is to be glanced at — so the label goes
 * where the glance lands, not in a tooltip nobody opens mid-trade.
 */
const PAPER_PREFIX = 'PAPER ';

const DEFAULT_STALE_MINUTES = 30;

/**
 * macOS tray titles render ANSI colour escapes (Electron documents setTitle as
 * "Support ANSI colors"), which is how a gain reads green and a loss red without
 * drawing an image.
 */
const ANSI = { green: '\u001b[32m', red: '\u001b[31m', reset: '\u001b[0m' };

/** The ANSI colour a net belongs in: green above zero, red below, plain at zero. */
function ansiFor(value) {
  const rounded = Math.round((Number(value) || 0) * 100) / 100;
  if (rounded > 0) return ANSI.green;
  if (rounded < 0) return ANSI.red;
  return '';
}

/**
 * Money with an explicit sign and no thousands separator, e.g. "+$896.65".
 * The sign is taken from the ROUNDED value, so a figure that rounds to zero
 * never renders as the nonsensical "-$0.00".
 */
function formatNet(value) {
  const n = Number(value) || 0;
  const rounded = Math.round(n * 100) / 100;
  return `${rounded < 0 ? '-' : '+'}$${Math.abs(rounded).toFixed(2)}`;
}

/**
 * True when the last import is older than the threshold AND the market is open,
 * which is the only combination where an old number is actually misleading.
 */
function isStale(importedAt, now, staleMinutes) {
  if (importedAt == null) return false;
  const minutes = staleMinutes == null ? DEFAULT_STALE_MINUTES : staleMinutes;
  if (!(minutes > 0)) return false;
  if (!isMarketOpen(now)) return false;
  return (Number(now) - Number(importedAt)) > minutes * 60_000;
}

/** The labels that go in front of the number: profile first, then account. */
function titlePrefix(opts) {
  return (opts.isTestProfile ? TEST_PREFIX : '') + (opts.paperMode ? PAPER_PREFIX : '');
}

/**
 * True when the most recent import attempt failed. The watcher clears `errorCode` on
 * every success and sets it on every failure, so a latched code *is* "the last attempt
 * failed" — there is no time threshold and no market-hours gate, because a number that
 * has stopped being refreshed is misleading at any hour.
 */
function hasFailedImport(state) {
  return !!(state && state.errorCode);
}

/** An error message shortened to fit one tooltip line, with an ellipsis when it was cut. */
function shortReason(message) {
  const text = String(message == null ? '' : message).replace(/\s+/g, ' ').trim();
  if (text.length <= MAX_TOOLTIP_REASON) return text;
  return text.slice(0, MAX_TOOLTIP_REASON - 1) + '…';
}

/**
 * Builds the menu-bar title from the import state: a signed net, a warning marker when
 * the import is stale or the last attempt failed, or a dash when there is nothing to show.
 */
function trayTitle(state, options) {
  const opts = options || {};
  const now = opts.now == null ? Date.now() : Number(opts.now);
  const prefix = titlePrefix(opts);
  const failed = hasFailedImport(state);

  // Nothing good to fall back on. The dash already says "do not act on this", but the
  // marker distinguishes "nothing imported yet" from "the import is broken".
  if (!state || !state.session || state.importedAt == null) {
    return prefix + NO_DATA_TITLE + (failed ? STALE_MARKER : '');
  }

  const base = formatNet(state.session.netPnl);
  const warn = failed || isStale(state.importedAt, now, opts.staleMinutes);
  return prefix + (warn ? base + STALE_MARKER : base);
}

/**
 * The title with ANSI colour applied — green for a gain, red for a loss, plain when
 * there is nothing to show. The uncoloured text is always `trayTitle()`, so stripping
 * the escapes can never change what the number says.
 */
function trayTitleColoured(state, options) {
  const plain = trayTitle(state, options);
  if (!state || !state.session || state.importedAt == null) return plain;
  const colour = ansiFor(state.session.netPnl);
  return colour ? `${colour}${plain}${ANSI.reset}` : plain;
}

/** Removes ANSI escapes, so a test (or a log line) can read the title as text. */
function stripAnsi(text) {
  // eslint-disable-next-line no-control-regex
  return String(text == null ? '' : text).replace(/\u001b\[[0-9;]*m/g, '');
}

/**
 * Names where the displayed number came from, so "as of" is never ambiguous. The feed's
 * collection is named too: the two brokers keep their fills in different places and
 * reading the wrong one is the failure this whole line exists to make visible.
 */
function sourceLabel(source, feedSource) {
  if (source === 'feed') return `Live feed${feedSource ? ` (${feedSource})` : ''} read`;
  if (source === 'csv')  return 'From the export, imported';
  return 'Imported';
}

/**
 * One line saying how the broker's own numbers compare with ours.
 *
 * A DIFFERENCE is informational and worded as such: TVCM-31 established that the broker's
 * figure goes absent, freezes and drifts, so it cannot be used to call ours wrong. BLIND
 * is a real fault and is reported through the failure line instead, so it is never said
 * twice.
 */
function crossCheckLine(check) {
  if (!check) return null;
  if (check.state === 'blind')       return null;   // said once, as a failure
  if (check.state === 'ok')          return 'Broker cross-check: OK';
  if (check.state === 'unavailable') return `Broker cross-check: not available — ${shortReason(check.message)}`;
  return `Broker cross-check: for information — ${shortReason(check.message)}`;
}

/** A longer line for the tray tooltip, where there is room to say which session it is. */
function trayTooltip(state, options) {
  const opts = options || {};
  const now = opts.now == null ? Date.now() : Number(opts.now);
  if (!state || !state.session || state.importedAt == null) {
    const head = (opts.isTestProfile ? 'TEST PROFILE — ' : '') + (opts.paperMode ? 'PAPER — ' : '');
    // An attempt that failed must not be reported as "nothing has happened yet".
    if (hasFailedImport(state)) {
      return head + 'Trading Analyzer — no usable order-history import\n' +
             `Last import failed: ${state.errorCode} — ${shortReason(state.errorMessage)}`;
    }
    return head + 'Trading Analyzer — no order-history import yet';
  }
  const s = state.session;
  const when = new Date(state.importedAt).toLocaleTimeString('en-US',
    { timeZone: 'America/Chicago', hour: 'numeric', minute: '2-digit' });
  const lines = [];
  if (opts.isTestProfile) lines.push('TEST PROFILE — not your everyday TVCM');
  if (opts.paperMode) lines.push('PAPER — paper account, not real money');
  lines.push(
    `Session ${s.sessionDate}${state.isFallback ? ' (last session with fills)' : ''}`,
    `Net ${formatNet(s.netPnl)}  ·  Gross ${formatNet(s.grossPnl)}  ·  Fees $${s.fees.toFixed(2)}`,
    `${s.contractSides} contract-sides (${s.roundTrips} RT)`,
    `${sourceLabel(opts.source, opts.feedSource)} ${when} CT${isStale(state.importedAt, now, opts.staleMinutes) ? ' — stale' : ''}`,
  );
  // Only the feed is cross-checked; the export is the record, not a thing to check.
  if (opts.source === 'feed') {
    const line = crossCheckLine(opts.crossCheck);
    if (line) lines.push(line);
  }
  if (s.openPositionAtEnd !== 0) lines.push(`Open position ${s.openPositionAtEnd > 0 ? '+' : ''}${s.openPositionAtEnd}`);
  if (hasFailedImport(state)) {
    lines.push(`Last import failed: ${state.errorCode} — ${shortReason(state.errorMessage)}`);
    // Only true when the displayed number really is older than the last attempt. A
    // successful read that merely disagrees with the broker is still a fresh number.
    lines.push('Showing the last good import — the number above is not being refreshed');
  }
  if (opts.switchHint) lines.push(opts.switchHint);
  if (opts.feedReason) lines.push(`Live feed: ${shortReason(opts.feedReason)}`);
  return lines.join('\n');
}

module.exports = {
  NO_DATA_TITLE, STALE_MARKER, TEST_PREFIX, PAPER_PREFIX,
  DEFAULT_STALE_MINUTES, MAX_TOOLTIP_REASON, ANSI,
  formatNet, ansiFor, isStale, hasFailedImport, shortReason, titlePrefix, sourceLabel, crossCheckLine,
  trayTitle, trayTitleColoured, stripAnsi, trayTooltip,
};
