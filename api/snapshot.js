/**
 * /api/snapshot -- Hourly snapshot capture endpoint
 *
 * POST /api/snapshot
 *   Protected by bearer token (SNAPSHOT_TOKEN env var).
 *   Fetches live feeds, calls computeRiskState, writes to KV.
 *   Runs alert check after writing.
 *
 * A single feed failure does NOT crash the capture: the snapshot is still
 * written with feedHealth indicating which feeds were degraded.
 *
 * Required env vars:
 *   SNAPSHOT_TOKEN       Secret bearer token (generate with: openssl rand -hex 32)
 *   KV_REST_API_URL      Auto-set when Vercel KV is linked
 *   KV_REST_API_TOKEN    Auto-set when Vercel KV is linked
 *
 * Optional env vars:
 *   GA511_API_KEY        Enables live traffic scoring
 *   ALERT_WEBHOOK_URL    Webhook URL for regime-transition alerts
 *   RESEND_API_KEY       Resend API key for email alerts
 *   ALERT_TO_EMAIL       Recipient email for Resend alerts
 */

import { readFile } from 'fs/promises';
import { join }     from 'path';

import { computeRiskState, getMinFeasible, DAYS, VALID_SCENARIOS, SERVICE_TARGET } from '../lib/model.js';
import { buildDecisionOutput, buildAlertPayload }                                    from '../lib/decision.js';
import { writeSnapshot, getPreviousSnapshot, getAlertState, setAlertState }         from '../lib/kv.js';
import { shouldFireAlert, fireAlert }                                                from '../lib/alerts.js';

const GA511_KEY = process.env.GA511_API_KEY || null;

// ── Feed helpers (duplicated from api/latest.js to keep routes independent) ──

async function fetchNWSAlerts() {
  try {
    const zones = ['GAC051','GAC029','GAC011','GAC025','GAC107','GAC175','GAC289','GAC021','GAC121'];
    const url = `https://api.weather.gov/alerts/active?zone=${zones.join(',')}&status=actual&message_type=alert`;
    const res = await fetch(url, {
      headers: { 'User-Agent': 'stress-inventory-dashboard/0.1 (neilsharma.research1@gmail.com)', 'Accept': 'application/geo+json' },
      signal: AbortSignal.timeout(4000)
    });
    if (!res.ok) return { count: 0, error: 'nws_http_' + res.status };
    const data = await res.json();
    const count = Array.isArray(data.features) ? data.features.length : 0;
    return { count, error: null };
  } catch (e) {
    return { count: 0, error: 'nws_timeout' };
  }
}

const CORRIDOR_KEYWORDS = ['i-16','i-75','i-85','i-285','i-20','savannah','macon','atlanta','chatham','bibb','fulton'];
const SEVERITY_KEYWORDS = ['crash','accident','closure','closed','congestion','delay','construction','disabled vehicle','incident','lane blocked'];
const SEVERE_KEYWORDS   = ['closure','closed','crash','accident','lane blocked'];

function flattenText(value, bucket = []) {
  if (value == null) return bucket;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') { bucket.push(String(value)); return bucket; }
  if (Array.isArray(value)) { for (const item of value) flattenText(item, bucket); return bucket; }
  if (typeof value === 'object') { for (const v of Object.values(value)) flattenText(v, bucket); }
  return bucket;
}

function extractEventArray(data) {
  if (Array.isArray(data)) return data;
  if (!data || typeof data !== 'object') return [];
  return data.events || data.Events || data.features || data.response || [];
}

function scoreTrafficEvent(event) {
  const h = flattenText(event).join(' | ').toLowerCase();
  if (!CORRIDOR_KEYWORDS.some(kw => h.includes(kw)) || !SEVERITY_KEYWORDS.some(kw => h.includes(kw))) return 0;
  return SEVERE_KEYWORDS.some(kw => h.includes(kw)) ? 0.23 : 0.08;
}

