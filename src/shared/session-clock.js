'use strict';

/**
 * Chicago trading-session clock.
 *
 * Everything about when a session starts, which session "now" belongs to, and
 * whether the market is open lives here, so the tray title, the watcher and the
 * panel cannot drift apart on the answer.
 *
 * A session runs 17:00 to 17:00 America/Chicago and is named for the day it ENDS
 * (the same RULE 1 the order-history engine uses). The CME globex week runs
 * Sun 17:00 CT to Fri 16:00 CT, with a 16:00-17:00 CT maintenance break daily.
 */

const CHICAGO = 'America/Chicago';

/** Session boundary and the daily maintenance break, in Chicago hours. */
const SESSION_ROLLOVER_HOUR = 17;
const DAILY_CLOSE_HOUR      = 16;

const PARTS_FMT = new Intl.DateTimeFormat('en-US', {
  timeZone: CHICAGO, hour12: false,
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit', weekday: 'short',
});

const WEEKDAY_INDEX = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

/** Breaks an instant into Chicago wall-clock pieces, which is the only clock that matters here. */
function chicagoParts(date) {
  const d = date instanceof Date ? date : new Date(date);
  const out = {};
  for (const p of PARTS_FMT.formatToParts(d)) out[p.type] = p.value;
  // Intl renders midnight as "24" in some ICU versions; normalise it.
  const hour = Number(out.hour) % 24;
  return {
    date:    `${out.year}-${out.month}-${out.day}`,
    year:    Number(out.year),
    month:   Number(out.month),
    day:     Number(out.day),
    hour,
    minute:  Number(out.minute),
    second:  Number(out.second),
    weekday: out.weekday,
    dow:     WEEKDAY_INDEX[out.weekday],
  };
}

/** Adds one day to a "YYYY-MM-DD" string, using Date purely as a calendar. */
function nextDay(dateText) {
  const [y, m, d] = dateText.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + 1);
  return dt.toISOString().slice(0, 10);
}

/** The trading session an instant falls in, named for the day that session ends. */
function currentSessionDate(date) {
  const p = chicagoParts(date);
  return p.hour >= SESSION_ROLLOVER_HOUR ? nextDay(p.date) : p.date;
}

/**
 * True while the futures market is trading: Sun 17:00 CT through Fri 16:00 CT,
 * minus the 16:00-17:00 CT maintenance break every weekday.
 */
function isMarketOpen(date) {
  const p = chicagoParts(date);
  if (p.dow === 6) return false;                                   // Saturday: closed all day
  if (p.dow === 0) return p.hour >= SESSION_ROLLOVER_HOUR;          // Sunday: opens at 17:00
  if (p.dow === 5 && p.hour >= DAILY_CLOSE_HOUR) return false;      // Friday: closed from 16:00
  // Mon-Fri: the daily break between 16:00 and 17:00
  return !(p.hour >= DAILY_CLOSE_HOUR && p.hour < SESSION_ROLLOVER_HOUR);
}

/** Plain-English reason the market is shut, or null when it is trading. */
function marketClosedReason(date) {
  const p = chicagoParts(date);
  if (p.dow === 6) return 'weekend';
  if (p.dow === 0 && p.hour < SESSION_ROLLOVER_HOUR) return 'weekend';
  if (p.dow === 5 && p.hour >= DAILY_CLOSE_HOUR) return 'weekend';
  if (p.hour >= DAILY_CLOSE_HOUR && p.hour < SESSION_ROLLOVER_HOUR) return 'daily break';
  return null;
}

/** A short Chicago clock reading like "9:41 AM CT", for "as of" labels. */
function chicagoTimeLabel(date) {
  const p = chicagoParts(date);
  const h12 = p.hour % 12 === 0 ? 12 : p.hour % 12;
  const ampm = p.hour < 12 ? 'AM' : 'PM';
  return `${h12}:${String(p.minute).padStart(2, '0')} ${ampm} CT`;
}

module.exports = {
  CHICAGO,
  SESSION_ROLLOVER_HOUR,
  DAILY_CLOSE_HOUR,
  chicagoParts,
  nextDay,
  currentSessionDate,
  isMarketOpen,
  marketClosedReason,
  chicagoTimeLabel,
};
