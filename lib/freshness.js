/**
 * lib/freshness.js
 *
 * Per-source data freshness assessment for SLRIS.
 * NWS and GA511 freshness reflects the current live-fetch result (ok or failed).
 * Port freshness reflects the age of data/port_signal.json against named thresholds.
 *
 * Possible status values:
 *   nws / ga511: 'live' | 'fetch_failed' | 'not_configured'
 *   port:        'fresh' | 'stale' | 'expired' | 'unknown'
 *
 * systemOk is false when any live feed failed or port is expired.
 * degraded is true when any source is sub-ideal but not yet critically failed.
 * warning is a short machine-readable code describing the worst active issue.
 */

import { PORT_STALE_HOURS, PORT_EXPIRED_HOURS } from './constants.js';

export function checkFreshness({ nwsOk, ga511Ok, ga511Enabled, portUpdatedAt }) {
  const nwsStatus = nwsOk ? 'live' : 'fetch_failed';

  const ga511Status = !ga511Enabled ? 'not_configured'
    : ga511Ok        ? 'live'
    : 'fetch_failed';

  let portStatus   = 'unknown';
  let portAgeHours = null;
  if (portUpdatedAt) {
    const ms = Date.now() - new Date(portUpdatedAt).getTime();
    if (isFinite(ms) && ms >= 0) {
      portAgeHours = parseFloat((ms / 3_600_000).toFixed(1));
      portStatus   = portAgeHours > PORT_EXPIRED_HOURS ? 'expired'
        : portAgeHours > PORT_STALE_HOURS              ? 'stale'
        : 'fresh';
    }
  }

  const liveFeedFailed = nwsStatus === 'fetch_failed'
    || (ga511Enabled && ga511Status === 'fetch_failed');
  const portExpired  = portStatus === 'expired';
  const portDegraded = portStatus === 'stale' || portExpired;

  const systemOk = !liveFeedFailed && !portExpired;
  const degraded  = liveFeedFailed || portDegraded;

  const warning = portExpired     ? 'port_signal_expired'
    : liveFeedFailed              ? 'live_feed_failed'
    : portDegraded                ? 'port_signal_stale'
    : null;

  return {
    nws:   { status: nwsStatus },
    ga511: { status: ga511Status },
    port:  { status: portStatus, ageHours: portAgeHours },
    systemOk,
    degraded,
    warning
  };
}
