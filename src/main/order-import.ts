import fs   from 'fs';
import os   from 'os';
import path from 'path';
import { currentSessionDate } from './session-clock-bridge';
import { sharedModule } from './shared-require';
import type { ImportedSession, OrderImportState } from '../shared/types';

// The engine proved against AMP's statement in TVCM-13. It is a shared CommonJS
// module that tsc does not compile, so it is loaded at runtime.
const orderHistory = sharedModule('order-history.js');

/** Exports are matched on name, case-insensitively, so paper and live files both land. */
export const EXPORT_NAME_PATTERN = /order-history.*\.csv$/i;

const DEFAULT_POLL_MS = 5_000;

export interface OrderImportOptions {
  folder?:        string;
  pollIntervalMs?: number;
  /** Injected clock, so tests can place "now" in any session without waiting. */
  now?:           () => number;
  /** Where the last good result is cached between runs. */
  statePath?:     string;
  onChange?:      (state: OrderImportState) => void;
  log?:           (line: string) => void;
}

/** What one scan decided to do, so callers and tests can assert on it. */
export type ScanOutcome =
  | { action: 'imported';  filePath: string }
  | { action: 'unchanged'; filePath: string }
  | { action: 'deferred';  filePath: string; reason: string }
  | { action: 'failed';    filePath: string; code: string; message: string }
  | { action: 'none';      reason: string };

interface FileSignature { size: number; mtimeMs: number }

/** The folder exports land in: the configured one, or ~/Downloads when unset. */
export function resolveWatchFolder(configured?: string): string {
  const trimmed = (configured ?? '').trim();
  if (trimmed) return trimmed.startsWith('~') ? path.join(os.homedir(), trimmed.slice(1)) : trimmed;
  return path.join(os.homedir(), 'Downloads');
}

/** True when a filename looks like a TradingView order-history export. */
export function isExportFileName(name: string): boolean {
  return EXPORT_NAME_PATTERN.test(name);
}

/** Converts the engine's session object into the shape the UI consumes. */
function toImportedSession(s: any): ImportedSession {
  return {
    sessionDate:         s.sessionDate,
    fillCount:           s.fillCount,
    buys:                s.buys,
    sells:               s.sells,
    avgBuy:              s.avgBuy,
    avgSell:             s.avgSell,
    grossPnl:            s.grossPnl,
    contractSides:       s.contractSides,
    roundTrips:          s.contractSides / 2,
    fees:                s.fees,
    netPnl:              s.netPnl,
    openPositionAtStart: s.openPositionAtStart,
    openPositionAtEnd:   s.openPositionAtEnd,
  };
}

/** An empty state, used before the first import and when the cache cannot be read. */
export function emptyState(watchFolder: string | null): OrderImportState {
  return {
    session: null, isFallback: false, currentSession: null,
    importedAt: null, fileName: null, filePath: null,
    fillCount: 0, skippedRows: 0, sessionCount: 0,
    errorCode: null, errorMessage: null, lastAttemptAt: null, watchFolder,
  };
}

/**
 * Watches a folder for TradingView order-history exports and keeps the current
 * session's numbers in memory. Polls on mtime rather than using fs.watch, which is
 * unreliable for this on macOS, and only reads a file once its size and mtime have
 * stopped moving — a half-written CSV must never be parsed as a short day.
 */
export class OrderImportWatcher {
  private folder:      string;
  private pollMs:      number;
  private now:         () => number;
  private statePath:   string | null;
  private onChange?:   (state: OrderImportState) => void;
  private log:         (line: string) => void;

  private timer:       ReturnType<typeof setInterval> | null = null;
  /** What each candidate looked like on the previous scan, to detect "still being written". */
  private lastSeen     = new Map<string, FileSignature>();
  /** The signature actually imported, so an unchanged file is not re-parsed. */
  private importedSig: (FileSignature & { filePath: string }) | null = null;
  private state:       OrderImportState;
  /** Everything the last successful parse produced, kept so the session can be re-resolved as time passes. */
  private lastSessions: ImportedSession[] = [];

  constructor(opts: OrderImportOptions = {}) {
    this.folder    = resolveWatchFolder(opts.folder);
    this.pollMs    = opts.pollIntervalMs ?? DEFAULT_POLL_MS;
    this.now       = opts.now ?? (() => Date.now());
    this.statePath = opts.statePath ?? null;
    this.onChange  = opts.onChange;
    this.log       = opts.log ?? ((l) => console.log(l));
    this.state     = emptyState(this.folder);
    this.restore();
  }

  /** Starts polling, after one immediate scan so a restart shows numbers right away. */
  start(): void {
    if (this.timer) return;
    void this.scanOnce();
    this.timer = setInterval(() => { void this.scanOnce(); }, this.pollMs);
  }

