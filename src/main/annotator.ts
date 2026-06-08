import { findStudyId, callSetStudyInputs } from './bridge';
import type { KeyLevel, LevelAnnotation, PatternMarker } from '../shared/types';

const SLOTS         = 8;
const INDICATOR_NAME = 'TA Levels';

let cachedStudyId: string | null = null;

export function invalidateStudyCache(): void {
  cachedStudyId = null;
}

async function resolveStudyId(): Promise<string> {
  if (!cachedStudyId) {
    cachedStudyId = await findStudyId(INDICATOR_NAME);
  }
  if (!cachedStudyId) {
    throw new Error(
      "TA Levels indicator not found on chart. Add it in TradingView's Pine Editor.",
    );
  }
  return cachedStudyId;
}

function buildFullPatch(slots: Array<LevelAnnotation | null>): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  for (let i = 0; i < SLOTS; i++) {
    const base = i * 5;
    const s    = slots[i];
    patch[`in_${base}`]     = s?.price    ?? 0.0;
    patch[`in_${base + 1}`] = s?.kind     ?? '';
    patch[`in_${base + 2}`] = s ? abbreviateLabel(s.label) : '';
    patch[`in_${base + 3}`] = s?.visible  ?? 0;
    patch[`in_${base + 4}`] = s?.priority ?? 'primary';
  }
  return patch;
}

/** Write all 40 inputs at once. Slots beyond levels.length are zeroed. */
export async function writeLevels(levels: LevelAnnotation[]): Promise<void> {
  const slots: Array<LevelAnnotation | null> = Array(SLOTS).fill(null);
  for (let i = 0; i < Math.min(levels.length, SLOTS); i++) {
    const lvl = levels[i];
    // normalise slotIndex so the patch lands at the expected positional inputs
    slots[lvl.slotIndex - 1] = lvl;
  }
  const patch = buildFullPatch(slots);
  const studyId = await resolveStudyId();
  const result  = await callSetStudyInputs(studyId, patch);
  if (!result.ok) {
    // Study ID may be stale (indicator removed and re-added). Invalidate cache and retry once.
    invalidateStudyCache();
    const freshId = await resolveStudyId();
    const retry   = await callSetStudyInputs(freshId, patch);
    if (!retry.ok) throw new Error(`Failed to write levels: ${retry.error}`);
  }
}

/** Update a single slot (5 inputs). Other slots are left unchanged. */
export async function writeLevel(
  slotIndex: number,
  price: number,
  kind: string,
  label: string,
  visible: number,
  priority: string = 'primary',
): Promise<void> {
  const base  = (slotIndex - 1) * 5;
  const patch: Record<string, unknown> = {
    [`in_${base}`]:     price,
    [`in_${base + 1}`]: kind,
    [`in_${base + 2}`]: abbreviateLabel(label),
    [`in_${base + 3}`]: visible,
    [`in_${base + 4}`]: priority,
  };
  const studyId = await resolveStudyId();
  const result  = await callSetStudyInputs(studyId, patch);
  if (!result.ok) {
    invalidateStudyCache();
    const freshId = await resolveStudyId();
    const retry   = await callSetStudyInputs(freshId, patch);
    if (!retry.ok) throw new Error(`Failed to write level: ${retry.error}`);
  }
}

/**
 * Truncate label to at most 20 chars at a clean word boundary.
 * Applied before writing to the Pine indicator so chips stay compact.
 * Called in buildFullPatch (covers all writeLevels paths) and writeLevel.
 */
export function abbreviateLabel(label: string): string {
  const MAX = 20;
  if (label.length <= MAX) return label;
  const candidate = label.slice(0, MAX);
  const spaceIdx  = candidate.lastIndexOf(' ');
  const cut        = spaceIdx > 3 ? spaceIdx : MAX;
  const trimmed    = label.slice(0, cut).replace(/[\s/·,\-]+$/, '');
  const result     = trimmed + '...';
  console.log(`[annotator] abbreviateLabel: "${label}" → "${result}"`);
  return result;
}

