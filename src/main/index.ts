import 'dotenv/config';
import { app, BrowserWindow, Tray, Menu, nativeImage, ipcMain, screen, dialog, shell } from 'electron';
import fs from 'fs';
import path from 'path';
import { runAnalysis, getSnapshot, disconnect, setStatusCallback, setCdpPort, setApiKeyOverride, resetConnection, getKeyStatus, evalPage, setLessonsProvider, getPricePollExpr, peekBars, getActiveModelId, connectionState } from './bridge';
import { registerAlert, checkCrossings, clearAlertForPrice, getArmedPrices } from './alert-monitor';
import { writeLevel, writeLevels, clearAll as clearAllLevels, buildAnnotations, invalidateStudyCache, writeTradePlan, clearTradePlan, writePatternMarkers, writeConfidence } from './annotator';
import { notifyVerdict, resetNotifier, notifyProblem } from './notifier';
import { submitMarketOrder, getCooldownStatus, getTradeWindowStatus } from './order-executor';
import { PnlTracker } from './pnl-tracker';
import { OrderImportWatcher } from './order-import';
import { LiveFeedReader } from './live-feed-reader';
import { CorrectionsStore } from './corrections-store';
import { OpeningBalanceStore } from './opening-balance-store';
import { currentSessionDate } from './session-clock-bridge';
import { sharedModule } from './shared-require';
import type { FeeConfig } from './fee-calculator';
import { loadSettings, saveSettings, getSettings } from './settings';
import { TradeStore } from './trade-store';
import { analysisErrorPayload } from './status-payload';
import { runStartupStep, startupFailureText, type StartupFailure } from './startup-guard';
import { RecommendationStore } from './recommendation-store';
import { GradeRunner } from './grade-runner';
import type { AnalysisResult, PatternMarker, AlertCreatePayload, AutoTradeOutcome, AutoTradeStatus, OrderImportState } from '../shared/types';
import { Scheduler } from './scheduler';
import { IPC } from '../shared/types';
import { parsePrice } from '../shared/utils';
import { formatAsHtml, docName } from './google-doc-formatter';
import { initLogger, logDir, logFilePath, logLine } from './logger';

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

// ── Single instance ───────────────────────────────────────────────────────
// This runs before anything else in the main process: before the tray exists,
// before the order-history watcher polls, before the scheduler starts and before
// the bridge opens a CDP connection to TradingView. A second copy must never
// reach any of that — two trays showing the same number, two watchers on the same
// folder and two processes polling the live account is exactly the confusion this
// prevents.

/**
 * Claims the single-instance lock. Returns false in a second copy, which then has
 * nothing started to tear down and can leave immediately.
 */
function acquireSingleInstanceLock(): boolean {
  if (app.requestSingleInstanceLock()) return true;
  console.log(
    '[index] TVCM-SECOND-INSTANCE: TVCM is already running for this profile — quitting. ' +
    'The running copy has been brought forward.'
  );
  // exit(), not quit(): nothing has been initialised, so there is nothing to unwind,
  // and this guarantees the ready handler never runs.
  app.exit(0);
  return false;
}

const isPrimaryInstance = acquireSingleInstanceLock();

interface WindowState {
  x?: number;
  y?: number;
  width: number;
  height: number;
  alwaysOnTop: boolean;
}

const STATE_PATH = path.join(app.getPath('userData'), 'window-state.json');
const PNL_STATE_PATH = path.join(app.getPath('userData'), 'pnl-window-state.json');
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

/** The Order History window's remembered size and position, or a sensible default. */
function loadPnlState(): { x?: number; y?: number; width: number; height: number } {
  try {
    return { width: 1040, height: 760, ...JSON.parse(fs.readFileSync(PNL_STATE_PATH, 'utf8')) };
  } catch {
    return { width: 1040, height: 760 };
  }
}

/** Remembers where the Order History window was left. */
function savePnlState(win: BrowserWindow): void {
  try {
    const b = win.getBounds();
    fs.writeFileSync(PNL_STATE_PATH, JSON.stringify({ x: b.x, y: b.y, width: b.width, height: b.height }));
  } catch { /* ignore */ }
}

// ── Globals ───────────────────────────────────────────────────────────────

let mainWindow: BrowserWindow | null = null;
let tray:       Tray           | null = null;
let scheduler:  Scheduler      | null = null;
let lastResult: AnalysisResult | null = null;

