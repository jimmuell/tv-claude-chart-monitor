import React, { useEffect, useState, useCallback } from 'react';

interface FilterConfig {
  zoneProximityTicks: number;
  perZoneCooldownSec: number;
  globalCooldownSec: number;
  minConfidence: number;
  fireOn: {
    notablePatterns: boolean;
    zoneInteractions: boolean;
    trendOrMaEvents: boolean;
    everyCandleIfActionable: boolean;
  };
}

export function Config() {
  const [config, setConfig] = useState<FilterConfig | null>(null);
  const [draft, setDraft] = useState<FilterConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [resetting, setResetting] = useState(false);

  useEffect(() => {
    fetch('/api/config')
      .then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
      .then(data => {
        const f: FilterConfig = {
          zoneProximityTicks: data.filter?.zoneProximityTicks ?? 4,
          perZoneCooldownSec: data.filter?.perZoneCooldownSec ?? 90,
          globalCooldownSec: data.filter?.globalCooldownSec ?? 20,
          minConfidence: data.filter?.minConfidence ?? 0,
          fireOn: {
            notablePatterns: data.filter?.fireOn?.notablePatterns ?? true,
            zoneInteractions: data.filter?.fireOn?.zoneInteractions ?? true,
            trendOrMaEvents: data.filter?.fireOn?.trendOrMaEvents ?? true,
            everyCandleIfActionable: data.filter?.fireOn?.everyCandleIfActionable ?? true,
          },
        };
        setConfig(f);
        setDraft(f);
      })
      .catch(e => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  const isDirty = draft && config && JSON.stringify(draft) !== JSON.stringify(config);

  const handleSave = async () => {
    if (!draft) return;
    setSaving(true);
    setError(null);
    try {
      const r = await fetch('/api/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filter: draft }),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      setConfig(draft);
      setSavedAt(Date.now());
      setTimeout(() => setSavedAt(null), 2000);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  const handleReset = useCallback(async () => {
    if (!window.confirm('Reset the trade journal? This deletes ALL trades and cannot be undone.')) return;
    setResetting(true);
    try {
      await fetch('/api/trades', { method: 'DELETE' });
      window.location.reload();
    } catch {
      setResetting(false);
    }
  }, []);

  const setFireOn = (key: keyof FilterConfig['fireOn'], value: boolean) => {
    setDraft(d => d ? { ...d, fireOn: { ...d.fireOn, [key]: value } } : d);
  };

  const setField = <K extends keyof Omit<FilterConfig, 'fireOn'>>(key: K, value: FilterConfig[K]) => {
    setDraft(d => d ? { ...d, [key]: value } : d);
  };

  if (loading) return <div className="loading">Loading...</div>;
  if (error && !draft) return <div className="error-msg">{error}</div>;
  if (!draft) return null;

  const confPct = Math.round(draft.minConfidence * 100);

  return (
    <div className="page">
      <div className="section-heading">SETUP FILTERS</div>

      {/* Fire Conditions */}
      <div className="chart-card" style={{ marginBottom: '1rem' }}>
        <div className="chart-title">Fire Conditions</div>
        {([
          ['notablePatterns', 'Notable Patterns'],
          ['zoneInteractions', 'Zone Interactions'],
          ['trendOrMaEvents', 'Trend / MA Events'],
          ['everyCandleIfActionable', 'Every Candle If Actionable'],
        ] as const).map(([key, label]) => (
          <div className="config-field" key={key}>
            <label htmlFor={`fire-${key}`}>{label}</label>
            <input
              id={`fire-${key}`}
              type="checkbox"
              checked={draft.fireOn[key]}
              onChange={e => setFireOn(key, e.target.checked)}
            />
          </div>
        ))}
      </div>

      {/* Cooldowns */}
      <div className="chart-card" style={{ marginBottom: '1rem' }}>
        <div className="chart-title">Cooldowns</div>
        <div className="config-field">
          <label>Zone Cooldown (sec)</label>
          <input type="number" min={0} step={5}
            value={draft.perZoneCooldownSec}
            onChange={e => setField('perZoneCooldownSec', Number(e.target.value))} />
        </div>
        <div className="config-field">
          <label>Global Cooldown (sec)</label>
          <input type="number" min={0} step={5}
            value={draft.globalCooldownSec}
            onChange={e => setField('globalCooldownSec', Number(e.target.value))} />
        </div>
      </div>

      {/* Zone Proximity */}
      <div className="chart-card" style={{ marginBottom: '1rem' }}>
        <div className="chart-title">Zone Proximity</div>
        <div className="config-field">
          <label>Proximity Threshold (ticks)</label>
          <input type="number" min={0} step={1}
            value={draft.zoneProximityTicks}
            onChange={e => setField('zoneProximityTicks', Number(e.target.value))} />
        </div>
      </div>

      {/* Confidence Gate */}
      <div className="chart-card" style={{ marginBottom: '1.5rem' }}>
        <div className="chart-title">Confidence Gate</div>
        <div className="config-field">
          <label>Min Confidence</label>
          <span style={{ fontSize: 12, color: confPct === 0 ? 'var(--text-secondary)' : 'var(--accent)', fontWeight: 600 }}>
            {confPct === 0 ? 'Disabled' : `>=${confPct}%`}
          </span>
        </div>
        <input type="range" min={0} max={100} step={5}
          style={{ width: '100%', accentColor: 'var(--accent)', marginTop: '0.5rem' }}
          value={confPct}
          onChange={e => setField('minConfidence', Number(e.target.value) / 100)} />
        <p style={{ fontSize: 11, color: 'var(--text-secondary)', marginTop: '0.35rem' }}>
          {confPct === 0 ? 'All trades fire regardless of confidence.' : `Only trade when Claude is >=${confPct}% confident.`}
        </p>
      </div>

      {/* Actions */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
        <button className="btn-critique" onClick={handleSave} disabled={saving || !isDirty}>
          {saving ? <><span className="spinner" /> Saving...</> : 'Save Changes'}
        </button>
        {isDirty && (
          <button
            style={{ background: 'none', border: 'none', color: 'var(--text-secondary)', fontSize: 12, cursor: 'pointer', fontFamily: 'var(--font)' }}
            onClick={() => setDraft(config)}
          >
            Discard
          </button>
        )}
        {savedAt && (
          <span style={{ fontSize: 12, color: 'var(--accent)' }}>Saved ✓</span>
        )}
      </div>
      {error && <div className="error-msg" style={{ marginTop: '0.75rem' }}>{error}</div>}
      <p style={{ fontSize: 11, color: 'var(--text-secondary)', marginTop: '0.75rem' }}>
        Changes take effect on next Electron analysis run.
      </p>

      {/* Danger zone */}
      <div style={{ marginTop: '2rem', paddingTop: '1.25rem', borderTop: '1px solid var(--border)' }}>
        <div className="section-heading" style={{ color: 'var(--bearish)' }}>DANGER ZONE</div>
        <div className="chart-card" style={{ marginTop: '0.75rem' }}>
          <div className="chart-title">Reset Trade Journal</div>
          <p style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: '0.75rem' }}>
            Deletes all trades. Use when resetting your paper trading account.
          </p>
          <button className="btn-reset" onClick={handleReset} disabled={resetting}>
            {resetting ? 'Resetting…' : 'Reset Journal'}
          </button>
        </div>
      </div>
    </div>
  );
}
