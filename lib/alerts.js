/**
 * lib/alerts.js
 *
 * Upward regime-transition alerting with debounce.
 *
 * Rules:
 *   1. Alert fires ONLY when regime crosses upward (risk increasing).
 *   2. No re-fire for the same regime level while still elevated (debounce).
 *   3. After debounce, a "still elevated" digest can be sent at most once per day.
 *
 * Alert channels (pluggable):
 *   - Webhook: POST to ALERT_WEBHOOK_URL with JSON payload
 *   - Resend email: requires RESEND_API_KEY + ALERT_TO_EMAIL
 *   Set whichever env vars you want; both can be active simultaneously.
 *
 * Env vars:
 *   ALERT_WEBHOOK_URL    URL to POST alert JSON to (Slack, partner endpoint, etc.)
 *   RESEND_API_KEY       Resend API key for email delivery
 *   ALERT_TO_EMAIL       Recipient email address for Resend alerts
 *   ALERT_FROM_EMAIL     Sender email (defaults to onboarding@resend.dev for testing)
 */

const REGIME_LEVEL = { low: 0, normal: 1, high: 2, extreme: 3 };

// Debounce: do not re-fire the same regime alert within this many ms
const DEBOUNCE_MS = 22 * 60 * 60 * 1000; // 22 hours -- fires at most once per day per regime level

/**
 * shouldFireAlert(newRegime, prevAlertState)
 *
 * Returns { fire: bool, reason: string }.
 * prevAlertState: { currentRegime, lastFiredAt, lastFiredRegime } from KV, or null.
 */
export function shouldFireAlert(newRegime, prevAlertState) {
  const newLevel  = REGIME_LEVEL[newRegime] ?? 0;
  const prevLevel = REGIME_LEVEL[prevAlertState?.currentRegime ?? 'low'] ?? 0;
  const lastFiredRegime = prevAlertState?.lastFiredRegime ?? null;
  const lastFiredAt     = prevAlertState?.lastFiredAt ? new Date(prevAlertState.lastFiredAt).getTime() : 0;
  const now = Date.now();

  // Regime crossed upward
  if (newLevel > prevLevel) {
    return { fire: true, reason: 'upward_transition' };
  }

  // Same elevated regime, but debounce window has passed: send daily digest
  if (newLevel > REGIME_LEVEL.normal && newLevel === REGIME_LEVEL[lastFiredRegime]) {
    if ((now - lastFiredAt) > DEBOUNCE_MS) {
      return { fire: true, reason: 'still_elevated_digest' };
    }
  }

  return { fire: false, reason: 'debounced_or_no_transition' };
}

/**
 * fireAlert(payload)
 *
 * Sends the alert through all configured channels.
 * Returns { sent: string[], errors: string[] }.
 */
export async function fireAlert(payload) {
  const sent   = [];
  const errors = [];

  // Channel 1: Generic webhook (Slack, food-bank partner, custom)
  const webhookUrl = process.env.ALERT_WEBHOOK_URL;
  if (webhookUrl) {
    try {
      const res = await fetch(webhookUrl, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify(payload),
        signal:  AbortSignal.timeout(5000)
      });
      if (res.ok) {
        sent.push('webhook');
      } else {
        errors.push(`webhook_http_${res.status}`);
      }
    } catch (err) {
      errors.push(`webhook_error: ${err.message}`);
    }
  }

  // Channel 2: Resend email
  const resendKey  = process.env.RESEND_API_KEY;
  const toEmail    = process.env.ALERT_RECIPIENT || process.env.ALERT_TO_EMAIL;
  const escalation = process.env.ALERT_ESCALATION;
  const fromEmail  = process.env.ALERT_FROM_EMAIL || 'onboarding@resend.dev';
  if (resendKey && toEmail) {
    try {
      const emailBody = {
        from:    fromEmail,
        to:      payload.escalate && escalation ? [toEmail, escalation] : [toEmail],
        subject: payload.subject || 'SLRIS Lane Stress Alert',
        text:    payload.body    || JSON.stringify(payload, null, 2)
      };
      const res = await fetch('https://api.resend.com/emails', {
        method:  'POST',
        headers: {
          'Content-Type':  'application/json',
          'Authorization': `Bearer ${resendKey}`
        },
        body:   JSON.stringify(emailBody),
        signal: AbortSignal.timeout(8000)
      });
      if (res.ok) {
        sent.push('resend_email');
      } else {
        const detail = await res.text().catch(() => '');
        errors.push(`resend_http_${res.status}: ${detail.substring(0, 80)}`);
      }
    } catch (err) {
      errors.push(`resend_error: ${err.message}`);
    }
  }

  return { sent, errors };
}

