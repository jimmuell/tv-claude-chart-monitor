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

// ---------------------------------------------------------------------------
// Logger
// ---------------------------------------------------------------------------

interface Logger {
  info:  (...args: unknown[]) => void;
  warn:  (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
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

interface AnthropicConfig {
  apiKeyEnv: string;
  model: string;
  maxOutputTokens: number;
  enabled: boolean;
}

interface AppConfig {
  tv:        TvConfig;
  anthropic: AnthropicConfig;
  filter?:   Record<string, unknown>;
  [key: string]: unknown;
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
    anthropicConfig: AnthropicConfig,
    log: Logger,
  ) => {
    analyze(ctx: unknown, reasons: Array<{ kind: string }>): Promise<unknown>;
  };
};

// ---------------------------------------------------------------------------
// Module-level singletons
// ---------------------------------------------------------------------------

let config: AppConfig = loadConfig();
let reader: ReturnType<typeof createReader> | null = null;
let engine: InstanceType<typeof CommentaryEngine> | null = null;
let connected = false;

let statusCallback: ((status: string) => void) | null = null;

// Runtime overrides applied by index.ts when settings change
let _cdpPortOverride: number | null = null;
let _apiKeyOverride:  string | null = null;
// Capture original env value before any override is applied
const _originalApiKeyValue: string | undefined = process.env[config.anthropic.apiKeyEnv];

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
  if (_apiKeyOverride) {
    process.env[config.anthropic.apiKeyEnv] = _apiKeyOverride;
  } else if (_originalApiKeyValue !== undefined) {
    process.env[config.anthropic.apiKeyEnv] = _originalApiKeyValue;
  } else {
    delete process.env[config.anthropic.apiKeyEnv];
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
  const val = process.env[config.anthropic.apiKeyEnv];
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
    engine = new CommentaryEngine(config.anthropic, logger);
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
    snapshot = await reader!.readSnapshot({ barCount: 200 });
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

  sendStatus('Analyzing...');
  ensureEngine();
  const commentary = await engine!.analyze(ctx, [{ kind: 'on-demand' }]);

  // ctx carries the shape returned by buildContext; cast via unknown for safety.
  const typedCtx = ctx as {
    symbol:    string;
    timeframe: string;
    closedBar: { close: number };
  };

  // Compute the close time of the currently-forming bar (last candle in snapshot).
  // time field in m_bars is Unix seconds (bar open); close = open + resolution_secs.
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
    commentary:     commentary as AnalysisResult['commentary'],
  };
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
    return await reader!.readSnapshot({ barCount: 200 });
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
  const symbol     = await reader!.evalPage("window.TradingViewApi.activeChart().symbol()") as string;
  const resolution = await reader!.evalPage("window.TradingViewApi.activeChart().resolution()") as string;
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
