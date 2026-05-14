// AnalysisResult is inlined here to avoid a rootDir conflict with src/shared/types.ts.
// The canonical definition lives in src/shared/types.ts; keep them in sync.
interface AnalysisResult {
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

const SYSTEM_PROMPT = `You are analyzing a live TradingView chart screenshot.
Identify the instrument, timeframe, and current price from the chart.
Analyze candlestick patterns, support/resistance levels, moving averages, and market structure.
Provide specific price levels, not vague descriptions.
The markdown_summary should be a complete, standalone trade report.
Return ONLY valid JSON, no markdown fences, no preamble.`;

export async function analyzeChart(base64Image: string): Promise<AnalysisResult> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error('ANTHROPIC_API_KEY environment variable is not set.');
  }

  const body = {
    model: 'claude-sonnet-4-20250514',
    max_tokens: 4096,
    system: SYSTEM_PROMPT,
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'image',
            source: {
              type: 'base64',
              media_type: 'image/png',
              data: base64Image,
            },
          },
          {
            type: 'text',
            text: 'Analyze this TradingView chart and return the JSON analysis.',
          },
        ],
      },
    ],
  };

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    throw new Error(`Anthropic API error: ${response.status} ${response.statusText}`);
  }

  const data = (await response.json()) as {
    content: Array<{ type: string; text: string }>;
  };

  const rawText = data.content[0]?.text;
  if (!rawText) {
    throw new Error('Failed to parse Claude response as JSON');
  }

  let parsed: AnalysisResult;
  try {
    parsed = JSON.parse(rawText) as AnalysisResult;
  } catch {
    throw new Error('Failed to parse Claude response as JSON');
  }

  return parsed;
}
