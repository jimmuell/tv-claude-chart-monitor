import React, { useEffect, useState, useCallback } from 'react';
import type {
  OrderImportState, SessionDetail, SessionListItem, ImportedTrade, ImportedFill,
} from '../shared/types';

// Display rules live outside the component tree so they can be tested without a DOM.
import * as view from '../shared/pnl-view.mjs';
import * as range from '../shared/pnl-range.mjs';

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

/**
 * The Past days tab: every session, newest first. A click selects one day; the tick
 * boxes combine two or more. Ticking is what turns the window into a range view.
 */
const PastDays: React.FC<{
  sessions: SessionListItem[]; selected: string; onSelect: (d: string) => void;
  ticked: Set<string>; onTick: (d: string, on: boolean) => void; onClearTicks: () => void;
}> = ({ sessions, selected, onSelect, ticked, onTick, onClearTicks }) => {
  if (sessions.length === 0) {
    return <div className="empty"><p>No sessions in the imported file.</p></div>;
  }
  return (
    <>
    {ticked.size > 0 && (
      <div className="tickbar">
        <span>{ticked.size} day{ticked.size === 1 ? '' : 's'} ticked{ticked.size === 1 ? ' — tick another to combine' : ''}</span>
        <button className="btn-link" onClick={onClearTicks}>Clear</button>
      </div>
    )}
    <table className="grid">
      <thead>
        <tr><th className="tick"></th><th>Session</th><th className="num">Trades</th><th className="num">Contracts</th><th className="num">Fees</th><th className="num">Net</th></tr>
      </thead>
      <tbody>
        {sessions.map(s => (
          <tr
            key={s.sessionDate}
            className={`row${s.sessionDate === selected ? ' selected' : ''}`}
            onClick={() => onSelect(s.sessionDate)}
          >
            <td className="tick" onClick={(e) => e.stopPropagation()}>
              <input type="checkbox" checked={ticked.has(s.sessionDate)}
                     onChange={(e) => onTick(s.sessionDate, e.target.checked)}
                     title="Combine this day with the others ticked" />
            </td>
            <td>{s.sessionDate}{s.openPositionAtEnd !== 0 && <span className="tag cross">carried {s.openPositionAtEnd > 0 ? '+' : ''}{s.openPositionAtEnd}</span>}</td>
            <td className="num">{s.tradeCount}</td>
            <td className="num dim">{s.contractSides}</td>
            <td className="num dim">{view.fmtMoney(s.fees, { signed: false })}</td>
            <td className={`num strong ${view.moneyClass(s.netPnl)}`}>{view.fmtMoney(s.netPnl)}</td>
          </tr>
        ))}
      </tbody>
    </table>
    </>
  );
};

