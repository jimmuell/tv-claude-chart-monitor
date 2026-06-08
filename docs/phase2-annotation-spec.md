# Phase 2 — Chart Annotation: Spec

## Overview

`tv-pine/trading-analyzer-levels.pine` is a Pine Script v6 overlay indicator that renders support and resistance levels on the TradingView chart. The Electron app writes level data to the indicator's inputs via CDP after each analysis run. The indicator recalculates and redraws automatically when inputs change.

Users add the indicator to their chart once. After that, the Electron app owns all input values — the user never touches the settings panel.

---

## Slot Layout

The indicator has **8 slots**. Each slot holds one price level and controls how it is drawn.

| Slot | Fields |
|------|--------|
| 1 | price, kind, label, visible, priority |
| 2 | price, kind, label, visible, priority |
| … | … |
| 8 | price, kind, label, visible, priority |

**Field semantics:**

| Field | Type | Description |
|-------|------|-------------|
| `price` | float | Price level to draw. `0.0` means unused. |
| `kind` | string | `"support"`, `"resistance"`, or `"neutral"`. Controls line/label color. |
| `label` | string | Descriptive text shown next to the price in the chart label. Max 20 chars. May be empty. |
| `visible` | int | `1` = draw this slot, `0` = hide/skip. |
| `priority` | string | `"primary"` = solid line, full opacity. `"secondary"` = dashed line, 30% transparent. |

---

## Positional Input Map

TradingView's internal study-input API keys inputs by **positional ID** (`in_0`, `in_1`, …), in the exact order they are declared in the Pine Script source.

The 40 inputs map as follows (stride of 5 per slot):

| Positional ID | Variable | Slot | Field |
|---------------|----------|------|-------|
| `in_0`  | `s1_price`    | 1 | price    |
| `in_1`  | `s1_kind`     | 1 | kind     |
| `in_2`  | `s1_label`    | 1 | label    |
| `in_3`  | `s1_visible`  | 1 | visible  |
| `in_4`  | `s1_priority` | 1 | priority |
| `in_5`  | `s2_price`    | 2 | price    |
| `in_6`  | `s2_kind`     | 2 | kind     |
| `in_7`  | `s2_label`    | 2 | label    |
| `in_8`  | `s2_visible`  | 2 | visible  |
| `in_9`  | `s2_priority` | 2 | priority |
| `in_10` | `s3_price`    | 3 | price    |
| `in_11` | `s3_kind`     | 3 | kind     |
| `in_12` | `s3_label`    | 3 | label    |
| `in_13` | `s3_visible`  | 3 | visible  |
| `in_14` | `s3_priority` | 3 | priority |
| `in_15` | `s4_price`    | 4 | price    |
| `in_16` | `s4_kind`     | 4 | kind     |
| `in_17` | `s4_label`    | 4 | label    |
| `in_18` | `s4_visible`  | 4 | visible  |
| `in_19` | `s4_priority` | 4 | priority |
| `in_20` | `s5_price`    | 5 | price    |
| `in_21` | `s5_kind`     | 5 | kind     |
| `in_22` | `s5_label`    | 5 | label    |
| `in_23` | `s5_visible`  | 5 | visible  |
| `in_24` | `s5_priority` | 5 | priority |
| `in_25` | `s6_price`    | 6 | price    |
| `in_26` | `s6_kind`     | 6 | kind     |
| `in_27` | `s6_label`    | 6 | label    |
| `in_28` | `s6_visible`  | 6 | visible  |
| `in_29` | `s6_priority` | 6 | priority |
| `in_30` | `s7_price`    | 7 | price    |
| `in_31` | `s7_kind`     | 7 | kind     |
| `in_32` | `s7_label`    | 7 | label    |
| `in_33` | `s7_visible`  | 7 | visible  |
| `in_34` | `s7_priority` | 7 | priority |
| `in_35` | `s8_price`    | 8 | price    |
| `in_36` | `s8_kind`     | 8 | kind     |
| `in_37` | `s8_label`    | 8 | label    |
| `in_38` | `s8_visible`  | 8 | visible  |
| `in_39` | `s8_priority` | 8 | priority |

---

## How the Electron App Writes Inputs via CDP

### Finding the indicator

After `readSnapshot()`, the app already has the study list from `chart.getStudyById()`. The CDP writer needs to:

1. **Find the indicator ID.** Call `chart.getAllStudies()` and find the entry whose `name` or `description` matches `"TA Levels"`.
2. **Get the study object.** Call `chart.getStudyById(id)`.
3. **Call `setStudyInputs(id, patch)`.** The `patch` is a partial object of `{ in_N: value }` keys.

### The `setStudyInputs` CDP call

```js
// expression evaluated in the TV page context
chart.getStudyById(studyId).setStudyInputs({ in_0: 5234.50, in_1: "support", ... })
```

Or, using the existing `setStudyInputs` wrapper in the annotator:

```js
await reader.setStudyInputs(studyId, {
  in_0:  7521.50,      // s1_price
  in_1:  "support",    // s1_kind
  in_2:  "PDL",        // s1_label
  in_3:  1,            // s1_visible
  in_4:  "primary",    // s1_priority
  in_5:  7540.00,      // s2_price
  in_6:  "resistance", // s2_kind
  in_7:  "PDH",        // s2_label
  in_8:  1,            // s2_visible
  in_9:  "secondary",  // s2_priority
  // ... slots 3–8 follow the same pattern (stride of 5)
  // Slots not used this run: set visible=0, price=0.0, kind="", label="", priority="primary"
})
```

### Priority field semantics

| Value | Line style | Line width | Opacity |
|-------|-----------|------------|---------|
| `"primary"` | Solid | 2px | Fully opaque |
| `"secondary"` | Dashed | 1px | 30% transparent |

