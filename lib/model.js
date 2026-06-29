/**
 * lib/model.js
 *
 * Pure model function for stress-conditioned stockout risk.
 * Source of truth for all regime/probability computation.
 *
 * computeRiskState(rawInputs) is the single entry point for risk calculation.
 * Both /api/latest and /api/snapshot import and call it here.
 * Do not change MODEL values, regime cutoffs, or weight scheme without
 * re-running the simulation and updating the paper.
 *
 * Model parameters (from Paper 242, Appendix A1):
 *   Stress index = 0.45 * weatherScore + 0.35 * trafficScore + 0.20 * portScore
 *   Regime cutoffs: low < 0.30 <= normal < 0.60 <= high < 0.80 <= extreme
 *   Simulation: N=50,000, seed=42, alpha=-2.197, beta=0.811, sigma_sev=1.2, severe cap 72h
 *
 * TODO (attribution): The severe-delay probability row in the dashboard figures table
 * references an FHWA PTI source that does not match the paper's Appendix A1 derivation.
 * The logistic parameters (alpha=-2.197, beta=0.811) are model-derived, not directly
 * from FHWA PTI. This attribution should be corrected in any published version.
 * Do NOT silently change the underlying figure values -- surface this discrepancy first.
 */

// ── Constants ─────────────────────────────────────────────────────────────────
export const DAYS = [2, 3, 4, 5, 6];
export const VALID_DAYS = [2, 3, 4, 5, 6];
export const VALID_SCENARIOS = ['baseline', 'safety', 'tail'];
export const SERVICE_TARGET = 0.02; // 2 percent default service constraint

// Stress index weights -- single source of truth is lib/constants.js
import { WEIGHTS } from './constants.js';
export { WEIGHTS };

// Regime cutoffs: a, b, c define the low/normal, normal/high, high/extreme boundaries
export const REGIME_CUTOFFS = { a: -0.5016, b: 0.4981, c: 1.4989 };

// ── Stockout model ────────────────────────────────────────────────────────────
// Per-(regime, scenario) curves: [p, lo, hi] at DAYS = [2,3,4,5,6]
// Values are DECIMAL probabilities (0.0-1.0).
// HIGH and EXTREME at B=2,3,4: exact values from Appendix A1, Paper 242, N=50000, seed=42.
// LOW, NORMAL, and all B=5,6 cells: illustrative, coarsely rounded, pending full simulation export.
// Illustrative cells satisfy monotone-in-B, regime order low<normal<high<extreme,
// safety<=baseline, tail<=baseline.
export const MODEL = {
  low: {
    baseline: [[0.018,0.011,0.025],[0.0010,0.0004,0.0016],[0.0001,0.0000,0.0002],[0.0000,0.0000,0.0000],[0.0000,0.0000,0.0000]],
    safety:   [[0.0030,0.0015,0.0045],[0.0002,0.0000,0.0004],[0.0000,0.0000,0.0000],[0.0000,0.0000,0.0000],[0.0000,0.0000,0.0000]],
    tail:     [[0.014,0.008,0.020],[0.0007,0.0002,0.0012],[0.0000,0.0000,0.0001],[0.0000,0.0000,0.0000],[0.0000,0.0000,0.0000]]
  },
  normal: {
    baseline: [[0.035,0.025,0.045],[0.0040,0.0025,0.0055],[0.0003,0.0001,0.0005],[0.0000,0.0000,0.0001],[0.0000,0.0000,0.0000]],
    safety:   [[0.0060,0.0040,0.0080],[0.0005,0.0002,0.0008],[0.0000,0.0000,0.0001],[0.0000,0.0000,0.0000],[0.0000,0.0000,0.0000]],
    tail:     [[0.028,0.019,0.037],[0.0030,0.0018,0.0042],[0.0002,0.0001,0.0004],[0.0000,0.0000,0.0001],[0.0000,0.0000,0.0000]]
  },
  high: {
    baseline: [[0.0721,0.0699,0.0744],[0.0083,0.0075,0.0091],[0.0008,0.0005,0.0011],[0.0001,0.0000,0.0002],[0.0000,0.0000,0.0001]],
    safety:   [[0.0095,0.0087,0.0104],[0.0008,0.0005,0.0011],[0.0000,0.0000,0.0001],[0.0000,0.0000,0.0000],[0.0000,0.0000,0.0000]],
    tail:     [[0.0555,0.0535,0.0575],[0.0052,0.0046,0.0058],[0.0004,0.0002,0.0006],[0.0001,0.0000,0.0001],[0.0000,0.0000,0.0000]]
  },
  extreme: {
    baseline: [[0.1251,0.1222,0.1280],[0.0176,0.0164,0.0188],[0.0024,0.0020,0.0028],[0.0004,0.0002,0.0006],[0.0001,0.0000,0.0002]],
    safety:   [[0.0183,0.0171,0.0195],[0.0024,0.0020,0.0028],[0.0002,0.0001,0.0004],[0.0000,0.0000,0.0001],[0.0000,0.0000,0.0000]],
    tail:     [[0.0931,0.0906,0.0956],[0.0122,0.0112,0.0132],[0.0015,0.0012,0.0018],[0.0003,0.0002,0.0004],[0.0001,0.0000,0.0001]]
  }
};