let pnlTracker:      PnlTracker     | null = null;
let orderImport:     OrderImportWatcher | null = null;
let liveFeed:        LiveFeedReader | null = null;
let correctionsStore: CorrectionsStore | null = null;
let openingStore:     OpeningBalanceStore | null = null;
let pnlWindow:       BrowserWindow | null = null;
let trayTitleTimer:  ReturnType<typeof setInterval> | null = null;
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

const { trayMenuTemplate, escapeMenuLabel } = sharedModule('tray-menu.js') as {
  trayMenuTemplate: (s: { panelVisible: boolean; alwaysOnTop: boolean; paperMode: boolean }) => TrayMenuItem[];
  escapeMenuLabel:  (label: string | undefined) => string;
};

interface TrayMenuItem {
  id?: string; label?: string; type?: string; checked?: boolean; submenu?: TrayMenuItem[];
}

/** What each tray menu id does. The template itself knows only labels and nesting. */
function trayMenuActions(): Record<string, (checked: boolean) => void> {
  return {
    togglePanel:   () => toggleWindow(),
    refreshNow:    () => scheduler?.triggerNow(),
    alwaysOnTop:   (checked) => {
      mainWindow?.setAlwaysOnTop(checked, 'floating');
      if (mainWindow) saveState(mainWindow);
      rebuildMenu();
    },
    pnlWindow:     () => openPnlWindow(),
    paperMode:     (checked) => setPaperMode(checked),
    openLogFolder: () => { void shell.openPath(logDir()); },
    resetRecorder: () => { void confirmResetTradeRecorder(); },
    quit:          () => { isQuitting = true; app.quit(); },
  };
}

/** Turns the pure template into an Electron menu by attaching each id's action. */
function toElectronTemplate(items: TrayMenuItem[], actions: Record<string, (checked: boolean) => void>): Electron.MenuItemConstructorOptions[] {
  return items.map((item) => {
    if (item.type === 'separator') return { type: 'separator' as const };
    const out: Electron.MenuItemConstructorOptions = { label: escapeMenuLabel(item.label) };
    if (item.type === 'checkbox') { out.type = 'checkbox'; out.checked = item.checked; }
    if (item.submenu) out.submenu = toElectronTemplate(item.submenu, actions);
    const action = item.id ? actions[item.id] : undefined;
    if (action) out.click = (mi) => action(!!mi.checked);
    return out;
  });
}

function rebuildMenu(): void {
  if (!tray || !mainWindow) return;
  const template = trayMenuTemplate({
    panelVisible: mainWindow.isVisible(),
    alwaysOnTop:  mainWindow.isAlwaysOnTop(),
    paperMode:    paperMode(),
  });
  tray.setContextMenu(Menu.buildFromTemplate(toElectronTemplate(template, trayMenuActions())));
}


// ── Renderer watchdogs (TVCM-UI-*) ────────────────────────────────────────

/**
 * Log renderer crashes, hangs, failed loads and reloads, and bring the panel
 * back when it is safe to do so. Without this a blank panel left no trace.
 */
function attachRendererWatchdogs(win: BrowserWindow): void {
  const wc = win.webContents;

  // The renderer process died. Reloading is safe: all state is re-fetched.
  wc.on('render-process-gone', (_e, details) => {
    console.error(`[TVCM-UI-GONE] renderer gone reason=${details.reason} exitCode=${details.exitCode}`);
    if (details.reason !== 'clean-exit' && !isQuitting) {
      try { wc.reload(); console.log('[TVCM-UI-GONE] reloaded the panel'); }
      catch (err) { console.error('[TVCM-UI-GONE] reload failed:', (err as Error).message); }
    }
  });

  // Hung on the main thread. Not auto-recovered: a forced reload here would
  // throw away whatever the renderer was in the middle of.
  wc.on('unresponsive', () => {
    console.error('[TVCM-UI-UNRESPONSIVE] the panel stopped responding');
  });
  wc.on('responsive', () => {
    console.log('[TVCM-UI-RESPONSIVE] the panel is responding again');
  });

  // Vite not up yet in dev, or a missing bundle when packaged.
  wc.on('did-fail-load', (_e, code, desc, url) => {
    console.error(`[TVCM-UI-LOADFAIL] ${code} ${desc} url=${url}`);
  });

  // Distinguishes a reload from first paint, which matters when reading the log
  // back: a reload Jim did not ask for is itself a symptom.
  let loads = 0;
  wc.on('did-finish-load', () => {
    loads += 1;
    if (loads > 1) console.warn(`[TVCM-UI-RELOAD] panel reloaded (load #${loads})`);
    else console.log('[TVCM-UI-LOAD] panel loaded');
  });
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
    // A failure recorded before the panel existed still has to be seen.
    for (const f of pendingStartupFailures) {
      mainWindow.webContents.send(IPC.ANALYZE_STATUS, 'error', startupFailureText(f));
    }
    startSchedulerOnce();
  }
  rebuildMenu();
}

