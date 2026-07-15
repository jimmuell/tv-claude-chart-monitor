import { readAccountData } from './pnl-reader';
import { calculateFees, getBreakevenPoints, dailyFixedFee, type FeeConfig } from './fee-calculator';
import type { PnlSnapshot, FeeBreakdown, TradeEntry } from '../shared/types';
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
  private lastSymbol         = 'CME_MINI:MES1!';
  private lastAccountType:   'amp_live' | 'paper' | null = null;

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
      // Do NOT reset lastSymbol/lastAccountType — carry forward for cross-midnight cleanup
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
        // Priority 3: openingFillDirection — inferred from oldest fill in DOM.
        const posFromPanel      = data.openPosition;
        let detectedDirection: 'long' | 'short' | null = posFromPanel?.direction ?? null;
        let directionSource: 'positions_panel' | 'order_history' | 'cached' | 'unknown' | null = null;
        if (detectedDirection !== null) {
          directionSource = 'positions_panel';
        } else if (data.buyFills !== data.sellFills) {
          detectedDirection = data.buyFills > data.sellFills ? 'long' : 'short';
          directionSource   = 'order_history';
        } else if (data.openingFillDirection !== null) {
          detectedDirection = data.openingFillDirection;
          directionSource   = 'order_history';
        }
        // Cache the most recent non-null direction for use when all signals go dark.
        if (detectedDirection !== null) {
          this.lastKnownDirection = detectedDirection;
        }

        // Update symbol and account type cache when available
        const currentSymbol = posFromPanel?.symbol ?? this.lastSymbol;
        if (posFromPanel?.symbol) this.lastSymbol = posFromPanel.symbol;
        if (data.accountType)    this.lastAccountType = data.accountType;

        // Whether the Positions tab badge shows ≥1 open position.
        // Always present in the DOM regardless of which tab is active —
        // unlike Ka-Table rows which lazy-render only for the active tab.
        // Used to suppress RESCUE when paper trading resets Realized PnL to 0
        // at position open (OTE is 0 at entry, so isFlat is spuriously true).
        const tabHasPosition = data.positionsTabCount !== null && data.positionsTabCount > 0;

        // Detect position close or missed complete trade.
        // "Flat" = unrealized is 0 OR null (OTE absent from DOM = null when no position).
        const grossChanged = prevGross !== null && gross !== prevGross;
        const isFlat = unrealized === 0 || unrealized === null;
        if (this.tradeStore && isFlat && grossChanged && !tabHasPosition) {
          const pnlGross  = gross - prevGross!;
          const exitFee   = getSettings().subtractCommissions ? cfg.perContractFee : 0;
          const acctType  = data.accountType ?? this.lastAccountType;
          const exitSymbol = this.lastSymbol;
          const exitPayload = {
            exit_at:   Date.now(),
            pnl_gross: pnlGross,
            pnl_net:   pnlGross - exitFee,
          };

          if (this.tradeStore.hasOpenTrade(exitSymbol, acctType)) {
            // Normal exit: an entry is already in the DB — close it.
            console.log(`[pnl-tracker] EXIT detected: pnlGross=${pnlGross} symbol=${exitSymbol} acctType=${acctType}`);
            this.tradeStore.recordExitForOpenTrade(exitPayload, exitSymbol, acctType);
          } else {
            // Rescue: trade opened and closed between polls.
            const rescueDir = detectedDirection ?? this.lastKnownDirection;
            if (rescueDir === null) {
              // All signals dark — never guess; flag for manual review.
              console.warn(`[pnl-tracker] RESCUE: direction unknown (all signals null) pnlGross=${pnlGross} buys=${data.buyFills} sells=${data.sellFills} — recording 'unknown', needs_review=1`);
              this.tradeStore.recordEntry({
                symbol:           exitSymbol,
                timeframe:        '1',
                direction:        'unknown',
                entry_price:      null,
                stop_price:       null,
                target_price:     null,
                trailing_stop:    false,
                rr_planned:       null,
                verdict:          'manual',
                headline:         'Auto-recovered — direction unknown (Balances tab was active)',
                objective:        null,
                steps_json:       null,
                structure:        null,
                rationale:        null,
                patterns_json:    null,
                confidence:       null,
                account_type:     acctType,
                direction_source: 'unknown',
                entry_source:     'rescued',
                needs_review:     true,
              });
            } else {
              const rescueSrc = detectedDirection ? directionSource! : 'cached';
              console.log(`[pnl-tracker] RESCUE: missed trade pnlGross=${pnlGross} dir=${rescueDir} src=${rescueSrc}`);
              this.tradeStore.recordEntry({
                symbol:           exitSymbol,
                timeframe:        '1',
                direction:        rescueDir,
                entry_price:      null,
                stop_price:       null,
                target_price:     null,
                trailing_stop:    false,
                rr_planned:       null,
                verdict:          'manual',
                headline:         'Auto-recovered — trade completed between polls',
                objective:        null,
                steps_json:       null,
                structure:        null,
                rationale:        null,
                patterns_json:    null,
                confidence:       null,
                account_type:     acctType,
                direction_source: rescueSrc,
                entry_source:     'rescued',
                needs_review:     false,
              });
            }
            this.tradeStore.recordExitForOpenTrade(exitPayload, exitSymbol, acctType);
          }
        } else if (isFlat && grossChanged && tabHasPosition) {
          console.log(`[pnl-tracker] gross changed (${prevGross}→${gross}) but Positions tab shows ${data.positionsTabCount} — paper P&L reset on open, skipping RESCUE`);
        }

        // Detect position opened.
        // OTE signals confirm a position exists; positionsTabCount as tie-breaker
        // when OTE is zero (paper trade at breakeven) and Ka-Table rows are lazy-unrendered.
        const hasNonZeroOte   = unrealized !== null && unrealized !== 0;
        const flatToNonFlat   = this.prevUnrealized === null && unrealized !== null && unrealized !== 0;
        const hasLivePosition = posFromPanel !== null || hasNonZeroOte || flatToNonFlat || tabHasPosition;

        // Effective direction: current signals OR last-known cache.
        const effectiveDirection = detectedDirection ?? this.lastKnownDirection;
        const effectiveDirSrc = (detectedDirection ? directionSource : 'cached') as TradeEntry['direction_source'];

        const acctType = data.accountType ?? this.lastAccountType;
        console.log(`[pnl-tracker] entry-check: posFromPanel=${JSON.stringify(posFromPanel)} hasNonZeroOte=${hasNonZeroOte} flatToNonFlat=${flatToNonFlat} tabCount=${data.positionsTabCount} hasLivePosition=${hasLivePosition} dir=${detectedDirection} effectiveDir=${effectiveDirection} buys=${data.buyFills} sells=${data.sellFills} hasOpenTrade=${this.tradeStore?.hasOpenTrade(currentSymbol, acctType)}`);
        if (this.tradeStore && hasLivePosition && effectiveDirection !== null && !this.tradeStore.hasOpenTrade(currentSymbol, acctType)) {
          const src = posFromPanel ? 'positions panel' : detectedDirection ? 'order history net' : 'cached direction';
          console.log(`[pnl-tracker] ENTRY detected — direction=${effectiveDirection} (${src}) entry=${posFromPanel?.entryPrice ?? null}`);
          this.tradeStore.recordEntry({
            symbol:           currentSymbol,
            timeframe:        '1',
            direction:        effectiveDirection,
            entry_price:      posFromPanel?.entryPrice ?? null,
            stop_price:       null,
            target_price:     null,
            trailing_stop:    false,
            rr_planned:       null,
            verdict:          'manual',
            headline:         'Manually placed trade',
            objective:        null,
            steps_json:       null,
            structure:        null,
            rationale:        null,
            patterns_json:    null,
            confidence:       null,
            account_type:     acctType,
            direction_source: effectiveDirSrc,
            entry_source:     'observed',
            needs_review:     false,
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
