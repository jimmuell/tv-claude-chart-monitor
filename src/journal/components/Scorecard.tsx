import React, { useCallback, useEffect, useState } from 'react';
import { Scorecard as ScorecardData } from '../types';
import { BarChart } from './StatChart';
import { useAutoRefresh } from '../hooks/useAutoRefresh';

// Below this many graded calls the win rate is noise, so the page says so
// rather than inviting a decision it cannot support.
const MEANINGFUL_MIN = 100;

const pct = (n: number) => `${(n * 100).toFixed(1)}%`;
const r2  = (n: number | null) => (n == null ? '—' : `${n >= 0 ? '+' : ''}${n.toFixed(2)}R`);

/** Hour label 14:00 -> 2PM, matching the rest of the dashboard. */
function fmtHour(label: string): string {
  const h = parseInt(label.slice(0, 2), 10);
  if (Number.isNaN(h)) return label;
  const ampm = h >= 12 ? 'PM' : 'AM';
  const h12 = h === 0 ? 12 : h > 12 ? h - 12 : h;
  return `${h12}${ampm}`;
}

/**
 * Win rate of the app's own recommendations, graded from bar highs and lows.
 * Live calls by default; Bar Replay is a deliberate, separate toggle because
 * replay re-walks the same history and would flatter the live number.
 */
