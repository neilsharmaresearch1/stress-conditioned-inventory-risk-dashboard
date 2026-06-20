/**
 * tests/model.test.js
 *
 * Reproducibility test for computeRiskState().
 *
 * Verifies that refactoring api/latest.js to import from lib/model.js
 * has NOT altered any outputs. Tests compare against:
 *   - Exact values from Appendix A1, Paper 242 (published HIGH/EXTREME cells)
 *   - Known intermediate quantities (weatherScore, stressScore, regime)
 *
 * Run with: node --test tests/model.test.js
 *          or: npm test
 *
 * All asserted values are traceable to either Appendix A1 or deterministic
 * arithmetic from the published parameters.
 */

import { test, describe } from 'node:test';
import { strict as assert } from 'node:assert';

import { computeRiskState, deriveRegime, getMinFeasible, MODEL, SHORTAGE_DATA, DAYS, REGIME_CUTOFFS } from '../lib/model.js';

// ── Published model constants (Paper 242) ────────────────────────────────────

describe('REGIME_CUTOFFS: published constants (Paper 242)', () => {
  test('a = -0.5016 (low/normal boundary in standardized regime space)', () => {
    assert.equal(REGIME_CUTOFFS.a, -0.5016);
  });
  test('b = 0.4981 (normal/high boundary in standardized regime space)', () => {
    assert.equal(REGIME_CUTOFFS.b, 0.4981);
  });
  test('c = 1.4989 (high/extreme boundary in standardized regime space)', () => {
    assert.equal(REGIME_CUTOFFS.c, 1.4989);
  });
});

// ── Regime classification ─────────────────────────────────────────────────────

describe('deriveRegime', () => {
  test('0.29 is low', () => assert.equal(deriveRegime(0.29), 'low'));
  test('0.30 is normal', () => assert.equal(deriveRegime(0.30), 'normal'));
  test('0.59 is normal', () => assert.equal(deriveRegime(0.59), 'normal'));
  test('0.60 is high', () => assert.equal(deriveRegime(0.60), 'high'));
  test('0.79 is high', () => assert.equal(deriveRegime(0.79), 'high'));
  test('0.80 is extreme', () => assert.equal(deriveRegime(0.80), 'extreme'));
  test('1.00 is extreme', () => assert.equal(deriveRegime(1.00), 'extreme'));
});

// ── Stress index arithmetic ───────────────────────────────────────────────────

describe('computeRiskState: stress index', () => {
  test('zero inputs yield near-zero stress', () => {
    const r = computeRiskState({ nwsAlertCount: 0, trafficScore: 0, portScore: 0 });
    assert.equal(r.stressScore, 0);
    assert.equal(r.regime, 'low');
  });

  test('weatherScore caps at 0.80 (10 or more alerts)', () => {
    // 10 * 0.08 = 0.80, capped
    const r = computeRiskState({ nwsAlertCount: 10, trafficScore: 0, portScore: 0 });
    assert.equal(r.weatherScore, 0.8);
    assert.equal(r.stressContributions.weather, parseFloat((0.45 * 0.8).toFixed(4)));
  });

  test('port-only signal puts regime in low', () => {
    // portScore=0.10 -> stressRaw = 0.45*0 + 0.35*0 + 0.20*0.10 = 0.02
    const r = computeRiskState({ nwsAlertCount: 0, trafficScore: 0, portScore: 0.10 });
    assert.equal(r.stressScore, 0.0200);
    assert.equal(r.regime, 'low');
  });

  test('typical normal regime inputs', () => {
    // nws=0, traffic=0.23 -> weatherScore=0, trafficScore=0.23, portScore=0.22
    // stressRaw = 0 + 0.35*0.23 + 0.20*0.22 = 0.0805 + 0.044 = 0.1245
    // stressScore = 0.1245 -> normal? No, 0.1245 < 0.30, so low
    const r = computeRiskState({ nwsAlertCount: 0, trafficScore: 0.23, portScore: 0.22 });
    assert.equal(r.regime, 'low');
    assert.ok(r.stressScore < 0.30);
  });

  test('moderate inputs produce normal regime', () => {
    // nws=4, traffic=0.23, portScore=0.22
    // weatherScore = 4*0.08 = 0.32
    // stressRaw = 0.45*0.32 + 0.35*0.23 + 0.20*0.22 = 0.144 + 0.0805 + 0.044 = 0.2685
    // -> 0.2685 < 0.30, still low. Try nws=5:
    // weatherScore = 5*0.08 = 0.40
    // stressRaw = 0.45*0.40 + 0.35*0.23 + 0.20*0.22 = 0.18 + 0.0805 + 0.044 = 0.3045 -> normal
    const r = computeRiskState({ nwsAlertCount: 5, trafficScore: 0.23, portScore: 0.22 });
    assert.ok(r.stressScore >= 0.30, `stressScore ${r.stressScore} should be >= 0.30`);
    assert.equal(r.regime, 'normal');
  });
});

// ── Published HIGH regime values (Appendix A1, Paper 242) ────────────────────

