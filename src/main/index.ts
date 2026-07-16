import 'dotenv/config';
import { app, BrowserWindow, Tray, Menu, nativeImage, ipcMain, screen, dialog, shell } from 'electron';
import fs from 'fs';
import path from 'path';
import { runAnalysis, getSnapshot, disconnect, setStatusCallback, setCdpPort, setApiKeyOverride, resetConnection, getKeyStatus, evalPage } from './bridge';
import { registerAlert, checkCrossings, clearAlertForPrice, getArmedPrices } from './alert-monitor';
import { writeLevel, writeLevels, clearAll as clearAllLevels, buildAnnotations, invalidateStudyCache, writeTradePlan, clearTradePlan, writePatternMarkers, writeConfidence } from './annotator';
import { notifyVerdict, resetNotifier } from './notifier';
import { submitMarketOrder, getCooldownStatus, getTradeWindowStatus } from './order-executor';
import { PnlTracker } from './pnl-tracker';
import type { FeeConfig } from './fee-calculator';
import { loadSettings, saveSettings, getSettings } from './settings';
import { TradeStore } from './trade-store';
import type { AnalysisResult, PatternMarker, AlertCreatePayload } from '../shared/types';
import { Scheduler } from './scheduler';
import { IPC } from '../shared/types';
import { parsePrice } from '../shared/utils';
import { formatAsHtml, docName } from './google-doc-formatter';

// ── Confidence gate ───────────────────────────────────────────────────────

function readMinConfidence(): number {
  try {
    const raw = fs.readFileSync(
      path.join(app.getAppPath(), 'config', 'config.json'), 'utf-8'
    );
    const cfg = JSON.parse(raw) as { filter?: { minConfidence?: number } };
    return cfg.filter?.minConfidence ?? 0;
  } catch {
    return 0;
  }
}

// ── Window state persistence ──────────────────────────────────────────────

interface WindowState {
  x?: number;
  y?: number;
  width: number;
  height: number;
  alwaysOnTop: boolean;
}

const STATE_PATH = path.join(app.getPath('userData'), 'window-state.json');
const MIN_WIDTH  = 380;
const MIN_HEIGHT = 500;
const DEF_WIDTH  = 420;
const DEF_HEIGHT = 700;

function loadState(): WindowState {
  try {
    return { width: DEF_WIDTH, height: DEF_HEIGHT, alwaysOnTop: true,
             ...JSON.parse(fs.readFileSync(STATE_PATH, 'utf8')) };
  } catch {
    return { width: DEF_WIDTH, height: DEF_HEIGHT, alwaysOnTop: true };
  }
}

function saveState(win: BrowserWindow): void {
  try {
    const b = win.getBounds();
    fs.writeFileSync(STATE_PATH, JSON.stringify({
      x: b.x, y: b.y, width: b.width, height: b.height,
      alwaysOnTop: win.isAlwaysOnTop(),
    }));
  } catch { /* ignore */ }
}

// ── Globals ───────────────────────────────────────────────────────────────

let mainWindow: BrowserWindow | null = null;
let tray:       Tray           | null = null;
let scheduler:  Scheduler      | null = null;
let lastResult: AnalysisResult | null = null;

let pnlTracker:      PnlTracker     | null = null;
let tradeStore:      TradeStore     | null = null;
let schedulerStarted = false;
let isQuitting       = false;
let firstShow        = false; // set to true when no saved position exists
let saveTimer:       ReturnType<typeof setTimeout> | null = null;

function debounceSave(win: BrowserWindow): void {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => { saveState(win); saveTimer = null; }, 500);
}

// ── Context menu ──────────────────────────────────────────────────────────

function rebuildMenu(): void {
  if (!tray || !mainWindow) return;
  const visible = mainWindow.isVisible();
  tray.setContextMenu(Menu.buildFromTemplate([
    {
      label: visible ? 'Hide Panel' : 'Show Panel',
      click: () => toggleWindow(),
    },
    {
      label: 'Refresh Now',
      click: () => scheduler?.triggerNow(),
    },
    { type: 'separator' },
    {
      label: 'Always on Top',
      type: 'checkbox',
      checked: mainWindow.isAlwaysOnTop(),
      click: (item) => {
        mainWindow?.setAlwaysOnTop(item.checked, 'floating');
        if (mainWindow) saveState(mainWindow);
        rebuildMenu();
      },
    },
    { type: 'separator' },
    {
      label: 'Open Journal',
      click: () => shell.openExternal('http://localhost:3001'),
    },
    { type: 'separator' },
    { label: 'Quit', click: () => { isQuitting = true; app.quit(); } },
  ]));
}

