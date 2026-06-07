# -*- coding: utf-8 -*-
"""
Monte Carlo simulation for stockout risk - Paper 242, corrected parameters.

Paper: Stress Conditioned Monte Carlo Modeling of Stockout Risk
       on the Savannah to Atlanta Lane (Paper 242, Neil Sharma)

All scenario implementations match the paper exactly:
  L0       = 1.0 day        base lead time (Section 5.2)
  Safety   = B + 1          one extra day of cover (Section 5.3)
  Tail     = beta * 0.80    20% reduction in stress sensitivity (Section 5.3)
  Mixing   = gamma=0.35     35% moderate, 65% short among non-severe (Section 6.2)
  Demand   = N(100*L, 25*sqrt(L))  absolute units, not normalized (Section 5.2)
  Logistic = alpha=-2.197, beta=0.811 (published exact)
  Severe   = LogNormal(MU_SEV, sigma=1.2), capped at 72h = 3.0 days

Unknown parameter needing calibration:
  MU_SEV: log-scale location of severe delay duration (days).
  The script sweeps a range and selects the value with lowest average
  deviation from the 18 published Appendix A1 cells.

Non-severe triangular bounds are short relative to L0 and have minor influence;
set to plausible hours-scale values for the Savannah-Atlanta corridor.

Usage:
  python run_monte_carlo.py

Outputs:
  - Console: calibration sweep, validation table, MODEL tables
  - simulation_output.json: machine-readable results for dashboard update
"""

import math
import json
import random
import os

# ---- Reproducibility ---------------------------------------------------------
SEED = 42
N_TRIALS = 50_000
N_CAL = 8_000   # reduced trials for calibration sweep speed

# ---- Published model parameters (exact from paper) ---------------------------
ALPHA = -2.197
BETA = 0.811
SIGMA_SEV = 1.2
SEVERE_CAP_H = 72.0
SEVERE_CAP_D = SEVERE_CAP_H / 24.0  # 3.0 days

# ---- Paper-specified structural parameters -----------------------------------
L0 = 1.0       # base lead time in days (Section 5.2)
GAMMA = 0.35   # fraction of non-severe events that are moderate (Section 6.2)
MU_D = 100.0   # mean demand per day in units (Section 5.2)
SIGMA_D = 25.0  # demand std dev per day in units (Section 5.2)

# ---- Non-severe triangular delay bounds (days) -------------------------------
# Short: 0-6 hours; Moderate: 2-12 hours. Hours-scale relative to L0=1 day.
NON_SEVERE_SHORT = (0.0, 6.0/24, 2.5/24)       # (low, high, mode)
NON_SEVERE_MODERATE = (2.0/24, 12.0/24, 6.0/24)  # (low, high, mode)

# ---- MU_SEV: calibrated below -----------------------------------------------
# Initial guess: 20-hour median severe delay
MU_SEV = math.log(20.0 / 24.0)

# ---- Regime definitions ------------------------------------------------------
REGIMES = {'low': -1, 'normal': 0, 'high': 1, 'extreme': 2}
DAYS_OF_COVER = [2, 3, 4, 5, 6]
SCENARIOS = ['baseline', 'safety', 'tail']

# ---- Published ground truth (Appendix A1, Paper 242) -------------------------
# [p_central, lo, hi] in percent. 18 cells: High and Extreme, B=2,3,4.
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

# ---- Core model functions ----------------------------------------------------

def p_severe(R, beta=None):
    b = beta if beta is not None else BETA
    return 1.0 / (1.0 + math.exp(-(ALPHA + b * R)))


def sample_delay(R, rng, beta=None, mu_sev=None):
    """Sample delay duration in days (added to L0 to get total lead time)."""
    b = beta if beta is not None else BETA
    mu = mu_sev if mu_sev is not None else MU_SEV
    if rng.random() < p_severe(R, beta=b):
        raw = math.exp(rng.gauss(mu, SIGMA_SEV))
        return min(raw, SEVERE_CAP_D)
    if rng.random() < GAMMA:
        return rng.triangular(*NON_SEVERE_MODERATE)
    return rng.triangular(*NON_SEVERE_SHORT)


