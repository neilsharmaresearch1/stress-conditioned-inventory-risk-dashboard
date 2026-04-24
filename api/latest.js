/**
 * Savannah Lane Risk Intelligence System (SLRIS)
 * /api/latest — Live Disruption Signal Ingestion + Stress-Conditioned Inventory Risk
 *
 * This endpoint ingests real operational disruption signals from the National
 * Weather Service and Georgia 511 and maps them into a stress-conditioned
 * Monte Carlo inventory risk model for the Savannah–Atlanta replenishment lane.
 *
 * It does NOT directly observe or track stockouts. It produces model-based
 * stockout risk estimates under current disruption stress using pre-calibrated
 * risk curves derived from stress-conditioned Monte Carlo simulation.
 *
 * Data sources:
 *   1. NWS Alerts API (api.weather.gov) — no key required
 *   2. Georgia 511 (GA511_API_KEY env var) — optional, graceful degradation
 *   3. Port baseline score — static value, manually updated from Georgia Ports
 *      Authority monthly TEU reports. Not a real-time signal.
 *
 * Author: Neil | SLRIS v2.2
 */

// === Scoring weights =========================================================
const WEIGHT_WEATHER = 0.50;
const WEIGHT_TRAFFIC = 0.35;
const WEIGHT_PORT    = 0.15;

// === Valid input enumerations ================================================
const VALID_DAYS      = [2, 3, 4, 5, 6];
const VALID_SCENARIOS = ["baseline", "safety", "tail"];

// === Risk target =============================================================
const TARGET_STOCKOUT_PROBABILITY = 0.02;

// === Port baseline ============================================================
// Updated manually from Georgia Ports Authority monthly TEU throughput reports.
// 0.0 = normal throughput, 1.0 = severe port disruption.
// Last manual update: 2025-Q4 — throughput near historical average.
// This is NOT a real-time signal.
const PORT_BASELINE_SCORE = 0.10;

// === Inventory risk curves ===================================================
// Structure: RISK_CURVES[regime][scenario][days_of_cover]
// Each value: [stockout_prob, ci_low, ci_high, expected_shortage_normalized]
//
// Scenarios:
//   baseline — standard replenishment, no extra buffer
//   safety   — safety stock buffer added; approx 30-40% lower stockout prob
//              vs. baseline at equivalent days of cover
//   tail     — tail-risk mitigation; expedited replenishment triggers at
//              higher thresholds; approx 50-60% lower vs. baseline
//
// Baseline curves are pre-calibrated representative outputs from the
// stress-conditioned Monte Carlo model. Replace these with the final
// published IEOM table values before citing them as paper results.
//
// Safety and tail curves are calibrated at 1-sigma and 2-sigma demand
// uncertainty bounds respectively from the same simulation output distributions.

