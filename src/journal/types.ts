export interface TradeRecord {
  id:            number;
  created_at:    number;
  symbol:        string;
  timeframe:     string;
  direction:     'long' | 'short' | 'unknown';
  entry_price:   number | null;
  stop_price:    number | null;
  target_price:  number | null;
  trailing_stop: boolean;
  rr_planned:    number | null;
  verdict:       'valid_long' | 'valid_short' | 'manual';
  headline:      string | null;
  objective:     string | null;
  steps_json:    string | null;   // JSON string[]
  structure:     string | null;
  rationale:     string | null;
  patterns_json: string | null;   // JSON string[]
  confidence:    number | null;
  // Provenance
  account_type:     'amp_live' | 'paper' | null;
  qty:              number | null;
  direction_source: 'positions_panel' | 'order_history' | 'cached' | 'unknown' | null;
  entry_source:     'observed' | 'rescued' | null;
  needs_review:     boolean;
  // Exit
  exit_at:       number | null;
  exit_price:    number | null;
  exit_source:   'derived' | null;
  pnl_gross:     number | null;
  pnl_net:       number | null;
  r_multiple:    number | null;
  // User
  notes:         string | null;
  tags_json:     string | null;   // JSON string[]
  critique_json: string | null;   // JSON { text, created_at }
}

export interface TradeLesson {
  id:           number;
  created_at:   number;
  trade_id:     number | null;
  symbol:       string;
  timeframe:    string | null;
  direction:    string | null;
  pattern:      string | null;
  outcome:      string | null;
  lesson_text:  string;
  context_text: string | null;
  approved:     boolean;
}

export interface TradeStats {
  totalTrades:      number;
  winCount:         number;
  lossCount:        number;
  openCount:        number;
  winRate:          number;
  avgR:             number;
  totalNetPnl:      number;
  needsReviewCount: number;
  byPattern:     Array<{ pattern: string; count: number; wins: number; winRate: number; avgR: number }>;
  byHour:        Array<{ hour: number; count: number; avgNetPnl: number }>;
  equityCurve:   Array<{ date: string; cumulativeNet: number }>;
  byConfidenceBucket: Array<{
    bucket: string;
    count: number;
    wins: number;
    winRate: number;
    avgR: number;
  }>;
  byDayOfWeek: Array<{
    dow: number;
    label: string;
    count: number;
    avgNetPnl: number;
    winRate: number;
  }>;
}

/** One win-rate bucket on the recommendation scorecard. */
export interface ScorecardBucket {
  label:   string;
  graded:  number;
  wins:    number;
  losses:  number;
  winRate: number;
  avgNetR: number | null;
}

/**
 * Win rate of the app's own recommendations, graded from bars.
 * `mode` is 0 for live calls and 1 for Bar Replay — never mixed.
 */
export interface Scorecard {
  graded:       number;
  wins:         number;
  losses:       number;
  winRate:      number;
  avgNetR:      number | null;
  avgGrossR:    number | null;
  ambiguous:    number;
  expired:      number;
  notTriggered: number;
  ungradeable:  number;
  pending:      number;
  total:        number;
  bySetup:      ScorecardBucket[];
  byHour:       ScorecardBucket[];
  byDirection:  ScorecardBucket[];
  breakEven:    number | null;
  medianRr:     number | null;
  mode:         number;
  /** Which rules version these numbers are filtered to, or null for all. */
  rulesVersion: string | null;
  /** Every rules version present, newest first. */
  versions:     Array<{ rules_version: string; n: number; lastSeen: number }>;
  /** Calls the lever blocked, graded anyway. Never folded into the numbers above. */
  blocked: {
    graded:  number;
    wins:    number;
    losses:  number;
    winRate: number;
    avgNetR: number | null;
    total:   number;
  };
}
