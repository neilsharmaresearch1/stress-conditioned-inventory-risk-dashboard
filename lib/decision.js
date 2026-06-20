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