const RISK_CURVES = {
  low: {
    baseline: {
      2: [0.181, 0.163, 0.199, 1.42],
      3: [0.072, 0.061, 0.083, 0.58],
      4: [0.024, 0.018, 0.030, 0.19],
      5: [0.009, 0.006, 0.013, 0.07],
      6: [0.003, 0.001, 0.005, 0.02],
    },
    safety: {
      2: [0.108, 0.094, 0.122, 0.87],
      3: [0.041, 0.033, 0.049, 0.33],
      4: [0.013, 0.009, 0.018, 0.10],
      5: [0.005, 0.003, 0.008, 0.04],
      6: [0.002, 0.001, 0.003, 0.01],
    },
    tail: {
      2: [0.072, 0.060, 0.084, 0.58],
      3: [0.024, 0.018, 0.031, 0.19],
      4: [0.007, 0.004, 0.011, 0.06],
      5: [0.002, 0.001, 0.004, 0.02],
      6: [0.001, 0.000, 0.002, 0.01],
    },
  },
  normal: {
    baseline: {
      2: [0.241, 0.221, 0.261, 1.89],
      3: [0.112, 0.098, 0.126, 0.87],
      4: [0.046, 0.037, 0.055, 0.35],
      5: [0.018, 0.013, 0.024, 0.14],
      6: [0.007, 0.004, 0.011, 0.05],
    },
    safety: {
      2: [0.145, 0.129, 0.161, 1.13],
      3: [0.063, 0.053, 0.074, 0.49],
      4: [0.024, 0.018, 0.031, 0.19],
      5: [0.009, 0.006, 0.013, 0.07],
      6: [0.003, 0.001, 0.005, 0.02],
    },
    tail: {
      2: [0.096, 0.082, 0.111, 0.75],
      3: [0.038, 0.030, 0.047, 0.29],
      4: [0.013, 0.009, 0.018, 0.10],
      5: [0.004, 0.002, 0.007, 0.03],
      6: [0.001, 0.000, 0.003, 0.01],
    },
  },
  high: {
    baseline: {
      2: [0.334, 0.311, 0.357, 2.63],
      3: [0.178, 0.161, 0.196, 1.38],
      4: [0.087, 0.075, 0.099, 0.67],
      5: [0.038, 0.031, 0.046, 0.29],
      6: [0.016, 0.011, 0.022, 0.12],
    },
    safety: {
      2: [0.200, 0.181, 0.219, 1.57],
      3: [0.099, 0.086, 0.112, 0.76],
      4: [0.044, 0.036, 0.053, 0.34],
      5: [0.017, 0.012, 0.023, 0.13],
      6: [0.007, 0.004, 0.011, 0.05],
    },
    tail: {
      2: [0.133, 0.117, 0.150, 1.04],
      3: [0.059, 0.049, 0.070, 0.45],
      4: [0.022, 0.016, 0.029, 0.17],
      5: [0.007, 0.004, 0.011, 0.06],
      6: [0.002, 0.001, 0.004, 0.02],
    },
  },
  extreme: {
    baseline: {
      2: [0.451, 0.425, 0.477, 3.54],
      3: [0.289, 0.268, 0.310, 2.24],
      4: [0.163, 0.147, 0.180, 1.26],
      5: [0.082, 0.071, 0.094, 0.63],
      6: [0.038, 0.030, 0.047, 0.29],
    },
    safety: {
      2: [0.271, 0.249, 0.293, 2.12],
      3: [0.159, 0.143, 0.175, 1.22],
      4: [0.081, 0.069, 0.093, 0.62],
      5: [0.036, 0.028, 0.044, 0.27],
      6: [0.015, 0.010, 0.021, 0.11],
    },
    tail: {
      2: [0.180, 0.162, 0.199, 1.41],
      3: [0.094, 0.081, 0.108, 0.72],
      4: [0.041, 0.033, 0.050, 0.32],
      5: [0.015, 0.010, 0.021, 0.11],
      6: [0.005, 0.003, 0.009, 0.04],
    },
  },
};

// === Policy cost index =======================================================
// Normalized holding + ordering cost index by days of cover.
// Safety and tail carry buffer cost premiums (~30% and ~60% over baseline).
const POLICY_COST_INDEX = {
  baseline: { 2: 2.10, 3: 3.85, 4: 6.34,  5: 9.71,  6: 14.20 },
  safety:   { 2: 2.73, 3: 5.01, 4: 8.24,  5: 12.62, 6: 18.46 },
  tail:     { 2: 3.36, 3: 6.17, 4: 10.15, 5: 15.54, 6: 22.72 },
};

// === NWS corridor zones ======================================================
const NWS_ZONES = [
  "GAZ087",  // Chatham County (Savannah)
  "GAZ075",  // Bryan County
  "GAZ076",  // Bulloch County
  "GAZ064",  // Laurens County (Dublin, I-16 midcorridor)
  "GAZ051",  // Twiggs County (I-16 midpoint)
  "GAZ052",  // Bibb County (Macon, I-75/I-16 junction)
  "GAZ035",  // Henry County (I-75 south Atlanta)
  "GAZ033",  // Clayton County (I-285/I-75)
  "GAZ020",  // Fulton County (Atlanta)
  "GAZ021",  // DeKalb County (Atlanta metro)
  "GAZ036",  // Fayette County (I-85 corridor)
];

