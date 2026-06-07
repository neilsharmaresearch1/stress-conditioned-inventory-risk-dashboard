# -*- coding: utf-8 -*-
"""
Monte Carlo simulation framework for stockout risk on the Savannah-Atlanta lane.

Paper: Stress Conditioned Monte Carlo Modeling of Stockout Risk
       on the Savannah to Atlanta Lane (Paper 242, Neil Sharma)

Published parameters (from paper / CLAUDE.md):
  alpha          = -2.197   logistic intercept for severe-delay probability
  beta           =  0.811   logistic coefficient for stress regime R
  sigma_sev      =  1.2     LogNormal sigma for severe delay duration
  severe_cap_hrs = 72       severe delay cap in hours
  N              = 50,000   simulation trials
  seed           = 42

CALIBRATION STATUS: PARTIAL
  This script reproduces the logistic severe-delay model exactly (alpha, beta).
  The non-severe lead-time bounds, demand CV, and scenario adjustment factors
  below are approximated from model description text. They do NOT perfectly
  reproduce Appendix A1 -- the paper's full parameter table is needed to
  match all 18 published cells exactly.

  Current validation: 10/18 cells within 1.5pp. B2 and B3 baseline/tail
  cells are systematically ~2-5pp above published values, indicating the
  non-severe lead-time distribution or demand CV needs adjustment.

  DO NOT use this script's outputs to replace the published Appendix A1 cells
  in the MODEL tables. It is a calibration tool only.

To complete calibration:
  1. Obtain the paper's exact non-severe delay triangular bounds.
  2. Obtain the paper's exact demand CV per regime.
  3. Obtain the paper's exact scenario adjustment method.
  4. Re-run with updated parameters below.
  5. Verify all 18 published cells pass within 0.5pp before exporting.

Usage:
  python run_monte_carlo.py

Outputs:
  - Console: per-cell results + validation diff vs published Appendix A1
  - simulation_output.json: machine-readable results
"""

import math
import json
import random
import os

# ---- Reproducibility ---------------------------------------------------------
SEED     = 42
N_TRIALS = 50_000

# ---- Published model parameters (exact from paper) ---------------------------
ALPHA         = -2.197
BETA          =  0.811
SIGMA_SEV     =  1.2
SEVERE_CAP_H  = 72.0
SEVERE_CAP_D  = SEVERE_CAP_H / 24.0   # = 3.0 days

# ---- Parameters needing calibration (approximate) ----------------------------
# LogNormal location for severe delay: ln(median_days). Currently set to ln(1.5).
# Adjust until published B2/B3 cells match.
MU_SEV = math.log(1.5)

# Non-severe triangular bounds (days). Approximate; adjust to match published.
NON_SEVERE_MODERATE = (0.5, 2.0, 1.0)   # (low, high, mode)
NON_SEVERE_SHORT    = (0.25, 1.0, 0.5)  # (low, high, mode)

# Base demand variability CV (normal regime). Paper states CV=0.22.
BASE_CV = 0.22

# Demand stress amplifiers (on sigma). Paper: high=1.45x, extreme=2.1x.
STRESS_AMP = {
    'low':     0.75,
    'normal':  1.00,
    'high':    1.45,
    'extreme': 2.10,
}

DEMAND_MU = 1.0   # normalized daily demand units

# ---- Regime definitions ------------------------------------------------------
REGIMES = {
    'low':     -1,
    'normal':   0,
    'high':     1,
    'extreme':  2,
}

DAYS_OF_COVER = [2, 3, 4, 5, 6]
SCENARIOS     = ['baseline', 'safety', 'tail']

# ---- Published ground truth (Appendix A1, Paper 242) -------------------------
# [p_central, lo, hi] in percent
PUBLISHED = {
    ('high',    'baseline', 2): [7.21,  6.99,  7.44],
    ('high',    'baseline', 3): [0.83,  0.75,  0.91],
    ('high',    'baseline', 4): [0.08,  0.05,  0.11],
    ('high',    'safety',   2): [0.95,  0.87,  1.04],
    ('high',    'safety',   3): [0.08,  0.05,  0.11],
    ('high',    'safety',   4): [0.00,  0.00,  0.01],
    ('high',    'tail',     2): [5.55,  5.35,  5.75],
    ('high',    'tail',     3): [0.52,  0.46,  0.58],
    ('high',    'tail',     4): [0.04,  0.02,  0.06],
    ('extreme', 'baseline', 2): [12.51, 12.22, 12.80],
    ('extreme', 'baseline', 3): [1.76,  1.64,  1.88],
    ('extreme', 'baseline', 4): [0.24,  0.20,  0.28],
    ('extreme', 'safety',   2): [1.83,  1.71,  1.95],
    ('extreme', 'safety',   3): [0.24,  0.20,  0.28],
    ('extreme', 'safety',   4): [0.02,  0.01,  0.04],
    ('extreme', 'tail',     2): [9.31,  9.06,  9.56],
    ('extreme', 'tail',     3): [1.22,  1.12,  1.32],
    ('extreme', 'tail',     4): [0.15,  0.12,  0.18],
}

