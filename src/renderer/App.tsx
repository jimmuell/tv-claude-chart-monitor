import React, { useState, useEffect, useRef, useCallback } from 'react';
import type { AnalysisResult, CommentaryResult, SetupVerdict, KeyLevel, LevelAnnotation, HighestProbabilityTrade, PnlSnapshot, CandlestickPattern, AlertCreatePayload, AlertCreateResult } from '../shared/types';
import { parsePrice } from '../shared/utils';
import SettingsPanel from './SettingsPanel';

// ── Icons ──────────────────────────────────────────────────────────────────

const GearIcon: React.FC = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
    <path d="M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58c.18-.14.23-.41.12-.61l-1.92-3.32c-.12-.22-.37-.29-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54c-.04-.24-.24-.41-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.56-1.62.94l-2.39-.96c-.22-.08-.47 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.05.3-.09.63-.09.94s.02.64.07.94l-2.03 1.58c-.18.14-.23.41-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6z" />
  </svg>
);

const GoogleDriveIcon: React.FC = () => (
  <svg width="13" height="13" viewBox="0 0 24 24" aria-hidden="true">
    <path fill="#4285F4" d="M4.53 21L0 13.5 4.53 6h4.52L4.53 21z" />
    <path fill="#34A853" d="M19.47 21H4.53l2.26-3.9h15.2z" />
    <path fill="#EA4335" d="M19.47 21l4.53-7.5L19.47 6l-2.26 3.9 4.52 7.6z" />
    <path fill="#0F9D58" d="M9.88 21l2.26-3.9h5.07L9.88 21z" />
    <path fill="#1565C0" d="M4.53 6h4.52l2.26 3.9H6.8z" />
    <path fill="#FFC107" d="M14.14 9.9h5.07l-2.26 3.9h-5.08z" />
  </svg>
);


type GDriveState = 'idle' | 'exporting' | 'success' | 'error';

const GDriveButton: React.FC<{
  onError: (msg: string) => void;
}> = ({ onError }) => {
  const [gState, setGState]   = useState<GDriveState>('idle');
  const stateTimerRef         = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => { if (stateTimerRef.current) clearTimeout(stateTimerRef.current); };
  }, []);

  const setTempState = (s: GDriveState, ms: number) => {
    setGState(s);
    if (stateTimerRef.current) clearTimeout(stateTimerRef.current);
    stateTimerRef.current = setTimeout(() => { setGState('idle'); stateTimerRef.current = null; }, ms);
  };

  const handleExport = async () => {
    setGState('exporting');
    try {
      const result = await window.api.exportToDrive();
      if (result.cancelled) { setGState('idle'); return; }
      setTempState('success', 2000);
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Export failed');
      setTempState('error', 3000);
    }
  };

  const label = () => {
    switch (gState) {
      case 'exporting': return 'Saving…';
      case 'success':   return 'Saved ✓';
      case 'error':     return 'Failed';
      default:          return 'Save HTML';
    }
  };

  const btnClass = [
    'gdrive-btn-left',
    gState === 'success' ? 'success' : '',
    gState === 'error'   ? 'error-state' : '',
  ].filter(Boolean).join(' ');

  return (
    <div className="gdrive-wrap">
      <button
        className={btnClass}
        onClick={handleExport}
        disabled={gState === 'exporting'}
        title="Save analysis as HTML"
      >
        {gState === 'exporting'
          ? <span className="gdrive-spinner" />
          : <GoogleDriveIcon />
        }
        {label()}
      </button>
    </div>
  );
};

const BackArrowIcon: React.FC = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
    <path d="M20 11H7.83l5.59-5.59L12 4l-8 8 8 8 1.41-1.41L7.83 13H20v-2z" />
  </svg>
);

const EyeOnIcon: React.FC = () => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
    <path d="M12 4.5C7 4.5 2.73 7.61 1 12c1.73 4.39 6 7.5 11 7.5s9.27-3.11 11-7.5c-1.73-4.39-6-7.5-11-7.5zM12 17c-2.76 0-5-2.24-5-5s2.24-5 5-5 5 2.24 5 5-2.24 5-5 5zm0-8c-1.66 0-3 1.34-3 3s1.34 3 3 3 3-1.34 3-3-1.34-3-3-3z" />
  </svg>
);

const EyeOffIcon: React.FC = () => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
    <path d="M12 7c2.76 0 5 2.24 5 5 0 .65-.13 1.26-.36 1.83l2.92 2.92c1.51-1.26 2.7-2.89 3.43-4.75-1.73-4.39-6-7.5-11-7.5-1.4 0-2.74.25-3.98.7l2.16 2.16C10.74 7.13 11.35 7 12 7zM2 4.27l2.28 2.28.46.46C3.08 8.3 1.78 10.02 1 12c1.73 4.39 6 7.5 11 7.5 1.55 0 3.03-.3 4.38-.84l.42.42L19.73 22 21 20.73 3.27 3 2 4.27zM7.53 9.8l1.55 1.55c-.05.21-.08.43-.08.65 0 1.66 1.34 3 3 3 .22 0 .44-.03.65-.08l1.55 1.55c-.67.33-1.41.53-2.2.53-2.76 0-5-2.24-5-5 0-.79.2-1.53.53-2.2zm4.31-.78l3.15 3.15.02-.16c0-1.66-1.34-3-3-3l-.17.01z" />
  </svg>
);


// ── Verdict helpers ────────────────────────────────────────────────────────

const VERDICT_LABEL: Record<SetupVerdict, string> = {
  valid_long:       'Buy Setup',
  valid_long_was:   'Missed Buy',
  valid_short:      'Sell Setup',
  valid_short_was:  'Missed Sell',
  no_trade:         'No Setup',
  wait:             'Wait',
};

