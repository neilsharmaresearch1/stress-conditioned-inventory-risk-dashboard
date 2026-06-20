/**
 * lib/framing.js
 *
 * Config-driven vocabulary layer for presenting the same engine output in
 * different operational contexts.
 *
 * Same model, same feeds, same regime math. Only the output vocabulary changes.
 *
 * Frames:
 *   corporate  -- inventory/supply chain language (default)
 *   foodbank   -- humanitarian supply distribution language
 *
 * Activation:
 *   Route param  ?mode=foodbank  (overrides env var)
 *   Env var      FRAMING_MODE=foodbank
 *
 * Usage in API routes:
 *   import { getFrame } from '../lib/framing.js';
 *   const frame = getFrame(req.query.mode);
 */

export const FRAMES = {
  corporate: {
    id:            'corporate',
    label:         'Inventory Operations',
    riskNoun:      'stockout risk',
    disruptionNoun: 'disruption risk',
    coverageNoun:  'inventory coverage',
    coverageUnit:  'days of cover',
    demandNoun:    'demand',
    actionVerb:    'reorder',
    urgentPrefix:  'Operational alert',
    description:   'Standard supply-chain inventory view for distribution operators.'
  },
  foodbank: {
    id:            'foodbank',
    label:         'Humanitarian Supply Distribution',
    riskNoun:      'distribution failure risk',
    disruptionNoun: 'inbound sourcing disruption',
    coverageNoun:  'supply coverage',
    coverageUnit:  'days of supply',
    demandNoun:    'community demand',
    actionVerb:    'pre-position',
    urgentPrefix:  'Supply continuity alert',
    description:   'Food-bank and humanitarian distribution view. Same model and feeds; different operational vocabulary and action framing.'
  }
};

/**
 * getFrame(modeParam)
 *
 * Resolves the active frame from a route param or env var.
 * Falls back to 'corporate' if unrecognized.
 */
export function getFrame(modeParam) {
  const raw = modeParam || process.env.FRAMING_MODE || 'corporate';
  return FRAMES[raw] || FRAMES.corporate;
}

/**
 * applyFrameToTakeaway(takeaway, frame)
 *
 * Rewrites an existing corporate-vocabulary takeaway string
 * for the food-bank frame by substituting key phrases.
 * This is a lightweight string transform, not a re-generation.
 * Full re-generation goes through buildDecisionOutput in decision.js.
 */
export function applyFrameToTakeaway(takeaway, frame) {
  if (!frame || frame.id === 'corporate') return takeaway;

  return takeaway
    .replace(/inventory/gi, frame.coverageNoun)
    .replace(/days of cover/gi, frame.coverageUnit)
    .replace(/stockout/gi, frame.riskNoun)
    .replace(/demand/gi, frame.demandNoun)
    .replace(/reorder/gi, frame.actionVerb);
}

/**
 * frameHeadline(regime, stressScore, frame)
 *
 * Produces a single-sentence headline in the target frame's vocabulary.
 */
export function frameHeadline(regime, stressScore, frame = FRAMES.corporate) {
  const riskLevel = {
    low:     'Low',
    normal:  'Moderate',
    high:    'Elevated',
    extreme: 'Severe'
  }[regime] || 'Unknown';

  return `${riskLevel} ${frame.disruptionNoun} on the Savannah-to-Atlanta lane. Stress index: ${stressScore.toFixed(3)}.`;
}

/**
 * frameAction(meetsTarget, minFeasible, selectedDays, targetPct, frame)
 *
 * Returns the recommended action sentence.
 */
export function frameAction(meetsTarget, minFeasible, selectedDays, targetPct, frame = FRAMES.corporate) {
  if (minFeasible === null) {
    return `No ${frame.coverageUnit} level in the 2 to 6 day range meets the ${targetPct}% target. Consider escalating ${frame.coverageNoun} beyond 6 days.`;
  }
  if (!meetsTarget) {
    const gap = minFeasible - selectedDays;
    return `${frame.urgentPrefix}: ${frame.actionVerb.charAt(0).toUpperCase() + frame.actionVerb.slice(1)} to add ${gap} day(s) of ${frame.coverageUnit}. Current ${selectedDays}d is below the required ${minFeasible}d minimum.`;
  }
  const buffer = selectedDays - minFeasible;
  return `Current ${selectedDays}-day ${frame.coverageUnit} meets the ${targetPct}% target with ${buffer} day(s) of buffer. Maintain current position.`;
}
