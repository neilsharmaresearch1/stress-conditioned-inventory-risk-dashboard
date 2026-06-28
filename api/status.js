/**
 * /api/status -- System status, data sources, and research tool disclosure
 *
 * GET /api/status
 *
 * Returns a machine-readable + human-readable summary of:
 *   - Data sources and their current configuration
 *   - Snapshot capture schedule and last-captured time
 *   - Model metadata and reproducibility notes
 *   - Research tool disclosure
 *
 * Designed for the /about section of the dashboard.
 */

import { getLatestSnapshot } from '../lib/kv.js';
import { WEIGHTS }           from '../lib/constants.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET required' });

  res.setHeader('Cache-Control', 'no-store, max-age=0');
  res.setHeader('Access-Control-Allow-Origin', '*');

  const kvConfigured = !!(process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN);
  const ga511Enabled = !!process.env.GA511_API_KEY;
  const alertWebhook = !!process.env.ALERT_WEBHOOK_URL;
  const alertEmail   = !!(process.env.RESEND_API_KEY && process.env.ALERT_TO_EMAIL);
  const framingMode  = process.env.FRAMING_MODE || 'corporate';

  let latestSnapshotTs = null;
  let latestRegime     = null;
  if (kvConfigured) {
    try {
      const snap = await getLatestSnapshot();
      if (snap) { latestSnapshotTs = snap.timestamp; latestRegime = snap.regime; }
    } catch (_) {}
  }

  const payload = {
    system: 'SLRIS -- Stress-conditioned Lane Risk Intelligence System',
    lane:   'Savannah to Atlanta replenishment corridor',
    phase:  'Phase 0 research prototype',

    data_sources: [
      {
        name:         'National Weather Service (NWS)',
        role:         'Weather disruption signal (45% weight in stress index)',
        status:       'live',
        endpoint:     'api.weather.gov/alerts/active',
        counties:     'Chatham, Bryan, Bulloch, Candler, Emanuel, Laurens, Twiggs, Bibb, Fulton (GA)',
        cadence:      'Fetched on every /api/latest request and hourly /api/snapshot capture'
      },
      {
        name:    'Georgia 511 (GA DOT)',
        role:    'Road disruption signal (35% weight in stress index)',
        status:  ga511Enabled ? 'live' : 'not_configured',
        note:    ga511Enabled ? 'GA511_API_KEY is set' : 'Set GA511_API_KEY env var to enable. Without it, traffic contribution is 0 and regime is capped at Normal in live mode.'
      },
      {
        name:   'Port signal (data/port_signal.json)',
        role:   'Port baseline stress (20% weight in stress index)',
        status: 'manual_public_proxy',
        note:   'Manually updated JSON file. Not connected to GPA operational APIs. Phase 1 upgrade: replace with live GPA throughput data.'
      }
    ],

    snapshot_capture: {
      method:       'GitHub Actions cron, hourly (*/60 * * * *)',
      endpoint:     'POST /api/snapshot',
      auth:         'Bearer token (SNAPSHOT_TOKEN)',
      kv_store:     kvConfigured ? 'connected (Vercel KV)' : 'not_configured -- set KV_REST_API_URL and KV_REST_API_TOKEN',
      latest_timestamp: latestSnapshotTs,
      latest_regime:    latestRegime
    },

    alerting: {
      webhook_enabled: alertWebhook,
      email_enabled:   alertEmail,
      trigger:         'Upward regime transition only (no re-fire while elevated, daily digest after debounce)',
      note:            alertWebhook || alertEmail ? 'At least one alert channel is configured.' : 'No alert channels configured. Set ALERT_WEBHOOK_URL or RESEND_API_KEY+ALERT_TO_EMAIL.'
    },

    framing_mode: framingMode,

    model: {
      title:        'Stress Conditioned Monte Carlo Modeling of Stockout Risk on the Savannah to Atlanta Lane',
      author:       'Neil Sharma',
      paper_id:     'Paper 242',
      parameters: {
        stress_weights:    WEIGHTS,
        regime_cutoffs:    { low_to_normal: 0.30, normal_to_high: 0.60, high_to_extreme: 0.80 },
        logistic_alpha:    -2.197,
        logistic_beta:     0.811,
        sigma_sev:         1.2,
        severe_delay_cap:  '72 hours',
        simulation_trials: 50000,
        seed:              42
      },
      published_cells:     'High and Extreme stress at B=2,3,4 (all 3 scenarios): Appendix A1, Paper 242',
      illustrative_cells:  'Low, Normal (all B), and High/Extreme at B=5,6: pending full simulation export',
      directionality_pass: '94.7%',
      calibration:         'Not calibrated to GPA operational data'
    },

    reproducibility_statement: 'Every persisted snapshot stores the exact raw feed inputs (NWS alert count, traffic score, port score) used to derive its outputs. Any historical data point can be re-computed by passing its rawInputs to computeRiskState() in lib/model.js and verifying against the stored stressIndex, regime, and pStockout values. The model function is deterministic given identical inputs.',

    research_tool_disclosure: 'This is a research prototype built for academic and operational-decision research purposes. It is not a production Georgia Ports Authority system and has not been certified for operational decision-making. All outputs are illustrative estimates. Review with qualified operational context before any planning or logistics use.',

    update_cadence: {
      live_feeds:   'On every /api/latest page load',
      snapshots:    'Hourly via GitHub Actions cron',
      port_signal:  'Manual -- updated as needed in data/port_signal.json'
    }
  };

  return res.status(200).json(payload);
}
