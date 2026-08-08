// js/pages/calculate/blend-calculator.js tests (V2.4 Phase 2 -- Blend
// Calculator). See
// docs/V2.4_CALCULATE_AND_BLENDING_RECOMMENDATION_ARCHITECTURE.md Sections
// 14-15, and this task's Section 26.
//
// Run with Node's built-in test runner:
//
//   node --test tests/blend-calculator.test.mjs
//
// calculateWeightedBlend() is a pure function (no DOM/router/i18n/
// localStorage) -- every test below calls it directly with already-
// numeric pile objects, exactly the shape calculate-validation.js's
// toNumericPile() produces.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { calculatePileTonnage, calculateWeightedBlend } from '../js/pages/calculate/blend-calculator.js';

function closeTo(actual, expected, epsilon = 1e-9) {
  assert.ok(Math.abs(actual - expected) < epsilon, `expected ${actual} to be close to ${expected}`);
}

describe('calculatePileTonnage()', () => {
  test('units x tonnesPerUnit', () => {
    assert.equal(calculatePileTonnage(10, 50), 500);
  });

  test('zero units -> zero tonnage', () => {
    assert.equal(calculatePileTonnage(0, 50), 0);
  });

  test('decimal tonnes/unit preserved exactly', () => {
    assert.equal(calculatePileTonnage(10, 45.5), 455);
  });
});

describe('calculateWeightedBlend() -- A. single pile', () => {
  test('Ni 1.20, 10 DT, 50 t/DT -> 500 t, Final Ni 1.20, class MGLO (boundary)', () => {
    const result = calculateWeightedBlend([{ pileId: 'A', ni: 1.2, units: 10, tonnesPerUnit: 50 }]);
    assert.equal(result.ok, true);
    assert.equal(result.totalTonnage, 500);
    assert.equal(result.totalUnits, 10);
    closeTo(result.weightedNi, 1.2);
    assert.equal(result.piles[0].oreClass, 'MGLO');
  });
});

describe('calculateWeightedBlend() -- B. two equal-tonnage piles', () => {
  test('Ni 1.30 (10x50) + Ni 1.00 (10x50) -> 1.15', () => {
    const result = calculateWeightedBlend([
      { pileId: 'A', ni: 1.3, units: 10, tonnesPerUnit: 50 },
      { pileId: 'B', ni: 1.0, units: 10, tonnesPerUnit: 50 },
    ]);
    assert.equal(result.ok, true);
    assert.equal(result.totalTonnage, 1000);
    assert.equal(result.totalUnits, 20);
    closeTo(result.weightedNi, 1.15);
  });
});

describe('calculateWeightedBlend() -- C. different tonnes/DT (the authoritative worked example, architecture doc Section 14)', () => {
  test('Ni 1.30 (10x50=500t) + Ni 0.95 (20x45=900t) -> Final Ni = 1.075%', () => {
    const result = calculateWeightedBlend([
      { pileId: 'A', ni: 1.3, units: 10, tonnesPerUnit: 50 },
      { pileId: 'B', ni: 0.95, units: 20, tonnesPerUnit: 45 },
    ]);
    assert.equal(result.ok, true);
    assert.equal(result.totalUnits, 30);
    assert.equal(result.totalTonnage, 1400);
    closeTo(result.weightedNi, 1.075);
    assert.equal(result.weightedNi.toFixed(3), '1.075');
  });

  test('never a DT-count-weighted average -- differs from the (wrong) Sigma(Ni*units)/Sigma(units) shortcut since tonnes/DT differ', () => {
    const result = calculateWeightedBlend([
      { pileId: 'A', ni: 1.3, units: 10, tonnesPerUnit: 50 },
      { pileId: 'B', ni: 0.95, units: 20, tonnesPerUnit: 45 },
    ]);
    const wrongDtWeightedAverage = (1.3 * 10 + 0.95 * 20) / 30; // 1.083333...
    assert.notEqual(result.weightedNi.toFixed(3), wrongDtWeightedAverage.toFixed(3));
  });

  test('never a plain average(Ni) either', () => {
    const result = calculateWeightedBlend([
      { pileId: 'A', ni: 1.3, units: 10, tonnesPerUnit: 50 },
      { pileId: 'B', ni: 0.95, units: 20, tonnesPerUnit: 45 },
    ]);
    const plainAverage = (1.3 + 0.95) / 2; // 1.125
    assert.notEqual(result.weightedNi.toFixed(3), plainAverage.toFixed(3));
  });
});