def run_simulation(regime, B, scenario, rng, n=N_TRIALS, mu_sev=None):
    R = REGIMES[regime]

    # Scenario adjustments
    if scenario == 'safety':
        B_eff = B + 1        # one extra day of cover
        beta_eff = BETA
    elif scenario == 'tail':
        B_eff = B
        beta_eff = BETA * 0.80   # 20% reduction in stress sensitivity
    else:
        B_eff = B
        beta_eff = BETA

    inventory = MU_D * B_eff   # units

    stockouts = 0
    shortage = 0.0

    for _ in range(n):
        delay = sample_delay(R, rng, beta=beta_eff, mu_sev=mu_sev)
        L = L0 + delay                               # total lead time (days)
        demand = max(rng.gauss(MU_D * L, SIGMA_D * math.sqrt(L)), 0.0)
        if demand > inventory:
            stockouts += 1
            shortage += demand - inventory

    return stockouts / n, shortage / n


def binomial_ci(p, n, z=1.96):
    if n == 0 or p <= 0 or p >= 1:
        return max(0.0, p), min(1.0, p)
    se = math.sqrt(p * (1.0 - p) / n)
    return max(0.0, p - z * se), min(1.0, p + z * se)


def shortage_ci_approx(p, n, mean_sh):
    if p <= 0 or n == 0 or mean_sh <= 0:
        return 0.0, 0.0
    cv_est = math.sqrt((1.0 - p) / (p * n))
    se = mean_sh * cv_est
    return max(0.0, mean_sh - 1.96 * se), mean_sh + 1.96 * se

# ---- Calibration sweep -------------------------------------------------------

def _run_published_cells(mu_sev, n_trials):
    """Run only the 18 published cells for quick calibration."""
    rng = random.Random(SEED)
    total_sq = 0.0
    count = 0
    for (regime, scenario, B), pub in PUBLISHED.items():
        p, _ = run_simulation(regime, B, scenario, rng, n=n_trials, mu_sev=mu_sev)
        diff = abs(p * 100 - pub[0])
        total_sq += diff * diff
        count += 1
    return math.sqrt(total_sq / count) if count else float('inf')


def calibrate_mu_sev():
    """Grid search over MU_SEV (median hours 6-48) using N_CAL trials."""
    print("Calibrating MU_SEV (median severe delay duration)...")
    print("  N_CAL = {:,} trials per step".format(N_CAL))
    print()
    print("{:>10s} {:>12s} {:>12s}".format("Median_h", "MU_SEV", "RMS_diff_pp"))
    print("-" * 38)

    best_rms = float('inf')
    best_mu = MU_SEV
    candidates = []

    for median_h in [6, 8, 10, 12, 14, 16, 18, 20, 22, 24, 28, 32, 36, 42, 48]:
        mu = math.log(median_h / 24.0)
        rms = _run_published_cells(mu, N_CAL)
        candidates.append((rms, mu, median_h))
        marker = " <--" if rms < best_rms else ""
        print("{:>10.0f}h {:>12.4f} {:>12.3f}{}".format(median_h, mu, rms, marker))
        if rms < best_rms:
            best_rms = rms
            best_mu = mu

    # Fine sweep around best
    best_median_h = math.exp(best_mu) * 24.0
    print()
    print("Fine sweep around {:.0f}h...".format(best_median_h))
    for delta_h in [-3, -2, -1, 0.5, 1, 2, 3]:
        candidate_h = best_median_h + delta_h
        if candidate_h <= 0:
            continue
        mu = math.log(candidate_h / 24.0)
        rms = _run_published_cells(mu, N_CAL)
        marker = " <--" if rms < best_rms else ""
        print("{:>10.1f}h {:>12.4f} {:>12.3f}{}".format(candidate_h, mu, rms, marker))
        if rms < best_rms:
            best_rms = rms
            best_mu = mu

    print()
    best_h = math.exp(best_mu) * 24.0
    print("Selected MU_SEV = {:.4f}  (median {:.1f}h, RMS = {:.3f}pp)".format(
        best_mu, best_h, best_rms))
    return best_mu