/** The Summary for a range: combined totals, then one line per day. */
const RangeSummary: React.FC<{ combined: any; label: string }> = ({ combined, label }) => {
  const t = combined.totals;
  const rows = [
    { key: 'net',   label: 'Net',       value: view.fmtMoney(t.netPnl),   tone: view.moneyClass(t.netPnl), headline: true },
    { key: 'gross', label: 'Gross',     value: view.fmtMoney(t.grossPnl), tone: view.moneyClass(t.grossPnl) },
    { key: 'fees',  label: 'Fees',      value: view.fmtMoney(t.fees, { signed: false }), tone: '' },
    { key: 'con',   label: 'Contracts', value: view.fmtContracts(t.contractSides), tone: '' },
    { key: 'trd',   label: 'Trades',    value: String(t.tradeCount), tone: '' },
    { key: 'day',   label: 'Days',      value: `${combined.dayCount} trading days`, tone: '' },
  ];
  return (
    <div className="summary">
      <div className="range-head">{label}</div>
      {rows.map(r => (
        <div key={r.key} className={`srow${r.headline ? ' headline' : ''}`}>
          <span className="slabel">{r.label}</span>
          <span className={`svalue ${r.tone}`}>{r.value}</span>
        </div>
      ))}
      <div className="perday">
        <div className="perday-title">Per day</div>
        {combined.perDay.map((d: any) => (
          <div key={d.sessionDate} className={`perday-row${d.hasData ? '' : ' empty-day'}`}>
            <span>{d.sessionDate}</span>
            <span className={view.moneyClass(d.netPnl)}>{d.hasData ? view.fmtMoney(d.netPnl) : 'no trading'}</span>
          </div>
        ))}
      </div>
      <p className="carried-note">
        Each day is its own statement total; the combined figure is their sum, so a trade
        carried between days is counted once.
      </p>
    </div>
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

  // --- the range view -----------------------------------------------------
  // The period is remembered between openings; the tick boxes are not, because a
  // combination of specific days is a deliberate, momentary thing.
  const [period, setPeriod] = useState<string>(() => {
    try { return window.localStorage.getItem('tvcm.period') || 'today'; } catch { return 'today'; }
  });
  const [customFrom, setCustomFrom] = useState('');
  const [customTo,   setCustomTo]   = useState('');
  const [ticked, setTicked] = useState<Set<string>>(new Set());
  const [rangeDetails, setRangeDetails] = useState<SessionDetail[]>([]);

  /** Remembers the chosen period, so the window opens the way it was left. */
  const choosePeriod = useCallback((p: string) => {
    setPeriod(p);
    setTicked(new Set());
    try { window.localStorage.setItem('tvcm.period', p); } catch { /* private window */ }
  }, []);

  /** Ticking days in Past days overrides the period selector while any are ticked. */
  const toggleTick = useCallback((d: string, on: boolean) => {
    setTicked(prev => { const next = new Set(prev); if (on) next.add(d); else next.delete(d); return next; });
  }, []);

  const today = state?.currentSession || sessions[0]?.sessionDate || '';
  const available = React.useMemo(() => range.availableDates(sessions), [sessions]);
  const activeRange = React.useMemo(() => {
    if (ticked.size >= 2) {
      const dates = Array.from(ticked).sort();
      return { period: 'ticked', dates, from: dates[0], to: dates[dates.length - 1] };
    }
    return range.rangeFor(period, { today, available, from: customFrom, to: customTo });
  }, [ticked, period, today, available, customFrom, customTo]);

  const isRange = activeRange.dates.length > 1;

  // One getDetail per day in the range. Days are few and the call is a local IPC read.
  useEffect(() => {
    if (!isRange) { setRangeDetails([]); return; }
    let alive = true;
    void Promise.all(activeRange.dates.map(d => window.pnlApi.getDetail(d)))
      .then(ds => { if (alive) setRangeDetails(ds); });
    return () => { alive = false; };
  }, [isRange, activeRange.dates.join(','), state?.importedAt]);

  const combined = React.useMemo(
    () => range.combineSessions(sessions, activeRange.dates), [sessions, activeRange.dates.join(',')]);
  const rangeTrades = React.useMemo(
    () => range.rowsInRange(rangeDetails.flatMap(d => d.trades || []), activeRange.dates, 'trades'),
    [rangeDetails, activeRange.dates.join(',')]);
  const rangeFills = React.useMemo(
    () => range.rowsInRange(rangeDetails.flatMap(d => d.fills || []), activeRange.dates, 'fills'),
    [rangeDetails, activeRange.dates.join(',')]);

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
  const isRangeTicked = ticked.size >= 2;

  return (
    <div className="app">
      <header className="head">
        <div className="title">
          Order History &amp; P&amp;L
          {paper && <span className="paper-chip" title="Paper account — not real money">PAPER</span>}
          <span className="session-chip">{isRange ? range.rangeLabel(activeRange) : (selected || today)}</span>
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

      <nav className="periods">
        {range.PERIODS.map(p => (
          <button key={p.key}
                  className={`period${!isRangeTicked && period === p.key ? ' active' : ''}`}
                  onClick={() => choosePeriod(p.key)}>{p.label}</button>
        ))}
        {period === 'custom' && !isRangeTicked && (
          <span className="custom-dates">
            <label>From <input type="date" value={customFrom} onChange={e => setCustomFrom(e.target.value)} /></label>
            <label>To <input type="date" value={customTo} onChange={e => setCustomTo(e.target.value)} /></label>
          </span>
        )}
        {isRangeTicked && (
          <span className="custom-dates">
            {ticked.size} days ticked in Past days
            <button className="btn-link" onClick={() => setTicked(new Set())}>Clear</button>
          </span>
        )}
      </nav>

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
          ? <PastDays sessions={sessions} selected={selected}
                      onSelect={(d) => { setSelected(d); setTab('summary'); }}
                      ticked={ticked} onTick={toggleTick} onClearTicks={() => setTicked(new Set())} />
          : isRange
            ? (tab === 'summary' ? <RangeSummary combined={combined} label={range.rangeLabel(activeRange)} />
             : tab === 'trades'  ? <Trades detail={{ sessionDate: '', session: null, trades: rangeTrades, fills: rangeFills, boundary: null }} />
             : <Fills detail={{ sessionDate: '', session: null, trades: rangeTrades, fills: rangeFills, boundary: null }} />)
            : !hasData
              ? <Empty state={state} />
              : tab === 'summary' ? <Summary detail={detail!} state={state} />
              : tab === 'trades'  ? <Trades detail={detail!} />
              : <Fills detail={detail!} />}
      </main>
    </div>
  );
}
