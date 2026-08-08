// js/pages/calculate/calculate-validation.js tests (V2.4 Phase 2 -- Blend
// Calculator). See
// docs/V2.4_CALCULATE_AND_BLENDING_RECOMMENDATION_ARCHITECTURE.md Section
// 29, and this task's Section 27.
//
// Run with Node's built-in test runner:
//
//   node --test tests/calculate-validation.test.mjs
//
// Every exported function is pure (no DOM/router/i18n/localStorage) and
// returns a stable i18n KEY, never a localized string -- tests assert on
// the key, never on any particular language's wording.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  validatePileId,
  validateContractor,
  validateNi,
  validateUnits,
  validateTonnesPerUnit,
  validatePiles,
  toNumericPile,
  normalizePileIdForComparison,
  normalizeContractorForComparison,
  normalizeSourceIdentity,
  isRowBlank,
} from '../js/pages/calculate/calculate-validation.js';

// Composite Pile ID + Contractor duplicate identity (this task's Owner
// revision): the same Pile ID may legitimately appear more than once as
// long as Contractor differs (e.g. "L30/MRP" and "L30/TII" are distinct
// sources) -- validatePileId()'s signature grew a `contractor` parameter,
// and its `seen` list now holds normalizeSourceIdentity() composites
// rather than bare normalized Pile IDs.
describe('validatePileId()', () => {
  test('empty string -> required, regardless of Contractor', () => {
    assert.equal(validatePileId('', 'SMA'), 'calculate.validation.pileIdRequired');
  });

  test('whitespace-only -> required (trim makes it empty)', () => {
    assert.equal(validatePileId('   ', 'SMA'), 'calculate.validation.pileIdRequired');
  });

  test('null/undefined -> required', () => {
    assert.equal(validatePileId(null, 'SMA'), 'calculate.validation.pileIdRequired');
    assert.equal(validatePileId(undefined, 'SMA'), 'calculate.validation.pileIdRequired');
  });

  test('a normal id -> valid (null) with an empty seen list', () => {
    assert.equal(validatePileId('S13_L02', 'SMA', []), null);
  });

  test('duplicate (exact match: same Pile ID AND same Contractor) -> duplicate error', () => {
    const seen = [normalizeSourceIdentity('S13_L02', 'SMA')];
    assert.equal(validatePileId('S13_L02', 'SMA', seen), 'calculate.validation.pileIdDuplicate');
  });

  test('duplicate case-insensitive on BOTH Pile ID and Contractor -> duplicate error', () => {
    const seen = [normalizeSourceIdentity('S13_L02', 'SMA')];
    assert.equal(validatePileId('s13_L02', 'sma', seen), 'calculate.validation.pileIdDuplicate');
  });

  test('duplicate with outer whitespace on both fields -> duplicate error (trim before compare)', () => {
    const seen = [normalizeSourceIdentity('S13_L02', 'SMA')];
    assert.equal(validatePileId('  S13_L02  ', '  SMA  ', seen), 'calculate.validation.pileIdDuplicate');
  });

  test('same Pile ID but a DIFFERENT Contractor -> NOT a duplicate (Owner-clarified composite identity)', () => {
    const seen = [normalizeSourceIdentity('L30', 'MRP')];
    assert.equal(validatePileId('L30', 'TII', seen), null);
  });

  test('does not rewrite a valid Pile ID beyond what duplicate detection requires', () => {
    assert.equal(normalizePileIdForComparison('  S13_L02  '), 's13_l02');
  });
});