async function fetchGA511() {
  if (!GA511_KEY) return { enabled: false, count: 0, score: 0, error: null };
  try {
    const res = await fetch(`https://511ga.org/api/v2/get/event?key=${GA511_KEY}&format=json`, { signal: AbortSignal.timeout(4000) });
    if (!res.ok) return { enabled: true, count: 0, score: 0, error: 'ga511_http_' + res.status };
    const data = await res.json();
    const events = extractEventArray(data);
    let count = 0, total = 0;
    for (const ev of events) { const inc = scoreTrafficEvent(ev); if (inc > 0) { count++; total += inc; } }
    return { enabled: true, count, score: Math.min(total, 0.85), error: null };
  } catch (e) {
    return { enabled: true, count: 0, score: 0, error: 'ga511_fetch_failed' };
  }
}

async function loadPortScore() {
  try {
    const text = await readFile(join(process.cwd(), 'data/port_signal.json'), 'utf8');
    const data = JSON.parse(text);
    const v = data?.port_score;
    if (typeof v === 'number' && isFinite(v) && v >= 0 && v <= 1) return { score: v, updatedAt: data.updated_at || null };
  } catch (_) {}
  return { score: 0.10, updatedAt: null };
}

// ── Snapshot schema ───────────────────────────────────────────────────────────
function buildSnapshot(rawInputs, riskState, feedHealth, timestamp) {
  return {
    timestamp,
    rawInputs,
    stressIndex:         riskState.stressScore,
    stressContributions: riskState.stressContributions,
    regime:              riskState.regime,
    pStockout:           riskState.pStockout,
    feedHealth
  };
}

// ── Handler ───────────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  if (req.method !== 'POST') return res.status(405).json({ error: 'POST required' });

  // Bearer token guard
  const expectedToken = process.env.SNAPSHOT_TOKEN;
  if (!expectedToken) return res.status(500).json({ error: 'SNAPSHOT_TOKEN env var not set' });

  const authHeader = req.headers['authorization'] || '';
  const provided   = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
  if (provided !== expectedToken) return res.status(401).json({ error: 'Unauthorized' });

  try {
    const timestamp = new Date().toISOString();

    // Fetch all feeds in parallel; failures are tolerated
    const [nws, traffic, portData] = await Promise.all([
      fetchNWSAlerts(),
      fetchGA511(),
      loadPortScore()
    ]);

    const rawInputs = {
      nwsAlertCount:    nws.count,
      trafficEventCount: traffic.count,
      trafficScore:     traffic.score,
      portScore:        portData.score
    };

    const feedHealth = {
      nws:   nws.error   ? 'failed' : 'ok',
      ga511: !traffic.enabled ? 'not_configured' : traffic.error ? 'failed' : 'ok',
      port:  portData.updatedAt ? (() => {
        const ageH = (Date.now() - new Date(portData.updatedAt).getTime()) / 3_600_000;
        return ageH > 168 ? 'stale' : 'ok';
      })() : 'unknown'
    };

    // Core model computation
    const riskState = computeRiskState(rawInputs);
    const snapshot  = buildSnapshot(rawInputs, riskState, feedHealth, timestamp);

    // Write to KV
    const writeResult = await writeSnapshot(snapshot);

    // Alert check: compare to previous snapshot
    const [prevSnapshot, alertState] = await Promise.all([
      getPreviousSnapshot(),
      getAlertState()
    ]);

    let alertResult = null;
    const { fire, reason } = shouldFireAlert(riskState.regime, alertState);

    if (fire) {
      const decisionOutput = buildDecisionOutput(riskState, 3, 'baseline', SERVICE_TARGET, 'corporate');
      const alertPayload   = buildAlertPayload(snapshot, prevSnapshot, decisionOutput);
      alertResult = await fireAlert(alertPayload);
    }

    // Update alert state in KV
    await setAlertState({
      currentRegime:    riskState.regime,
      lastFiredAt:      fire ? timestamp : (alertState?.lastFiredAt ?? null),
      lastFiredRegime:  fire ? riskState.regime : (alertState?.lastFiredRegime ?? null)
    });

    return res.status(200).json({
      ok:          true,
      timestamp,
      regime:      riskState.regime,
      stressIndex: riskState.stressScore,
      feedHealth,
      kvWrite:     writeResult,
      alertCheck:  { shouldFire: fire, reason, result: alertResult }
    });

  } catch (err) {
    console.error('[api/snapshot] error:', err);
    return res.status(500).json({ error: 'Internal server error', detail: err.message });
  }
}