function verdictColor(v: SetupVerdict): string {
  switch (v) {
    case 'valid_long':
    case 'valid_long_was':
      return 'var(--accent)';
    case 'valid_short':
    case 'valid_short_was':
      return 'var(--bearish)';
    case 'wait':
      return '#f59e0b';
    case 'no_trade':
    default:
      return 'var(--text-secondary)';
  }
}

// ── Key level color helpers ────────────────────────────────────────────────

function levelColors(lvl: KeyLevel, currentPrice: number): { primary: string; secondary: string } {
  if (lvl.color === 'yellow') {
    return { primary: '#f59e0b', secondary: '#fcd34d' };
  }
  const isSupport = lvl.price < currentPrice;
  return isSupport
    ? { primary: '#ef5350', secondary: '#ef9a9a' }
    : { primary: '#42a5f5', secondary: '#90caf9' };
}

function levelKind(lvl: KeyLevel, currentPrice: number): string {
  if (lvl.color === 'yellow' || lvl.color === 'gray') return 'neutral';
  if (lvl.color === 'green') return 'support';
  if (lvl.color === 'red') return 'resistance';
  return lvl.price < currentPrice ? 'support' : 'resistance';
}

// ── Text helpers ───────────────────────────────────────────────────────────

function stripLeadingNumber(text: string): string {
  return text.replace(/^\d+[.)]\s*/, '');
}

function splitBullets(text: string): string[] {
  const parts = text.split(/\s*[•·]\s*|\n+/).map(s => s.trim()).filter(Boolean);
  return parts.length > 1 ? parts : [text];
}

// ── Countdown formatter ────────────────────────────────────────────────────

