/**
 * bridge.ts
 *
 * Main-process bridge between Electron and the TradingView CDP reader.
 * Owns the reader singleton, config loading, and the runAnalysis() entry point
 * called by index.ts IPC handlers.
 */

import { app } from 'electron';
import fs from 'fs';
import path from 'path';
import type { AnalysisResult, KeyStatus, AlertCreateResult } from '../shared/types';
import { getSettings } from './settings';

// ---------------------------------------------------------------------------
// Logger
// ---------------------------------------------------------------------------

interface Logger {
  info:  (...args: unknown[]) => void;
  warn:  (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
}

/** Lightweight chart state used by the scheduler to detect replay progress. */
export interface BarState {
  replayMode:    boolean;
  /** Open time (epoch SECONDS) of the most recently closed bar. */
  closedBarTime: number;
  /** Open time (epoch SECONDS) of the live/forming bar. */
  lastBarTime:   number;
}

const logger: Logger = {
  info:  console.log,
  warn:  console.warn,
  error: console.error,
};

// ---------------------------------------------------------------------------
// Config loading
// ---------------------------------------------------------------------------

interface TvConfig {
  cdpHost: string;
  cdpPort: number;
  pollIntervalMs?: number;
  useMockReader: boolean;
}

interface LlmConfig {
  /** Which backend in src/shared/llm-providers.js handles the call. */
  provider?: 'anthropic' | 'gemini';
  apiKeyEnv: string;
  model: string;
  /** Cheap model for high-volume work (journal lesson extraction). Defaults to `model`. */
  fastModel?: string;
  maxOutputTokens: number;
  enabled: boolean;
  /** Gemini only: 0 disables thinking so the token budget goes to JSON output. */
  thinkingBudget?: number;
  temperature?: number;
  timeoutMs?: number;
  /** Gemini only: models walked after `model` when one is congested or capped. */
  fallbackModels?: string[];
  /** Gemini only: how many times the whole model chain is walked. */
  maxPasses?: number;
}

interface AppConfig {
  tv:         TvConfig;
  /** Active LLM backend. Falls back to `anthropic` for pre-provider configs. */
  llm?:       LlmConfig;
  /** Back-compat only: pre-provider configs had no `llm`. Not the parked block. */
  anthropic?: LlmConfig;
  /** Parked alternative backend, copied over `llm` to switch providers. */
  gemini?:    LlmConfig;
  filter?:    Record<string, unknown>;
  [key: string]: unknown;
}

/**
 * Resolve the active LLM block. `llm` wins when present; `anthropic` is the
 * back-compat path for configs written before providers existed (and stays in
 * config.json as a ready-made block to switch back to).
 */
function resolveLlm(cfg: AppConfig): LlmConfig {
  const block = cfg.llm ?? cfg.anthropic;
  if (!block) {
    throw new Error('config.json is missing both an `llm` and an `anthropic` block');
  }
  return { provider: 'anthropic', ...block };
}

function loadConfig(): AppConfig {
  const configPath = path.join(app.getAppPath(), 'config', 'config.json');
  const raw = fs.readFileSync(configPath, 'utf-8');
  return JSON.parse(raw) as AppConfig;
}

// ---------------------------------------------------------------------------
// Lazy-loaded JS modules (CommonJS, live in src/shared/)
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { createReader } = require(path.join(app.getAppPath(), 'src/shared/tv-reader')) as {
  createReader: (config: AppConfig, log: Logger) => {
    connect():                                    Promise<boolean>;
    disconnect():                                 Promise<void>;
    readSnapshot(opts?: { barCount?: number }):   Promise<unknown>;
    readBarState():                               Promise<unknown>;
    hasNewClose(snapshot: unknown):               boolean;
    setStudyInputs(studyId: string, patch: Record<string, unknown>): Promise<{ok: boolean; error?: string}>;
    evalPage(expression: string):                 Promise<unknown>;
    createAlert(price: number, label: string, symbol: string, resolution: string): Promise<unknown>;
  };
};

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { buildContext } = require(path.join(app.getAppPath(), 'src/shared/context')) as {
  buildContext(snapshot: unknown, opts: { tickSize: number; maPeriod: number }): unknown;
};

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { CommentaryEngine } = require(path.join(app.getAppPath(), 'src/shared/commentary')) as {
  CommentaryEngine: new (
    llmConfig: LlmConfig,
    log: Logger,
  ) => {
    analyze(ctx: unknown, reasons: Array<{ kind: string }>): Promise<unknown>;
  };
};

// ---------------------------------------------------------------------------
// Module-level singletons
// ---------------------------------------------------------------------------

type LessonsProvider = () => Array<{
  id: number; pattern: string | null; direction: string | null;
  outcome: string | null; lesson_text: string; context_text: string | null;
}>;
let lessonsProvider: LessonsProvider | null = null;

/** Called by index.ts after TradeStore is ready. */
export function setLessonsProvider(fn: LessonsProvider): void {
  lessonsProvider = fn;
}

let config: AppConfig = loadConfig();
let reader: ReturnType<typeof createReader> | null = null;
let engine: InstanceType<typeof CommentaryEngine> | null = null;
let connected = false;

let statusCallback: ((status: string) => void) | null = null;

// Runtime overrides applied by index.ts when settings change
let _cdpPortOverride: number | null = null;
let _apiKeyOverride:  string | null = null;
// Capture original env value before any override is applied
const _originalApiKeyValue: string | undefined = process.env[resolveLlm(config).apiKeyEnv];

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export function setStatusCallback(cb: (status: string) => void): void {
  statusCallback = cb;
}

export function setCdpPort(port: number | null): void {
  _cdpPortOverride = port;
  void (reader?.disconnect().catch(() => {}));
  connected = false;
  reader = null;
}

export function setApiKeyOverride(key: string): void {
  _apiKeyOverride = key || null;
  const keyEnv = resolveLlm(config).apiKeyEnv;
  if (_apiKeyOverride) {
    process.env[keyEnv] = _apiKeyOverride;
  } else if (_originalApiKeyValue !== undefined) {
    process.env[keyEnv] = _originalApiKeyValue;
  } else {
    delete process.env[keyEnv];
  }
  engine = null;
}

export function resetConnection(): void {
  void (reader?.disconnect().catch(() => {}));
  connected = false;
  reader = null;
}

export function getKeyStatus(): KeyStatus {
  if (_apiKeyOverride) return 'override';
  const val = process.env[resolveLlm(config).apiKeyEnv];
  return val ? 'env' : 'missing';
}

function sendStatus(status: string): void {
  if (statusCallback) {
    statusCallback(status);
  }
}

/** Ensure the reader is initialised and connected. */
async function ensureConnected(): Promise<void> {
  // Reload config each time so hot-editing config.json takes effect.
  config = loadConfig();
  if (_cdpPortOverride !== null) {
    config = { ...config, tv: { ...config.tv, cdpPort: _cdpPortOverride } };
  }

  if (!reader) {
    reader = createReader(config, logger);
  }

  if (!connected) {
    sendStatus('Connecting to TradingView...');
    try {
      await reader.connect();
      connected = true;
    } catch (err: unknown) {
      connected = false;
      reader = null; // force re-create on next attempt
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.toLowerCase().includes('connection refused') || msg.toLowerCase().includes('econnrefused')) {
        throw new Error(
          'Cannot connect to TradingView. Launch TradingView Desktop with: --remote-debugging-port=9222',
        );
      }
      throw err;
    }
  }
}