describe('normalizeContractorForComparison() / normalizeSourceIdentity()', () => {
  test('normalizeContractorForComparison trims and case-folds, same as Pile ID', () => {
    assert.equal(normalizeContractorForComparison('  MRP  '), 'mrp');
    assert.equal(normalizeContractorForComparison(null), '');
    assert.equal(normalizeContractorForComparison(undefined), '');
  });

  test('normalizeSourceIdentity is order-sensitive per field but insensitive to case/outer whitespace', () => {
    assert.equal(normalizeSourceIdentity('L30', 'MRP'), normalizeSourceIdentity('  l30  ', '  mrp  '));
  });

  test('normalizeSourceIdentity distinguishes different Pile IDs with the same Contractor', () => {
    assert.notEqual(normalizeSourceIdentity('L30', 'MRP'), normalizeSourceIdentity('L31', 'MRP'));
  });

  test('normalizeSourceIdentity distinguishes the same Pile ID with different Contractors', () => {
    assert.notEqual(normalizeSourceIdentity('L30', 'MRP'), normalizeSourceIdentity('L30', 'TII'));
  });

  test('no accidental collision between a "pileId containing the separator" and a differently-split pair (JSON.stringify encoding is exact)', () => {
    // Guards the encoding choice itself, not just typical inputs.
    assert.notEqual(normalizeSourceIdentity('a|b', 'c'), normalizeSourceIdentity('a', 'b|c'));
  });
});

describe('validateContractor() -- this task\'s Contractor revision', () => {
  test('empty string -> required', () => {
    assert.equal(validateContractor(''), 'calculate.validation.contractorRequired');
  });

  test('whitespace-only -> required (trim makes it empty)', () => {
    assert.equal(validateContractor('   '), 'calculate.validation.contractorRequired');
  });

  test('null/undefined -> required', () => {
    assert.equal(validateContractor(null), 'calculate.validation.contractorRequired');
    assert.equal(validateContractor(undefined), 'calculate.validation.contractorRequired');
  });

  test('a normal contractor name -> valid (null)', () => {
    assert.equal(validateContractor('SMA'), null);
    assert.equal(validateContractor('TII'), null);
    assert.equal(validateContractor('Contractor A'), null);
  });

  test('no whitelist -- any non-blank text is accepted, never auto-corrected or checked against a directory', () => {
    assert.equal(validateContractor('AAA'), null);
    assert.equal(validateContractor('xyz123'), null);
  });
});

describe('validateNi()', () => {
  test('missing (empty/null/undefined) -> required', () => {
    assert.equal(validateNi(''), 'calculate.validation.niRequired');
    assert.equal(validateNi(null), 'calculate.validation.niRequired');
    assert.equal(validateNi(undefined), 'calculate.validation.niRequired');
  });

  test('NaN (non-numeric text) -> invalid', () => {
    assert.equal(validateNi('abc'), 'calculate.validation.niInvalid');
  });

  test('Infinity -> invalid', () => {
    assert.equal(validateNi(Infinity), 'calculate.validation.niInvalid');
    assert.equal(validateNi('Infinity'), 'calculate.validation.niInvalid');
  });

  test('<= 0 -> positive required', () => {
    assert.equal(validateNi(0), 'calculate.validation.niPositive');
    assert.equal(validateNi(-1.2), 'calculate.validation.niPositive');
  });

  test('a valid positive number (string or number) -> valid (null)', () => {
    assert.equal(validateNi('1.18'), null);
    assert.equal(validateNi(1.18), null);
  });

  test('no operational maximum is enforced (no upper bound invented without Owner approval)', () => {
    assert.equal(validateNi(999), null);
  });
});

describe('validateUnits()', () => {
  test('missing -> required', () => {
    assert.equal(validateUnits(''), 'calculate.validation.unitsRequired');
    assert.equal(validateUnits(null), 'calculate.validation.unitsRequired');
    assert.equal(validateUnits(undefined), 'calculate.validation.unitsRequired');
  });

  test('non-numeric -> invalid', () => {
    assert.equal(validateUnits('abc'), 'calculate.validation.unitsInvalid');
  });

  test('Infinity/NaN -> invalid', () => {
    assert.equal(validateUnits(Infinity), 'calculate.validation.unitsInvalid');
    assert.equal(validateUnits(NaN), 'calculate.validation.unitsInvalid');
  });

  test('decimal/non-integer -> integer required', () => {
    assert.equal(validateUnits('10.5'), 'calculate.validation.unitsInteger');
    assert.equal(validateUnits(3.2), 'calculate.validation.unitsInteger');
  });

  test('negative -> non-negative required', () => {
    assert.equal(validateUnits(-1), 'calculate.validation.unitsNonNegative');
  });

  test('valid zero-unit pile is accepted (Blend E: zero units on one pile must not be rejected outright)', () => {
    assert.equal(validateUnits(0), null);
    assert.equal(validateUnits('0'), null);
  });

  test('a normal positive integer -> valid', () => {
    assert.equal(validateUnits(10), null);
    assert.equal(validateUnits('10'), null);
  });
});