# ---- Severe delay probability (exact from paper) -----------------------------
def p_severe(R):
    return 1.0 / (1.0 + math.exp(-(ALPHA + BETA * R)))

# ---- Lead time sampler -------------------------------------------------------
def sample_lead_time(R, rng):
    if rng.random() < p_severe(R):
        lt = math.exp(rng.gauss(MU_SEV, SIGMA_SEV))
        return min(lt, SEVERE_CAP_D)
    if rng.random() < 0.5:
        return rng.triangular(*NON_SEVERE_MODERATE)
    return rng.triangular(*NON_SEVERE_SHORT)

# ---- Demand sampler ----------------------------------------------------------
def sample_demand(regime, lead_time_days, rng):
    cv    = BASE_CV * STRESS_AMP[regime]
    sigma = DEMAND_MU * cv
    mean  = DEMAND_MU * lead_time_days
    std   = sigma * math.sqrt(max(lead_time_days, 0.001))
    return max(rng.gauss(mean, std), 0.0)

# ---- Scenario effective-B adjustment -----------------------------------------
# Approximate. Paper's exact method needed for full calibration.
SAFETY_MULT = {2: 1.6, 3: 1.4, 4: 1.25, 5: 1.15, 6: 1.08}
TAIL_BUF    = {2: 0.3, 3: 0.5, 4: 0.7,  5: 1.0,  6: 1.3}

def effective_b(B, scenario):
    if scenario == 'safety':
        return B * SAFETY_MULT.get(B, 1.1)
    if scenario == 'tail':
        return B + TAIL_BUF.get(B, 0.5)
    return float(B)

# ---- Single run --------------------------------------------------------------
def run_simulation(regime, B, scenario, rng, n=N_TRIALS):
    R         = REGIMES[regime]
    inventory = DEMAND_MU * effective_b(B, scenario)
    stockouts = 0
    shortage  = 0.0
    for _ in range(n):
        lt  = sample_lead_time(R, rng)
        dem = sample_demand(regime, lt, rng)
        if dem > inventory:
            stockouts += 1
            shortage  += dem - inventory
    return stockouts / n, shortage / n

# ---- Confidence intervals ----------------------------------------------------
def binomial_ci(p, n, z=1.96):
    if n == 0:
        return 0.0, 0.0
    se = math.sqrt(p * (1 - p) / n)
    return max(0.0, p - z * se), min(1.0, p + z * se)

def shortage_ci_approx(p, n, mean_sh):
    if p <= 0 or n == 0:
        return 0.0, 0.0
    cv_est = math.sqrt((1 - p) / (p * n))
    se = mean_sh * cv_est
    return max(0.0, mean_sh - 1.96 * se), mean_sh + 1.96 * se

