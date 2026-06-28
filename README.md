# Stress Conditioned Inventory Risk Dashboard (SLRIS)

**Live demo:** https://stress-conditioned-inventory-risk-d.vercel.app/
**Author:** Neil Sharma
**Source paper:** Stress Conditioned Monte Carlo Modeling of Stockout Risk on the Savannah to Atlanta Lane (Paper 242)

---

## What It Does

SLRIS is a live monitoring tool for the Savannah-to-Atlanta freight replenishment lane. It ingests real disruption signals (NWS weather alerts, GA-511 traffic events, port baseline), maps them into a stress index, classifies the current operating regime, and returns model-based stockout risk estimates and inventory policy recommendations.

It also stores hourly snapshots to KV so the dashboard can show trend history, fire regime-transition alerts, and let any historical data point be re-derived from its raw inputs.

The dashboard answers: what is the trend, what is the current risk, and what should I do?

---

## Architecture

```
index.html (static frontend)
    |-- /api/latest    GET  live stress + risk estimate (page load)
    |-- /api/history   GET  time series from KV (history tab)
    |-- /api/snapshot  POST hourly capture, triggered by GitHub Actions
    |-- /api/status    GET  data sources, cadence, reproducibility

lib/model.js           pure computeRiskState() -- all regime math lives here
lib/decision.js        plain-language action output (takeaway, alert text)
lib/kv.js              Vercel KV wrapper with graceful no-KV fallback
lib/alerts.js          upward-transition alerting with debounce
lib/framing.js         corporate vs food-bank vocabulary layer

GitHub Actions          .github/workflows/snapshot.yml  hourly POST /api/snapshot

data/port_signal.json   manually updated port baseline score
data/history.json       prototype sample history (shown until KV has real data)
```

---

## Environment Variables

### Required for persistence (Tasks 1-3)

Set these in your Vercel project dashboard under Settings > Environment Variables.

| Variable | Where | Description |
|---|---|---|
| `KV_REST_API_URL` | Vercel project | Auto-set when you link a Vercel KV store |
| `KV_REST_API_TOKEN` | Vercel project | Auto-set when you link a Vercel KV store |
| `SNAPSHOT_TOKEN` | Vercel project + GitHub Actions secret | Bearer token protecting POST /api/snapshot. Generate with: `openssl rand -hex 32` |
| `DEPLOYED_URL` | GitHub Actions secret | Base URL of your Vercel deployment, no trailing slash. e.g. `https://your-deployment.vercel.app` |

### Optional (existing + new)

| Variable | Where | Description |
|---|---|---|
| `GA511_API_KEY` | Vercel project | Georgia 511 API key. Without it, traffic contribution is 0 and regime is capped at Normal in live mode. |
| `ALERT_WEBHOOK_URL` | Vercel project | POST target for regime-transition alerts (Slack incoming webhook, food-bank partner endpoint, etc.) |
| `RESEND_API_KEY` | Vercel project | Resend API key for email alerts. Requires `ALERT_TO_EMAIL`. |
| `ALERT_TO_EMAIL` | Vercel project | Recipient email address for Resend alerts. |
| `ALERT_FROM_EMAIL` | Vercel project | Sender address for Resend. Defaults to `onboarding@resend.dev` for testing. |
| `FRAMING_MODE` | Vercel project | Set to `foodbank` to use humanitarian supply vocabulary across all routes. Default: `corporate`. |

---

## Setup: Persistence (Upstash Redis via Vercel Marketplace)

Note: Vercel's built-in KV product is deprecated. Use the Upstash Redis integration from the Vercel Marketplace instead. The package (`@vercel/kv`) and env var names are unchanged.

1. Go to your Vercel project dashboard.
2. Click **Integrations** > **Browse Marketplace** and search for **Upstash Redis**.
3. Add the integration and create a free-tier Redis database linked to your project.
4. Vercel automatically injects `KV_REST_API_URL` and `KV_REST_API_TOKEN` as project env vars.
5. Generate a snapshot token: `openssl rand -hex 32` and add it as `SNAPSHOT_TOKEN` in Vercel env vars (Settings > Environment Variables).
6. Redeploy the project for the env vars to take effect.
7. Run `npm install` locally to install the client library.

---

## Setup: GitHub Actions Cron

1. Go to your GitHub repository > **Settings** > **Secrets and variables** > **Actions**.
2. Add two secrets:
   - `SNAPSHOT_TOKEN`: same value as the Vercel env var
   - `DEPLOYED_URL`: your Vercel deployment URL (canonical alias, no trailing slash: `https://stress-conditioned-inventory-risk-d.vercel.app`)