// === NWS scoring tables ======================================================
const SEVERITY_SCORE = {
  Extreme: 1.00, Severe: 0.75, Moderate: 0.45, Minor: 0.15, Unknown: 0.10,
};
const URGENCY_SCORE = {
  Immediate: 1.00, Expected: 0.75, Future: 0.40, Past: 0.05, Unknown: 0.10,
};
const CERTAINTY_SCORE = {
  Observed: 1.00, Likely: 0.80, Possible: 0.50, Unlikely: 0.20, Unknown: 0.10,
};
const HIGH_IMPACT_EVENTS = new Set([
  "tornado warning", "tornado watch",
  "hurricane warning", "hurricane watch",
  "tropical storm warning", "tropical storm watch",
  "flash flood warning", "flash flood watch",
  "flood warning", "flood watch",
  "winter storm warning", "winter storm watch", "winter storm advisory",
  "blizzard warning", "ice storm warning", "freezing rain advisory",
  "severe thunderstorm warning",
  "high wind warning", "high wind watch",
  "dense fog advisory",
  "extreme heat warning", "heat advisory",
  "extreme cold warning", "wind chill warning",
]);

// === GA511 corridor keywords =================================================
const CORRIDOR_KEYWORDS = [
  "i-16", "i-75", "i-85", "i-285", "i-20",
  "savannah", "atlanta", "macon", "dublin",
  "chatham", "bibb", "fulton", "dekalb", "henry", "clayton",
];
const HIGH_SEVERITY_TRAFFIC = [
  "closure", "closed", "crash", "accident", "major incident",
  "lane blocked", "disabled vehicle", "major delay", "emergency", "overturned",
];
const MODERATE_SEVERITY_TRAFFIC = [
  "congestion", "delay", "slow", "construction", "roadwork",
  "reduced lanes", "incident",
];

// === Fetch helper =============================================================
const FETCH_TIMEOUT_MS = 8000;

async function fetchWithTimeout(url, options = {}) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    clearTimeout(id);
    return res;
  } catch (err) {
    clearTimeout(id);
    throw err;
  }
}

// === NWS ingestion ===========================================================
async function fetchNWSAlerts() {
  const url = "https://api.weather.gov/alerts/active?area=GA&status=actual";
  const res = await fetchWithTimeout(url, {
    headers: {
      "User-Agent": "SLRIS-InventoryRiskDashboard/2.0 (student research; contact: neilsharma.research1@gmail.com)",
      "Accept": "application/geo+json",
    },
  });
  if (!res.ok) throw new Error(`NWS HTTP ${res.status}`);
  const data = await res.json();
  return Array.isArray(data.features) ? data.features : [];
}

function scoreNWSAlerts(features) {
  const corridorAlerts = features.filter((f) => {
    const zones = f.properties?.geocode?.UGC ?? [];
    return zones.some((z) => NWS_ZONES.includes(z));
  });
  if (corridorAlerts.length === 0) return { score: 0.0, count: 0 };

  let rawScore = 0;
  for (const f of corridorAlerts) {
    const p         = f.properties ?? {};
    const sev       = SEVERITY_SCORE[p.severity]   ?? 0.10;
    const urg       = URGENCY_SCORE[p.urgency]     ?? 0.10;
    const cert      = CERTAINTY_SCORE[p.certainty] ?? 0.10;
    const eventType = (p.event ?? "").toLowerCase();
    const impact    = HIGH_IMPACT_EVENTS.has(eventType) ? 1.2 : 1.0;
    rawScore       += Math.min((sev * urg * cert) ** (1 / 3) * impact, 1.0);
  }
  return {
    score: Math.min(1 - Math.exp(-1.2 * rawScore), 1.0),
    count: corridorAlerts.length,
  };
}

// === GA511 ingestion =========================================================
async function fetchGA511Events(apiKey) {
  const url = `https://511ga.org/api/v2/get/event?key=${apiKey}&format=json`;
  const res = await fetchWithTimeout(url, { headers: { "Accept": "application/json" } });
  if (!res.ok) throw new Error(`GA511 HTTP ${res.status}`);
  const data = await res.json();
  if (Array.isArray(data)) return data;
  for (const key of ["events", "Events", "data", "features", "items"]) {
    if (Array.isArray(data[key])) return data[key];
  }
  return [];
}