// ── Window toggle ─────────────────────────────────────────────────────────

function toggleWindow(): void {
  if (!mainWindow) return;
  if (mainWindow.isVisible() && !mainWindow.isMinimized()) {
    mainWindow.hide();
  } else {
    if (firstShow) {
      positionNearTray(mainWindow);
      firstShow = false;
    }
    // showInactive — appear on the current Space without stealing focus
    mainWindow.showInactive();
    startSchedulerOnce();
  }
  rebuildMenu();
}

function startSchedulerOnce(): void {
  if (!schedulerStarted) {
    schedulerStarted = true;
    if (getSettings().autoRefresh !== false) {
      scheduler?.start();
    }
  }
}

// ── First-launch positioning ──────────────────────────────────────────────

function positionNearTray(win: BrowserWindow): void {
  if (!tray) return;
  const tb = tray.getBounds();
  const wb = win.getBounds();
  const { workArea } = screen.getDisplayMatching(tb);

  let x = Math.round(tb.x + tb.width / 2 - wb.width / 2);
  const aboveTaskbar = tb.y > workArea.y + workArea.height / 2;
  let y = aboveTaskbar
    ? tb.y - wb.height - 4
    : tb.y + tb.height + 4;

  x = Math.max(workArea.x, Math.min(x, workArea.x + workArea.width  - wb.width));
  y = Math.max(workArea.y, Math.min(y, workArea.y + workArea.height - wb.height));
  win.setPosition(x, y);
}

// ── App ───────────────────────────────────────────────────────────────────

function resolveTradePlanNumbers(result: AnalysisResult): { entry: number; stop: number; target: number } | null {
  const tp  = result.commentary.trade_plan;
  const hpt = result.commentary.highest_probability_trade;

  // HPT has priority — it is always the highest-conviction setup.
  if (hpt) {
    const entry  = parsePrice(hpt.entry_zone);
    const stop   = parsePrice(hpt.stop);
    const target = parsePrice(hpt.targets);
    if (entry != null && stop != null && target != null) {
      return { entry, stop, target };
    }
  }
  // Fallback to trade_plan exact numeric values.
  if (tp && tp.entry != null && tp.stop != null && tp.target != null) {
    return { entry: tp.entry, stop: tp.stop, target: tp.target };
  }
  return null;
}

// Build stop/target from configured dollar amounts so R:R is always consistent.
// MES: 1 tick = $1.25, tick size = 0.25 pts.
function configuredBracket(entry: number, dir: 'long' | 'short'): { stop: number; target: number } {
  const s = getSettings();
  const TICK_VALUE = 1.25;
  const TICK_SIZE  = 0.25;
  const stopOffset   = Math.round(s.autoTradeStopDollars   / TICK_VALUE) * TICK_SIZE;
  const targetOffset = Math.round(s.autoTradeTargetDollars / TICK_VALUE) * TICK_SIZE;
  return dir === 'long'
    ? { stop: entry - stopOffset, target: entry + targetOffset }
    : { stop: entry + stopOffset, target: entry - targetOffset };
}

function autoDrawResult(result: AnalysisResult): void {
  const levels = result.commentary.key_levels_to_watch;
  if (levels && levels.length > 0) {
    writeLevels(buildAnnotations(levels, result.closedBarPrice, getArmedPrices()))
      .catch(err => console.error('[auto-draw levels]', (err as Error).message));
  }

  const bracket = resolveTradePlanNumbers(result);
  if (bracket) {
    writeTradePlan(bracket.entry, bracket.stop, bracket.target)
      .catch(err => console.error('[auto-draw tp]', (err as Error).message));
  } else {
    clearTradePlan()
      .catch(err => console.error('[auto-draw tp clear]', (err as Error).message));
  }

  const patterns = result.commentary.candlestick_patterns;
  if (patterns && patterns.length > 0) {
    const markers: PatternMarker[] = patterns.slice(0, 4).map(p => ({
      bar_offset: p.bar_offset,
      label:      p.name.slice(0, 12),
      signal:     p.signal === 'bullish' ? 1 : p.signal === 'bearish' ? -1 : 0,
    }));
    writePatternMarkers(markers)
      .catch(err => console.error('[auto-draw markers]', (err as Error).message));
  } else {
    writePatternMarkers([])
      .catch(err => console.error('[auto-draw markers clear]', (err as Error).message));
  }

  const pct = Math.round((result.commentary.confidence ?? 0) * 100);
  const verdict = result.commentary.setup_verdict;
  const dir = verdict === 'valid_long' || verdict === 'valid_long_was' ? 'Long'
            : verdict === 'valid_short' || verdict === 'valid_short_was' ? 'Short'
            : '';
  writeConfidence(pct, dir)
    .catch(err => console.error('[auto-draw confidence]', (err as Error).message));

}

