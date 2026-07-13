import React, { useEffect, useState } from 'react';
import { TradeStats } from '../types';
import { BarChart, LineChart } from '../components/StatChart';

const fmt$ = (n: number) =>
  `${n >= 0 ? '+' : '-'}$${Math.abs(n).toFixed(2)}`;

const fmtPct = (n: number) => `${n.toFixed(1)}%`;

const fmtHour = (h: number) => {
  const ampm = h >= 12 ? 'PM' : 'AM';
  const h12 = h === 0 ? 12 : h > 12 ? h - 12 : h;
  return `${h12}${ampm}`;
};

export function Stats() {
  const [stats, setStats] = useState<TradeStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [resetting, setResetting] = useState(false);

  useEffect(() => {
    fetch('/api/stats')
      .then(r => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then(setStats)
      .catch(e => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  const handleReset = async () => {
    if (!window.confirm('Reset the trade journal? This deletes all trades and cannot be undone.')) return;
    setResetting(true);
    try {
      await fetch('/api/trades', { method: 'DELETE' });
      window.location.reload();
    } catch {
      setResetting(false);
    }
  };

  if (loading) return <div className="loading">Loading…</div>;
  if (error) return <div className="error-msg">Failed to load stats: {error}</div>;
  if (!stats || stats.totalTrades === 0) return (
    <div className="page">
      <div className="empty-state">No trade data yet.</div>
      <div style={{ textAlign: 'center', marginTop: '1rem' }}>
        <button className="btn-reset" onClick={handleReset} disabled={resetting}>
          {resetting ? 'Resetting…' : 'Reset Journal'}
        </button>
      </div>
    </div>
  );

  const pnlClass = (stats.totalNetPnl ?? 0) >= 0 ? 'pos' : 'neg';

  // Pattern win rate chart data
  const patternData = (stats.byPattern ?? []).map(p => ({
    label: p.pattern,
    value: p.winRate,
    maxValue: 100,
    color: p.winRate >= 50 ? 'var(--accent)' : 'var(--bearish)',
  }));

  // By-hour chart data
  const hourData = (stats.byHour ?? []).map(h => ({
    label: fmtHour(h.hour),
    value: h.avgNetPnl,
  }));

  // Equity curve
  const equityData = (stats.equityCurve ?? []).map(e => ({
    label: e.date,
    value: e.cumulativeNet,
  }));

  return (
    <div className="page">
      {/* Summary chips */}
      <div className="stat-chips">
        <div className="stat-chip">
          <div className="chip-label">Total Trades</div>
          <div className="chip-value">{stats.totalTrades}</div>
        </div>
        <div className="stat-chip">
          <div className="chip-label">Win Rate</div>
          <div className={`chip-value ${stats.winRate >= 50 ? 'pos' : 'neg'}`}>
            {fmtPct(stats.winRate)}
          </div>
        </div>
        <div className="stat-chip">
          <div className="chip-label">Avg R</div>
          <div className={`chip-value ${(stats.avgR ?? 0) >= 0 ? 'pos' : 'neg'}`}>
            {stats.avgR != null ? `${stats.avgR >= 0 ? '+' : ''}${stats.avgR.toFixed(2)}R` : '—'}
          </div>
        </div>
        <div className="stat-chip">
          <div className="chip-label">Total Net P&L</div>
          <div className={`chip-value ${pnlClass}`}>
            {fmt$(stats.totalNetPnl ?? 0)}
          </div>
        </div>
      </div>

      {/* Win rate by pattern */}
      {patternData.length > 0 && (
        <div className="chart-card">
          <div className="chart-title">Win Rate by Pattern</div>
          <BarChart
            data={patternData}
            height={Math.max(120, patternData.length * 28)}
            formatValue={v => fmtPct(v)}
          />
        </div>
      )}

      {/* P&L by hour */}
      {hourData.length > 0 && (
        <div className="chart-card">
          <div className="chart-title">Avg Net P&L by Hour (CST)</div>
          <BarChart
            data={hourData}
            height={200}
            formatValue={v => fmt$(v)}
          />
        </div>
      )}

      {/* Confidence calibration */}
      {(stats.byConfidenceBucket ?? []).length > 0 && (
        <div className="chart-card">
          <div className="chart-title">Win Rate by Confidence Level</div>
          <BarChart
            data={(stats.byConfidenceBucket ?? []).map(b => ({
              label: b.bucket,
              value: b.winRate * 100,
              color: b.winRate >= 0.5 ? 'var(--accent)' : 'var(--bearish)',
            }))}
            height={Math.max(80, (stats.byConfidenceBucket ?? []).length * 28)}
            formatValue={fmtPct}
          />
        </div>
      )}

      {/* Day-of-week P&L */}
      {(stats.byDayOfWeek ?? []).length > 0 && (
        <div className="chart-card">
          <div className="chart-title">Avg Net P&L by Day of Week</div>
          <BarChart
            data={(stats.byDayOfWeek ?? []).map(d => ({
              label: d.label,
              value: d.avgNetPnl,
            }))}
            height={Math.max(80, (stats.byDayOfWeek ?? []).length * 28)}
            formatValue={fmt$}
          />
        </div>
      )}

      {/* Equity curve */}
      {equityData.length >= 2 && (
        <div className="chart-card">
          <div className="chart-title">Equity Curve (cumulative net P&L)</div>
          <LineChart
            data={equityData}
            height={150}
            color={(stats.totalNetPnl ?? 0) >= 0 ? 'var(--accent)' : 'var(--bearish)'}
            formatValue={v => fmt$(v)}
          />
        </div>
      )}

      {/* Breakdown row */}
      <div style={{ display: 'flex', gap: '0.75rem', marginTop: '0.5rem', flexWrap: 'wrap' }}>
        <div className="stat-chip" style={{ flex: 1 }}>
          <div className="chip-label">Wins</div>
          <div className="chip-value pos">{stats.winCount}</div>
        </div>
        <div className="stat-chip" style={{ flex: 1 }}>
          <div className="chip-label">Losses</div>
          <div className="chip-value neg">{stats.lossCount}</div>
        </div>
        <div className="stat-chip" style={{ flex: 1 }}>
          <div className="chip-label">Open</div>
          <div className="chip-value">{stats.openCount}</div>
        </div>
      </div>

      {/* Reset */}
      <div style={{ marginTop: '2rem', paddingTop: '1.25rem', borderTop: '1px solid var(--border)', textAlign: 'center' }}>
        <button className="btn-reset" onClick={handleReset} disabled={resetting}>
          {resetting ? 'Resetting…' : 'Reset Journal'}
        </button>
        <p style={{ fontSize: 11, color: 'var(--text-secondary)', marginTop: '0.4rem' }}>
          Clears all trades. Use when resetting your paper trading account.
        </p>
      </div>
    </div>
  );
}
