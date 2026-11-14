import React, { useEffect, useState, useCallback } from 'react';
import type {
  OrderImportState, SessionDetail, SessionListItem, ImportedTrade, ImportedFill,
} from '../shared/types';

// Display rules live outside the component tree so they can be tested without a DOM.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const view = require('../shared/pnl-view.js');

type TabKey = 'summary' | 'trades' | 'fills' | 'days';

const TABS: { key: TabKey; label: string }[] = [
  { key: 'summary', label: 'Summary' },
  { key: 'trades',  label: 'Trades' },
  { key: 'fills',   label: 'Fills' },
  { key: 'days',    label: 'Past days' },
];

/** The shared "nothing imported yet" panel, so no tab ever shows invented zeros. */
const Empty: React.FC<{ state: OrderImportState | null }> = ({ state }) => (
  <div className="empty">
    <p>{view.emptyMessage(state)}</p>
  </div>
);

/** The Summary tab: the session total leads, everything else explains it. */
const Summary: React.FC<{ detail: SessionDetail; state: OrderImportState | null }> = ({ detail, state }) => {
  const rows = view.summaryRows(detail, state) as Array<{
    key: string; label: string; value: string; tone: string; headline?: boolean; note?: boolean;
  }>;
  const explanation = view.carriedExplanation(detail) as string | null;

  return (
    <div className="summary">
      {rows.map(r => (
        <div key={r.key} className={`srow${r.headline ? ' headline' : ''}${r.note ? ' note' : ''}`}>
          <span className="slabel">{r.label}</span>
          <span className={`svalue ${r.tone}`}>{r.value}</span>
        </div>
      ))}
      {explanation && <p className="carried-note">{explanation}</p>}
      <div className="actions">
        <button className="btn" disabled title="Automatic export coming soon">Export now</button>
        <span className="hint">Automatic export coming soon</span>
      </div>
    </div>
  );
};

