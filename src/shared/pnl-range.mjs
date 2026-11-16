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

/**
 * Every date the supplied sessions cover, oldest first and deduped.
 *
 * In calendar mode a trading day touches TWO calendar dates — the evening it opened and
 * the day it ended — so both are offered, or Sunday evening's trading would have no day
 * to be picked by.
 */
export function availableDates(sessions, mode) {
  if (!Array.isArray(sessions)) return [];
  const dates = new Set();
  for (const s of sessions.filter(Boolean)) {
    dates.add(s.sessionDate);
    if (mode === 'calendar') dates.add(shiftDays(s.sessionDate, -1));
  }
  return Array.from(dates).sort();
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
export function rowsInRange(rows, dates, kind, mode) {
  const want = new Set(dates || []);
  const picked = (rows || []).filter(Boolean).filter(row => {
    // Calendar mode asks a different question of the same row: not which 17:00-17:00
    // session it belongs to, but which midnight-to-midnight day it fell on.
    if (mode === 'calendar') return want.has(calendarDateOf(row, kind));
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

// ── Trading day vs calendar day ──────────────────────────────────────────
//
// Jim (2026-11-16): "when I click Today it includes Sunday's trades". It does, and it is
// right: AMP's trading day runs 17:00–17:00 CT, so Monday's session opened on Sunday
// evening. Right is not the same as obvious, so the window now says which window it is
// showing and offers the other one.
//
// Calendar mode is a DISPLAY re-bucketing only. The menu bar never leaves the AMP
// trading day, and a calendar total is not a statement total — a trade that opened
// Sunday evening and closed Monday morning lands wholly on Monday, so Sunday's calendar
// total is missing P&L that AMP booked to the Monday session anyway.

/** The two ways a day can be drawn, in the order the switch shows them. */
export const DAY_MODES = [
  { key: 'trading',  label: 'Trading day (matches AMP)' },
  { key: 'calendar', label: 'Calendar day (midnight–midnight)' },
];

/** The warning shown whenever calendar days are on. */
export const CALENDAR_NOTE = "Calendar-day totals won't match AMP's daily statement.";

/** Weekday names, indexed the way the calendar does it. */
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** "Mon" for a "YYYY-MM-DD" label, read straight off the calendar. */
function weekday(dateText) {
  return WEEKDAYS[dow(dateText)] || '?';
}

/** "11/16" for a "YYYY-MM-DD" label. */
function monthDay(dateText) {
  return `${String(dateText).slice(5, 7)}/${String(dateText).slice(8, 10)}`;
}

/** Today's Chicago calendar date, which on a Sunday evening is NOT the session date. */
export function chicagoToday(now) {
  const d = now ? new Date(now) : new Date();
  return d.toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });
}

/**
 * The calendar date a row fell on. A trade belongs to the date it CLOSED, because that
 * is when its P&L became real; a trade still open belongs to the date it opened.
 */
export function calendarDateOf(row, kind) {
  if (!row) return null;
  const stamp = kind === 'fills' ? row.fillTime : (row.closeTime || row.openTime);
  return stamp ? String(stamp).slice(0, 10) : null;
}

/**
 * Which 17:00–17:00 sessions have to be fetched to draw these calendar days. A calendar
 * day is split across two of them: midnight to 17:00 belongs to the session of the same
 * name, and 17:00 to midnight to the NEXT one.
 */
export function sessionsCoveringCalendar(dates) {
  const want = new Set();
  for (const d of (dates || []).filter(Boolean)) {
    want.add(d);
    want.add(shiftDays(d, 1));
  }
  return Array.from(want).sort();
}

/**
 * Totals added up from the trade rows themselves, for calendar days only.
 *
 * This is NOT how a trading day is totalled — that stays the statement-proven session
 * figure (TVCM-13). It is the only way to total a calendar day, because no such session
 * exists at the broker, and it is why calendar mode carries a warning.
 */
export function totalsFromRows(trades) {
  const totals = { netPnl: 0, grossPnl: 0, fees: 0, contractSides: 0, roundTrips: 0, tradeCount: 0 };
  for (const t of (trades || []).filter(Boolean)) {
    totals.netPnl    = toCents(totals.netPnl + Number(t.net || 0));
    totals.grossPnl  = toCents(totals.grossPnl + Number(t.gross || 0));
    totals.fees      = toCents(totals.fees + Number(t.fees || 0));
    totals.contractSides += Number(t.contractSides) || 0;
    totals.tradeCount    += 1;
  }
  totals.roundTrips = totals.contractSides / 2;
  return totals;
}

/** The same shape combineSessions returns, but bucketed by calendar date instead. */
export function combineCalendarDays(trades, dates) {
  const wanted = Array.from(new Set(dates || []));
  const rows = (trades || []).filter(Boolean);
  const perDay = wanted.map(date => {
    const mine = rows.filter(t => calendarDateOf(t, 'trades') === date);
    const totals = totalsFromRows(mine);
    return { sessionDate: date, hasData: mine.length > 0, openPositionAtEnd: 0, ...totals };
  });
  perDay.sort((a, b) => (a.sessionDate < b.sessionDate ? 1 : -1));
  const totals = totalsFromRows(rows.filter(t => wanted.includes(calendarDateOf(t, 'trades'))));
  return { totals, perDay, dayCount: wanted.length };
}

/**
 * The window a range actually covers, spelled out, e.g.
 * "Sun 5:00 PM – Mon 4:00 PM CT". Shown beside the period buttons so "Today" can never
 * again look like it has quietly swallowed somebody else's trading.
 */
export function rangeWindowLabel(range, mode) {
  const dates = (range && range.dates) || [];
  if (dates.length === 0) return '';
  const from = dates[0];
  const to   = dates[dates.length - 1];
  const many = dates.length > 1;
  if (mode === 'calendar') {
    const start = many ? `${weekday(from)} ${monthDay(from)}` : weekday(from);
    const end   = many ? `${weekday(to)} ${monthDay(to)} ` : '';
    return `${start} 12:00 AM – ${end}11:59 PM CT`;
  }
  // A trading day opens at 17:00 on the day BEFORE the one it is named for.
  const open = shiftDays(from, -1);
  const start = many ? `${weekday(open)} ${monthDay(open)}` : weekday(open);
  const end   = many ? `${weekday(to)} ${monthDay(to)}` : weekday(to);
  return `${start} 5:00 PM – ${end} 4:00 PM CT`;
}
