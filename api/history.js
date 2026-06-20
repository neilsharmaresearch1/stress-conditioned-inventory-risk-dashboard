/**
 * /api/history -- Historical snapshot time series
 *
 * GET /api/history?from=ISO&to=ISO
 *
 * Returns a time series of lane stress snapshots in the format the
 * existing dashboard frontend expects (points array with date, stress_score,
 * regime, contributions, stockout_probability, recommended_days, etc.)
 *
 * Data source priority:
 *   1. Vercel KV (live snapshots written by /api/snapshot)
 *   2. Static data/history.json file (prototype sample data)
 *
 * When KV has data, the static file is ignored.
 * When KV is empty or not configured, the static file is returned and
 * clearly labeled as prototype/sample data.
 *
 * Query params:
 *   from    ISO 8601 start timestamp (default: 7 days ago)
 *   to      ISO 8601 end timestamp (default: now)
 */

import { readFile } from 'fs/promises';
import { join }     from 'path';

import { getSnapshotsInRange } from '../lib/kv.js';
import { DAYS, SERVICE_TARGET } from '../lib/model.js';

const DEFAULT_RANGE_DAYS = 7;
const MAX_POINTS = 168; // cap at 7 days at hourly cadence

const STATIC_FALLBACK = {
  status:      'unavailable',
  updated_at:  null,
  limitations: 'History file not available.',
  points:      []
};

// ── Snapshot -> frontend history point conversion ─────────────────────────────

function getMinFeasibleFromPStockout(pStockoutBaseline) {
  if (!pStockoutBaseline) return null;
  for (const d of DAYS) {
    const entry = pStockoutBaseline[d];
    if (entry && entry.p <= SERVICE_TARGET) return d;
  }
  return null;
}

function feedHealthToConfidence(feedHealth) {
  if (!feedHealth) return 'low';
  const statuses = Object.values(feedHealth);
  const okCount  = statuses.filter(s => s === 'ok').length;
  if (okCount === statuses.length) return 'high';
  if (okCount >= 1)               return 'medium';
  return 'low';
}

function snapshotToPoint(snap) {
  const baseline3 = snap.pStockout?.baseline?.[3];
  const minFeasible = getMinFeasibleFromPStockout(snap.pStockout?.baseline);

  return {
    date:                 snap.timestamp.substring(0, 10),
    timestamp:            snap.timestamp,
    stress_score:         snap.stressIndex,
    regime:               snap.regime,
    weather_contribution: snap.stressContributions?.weather ?? 0,
    traffic_contribution: snap.stressContributions?.traffic ?? 0,
    port_contribution:    snap.stressContributions?.port    ?? 0,
    stockout_probability: baseline3?.p ?? 0,
    recommended_days:     minFeasible ?? 6,
    source_confidence:    feedHealthToConfidence(snap.feedHealth),
    feed_health:          snap.feedHealth ?? null,
    // Raw inputs stored for re-derivation (academic traceability)
    raw_inputs:           snap.rawInputs ?? null
  };
}

// ── Handler ───────────────────────────────────────────────────────────────────

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Access-Control-Allow-Origin', '*');

  const reqUrl = new URL(req.url, `http://${req.headers.host}`);
  const toMs   = reqUrl.searchParams.has('to')
    ? new Date(reqUrl.searchParams.get('to')).getTime()
    : Date.now();
  const fromMs = reqUrl.searchParams.has('from')
    ? new Date(reqUrl.searchParams.get('from')).getTime()
    : toMs - DEFAULT_RANGE_DAYS * 86400000;

  if (!isFinite(fromMs) || !isFinite(toMs) || fromMs > toMs) {
    return res.status(400).json({ error: 'Invalid from/to range' });
  }

  // Try KV first
  try {
    const snapshots = await getSnapshotsInRange(fromMs, toMs, MAX_POINTS);

    if (snapshots.length > 0) {
      const points = snapshots.map(snapshotToPoint).sort((a, b) => a.timestamp.localeCompare(b.timestamp));
      return res.status(200).json({
        status:      'live',
        source:      'kv',
        updated_at:  points.at(-1)?.timestamp ?? null,
        limitations: null,
        points
      });
    }
  } catch (err) {
    console.error('[api/history] KV query failed:', err.message);
  }

  // Fall back to static file
  try {
    const text    = await readFile(join(process.cwd(), 'data/history.json'), 'utf8');
    const payload = JSON.parse(text);
    // Always label the static file as sample data
    return res.status(200).json({
      ...payload,
      status:      'prototype_sample_history',
      source:      'static_file',
      limitations: (payload.limitations || '') + ' This is prototype sample data, not live captured history. Deploy /api/snapshot cron to collect real history.'
    });
  } catch (_) {
    return res.status(200).json(STATIC_FALLBACK);
  }
}
