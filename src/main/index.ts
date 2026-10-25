import 'dotenv/config';
import { app, BrowserWindow, Tray, Menu, nativeImage, ipcMain, screen, dialog, shell } from 'electron';
import fs from 'fs';
import path from 'path';
import { runAnalysis, getSnapshot, disconnect, setStatusCallback, setCdpPort, setApiKeyOverride, resetConnection, getKeyStatus, evalPage, setLessonsProvider, getPricePollExpr, peekBars, getActiveModelId } from './bridge';
import { registerAlert, checkCrossings, clearAlertForPrice, getArmedPrices } from './alert-monitor';
import { writeLevel, writeLevels, clearAll as clearAllLevels, buildAnnotations, invalidateStudyCache, writeTradePlan, clearTradePlan, writePatternMarkers, writeConfidence } from './annotator';
import { notifyVerdict, resetNotifier } from './notifier';
import { submitMarketOrder, getCooldownStatus, getTradeWindowStatus } from './order-executor';
import { PnlTracker } from './pnl-tracker';
import type { FeeConfig } from './fee-calculator';
import { loadSettings, saveSettings, getSettings } from './settings';
import { TradeStore } from './trade-store';
import { analysisErrorPayload } from './status-payload';
import { RecommendationStore } from './recommendation-store';
import { GradeRunner } from './grade-runner';
import type { AnalysisResult, PatternMarker, AlertCreatePayload, AutoTradeOutcome, AutoTradeStatus } from '../shared/types';
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
let recStore:        RecommendationStore | null = null;
let gradeRunner:     GradeRunner    | null = null;
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

/** Push one auto-trade decision (and its reason) to the panel. */
function pushAutoTradeStatus(
  outcome: AutoTradeOutcome,
  reason: string,
  direction?: 'long' | 'short',
): void {
  console.log(`[auto-trade] ${outcome}: ${reason}`);
  const status: AutoTradeStatus = { outcome, reason, at: Date.now(), direction };
  mainWindow?.webContents.send(IPC.AUTO_TRADE_STATUS, status);
}

/**
 * The single auto-trade decision path, shared by the scheduler and by on-demand
 * analysis (these were two near-identical copies).
 *
 * Every branch that declines to trade now reports WHY via pushAutoTradeStatus,
 * so the panel can answer "why isn't it trading?" without a console trace.
 */
function evaluateAutoTrade(result: AnalysisResult): void {
  const sv          = result.commentary.setup_verdict;
  const conf        = result.commentary.confidence ?? 1;
  const minConf     = readMinConfidence();
  const confOk      = conf >= minConf;
  const enabled     = getSettings().autoTrade;
  const directional = sv === 'valid_long' || sv === 'valid_short';
  const pct         = (n: number) => `${(n * 100).toFixed(0)}%`;

  console.log(`[auto-trade] verdict=${sv} conf=${pct(conf)} confOk=${confOk} autoTrade=${enabled}`);

  const willTrade = enabled && directional && confOk;
  // A call the rules lever blocked must not ping Jim — it is recorded and graded
  // in the background, but it is explicitly not something to act on.
  if (getSettings().notifications && !willTrade && !result.blocked) {
    notifyVerdict(sv, result.commentary.headline);
  }

  // Auto-trade switched off — nothing to report, the UI hides the row anyway.
  if (!enabled) return;

  if (!directional) {
    pushAutoTradeStatus('skipped', `No directional setup — verdict was "${sv}"`);
    return;
  }
  if (!confOk) {
    pushAutoTradeStatus('skipped', `Confidence ${pct(conf)} is below the ${pct(minConf)} minimum`);
    return;
  }

  const bracket = resolveTradePlanNumbers(result);
  if (!bracket) {
    pushAutoTradeStatus('skipped', 'No entry/stop/target in the trade plan');
    return;
  }

  const dir = sv === 'valid_long' ? 'long' : 'short';
  const cb  = configuredBracket(bracket.entry, dir);
  console.log(`[auto-trade] FIRING ${dir.toUpperCase()} entry=${bracket.entry} stop=${cb.stop} target=${cb.target}`);
  pnlTracker?.suppressNextEntry();

  submitMarketOrder(dir, cb.stop, cb.target, bracket.entry, getSettings().autoTradeTrailingStop)
    .then(attempt => {
      pushAutoTradeStatus(attempt.outcome, attempt.reason, dir);
      if (attempt.outcome === 'submitted' && tradeStore) {
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
          account_type:  pnlTracker?.getSnapshot().accountType ?? null,
        });
      }
    })
    .catch(err => pushAutoTradeStatus('error', (err as Error).message, dir));
}

// Shared CommonJS module (not compiled by tsc) — loaded the same way bridge.ts
// loads src/shared/*.js. Pure and dependency-free.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { setupKeyFor } = require(path.join(app.getAppPath(), 'src/shared/setup-normaliser')) as {
  setupKeyFor(labels: unknown): string;
};