function formatCountdown(ms: number): string {
  if (ms <= 0) return '0:00';
  const totalSeconds = Math.ceil(ms / 1000);
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

// ── Markdown formatter for clipboard ──────────────────────────────────────

function formatAnalysis(result: AnalysisResult): string {
  const { commentary, symbol, timeframe, closedBarPrice } = result;
  const {
    headline, setup_verdict, objective,
    steps_what_happened, what_now, what_not,
    trade_plan, key_levels_to_watch,
    bottom_line, next_trigger, key_lesson,
  } = commentary;

  const lines: string[] = [];
  lines.push(`# ${VERDICT_LABEL[setup_verdict]}: ${headline}`);
  lines.push(`**${symbol} ${timeframe}m @ ${closedBarPrice}**`);
  lines.push('');

  if (key_levels_to_watch && key_levels_to_watch.length > 0) {
    lines.push('## Key Levels');
    for (const lvl of key_levels_to_watch) {
      lines.push(`- **${lvl.price.toFixed(2)}** ${lvl.label} — ${lvl.action}`);
    }
    lines.push('');
  }

  if (steps_what_happened.length > 0) {
    lines.push('## What Happened');
    steps_what_happened.forEach((s, i) => {
      lines.push(`${i + 1}. ${stripLeadingNumber(s)}`);
    });
    lines.push('');
  }

  lines.push('## Chart State');
  lines.push(objective);
  lines.push('');

  lines.push('## Directives');
  lines.push(`**NOW:** ${what_now}`);
  lines.push(`**NOT:** ${what_not}`);
  lines.push('');

  if (trade_plan && trade_plan.direction !== 'none') {
    const tp = trade_plan;
    lines.push(`## Trade Plan (${tp.direction.toUpperCase()})`);
    const entry  = tp.entry  != null ? tp.entry.toFixed(2)  : '—';
    const stop   = tp.stop   != null ? tp.stop.toFixed(2)   : '—';
    const target = tp.target != null ? tp.target.toFixed(2) : '—';
    const rr     = tp.rr     != null ? `${tp.rr.toFixed(1)}R` : '—';
    lines.push(`Entry: ${entry} | Stop: ${stop} | Target: ${target} | R:R: ${rr} | ${tp.confidence.toUpperCase()}`);
    if (tp.rationale) lines.push(tp.rationale);
    lines.push('');
  }

  lines.push('## Summary');
  lines.push(bottom_line);
  if (next_trigger) { lines.push(''); lines.push(`**IF** ${next_trigger}`); }
  if (key_lesson)   { lines.push(''); lines.push(`**LESSON** ${key_lesson}`); }

  return lines.join('\n');
}

// ── PnlBar ────────────────────────────────────────────────────────────────

function pnlColor(net: number): string {
  if (net > 5)  return 'var(--accent)';
  if (net < -5) return 'var(--bearish)';
  return '#f59e0b';
}

function fmtDollar(n: number): string {
  const abs  = Math.abs(n).toFixed(2);
  const sign = n < 0 ? '-' : n > 0 ? '+' : '';
  return `${sign}$${abs}`;
}

const PnlBar: React.FC<{ snap: PnlSnapshot; expanded: boolean; onToggle: () => void }> = ({
  snap, expanded, onToggle,
}) => {
  const netColor = pnlColor(snap.netPnl);
  const { fees } = snap;

  return (
    <div className="pnl-bar" onClick={onToggle} role="button" title="Click to expand fee breakdown">
      {!snap.dataAvailable ? (
        <span className="pnl-unavailable">{snap.message ?? 'Connect trading panel'}</span>
      ) : (
        <>
          <div className="pnl-row1">
            <span className="pnl-net" style={{ color: netColor }}>
              Net&nbsp;<strong>{fmtDollar(snap.netPnl)}</strong>
            </span>
            <span className="pnl-gross">Gross&nbsp;{fmtDollar(snap.grossPnl)}</span>
            <span className="pnl-fees">Fees&nbsp;${fees.totalFees.toFixed(2)}</span>
          </div>
          <div className="pnl-row2">
            <span className="pnl-trades">{snap.tradeCount}&nbsp;RT</span>
            <span className="pnl-sep">│</span>
            <span className="pnl-be">B/E&nbsp;{snap.breakevenPoints.toFixed(1)}&nbsp;pts</span>
            {snap.unrealizedPnl !== 0 && (
              <>
                <span className="pnl-sep">│</span>
                <span className="pnl-unreal" style={{ color: pnlColor(snap.unrealizedPnl) }}>
                  OTE&nbsp;{fmtDollar(snap.unrealizedPnl)}
                </span>
              </>
            )}
          </div>
          {expanded && (
            <div className="pnl-breakdown">
              <div className="pnl-bd-row">
                <span>Variable ({fees.contractCount}&nbsp;RT&nbsp;×&nbsp;${fees.perContractRate.toFixed(2)})</span>
                <span>${fees.variableFees.toFixed(2)}</span>
              </div>
              <div className="pnl-bd-row">
                <span>Daily fixed (liq + data)</span>
                <span>${fees.dailyFixed.toFixed(2)}</span>
              </div>
              <div className="pnl-bd-row pnl-bd-total">
                <span>Total fees</span>
                <span>${fees.totalFees.toFixed(2)}</span>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
};

// ── CommentaryCard ─────────────────────────────────────────────────────────

interface AnnotationState {
  drawnSlots:          Set<number>;
  pendingSlots:        Set<number>;
  autoDraw:            boolean;
  isAnnotationStale:   boolean;
  onToggle:            (idx: number, lvl: KeyLevel) => void;
  onDrawAll:           () => void;
  onClearAll:          () => void;
  onToggleAutoDraw:    (checked: boolean) => void;
}

interface TradePlanCtrl {
  tpDrawn:   boolean;
  tpPending: boolean;
  onDrawTP:  () => void;
  onClearTP: () => void;
}

interface AlertCtrl {
  alertedPrices:    Set<number>;
  pendingAlertPrices: Set<number>;
  alertErrorPrices:   Map<number, string>;
  onAlertToggle:    (slotIndex: number, price: number, label: string) => void;
}

function hptBiasColor(bias: HighestProbabilityTrade['bias']): string {
  if (bias === 'long')  return 'var(--accent)';
  if (bias === 'short') return 'var(--bearish)';
  return 'var(--text-secondary)';
}

function patternSignalStyle(signal: CandlestickPattern['signal']): { label: string; color: string } {
  switch (signal) {
    case 'bullish':  return { label: '▲ Bullish', color: 'var(--accent)' };
    case 'bearish':  return { label: '▼ Bearish', color: 'var(--bearish)' };
    default:         return { label: '◆ Neutral', color: '#f59e0b' };
  }
}

const CommentaryCard: React.FC<{
  commentary:   CommentaryResult;
  currentPrice: number;
  annotation:   AnnotationState;
  tradePlanCtrl: TradePlanCtrl;
  alertCtrl:    AlertCtrl;
}> = ({ commentary, currentPrice, annotation, tradePlanCtrl, alertCtrl }) => {
  const [detailsOpen, setDetailsOpen] = React.useState(false);

  const {
    headline, objective, steps_what_happened,
    setup_verdict, what_now, what_not,
    next_trigger, key_lesson, bottom_line,
    trade_plan, key_levels_to_watch,
    structure_read, highest_probability_trade,
    candlestick_patterns,
  } = commentary;

  const showTradePlan = trade_plan !== null && trade_plan !== undefined && trade_plan.direction !== 'none';
  const tradeBorderColor = trade_plan?.direction === 'long' ? 'var(--accent)' : 'var(--bearish)';

  const formatPrice = (n: number | null) => n != null ? n.toFixed(2) : '—';
  const formatRR   = (n: number | null) => n != null ? `${n.toFixed(1)}R` : '—';

  const objectiveBullets = splitBullets(objective);
  const hasLevels = key_levels_to_watch && key_levels_to_watch.length > 0;
  const hasPatterns = candlestick_patterns && candlestick_patterns.length > 0;

  return (
    <div className="commentary-card">

      {/* Section A — Verdict + Headline */}
      <div className="commentary-section">
        <span
          className="verdict-badge"
          style={{ backgroundColor: verdictColor(setup_verdict) }}
        >
          {VERDICT_LABEL[setup_verdict]}
        </span>
        <p style={{ marginTop: 6, fontSize: 13, fontWeight: 600, color: 'var(--text-primary)', lineHeight: 1.4 }}>
          {headline}
        </p>
      </div>

      {/* Section A1.5 — Candlestick Pattern Card */}
      {hasPatterns && (
        <div className="commentary-section">
          <div className="section-label">Patterns</div>
          <div className="pattern-list">
            {candlestick_patterns!.map((p, i) => {
              const sig = patternSignalStyle(p.signal);
              return (
                <div key={i} className="pattern-card" style={{ borderLeftColor: sig.color }}>
                  <div className="pattern-card-header">
                    <span className="pattern-name">{p.name}</span>
                    <span className="pattern-badge" style={{ color: sig.color }}>{sig.label}</span>
                  </div>
                  <p className="pattern-meaning">{p.meaning}</p>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Section B2 — Best Setup (HPT) — moved before levels */}
      {highest_probability_trade && (
        <div className="commentary-section">
          <div className="hpt-card" style={{ borderLeftColor: hptBiasColor(highest_probability_trade.bias) }}>
            <div className="hpt-header">
              <div className="section-label" style={{ margin: 0 }}>Best Setup</div>
              <span className="verdict-badge" style={{ backgroundColor: hptBiasColor(highest_probability_trade.bias) }}>
                {highest_probability_trade.bias.toUpperCase()}
              </span>
            </div>
            <p className="hpt-setup">{highest_probability_trade.setup}</p>
            <div className="hpt-details">
              <div className="hpt-detail-item">
                <span className="hpt-detail-label">Entry</span>
                <span className="hpt-detail-value">{highest_probability_trade.entry_zone}</span>
              </div>
              <div className="hpt-detail-item">
                <span className="hpt-detail-label">Stop</span>
                <span className="hpt-detail-value">{highest_probability_trade.stop}</span>
              </div>
              <div className="hpt-detail-item">
                <span className="hpt-detail-label">Targets</span>
                <span className="hpt-detail-value">{highest_probability_trade.targets}</span>
              </div>
            </div>
            {highest_probability_trade.condition && (
              <div className="callout-box callout-amber" style={{ marginTop: 8 }}>
                <span className="callout-prefix">IF</span>
                <span>{highest_probability_trade.condition}</span>
              </div>
            )}
            <div className="hpt-bracket-row">
              {tradePlanCtrl.tpDrawn ? (
                <button
                  className="annotate-btn annotate-btn-clear"
                  onClick={tradePlanCtrl.onClearTP}
                  disabled={tradePlanCtrl.tpPending}
                  title="Remove bracket from chart"
                >
                  Clear Bracket
                </button>
              ) : (
                <button
                  className="annotate-btn"
                  onClick={tradePlanCtrl.onDrawTP}
                  disabled={tradePlanCtrl.tpPending}
                  title="Draw entry/stop/target bracket on chart"
                >
                  Draw on Chart
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Section B — Watch These Levels (renamed from Key Levels) */}
      {hasLevels && (
        <div className="commentary-section">
          <div className="level-section-header">
            <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
              <span className="section-label" style={{ margin: 0 }}>Watch These Levels</span>
              {annotation.isAnnotationStale && <span className="stale-badge">Stale</span>}
            </div>
            <div className="level-toolbar">
              <label className="auto-draw-switch" title="Auto-draw levels on every refresh">
                <input
                  type="checkbox"
                  checked={annotation.autoDraw}
                  onChange={e => annotation.onToggleAutoDraw(e.target.checked)}
                />
                <span className="switch-track" />
                <span className="switch-label">Auto</span>
              </label>
              <button
                className="annotate-btn"
                onClick={annotation.onDrawAll}
                title="Draw all levels on chart"
              >
                Draw All
              </button>
              <button
                className="annotate-btn annotate-btn-clear"
                onClick={annotation.onClearAll}
                title="Remove all chart annotations"
              >
                Clear All
              </button>
            </div>
          </div>
          <div className="level-list">
            {key_levels_to_watch!.map((lvl, i) => {
              const { primary, secondary } = levelColors(lvl, currentPrice);
              const isDrawn   = annotation.drawnSlots.has(i);
              const isPending = annotation.pendingSlots.has(i);
              const isSecondary = lvl.priority === 'secondary';
              const isBellPending = alertCtrl.pendingAlertPrices.has(lvl.price);
              const isBellActive  = alertCtrl.alertedPrices.has(lvl.price);
              const bellError     = alertCtrl.alertErrorPrices.get(lvl.price);
              return (
                <div
                  key={i}
                  className={`level-card${isSecondary ? ' level-card-secondary' : ''}`}
                  style={{ borderLeftColor: primary }}
                >
                  <button
                    className={`eye-btn${isDrawn ? ' eye-on' : ''}${isPending ? ' eye-pending' : ''}`}
                    onClick={() => annotation.onToggle(i, lvl)}
                    disabled={isPending}
                    aria-label={isDrawn ? 'Hide level on chart' : 'Draw level on chart'}
                    style={{ color: isDrawn ? primary : 'var(--text-secondary)' }}
                  >
                    {isDrawn ? <EyeOnIcon /> : <EyeOffIcon />}
                  </button>
                  <span className="level-price" style={{ color: primary }}>{lvl.price.toFixed(2)}</span>
                  <span
                    className="level-label"
                    style={{
                      color:   isBellActive ? 'var(--accent)' : bellError ? 'var(--bearish)' : secondary,
                      cursor:  isBellPending ? 'default' : 'pointer',
                      opacity: isBellPending ? 0.5 : 1,
                    }}
                    onClick={() => !isBellPending && alertCtrl.onAlertToggle(i, lvl.price, lvl.label)}
                    title={
                      bellError    ? `Alert failed: ${bellError} — click to retry` :
                      isBellActive ? 'Alert armed — click to disarm' :
                      isBellPending ? 'Setting alert…' :
                                     'Click to arm a price-crossing alert'
                    }
                  >
                    {lvl.label}
                    {isBellActive  && <span className="alert-badge">🔔</span>}
                    {isBellPending && <span className="alert-badge alert-badge-pending">…</span>}
                    {bellError     && <span className="alert-badge alert-badge-error">!</span>}
                  </span>
                  <span className="level-action">{lvl.action}</span>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Section C — Trade Plan */}
      {showTradePlan && trade_plan && (
        <div className="commentary-section">
          <div
            className="trade-plan-card"
            style={{ borderLeftColor: tradeBorderColor }}
          >
            <div className="price-row">
              <div className="price-item">
                <span className="price-item-label">Entry</span>
                <span className="price-item-value">{formatPrice(trade_plan.entry)}</span>
              </div>
              <div className="price-item">
                <span className="price-item-label">Stop</span>
                <span className="price-item-value">{formatPrice(trade_plan.stop)}</span>
              </div>
              <div className="price-item">
                <span className="price-item-label">Target</span>
                <span className="price-item-value">{formatPrice(trade_plan.target)}</span>
              </div>
              <div className="price-item">
                <span className="price-item-label">R:R</span>
                <span className="price-item-value">{formatRR(trade_plan.rr)}</span>
              </div>
            </div>
            <div style={{ marginBottom: 6 }}>
              <span
                className="verdict-badge"
                style={{
                  backgroundColor:
                    trade_plan.confidence === 'high' ? 'var(--accent)'
                    : trade_plan.confidence === 'medium' ? '#f59e0b'
                    : 'var(--text-secondary)',
                }}
              >
                {trade_plan.confidence.toUpperCase()}
              </span>
            </div>
            {trade_plan.rationale && (
              <p style={{ fontSize: 12, color: 'var(--text-primary)', lineHeight: 1.4 }}>
                {trade_plan.rationale}
              </p>
            )}
          </div>
        </div>
      )}

      {/* Section F — What Now / What Not */}
      <div className="commentary-section">
        <div className="what-row">
          <span className="what-prefix">NOW</span>
          <span style={{ fontSize: 12, color: 'var(--text-primary)', lineHeight: 1.4 }}>{what_now}</span>
        </div>
        <div className="what-row">
          <span className="what-prefix">NOT</span>
          <span style={{ fontSize: 12, color: 'var(--bearish)', opacity: 0.85, lineHeight: 1.4 }}>{what_not}</span>
        </div>
      </div>

      {/* Details toggle — collapses What Happened, Structure Read, Chart State */}
      <div
        className="details-toggle"
        onClick={() => setDetailsOpen(v => !v)}
        role="button"
        aria-expanded={detailsOpen}
      >
        <span className="section-label" style={{ margin: 0 }}>Details</span>
        <span className="details-chevron">{detailsOpen ? '▲' : '▼'}</span>
      </div>
      {detailsOpen && (
        <div className="details-body">
          {structure_read && (
            <div className="commentary-section">
              <div className="section-label">Structure</div>
              <p className="structure-read-text">{structure_read}</p>
            </div>
          )}
          {steps_what_happened.length > 0 && (
            <div className="commentary-section">
              <div className="section-label">What Happened</div>
              <ol style={{ paddingLeft: 18, margin: 0 }}>
                {steps_what_happened.map((step, i) => (
                  <li key={i} style={{ fontSize: 12, color: 'var(--text-primary)', marginBottom: 3, lineHeight: 1.45 }}>
                    {stripLeadingNumber(step)}
                  </li>
                ))}
              </ol>
            </div>
          )}
          <div className="commentary-section">
            <div className="section-label">Chart State</div>
            {objectiveBullets.length > 1 ? (
              <ul style={{ paddingLeft: 16, margin: 0 }}>
                {objectiveBullets.map((b, i) => (
                  <li key={i} style={{ fontSize: 12, color: 'var(--text-primary)', lineHeight: 1.5, marginBottom: 2 }}>
                    {b}
                  </li>
                ))}
              </ul>
            ) : (
              <p style={{ fontSize: 12, color: 'var(--text-primary)', lineHeight: 1.5 }}>
                {objective}
              </p>
            )}
          </div>
        </div>
      )}

      {/* Section G — Bottom line + callouts */}
      <div className="commentary-section" style={{ marginBottom: 0, marginTop: 8 }}>
        <p className="bottom-line">{bottom_line}</p>
        {next_trigger && (
          <div className="callout-box callout-amber">
            <span className="callout-prefix">IF</span>
            <span>{next_trigger}</span>
          </div>
        )}
        {key_lesson && (
          <div className="callout-box callout-accent">
            <span className="callout-prefix">LESSON</span>
            <em>{key_lesson}</em>
          </div>
        )}
      </div>

    </div>
  );
};

// ── Loading message mapper ─────────────────────────────────────────────────

function mapLoadingMessage(status: string): string {
  switch (status) {
    case 'capturing':                   return 'Connecting to TradingView...';
    case 'analyzing':                   return 'Analyzing with Claude...';
    case 'Connecting to TradingView...':
    case 'Reading chart data...':
    case 'Analyzing...':               return status;
    default:                           return status;
  }
}

// ── App ────────────────────────────────────────────────────────────────────

type UIStatus = 'idle' | 'loading' | 'complete' | 'error';

const App: React.FC = () => {
  const [view, setView]                     = useState<'analysis' | 'settings'>('analysis');
  const [uiStatus, setUiStatus]             = useState<UIStatus>('idle');
  const [loadingMessage, setLoadingMessage] = useState('');
  const [result, setResult]                 = useState<AnalysisResult | null>(null);
  const [errorMessage, setErrorMessage]     = useState('');
  const [nextTickMs, setNextTickMs]         = useState<number | null>(null);
  const [countdown, setCountdown]           = useState('');
  const [copied, setCopied]                 = useState(false);
  const [drawnSlots, setDrawnSlots]           = useState<Set<number>>(new Set());
  const [pendingSlots, setPendingSlots]       = useState<Set<number>>(new Set());
  const [annotateError, setAnnotateError]     = useState<string | null>(null);
  const [autoDraw, setAutoDraw]               = useState(false);
  const [persistLevels, setPersistLevels]     = useState(false);
  const [isAnnotationStale, setIsAnnotationStale] = useState(false);
  const [tpDrawn, setTpDrawn]                 = useState(false);
  const [tpPending, setTpPending]             = useState(false);
  const [pnlSnap, setPnlSnap]                 = useState<PnlSnapshot | null>(null);
  const [pnlExpanded, setPnlExpanded]         = useState(false);
  const [pnlVisible, setPnlVisible]           = useState(true);
  const countdownRef                          = useRef<ReturnType<typeof setInterval> | null>(null);
  const copiedTimerRef                        = useRef<ReturnType<typeof setTimeout> | null>(null);
  const annotateErrTimerRef                   = useRef<ReturnType<typeof setTimeout> | null>(null);
  const autoDrawRef                           = useRef(false);
  const persistLevelsRef                      = useRef(false);
  const drawnSlotsRef                         = useRef<Set<number>>(new Set());
  const [alertedPrices, setAlertedPrices]           = useState<Set<number>>(new Set());
  const [pendingAlertPrices, setPendingAlertPrices] = useState<Set<number>>(new Set());
  const [alertErrorPrices, setAlertErrorPrices]     = useState<Map<number, string>>(new Map());
  const prevSymbolRef                               = useRef<string | null>(null);

  // Load persisted settings on mount
  useEffect(() => {
    window.api.getSettings().then(s => {
      setAutoDraw(s.autoDraw);
      autoDrawRef.current = s.autoDraw;
      setPersistLevels(s.persistLevels);
      persistLevelsRef.current = s.persistLevels;
    }).catch(() => {/* ignore */});
  }, []);

  // Keep refs in sync so stale closures (onAnalysis) see current values
  useEffect(() => { autoDrawRef.current = autoDraw; }, [autoDraw]);
  useEffect(() => { persistLevelsRef.current = persistLevels; }, [persistLevels]);
  useEffect(() => { drawnSlotsRef.current = drawnSlots; }, [drawnSlots]);

  // Returns true when the result has enough data to draw a trade plan bracket
  const hasBracketData = useCallback((r: AnalysisResult): boolean => {
    const tp  = r.commentary.trade_plan;
    const hpt = r.commentary.highest_probability_trade;
    if (tp && tp.entry != null && tp.stop != null && tp.target != null) return true;
    if (hpt) {
      return (
        parsePrice(hpt.entry_zone) != null &&
        parsePrice(hpt.stop)       != null &&
        parsePrice(hpt.targets)    != null
      );
    }
    return false;
  }, []);

  // Derive drawn slot set for a pushed result given current autoDraw state
  const drawnSlotsForResult = useCallback((pushed: AnalysisResult, ad: boolean): Set<number> => {
    if (!ad) return new Set();
    const count = pushed.commentary.key_levels_to_watch?.length ?? 0;
    return new Set(Array.from({ length: Math.min(count, 8) }, (_, i) => i));
  }, []);

  // Subscribe to IPC events
  useEffect(() => {
    const unsubStatus = window.api.onStatus((status) => {
      setLoadingMessage(mapLoadingMessage(status));
    });

    const unsubAnalysis = window.api.onAnalysis((pushed) => {
      if (!pushed || typeof pushed !== 'object' || !('commentary' in pushed)) return;
      if (pushed.symbol !== prevSymbolRef.current) {
        setAlertedPrices(new Set());
        setAlertErrorPrices(new Map());
        prevSymbolRef.current = pushed.symbol;
      }
      setResult(pushed);
      setUiStatus('complete');
      if (pushed.barCloseMs > Date.now()) setNextTickMs(pushed.barCloseMs);

      const ad = autoDrawRef.current;
      const pl = persistLevelsRef.current;
      if (ad) {
        // autoDraw wins — overwrite chart with current levels
        setDrawnSlots(drawnSlotsForResult(pushed, true));
        setIsAnnotationStale(false);
        setTpDrawn(hasBracketData(pushed));
      } else if (pl) {
        // persist ON: keep existing eye state; mark stale if any levels are drawn
        if (drawnSlotsRef.current.size > 0) setIsAnnotationStale(true);
      } else {
        // default: reset eye icons on each new analysis
        setDrawnSlots(new Set());
        setIsAnnotationStale(false);
      }
      setPendingSlots(new Set());
    });

    const unsubNextTick = window.api.onNextTick((_nextMs) => { /* barCloseMs drives countdown */ });

    const unsubPnl = window.api.onPnlUpdate((snap) => { setPnlSnap(snap); });

    // Fetch initial P&L snapshot and pnlVisible setting
    window.api.getPnl().then(setPnlSnap).catch(() => {});
    window.api.getSettings().then(s => {
      setPnlVisible(s.pnlVisible ?? true);
    }).catch(() => {});

    return () => {
      unsubStatus();
      unsubAnalysis();
      unsubNextTick();
      unsubPnl();
    };
  }, []);

  // Countdown ticker
  useEffect(() => {
    if (countdownRef.current) { clearInterval(countdownRef.current); countdownRef.current = null; }
    if (nextTickMs === null) { setCountdown(''); return; }
    const tick = () => {
      const remaining = nextTickMs - Date.now();
      if (remaining <= 0) {
        setCountdown('');
        if (countdownRef.current) { clearInterval(countdownRef.current); countdownRef.current = null; }
      } else {
        setCountdown(formatCountdown(remaining));
      }
    };
    tick();
    countdownRef.current = setInterval(tick, 1000);
    return () => { if (countdownRef.current) clearInterval(countdownRef.current); };
  }, [nextTickMs]);

  // Re-sync settings when returning from settings panel
  useEffect(() => {
    if (view === 'analysis') {
      window.api.getSettings().then(s => {
        setAutoDraw(s.autoDraw);
        autoDrawRef.current = s.autoDraw;
        setPersistLevels(s.persistLevels);
        persistLevelsRef.current = s.persistLevels;
        if (!s.persistLevels) setIsAnnotationStale(false);
        setPnlVisible(s.pnlVisible ?? true);
      }).catch(() => {});
    }
  }, [view]);

  const handleRefresh = async () => {
    setUiStatus('loading');
    setErrorMessage('');
    setLoadingMessage('Requesting analysis…');
    try {
      const analysisResult = await window.api.requestAnalysis();
      setResult(analysisResult);
      setUiStatus('complete');
      if (analysisResult.barCloseMs > Date.now()) setNextTickMs(analysisResult.barCloseMs);
      if (autoDraw) {
        setDrawnSlots(drawnSlotsForResult(analysisResult, true));
        setIsAnnotationStale(false);
        setTpDrawn(hasBracketData(analysisResult));
      } else if (persistLevels) {
        if (drawnSlots.size > 0) setIsAnnotationStale(true);
      } else {
        setDrawnSlots(new Set());
        setIsAnnotationStale(false);
      }
      setPendingSlots(new Set());
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : 'Unknown error');
      setUiStatus('error');
    }
  };

  const handleCopy = async () => {
    if (!result) return;
    try {
      await navigator.clipboard.writeText(formatAnalysis(result));
      setCopied(true);
      if (copiedTimerRef.current) clearTimeout(copiedTimerRef.current);
      copiedTimerRef.current = setTimeout(() => { setCopied(false); copiedTimerRef.current = null; }, 2000);
    } catch { /* clipboard unavailable */ }
  };

  const showAnnotateError = (msg: string) => {
    setAnnotateError(msg);
    if (annotateErrTimerRef.current) clearTimeout(annotateErrTimerRef.current);
    annotateErrTimerRef.current = setTimeout(() => {
      setAnnotateError(null);
      annotateErrTimerRef.current = null;
    }, 3000);
  };

  const handleToggle = async (idx: number, lvl: KeyLevel) => {
    if (pendingSlots.has(idx) || !result) return;
    const isDrawn = drawnSlots.has(idx);
    const kind    = levelKind(lvl, result.closedBarPrice);
    setPendingSlots(prev => new Set([...prev, idx]));
    try {
      const chartLabel = !isDrawn && alertedPrices.has(lvl.price) ? armedLabel(lvl.label) : lvl.label;
      await window.api.toggleLevel(idx + 1, lvl.price, kind, chartLabel, isDrawn ? 0 : 1, lvl.priority ?? 'primary');
      setDrawnSlots(prev => {
        const next = new Set(prev);
        if (isDrawn) next.delete(idx); else next.add(idx);
        return next;
      });
    } catch (err) {
      showAnnotateError(err instanceof Error ? err.message : 'Annotation failed');
    } finally {
      setPendingSlots(prev => { const next = new Set(prev); next.delete(idx); return next; });
    }
  };

  const handleDrawAll = async () => {
    if (!result?.commentary.key_levels_to_watch) return;
    const levels = result.commentary.key_levels_to_watch.slice(0, 8);
    const currentPrice = result.closedBarPrice;
    const annotations: LevelAnnotation[] = levels.map((lvl, i) => ({
      slotIndex: i + 1,
      price:     lvl.price,
      kind:      levelKind(lvl, currentPrice),
      label:     alertedPrices.has(lvl.price) ? armedLabel(lvl.label) : lvl.label,
      visible:   1,
      priority:  lvl.priority ?? 'primary',
    }));
    try {
      await window.api.drawAllLevels(annotations);
      setDrawnSlots(new Set(levels.map((_, i) => i)));
      setIsAnnotationStale(false);
    } catch (err) {
      showAnnotateError(err instanceof Error ? err.message : 'Draw failed');
    }
  };

  const handleClearAll = async () => {
    try {
      await window.api.clearAllLevels();
      setDrawnSlots(new Set());
      setIsAnnotationStale(false);
    } catch (err) {
      showAnnotateError(err instanceof Error ? err.message : 'Clear failed');
    }
  };

  const armedLabel = (base: string) => base.slice(0, 17).trimEnd() + ' 🔔';

  const updateChartLabel = (slotIndex: number, lvl: KeyLevel, armed: boolean) => {
    if (!result || !drawnSlots.has(slotIndex)) return;
    const kind       = levelKind(lvl, result.closedBarPrice);
    const chartLabel = armed ? armedLabel(lvl.label) : lvl.label;
    window.api.toggleLevel(slotIndex + 1, lvl.price, kind, chartLabel, 1, lvl.priority ?? 'primary')
      .catch(() => {});
  };

  const handleAlertToggle = async (slotIndex: number, price: number, label: string) => {
    const lvl = result?.commentary.key_levels_to_watch?.[slotIndex];
    if (alertedPrices.has(price)) {
      try { await window.api.removeAlert(price); } catch (_) {}
      setAlertedPrices(prev => { const s = new Set(prev); s.delete(price); return s; });
      if (lvl) updateChartLabel(slotIndex, lvl, false);
      return;
    }
    if (pendingAlertPrices.has(price)) return;
    setPendingAlertPrices(prev => { const s = new Set(prev); s.add(price); return s; });
    setAlertErrorPrices(prev => { const m = new Map(prev); m.delete(price); return m; });
    try {
      const res: AlertCreateResult = await window.api.createAlert({ price, label });
      if (res.ok) {
        setAlertedPrices(prev => { const s = new Set(prev); s.add(price); return s; });
        if (lvl) updateChartLabel(slotIndex, lvl, true);
      } else {
        setAlertErrorPrices(prev => { const m = new Map(prev); m.set(price, res.error); return m; });
      }
    } catch (err) {
      setAlertErrorPrices(prev => {
        const m = new Map(prev);
        m.set(price, err instanceof Error ? err.message : 'Unknown error');
        return m;
      });
    } finally {
      setPendingAlertPrices(prev => { const s = new Set(prev); s.delete(price); return s; });
    }
  };

  const handleDrawTP = async () => {
    if (!result) return;
    const tp  = result.commentary.trade_plan;
    const hpt = result.commentary.highest_probability_trade;

    let entry: number | null = null;
    let stop:  number | null = null;
    let target: number | null = null;

    // HPT has priority — it is the highest-confidence setup.
    if (hpt) {
      entry  = parsePrice(hpt.entry_zone);
      stop   = parsePrice(hpt.stop);
      target = parsePrice(hpt.targets);
    }
    // Fallback to trade_plan numeric values if HPT parse failed.
    if ((entry == null || stop == null || target == null) && tp && tp.entry != null && tp.stop != null && tp.target != null) {
      entry = tp.entry; stop = tp.stop; target = tp.target;
    }

    if (entry == null || stop == null || target == null) return;
    setTpPending(true);
    try {
      await window.api.writeTradePlan(entry, stop, target);
      setTpDrawn(true);
    } catch (err) {
      showAnnotateError(err instanceof Error ? err.message : 'Bracket draw failed');
    } finally {
      setTpPending(false);
    }
  };

  const handleClearTP = async () => {
    setTpPending(true);
    try {
      await window.api.clearTradePlan();
      setTpDrawn(false);
    } catch (err) {
      showAnnotateError(err instanceof Error ? err.message : 'Bracket clear failed');
    } finally {
      setTpPending(false);
    }
  };

  const handleToggleAutoDraw = async (checked: boolean) => {
    setAutoDraw(checked);
    autoDrawRef.current = checked;
    try {
      await window.api.updateSettings({ autoDraw: checked });
    } catch { /* ignore */ }
  };

  const dotClass = uiStatus === 'complete' ? 'status-dot active'
    : uiStatus === 'error' ? 'status-dot error'
    : 'status-dot';

  const renderBody = () => {
    if (view === 'settings') {
      return (
        <div className="result-body-wrap">
          <SettingsPanel />
        </div>
      );
    }
    if (uiStatus === 'loading') {
      return <div className="body"><p className="loading-text">{loadingMessage}</p></div>;
    }
    if (uiStatus === 'error') {
      return <div className="body"><p className="error-text">{errorMessage}</p></div>;
    }
    if (uiStatus === 'complete' && result) {
      return (
        <div className="result-body-wrap">
          {pnlVisible && pnlSnap && (
            <PnlBar
              snap={pnlSnap}
              expanded={pnlExpanded}
              onToggle={() => setPnlExpanded(v => !v)}
            />
          )}
          <div className="result-body">
            <CommentaryCard
              commentary={result.commentary}
              currentPrice={result.closedBarPrice}
              annotation={{
                drawnSlots,
                pendingSlots,
                autoDraw,
                isAnnotationStale,
                onToggle:         handleToggle,
                onDrawAll:        handleDrawAll,
                onClearAll:       handleClearAll,
                onToggleAutoDraw: handleToggleAutoDraw,
              }}
              tradePlanCtrl={{
                tpDrawn,
                tpPending,
                onDrawTP:  handleDrawTP,
                onClearTP: handleClearTP,
              }}
              alertCtrl={{
                alertedPrices,
                pendingAlertPrices,
                alertErrorPrices,
                onAlertToggle: handleAlertToggle,
              }}
            />
          </div>
          <div className="scroll-fade" />
        </div>
      );
    }
    return <div className="body"><p className="placeholder-text">No analysis yet. Click refresh to capture.</p></div>;
  };

  return (
    <div className="app">
      <header className="header">
        {/* Row 1: title + gear (or back arrow + Settings title when in settings view) */}
        {view === 'settings' ? (
          <div className="header-row1">
            <button
              className="icon-btn"
              aria-label="Back to analysis"
              title="Back"
              onClick={() => setView('analysis')}
            >
              <BackArrowIcon />
            </button>
            <h1 className="title">Settings</h1>
            <button
              className="icon-btn icon-btn-active"
              aria-label="Close settings"
              title="Close settings"
              onClick={() => setView('analysis')}
            >
              <GearIcon />
            </button>
          </div>
        ) : (
          <div className="header-row1">
            <h1 className="title">Trading Analyzer</h1>
            <div className="header-actions">
              {result && (
                <GDriveButton
                  onError={showAnnotateError}
                />
              )}
              <button
                className="icon-btn"
                aria-label="Settings"
                title="Settings"
                onClick={() => setView('settings')}
              >
                <GearIcon />
              </button>
            </div>
          </div>
        )}
        {/* Row 2: only in analysis view */}
        {view === 'analysis' && (
          <div className="header-row2">
            <div className="header-row2-left">
              <span className={dotClass} aria-label={`Status: ${uiStatus}`} />
              {result && (
                <span className="header-symbol">
                  {result.symbol}
                  <span className="header-symbol-sep"> · {result.timeframe}m</span>
                </span>
              )}
            </div>
            {result && (
              <span className="header-price">
                <span className="header-price-at">@</span>{result.closedBarPrice}
              </span>
            )}
            {countdown
              ? <span className="countdown-chip"><span className="countdown-label">Next:</span><span className="countdown-value">{countdown}</span></span>
              : <span />
            }
          </div>
        )}
      </header>

      {renderBody()}

      {view === 'analysis' && (
        <footer className="footer">
          <div className="footer-row">
            {result && (
              <button
                className="copy-btn"
                onClick={handleCopy}
                title="Copy analysis to clipboard"
              >
                {copied ? 'Copied!' : 'Copy'}
              </button>
            )}
            <button
              className="refresh-btn"
              onClick={handleRefresh}
              disabled={uiStatus === 'loading'}
            >
              {uiStatus === 'loading' ? 'Loading...' : 'Refresh'}
            </button>
          </div>
        </footer>
      )}

      {annotateError && <div className="toast toast-error">{annotateError}</div>}
    </div>
  );
};

export default App;
