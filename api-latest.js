/**
 * /api/latest
 *
 * True live-data proxy for the dashboard.
 *
 * What it does:
 * - fetches a live JSON payload from process.env.LIVE_DATA_URL
 * - validates the payload shape
 * - returns clean JSON to the dashboard
 * - returns structured errors on config/upstream/validation failure
 *
 * Required Vercel env var:
 *   LIVE_DATA_URL=https://your-live-json-endpoint.example.com/latest.json
 */

const ALLOWED_REGIMES = new Set(['low', 'normal', 'high', 'extreme']);
const ALLOWED_SCENARIOS = new Set(['baseline', 'safety', 'tail']);

const DOC_MIN = 2;
const DOC_MAX = 6;
const FETCH_TIMEOUT_MS = 8000;

function sendJson(res, status, body) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.status(status).json(body);
}

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function assertEnum(name, value, allowedSet) {
  if (typeof value !== 'string' || !allowedSet.has(value)) {
    throw new Error(
      `${name} must be one of: ${Array.from(allowedSet).join(', ')}. Received: ${JSON.stringify(value)}`
    );
  }
  return value;
}

function assertIntegerRange(name, value, min, max) {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}. Received: ${JSON.stringify(value)}`);
  }
  return value;
}

function assertNullableIntegerRange(name, value, min, max) {
  if (value === null || value === undefined) return null;
  return assertIntegerRange(name, value, min, max);
}

function assertNumberRange(name, value, min, max) {
  if (!isFiniteNumber(value) || value < min || value > max) {
    throw new Error(`${name} must be a number between ${min} and ${max}. Received: ${JSON.stringify(value)}`);
  }
  return value;
}

function assertNonNegativeNumber(name, value) {
  if (!isFiniteNumber(value) || value < 0) {
    throw new Error(`${name} must be a non-negative number. Received: ${JSON.stringify(value)}`);
  }
  return value;
}

function assertString(name, value) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${name} must be a non-empty string. Received: ${JSON.stringify(value)}`);
  }
  return value.trim();
}

function validatePayload(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('Upstream payload must be a JSON object.');
  }

  const payload = {
    timestamp:
      typeof raw.timestamp === 'string' && raw.timestamp.trim().length > 0
        ? raw.timestamp
        : new Date().toISOString(),

    regime: assertEnum('regime', raw.regime, ALLOWED_REGIMES),
    stress_score: assertNumberRange('stress_score', raw.stress_score, 0, 1),
    scenario: assertEnum('scenario', raw.scenario, ALLOWED_SCENARIOS),

    selected_days_of_cover: assertIntegerRange(
      'selected_days_of_cover',
      raw.selected_days_of_cover,
      DOC_MIN,
      DOC_MAX
    ),

    recommended_days: assertNullableIntegerRange(
      'recommended_days',
      raw.recommended_days,
      DOC_MIN,
      DOC_MAX
    ),

    minimum_feasible_days: assertNullableIntegerRange(
      'minimum_feasible_days',
      raw.minimum_feasible_days,
      DOC_MIN,
      DOC_MAX
    ),

    // Must be decimals, not percentages. Example: 0.038 = 3.8%
    stockout_probability: assertNumberRange('stockout_probability', raw.stockout_probability, 0, 1),
    stockout_ci_low: assertNumberRange('stockout_ci_low', raw.stockout_ci_low, 0, 1),
    stockout_ci_high: assertNumberRange('stockout_ci_high', raw.stockout_ci_high, 0, 1),

    expected_shortage: assertNonNegativeNumber('expected_shortage', raw.expected_shortage),
    policy_cost_index: assertNonNegativeNumber('policy_cost_index', raw.policy_cost_index),

    coverage_margin:
      Number.isInteger(raw.coverage_margin)
        ? raw.coverage_margin
        : (() => {
            throw new Error(`coverage_margin must be an integer. Received: ${JSON.stringify(raw.coverage_margin)}`);
          })(),

    operational_takeaway: assertString('operational_takeaway', raw.operational_takeaway),
  };

  if (payload.stockout_ci_low > payload.stockout_ci_high) {
    throw new Error('stockout_ci_low cannot be greater than stockout_ci_high.');
  }

  return payload;
}

async function fetchWithTimeout(url, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      cache: 'no-store',
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-store, max-age=0');

  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return sendJson(res, 405, { error: 'Method not allowed', detail: 'Use GET for /api/latest.' });
  }

  const upstreamUrl = process.env.LIVE_DATA_URL;

  if (!upstreamUrl) {
    return sendJson(res, 500, {
      error: 'Missing configuration',
      detail: 'LIVE_DATA_URL is not set.',
    });
  }

  try {
    const upstreamResponse = await fetchWithTimeout(upstreamUrl, FETCH_TIMEOUT_MS);
    const rawText = await upstreamResponse.text();

    if (!upstreamResponse.ok) {
      return sendJson(res, 502, {
        error: 'Upstream request failed',
        detail: `Upstream returned ${upstreamResponse.status} ${upstreamResponse.statusText}.`,
      });
    }

    let upstreamJson;
    try {
      upstreamJson = JSON.parse(rawText);
    } catch {
      return sendJson(res, 502, {
        error: 'Invalid upstream JSON',
        detail: 'The upstream source did not return valid JSON.',
      });
    }

    const payload = validatePayload(upstreamJson);
    return sendJson(res, 200, payload);
  } catch (error) {
    if (error.name === 'AbortError') {
      return sendJson(res, 504, {
        error: 'Upstream timeout',
        detail: `The upstream source did not respond within ${FETCH_TIMEOUT_MS}ms.`,
      });
    }

    return sendJson(res, 500, {
      error: 'Internal server error',
      detail: error.message || 'Unknown error',
    });
  }
}