describe('validateTonnesPerUnit()', () => {
  test('missing -> required', () => {
    assert.equal(validateTonnesPerUnit(''), 'calculate.validation.tonnesPerUnitRequired');
    assert.equal(validateTonnesPerUnit(null), 'calculate.validation.tonnesPerUnitRequired');
  });

  test('<= 0 -> positive required', () => {
    assert.equal(validateTonnesPerUnit(0), 'calculate.validation.tonnesPerUnitPositive');
    assert.equal(validateTonnesPerUnit(-5), 'calculate.validation.tonnesPerUnitPositive');
  });

  test('Infinity/NaN -> invalid', () => {
    assert.equal(validateTonnesPerUnit(Infinity), 'calculate.validation.tonnesPerUnitInvalid');
    assert.equal(validateTonnesPerUnit('abc'), 'calculate.validation.tonnesPerUnitInvalid');
  });

  test('a valid decimal -> valid', () => {
    assert.equal(validateTonnesPerUnit(45.5), null);
  });
});

describe('toNumericPile()', () => {
  test('converts raw string fields to numbers, trims pileId and contractor', () => {
    assert.deepEqual(toNumericPile({ pileId: '  S13_L02  ', contractor: '  SMA  ', ni: '1.18', units: '10', tonnesPerUnit: '50' }), {
      pileId: 'S13_L02',
      contractor: 'SMA',
      ni: 1.18,
      units: 10,
      tonnesPerUnit: 50,
    });
  });
});

describe('isRowBlank() -- trailing-blank-row detection (Contractor revision)', () => {
  test('F. all five fields empty -> blank', () => {
    assert.equal(isRowBlank({ pileId: '', contractor: '', ni: '', units: '', tonnesPerUnit: '' }), true);
  });

  test('whitespace-only Pile ID and Contractor with everything else empty -> still blank', () => {
    assert.equal(isRowBlank({ pileId: '   ', contractor: '   ', ni: '', units: '', tonnesPerUnit: '' }), true);
  });

  test('Contractor only -> not blank', () => {
    assert.equal(isRowBlank({ pileId: '', contractor: 'SMA', ni: '', units: '', tonnesPerUnit: '' }), false);
  });

  test('Pile ID only -> not blank', () => {
    assert.equal(isRowBlank({ pileId: 'A', contractor: '', ni: '', units: '', tonnesPerUnit: '' }), false);
  });

  test('Ni only -> not blank', () => {
    assert.equal(isRowBlank({ pileId: '', contractor: '', ni: '1.2', units: '', tonnesPerUnit: '' }), false);
  });

  test('Units only -> not blank', () => {
    assert.equal(isRowBlank({ pileId: '', contractor: '', ni: '', units: '10', tonnesPerUnit: '' }), false);
  });

  test('Tonnes/unit only -> not blank', () => {
    assert.equal(isRowBlank({ pileId: '', contractor: '', ni: '', units: '', tonnesPerUnit: '50' }), false);
  });

  test('a literal "0" counts as meaningful content, not blank', () => {
    assert.equal(isRowBlank({ pileId: '', contractor: '', ni: '', units: '0', tonnesPerUnit: '' }), false);
  });

  test('a fully populated row is never blank', () => {
    assert.equal(isRowBlank({ pileId: 'A', contractor: 'SMA', ni: '1.2', units: '10', tonnesPerUnit: '50' }), false);
  });
});

