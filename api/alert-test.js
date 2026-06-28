/**
 * /api/alert-test -- MBG alert integration test
 *
 * POST /api/alert-test
 *   Protected by the same SNAPSHOT_TOKEN bearer auth.
 *   Fires a real email with state "ELEVATED (TEST)" so the alerting pipeline
 *   can be verified without waiting for a real signal transition.
 *   Does NOT write to KV or modify any persistent state.
 *
 * Required env vars:
 *   SNAPSHOT_TOKEN    Same token used to trigger /api/snapshot
 *   RESEND_API_KEY    Resend API key
 *   ALERT_RECIPIENT   Primary recipient email (or ALERT_TO_EMAIL as fallback)
 */

import { fireAlert, buildMbgAlertEmail } from '../lib/alerts.js';
import { getLatestSnapshot }             from '../lib/kv.js';

const TEST_MBG_DECISION = {
  state:            'ELEVATED (TEST)',
  twoSignalScore:   0.0950,
  threshold:        0.0862,
  primaryAction:    'TEST ALERT: Upstream port congestion detected. Add a modest buffer to your next ACFB order while supply is still normal. (This is a test -- no real transition occurred.)',
  secondaryContext: 'This is a system integration test fired from /api/alert-test. No real signal change occurred. Disregard for operational purposes.',
  framingText: {
    scope:          'This tool detects sustained supply-chain congestion on the Savannah-Atlanta corridor. It does not predict sudden disruptions such as hurricanes or accidents.',
    lag:            'This signal reflects upstream congestion, which reaches shelves with a delay of several weeks.',
    localKnowledge: 'This tool does not see your current inventory.',
    dataFreshness:  'Test alert -- live data freshness not evaluated at test time.'
  }
};

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
    const timestamp      = new Date().toISOString();
    const latestSnapshot = await getLatestSnapshot().catch(() => null);
    const lastCronRunAt  = latestSnapshot?.timestamp ?? null;

    const feedHealth = { nws: 'test_mode', ga511: 'test_mode', port: 'test_mode' };

    const emailPayload = buildMbgAlertEmail(
      TEST_MBG_DECISION,
      'NORMAL (prior state at time of test)',
      timestamp,
      lastCronRunAt,
      feedHealth
    );

    const result = await fireAlert(emailPayload);

    return res.status(200).json({
      ok:        true,
      timestamp,
      testState: TEST_MBG_DECISION.state,
      fired:     result
    });
  } catch (err) {
    console.error('[api/alert-test] error:', err);
    return res.status(500).json({ error: 'Internal server error', detail: err.message });
  }
}