/** Ensure the CommentaryEngine is initialised. */
function ensureEngine(): void {
  if (!engine) {
    engine = new CommentaryEngine(resolveLlm(config), logger);
  }
}

export async function runAnalysis(): Promise<AnalysisResult> {
  try {
    await ensureConnected();
  } catch (err: unknown) {
    connected = false;
    reader = null;
    throw err;
  }

  sendStatus('Reading chart data...');
  let snapshot: unknown;
  try {
    snapshot = await reader!.readSnapshot({ barCount: 300 });
  } catch (err: unknown) {
    // Treat any read error as a lost connection so we reconnect next time.
    connected = false;
    reader = null;
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.toLowerCase().includes('connection refused') || msg.toLowerCase().includes('econnrefused')) {
      throw new Error(
        'Cannot connect to TradingView. Launch TradingView Desktop with: --remote-debugging-port=9222',
      );
    }
    throw err;
  }

  const ctx = buildContext(snapshot, { tickSize: 0.25, maPeriod: 20 });
  if (ctx === null || ctx === undefined) {
    throw new Error('Not enough bar data to build context');
  }

  // Inject approved lessons so CommentaryEngine can learn from past trades.
  if (lessonsProvider) {
    const lessons = lessonsProvider();
    if (lessons.length > 0) {
      (ctx as Record<string, unknown>).lessons = lessons;
    }
  }

  sendStatus('Analyzing...');
  ensureEngine();
  const commentary = await engine!.analyze(ctx, [{ kind: 'on-demand' }]);

  const typedCtx = ctx as {
    symbol:    string;
    timeframe: string;
    closedBar: { close: number; time: number };
  };

  // Compute the close time of the currently-forming bar (last candle in snapshot).
  const snapCandles = (snapshot as { candles?: Array<{ time: number }> })?.candles;
  const lastCandle  = snapCandles && snapCandles.length > 0 ? snapCandles[snapCandles.length - 1] : null;
  const resNum      = parseFloat(typedCtx.timeframe);
  const barCloseMs  = lastCandle && !isNaN(resNum)
    ? (lastCandle.time + resNum * 60) * 1000
    : 0;

  return {
    symbol:         typedCtx.symbol,
    timeframe:      typedCtx.timeframe,
    closedBarPrice: typedCtx.closedBar.close,
    barCloseMs,
    replayMode:     !!(snapshot as { replayMode?: boolean }).replayMode,
    closedBarTime:  typedCtx.closedBar.time ?? 0,
    commentary:     commentary as AnalysisResult['commentary'],
  };
}