// eslint-disable-next-line @typescript-eslint/no-require-imports
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { detectSkippedBars } = require(path.join(app.getAppPath(), 'src/shared/pacing')) as {
  detectSkippedBars(prev: number | null, curr: number, timeframe: string, analysisMs: number | null):
    { message: string } | null;
};

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { evaluateRules, rulesVersion } = require(path.join(app.getAppPath(), 'src/shared/rules')) as {
  evaluateRules(call: { setup_key: string | null; confidence: number | null; bar_time: number },
                rules: unknown): { blocked: boolean; reason: string | null };
  rulesVersion(rules: unknown, appVersion: string): string;
};

// Haiku 4.5 list price. Cost is derived from the usage the API reports, never
// estimated from character counts.
const USD_PER_INPUT_MTOK  = 1.0;
const USD_PER_OUTPUT_MTOK = 5.0;

/** Dollar cost of one analysis from its reported token usage. */
function costOf(inputTokens: number | null, outputTokens: number | null): number | null {
  if (inputTokens === null && outputTokens === null) return null;
  return ((inputTokens ?? 0) / 1e6) * USD_PER_INPUT_MTOK
       + ((outputTokens ?? 0) / 1e6) * USD_PER_OUTPUT_MTOK;
}

/** The rules in force right now, and their stable version hash. */
function currentRules(): { rules: unknown; version: string } {
  const rules = getSettings().rules;
  return { rules, version: rulesVersion(rules, app.getVersion()) };
}

/**
 * Save one recommendation at bar close — every verdict, not just tradeable ones.
 * Deduped on symbol+timeframe+bar+mode, so a manual refresh cannot double-count.
 */
function saveRecommendation(result: AnalysisResult): { blocked: boolean; reason: string | null; version: string } {
  const fallback = { blocked: false, reason: null as string | null, version: '' };
  if (!recStore) return fallback;
  try {
    const c    = result.commentary;
    const plan = c.trade_plan ?? null;
    const dir  = plan?.direction === 'long' || plan?.direction === 'short'
      ? plan.direction
      : c.setup_verdict === 'valid_long' ? 'long'
      : c.setup_verdict === 'valid_short' ? 'short'
      : 'none';

    // Setup labels: the detected patterns plus the named high-probability setup.
    const setups: string[] = [
      ...(c.candlestick_patterns?.map(p => p.name) ?? []),
      ...(c.highest_probability_trade?.setup ? [c.highest_probability_trade.setup] : []),
    ].filter(Boolean);

    const setupKey = setupKeyFor(setups);
    const { rules, version } = currentRules();
    // The lever runs AFTER analysis, so blocking never changes what the model said.
    const verdict = evaluateRules(
      { setup_key: setupKey, confidence: typeof c.confidence === 'number' ? c.confidence : null,
        bar_time: result.closedBarTime },
      rules,
    );

    const usage = (c as unknown as { usage?: { inputTokens: number | null; outputTokens: number | null } }).usage ?? null;
    const inTok  = usage ? usage.inputTokens  : null;
    const outTok = usage ? usage.outputTokens : null;

    const id = recStore.save({
      created_at:   Date.now(),
      symbol:       result.symbol,
      timeframe:    result.timeframe,
      bar_time:     result.closedBarTime,
      bar_price:    result.closedBarPrice ?? null,
      verdict:      c.setup_verdict,
      direction:    dir,
      confidence:   typeof c.confidence === 'number' ? c.confidence : null,
      entry:        plan?.entry  ?? null,
      stop:         plan?.stop   ?? null,
      target:       plan?.target ?? null,
      rr_planned:   plan?.rr     ?? null,
      setups_json:  JSON.stringify(setups),
      setup_key:    setupKey,
      blocked:        verdict.blocked ? 1 : 0,
      blocked_reason: verdict.reason,
      rules_version:  version,
      input_tokens:   inTok,
      output_tokens:  outTok,
      cost_usd:       costOf(inTok, outTok),
      analysis_ms:    typeof result.analysisMs === 'number' ? result.analysisMs : null,
      structure:    c.structure_read ?? null,
      replay_mode:  result.replayMode ? 1 : 0,
      account_type: pnlTracker?.getSnapshot().accountType ?? null,
      app_version:  app.getVersion(),
      model_id:     getActiveModelId(),
      raw_json:     JSON.stringify(c).slice(0, 20000),
    });
    if (id === null) {
      console.log(`[recommendations] bar ${result.closedBarTime} already saved — skipped (dedup)`);
    }
    if (verdict.blocked) {
      console.log(`[recommendations] BLOCKED: ${verdict.reason}`);
    }
    return { blocked: verdict.blocked, reason: verdict.reason, version };
  } catch (err) {
    // Never let bookkeeping break the analysis pipeline.
    console.error('[recommendations] TVCM-REC-SAVE-FAILED:', (err as Error).message);
    return fallback;
  }
}

/**
 * Save the call, stamp the lever's verdict onto the result for the panel, then
 * grade whatever the fresh bars can now settle. Blocked calls are graded too —
 * shadow grading is how the scorecard shows what a rule costs.
 */
