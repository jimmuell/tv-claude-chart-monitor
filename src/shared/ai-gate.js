'use strict';

/**
 * When TVCM may spend money on an LLM.
 *
 * Jim's recommendation scorecard was below break-even and the Anthropic bill was
 * climbing, so on 2026-11-17 he cut the spending — but **not to zero** (15:59): AI
 * analysis runs **automatically 07:30–16:30 CT on trading days** and is **manual the rest
 * of the time**. TVCM-44 built the first version of that instruction, which said off
 * entirely; this is the one he actually asked for.
 *
 * The distinction that matters is not on/off, it is **who asked**:
 *
 *   AUTOMATIC — the scheduler, on bar close. Costs money without anybody deciding to
 *   spend it, so it is confined to the window. Outside it the scheduler makes no call
 *   at all; it does not queue one, it does not make one late.
 *
 *   MANUAL — the Refresh button, in the panel or the tray. Always allowed, because Jim
 *   pressing it IS the decision to spend. One press, one analysis.
 *
 * The P&L half of the app — live feed, menu bar, Order History window, corrections — has
 * never made an LLM call and is untouched by any of this.
 *
 * Pure: no Electron, no network, no settings file and no clock of its own — the caller
 * passes what it has, so the same rules can be tested in milliseconds, across a DST
 * boundary, without waiting for one.
 */

/** Shown wherever commentary would have been, when AI is switched off entirely. */
const AI_OFF_MESSAGE = 'AI analysis is off';

/** The longer form, for a status line or a thrown error. */
const AI_OFF_REASON =
  'AI analysis is off — turn it on in Settings if you want chart commentary again';

/** Raised when something asks for an analysis while AI is off. */
const AI_OFF_CODE = 'TVCM-AI-OFF';

/** Raised when the SCHEDULER asks for one outside the automatic window. */
const AI_OUTSIDE_WINDOW_CODE = 'TVCM-AI-OUTSIDE-WINDOW';

/** The window's defaults, in America/Chicago, as Jim gave them. */
const DEFAULT_AUTO_START = '07:30';
const DEFAULT_AUTO_END   = '16:30';

/** "HH:MM" as minutes past midnight, or null when it is not a time at all. */
function parseHhMm(text) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(text == null ? '' : text).trim());
  if (!m) return null;
  const h = Number(m[1]), min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

/** "7:30" from "07:30", for a sentence rather than a field. */
function spokenTime(text) {
  const mins = parseHhMm(text);
  if (mins === null) return String(text);
  const h24 = Math.floor(mins / 60), m = mins % 60;
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  return `${h12}:${String(m).padStart(2, '0')}`;
}

/**
 * The Chicago wall clock at an instant, as {minutes, weekday}. Read through the calendar
 * rather than by subtracting an offset, so it is right on both sides of a DST change.
 */
function chicagoClock(now) {
  const at = new Date(now == null ? Date.now() : now);
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago', hour12: false,
    hour: '2-digit', minute: '2-digit', weekday: 'short',
  }).formatToParts(at);
  const get = (type) => (parts.find(p => p.type === type) || {}).value;
  const hour = Number(get('hour')) % 24;      // en-US can render midnight as 24
  const minute = Number(get('minute'));
  const names = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return { minutes: hour * 60 + minute, weekday: names[get('weekday')] };
}

/** The window as configured, falling back to Jim's defaults when a field is unusable. */
function autoWindow(settings) {
  const s = settings || {};
  const start = parseHhMm(s.aiAutoWindowStart) === null ? DEFAULT_AUTO_START : s.aiAutoWindowStart;
  const end   = parseHhMm(s.aiAutoWindowEnd)   === null ? DEFAULT_AUTO_END   : s.aiAutoWindowEnd;
  return { start, end, startMinutes: parseHhMm(start), endMinutes: parseHhMm(end) };
}

/** Mon–Fri in Chicago. CME holidays are not known to the app — see the report. */
function isTradingWeekday(now) {
  const d = chicagoClock(now).weekday;
  return d >= 1 && d <= 5;
}

/**
 * Inside the automatic window: at or after the start and STRICTLY BEFORE the end, so
 * "07:30–16:30" means the 07:30 bar is analysed and the 16:30 one is not.
 */
function insideAutoWindow(settings, now) {
  const w = autoWindow(settings);
  const { minutes } = chicagoClock(now);
  return minutes >= w.startMinutes && minutes < w.endMinutes;
}

/**
 * True when TVCM may analyse **on its own**. Everything has to line up: AI is on at all,
 * it is a trading weekday, and the Chicago clock is inside the window.
 */
function aiAutoAllowed(settings, now) {
  if (!aiAllowed(settings)) return false;
  if (!isTradingWeekday(now)) return false;
  return insideAutoWindow(settings, now);
}

/** True when Jim may ask for one himself. Pressing Refresh IS the decision to spend. */
function aiManualAllowed(settings) {
  return aiAllowed(settings);
}

/**
 * Whether AI is switched on at all. Since TVCM-46 the default is ON, because the
 * spending is bounded by the window rather than by the switch.
 */
function aiAllowed(settings) {
  return !settings || settings.aiAnalysisEnabled !== false;
}

/** The reason to show when AI is off, or null when it is on and there is nothing to say. */
function aiOffReason(settings) {
  return aiAllowed(settings) ? null : AI_OFF_REASON;
}

/** The sentence the panel shows outside the window, naming the hours and what to press. */
function autoWindowText(settings) {
  const w = autoWindow(settings);
  return `Auto-analysis ${spokenTime(w.start)}–${spokenTime(w.end)} CT — press Refresh for an update`;
}

/** One line for a log or a status bar: whether auto is live, and why not when it is not. */
function autoStatusText(settings, now) {
  if (!aiAllowed(settings)) return AI_OFF_MESSAGE;
  if (!isTradingWeekday(now)) return `${autoWindowText(settings)} (weekend)`;
  if (!insideAutoWindow(settings, now)) return autoWindowText(settings);
  return null;
}

module.exports = {
  AI_OFF_MESSAGE, AI_OFF_REASON, AI_OFF_CODE, AI_OUTSIDE_WINDOW_CODE,
  DEFAULT_AUTO_START, DEFAULT_AUTO_END,
  parseHhMm, spokenTime, chicagoClock, autoWindow, isTradingWeekday, insideAutoWindow,
  aiAllowed, aiAutoAllowed, aiManualAllowed, aiOffReason, autoWindowText, autoStatusText,
};
