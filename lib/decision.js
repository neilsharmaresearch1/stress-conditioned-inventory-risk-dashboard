/**
 * lib/decision.js
 *
 * Translates model outputs into plain-language, actionable text.
 * Used by /api/latest (operational takeaway), /api/snapshot (alert payload),
 * and the food-bank framing layer.
 *
 * All language here is derived from model outputs -- nothing is hardcoded.
 * No em dashes anywhere in this file.
 */

import {
  MBG_THRESHOLD,
  MBG_W_WEATHER,
  MBG_W_PORT,
  MBG_SUSTAINED_N
} from './constants.js';
export { MBG_THRESHOLD, MBG_SUSTAINED_N };

const REGIME_WORD = {
  low:     'low',
  normal:  'moderate',
  high:    'elevated',
  extreme: 'extreme'
};

const SCENARIO_WORD = {
  baseline: 'baseline',
  safety:   'safety stock',
  tail:     'tail mitigation'
};

// ── Operational takeaway (moved verbatim from api/latest.js) ──────────────────
// Preserves the exact language contract the frontend already renders.
export function buildTakeaway(regime, scenario, selectedDays, minFeasible, meetsTarget, coverageMargin) {
  const sw = REGIME_WORD[regime]   || regime;
  const sc = SCENARIO_WORD[scenario] || scenario;

  if (minFeasible === null) {
    return `The model suggests no policy within the 2 to 6 day range meets the estimated 2% service target under ${sw} stress and the ${sc} scenario, under current public-signal conditions. Coverage above 6 days or a stronger mitigation scenario may be required. Review with operational context before acting.`;
  }
  if (!meetsTarget) {
    return `The model suggests the current ${selectedDays}-day policy falls below the estimated minimum of ${minFeasible} days under ${sw} stress (${sc}), under current public-signal conditions. Increasing coverage may reduce estimated stockout risk. Review with operational context before acting.`;
  }
  if (coverageMargin > 1) {
    return `The model suggests the current ${selectedDays}-day policy meets the estimated 2% target with ${coverageMargin} day(s) of buffer under ${sw} stress (${sc}), under current public-signal conditions. Evaluate whether the estimated holding cost is justified. Review with operational context.`;
  }
  return `The model suggests the current ${selectedDays}-day policy is at the estimated minimum required level under ${sw} stress (${sc}), under current public-signal conditions. Any reduction may breach the estimated 2% service target. Review with operational context before acting.`;
}

// ── Decision output layer (Task 5) ────────────────────────────────────────────
/**
 * buildDecisionOutput(riskState, selectedDays, scenario, targetFrac, frame)
 *
 * Returns a structured plain-language summary for display in the UI and alerts.
 * All values are derived from the model, none are hardcoded.
 *
 * frame: 'corporate' (default) or 'foodbank'
 */