describe('computeRiskState: HIGH regime published cells', () => {
  // Inputs that produce regime = high:
  // nwsAlertCount=10 -> weatherScore=0.80 (capped)
  // trafficScore=0.23, portScore=0.22
  // stressRaw = 0.45*0.80 + 0.35*0.23 + 0.20*0.22 = 0.360 + 0.0805 + 0.044 = 0.4845
  // -> 0.4845 < 0.60 = normal. Need higher score.
  // Use: nws=10, traffic=0.69, portScore=0.22
  // stressRaw = 0.45*0.80 + 0.35*0.69 + 0.20*0.22 = 0.360 + 0.2415 + 0.044 = 0.6455 -> high
  const inputs = { nwsAlertCount: 10, trafficScore: 0.69, portScore: 0.22 };

  test('regime is high', () => {
    const r = computeRiskState(inputs);
    assert.equal(r.regime, 'high');
  });

  test('baseline B=2: p=0.0721, lo=0.0699, hi=0.0744 (Appendix A1)', () => {
    const r = computeRiskState(inputs);
    assert.equal(r.pStockout.baseline[2].p,  0.0721);
    assert.equal(r.pStockout.baseline[2].lo, 0.0699);
    assert.equal(r.pStockout.baseline[2].hi, 0.0744);
  });

  test('baseline B=3: p=0.0083, lo=0.0075, hi=0.0091 (Appendix A1)', () => {
    const r = computeRiskState(inputs);
    assert.equal(r.pStockout.baseline[3].p,  0.0083);
    assert.equal(r.pStockout.baseline[3].lo, 0.0075);
    assert.equal(r.pStockout.baseline[3].hi, 0.0091);
  });

  test('baseline B=4: p=0.0008, lo=0.0005, hi=0.0011 (Appendix A1)', () => {
    const r = computeRiskState(inputs);
    assert.equal(r.pStockout.baseline[4].p,  0.0008);
    assert.equal(r.pStockout.baseline[4].lo, 0.0005);
    assert.equal(r.pStockout.baseline[4].hi, 0.0011);
  });

  test('safety B=2: p=0.0095, lo=0.0087, hi=0.0104 (Appendix A1)', () => {
    const r = computeRiskState(inputs);
    assert.equal(r.pStockout.safety[2].p,  0.0095);
    assert.equal(r.pStockout.safety[2].lo, 0.0087);
    assert.equal(r.pStockout.safety[2].hi, 0.0104);
  });

  test('tail B=2: p=0.0555, lo=0.0535, hi=0.0575 (Appendix A1)', () => {
    const r = computeRiskState(inputs);
    assert.equal(r.pStockout.tail[2].p,  0.0555);
    assert.equal(r.pStockout.tail[2].lo, 0.0535);
    assert.equal(r.pStockout.tail[2].hi, 0.0575);
  });
});

// ── Published EXTREME regime values (Appendix A1, Paper 242) ─────────────────

describe('computeRiskState: EXTREME regime published cells', () => {
  // nws=21 -> weatherScore=0.80 (capped)
  // traffic=0.85, port=0.80
  // stressRaw = 0.45*0.80 + 0.35*0.85 + 0.20*0.80 = 0.360 + 0.2975 + 0.160 = 0.8175 -> extreme
  const inputs = { nwsAlertCount: 21, trafficScore: 0.85, portScore: 0.80 };

  test('regime is extreme', () => {
    const r = computeRiskState(inputs);
    assert.equal(r.regime, 'extreme');
  });

  test('baseline B=2: p=0.1251, lo=0.1222, hi=0.1280 (Appendix A1)', () => {
    const r = computeRiskState(inputs);
    assert.equal(r.pStockout.baseline[2].p,  0.1251);
    assert.equal(r.pStockout.baseline[2].lo, 0.1222);
    assert.equal(r.pStockout.baseline[2].hi, 0.1280);
  });

  test('baseline B=3: p=0.0176, lo=0.0164, hi=0.0188 (Appendix A1)', () => {
    const r = computeRiskState(inputs);
    assert.equal(r.pStockout.baseline[3].p,  0.0176);
    assert.equal(r.pStockout.baseline[3].lo, 0.0164);
    assert.equal(r.pStockout.baseline[3].hi, 0.0188);
  });

  test('baseline B=4: p=0.0024, lo=0.0020, hi=0.0028 (Appendix A1)', () => {
    const r = computeRiskState(inputs);
    assert.equal(r.pStockout.baseline[4].p,  0.0024);
    assert.equal(r.pStockout.baseline[4].lo, 0.0020);
    assert.equal(r.pStockout.baseline[4].hi, 0.0028);
  });

  test('safety B=2: p=0.0183, lo=0.0171, hi=0.0195 (Appendix A1)', () => {
    const r = computeRiskState(inputs);
    assert.equal(r.pStockout.safety[2].p,  0.0183);
    assert.equal(r.pStockout.safety[2].lo, 0.0171);
    assert.equal(r.pStockout.safety[2].hi, 0.0195);
  });

  test('tail B=2: p=0.0931, lo=0.0906, hi=0.0956 (Appendix A1)', () => {
    const r = computeRiskState(inputs);
    assert.equal(r.pStockout.tail[2].p,  0.0931);
    assert.equal(r.pStockout.tail[2].lo, 0.0906);
    assert.equal(r.pStockout.tail[2].hi, 0.0956);
  });
});

