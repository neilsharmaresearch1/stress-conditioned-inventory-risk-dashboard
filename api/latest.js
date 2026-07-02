/**
 * /api/latest -- SLRIS: Stress-conditioned Lane Risk Intelligence System
 *
 * GET /api/latest returns the current risk state for the Savannah-to-Atlanta
 * replenishment lane. Model parameters are frozen; see backtest/VALIDATION.md.
 * Two-signal backtest validated at ROC AUC 0.9055 on 1,795 days (Aug 2017 to Jun 2022).
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
import { WEIGHTS } from '../lib/constants.js';

import { buildTakeaway, computeTwoSignalScore, mbgDecision, mbgActionsForState } from '../lib/decision.js';
import { getMbgState, getLatestSnapshot } from '../lib/kv.js';
import { checkFreshness } from '../lib/freshness.js';

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

    // Live signal fetch (includes MBG counter read in parallel)
    const [portSignalFile, validationFile, nwsResult, trafficResult, prevMbgState, latestSnapshot] = await Promise.all([
      loadJsonFile('data/port_signal.json', null),
      loadJsonFile('data/validation_status.json', null),
      fetchNWSAlerts(),
      fetchGA511TrafficEvents(),
      getMbgState(),
      getLatestSnapshot()
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

    const portUpdatedAt  = portSignalFile?.updated_at ?? null;
    const freshnessGuard = checkFreshness({
      nwsOk:        !nwsResult.error,
      ga511Ok:      trafficResult.enabled && !trafficResult.error,
      ga511Enabled: trafficResult.enabled,
      portUpdatedAt
    });
    const portAgeHours = freshnessGuard.port.ageHours;
    const portStale    = freshnessGuard.port.status === 'stale' || freshnessGuard.port.status === 'expired';

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

    // ── MBG food-bank decision layer ─────────────────────────────────────────
    // Thresholds the two-signal score (weather + port, traffic excluded) to match
    // the exact quantity validated in backtest/validate_model.py. See the
    // accuracy constraint comment in lib/decision.js::computeTwoSignalScore().
    const mbgResult = mbgDecision(
      weatherScore,
      portScore,
      prevMbgState.consecutiveElevated || 0,
      portUpdatedAt
    );
    // Read-only: /api/latest does not write MBG state. Only /api/snapshot (cron) advances the counter.
    // State and actions come from the last KV snapshot; twoSignalScore is computed live.
    const kvMbgState   = latestSnapshot?.mbgState ?? mbgResult.state;
    const kvMbgActions = mbgActionsForState(kvMbgState);

    const takeaway = buildTakeaway(regime, scenario, selectedDays, minFeasible, meetsTarget, coverageMargin);

    const recBasis      = `Regime "${regime}", scenario "${scenario}", ${liveSourceCount} live public signal source(s). Two-signal backtest validated (ROC AUC 0.9055, PR AUC 0.5913). See backtest/VALIDATION.md.`;
    const recConfidence = liveSourceCount >= 2 ? 'low' : liveSourceCount === 1 ? 'very_low' : 'minimal';
    const recStability  = minFeasible === null
      ? 'target_unreachable_in_range'
      : meetsTarget ? 'meets_estimated_target' : 'below_estimated_target';
    const recNextStep   = 'Validate against GPA throughput records, actual demand history, and port-specific lead-time distributions before any operational or planning use.';

    // Suppress actionable recommendation when any source has exceeded its maximum age.
    // Stockout estimates are still returned. The four actionable fields are set to null
    // and operational_takeaway is replaced with a plain-language explanation.
    const suppressRec     = !freshnessGuard.systemOk;
    const suppressionNote = suppressRec
      ? (freshnessGuard.warning === 'port_signal_expired'
          ? 'Recommendation suppressed. Port signal has not been updated in more than 7 days. Refresh data/port_signal.json before using this output for planning.'
          : 'Recommendation suppressed. One or more live data feeds failed on this request. Check feed health in the Data Health section and retry.')
      : null;

    // ── Build payload (contract preserved verbatim) ───────────────────────────
    const payload = {
      timestamp:              new Date().toISOString(),
      regime,
      stress_score:           stressScore,
      scenario,
      selected_days_of_cover: selectedDays,
      recommended_days:       suppressRec ? null : recommendedDays,
      minimum_feasible_days:  suppressRec ? null : minFeasible,

      stockout_probability:   parseFloat(stockoutProb.toFixed(4)),
      stockout_ci_low:        parseFloat(ciLow.toFixed(4)),
      stockout_ci_high:       parseFloat(ciHigh.toFixed(4)),

      expected_shortage:         expectedShortage,
      expected_shortage_ci_low:  parseFloat(shortageCiLow.toFixed(3)),
      expected_shortage_ci_high: parseFloat(shortageCiHigh.toFixed(3)),
      policy_cost_index:         policyCostIndex,
      coverage_margin:           suppressRec ? null : coverageMargin,
      operational_takeaway:      suppressionNote ?? takeaway,
      recommendation_suppressed: suppressRec,
      suppression_reason:        suppressRec ? (freshnessGuard.warning ?? null) : null,

      recommendation_basis:      recBasis,
      recommendation_confidence: recConfidence,
      recommendation_stability:  recStability,
      next_validation_step:      recNextStep,

      model_metadata: {
        model_status:       'validated_pilot',
        model_mode:         'live_signal',
        calibration_status: 'two_signal_backtest_validated',
        data_quality:       'live_public_signals_plus_port_proxy',
        professional_note:  'Live public weather and traffic signals plus a public/manual port proxy. Two-signal backtest validated at ROC AUC 0.9055 on 1,795 days. All outputs are model estimates. Review with operational context before acting.'
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

        stress_formula_weights:  WEIGHTS,
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
          nws:           freshnessGuard.nws.status,
          ga511:         freshnessGuard.ga511.status,
          port_signal:   freshnessGuard.port.status,
          model_outputs: 'precomputed_static_curves'
        }
      },

      validation_status:    validationFile ?? VALIDATION_FALLBACK,

      freshness_guard: freshnessGuard,

      operational_readiness: {
        current_level:           'pilot',
        production_ready:        false,
        missing_for_production:  [
          'direct GPA operational data feed',
          'demand and lead-time calibration with real throughput data',
          'versioned simulation engine'
        ]
      },

      last_cron_run_at: latestSnapshot?.timestamp ?? null,

      // MBG food-bank nowcast decision (threshold on two-signal score only)
      // See lib/decision.js::mbgDecision() and backtest/VALIDATION.md Section 4
      mbg_decision: {
        state:                  kvMbgState,
        primaryAction:          kvMbgActions.primaryAction,
        secondaryContext:       kvMbgActions.secondaryContext,
        framingText:            mbgResult.framingText,
        twoSignalScore:         mbgResult.twoSignalScore,
        consecutiveElevated:    prevMbgState.consecutiveElevated,
        threshold:              mbgResult.threshold,
        sustainedN:             mbgResult.sustainedN,
        sustainedNote:          mbgResult.sustainedNote,
        portDataUpdatedAt:      portUpdatedAt,
      }
    };

    return res.status(200).json(payload);
  } catch (err) {
    console.error('[api/latest] handler error:', err);
    return res.status(500).json({ error: 'Internal server error', detail: err.message });
  }
}
