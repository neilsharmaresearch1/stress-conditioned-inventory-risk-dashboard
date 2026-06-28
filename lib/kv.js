/**
 * lib/kv.js
 *
 * Thin wrapper around @vercel/kv (Upstash Redis).
 * All functions fail gracefully when KV is not configured so the dashboard
 * continues to work without a persistence layer (just without memory).
 *
 * Required env vars (auto-set when you link a Vercel KV store):
 *   KV_REST_API_URL
 *   KV_REST_API_TOKEN
 *
 * Key scheme:
 *   snapshot:{ISO timestamp}          -- individual snapshot JSON
 *   snapshot_index                    -- sorted set, score=timestamp ms, member=key
 *   alert_state                       -- JSON object: { currentRegime, lastFiredAt, lastFiredRegime }
 *   mbg_state                         -- JSON object: { consecutiveElevated: int }
 *                                        Carries the consecutive-elevated counter for the MBG
 *                                        food-bank decision layer (lib/decision.js::mbgDecision).
 *                                        Persists across serverless invocations so state transitions
 *                                        (ELEVATED -> SUSTAINED) survive cold starts.
 */

import { kv } from '@vercel/kv';

const KV_INDEX        = 'snapshot_index';
const ALERT_STATE_KEY = 'alert_state';
const MBG_STATE_KEY   = 'mbg_state';

// Max snapshots to return in a single history query (safety cap)
const MAX_HISTORY_POINTS = 720; // 30 days at hourly cadence

function isKvConfigured() {
  return !!(process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN);
}

// ── Write ─────────────────────────────────────────────────────────────────────

/**
 * writeSnapshot(snapshot)
 *
 * Persists a snapshot to KV and registers it in the sorted index.
 * snapshot must have a valid ISO 8601 timestamp field.
 */
export async function writeSnapshot(snapshot) {
  if (!isKvConfigured()) return { ok: false, reason: 'kv_not_configured' };

  try {
    const key = `snapshot:${snapshot.timestamp}`;
    const score = new Date(snapshot.timestamp).getTime();

    await Promise.all([
      kv.set(key, snapshot),
      kv.zadd(KV_INDEX, { score, member: key })
    ]);

    return { ok: true, key };
  } catch (err) {
    console.error('[kv] writeSnapshot error:', err.message);
    return { ok: false, reason: err.message };
  }
}

// ── Read: single ──────────────────────────────────────────────────────────────

/**
 * getLatestSnapshot()
 *
 * Returns the most recent snapshot by sorted-set score, or null.
 */
export async function getLatestSnapshot() {
  if (!isKvConfigured()) return null;

  try {
    const members = await kv.zrange(KV_INDEX, -1, -1);
    if (!members || members.length === 0) return null;
    return await kv.get(members[0]);
  } catch (err) {
    console.error('[kv] getLatestSnapshot error:', err.message);
    return null;
  }
}

/**
 * getPreviousSnapshot()
 *
 * Returns the second-most-recent snapshot (for regime comparison), or null.
 */
export async function getPreviousSnapshot() {
  if (!isKvConfigured()) return null;

  try {
    const members = await kv.zrange(KV_INDEX, -2, -2);
    if (!members || members.length === 0) return null;
    return await kv.get(members[0]);
  } catch (err) {
    console.error('[kv] getPreviousSnapshot error:', err.message);
    return null;
  }
}

// ── Read: range ───────────────────────────────────────────────────────────────

/**
 * getSnapshotsInRange(fromMs, toMs, maxPoints)
 *
 * Returns snapshots between fromMs and toMs (epoch ms).
 * Downsample if the range contains more than maxPoints snapshots so the
 * payload stays manageable.
 */
