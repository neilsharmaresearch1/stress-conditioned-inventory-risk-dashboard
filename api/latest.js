/**
 * /api/latest — Stress-Aware Inventory Dashboard · Phase 0 GPA-Facing Prototype
 *
 * PROTOTYPE NOTICE: This is a Phase 0 exploratory prototype for evaluation and
 * discussion purposes only. It is NOT a production Georgia Ports Authority model
 * and has NOT been calibrated to GPA operational data, actual port throughput,
 * real demand patterns, or GPA-specific parameters. All outputs are illustrative
 * estimates derived from public weather and traffic signals only. Review all
 * results with qualified operational context before any planning or decision use.
 *
 * Deployed as a Vercel serverless function at /api/latest.
 *
 * Phase 0: Returns a stress-regime-aware illustrative payload driven by
 *   live NWS corridor alert checks and a static port baseline estimate.
 *   Query params `days` and `scenario` are read and echoed back correctly.
 *
 * Phase 1 upgrade path: Replace the payload construction below with a real
 *   data fetch from your simulation engine or data store. No changes to
 *   index.html are required — the contract below is stable.
 *
 * ── Query parameters ─────────────────────────────────────────────────────────
 *
 *   ?days=N         integer 2–6, defaults to 3
 *   ?scenario=X     "baseline" | "safety" | "tail", defaults to "baseline"
 *
 * ── Payload contract ─────────────────────────────────────────────────────────
 *
 *   timestamp              ISO 8601 string — when this reading was generated
 *   regime                 "low" | "normal" | "high" | "extreme"
 *   stress_score           decimal 0.0–1.0 — composite stress index
 *   scenario               "baseline" | "safety" | "tail"
 *   selected_days_of_cover integer 2–6 — echoes the requested ?days param
 *   recommended_days       integer 2–6 or null — from model recommendation
 *   minimum_feasible_days  integer 2–6 or null — minimum policy meeting target
 *   stockout_probability   DECIMAL 0.0–1.0 — e.g. 0.038 = 3.8%
 *   stockout_ci_low        DECIMAL 0.0–1.0 — 95% CI lower bound
 *   stockout_ci_high       DECIMAL 0.0–1.0 — 95% CI upper bound
 *   expected_shortage      number — expected demand-days of unmet demand
 *   policy_cost_index      number — holding + expected shortage cost index
 *   coverage_margin        integer — days above minimum (negative = breach)
 *   operational_takeaway   string — one-line action recommendation
 *   source_summary         object — live signal metadata (see below)
 *
 * NOTE: stockout_probability, stockout_ci_low, stockout_ci_high are decimals
 * (0.0–1.0). The dashboard's display layer multiplies by 100 for percent
 * display. Do NOT pass percent values (e.g. 3.8) — pass decimal (e.g. 0.038).
 */

import { readFile } from 'fs/promises';
import { join }     from 'path';

const GA511_KEY = process.env.GA511_API_KEY || null;

// ── NWS live alert check ──────────────────────────────────────────────────────
// Checks NWS API for active weather alerts along the Savannah–Atlanta corridor.
// Returns alert count and whether any are active. Falls back gracefully.
async function fetchNWSAlerts() {
  try {
    // Savannah–Atlanta corridor counties: Chatham GA, Bryan GA, Bulloch GA,
    // Candler GA, Emanuel GA, Laurens GA, Twiggs GA, Bibb GA, Fulton GA
    const zones = ['GAC051', 'GAC029', 'GAC011', 'GAC025', 'GAC107', 'GAC175', 'GAC289', 'GAC021', 'GAC121'];
    const url = `https://api.weather.gov/alerts/active?zone=${zones.join(',')}&status=actual&message_type=alert`;
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'stress-inventory-dashboard/0.1 (neilsharma.research1@gmail.com)',
        'Accept': 'application/geo+json'
      },
      signal: AbortSignal.timeout(4000)
    });
    if (!res.ok) return { count: 0, active: false, error: 'nws_http_' + res.status };
    const data = await res.json();
    const count = Array.isArray(data.features) ? data.features.length : 0;
    return { count, active: count > 0, error: null };
  } catch (e) {
    return { count: 0, active: false, error: 'nws_timeout' };
  }
}

// ── Georgia 511 traffic ingestion ─────────────────────────────────────────────

const CORRIDOR_LOCATION_KEYWORDS = [
  'i-16',
  'i-75',
  'i-85',
  'i-285',
  'i-20',
  'savannah',
  'macon',
  'atlanta',
  'chatham',
  'bibb',
  'fulton'
];

