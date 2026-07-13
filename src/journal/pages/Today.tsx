import React, { useEffect, useState } from 'react';
import { TradeRecord } from '../types';
import { TradeCard } from '../components/TradeCard';

const fmt$ = (n: number) =>
  `${n >= 0 ? '+' : '-'}$${Math.abs(n).toFixed(2)}`;

const todayCSTStr = () =>
  new Date().toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });

export function Today() {
  const [trades, setTrades] = useState<TradeRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch('/api/trades')
      .then(r => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((data: TradeRecord[]) => {
        const todayStr = todayCSTStr();
        const todayTrades = data.filter(t => {
          const d = new Date(t.created_at).toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });
          return d === todayStr;
        });
        // Most recent first
        todayTrades.sort((a, b) => b.created_at - a.created_at);
        setTrades(todayTrades);
      })
      .catch(e => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  const totalNet = trades.reduce((s, t) => s + (t.pnl_net ?? 0), 0);
  const wins = trades.filter(t => t.r_multiple != null && t.r_multiple > 0).length;
  const closed = trades.filter(t => t.exit_price != null).length;
  const winRate = closed > 0 ? Math.round((wins / closed) * 100) : null;

  const todayLabel = new Date().toLocaleDateString('en-US', {
    weekday: 'long', month: 'long', day: 'numeric', timeZone: 'America/Chicago',
  });

  if (loading) return <div className="loading">Loading…</div>;
  if (error) return <div className="error-msg">Failed to load trades: {error}</div>;

  return (
    <div className="page">
      <div className="summary-bar">
        <span className="date-label">{todayLabel}</span>
        <div className="summary-chip">
          <span className="chip-label">Net P&L</span>
          <span className={`chip-value ${totalNet >= 0 ? 'pos' : 'neg'}`}>
            {trades.length > 0 ? fmt$(totalNet) : '—'}
          </span>
        </div>
        <div className="summary-chip">
          <span className="chip-label">Trades</span>
          <span className="chip-value">{trades.length}</span>
        </div>
        <div className="summary-chip">
          <span className="chip-label">Win Rate</span>
          <span className="chip-value">{winRate != null ? `${winRate}%` : '—'}</span>
        </div>
      </div>

      {trades.length === 0 ? (
        <div className="empty-state">No trades today.</div>
      ) : (
        trades.map(t => (
          <TradeCard
            key={t.id}
            trade={t}
            onDeleted={id => setTrades(prev => prev.filter(p => p.id !== id))}
            onUpdated={updated => setTrades(prev => prev.map(p => p.id === updated.id ? updated : p))}
          />
        ))
      )}
    </div>
  );
}
