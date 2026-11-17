'use strict';

/**
 * Whether TVCM may spend money on an LLM.
 *
 * Jim turned AI chart analysis off on 2026-11-17: the recommendation scorecard was below
 * break-even and the Anthropic bill was climbing. The P&L half of the app — the live feed,
 * the menu bar, the Order History window, corrections — has never made an LLM call and is
 * untouched by this.
 *
 * One rule, and it is a spending rule rather than a display one:
 *
 *   **With `aiAnalysisEnabled` off, nothing in TVCM may reach a provider.** Not the
 *   scheduler, not Refresh Now, not a lesson, not a grade. A gate that only hides the
 *   output would still be billed.
 *
 * The default is OFF. A setting that costs money per tick should have to be asked for.
 *
 * Pure: no Electron, no network, no settings file of its own — the caller passes what it
 * has, so the same rule can be tested in milliseconds and read in one place.
 */

/** Shown wherever commentary would have been, and as the reason Refresh Now is disabled. */
const AI_OFF_MESSAGE = 'AI analysis is off';

/** The longer form, for a status line or a thrown error. */
const AI_OFF_REASON =
  'AI analysis is off — turn it on in Settings if you want chart commentary again';

/** Raised when something asks for an analysis while AI is off. */
const AI_OFF_CODE = 'TVCM-AI-OFF';

/**
 * True when an LLM call is permitted. Absent and malformed settings both read as OFF:
 * the expensive direction is never the default, and `undefined` must not buy anything.
 */
function aiAllowed(settings) {
  return !!(settings && settings.aiAnalysisEnabled === true);
}

/** The reason to show when AI is off, or null when it is on and there is nothing to say. */
function aiOffReason(settings) {
  return aiAllowed(settings) ? null : AI_OFF_REASON;
}

module.exports = { AI_OFF_MESSAGE, AI_OFF_REASON, AI_OFF_CODE, aiAllowed, aiOffReason };
