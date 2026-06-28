/**
 * lib/constants.js
 *
 * Frozen model constants for SLRIS.
 * All values were fixed before the backtest ran. Do not alter
 * without re-running backtest/validate_model.py and updating
 * backtest/VALIDATION.md.
 */

// Composite stress index weights (must sum to 1.0)
export const WEIGHTS = { weather: 0.45, traffic: 0.35, port: 0.20 };

// Two-signal weights for the MBG food-bank nowcast layer.
// Must match WEIGHT_WEATHER and WEIGHT_PORT in backtest/score_backtest.py exactly.
// Traffic excluded from the two-signal score (NPMRDS unavailable historically).
export const MBG_W_WEATHER = 0.45;
export const MBG_W_PORT    = 0.20;

// Validated operating-point threshold from time-blocked 5-fold CV.
// Applied to the two-signal score (weather + port only). NOT the three-signal stressScore.
// Source: backtest/VALIDATION.md Section 4.
export const MBG_THRESHOLD = 0.0862;

// Consecutive elevated readings required to escalate ELEVATED -> SUSTAINED.
// Operational assumption; not statistically validated against disruption data.
export const MBG_SUSTAINED_N = 3;

// Port signal freshness thresholds (data/port_signal.json is manually updated).
// NWS and GA511 are fetched live on every run; their freshness is the current run result.
export const PORT_STALE_HOURS   = 72;   // warn after 3 days without a port signal update
export const PORT_EXPIRED_HOURS = 168;  // treat port signal as expired after 7 days
