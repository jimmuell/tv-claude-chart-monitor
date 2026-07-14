import React, { useState, useEffect } from 'react';
import type { AppSettings, KeyStatus, TradeSession } from '../shared/types';

const SettingsPanel: React.FC = () => {
  const [settings, setSettings]       = useState<AppSettings | null>(null);
  const [keyStatus, setKeyStatus]     = useState<KeyStatus>('missing');
  const [appVersion, setAppVersion]   = useState('');
  const [reconnecting, setReconnecting] = useState(false);
  const [saveError, setSaveError]     = useState<string | null>(null);

  useEffect(() => {
    window.api.getSettings().then(setSettings).catch(() => {});
    window.api.getKeyStatus().then(setKeyStatus).catch(() => {});
    window.api.getAppVersion().then(setAppVersion).catch(() => {});
  }, []);

  const update = async (partial: Partial<AppSettings>) => {
    if (!settings) return;
    try {
      const updated = await window.api.updateSettings(partial);
      setSettings(updated);
      if ('apiKeyOverride' in partial) {
        window.api.getKeyStatus().then(setKeyStatus).catch(() => {});
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Save failed';
      setSaveError(msg);
      setTimeout(() => setSaveError(null), 3000);
    }
  };

  const handleReconnect = async () => {
    setReconnecting(true);
    try { await window.api.reconnectBridge(); } catch { /* ignore */ }
    setReconnecting(false);
  };

  if (!settings) {
    return (
      <div className="settings-panel">
        <p className="placeholder-text" style={{ padding: '24px' }}>Loading…</p>
      </div>
    );
  }

  return (
    <div className="settings-panel">

      {/* Connection */}
      <div className="settings-section">
        <div className="settings-section-title">Connection</div>
        <div className="settings-row">
          <span className="settings-label">CDP Port</span>
          <input
            type="number"
            className="settings-input settings-input-sm"
            value={settings.cdpPort}
            min={1024}
            max={65535}
            onChange={e => {
              const v = parseInt(e.target.value);
              if (!isNaN(v) && v >= 1024 && v <= 65535) update({ cdpPort: v });
            }}
          />
        </div>
        <div className="settings-row">
          <span className="settings-label">Reconnect</span>
          <button
            className="settings-btn"
            onClick={handleReconnect}
            disabled={reconnecting}
          >
            {reconnecting ? 'Connecting…' : 'Reconnect'}
          </button>
        </div>
      </div>

      {/* Analysis */}
      <div className="settings-section">
        <div className="settings-section-title">Analysis</div>
        <div className="settings-row">
          <span className="settings-label">Auto Refresh</span>
          <SettingsToggle
            checked={settings.autoRefresh}
            onChange={v => update({ autoRefresh: v })}
          />
        </div>
        <div className="settings-row">
          <span className="settings-label">Auto Draw Levels</span>
          <SettingsToggle
            checked={settings.autoDraw}
            onChange={v => update({ autoDraw: v })}
          />
        </div>
        <div className="settings-row">
          <span className="settings-label">Persist Levels</span>
          <SettingsToggle
            checked={settings.persistLevels}
            onChange={v => update({ persistLevels: v })}
          />
        </div>
        <div className="settings-row">
          <span className="settings-label">Notifications</span>
          <SettingsToggle
            checked={settings.notifications}
            onChange={v => update({ notifications: v })}
          />
        </div>
        <div className="settings-row">
          <span className="settings-label">
            Auto Trade
            {settings.autoTrade && (
              <span style={{ color: 'var(--bearish)', marginLeft: 6, fontSize: '0.75em', fontWeight: 700 }}>
                LIVE
              </span>
            )}
          </span>
          <SettingsToggle
            checked={settings.autoTrade}
            onChange={v => update({ autoTrade: v })}
          />
        </div>
        {settings.autoTrade && (
          <>
            <div className="settings-row">
              <span className="settings-label">Test Buttons</span>
              <SettingsToggle
                checked={settings.autoTradeTestMode}
                onChange={v => update({ autoTradeTestMode: v })}
              />
            </div>
            <div className="settings-row">
              <span className="settings-label">
                Trailing Stop
                <span style={{ marginLeft: 6, fontSize: '0.7em', color: 'var(--text-secondary)', fontWeight: 400 }}>soon</span>
              </span>
              <SettingsToggle
                checked={false}
                onChange={() => {}}
                disabled
              />
            </div>
            {([
              ['number', 'Morning 8:45–11:30'],
              ['full',   'Full 8:45–3:00 PM'],
              ['all',    '24 h — all sessions'],
            ] as [TradeSession, string][]).map(([s, label]) => (
              <div className="settings-row" key={s}>
                <span className="settings-label">{label}</span>
                <label className="settings-toggle-wrap">
                  <input
                    type="checkbox"
                    checked={(settings.tradeSession ?? 'number') === s}
                    onChange={() => update({ tradeSession: s })}
                  />
                  <span className="switch-track" />
                </label>
              </div>
            ))}
            <div className="settings-row">
              <span className="settings-label">Stop Loss $</span>
              <input
                type="number"
                className="settings-input settings-input-sm"
                value={settings.autoTradeStopDollars}
                step={1.25}
                min={1.25}
                onChange={e => { const v = parseFloat(e.target.value); if (!isNaN(v) && v > 0) update({ autoTradeStopDollars: v }); }}
              />
            </div>
            <div className="settings-row">
              <span className="settings-label">Take Profit $</span>
              <input
                type="number"
                className="settings-input settings-input-sm"
                value={settings.autoTradeTargetDollars}
                step={1.25}
                min={1.25}
                onChange={e => { const v = parseFloat(e.target.value); if (!isNaN(v) && v > 0) update({ autoTradeTargetDollars: v }); }}
              />
            </div>
          </>
        )}
        <div className="settings-row">
          <span className="settings-label">P&amp;L Bar</span>
          <SettingsToggle
            checked={settings.pnlVisible}
            onChange={v => update({ pnlVisible: v })}
          />
        </div>
      </div>

      {/* Fees */}
      <div className="settings-section">
        <div className="settings-section-title">Fees (MES / AMP)</div>
        <div className="settings-row">
          <span className="settings-label">Subtract commissions</span>
          <SettingsToggle
            checked={settings.subtractCommissions ?? false}
            onChange={v => update({ subtractCommissions: v })}
          />
        </div>
        <div className="settings-row">
          <span className="settings-label">Per-contract (RT)</span>
          <input
            type="number"
            className="settings-input settings-input-sm"
            value={settings.feePerContract}
            step={0.01}
            min={0}
            onChange={e => { const v = parseFloat(e.target.value); if (!isNaN(v)) update({ feePerContract: v }); }}
          />
        </div>
        <div className="settings-row">
          <span className="settings-label">Liquidation / day</span>
          <input
            type="number"
            className="settings-input settings-input-sm"
            value={settings.feeLiquidationDaily}
            step={0.01}
            min={0}
            onChange={e => { const v = parseFloat(e.target.value); if (!isNaN(v)) update({ feeLiquidationDaily: v }); }}
          />
        </div>
        <div className="settings-row">
          <span className="settings-label">Data feed / month</span>
          <input
            type="number"
            className="settings-input settings-input-sm"
            value={settings.feeDataMonthly}
            step={0.01}
            min={0}
            onChange={e => { const v = parseFloat(e.target.value); if (!isNaN(v)) update({ feeDataMonthly: v }); }}
          />
        </div>
        <div className="settings-row">
          <span className="settings-label">Trading days / mo</span>
          <input
            type="number"
            className="settings-input settings-input-sm"
            value={settings.feeTradingDays}
            step={1}
            min={1}
            max={31}
            onChange={e => { const v = parseInt(e.target.value); if (!isNaN(v) && v > 0) update({ feeTradingDays: v }); }}
          />
        </div>
        <div className="settings-row">
          <span className="settings-label">Daily fixed (calc)</span>
          <span className="settings-value">
            ${(settings.feeLiquidationDaily + settings.feeDataMonthly / settings.feeTradingDays).toFixed(2)}
          </span>
        </div>
      </div>

      {/* Display */}
      <div className="settings-section">
        <div className="settings-section-title">Display</div>
        <div className="settings-row">
          <span className="settings-label">Line Thickness</span>
          <select
            className="settings-select"
            value={settings.lineThickness}
            onChange={e => update({ lineThickness: parseInt(e.target.value) as 1 | 2 | 3 })}
          >
            <option value={1}>1 — Thin</option>
            <option value={2}>2 — Normal</option>
            <option value={3}>3 — Thick</option>
          </select>
        </div>
        <div className="settings-row">
          <span className="settings-label">Label Size</span>
          <select
            className="settings-select"
            value={settings.labelSize}
            onChange={e => update({ labelSize: e.target.value as 'small' | 'normal' | 'large' })}
          >
            <option value="small">Small</option>
            <option value="normal">Normal</option>
            <option value="large">Large</option>
          </select>
        </div>
      </div>

      {/* API Key */}
      <div className="settings-section">
        <div className="settings-section-title">API Key</div>
        <div className="settings-row">
          <span className="settings-label">Status</span>
          <span className={`key-status-badge key-status-${keyStatus}`}>
            {keyStatus === 'env' ? 'From .env' : keyStatus === 'override' ? 'Override' : 'Missing'}
          </span>
        </div>
        <div className="settings-row settings-row-stack">
          <span className="settings-label">Override</span>
          <input
            type="password"
            className="settings-input"
            placeholder="sk-ant-… (leave empty to use .env)"
            value={settings.apiKeyOverride}
            onChange={e => update({ apiKeyOverride: e.target.value })}
          />
        </div>
      </div>

      {/* About */}
      <div className="settings-section settings-section-last">
        <div className="settings-section-title">About</div>
        <div className="settings-row">
          <span className="settings-label">Version</span>
          <span className="settings-value">{appVersion || '—'}</span>
        </div>
      </div>

      {saveError && <div className="toast toast-error">{saveError}</div>}
    </div>
  );
};

const SettingsToggle: React.FC<{ checked: boolean; onChange: (v: boolean) => void; disabled?: boolean }> = ({ checked, onChange, disabled }) => (
  <label className="settings-toggle-wrap" style={disabled ? { opacity: 0.35, pointerEvents: 'none' } : undefined}>
    <input type="checkbox" checked={checked} onChange={e => onChange(e.target.checked)} disabled={disabled} />
    <span className="switch-track" />
  </label>
);

export default SettingsPanel;