  /** Stops polling. Safe to call when already stopped. */
  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }

  /** The current state, with the displayed session re-resolved against the clock. */
  getState(): OrderImportState {
    this.resolveSession();
    return { ...this.state };
  }

  /** Points the watcher at a different folder, forgetting what it had seen in the old one. */
  setFolder(folder: string | undefined): void {
    const next = resolveWatchFolder(folder);
    if (next === this.folder) return;
    this.folder = next;
    this.lastSeen.clear();
    this.importedSig = null;
    this.state.watchFolder = next;
  }

  /** Every export in the watch folder, newest modification first. */
  private candidates(): { filePath: string; sig: FileSignature }[] {
    let names: string[];
    try {
      names = fs.readdirSync(this.folder);
    } catch {
      return [];
    }
    const out: { filePath: string; sig: FileSignature }[] = [];
    for (const name of names) {
      if (!isExportFileName(name)) continue;
      const filePath = path.join(this.folder, name);
      try {
        const st = fs.statSync(filePath);
        if (!st.isFile()) continue;
        out.push({ filePath, sig: { size: st.size, mtimeMs: st.mtimeMs } });
      } catch { /* vanished between readdir and stat — ignore */ }
    }
    return out.sort((a, b) => b.sig.mtimeMs - a.sig.mtimeMs);
  }

  /** One pass: find the newest export, make sure it has stopped growing, then import it. */
  async scanOnce(): Promise<ScanOutcome> {
    const found = this.candidates();
    if (found.length === 0) {
      return { action: 'none', reason: `no *order-history*.csv in ${this.folder}` };
    }

    const { filePath, sig } = found[0];
    const previous = this.lastSeen.get(filePath);
    this.lastSeen.set(filePath, sig);

    // Still moving, or seen for the first time: wait for the next scan to confirm it settled.
    if (!previous || previous.size !== sig.size || previous.mtimeMs !== sig.mtimeMs) {
      const reason = previous ? 'size or mtime changed since the last scan' : 'first sighting, waiting for it to settle';
      return { action: 'deferred', filePath, reason };
    }

    // Already imported this exact file, untouched since.
    if (this.importedSig && this.importedSig.filePath === filePath
        && this.importedSig.size === sig.size && this.importedSig.mtimeMs === sig.mtimeMs) {
      return { action: 'unchanged', filePath };
    }

    return this.importFile(filePath, sig);
  }

  /** Parses one export and replaces the held result, or keeps the old one if it cannot be read. */
  private importFile(filePath: string, sig: FileSignature): ScanOutcome {
    const at = this.now();
    let text: string;
    try {
      text = fs.readFileSync(filePath, 'utf8');
    } catch (err) {
      return this.fail(filePath, at, 'TVCM-OI-UNREADABLE', (err as Error).message);
    }

    let result: any;
    try {
      result = orderHistory.analyseOrderHistory(text, { sourceNames: [path.basename(filePath)] });
    } catch (err) {
      return this.fail(filePath, at, 'TVCM-OI-PARSE-FAILED', (err as Error).message);
    }

    if (result.errors && result.errors.length > 0) {
      const first = String(result.errors[0]);
      return this.fail(filePath, at, first.split(':')[0], first);
    }
    if (!result.sessions || result.sessions.length === 0) {
      return this.fail(filePath, at, 'TVCM-OH-NO-ROWS', 'the export parsed but contains no fills');
    }

    this.lastSessions = result.sessions.map(toImportedSession);
    this.importedSig  = { ...sig, filePath };
    this.state = {
      ...this.state,
      importedAt:    at,
      lastAttemptAt: at,
      filePath,
      fileName:      path.basename(filePath),
      fillCount:     result.fills.length,
      skippedRows:   result.skipped.length,
      sessionCount:  result.sessions.length,
      errorCode:     null,
      errorMessage:  null,
      watchFolder:   this.folder,
    };
    this.resolveSession();

    if (result.skipped.length > 0) {
      this.log(`[order-import] TVCM-OI-SKIPPED-ROWS: ${result.skipped.length} row(s) reported a fill but could not be read in ${path.basename(filePath)} — totals are incomplete`);
    }
    this.log(`[order-import] imported ${path.basename(filePath)}: ${result.fills.length} fills, ${result.sessions.length} sessions, showing ${this.state.session?.sessionDate ?? 'none'}`);
    this.persist();
    this.onChange?.(this.getState());
    return { action: 'imported', filePath };
  }

  /** Records a failed attempt without discarding the last good numbers. */
  private fail(filePath: string, at: number, code: string, message: string): ScanOutcome {
    this.state = { ...this.state, lastAttemptAt: at, errorCode: code, errorMessage: message };
    this.log(`[order-import] ${code}: ${path.basename(filePath)} — ${message}`);
    this.persist();
    this.onChange?.(this.getState());
    return { action: 'failed', filePath, code, message };
  }

  /**
   * Chooses which session to show. The current one when it has fills; otherwise, with
   * the market shut, the newest session in the file — on a Saturday a trader wants
   * Friday's result, not a dash. While the market is open an empty current session
   * stays empty, because showing yesterday's number mid-session would be read as today's.
   */
  private resolveSession(): void {
    const sessions = this.lastSessions;
    if (sessions.length === 0) { this.state.session = null; this.state.isFallback = false; return; }

    const today = currentSessionDate(new Date(this.now()));
    this.state.currentSession = today;

    const exact = sessions.find(s => s.sessionDate === today);
    if (exact) { this.state.session = exact; this.state.isFallback = false; return; }

    const newest = sessions[sessions.length - 1];
    this.state.session    = newest;
    this.state.isFallback = true;
  }

  /** Writes the last good result so a restart can show it before the first scan finishes. */
  private persist(): void {
    if (!this.statePath) return;
    try {
      fs.mkdirSync(path.dirname(this.statePath), { recursive: true });
      fs.writeFileSync(this.statePath, JSON.stringify({ state: this.state, sessions: this.lastSessions }, null, 2));
    } catch (err) {
      this.log(`[order-import] TVCM-OI-CACHE-WRITE: could not cache the import — ${(err as Error).message}`);
    }
  }

  /** Reloads the cached result from the last run; a missing or broken cache is not an error. */
  private restore(): void {
    if (!this.statePath) return;
    try {
      const raw = JSON.parse(fs.readFileSync(this.statePath, 'utf8'));
      if (raw && raw.state) {
        this.state        = { ...emptyState(this.folder), ...raw.state, watchFolder: this.folder };
        this.lastSessions = Array.isArray(raw.sessions) ? raw.sessions : [];
        this.resolveSession();
      }
    } catch { /* no cache yet, or unreadable — start empty */ }
  }
}
