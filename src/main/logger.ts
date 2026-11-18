// logger.ts — always-on log file for the main process.
//
// Electron's stdout is not captured when the app runs detached, so a blank
// panel or a crash during a live session left no evidence behind. This mirrors
// every console.log/warn/error to a file on EVERY start, with no env var to
// remember, and rotates by size so it cannot fill the disk.
//
// Nothing sensitive is allowed through: redact() scrubs credential- and
// account-shaped text before a line is written. Logging must never break the
// app, so every filesystem call here is wrapped.

import { app } from 'electron';
import * as fs from 'fs';
import * as path from 'path';

const MAX_BYTES   = 1024 * 1024; // rotate once the live file passes 1 MB
const ARCHIVES    = 4;           // main.log + main.1..main.4 = 5 files kept
const PLACEHOLDER = '[REDACTED]';

/** Folder the log files live in — userData/logs. */
export function logDir(): string {
  return path.join(app.getPath('userData'), 'logs');
}

/** Full path of the log file currently being written. */
export function logFilePath(): string {
  return path.join(logDir(), 'main.log');
}

/** Path of one rotated archive, 1 being the most recent. */
function archivePath(n: number): string {
  return path.join(logDir(), `main.${n}.log`);
}

// Credential and account shapes, most specific first. Each pattern keeps the
// label it matched so a log line still says WHICH secret was withheld.
const REDACTIONS: Array<[RegExp, string]> = [
  // Provider key shapes: Anthropic sk-ant-..., generic sk-..., Google AIza...
  [/sk-ant-[A-Za-z0-9_-]{8,}/g,                                   PLACEHOLDER],
  [/\bsk-[A-Za-z0-9_-]{16,}/g,                                    PLACEHOLDER],
  [/\bAIza[A-Za-z0-9_-]{10,}/g,                                   PLACEHOLDER],
  // Bearer tokens in a header or a log of one.
  [/\b[Bb]earer\s+[A-Za-z0-9._~+/=-]{8,}/g,                       `Bearer ${PLACEHOLDER}`],
  // JSON or object form: "apiKey": "...", token: '...', secret: "..."
  [/("|')?(api[_-]?key|apikey|token|secret|password|authorization)("|')?(\s*[:=]\s*)("|')[^"']*("|')/gi,
    `$1$2$3$4"${PLACEHOLDER}"`],
  // Env / query form: ANTHROPIC_API_KEY=..., gemini_api_key=...&
  [/\b([A-Za-z0-9_]*(?:API[_-]?KEY|TOKEN|SECRET|PASSWORD))\b(\s*=\s*)([^\s&;'"]+)/gi,
    `$1$2${PLACEHOLDER}`],
  // Account NUMBERS only. The account TYPE (amp_live, amp_demo) is a safety
  // flag Jim needs to see, so it is deliberately left alone.
  [/\b(account[_-]?(?:number|num|no|id))("|')?(\s*[:=]\s*)("|')?[A-Za-z0-9-]+("|')?/gi,
    `$1$2$3${PLACEHOLDER}`],
];

/** Strip anything credential- or account-number-shaped out of one line. */
export function redact(text: string): string {
  let out = String(text);
  for (const [pattern, replacement] of REDACTIONS) {
    out = out.replace(pattern, replacement);
  }
  return out;
}

/** Minutes east of UTC for America/Chicago at this instant (negative here). */
function chicagoOffsetMinutes(d: Date): number {
  const name = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago', timeZoneName: 'longOffset',
  }).formatToParts(d).find(p => p.type === 'timeZoneName')?.value ?? 'GMT+00:00';
  const m = /GMT([+-])(\d{2}):(\d{2})/.exec(name);
  if (!m) return 0;
  return (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3]));
}

/** ISO-8601 timestamp in America/Chicago, e.g. 2026-10-27T07:30:12.345-05:00. */
export function chicagoStamp(d: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Chicago', hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(d);
  const p: Record<string, string> = {};
  for (const part of parts) p[part.type] = part.value;
  const hour = p.hour === '24' ? '00' : p.hour; // some ICU builds say 24 at midnight
  const ms   = String(d.getMilliseconds()).padStart(3, '0');
  const off  = chicagoOffsetMinutes(d);
  const sign = off < 0 ? '-' : '+';
  const abs  = Math.abs(off);
  const hh   = String(Math.floor(abs / 60)).padStart(2, '0');
  const mm   = String(abs % 60).padStart(2, '0');
  return `${p.year}-${p.month}-${p.day}T${hour}:${p.minute}:${p.second}.${ms}${sign}${hh}:${mm}`;
}

/** Shift main.log to main.1.log (and so on) once it outgrows MAX_BYTES. */
export function rotateIfNeeded(): void {
  try {
    const live = logFilePath();
    if (!fs.existsSync(live) || fs.statSync(live).size < MAX_BYTES) return;
    try { fs.rmSync(archivePath(ARCHIVES), { force: true }); } catch { /* ignore */ }
    for (let n = ARCHIVES - 1; n >= 1; n--) {
      if (fs.existsSync(archivePath(n))) fs.renameSync(archivePath(n), archivePath(n + 1));
    }
    fs.renameSync(live, archivePath(1));
  } catch { /* rotation failing must not stop logging */ }
}

/** Append one redacted, timestamped line. Never throws. */
export function logLine(level: string, message: string): void {
  try {
    fs.mkdirSync(logDir(), { recursive: true });
    rotateIfNeeded();
    fs.appendFileSync(logFilePath(), `${chicagoStamp()} [${level}] ${redact(message)}\n`);
  } catch { /* logging must never break the app */ }
}

/** Turn console args into one string without throwing on a circular object. */
export function formatArgs(args: unknown[]): string {
  return args.map((a) => {
    if (typeof a === 'string') return a;
    if (a instanceof Error) return `${a.name}: ${a.message}\n${a.stack ?? ''}`;
    try { return JSON.stringify(a); } catch { return String(a); }
  }).join(' ');
}

let started = false;

/**
 * The Chicago wall clock as "HH:MM:SS", the only clock this app reasons in. Every
 * timestamp TVCM prints or stores is CT, so the log is comparable with the session
 * boundaries, the AMP statement and Jim's own screen without conversion.
 */
export function logStamp(now?: number): string {
  return new Date(now == null ? Date.now() : now).toLocaleTimeString('en-GB', {
    timeZone: 'America/Chicago', hour12: false,
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
}

/**
 * Mirror console.log/warn/error into the log file for the rest of the run, and stamp
 * every line on the way out. Safe to call twice; returns the path so startup can announce it.
 */
export function initLogger(): string {
  if (started) return logFilePath();
  started = true;
  for (const level of ['log', 'warn', 'error'] as const) {
    const original = console[level].bind(console);
    console[level] = (...args: unknown[]) => {
      // Stamped on the way out as well as into the file. TVCM-45 §4.4: the roll report
      // had to bound every log line by its run's file-creation time, because no line
      // said when it happened.
      original(`${logStamp()} CT`, ...args);
      logLine(level, formatArgs(args));
    };
  }
  logLine('log', `[logger] log file opened at ${logFilePath()}`);
  return logFilePath();
}
