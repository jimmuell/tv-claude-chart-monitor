import React, { useState, useRef } from 'react';
import { TradeRecord } from '../types';

// ─── Formatting helpers ────────────────────────────────────────────────────

const fmt$ = (n: number | null) =>
  n == null ? '—' : `${n >= 0 ? '+' : '-'}$${Math.abs(n).toFixed(2)}`;

const fmtR = (r: number | null) =>
  r == null ? '—' : `${r >= 0 ? '+' : ''}${r.toFixed(2)}R`;

const fmtPrice = (p: number | null) =>
  p == null ? '—' : p.toFixed(2);

const fmtTime = (ms: number) =>
  new Date(ms).toLocaleTimeString('en-US', {
    hour: 'numeric', minute: '2-digit', hour12: true, timeZone: 'America/Chicago',
  });

// ─── TradeCard ─────────────────────────────────────────────────────────────

interface TradeCardProps {
  trade: TradeRecord;
  onUpdated?: (updated: TradeRecord) => void;
}

export function TradeCard({ trade, onUpdated }: TradeCardProps) {
  const [expanded, setExpanded] = useState(false);
  const [notes, setNotes] = useState(trade.notes ?? '');
  const [tags, setTags] = useState<string[]>(() => {
    try { return trade.tags_json ? JSON.parse(trade.tags_json) : []; }
    catch { return []; }
  });
  const [tagInput, setTagInput] = useState('');
  const [critiqueLoading, setCritiqueLoading] = useState(false);
  const [critiqueData, setCritiqueData] = useState<{ text: string; created_at: number } | null>(() => {
    try { return trade.critique_json ? JSON.parse(trade.critique_json) : null; }
    catch { return null; }
  });
  const [saveStatus, setSaveStatus] = useState<'idle' | 'saving' | 'saved'>('idle');

  const steps: string[] = (() => {
    try { return trade.steps_json ? JSON.parse(trade.steps_json) : []; }
    catch { return []; }
  })();

  const patterns: string[] = (() => {
    try { return trade.patterns_json ? JSON.parse(trade.patterns_json) : []; }
    catch { return []; }
  })();

  const isOpen = trade.exit_price == null;
  const isWin = !isOpen && trade.r_multiple != null && trade.r_multiple > 0;
  const isLoss = !isOpen && trade.r_multiple != null && trade.r_multiple <= 0;

  const pnlClass = isOpen ? 'open' : (trade.pnl_net ?? 0) >= 0 ? 'pos' : 'neg';
  const outcomeClass = isOpen ? 'open' : isWin ? 'win' : 'loss';
  const outcomeSymbol = isOpen ? '○' : isWin ? '✓' : '✗';

  const handleNotesBlur = async () => {
    setSaveStatus('saving');
    try {
      await fetch(`/api/trades/${trade.id}/notes`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ notes, tags }),
      });
      setSaveStatus('saved');
      setTimeout(() => setSaveStatus('idle'), 1500);
    } catch {
      setSaveStatus('idle');
    }
  };

  const handleAddTag = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if ((e.key === 'Enter' || e.key === ',') && tagInput.trim()) {
      e.preventDefault();
      const newTags = [...tags, tagInput.trim()];
      setTags(newTags);
      setTagInput('');
      // Save immediately
      fetch(`/api/trades/${trade.id}/notes`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ notes, tags: newTags }),
      }).catch(() => {});
    }
  };

  const handleRemoveTag = (idx: number) => {
    const newTags = tags.filter((_, i) => i !== idx);
    setTags(newTags);
    fetch(`/api/trades/${trade.id}/notes`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ notes, tags: newTags }),
    }).catch(() => {});
  };

  const handleCritique = async () => {
    setCritiqueLoading(true);
    try {
      const res = await fetch(`/api/trades/${trade.id}/critique`, { method: 'POST' });
      const data = await res.json();
      if (data.critique_json) {
        const parsed = JSON.parse(data.critique_json);
        setCritiqueData(parsed);
      } else if (data.text) {
        setCritiqueData(data);
      }
    } catch {
      // ignore
    } finally {
      setCritiqueLoading(false);
    }
  };

  return (
    <div className="trade-card">
      {/* ── Summary row ─────────────────────────────────────── */}
      <div className="trade-card-summary" onClick={() => setExpanded(e => !e)}>
        {/* Direction badge */}
        <span className={`direction-badge ${trade.direction}`}>
          {trade.direction === 'long' ? '▲ LONG' : '▼ SHORT'}
        </span>

        {/* Symbol + time */}
        <div className="trade-card-main">
          <div className="trade-symbol-line">
            <span>{trade.symbol}</span>
            <span className="at-price">@ {fmtPrice(trade.entry_price)}</span>
            <span className="timeframe">{trade.timeframe}</span>
          </div>
          <div className="trade-time">{fmtTime(trade.created_at)}</div>
          {trade.headline && (
            <div className="trade-headline">{trade.headline}</div>
          )}
        </div>

        {/* P&L */}
        <div className={`trade-pnl ${pnlClass}`}>
          {isOpen ? 'Open' : fmt$(trade.pnl_net)}
        </div>

        {/* R multiple */}
        <div className="trade-r">
          {isOpen ? '—' : fmtR(trade.r_multiple)}
        </div>

        {/* Outcome */}
        <span className={`trade-outcome ${outcomeClass}`}>{outcomeSymbol}</span>

        {/* Expand toggle */}
        <button className="expand-btn" onClick={e => { e.stopPropagation(); setExpanded(v => !v); }}>
          {expanded ? '▲' : '▼'}
        </button>
      </div>

      {/* ── Detail panel ─────────────────────────────────────── */}
      {expanded && (
        <div className="trade-card-detail">
          {/* Entry / exit row */}
          <div className="detail-row">
            <div className="detail-item">
              <span className="detail-label">Entry</span>
              <span className="detail-value">{fmtPrice(trade.entry_price)}</span>
            </div>
            <div className="detail-item">
              <span className="detail-label">Stop</span>
              <span className="detail-value">{fmtPrice(trade.stop_price)}</span>
            </div>
            <div className="detail-item">
              <span className="detail-label">Target</span>
              <span className="detail-value">{fmtPrice(trade.target_price)}</span>
            </div>
            {trade.rr_planned != null && (
              <div className="detail-item">
                <span className="detail-label">Planned R:R</span>
                <span className="detail-value">1:{trade.rr_planned.toFixed(1)}</span>
              </div>
            )}
          </div>

          <div className="detail-row">
            <div className="detail-item">
              <span className="detail-label">Exit</span>
              <span className="detail-value">{isOpen ? 'Open' : fmtPrice(trade.exit_price)}</span>
            </div>
            <div className="detail-item">
              <span className="detail-label">P&L (net)</span>
              <span className={`detail-value ${pnlClass}`}>{isOpen ? '—' : fmt$(trade.pnl_net)}</span>
            </div>
            {!isOpen && (
              <div className="detail-item">
                <span className="detail-label">R-Multiple</span>
                <span className="detail-value">{fmtR(trade.r_multiple)}</span>
              </div>
            )}
          </div>

          {/* What Claude saw */}
          <div>
            <div className="section-divider">WHAT CLAUDE SAW</div>
            {trade.headline && (
              <p style={{ fontSize: 13, fontWeight: 600, marginTop: '0.5rem', marginBottom: '0.3rem' }}>
                {trade.headline}
              </p>
            )}
            {trade.objective && (
              <p style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: '0.4rem' }}>
                {trade.objective}
              </p>
            )}
            {steps.length > 0 && (
              <div style={{ marginTop: '0.35rem', marginBottom: '0.35rem' }}>
                <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginBottom: '0.2rem' }}>Steps:</div>
                <ul style={{ paddingLeft: '1.2rem', fontSize: 12, color: 'var(--text-secondary)', display: 'flex', flexDirection: 'column', gap: '0.15rem' }}>
                  {steps.map((s, i) => <li key={i}>{s}</li>)}
                </ul>
              </div>
            )}
            {trade.structure && (
              <p style={{ fontSize: 12, marginTop: '0.35rem' }}>
                <span style={{ color: 'var(--text-secondary)' }}>Market structure: </span>{trade.structure}
              </p>
            )}
            {trade.rationale && (
              <p style={{ fontSize: 12, marginTop: '0.35rem' }}>
                <span style={{ color: 'var(--text-secondary)' }}>Rationale: </span>{trade.rationale}
              </p>
            )}
            {patterns.length > 0 && (
              <div className="patterns-row">
                {patterns.map((p, i) => (
                  <span key={i} className="pattern-badge">{p}</span>
                ))}
              </div>
            )}
            {trade.confidence != null && (
              <p style={{ fontSize: 12, marginTop: '0.35rem', color: 'var(--text-secondary)' }}>
                Confidence: <strong style={{ color: 'var(--text-primary)' }}>{trade.confidence}%</strong>
              </p>
            )}
          </div>

          {/* Notes */}
          <div>
            <div className="section-divider">YOUR NOTES</div>
            <textarea
              className="notes-textarea"
              value={notes}
              onChange={e => setNotes(e.target.value)}
              onBlur={handleNotesBlur}
              placeholder="Add notes…"
            />
            {saveStatus === 'saving' && (
              <span style={{ fontSize: 11, color: 'var(--text-secondary)', marginLeft: 4 }}>saving…</span>
            )}
            {saveStatus === 'saved' && (
              <span style={{ fontSize: 11, color: 'var(--accent)', marginLeft: 4 }}>saved</span>
            )}
            <div className="tags-row">
              {tags.map((tag, i) => (
                <span
                  key={i}
                  className="tag-chip"
                  title="Click to remove"
                  style={{ cursor: 'pointer' }}
                  onClick={() => handleRemoveTag(i)}
                >
                  {tag} ×
                </span>
              ))}
              <input
                className="tag-input"
                placeholder="+ tag"
                value={tagInput}
                onChange={e => setTagInput(e.target.value)}
                onKeyDown={handleAddTag}
              />
            </div>
          </div>

          {/* Critique */}
          <div>
            <div className="section-divider">CLAUDE'S CRITIQUE</div>
            {critiqueData ? (
              <>
                <p className="critique-text">{critiqueData.text}</p>
                <button
                  className="btn-critique"
                  onClick={handleCritique}
                  disabled={critiqueLoading}
                  style={{ marginTop: '0.5rem' }}
                >
                  {critiqueLoading ? <><span className="spinner" /> Refreshing…</> : '↺ Refresh critique'}
                </button>
              </>
            ) : (
              <button
                className="btn-critique"
                onClick={handleCritique}
                disabled={critiqueLoading}
              >
                {critiqueLoading ? <><span className="spinner" /> Asking Claude…</> : '🤖 Ask Claude'}
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
