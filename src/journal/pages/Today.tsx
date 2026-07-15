import React, { useEffect, useState } from 'react';
import { TradeRecord } from '../types';
import { TradeCard } from '../components/TradeCard';

const fmt$ = (n: number) =>
  `${n >= 0 ? '+' : '-'}$${Math.abs(n).toFixed(2)}`;

const todayCSTStr = () =>
  new Date().toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });

function LogTradeForm({ onLogged }: { onLogged: (t: TradeRecord) => void }) {
  const [open, setOpen] = useState(false);
  const [dir, setDir] = useState<'long' | 'short'>('short');
  const [entry, setEntry] = useState('');
  const [stop, setStop] = useState('');
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const handleSubmit = async () => {
    const entry_price = parseFloat(entry);
    if (isNaN(entry_price)) { setErr('Enter a valid entry price'); return; }
    setSaving(true); setErr(null);
    try {
      const res = await fetch('/api/trades', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          symbol: 'CME_MINI:MES1!',
          direction: dir,
          entry_price,
          stop_price: stop ? parseFloat(stop) : undefined,
        }),
      });
      if (!res.ok) {
        const e = await res.json().catch(() => ({}));
        throw new Error(e.error ?? `HTTP ${res.status}`);
      }
      const trade: TradeRecord = await res.json();
      onLogged(trade);
      setOpen(false);
      setEntry(''); setStop('');
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : 'Failed');
    } finally {
      setSaving(false);
    }
  };

  if (!open) {
    return (
      <button
        className="btn-critique"
        onClick={() => setOpen(true)}
        style={{ fontSize: 11, padding: '0.25rem 0.6rem', marginBottom: '0.5rem' }}
      >
        + Log Open Trade
      </button>
    );
  }

  return (
    <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 'var(--radius)', padding: '0.75rem', marginBottom: '0.75rem' }}>
      <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: '0.5rem' }}>Log Open Trade</div>
      <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', alignItems: 'flex-end' }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
          <span style={{ fontSize: 10, color: 'var(--text-secondary)', textTransform: 'uppercase' }}>Direction</span>
          <select
            value={dir}
            onChange={e => setDir(e.target.value as 'long' | 'short')}
            style={{ background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 'var(--radius)', color: 'var(--text-primary)', padding: '0.25rem 0.4rem', fontSize: 12, fontFamily: 'var(--font)' }}
          >
            <option value="short">Short</option>
            <option value="long">Long</option>
          </select>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
          <span style={{ fontSize: 10, color: 'var(--text-secondary)', textTransform: 'uppercase' }}>Entry price</span>
          <input
            type="number" step="0.25" placeholder="7568.75"
            value={entry} onChange={e => setEntry(e.target.value)}
            style={{ width: 90, background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 'var(--radius)', color: 'var(--text-primary)', padding: '0.25rem 0.4rem', fontSize: 12, fontFamily: 'var(--font)' }}
          />
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
          <span style={{ fontSize: 10, color: 'var(--text-secondary)', textTransform: 'uppercase' }}>Stop price</span>
          <input
            type="number" step="0.25" placeholder="7572.75"
            value={stop} onChange={e => setStop(e.target.value)}
            style={{ width: 90, background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 'var(--radius)', color: 'var(--text-primary)', padding: '0.25rem 0.4rem', fontSize: 12, fontFamily: 'var(--font)' }}
          />
        </div>
        <button className="btn-critique" onClick={handleSubmit} disabled={saving} style={{ alignSelf: 'flex-end' }}>
          {saving ? 'Saving…' : 'Log Trade'}
        </button>
        <button className="btn-reset" onClick={() => { setOpen(false); setErr(null); }} style={{ alignSelf: 'flex-end', fontSize: 11, padding: '0.25rem 0.5rem' }}>
          Cancel
        </button>
      </div>
      {err && <p style={{ fontSize: 11, color: 'var(--bearish)', marginTop: '0.35rem' }}>{err}</p>}
    </div>
  );
}

export function Today() {
  const [trades, setTrades] = useState<TradeRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [connected, setConnected] = useState<boolean | null>(null);

  useEffect(() => {
    const fetchTrades = () => {
      fetch('/api/trades')
        .then(r => {
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          return r.json();
        })
        .then((data: TradeRecord[]) => {
          setConnected(true);
          setError(null);
          const todayStr = todayCSTStr();
          const todayTrades = data.filter(t => {
            const d = new Date(t.created_at).toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });
            return d === todayStr;
          });
          todayTrades.sort((a, b) => b.created_at - a.created_at);
          setTrades(todayTrades);
        })
        .catch(e => {
          if (e instanceof TypeError) {
            setConnected(false);
          } else {
            setConnected(true);
            setError(e instanceof Error ? e.message : String(e));
          }
        })
        .finally(() => setLoading(false));
    };

    fetchTrades();

    // SSE: re-fetch whenever the server pushes a refresh event (trade entry, exit, close)
    const es = new EventSource('/api/events');
    es.onmessage = () => fetchTrades();
    es.onerror = () => {}; // browser auto-reconnects

    // Fallback poll every 60 s in case SSE is unavailable
    const interval = setInterval(fetchTrades, 60_000);
    return () => { es.close(); clearInterval(interval); };
  }, []);

  const totalNet      = trades.reduce((s, t) => s + (t.pnl_net ?? 0), 0);
  const closedTrades  = trades.filter(t => t.exit_at != null);
  const wins          = closedTrades.filter(t => (t.pnl_net ?? 0) > 0).length;
  const losses        = closedTrades.filter(t => (t.pnl_net ?? 0) < 0).length;
  const closedForRate = wins + losses; // scratches not counted
  const winRate       = closedForRate > 0 ? Math.round((wins / closedForRate) * 100) : null;
  const needsReview   = trades.filter(t => t.needs_review).length;

  const todayLabel = new Date().toLocaleDateString('en-US', {
    weekday: 'long', month: 'long', day: 'numeric', timeZone: 'America/Chicago',
  });

  const handleLogged = (t: TradeRecord) => {
    setTrades(prev => [t, ...prev]);
  };

  if (loading) return <div className="loading">Loading…</div>;
  if (connected === false) return <div className="error-msg">Trade monitor not connected — start the app to record trades.</div>;
  if (error) return <div className="error-msg">Error loading trades: {error}</div>;

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

      {needsReview > 0 && (
        <div style={{
          background: '#92400e', border: '1px solid #f59e0b', borderRadius: 'var(--radius)',
          padding: '0.5rem 0.75rem', marginBottom: '0.75rem',
          fontSize: 12, color: '#fef3c7',
        }}>
          <strong>{needsReview} trade{needsReview > 1 ? 's' : ''} need review</strong> — direction was unknown when recorded. Check the REVIEW badge.
        </div>
      )}

      <LogTradeForm onLogged={handleLogged} />

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
