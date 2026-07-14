import React, { useState } from 'react';
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
  onDeleted?: (id: number) => void;
}

export function TradeCard({ trade, onUpdated, onDeleted }: TradeCardProps) {
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
  const [deleting, setDeleting] = useState(false);

  // Manual-close state (for open trades)
  const [closePrice, setClosePrice] = useState('');
  const [closePnl, setClosePnl] = useState('');
  const [closing, setClosing] = useState(false);
  const [closeError, setCloseError] = useState<string | null>(null);

  const steps: string[] = (() => {
    try { return trade.steps_json ? JSON.parse(trade.steps_json) : []; }
    catch { return []; }
  })();

  const patterns: string[] = (() => {
    try { return trade.patterns_json ? JSON.parse(trade.patterns_json) : []; }
    catch { return []; }
  })();

  const isOpen   = trade.exit_price == null && trade.exit_at == null;
  const isWin    = !isOpen && (trade.pnl_net ?? 0) > 0;
  const isLoss   = !isOpen && trade.pnl_net != null && trade.pnl_net < 0;
  const isScratch = !isOpen && trade.pnl_net != null && trade.pnl_net === 0;

  const pnlClass = isOpen ? 'open' : (trade.pnl_net ?? 0) >= 0 ? 'pos' : 'neg';
  const outcomeClass = isOpen ? 'open' : isWin ? 'win' : isLoss ? 'loss' : 'scratch';
  const outcomeSymbol = isOpen ? '—' : isWin ? 'W' : isLoss ? 'L' : isScratch ? '=' : '?';

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

  const handleDelete = async () => {
    if (!window.confirm('Delete this trade? This cannot be undone.')) return;
    setDeleting(true);
    try {
      await fetch(`/api/trades/${trade.id}`, { method: 'DELETE' });
      onDeleted?.(trade.id);
    } catch {
      setDeleting(false);
    }
  };

  const handleClose = async () => {
    const pnl = parseFloat(closePnl);
    if (isNaN(pnl)) { setCloseError('Enter a valid P&L number (e.g. -21.25)'); return; }
    const price = closePrice ? parseFloat(closePrice) : undefined;
    setClosing(true);
    setCloseError(null);
    try {
      const res = await fetch(`/api/trades/${trade.id}/close`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ exit_price: price ?? null, pnl_gross: pnl }),
      });
      if (!res.ok) {
        const e = await res.json().catch(() => ({}));
        throw new Error(e.error ?? `HTTP ${res.status}`);
      }
      const updated: TradeRecord = await res.json();
      onUpdated?.(updated);
    } catch (e: unknown) {
      setCloseError(e instanceof Error ? e.message : 'Close failed');
      setClosing(false);
    }
  };

  return (
    <div className="trade-card">
      {/* ── Summary row ─────────────────────────────────────── */}
      <div className="trade-card-summary" onClick={() => setExpanded(e => !e)}>
        {/* Needs-review flag */}
        {trade.needs_review && (
          <span
            title="Direction unknown or data incomplete — review this trade"
            style={{
              fontSize: 9, fontWeight: 700, padding: '1px 5px', borderRadius: 3,
              background: '#f59e0b', color: '#1e222d', flexShrink: 0,
            }}
          >
            REVIEW
          </span>
        )}

        {/* Direction badge */}
        <span className={`direction-badge ${trade.direction === 'unknown' ? 'unknown' : trade.direction}`}>
          {trade.direction === 'long' ? '▲ LONG' : trade.direction === 'short' ? '▼ SHORT' : '? UNKNOWN'}
        </span>

        {/* Source badge: A = auto-traded, M = manually placed */}
        <span
          title={trade.verdict === 'manual' ? 'Manually placed' : 'Auto-traded by Claude'}
          style={{
            fontSize: 9, fontWeight: 700, letterSpacing: '0.04em',
            padding: '1px 5px', borderRadius: 3,
            background: trade.verdict === 'manual' ? 'var(--text-secondary)' : 'var(--accent)',
            color: '#1e222d', flexShrink: 0,
          }}
        >
          {trade.verdict === 'manual' ? 'M' : 'A'}
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
              <span className="detail-label">P&L</span>
              <span className={`detail-value ${pnlClass}`}>{isOpen ? '—' : fmt$(trade.pnl_net)}</span>
            </div>
            {!isOpen && (
              <div className="detail-item">
                <span className="detail-label">R-Multiple</span>
                <span className="detail-value">{fmtR(trade.r_multiple)}</span>
              </div>
            )}
          </div>

          {/* Manual close form — only for open trades */}
          {isOpen && (
            <div>
              <div className="section-divider">MARK AS CLOSED</div>
              <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'flex-end', flexWrap: 'wrap', marginTop: '0.5rem' }}>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '3px' }}>
                  <span style={{ fontSize: 10, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Exit price</span>
                  <input
                    type="number"
                    step="0.25"
                    placeholder="0.00"
                    value={closePrice}
                    onChange={e => setClosePrice(e.target.value)}
                    style={{ width: 90, background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 'var(--radius)', color: 'var(--text-primary)', padding: '0.25rem 0.4rem', fontSize: 12, fontFamily: 'var(--font)' }}
                  />
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '3px' }}>
                  <span style={{ fontSize: 10, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>P&L (from TV)</span>
                  <input
                    type="number"
                    step="0.25"
                    placeholder="+12.50 or -12.50"
                    value={closePnl}
                    onChange={e => setClosePnl(e.target.value)}
                    style={{ width: 90, background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 'var(--radius)', color: 'var(--text-primary)', padding: '0.25rem 0.4rem', fontSize: 12, fontFamily: 'var(--font)' }}
                  />
                </div>
                <button
                  className="btn-critique"
                  onClick={handleClose}
                  disabled={closing || !closePnl}
                  style={{ alignSelf: 'flex-end' }}
                >
                  {closing ? <><span className="spinner" /> Saving…</> : 'Close Trade'}
                </button>
              </div>
              {closeError && (
                <p style={{ fontSize: 11, color: 'var(--bearish)', marginTop: '0.35rem' }}>{closeError}</p>
              )}
            </div>
          )}

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
                Confidence: <strong style={{ color: 'var(--text-primary)' }}>{((trade.confidence ?? 0) * 100).toFixed(0)}%</strong>
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

          {/* Delete */}
          <div style={{ borderTop: '1px solid var(--border)', paddingTop: '0.75rem', marginTop: '0.25rem' }}>
            <button
              className="btn-reset"
              onClick={handleDelete}
              disabled={deleting}
              style={{ fontSize: 11, padding: '0.25rem 0.6rem' }}
            >
              {deleting ? 'Deleting…' : 'Delete trade'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
