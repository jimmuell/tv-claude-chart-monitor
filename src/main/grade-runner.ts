/**
 * grade-runner.ts
 *
 * Walks ungraded recommendations and scores them against the bars that came
 * after each one. Runs on every bar close, and once at app start to catch up
 * on anything left hanging while the app was closed.
 *
 * The scoring rules live in src/shared/grader.js (pure, unit-tested). This file
 * only decides WHICH calls are safe to grade with the bars currently on screen.
 *
 * Three guards matter, because the chart in front of us may not be the chart the
 * call was made on:
 *   - symbol must match      (MES bars cannot grade an MNQ call)
 *   - timeframe must match   (5m bars cannot grade a 1m call)
 *   - replay_mode must match (replay bars are historical; grading a live call
 *                             against them, or vice versa, is meaningless)
 *
 * Coded errors: TVCM-GRADE-NO-BARS.
 */

import path from 'path';
import { app } from 'electron';
import type { RecommendationStore, RecommendationRow, RecOutcome } from './recommendation-store';

interface Bar { time: number; open: number; high: number; low: number; close: number }

interface GradeVerdict {
  outcome:        RecOutcome;
  barsToOutcome:  number | null;
  rGross:         number | null;
  rNet:           number | null;
}

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { gradeCall } = require(path.join(app.getAppPath(), 'src/shared/grader')) as {
  gradeCall(
    call: { direction: string | null; entry: number | null; stop: number | null; target: number | null },
    barsAfter: Bar[],
    opts?: Record<string, unknown>,
  ): GradeVerdict;
};

/** What peekBars() hands back: the chart's identity plus its recent bars. */
export type BarsProvider = () => Promise<{
  symbol: string; timeframe: string; replayMode: boolean; candles: Bar[];
} | null>;

export interface GradeRunSummary {
  considered: number;
  graded:     number;
  skipped:    number;
  byOutcome:  Record<string, number>;
}

export class GradeRunner {
  private store: RecommendationStore;
  private getBars: BarsProvider;
  private running = false;
  private noBarsLogged = false;

  constructor(store: RecommendationStore, getBars: BarsProvider) {
    this.store = store;
    this.getBars = getBars;
  }

  /**
   * Grade every ungraded call the current chart can legitimately settle.
   * Safe to call repeatedly: settled rows are never rewritten.
   */
  async run(): Promise<GradeRunSummary> {
    const summary: GradeRunSummary = { considered: 0, graded: 0, skipped: 0, byOutcome: {} };
    if (this.running) return summary;           // never overlap with itself
    this.running = true;
    try {
      const chart = await this.getBars();
      if (!chart) {
        // Chart unreadable — not a grading fault, so say it once and move on.
        if (!this.noBarsLogged) {
          console.error('[grade-runner] TVCM-GRADE-NO-BARS: no bars available, grading skipped this cycle');
          this.noBarsLogged = true;
        }
        return summary;
      }
      this.noBarsLogged = false;

      const replayFlag = chart.replayMode ? 1 : 0;
      const ungraded = this.store.getUngraded(500);
      summary.considered = ungraded.length;

      for (const row of ungraded) {
        if (!this.matchesChart(row, chart, replayFlag)) { summary.skipped++; continue; }

        const barsAfter = chart.candles.filter((b) => b.time > row.bar_time);
        if (barsAfter.length === 0) { summary.skipped++; continue; }

        const verdict = gradeCall(
          { direction: row.direction, entry: row.entry, stop: row.stop, target: row.target },
          barsAfter,
        );
        if (verdict.outcome === 'PENDING') { summary.skipped++; continue; }

        this.store.applyGrade(row.id, verdict);
        summary.graded++;
        summary.byOutcome[verdict.outcome] = (summary.byOutcome[verdict.outcome] ?? 0) + 1;
      }
      return summary;
    } finally {
      this.running = false;
    }
  }

  /**
   * One-shot re-grade after a scoring-rule change: drop the grades a rule change
   * could invalidate, score them again, and report which ones actually moved.
   * Normal grading stays idempotent; only this path deliberately re-opens a grade.
   */
  async regrade(): Promise<{ cleared: number; resettled: number; changed: Array<{ id: number; from: string; to: string }> }> {
    const before = this.store.clearGradesForRegrade();
    await this.run();
    const changed: Array<{ id: number; from: string; to: string }> = [];
    let resettled = 0;
    for (const row of before) {
      const now = this.store.outcomeOf(row.id);
      if (now !== null && now !== 'PENDING') resettled++;
      if (now !== row.outcome) changed.push({ id: row.id, from: row.outcome, to: now ?? 'PENDING' });
    }
    return { cleared: before.length, resettled, changed };
  }

  /** True when the on-screen chart is the same instrument, timeframe and mode as the call. */
  private matchesChart(
    row: RecommendationRow,
    chart: { symbol: string; timeframe: string },
    replayFlag: number,
  ): boolean {
    return row.symbol === chart.symbol
      && row.timeframe === chart.timeframe
      && row.replay_mode === replayFlag;
  }
}
