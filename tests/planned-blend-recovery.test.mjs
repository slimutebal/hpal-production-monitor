// js/pages/calculate/planned-blend-recovery.js tests (V2.4 Phase 6 --
// Planned Blend Recovery / New Dome Requirement). See
// docs/V2.4_CALCULATE_AND_BLENDING_RECOMMENDATION_ARCHITECTURE.md Sections
// 24-26, and this task's Sections 1/3-6/12-17/24-25.
//
// Run with Node's built-in test runner:
//
//   node --test tests/planned-blend-recovery.test.mjs
//
// Pure-module tests only -- no DOM, no i18n resolution (validators return
// i18n KEYS, asserted as keys, never localized strings). UI-level Recovery
// behavior (baseline sourcing, invalidation, explicit-action gating,
// rendering) lives in tests/calculate-page.test.mjs.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  validateAddedUnits,
  validateRecoveryTonnesPerUnit,
  calculateRequiredNewDomeNi,
  findQualifyingSources,
} from '../js/pages/calculate/planned-blend-recovery.js';

/* ============================================================
   A-D. FORMULA -- reference example + variations (this task's Section 24
   A-D). Reference: Current 1.085%/1000t, Target 1.120%, 5 DT x 50 t/DT ->
   AddedTonnage 250t -> RequiredNi = (1.120*1250 - 1.085*1000)/250 =
   315/250 = 1.260% (mandatory regression value).
============================================================ */
describe('24A-D. calculateRequiredNewDomeNi() -- formula', () => {
  test('A. reference example: 1.085%/1000t current, 1.120% target, 5 DT x 50 t/DT -> requiredNi ~= 1.260%', () => {
    const result = calculateRequiredNewDomeNi({
      currentNi: 1.085,
      currentTonnage: 1000,
      targetNi: 1.120,
      addedUnits: 5,
      tonnesPerUnit: 50,
    });
    assert.equal(result.ok, true);
    assert.equal(result.addedTonnage, 250);
    assert.equal(result.requiredNi.toFixed(3), '1.260');
  });

  test('B. different Added DT (10 instead of 5) changes AddedTonnage and requiredNi', () => {
    const result = calculateRequiredNewDomeNi({
      currentNi: 1.085,
      currentTonnage: 1000,
      targetNi: 1.120,
      addedUnits: 10,
      tonnesPerUnit: 50,
    });
    assert.equal(result.ok, true);
    assert.equal(result.addedTonnage, 500);
    assert.equal(result.requiredNi.toFixed(3), '1.190');
  });

  test('C. different Tonnes/DT (100 instead of 50) changes AddedTonnage and requiredNi', () => {
    const result = calculateRequiredNewDomeNi({
      currentNi: 1.085,
      currentTonnage: 1000,
      targetNi: 1.120,
      addedUnits: 5,
      tonnesPerUnit: 100,
    });
    assert.equal(result.ok, true);
    assert.equal(result.addedTonnage, 500);
    assert.equal(result.requiredNi.toFixed(3), '1.190');
  });

  test('D. decimal Tonnes/DT (45.5) is accepted and computed at full precision', () => {
    const result = calculateRequiredNewDomeNi({
      currentNi: 1.085,
      currentTonnage: 1000,
      targetNi: 1.120,
      addedUnits: 5,
      tonnesPerUnit: 45.5,
    });
    assert.equal(result.ok, true);
    assert.equal(result.addedTonnage, 227.5);
    const expected = (1.120 * (1000 + 227.5) - 1.085 * 1000) / 227.5;
    assert.equal(result.requiredNi, expected);
  });
});