/**
 * Open the panel at launch without a tray click, so an unattended run can be
 * screenshotted or driven. Same opt-in shape as TVCM_AUTOSTART_SCHEDULER.
 */
function maybeShowPanel(): void {
  if (process.env.TVCM_SHOW_PANEL === '1') {
    console.log('[index] TVCM_SHOW_PANEL=1 — opening the panel without a tray click');
    toggleWindow();
  }
}

/**
 * Open the Order History & P&L window at launch, so an unattended run can be
 * screenshotted or driven. Same opt-in shape as TVCM_SHOW_PANEL; the only other
 * way in is a right-click on the tray.
 */
function maybeOpenPnlWindow(): void {
  if (process.env.TVCM_OPEN_PNL === '1') {
    console.log('[index] TVCM_OPEN_PNL=1 — opening the P&L window without a tray click');
    openPnlWindow();
  }
}

/**
 * Start the scheduler without the panel. The training runner needs the app
 * analysing unattended, and the only other way in is a tray click.
 */
function maybeAutostartScheduler(): void {
  if (process.env.TVCM_AUTOSTART_SCHEDULER === '1') {
    console.log('[index] TVCM_AUTOSTART_SCHEDULER=1 — starting the scheduler without the panel');
    startSchedulerOnce();
  }
}