export function buildDecisionOutput(riskState, selectedDays, scenario, targetFrac = 0.02, frame = 'corporate') {
  const { regime, pStockout, stressScore } = riskState;
  const entry = pStockout?.[scenario]?.[selectedDays];
  const p = entry ? entry.p : null;
  const meetsTarget = p !== null ? p <= targetFrac : null;

  // Find minimum feasible days from pStockout (avoids re-importing getMinFeasible)
  let minFeasible = null;
  if (pStockout?.[scenario]) {
    const days = [2, 3, 4, 5, 6];
    for (const d of days) {
      if (pStockout[scenario][d] && pStockout[scenario][d].p <= targetFrac) {
        minFeasible = d;
        break;
      }
    }
  }

  const coverageGap = minFeasible !== null ? selectedDays - minFeasible : null;
  const targetPct = Math.round(targetFrac * 100);

  const vocab = frame === 'foodbank' ? FOODBANK_VOCAB : CORPORATE_VOCAB;

  // Headline sentence
  const riskLevel = { low: 'low', normal: 'moderate', high: 'elevated', extreme: 'severe' }[regime] || regime;
  const headline = `${vocab.riskLevel(riskLevel)} ${vocab.disruption} on the Savannah-to-Atlanta lane. Current stress index: ${stressScore.toFixed(3)}.`;

  // Coverage guidance
  let coverageStatement;
  if (minFeasible === null) {
    coverageStatement = `No ${vocab.coverageUnit} level in the 2 to 6 day range meets the ${targetPct}% ${vocab.stockoutWord} target under current conditions. Consider increasing ${vocab.coverageUnit} beyond 6 days or activating stronger mitigation.`;
  } else if (meetsTarget) {
    const bufferDays = coverageGap > 0 ? coverageGap : 0;
    coverageStatement = `Current ${selectedDays}-day ${vocab.coverageUnit} meets the ${targetPct}% ${vocab.stockoutWord} target with ${bufferDays} day(s) of buffer. Minimum required: ${minFeasible} days.`;
  } else {
    const gap = minFeasible - selectedDays;
    coverageStatement = `To stay under ${targetPct}% ${vocab.stockoutWord} probability at current ${vocab.demandWord}, add ${gap} day(s) of ${vocab.coverageUnit} (current: ${selectedDays}d, minimum required: ${minFeasible}d).`;
  }

  // Next action date
  const reviewIntervalDays = { low: 7, normal: 3, high: 1, extreme: 0 }[regime] ?? 3;
  const reviewDate = new Date(Date.now() + reviewIntervalDays * 86400000);
  const reviewDateStr = reviewDate.toISOString().substring(0, 10);
  let actionStatement;
  if (reviewIntervalDays === 0) {
    actionStatement = `${vocab.urgentAction} Reassess ${vocab.coverageUnit} position now and every 12 hours while extreme stress persists.`;
  } else if (!meetsTarget && minFeasible !== null) {
    actionStatement = `${vocab.increaseAction(minFeasible)} Next ${vocab.coverageUnit} review: ${reviewDateStr}.`;
  } else {
    actionStatement = `${vocab.maintainAction} Next ${vocab.coverageUnit} review: ${reviewDateStr}.`;
  }

  // Alert text (concise, used in webhook/email payloads)
  const alertText = `${vocab.alertPrefix}: ${headline} ${coverageStatement}`;

  return { headline, coverageStatement, actionStatement, alertText, minFeasible, coverageGap, meetsTarget };
}

// ── Vocabulary frames ─────────────────────────────────────────────────────────

const CORPORATE_VOCAB = {
  disruption:  'disruption risk',
  riskLevel:   (level) => `${level.charAt(0).toUpperCase() + level.slice(1)}`,
  coverageUnit: 'inventory coverage',
  stockoutWord: 'stockout',
  demandWord:   'demand',
  urgentAction: 'Activate emergency mitigation protocol.',
  increaseAction: (d) => `Increase inventory coverage to at least ${d} days immediately.`,
  maintainAction: 'Maintain current coverage position.',
  alertPrefix:  'SLRIS Alert'
};

const FOODBANK_VOCAB = {
  disruption:  'supply disruption risk',
  riskLevel:   (level) => `${level.charAt(0).toUpperCase() + level.slice(1)}`,
  coverageUnit: 'supply coverage',
  stockoutWord: 'distribution failure',
  demandWord:   'community demand',
  urgentAction: 'Activate emergency pre-positioning of supplies.',
  increaseAction: (d) => `Pre-position supplies to achieve at least ${d} days of supply coverage.`,
  maintainAction: 'Maintain current supply position.',
  alertPrefix:  'Supply Disruption Alert'
};

// ── MBG Food-Bank Nowcast Decision Layer ──────────────────────────────────────
//
// HARD ACCURACY CONSTRAINT
// The validated threshold MBG_THRESHOLD was selected by time-blocked 5-fold
// cross-validation in backtest/validate_model.py. It was selected on the
// quantity computed in backtest/score_backtest.py::score_row():
//
//   computed_stress_index = 0.45 * weatherScore + 0.20 * portScore
//                           (trafficScore = 0.0, NPMRDS unavailable historically)
//
// This is the column "computed_stress_index" in backtest/corridor_daily.csv.
// The threshold MUST be applied to this same two-signal formula. Do NOT apply
// it to the full three-signal stressScore from computeRiskState -- that
// includes the 0.35 traffic weight and is a different quantity. Applying
// MBG_THRESHOLD to the three-signal score would silently shift the effective
// operating point and break the ROC validation.
//
// References:
//   backtest/VALIDATION.md -- Section 4 (MBG Operating Point, CV threshold)
//   backtest/score_backtest.py -- score_row(), constants WEIGHT_WEATHER, WEIGHT_PORT
//   backtest/validate_model.py -- computeTwoSignalScore(), select_threshold_asymmetric_youden()

