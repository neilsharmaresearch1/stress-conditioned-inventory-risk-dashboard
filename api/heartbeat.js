/**
 * /api/heartbeat -- Daily system heartbeat
 *
 * POST /api/heartbeat
 *   Protected by bearer token (SNAPSHOT_TOKEN env var).
 *   Reads the latest KV snapshot and sends a daily status email to ALERT_RECIPIENT.
 *   Called by .github/workflows/daily-heartbeat.yml at 09:00 UTC.
 *   Does not modify any KV state.
 *
 * Required env vars:
 *   SNAPSHOT_TOKEN    Same token used for /api/snapshot and /api/alert-test
 *   RESEND_API_KEY    Resend API key
 *   ALERT_RECIPIENT   Primary recipient (ALERT_TO_EMAIL as fallback)
 */

import { getLatestSnapshot }              from '../lib/kv.js';
import { fireAlert, buildHeartbeatEmail } from '../lib/alerts.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  if (req.method !== 'POST') return res.status(405).json({ error: 'POST required' });

  const expectedToken = process.env.SNAPSHOT_TOKEN;
  if (!expectedToken) return res.status(500).json({ error: 'SNAPSHOT_TOKEN env var not set' });
  const provided = (req.headers['authorization'] || '').startsWith('Bearer ')
    ? req.headers['authorization'].slice(7).trim()
    : '';
  if (provided !== expectedToken) return res.status(401).json({ error: 'Unauthorized' });

  try {
    const snapshot    = await getLatestSnapshot().catch(() => null);
    const emailPayload = buildHeartbeatEmail(snapshot);
    const result      = await fireAlert(emailPayload);

    return res.status(200).json({
      ok:           true,
      timestamp:    new Date().toISOString(),
      lastSnapshot: snapshot?.timestamp ?? null,
      mbgState:     snapshot?.mbgState  ?? null,
      fired:        result
    });
  } catch (err) {
    console.error('[api/heartbeat] error:', err);
    return res.status(500).json({ error: 'Internal server error', detail: err.message });
  }
}