function isCorridorRelevant(event) {
  const text = [
    event.description ?? "", event.headline ?? "",
    event.location    ?? "", event.road      ?? "",
    event.area        ?? "", event.region    ?? "",
    event.name        ?? "", event.title     ?? "",
    JSON.stringify(event.geography ?? ""),
  ].join(" ").toLowerCase();
  return CORRIDOR_KEYWORDS.some((kw) => text.includes(kw));
}

function scoreGA511Events(events) {
  const relevant = events.filter(isCorridorRelevant);
  if (relevant.length === 0) return { score: 0.0, count: 0 };
  let rawScore = 0;
  for (const ev of relevant) {
    const text = JSON.stringify(ev).toLowerCase();
    let w = 0.05;
    if (HIGH_SEVERITY_TRAFFIC.some((kw) => text.includes(kw)))         w = 0.35;
    else if (MODERATE_SEVERITY_TRAFFIC.some((kw) => text.includes(kw))) w = 0.18;
    rawScore += w;
  }
  return {
    score: Math.min(1 - Math.exp(-1.5 * rawScore), 1.0),
    count: relevant.length,
  };
}

// === Stress scoring ==========================================================
function computeStressScore({ weatherScore, trafficScore, trafficAvailable }) {
  if (trafficAvailable) {
    return (
      WEIGHT_WEATHER * weatherScore +
      WEIGHT_TRAFFIC * trafficScore +
      WEIGHT_PORT    * PORT_BASELINE_SCORE
    );
  }
  // Renormalize weights proportionally across remaining sources
  const wW = WEIGHT_WEATHER + WEIGHT_TRAFFIC * (WEIGHT_WEATHER / (WEIGHT_WEATHER + WEIGHT_PORT));
  const wP = WEIGHT_PORT    + WEIGHT_TRAFFIC * (WEIGHT_PORT    / (WEIGHT_WEATHER + WEIGHT_PORT));
  return wW * weatherScore + wP * PORT_BASELINE_SCORE;
}

function stressToRegime(score) {
  if (score <= 0.29) return "low";
  if (score <= 0.59) return "normal";
  if (score <= 0.79) return "high";
  return "extreme";
}

// === Inventory risk model ====================================================
function computeInventoryMetrics(regime, scenario, selectedDays) {
  const curve = RISK_CURVES[regime][scenario];

  let recommendedDays = null;
  for (const d of VALID_DAYS) {
    if (curve[d][0] <= TARGET_STOCKOUT_PROBABILITY) {
      recommendedDays = d;
      break;
    }
  }

  const [stockoutProb, ciLow, ciHigh, expectedShortage] = curve[selectedDays];
  const coverageMargin = recommendedDays !== null ? selectedDays - recommendedDays : null;

  let operationalTakeaway;
  if (recommendedDays === null) {
    operationalTakeaway =
      `No standard ${scenario} policy meets the 2% stockout risk target under ` +
      `current ${regime} stress. Escalate to emergency replenishment or demand reduction protocols.`;
  } else if (coverageMargin < 0) {
    operationalTakeaway =
      `Increase coverage to ${recommendedDays} days of cover under the ${scenario} ` +
      `scenario and current ${regime} stress. Current policy under-insures by ` +
      `${Math.abs(coverageMargin)} day(s).`;
  } else if (coverageMargin === 0) {
    operationalTakeaway =
      `Current ${selectedDays}-day ${scenario} policy meets the 2% stockout risk ` +
      `target under ${regime} stress. Monitor for regime escalation.`;
  } else {
    operationalTakeaway =
      `Current ${selectedDays}-day ${scenario} policy exceeds the minimum requirement ` +
      `by ${coverageMargin} day(s) under ${regime} stress. Cost reduction possible ` +
      `if this regime persists.`;
  }

  return {
    stockout_probability:  round4(stockoutProb),
    stockout_ci_low:       round4(ciLow),
    stockout_ci_high:      round4(ciHigh),
    expected_shortage:     round4(expectedShortage),
    minimum_feasible_days: recommendedDays,
    recommended_days:      recommendedDays,
    coverage_margin:       coverageMargin,
    policy_cost_index:     POLICY_COST_INDEX[scenario][selectedDays],
    operational_takeaway:  operationalTakeaway,
  };
}

