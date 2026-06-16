// context.js
// Builds the structured context object that the actionability filter and the
// LLM commentary engine both consume. Wraps patterns.js with trend, zone-state,
// MA-relative, and recent-action information.

const { classifyLatest, classifySingle, isNotable } = require("./patterns");
const { computeOrbState, parseOrbConfig } = require("./strategies/orb");
const { detectSwingPivots } = require("./detectors/swing-pivots");

// Priority order for cross-source dedup. Higher number wins when two zones
// from DIFFERENT sources end up at the same price (within tolerance).
// tvcm > orb > tracked-drawing > drawing — see Phase 4b.2 design doc.
const ZONE_SOURCE_PRIORITY = {
  tvcm: 4,
  orb: 3,
  'tracked-drawing': 2,
  drawing: 1,
};

function zonePriority(z) {
  return ZONE_SOURCE_PRIORITY[z && z.source] || 0;
}

// Cross-source dedup: when two zones from DIFFERENT sources land within
// `tolerance` of each other, keep the higher-priority one. Same-source
// duplicates pass through (it's the user's configuration to manage).
function dedupZones(zones, tolerance) {
  const out = [];
  for (const z of zones) {
    const zp = z && typeof z.price === 'number' ? z.price : null;
    if (zp == null) { out.push(z); continue; }
    const dupIdx = out.findIndex((r) => {
      if (!r || r.source === z.source) return false;
      if (typeof r.price !== 'number') return false;
      return Math.abs(r.price - zp) <= tolerance;
    });
    if (dupIdx === -1) {
      out.push(z);
    } else if (zonePriority(z) > zonePriority(out[dupIdx])) {
      out[dupIdx] = z;
    }
    // else: lower priority — drop z silently.
  }
  return out;
}

