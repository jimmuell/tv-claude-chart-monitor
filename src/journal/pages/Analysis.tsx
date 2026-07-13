import React, { useState } from 'react';

interface ReviewResult {
  summary: string;
  patternRecommendations: Array<{ pattern: string; recommendation: 'keep' | 'avoid' | 'reduce'; reason: string }>;
  configRecommendations: Array<{ field: string; currentValue: number | boolean; suggestedValue: number | boolean; reason: string }>;
  overallVerdict: 'profitable' | 'marginal' | 'losing';
  generated_at: number;
}

export function Analysis() {
  const [status, setStatus] = useState<'idle' | 'loading' | 'done' | 'error'>('idle');
  const [review, setReview] = useState<ReviewResult | null>(null);
  const [tradeCount, setTradeCount] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const runReview = async () => {
    setStatus('loading');
    setReview(null);
    try {
      const r = await fetch('/api/review', { method: 'POST' });
      if (r.status === 422) {
        const body = await r.json();
        setStatus('error');
        setError(`Need at least ${body.minRequired ?? 5} closed trades to generate a review.`);
        return;
      }
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data: ReviewResult = await r.json();
      setReview(data);
      setStatus('done');
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Unknown error');
      setStatus('error');
    }
  };

  return (
    <div className="page">
      <div className="section-heading">PERFORMANCE REVIEW</div>

      <div style={{ marginBottom: '1rem' }}>
        <button className="btn-critique" onClick={runReview} disabled={status === 'loading'}>
          {status === 'loading' ? <><span className="spinner" /> Analyzing…</> : 'Run Review'}
        </button>
        {status === 'loading' && (
          <p style={{ fontSize: 11, color: 'var(--text-secondary)', marginTop: '0.5rem' }}>
            Analyzing your trades — this takes ~10s…
          </p>
        )}
      </div>

      {status === 'error' && error && <div className="error-msg">{error}</div>}

      {status === 'done' && review && (
        <>
          {/* Overall Verdict */}
          <div style={{ marginBottom: '1rem' }}>
            <span style={{ fontSize: 11, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
              Overall Verdict:{' '}
            </span>
            <span style={{
              fontWeight: 700,
              color: review.overallVerdict === 'profitable' ? 'var(--accent)' : review.overallVerdict === 'losing' ? 'var(--bearish)' : 'var(--text-secondary)',
            }}>
              {review.overallVerdict.toUpperCase()}
            </span>
          </div>

          {/* Summary */}
          <div className="chart-card" style={{ marginBottom: '1rem' }}>
            <div className="chart-title">Summary</div>
            <p style={{ fontSize: 12, color: 'var(--text-primary)', lineHeight: 1.6, whiteSpace: 'pre-wrap' }}>
              {review.summary}
            </p>
          </div>

          {/* Config Recommendations */}
          {review.configRecommendations.length > 0 && (
            <div className="chart-card" style={{ marginBottom: '1rem' }}>
              <div className="chart-title">Config Recommendations</div>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                <thead>
                  <tr style={{ color: 'var(--text-secondary)', textAlign: 'left' }}>
                    <th style={{ paddingBottom: '0.5rem', fontWeight: 600 }}>Field</th>
                    <th style={{ paddingBottom: '0.5rem', fontWeight: 600 }}>Current → Suggested</th>
                    <th style={{ paddingBottom: '0.5rem', fontWeight: 600 }}>Reason</th>
                  </tr>
                </thead>
                <tbody>
                  {review.configRecommendations.map((rec, i) => (
                    <tr key={i} style={{ borderTop: '1px solid var(--border)' }}>
                      <td style={{ padding: '0.4rem 0.5rem 0.4rem 0', color: 'var(--text-primary)', fontFamily: 'monospace', fontSize: 11 }}>{rec.field}</td>
                      <td style={{ padding: '0.4rem 0.5rem', whiteSpace: 'nowrap' }}>
                        <span style={{ color: 'var(--bearish)' }}>{String(rec.currentValue)}</span>
                        {' → '}
                        <span style={{ color: 'var(--accent)' }}>{String(rec.suggestedValue)}</span>
                      </td>
                      <td style={{ padding: '0.4rem 0', color: 'var(--text-secondary)' }}>{rec.reason}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {/* Pattern Recommendations */}
          {review.patternRecommendations.length > 0 && (
            <div className="chart-card" style={{ marginBottom: '1rem' }}>
              <div className="chart-title">Pattern Recommendations</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                {review.patternRecommendations.map((rec, i) => (
                  <div key={i} style={{ display: 'flex', alignItems: 'flex-start', gap: '0.5rem' }}>
                    <span className="pattern-badge" style={{
                      color: rec.recommendation === 'keep' ? 'var(--accent)' : rec.recommendation === 'avoid' ? 'var(--bearish)' : 'var(--text-secondary)',
                      borderColor: rec.recommendation === 'keep' ? 'rgba(38,166,154,0.3)' : rec.recommendation === 'avoid' ? 'rgba(239,83,80,0.3)' : 'var(--border)',
                      background: rec.recommendation === 'keep' ? 'rgba(38,166,154,0.15)' : rec.recommendation === 'avoid' ? 'rgba(239,83,80,0.15)' : 'var(--surface2)',
                      flexShrink: 0,
                    }}>
                      {rec.pattern}
                    </span>
                    <span style={{ fontSize: 11, color: 'var(--text-secondary)', lineHeight: 1.5 }}>
                      <strong style={{ color: rec.recommendation === 'keep' ? 'var(--accent)' : rec.recommendation === 'avoid' ? 'var(--bearish)' : 'var(--text-secondary)' }}>
                        {rec.recommendation.toUpperCase()}
                      </strong>
                      {' — '}{rec.reason}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}

          <p style={{ fontSize: 10, color: 'var(--text-secondary)', marginTop: '0.5rem' }}>
            Generated {new Date(review.generated_at).toLocaleString()}
          </p>
        </>
      )}
    </div>
  );
}