3. The workflow at `.github/workflows/snapshot.yml` will run automatically at the top of every hour.
4. You can also trigger it manually from the Actions tab for testing.

The cron uses GitHub Actions (not Vercel Cron) to avoid plan-tier frequency limits.

---

## Adding an Alert Channel

Alerts fire on upward regime transitions (risk increasing) with a 22-hour debounce to prevent re-firing while elevated.

**Webhook (Slack, food-bank partner, any HTTP endpoint):**
Set `ALERT_WEBHOOK_URL` to any URL that accepts a POST with a JSON body. The payload includes `subject`, `body`, `regime`, `previousRegime`, `timestamp`, and `stressIndex`.

**Email via Resend:**
Set `RESEND_API_KEY` + `ALERT_TO_EMAIL` + optionally `ALERT_FROM_EMAIL`. Both channels can be active simultaneously.

**Custom channel:** Add a new function to `lib/alerts.js` in the `fireAlert()` function alongside the existing webhook and email blocks.

---

## Food-Bank Mode

The same model and feeds can be presented with humanitarian supply-distribution vocabulary by setting `FRAMING_MODE=foodbank` (Vercel env var) or passing `?mode=foodbank` as a route parameter.

- Stockout becomes "distribution failure risk"
- Days of cover becomes "days of supply"
- Reorder becomes "pre-position"
- Alerts use "Supply Disruption Alert" prefix

No model code is forked. One deployment, two faces.

---

## Reproducibility Statement

Every persisted snapshot stores the exact raw feed inputs (NWS alert count, traffic score, port score) alongside its computed outputs. Any historical data point can be re-derived by:

1. Passing `snapshot.rawInputs` to `computeRiskState()` in `lib/model.js`
2. Comparing the returned `stressScore`, `regime`, and `pStockout` against the stored values

The model function is deterministic for identical inputs (no random state, no external state). All HIGH and EXTREME stockout and shortage values at B=2,3,4 in the MODEL table match Appendix A1 of Paper 242 exactly (N=50,000, seed=42). Run `npm test` to verify this against the paper's published figures.

---

## Running Tests

```bash
npm install
npm test
```

Tests in `tests/model.test.js` use Node's built-in test runner (Node 18+). They verify that `computeRiskState` returns values byte-identical to Appendix A1 of Paper 242, and that the MODEL table satisfies all structural invariants (monotone, regime ordering, safety/tail constraints).

---

## Live Signal Model

Every refresh calls `/api/latest` with selected days of cover and scenario. The backend checks live feeds, computes a stress index, classifies the regime, and returns a risk estimate. Snapshots are also captured hourly and stored to KV.

| Source | Status | Weight | Role |
|---|---|---|---|
| NWS weather alerts | Live | 45% | Weather disruption signal |
| Georgia 511 traffic | Optional (requires API key) | 35% | Road disruption signal |
| Port baseline score | Manual (data/port_signal.json) | 20% | Slower baseline stress input |

Stress index = 0.45 * weatherScore + 0.35 * trafficScore + 0.20 * portScore

Regime cutoffs: Low < 0.30, Normal < 0.60, High < 0.80, Extreme >= 0.80

---

## Policy Scenarios

| Scenario | Description |
|---|---|
| Baseline | Standard replenishment with no added mitigation |
| Safety Stock | Non-proportional coverage compression (greatest benefit at low coverage) |
| Tail Mitigation | Reduces severe delay tail outcomes (most effective at 5-6d) |

---

## Model Parameters (Paper 242)

- alpha = -2.197, beta = 0.811 (logistic severe-delay probability)
- sigma_sev = 1.2 (log-normal severe delay tail)
- Severe delay cap = 72 hours
- N = 50,000 trials, seed = 42
- Directionality pass rate: 94.7%

Published cells: High and Extreme at B=2,3,4 (Appendix A1).
Illustrative cells: Low, Normal (all B), High/Extreme at B=5,6 (pending full simulation export).

---

## Endpoints

| Endpoint | Method | Description |
|---|---|---|
| `/api/latest` | GET | Live stress + risk estimate for current moment |
| `/api/history` | GET | Snapshot time series from KV (falls back to sample data) |
| `/api/snapshot` | POST | Capture a snapshot (protected by SNAPSHOT_TOKEN) |
| `/api/status` | GET | Data sources, cadence, and reproducibility statement |

---

## Research Tool Disclosure

This is a Phase 0 research prototype. It is not a production Georgia Ports Authority system and has not been certified for operational decision-making. All outputs are illustrative estimates derived from public weather and traffic signals. Review with qualified operational context before any planning or logistics use.