// ── Shortage values (published HIGH/EXTREME, Appendix A1) ────────────────────

describe('computeRiskState: shortage values', () => {
  test('HIGH baseline B=2: shortage=3.703 (Appendix A1)', () => {
    const r = computeRiskState({ nwsAlertCount: 10, trafficScore: 0.69, portScore: 0.22 });
    assert.equal(r.pStockout.baseline[2].shortage, 3.703);
  });

  test('EXTREME baseline B=2: shortage=6.370 (Appendix A1)', () => {
    const r = computeRiskState({ nwsAlertCount: 21, trafficScore: 0.85, portScore: 0.80 });
    assert.equal(r.pStockout.baseline[2].shortage, 6.370);
  });
});

// ── getMinFeasible ────────────────────────────────────────────────────────────

describe('getMinFeasible', () => {
  test('high regime baseline: min feasible at 2% target is B=3 (p=0.0083 <= 0.02)', () => {
    // high baseline B=2: 0.0721 (fail), B=3: 0.0083 (pass) -- first below 0.02 is B=3
    assert.equal(getMinFeasible('high', 'baseline', 0.02), 3);
  });

  test('extreme regime baseline: min feasible at 2% target is B=3 (p=0.0176 <= 0.02)', () => {
    // extreme baseline B=2: 0.1251 (fail), B=3: 0.0176 (pass) -- first below 0.02 is B=3
    assert.equal(getMinFeasible('extreme', 'baseline', 0.02), 3);
  });

  test('low regime baseline: min feasible at 2% target is B=2 (p=0.018 <= 0.02)', () => {
    assert.equal(getMinFeasible('low', 'baseline', 0.02), 2);
  });

  test('extreme regime baseline: min feasible at 1% target is B=4 (p=0.0024 <= 0.01)', () => {
    // B=2: 0.1251 (fail), B=3: 0.0176 (fail), B=4: 0.0024 (pass) -- first <= 0.01 is B=4
    assert.equal(getMinFeasible('extreme', 'baseline', 0.01), 4);
  });
});

// ── Structural invariants ─────────────────────────────────────────────────────

describe('MODEL structural invariants', () => {
  const regimes   = ['low', 'normal', 'high', 'extreme'];
  const scenarios = ['baseline', 'safety', 'tail'];

  test('all (regime, scenario) cells exist and have 5 B-values', () => {
    for (const regime of regimes) {
      for (const scenario of scenarios) {
        const curve = MODEL[regime]?.[scenario];
        assert.ok(curve, `Missing MODEL[${regime}][${scenario}]`);
        assert.equal(curve.length, 5, `MODEL[${regime}][${scenario}] should have 5 B-values`);
      }
    }
  });

  test('probabilities are monotone decreasing in B (within each regime/scenario)', () => {
    for (const regime of regimes) {
      for (const scenario of scenarios) {
        const curve = MODEL[regime][scenario];
        for (let i = 1; i < curve.length; i++) {
          assert.ok(curve[i][0] <= curve[i-1][0],
            `MODEL[${regime}][${scenario}] not monotone at B=${DAYS[i]}: ${curve[i][0]} > ${curve[i-1][0]}`);
        }
      }
    }
  });

  test('regime order: low < normal < high < extreme at each B', () => {
    for (let i = 0; i < DAYS.length; i++) {
      const [lo, no, hi, ex] = regimes.map(r => MODEL[r].baseline[i][0]);
      assert.ok(lo <= no, `low <= normal at B=${DAYS[i]}`);
      assert.ok(no <= hi, `normal <= high at B=${DAYS[i]}`);
      assert.ok(hi <= ex, `high <= extreme at B=${DAYS[i]}`);
    }
  });

  test('safety <= baseline at each (regime, B)', () => {
    for (const regime of regimes) {
      for (let i = 0; i < DAYS.length; i++) {
        assert.ok(MODEL[regime].safety[i][0] <= MODEL[regime].baseline[i][0],
          `safety <= baseline violated at [${regime}][B=${DAYS[i]}]`);
      }
    }
  });

  test('tail <= baseline at each (regime, B)', () => {
    for (const regime of regimes) {
      for (let i = 0; i < DAYS.length; i++) {
        assert.ok(MODEL[regime].tail[i][0] <= MODEL[regime].baseline[i][0],
          `tail <= baseline violated at [${regime}][B=${DAYS[i]}]`);
      }
    }
  });
});

// ── Stress contributions sum check ───────────────────────────────────────────

describe('stress contributions', () => {
  test('contributions sum to stressScore within floating-point tolerance', () => {
    const inputs = { nwsAlertCount: 5, trafficScore: 0.40, portScore: 0.22 };
    const r = computeRiskState(inputs);
    const sum = r.stressContributions.weather + r.stressContributions.traffic + r.stressContributions.port;
    assert.ok(Math.abs(sum - r.stressScore) < 0.0002,
      `contributions sum ${sum} should equal stressScore ${r.stressScore}`);
  });
});
