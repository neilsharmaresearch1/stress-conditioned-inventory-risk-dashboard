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
  const resendKey   = process.env.RESEND_API_KEY;
  const toEmail     = process.env.ALERT_TO_EMAIL;
  const fromEmail   = process.env.ALERT_FROM_EMAIL || 'onboarding@resend.dev';
  if (resendKey && toEmail) {
    try {
      const emailBody = {
        from:    fromEmail,
        to:      [toEmail],
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