app.on('ready', () => {
  const initialSettings = loadSettings();
  // Apply persisted overrides so bridge/scheduler honour stored settings from first use
  setCdpPort(initialSettings.cdpPort);
  if (initialSettings.apiKeyOverride) setApiKeyOverride(initialSettings.apiKeyOverride);
  app.dock?.hide();

  // Tray
  const icon = nativeImage.createFromPath(
    path.join(app.getAppPath(), 'assets', 'iconTemplate.png')
  );
  icon.setTemplateImage(true);
  tray = new Tray(icon);
  tray.setToolTip('Trading Analyzer');

  // Window
  const state = loadState();
  firstShow = state.x === undefined;

  mainWindow = new BrowserWindow({
    x:               state.x,
    y:               state.y,
    width:           Math.max(state.width, MIN_WIDTH),
    height:          Math.max(state.height, MIN_HEIGHT),
    minWidth:        MIN_WIDTH,
    minHeight:       MIN_HEIGHT,
    show:            false,
    frame:           false,
    resizable:       true,
    skipTaskbar:     true,
    backgroundColor: '#1e222d',
    webPreferences: {
      nodeIntegration:  false,
      contextIsolation: true,
      sandbox:          false, // required: preload uses require() for local modules
      preload:          path.join(__dirname, 'preload.js'),
    },
  });

  mainWindow.setAlwaysOnTop(state.alwaysOnTop, 'floating');
  // Appear on whichever Space the user is on — no Desktop switching
  mainWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: false });

  // Load content in background (equivalent to menubar's preloadWindow: true)
  if (app.isPackaged) {
    mainWindow.loadFile(path.join(app.getAppPath(), 'dist', 'renderer', 'index.html'));
  } else {
    mainWindow.loadURL('http://localhost:5173');
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  }

  // Hide instead of destroy when the user closes the window
  mainWindow.on('close', (e) => {
    if (!isQuitting) { e.preventDefault(); mainWindow?.hide(); rebuildMenu(); }
  });

  // Persist state on move / resize
  mainWindow.on('moved',   () => debounceSave(mainWindow!));
  mainWindow.on('resized', () => debounceSave(mainWindow!));

  // Both click and right-click show the same menu — menu contains Show/Hide Panel
  tray.on('click',       () => { rebuildMenu(); tray?.popUpContextMenu(); });
  tray.on('right-click', () => { rebuildMenu(); tray?.popUpContextMenu(); });

  rebuildMenu();

  // Trade journal store (standalone journal server runs separately via `pnpm journal`)
  tradeStore = new TradeStore(app.getPath('userData'));

  // Watch for journal-reset signal written by the journal server's DELETE /api/trades.
  // The journal server uses sql.js (raw file I/O) which bypasses SQLite's lock protocol,
  // so we must perform the actual DELETE through better-sqlite3's live connection here.
  const resetSignalPath = path.join(app.getPath('userData'), 'trades.db.reset');
  setInterval(() => {
    if (fs.existsSync(resetSignalPath)) {
      try { fs.unlinkSync(resetSignalPath); } catch { /* ignore race */ }
      tradeStore?.clearAll();
      // Notify the journal server that drop+recreate is complete
      try { fs.writeFileSync(resetSignalPath + '.done', '1'); } catch { /* ignore */ }
      console.log('[index] journal reset complete — schema rebuilt, done signal written');
    }
  }, 2000);

  // P&L tracker
  pnlTracker = new PnlTracker(
    (snap) => { mainWindow?.webContents.send(IPC.PNL_PUSH, snap); },
    () => {
      const s = getSettings();
      return {
        perContractFee:      s.feePerContract,
        liquidationDaily:    s.feeLiquidationDaily,
        dataFeedMonthly:     s.feeDataMonthly,
        tradingDaysPerMonth: s.feeTradingDays,
      } satisfies FeeConfig;
    },
    tradeStore,
  );
  pnlTracker.start();

  // Scheduler
  scheduler = new Scheduler(
    (result) => {
      lastResult = result;
      mainWindow?.webContents.send(IPC.ANALYSIS_PUSH, result);
      const sv = result.commentary.setup_verdict;
      const conf = result.commentary.confidence ?? 1;
      const minConf = readMinConfidence();
      const confOk = conf >= minConf;
      console.log(`[auto-trade] verdict=${sv} conf=${(conf * 100).toFixed(0)}% confOk=${confOk} autoTrade=${getSettings().autoTrade}`);
      if (!confOk && minConf > 0) {
        console.log(`[auto-trade] skipped — confidence ${(conf * 100).toFixed(0)}% < min ${(minConf * 100).toFixed(0)}%`);
      }
      const willTrade = getSettings().autoTrade && (sv === 'valid_long' || sv === 'valid_short') && confOk;
      if (getSettings().notifications && !willTrade) {
        notifyVerdict(sv, result.commentary.headline);
      }
      if (getSettings().autoTrade && (sv === 'valid_long' || sv === 'valid_short') && confOk) {
        const bracket = resolveTradePlanNumbers(result);
        if (bracket) {
          const dir = sv === 'valid_long' ? 'long' : 'short';
          const cb  = configuredBracket(bracket.entry, dir);
          console.log(`[auto-trade] FIRING ${dir.toUpperCase()} entry=${bracket.entry} stop=${cb.stop} target=${cb.target}`);
          submitMarketOrder(dir, cb.stop, cb.target, bracket.entry, getSettings().autoTradeTrailingStop)
            .then(outcome => {
              console.log('[auto-trade]', outcome);
              if (outcome === 'submitted' && tradeStore) {
                tradeStore.recordEntry({
                  symbol:        result.symbol,
                  timeframe:     result.timeframe,
                  direction:     dir,
                  entry_price:   bracket.entry,
                  stop_price:    cb.stop,
                  target_price:  cb.target,
                  trailing_stop: getSettings().autoTradeTrailingStop,
                  rr_planned:    result.commentary.trade_plan?.rr ?? null,
                  verdict:       sv as 'valid_long' | 'valid_short',
                  headline:      result.commentary.headline ?? null,
                  objective:     result.commentary.objective ?? null,
                  steps_json:    JSON.stringify(result.commentary.steps_what_happened ?? []),
                  structure:     result.commentary.structure_read ?? null,
                  rationale:     result.commentary.trade_plan?.rationale ?? null,
                  patterns_json: JSON.stringify(
                    result.commentary.candlestick_patterns?.map(p => p.name) ?? []
                  ),
                  confidence:    result.commentary.confidence ?? null,
                });
              }
            })
            .catch(err => console.error('[auto-trade] error:', (err as Error).message));
        } else {
          console.warn('[auto-trade] skipped — no entry in trade_plan or HPT');
        }
      }
      if (getSettings().autoDraw) autoDrawResult(result);
    },
    (err) => {
      // Status only — never push error objects as ANALYSIS_PUSH (renderer expects AnalysisResult)
      mainWindow?.webContents.send(IPC.ANALYZE_STATUS, 'error');
      console.error('[scheduler] background analysis failed:', err.message);
    },
    (status) => {
      mainWindow?.webContents.send(IPC.ANALYZE_STATUS, status);
    },
    (nextMs) => {
      mainWindow?.webContents.send(IPC.SCHEDULER_NEXT_TICK, nextMs);
    },
  );

  // IPC: on-demand analysis (awaitable; status updates via callback)
  ipcMain.handle(IPC.ANALYZE_RUN, async () => {
    setStatusCallback((status) => {
      mainWindow?.webContents.send(IPC.ANALYZE_STATUS, status);
    });
    try {
      const result = await runAnalysis();
      lastResult = result;
      mainWindow?.webContents.send(IPC.ANALYZE_STATUS, 'complete');
      const sv2 = result.commentary.setup_verdict;
      const conf2 = result.commentary.confidence ?? 1;
      const minConf2 = readMinConfidence();
      const confOk2 = conf2 >= minConf2;
      console.log(`[auto-trade] verdict=${sv2} conf=${(conf2 * 100).toFixed(0)}% confOk=${confOk2} autoTrade=${getSettings().autoTrade}`);
      if (!confOk2 && minConf2 > 0) {
        console.log(`[auto-trade] skipped — confidence ${(conf2 * 100).toFixed(0)}% < min ${(minConf2 * 100).toFixed(0)}%`);
      }
      const willTrade2 = getSettings().autoTrade && (sv2 === 'valid_long' || sv2 === 'valid_short') && confOk2;
      if (getSettings().notifications && !willTrade2) {
        notifyVerdict(sv2, result.commentary.headline);
      }
      if (getSettings().autoTrade && (sv2 === 'valid_long' || sv2 === 'valid_short') && confOk2) {
        const bracket2 = resolveTradePlanNumbers(result);
        if (bracket2) {
          const dir2 = sv2 === 'valid_long' ? 'long' : 'short';
          const cb2  = configuredBracket(bracket2.entry, dir2);
          console.log(`[auto-trade] FIRING ${dir2.toUpperCase()} entry=${bracket2.entry} stop=${cb2.stop} target=${cb2.target}`);
          submitMarketOrder(dir2, cb2.stop, cb2.target, bracket2.entry, getSettings().autoTradeTrailingStop)
            .then(outcome => {
              console.log('[auto-trade]', outcome);
              if (outcome === 'submitted' && tradeStore) {
                tradeStore.recordEntry({
                  symbol:        result.symbol,
                  timeframe:     result.timeframe,
                  direction:     dir2,
                  entry_price:   bracket2.entry,
                  stop_price:    cb2.stop,
                  target_price:  cb2.target,
                  trailing_stop: getSettings().autoTradeTrailingStop,
                  rr_planned:    result.commentary.trade_plan?.rr ?? null,
                  verdict:       sv2 as 'valid_long' | 'valid_short',
                  headline:      result.commentary.headline ?? null,
                  objective:     result.commentary.objective ?? null,
                  steps_json:    JSON.stringify(result.commentary.steps_what_happened ?? []),
                  structure:     result.commentary.structure_read ?? null,
                  rationale:     result.commentary.trade_plan?.rationale ?? null,
                  patterns_json: JSON.stringify(
                    result.commentary.candlestick_patterns?.map(p => p.name) ?? []
                  ),
                  confidence:    result.commentary.confidence ?? null,
                });
              }
            })
            .catch(e2 => console.error('[auto-trade] error:', (e2 as Error).message));
        } else {
          console.warn('[auto-trade] skipped — no entry in trade_plan or HPT');
        }
      }
      if (getSettings().autoDraw) autoDrawResult(result);
      return result;
    } catch (err) {
      mainWindow?.webContents.send(IPC.ANALYZE_STATUS, 'error');
      throw err;
    }
  });

  // IPC: raw snapshot
  ipcMain.handle(IPC.SNAPSHOT_RAW, async () => getSnapshot());

  // IPC: annotation — toggle one slot (partial 5-input write)
  ipcMain.handle(IPC.ANNOTATE_TOGGLE, async (_e, slotIndex: number, price: number, kind: string, label: string, visible: number, priority: string = 'primary') => {
    await writeLevel(slotIndex, price, kind, label, visible, priority);
  });

  // IPC: annotation — write all levels at once (all 40 inputs)
  ipcMain.handle(IPC.ANNOTATE_DRAW_ALL, async (_e, levels: import('../shared/types').LevelAnnotation[]) => {
    await writeLevels(levels);
  });

  // IPC: annotation — zero out all 8 slots
  ipcMain.handle(IPC.ANNOTATE_CLEAR_ALL, async () => {
    await clearAllLevels();
  });

  // IPC: settings
  ipcMain.handle(IPC.SETTINGS_GET, () => getSettings());
  ipcMain.handle(IPC.SETTINGS_UPDATE, (_e, partial: Partial<import('../shared/types').AppSettings>) => {
    const updated = { ...getSettings(), ...partial };
    saveSettings(updated);

    if ('cdpPort' in partial && partial.cdpPort !== undefined) {
      setCdpPort(partial.cdpPort);
    }
    if ('apiKeyOverride' in partial && partial.apiKeyOverride !== undefined) {
      setApiKeyOverride(partial.apiKeyOverride);
    }
    if ('autoRefresh' in partial) {
      if (partial.autoRefresh && schedulerStarted && scheduler && !scheduler.isRunning()) {
        scheduler.resume();
      } else if (!partial.autoRefresh && scheduler?.isRunning()) {
        scheduler.stop();
      }
    }

    return updated;
  });

  // IPC: scheduler pause / resume
  ipcMain.handle(IPC.SCHEDULER_PAUSE, () => { scheduler?.stop(); });
  ipcMain.handle(IPC.SCHEDULER_RESUME, () => {
    if (schedulerStarted) scheduler?.resume(); else startSchedulerOnce();
  });

  // IPC: P&L
  ipcMain.handle(IPC.PNL_GET, () => pnlTracker?.getSnapshot() ?? null);

  // IPC: trade plan bracket
  ipcMain.handle(IPC.ANNOTATE_TRADE_PLAN, async (_e, entry: number, stop: number, target: number) => {
    await writeTradePlan(entry, stop, target);
  });
  ipcMain.handle(IPC.ANNOTATE_CLEAR_TRADE_PLAN, async () => {
    await clearTradePlan();
  });

  // IPC: candle pattern markers
  ipcMain.handle(IPC.ANNOTATE_PATTERN_MARKERS, async (_e, markers: PatternMarker[]) => {
    await writePatternMarkers(markers);
  });

  // IPC: register a local price-crossing alert for a level
  ipcMain.handle(IPC.ALERT_CREATE, async (_e, payload: AlertCreatePayload) => {
    try {
      const symbol = await evalPage("window.TradingViewApi.activeChart().symbol()") as string;
      registerAlert(payload.price, payload.label, symbol);
      return { ok: true, alertId: 'local' };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  });

  // IPC: remove a local price-crossing alert
  ipcMain.handle(IPC.ALERT_REMOVE, (_e, price: number) => { clearAlertForPrice(price); });

  // IPC: manual test trigger for order-executor (bypasses autoTrade setting)
  ipcMain.handle(IPC.AUTO_TRADE_TEST, (_e, direction: 'long' | 'short', stop: number, target: number, entry: number) =>
    submitMarketOrder(direction, stop, target, entry, false, true)
  );

  // IPC: delete cooldown file so the next trade can fire immediately
  ipcMain.handle(IPC.COOLDOWN_STATUS, () => getCooldownStatus());
  ipcMain.handle(IPC.TRADE_WINDOW_STATUS, () => getTradeWindowStatus());

  ipcMain.handle(IPC.COOLDOWN_DELETE, () => {
    const cooldownPath = path.join(app.getPath('userData'), 'order-cooldown.json');
    try {
      fs.unlinkSync(cooldownPath);
      console.log('[cooldown] deleted', cooldownPath);
      return { deleted: true };
    } catch {
      return { deleted: false };
    }
  });

  // IPC: force CDP reconnect
  ipcMain.handle(IPC.BRIDGE_RECONNECT, () => { resetConnection(); invalidateStudyCache(); resetNotifier(); });

  // IPC: API key status
  ipcMain.handle(IPC.SETTINGS_KEY_STATUS, () => getKeyStatus());

  // IPC: Export analysis as local HTML file
  ipcMain.handle(IPC.GDRIVE_EXPORT, async () => {
    if (!lastResult) throw new Error('No analysis result to export');
    const defaultName = docName(lastResult) + '.html';
    const { canceled, filePath } = await dialog.showSaveDialog({
      defaultPath: path.join(app.getPath('desktop'), defaultName),
      filters: [{ name: 'HTML', extensions: ['html'] }],
    });
    if (canceled || !filePath) return { cancelled: true };
    await fs.promises.writeFile(filePath, formatAsHtml(lastResult), 'utf-8');
    shell.showItemInFolder(filePath);
    return { filePath };
  });

  // IPC: app version
  ipcMain.handle(IPC.APP_VERSION, () => app.getVersion());

  // Price-crossing alert poller — checks every 5 s, fires macOS notification on cross
  const PRICE_POLL_EXPR = `(() => {
    try {
      const chart = window.TradingViewApi.activeChart();
      const series = chart.getSeries();
      const bars = series.data().m_bars;
      const last = bars.valueAt(bars.size() - 1);
      return { price: last[4], symbol: chart.symbol() };
    } catch(e) { return null; }
  })()`;

  setInterval(async () => {
    try {
      const result = await evalPage(PRICE_POLL_EXPR);
      if (result && typeof (result as { price: number; symbol: string }).price === 'number') {
        const { price, symbol } = result as { price: number; symbol: string };
        checkCrossings(price, symbol);
      }
    } catch (_) { /* CDP not connected — skip silently */ }
  }, 5000);
});

app.on('before-quit', () => {
  isQuitting = true;
  pnlTracker?.stop();
  void disconnect();
});