describe('calculateWeightedBlend() -- D. three+ piles', () => {
  test('proper weighted sum across three piles with equal tonnage each', () => {
    const result = calculateWeightedBlend([
      { pileId: 'A', ni: 1.5, units: 5, tonnesPerUnit: 40 }, // 200 t
      { pileId: 'B', ni: 1.0, units: 8, tonnesPerUnit: 25 }, // 200 t
      { pileId: 'C', ni: 1.3, units: 10, tonnesPerUnit: 20 }, // 200 t
    ]);
    assert.equal(result.ok, true);
    assert.equal(result.totalTonnage, 600);
    closeTo(result.weightedNi, 760 / 600);
  });
});

describe('calculateWeightedBlend() -- E. zero units on one pile does not poison the math', () => {
  test('a zero-unit pile contributes zero weight, result equals the other pile\'s own Ni', () => {
    const result = calculateWeightedBlend([
      { pileId: 'A', ni: 1.3, units: 0, tonnesPerUnit: 50 },
      { pileId: 'B', ni: 1.0, units: 10, tonnesPerUnit: 50 },
    ]);
    assert.equal(result.ok, true);
    assert.equal(result.totalTonnage, 500);
    closeTo(result.weightedNi, 1.0);
  });
});

describe('calculateWeightedBlend() -- F. all zero units is rejected', () => {
  test('total tonnage = 0 -> ok:false, never a fabricated Ni = 0', () => {
    const result = calculateWeightedBlend([
      { pileId: 'A', ni: 1.3, units: 0, tonnesPerUnit: 50 },
      { pileId: 'B', ni: 1.0, units: 0, tonnesPerUnit: 45 },
    ]);
    assert.equal(result.ok, false);
    assert.equal(result.error, 'ZERO_TOTAL_TONNAGE');
    assert.equal('weightedNi' in result, false);
  });

  test('an empty pile list is likewise rejected, not treated as Ni = 0', () => {
    const result = calculateWeightedBlend([]);
    assert.equal(result.ok, false);
    assert.equal(result.error, 'ZERO_TOTAL_TONNAGE');
  });
});

describe('calculateWeightedBlend() -- G. decimal tonnes/unit preserved accurately', () => {
  test('45.5 t/DT is not truncated or rounded internally', () => {
    const result = calculateWeightedBlend([{ pileId: 'A', ni: 1.25, units: 10, tonnesPerUnit: 45.5 }]);
    assert.equal(result.ok, true);
    assert.equal(result.piles[0].tonnage, 455);
    assert.equal(result.totalTonnage, 455);
  });
});

describe('calculateWeightedBlend() -- H. no premature rounding', () => {
  test('rounding each pile\'s own Ni to 2 decimals before weighting would give a visibly different (wrong) result -- confirm we are NOT that', () => {
    const result = calculateWeightedBlend([
      { pileId: 'A', ni: 1.111111, units: 1, tonnesPerUnit: 9 },
      { pileId: 'B', ni: 1.222222, units: 1, tonnesPerUnit: 9 },
    ]);
    assert.equal(result.ok, true);
    // Full precision: (1.111111*9 + 1.222222*9) / 18 = 20.999997 / 18
    closeTo(result.weightedNi, 20.999997 / 18, 1e-9);
    // A naive "round each pile's Ni to 2dp first" implementation would
    // compute (1.11*9 + 1.22*9) / 18 = 20.97 / 18 = 1.165 instead.
    assert.ok(Math.abs(result.weightedNi - 1.165) > 1e-4);
  });

  test('rounding pile tonnage before summing would also give a different result -- confirm full-precision tonnage is what is actually summed', () => {
    const result = calculateWeightedBlend([
      { pileId: 'A', ni: 1.2, units: 3, tonnesPerUnit: 33.333333 }, // 99.999999 t, not 100 t
      { pileId: 'B', ni: 1.2, units: 1, tonnesPerUnit: 0.000001 },
    ]);
    assert.equal(result.ok, true);
    closeTo(result.totalTonnage, 99.999999 + 0.000001, 1e-6);
  });
});

