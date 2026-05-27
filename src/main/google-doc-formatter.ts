import type { AnalysisResult } from '../shared/types';

const VERDICT_LABEL: Record<string, string> = {
  valid_long:      'LONG',
  valid_long_was:  'LONG (WAS)',
  valid_short:     'SHORT',
  valid_short_was: 'SHORT (WAS)',
  no_trade:        'NO TRADE',
  wait:            'WAIT',
};

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function fmt(n: number | null): string {
  return n != null ? n.toFixed(2) : '—';
}

function stripLeadingNumber(s: string): string {
  return s.replace(/^\d+[.)]\s*/, '');
}

export function formatAsHtml(result: AnalysisResult): string {
  const { symbol, timeframe, closedBarPrice, commentary } = result;
  const {
    headline, setup_verdict, objective, steps_what_happened,
    what_now, what_not, trade_plan, key_levels_to_watch,
    structure_read, highest_probability_trade,
    bottom_line, next_trigger, key_lesson,
  } = commentary;

  const verdict   = VERDICT_LABEL[setup_verdict] ?? setup_verdict;
  const now       = new Date();
  const pad       = (n: number) => n.toString().padStart(2, '0');
  const timestamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`;

  const parts: string[] = [
    `<h1>${esc(verdict)}: ${esc(headline)}</h1>`,
    `<p><strong>${esc(symbol)} ${esc(timeframe)}m @ ${closedBarPrice.toFixed(2)}</strong> · ${timestamp}</p>`,
  ];

  if (structure_read) {
    parts.push(`<h2>Structure</h2><p>${esc(structure_read)}</p>`);
  }

  if (key_levels_to_watch && key_levels_to_watch.length > 0) {
    parts.push('<h2>Key Levels</h2><ul>');
    for (const lvl of key_levels_to_watch) {
      parts.push(`<li><strong>${lvl.price.toFixed(2)}</strong> ${esc(lvl.label)} — ${esc(lvl.action)}</li>`);
    }
    parts.push('</ul>');
  }

  if (highest_probability_trade) {
    const hpt = highest_probability_trade;
    parts.push(`<h2>Best Setup</h2><p>${esc(hpt.setup)}</p>`);
    parts.push(`<p>Entry: ${esc(hpt.entry_zone)} | Stop: ${esc(hpt.stop)} | Targets: ${esc(hpt.targets)}</p>`);
    if (hpt.condition) {
      parts.push(`<p><strong>IF:</strong> ${esc(hpt.condition)}</p>`);
    }
  }

  if (trade_plan && trade_plan.direction !== 'none') {
    const tp = trade_plan;
    parts.push(`<h2>Trade Plan (${esc(tp.direction.toUpperCase())})</h2>`);
    parts.push(
      `<table><tr><th>Entry</th><th>Stop</th><th>Target</th><th>R:R</th><th>Confidence</th></tr>` +
      `<tr><td>${fmt(tp.entry)}</td><td>${fmt(tp.stop)}</td><td>${fmt(tp.target)}</td>` +
      `<td>${tp.rr != null ? tp.rr.toFixed(1) + 'R' : '—'}</td><td>${esc(tp.confidence.toUpperCase())}</td></tr></table>`,
    );
    if (tp.rationale) parts.push(`<p>${esc(tp.rationale)}</p>`);
  }

  if (steps_what_happened.length > 0) {
    parts.push('<h2>What Happened</h2><ol>');
    for (const step of steps_what_happened) {
      parts.push(`<li>${esc(stripLeadingNumber(step))}</li>`);
    }
    parts.push('</ol>');
  }

  parts.push(`<h2>Chart State</h2><p>${esc(objective)}</p>`);
  parts.push(
    `<h2>Directives</h2>` +
    `<p><strong>NOW:</strong> ${esc(what_now)}</p>` +
    `<p><strong>NOT:</strong> ${esc(what_not)}</p>`,
  );
  parts.push(`<h2>Summary</h2><p>${esc(bottom_line)}</p>`);
  if (next_trigger) parts.push(`<p><strong>IF:</strong> ${esc(next_trigger)}</p>`);
  if (key_lesson)   parts.push(`<p><em>LESSON: ${esc(key_lesson)}</em></p>`);

  return parts.join('\n');
}

export function docName(result: AnalysisResult): string {
  const { symbol, timeframe, commentary } = result;
  const verdict = VERDICT_LABEL[commentary.setup_verdict] ?? commentary.setup_verdict;
  const now     = new Date();
  const pad     = (n: number) => n.toString().padStart(2, '0');
  const date    = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  const time    = `${pad(now.getHours())}:${pad(now.getMinutes())}`;
  return `${symbol} ${timeframe}m — ${verdict} — ${date} ${time}`;
}
