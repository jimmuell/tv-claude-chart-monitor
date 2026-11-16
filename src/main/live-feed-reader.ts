import fs   from 'fs';
import path from 'path';
import { currentSessionDate } from './session-clock-bridge';
import { sharedModule } from './shared-require';
import { toImportedSession, toImportedTrade, toImportedFill, toBoundary } from './engine-shapes';
import type { LiveFeedState, LiveFeedGate, ImportedSession, ImportedTrade, ImportedFill,
              SessionBoundary, SessionDetail, SessionListItem } from '../shared/types';

// The pure half — broker gating, shape detection, conversion — lives in a shared
// CommonJS module so it can be unit-tested without Electron or a CDP connection.
const liveFeed = sharedModule('live-feed.js');

/** How often to read when nothing says otherwise. */
const DEFAULT_POLL_MS = 5_000;

export interface LiveFeedOptions {
  /** Evaluates a page expression over the existing CDP connection. */
  evalPage:        (expression: string) => Promise<unknown>;
  mode?:           'live' | 'paper';
  pollIntervalMs?: number;
  perContractSideFee?: () => number;
  now?:            () => number;
  /** Where this MODE's last reading is cached. Live and paper never share a file. */
  statePath?:      string | null;
  onChange?:       (state: LiveFeedState) => void;
  log?:            (line: string) => void;
}

/** An empty reading, used before the first poll and whenever the account gate closes. */
export function emptyLiveFeedState(mode: 'live' | 'paper'): LiveFeedState {
  return {
    mode, brokerId: null, account: null, available: false, state: 'disconnected',
    reason: null, switchHint: null, session: null, fallbackSession: null, currentSession: null,
    source: null,
    executionCount: 0, fillCount: 0, skippedCount: 0, openPositionCount: null,
    readAt: null, lastAttemptAt: null, errorCode: null, errorMessage: null, warn: false,
  };
}

/** Contracts actually held open, summed across symbols — not the number of symbol rows. */
function openQuantity(payload: any): number | null {
  const rows = Array.isArray(payload?.positions) ? payload.positions.filter(Boolean) : null;
  if (!rows) return null;
  return rows.reduce((n: number, p: any) => n + Math.abs(Number(p.qty) || 0), 0);
}

/**
 * Polls TradingView's own execution list over the existing CDP connection and keeps the
 * CURRENT session's numbers in memory.
 *
 * Three rules it will not bend:
 *
 *   1. The broker is checked in the SAME page expression as the read, so the account
 *      cannot change in the gap between a gate round trip and a data round trip.
 *   2. The moment the gate closes — replay, an account mismatch, an unknown broker — the
 *      held session is dropped immediately. A stale number from the wrong account is
 *      worse than no number, and this is what keeps paper and live from ever mixing.
 *   3. A payload that does not look like what TVCM-25 measured is refused with a code
 *      rather than converted hopefully. The AMP adapter is unproven; if it differs, Jim
 *      sees "can't read this TradingView version" and the CSV import carries the day.
 *
 * A transport failure is gentler: the last good reading is kept and goes stale normally,
 * so one dropped poll does not make the menu bar flicker between sources.
 */
export class LiveFeedReader {
  private evalPage: (expression: string) => Promise<unknown>;
  private mode:     'live' | 'paper';
  private pollMs:   number;
  private feeRate:  () => number;
  private now:      () => number;
  private statePath: string | null;
  private onChange?: (state: LiveFeedState) => void;
  private log:      (line: string) => void;

  private timer:   ReturnType<typeof setInterval> | null = null;
  private running  = false;
  private state:   LiveFeedState;
  /** Latched so a repeating fault logs once per episode rather than every 5 seconds. */
  private loggedCode: string | null = null;
  /** Everything the last good read produced, so the window can show trades and fills too. */
  private lastSessions:   ImportedSession[] = [];
  private lastTrades:     ImportedTrade[]   = [];
  private lastFills:      ImportedFill[]    = [];
  private lastBoundaries  = new Map<string, SessionBoundary>();

  constructor(opts: LiveFeedOptions) {
    this.evalPage  = opts.evalPage;
    this.mode      = opts.mode ?? 'live';
    this.pollMs    = opts.pollIntervalMs ?? DEFAULT_POLL_MS;
    this.feeRate   = opts.perContractSideFee ?? (() => 0.60);
    this.now       = opts.now ?? (() => Date.now());
    this.statePath = opts.statePath ?? null;
    this.onChange  = opts.onChange;
    this.log       = opts.log ?? ((l) => console.log(l));
    this.state     = emptyLiveFeedState(this.mode);
    this.restore();
  }

