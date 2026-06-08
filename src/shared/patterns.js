// patterns.js
// Deterministic candlestick classifier. Pure functions, no external deps.
// A "candle" is { time, open, high, low, close, volume? }.
// All thresholds are configurable per call so you can tune to your instrument
// and timeframe without rebuilding the engine.

const DEFAULTS = {
  dojiBodyRatio: 0.1,
  longShadowMultiple: 2.0,
  smallOppositeShadowRatio: 0.15,
  pinBarWickRatio: 0.6,
  engulfTolerance: 0.0,
};

function safe(c) {
  return {
    time: c.time,
    open: +c.open,
    high: +c.high,
    low: +c.low,
    close: +c.close,
    volume: c.volume == null ? null : +c.volume,
  };
}

function metrics(c) {
  const range = c.high - c.low;
  const body = Math.abs(c.close - c.open);
  const upperWick = c.high - Math.max(c.open, c.close);
  const lowerWick = Math.min(c.open, c.close) - c.low;
  const direction = c.close > c.open ? "bull" : c.close < c.open ? "bear" : "flat";
  return { range, body, upperWick, lowerWick, direction };
}

function classifySingle(candle, opts = {}) {
  const cfg = { ...DEFAULTS, ...opts };
  const c = safe(candle);
  const m = metrics(c);
  const tags = [];

  tags.push(m.direction === "bull" ? "bullish" : m.direction === "bear" ? "bearish" : "flat");

  if (m.range === 0) {
    tags.push("zero-range");
    return { candle: c, metrics: m, tags };
  }

  const bodyRatio = m.body / m.range;
  const upperWickRatio = m.upperWick / m.range;
  const lowerWickRatio = m.lowerWick / m.range;

  if (bodyRatio <= cfg.dojiBodyRatio) {
    tags.push("doji");
    if (upperWickRatio > 0.4 && lowerWickRatio > 0.4) tags.push("long-legged-doji");
    if (upperWickRatio < 0.05 && lowerWickRatio > 0.6) tags.push("dragonfly-doji");
    if (lowerWickRatio < 0.05 && upperWickRatio > 0.6) tags.push("gravestone-doji");
  }

  const longLower = m.lowerWick >= cfg.longShadowMultiple * m.body && m.body > 0;
  const smallUpper = m.upperWick <= cfg.smallOppositeShadowRatio * m.range;
  if (longLower && smallUpper) {
    tags.push(m.direction === "bull" ? "hammer" : "hanging-man");
  }

  const longUpper = m.upperWick >= cfg.longShadowMultiple * m.body && m.body > 0;
  const smallLower = m.lowerWick <= cfg.smallOppositeShadowRatio * m.range;
  if (longUpper && smallLower) {
    tags.push(m.direction === "bull" ? "inverted-hammer" : "shooting-star");
  }

  if (lowerWickRatio >= cfg.pinBarWickRatio) tags.push("bullish-pin-bar");
  if (upperWickRatio >= cfg.pinBarWickRatio) tags.push("bearish-pin-bar");

  if (bodyRatio >= 0.95) {
    tags.push(m.direction === "bull" ? "bullish-marubozu" : "bearish-marubozu");
  }

  return { candle: c, metrics: m, tags, ratios: { bodyRatio, upperWickRatio, lowerWickRatio } };
}

function classifyPair(prev, curr, opts = {}) {
  const cfg = { ...DEFAULTS, ...opts };
  const p = safe(prev);
  const c = safe(curr);
  const tags = [];

  const pBody = Math.abs(p.close - p.open);
  const cBody = Math.abs(c.close - c.open);
  const pHigh = Math.max(p.open, p.close);
  const pLow = Math.min(p.open, p.close);

  const pBull = p.close > p.open;
  const pBear = p.close < p.open;
  const cBull = c.close > c.open;
  const cBear = c.close < c.open;

  if (
    pBear && cBull &&
    c.open <= pLow * (1 - cfg.engulfTolerance) &&
    c.close >= pHigh * (1 + cfg.engulfTolerance) &&
    cBody > pBody
  ) {
    tags.push("bullish-engulfing");
  }

  if (
    pBull && cBear &&
    c.open >= pHigh * (1 + cfg.engulfTolerance) &&
    c.close <= pLow * (1 - cfg.engulfTolerance) &&
    cBody > pBody
  ) {
    tags.push("bearish-engulfing");
  }

  if (c.high <= p.high && c.low >= p.low) tags.push("inside-bar");
  if (c.high >= p.high && c.low <= p.low) tags.push("outside-bar");

  if (pBear && cBull && c.high <= pHigh && c.low >= pLow && cBody < pBody) tags.push("bullish-harami");
  if (pBull && cBear && c.high <= pHigh && c.low >= pLow && cBody < pBody) tags.push("bearish-harami");

  const eps = (p.high - p.low) * 0.001;
  if (Math.abs(p.high - c.high) <= eps && pBull && cBear) tags.push("tweezer-top");
  if (Math.abs(p.low - c.low) <= eps && pBear && cBull) tags.push("tweezer-bottom");

  return tags;
}

function classifyTriple(c1, c2, c3, opts = {}) {
  const tags = [];
  const a = safe(c1), b = safe(c2), c = safe(c3);

  const aBull = a.close > a.open, bBull = b.close > b.open, cBull = c.close > c.open;
  const aBear = a.close < a.open, bBear = b.close < b.open, cBear = c.close < c.open;

  if (aBull && bBull && cBull && b.close > a.close && c.close > b.close) tags.push("three-white-soldiers");
  if (aBear && bBear && cBear && b.close < a.close && c.close < b.close) tags.push("three-black-crows");

  const aBody = Math.abs(a.close - a.open);
  const bBody = Math.abs(b.close - b.open);
  const aMid = (a.open + a.close) / 2;
  if (aBear && bBody < aBody * 0.5 && cBull && c.close > aMid) tags.push("morning-star");
  if (aBull && bBody < aBody * 0.5 && cBear && c.close < aMid) tags.push("evening-star");

  return tags;
}

function classifyLatest(candles, opts = {}) {
  if (!candles || candles.length === 0) return null;
  const n = candles.length;
  const single = classifySingle(candles[n - 1], opts);
  const pair = n >= 2 ? classifyPair(candles[n - 2], candles[n - 1], opts) : [];
  const triple = n >= 3 ? classifyTriple(candles[n - 3], candles[n - 2], candles[n - 1], opts) : [];
  return {
    ...single,
    tags: [...single.tags, ...pair, ...triple],
    pairTags: pair,
    tripleTags: triple,
  };
}

const NOTABLE = new Set([
  "hammer", "hanging-man", "inverted-hammer", "shooting-star",
  "bullish-engulfing", "bearish-engulfing",
  "bullish-pin-bar", "bearish-pin-bar",
  "bullish-marubozu", "bearish-marubozu",
  "morning-star", "evening-star",
  "three-white-soldiers", "three-black-crows",
  "tweezer-top", "tweezer-bottom",
  "dragonfly-doji", "gravestone-doji",
]);

function isNotable(classification) {
  if (!classification) return false;
  return classification.tags.some((t) => NOTABLE.has(t));
}

module.exports = {
  DEFAULTS,
  classifySingle,
  classifyPair,
  classifyTriple,
  classifyLatest,
  isNotable,
  NOTABLE,
};