describe('Ore-class and Higher Grade totals (Section 18-19 -- informational only, never a recommendation)', () => {
  test('per-class unit/tonnage totals are correct', () => {
    const result = calculateWeightedBlend([
      { pileId: 'H1', ni: 1.5, units: 2, tonnesPerUnit: 50 }, // HGLO, 100 t
      { pileId: 'M1', ni: 1.3, units: 7, tonnesPerUnit: 50 }, // MGLO, 350 t
      { pileId: 'L1', ni: 0.9, units: 18, tonnesPerUnit: 50 }, // LGLO, 900 t
    ]);
    assert.equal(result.ok, true);
    assert.equal(result.classes.HGLO.units, 2);
    assert.equal(result.classes.HGLO.tonnage, 100);
    assert.equal(result.classes.MGLO.units, 7);
    assert.equal(result.classes.MGLO.tonnage, 350);
    assert.equal(result.classes.LGLO.units, 18);
    assert.equal(result.classes.LGLO.tonnage, 900);
  });

  test('Higher Grade = HGLO + MGLO combined (units and tonnage)', () => {
    const result = calculateWeightedBlend([
      { pileId: 'H1', ni: 1.5, units: 2, tonnesPerUnit: 50 },
      { pileId: 'M1', ni: 1.3, units: 7, tonnesPerUnit: 50 },
      { pileId: 'L1', ni: 0.9, units: 18, tonnesPerUnit: 50 },
    ]);
    assert.equal(result.higherGrade.units, 9);
    assert.equal(result.higherGrade.tonnage, 450);
  });

  test('the result model carries no Hopper Pattern, Unit Ratio, or Recommendation field of any kind', () => {
    const result = calculateWeightedBlend([{ pileId: 'A', ni: 1.3, units: 10, tonnesPerUnit: 50 }]);
    for (const forbidden of ['hopperPattern', 'unitRatio', 'tonnageRatio', 'recommendation', 'targetNi', 'tolerance']) {
      assert.equal(forbidden in result, false, `result must not contain ${forbidden}`);
    }
  });
});

describe('Contractor -- retained but never affects math (this task\'s Contractor revision)', () => {
  test('A. Contractor is retained on each pile result', () => {
    const result = calculateWeightedBlend([{ pileId: 'Pile A', contractor: 'SMA', ni: 1.3, units: 10, tonnesPerUnit: 50 }]);
    assert.equal(result.ok, true);
    assert.equal(result.piles[0].contractor, 'SMA');
  });

  test('B. weighted Ni is identical regardless of Contractor values (SMA/TII vs AAA/BBB)', () => {
    const withRealContractors = calculateWeightedBlend([
      { pileId: 'A', contractor: 'SMA', ni: 1.3, units: 10, tonnesPerUnit: 50 },
      { pileId: 'B', contractor: 'TII', ni: 0.95, units: 20, tonnesPerUnit: 45 },
    ]);
    const withOtherContractors = calculateWeightedBlend([
      { pileId: 'A', contractor: 'AAA', ni: 1.3, units: 10, tonnesPerUnit: 50 },
      { pileId: 'B', contractor: 'BBB', ni: 0.95, units: 20, tonnesPerUnit: 45 },
    ]);
    assert.equal(withRealContractors.weightedNi, withOtherContractors.weightedNi);
    assert.equal(withRealContractors.totalTonnage, withOtherContractors.totalTonnage);
    assert.equal(withRealContractors.totalUnits, withOtherContractors.totalUnits);
    closeTo(withRealContractors.weightedNi, 1.075);
  });

  test('Contractor has zero effect on ore-class totals or Higher Grade grouping', () => {
    const a = calculateWeightedBlend([{ pileId: 'A', contractor: 'SMA', ni: 1.5, units: 2, tonnesPerUnit: 50 }]);
    const b = calculateWeightedBlend([{ pileId: 'A', contractor: 'ZZZ', ni: 1.5, units: 2, tonnesPerUnit: 50 }]);
    assert.deepEqual(a.classes, b.classes);
    assert.deepEqual(a.higherGrade, b.higherGrade);
  });
});

describe('tonnageShare -- % of total tonnage per pile', () => {
  test('sums to 1 (100%) across all piles', () => {
    const result = calculateWeightedBlend([
      { pileId: 'A', ni: 1.3, units: 10, tonnesPerUnit: 50 },
      { pileId: 'B', ni: 0.95, units: 20, tonnesPerUnit: 45 },
    ]);
    const totalShare = result.piles.reduce((sum, p) => sum + p.tonnageShare, 0);
    closeTo(totalShare, 1);
  });
});

describe('Pure module contract', () => {
  test('blend-calculator.js imports only the shared classification helper -- no DOM/router/i18n/localStorage', async () => {
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const path = await import('node:path');
    const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
    const source = readFileSync(path.join(root, 'js', 'pages', 'calculate', 'blend-calculator.js'), 'utf8');
    const importLines = source.match(/^import .+$/gm) || [];
    assert.equal(importLines.length, 1);
    assert.match(importLines[0], /ore-classification\.js/);
  });
});
