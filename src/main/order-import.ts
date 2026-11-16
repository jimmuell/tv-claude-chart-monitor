import fs   from 'fs';
import os   from 'os';
import path from 'path';
import { currentSessionDate } from './session-clock-bridge';
import { sharedModule } from './shared-require';
import { toImportedSession, toImportedTrade, toImportedFill, toBoundary } from './engine-shapes';
import type { OrderImportState, ImportedSession, ImportedTrade, ImportedFill, SessionBoundary, SessionDetail, SessionListItem } from '../shared/types';

// The engine proved against AMP's statement in TVCM-13. It is a shared CommonJS
// module that tsc does not compile, so it is loaded at runtime.
const orderHistory = sharedModule('order-history.js');
const corrections = sharedModule('corrections.js');

/**
 * Only live AMP exports are imported. TradingView names the real one
 * `amp-order-history-<...>.csv`; a paper or Bar Replay export lands in the same folder
 * with a name that matched the old `*order-history*.csv` rule, so TVCM would import it
 * and show play money in the menu bar as real money (TVCM-23 §5).
 */
export const LIVE_EXPORT_NAME_PATTERN = /^amp-order-history-.*\.csv$/i;

/**
 * The wider family of order-history exports. Nothing here is ever imported unless it
 * also matches the live pattern — this exists only so a refused file can be named in
 * the log instead of being passed over in silence.
 */
export const ORDER_HISTORY_NAME_PATTERN = /order-history.*\.csv$/i;

const DEFAULT_POLL_MS = 5_000;