const TRAFFIC_SEVERITY_KEYWORDS = [
  'crash',
  'accident',
  'closure',
  'closed',
  'congestion',
  'delay',
  'construction',
  'disabled vehicle',
  'incident',
  'lane blocked'
];

const TRAFFIC_SEVERE_KEYWORDS = [
  'closure',
  'closed',
  'crash',
  'accident',
  'lane blocked'
];

function flattenText(value, bucket = []) {
  if (value == null) return bucket;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    bucket.push(String(value));
    return bucket;
  }
  if (Array.isArray(value)) {
    for (const item of value) flattenText(item, bucket);
    return bucket;
  }
  if (typeof value === 'object') {
    for (const v of Object.values(value)) flattenText(v, bucket);
  }
  return bucket;
}

function extractEventArray(data) {
  if (Array.isArray(data)) return data;
  if (!data || typeof data !== 'object') return [];
  if (Array.isArray(data.events)) return data.events;
  if (Array.isArray(data.Events)) return data.Events;
  if (Array.isArray(data.features)) return data.features;
  if (Array.isArray(data.response)) return data.response;
  return [];
}

function scoreTrafficEvent(event) {
  const haystack = flattenText(event).join(' | ').toLowerCase();

  const matchesLocation = CORRIDOR_LOCATION_KEYWORDS.some((kw) => haystack.includes(kw));
  const matchesSeverity = TRAFFIC_SEVERITY_KEYWORDS.some((kw) => haystack.includes(kw));

  if (!matchesLocation || !matchesSeverity) {
    return { relevant: false, increment: 0 };
  }

  let increment = 0.08;
  if (TRAFFIC_SEVERE_KEYWORDS.some((kw) => haystack.includes(kw))) {
    increment += 0.15;
  }

  return { relevant: true, increment };
}

async function fetchGA511TrafficEvents() {
  if (!GA511_KEY) {
    return {
      enabled: false,
      count: 0,
      score: 0,
      error: null
    };
  }

  try {
    const url = `https://511ga.org/api/v2/get/event?key=${GA511_KEY}&format=json`;
    const res = await fetch(url, {
      signal: AbortSignal.timeout(4000)
    });

    if (!res.ok) {
      return {
        enabled: true,
        count: 0,
        score: 0,
        error: 'ga511_http_' + res.status
      };
    }

    const data = await res.json();
    const rawEvents = extractEventArray(data);

    let relevantCount = 0;
    let totalScore = 0;

    for (const event of rawEvents) {
      const result = scoreTrafficEvent(event);
      if (result.relevant) {
        relevantCount += 1;
        totalScore += result.increment;
      }
    }

    return {
      enabled: true,
      count: relevantCount,
      score: Math.min(totalScore, 0.85),
      error: null
    };
  } catch (e) {
    return {
      enabled: true,
      count: 0,
      score: 0,
      error: 'ga511_fetch_failed'
    };
  }
}

// ── Stockout model (mirrors frontend MODEL object) ────────────────────────────
// Per-(regime, scenario) curves: [p, lo, hi] at days [2,3,4,5,6]
// Values are DECIMAL probabilities (0.0–1.0).
const MODEL = {
  low: {
    baseline: [[0.082, 0.068, 0.096], [0.031, 0.023, 0.040], [0.012, 0.008, 0.016], [0.005, 0.003, 0.007], [0.002, 0.001, 0.003]],
    safety:   [[0.061, 0.049, 0.073], [0.021, 0.015, 0.028], [0.008, 0.005, 0.011], [0.003, 0.001, 0.005], [0.001, 0.0005, 0.002]],
    tail:     [[0.074, 0.060, 0.088], [0.026, 0.019, 0.034], [0.009, 0.006, 0.012], [0.0035, 0.002, 0.005], [0.0012, 0.0006, 0.0018]]
  },
  normal: {
    baseline: [[0.145, 0.121, 0.169], [0.072, 0.058, 0.086], [0.038, 0.029, 0.047], [0.019, 0.013, 0.025], [0.009, 0.006, 0.012]],
    safety:   [[0.108, 0.089, 0.127], [0.049, 0.038, 0.060], [0.023, 0.016, 0.030], [0.011, 0.007, 0.015], [0.005, 0.003, 0.007]],
    tail:     [[0.130, 0.108, 0.152], [0.061, 0.048, 0.074], [0.030, 0.022, 0.038], [0.014, 0.009, 0.019], [0.006, 0.004, 0.008]]
  },
  high: {
    baseline: [[0.263, 0.224, 0.302], [0.158, 0.132, 0.184], [0.094, 0.076, 0.112], [0.056, 0.043, 0.069], [0.034, 0.025, 0.043]],
    safety:   [[0.197, 0.165, 0.229], [0.109, 0.088, 0.130], [0.058, 0.044, 0.072], [0.031, 0.022, 0.040], [0.017, 0.011, 0.023]],
    tail:     [[0.235, 0.198, 0.272], [0.134, 0.110, 0.158], [0.074, 0.058, 0.090], [0.041, 0.030, 0.052], [0.023, 0.016, 0.030]]
  },
  extreme: {
    baseline: [[0.421, 0.368, 0.474], [0.296, 0.255, 0.337], [0.198, 0.167, 0.229], [0.132, 0.108, 0.156], [0.087, 0.070, 0.104]],
    safety:   [[0.315, 0.270, 0.360], [0.204, 0.172, 0.236], [0.125, 0.102, 0.148], [0.078, 0.062, 0.094], [0.049, 0.038, 0.060]],
    tail:     [[0.378, 0.328, 0.428], [0.259, 0.220, 0.298], [0.163, 0.135, 0.191], [0.101, 0.082, 0.120], [0.062, 0.049, 0.075]]
  }
};

