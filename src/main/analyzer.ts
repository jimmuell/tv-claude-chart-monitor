import { AnalysisResult } from '../shared/types';

const CLAUDE_MODEL = 'claude-sonnet-4-20250514';

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
    model: CLAUDE_MODEL,
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

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 60_000);
  let response: Response;
  try {
    response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeoutId);
  }

  if (!response.ok) {
    const errBody = await response.text();
    throw new Error(`Anthropic API error ${response.status}: ${errBody}`);
  }

  const data = (await response.json()) as {
    content: Array<{ type: string; text: string }>;
  };

  const block = data.content[0];
  if (!block || block.type !== 'text' || !block.text) {
    throw new Error(`Unexpected Claude response shape: content[0] type is "${block?.type ?? 'missing'}"`);
  }
  const rawText = block.text;

  let parsed: AnalysisResult;
  try {
    parsed = JSON.parse(rawText) as AnalysisResult;
  } catch (err) {
    throw new Error(`Failed to parse Claude response as JSON: ${(err as Error).message}`);
  }

  return parsed;
}