/**
 * Cheap poll for scheduler use: replay flag + latest closed-bar timestamp,
 * without pulling a full 300-bar snapshot and without a Claude call.
 *
 * Deliberately does NOT tear down the connection on failure — this runs every
 * few seconds during replay, and a transient read error should not force a
 * reconnect. Returns null on any problem; callers treat that as "no change".
 */
export async function peekBarState(): Promise<BarState | null> {
  try {
    await ensureConnected();
    const raw = await reader!.readBarState();
    if (!raw || typeof raw !== 'object') return null;
    const s = raw as Partial<BarState>;
    if (typeof s.closedBarTime !== 'number') return null;
    return {
      replayMode:    !!s.replayMode,
      closedBarTime: s.closedBarTime,
      lastBarTime:   typeof s.lastBarTime === 'number' ? s.lastBarTime : s.closedBarTime,
    };
  } catch {
    return null;
  }
}

export async function getSnapshot(): Promise<unknown> {
  try {
    await ensureConnected();
  } catch (err: unknown) {
    connected = false;
    reader = null;
    throw err;
  }

  try {
    return await reader!.readSnapshot({ barCount: 300 });
  } catch (err: unknown) {
    connected = false;
    reader = null;
    throw err;
  }
}

export async function callSetStudyInputs(
  studyId: string,
  patch: Record<string, unknown>,
): Promise<{ok: boolean; error?: string}> {
  try {
    await ensureConnected();
  } catch (err: unknown) {
    connected = false;
    reader = null;
    throw err;
  }
  return reader!.setStudyInputs(studyId, patch);
}

export async function evalPage(expression: string): Promise<unknown> {
  try {
    await ensureConnected();
  } catch (err: unknown) {
    connected = false;
    reader = null;
    throw err;
  }
  return reader!.evalPage(expression);
}

export async function createLevelAlert(
  price: number,
  label: string,
): Promise<AlertCreateResult> {
  try {
    await ensureConnected();
  } catch (err: unknown) {
    connected = false;
    reader    = null;
    throw err;
  }
  let symbol: string;
  let resolution: string;
  try {
    symbol     = await reader!.evalPage("window.TradingViewApi.activeChart().symbol()") as string;
    resolution = await reader!.evalPage("window.TradingViewApi.activeChart().resolution()") as string;
  } catch (err: unknown) {
    connected = false;
    reader    = null;
    throw err;
  }
  return reader!.createAlert(price, label, symbol, resolution) as Promise<AlertCreateResult>;
}

export async function findStudyId(nameContains: string): Promise<string | null> {
  try {
    await ensureConnected();
  } catch (err: unknown) {
    connected = false;
    reader = null;
    throw err;
  }
  const name = JSON.stringify(nameContains);
  const expr = `
    (() => {
      try {
        const api = window.TradingViewApi;
        const chart = api && typeof api.activeChart === 'function' ? api.activeChart() : null;
        if (!chart) return null;
        const studies = typeof chart.getAllStudies === 'function' ? (chart.getAllStudies() || []) : [];
        const found = studies.find(s => s.name && s.name.includes(${name}));
        return found ? String(found.id) : null;
      } catch { return null; }
    })()
  `;
  const result = await reader!.evalPage(expr);
  return typeof result === 'string' && result ? result : null;
}

export async function disconnect(): Promise<void> {
  if (reader && connected) {
    try {
      await reader.disconnect();
    } catch (_) {
      // ignore errors on disconnect
    }
  }
  connected = false;
  reader = null;
}
