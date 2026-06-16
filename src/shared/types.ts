export type AppStatus = 'active' | 'inactive';

export type AnalysisStatus = 'idle' | 'capturing' | 'analyzing' | 'complete' | 'error';

// ---------------------------------------------------------------------------
// IPC channel constants
// ---------------------------------------------------------------------------

export const IPC = {
  ANALYZE_RUN:               'analyze:run',
  ANALYZE_STATUS:            'analyze:status',
  SNAPSHOT_RAW:              'snapshot:raw',
  SCHEDULER_START:           'scheduler:start',
  SCHEDULER_STOP:            'scheduler:stop',
  ANALYSIS_PUSH:             'analysis:push',
  SCHEDULER_NEXT_TICK:       'scheduler:nextTick',
  ANNOTATE_TOGGLE:           'annotate:toggle',
  ANNOTATE_DRAW_ALL:         'annotate:drawAll',
  ANNOTATE_CLEAR_ALL:        'annotate:clearAll',
  ANNOTATE_TRADE_PLAN:       'annotate:tradePlan',
  ANNOTATE_CLEAR_TRADE_PLAN: 'annotate:clearTradePlan',
  SETTINGS_GET:              'settings:get',
  SETTINGS_UPDATE:           'settings:update',
  SCHEDULER_PAUSE:           'scheduler:pause',
  SCHEDULER_RESUME:          'scheduler:resume',
  BRIDGE_RECONNECT:          'bridge:reconnect',
  SETTINGS_KEY_STATUS:       'settings:keyStatus',
  APP_VERSION:               'app:version',
  PNL_GET:                   'pnl:get',
  PNL_PUSH:                  'pnl:push',
  GDRIVE_EXPORT:             'gdrive:export',
  GDRIVE_STATUS:             'gdrive:status',
  GDRIVE_SIGNOUT:            'gdrive:signout',
  ANNOTATE_PATTERN_MARKERS:  'annotate:patternMarkers',
  ALERT_CREATE:              'alert:create',
  ALERT_REMOVE:              'alert:remove',
} as const;

// ---------------------------------------------------------------------------
// CommentaryEngine output — matches the SYSTEM_PROMPT JSON schema exactly
// ---------------------------------------------------------------------------

export type SetupVerdict =
  | 'valid_long'
  | 'valid_short'
  | 'valid_long_was'
  | 'valid_short_was'
  | 'no_trade'
  | 'wait';

export interface TradePlan {
  direction:  'long' | 'short' | 'none';
  entry:      number | null;
  stop:       number | null;
  target:     number | null;
  rr:         number | null;
  confidence: 'low' | 'medium' | 'high';
  rationale:  string | null;
}

export interface KeyLevel {
  label:    string;
  price:    number;
  color:    'green' | 'red' | 'yellow' | 'blue' | 'gray';
  action:   string;
  priority?: 'primary' | 'secondary';
}

export interface HighestProbabilityTrade {
  setup:       string;
  entry_zone:  string;
  stop:        string;
  targets:     string;
  bias:        'long' | 'short' | 'neutral';
  condition:   string;
}

export interface CandlestickPattern {
  name:       string;                            // e.g. "Bullish Engulfing"
  meaning:    string;                            // 1-sentence plain English for beginners
  signal:     'bullish' | 'bearish' | 'neutral';
  bar_offset: number;                            // 0 = just-closed bar, 1 = one bar back
}

export interface PatternMarker {
  bar_offset: number;
  label:      string;   // max 12 chars (Pine indicator constraint)
  signal:     1 | -1 | 0;  // 1 = bullish, -1 = bearish, 0 = neutral
}

// Payload for 'suggest_level' special cards (Phase 4b.2)
export interface SuggestedLevel {
  price:          number;
  kind:           'support' | 'resistance';
  touchCount:     number;
  firstTouchTime: string | null;
  lastTouchTime:  string | null;
  strength:       number | null;
}

// Payload for 'lifecycle' special cards (Phase 4b.3.b)
export interface LifecycleEvent {
  directive:        'remove' | 'refine' | 'recategorize';
  tracked_level_id: string | null;
  price:            number | null;
  prior_kind:       string | null;
  new_kind:         string | null;
  zone_top:         number | null;
  zone_bottom:      number | null;
  rationale_short:  string;
  evidence:         Record<string, unknown>;
}

export interface CommentaryResult {
  // Standard fields — always present
  headline:                   string;
  objective:                  string;
  steps_what_happened:        string[];
  setup_verdict:              SetupVerdict;
  entry_was:                  string | null;
  what_now:                   string;
  what_not:                   string;
  next_trigger:               string | null;
  key_lesson:                 string | null;
  bottom_line:                string;
  trade_plan:                 TradePlan | null;
  key_levels_to_watch:        KeyLevel[] | null;
  structure_read?:            string;
  highest_probability_trade?: HighestProbabilityTrade | null;
  confidence:                 number;

  // Detected candlestick patterns (optional — null for special-card kinds)
  candlestick_patterns?: CandlestickPattern[] | null;

  // Special-card discriminator (undefined for normal LLM-generated cards)
  kind?: 'suggest_level' | 'lifecycle';

