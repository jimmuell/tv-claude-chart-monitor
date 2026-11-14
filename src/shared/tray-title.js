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
 * to act on. Second, a warning marker when the numbers have gone stale *while the
 * market is open* — a stale figure on a Saturday is simply Friday's result and
 * needs no warning.
 */

const { isMarketOpen } = require('./session-clock.js');

/** The dash shown when there is nothing trustworthy to display. */
const NO_DATA_TITLE = 'P&L —';

/** Appended when the import has gone stale during live trading. */
const STALE_MARKER = ' ⚠';

/**
 * Prefixed when TVCM is running on a non-default userData profile. A test copy puts a
 * second tray in the menu bar next to the real one, and three prompts running they were
 * read as the same thing. This makes them impossible to confuse.
 */
const TEST_PREFIX = 'TEST ';

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

/**
 * Builds the menu-bar title from the import state: a signed net, a stale marker
 * when it applies, or a dash when there is nothing to show.
 */
function trayTitle(state, options) {
  const opts = options || {};
  const now = opts.now == null ? Date.now() : Number(opts.now);
  const prefix = opts.isTestProfile ? TEST_PREFIX : '';

  if (!state || !state.session || state.importedAt == null) return prefix + NO_DATA_TITLE;

  const base = formatNet(state.session.netPnl);
  return prefix + (isStale(state.importedAt, now, opts.staleMinutes) ? base + STALE_MARKER : base);
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

/** A longer line for the tray tooltip, where there is room to say which session it is. */
function trayTooltip(state, options) {
  const opts = options || {};
  const now = opts.now == null ? Date.now() : Number(opts.now);
  if (!state || !state.session || state.importedAt == null) {
    return (opts.isTestProfile ? 'TEST PROFILE — ' : '') + 'Trading Analyzer — no order-history import yet';
  }
  const s = state.session;
  const when = new Date(state.importedAt).toLocaleTimeString('en-US',
    { timeZone: 'America/Chicago', hour: 'numeric', minute: '2-digit' });
  const lines = [];
  if (opts.isTestProfile) lines.push('TEST PROFILE — not your everyday TVCM');
  lines.push(
    `Session ${s.sessionDate}${state.isFallback ? ' (last session with fills)' : ''}`,
    `Net ${formatNet(s.netPnl)}  ·  Gross ${formatNet(s.grossPnl)}  ·  Fees $${s.fees.toFixed(2)}`,
    `${s.contractSides} contract-sides (${s.roundTrips} RT)`,
    `Imported ${when} CT${isStale(state.importedAt, now, opts.staleMinutes) ? ' — stale' : ''}`,
  );
  if (s.openPositionAtEnd !== 0) lines.push(`Open position ${s.openPositionAtEnd > 0 ? '+' : ''}${s.openPositionAtEnd}`);
  if (state.errorCode) lines.push(`Last import failed: ${state.errorCode}`);
  return lines.join('\n');
}

module.exports = {
  NO_DATA_TITLE, STALE_MARKER, TEST_PREFIX, DEFAULT_STALE_MINUTES, ANSI,
  formatNet, ansiFor, isStale, trayTitle, trayTitleColoured, stripAnsi, trayTooltip,
};
