export interface TradeRecord {
  id:            number;
  created_at:    number;
  symbol:        string;
  timeframe:     string;
  direction:     'long' | 'short';
  entry_price:   number | null;
  stop_price:    number | null;
  target_price:  number | null;
  trailing_stop: boolean;
  rr_planned:    number | null;
  verdict:       'valid_long' | 'valid_short';
  headline:      string | null;
  objective:     string | null;
  steps_json:    string | null;   // JSON string[]
  structure:     string | null;
  rationale:     string | null;
  patterns_json: string | null;   // JSON string[]
  confidence:    number | null;
  exit_at:       number | null;
  exit_price:    number | null;
  pnl_gross:     number | null;
  pnl_net:       number | null;
  r_multiple:    number | null;
  notes:         string | null;
  tags_json:     string | null;   // JSON string[]
  critique_json: string | null;   // JSON { text, created_at }
}

export interface TradeStats {
  totalTrades:   number;
  winCount:      number;
  lossCount:     number;
  openCount:     number;
  winRate:       number;
  avgR:          number;
  totalNetPnl:   number;
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