# ---- Full simulation run -----------------------------------------------------

def run_all(mu_sev):
    rng = random.Random(SEED)
    regimes_order = ['low', 'normal', 'high', 'extreme']
    results = {}
    for regime in regimes_order:
        results[regime] = {}
        for scenario in SCENARIOS:
            results[regime][scenario] = []
            for B in DAYS_OF_COVER:
                p, sh = run_simulation(regime, B, scenario, rng,
                                       n=N_TRIALS, mu_sev=mu_sev)
                lo_p, hi_p = binomial_ci(p, N_TRIALS)
                lo_sh, hi_sh = shortage_ci_approx(p, N_TRIALS, sh)
                results[regime][scenario].append({
                    'B': B,
                    'p':       round(p, 6),
                    'p_lo':    round(lo_p, 6),
                    'p_hi':    round(hi_p, 6),
                    'p_pct':     round(p * 100, 4),
                    'p_lo_pct':  round(lo_p * 100, 4),
                    'p_hi_pct':  round(hi_p * 100, 4),
                    'shortage':    round(sh, 4),
                    'shortage_lo': round(lo_sh, 4),
                    'shortage_hi': round(hi_sh, 4),
                })
    return results

# ---- Validation --------------------------------------------------------------

def print_validation(results, tol=1.5):
    print("\n-- Validation vs Published Appendix A1 " + "-" * 35)
    print("{:40s} {:>9s} {:>9s} {:>8s} {:>6s}".format(
        "Cell", "Published", "Simulated", "Diff pp", "Status"))

    pass_count = fail_count = 0
    max_diff = 0.0
    total_diff = 0.0

    for key in sorted(PUBLISHED.keys()):
        regime, scenario, B = key
        pub = PUBLISHED[key]
        cell = next((c for c in results[regime][scenario] if c['B'] == B), None)
        if cell is None:
            continue
        sim_p = cell['p_pct']
        diff = abs(sim_p - pub[0])
        max_diff = max(max_diff, diff)
        total_diff += diff
        ok = diff <= tol
        if ok:
            pass_count += 1
        else:
            fail_count += 1
        label = "  {}.{} B={}".format(regime, scenario, B)
        print("{:40s} {:>9.2f} {:>9.2f} {:>8.2f} {:>6s}".format(
            label, pub[0], sim_p, diff, "PASS" if ok else "FAIL"))

    total = pass_count + fail_count
    avg_diff = total_diff / total if total else 0
    print("\n  {}/{} cells within {}pp  |  max diff: {:.2f}pp  |  avg diff: {:.2f}pp".format(
        pass_count, total, tol, max_diff, avg_diff))

    if fail_count > 0:
        print()
        print("  CALIBRATION NEEDED: {} cells exceed {}pp.".format(fail_count, tol))
        print("  Adjust MU_SEV or non-severe triangular bounds before exporting.")
        print("  Do NOT use outputs to replace published Appendix A1 MODEL cells.")
    else:
        print()
        print("  ALL CELLS PASS. Safe to export Low/Normal/B5-B6 outputs.")

    return pass_count, fail_count, max_diff

# ---- Print MODEL tables ------------------------------------------------------