// Convert TV drawings AND TVCM-protocol indicator data into normalized "zone"
// records the rest of the engine can reason about. Each entry carries a
// `source` tag ('drawing' | 'tvcm' | 'orb' | 'tracked-drawing') so commentary
// and debugging can tell where the level came from. TVCM data takes precedence
// visually because it has a real `kind` from the protocol; drawings fall back
// to the drawing tool name. Tracked-drawing entries (Phase 4b.2) are persisted
// horizontal lines the user has drawn that we want to surface across sessions.
//
// Signature is backward-compatible: third argument (TVCM studies) and the
// `extra` opts bag are both optional. Older callers passing only
// `(drawings, tickSize)` keep working.
//
// `extra` accepts:
//   - trackedLevelEntries: pre-built zone records (source='tracked-drawing')
//   - orbZoneEntries:      pre-built zone records (source='orb')
//   - dedupToleranceTicks: tolerance for cross-source dedup (default 2 ticks)
function normalizeZones(drawings, tickSize = 0.25, tvcmStudies = null, extra = {}) {
  const zones = [];

  // ---- drawings (legacy / fallback path) ----
  for (const d of drawings || []) {
    const id = d.id;
    const label = d.text || d.type || id;
    const color = d.color || null;
    if (d.type === "horizontal_line" || d.type === "horizontal_ray") {
      const price = d.points && d.points[0] && d.points[0].price;
      if (price == null) continue;
      zones.push({
        id, label, color, kind: "level", price,
        lo: price - tickSize / 2, hi: price + tickSize / 2,
        source: "drawing",
      });
    } else if (d.type === "rectangle" || d.type === "long_position" || d.type === "short_position") {
      const ps = d.points || [];
      const prices = ps.map((p) => p.price).filter((p) => p != null);
      if (prices.length < 2) continue;
      const lo = Math.min(...prices), hi = Math.max(...prices);
      zones.push({
        id, label, color, kind: "zone", lo, hi, price: (lo + hi) / 2,
        source: "drawing",
      });
    } else if (d.type === "trend_line" || d.type === "trendline") {
      // Trendlines need slope/intercept; skip for now.
      continue;
    }
  }

  // ---- TVCM protocol path (Phase 2.5+) ----
  // Indicator inputs are first-class and stable. We trust the kind verbatim.
  for (const study of tvcmStudies || []) {
    if (!study) continue;
    const studyId = study.id || "tvcm";
    const strategyName = study.strategyName || null;
    const role = study.role || "base";
    for (const lvl of study.levels || []) {
      if (lvl == null || lvl.price == null) continue;
      const id = `tvcm:${studyId}:level:${lvl.n}`;
      const label = lvl.label || `${lvl.kind}@${lvl.price}`;
      zones.push({
        id, label,
        color: lvl.color || null,
        kind: lvl.kind || "level",
        price: lvl.price,
        lo: lvl.price - tickSize / 2,
        hi: lvl.price + tickSize / 2,
        source: "tvcm",
        tvcm: { studyId, studyName: study.name || null, role, strategyName, slot: lvl.n, isLevel: true },
      });
    }
    for (const zn of study.zones || []) {
      if (zn == null || zn.low == null || zn.high == null) continue;
      const id = `tvcm:${studyId}:zone:${zn.n}`;
      const label = zn.label || `${zn.kind} ${zn.low}-${zn.high}`;
      zones.push({
        id, label,
        color: zn.color || null,
        kind: zn.kind || "zone",
        lo: zn.low,
        hi: zn.high,
        price: (zn.low + zn.high) / 2,
        source: "tvcm",
        tvcm: { studyId, studyName: study.name || null, role, strategyName, slot: zn.n, isLevel: false },
      });
    }
  }

  // ---- tracked-drawing path (Phase 4b.2) ----
  // Caller has already enriched these (kind, lo/hi, etc.) since the kind
  // inference needs a current-price reference. Just append.
  for (const entry of extra.trackedLevelEntries || []) {
    if (entry) zones.push(entry);
  }

  // ---- ORB path (Phase 4a) ----
  // Same convention: caller built the entries from orbState; we just append
  // here so dedup sees the full multi-source set in one pass.
  for (const entry of extra.orbZoneEntries || []) {
    if (entry) zones.push(entry);
  }

  // Cross-source dedup. Tolerance defaults to 2 ticks (0.5 at MES tickSize)
  // — small enough that genuinely different levels stay separate, large
  // enough that a hand-drawn line on a TVCM-configured price still collapses.
  const dedupToleranceTicks = (extra.dedupToleranceTicks != null) ? extra.dedupToleranceTicks : 2;
  const dedupTolerance = dedupToleranceTicks * tickSize;
  return dedupZones(zones, dedupTolerance);
}

// Compute simple moving average on close.
function sma(candles, period) {
  if (!candles || candles.length < period) return null;
  let sum = 0;
  for (let i = candles.length - period; i < candles.length; i++) sum += candles[i].close;
  return sum / period;
}

// Detect trend by comparing close to MA over recent window plus higher-highs / lower-lows.
function detectTrend(candles, maPeriod = 20) {
  if (!candles || candles.length < maPeriod + 5) return { trend: "unknown", reason: "not-enough-data" };
  const last = candles[candles.length - 1];
  const ma = sma(candles, maPeriod);
  const maPrev = sma(candles.slice(0, candles.length - 5), maPeriod);
  const maRising = ma != null && maPrev != null && ma > maPrev;
  const maFalling = ma != null && maPrev != null && ma < maPrev;

  // Simple swing structure: count higher highs / lower lows in last 10 bars.
  const window = candles.slice(-10);
  let hh = 0, ll = 0;
  for (let i = 1; i < window.length; i++) {
    if (window[i].high > window[i - 1].high) hh++;
    if (window[i].low < window[i - 1].low) ll++;
  }

  if (last.close > ma && maRising && hh >= ll) return { trend: "up", ma, maRising, reason: "close>MA, MA rising" };
  if (last.close < ma && maFalling && ll >= hh) return { trend: "down", ma, maFalling, reason: "close<MA, MA falling" };
  return { trend: "sideways", ma, reason: "mixed signals" };
}

