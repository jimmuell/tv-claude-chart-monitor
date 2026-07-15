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

  // True once we've observed at least one live position this session.
  // RESCUE is suppressed until this is set, preventing spurious rescues from
  // startup-residual P&L (paper trading carries over yesterday's gross on connect).
  private hasObservedLivePosition = false;

  // Gross change that may be a real missed trade — confirmed on the next poll.
  // If a position appears on the next poll, this was a paper-trading P&L reset on
  // position open (not a trade); otherwise we fire the rescue.
  private pendingRescue: {
    exitAt:     number;
    pnlGross:   number;
    pnlNet:     number;
    exitSymbol: string;
    acctType:   'amp_live' | 'paper' | null;
  } | null = null;

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
      this.sessionDate             = today;
      this.tradeCount              = 0;
      this.prevTradeCount          = 0;
      this.lastGrossPnl            = null;
      this.lastKnownDirection      = null;
      this.hasObservedLivePosition = false;
      this.pendingRescue           = null;
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
        // AMP Live shows a numeric badge; paper trading does not — tabHasPosition is always
        // false for paper trading, so it cannot be relied on alone.
        const tabHasPosition = data.positionsTabCount !== null && data.positionsTabCount > 0;

        // Detect position state — computed here so EXIT/RESCUE and ENTRY share one value.
        // OTE signals confirm a position exists; positionsTabCount as tie-breaker for AMP Live
        // when OTE is zero (paper trade at breakeven) and Ka-Table rows are lazy-unrendered.
        const hasNonZeroOte   = unrealized !== null && unrealized !== 0;
        const flatToNonFlat   = this.prevUnrealized === null && unrealized !== null && unrealized !== 0;
        const hasLivePosition = posFromPanel !== null || hasNonZeroOte || flatToNonFlat || tabHasPosition;

        // Track whether we have ever seen a live position this session.
        // Prevents RESCUE from firing on startup-residual gross changes (paper trading carries
        // over the previous session's Realized PnL until the account resets on first connect).
        if (hasLivePosition) this.hasObservedLivePosition = true;

        // "Flat" = no open position OTE (0 or absent from DOM).
        const grossChanged = prevGross !== null && gross !== prevGross;
        const isFlat       = unrealized === 0 || unrealized === null;

        // ── Step 1: Resolve any pending rescue from the previous poll ─────────────────────
        // A rescue is pended (not fired immediately) so we can confirm on the next poll
        // that no position appeared, which would indicate a paper-trading P&L reset on open
        // rather than a real completed trade.
        if (this.pendingRescue && this.tradeStore) {
          if (hasLivePosition) {
            // Position appeared: the gross change was a display reset, not a completed trade.
            console.log(`[pnl-tracker] pending rescue cancelled — position appeared (paper P&L reset on open)`);
            this.pendingRescue = null;
          } else {
            // Still flat with no position: confirmed real missed trade — fire rescue.
            const pr = this.pendingRescue;
            this.pendingRescue = null;
            const rescueDir = detectedDirection ?? this.lastKnownDirection;
            if (rescueDir === null) {
              console.warn(`[pnl-tracker] RESCUE: direction unknown pnlGross=${pr.pnlGross} buys=${data.buyFills} sells=${data.sellFills} — recording 'unknown', needs_review=1`);
              this.tradeStore.recordEntry({
                symbol: pr.exitSymbol, timeframe: '1', direction: 'unknown',
                entry_price: null, stop_price: null, target_price: null,
                trailing_stop: false, rr_planned: null, verdict: 'manual',
                headline: 'Auto-recovered — direction unknown (Balances tab was active)',
                objective: null, steps_json: null, structure: null, rationale: null,
                patterns_json: null, confidence: null,
                account_type: pr.acctType, direction_source: 'unknown',
                entry_source: 'rescued', needs_review: true,
              });
            } else {
              const rescueSrc = (detectedDirection ? directionSource : 'cached') as TradeEntry['direction_source'];
              console.log(`[pnl-tracker] RESCUE: missed trade pnlGross=${pr.pnlGross} dir=${rescueDir} src=${rescueSrc}`);
              this.tradeStore.recordEntry({
                symbol: pr.exitSymbol, timeframe: '1', direction: rescueDir,
                entry_price: null, stop_price: null, target_price: null,
                trailing_stop: false, rr_planned: null, verdict: 'manual',
                headline: 'Auto-recovered — trade completed between polls',
                objective: null, steps_json: null, structure: null, rationale: null,
                patterns_json: null, confidence: null,
                account_type: pr.acctType, direction_source: rescueSrc,
                entry_source: 'rescued', needs_review: false,
              });
            }
            this.tradeStore.recordExitForOpenTrade(
              { exit_at: pr.exitAt, pnl_gross: pr.pnlGross, pnl_net: pr.pnlNet },
              pr.exitSymbol, pr.acctType,
            );
          }
        }

        // ── Step 2: Detect position close or missed complete trade ────────────────────────
        if (this.tradeStore && isFlat && grossChanged) {
          const pnlGross   = gross - prevGross!;
          const exitFee    = getSettings().subtractCommissions ? cfg.perContractFee : 0;
          const acctType   = data.accountType ?? this.lastAccountType;
          const exitSymbol = this.lastSymbol;

          if (this.tradeStore.hasOpenTrade(exitSymbol, acctType)) {
            // Normal exit: recorded entry exists — close it immediately.
            console.log(`[pnl-tracker] EXIT detected: pnlGross=${pnlGross} symbol=${exitSymbol} acctType=${acctType}`);
            this.tradeStore.recordExitForOpenTrade(
              { exit_at: Date.now(), pnl_gross: pnlGross, pnl_net: pnlGross - exitFee },
              exitSymbol, acctType,
            );
            // Reset cached direction: the position that set it is now closed.
            // Prevents a subsequent rescue from inheriting the wrong direction.
            this.lastKnownDirection = null;
          } else if (hasLivePosition) {
            // A position is visible on the same poll as the gross change.
            // Most likely: paper trading resets Realized PnL to 0 when a new position opens.
            // AMP Live: tabHasPosition (included in hasLivePosition) catches this correctly.
            // Either way, this is not a completed trade.
            console.log(`[pnl-tracker] gross changed (${prevGross}→${gross}) but position visible — P&L reset on open, skipping`);
          } else if (!this.hasObservedLivePosition) {
            // Never seen a live position this session: the gross change is a startup residual
            // (paper trading carries over yesterday's Realized PnL until the account resets).
            console.log(`[pnl-tracker] gross changed (${prevGross}→${gross}) but no position observed yet — startup residual, skipping`);
          } else {
            // A position was observed earlier this session; now the account is flat and gross
            // changed. Queue rescue for one-poll confirmation: if a position appears on the
            // next poll the gross change was a paper P&L reset on open, not a trade.
            console.log(`[pnl-tracker] gross changed (${prevGross}→${gross}) — queueing rescue for next-poll confirmation`);
            this.pendingRescue = {
              exitAt:     Date.now(),
              pnlGross,
              pnlNet:     pnlGross - exitFee,
              exitSymbol,
              acctType,
            };
          }
        }

        // ── Step 3: Detect position opened ───────────────────────────────────────────────
        const effectiveDirection = detectedDirection ?? this.lastKnownDirection;
        const effectiveDirSrc    = (detectedDirection ? directionSource : 'cached') as TradeEntry['direction_source'];

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