  // Present when kind === 'suggest_level'
  suggested_level?:  SuggestedLevel;
  suggested_levels?: SuggestedLevel[];

  // Present when kind === 'lifecycle'
  lifecycle_event?: LifecycleEvent;
}

// ---------------------------------------------------------------------------
// P&L tracking types
// ---------------------------------------------------------------------------

export interface FeeBreakdown {
  perContractRate: number;  // $/RT
  contractCount:   number;  // round-trips today
  variableFees:    number;  // perContractRate × contractCount
  dailyFixed:      number;  // liquidation + amortized data feed
  totalFees:       number;  // variableFees + dailyFixed
}

export interface PnlSnapshot {
  sessionDate:     string;   // 'YYYY-MM-DD'
  tradeCount:      number;   // round-trips detected
  grossPnl:        number;   // from TV Realized PnL
  unrealizedPnl:   number;   // from TV Unrealized PnL
  fees:            FeeBreakdown;
  netPnl:          number;   // grossPnl − fees.totalFees
  breakevenPoints: number;   // points on next 1-RT trade to reach net zero
  dataAvailable:   boolean;
  message?:        string;   // e.g. "trading panel not open"
}

// ---------------------------------------------------------------------------
// App settings — persisted to userData/settings.json
// ---------------------------------------------------------------------------

export type KeyStatus = 'env' | 'override' | 'missing';

export interface AppSettings {
  autoDraw:            boolean;
  autoRefresh:         boolean;
  persistLevels:       boolean;
  notifications:       boolean;
  cdpPort:             number;
  lineThickness:       1 | 2 | 3;
  labelSize:           'small' | 'normal' | 'large';
  apiKeyOverride:      string;
  // P&L / fee settings
  feePerContract:      number;   // $/RT, default 1.24
  feeLiquidationDaily: number;   // $/day, default 2.50
  feeDataMonthly:      number;   // $/month, default 45.00
  feeTradingDays:      number;   // trading days/month, default 21
  pnlVisible:          boolean;  // show P&L bar
}

// ---------------------------------------------------------------------------
// Annotation types — used by annotator.ts and renderer
// ---------------------------------------------------------------------------

export interface LevelAnnotation {
  slotIndex: number; // 1–8, maps to Pine Script slot
  price:     number;
  kind:      string; // 'support' | 'resistance' | 'neutral'
  label:     string;
  visible:   number; // 1 = draw, 0 = hide
  priority:  string; // 'primary' | 'secondary'
}

export interface AlertCreatePayload {
  price: number;
  label: string;
}

export type AlertCreateResult =
  | { ok: true;  alertId: string }
  | { ok: false; error: string };

// ---------------------------------------------------------------------------
// Wrapper returned from bridge.runAnalysis()
// ---------------------------------------------------------------------------

export interface AnalysisResult {
  symbol:         string;
  timeframe:      string;
  closedBarPrice: number;
  /** Epoch ms when the current open bar closes (lastBarOpenSecs + resolution*60)*1000). Zero when unavailable (daily/weekly). */
  barCloseMs:     number;
  commentary:     CommentaryResult;
}

export interface GDriveStatus {
  authenticated: boolean;
  email?: string;
}

// ---------------------------------------------------------------------------
// window.api surface (preload / renderer contract)
// ---------------------------------------------------------------------------

export interface ElectronAPI {
  requestAnalysis(): Promise<AnalysisResult>;
  getSnapshot(): Promise<unknown>;
  onStatus(cb: (status: AnalysisStatus) => void): () => void;
  onAnalysis(cb: (result: AnalysisResult) => void): () => void;
  /** nextMs: epoch ms of the next scheduled refresh */
  onNextTick(cb: (nextMs: number) => void): () => void;
  /** Write a single slot to the TA Levels Pine indicator */
  toggleLevel(slotIndex: number, price: number, kind: string, label: string, visible: number, priority: string): Promise<void>;
  /** Write all levels at once (all 32 inputs) */
  drawAllLevels(levels: LevelAnnotation[]): Promise<void>;
  /** Zero out all 8 slots */
  clearAllLevels(): Promise<void>;
  getSettings(): Promise<AppSettings>;
  updateSettings(partial: Partial<AppSettings>): Promise<AppSettings>;
  pauseScheduler(): Promise<void>;
  resumeScheduler(): Promise<void>;
  reconnectBridge(): Promise<void>;
  getKeyStatus(): Promise<KeyStatus>;
  getAppVersion(): Promise<string>;
  /** Draw entry/stop/target bracket on chart (writes in_43–in_45) */
  writeTradePlan(entry: number, stop: number, target: number): Promise<void>;
  /** Clear bracket — zeros out in_43–in_45 */
  clearTradePlan(): Promise<void>;
  getPnl(): Promise<PnlSnapshot>;
  onPnlUpdate(cb: (snapshot: PnlSnapshot) => void): () => void;
  exportToDrive(): Promise<{ filePath?: string; cancelled?: boolean }>;
  /** Write up to 4 candle pattern markers to the TA Levels Pine indicator (in_46–in_57) */
  writePatternMarkers(markers: PatternMarker[]): Promise<void>;
  createAlert(payload: AlertCreatePayload): Promise<AlertCreateResult>;
  removeAlert(price: number): Promise<void>;
}