# ---- Main --------------------------------------------------------------------
def main():
    rng = random.Random(SEED)

    print("Monte Carlo Simulation  N={:,}  seed={}".format(N_TRIALS, SEED))
    print("Severe-delay probabilities:")
    for name, R in REGIMES.items():
        print("  {:8s} (R={:+d}): {:.1f}%".format(name, R, p_severe(R) * 100))
    print()

    regimes_order = ['low', 'normal', 'high', 'extreme']
    results = {}

    for regime in regimes_order:
        results[regime] = {}
        for scenario in SCENARIOS:
            results[regime][scenario] = []
            row = []
            for B in DAYS_OF_COVER:
                p, sh = run_simulation(regime, B, scenario, rng)
                lo_p, hi_p   = binomial_ci(p, N_TRIALS)
                lo_sh, hi_sh = shortage_ci_approx(p, N_TRIALS, sh)
                results[regime][scenario].append({
                    'B': B,
                    'p':      round(p, 6),
                    'p_lo':   round(lo_p, 6),
                    'p_hi':   round(hi_p, 6),
                    'p_pct':     round(p * 100, 4),
                    'p_lo_pct':  round(lo_p * 100, 4),
                    'p_hi_pct':  round(hi_p * 100, 4),
                    'shortage':    round(sh, 4),
                    'shortage_lo': round(lo_sh, 4),
                    'shortage_hi': round(hi_sh, 4),
                })
                row.append("B{}={:.2f}%".format(B, p * 100))
            print("  {:8s} {:8s}: {}".format(regime, scenario, " | ".join(row)))

    # ---- Validation ----------------------------------------------------------
    print("\n-- Validation vs Published Appendix A1 " + "-" * 30)
    print("{:35s} {:>10s} {:>10s} {:>8s} {:>8s}".format(
        "Cell", "Published", "Simulated", "Diff pp", "Status"))

    TOLERANCE_PP = 1.5
    pass_count = fail_count = 0
    max_diff = 0.0

    for (regime, scenario, B), pub in PUBLISHED.items():
        pub_p = pub[0]
        cell  = next((c for c in results[regime][scenario] if c['B'] == B), None)
        if cell is None:
            continue
        sim_p = cell['p_pct']
        diff  = abs(sim_p - pub_p)
        max_diff = max(max_diff, diff)
        ok = diff <= TOLERANCE_PP
        if ok:
            pass_count += 1
        else:
            fail_count += 1
        key = "  {}.{} B={}".format(regime, scenario, B)
        print("{:35s} {:>10.2f} {:>10.2f} {:>8.2f} {:>8s}".format(
            key, pub_p, sim_p, diff, "PASS" if ok else "FAIL"))

    total = pass_count + fail_count
    print("\nValidation: {}/{} cells within {}pp  (max diff: {:.2f}pp)".format(
        pass_count, total, TOLERANCE_PP, max_diff))

    if fail_count > 0:
        print("\nCALIBRATION NEEDED: {} cells exceed {}pp tolerance.".format(
            fail_count, TOLERANCE_PP))
        print("Adjust MU_SEV, NON_SEVERE_MODERATE, NON_SEVERE_SHORT, or STRESS_AMP.")
        print("Do not use these outputs to replace published MODEL cells.")

    # ---- Print tables --------------------------------------------------------
    print("\n-- MODEL decimal (api/latest.js) " + "-" * 30)
    for regime in regimes_order:
        print("  {}: {{".format(regime))
        for scenario in SCENARIOS:
            cells = results[regime][scenario]
            row = ", ".join(
                "[{:.4f},{:.4f},{:.4f}]".format(c['p'], c['p_lo'], c['p_hi'])
                for c in cells
            )
            print("    {:8s}: [{}],".format(scenario, row))
        print("  },")

    print("\n-- MODEL percent (index.html) " + "-" * 30)
    for regime in regimes_order:
        print("  {}: {{".format(regime))
        for scenario in SCENARIOS:
            cells = results[regime][scenario]
            row = ", ".join(
                "[{:.2f},{:.2f},{:.2f}]".format(c['p_pct'], c['p_lo_pct'], c['p_hi_pct'])
                for c in cells
            )
            print("    {:8s}: [{}],".format(scenario, row))
        print("  },")

    print("\n-- SHORTAGE_DATA " + "-" * 30)
    for regime in regimes_order:
        print("  {}: {{".format(regime))
        for scenario in SCENARIOS:
            cells = results[regime][scenario]
            row = ", ".join(
                "[{:.4f},{:.4f},{:.4f}]".format(
                    c['shortage'], c['shortage_lo'], c['shortage_hi'])
                for c in cells
            )
            print("    {:8s}: [{}],".format(scenario, row))
        print("  },")

    # ---- Save JSON -----------------------------------------------------------
    out_path = os.path.join(os.path.dirname(__file__), 'simulation_output.json')
    with open(out_path, 'w', encoding='utf-8') as f:
        json.dump({
            'run_timestamp': '2026-06-07T00:00:00Z',
            'paper_id': '242',
            'n_trials': N_TRIALS,
            'seed': SEED,
            'calibration_status': 'partial',
            'validation_cells_passed': pass_count,
            'validation_cells_total': total,
            'validation_tolerance_pp': TOLERANCE_PP,
            'validation_max_diff_pp': round(max_diff, 4),
            'parameters': {
                'alpha': ALPHA, 'beta': BETA,
                'sigma_sev': SIGMA_SEV, 'mu_sev': round(MU_SEV, 4),
                'severe_cap_hours': SEVERE_CAP_H,
                'base_cv': BASE_CV, 'demand_mu': DEMAND_MU,
                'non_severe_moderate_triangular': NON_SEVERE_MODERATE,
                'non_severe_short_triangular': NON_SEVERE_SHORT,
            },
            'results': results,
        }, f, indent=2)
    print("\nOutput saved: {}".format(out_path))

if __name__ == '__main__':
    main()
