import 'dotenv/config';
import { app, BrowserWindow, Tray, Menu, nativeImage, ipcMain, screen } from 'electron';
import fs from 'fs';
import path from 'path';
import { runAnalysis, getSnapshot, disconnect, setStatusCallback, setCdpPort, setApiKeyOverride, resetConnection, getKeyStatus } from './bridge';
import { writeLevel, writeLevels, clearAll as clearAllLevels, buildAnnotations, invalidateStudyCache, writeTradePlan, clearTradePlan } from './annotator';
import { notifyVerdict, resetNotifier } from './notifier';
import { PnlTracker } from './pnl-tracker';
import type { FeeConfig } from './fee-calculator';
import { loadSettings, saveSettings, getSettings } from './settings';
import type { AnalysisResult } from '../shared/types';
import { Scheduler } from './scheduler';
import { IPC } from '../shared/types';
import { parsePrice } from '../shared/utils';

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

  if (tp && tp.entry != null && tp.stop != null && tp.target != null) {
    return { entry: tp.entry, stop: tp.stop, target: tp.target };
  }
  if (hpt) {
    const entry  = parsePrice(hpt.entry_zone);
    const stop   = parsePrice(hpt.stop);
    const target = parsePrice(hpt.targets);
    if (entry != null && stop != null && target != null) {
      return { entry, stop, target };
    }
  }
  return null;
}

function autoDrawResult(result: AnalysisResult): void {
  const levels = result.commentary.key_levels_to_watch;
  if (levels && levels.length > 0) {
    writeLevels(buildAnnotations(levels, result.closedBarPrice))
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
  );
  pnlTracker.start();

  // Scheduler
  scheduler = new Scheduler(
    (result) => {
      lastResult = result;
      mainWindow?.webContents.send(IPC.ANALYSIS_PUSH, result);
      if (getSettings().notifications) {
        notifyVerdict(result.commentary.setup_verdict, result.commentary.headline);
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
      if (getSettings().notifications) {
        notifyVerdict(result.commentary.setup_verdict, result.commentary.headline);
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

  // IPC: force CDP reconnect
  ipcMain.handle(IPC.BRIDGE_RECONNECT, () => { resetConnection(); invalidateStudyCache(); resetNotifier(); });

  // IPC: API key status
  ipcMain.handle(IPC.SETTINGS_KEY_STATUS, () => getKeyStatus());

  // IPC: app version
  ipcMain.handle(IPC.APP_VERSION, () => app.getVersion());
});

app.on('before-quit', () => {
  isQuitting = true;
  pnlTracker?.stop();
  void disconnect();
});