// ── MBG three-state alerting ──────────────────────────────────────────────────

const MBG_DEBOUNCE_MS = 22 * 60 * 60 * 1000; // 22 hours

/**
 * shouldFireMbgAlert(newState, prevMbgAlertState)
 *
 * Returns { fire: bool, reason: string }.
 * prevMbgAlertState: { lastKnownState, lastFiredState, lastFiredAt } from KV, or null.
 *
 * Fires on:
 *   Any MBG state change (NORMAL -> ELEVATED, ELEVATED -> SUSTAINED, recovery to NORMAL).
 *   Still-elevated daily digest after 22h when ELEVATED or SUSTAINED and state unchanged.
 *
 * Does NOT fire:
 *   First tick (prevMbgAlertState null -- no prior state in KV).
 *   Unchanged NORMAL state.
 */
export function shouldFireMbgAlert(newState, prevMbgAlertState) {
  if (!prevMbgAlertState || !prevMbgAlertState.lastKnownState) {
    return { fire: false, reason: 'no_prior_state_first_tick' };
  }

  const prevState   = prevMbgAlertState.lastKnownState;
  const lastFiredAt = prevMbgAlertState.lastFiredAt
    ? new Date(prevMbgAlertState.lastFiredAt).getTime()
    : 0;
  const now = Date.now();

  if (newState !== prevState) {
    return { fire: true, reason: 'state_transition' };
  }

  if (newState !== 'NORMAL' && (now - lastFiredAt) > MBG_DEBOUNCE_MS) {
    return { fire: true, reason: 'still_elevated_digest' };
  }

  return { fire: false, reason: 'debounced_or_no_change' };
}

/**
 * buildMbgAlertEmail(mbgDecision, prevState, timestamp, lastCronRunAt, feedHealth)
 *
 * Builds the full alert payload for an MBG state transition.
 * All Phase 2 required fields are present. No em dashes anywhere.
 *
 * mbgDecision:   output of lib/decision.js::mbgDecision()
 * prevState:     previous MBG state string (or null if unknown)
 * timestamp:     ISO 8601 string of the triggering cron run
 * lastCronRunAt: ISO 8601 string of the last successful snapshot write
 * feedHealth:    { nws, ga511, port } strings from the snapshot
 */
/**
 * buildHeartbeatEmail(snapshot)
 *
 * Builds a daily status email payload from the latest KV snapshot.
 * Not an alert -- informational only. escalate is always false.
 * snapshot may be null if KV has no data yet.
 */