// Distance helpers.
function nearestZone(price, zones) {
  if (!zones || zones.length === 0) return null;
  let best = null;
  for (const z of zones) {
    const d = price < z.lo ? z.lo - price : price > z.hi ? price - z.hi : 0;
    if (best == null || d < best.distance) best = { zone: z, distance: d };
  }
  return best;
}

// Determine zone interaction for the most recently closed bar.
// Possible states: 'inside', 'rejected_top', 'rejected_bottom', 'broke_up', 'broke_down', 'approaching', 'none'.
function zoneInteraction(prev, curr, zone) {
  const pInZone = prev && prev.close >= zone.lo && prev.close <= zone.hi;
  const cInZone = curr.close >= zone.lo && curr.close <= zone.hi;
  const cAboveZone = curr.close > zone.hi;
  const cBelowZone = curr.close < zone.lo;
  const wickedTop = curr.high >= zone.hi && curr.close < zone.hi;
  const wickedBottom = curr.low <= zone.lo && curr.close > zone.lo;
  const wasBelow = prev && prev.close < zone.lo;
  const wasAbove = prev && prev.close > zone.hi;

  if (cInZone) return "inside";
  if (wasBelow && cAboveZone) return "broke_up";
  if (wasAbove && cBelowZone) return "broke_down";
  if (wickedTop && curr.close < zone.lo + (zone.hi - zone.lo) / 2) return "rejected_top";
  if (wickedBottom && curr.close > zone.hi - (zone.hi - zone.lo) / 2) return "rejected_bottom";
  return "none";
}

// MA-cross / MA-touch detection on the latest closed bar.
function maEvents(candles, maPeriod = 20) {
  if (!candles || candles.length < maPeriod + 2) return [];
  const ma = sma(candles, maPeriod);
  const prevMa = sma(candles.slice(0, candles.length - 1), maPeriod);
  if (ma == null || prevMa == null) return [];
  const last = candles[candles.length - 1];
  const prev = candles[candles.length - 2];
  const events = [];
  if (prev.close < prevMa && last.close > ma) events.push({ type: "ma_cross_up", ma });
  if (prev.close > prevMa && last.close < ma) events.push({ type: "ma_cross_down", ma });
  if (last.low <= ma && last.high >= ma && last.close !== ma) events.push({ type: "ma_touch", ma });
  return events;
}