export async function getSnapshotsInRange(fromMs, toMs, maxPoints = MAX_HISTORY_POINTS) {
  if (!isKvConfigured()) return [];

  try {
    const members = await kv.zrange(KV_INDEX, fromMs, toMs, { byScore: true });
    if (!members || members.length === 0) return [];

    let keys = members;
    if (keys.length > maxPoints) {
      const step = keys.length / maxPoints;
      keys = Array.from({ length: maxPoints }, (_, i) => keys[Math.floor(i * step)]);
    }

    const snapshots = await Promise.all(keys.map(k => kv.get(k)));
    return snapshots.filter(Boolean);
  } catch (err) {
    console.error('[kv] getSnapshotsInRange error:', err.message);
    return [];
  }
}

// ── Alert state ───────────────────────────────────────────────────────────────

/**
 * getAlertState()
 *
 * Returns { currentRegime, lastFiredAt, lastFiredRegime } or null.
 */
export async function getAlertState() {
  if (!isKvConfigured()) return null;

  try {
    return await kv.get(ALERT_STATE_KEY);
  } catch (err) {
    console.error('[kv] getAlertState error:', err.message);
    return null;
  }
}

/**
 * setAlertState(state)
 *
 * Persists { currentRegime, lastFiredAt, lastFiredRegime }.
 */
export async function setAlertState(state) {
  if (!isKvConfigured()) return { ok: false, reason: 'kv_not_configured' };

  try {
    await kv.set(ALERT_STATE_KEY, state);
    return { ok: true };
  } catch (err) {
    console.error('[kv] setAlertState error:', err.message);
    return { ok: false, reason: err.message };
  }
}

// ── MBG consecutive-elevated counter ─────────────────────────────────────────

/**
 * getMbgState()
 *
 * Returns { consecutiveElevated: int } from KV, or a safe default if KV is
 * not configured or the key has never been written. Never throws.
 */
export async function getMbgState() {
  if (!isKvConfigured()) return { consecutiveElevated: 0 };

  try {
    const stored = await kv.get(MBG_STATE_KEY);
    if (stored && typeof stored.consecutiveElevated === 'number') return stored;
    return { consecutiveElevated: 0 };
  } catch (err) {
    console.error('[kv] getMbgState error:', err.message);
    return { consecutiveElevated: 0 };
  }
}

/**
 * setMbgState(state)
 *
 * Persists { consecutiveElevated: int } (plus any other fields in state).
 * Called after each mbgDecision() run to carry the counter across invocations.
 */
export async function setMbgState(state) {
  if (!isKvConfigured()) return { ok: false, reason: 'kv_not_configured' };

  try {
    await kv.set(MBG_STATE_KEY, state);
    return { ok: true };
  } catch (err) {
    console.error('[kv] setMbgState error:', err.message);
    return { ok: false, reason: err.message };
  }
}

// ── MBG alert state ───────────────────────────────────────────────────────────

const MBG_ALERT_STATE_KEY = 'mbg_alert_state';

/**
 * getMbgAlertState()
 *
 * Returns { lastKnownState, lastFiredState, lastFiredAt } or null.
 * lastKnownState: MBG state at the most recent cron run (transition detection).
 * lastFiredState: MBG state when the most recent alert fired.
 * lastFiredAt:    ISO 8601 string of when the most recent alert fired.
 */
export async function getMbgAlertState() {
  if (!isKvConfigured()) return null;
  try {
    return await kv.get(MBG_ALERT_STATE_KEY);
  } catch (err) {
    console.error('[kv] getMbgAlertState error:', err.message);
    return null;
  }
}

/**
 * setMbgAlertState(state)
 *
 * Persists { lastKnownState, lastFiredState, lastFiredAt }.
 * Called after every cron snapshot regardless of whether an alert fired.
 */
export async function setMbgAlertState(state) {
  if (!isKvConfigured()) return { ok: false, reason: 'kv_not_configured' };
  try {
    await kv.set(MBG_ALERT_STATE_KEY, state);
    return { ok: true };
  } catch (err) {
    console.error('[kv] setMbgAlertState error:', err.message);
    return { ok: false, reason: err.message };
  }
}