export function Scorecard() {
  const [mode, setMode] = useState<'live' | 'replay'>('live');
  const [data, setData] = useState<ScorecardData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const fetchCard = useCallback(() => {
    fetch(`/api/scorecard?mode=${mode}`)
      .then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
      .then((d: ScorecardData) => { setData(d); setError(null); })
      .catch(e => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false));
  }, [mode]);

  useEffect(() => { setLoading(true); fetchCard(); }, [fetchCard]);
  useAutoRefresh(fetchCard);

  const toggle = (
    <div className="scorecard-toggle" role="group" aria-label="Call source">
      {(['live', 'replay'] as const).map(m => (
        <button
          key={m}
          className={`scorecard-tab ${mode === m ? 'active' : ''}`}
          onClick={() => setMode(m)}
        >
          {m === 'live' ? 'Live calls' : 'Bar Replay'}
        </button>
      ))}
    </div>
  );

  const header = (
    <div className="scorecard-head">
      <div>
        <h3 className="scorecard-title">Recommendation scorecard</h3>
        <p className="scorecard-sub">
          Every call the app made, graded from bar highs and lows — not from P&amp;L,
          and not only the ones that were traded.
        </p>
      </div>
      {toggle}
    </div>
  );

  if (loading && !data) {
    return <section className="scorecard">{header}<p className="scorecard-empty">Loading…</p></section>;
  }
  if (error) {
    return <section className="scorecard">{header}<p className="scorecard-empty">Could not load: {error}</p></section>;
  }
  if (!data || data.total === 0) {
    return (
      <section className="scorecard">
        {header}
        <p className="scorecard-empty">
          No {mode === 'live' ? 'live' : 'replay'} calls saved yet. Rows appear at each bar close.
        </p>
      </section>
    );
  }

  const beatsBreakEven = data.breakEven != null && data.winRate >= data.breakEven;
  const winClass = data.graded === 0 ? '' : beatsBreakEven ? 'pos' : 'neg';

  const bucketChart = (rows: ScorecardData['bySetup'], relabel?: (s: string) => string) =>
    rows.map(b => ({
      label: `${relabel ? relabel(b.label) : b.label} (${b.graded})`,
      value: b.winRate * 100,
      maxValue: 100,
      color: data.breakEven != null && b.winRate >= data.breakEven
        ? 'var(--accent)' : 'var(--bearish)',
    }));

  return (
    <section className="scorecard">
      {header}

      {data.graded < MEANINGFUL_MIN && (
        <div className="scorecard-banner">
          Fewer than {MEANINGFUL_MIN} graded calls ({data.graded}) — not yet meaningful.
          Treat every number below as provisional.
        </div>
      )}
      {mode === 'replay' && (
        <div className="scorecard-banner replay">
          Bar Replay calls. Replay re-walks the same history, so these are rehearsal,
          not evidence. Never compare them with live results.
        </div>
      )}

      <div className="stat-chips">
        <div className="stat-chip">
          <div className="chip-label">Graded</div>
          <div className="chip-value">{data.graded}</div>
        </div>
        <div className="stat-chip">
          <div className="chip-label">Win Rate</div>
          <div className={`chip-value ${winClass}`}>
            {data.graded > 0 ? pct(data.winRate) : '—'}
          </div>
        </div>
        <div className="stat-chip">
          <div className="chip-label">Break-even</div>
          <div className="chip-value">{data.breakEven != null ? pct(data.breakEven) : '—'}</div>
        </div>
        <div className="stat-chip">
          <div className="chip-label">Avg Net R</div>
          <div className={`chip-value ${(data.avgNetR ?? 0) >= 0 ? 'pos' : 'neg'}`}>
            {r2(data.avgNetR)}
          </div>
        </div>
      </div>

      {data.breakEven != null && data.graded > 0 && (
        <p className="scorecard-note">
          {beatsBreakEven
            ? `Above the ${pct(data.breakEven)} needed to cover $1.24/round-trip fees at the median ${data.medianRr?.toFixed(2) ?? '—'}:1 plan.`
            : `Below the ${pct(data.breakEven)} needed to cover $1.24/round-trip fees at the median ${data.medianRr?.toFixed(2) ?? '—'}:1 plan — these calls lose money even when the win rate looks close to half.`}
        </p>
      )}

      {/* Counted, but deliberately outside the win rate. */}
      <div className="stat-chips scorecard-aside">
        <div className="stat-chip" style={{ flex: 1 }}>
          <div className="chip-label">Wins</div><div className="chip-value pos">{data.wins}</div>
        </div>
        <div className="stat-chip" style={{ flex: 1 }}>
          <div className="chip-label">Losses</div><div className="chip-value neg">{data.losses}</div>
        </div>
        <div className="stat-chip" style={{ flex: 1 }}>
          <div className="chip-label">Ambiguous</div><div className="chip-value">{data.ambiguous}</div>
        </div>
        <div className="stat-chip" style={{ flex: 1 }}>
          <div className="chip-label">Expired</div><div className="chip-value">{data.expired}</div>
        </div>
        <div className="stat-chip" style={{ flex: 1 }}>
          <div className="chip-label">Not triggered</div><div className="chip-value">{data.notTriggered}</div>
        </div>
        <div className="stat-chip" style={{ flex: 1 }}>
          <div className="chip-label">Pending</div><div className="chip-value">{data.pending}</div>
        </div>
      </div>
      <p className="scorecard-note">
        Ambiguous means one bar touched both the target and the stop; the order inside a
        bar is unknowable, so it is never scored as a win or a loss. Expired, not-triggered
        and pending calls are excluded from the win rate too. {data.total} calls saved in total.
      </p>

      {data.bySetup.length > 0 && (
        <div className="stat-section">
          <h4 className="section-title">Win rate by setup</h4>
          <BarChart data={bucketChart(data.bySetup)}
                    height={Math.max(120, data.bySetup.length * 28)}
                    formatValue={v => `${v.toFixed(0)}%`} />
        </div>
      )}

      {data.byDirection.length > 0 && (
        <div className="stat-section">
          <h4 className="section-title">Long vs short</h4>
          <BarChart data={bucketChart(data.byDirection)} height={90}
                    formatValue={v => `${v.toFixed(0)}%`} />
        </div>
      )}

      {data.byHour.length > 0 && (
        <div className="stat-section">
          <h4 className="section-title">Win rate by hour</h4>
          <BarChart data={bucketChart(data.byHour, fmtHour)}
                    height={Math.max(120, data.byHour.length * 26)}
                    formatValue={v => `${v.toFixed(0)}%`} />
        </div>
      )}
    </section>
  );
}
