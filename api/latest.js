/**
 * /api/latest -- Stress-Aware Inventory Dashboard, Phase 0 GPA-Facing Prototype
 *
 * PROTOTYPE NOTICE: This is a Phase 0 exploratory prototype for evaluation and
 * discussion purposes only. It is NOT a production Georgia Ports Authority model
 * and has NOT been calibrated to GPA operational data, actual port throughput,
 * real demand patterns, or GPA-specific parameters. All outputs are illustrative
 * estimates derived from public weather and traffic signals only. Review all
 * results with qualified operational context before any planning or decision use.
 *
 * Deployed as a Vercel serverless function at /api/latest.
 * Model computation is delegated to lib/model.js (pure function, deterministic).
 * Decision-layer language is delegated to lib/decision.js.
 *
 * Query parameters:
 *   ?days=N         integer 2-6, defaults to 3
 *   ?scenario=X     "baseline" | "safety" | "tail", defaults to "baseline"
 *   ?mode=X         "corporate" | "foodbank", defaults to env var FRAMING_MODE or "corporate"
 *
 * Payload contract (unchanged from pre-refactor):
 *   timestamp              ISO 8601 string
 *   regime                 "low" | "normal" | "high" | "extreme"
 *   stress_score           decimal 0.0-1.0
 *   scenario               "baseline" | "safety" | "tail"
 *   selected_days_of_cover integer 2-6
 *   recommended_days       integer 2-6 or null
 *   minimum_feasible_days  integer 2-6 or null
 *   stockout_probability   DECIMAL 0.0-1.0 (frontend multiplies x100 for percent)
 *   stockout_ci_low        DECIMAL 0.0-1.0
 *   stockout_ci_high       DECIMAL 0.0-1.0
 *   expected_shortage      number (demand-days of unmet demand)
 *   policy_cost_index      number
 *   coverage_margin        integer
 *   operational_takeaway   string
 *   source_summary         object
 */

import { readFile } from 'fs/promises';
import { join }     from 'path';

import {
  computeRiskState,
  getMinFeasible,
  STRESS_DATA,
  VALID_DAYS,
  VALID_SCENARIOS,
  DAYS,
  SERVICE_TARGET
} from '../lib/model.js';

import { buildTakeaway } from '../lib/decision.js';

const GA511_KEY = process.env.GA511_API_KEY || null;

// ── NWS live alert check ──────────────────────────────────────────────────────
async function fetchNWSAlerts() {
  try {
    const zones = ['GAC051','GAC029','GAC011','GAC025','GAC107','GAC175','GAC289','GAC021','GAC121'];
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
  'i-16','i-75','i-85','i-285','i-20',
  'savannah','macon','atlanta','chatham','bibb','fulton'
];

const TRAFFIC_SEVERITY_KEYWORDS = [
  'crash','accident','closure','closed','congestion','delay',
  'construction','disabled vehicle','incident','lane blocked'
];

const TRAFFIC_SEVERE_KEYWORDS = [
  'closure','closed','crash','accident','lane blocked'
];

function flattenText(value, bucket = []) {
  if (value == null) return bucket;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    bucket.push(String(value)); return bucket;
  }
  if (Array.isArray(value)) { for (const item of value) flattenText(item, bucket); return bucket; }
  if (typeof value === 'object') { for (const v of Object.values(value)) flattenText(v, bucket); }
  return bucket;
}

function extractEventArray(data) {
  if (Array.isArray(data)) return data;
  if (!data || typeof data !== 'object') return [];
  if (Array.isArray(data.events))   return data.events;
  if (Array.isArray(data.Events))   return data.Events;
  if (Array.isArray(data.features)) return data.features;
  if (Array.isArray(data.response)) return data.response;
  return [];
}

function scoreTrafficEvent(event) {
  const haystack = flattenText(event).join(' | ').toLowerCase();
  const matchesLocation = CORRIDOR_LOCATION_KEYWORDS.some(kw => haystack.includes(kw));
  const matchesSeverity = TRAFFIC_SEVERITY_KEYWORDS.some(kw => haystack.includes(kw));
  if (!matchesLocation || !matchesSeverity) return { relevant: false, increment: 0 };
  let increment = 0.08;
  if (TRAFFIC_SEVERE_KEYWORDS.some(kw => haystack.includes(kw))) increment += 0.15;
  return { relevant: true, increment };
}