Primary levels are the 2-3 most actionable levels where you'd actually trade. Secondary levels are internal references, distant targets, or low-conviction markers.

### Slot assignment strategy

The CDP writer maps `key_levels_to_watch[]` from `AnalysisResult.commentary` to slots 1–8:

- Take up to 8 levels from the array (truncate if more).
- Map `KeyLevel.color` → `kind`:
  - `"green"` → `"support"`
  - `"red"` → `"resistance"`
  - `"gray"` / `"yellow"` / others → `"neutral"`
  - `"blue"` — use price position relative to current price as tiebreaker
- Pass `KeyLevel.priority` → `priority` directly (`"primary"` or `"secondary"`; default `"primary"`).
- Slots beyond the level count get `visible=0` to clear stale drawings.

### Triggering recalculation

After `setStudyInputs` returns, TradingView automatically recalculates and redraws the indicator. No additional call is needed.

---

## Color Reference

| Kind | Color | Hex |
|------|-------|-----|
| `"support"` | Red | `#ef5350` |
| `"resistance"` | Blue | `#42a5f5` |
| `"neutral"` / unknown | Gray | `#cfd8dc` |

These match the color scheme used in the Electron panel's key-level cards.

---

## ORB Inputs (in_40 … in_42)

Three additional inputs follow the 40-level inputs:

| Positional ID | Variable | Type | Default | Description |
|---------------|----------|------|---------|-------------|
| `in_40` | `orb_enabled` | bool | `true` | Show/hide all ORB drawings |
| `in_41` | `orb_high_override` | float | `0.0` | Override ORB high (0.0 = use Pine-calculated value) |
| `in_42` | `orb_low_override` | float | `0.0` | Override ORB low (0.0 = use Pine-calculated value) |

## Trade Plan Bracket Inputs (in_43 … in_45)

Three inputs after the ORB inputs control the trade plan bracket overlay:

| Positional ID | Variable | Type | Default | Description |
|---------------|----------|------|---------|-------------|
| `in_43` | `tp_entry` | float | `0.0` | Entry price. 0.0 = no bracket drawn. |
| `in_44` | `tp_stop` | float | `0.0` | Stop loss price. |
| `in_45` | `tp_target` | float | `0.0` | Profit target price. |

**Total inputs: 46** (40 level inputs + 3 ORB inputs + 3 trade plan inputs)

### Trade Plan Bracket Rendering

When all three values are non-zero the indicator draws:

| Drawing | Color | Style | Width | Description |
|---------|-------|-------|-------|-------------|
| Entry line | `#26a69a` (teal) | Solid | 2px | Extends across full chart |
| Stop line | `#ef5350` (red) | Dashed | 2px | Extends across full chart |
| Target line | `#4caf50` (green) | Dashed | 2px | Extends across full chart |
| Entry label | `#26a69a` | — | — | `"<price> · <R:R>R"` at `bar_index + 35` |
| Risk zone box | `#ef5350` 92% transparent | — | — | Between entry and stop |
| Reward zone box | `#4caf50` 92% transparent | — | — | Between entry and target |

R:R is calculated as `abs(target - entry) / abs(entry - stop)`, rounded to 1 decimal.

Setting any value to 0.0 removes all bracket drawings.

When override values are both non-zero, they replace the Pine-calculated ORB range for the current session. Set both to `0.0` to let the indicator calculate the ORB natively.

---

## ORB Rendering Behavior

The indicator calculates the Opening Range Breakout (ORB) natively for the NY regular session.

### Session Hours
- **Open**: 8:30 AM CST / 9:30 AM ET
- **ORB window**: 8:30–8:45 AM CST (first 15 minutes)
- **Close**: 3:00 PM CST / 4:00 PM ET

### Timeframe Gate
ORB is only rendered on charts with timeframe ≤ 15 minutes (`timeframe.in_seconds() ≤ 900`). On 1h, 4h, and daily charts, ORB is suppressed.

| Timeframe | ORB bars |
|-----------|----------|
| 1m | 15 bars |
| 5m | 3 bars |
| 15m | 1 bar |
| 30m+ | Hidden |

### Visual States

| State | When | Appearance |
|-------|------|------------|
| **Forming** | 8:30–8:45 AM CST | Dashed green high / dashed red low, extend.both |
| **Complete** | After 8:45 AM CST | Solid lines from ORB-lock bar, zone fill, labels |
| **After session** | After 3:00 PM CST | All ORB drawings removed |

### Zone Fill Colors

| Price position | Zone color |
|----------------|------------|
| Above ORB High | Green, 90% transparent |
| Below ORB Low | Red, 90% transparent |
| Inside range | Neutral gray, 92% transparent |

### Daily Reset
ORB state and drawings reset on the first bar of each new NY session (8:30 CST). Prior session drawings are deleted.

---

## Constraints

- **8 slots maximum.** If `key_levels_to_watch` has more than 8 entries, the CDP writer takes the first 8.
- **46 total inputs.** The indicator has 40 level inputs (in_0–in_39), 3 ORB inputs (in_40–in_42), and 3 trade plan bracket inputs (in_43–in_45). The Electron app writes the 40 level inputs via `writeLevels`/`writeLevel` and the 3 bracket inputs via `writeTradePlan`/`clearTradePlan`; the ORB inputs are managed by the user or override API.
- **Always write all 40 level inputs.** Writing a partial patch leaves stale values in unused slots from prior runs. Always zero out unused slots explicitly.
- **Label truncation.** Labels are truncated to 20 characters before writing (word-boundary aware). The Pine indicator comment says `≤20 chars`.
- **Price precision.** The indicator uses `format.mintick` for label display, matching TradingView's native price formatting for the active symbol.