  /** Starts polling, after one immediate read so the panel is not blank on open. */
  start(): void {
    if (this.timer) return;
    void this.readOnce();
    this.timer = setInterval(() => { void this.readOnce(); }, this.pollMs);
  }

  /** Stops polling. Safe to call when already stopped. */
  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }

  /** The current reading. */
  getState(): LiveFeedState { return { ...this.state }; }

  /** Which account this reader is pointed at. */
  getMode(): 'live' | 'paper' { return this.mode; }

  /**
   * Switches account. Everything held is dropped first — a paper reading must never
   * survive into a live view, even for the one poll it would take to be replaced.
   */
  setMode(mode: 'live' | 'paper', statePath: string | null): void {
    if (mode === this.mode) return;
    this.mode      = mode;
    this.statePath = statePath;
    this.state     = emptyLiveFeedState(mode);
    this.clearHeld();
    this.loggedCode = null;
    this.restore();
    this.onChange?.(this.getState());
    void this.readOnce();
  }

  /** One read: gate, fetch, shape-check, price. Never overlaps itself. */
  async readOnce(): Promise<LiveFeedState> {
    if (this.running) return this.getState();
    this.running = true;
    const at = this.now();
    try {
      let raw: unknown;
      try {
        raw = await this.evalPage(liveFeed.liveFeedExpression());
      } catch (err) {
        return this.softFail(at, 'disconnected', 'TVCM-LF-NOT-CONNECTED', (err as Error).message);
      }

      let payload: any;
      try {
        payload = typeof raw === 'string' ? JSON.parse(raw) : raw;
      } catch (err) {
        return this.softFail(at, 'unreadable', 'TVCM-LF-READ-FAILED', `unparseable reply: ${(err as Error).message}`);
      }
      if (!payload || typeof payload !== 'object') {
        return this.softFail(at, 'unreadable', 'TVCM-LF-READ-FAILED', 'the page returned nothing');
      }
      if (payload.error) {
        return this.softFail(at, 'unreadable', String(payload.error), String(payload.message || 'TradingView could not be read'));
      }

      // --- the gate -------------------------------------------------------
      const gate = liveFeed.brokerAvailability(payload.brokerId, this.mode === 'paper');
      if (!gate.available) return this.gateClosed(at, payload, gate);

      // --- the shape, of whichever collection this broker actually uses ----
      // AMP keeps the current session in orders(); paper keeps it in allExecutions().
      // Checking the wrong one is how TVCM-28's blindness went unnoticed.
      const source = liveFeed.feedSourceFor(payload.brokerId);
      const shape = source === 'orders'
        ? liveFeed.detectOrderShape([...(payload.orders || []), ...(payload.ordersHistory || [])])
        : liveFeed.detectExecutionShape(payload.executions);
      if (!shape.ok) {
        const detail = [
          shape.notAnArray ? `the reply was not a list of ${source}` : null,
          shape.missing.length  ? `missing field(s): ${shape.missing.join(', ')}`  : null,
          shape.badTypes.length ? `wrong type(s): ${shape.badTypes.join(', ')}` : null,
        ].filter(Boolean).join('; ');
        return this.hardFail(at, payload, 'unreadable', 'TVCM-LF-SHAPE',
          `can't read this TradingView version — ${detail}`);
      }

      // --- price it -------------------------------------------------------
      const feed = liveFeed.analyseFeed(payload, {
        perContractSideFee: this.feeRate(),
        source: `live-feed:${this.mode}`,
      });
      const result = feed.result;
      const today = currentSessionDate(new Date(at));
      const match = (result.sessions || []).find((s: any) => s.sessionDate === today);

      this.lastSessions = (result.sessions || []).map(toImportedSession);
      this.lastTrades   = (result.trades  || []).map(toImportedTrade);
      this.lastFills    = (result.fills   || []).map(toImportedFill);
      this.lastBoundaries.clear();
      for (const sess of (result.sessions || [])) {
        const b = toBoundary(sess.tradeReconciliation);
        if (b) this.lastBoundaries.set(sess.sessionDate, b);
      }

      this.state = {
        mode: this.mode,
        brokerId: payload.brokerId ?? null,
        account:  payload.account ?? null,
        available: true,
        state: 'ok',
        reason: null,
        switchHint: null,
        source,
        session: match ? toImportedSession(match) : null,
        // The newest session that has fills, for the market-shut fallback. Never shown
        // while the market is open — that is the merge's call, not this one's.
        fallbackSession: this.lastSessions.length
          ? this.lastSessions.slice().sort((a, b) => (a.sessionDate < b.sessionDate ? 1 : -1))[0]
          : null,
        currentSession: today,
        executionCount: (feed.fills || []).length,
        fillCount: (result.fills || []).length,
        skippedCount: (result.skipped || []).length,
        openPositionCount: openQuantity(payload),
        readAt: at,
        lastAttemptAt: at,
        errorCode: null,
        errorMessage: null,
        warn: false,
      };
      if (this.loggedCode) { this.log(`[live-feed] recovered — reading ${this.mode} account ${payload.account ?? '?'} via ${source}()`); this.loggedCode = null; }
      if ((result.skipped || []).length > 0) {
        this.logOnce('TVCM-LF-SKIPPED', `[live-feed] TVCM-LF-SKIPPED: ${result.skipped.length} execution(s) could not be read — the current session is incomplete`);
      }
      this.persist();
      this.onChange?.(this.getState());
      return this.getState();
    } finally {
      this.running = false;
    }
  }

  /**
   * The gate said no. The held session goes immediately, because it may be the other
   * account's. Replay is recorded without a code — it is a normal state, not a fault.
   */
  private gateClosed(at: number, payload: any, gate: any): LiveFeedState {
    this.state = {
      ...emptyLiveFeedState(this.mode),
      brokerId: payload.brokerId ?? null,
      account:  payload.account ?? null,
      state:    gate.state as LiveFeedGate,
      reason:   gate.reason,
      switchHint: gate.switchHint,
      currentSession: currentSessionDate(new Date(at)),
      readAt: null,
      lastAttemptAt: at,
      errorCode: gate.errorCode,
      errorMessage: gate.errorCode ? gate.reason : null,
      warn: !!gate.warn,
    };
    this.clearHeld();
    if (gate.errorCode) this.logOnce(gate.errorCode, `[live-feed] ${gate.errorCode}: ${gate.reason}`);
    else this.logOnce('replay', `[live-feed] ${gate.reason}`);
    this.persist();
    this.onChange?.(this.getState());
    return this.getState();
  }

  /** A fault in the data itself: drop the held session, because it cannot be trusted. */
  private hardFail(at: number, payload: any, state: LiveFeedGate, code: string, message: string): LiveFeedState {
    this.state = {
      ...emptyLiveFeedState(this.mode),
      brokerId: payload?.brokerId ?? null,
      account:  payload?.account ?? null,
      state, reason: message, switchHint: null,
      currentSession: currentSessionDate(new Date(at)),
      lastAttemptAt: at, errorCode: code, errorMessage: message, warn: true,
    };
    this.clearHeld();
    this.logOnce(code, `[live-feed] ${code}: ${message}`);
    this.persist();
    this.onChange?.(this.getState());
    return this.getState();
  }

  /** A transport fault: keep the last good reading and let it go stale on its own. */
  private softFail(at: number, state: LiveFeedGate, code: string, message: string): LiveFeedState {
    this.state = { ...this.state, state, lastAttemptAt: at, errorCode: code, errorMessage: message, warn: false };
    this.logOnce(code, `[live-feed] ${code}: ${message}`);
    this.onChange?.(this.getState());
    return this.getState();
  }

  /** Forgets every held record. Called whenever the held session can no longer be trusted. */
  private clearHeld(): void {
    this.lastSessions = [];
    this.lastTrades   = [];
    this.lastFills    = [];
    this.lastBoundaries.clear();
  }

  /** Every session the feed can see, newest first — in paper mode this is the whole list. */
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

  /** True when the feed holds this session, so the caller knows who should answer. */
  hasSession(sessionDate: string): boolean {
    return this.lastSessions.some(s => s.sessionDate === sessionDate);
  }

  /** One session's headline, trades and raw fills, straight from the feed. */
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

  /** Logs a coded condition once per episode, so a 5-second poll cannot flood the log. */
  private logOnce(code: string, line: string): void {
    if (this.loggedCode === code) return;
    this.loggedCode = code;
    this.log(line);
  }

  /** Caches this mode's reading so a restart shows something before the first poll. */
  private persist(): void {
    if (!this.statePath) return;
    try {
      fs.mkdirSync(path.dirname(this.statePath), { recursive: true });
      fs.writeFileSync(this.statePath, JSON.stringify({ mode: this.mode, state: this.state }));
    } catch (err) {
      this.log(`[live-feed] TVCM-LF-CACHE-WRITE: could not cache the reading — ${(err as Error).message}`);
    }
  }

  /** Reloads this mode's cached reading; a cache written in the other mode is ignored. */
  private restore(): void {
    if (!this.statePath) return;
    try {
      const raw = JSON.parse(fs.readFileSync(this.statePath, 'utf8'));
      if (raw && raw.state && raw.mode === this.mode) {
        this.state = { ...emptyLiveFeedState(this.mode), ...raw.state, mode: this.mode };
      }
    } catch { /* no cache yet, or unreadable — start empty */ }
  }
}