const DAYS = [2, 3, 4, 5, 6];
const VALID_DAYS = [2, 3, 4, 5, 6];
const VALID_SCENARIOS = ['baseline', 'safety', 'tail'];
const SERVICE_TARGET = 0.02; // 2%

// Minimum days that meets the service target (or null if none in range)
function getMinFeasible(regime, scenario) {
  const curve = MODEL[regime]?.[scenario] || MODEL.normal.baseline;
  for (let i = 0; i < DAYS.length; i++) {
    if (curve[i][0] <= SERVICE_TARGET) return DAYS[i];
  }
  return null;
}

// Stress decomposition per regime
const STRESS_DATA = {
  low:     { score: 0.023, components: { throughput_z: 0.04, leadtime_var_z: 0.02, ops_disruption: 0.01 } },
  normal:  { score: 0.18,  components: { throughput_z: 0.22, leadtime_var_z: 0.16, ops_disruption: 0.12 } },
  high:    { score: 0.54,  components: { throughput_z: 0.61, leadtime_var_z: 0.54, ops_disruption: 0.47 } },
  extreme: { score: 0.87,  components: { throughput_z: 0.92, leadtime_var_z: 0.88, ops_disruption: 0.81 } }
};

async function loadJsonFile(relativePath, fallback) {
  try {
    const text = await readFile(join(process.cwd(), relativePath), 'utf8');
    return JSON.parse(text);
  } catch (e) {
    return fallback;
  }
}

const PORT_SIGNAL = {
  score:       0.10,
  mode:        'static_phase_0_proxy',
  explanation: 'Static Phase 0 estimate. No live GPA throughput or port congestion data is ingested. Replace with a live port signal in Phase 1.'
};

const VALIDATION_FALLBACK = {
  updated_at:            null,
  directionality_checks: 'unknown',
  sensitivity_analysis:  'pending',
  historical_backtest:   'pending',
  gpa_calibration:       'not_connected',
  notes:                 []
};

function deriveRegime(stressScore) {
  if (stressScore >= 0.8) return 'extreme';
  if (stressScore >= 0.6) return 'high';
  if (stressScore >= 0.3) return 'normal';
  return 'low';
}

