export type AppStatus = 'active' | 'inactive';

export type AnalysisStatus = 'idle' | 'capturing' | 'analyzing' | 'complete' | 'error';

export const IPC = {
  ANALYZE_RUN: 'analyze:run',
  ANALYZE_STATUS: 'analyze:status',
} as const;

export interface AnalysisResult {
  instrument: string;
  timeframe: string;
  current_price: number;
  bias: 'bullish' | 'bearish' | 'neutral';
  market_structure: {
    trend: string;
    pattern: string;
    higher_highs: boolean;
    higher_lows: boolean;
    description: string;
  };
  key_levels: {
    resistance: Array<{ price: number; type: string; description: string }>;
    support: Array<{ price: number; type: string; description: string }>;
  };
  moving_averages: {
    ma200_price: number | null;
    price_vs_ma200: 'above' | 'below' | 'at';
  };
  setups: Array<{
    name: string;
    direction: 'long' | 'short';
    type: 'primary' | 'alternative';
    entry: { trigger: string; price: number };
    stop_loss: { price: number; description: string };
    targets: Array<{ label: string; price: number }>;
    reasoning: string;
  }>;
  bearish_scenario: {
    trigger: string;
    downside_targets: Array<{ label: string; price: number }>;
    invalidation: string;
  };
  trade_bias: {
    intraday: string;
    momentum: string;
    structure: string;
    risk: string;
  };
  focus_areas: string[];
  markdown_summary: string;
}