def print_model_tables(results):
    regimes_order = ['low', 'normal', 'high', 'extreme']

    print("\n-- MODEL decimal (api/latest.js) " + "-" * 40)
    for regime in regimes_order:
        print("  {}: {{".format(regime))
        for scenario in SCENARIOS:
            cells = results[regime][scenario]
            row = ", ".join(
                "[{:.4f},{:.4f},{:.4f}]".format(c['p'], c['p_lo'], c['p_hi'])
                for c in cells)
            print("    {:8s}: [{}],".format(scenario, row))
        print("  },")

    print("\n-- MODEL percent (index.html) " + "-" * 43)
    for regime in regimes_order:
        print("  {}: {{".format(regime))
        for scenario in SCENARIOS:
            cells = results[regime][scenario]
            row = ", ".join(
                "[{:.2f},{:.2f},{:.2f}]".format(
                    c['p_pct'], c['p_lo_pct'], c['p_hi_pct'])
                for c in cells)
            print("    {:8s}: [{}],".format(scenario, row))
        print("  },")

    print("\n-- SHORTAGE_DATA " + "-" * 56)
    for regime in regimes_order:
        print("  {}: {{".format(regime))
        for scenario in SCENARIOS:
            cells = results[regime][scenario]
            row = ", ".join(
                "[{:.4f},{:.4f},{:.4f}]".format(
                    c['shortage'], c['shortage_lo'], c['shortage_hi'])
                for c in cells)
            print("    {:8s}: [{}],".format(scenario, row))
        print("  },")

# ---- Main --------------------------------------------------------------------

def main():
    print("Monte Carlo Simulation  N={:,}  seed={}".format(N_TRIALS, SEED))
    print()
    print("Severe-delay probabilities by regime:")
    for name, R in [('low', -1), ('normal', 0), ('high', 1), ('extreme', 2)]:
        print("  {:8s} (R={:+d}): baseline {:.1f}%  tail {:.1f}%".format(
            name, R,
            p_severe(R, beta=BETA) * 100,
            p_severe(R, beta=BETA * 0.8) * 100))
    print()

    # Run calibration sweep
    best_mu = calibrate_mu_sev()

    # Full run with calibrated MU_SEV
    print()
    print("Full run: N={:,} trials, MU_SEV={:.4f} (median {:.1f}h)".format(
        N_TRIALS, best_mu, math.exp(best_mu) * 24))
    results = run_all(best_mu)

    # Validation
    pass_count, fail_count, max_diff = print_validation(results)

    # Print tables
    print_model_tables(results)

    # Save JSON
    out_path = os.path.join(os.path.dirname(__file__), 'simulation_output.json')
    status = 'calibrated_full' if fail_count == 0 else 'calibrated_partial'
    with open(out_path, 'w', encoding='utf-8') as f:
        json.dump({
            'run_timestamp': '2026-06-07T00:00:00Z',
            'paper_id': '242',
            'n_trials': N_TRIALS,
            'seed': SEED,
            'calibration_status': status,
            'mu_sev_calibrated': round(best_mu, 6),
            'mu_sev_median_hours': round(math.exp(best_mu) * 24, 2),
            'validation_cells_passed': pass_count,
            'validation_cells_total': 18,
            'validation_max_diff_pp': round(max_diff, 4),
            'parameters': {
                'alpha': ALPHA,
                'beta': BETA,
                'sigma_sev': SIGMA_SEV,
                'severe_cap_hours': SEVERE_CAP_H,
                'L0_days': L0,
                'gamma_moderate_fraction': GAMMA,
                'demand_mu_per_day': MU_D,
                'demand_sigma_per_day': SIGMA_D,
                'non_severe_short_triangular_days': NON_SEVERE_SHORT,
                'non_severe_moderate_triangular_days': NON_SEVERE_MODERATE,
            },
            'results': results,
        }, f, indent=2)

    print("\nSaved: {}".format(out_path))

    if fail_count == 0:
        print()
        print("Next step: copy Low/Normal and B5-B6 cells from MODEL tables above")
        print("into both index.html (percent form) and api/latest.js (decimal form).")
        print("Remove 'illustrative, pending' labels from those cells only.")

if __name__ == '__main__':
    main()
