import React, { useEffect, useMemo, useState } from 'react';
import { TradeRecord } from '../types';
import { TradeCard } from '../components/TradeCard';

const fmtDate = (ms: number) =>
  new Date(ms).toLocaleDateString('en-US', {
    weekday: 'short', month: 'short', day: 'numeric', timeZone: 'America/Chicago',
  });

const dateKey = (ms: number) =>
  new Date(ms).toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });

type OutcomeFilter = 'all' | 'win' | 'loss' | 'open';
type SourceFilter  = 'all' | 'auto' | 'manual';

export function TradeList() {
  const [trades, setTrades] = useState<TradeRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [connected, setConnected] = useState<boolean | null>(null);

  const [dateFilter, setDateFilter] = useState('');
  const [dirFilter, setDirFilter] = useState<'all' | 'long' | 'short'>('all');
  const [outcomeFilter, setOutcomeFilter] = useState<OutcomeFilter>('all');
  const [sourceFilter, setSourceFilter] = useState<SourceFilter>('all');

  useEffect(() => {
    fetch('/api/trades')
      .then(r => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((data: TradeRecord[]) => {
        setConnected(true);
        data.sort((a, b) => b.created_at - a.created_at);
        setTrades(data);
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
  }, []);

  const filtered = useMemo(() => {
    return trades.filter(t => {
      if (dateFilter) {
        const dk = dateKey(t.created_at);
        if (dk !== dateFilter) return false;
      }
      if (dirFilter !== 'all' && t.direction !== dirFilter) return false;
      if (outcomeFilter === 'win' && !(t.r_multiple != null && t.r_multiple > 0)) return false;
      if (outcomeFilter === 'loss' && !(t.r_multiple != null && t.r_multiple <= 0)) return false;
      if (outcomeFilter === 'open' && t.exit_at != null) return false;
      if (sourceFilter === 'auto' && t.verdict === 'manual') return false;
      if (sourceFilter === 'manual' && t.verdict !== 'manual') return false;
      return true;
    });
  }, [trades, dateFilter, dirFilter, outcomeFilter, sourceFilter]);

  // Group by date
  const groups = useMemo(() => {
    const map = new Map<string, TradeRecord[]>();
    for (const t of filtered) {
      const k = dateKey(t.created_at);
      if (!map.has(k)) map.set(k, []);
      map.get(k)!.push(t);
    }
    return Array.from(map.entries()).sort((a, b) => (a[0] < b[0] ? 1 : -1));
  }, [filtered]);

  const clearFilters = () => {
    setDateFilter('');
    setDirFilter('all');
    setOutcomeFilter('all');
    setSourceFilter('all');
  };

  if (loading) return <div className="loading">Loading…</div>;
  if (connected === false) return <div className="error-msg">Trade monitor not connected — start the app to record trades.</div>;
  if (error) return <div className="error-msg">Error loading trades: {error}</div>;

  return (
    <div className="page">
      <div className="filter-bar">
        <input
          type="date"
          value={dateFilter}
          onChange={e => setDateFilter(e.target.value)}
          title="Filter by date"
        />
        <select
          value={dirFilter}
          onChange={e => setDirFilter(e.target.value as 'all' | 'long' | 'short')}
        >
          <option value="all">All directions</option>
          <option value="long">Long only</option>
          <option value="short">Short only</option>
        </select>
        <div className="radio-group">
          {(['all', 'win', 'loss', 'open'] as OutcomeFilter[]).map(v => (
            <label key={v}>
              <input
                type="radio"
                name="outcome"
                value={v}
                checked={outcomeFilter === v}
                onChange={() => setOutcomeFilter(v)}
              />
              {v.charAt(0).toUpperCase() + v.slice(1)}
            </label>
          ))}
        </div>
        <div className="radio-group">
          {(['all', 'auto', 'manual'] as SourceFilter[]).map(v => (
            <label key={v}>
              <input
                type="radio"
                name="source"
                value={v}
                checked={sourceFilter === v}
                onChange={() => setSourceFilter(v)}
              />
              {v === 'all' ? 'All' : v === 'auto' ? 'A — Auto' : 'M — Manual'}
            </label>
          ))}
        </div>
        {(dateFilter || dirFilter !== 'all' || outcomeFilter !== 'all' || sourceFilter !== 'all') && (
          <button className="btn-clear" onClick={clearFilters}>Clear</button>
        )}
      </div>

      {filtered.length === 0 ? (
        <div className="empty-state">
          {trades.length === 0 ? 'No trades recorded yet.' : 'No trades match the current filters.'}
        </div>
      ) : (
        groups.map(([key, group]) => (
          <div key={key}>
            <div className="date-group-header">
              {fmtDate(group[0].created_at)} &mdash; {group.length} trade{group.length !== 1 ? 's' : ''}
            </div>
            {group.map(t => (
              <TradeCard
                key={t.id}
                trade={t}
                onDeleted={id => setTrades(prev => prev.filter(p => p.id !== id))}
                onUpdated={updated => setTrades(prev => prev.map(p => p.id === updated.id ? updated : p))}
              />
            ))}
          </div>
        ))
      )}
    </div>
  );
}
