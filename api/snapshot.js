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
 *   ALERT_RECIPIENT      Primary recipient for MBG state alerts (ALERT_TO_EMAIL as fallback)
 *   ALERT_ESCALATION     Additional recipient for SUSTAINED state transitions only
 */

import { readFile } from 'fs/promises';
import { join }     from 'path';

import { computeRiskState, getMinFeasible, DAYS, VALID_SCENARIOS, SERVICE_TARGET } from '../lib/model.js';
import { buildDecisionOutput, buildAlertPayload, mbgDecision }                      from '../lib/decision.js';
import { writeSnapshot, getPreviousSnapshot, getAlertState, setAlertState,
         getMbgState, setMbgState, getMbgAlertState, setMbgAlertState }            from '../lib/kv.js';
import { checkFreshness }                                                           from '../lib/freshness.js';
import { shouldFireAlert, fireAlert, shouldFireMbgAlert, buildMbgAlertEmail }       from '../lib/alerts.js';

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
// Snapshots are stored pre-suppression. The freshness_guard field is included but
// the four suppression nulls (recommended_days, minimum_feasible_days,
// coverage_margin, operational_takeaway) are applied only by /api/latest at
// response time. Any future consumer reading KV directly must call checkFreshness()
// and apply suppression before surfacing recommendations.
function buildSnapshot(rawInputs, riskState, feedHealth, timestamp, mbgState, freshnessGuard) {
  return {
    timestamp,
    rawInputs,
    stressIndex:         riskState.stressScore,
    stressContributions: riskState.stressContributions,
    regime:              riskState.regime,
    pStockout:           riskState.pStockout,
    feedHealth,
    mbgState:            mbgState      ?? null,
    freshnessGuard:      freshnessGuard ?? null
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

    // Fetch all feeds and KV state in parallel; failures are tolerated
    const [nws, traffic, portData, prevMbgState, prevMbgAlertState] = await Promise.all([
      fetchNWSAlerts(),
      fetchGA511(),
      loadPortScore(),
      getMbgState(),
      getMbgAlertState()
    ]);

    const rawInputs = {
      nwsAlertCount:    nws.count,
      trafficEventCount: traffic.count,
      trafficScore:     traffic.score,
      portScore:        portData.score
    };

    const freshnessGuard = checkFreshness({
      nwsOk:        !nws.error,
      ga511Ok:      traffic.enabled && !traffic.error,
      ga511Enabled: traffic.enabled,
      portUpdatedAt: portData.updatedAt
    });
    const feedHealth = {
      nws:   nws.error        ? 'failed'         : 'ok',
      ga511: !traffic.enabled ? 'not_configured' : traffic.error ? 'failed' : 'ok',
      port:  freshnessGuard.port.status === 'fresh' ? 'ok' : freshnessGuard.port.status
    };

    // Core model computation
    const riskState = computeRiskState(rawInputs);

    // MBG three-state nowcast
    const mbgResult = mbgDecision(
      riskState.weatherScore, portData.score,
      prevMbgState.consecutiveElevated || 0, portData.updatedAt
    );
    // Write MBG counter; one retry with 500 ms backoff.
    // setMbgState() is internally try-catch wrapped and returns { ok, reason } without throwing,
    // but a defensive outer try-catch guards against unexpected regressions in kv.js.
    let mbgWriteResult = { ok: false, reason: 'not_attempted' };
    try {
      mbgWriteResult = await setMbgState({ consecutiveElevated: mbgResult.newConsecutiveElevated });
      if (!mbgWriteResult.ok) {
        await new Promise(r => setTimeout(r, 500));
        mbgWriteResult = await setMbgState({ consecutiveElevated: mbgResult.newConsecutiveElevated });
        if (!mbgWriteResult.ok) {
          console.error('[snapshot] mbg state write failed after retry:', mbgWriteResult.reason);
        }
      }
    } catch (err) {
      mbgWriteResult = { ok: false, reason: err.message };
      console.error('[snapshot] mbg state write threw unexpectedly:', err.message);
    }

    const snapshot = buildSnapshot(rawInputs, riskState, feedHealth, timestamp, mbgResult.state, freshnessGuard);
    if (!mbgWriteResult.ok) snapshot.mbgStateWriteError = mbgWriteResult.reason;

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

    // Update four-regime alert state in KV
    await setAlertState({
      currentRegime:    riskState.regime,
      lastFiredAt:      fire ? timestamp : (alertState?.lastFiredAt ?? null),
      lastFiredRegime:  fire ? riskState.regime : (alertState?.lastFiredRegime ?? null)
    });

    // MBG alert check
    let mbgAlertResult = null;
    const { fire: mbgFire, reason: mbgReason } = shouldFireMbgAlert(mbgResult.state, prevMbgAlertState);
    if (mbgFire) {
      const emailPayload = buildMbgAlertEmail(
        mbgResult, prevMbgAlertState?.lastKnownState ?? null,
        timestamp, timestamp, feedHealth
      );
      mbgAlertResult = await fireAlert(emailPayload);
    }
    await setMbgAlertState({
      lastKnownState: mbgResult.state,
      lastFiredState: mbgFire ? mbgResult.state : (prevMbgAlertState?.lastFiredState ?? null),
      lastFiredAt:    mbgFire ? timestamp        : (prevMbgAlertState?.lastFiredAt   ?? null)
    });

    return res.status(200).json({
      ok:           true,
      timestamp,
      regime:       riskState.regime,
      stressIndex:  riskState.stressScore,
      mbgState:     mbgResult.state,
      feedHealth,
      freshnessGuard,
      kvWrite:      writeResult,
      mbgStateWrite: mbgWriteResult,
      alertCheck:   { shouldFire: fire,    reason,    result: alertResult },
      mbgAlertCheck: { shouldFire: mbgFire, reason: mbgReason, result: mbgAlertResult }
    });

  } catch (err) {
    console.error('[api/snapshot] error:', err);
    return res.status(500).json({ error: 'Internal server error', detail: err.message });
  }
}