/** The Trades tab: one row per flat-to-flat trade; a click reveals that trade's fills. */
const Trades: React.FC<{ detail: SessionDetail }> = ({ detail }) => {
  const [openId, setOpenId] = useState<number | null>(null);
  if (detail.trades.length === 0) {
    return <div className="empty"><p>No trades closed in this session.</p></div>;
  }
  return (
    <table className="grid">
      <thead>
        <tr>
          <th className="num">#</th><th>Open – Close</th><th>Dir</th><th className="num">Size</th>
          <th className="num">Avg entry</th><th className="num">Avg exit</th>
          <th className="num">Fees</th><th className="num">Net</th>
        </tr>
      </thead>
      <tbody>
        {detail.trades.map((t: ImportedTrade) => {
          const r = view.tradeRow(t);
          const expanded = openId === t.id;
          const fills = expanded ? (view.fillsForTrade(t, detail.fills) as ImportedFill[]) : [];
          return (
            <React.Fragment key={t.id}>
              <tr className={`row${expanded ? ' expanded' : ''}`} onClick={() => setOpenId(expanded ? null : t.id)}>
                <td className="num">{r.id}</td>
                <td>{r.time}{r.isOpen && <span className="tag open">OPEN</span>}{r.crosses && <span className="tag cross">CROSSES</span>}</td>
                <td><span className={`dir ${r.direction}`}>{r.direction}</span></td>
                <td className="num">{r.size}</td>
                <td className="num">{r.avgEntry}</td>
                <td className="num">{r.avgExit}</td>
                <td className="num dim">{r.fees}</td>
                <td className={`num strong ${r.tone}`}>{r.net}</td>
              </tr>
              {expanded && (
                <tr className="detail-row">
                  <td colSpan={8}>
                    <div className="fills-inline">
                      <div className="fills-title">Fills in trade #{t.id}</div>
                      <table className="grid inner">
                        <thead><tr><th>Time</th><th>Side</th><th className="num">Qty</th><th className="num">Price</th><th>Status</th><th>Order ID</th></tr></thead>
                        <tbody>
                          {fills.map(f => (
                            <tr key={f.orderId}>
                              <td>{view.fmtClock(f.fillTime)}</td>
                              <td><span className={`dir ${f.side === 'Buy' ? 'long' : 'short'}`}>{f.side}</span></td>
                              <td className="num">{f.qty}</td>
                              <td className="num">{f.price.toFixed(2)}</td>
                              <td className="dim">{f.status}</td>
                              <td className="dim mono">{f.orderId}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </td>
                </tr>
              )}
            </React.Fragment>
          );
        })}
      </tbody>
    </table>
  );
};

/** The Fills tab: every raw row the export carried for this session. */
const Fills: React.FC<{ detail: SessionDetail }> = ({ detail }) => {
  if (detail.fills.length === 0) {
    return <div className="empty"><p>No fills in this session.</p></div>;
  }
  return (
    <table className="grid">
      <thead>
        <tr><th>Time</th><th>Side</th><th>Type</th><th className="num">Qty</th><th className="num">Price</th><th>Status</th><th>Order ID</th></tr>
      </thead>
      <tbody>
        {detail.fills.map((f: ImportedFill) => (
          <tr key={f.orderId} className="row">
            <td>{view.fmtStamp(f.fillTime)}</td>
            <td><span className={`dir ${f.side === 'Buy' ? 'long' : 'short'}`}>{f.side}</span></td>
            <td className="dim">{f.orderType}</td>
            <td className="num">{f.qty}</td>
            <td className="num">{f.price.toFixed(2)}</td>
            <td className={f.status === 'Filled' ? 'dim' : 'warn'}>{f.status}</td>
            <td className="dim mono">{f.orderId}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
};

/** The Past days tab: every session in the file, newest first; a click selects it. */
const PastDays: React.FC<{
  sessions: SessionListItem[]; selected: string; onSelect: (d: string) => void;
}> = ({ sessions, selected, onSelect }) => {
  if (sessions.length === 0) {
    return <div className="empty"><p>No sessions in the imported file.</p></div>;
  }
  return (
    <table className="grid">
      <thead>
        <tr><th>Session</th><th className="num">Trades</th><th className="num">Contracts</th><th className="num">Fees</th><th className="num">Net</th></tr>
      </thead>
      <tbody>
        {sessions.map(s => (
          <tr
            key={s.sessionDate}
            className={`row${s.sessionDate === selected ? ' selected' : ''}`}
            onClick={() => onSelect(s.sessionDate)}
          >
            <td>{s.sessionDate}{s.openPositionAtEnd !== 0 && <span className="tag cross">carried {s.openPositionAtEnd > 0 ? '+' : ''}{s.openPositionAtEnd}</span>}</td>
            <td className="num">{s.tradeCount}</td>
            <td className="num dim">{s.contractSides}</td>
            <td className="num dim">{view.fmtMoney(s.fees, { signed: false })}</td>
            <td className={`num strong ${view.moneyClass(s.netPnl)}`}>{view.fmtMoney(s.netPnl)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
};

export function App() {
  const [state, setState]       = useState<OrderImportState | null>(null);
  const [sessions, setSessions] = useState<SessionListItem[]>([]);
  const [selected, setSelected] = useState<string>('');
  const [detail, setDetail]     = useState<SessionDetail | null>(null);
  const [tab, setTab]           = useState<TabKey>('summary');

  /** Pulls the session list and keeps the current selection valid as data changes. */
  const refreshSessions = useCallback(async (preferred?: string) => {
    const list = await window.pnlApi.listSessions();
    setSessions(list);
    const want = preferred && list.some(s => s.sessionDate === preferred)
      ? preferred
      : (list[0]?.sessionDate ?? '');
    setSelected(want);
    return want;
  }, []);

  useEffect(() => {
    let alive = true;
    void (async () => {
      const s = await window.pnlApi.getState();
      if (!alive) return;
      setState(s);
      await refreshSessions(s?.session?.sessionDate);
    })();
    const unsub = window.pnlApi.onUpdate(async (next) => {
      setState(next);
      await refreshSessions(selectedRef.current);
    });
    return () => { alive = false; unsub(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Kept in a ref so the push handler above always re-selects the day being viewed.
  const selectedRef = React.useRef('');
  useEffect(() => { selectedRef.current = selected; }, [selected]);

  useEffect(() => {
    if (!selected) { setDetail(null); return; }
    let alive = true;
    void window.pnlApi.getDetail(selected).then(d => { if (alive) setDetail(d); });
    return () => { alive = false; };
  }, [selected, state?.importedAt]);

  const hasData = !!(detail && detail.session);

  return (
    <div className="app">
      <header className="head">
        <div className="title">
          Order History &amp; P&amp;L
          {selected && <span className="session-chip">{selected}</span>}
        </div>
        <div className="source">{state?.fileName ?? 'no file'}</div>
      </header>

      <nav className="tabs">
        {TABS.map(t => (
          <button
            key={t.key}
            className={`tab${tab === t.key ? ' active' : ''}`}
            onClick={() => setTab(t.key)}
          >{t.label}</button>
        ))}
      </nav>

      <main className="body">
        {tab === 'days'
          ? <PastDays sessions={sessions} selected={selected} onSelect={(d) => { setSelected(d); setTab('summary'); }} />
          : !hasData
            ? <Empty state={state} />
            : tab === 'summary' ? <Summary detail={detail!} state={state} />
            : tab === 'trades'  ? <Trades detail={detail!} />
            : <Fills detail={detail!} />}
      </main>
    </div>
  );
}