function startSchedulerOnce(): void {
  if (!schedulerStarted) {
    schedulerStarted = true;
    if (getSettings().autoRefresh !== false) {
      // A scheduler that fails to start means no analysis ever happens, which
      // is silent by nature — so it is reported like any other startup step.
      runStartupStep('scheduler', () => scheduler?.start(), (f) => {
        const text = startupFailureText(f);
        console.error('[startup]', text);
        try { notifyProblem('TV Chart Monitor — startup problem', text); } catch { /* ignore */ }
        mainWindow?.webContents.send(IPC.ANALYZE_STATUS, 'error', text);
      });
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
// Electron's stdout is not captured when the app runs detached, which made a
// blank panel or a crash during a live session impossible to investigate after
// the fact. The log file is now always on — see logger.ts. TVCM_LOG_FILE is
// still honoured as a second destination for training runs that want their own
// file, but it is no longer what decides whether anything gets logged.
initLogger();

if (process.env.TVCM_LOG_FILE) {
  const logPath = process.env.TVCM_LOG_FILE;
  const stamp = () => new Date().toISOString().slice(11, 23);
  for (const level of ['log', 'warn', 'error'] as const) {
    const original = console[level].bind(console);
    console[level] = (...args: unknown[]) => {
      original(...args);
      try {
        fs.appendFileSync(logPath, `${stamp()} [${level}] ${args.map(String).join(' ')}\n`);
      } catch { /* logging must never break the app */ }
    };
  }
}

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
/** Startup failures seen before the panel existed, replayed when it opens. */
const pendingStartupFailures: StartupFailure[] = [];

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

type TrayTitleOpts = {
  now?: number; staleMinutes?: number; isTestProfile?: boolean;
  paperMode?: boolean; source?: string | null; switchHint?: string | null; feedReason?: string | null;
  feedSource?: string | null; crossCheck?: unknown; lastKnown?: boolean;
  appliedCorrections?: string[];
  /** The CDP connection's own state, so "lost" can be said differently from "no broker". */
  cdpState?: string; cdpLostAt?: number | null;
};
const { trayTitleColoured, trayTooltip } = sharedModule('tray-title.js') as {
  trayTitleColoured: (s: OrderImportState | null, o?: TrayTitleOpts) => string;
  trayTooltip:       (s: OrderImportState | null, o?: TrayTitleOpts) => string;
};

const liveFeedLib = sharedModule('live-feed.js') as {
  brokerSessionGross: (payload: unknown, prevDayBalance: number | null) => number | null;
};

/**
 * The balance this trading session OPENED with, which the missing-fill solve subtracts
 * from today's. TVCM records it itself at the session open while the account is flat
 * (TVCM-37); the hand-typed setting is only read for sessions it never saw the start of,
 * and a session that first came into view after trading had begun stays UNKNOWN rather
 * than be guessed at. Null here is what makes the banner ask Jim for the price.
 */
function openingBalance(currentSession: string | null): number | null {
  if (!currentSession || !openingStore) return null;
  const mode = paperMode() ? 'paper' : 'live';
  const settings = getSettings();
  return openingStore.resolve(mode, currentSession,
    settings.openingBalanceOverride ?? null, settings.prevDayBalance ?? null).balance;
}

const { mergePnl, mergedToImportState } = sharedModule('pnl-merge.js') as {
  mergePnl: (i: Record<string, unknown>) => import('../shared/types').MergedPnlState;
  mergedToImportState: (m: unknown, c: unknown, f: unknown) => OrderImportState;
};

const correctionsLib = sharedModule('corrections.js') as {
  reviewCorrection: (c: unknown, ctx: Record<string, unknown>) => { id: string; needsReview: boolean; problems: string[] };
  reviewText: (r: unknown) => string | null;
};

/**
 * Jim's corrections with today's rules applied to each one. Nothing is removed or
 * changed — a correction that no longer passes is simply marked, so he can decide.
 * TVCM-42: the 7,375.67 fill he accepted is not a price MES ever traded.
 */
function correctionsWithReview(): unknown[] {
  const mode = paperMode() ? 'paper' : 'live';
  const rows = correctionsStore?.list(mode) ?? [];
  return rows.map((c) => {
    const opening = openingStore?.get(mode, c.sessionDate) as
      (import('../shared/types').OpeningBalanceRecord & { changedAt?: number | null; previousBalance?: number | null }) | null;
    const review = correctionsLib.reviewCorrection(c, {
      imbalanceQty: liveFeed?.rawImbalance(c.sessionDate) ?? null,
      // Bars are deliberately not supplied: the active chart is not guaranteed to be the
      // instrument that traded, and a wrong bar would reject a good price (TVCM-42 §7).
      bars: null,
      // A price solved from the broker's money is only as good as the opening balance it
      // came from, and AMP's figure moves at every 17:00 roll (TVCM-43).
      openingChangedAt: openingStore?.changedAt(mode, c.sessionDate) ?? null,
      previousBalance:  opening?.previousBalance ?? null,
      openingBalance:   opening?.balance ?? null,
    });
    return { ...c, needsReview: review.needsReview, reviewText: correctionsLib.reviewText(review) };
  });
}

/**
 * The broker's realized gross, but only when the session's opening balance is settled.
 *
 * The roll guard protects what gets STORED; this is the other half. Between 17:00 and
 * AMP rolling its statement, the live Balances pair is the previous session's — account
 * balance against the previous day's opening — and subtracting them yields YESTERDAY'S
 * P&L. Handing that to the missing-fill solve would produce exactly the class of
 * confidently wrong price TVCM-42 and TVCM-43 exist to stop. While the opening balance is
 * unknown, so is the gross, and the banner asks (TVCM-43).
 */
function brokerGrossForSolve(payload: unknown): number | null {
  const today = currentSessionDate(new Date());
  const record = openingStore?.get(paperMode() ? 'paper' : 'live', today) ?? null;
  if (record && !record.known) return null;
  return liveFeedLib.brokerSessionGross(payload, openingBalance(today));
}

/** Whether TVCM is reading the paper account instead of AMP Live. */
function paperMode(): boolean {
  return getSettings().paperMode === true;
}

/** Where this mode's live-feed reading is cached. Live and paper never share a file. */
function liveFeedStatePath(mode: 'live' | 'paper'): string {
  return path.join(app.getPath('userData'), `live-feed-${mode}.json`);
}

/**
 * The one view everything renders: the live feed for the current session, the CSV import
 * for past days, and whichever complaint matters most. Built fresh on every read so the
 * session rollover and the stale rules are always evaluated against the current clock.
 */
function currentMergedState(): import('../shared/types').MergedPnlState {
  const settings = getSettings();
  return mergePnl({
    feed: liveFeed?.getState() ?? null,
    csv:  orderImport?.getState() ?? null,
    now:  Date.now(),
    mode: paperMode() ? 'paper' : 'live',
    staleMinutes: settings.orderImportStaleMinutes ?? 30,
  });
}

/**
 * Flips between the live and the paper account. One setting backs the tray item, the
 * window header and the Settings panel, so all three move together; everything the feed
 * held is dropped first, because a paper reading has no business surviving into a live
 * view even for one poll.
 */
function setPaperMode(on: boolean): void {
  const next = !!on;
  if (getSettings().paperMode === next) return;
  saveSettings({ ...getSettings(), paperMode: next });
  const mode: 'live' | 'paper' = next ? 'paper' : 'live';
  liveFeed?.setMode(mode, liveFeedStatePath(mode));
  orderImport?.reapplyCorrections();
  console.log(`[live-feed] switched to ${mode} mode`);
  rebuildMenu();
  publishPnl();
  mainWindow?.webContents.send(IPC.PAPER_MODE_PUSH, next);
  if (pnlWindow && !pnlWindow.isDestroyed()) pnlWindow.webContents.send(IPC.PAPER_MODE_PUSH, next);
}

/** The merged view flattened into the shape the panel and the P&L window already read. */
function displayState(): OrderImportState {
  return mergedToImportState(currentMergedState(), orderImport?.getState() ?? null, liveFeed?.getState() ?? null);
}

/**
 * The sessions the window may list. In paper mode only the feed's own sessions, because
 * the AMP export holds real money and has no place in a paper view. In live mode the
 * export owns past days, with the feed's current session added when the export has not
 * caught up to it yet.
 */
function sessionList(): import('../shared/types').SessionListItem[] {
  const feedList = liveFeed?.listSessions() ?? [];
  if (paperMode()) return feedList;
  const csvList = orderImport?.listSessions() ?? [];
  const today = currentMergedState().currentSession;
  const haveToday = csvList.some(s => s.sessionDate === today);
  const feedToday = feedList.find(s => s.sessionDate === today);
  return (!haveToday && feedToday) ? [feedToday, ...csvList] : csvList;
}

/** One session's detail, from whichever source actually holds that session. */
function sessionDetail(sessionDate: string): import('../shared/types').SessionDetail {
  const merged = currentMergedState();
  const feedOwns = !!liveFeed && liveFeed.getMode() === merged.mode && liveFeed.hasSession(sessionDate);
  // The feed answers for the session it owns; in paper mode it answers for all of them,
  // because the export is live money and must never be read into a paper view.
  if (feedOwns && (paperMode() || sessionDate === merged.currentSession)) {
    return liveFeed!.getSessionDetail(sessionDate);
  }
  if (paperMode()) {
    return { sessionDate, session: null, trades: [], fills: [], boundary: null };
  }
  return orderImport?.getSessionDetail(sessionDate)
      ?? { sessionDate, session: null, trades: [], fills: [], boundary: null };
}

/** Repaints the tray and pushes the merged view to both windows. */
function publishPnl(): void {
  refreshTrayTitle();
  const state = displayState();
  mainWindow?.webContents.send(IPC.ORDER_IMPORT_PUSH, state);
  if (pnlWindow && !pnlWindow.isDestroyed()) pnlWindow.webContents.send(IPC.ORDER_IMPORT_PUSH, state);
}

/** Repaints the menu-bar title and tooltip from the latest import state. */
function refreshTrayTitle(): void {
  if (!tray) return;
  const merged = currentMergedState();
  const state = mergedToImportState(merged, orderImport?.getState() ?? null, liveFeed?.getState() ?? null);
  const staleMinutes = getSettings().orderImportStaleMinutes ?? 30;
  const cdpStatus = connectionState();
  const opts: TrayTitleOpts = {
    staleMinutes,
    isTestProfile: isTestProfile(),
    paperMode:     paperMode(),
    source:        merged.source === 'none' ? null : merged.source,
    switchHint:    merged.switchHint,
    feedReason:    merged.feedReason,
    // Which collection the feed read, and whether the broker agrees with it.
    feedSource:    liveFeed?.getState().source ?? null,
    crossCheck:    liveFeed?.getState().crossCheck ?? null,
    lastKnown:     merged.lastKnown,
    appliedCorrections: liveFeed?.getState().appliedCorrections ?? [],
    // The connection speaks for itself: "reconnecting" and "press Connect" are different
    // problems with different answers, and only the manager knows which one this is.
    cdpState:      cdpStatus.state,
    cdpLostAt:     cdpStatus.lostAt,
  };
  try {
    // monospacedDigit stops the title's width jittering as the number changes.
    tray.setTitle(trayTitleColoured(state, opts), { fontType: 'monospacedDigit' });
    tray.setToolTip(trayTooltip(state, opts));
  } catch (err) {
    console.error('[tray] TVCM-OI-TITLE: could not set the menu-bar title —', (err as Error).message);
  }
}

const { raiseToFront } = sharedModule('raise-to-front.js') as {
  raiseToFront: (win: BrowserWindow, activateApp: () => void) => void;
};

/** Brings a window in front of every other app, however TVCM is placed at the time. */
function bringToFront(win: BrowserWindow): void {
  raiseToFront(win, () => app.focus({ steal: true }));
}

/**
 * Opens the Order History & P&L window, or focuses it if it is already up. It reads the
 * imported export over IPC — there is no server and no connection to TradingView.
 */
function openPnlWindow(): void {
  if (pnlWindow && !pnlWindow.isDestroyed()) {
    bringToFront(pnlWindow);
    return;
  }
  const st = loadPnlState();
  pnlWindow = new BrowserWindow({
    x: st.x, y: st.y, width: st.width, height: st.height,
    minWidth: 720, minHeight: 420,
    title: 'Order History & P&L',
    backgroundColor: '#1e222d',
    titleBarStyle: 'hiddenInset',
    show: false,
    webPreferences: {
      nodeIntegration:  false,
      contextIsolation: true,
      sandbox:          false,
      preload:          path.join(__dirname, 'pnl-preload.js'),
    },
  });

  if (app.isPackaged) {
    void pnlWindow.loadFile(path.join(app.getAppPath(), 'dist', 'pnlwindow', 'index.html'));
  } else {
    void pnlWindow.loadURL('http://localhost:5175');
  }

  // Opened from the menu, it must land in front — otherwise it hides behind the editor.
  pnlWindow.once('ready-to-show', () => { if (pnlWindow) bringToFront(pnlWindow); });
  pnlWindow.on('moved',   () => { if (pnlWindow) savePnlState(pnlWindow); });
  pnlWindow.on('resized', () => { if (pnlWindow) savePnlState(pnlWindow); });
  pnlWindow.on('closed',  () => { pnlWindow = null; });
}

/**
 * Wipes the trade recorder's `trades` table, behind a confirmation. It calls the same
 * clearAll() the journal's reset used, which drops and rebuilds ONLY that table —
 * recommendations and lessons are untouched, and the dialog says so.
 */
async function confirmResetTradeRecorder(): Promise<void> {
  const count = tradeStore?.getAll().length ?? 0;
  const { response } = await dialog.showMessageBox({
    type:      'warning',
    buttons:   ['Cancel', 'Delete trade records'],
    defaultId: 0,
    cancelId:  0,
    title:     'Reset trade recorder data',
    message:   `Delete all ${count} recorded trade${count === 1 ? '' : 's'}?`,
    detail:    'This clears the trade recorder only. Your recommendations and lessons are '
             + 'not touched, and your order-history P&L comes from the TradingView export, '
             + 'so it is unaffected. This cannot be undone.',
  });
  if (response !== 1) return;
  try {
    tradeStore?.clearAll();
    console.log('[index] trade recorder reset by the user — trades table rebuilt');
  } catch (err) {
    console.error('[index] TVCM-RESET-FAILED:', (err as Error).message);
    dialog.showErrorBox('Reset failed', (err as Error).message);
  }
}

/** True only when the developer asked for DevTools with TVCM_DEVTOOLS=1. */
function wantsDevTools(): boolean {
  return process.env.TVCM_DEVTOOLS === '1';
}

/**
 * True when this copy is running on a userData profile that is not the everyday one —
 * i.e. somebody passed --user-data-dir. The single-instance lock is per profile, so a
 * test copy legitimately runs alongside the real one and puts a second tray in the menu
 * bar; this is what lets the two be told apart at a glance.
 */
function isTestProfile(): boolean {
  const actual = app.getPath('userData');
  const everyday = path.join(app.getPath('appData'), app.getName());
  return path.resolve(actual) !== path.resolve(everyday);
}

/**
 * Someone tried to launch TVCM again. Show them the copy that is already running,
 * so "nothing happened" is never the answer.
 */
function revealRunningInstance(): void {
  console.log('[index] TVCM-SECOND-INSTANCE: a second launch was refused; showing the running copy');
  try {
    openPnlWindow();
  } catch {
    // No window yet (still starting up) — the tray menu still proves which copy is live.
    rebuildMenu();
    tray?.popUpContextMenu();
  }
}

if (isPrimaryInstance) app.on('second-instance', revealRunningInstance);

app.on('ready', () => {
  // Belt and braces: app.exit() above should mean this never fires in a second copy.
  if (!isPrimaryInstance) return;
  const initialSettings = loadSettings();
  // Apply persisted overrides so bridge/scheduler honour stored settings from first use
  setCdpPort(initialSettings.cdpPort);
  if (initialSettings.apiKeyOverride) setApiKeyOverride(initialSettings.apiKeyOverride);
  app.dock?.hide();

  // Tray
  // No icon: macOS always draws a status item's title to the RIGHT of its image, and
  // Electron's TitleOptions has no positioning option, so the only way to put the
  // number first is to have no image at all. refreshTrayTitle() guarantees the title
  // is never empty, which is what keeps the item visible and clickable.
  tray = new Tray(nativeImage.createEmpty());
  tray.setToolTip('Trading Analyzer');
  refreshTrayTitle();

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
    // Detached DevTools is its own top-level Chromium window, which looks like a stray
    // Chrome window sitting behind TradingView. Opt in with TVCM_DEVTOOLS=1 instead.
    if (wantsDevTools()) mainWindow.webContents.openDevTools({ mode: 'detach' });
  }

  // A blank panel has more than one cause. Every way the renderer can die,
  // hang or reload is logged with its own code so the log says which happened.
  attachRendererWatchdogs(mainWindow);

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

  // Trade recorder store. It also owns the database handle RecommendationStore borrows,
  // so it stays even though its own UI is gone.
  // Startup failures must be visible. A throw here used to leave a working tray
  // and a dead app with nothing on screen and nothing in any log a user reads.
  const startupFailures: StartupFailure[] = [];
  const reportStartupFailure = (f: StartupFailure): void => {
    startupFailures.push(f);
    pendingStartupFailures.push(f);
    const text = startupFailureText(f);
    console.error('[startup]', text);
    // A notification failure must never hide the original problem.
    try { notifyProblem('TV Chart Monitor — startup problem', text); } catch { /* ignore */ }
    // The panel may not exist yet; send on creation as well as now.
    mainWindow?.webContents.send(IPC.ANALYZE_STATUS, 'error', text);
  };

  tradeStore = new TradeStore(app.getPath('userData'));
  setLessonsProvider(() => tradeStore?.getApprovedLessons() ?? []);
  // Share TradeStore's connection so trades.db keeps a single writer.
  runStartupStep('schema', () => {
    recStore    = new RecommendationStore(tradeStore!.database);
    gradeRunner = new GradeRunner(recStore, peekBars);
  }, reportStartupFailure);
  // Fill setup_key on any rows written before the column existed.
  try {
    const filled = recStore?.backfillSetupKeys((json) => setupKeyFor(json)) ?? 0;
    if (filled > 0) console.log(`[recommendations] backfilled setup_key on ${filled} row(s)`);
  } catch (err) {
    console.error('[recommendations] TVCM-REC-BACKFILL-FAILED:', (err as Error).message);
  }
  // Catch up on anything left ungraded while the app was closed.
  void gradeRunner?.run().catch((err: unknown) =>
    console.error('[grade-runner] startup catch-up failed:', (err as Error).message));


  // P&L tracker
  pnlTracker = new PnlTracker(
    (snap) => { mainWindow?.webContents.send(IPC.PNL_PUSH, snap); },
    () => {
      const s = getSettings();
      return {
        perContractSideFee:  s.feePerContractSide,
        liquidationDaily:    s.feeLiquidationDaily,
        dataFeedMonthly:     s.feeDataMonthly,
        tradingDaysPerMonth: s.feeTradingDays,
      } satisfies FeeConfig;
    },
    tradeStore,
  );
  pnlTracker.start();

  // Order-history import: the source of truth for session P&L and fees.
  const importSettings = getSettings();
  correctionsStore = new CorrectionsStore(app.getPath('userData'));
  openingStore     = new OpeningBalanceStore(app.getPath('userData'));
  orderImport = new OrderImportWatcher({
    // The env override exists so the watcher can be pointed at a scratch folder
    // for testing without editing the real settings file.
    folder:    process.env.TVCM_ORDER_IMPORT_FOLDER || importSettings.orderImportFolder,
    statePath: path.join(app.getPath('userData'), 'order-import.json'),
    corrections: () => correctionsStore?.list(paperMode() ? 'paper' : 'live') ?? [],
    mode:        () => (paperMode() ? 'paper' : 'live'),
    // The watcher's own state is no longer what anyone renders — publishPnl() merges it
    // with the live feed first — so a change just asks for a repaint.
    onChange:  () => publishPnl(),
  });
  if (importSettings.orderImportEnabled !== false) orderImport.start();

  // Live feed: TradingView's own executions, over the CDP connection the analyzer
  // already keeps. It drives the CURRENT session; the CSV import still owns past days
  // and remains the statement-proven record if the two ever disagree.
  const feedMode: 'live' | 'paper' = importSettings.paperMode ? 'paper' : 'live';
  liveFeed = new LiveFeedReader({
    evalPage,
    mode:           feedMode,
    pollIntervalMs: Math.max(1, importSettings.liveFeedPollSeconds ?? 5) * 1000,
    perContractSideFee: () => getSettings().feePerContractSide ?? 0.60,
    corrections: () => correctionsStore?.list(paperMode() ? 'paper' : 'live') ?? [],
    brokerGross: (payload) => brokerGrossForSolve(payload),
    // Every poll is offered for the session's opening balance; at most one is recorded.
    onReading: (info) => { openingStore?.observe(info); },
    statePath:      liveFeedStatePath(feedMode),
    onChange:       () => publishPnl(),
  });
  if (importSettings.liveFeedEnabled !== false) liveFeed.start();

  refreshTrayTitle();
  // The title also has to change on its own: the stale marker appears with the
  // passage of time, and the session rolls over at 17:00 CT with nothing happening.
  trayTitleTimer = setInterval(refreshTrayTitle, 60_000);

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

  maybeAutostartScheduler();

  maybeShowPanel();
  maybeOpenPnlWindow();

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
    if ('orderImportFolder' in partial) {
      orderImport?.setFolder(partial.orderImportFolder);
      void orderImport?.scanOnce();
    }
    if ('orderImportEnabled' in partial) {
      if (partial.orderImportEnabled) orderImport?.start(); else orderImport?.stop();
    }
    if ('liveFeedEnabled' in partial) {
      if (partial.liveFeedEnabled) liveFeed?.start(); else liveFeed?.stop();
    }
    // Settings is the third place the toggle lives; route it through the one function
    // so the tray checkbox and both windows follow.
    if ('paperMode' in partial && partial.paperMode !== undefined) {
      setPaperMode(partial.paperMode);
    }
    if ('orderImportStaleMinutes' in partial || 'orderImportEnabled' in partial) {
      refreshTrayTitle();
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
  ipcMain.handle(IPC.ORDER_IMPORT_GET, () => displayState());
  ipcMain.handle(IPC.PAPER_MODE_GET, () => ({
    paperMode: paperMode(),
    merged:    currentMergedState(),
  }));
  ipcMain.handle(IPC.PAPER_MODE_SET, (_e, on: boolean) => { setPaperMode(!!on); return paperMode(); });

  // Corrections: Jim's recorded missing fills. Nothing is ever added without his click.
  ipcMain.handle(IPC.CORRECTION_LIST, () => correctionsWithReview());
  ipcMain.handle(IPC.CORRECTION_SUGGESTION, () => liveFeed?.getState().suggestion ?? null);
  ipcMain.handle(IPC.CORRECTION_ADD, (_e, input: unknown) => {
    const made = correctionsStore?.add(paperMode() ? 'paper' : 'live', input) ?? null;
    orderImport?.reapplyCorrections();
    void liveFeed?.readOnce().then(() => publishPnl());
    publishPnl();
    return made;
  });
  ipcMain.handle(IPC.CORRECTION_REMOVE, (_e, id: string) => {
    correctionsStore?.remove(paperMode() ? 'paper' : 'live', id);
    orderImport?.reapplyCorrections();
    void liveFeed?.readOnce().then(() => publishPnl());
    publishPnl();
  });
  ipcMain.handle(IPC.PNL_WINDOW_CLOSE, () => { pnlWindow?.close(); });
  ipcMain.handle(IPC.ORDER_IMPORT_SESSIONS, () => sessionList());
  ipcMain.handle(IPC.ORDER_IMPORT_DETAIL, (_e, sessionDate: string) => sessionDetail(sessionDate));

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
  // Renderer console errors/warnings, written to the same always-on log file.
  // One-way on purpose: logging must never make the panel await the main process.
  ipcMain.on(IPC.LOG_RENDERER, (_e, level: string, message: string) => {
    logLine(`renderer:${level === 'warn' ? 'warn' : 'error'}`, String(message));
  });

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
  orderImport?.stop();
  liveFeed?.stop();
  if (trayTitleTimer) { clearInterval(trayTitleTimer); trayTitleTimer = null; }
  void disconnect();
});