/* ============================================================
   E-I. VALIDATION -- Added DT integer > 0; Tonnes/DT finite > 0; never
   silently Infinity/NaN (this task's Section 5/24 E-I).
============================================================ */
describe('24E-I. calculateRequiredNewDomeNi() / validators -- rejection', () => {
  const baseline = { currentNi: 1.085, currentTonnage: 1000, targetNi: 1.120 };

  test('E. Added DT = 0 is rejected (never a silent Infinity/NaN AddedTonnage)', () => {
    assert.equal(validateAddedUnits(0), 'calculate.validation.recoveryAddedUnitsPositive');
    const result = calculateRequiredNewDomeNi({ ...baseline, addedUnits: 0, tonnesPerUnit: 50 });
    assert.equal(result.ok, false);
    assert.equal(result.error, 'INVALID_INPUT');
    assert.equal(result.addedUnitsError, 'calculate.validation.recoveryAddedUnitsPositive');
  });

  test('E. Added DT negative is rejected', () => {
    assert.equal(validateAddedUnits(-3), 'calculate.validation.recoveryAddedUnitsPositive');
    const result = calculateRequiredNewDomeNi({ ...baseline, addedUnits: -3, tonnesPerUnit: 50 });
    assert.equal(result.ok, false);
    assert.equal(result.addedUnitsError, 'calculate.validation.recoveryAddedUnitsPositive');
  });

  test('G. Added DT fractional (2.5) is rejected -- must be a whole number', () => {
    assert.equal(validateAddedUnits(2.5), 'calculate.validation.recoveryAddedUnitsInteger');
    const result = calculateRequiredNewDomeNi({ ...baseline, addedUnits: 2.5, tonnesPerUnit: 50 });
    assert.equal(result.ok, false);
    assert.equal(result.addedUnitsError, 'calculate.validation.recoveryAddedUnitsInteger');
  });

  test('H. Tonnes/DT = 0 is rejected', () => {
    assert.equal(validateRecoveryTonnesPerUnit(0), 'calculate.validation.recoveryTonnesPerUnitPositive');
    const result = calculateRequiredNewDomeNi({ ...baseline, addedUnits: 5, tonnesPerUnit: 0 });
    assert.equal(result.ok, false);
    assert.equal(result.tonnesPerUnitError, 'calculate.validation.recoveryTonnesPerUnitPositive');
  });

  test('H. Tonnes/DT negative is rejected', () => {
    assert.equal(validateRecoveryTonnesPerUnit(-10), 'calculate.validation.recoveryTonnesPerUnitPositive');
    const result = calculateRequiredNewDomeNi({ ...baseline, addedUnits: 5, tonnesPerUnit: -10 });
    assert.equal(result.ok, false);
    assert.equal(result.tonnesPerUnitError, 'calculate.validation.recoveryTonnesPerUnitPositive');
  });

  test('I. non-numeric Added DT ("abc") is rejected as invalid, not coerced to 0/NaN', () => {
    assert.equal(validateAddedUnits('abc'), 'calculate.validation.recoveryAddedUnitsInvalid');
    const result = calculateRequiredNewDomeNi({ ...baseline, addedUnits: 'abc', tonnesPerUnit: 50 });
    assert.equal(result.ok, false);
    assert.equal(result.addedUnitsError, 'calculate.validation.recoveryAddedUnitsInvalid');
  });

  test('I. Infinity Tonnes/DT is rejected, never silently propagated', () => {
    assert.equal(validateRecoveryTonnesPerUnit(Infinity), 'calculate.validation.recoveryTonnesPerUnitInvalid');
    const result = calculateRequiredNewDomeNi({ ...baseline, addedUnits: 5, tonnesPerUnit: Infinity });
    assert.equal(result.ok, false);
    assert.equal(result.tonnesPerUnitError, 'calculate.validation.recoveryTonnesPerUnitInvalid');
  });

  test('I. NaN Added DT is rejected', () => {
    assert.equal(validateAddedUnits(NaN), 'calculate.validation.recoveryAddedUnitsInvalid');
  });

  test('empty/missing Added DT and Tonnes/DT are rejected as required, not coerced', () => {
    assert.equal(validateAddedUnits(''), 'calculate.validation.recoveryAddedUnitsRequired');
    assert.equal(validateAddedUnits(null), 'calculate.validation.recoveryAddedUnitsRequired');
    assert.equal(validateRecoveryTonnesPerUnit(''), 'calculate.validation.recoveryTonnesPerUnitRequired');
  });
});

/* ============================================================
   J-K. NO PREMATURE ROUNDING / DETERMINISM (this task's Section 24 J-K).
============================================================ */
describe('24J-K. calculateRequiredNewDomeNi() -- precision and determinism', () => {
  test('J. requiredNi is never rounded before being returned (full float precision preserved)', () => {
    const result = calculateRequiredNewDomeNi({
      currentNi: 1.085,
      currentTonnage: 1000,
      targetNi: 1.120,
      addedUnits: 5,
      tonnesPerUnit: 50,
    });
    // The reference example's exact IEEE-754 result is NOT the clean
    // decimal 1.26 -- if this module rounded internally, this assertion
    // would fail (result.requiredNi would equal exactly 1.26).
    assert.notEqual(result.requiredNi, 1.26);
    assert.equal(result.requiredNi, (1.120 * 1250 - 1.085 * 1000) / 250);
  });

  test('K. repeated calls with identical input produce the identical result', () => {
    const input = { currentNi: 1.085, currentTonnage: 1000, targetNi: 1.120, addedUnits: 5, tonnesPerUnit: 50 };
    const first = calculateRequiredNewDomeNi(input);
    const second = calculateRequiredNewDomeNi({ ...input });
    assert.equal(first.requiredNi, second.requiredNi);
  });
});

/* ============================================================
   25.1-3/8. AVAILABLE SOURCE MATCHING -- below/equal/above minimum, empty
   list (this task's Section 25/26 tests 1-3/8).
============================================================ */
function matchSource(overrides) {
  return { pileId: 'A', contractor: 'SMA', oreClass: 'HGLO', ni: 1.30, units: 5, ...overrides };
}

