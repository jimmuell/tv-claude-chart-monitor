import React, { useEffect, useState, useCallback } from 'react';
import type {
  OrderImportState, SessionDetail, SessionListItem, ImportedTrade, ImportedFill,
} from '../shared/types';

// Display rules live outside the component tree so they can be tested without a DOM.
import * as view from '../shared/pnl-view.mjs';
import * as range from '../shared/pnl-range.mjs';
import * as sorting from '../shared/pnl-sort.mjs';

type TabKey = 'summary' | 'trades' | 'fills' | 'days';

const TABS: { key: TabKey; label: string }[] = [
  { key: 'summary', label: 'Summary' },
  { key: 'trades',  label: 'Trades' },
  { key: 'fills',   label: 'Fills' },
  { key: 'days',    label: 'Past days' },
];

/** The browser store the tabs remember their sort in; absent in a private window. */
function sortStore(): Storage | null {
  try { return window.localStorage; } catch { return null; }
}

/**
 * A tab's sort, remembered between openings. Returned with the click handler the headers
 * need, so each table only has to draw itself.
 */
function useSort(tab: string) {
  const [sort, setSort] = useState<{ key: string; dir: string }>(() => sorting.readSort(sortStore(), tab));
  const onSort = useCallback((key: string) => {
    setSort(prev => {
      const next = sorting.nextSort(prev, tab, key);
      sorting.writeSort(sortStore(), tab, next);
      return next;
    });
  }, [tab]);
  return { sort, onSort };
}