// Top-level builder: takes a snapshot and produces the full context object.
function buildContext(snapshot, opts = {}) {
  const tickSize = opts.tickSize || 0.25;
  const maPeriod = opts.maPeriod || 20;

  const candles = snapshot.candles || [];
  if (candles.length < 2) return null;

  // The closed bar is the second-to-last; the last is the live/forming bar.
  const closed = candles[candles.length - 2];
  const prevClosed = candles[candles.length - 3] || null;
  const closedSeries = candles.slice(0, -1); // up through and including closed

  const classification = classifyLatest(closedSeries, opts.patterns);
  const tvcmStudies = (snapshot.tvcm && Array.isArray(snapshot.tvcm.studies)) ? snapshot.tvcm.studies : null;

  // ── ORB strategy integration ──────────────────────────────────────────────
  // If an ORB TVCM study is on the chart, compute ORB state and build entries
  // for the shared zone pool with source: 'orb'.
  const orbStudy = tvcmStudies && tvcmStudies.find(
    s => s && s.role === 'strategy' && s.strategyName === 'ORB'
  );
  let orbState = null;
  const orbZoneEntries = [];
  if (orbStudy && orbStudy.inputs) {
    const orbConfig = parseOrbConfig(orbStudy.inputs, tickSize);
    orbState = computeOrbState(snapshot, orbConfig);
    for (const lvl of orbState.levels || []) {
      orbZoneEntries.push({
        id:    `orb:level:${lvl.kind}`,
        label: lvl.label,
        color: null,
        kind:  lvl.kind,
        price: lvl.price,
        lo:    lvl.price - tickSize / 2,
        hi:    lvl.price + tickSize / 2,
        source: 'orb',
        orb:  { range: orbState.range, phase: orbState.phase },
      });
    }
    for (const zn of orbState.zones || []) {
      orbZoneEntries.push({
        id:    'orb:zone:opening_range',
        label: zn.label,
        color: null,
        kind:  zn.kind,
        lo:    zn.low,
        hi:    zn.high,
        price: (zn.low + zn.high) / 2,
        source: 'orb',
        orb:  { range: orbState.range, phase: orbState.phase },
      });
    }
  }

  // ── Tracked-drawing entries (Phase 4b.2) ─────────────────────────────────
  // Convert journal rows into zone entries here so the kind can be inferred
  // from the closed bar's relationship to the tracked price. Pull `kind` from
  // the TV drawing label when it includes a recognized hint ("support" /
  // "resistance" / "level"), otherwise default by position.
  const trackedLevels = Array.isArray(opts.trackedLevels) ? opts.trackedLevels : [];
  const trackedLevelEntries = trackedLevels
    .filter((tl) => tl && typeof tl.price === 'number')
    .map((tl) => {
      const labelText = (tl.label || '').toLowerCase();
      let kind;
      if (labelText.includes('support')) kind = 'support';
      else if (labelText.includes('resistance')) kind = 'resistance';
      else if (labelText.includes('level'))      kind = 'level';
      else kind = (closed.close < tl.price) ? 'resistance' : 'support';
      return {
        id:    `tracked:${tl.id}`,
        label: tl.label || `Tracked ${tl.price}`,
        color: tl.color || null,
        kind,
        price: tl.price,
        lo:    tl.price - tickSize / 2,
        hi:    tl.price + tickSize / 2,
        source: 'tracked-drawing',
        tracked: {
          drawingId:   tl.drawing_id,
          drawingType: tl.drawing_type,
          firstSeenTs: tl.first_seen_ts,
          lastSeenTs:  tl.last_seen_ts,
        },
      };
    });

  // Merge all sources through normalizeZones so dedup sees the full set.
  const zones = normalizeZones(snapshot.drawings, tickSize, tvcmStudies, {
    trackedLevelEntries,
    orbZoneEntries,
  });

  const trendInfo = detectTrend(closedSeries, maPeriod);
  const ma = sma(closedSeries, maPeriod);
  const nearest = nearestZone(closed.close, zones);

  // ── Emerging-level detector (Phase 4b.2) ─────────────────────────────────
  // Candidate levels are NOT zones — they are suggestions for the trader to
  // consider drawing. The filter scans this list for suggest_level events.
  const swingOpts = Object.assign({ tickSize }, opts.swingPivots || {});
  const candidateLevels = detectSwingPivots(closedSeries, swingOpts);

  const zoneStates = zones.map((z) => ({
    zone: z,
    interaction: zoneInteraction(prevClosed, closed, z),
    distanceTicks: ((closed.close < z.lo ? z.lo - closed.close : closed.close > z.hi ? closed.close - z.hi : 0) / tickSize),
  }));

  const maEv = maEvents(closedSeries, maPeriod);

  const recent = closedSeries.slice(-10).map((c) => ({
    time: c.time, open: c.open, high: c.high, low: c.low, close: c.close,
  }));

  return {
    symbol: snapshot.symbol,
    timeframe: snapshot.timeframe,
    fetchedAt: snapshot.fetchedAt,
    closedBar: closed,
    livingBar: candles[candles.length - 1],
    classification,            // patterns + tags
    notable: isNotable(classification),
    trend: trendInfo,
    ma,
    nearestZone: nearest,
    zones: zoneStates,
    maEvents: maEv,
    recent,
    replayMode: !!snapshot.replayMode,
    orbState,                  // null if no ORB indicator on chart
    orbSignal: orbState && orbState.signal ? orbState.signal : null,
    candidateLevels,           // Phase 4b.2: swing-pivot detector output
  };
}

module.exports = {
  normalizeZones,
  dedupZones,
  ZONE_SOURCE_PRIORITY,
  sma,
  detectTrend,
  zoneInteraction,
  nearestZone,
  maEvents,
  buildContext,
  parseOrbConfig,
};