describe('validatePiles() -- whole-blend validation', () => {
  test('a single fully valid pile -> valid, no blend error', () => {
    const { valid, blendError, pileErrors } = validatePiles([{ pileId: 'A', contractor: 'SMA', ni: '1.2', units: '10', tonnesPerUnit: '50' }]);
    assert.equal(valid, true);
    assert.equal(blendError, null);
    assert.deepEqual(pileErrors[0], { pileId: null, contractor: null, ni: null, units: null, tonnesPerUnit: null });
  });

  test('duplicate Pile ID (same Contractor): the FIRST occurrence is never flagged, only later ones are (deterministic order-based rule)', () => {
    const { valid, pileErrors } = validatePiles([
      { pileId: 'S1', contractor: 'SMA', ni: '1.2', units: '10', tonnesPerUnit: '50' },
      { pileId: 's1', contractor: 'SMA', ni: '1.0', units: '5', tonnesPerUnit: '40' },
    ]);
    assert.equal(valid, false);
    assert.equal(pileErrors[0].pileId, null);
    assert.equal(pileErrors[1].pileId, 'calculate.validation.pileIdDuplicate');
  });

  test('same Pile ID, same Contractor, but written with different case in EACH field -- still a duplicate (case folded independently per field)', () => {
    const { valid, pileErrors } = validatePiles([
      { pileId: 'S1', contractor: 'SMA', ni: '1.2', units: '10', tonnesPerUnit: '50' },
      { pileId: 's1', contractor: 'sma', ni: '1.0', units: '5', tonnesPerUnit: '40' },
    ]);
    assert.equal(valid, false);
    assert.equal(pileErrors[1].pileId, 'calculate.validation.pileIdDuplicate');
  });

  test('G. the same Pile ID with DIFFERENT Contractors is now VALID (Owner-clarified composite identity: "L30/MRP" and "L30/TII" are distinct sources)', () => {
    const { valid, pileErrors } = validatePiles([
      { pileId: 'L30', contractor: 'MRP', ni: '1.2', units: '10', tonnesPerUnit: '50' },
      { pileId: 'L30', contractor: 'TII', ni: '1.0', units: '5', tonnesPerUnit: '40' },
    ]);
    assert.equal(valid, true);
    assert.equal(pileErrors[0].pileId, null);
    assert.equal(pileErrors[1].pileId, null);
  });

  test('G2. the same Pile ID with the SAME Contractor is still rejected as a duplicate ("L30/MRP" twice)', () => {
    const { valid, pileErrors } = validatePiles([
      { pileId: 'L30', contractor: 'MRP', ni: '1.2', units: '10', tonnesPerUnit: '50' },
      { pileId: 'L30', contractor: 'MRP', ni: '1.0', units: '5', tonnesPerUnit: '40' },
    ]);
    assert.equal(valid, false);
    assert.equal(pileErrors[0].pileId, null);
    assert.equal(pileErrors[1].pileId, 'calculate.validation.pileIdDuplicate');
  });

  test('G3. duplicate detection on the composite identity is case-insensitive and trims outer whitespace on both fields', () => {
    const { valid, pileErrors } = validatePiles([
      { pileId: 'L30', contractor: 'MRP', ni: '1.2', units: '10', tonnesPerUnit: '50' },
      { pileId: '  l30  ', contractor: '  mrp  ', ni: '1.0', units: '5', tonnesPerUnit: '40' },
    ]);
    assert.equal(valid, false);
    assert.equal(pileErrors[1].pileId, 'calculate.validation.pileIdDuplicate');
  });

  test('G4. the SAME Pile ID appearing under THREE different Contractors is entirely valid (no pairwise false positives)', () => {
    const { valid, pileErrors } = validatePiles([
      { pileId: 'L30', contractor: 'MRP', ni: '1.2', units: '10', tonnesPerUnit: '50' },
      { pileId: 'L30', contractor: 'TII', ni: '1.0', units: '5', tonnesPerUnit: '40' },
      { pileId: 'L30', contractor: 'SMA', ni: '1.1', units: '8', tonnesPerUnit: '45' },
    ]);
    assert.equal(valid, true);
    pileErrors.forEach((e) => assert.equal(e.pileId, null));
  });

  test('a blank Pile ID never falsely triggers a duplicate error against another blank Pile ID -- each independently reports "required"', () => {
    const { pileErrors } = validatePiles([
      { pileId: '', contractor: 'SMA', ni: '1.2', units: '10', tonnesPerUnit: '50' },
      { pileId: '', contractor: 'TII', ni: '1.0', units: '5', tonnesPerUnit: '40' },
    ]);
    assert.equal(pileErrors[0].pileId, 'calculate.validation.pileIdRequired');
    assert.equal(pileErrors[1].pileId, 'calculate.validation.pileIdRequired');
  });

  test('C. missing Contractor on an otherwise-valid row -> invalid', () => {
    const { valid, pileErrors } = validatePiles([{ pileId: 'A', contractor: '', ni: '1.2', units: '10', tonnesPerUnit: '50' }]);
    assert.equal(valid, false);
    assert.equal(pileErrors[0].contractor, 'calculate.validation.contractorRequired');
  });

  test('D. whitespace-only Contractor -> invalid', () => {
    const { valid, pileErrors } = validatePiles([{ pileId: 'A', contractor: '   ', ni: '1.2', units: '10', tonnesPerUnit: '50' }]);
    assert.equal(valid, false);
    assert.equal(pileErrors[0].contractor, 'calculate.validation.contractorRequired');
  });

  test('E. a valid Contractor passes', () => {
    const { valid, pileErrors } = validatePiles([{ pileId: 'A', contractor: 'Contractor A', ni: '1.2', units: '10', tonnesPerUnit: '50' }]);
    assert.equal(valid, true);
    assert.equal(pileErrors[0].contractor, null);
  });

  test('field errors on one pile do not suppress or alter field errors on another', () => {
    const { pileErrors, valid } = validatePiles([
      { pileId: '', contractor: 'SMA', ni: '1.2', units: '10', tonnesPerUnit: '50' },
      { pileId: 'B', contractor: 'TII', ni: '-1', units: '10', tonnesPerUnit: '50' },
    ]);
    assert.equal(valid, false);
    assert.equal(pileErrors[0].pileId, 'calculate.validation.pileIdRequired');
    assert.equal(pileErrors[1].ni, 'calculate.validation.niPositive');
  });

  test('overall blend tonnage = 0 (every pile has 0 units) -> blendError, even though every field is individually valid', () => {
    const { valid, blendError, pileErrors } = validatePiles([
      { pileId: 'A', contractor: 'SMA', ni: '1.2', units: '0', tonnesPerUnit: '50' },
      { pileId: 'B', contractor: 'TII', ni: '1.0', units: '0', tonnesPerUnit: '40' },
    ]);
    assert.equal(valid, false);
    assert.equal(blendError, 'calculate.validation.noPositiveTonnage');
    assert.deepEqual(pileErrors[0], { pileId: null, contractor: null, ni: null, units: null, tonnesPerUnit: null });
  });

  test('the blend-level tonnage check never fires merely because a field was left blank -- only once every pile is individually valid', () => {
    const { blendError } = validatePiles([{ pileId: '', contractor: '', ni: '', units: '', tonnesPerUnit: '' }]);
    assert.equal(blendError, null);
  });

  test('a mix of a zero-unit pile and a contributing pile is valid overall (Blend E)', () => {
    const { valid, blendError } = validatePiles([
      { pileId: 'A', contractor: 'SMA', ni: '1.3', units: '0', tonnesPerUnit: '50' },
      { pileId: 'B', contractor: 'TII', ni: '1.0', units: '10', tonnesPerUnit: '50' },
    ]);
    assert.equal(valid, true);
    assert.equal(blendError, null);
  });
});