/** One clickable column heading, with the arrow when it is the one being sorted by. */
const Th: React.FC<{
  tab: string; col: any; sort: { key: string; dir: string }; onSort: (key: string) => void;
}> = ({ col, sort, onSort }) => (
  <th
    className={`${col.align === 'num' ? 'num ' : ''}sortable${sort.key === col.key ? ' sorted' : ''}`}
    onClick={() => onSort(col.key)}
    title={`Sort by ${col.label}`}
  >
    {col.label}<span className="sort-arrow">{sorting.arrowFor(sort, col.key)}</span>
  </th>
);

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
  const { sort, onSort } = useSort('trades');

  // The trade number is fixed in the order the engine delivered them — #1 is the first
  // trade of the session whatever column the table is being read by.
  const numbered = React.useMemo(
    () => (detail.trades || []).map((t, i) => ({ ...t, number: i + 1 })), [detail.trades]);
  const ordered = React.useMemo(
    () => sorting.sortRows(numbered, 'trades', sort), [numbered, sort]);

  // Arrow keys move the cursor and Enter opens a trade's fills, so the breakdown is
  // reachable without a mouse — the same toggle a click runs.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || ordered.length === 0) return;
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        setCursor(c => Math.min(ordered.length - 1, Math.max(0, c + (e.key === 'ArrowDown' ? 1 : -1))));
      } else if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        const t = ordered[cursor];
        if (t) setOpenId(prev => (prev === t.id ? null : t.id));
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [ordered, cursor]);

  useEffect(() => { setCursor(0); setOpenId(null); }, [detail.sessionDate]);

  if (ordered.length === 0) {
    return <div className="empty"><p>No trades closed in this session.</p></div>;
  }
  const cols = sorting.COLUMNS.trades;
  return (
    <table className="grid">
      <thead>
        <tr>{cols.map((c: any) => <Th key={c.key} tab="trades" col={c} sort={sort} onSort={onSort} />)}</tr>
      </thead>
      <tbody>
        {ordered.map((t: ImportedTrade & { number: number }, idx: number) => {
          const r = view.tradeRow(t);
          const expanded = openId === t.id;
          const atCursor = idx === cursor;
          // The fills are matched on the trade's own order ids, so no amount of
          // reordering can put one under the wrong trade.
          const fills: ImportedFill[] = expanded ? view.fillsForTrade(t, detail.fills) : [];
          return (
            <React.Fragment key={t.id}>
              <tr
                className={`row${expanded ? ' expanded' : ''}${atCursor ? ' cursor' : ''}`}
                onClick={() => { setCursor(idx); setOpenId(expanded ? null : t.id); }}
              >
                <td className="num">{t.number}</td>
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
                  <td colSpan={cols.length}>
                    <div className="fills-inline">
                      <div className="fills-title">
                        Fills in trade #{t.number} <span className="dim">· id {t.id}</span>
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
  const { sort, onSort } = useSort('fills');
  const ordered = React.useMemo(
    () => sorting.sortRows(detail.fills, 'fills', sort), [detail.fills, sort]);
  if (ordered.length === 0) {
    return <div className="empty"><p>No fills in this session.</p></div>;
  }
  return (
    <table className="grid">
      <thead>
        <tr>{sorting.COLUMNS.fills.map((c: any) =>
          <Th key={c.key} tab="fills" col={c} sort={sort} onSort={onSort} />)}</tr>
      </thead>
      <tbody>
        {ordered.map((f: ImportedFill) => (
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
  calendarMode: boolean;
}> = ({ sessions, selected, onSelect, ticked, onTick, onClearTicks, calendarMode }) => {
  const { sort, onSort } = useSort('days');
  const ordered = React.useMemo(() => sorting.sortRows(sessions, 'days', sort), [sessions, sort]);
  if (sessions.length === 0) {
    return <div className="empty"><p>No sessions in the imported file.</p></div>;
  }
  return (
    <>
    {calendarMode && (
      <div className="tickbar">
        <span>Past days always lists AMP trading days — calendar days only re-bucket Trades and Fills.</span>
      </div>
    )}
    {ticked.size > 0 && (
      <div className="tickbar">
        <span>{ticked.size} day{ticked.size === 1 ? '' : 's'} ticked{ticked.size === 1 ? ' — tick another to combine' : ''}</span>
        <button className="btn-link" onClick={onClearTicks}>Clear</button>
      </div>
    )}
    <table className="grid">
      <thead>
        <tr>
          <th className="tick"></th>
          {sorting.COLUMNS.days.map((c: any) =>
            <Th key={c.key} tab="days" col={c} sort={sort} onSort={onSort} />)}
        </tr>
      </thead>
      <tbody>
        {ordered.map((s: SessionListItem) => (
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

/** The Summary for several days: combined totals, then one line per day. */
const RangeSummary: React.FC<{ combined: any; label: string; dayWord?: string; note?: string | null }> =
  ({ combined, label, dayWord, note }) => {
  const t = combined.totals;
  const rows = [
    { key: 'net',   label: 'Net',       value: view.fmtMoney(t.netPnl),   tone: view.moneyClass(t.netPnl), headline: true },
    { key: 'gross', label: 'Gross',     value: view.fmtMoney(t.grossPnl), tone: view.moneyClass(t.grossPnl) },
    { key: 'fees',  label: 'Fees',      value: view.fmtMoney(t.fees, { signed: false }), tone: '' },
    { key: 'con',   label: 'Contracts', value: view.fmtContracts(t.contractSides), tone: '' },
    { key: 'trd',   label: 'Trades',    value: String(t.tradeCount), tone: '' },
    { key: 'day',   label: 'Days',      value: `${combined.dayCount} ${dayWord || 'trading days'}`, tone: '' },
  ];
  return (
    <div className="summary">
      <div className="range-head">{label}</div>
      {note && <p className="calendar-note">{note}</p>}
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
        {note
          ? 'A calendar day is added up from the trades that closed inside it, which is not how AMP totals a statement.'
          : 'Each day is its own statement total; the combined figure is their sum, so a trade carried between days is counted once.'}
      </p>
    </div>
  );
};

/** The missing-fill banner. It proposes; only Jim's click records anything. */
const MissingFillBanner: React.FC<{
  suggestion: any; onAdd: () => void; onDismiss: () => void;
}> = ({ suggestion, onAdd, onDismiss }) => (
  <div className="missing-banner">
    <span className="missing-text">{suggestion.text}</span>
    <span className="missing-actions">
      {!suggestion.needsPrice && <button className="btn-add" onClick={onAdd}>Add</button>}
      <button className="btn-link" onClick={onDismiss}>Dismiss</button>
    </span>
  </div>
);

/** The corrections Jim has recorded, each removable, with what they are written on them. */
const CorrectionList: React.FC<{ corrections: any[]; onRemove: (id: string) => void }> = ({ corrections, onRemove }) => {
  if (corrections.length === 0) return null;
  return (
    <div className="corrections">
      <div className="perday-title">Added fills — missing from TradingView&rsquo;s records</div>
      {corrections.map(c => (
        <div key={c.id} className="correction-row">
          <span>{view.fmtDayStamp(c.fillTime)} · {c.side} {c.qty} @ {Number(c.price).toFixed(2)}</span>
          <span className="dim">{c.source}</span>
          <button className="btn-link" onClick={() => onRemove(c.id)}>Remove</button>
        </div>
      ))}
    </div>
  );
};

export function App() {
  const [state, setState]       = useState<OrderImportState | null>(null);
  /**
   * Bumped whenever the numbers can have changed without the import time moving — which
   * is what adding or removing a correction does. Without it the window kept showing the
   * uncorrected figures until the next export landed.
   */
  const [dataVersion, setDataVersion] = useState(0);
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

  // Which day a day is. AMP's runs 17:00–17:00 CT, which is why "Today" shows Sunday
  // evening's trading; calendar days re-bucket the same rows midnight to midnight.
  const [dayMode, setDayMode] = useState<string>(() => {
    try { return window.localStorage.getItem('tvcm.dayMode') || 'trading'; } catch { return 'trading'; }
  });
  const calendarMode = dayMode === 'calendar';

  /** Remembers which kind of day the window is showing. The menu bar never changes. */
  const chooseDayMode = useCallback((m: string) => {
    setDayMode(m);
    try { window.localStorage.setItem('tvcm.dayMode', m); } catch { /* private window */ }
  }, []);

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

  // In calendar mode "today" is the actual calendar date, which on a Sunday evening is
  // NOT the session date — that is the whole difference between the two modes.
  const sessionToday = state?.currentSession || sessions[0]?.sessionDate || '';
  const today = calendarMode ? range.chicagoToday() : sessionToday;
  const available = React.useMemo(() => range.availableDates(sessions, dayMode), [sessions, dayMode]);
  const activeRange = React.useMemo(() => {
    if (ticked.size >= 2) {
      const dates = Array.from(ticked).sort();
      return { period: 'ticked', dates, from: dates[0], to: dates[dates.length - 1] };
    }
    return range.rangeFor(period, { today, available, from: customFrom, to: customTo });
  }, [ticked, period, today, available, customFrom, customTo]);

  const isRange = activeRange.dates.length > 1;
  // One day at a time still follows the Past-days selection, as it always has.
  const viewDates = React.useMemo(
    () => (isRange ? activeRange.dates : [selected || today].filter(Boolean)),
    [isRange, activeRange.dates.join(','), selected, today]);
  // A calendar day is cut out of two AMP sessions, so both have to be fetched.
  const needDetails = isRange || calendarMode;
  const fetchDates = React.useMemo(
    () => (calendarMode ? range.sessionsCoveringCalendar(viewDates) : viewDates),
    [calendarMode, viewDates.join(',')]);

  // One getDetail per day needed. Days are few and the call is a local IPC read.
  useEffect(() => {
    if (!needDetails) { setRangeDetails([]); return; }
    let alive = true;
    void Promise.all(fetchDates.map(d => window.pnlApi.getDetail(d)))
      .then(ds => { if (alive) setRangeDetails(ds); });
    return () => { alive = false; };
  }, [needDetails, fetchDates.join(','), state?.importedAt, dataVersion]);

  const combined = React.useMemo(
    () => range.combineSessions(sessions, activeRange.dates), [sessions, activeRange.dates.join(',')]);
  const rangeTrades = React.useMemo(
    () => range.rowsInRange(rangeDetails.flatMap(d => d.trades || []), viewDates, 'trades', dayMode),
    [rangeDetails, viewDates.join(','), dayMode]);
  const rangeFills = React.useMemo(
    () => range.rowsInRange(rangeDetails.flatMap(d => d.fills || []), viewDates, 'fills', dayMode),
    [rangeDetails, viewDates.join(','), dayMode]);
  const calendarCombined = React.useMemo(
    () => range.combineCalendarDays(rangeTrades, viewDates), [rangeTrades, viewDates.join(',')]);

  // --- missing fills -----------------------------------------------------
  // TVCM can only ever suggest. Nothing is recorded without Jim pressing Add.
  const [suggestion, setSuggestion] = useState<any>(null);
  const [dismissed, setDismissed] = useState(false);
  const [corrections, setCorrections] = useState<any[]>([]);

  const refreshCorrections = useCallback(async () => {
    const [s, list] = await Promise.all([window.pnlApi.getSuggestion(), window.pnlApi.listCorrections()]);
    setSuggestion(s); setCorrections(list);
    setDataVersion(v => v + 1);
  }, []);

  useEffect(() => {
    void refreshCorrections();
    const off = window.pnlApi.onUpdate(() => { void refreshCorrections(); });
    return () => off();
  }, [refreshCorrections]);

  /** Records the suggested fill. The only path by which a correction is ever created. */
  const addSuggested = useCallback(async () => {
    if (!suggestion || suggestion.needsPrice) return;
    await window.pnlApi.addCorrection({
      side: suggestion.side, qty: suggestion.qty, price: suggestion.price,
      fillTime: suggestion.windowFrom, source: 'inferred from balance',
      windowFrom: suggestion.windowFrom, windowTo: suggestion.windowTo,
      reason: 'closed by the broker but absent from TradingView’s records',
    });
    setDismissed(false);
    await refreshCorrections();
  }, [suggestion, refreshCorrections]);

  // Kept in a ref so the push handler above always re-selects the day being viewed.
  const selectedRef = React.useRef('');
  useEffect(() => { selectedRef.current = selected; }, [selected]);

  useEffect(() => {
    if (!selected) { setDetail(null); return; }
    let alive = true;
    void window.pnlApi.getDetail(selected).then(d => { if (alive) setDetail(d); });
    return () => { alive = false; };
  }, [selected, state?.importedAt, dataVersion]);

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
  const rangeDetail: SessionDetail = {
    sessionDate: '', session: null, trades: rangeTrades, fills: rangeFills, boundary: null,
  };
  // What the window is showing, said twice: by name and by the hours it covers.
  const shownLabel = isRange ? range.rangeLabel(activeRange)
                    : (viewDates[0] === today ? 'Today' : (viewDates[0] || ''));
  const windowText = range.rangeWindowLabel({ dates: viewDates }, dayMode);

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

      {suggestion && !dismissed && (
        <MissingFillBanner suggestion={suggestion} onAdd={() => { void addSuggested(); }}
                           onDismiss={() => setDismissed(true)} />
      )}

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
        <span className="daymode">
          {range.DAY_MODES.map(m => (
            <button key={m.key}
                    className={`period${dayMode === m.key ? ' active' : ''}`}
                    onClick={() => chooseDayMode(m.key)}
                    title={m.key === 'trading'
                      ? "AMP's trading day: 17:00–17:00 CT, named for the day it ends"
                      : 'Midnight to midnight CT — for display only'}>{m.label}</button>
          ))}
        </span>
      </nav>

      {windowText && (
        <div className="window-note">
          <span>{shownLabel} = {windowText}</span>
          {calendarMode && <span className="calendar-warn">{range.CALENDAR_NOTE}</span>}
        </div>
      )}

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
                      ticked={ticked} onTick={toggleTick} onClearTicks={() => setTicked(new Set())}
                      calendarMode={calendarMode} />
          : calendarMode
            ? (tab === 'summary'
                ? <RangeSummary combined={calendarCombined} label={shownLabel}
                                dayWord="calendar days" note={range.CALENDAR_NOTE} />
              : tab === 'trades' ? <Trades detail={rangeDetail} />
              : <Fills detail={rangeDetail} />)
          : isRange
            ? (tab === 'summary' ? <RangeSummary combined={combined} label={range.rangeLabel(activeRange)} />
             : tab === 'trades'  ? <Trades detail={rangeDetail} />
             : <Fills detail={rangeDetail} />)
            : !hasData
              ? <Empty state={state} />
              : tab === 'summary' ? <><Summary detail={detail!} state={state} />
                  <CorrectionList corrections={corrections}
                                  onRemove={(id) => { void window.pnlApi.removeCorrection(id).then(refreshCorrections); }} /></>
              : tab === 'trades'  ? <Trades detail={detail!} />
              : <Fills detail={detail!} />}
      </main>
    </div>
  );
}
