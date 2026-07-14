import { readAccountData } from './pnl-reader';
import { calculateFees, getBreakevenPoints, dailyFixedFee, type FeeConfig } from './fee-calculator';
import type { PnlSnapshot, FeeBreakdown } from '../shared/types';
import type { TradeStore } from './trade-store';
import { getSettings } from './settings';

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
    accountType:     null,
    message:         'Waiting for first poll…',
  };
}

export class PnlTracker {
  private timer:              ReturnType<typeof setInterval> | null = null;
  private current:            PnlSnapshot;
  private sessionDate:        string;
  private lastGrossPnl:       number | null = null;
  private tradeCount          = 0;
  private prevTradeCount      = 0;
  private prevUnrealized:     number | null = null;
  private lastKnownDirection: 'long' | 'short' | null = null;

  constructor(
    private readonly onUpdate:   (snap: PnlSnapshot) => void,
    private readonly getConfig:  () => FeeConfig,
    private readonly tradeStore?: TradeStore,
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
      this.sessionDate        = today;
      this.tradeCount         = 0;
      this.prevTradeCount     = 0;
      this.lastGrossPnl       = null;
      this.lastKnownDirection = null;
    }

    const cfg  = this.getConfig();
    let snap: PnlSnapshot;

    try {
      const data = await readAccountData();

      if (!data) {
        snap = {
          ...emptySnapshot(this.sessionDate, cfg),
          dataAvailable: false,
          accountType:   null,
          message: 'Open the AMP Live or Paper Trading account panel in TradingView',
        };
      } else {
        // Realized P&L: prefer Order History sum; fall back to 0 when no trades.
        const gross      = data.realizedPnl ?? 0;
        const unrealized = data.unrealizedPnl;  // keep null — isFlat and entry detection both handle it

        console.log(`[pnl-tracker] poll: gross=${gross} unrealized=${unrealized} openPosition=${JSON.stringify(data.openPosition)} prevUnrealized=${this.prevUnrealized}`);

        // Prefer round-trips counted directly from Order History (most accurate).
        // Fall back to tracking P/L changes between polls if Order History isn't visible.
        const prevGross = this.lastGrossPnl;

        if (data.roundTrips > 0) {
          this.tradeCount = data.roundTrips;
        } else if (this.lastGrossPnl !== null && gross !== this.lastGrossPnl) {
          this.tradeCount++;
        }
        this.lastGrossPnl = gross;

        // Compute direction early — needed by both rescue and entry paths.
        // Priority 1: Positions panel row (ground truth, gives direction + entry price).
        // Priority 2: Order history net fills (buyFills vs sellFills, unbalanced = open position).
        // Priority 3: openingFillDirection — inferred from the newest (closing) fill,
        //             useful when fills are balanced (round-trip complete, order history still visible).
        const posFromPanel      = data.openPosition;
        let detectedDirection: 'long' | 'short' | null = posFromPanel?.direction ?? null;
        if (detectedDirection === null && data.buyFills !== data.sellFills) {
          detectedDirection = data.buyFills > data.sellFills ? 'long' : 'short';
        }
        if (detectedDirection === null) {
          detectedDirection = data.openingFillDirection;
        }
        // Cache the most recent non-null direction for use when all signals go dark.
        if (detectedDirection !== null) {
          this.lastKnownDirection = detectedDirection;
        }

        // Detect position close or missed complete trade.
        // "Flat" = unrealized is 0 OR null (OTE absent from DOM = null when no position).
        const grossChanged = prevGross !== null && gross !== prevGross;
        const isFlat = unrealized === 0 || unrealized === null;
        if (this.tradeStore && isFlat && grossChanged) {
          const pnlGross = gross - prevGross!;
          const exitFee  = getSettings().subtractCommissions ? cfg.perContractFee : 0;
          if (this.tradeStore.hasOpenTrade()) {
            // Normal exit: an entry is already in the DB — close it.
            console.log(`[pnl-tracker] EXIT detected: pnlGross=${pnlGross} exitFee=${exitFee} accountType=${data.accountType}`);
            this.tradeStore.recordExitForOpenTrade({
              exit_at:    Date.now(),
              pnl_gross:  pnlGross,
              pnl_net:    pnlGross - exitFee,
              r_multiple: getSettings().autoTradeStopDollars > 0
                ? pnlGross / getSettings().autoTradeStopDollars
                : 0,
            });
          } else {
            // Rescue: no entry in DB — trade opened and closed between polls.
            const rescueDir = detectedDirection ?? this.lastKnownDirection ?? 'long';
            const rescueSrc = detectedDirection ? 'from signals' : this.lastKnownDirection ? 'from cache' : 'guessed long';
            console.log(`[pnl-tracker] RESCUE: missed trade pnlGross=${pnlGross} dir=${rescueDir} (${rescueSrc}) — signals: detected=${detectedDirection} lastKnown=${this.lastKnownDirection} openingFill=${data.openingFillDirection} buys=${data.buyFills} sells=${data.sellFills} tabCount=${data.positionsTabCount}`);
            this.tradeStore.recordEntry({
              symbol:        posFromPanel?.symbol ?? 'CME_MINI:MES1!',
              timeframe:     '1',
              direction:     rescueDir,
              entry_price:   null,
              stop_price:    null,
              target_price:  null,
              trailing_stop: false,
              rr_planned:    null,
              verdict:       'manual',
              headline:      'Auto-recovered — trade completed between polls',
              objective:     null,
              steps_json:    null,
              structure:     null,
              rationale:     null,
              patterns_json: null,
              confidence:    null,
            });
            this.tradeStore.recordExitForOpenTrade({
              exit_at:    Date.now(),
              pnl_gross:  pnlGross,
              pnl_net:    pnlGross - exitFee,
              r_multiple: getSettings().autoTradeStopDollars > 0
                ? pnlGross / getSettings().autoTradeStopDollars
                : 0,
            });
          }
        }

        // Detect position opened.
        // OTE signals confirm a position exists; both position panel and OTE required together.
        // positionsTabCount is always visible regardless of active tab — use it as tie-breaker
        // when OTE is zero (paper trade at breakeven) and Ka-Table rows are lazy-unrendered.
        const hasNonZeroOte   = unrealized !== null && unrealized !== 0;
        const flatToNonFlat   = this.prevUnrealized === null && unrealized !== null && unrealized !== 0;
        const tabHasPosition  = data.positionsTabCount !== null && data.positionsTabCount > 0;
        const hasLivePosition = posFromPanel !== null || hasNonZeroOte || flatToNonFlat || tabHasPosition;

        // Effective direction: current signals OR last-known cache.
        // This lets entry fire when Ka-Table data is absent (Balances tab active),
        // as long as we've seen the direction at least once since the position opened.
        const effectiveDirection = detectedDirection ?? this.lastKnownDirection;

        console.log(`[pnl-tracker] entry-check: posFromPanel=${JSON.stringify(posFromPanel)} hasNonZeroOte=${hasNonZeroOte} flatToNonFlat=${flatToNonFlat} tabCount=${data.positionsTabCount} hasLivePosition=${hasLivePosition} dir=${detectedDirection} effectiveDir=${effectiveDirection} buys=${data.buyFills} sells=${data.sellFills} hasOpenTrade=${this.tradeStore?.hasOpenTrade()}`);
        if (this.tradeStore && hasLivePosition && effectiveDirection !== null && !this.tradeStore.hasOpenTrade()) {
          const src = posFromPanel ? 'positions panel' : detectedDirection ? 'order history net' : 'cached direction';
          console.log(`[pnl-tracker] ENTRY detected — direction=${effectiveDirection} (${src}) entry=${posFromPanel?.entryPrice ?? null}`);
          this.tradeStore.recordEntry({
            symbol:        posFromPanel?.symbol ?? 'CME_MINI:MES1!',
            timeframe:     '1',
            direction:     effectiveDirection,
            entry_price:   posFromPanel?.entryPrice ?? null,
            stop_price:    null,
            target_price:  null,
            trailing_stop: false,
            rr_planned:    null,
            verdict:       'manual',
            headline:      'Manually placed trade',
            objective:     null,
            steps_json:    null,
            structure:     null,
            rationale:     null,
            patterns_json: null,
            confidence:    null,
          });
        }
        this.prevUnrealized = unrealized;
        this.prevTradeCount = this.tradeCount;

        const fees: FeeBreakdown = getSettings().subtractCommissions
          ? calculateFees(this.tradeCount, cfg)
          : { perContractRate: 0, contractCount: this.tradeCount, variableFees: 0, dailyFixed: 0, totalFees: 0 };
        const netPnl = gross - fees.totalFees;

        snap = {
          sessionDate:     this.sessionDate,
          tradeCount:      this.tradeCount,
          grossPnl:        gross,
          unrealizedPnl:   unrealized ?? 0,
          fees,
          netPnl,
          breakevenPoints: getBreakevenPoints(netPnl),
          dataAvailable:   true,
          accountType:     data.accountType,
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
