import { readAccountData } from './pnl-reader';
import { calculateFees, getBreakevenPoints, dailyFixedFee, type FeeConfig } from './fee-calculator';
import type { PnlSnapshot, FeeBreakdown } from '../shared/types';

const POLL_INTERVAL_MS = 10_000;

function todayCST(): string {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });
}

function emptySnapshot(date: string, cfg: FeeConfig): PnlSnapshot {
  const fees = calculateFees(0, cfg);
  return {
    sessionDate:     date,
    tradeCount:      0,
    grossPnl:        0,
    unrealizedPnl:   0,
    fees,
    netPnl:          -fees.totalFees,
    breakevenPoints: getBreakevenPoints(-fees.totalFees),
    dataAvailable:   false,
    message:         'Waiting for first poll…',
  };
}

export class PnlTracker {
  private timer:         ReturnType<typeof setInterval> | null = null;
  private current:       PnlSnapshot;
  private sessionDate:   string;
  private lastGrossPnl:  number | null = null;
  private tradeCount     = 0;

  constructor(
    private readonly onUpdate:  (snap: PnlSnapshot) => void,
    private readonly getConfig: () => FeeConfig,
  ) {
    this.sessionDate = todayCST();
    this.current     = emptySnapshot(this.sessionDate, this.getConfig());
  }

  start(): void {
    if (this.timer) return;
    void this.poll(); // immediate first poll
    this.timer = setInterval(() => { void this.poll(); }, POLL_INTERVAL_MS);
  }

  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }

  getSnapshot(): PnlSnapshot {
    return this.current;
  }

  private async poll(): Promise<void> {
    // Session date rollover check
    const today = todayCST();
    if (today !== this.sessionDate) {
      this.sessionDate  = today;
      this.tradeCount   = 0;
      this.lastGrossPnl = null;
    }

    const cfg  = this.getConfig();
    let snap: PnlSnapshot;

    try {
      const data = await readAccountData();

      if (!data) {
        snap = {
          ...emptySnapshot(this.sessionDate, cfg),
          dataAvailable: false,
          message: 'Account Summary panel not open or no data visible',
        };
      } else {
        // Realized P&L: prefer Order History sum; fall back to 0 when no trades.
        const gross      = data.realizedPnl ?? 0;
        const unrealized = data.unrealizedPnl ?? 0;  // OTE

        // Prefer round-trips counted directly from Order History (most accurate).
        // Fall back to tracking P/L changes between polls if Order History isn't visible.
        if (data.roundTrips > 0) {
          this.tradeCount = data.roundTrips;
        } else if (this.lastGrossPnl !== null && gross !== this.lastGrossPnl) {
          this.tradeCount++;
        }
        this.lastGrossPnl = gross;

        const fees: FeeBreakdown = calculateFees(this.tradeCount, cfg);
        const netPnl = gross - fees.totalFees;

        snap = {
          sessionDate:     this.sessionDate,
          tradeCount:      this.tradeCount,
          grossPnl:        gross,
          unrealizedPnl:   unrealized,
          fees,
          netPnl,
          breakevenPoints: getBreakevenPoints(netPnl),
          dataAvailable:   true,
          message:         data.realizedPnl == null
            ? 'Realized P&L not yet available (no completed trades in Order History)'
            : undefined,
        };
      }
    } catch (err) {
      const cfg2 = this.getConfig();
      snap = {
        ...emptySnapshot(this.sessionDate, cfg2),
        dataAvailable: false,
        message: (err as Error).message,
      };
    }

    this.current = snap;
    this.onUpdate(snap);
  }
}