describe('25.1-3/8. findQualifyingSources() -- minimum-Ni filtering', () => {
  test('1. a source below the minimum Ni is excluded', () => {
    const sources = [matchSource({ pileId: 'A', ni: 1.20 })];
    assert.deepEqual(findQualifyingSources(sources, 1.260), []);
  });

  test('2. a source exactly equal to the minimum Ni is included (>=, not >)', () => {
    const sources = [matchSource({ pileId: 'A', ni: 1.260 })];
    const result = findQualifyingSources(sources, 1.260);
    assert.equal(result.length, 1);
    assert.equal(result[0].pileId, 'A');
  });

  test('3. a source above the minimum Ni is included', () => {
    const sources = [matchSource({ pileId: 'A', ni: 1.50 })];
    const result = findQualifyingSources(sources, 1.260);
    assert.equal(result.length, 1);
  });

  test('8. an empty qualifying list is returned when no source meets the minimum', () => {
    const sources = [matchSource({ pileId: 'A', ni: 1.00 }), matchSource({ pileId: 'B', ni: 1.10 })];
    assert.deepEqual(findQualifyingSources(sources, 1.260), []);
  });
});

/* ============================================================
   25.4. UNROUNDED COMPARISON -- a source whose Ni is a hair below the
   requiredNi at full precision must NOT qualify, even if both would
   round to the same displayed value (this task's Section 25 test 4).
============================================================ */
describe('25.4. findQualifyingSources() -- full-precision comparison, never rounded first', () => {
  test('a source 0.0005 below the unrounded requiredNi is excluded even though both round to the same 3-decimal display', () => {
    const requiredNi = 1.2601; // would display as 1.260%
    const sources = [matchSource({ pileId: 'A', ni: 1.2599 })]; // also displays as 1.260%, but is numerically lower
    assert.deepEqual(findQualifyingSources(sources, requiredNi), []);
  });

  test('a source exactly at the unrounded requiredNi (from the real reference-example computation) qualifies', () => {
    const { requiredNi } = calculateRequiredNewDomeNi({
      currentNi: 1.085, currentTonnage: 1000, targetNi: 1.120, addedUnits: 5, tonnesPerUnit: 50,
    });
    const sources = [matchSource({ pileId: 'A', ni: requiredNi })];
    const result = findQualifyingSources(sources, requiredNi);
    assert.equal(result.length, 1);
  });
});

/* ============================================================
   25.5. SAME PILE ID, DIFFERENT CONTRACTOR -- distinct entries, each
   evaluated independently (this task's Section 25 test 5).
============================================================ */
describe('25.5. findQualifyingSources() -- same Pile ID, different Contractor are separate sources', () => {
  test('one contractor qualifies and the other does not, despite sharing a Pile ID', () => {
    const sources = [
      matchSource({ pileId: 'PILE-1', contractor: 'Contractor A', ni: 1.50 }),
      matchSource({ pileId: 'PILE-1', contractor: 'Contractor B', ni: 1.00 }),
    ];
    const result = findQualifyingSources(sources, 1.260);
    assert.equal(result.length, 1);
    assert.equal(result[0].contractor, 'Contractor A');
  });
});

/* ============================================================
   25.6-7. DETERMINISTIC ORDERING -- lowest qualifying Ni first, then
   Contractor, then Pile ID -- NEVER highest-Ni-first (this task's Section
   15/25 tests 6-7).
============================================================ */
describe('25.6-7. findQualifyingSources() -- deterministic ordering, never highest-Ni-first', () => {
  test('6-7. results are ordered lowest-qualifying-Ni-first, even when the input array lists a higher-Ni source first', () => {
    const sources = [
      matchSource({ pileId: 'HIGH', contractor: 'Z Co', ni: 1.80 }),
      matchSource({ pileId: 'LOW', contractor: 'A Co', ni: 1.30 }),
      matchSource({ pileId: 'MID', contractor: 'M Co', ni: 1.50 }),
    ];
    const result = findQualifyingSources(sources, 1.260);
    assert.deepEqual(result.map((s) => s.pileId), ['LOW', 'MID', 'HIGH']);
    // Explicit negative proof: the highest-Ni source is NOT first.
    assert.notEqual(result[0].pileId, 'HIGH');
  });

  test('equal-Ni sources tie-break by normalized Contractor, then normalized Pile ID', () => {
    const sources = [
      matchSource({ pileId: 'B', contractor: 'zeta', ni: 1.30 }),
      matchSource({ pileId: 'A', contractor: 'alpha', ni: 1.30 }),
      matchSource({ pileId: 'A', contractor: 'alpha ', ni: 1.30, oreClass: 'LGLO' }), // same normalized Contractor, tie-break by Pile ID
      matchSource({ pileId: 'B', contractor: 'alpha', ni: 1.30 }),
    ];
    const result = findQualifyingSources(sources, 1.260);
    // alpha/A ties (two of them) sort before alpha/B, which sorts before zeta/B.
    assert.deepEqual(result.map((s) => `${s.contractor.trim().toLowerCase()}|${s.pileId}`), ['alpha|A', 'alpha|A', 'alpha|B', 'zeta|B']);
  });
});