// Plain-language operational takeaway
function buildTakeaway(regime, scenario, selectedDays, minFeasible, meetsTarget, coverageMargin) {
  const sw = { low: 'low', normal: 'moderate', high: 'elevated', extreme: 'extreme' }[regime];
  const sc = { baseline: 'baseline', safety: 'safety stock', tail: 'tail mitigation' }[scenario];

  if (minFeasible === null) {
    return `The model suggests no policy within the 2–6 day range meets the estimated 2% service target under ${sw} stress and the ${sc} scenario, under current public-signal conditions. Coverage above 6 days or a stronger mitigation scenario may be required. Review with operational context before acting.`;
  }
  if (!meetsTarget) {
    return `The model suggests the current ${selectedDays}-day policy falls below the estimated minimum of ${minFeasible} days under ${sw} stress (${sc}), under current public-signal conditions. Increasing coverage may reduce estimated stockout risk. Review with operational context before acting.`;
  }
  if (coverageMargin > 1) {
    return `The model suggests the current ${selectedDays}-day policy meets the estimated 2% target with ${coverageMargin} day(s) of buffer under ${sw} stress (${sc}), under current public-signal conditions. Evaluate whether the estimated holding cost is justified. Review with operational context.`;
  }
  return `The model suggests the current ${selectedDays}-day policy is at the estimated minimum required level under ${sw} stress (${sc}), under current public-signal conditions. Any reduction may breach the estimated 2% service target. Review with operational context before acting.`;
}

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-store, max-age=0');

  try {
    // ── Parse query params ────────────────────────────────────────────────────
    const reqUrl = new URL(req.url, `http://${req.headers.host}`);
    const rawDays = parseInt(reqUrl.searchParams.get('days') ?? '3', 10);
    const selectedDays = VALID_DAYS.includes(rawDays) ? rawDays : 3;
    const rawScenario = reqUrl.searchParams.get('scenario') ?? 'baseline';
    const scenario = VALID_SCENARIOS.includes(rawScenario) ? rawScenario : 'baseline';

    // ── Live signal fetch ─────────────────────────────────────────────────────
    const [portSignalFile, validationFile, nwsResult, trafficResult] = await Promise.all([
      loadJsonFile('data/port_signal.json', null),
      loadJsonFile('data/validation_status.json', null),
      fetchNWSAlerts(),
      fetchGA511TrafficEvents()
    ]);

    const nwsAlertCount = nwsResult.count;
    const weatherScore = Math.min(nwsAlertCount * 0.08, 0.80);

    const trafficEventCount = trafficResult.count;
    const trafficScore = trafficResult.score;

    const sourceFailures = [];
    if (nwsResult.error) sourceFailures.push(nwsResult.error);
    if (trafficResult.error) sourceFailures.push(trafficResult.error);

    const sourcesUsed = [];
    if (!nwsResult.error) sourcesUsed.push('nws_alerts');
    if (trafficResult.enabled && !trafficResult.error) sourcesUsed.push('ga511_traffic');

    const nwsAvailable    = !nwsResult.error;
    const ga511Available  = trafficResult.enabled && !trafficResult.error;
    const liveSourceCount = [nwsAvailable, ga511Available].filter(Boolean).length;
    const sourceConfidence = liveSourceCount >= 2 ? 'high' : liveSourceCount === 1 ? 'medium' : 'low';

    const rawPortScore   = portSignalFile?.port_score;
    const portScoreValid = typeof rawPortScore === 'number' && isFinite(rawPortScore)
      && rawPortScore >= 0 && rawPortScore <= 1;
    const portScore    = portScoreValid ? rawPortScore : PORT_SIGNAL.score;
    const portFallback = !portScoreValid;

    const portUpdatedAt = portSignalFile?.updated_at ?? null;
    let portAgeHours = null;
    let portStale    = true;
    if (portUpdatedAt) {
      const ms = Date.now() - new Date(portUpdatedAt).getTime();
      if (isFinite(ms) && ms >= 0) {
        portAgeHours = parseFloat((ms / 3_600_000).toFixed(2));
        portStale    = portAgeHours > 168;
      }
    }

    const stressScoreRaw = (0.45 * weatherScore) + (0.35 * trafficScore) + (0.20 * portScore);
    const stressScore = parseFloat(Math.max(0, Math.min(1, stressScoreRaw)).toFixed(4));
    const regime = deriveRegime(stressScore);
    const stressContributions = {
      weather: parseFloat((0.45 * weatherScore).toFixed(4)),
      traffic: parseFloat((0.35 * trafficScore).toFixed(4)),
      port:    parseFloat((0.20 * portScore).toFixed(4))
    };

    // ── Stockout estimates ────────────────────────────────────────────────────
    const curve = MODEL[regime]?.[scenario] || MODEL.normal.baseline;
    const dayIndex = DAYS.indexOf(selectedDays);
    const [stockoutProb, ciLow, ciHigh] = curve[dayIndex] || [0.038, 0.030, 0.046];

    const minFeasible = getMinFeasible(regime, scenario);
    const recommendedDays = minFeasible; // recommended = minimum that meets 2% target
    const meetsTarget = stockoutProb <= SERVICE_TARGET;
    const coverageMargin = minFeasible !== null ? selectedDays - minFeasible : null;

    // Expected shortage (simplified linear model)
    const expectedShortage = parseFloat((stockoutProb * 8.0).toFixed(3));

    // Policy cost index (holding + shortage exposure)
    const holdingIndex = selectedDays * 0.80;
    const shortageIndex = expectedShortage * 18;
    const policyCostIndex = parseFloat((holdingIndex + shortageIndex).toFixed(2));

    const takeaway = buildTakeaway(regime, scenario, selectedDays, minFeasible, meetsTarget, coverageMargin);

    const recBasis = `Phase 0 illustrative model: regime "${regime}", scenario "${scenario}", ${liveSourceCount} live public signal source(s). No GPA operational or demand data ingested.`;
    const recConfidence = liveSourceCount >= 2 ? 'low' : liveSourceCount === 1 ? 'very_low' : 'minimal';
    const recStability  = minFeasible === null
      ? 'target_unreachable_in_range'
      : meetsTarget ? 'meets_estimated_target' : 'below_estimated_target';
    const recNextStep = 'Validate against GPA throughput records, actual demand history, and port-specific lead-time distributions before any operational or planning use.';

    // ── Build payload ─────────────────────────────────────────────────────────
    const payload = {
      timestamp:              new Date().toISOString(),
      regime,
      stress_score:           stressScore,
      scenario,
      selected_days_of_cover: selectedDays,
      recommended_days:       recommendedDays,
      minimum_feasible_days:  minFeasible,

      // DECIMAL probabilities (NOT percent — frontend multiplies ×100)
      stockout_probability:   parseFloat(stockoutProb.toFixed(4)),
      stockout_ci_low:        parseFloat(ciLow.toFixed(4)),
      stockout_ci_high:       parseFloat(ciHigh.toFixed(4)),

      expected_shortage:      expectedShortage,
      policy_cost_index:      policyCostIndex,
      coverage_margin:        coverageMargin,
      operational_takeaway:   takeaway,

      recommendation_basis:       recBasis,
      recommendation_confidence:  recConfidence,
      recommendation_stability:   recStability,
      next_validation_step:       recNextStep,

      model_metadata: {
        model_status:       'phase0_prototype',
        model_mode:         'illustrative_live_signal_overlay',
        calibration_status: 'not_calibrated_to_gpa_operations',
        data_quality:       'illustrative',
        professional_note:  'Phase 0 prototype using public weather and traffic signals, an updateable public/manual port proxy from data/port_signal.json, and precomputed stockout-risk curves. Not calibrated to Georgia Ports Authority operational data, actual throughput, or GPA-specific demand patterns. All outputs are illustrative estimates and should be reviewed with qualified operational context before any planning or decision use.'
      },

      source_summary: {
        weather_alert_count:    nwsAlertCount,
        weather_score:          parseFloat(weatherScore.toFixed(4)),
        traffic_event_count:    trafficEventCount,
        traffic_score:          parseFloat(trafficScore.toFixed(4)),
        baseline_port_score:    portScore,
        traffic_source_enabled: trafficResult.enabled,
        sources_used:           sourcesUsed,
        source_failures:        sourceFailures,

        stress_formula_weights:  { weather: 0.45, traffic: 0.35, port: 0.20 },
        stress_contributions:    stressContributions,
        stress_score_raw:        parseFloat(stressScoreRaw.toFixed(4)),
        stress_score_capped:     stressScore,
        port_signal_mode:        portSignalFile?.mode        ?? PORT_SIGNAL.mode,
        port_signal_explanation: portSignalFile?.limitations  ?? PORT_SIGNAL.explanation,

        nws_available:           nwsAvailable,
        ga511_available:         ga511Available,
        live_source_count:       liveSourceCount,
        source_confidence:       sourceConfidence,

        port_signal_details: {
          updated_at:          portUpdatedAt,
          mode:                portSignalFile?.mode        ?? PORT_SIGNAL.mode,
          confidence:          portSignalFile?.confidence  ?? 'unknown',
          components:          portSignalFile?.components  ?? null,
          source_notes:        portSignalFile?.source_notes ?? [],
          limitations:         portSignalFile?.limitations  ?? PORT_SIGNAL.explanation,
          loaded_from_file:    portSignalFile !== null,
          fallback_used:       portFallback,
          port_signal_age_hours: portAgeHours,
          port_signal_stale:   portStale
        },

        data_freshness: {
          nws:           nwsAvailable    ? 'live' : 'unavailable',
          ga511:         ga511Available  ? 'live' : 'unavailable',
          port_signal:   'manual_or_public_proxy',
          model_outputs: 'precomputed_static_curves'
        }
      },

      validation_status:    validationFile ?? VALIDATION_FALLBACK,

      operational_readiness: {
        current_level:         'operational_grade_prototype',
        production_ready:      false,
        missing_for_production: [
          'direct GPA operational data feed',
          'historical backtesting',
          'demand and lead-time calibration',
          'versioned simulation engine'
        ]
      }
    };

    return res.status(200).json(payload);
  } catch (err) {
    console.error('[api/latest] handler error:', err);
    return res.status(500).json({ error: 'Internal server error', detail: err.message });
  }
}