function round4(n) {
  return Math.round(n * 10000) / 10000;
}

// === Main handler ============================================================
export default async function handler(req, res) {

  // GET-only guard
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({
      error: "Method not allowed",
      detail: "Use GET for /api/latest.",
    });
  }

  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Content-Type", "application/json");

  const GA511_KEY      = process.env.GA511_API_KEY ?? null;
  const trafficEnabled = Boolean(GA511_KEY);
  const sourceFailures = [];
  const sourcesUsed    = [];

  // Validate query params — invalid values fall back silently to defaults
  const reqUrl       = new URL(req.url, `http://${req.headers.host}`);
  const rawDays      = parseInt(reqUrl.searchParams.get("days") ?? "3", 10);
  const selectedDays = VALID_DAYS.includes(rawDays) ? rawDays : 3;
  const rawScenario  = reqUrl.searchParams.get("scenario") ?? "baseline";
  const scenario     = VALID_SCENARIOS.includes(rawScenario) ? rawScenario : "baseline";

  // 1. NWS alerts
  let weatherScore      = 0.0;
  let weatherAlertCount = 0;
  try {
    const features = await fetchNWSAlerts();
    const result   = scoreNWSAlerts(features);
    weatherScore      = result.score;
    weatherAlertCount = result.count;
    sourcesUsed.push("nws_alerts");
  } catch (err) {
    sourceFailures.push(`nws_alerts: ${err.message}`);
  }

  // 2. GA511 traffic
  let trafficScore      = 0.0;
  let trafficEventCount = 0;
  let trafficAvailable  = false;
  if (trafficEnabled) {
    try {
      const events = await fetchGA511Events(GA511_KEY);
      const result = scoreGA511Events(events);
      trafficScore      = result.score;
      trafficEventCount = result.count;
      trafficAvailable  = true;
      sourcesUsed.push("ga511_traffic");
    } catch (err) {
      sourceFailures.push(`ga511_traffic: ${err.message}`);
      // Graceful degradation to weather-only mode
    }
  }

  // Require at least one live source
  if (sourcesUsed.length === 0) {
    return res.status(503).json({
      error: "No live data sources available",
      source_failures: sourceFailures,
      timestamp: new Date().toISOString(),
    });
  }

  // 3. Composite stress
  const stressScore = Math.min(
    Math.max(computeStressScore({ weatherScore, trafficScore, trafficAvailable }), 0.0),
    1.0
  );
  const regime = stressToRegime(stressScore);

  // 4. Model-based stockout risk estimation
  const metrics = computeInventoryMetrics(regime, scenario, selectedDays);

  // 5. Response
  return res.status(200).json({
    timestamp:              new Date().toISOString(),
    regime,
    stress_score:           round4(stressScore),
    scenario,
    selected_days_of_cover: selectedDays,
    recommended_days:       metrics.recommended_days,
    minimum_feasible_days:  metrics.minimum_feasible_days,
    stockout_probability:   metrics.stockout_probability,
    stockout_ci_low:        metrics.stockout_ci_low,
    stockout_ci_high:       metrics.stockout_ci_high,
    expected_shortage:      metrics.expected_shortage,
    policy_cost_index:      metrics.policy_cost_index,
    coverage_margin:        metrics.coverage_margin,
    operational_takeaway:   metrics.operational_takeaway,
    source_summary: {
      weather_alert_count:    weatherAlertCount,
      traffic_event_count:    trafficEventCount,
      weather_score:          round4(weatherScore),
      traffic_score:          round4(trafficScore),
      baseline_port_score:    PORT_BASELINE_SCORE,
      traffic_source_enabled: trafficEnabled,
      sources_used:           sourcesUsed,
      source_failures:        sourceFailures,
    },
  });
}
