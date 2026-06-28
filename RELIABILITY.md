# SLRIS Reliability Architecture

This document describes the operational continuity stack for the
Savannah-Atlanta Lane Risk Intelligence System and how failures in
each subsystem are detected and resolved.

---

## Subsystems

### 1. Hourly snapshot cron

Source: .github/workflows/snapshot.yml
Frequency: every hour at minute 0 (UTC)
Function: POSTs to /api/snapshot, which fetches live feeds, computes the
risk state, writes the snapshot to KV, evaluates MBG state, and fires
transition alerts if warranted.

Single-feed failures are tolerated. The snapshot is written with feedHealth
indicating which feeds were degraded. The cron fails (exit 1) only if the
API itself returns ok=false or times out.

### 2. Dead-man's switch (healthchecks.io)

Source: HEALTHCHECK_URL GitHub Actions secret
Behavior: The snapshot workflow pings HEALTHCHECK_URL/start at the beginning
of each run and HEALTHCHECK_URL (success) at the end. If the success ping
does not arrive within the configured grace period, healthchecks.io sends
an alert to its configured recipient.

If the snapshot workflow itself never starts (GitHub outage, workflow
disabled), no ping arrives and the dead-man's switch fires.

Recommended configuration:
  Period: 1 hour (one ping expected per hour)
  Grace:  30 minutes

Setup:
  1. Create a check at healthchecks.io with Period=1h, Grace=30min.
  2. Copy the ping URL.
  3. Add it as HEALTHCHECK_URL in GitHub Actions secrets.
  The workflow picks it up automatically on the next run.
  If HEALTHCHECK_URL is not set, pings are silently skipped and the
  dead-man's switch is inactive.

### 3. Daily email heartbeat

Source: .github/workflows/daily-heartbeat.yml + /api/heartbeat
Frequency: 09:00 UTC daily
Function: Reads the latest KV snapshot and sends a formatted status email
to ALERT_RECIPIENT. Confirms that the Resend email delivery pipeline is
operational independently of MBG state transitions.

If the daily heartbeat email stops arriving, the email pipeline is broken
even if hourly snapshots are writing to KV correctly.

### 4. GitHub Actions keep-alive

Source: .github/workflows/keep-alive.yml
Frequency: 10:00 UTC on the 1st of each month
Function: Creates an empty git commit tagged [skip ci] so the repository
shows activity. GitHub disables scheduled workflows after 60 days of repo
inactivity. This prevents snapshot.yml and daily-heartbeat.yml from being
silently disabled.

---

## Alert routing

| Event | Channel | Recipient |
|---|---|---|
| MBG state transition (any) | Resend email | ALERT_RECIPIENT |
| SUSTAINED state (escalation) | Resend email | ALERT_RECIPIENT + ALERT_ESCALATION |
| Cron missed or failed | healthchecks.io | Configured in healthchecks.io dashboard |
| Daily system status | Resend email | ALERT_RECIPIENT |

---

## Failure modes and response

| Failure | Detection | Response |
|---|---|---|
| Live feed degraded (NWS, GA511, or port) | feedHealth in snapshot response | Model continues on remaining feeds. Manual review if port degrades. |
| /api/snapshot returns ok=false | Cron exits 1, GitHub failure email | Check Actions log. Check Vercel function logs. |
| Hourly cron stops firing | Dead-man's switch fires after grace period | Check GitHub Actions tab. If disabled, push any commit to re-enable. |
| Email delivery fails | fireAlert returns non-empty errors array | Check Resend dashboard. Verify RESEND_API_KEY and ALERT_RECIPIENT in Vercel. |
| KV unreachable | writeSnapshot returns ok=false in cron response | Check Upstash Redis quota and connectivity. Dashboard falls back to computed values. |
| All scheduled workflows disabled (60-day rule) | No snapshots in KV; no heartbeat emails | keep-alive.yml prevents this. If it occurs, push any commit to restore. |

---

## Environment variable checklist

### Vercel project (Settings > Environment Variables)

| Variable | Required | Description |
|---|---|---|
| SNAPSHOT_TOKEN | Yes | Bearer token for /api/snapshot, /api/alert-test, /api/heartbeat |
| KV_REST_API_URL | Yes | Auto-set by Upstash Redis integration |
| KV_REST_API_TOKEN | Yes | Auto-set by Upstash Redis integration |
| RESEND_API_KEY | Yes (alerts + heartbeat) | Resend API key |
| ALERT_RECIPIENT | Yes (alerts + heartbeat) | Primary email recipient |
| ALERT_ESCALATION | No | Additional recipient for SUSTAINED state only |
| ALERT_FROM_EMAIL | No | Sender address. Defaults to onboarding@resend.dev |
| GA511_API_KEY | No | Georgia 511 API key. Without it, traffic score is 0. |

### GitHub Actions secrets (Settings > Secrets and variables > Actions)

| Secret | Required | Description |
|---|---|---|
| SNAPSHOT_TOKEN | Yes | Same value as Vercel SNAPSHOT_TOKEN |
| DEPLOYED_URL | Yes | Canonical alias, no trailing slash: https://stress-conditioned-inventory-risk-d.vercel.app |
| HEALTHCHECK_URL | No | healthchecks.io ping URL. Dead-man's switch is inactive if not set. |

---

## Testing each subsystem

Hourly snapshot cron:
  GitHub Actions tab > snapshot.yml > Run workflow.

Dead-man's switch:
  Temporarily remove HEALTHCHECK_URL secret, let a run complete (no success
  ping sent), then restore it. Healthchecks.io should alert after the grace period.

Email alerting:
  POST /api/alert-test with SNAPSHOT_TOKEN bearer token.
  Expect resend_email in fired.sent.

Daily heartbeat:
  POST /api/heartbeat with SNAPSHOT_TOKEN bearer token.
  Expect ok=true and email in ALERT_RECIPIENT inbox.

Keep-alive:
  GitHub Actions tab > keep-alive.yml > Run workflow.
  Confirm an empty commit appears in git log.