// ── Expected shortage table ───────────────────────────────────────────────────
// [val, lo, hi] at B=[2,3,4,5,6] (demand-days of unmet demand).
// HIGH and EXTREME at B=2,3,4: exact values from Appendix A1, Paper 242.
// LOW, NORMAL, and all B=5,6 cells: illustrative, pending full simulation export.
export const SHORTAGE_DATA = {
  low: {
    baseline: [[0.90,0.55,1.25],[0.06,0.02,0.10],[0.003,0.000,0.006],[0.000,0.000,0.001],[0.000,0.000,0.000]],
    safety:   [[0.11,0.06,0.16],[0.003,0.000,0.007],[0.000,0.000,0.001],[0.000,0.000,0.000],[0.000,0.000,0.000]],
    tail:     [[0.70,0.40,1.00],[0.04,0.01,0.07],[0.001,0.000,0.003],[0.000,0.000,0.000],[0.000,0.000,0.000]]
  },
  normal: {
    baseline: [[1.8,1.2,2.4],[0.12,0.07,0.17],[0.005,0.001,0.010],[0.001,0.000,0.002],[0.000,0.000,0.001]],
    safety:   [[0.22,0.14,0.30],[0.008,0.003,0.013],[0.000,0.000,0.001],[0.000,0.000,0.000],[0.000,0.000,0.000]],
    tail:     [[1.4,0.9,1.9],[0.09,0.05,0.13],[0.004,0.001,0.008],[0.000,0.000,0.001],[0.000,0.000,0.000]]
  },
  high: {
    baseline: [[3.703,3.533,3.874],[0.304,0.257,0.350],[0.019,0.011,0.027],[0.003,0.001,0.005],[0.000,0.000,0.001]],
    safety:   [[0.444,0.390,0.496],[0.022,0.012,0.032],[0.000,0.000,0.001],[0.000,0.000,0.000],[0.000,0.000,0.000]],
    tail:     [[2.750,2.612,2.896],[0.180,0.149,0.211],[0.010,0.005,0.015],[0.002,0.000,0.004],[0.000,0.000,0.001]]
  },
  extreme: {
    baseline: [[6.370,6.123,6.617],[0.839,0.767,0.911],[0.088,0.068,0.108],[0.015,0.008,0.022],[0.003,0.001,0.005]],
    safety:   [[0.849,0.785,0.914],[0.091,0.069,0.112],[0.005,0.001,0.009],[0.001,0.000,0.002],[0.000,0.000,0.001]],
    tail:     [[4.656,4.457,4.855],[0.570,0.507,0.632],[0.052,0.037,0.067],[0.009,0.004,0.014],[0.002,0.000,0.004]]
  }
};

