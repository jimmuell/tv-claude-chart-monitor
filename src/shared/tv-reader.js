// tv-reader.js
// Connects to TradingView Desktop via the Chrome DevTools Protocol and pulls
// the data the rest of the pipeline needs: OHLC bars, drawings, indicator
// list, active symbol, timeframe, and replay-mode state.
//
// VERIFIED API SURFACE (Phase 2a probe — see ROADMAP.md)
// ------------------------------------------------------
// TV Desktop wraps the public tradingview.com chart page in Electron. The
// licensed Charting Library global `window.tvWidget` is NOT exposed — that's
// for paying integrators. What IS exposed is `window.TradingViewApi`, which
// gives us the chart object and a rich method surface.
//
//   const chart = window.TradingViewApi.activeChart();
//   chart.symbol()           => "CME_MINI:MES1!"
//   chart.resolution()       => "5"   (timeframe in minutes; "1D"/"1W" for daily/weekly)
//   chart.dataReady()        => true when bars are loaded
//   chart.getAllShapes()     => [{ id, name }, ...]
//   chart.getShapeById(id)   => shape object
//      shape.getPoints()     => [{ price, time }, ...]
//      shape.getProperties() => { linecolor, text, ... }
//   chart.getAllStudies()    => [{ id, name }, ...]
//   chart.getStudyById(id)   => study object
//      Indicator plot values are not directly exposed; we compute MA etc.
//      ourselves in context.js from the bar history. Indicator INPUTS
//      (user-set values from the settings dialog) are accessible via:
//        study.properties()           // FUNCTION — call it to get prop tree
//          .inputs.state()            // {in_0: ..., in_1: ..., ...}
//      Keys are POSITIONAL ("in_N") in Pine declaration order, NOT input
//      titles. The TVCM block in readSnapshot() applies a hardcoded
//      positional layout to map them back to protocol field names.
//   chart.getSeries()        => series object
//      series.isInReplay()   => boolean (replay-mode check)
//      series.data().m_bars  => custom bar collection:
//        m_bars.size()       => total bar count
//        m_bars.valueAt(i)   => [time_secs, open, high, low, close, volume]
//
// Launch TV Desktop with --remote-debugging-port=9222 (use `npm run tv:launch`)
// before starting this app. Set `tv.useMockReader: false` in config to attach
// to the real chart.

const CDP = require("chrome-remote-interface");

class TvReader {
  constructor(config, logger) {
    this.config = config;
    this.logger = logger || console;
    this.client = null;
    this.target = null;
    this._lastSeenBarTime = null;
  }

  async connect() {
    const { cdpHost, cdpPort } = this.config.tv;
    const targets = await CDP.List({ host: cdpHost, port: cdpPort });
    // Find the page that hosts the TradingView chart. TV Desktop usually has
    // a single page-type target whose URL is on tradingview.com or its desktop
    // bundle.
    const pageTarget = targets.find(
      (t) => t.type === "page" &&
             (t.url.includes("tradingview") || t.title.toLowerCase().includes("tradingview"))
    );
    if (!pageTarget) {
      throw new Error(
        "Could not find a TradingView page target via CDP. Is TV Desktop running with --remote-debugging-port=9222?"
      );
    }
    this.target = pageTarget;
    this.client = await CDP({ host: cdpHost, port: cdpPort, target: pageTarget });
    await this.client.Runtime.enable();
    await this.client.Page.enable();
    this.logger.info(`[tv-reader] connected to ${pageTarget.title}`);
    return true;
  }

  async disconnect() {
    if (this.client) {
      try { await this.client.close(); } catch (_) {}
      this.client = null;
    }
  }