// MBG_THRESHOLD, MBG_W_WEATHER, MBG_W_PORT, MBG_SUSTAINED_N
// imported from lib/constants.js and re-exported above.

/**
 * computeTwoSignalScore(weatherScore, portScore)
 *
 * Computes the exact score quantity on which MBG_THRESHOLD = 0.0862 was
 * validated. Formula mirrors backtest/score_backtest.py::score_row():
 *   stress = 0.45 * weatherScore + 0.20 * portScore
 * Traffic is excluded.
 *
 * weatherScore: float 0-0.80 (same NWS formula: min(count * 0.08, 0.80))
 * portScore:    float 0-1.00 (from data/port_signal.json or BTS normalization)
 *
 * Returns: float, clamped to [0, 1], 6 decimal places
 */
export function computeTwoSignalScore(weatherScore, portScore) {
  const raw = MBG_W_WEATHER * weatherScore + MBG_W_PORT * portScore;
  return parseFloat(Math.max(0, Math.min(1, raw)).toFixed(6));
}

/**
 * mbgDecision(weatherScore, portScore, consecutiveElevated, portUpdatedAt)
 *
 * Pure function. Returns the MBG food-bank nowcast decision for the current
 * reading.
 *
 * State logic (one threshold, persistence only -- no second magnitude cutoff):
 *   twoSignalScore < MBG_THRESHOLD                              => NORMAL
 *   twoSignalScore >= MBG_THRESHOLD                             => ELEVATED
 *   twoSignalScore >= MBG_THRESHOLD for >= MBG_SUSTAINED_N
 *     consecutive readings (counting the current one)           => SUSTAINED
 *
 * Inputs:
 *   weatherScore          float  min(nwsAlertCount * 0.08, 0.80)
 *   portScore             float  from data/port_signal.json or BTS normalization
 *   consecutiveElevated   int    count of PREVIOUS consecutive elevated readings
 *                                (stored in KV, zero if unknown)
 *   portUpdatedAt         string ISO 8601 or null -- used for freshness note only
 *
 * Returns:
 *   {
 *     state,                  string  'NORMAL' | 'ELEVATED' | 'SUSTAINED'
 *     twoSignalScore,         float   the exact validated score quantity
 *     newConsecutiveElevated, int     updated counter -- persist in KV
 *     primaryAction,          string  single recommended action
 *     secondaryContext,       string  de-emphasized supporting context
 *     framingText,            object  { scope, lag, localKnowledge, dataFreshness }
 *     threshold,              float   MBG_THRESHOLD (audit field)
 *     sustainedN,             int     MBG_SUSTAINED_N (audit field)
 *     sustainedNote,          string  operational-assumption disclaimer
 *   }
 *
 * What this does NOT return (hard constraints):
 *   - No stockout probability or AUC
 *   - No regime label (low/normal/high/extreme)
 *   - No stressScore (three-signal quantity)
 *   - No lead-time number (lag is qualitative only)
 */
export function mbgDecision(weatherScore, portScore, consecutiveElevated, portUpdatedAt) {
  const twoSignalScore = computeTwoSignalScore(weatherScore, portScore);
  const isElevated     = twoSignalScore >= MBG_THRESHOLD;

  const prevCount              = (typeof consecutiveElevated === 'number' && consecutiveElevated >= 0)
    ? consecutiveElevated : 0;
  const newConsecutiveElevated = isElevated ? prevCount + 1 : 0;

  let state;
  if (!isElevated) {
    state = 'NORMAL';
  } else if (newConsecutiveElevated >= MBG_SUSTAINED_N) {
    state = 'SUSTAINED';
  } else {
    state = 'ELEVATED';
  }

  return {
    state,
    twoSignalScore,
    newConsecutiveElevated,
    primaryAction:   MBG_PRIMARY_ACTIONS[state],
    secondaryContext: MBG_SECONDARY_CONTEXT[state],
    framingText:     _buildFramingText(portUpdatedAt),
    threshold:       MBG_THRESHOLD,
    sustainedN:      MBG_SUSTAINED_N,
    sustainedNote:   'MBG_SUSTAINED_N is an operational assumption, NOT statistically validated. Reviewable by MBG operations staff.',
  };
}

