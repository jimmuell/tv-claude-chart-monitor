import React from 'react';

// ─── Bar Chart (horizontal) ────────────────────────────────────────────────

interface BarItem {
  label: string;
  value: number;
  maxValue?: number;
  color?: string;
}

interface BarChartProps {
  data: BarItem[];
  height?: number;
  showValue?: boolean;
  formatValue?: (v: number) => string;
}

export function BarChart({ data, height = 200, showValue = true, formatValue }: BarChartProps) {
  if (!data.length) return <div style={{ color: 'var(--text-secondary)', fontSize: 12, padding: '1rem 0' }}>No data</div>;

  const maxVal = Math.max(...data.map(d => Math.abs(d.value)), 0.001);
  const barH = Math.max(16, Math.floor((height - data.length * 6) / data.length));
  const labelW = 130;
  const valueW = 60;
  const svgW = 600;
  const trackW = svgW - labelW - valueW - 8;

  const svgHeight = data.length * (barH + 6) + 4;

  return (
    <svg
      viewBox={`0 0 ${svgW} ${svgHeight}`}
      width="100%"
      style={{ display: 'block', overflow: 'visible' }}
      aria-label="Bar chart"
    >
      {data.map((item, i) => {
        const y = i * (barH + 6) + 2;
        const frac = Math.abs(item.value) / maxVal;
        const w = Math.max(2, frac * trackW);
        const color = item.color ?? (item.value >= 0 ? 'var(--accent)' : 'var(--bearish)');
        const displayVal = formatValue ? formatValue(item.value) : item.value.toFixed(1);

        return (
          <g key={i}>
            {/* label */}
            <text
              x={labelW - 6}
              y={y + barH / 2 + 4}
              textAnchor="end"
              fontSize={11}
              fill="var(--text-secondary)"
              style={{ fontFamily: 'var(--font)' }}
            >
              {item.label.length > 18 ? item.label.slice(0, 17) + '…' : item.label}
            </text>
            {/* track */}
            <rect
              x={labelW}
              y={y}
              width={trackW}
              height={barH}
              rx={3}
              fill="var(--bg)"
            />
            {/* bar */}
            <rect
              x={labelW}
              y={y}
              width={w}
              height={barH}
              rx={3}
              fill={color}
              opacity={0.85}
            />
            {/* value */}
            {showValue && (
              <text
                x={labelW + trackW + 6}
                y={y + barH / 2 + 4}
                textAnchor="start"
                fontSize={11}
                fill="var(--text-primary)"
                style={{ fontFamily: 'var(--font)' }}
              >
                {displayVal}
              </text>
            )}
          </g>
        );
      })}
    </svg>
  );
}

// ─── Line Chart (equity curve) ─────────────────────────────────────────────

interface LinePoint {
  label: string;
  value: number;
}

interface LineChartProps {
  data: LinePoint[];
  height?: number;
  color?: string;
  formatValue?: (v: number) => string;
}

export function LineChart({ data, height = 150, color = 'var(--accent)', formatValue }: LineChartProps) {
  if (data.length < 2) {
    return <div style={{ color: 'var(--text-secondary)', fontSize: 12, padding: '0.5rem 0' }}>Not enough data</div>;
  }

  const svgW = 600;
  const svgH = height;
  const padL = 56;
  const padR = 16;
  const padT = 12;
  const padB = 28;
  const plotW = svgW - padL - padR;
  const plotH = svgH - padT - padB;

  const values = data.map(d => d.value);
  const minV = Math.min(...values);
  const maxV = Math.max(...values);
  const range = maxV - minV || 1;

  const toX = (i: number) => padL + (i / (data.length - 1)) * plotW;
  const toY = (v: number) => padT + plotH - ((v - minV) / range) * plotH;

  const points = data.map((d, i) => `${toX(i)},${toY(d.value)}`).join(' ');

  // zero line
  const zeroY = toY(0);
  const showZero = minV < 0 && maxV > 0;

  // Y axis labels
  const yLabels = [minV, (minV + maxV) / 2, maxV];

  // X axis ticks (show ~5 evenly spaced)
  const xTickCount = Math.min(5, data.length);
  const xTicks = Array.from({ length: xTickCount }, (_, i) =>
    Math.round((i / (xTickCount - 1)) * (data.length - 1))
  );

  return (
    <svg
      viewBox={`0 0 ${svgW} ${svgH}`}
      width="100%"
      style={{ display: 'block', overflow: 'visible' }}
      aria-label="Line chart"
    >
      {/* zero line */}
      {showZero && (
        <line
          x1={padL} y1={zeroY} x2={svgW - padR} y2={zeroY}
          stroke="var(--border)" strokeWidth={1} strokeDasharray="4,3"
        />
      )}

      {/* Y axis labels */}
      {yLabels.map((v, i) => {
        const y = toY(v);
        const label = formatValue ? formatValue(v) : v.toFixed(0);
        return (
          <text key={i} x={padL - 6} y={y + 4} textAnchor="end" fontSize={9} fill="var(--text-secondary)">
            {label}
          </text>
        );
      })}

      {/* X axis labels */}
      {xTicks.map((idx) => {
        const x = toX(idx);
        const label = data[idx].label;
        return (
          <text key={idx} x={x} y={svgH - 6} textAnchor="middle" fontSize={9} fill="var(--text-secondary)">
            {label.length > 10 ? label.slice(5) : label}
          </text>
        );
      })}

      {/* Fill under line */}
      <defs>
        <linearGradient id="fill-gradient" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.2" />
          <stop offset="100%" stopColor={color} stopOpacity="0.02" />
        </linearGradient>
      </defs>
      <polygon
        points={`${padL},${padT + plotH} ${points} ${svgW - padR},${padT + plotH}`}
        fill="url(#fill-gradient)"
      />

      {/* Line */}
      <polyline
        points={points}
        fill="none"
        stroke={color}
        strokeWidth={1.5}
        strokeLinejoin="round"
        strokeLinecap="round"
      />

      {/* Dots at first and last */}
      {[0, data.length - 1].map(i => (
        <circle key={i} cx={toX(i)} cy={toY(data[i].value)} r={3} fill={color} />
      ))}
    </svg>
  );
}