  async evalPage(expression) {
    const { result, exceptionDetails } = await this.client.Runtime.evaluate({
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (exceptionDetails) {
      throw new Error(`CDP eval failed: ${exceptionDetails.text}`);
    }
    return result.value;
  }

  // Write inputs to a TV study via the Charting Library's setInputValues API.
  //
  // partialUpdate is a flat object keyed by positional input id ("in_3", "in_4",
  // ...). Values are written as-is — strings for string inputs, numbers for
  // float inputs. Inputs not included in the partial are left untouched.
  //
  // The CDP-side script tries two API shapes for forward-compat:
  //   1. study.setInputValues([{id, value}, ...]) — modern Charting Library
  //   2. study.setInputValues({in_3: ..., in_4: ...}) — older flat-object form
  // If both throw, returns { ok: false, error }.
  //
  // Phase 4b.3.a.2: the annotator uses this to flush all 10 slots × 4 fields = 40
  // inputs in a single call so the Pine indicator recomputes once per event.
  async setStudyInputs(studyId, partialUpdate) {
    if (!this.client) throw new Error("Not connected. Call connect() first.");
    if (!studyId) throw new Error("setStudyInputs: studyId is required");
    if (!partialUpdate || typeof partialUpdate !== "object") {
      throw new Error("setStudyInputs: partialUpdate must be an object");
    }
    const sid = JSON.stringify(String(studyId));
    const flat = JSON.stringify(partialUpdate);
    const arr = JSON.stringify(
      Object.keys(partialUpdate).map((k) => ({ id: k, value: partialUpdate[k] }))
    );
    const expr = `
      (async () => {
        try {
          const chart = window.TradingViewApi.activeChart();
          if (!chart) return { ok: false, error: "activeChart() returned null" };
          const study = chart.getStudyById(${sid});
          if (!study) return { ok: false, error: "study not found: " + ${sid} };
          // Prefer the documented array-of-{id,value} form (modern Charting
          // Library). Fall back to the flat object form, then to mutating the
          // property tree directly via inputs.in_N.setValue(...).
          let lastError = null;
          try {
            const raw = study.setInputValues(${arr});
            if (raw && typeof raw.then === "function") await raw;
            return { ok: true, shape: "array" };
          } catch (e1) {
            lastError = String(e1 && e1.message || e1);
          }
          try {
            const raw = study.setInputValues(${flat});
            if (raw && typeof raw.then === "function") await raw;
            return { ok: true, shape: "object" };
          } catch (e2) {
            lastError = String(e2 && e2.message || e2);
          }
          // Last resort: walk the property tree and call setValue on each input.
          try {
            const propsObj = study.properties && study.properties();
            const inputsObj = propsObj && propsObj.inputs;
            if (!inputsObj) return { ok: false, error: "no inputs object on study; lastError=" + lastError };
            const update = ${flat};
            for (const k of Object.keys(update)) {
              const node = inputsObj[k];
              if (node && typeof node.setValue === "function") {
                node.setValue(update[k]);
              } else if (node && typeof node.set === "function") {
                node.set(update[k]);
              }
            }
            return { ok: true, shape: "property-tree" };
          } catch (e3) {
            return { ok: false, error: "all setInputValues shapes failed; last=" + String(e3 && e3.message || e3) + "; prior=" + lastError };
          }
        } catch (e) {
          return { ok: false, error: String(e && e.message || e) };
        }
      })()
    `;
    const result = await this.evalPage(expr);
    return result || { ok: false, error: "no result from evalPage" };
  }

  // Read the entire chart snapshot we need.
  // Returns { symbol, timeframe, candles[], drawings[], indicators[], replayMode, dataReady, fetchedAt }.
  async readSnapshot({ barCount = 200 } = {}) {
    if (!this.client) throw new Error("Not connected. Call connect() first.");

    // The expression below targets the verified TradingViewApi surface
    // documented at the top of this file. Each block is wrapped in try/catch
    // so a single failure (e.g. drawings unreadable) doesn't kill the whole
    // snapshot.
    const expr = `
      (() => {
        const safe = (fn, fb) => { try { return fn(); } catch { return fb; } };
        const api = window.TradingViewApi;
        if (!api || typeof api.activeChart !== "function") {
          return { error: "TradingViewApi.activeChart not found — TV Desktop may not be fully loaded" };
        }
        const chart = api.activeChart();
        if (!chart) return { error: "activeChart() returned null" };

        const symbol = safe(() => chart.symbol(), null);
        const timeframe = safe(() => chart.resolution(), null);
        const dataReady = safe(() => !!chart.dataReady(), false);

        // ---- bars: chart.getSeries().data().m_bars ----
        let candles = [];
        let inReplay = false;
        try {
          const series = (typeof chart.getSeries === "function") ? chart.getSeries() : null;
          if (series) {
            try { inReplay = (typeof series.isInReplay === "function") && !!series.isInReplay(); } catch {}
            const data = (typeof series.data === "function") ? series.data() : null;
            const m = data && data.m_bars;
            if (m && typeof m.size === "function" && typeof m.valueAt === "function") {
              const n = m.size();
              const want = ${barCount};
              const start = Math.max(0, n - want);
              for (let i = start; i < n; i++) {
                const v = m.valueAt(i);
                if (Array.isArray(v) && v.length >= 5) {
                  candles.push({
                    time: v[0],
                    open: v[1],
                    high: v[2],
                    low: v[3],
                    close: v[4],
                    volume: v.length > 5 ? v[5] : null,
                  });
                }
              }
            }
          }
        } catch (e) { /* candles stays [] */ }

        // ---- drawings: chart.getAllShapes() + chart.getShapeById(id) ----
        let drawings = [];
        try {
          const all = (typeof chart.getAllShapes === "function") ? (chart.getAllShapes() || []) : [];
          for (const s of all) {
            const obj = safe(() => chart.getShapeById(s.id), null);
            const points = (obj && typeof obj.getPoints === "function") ? safe(() => obj.getPoints(), []) : [];
            const props = (obj && typeof obj.getProperties === "function") ? safe(() => obj.getProperties(), {}) : {};
            drawings.push({
              id: s.id,
              type: s.name || "unknown",
              points: Array.isArray(points) ? points.map(p => ({ price: p && p.price, time: p && p.time })) : [],
              text: (props && (props.text || props.title || props.string)) || null,
              color: (props && (props.linecolor || props.backgroundColor || props.color)) || null,
              filled: (props && (props.fillBackground != null ? !!props.fillBackground : null)),
            });
          }
        } catch (e) { /* drawings stays [] */ }

        // ---- studies: list + TVCM Protocol v1 input extraction.
        //
        // VERIFIED API SHAPE (probe-properties.js, 2026-05-10):
        //   - study.properties is a FUNCTION; call it to get the property obj.
        //   - That object has .state() returning the full property tree.
        //   - state().inputs is a flat object of input values KEYED BY
        //     POSITIONAL ID ("in_0", "in_1", ...), NOT by title. The order
        //     matches the Pine declaration order.
        //   - state().inputs also contains TV-internal keys "__fast_calc"
        //     and "__profile" which we ignore.
        //
        // Because keys are positional, the reader has to know each TVCM
        // indicator's input layout. We hardcode the BASE v1 layout below.
        // Phase 4 strategy indicators will declare their own layouts in the
        // LAYOUTS table.
        //
        // CRITICAL: any change to input declaration order in
        // tv-pine/base-levels.pine MUST be matched by an update to
        // BASE_V1_LAYOUT below or the reader will pull wrong values.
        let indicators = [];
        let tvcm = { studies: [] };
        try {
          const studies = (typeof chart.getAllStudies === "function") ? (chart.getAllStudies() || []) : [];
          indicators = studies.map(s => ({ id: s.id, name: s.name, lastValue: null }));

          // ---- TVCM input layouts (positional). Each entry is the protocol
          // field name at that index. Layouts are dispatched by (role,
          // strategyName) read from the first three inputs.
          //
          // BASE v1: 6 level slots × {kind, price, label} + 3 zone slots ×
          // {kind, low, high, label} = 33 inputs total starting at in_0.
          const BASE_V1_LAYOUT = [
            "tvcm_version",         // in_0
            "tvcm_role",            // in_1
            "tvcm_strategy_name",   // in_2
            "tvcm_level_1_kind",    // in_3
            "tvcm_level_1_price",   // in_4
            "tvcm_level_1_label",   // in_5
            "tvcm_level_2_kind",    // in_6
            "tvcm_level_2_price",   // in_7
            "tvcm_level_2_label",   // in_8
            "tvcm_level_3_kind",    // in_9
            "tvcm_level_3_price",   // in_10
            "tvcm_level_3_label",   // in_11
            "tvcm_level_4_kind",    // in_12
            "tvcm_level_4_price",   // in_13
            "tvcm_level_4_label",   // in_14
            "tvcm_level_5_kind",    // in_15
            "tvcm_level_5_price",   // in_16
            "tvcm_level_5_label",   // in_17
            "tvcm_level_6_kind",    // in_18
            "tvcm_level_6_price",   // in_19
            "tvcm_level_6_label",   // in_20
            "tvcm_zone_1_kind",     // in_21
            "tvcm_zone_1_low",      // in_22
            "tvcm_zone_1_high",     // in_23
            "tvcm_zone_1_label",    // in_24
            "tvcm_zone_2_kind",     // in_25
            "tvcm_zone_2_low",      // in_26
            "tvcm_zone_2_high",     // in_27
            "tvcm_zone_2_label",    // in_28
            "tvcm_zone_3_kind",     // in_29
            "tvcm_zone_3_low",      // in_30
            "tvcm_zone_3_high",     // in_31
            "tvcm_zone_3_label",    // in_32
          ];

          // Read raw inputs for a study via the verified accessor path.
          // Returns a plain {in_0: ..., in_1: ...} object (TV-internal keys
          // __fast_calc / __profile are stripped) or null if unavailable.
          const readRawInputs = (study) => {
            try {
              const propsFn = study && study.properties;
              if (typeof propsFn !== "function") return null;
              const propsObj = propsFn.call(study);
              if (!propsObj) return null;
              // Two equivalent paths to the inputs subtree; prefer the direct
              // accessor, fall back to the flat state() snapshot.
              let inputsObj = null;
              if (propsObj.inputs && typeof propsObj.inputs.state === "function") {
                inputsObj = propsObj.inputs.state();
              } else if (typeof propsObj.state === "function") {
                const full = propsObj.state();
                inputsObj = full && full.inputs;
              }
              if (!inputsObj || typeof inputsObj !== "object") return null;
              // Strip TV-internal keys.
              const out = {};
              for (const k of Object.keys(inputsObj)) {
                if (k === "__fast_calc" || k === "__profile") continue;
                out[k] = inputsObj[k];
              }
              return out;
            } catch (e) { return null; }
          };

          // Map a flat raw inputs object through a positional layout into a
          // {fieldName: value} dictionary. Missing positions stay undefined.
          const applyLayout = (raw, layout) => {
            const out = {};
            for (let i = 0; i < layout.length; i++) {
              const k = "in_" + i;
              if (raw[k] !== undefined) out[layout[i]] = raw[k];
            }
            return out;
          };

          // ORB strategy v1: 3 protocol metadata inputs + 6 ORB config inputs.
          const ORB_V1_LAYOUT = [
            "tvcm_version",              // in_0
            "tvcm_role",                 // in_1
            "tvcm_strategy_name",        // in_2
            "orb_session_start",         // in_3
            "orb_session_end",           // in_4
            "orb_range_minutes",         // in_5
            "orb_direction_filter",      // in_6
            "orb_breakout_buffer_ticks", // in_7
            "orb_timezone",              // in_8
          ];

          // Annotator v1 (Phase 4b.3.a.2): 3 protocol metadata + 10 slots ×
          // {kind, price, label, meta} = 43 inputs. The annotator is an
          // *app-output renderer* — the app writes inputs via
          // study.setInputValues to render annotation chips on the chart.
          // The reader still discovers the study (so the app can find its
          // study id), but does not parse slots into level/zone fields —
          // the slot data flows app → study, not study → app.
          const ANNOTATOR_V1_LAYOUT = [
            "tvcm_version",              // in_0
            "tvcm_role",                 // in_1
            "tvcm_strategy_name",        // in_2
            "tvcm_slot_1_kind",          // in_3
            "tvcm_slot_1_price",         // in_4
            "tvcm_slot_1_label",         // in_5
            "tvcm_slot_1_meta",          // in_6
            "tvcm_slot_2_kind",          // in_7
            "tvcm_slot_2_price",         // in_8
            "tvcm_slot_2_label",         // in_9
            "tvcm_slot_2_meta",          // in_10
            "tvcm_slot_3_kind",          // in_11
            "tvcm_slot_3_price",         // in_12
            "tvcm_slot_3_label",         // in_13
            "tvcm_slot_3_meta",          // in_14
            "tvcm_slot_4_kind",          // in_15
            "tvcm_slot_4_price",         // in_16
            "tvcm_slot_4_label",         // in_17
            "tvcm_slot_4_meta",          // in_18
            "tvcm_slot_5_kind",          // in_19
            "tvcm_slot_5_price",         // in_20
            "tvcm_slot_5_label",         // in_21
            "tvcm_slot_5_meta",          // in_22
            "tvcm_slot_6_kind",          // in_23
            "tvcm_slot_6_price",         // in_24
            "tvcm_slot_6_label",         // in_25
            "tvcm_slot_6_meta",          // in_26
            "tvcm_slot_7_kind",          // in_27
            "tvcm_slot_7_price",         // in_28
            "tvcm_slot_7_label",         // in_29
            "tvcm_slot_7_meta",          // in_30
            "tvcm_slot_8_kind",          // in_31
            "tvcm_slot_8_price",         // in_32
            "tvcm_slot_8_label",         // in_33
            "tvcm_slot_8_meta",          // in_34
            "tvcm_slot_9_kind",          // in_35
            "tvcm_slot_9_price",         // in_36
            "tvcm_slot_9_label",         // in_37
            "tvcm_slot_9_meta",          // in_38
            "tvcm_slot_10_kind",         // in_39
            "tvcm_slot_10_price",        // in_40
            "tvcm_slot_10_label",        // in_41
            "tvcm_slot_10_meta",         // in_42
          ];

          // Pick the right layout for this study based on its protocol
          // metadata. Returns null for non-TVCM studies.
          const layoutFor = (raw) => {
            const version = Number(raw.in_0);
            if (version !== 1) return null;
            const role = String(raw.in_1 || "");
            const strategyName = String(raw.in_2 || "");
            if (role === "base") return { layout: BASE_V1_LAYOUT, role, strategyName };
            if (role === "strategy" && strategyName === "ORB") return { layout: ORB_V1_LAYOUT, role, strategyName };
            if (role === "annotator") return { layout: ANNOTATOR_V1_LAYOUT, role, strategyName };
            return null;
          };

          for (const s of studies) {
            const study = safe(() => chart.getStudyById(s.id), null);
            if (!study) continue;
            const raw = readRawInputs(study);
            if (!raw) continue;

            const layoutPick = layoutFor(raw);
            if (!layoutPick) continue;

            const fields = applyLayout(raw, layoutPick.layout);

            // Parse levels — scan up to 6 slots (matches BASE_V1_LAYOUT).
            const levels = [];
            for (let n = 1; n <= 6; n++) {
              const kind = String(fields["tvcm_level_" + n + "_kind"] || "");
              const price = Number(fields["tvcm_level_" + n + "_price"]);
              const labelV = fields["tvcm_level_" + n + "_label"];
              if (kind && kind !== "none" && Number.isFinite(price) && price !== 0) {
                levels.push({
                  n, kind, price,
                  label: labelV != null && String(labelV).length ? String(labelV) : null,
                  color: null,
                });
              }
            }

            // Parse zones — scan up to 3 slots.
            const zones = [];
            for (let n = 1; n <= 3; n++) {
              const kind = String(fields["tvcm_zone_" + n + "_kind"] || "");
              const lo = Number(fields["tvcm_zone_" + n + "_low"]);
              const hi = Number(fields["tvcm_zone_" + n + "_high"]);
              const labelV = fields["tvcm_zone_" + n + "_label"];
              if (kind && kind !== "none" && Number.isFinite(lo) && Number.isFinite(hi) && lo !== 0 && hi !== 0 && hi > lo) {
                zones.push({
                  n, kind, low: lo, high: hi,
                  label: labelV != null && String(labelV).length ? String(labelV) : null,
                  color: null,
                });
              }
            }

            // Strategy signal — only meaningful for role=strategy. Base
            // indicators don't expose signals; this stays null.
            const signal = null;

            tvcm.studies.push({
              id: s.id,
              name: s.name,
              role: layoutPick.role,
              strategyName: layoutPick.strategyName,
              levels,
              zones,
              signal,
              // Strategy studies expose their config inputs so context.js can
              // parse them (e.g. orb_session_start, orb_range_minutes).
              inputs: layoutPick.role === "strategy" ? fields : undefined,
            });
          }
        } catch (e) { /* indicators / tvcm stays as initialized */ }

        return { symbol, timeframe, dataReady, candles, drawings, indicators, tvcm, replayMode: inReplay };
      })()
    `;

    const raw = await this.evalPage(expr);
    if (!raw || raw.error) {
      throw new Error(`Could not read TV chart state: ${raw && raw.error}`);
    }
    return { ...raw, fetchedAt: Date.now() };
  }

  // Detect whether a new candle has closed since the last read.
  hasNewClose(snapshot) {
    if (!snapshot.candles || snapshot.candles.length < 2) return false;
    // The most recent bar is typically the in-progress one. We treat the
    // SECOND-to-last bar as the most recently CLOSED bar.
    const closedBar = snapshot.candles[snapshot.candles.length - 2];
    if (!closedBar) return false;
    if (this._lastSeenBarTime === null) {
      this._lastSeenBarTime = closedBar.time;
      return false; // first observation; no event
    }
    if (closedBar.time !== this._lastSeenBarTime) {
      this._lastSeenBarTime = closedBar.time;
      return true;
    }
    return false;
  }

  resetCloseTracker() { this._lastSeenBarTime = null; }
}

// ----- Mock reader: deterministic synthetic data for offline development -----
class MockTvReader {
  constructor(config, logger) {
    this.config = config;
    this.logger = logger || console;
    this._t = 0;
    this._lastSeenBarTime = null;
    this._closes = this._buildScript();
  }
  async connect() { this.logger.info("[mock-tv-reader] using synthetic data"); return true; }
  async disconnect() {}
  async evalPage() { return null; }
  async setStudyInputs(_studyId, _partialUpdate) { return { ok: true, shape: "mock" }; }

  _buildScript() {
    // A short repeating script that produces interesting events for testing.
    // Pulls down, rejects at a "zone", recovers, breaks down — designed to
    // exercise the engulfing / pin-bar / zone-rejection paths.
    const base = 7355;
    const zone = { lo: 7358, hi: 7360 };
    const candles = [];
    for (let i = 0; i < 300; i++) {
      const t = (Date.now() / 1000 | 0) - (300 - i) * 120;
      const phase = i % 30;
      let o, h, l, c;
      if (phase < 8) {           // gentle pullback up
        o = base + i * 0.05;
        c = o + 0.5;
        h = c + 0.3; l = o - 0.3;
      } else if (phase === 8) {  // tag zone
        o = zone.lo - 0.25;
        c = zone.lo + 0.5;
        h = zone.hi - 0.25; l = o - 0.5;
      } else if (phase === 9) {  // rejection candle
        o = zone.hi - 0.25;
        c = zone.lo - 0.75;
        h = zone.hi + 0.5; l = c - 0.5;
      } else if (phase < 18) {   // sell-off
        o = zone.lo - phase * 0.3;
        c = o - 0.7;
        h = o + 0.2; l = c - 0.4;
      } else {                   // chop
        o = base - 1 + Math.sin(i) * 0.5;
        c = o + (Math.cos(i) * 0.3);
        h = Math.max(o, c) + 0.4; l = Math.min(o, c) - 0.4;
      }
      candles.push({ time: t, open: +o.toFixed(2), high: +h.toFixed(2), low: +l.toFixed(2), close: +c.toFixed(2), volume: 100 + (i % 7) * 30 });
    }
    return candles;
  }

  async readSnapshot({ barCount = 200 } = {}) {
    this._t += 1;
    const upTo = Math.min(this._closes.length, 50 + this._t);
    const candles = this._closes.slice(Math.max(0, upTo - barCount), upTo);
    return {
      symbol: "MES1!",
      timeframe: "2",
      candles,
      drawings: [
        { id: "z1", type: "rectangle", points: [{ time: candles[0].time, price: 7358 }, { time: candles[candles.length - 1].time, price: 7360 }], text: "rejection zone", color: "rgba(255,80,80,0.3)" },
        { id: "h1", type: "horizontal_line", points: [{ price: 7350 }], text: "support", color: "#3fa55a" },
        { id: "h2", type: "horizontal_line", points: [{ price: 7367.5 }], text: "resistance", color: "#3fa55a" },
      ],
      indicators: [{ id: "ma20", name: "MA 20", lastValue: 7356.4 }],
      // TVCM Protocol v1 stub: lets us exercise the merge path in
      // context.js without needing TV Desktop running. The values mirror the
      // mock drawings above (intentionally — so commentary references the
      // labeled zone "Rejection 7358-60" via the TVCM path even if drawing
      // extraction goes away).
      tvcm: {
        studies: [
          {
            id: "mock-tvcm-1",
            name: "TVCM Base Levels (mock)",
            role: "base",
            strategyName: "",
            levels: [
              { n: 1, kind: "support", price: 7350, label: "Major support", color: null },
              { n: 2, kind: "resistance", price: 7367.5, label: "Day resistance", color: null },
            ],
            zones: [
              { n: 1, kind: "rejection", low: 7358, high: 7360, label: "Rejection 7358-60", color: null },
            ],
            signal: null,
          },
        ],
      },
      replayMode: false,
      fetchedAt: Date.now(),
    };
  }

  hasNewClose(snapshot) {
    if (!snapshot.candles || snapshot.candles.length < 2) return false;
    const closedBar = snapshot.candles[snapshot.candles.length - 2];
    if (this._lastSeenBarTime === null) { this._lastSeenBarTime = closedBar.time; return false; }
    if (closedBar.time !== this._lastSeenBarTime) { this._lastSeenBarTime = closedBar.time; return true; }
    return false;
  }
  resetCloseTracker() { this._lastSeenBarTime = null; }
}

function createReader(config, logger) {
  return config.tv.useMockReader ? new MockTvReader(config, logger) : new TvReader(config, logger);
}

module.exports = { TvReader, MockTvReader, createReader };
