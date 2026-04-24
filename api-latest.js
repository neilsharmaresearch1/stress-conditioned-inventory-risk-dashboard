import fs from 'fs/promises';
import path from 'path';

const ALLOWED_REGIMES = new Set(['low', 'normal', 'high', 'extreme']);
const ALLOWED_SCENARIOS = new Set(['baseline', 'safety', 'tail']);
const DOC_MIN = 2;
const DOC_MAX = 6;

function sendJson(res, status, body) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  res.status(status).json(body);
}

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function assertEnum(name, value, allowedSet) {
  if (typeof value !== 'string' || !allowedSet.has(value)) {
    throw new Error(`${name} must be one of: ${Array.from(allowedSet).join(', ')}`);
  }
  return value;
}

function assertIntegerRange(name, value, min, max) {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  }
  return value;
}

function assertNullableIntegerRange(name, value, min, max) {
  if (value === null || value === undefined) return null;
  return assertIntegerRange(name, value, min, max);
}

function assertNumberRange(name, value, min, max) {
  if (!isFiniteNumber(value) || value < min || value > max) {
    throw new Error(`${name} must be a number between ${min} and ${max}`);
  }
  return value;
}

function assertNonNegativeNumber(name, value) {
  if (!isFiniteNumber(value) || value < 0) {
    throw new Error(`${name} must be a non-negative number`);
  }
  return value;
}

function assertString(name, value) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${name} must be a non-empty string`);
  }
  return value.trim();
}

function validatePayload(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('Payload must be a JSON object');
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

    stockout_probability: assertNumberRange('stockout_probability', raw.stockout_probability, 0, 1),
    stockout_ci_low: assertNumberRange('stockout_ci_low', raw.stockout_ci_low, 0, 1),
    stockout_ci_high: assertNumberRange('stockout_ci_high', raw.stockout_ci_high, 0, 1),

    expected_shortage: assertNonNegativeNumber('expected_shortage', raw.expected_shortage),
    policy_cost_index: assertNonNegativeNumber('policy_cost_index', raw.policy_cost_index),

    coverage_margin: Number.isInteger(raw.coverage_margin)
      ? raw.coverage_margin
      : (() => {
          throw new Error('coverage_margin must be an integer');
        })(),

    operational_takeaway: assertString('operational_takeaway', raw.operational_takeaway),
  };

  if (payload.stockout_ci_low > payload.stockout_ci_high) {
    throw new Error('stockout_ci_low cannot be greater than stockout_ci_high');
  }

  return payload;
}

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return sendJson(res, 405, {
      error: 'Method not allowed',
      detail: 'Use GET for /api/latest.'
    });
  }

  res.setHeader('Access-Control-Allow-Origin', '*');

  try {
    const filePath = path.join(process.cwd(), 'data', 'latest.json');
    const rawText = await fs.readFile(filePath, 'utf8');
    const rawJson = JSON.parse(rawText);
    const payload = validatePayload(rawJson);

    return sendJson(res, 200, payload);
  } catch (error) {
    return sendJson(res, 500, {
      error: 'Internal server error',
      detail: error.message || 'Unknown error'
    });
  }
}