const MBG_PRIMARY_ACTIONS = {
  NORMAL:   'Supply pipeline normal. No action needed.',
  ELEVATED: 'Upstream port congestion detected. Add a modest buffer to your next ACFB order while supply is still normal.',
  SUSTAINED: 'Congestion has persisted. Downstream tightening is likely in the coming weeks. Maximize your ACFB pre-order, launch a donation drive, and review current stock. If your shelves are already low, prepare a rationing plan.',
};

const MBG_SECONDARY_CONTEXT = {
  NORMAL:   'Monitor weekly. No changes to ordering or donation strategy are needed at this time.',
  ELEVATED: 'This is a low-regret buffer action. Even if congestion clears quickly, a modest pre-order has low downside. Your current stock is not yet affected by this upstream signal.',
  SUSTAINED: 'This signal has been elevated for multiple consecutive readings at the port-data cadence (roughly monthly). Congestion at this duration typically begins affecting downstream supply within several weeks. Act on stock and ordering now rather than waiting for further confirmation.',
};

// Returns { primaryAction, secondaryContext } for a stored MBG state string.
// Used by /api/latest to render the KV-persisted state without re-deriving it.
export function mbgActionsForState(state) {
  return {
    primaryAction:    MBG_PRIMARY_ACTIONS[state]   ?? MBG_PRIMARY_ACTIONS.NORMAL,
    secondaryContext: MBG_SECONDARY_CONTEXT[state] ?? MBG_SECONDARY_CONTEXT.NORMAL,
  };
}

function _buildFramingText(portUpdatedAt) {
  let dataFreshness;
  if (portUpdatedAt) {
    const ageMs   = Date.now() - new Date(portUpdatedAt).getTime();
    const ageDays = Math.max(0, Math.floor(ageMs / 86_400_000));
    if (ageDays <= 1) {
      dataFreshness = 'Port data updated today.';
    } else if (ageDays <= 7) {
      dataFreshness = 'Port data last updated ' + ageDays + ' day' + (ageDays === 1 ? '' : 's') + ' ago.';
    } else {
      dataFreshness = 'Port data last updated ' + ageDays + ' days ago. This signal updates roughly monthly -- check for a newer reading if more than 35 days have passed.';
    }
  } else {
    dataFreshness = 'Port data update date unavailable. This signal updates roughly monthly; treat stale data with caution.';
  }

  return {
    scope:          'This tool detects sustained supply-chain congestion on the Savannah-Atlanta corridor. It does not predict sudden disruptions such as hurricanes or accidents. Use it alongside your own monitoring of stock.',
    lag:            'This signal reflects current upstream congestion, which reaches your shelves with a delay of several weeks. It is not a prediction of shortages; it is an early indicator of pressure that may affect your supply.',
    localKnowledge: 'This tool does not see your current inventory. If your stock is already low, treat an Elevated signal as urgent.',
    dataFreshness,
  };
}

// ── Alert payload builder ─────────────────────────────────────────────────────
/**
 * buildAlertPayload(newSnapshot, prevSnapshot, decisionOutput)
 *
 * Constructs the alert body for a regime transition notification.
 * Uses decision-layer language, not raw model variables.
 */
export function buildAlertPayload(newSnapshot, prevSnapshot, decisionOutput) {
  const from = prevSnapshot?.regime || 'unknown';
  const to   = newSnapshot.regime;
  const ts   = newSnapshot.timestamp;

  return {
    subject: `Lane Stress Alert: ${from} to ${to} transition (${ts.substring(0, 10)})`,
    body: [
      `Savannah-to-Atlanta Lane Stress Index Alert`,
      ``,
      `Regime transition: ${from} to ${to}`,
      `Timestamp: ${ts}`,
      `Stress index: ${newSnapshot.stressIndex.toFixed(4)}`,
      ``,
      decisionOutput.headline,
      decisionOutput.coverageStatement,
      decisionOutput.actionStatement,
      ``,
      `Feed health:`,
      `  NWS: ${newSnapshot.feedHealth?.nws || 'unknown'}`,
      `  GA-511: ${newSnapshot.feedHealth?.ga511 || 'unknown'}`,
      `  Port: ${newSnapshot.feedHealth?.port || 'unknown'}`,
      ``,
      `This is an automated alert from the Savannah-to-Atlanta Lane Risk Intelligence System (SLRIS). All outputs are model-based estimates from a research prototype. Review with operational context before acting.`
    ].join('\n'),
    regime: to,
    previousRegime: from,
    timestamp: ts,
    stressIndex: newSnapshot.stressIndex
  };
}