export interface OrderImportOptions {
  folder?:        string;
  pollIntervalMs?: number;
  /** Injected clock, so tests can place "now" in any session without waiting. */
  now?:           () => number;
  /** Where the last good result is cached between runs. */
  statePath?:     string;
  onChange?:      (state: OrderImportState) => void;
  /** Jim's recorded missing fills, so the export's totals include them too. */
  corrections?:   () => unknown[];
  /** Which mode's corrections apply. */
  mode?:          () => 'live' | 'paper';
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

/** True when a filename is a live AMP order-history export — the only kind imported. */
export function isLiveExportFileName(name: string): boolean {
  return LIVE_EXPORT_NAME_PATTERN.test(name);
}

/** True when a filename is an order-history export of any account, live or not. */
export function isOrderHistoryFileName(name: string): boolean {
  return ORDER_HISTORY_NAME_PATTERN.test(name);
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
  private corrections: () => unknown[];
  private mode:        () => 'live' | 'paper';
  private log:         (line: string) => void;

  private timer:       ReturnType<typeof setInterval> | null = null;
  /** What each candidate looked like on the previous scan, to detect "still being written". */
  private lastSeen     = new Map<string, FileSignature>();
  /** The signature actually imported, so an unchanged file is not re-parsed. */
  private importedSig: (FileSignature & { filePath: string }) | null = null;
  /** Paths already refused as non-live, so the refusal is logged once and not every poll. */
  private refused     = new Set<string>();
  private state:       OrderImportState;
  /** Everything the last successful parse produced, kept so the session can be re-resolved as time passes. */
  private lastSessions: ImportedSession[] = [];
  /** Every flat-to-flat trade in the file, for the window's Trades tab. */
  private lastTrades: ImportedTrade[] = [];
  /** Every fill in the file, for the window's Fills tab. */
  private lastFills: ImportedFill[] = [];
  /** The fills exactly as parsed from the export, so corrections can be re-applied
   *  without re-reading the file. */
  private lastRawFills: any[] = [];
  /** How each session's trade list relates to its statement total. */
  private lastBoundaries = new Map<string, SessionBoundary>();

  constructor(opts: OrderImportOptions = {}) {
    this.folder    = resolveWatchFolder(opts.folder);
    this.pollMs    = opts.pollIntervalMs ?? DEFAULT_POLL_MS;
    this.now       = opts.now ?? (() => Date.now());
    this.statePath = opts.statePath ?? null;
    this.onChange  = opts.onChange;
    this.corrections = opts.corrections ?? (() => []);
    this.mode        = opts.mode ?? (() => 'live');
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

  /** Every session in the file, newest first, for the past-days picker. */
  listSessions(): SessionListItem[] {
    return this.lastSessions
      .slice()
      .sort((a, b) => (a.sessionDate < b.sessionDate ? 1 : -1))
      .map(s => ({
        sessionDate:       s.sessionDate,
        netPnl:            s.netPnl,
        grossPnl:          s.grossPnl,
        fees:              s.fees,
        contractSides:     s.contractSides,
        tradeCount:        this.lastBoundaries.get(s.sessionDate)?.tradeCount ?? 0,
        openPositionAtEnd: s.openPositionAtEnd,
      }));
  }

  /** One session's headline, its trades and its raw fills; empty when nothing matches. */
  getSessionDetail(sessionDate: string): SessionDetail {
    return {
      sessionDate,
      session:  this.lastSessions.find(s => s.sessionDate === sessionDate) ?? null,
      trades:   this.lastTrades.filter(t =>
        (t.status === 'CLOSED' && t.sessionDate === sessionDate) ||
        (t.status === 'OPEN'   && t.openSessionDate === sessionDate)),
      fills:    this.lastFills.filter(f => f.sessionDate === sessionDate),
      boundary: this.lastBoundaries.get(sessionDate) ?? null,
    };
  }

  /** Points the watcher at a different folder, forgetting what it had seen in the old one. */
  setFolder(folder: string | undefined): void {
    const next = resolveWatchFolder(folder);
    if (next === this.folder) return;
    this.folder = next;
    this.lastSeen.clear();
    this.refused.clear();
    this.importedSig = null;
    this.state.watchFolder = next;
  }

  /**
   * Every LIVE export in the watch folder, newest modification first, plus a count of
   * the order-history files refused for not being live. A refused file is never a
   * candidate, so it cannot win on mtime however new it is.
   */
  private candidates(): { live: { filePath: string; sig: FileSignature }[]; refusedCount: number } {
    let names: string[];
    try {
      names = fs.readdirSync(this.folder);
    } catch {
      return { live: [], refusedCount: 0 };
    }
    const live: { filePath: string; sig: FileSignature }[] = [];
    let refusedCount = 0;
    for (const name of names) {
      if (!isOrderHistoryFileName(name)) continue;
      const filePath = path.join(this.folder, name);
      if (!isLiveExportFileName(name)) {
        refusedCount++;
        this.noteRefused(filePath);
        continue;
      }
      try {
        const st = fs.statSync(filePath);
        if (!st.isFile()) continue;
        live.push({ filePath, sig: { size: st.size, mtimeMs: st.mtimeMs } });
      } catch { /* vanished between readdir and stat — ignore */ }
    }
    return { live: live.sort((a, b) => b.sig.mtimeMs - a.sig.mtimeMs), refusedCount };
  }

  /** Logs a non-live export once, so a paper file in the folder is visible but not noisy. */
  private noteRefused(filePath: string): void {
    if (this.refused.has(filePath)) return;
    this.refused.add(filePath);
    this.log(`[order-import] TVCM-OI-NOT-LIVE: ignoring ${path.basename(filePath)} — ` +
             'only live AMP exports (amp-order-history-*.csv) are imported');
  }

  /** One pass: find the newest export, make sure it has stopped growing, then import it. */
  async scanOnce(): Promise<ScanOutcome> {
    const { live, refusedCount } = this.candidates();
    if (live.length === 0) {
      const refused = refusedCount > 0
        ? `; ${refusedCount} non-live order-history file(s) ignored`
        : '';
      return { action: 'none', reason: `no amp-order-history-*.csv in ${this.folder}${refused}` };
    }

    const { filePath, sig } = live[0];
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

    this.lastRawFills = result.fills || [];
    result = this.withCorrections(result);

    this.lastSessions = result.sessions.map(toImportedSession);
    this.lastTrades   = (result.trades || []).map(toImportedTrade);
    this.lastFills    = (result.fills  || []).map(toImportedFill);
    this.lastBoundaries.clear();
    for (const sess of result.sessions) {
      const b = toBoundary(sess.tradeReconciliation);
      if (b) this.lastBoundaries.set(sess.sessionDate, b);
    }
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

  /**
   * Folds Jim's recorded missing fills into an analysis. They belong in the export's
   * totals too, not only the live feed's — otherwise the same day reads differently
   * depending on which source showed it. A correction a real export row has overtaken is
   * dropped rather than doubled.
   */
  private withCorrections(result: any): any {
    const corrected = corrections.analyseWithCorrections(this.lastRawFills, this.corrections(), {
      mode: this.mode(), skipped: result.skipped,
    });
    // Always the analysed result, even with no corrections to apply: with none it is
    // simply the plain analysis of the same fills. Returning the caller's object instead
    // handed reapplyCorrections() a stub with no sessions and emptied the window.
    return { ...corrected.result, errors: result.errors, skipped: result.skipped };
  }

  /**
   * Re-prices the last import after Jim adds or removes a correction. The file has not
   * changed, so re-reading it would be a no-op — the held fills are re-analysed instead.
   */
  reapplyCorrections(): void {
    if (this.lastRawFills.length === 0) return;
    const result = this.withCorrections({ skipped: [], errors: [] });
    this.lastSessions = (result.sessions || []).map(toImportedSession);
    this.lastTrades   = (result.trades  || []).map(toImportedTrade);
    this.lastFills    = (result.fills   || []).map(toImportedFill);
    this.lastBoundaries.clear();
    for (const sess of (result.sessions || [])) {
      const b = toBoundary(sess.tradeReconciliation);
      if (b) this.lastBoundaries.set(sess.sessionDate, b);
    }
    this.state = { ...this.state, sessionCount: (result.sessions || []).length,
                   fillCount: (result.fills || []).length };
    this.resolveSession();
    this.persist();
    this.onChange?.(this.getState());
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
      fs.writeFileSync(this.statePath, JSON.stringify({
        state: this.state, sessions: this.lastSessions, trades: this.lastTrades,
        fills: this.lastFills, boundaries: Array.from(this.lastBoundaries),
      }));
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
        this.lastTrades   = Array.isArray(raw.trades)   ? raw.trades   : [];
        this.lastFills    = Array.isArray(raw.fills)    ? raw.fills    : [];
        this.lastBoundaries = new Map(Array.isArray(raw.boundaries) ? raw.boundaries : []);
        this.resolveSession();
      }
    } catch { /* no cache yet, or unreadable — start empty */ }
  }
}