// Reference stress decomposition by regime (for UI display only, not model inputs)
export const STRESS_DATA = {
  low:     { score: 0.023, components: { throughput_z: 0.04, leadtime_var_z: 0.02, ops_disruption: 0.01 } },
  normal:  { score: 0.18,  components: { throughput_z: 0.22, leadtime_var_z: 0.16, ops_disruption: 0.12 } },
  high:    { score: 0.54,  components: { throughput_z: 0.61, leadtime_var_z: 0.54, ops_disruption: 0.47 } },
  extreme: { score: 0.87,  components: { throughput_z: 0.92, leadtime_var_z: 0.88, ops_disruption: 0.81 } }
};

// ── Core functions ────────────────────────────────────────────────────────────

export function deriveRegime(stressScore) {
  if (stressScore >= 0.8) return 'extreme';
  if (stressScore >= 0.6) return 'high';
  if (stressScore >= 0.3) return 'normal';
  return 'low';
}

// Minimum days of cover that meets the service target (null if none in 2-6d range)
export function getMinFeasible(regime, scenario, target = SERVICE_TARGET) {
  const curve = MODEL[regime]?.[scenario] || MODEL.normal.baseline;
  for (let i = 0; i < DAYS.length; i++) {
    if (curve[i][0] <= target) return DAYS[i];
  }
  return null;
}

/**
 * computeRiskState(rawInputs) -- pure, deterministic risk computation.
 *
 * Takes raw feed values, applies the published stress index formula and regime
 * cutoffs, then returns stockout probabilities for all (scenario, days) cells.
 *
 * rawInputs:
 *   nwsAlertCount   int    active NWS alerts on the corridor
 *   trafficScore    float  scored GA-511 traffic (0-0.85, already aggregated)
 *   portScore       float  port baseline score (0-1)
 *
 * Returns { weatherScore, stressScore, stressScoreRaw, stressContributions,
 *           regime, pStockout }
 *
 * pStockout is keyed [scenario][days] with { p, lo, hi, shortage, shortage_lo, shortage_hi }
 * where p/lo/hi are DECIMAL probabilities (not percent).
 */
export function computeRiskState({ nwsAlertCount, trafficScore, portScore }) {
  const weatherScore = Math.min(nwsAlertCount * 0.08, 0.80);

  const stressScoreRaw = (WEIGHTS.weather * weatherScore)
    + (WEIGHTS.traffic * trafficScore)
    + (WEIGHTS.port    * portScore);

  const stressScore = parseFloat(Math.max(0, Math.min(1, stressScoreRaw)).toFixed(4));
  const regime = deriveRegime(stressScore);

  const stressContributions = {
    weather: parseFloat((WEIGHTS.weather * weatherScore).toFixed(4)),
    traffic: parseFloat((WEIGHTS.traffic * trafficScore).toFixed(4)),
    port:    parseFloat((WEIGHTS.port    * portScore).toFixed(4))
  };

  const pStockout = {};
  for (const scenario of VALID_SCENARIOS) {
    pStockout[scenario] = {};
    const curve        = MODEL[regime][scenario];
    const shortageCurve = SHORTAGE_DATA[regime][scenario];
    for (let i = 0; i < DAYS.length; i++) {
      pStockout[scenario][DAYS[i]] = {
        p:           curve[i][0],
        lo:          curve[i][1],
        hi:          curve[i][2],
        shortage:    shortageCurve[i][0],
        shortage_lo: shortageCurve[i][1],
        shortage_hi: shortageCurve[i][2]
      };
    }
  }

  return {
    weatherScore:        parseFloat(weatherScore.toFixed(4)),
    stressScore,
    stressScoreRaw:      parseFloat(stressScoreRaw.toFixed(4)),
    stressContributions,
    regime,
    pStockout
  };
}
