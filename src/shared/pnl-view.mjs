/**
 * Display rules for the Order History & P&L window.
 *
 * ESM on purpose: Vite serves source files to the window as native modules, so a
 * CommonJS file here would arrive in the browser as unparsed text.
 *
 * Kept out of the React tree so the rules that matter can be tested without a DOM.
 * Two of them are not cosmetic:
 *
 *   1. The HEADLINE is always the session total — the statement-matching FIFO figure.
 *      The trade list is a breakdown. Summing trades and showing that as the day's P&L
 *      would disagree with the broker on any day with an overnight position.
 *   2. With no import there are no numbers, only an explanation. A fabricated $0.00 and
 *      a real flat day look identical, and only one of them is safe to act on.
 */

/** Money to the cent with thousands separators and an explicit sign, e.g. "+$1,296.25". */
export function fmtMoney(value, opts) {
  const signed = !opts || opts.signed !== false;
  const n = Number(value) || 0;
  const rounded = Math.round(n * 100) / 100;
  const body = Math.abs(rounded).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  if (!signed) return `$${body}`;
  return `${rounded < 0 ? '-' : '+'}$${body}`;
}

/** 'gain' above zero, 'loss' below, 'flat' at zero — the window's only colour decision. */
export function moneyClass(value) {
  const rounded = Math.round((Number(value) || 0) * 100) / 100;
  if (rounded > 0) return 'gain';
  if (rounded < 0) return 'loss';
  return 'flat';
}

/** The clock part of a "YYYY-MM-DD HH:MM:SS" fill time, which is already Chicago local. */
export function fmtClock(fillTime) {
  if (!fillTime) return '—';
  return String(fillTime).slice(11, 19) || '—';
}

/** A fill time as "MM-DD HH:MM:SS", used when a row can belong to the previous day. */
export function fmtStamp(fillTime) {
  if (!fillTime) return '—';
  const s = String(fillTime);
  return `${s.slice(5, 10)} ${s.slice(11, 19)}`;
}

/** An import time as a short Chicago clock reading, e.g. "9:41 AM CT". */
export function fmtImportedAt(ms) {
  if (ms == null) return '—';
  return new Date(ms).toLocaleTimeString('en-US',
    { timeZone: 'America/Chicago', hour: 'numeric', minute: '2-digit' }) + ' CT';
}

/** Contracts phrased both ways, because fees are per side and traders count round trips. */
export function fmtContracts(contractSides) {
  const sides = Number(contractSides) || 0;
  return `${sides.toLocaleString('en-US')} sides (${(sides / 2).toLocaleString('en-US')} RT)`;
}

/** Why there is nothing to show, in the user's terms — never a zero. */
export function emptyMessage(state) {
  if (!state) return 'Waiting for the first import…';
  if (state.errorCode) return `Last import failed — ${state.errorCode}. Showing nothing rather than stale numbers.`;
  const where = state.watchFolder ? ` Watching ${state.watchFolder}.` : '';
  return `No order-history import yet.${where} Export Order History from TradingView and it will appear here.`;
}

/**
 * The Summary tab's rows, in order. The session total leads; the carried line appears
 * only when a trade actually spanned 17:00, and per-trade cent rounding is never shown
 * as an accounting difference because it is not one.
 */
export function summaryRows(detail, state) {
  const s = detail && detail.session;
  if (!s) return [];
  const rows = [
    { key: 'net',       label: 'Net',             value: fmtMoney(s.netPnl),   tone: moneyClass(s.netPnl), headline: true },
    { key: 'gross',     label: 'Gross',           value: fmtMoney(s.grossPnl), tone: moneyClass(s.grossPnl) },
    { key: 'fees',      label: 'Fees',            value: fmtMoney(s.fees, { signed: false }), tone: 'flat' },
    { key: 'contracts', label: 'Contracts',       value: fmtContracts(s.contractSides), tone: 'flat' },
    { key: 'trades',    label: 'Trades',          value: String((detail.boundary && detail.boundary.tradeCount) || 0), tone: 'flat' },
  ];
  if (s.openPositionAtEnd !== 0) {
    rows.push({
      key: 'open', label: 'Open position',
      value: `${s.openPositionAtEnd > 0 ? '+' : ''}${s.openPositionAtEnd} contract${Math.abs(s.openPositionAtEnd) === 1 ? '' : 's'}`,
      tone: 'flat',
    });
  }
  const carried = detail.boundary ? detail.boundary.boundaryNet : 0;
  if (carried !== 0) {
    rows.push({
      key: 'carried', label: 'Carried from/to other sessions',
      value: fmtMoney(carried), tone: moneyClass(carried), note: true,
    });
  }
  rows.push({ key: 'asof', label: 'As of', value: fmtImportedAt(state && state.importedAt), tone: 'flat' });
  return rows;
}

/**
 * The explanation under the carried line, naming which trades moved P&L across 17:00.
 * Returns null when nothing crossed, which is the normal day.
 */
export function carriedExplanation(detail) {
  const b = detail && detail.boundary;
  if (!b || b.boundaryNet === 0) return null;
  const parts = [];
  if (b.outboundTradeIds.length) {
    parts.push(`trade${b.outboundTradeIds.length > 1 ? 's' : ''} #${b.outboundTradeIds.join(', #')} ${b.outboundTradeIds.length > 1 ? 'are' : 'is'} counted here but ${b.outboundTradeIds.length > 1 ? 'were' : 'was'} realized in an earlier session`);
  }
  if (b.inboundTradeIds.length) {
    parts.push(`trade${b.inboundTradeIds.length > 1 ? 's' : ''} #${b.inboundTradeIds.join(', #')} ${b.inboundTradeIds.length > 1 ? 'were' : 'was'} realized here but ${b.inboundTradeIds.length > 1 ? 'are' : 'is'} counted in a later session`);
  }
  const body = parts.join('; ');
  return `The session total above is what the statement shows — ${body}.`;
}

/** One Trades-tab row, already formatted, so the component only places strings. */
export function tradeRow(t) {
  return {
    id:        t.id,
    time:      `${fmtClock(t.openTime)} – ${t.closeTime ? fmtClock(t.closeTime) : 'open'}`,
    direction: t.direction,
    size:      String(t.maxPositionSize),
    avgEntry:  t.avgEntry == null ? '—' : t.avgEntry.toFixed(2),
    avgExit:   t.avgExit == null ? '—' : t.avgExit.toFixed(2),
    fees:      fmtMoney(t.fees, { signed: false }),
    net:       t.net == null ? '—' : fmtMoney(t.net),
    tone:      t.net == null ? 'flat' : moneyClass(t.net),
    isOpen:    t.status === 'OPEN',
    crosses:   t.crossesBoundary,
  };
}

/** The fills belonging to one trade, matched on the order ids the trade recorded. */
export function fillsForTrade(trade, fills) {
  const ids = new Set(trade.orderIds);
  return (fills || []).filter(f => ids.has(f.orderId));
}

