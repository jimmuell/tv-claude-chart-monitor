import React, { useEffect, useState, useCallback } from 'react';
import type {
  OrderImportState, SessionDetail, SessionListItem, ImportedTrade, ImportedFill,
} from '../shared/types';

// Display rules live outside the component tree so they can be tested without a DOM.
import * as view from '../shared/pnl-view.mjs';

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
  const rows = view.summaryRows(detail, state);
  const explanation = view.carriedExplanation(detail);

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
  const [cursor, setCursor] = useState(0);

  // Arrow keys move the cursor and Enter opens a trade's fills, so the breakdown is
  // reachable without a mouse — the same toggle a click runs.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || detail.trades.length === 0) return;
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        setCursor(c => Math.min(detail.trades.length - 1, Math.max(0, c + (e.key === 'ArrowDown' ? 1 : -1))));
      } else if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        const t = detail.trades[cursor];
        if (t) setOpenId(prev => (prev === t.id ? null : t.id));
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [detail.trades, cursor]);

  useEffect(() => { setCursor(0); setOpenId(null); }, [detail.sessionDate]);

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
        {view.tradeRows(detail.trades).map((r, idx: number) => {
          const t: ImportedTrade = detail.trades[idx];
          const expanded = openId === t.id;
          const atCursor = idx === cursor;
          const fills: ImportedFill[] = expanded ? view.fillsForTrade(t, detail.fills) : [];
          return (
            <React.Fragment key={t.id}>
              <tr
                className={`row${expanded ? ' expanded' : ''}${atCursor ? ' cursor' : ''}`}
                onClick={() => { setCursor(idx); setOpenId(expanded ? null : t.id); }}
              >
                <td className="num">{r.number}</td>
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
                      <div className="fills-title">
                        Fills in trade #{r.number} <span className="dim">· id {t.id}</span>
                      </div>
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

  // The paper toggle lives in three places; this one mirrors whatever the main process
  // says, and never holds an opinion of its own.
  const [paper, setPaper] = useState(false);
  const [merged, setMerged] = useState<import('../shared/types').MergedPnlState | null>(null);
  useEffect(() => {
    let alive = true;
    const refresh = () => window.pnlApi.getPaperMode().then(r => {
      if (!alive) return;
      setPaper(r.paperMode);
      setMerged(r.merged);
    });
    void refresh();
    const offMode   = window.pnlApi.onPaperMode(() => { void refresh(); });
    const offUpdate = window.pnlApi.onUpdate(() => { void refresh(); });
    return () => { alive = false; offMode(); offUpdate(); };
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

  /** Keyboard: Cmd-1..4 pick a tab, Cmd-[ / Cmd-] step through sessions. */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); window.pnlApi.close(); return; }
      if (!e.metaKey) return;
      const tabIndex = TABS.findIndex((_, i) => String(i + 1) === e.key);
      if (tabIndex >= 0) { e.preventDefault(); setTab(TABS[tabIndex].key); return; }
      if (e.key === 'w') { e.preventDefault(); window.pnlApi.close(); return; }
      if (e.key === '[' || e.key === ']') {
        e.preventDefault();
        const i = sessions.findIndex(x => x.sessionDate === selected);
        // The list is newest first, so "]" (forward) means older.
        const next = e.key === ']' ? i + 1 : i - 1;
        if (next >= 0 && next < sessions.length) setSelected(sessions[next].sessionDate);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [sessions, selected]);

  const hasData = !!(detail && detail.session);

  return (
    <div className="app">
      <header className="head">
        <div className="title">
          Order History &amp; P&amp;L
          {paper && <span className="paper-chip" title="Paper account — not real money">PAPER</span>}
          {selected && <span className="session-chip">{selected}</span>}
        </div>
        <div className="head-right">
          {merged?.warn && merged.errorMessage &&
            <span className="warn-chip" title={[merged.errorMessage, merged.switchHint].filter(Boolean).join(' — ')}>
              ⚠ {merged.errorCode}
            </span>}
          <label className="paper-toggle" title="Read the paper account instead of AMP Live">
            <input type="checkbox" checked={paper} onChange={(e) => { void window.pnlApi.setPaperMode(e.target.checked); }} />
            Paper mode
          </label>
          <span className="source">{state?.fileName ?? 'no file'}</span>
          <button className="btn-close" onClick={() => window.pnlApi.close()} title="Close (Esc)">Close</button>
        </div>
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
