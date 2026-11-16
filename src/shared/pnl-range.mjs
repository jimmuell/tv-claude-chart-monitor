/**
 * Combining several trading days in the Order History & P&L window.
 *
 * ESM on purpose, like pnl-view.mjs: Vite serves source files to the window as native
 * modules, so a CommonJS file here would arrive in the browser as unparsed text.
 *
 * One rule governs everything in this file: **a combined total is the SUM of each day's
 * session total.** FIFO is never re-run across a range. The per-day figures are the ones
 * reconciled against AMP's statement (TVCM-13), and a "combined" number computed any
 * other way would disagree with the broker on every day that carried a position overnight
 * — which is most of them. Adding the per-day totals also makes double-counting a carried
 * trade impossible, because each day's own total already accounts for its carry.
 *
 * A trading day runs 17:00–17:00 CT and is named for the day it ENDS, so Sunday evening
 * already belongs to Monday. Everything here works on those session-date strings as
 * calendar labels; no timezone conversion happens, because none is needed.
 */

/** The period choices in the window's selector, in the order they appear. */
export const PERIODS = [
  { key: 'today',  label: 'Today' },
  { key: 'last2',  label: 'Last 2 days' },
  { key: 'week',   label: 'This week' },
  { key: 'month',  label: 'This month' },
  { key: 'custom', label: 'Custom' },
];

/** Cents, added without floating-point dust. */
function toCents(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

/** A "YYYY-MM-DD" label as a UTC calendar instant, used only for day arithmetic. */
function asUtc(dateText) {
  const [y, m, d] = String(dateText).split('-').map(Number);
  return Date.UTC(y, m - 1, d);
}

/** Day-of-week for a session date, 0 = Sunday, using the calendar and nothing else. */
function dow(dateText) {
  return new Date(asUtc(dateText)).getUTCDay();
}

/** "YYYY-MM-DD" shifted by whole days, staying on the calendar. */
function shiftDays(dateText, days) {
  return new Date(asUtc(dateText) + days * 86_400_000).toISOString().slice(0, 10);
}

/**
 * The first session of the trading week containing this one — the Monday, because the
 * week's first session opens Sunday at 17:00 CT and is named for the Monday it ends on.
 */
export function weekStartSession(sessionDate) {
  const d = dow(sessionDate);
  // Sunday (0) is only ever a session date if trading happened Saturday evening; treat it
  // as the start of its own week rather than reaching back six days.
  const back = d === 0 ? 0 : d - 1;
  return shiftDays(sessionDate, -back);
}

/** The first day of the calendar month a session belongs to. */
export function monthStartSession(sessionDate) {
  return String(sessionDate).slice(0, 8) + '01';
}

/** Every session date the supplied sessions cover, oldest first and deduped. */
export function availableDates(sessions) {
  if (!Array.isArray(sessions)) return [];
  return Array.from(new Set(sessions.filter(Boolean).map(s => s.sessionDate))).sort();
}

/**
 * Which trading days a period covers. `available` is the days the caller has data for —
 * supplying one mode's sessions is what keeps paper and live apart, because a day that is
 * not in `available` can never appear in a range.
 */
export function rangeFor(period, options) {
  const o = options || {};
  const today = o.today;
  const avail = (o.available || []).filter(Boolean).slice().sort();
  const upToToday = avail.filter(d => d <= today);
  const span = (dates) => ({
    period, dates,
    from: dates.length ? dates[0] : null,
    to:   dates.length ? dates[dates.length - 1] : null,
  });

  if (period === 'last2') {
    // Trading days, not calendar days: Friday and Monday are consecutive.
    return span(upToToday.slice(-2));
  }
  if (period === 'week') {
    const start = weekStartSession(today);
    return span(upToToday.filter(d => d >= start));
  }
  if (period === 'month') {
    const start = monthStartSession(today);
    return span(upToToday.filter(d => d >= start));
  }
  if (period === 'custom') {
    // Read the two pickers as a range whichever way round they were set.
    const lo = o.from && o.to ? (o.from <= o.to ? o.from : o.to) : (o.from || o.to || today);
    const hi = o.from && o.to ? (o.from <= o.to ? o.to : o.from) : (o.to || o.from || today);
    return span(avail.filter(d => d >= lo && d <= hi));
  }
  // 'today', and anything unrecognised: never widen a range by accident.
  return span([today]);
}

/**
 * Adds up the days in a range. Returns the combined totals, a per-day breakdown newest
 * first (including days with no trading, which count as zero), and the day count.
 */
export function combineSessions(sessions, dates) {
  const byDate = new Map();
  for (const s of (sessions || []).filter(Boolean)) byDate.set(s.sessionDate, s);
  const wanted = Array.from(new Set(dates || []));

  const totals = { netPnl: 0, grossPnl: 0, fees: 0, contractSides: 0, roundTrips: 0, tradeCount: 0 };
  const perDay = [];
  for (const date of wanted) {
    const s = byDate.get(date);
    perDay.push({
      sessionDate:       date,
      hasData:           !!s,
      netPnl:            s ? toCents(s.netPnl) : 0,
      grossPnl:          s ? toCents(s.grossPnl) : 0,
      fees:              s ? toCents(s.fees) : 0,
      contractSides:     s ? (Number(s.contractSides) || 0) : 0,
      tradeCount:        s ? (Number(s.tradeCount) || 0) : 0,
      openPositionAtEnd: s ? (Number(s.openPositionAtEnd) || 0) : 0,
    });
    if (!s) continue;
    totals.netPnl        = toCents(totals.netPnl + Number(s.netPnl || 0));
    totals.grossPnl      = toCents(totals.grossPnl + Number(s.grossPnl || 0));
    totals.fees          = toCents(totals.fees + Number(s.fees || 0));
    totals.contractSides += Number(s.contractSides) || 0;
    totals.tradeCount    += Number(s.tradeCount) || 0;
  }
  totals.roundTrips = totals.contractSides / 2;
  perDay.sort((a, b) => (a.sessionDate < b.sessionDate ? 1 : -1));
  return { totals, perDay, dayCount: wanted.length };
}

/**
 * The trades or fills that fall in a range, newest first. A trade belongs to the day its
 * own session reports it — the day it CLOSED, or for a still-open trade the day it opened.
 */
export function rowsInRange(rows, dates, kind) {
  const want = new Set(dates || []);
  const picked = (rows || []).filter(Boolean).filter(row => {
    if (kind === 'fills') return want.has(row.sessionDate);
    if (row.status === 'OPEN') return want.has(row.openSessionDate);
    return want.has(row.sessionDate);
  });
  const when = (row) => String(row.closeTime || row.openTime || row.fillTime || '');
  return picked.sort((a, b) => (when(a) < when(b) ? 1 : when(a) > when(b) ? -1 : 0));
}

/** The header's description of the range, e.g. "2026-11-13 → 2026-11-16 · 2 trading days". */
export function rangeLabel(range) {
  const n = range && range.dates ? range.dates.length : 0;
  if (n === 0) return 'no trading days';
  if (n === 1) return String(range.dates[0]);
  return `${range.from} → ${range.to} · ${n} trading days`;
}