export function buildHeartbeatEmail(snapshot) {
  const now = new Date().toUTCString();

  if (!snapshot) {
    return {
      subject: '[SLRIS] Daily heartbeat -- no snapshot data available',
      body: [
        `SLRIS DAILY HEARTBEAT -- Savannah-Atlanta Lane`,
        ``,
        `Issued: ${now}`,
        ``,
        `WARNING: No snapshot data found in KV. The hourly cron may not`,
        `be running or the persistence layer is not configured.`,
        ``,
        `Check the GitHub Actions log for .github/workflows/snapshot.yml.`,
        ``,
        `---`,
        `SLRIS is a congestion nowcast. It is not an acute-event forecaster and does not see your inventory or trucks.`
      ].join('\n'),
      escalate: false
    };
  }

  const lastRun  = snapshot.timestamp
    ? new Date(snapshot.timestamp).toUTCString()
    : 'unknown';
  const mbgState = snapshot.mbgState    || 'unknown';
  const regime   = snapshot.regime      || 'unknown';
  const stress   = snapshot.stressIndex != null
    ? Number(snapshot.stressIndex).toFixed(4) : 'unknown';
  const fh    = snapshot.feedHealth || {};
  const nws   = fh.nws   || 'unknown';
  const ga511 = fh.ga511 || 'unknown';
  const port  = fh.port  || 'unknown';

  const body = [
    `SLRIS DAILY HEARTBEAT -- Savannah-Atlanta Lane`,
    ``,
    `Issued:     ${now}`,
    ``,
    `CURRENT STATE:`,
    `  MBG operational state: ${mbgState}`,
    `  Four-regime stress:    ${regime}`,
    `  Stress index:          ${stress}`,
    ``,
    `FEED HEALTH:`,
    `  NWS (weather):         ${nws}`,
    `  Georgia 511 (traffic): ${ga511}`,
    `  Port signal:           ${port}`,
    ``,
    `LAST SNAPSHOT: ${lastRun}`,
    ``,
    ...(snapshot && snapshot.mbgStateWriteError
      ? [`WARNING: MBG state KV write failed at last snapshot: ${snapshot.mbgStateWriteError}`, ``]
      : []),
    `System operational. This is an automated daily status message.`,
    `No action required unless state is ELEVATED or SUSTAINED.`,
    ``,
    `---`,
    `SLRIS is a congestion nowcast. It is not an acute-event forecaster and does not see your inventory or trucks.`
  ].join('\n');

  return {
    subject:  `[SLRIS] Daily heartbeat -- ${mbgState} (Savannah-Atlanta)`,
    body,
    escalate: false
  };
}

export function buildMbgAlertEmail(mbgDecision, prevState, timestamp, lastCronRunAt, feedHealth) {
  const state       = mbgDecision.state;
  const prevLabel   = prevState || 'unknown';
  const isSustained = state === 'SUSTAINED';
  const isRecovery  = state === 'NORMAL';

  const subject = isRecovery
    ? `[SLRIS] Supply corridor recovered: NORMAL (Savannah-Atlanta)`
    : `[SLRIS] Supply corridor: ${state} (Savannah-Atlanta)`;

  const lastRunStr = lastCronRunAt
    ? new Date(lastCronRunAt).toUTCString()
    : 'Not available';

  const nwsStatus   = feedHealth?.nws   || 'unknown';
  const ga511Status = feedHealth?.ga511 || 'unknown';
  const portFresh   = mbgDecision.framingText?.dataFreshness || 'unknown';

  const body = [
    `SAVANNAH-ATLANTA LANE SUPPLY CORRIDOR ALERT`,
    ``,
    `Issued:      ${timestamp}`,
    `Transition:  ${prevLabel} -> ${state}`,
    ``,
    `STATE: ${state}`,
    `Two-signal score: ${mbgDecision.twoSignalScore != null ? mbgDecision.twoSignalScore.toFixed(4) : 'n/a'}  |  Threshold: ${mbgDecision.threshold ?? 0.0862}`,
    ``,
    `RECOMMENDED ACTION:`,
    mbgDecision.primaryAction,
    ``,
    `CONTEXT:`,
    mbgDecision.secondaryContext,
    ``,
    `DATA SCOPE:`,
    mbgDecision.framingText?.scope          || '',
    mbgDecision.framingText?.lag            || '',
    mbgDecision.framingText?.localKnowledge || '',
    ``,
    `DATA FRESHNESS:`,
    `  Last cron run:         ${lastRunStr}`,
    `  NWS (weather):         ${nwsStatus}`,
    `  Georgia 511 (traffic): ${ga511Status}`,
    `  Port signal:           ${portFresh}`,
    ``,
    `---`,
    `SLRIS is a congestion nowcast. It is not an acute-event forecaster and does not see your inventory or trucks.`
  ].join('\n');

  return { subject, body, escalate: isSustained };
}
