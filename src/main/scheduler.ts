import { AnalysisResult } from '../shared/types';
import { runAnalysis, setStatusCallback, peekBarState } from './bridge';

// ---------------------------------------------------------------------------
// Timeframe → polling interval (milliseconds)
// null means no auto-refresh (e.g. daily charts fire once only)
// ---------------------------------------------------------------------------
const TIMEFRAME_INTERVALS: Record<string, number | null> = {
  '1':   60_000,
  '2':   120_000,
  '3':   180_000,
  '5':   300_000,
  '15':  900_000,
  '30':  1_800_000,
  '60':  3_600_000,
  '1D':  null,
  'D':   null,
};

const DEFAULT_INTERVAL_MS = 300_000; // 5 minutes

/**
 * Replay mode: how often to cheaply check whether the replay cursor advanced.
 * This is only a CDP read of the last two bar timestamps — no Claude call — so
 * it can be frequent enough to feel responsive when stepping bar by bar.
 */
const REPLAY_POLL_MS = 3_000;

function intervalForTimeframe(timeframe: string): number | null {
  if (Object.prototype.hasOwnProperty.call(TIMEFRAME_INTERVALS, timeframe)) {
    return TIMEFRAME_INTERVALS[timeframe] ?? null;
  }
  return DEFAULT_INTERVAL_MS;
}

// ---------------------------------------------------------------------------
// Scheduler
// ---------------------------------------------------------------------------

export class Scheduler {
  private readonly onAnalysis: (result: AnalysisResult) => void;
  private readonly onError: (err: Error) => void;
  private readonly onStatus: (status: string) => void;
  private readonly onNextTick?: (nextMs: number) => void;

  private _running = false;
  private _timer: ReturnType<typeof setTimeout> | null = null;
  /** Interval used for the last successful reschedule; kept so transient
   *  errors can re-use it without a result to read the timeframe from. */
  private _lastIntervalMs: number = DEFAULT_INTERVAL_MS;

  /** Open time (epoch secs) of the bar the last replay analysis described.
   *  Null when not currently driving off replay bars. */
  private _replayBarTime: number | null = null;

  constructor(
    onAnalysis: (result: AnalysisResult) => void,
    onError: (err: Error) => void,
    onStatus: (status: string) => void,
    onNextTick?: (nextMs: number) => void,
  ) {
    this.onAnalysis = onAnalysis;
    this.onError = onError;
    this.onStatus = onStatus;
    this.onNextTick = onNextTick;

    // Wire the bridge status callback once at construction time.
    setStatusCallback(onStatus);
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  start(): void {
    if (this._running) return;
    this._running = true;
    this.triggerNow();
  }

  /** Re-enable auto-scheduling without an immediate trigger. */
  resume(): void {
    if (this._running) return;
    this._running = true;
    // Resume on whichever cadence was active when we were paused.
    if (this._replayBarTime !== null) this._scheduleReplayPoll();
    else this._scheduleNext(this._lastIntervalMs);
  }

  stop(): void {
    this._running = false;
    this._clearTimer();
  }

  isRunning(): boolean {
    return this._running;
  }

  triggerNow(): void {
    // Cancel any pending timer so we don't fire twice.
    this._clearTimer();
    this._execute();
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  private _clearTimer(): void {
    if (this._timer !== null) {
      clearTimeout(this._timer);
      this._timer = null;
    }
  }

  private _scheduleNext(intervalMs: number): void {
    if (!this._running) return;
    this._lastIntervalMs = intervalMs;
    this._scheduleAt(Date.now() + intervalMs);
  }

  private _scheduleAt(targetMs: number): void {
    if (!this._running) return;
    const delayMs = Math.max(targetMs - Date.now(), 1_000);
    this.onNextTick?.(targetMs);
    this._timer = setTimeout(() => {
      this._timer = null;
      this._execute();
    }, delayMs);
  }

  /**
   * Replay mode: poll cheaply for the replay cursor advancing, then run a full
   * analysis on the new bar.
   *
   * Wall-clock scheduling is meaningless in replay — bar timestamps are
   * historical, so barCloseMs alignment never applies and the old code fell
   * back to the timeframe interval. That left the chart annotations frozen on
   * whichever bar the last real-time-triggered analysis happened to hit, while
   * the replay ran on without them.
   */
  private _scheduleReplayPoll(): void {
    if (!this._running) return;
    this._timer = setTimeout(() => {
      this._timer = null;
      void this._replayTick();
    }, REPLAY_POLL_MS);
  }

  private async _replayTick(): Promise<void> {
    if (!this._running) return;

    // Never tears down the connection and never throws — a failed read just
    // means "no change", and we poll again.
    const state = await peekBarState();

    if (!this._running) return;

    if (state && !state.replayMode) {
      // Replay was exited — hand control back to wall-clock scheduling.
      this._replayBarTime = null;
      this.onStatus('Replay ended — resuming live schedule');
      this._scheduleNext(this._lastIntervalMs);
      return;
    }

    if (state && state.closedBarTime !== this._replayBarTime) {
      // Cursor advanced (or rewound — either way this is a different bar).
      this._execute();
      return;
    }

    this._scheduleReplayPoll();
  }

  private _execute(): void {
    runAnalysis()
      .then((result: AnalysisResult) => {
        this.onAnalysis(result);

        if (!this._running) return;

        // ── Replay: drive off bar advance, not the clock ─────────────────────
        if (result.replayMode) {
          this._replayBarTime = result.closedBarTime;
          // Blank the renderer countdown: there is no meaningful "next run at
          // T" in replay, we run when the user steps or autoplay advances.
          this.onNextTick?.(0);
          this._scheduleReplayPoll();
          return;
        }

        this._replayBarTime = null;

        const interval = intervalForTimeframe(result.timeframe);
        if (interval === null) return; // daily chart — fire once only

        // Align next run to the actual bar close time (+2s buffer so the bar
        // is fully settled before we read it). Fall back to interval-based
        // scheduling if barCloseMs is stale or unavailable.
        const alignedTarget = result.barCloseMs > Date.now() + 5_000
          ? result.barCloseMs + 2_000
          : Date.now() + interval;

        this._lastIntervalMs = interval;
        this._scheduleAt(alignedTarget);
      })
      .catch((err: unknown) => {
        const error = err instanceof Error ? err : new Error(String(err));
        this.onError(error);

        if (!this._running) return;

        // On error, reschedule so a transient CDP or network hiccup doesn't
        // stop monitoring — staying on whichever cadence we were using.
        if (this._replayBarTime !== null) this._scheduleReplayPoll();
        else this._scheduleNext(this._lastIntervalMs);
      });
  }
}