async function fetchGA511TrafficEvents() {
  if (!GA511_KEY) return { enabled: false, count: 0, score: 0, error: null };
  try {
    const url = `https://511ga.org/api/v2/get/event?key=${GA511_KEY}&format=json`;
    const res = await fetch(url, { signal: AbortSignal.timeout(4000) });
    if (!res.ok) return { enabled: true, count: 0, score: 0, error: 'ga511_http_' + res.status };
    const data = await res.json();
    const rawEvents = extractEventArray(data);
    let relevantCount = 0, totalScore = 0;
    for (const event of rawEvents) {
      const result = scoreTrafficEvent(event);
      if (result.relevant) { relevantCount += 1; totalScore += result.increment; }
    }
    return { enabled: true, count: relevantCount, score: Math.min(totalScore, 0.85), error: null };
  } catch (e) {
    return { enabled: true, count: 0, score: 0, error: 'ga511_fetch_failed' };
  }
}

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

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-store, max-age=0');

  try {
    // Parse query params
    const reqUrl = new URL(req.url, `http://${req.headers.host}`);
    const rawDays = parseInt(reqUrl.searchParams.get('days') ?? '3', 10);
    const selectedDays = VALID_DAYS.includes(rawDays) ? rawDays : 3;
    const rawScenario  = reqUrl.searchParams.get('scenario') ?? 'baseline';
    const scenario     = VALID_SCENARIOS.includes(rawScenario) ? rawScenario : 'baseline';

    // Live signal fetch
    const [portSignalFile, validationFile, nwsResult, trafficResult] = await Promise.all([
      loadJsonFile('data/port_signal.json', null),
      loadJsonFile('data/validation_status.json', null),
      fetchNWSAlerts(),
      fetchGA511TrafficEvents()
    ]);

    const nwsAlertCount    = nwsResult.count;
    const trafficEventCount = trafficResult.count;
    const trafficScore     = trafficResult.score;

    const sourceFailures = [];
    if (nwsResult.error)    sourceFailures.push(nwsResult.error);
    if (trafficResult.error) sourceFailures.push(trafficResult.error);
    if (!trafficResult.enabled) sourceFailures.push('ga511_not_configured');

    const sourcesUsed = [];
    if (!nwsResult.error) sourcesUsed.push('nws_alerts');
    if (trafficResult.enabled && !trafficResult.error) sourcesUsed.push('ga511_traffic');

    const nwsAvailable   = !nwsResult.error;
    const ga511Available = trafficResult.enabled && !trafficResult.error;
    const liveSourceCount = [nwsAvailable, ga511Available].filter(Boolean).length;
    const sourceConfidence = liveSourceCount >= 2 ? 'high' : liveSourceCount === 1 ? 'medium' : 'low';

    const rawPortScore   = portSignalFile?.port_score;
    const portScoreValid = typeof rawPortScore === 'number' && isFinite(rawPortScore)
      && rawPortScore >= 0 && rawPortScore <= 1;
    const portScore    = portScoreValid ? rawPortScore : PORT_SIGNAL.score;
    const portFallback = !portScoreValid;

    const portUpdatedAt = portSignalFile?.updated_at ?? null;
    let portAgeHours = null, portStale = true;
    if (portUpdatedAt) {
      const ms = Date.now() - new Date(portUpdatedAt).getTime();
      if (isFinite(ms) && ms >= 0) {
        portAgeHours = parseFloat((ms / 3_600_000).toFixed(2));
        portStale    = portAgeHours > 168;
      }
    }

    // ── Core model computation (delegated to lib/model.js) ───────────────────
    const riskState = computeRiskState({ nwsAlertCount, trafficScore, portScore });
    const { stressScore, stressScoreRaw, stressContributions, weatherScore, regime, pStockout } = riskState;

    // Stockout estimates for selected (scenario, days)
    const entry = pStockout[scenario]?.[selectedDays]
      || { p: 0.038, lo: 0.030, hi: 0.046, shortage: 0, shortage_lo: 0, shortage_hi: 0 };
    const stockoutProb = entry.p;
    const ciLow        = entry.lo;
    const ciHigh       = entry.hi;
    const shortageVal     = entry.shortage;
    const shortageCiLow   = entry.shortage_lo;
    const shortageCiHigh  = entry.shortage_hi;

    const minFeasible    = getMinFeasible(regime, scenario);
    const recommendedDays = minFeasible;
    const meetsTarget    = stockoutProb <= SERVICE_TARGET;
    const coverageMargin = minFeasible !== null ? selectedDays - minFeasible : null;

    const expectedShortage = parseFloat(shortageVal.toFixed(3));
    const holdingIndex     = selectedDays * 0.80;
    const shortageIndex    = expectedShortage * 18;
    const policyCostIndex  = parseFloat((holdingIndex + shortageIndex).toFixed(2));

    const takeaway = buildTakeaway(regime, scenario, selectedDays, minFeasible, meetsTarget, coverageMargin);

    const recBasis      = `Phase 0 illustrative model: regime "${regime}", scenario "${scenario}", ${liveSourceCount} live public signal source(s). No GPA operational or demand data ingested.`;
    const recConfidence = liveSourceCount >= 2 ? 'low' : liveSourceCount === 1 ? 'very_low' : 'minimal';
    const recStability  = minFeasible === null
      ? 'target_unreachable_in_range'
      : meetsTarget ? 'meets_estimated_target' : 'below_estimated_target';
    const recNextStep   = 'Validate against GPA throughput records, actual demand history, and port-specific lead-time distributions before any operational or planning use.';

    // ── Build payload (contract preserved verbatim) ───────────────────────────
    const payload = {
      timestamp:              new Date().toISOString(),
      regime,
      stress_score:           stressScore,
      scenario,
      selected_days_of_cover: selectedDays,
      recommended_days:       recommendedDays,
      minimum_feasible_days:  minFeasible,

      stockout_probability:   parseFloat(stockoutProb.toFixed(4)),
      stockout_ci_low:        parseFloat(ciLow.toFixed(4)),
      stockout_ci_high:       parseFloat(ciHigh.toFixed(4)),

      expected_shortage:         expectedShortage,
      expected_shortage_ci_low:  parseFloat(shortageCiLow.toFixed(3)),
      expected_shortage_ci_high: parseFloat(shortageCiHigh.toFixed(3)),
      policy_cost_index:         policyCostIndex,
      coverage_margin:           coverageMargin,
      operational_takeaway:      takeaway,

      recommendation_basis:      recBasis,
      recommendation_confidence: recConfidence,
      recommendation_stability:  recStability,
      next_validation_step:      recNextStep,

      model_metadata: {
        model_status:       'phase0_prototype',
        model_mode:         'illustrative_live_signal_overlay',
        calibration_status: 'not_calibrated_to_gpa_operations',
        data_quality:       'illustrative',
        professional_note:  'Phase 0 prototype using public weather and traffic signals, an updateable public/manual port proxy from data/port_signal.json, and precomputed stockout-risk curves. Not calibrated to Georgia Ports Authority operational data, actual throughput, or GPA-specific demand patterns. All outputs are illustrative estimates and should be reviewed with qualified operational context before any planning or decision use.'
      },

      data_provenance: {
        published_cells:             'high and extreme at B=2,3,4 (all 3 scenarios, stockout and shortage): Appendix A1, Paper 242, N=50000, seed=42',
        illustrative_cells:          'low and normal (all B), high and extreme at B=5,6: structurally consistent illustrative estimates, pending full simulation export',
        stockout_published_count:    18,
        stockout_illustrative_count: 42,
        shortage_published_count:    18,
        shortage_illustrative_count: 42
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

        nws_available:                  nwsAvailable,
        ga511_available:                ga511Available,
        live_source_count:              liveSourceCount,
        source_confidence:              sourceConfidence,
        regime_ceiling_without_traffic: ga511Available ? null : 'normal',
        port_signal_stale:              portStale,

        port_signal_details: {
          updated_at:              portUpdatedAt,
          mode:                    portSignalFile?.mode        ?? PORT_SIGNAL.mode,
          confidence:              portSignalFile?.confidence  ?? 'unknown',
          components:              portSignalFile?.components  ?? null,
          source_notes:            portSignalFile?.source_notes ?? [],
          limitations:             portSignalFile?.limitations  ?? PORT_SIGNAL.explanation,
          loaded_from_file:        portSignalFile !== null,
          fallback_used:           portFallback,
          port_signal_age_hours:   portAgeHours,
          port_signal_stale:       portStale
        },

        data_freshness: {
          nws:           nwsAvailable   ? 'live' : 'unavailable',
          ga511:         ga511Available ? 'live' : 'unavailable',
          port_signal:   'manual_or_public_proxy',
          model_outputs: 'precomputed_static_curves'
        }
      },

      validation_status:    validationFile ?? VALIDATION_FALLBACK,

      operational_readiness: {
        current_level:           'operational_grade_prototype',
        production_ready:        false,
        missing_for_production:  [
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