let lastAnalysedBarTime: number | null = null;

function recordAndGrade(result: AnalysisResult): void {
  // Replay stepped faster than the analysis? Then a bar went by with no call.
  if (result.replayMode) {
    const warn = detectSkippedBars(
      lastAnalysedBarTime, result.closedBarTime, result.timeframe,
      typeof result.analysisMs === 'number' ? result.analysisMs : null,
    );
    result.pacingWarning = warn ? warn.message : null;
    if (warn) console.warn(`[pacing] TVCM-TRAIN-BARS-SKIPPED: ${warn.message}`);
  }
  lastAnalysedBarTime = result.closedBarTime;

  const verdict = saveRecommendation(result);
  result.blocked = verdict.blocked;
  result.blockedReason = verdict.reason;
  result.rulesVersion = verdict.version;
  void gradeRunner?.run().catch((err: unknown) =>
    console.error('[grade-runner] TVCM-GRADE-FAILED:', (err as Error).message));
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
  setLessonsProvider(() => tradeStore?.getApprovedLessons() ?? []);
  // Share TradeStore's connection so trades.db keeps a single writer.
  recStore    = new RecommendationStore(tradeStore.database);
  gradeRunner = new GradeRunner(recStore, peekBars);
  // Fill setup_key on any rows written before the column existed.
  try {
    const filled = recStore.backfillSetupKeys((json) => setupKeyFor(json));
    if (filled > 0) console.log(`[recommendations] backfilled setup_key on ${filled} row(s)`);
  } catch (err) {
    console.error('[recommendations] TVCM-REC-BACKFILL-FAILED:', (err as Error).message);
  }
  // Catch up on anything left ungraded while the app was closed.
  void gradeRunner.run().catch((err: unknown) =>
    console.error('[grade-runner] startup catch-up failed:', (err as Error).message));

  // Watch for journal-reset signal written by the journal server's DELETE /api/trades.
  // The journal could now delete rows itself (it speaks real SQLite since TVCM-7), but
  // reset is more than a delete: clearAll() drops and rebuilds `trades` through
  // trade-store's own schema init and restarts the id counter. Keeping it here leaves
  // one owner of the table's shape instead of duplicating CREATE TABLE in two processes.
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
      // Stamp the lever verdict onto the result BEFORE pushing, so the panel can
      // say "Blocked: <rule>" instead of presenting it as an actionable call.
      recordAndGrade(result);
      mainWindow?.webContents.send(IPC.ANALYSIS_PUSH, result);
      evaluateAutoTrade(result);
      if (getSettings().autoDraw) autoDrawResult(result);
    },
    (err) => {
      // Never push error objects as ANALYSIS_PUSH (renderer expects AnalysisResult),
      // but DO send the message: a scheduled failure used to show only a red dot,
      // hiding coded reasons like TVCM-READ-EMPTY-BARS from everyone but the console.
      const payload = analysisErrorPayload(err);
      mainWindow?.webContents.send(IPC.ANALYZE_STATUS, payload.status, payload.message);
      console.error('[scheduler] background analysis failed:', payload.message);
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
      recordAndGrade(result);
      mainWindow?.webContents.send(IPC.ANALYZE_STATUS, 'complete');
      evaluateAutoTrade(result);
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
  ipcMain.handle(IPC.AUTO_TRADE_TEST, async (_e, direction: 'long' | 'short', stop: number, target: number, entry: number) => {
    // ignoreWindow=true bypasses the trading-window guard only. The replay
    // guard still applies — a manual test button must not fire a live order
    // from replayed prices either.
    const attempt = await submitMarketOrder(direction, stop, target, entry, false, true);
    pushAutoTradeStatus(attempt.outcome, attempt.reason, direction);
    return attempt;
  });

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

  // Price-crossing alert poller — checks every 5 s, fires macOS notification on cross.
  // The expression lives in tv-reader so it shares the bar-index-aware reader.
  const PRICE_POLL_EXPR = getPricePollExpr();

  // Latches the coded error so a persistent fault is logged once, not every 5 s.
  let alertNoBarLogged = false;

  setInterval(async () => {
    try {
      const result = (await evalPage(PRICE_POLL_EXPR)) as
        { price?: number; symbol?: string; error?: string } | null;
      if (result && typeof result.price === 'number' && result.symbol) {
        alertNoBarLogged = false;
        checkCrossings(result.price, result.symbol);
      } else if (result && result.error) {
        // Chart was reachable but no bar came back — name it instead of skipping.
        if (!alertNoBarLogged) {
          console.error(
            `[alert-poller] ${result.error}: chart is readable but no bar could be read — ` +
            'price-crossing alerts are not being checked',
          );
          alertNoBarLogged = true;
        }
      }
    } catch (_) { /* CDP not connected — skip silently */ }
  }, 5000);
});

app.on('before-quit', () => {
  isQuitting = true;
  pnlTracker?.stop();
  void disconnect();
});
