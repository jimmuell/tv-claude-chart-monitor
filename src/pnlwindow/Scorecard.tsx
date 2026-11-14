import React, { useEffect, useState, useCallback } from 'react';
import type { ScorecardView, ScorecardBucketView } from '../shared/types';
import { BarChart } from './StatChart';

// Below this many graded calls the win rate is noise, so the tab says so rather
// than inviting a decision it cannot support.
const MEANINGFUL_MIN = 100;

const pct = (n: number) => `${(n * 100).toFixed(1)}%`;
const r2  = (n: number | null) => (n == null ? '—' : `${n >= 0 ? '+' : ''}${n.toFixed(2)}R`);

/** Hour label 14:00 -> 2PM, which is how a trader reads a session. */
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
 *
 * Read-only: this tab never writes to the recommendations table.
 */
export const Scorecard: React.FC = () => {
  const [mode, setMode]         = useState<'live' | 'replay'>('live');
  const [rulesVer, setRulesVer] = useState<string>('');   // '' = all versions
  const [data, setData]         = useState<ScorecardView | null>(null);
  const [error, setError]       = useState<string | null>(null);
  const [loading, setLoading]   = useState(true);

  const load = useCallback(() => {
    setLoading(true);
    window.pnlApi.getScorecard(mode, rulesVer || null)
      .then(d => { setData(d); setError(d ? null : 'the recommendation store is not open'); })
      .catch(e => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false));
  }, [mode, rulesVer]);

  useEffect(() => { load(); }, [load]);

  // Default to the newest rules version once we know what exists, so the tab never
  // silently averages results produced under different rules.
  useEffect(() => {
    if (!rulesVer && data && data.versions.length > 0) setRulesVer(data.versions[0].rules_version);
  }, [data, rulesVer]);

  const header = (
    <div className="sc-head">
      <div>
        <h3 className="sc-title">Recommendation scorecard</h3>
        <p className="sc-sub">
          Every call the app made, graded from bar highs and lows — not from P&amp;L, and
          not only the ones that were traded.
        </p>
      </div>
      <div className="sc-controls">
        <div className="sc-toggle" role="group" aria-label="Call source">
          {(['live', 'replay'] as const).map(m => (
            <button key={m} className={`sc-tab${mode === m ? ' active' : ''}`} onClick={() => setMode(m)}>
              {m === 'live' ? 'Live calls' : 'Bar Replay'}
            </button>
          ))}
        </div>
        {data && data.versions.length > 0 && (
          <select
            className="sc-select"
            value={rulesVer}
            onChange={e => setRulesVer(e.target.value)}
            title="Results from different rules are never averaged together"
          >
            <option value="">All rules versions</option>
            {data.versions.map(v => (
              <option key={v.rules_version} value={v.rules_version}>
                rules {v.rules_version} ({v.n})
              </option>
            ))}
          </select>
        )}
      </div>
    </div>
  );

  if (loading && !data) return <section className="sc">{header}<p className="sc-empty">Loading…</p></section>;
  if (error)            return <section className="sc">{header}<p className="sc-empty">Could not load: {error}</p></section>;
  if (!data || data.total === 0) {
    return (
      <section className="sc">{header}
        <p className="sc-empty">
          No {mode === 'live' ? 'live' : 'replay'} calls saved yet. Rows appear at each bar close.
        </p>
      </section>
    );
  }

  const beatsBreakEven = data.breakEven != null && data.winRate >= data.breakEven;
  const winClass = data.graded === 0 ? '' : beatsBreakEven ? 'gain' : 'loss';

  /** Turns a breakdown into bars, coloured by whether each bucket clears break-even. */
  const bucketChart = (rows: ScorecardBucketView[], relabel?: (s: string) => string) =>
    rows.map(b => ({
      label: `${relabel ? relabel(b.label) : b.label} (${b.graded})`,
      value: b.winRate * 100,
      maxValue: 100,
      color: data.breakEven != null && b.winRate >= data.breakEven ? 'var(--accent)' : 'var(--bearish)',
    }));

  return (
    <section className="sc">
      {header}

      {data.graded < MEANINGFUL_MIN && (
        <div className="sc-banner">
          Fewer than {MEANINGFUL_MIN} graded calls ({data.graded}) — not yet meaningful.
          Treat every number below as provisional.
        </div>
      )}
      {mode === 'replay' && (
        <div className="sc-banner replay">
          Bar Replay calls. Replay re-walks the same history, so these are rehearsal, not
          evidence. Never compare them with live results.
        </div>
      )}

      <div className="chips">
        <div className="chip"><div className="chip-label">Graded</div><div className="chip-value">{data.graded}</div></div>
        <div className="chip"><div className="chip-label">Win rate</div>
          <div className={`chip-value ${winClass}`}>{data.graded > 0 ? pct(data.winRate) : '—'}</div></div>
        <div className="chip"><div className="chip-label">Break-even</div>
          <div className="chip-value">{data.breakEven != null ? pct(data.breakEven) : '—'}</div></div>
        <div className="chip"><div className="chip-label">Avg net R</div>
          <div className={`chip-value ${(data.avgNetR ?? 0) >= 0 ? 'gain' : 'loss'}`}>{r2(data.avgNetR)}</div></div>
      </div>

      {data.breakEven != null && data.graded > 0 && (
        <p className="sc-note">
          {beatsBreakEven
            ? `Above the ${pct(data.breakEven)} needed to cover fees at the median ${data.medianRr?.toFixed(2) ?? '—'}:1 plan.`
            : `Below the ${pct(data.breakEven)} needed to cover fees at the median ${data.medianRr?.toFixed(2) ?? '—'}:1 plan — these calls lose money even when the win rate looks close to half.`}
        </p>
      )}

      {data.blocked && data.blocked.total > 0 && (
        <div className="sc-compare">
          <div className="cmp">
            <div className="cmp-title">Allowed by the rules</div>
            <div className="cmp-rate">{data.graded > 0 ? pct(data.winRate) : '—'}</div>
            <div className="cmp-sub">{data.wins}W / {data.losses}L · {r2(data.avgNetR)} avg</div>
          </div>
          <div className="cmp blocked">
            <div className="cmp-title">Blocked by the rules</div>
            <div className="cmp-rate">{data.blocked.graded > 0 ? pct(data.blocked.winRate) : '—'}</div>
            <div className="cmp-sub">
              {data.blocked.wins}W / {data.blocked.losses}L · {r2(data.blocked.avgNetR)} avg · {data.blocked.total} saved
            </div>
          </div>
        </div>
      )}
      {data.blocked && data.blocked.graded > 0 && data.blocked.winRate > data.winRate && (
        <div className="sc-banner">
          Blocked calls are winning more often than allowed ones ({pct(data.blocked.winRate)} vs{' '}
          {pct(data.winRate)}). The rules may be costing more than they save — check which rule
          is firing before trusting it.
        </div>
      )}

      {/* Counted, but deliberately outside the win rate. */}
      <div className="chips aside">
        <div className="chip"><div className="chip-label">Wins</div><div className="chip-value gain">{data.wins}</div></div>
        <div className="chip"><div className="chip-label">Losses</div><div className="chip-value loss">{data.losses}</div></div>
        <div className="chip"><div className="chip-label">Ambiguous</div><div className="chip-value">{data.ambiguous}</div></div>
        <div className="chip"><div className="chip-label">Expired</div><div className="chip-value">{data.expired}</div></div>
        <div className="chip"><div className="chip-label">Not triggered</div><div className="chip-value">{data.notTriggered}</div></div>
        <div className="chip"><div className="chip-label">Pending</div><div className="chip-value">{data.pending}</div></div>
      </div>
      <p className="sc-note">
        Ambiguous means one bar touched both the target and the stop; the order inside a bar is
        unknowable, so it is never scored as a win or a loss. Expired, not-triggered and pending
        calls are excluded from the win rate too. {data.total} calls saved in total.
      </p>

      {data.bySetup.length > 0 && (
        <div className="sc-section">
          <h4 className="sc-section-title">Win rate by setup</h4>
          <BarChart data={bucketChart(data.bySetup)} height={Math.max(120, data.bySetup.length * 28)}
                    formatValue={v => `${v.toFixed(0)}%`} />
        </div>
      )}
      {data.byDirection.length > 0 && (
        <div className="sc-section">
          <h4 className="sc-section-title">Long vs short</h4>
          <BarChart data={bucketChart(data.byDirection)} height={90} formatValue={v => `${v.toFixed(0)}%`} />
        </div>
      )}
      {data.byHour.length > 0 && (
        <div className="sc-section">
          <h4 className="sc-section-title">Win rate by hour</h4>
          <BarChart data={bucketChart(data.byHour, fmtHour)} height={Math.max(120, data.byHour.length * 26)}
                    formatValue={v => `${v.toFixed(0)}%`} />
        </div>
      )}
    </section>
  );
};