function levelKind(color: string, price: number, currentPrice: number): string {
  // commentary.js color semantics: green=support/long, red=resistance/short,
  // yellow=neutral/watch, gray=low-priority, blue=ORB/structure
  if (color === 'yellow' || color === 'gray') return 'neutral';
  if (color === 'green') return 'support';
  if (color === 'red') return 'resistance';
  // blue (ORB/structure) and any unknown: use price position as tiebreaker
  return price < currentPrice ? 'support' : 'resistance';
}

/** Build a full LevelAnnotation array from key_levels_to_watch (up to 8 slots). */
export function buildAnnotations(levels: KeyLevel[], currentPrice: number): LevelAnnotation[] {
  const summary = levels.slice(0, SLOTS).map(l => `${l.price}(${l.color})`).join(', ');
  console.log(`[annotator] buildAnnotations currentPrice=${currentPrice} levels=[${summary}]`);
  return levels.slice(0, SLOTS).map((lvl, i) => ({
    slotIndex: i + 1,
    price:     lvl.price,
    kind:      levelKind(lvl.color, lvl.price, currentPrice),
    label:     abbreviateLabel(lvl.label),
    visible:   1,
    priority:  lvl.priority ?? 'primary',
  }));
}

/** Write entry/stop/target bracket lines (in_43–in_45). Pass 0 to clear. */
export async function writeTradePlan(entry: number, stop: number, target: number): Promise<void> {
  const patch: Record<string, unknown> = {
    in_43: entry,
    in_44: stop,
    in_45: target,
  };
  const studyId = await resolveStudyId();
  const result  = await callSetStudyInputs(studyId, patch);
  if (!result.ok) {
    invalidateStudyCache();
    const freshId = await resolveStudyId();
    const retry   = await callSetStudyInputs(freshId, patch);
    if (!retry.ok) throw new Error(`Failed to write trade plan: ${retry.error}`);
  }
}

/** Zero out all 3 trade plan inputs. */
export async function clearTradePlan(): Promise<void> {
  return writeTradePlan(0, 0, 0);
}

const PATTERN_MARKER_BASE = 46;
const MAX_PATTERN_MARKERS = 4;

/** Write up to 4 candle pattern markers (in_46–in_57). Pass [] to clear all. */
export async function writePatternMarkers(markers: PatternMarker[]): Promise<void> {
  const patch: Record<string, unknown> = {};
  for (let i = 0; i < MAX_PATTERN_MARKERS; i++) {
    const base = PATTERN_MARKER_BASE + i * 3;
    const m    = markers[i];
    patch[`in_${base}`]     = m?.bar_offset ?? 0;
    patch[`in_${base + 1}`] = m ? truncateMarkerLabel(m.label) : '';
    patch[`in_${base + 2}`] = m?.signal ?? 0;
  }
  const studyId = await resolveStudyId();
  const result  = await callSetStudyInputs(studyId, patch);
  if (!result.ok) {
    invalidateStudyCache();
    const freshId = await resolveStudyId();
    const retry   = await callSetStudyInputs(freshId, patch);
    if (!retry.ok) throw new Error(`Failed to write pattern markers: ${retry.error}`);
  }
}

function truncateMarkerLabel(label: string): string {
  return label.length > 12 ? label.slice(0, 12) : label;
}

/** Zero out all 8 slots. */
export async function clearAll(): Promise<void> {
  const patch    = buildFullPatch(Array(SLOTS).fill(null));
  const studyId  = await resolveStudyId();
  const result   = await callSetStudyInputs(studyId, patch);
  if (!result.ok) {
    invalidateStudyCache();
    const freshId = await resolveStudyId();
    const retry   = await callSetStudyInputs(freshId, patch);
    if (!retry.ok) throw new Error(`Failed to clear levels: ${retry.error}`);
  }
}
