// js/pages/calculate/blending-recommendation.js tests (V2.4 Phase 3 --
// Recommendation engine). See
// docs/V2.4_CALCULATE_AND_BLENDING_RECOMMENDATION_ARCHITECTURE.md Sections
// 12-31/36-37, and this task's Sections 3-19/23-34/37.
//
// Run with Node's built-in test runner:
//
//   node --test tests/blending-recommendation.test.mjs
//
// Full end-to-end search+ranking scenarios (the architecture doc's own
// worked numbers wherever available). Ranking-RULE-isolation tests live in
// tests/recommendation-ranking.test.mjs; fleet-allocation primitive tests
// live in tests/fleet-allocation.test.mjs.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  DEFAULT_RECOMMENDATION_TOLERANCE,
  validateTargetNi,
  validateTolerance,
  validateRecommendationSources,
  isWithinTolerance,
  findBlendRecommendations,
} from '../js/pages/calculate/blending-recommendation.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

function closeTo(actual, expected, epsilon = 1e-9) {
  assert.ok(Math.abs(actual - expected) < epsilon, `expected ${actual} to be close to ${expected}`);
}

// ============================================================
// TOLERANCE (this task's Section 15-16/33)
// ============================================================
describe('DEFAULT_RECOMMENDATION_TOLERANCE (Gate A default)', () => {
  test('exported default is exactly 0.010', () => {
    assert.equal(DEFAULT_RECOMMENDATION_TOLERANCE, 0.010);
  });
});

describe('validateTargetNi()', () => {
  test('missing -> required', () => {
    assert.equal(validateTargetNi(''), 'calculate.validation.targetNiRequired');
    assert.equal(validateTargetNi(null), 'calculate.validation.targetNiRequired');
    assert.equal(validateTargetNi(undefined), 'calculate.validation.targetNiRequired');
  });

  test('non-finite -> invalid', () => {
    assert.equal(validateTargetNi('abc'), 'calculate.validation.targetNiInvalid');
    assert.equal(validateTargetNi(Infinity), 'calculate.validation.targetNiInvalid');
  });

  test('<= 0 -> positive required', () => {
    assert.equal(validateTargetNi(0), 'calculate.validation.targetNiPositive');
    assert.equal(validateTargetNi(-1.12), 'calculate.validation.targetNiPositive');
  });

  test('no invented operational maximum', () => {
    assert.equal(validateTargetNi(999), null);
  });

  test('a normal value -> valid', () => {
    assert.equal(validateTargetNi(1.12), null);
    assert.equal(validateTargetNi('1.12'), null);
  });
});

describe('validateTolerance()', () => {
  test('missing -> required', () => {
    assert.equal(validateTolerance(''), 'calculate.validation.toleranceRequired');
    assert.equal(validateTolerance(null), 'calculate.validation.toleranceRequired');
  });

  test('non-finite (NaN/Infinity) -> invalid', () => {
    assert.equal(validateTolerance(NaN), 'calculate.validation.toleranceInvalid');
    assert.equal(validateTolerance(Infinity), 'calculate.validation.toleranceInvalid');
    assert.equal(validateTolerance('abc'), 'calculate.validation.toleranceInvalid');
  });

  test('negative -> rejected', () => {
    assert.equal(validateTolerance(-0.001), 'calculate.validation.toleranceNonNegative');
  });

  test('zero is VALID (exact-Target-only, this task\'s Section 16)', () => {
    assert.equal(validateTolerance(0), null);
  });

  test('the approved default (0.010) is valid', () => {
    assert.equal(validateTolerance(0.010), null);
  });
});

describe('isWithinTolerance() -- inclusive boundary comparison at full precision (this task\'s Section 15/33)', () => {
  test('exactly the lower boundary is accepted', () => {
    assert.equal(isWithinTolerance(1.110, 1.120, 0.010), true);
  });

  test('exactly the upper boundary is accepted', () => {
    assert.equal(isWithinTolerance(1.130, 1.120, 0.010), true);
  });

  test('immediately outside the lower boundary is rejected', () => {
    assert.equal(isWithinTolerance(1.1099, 1.120, 0.010), false);
  });

  test('immediately outside the upper boundary is rejected', () => {
    assert.equal(isWithinTolerance(1.1301, 1.120, 0.010), false);
  });

  test('tolerance = 0 accepts only an exact match', () => {
    assert.equal(isWithinTolerance(1.120, 1.120, 0), true);
    assert.equal(isWithinTolerance(1.1201, 1.120, 0), false);
  });

  test('no display rounding is used -- a value that would round INTO tolerance at 3dp is still correctly rejected', () => {
    // 1.1309999 rounds to 1.131 at typical display precision but must be
    // evaluated at full internal precision against tolerance 0.010.
    assert.equal(isWithinTolerance(1.1309999, 1.120, 0.010), false);
  });
});

// ============================================================
// SOURCE VALIDATION (this task's Section 34)
// ============================================================
describe('validateRecommendationSources()', () => {
  const validSource = { pileId: 'A', contractor: 'SMA', ni: '1.2', units: '5', tonnesPerUnit: '50' };

  test('a single fully valid source -> valid', () => {
    const { valid, sourceErrors, fleetError } = validateRecommendationSources([validSource]);
    assert.equal(valid, true);
    assert.equal(fleetError, null);
    assert.deepEqual(sourceErrors[0], { pileId: null, contractor: null, ni: null, units: null, tonnesPerUnit: null });
  });

  test('missing Pile ID -> rejected', () => {
    const { valid, sourceErrors } = validateRecommendationSources([{ ...validSource, pileId: '' }]);
    assert.equal(valid, false);
    assert.equal(sourceErrors[0].pileId, 'calculate.validation.pileIdRequired');
  });

  test('missing Contractor -> rejected', () => {
    const { valid, sourceErrors } = validateRecommendationSources([{ ...validSource, contractor: '' }]);
    assert.equal(valid, false);
    assert.equal(sourceErrors[0].contractor, 'calculate.validation.contractorRequired');
  });

  test('Ni <= 0 -> rejected', () => {
    const { valid, sourceErrors } = validateRecommendationSources([{ ...validSource, ni: '0' }]);
    assert.equal(valid, false);
    assert.equal(sourceErrors[0].ni, 'calculate.validation.niPositive');
  });

  test('non-integer units -> rejected (units means physical DT count, this task\'s Section 3)', () => {
    const { valid, sourceErrors } = validateRecommendationSources([{ ...validSource, units: '5.5' }]);
    assert.equal(valid, false);
    assert.equal(sourceErrors[0].units, 'calculate.validation.unitsInteger');
  });

  test('tonnesPerUnit <= 0 -> rejected', () => {
    const { valid, sourceErrors } = validateRecommendationSources([{ ...validSource, tonnesPerUnit: '0' }]);
    assert.equal(valid, false);
    assert.equal(sourceErrors[0].tonnesPerUnit, 'calculate.validation.tonnesPerUnitPositive');
  });

  test('duplicate normalized Pile ID -> rejected on the later occurrence', () => {
    const { valid, sourceErrors } = validateRecommendationSources([
      validSource,
      { ...validSource, pileId: '  a  ' },
    ]);
    assert.equal(valid, false);
    assert.equal(sourceErrors[0].pileId, null);
    assert.equal(sourceErrors[1].pileId, 'calculate.validation.pileIdDuplicate');
  });

  test('every source has zero units -> fleetError (this task\'s Section 34 "at least one physical DT required")', () => {
    const { valid, fleetError } = validateRecommendationSources([{ ...validSource, units: '0' }]);
    assert.equal(valid, false);
    assert.equal(fleetError, 'calculate.validation.noPhysicalFleet');
  });

  test('at least one source with a positive fleet is enough overall', () => {
    const { valid } = validateRecommendationSources([
      { ...validSource, pileId: 'A', units: '0' },
      { ...validSource, pileId: 'B', units: '5' },
    ]);
    assert.equal(valid, true);
  });
});

// ============================================================
// findBlendRecommendations() -- INPUT VALIDATION WIRING
// ============================================================
describe('findBlendRecommendations() -- invalid input', () => {
  test('invalid Target Ni -> ok:false, error INVALID_INPUT, no search performed', () => {
    const result = findBlendRecommendations({
      targetNi: 0,
      tolerance: 0.01,
      sources: [{ pileId: 'A', contractor: 'SMA', ni: '1.2', units: '5', tonnesPerUnit: '50' }],
    });
    assert.equal(result.ok, false);
    assert.equal(result.error, 'INVALID_INPUT');
    assert.equal(result.targetError, 'calculate.validation.targetNiPositive');
  });

  test('invalid (negative) tolerance -> ok:false, error INVALID_INPUT', () => {
    const result = findBlendRecommendations({
      targetNi: 1.12,
      tolerance: -0.01,
      sources: [{ pileId: 'A', contractor: 'SMA', ni: '1.2', units: '5', tonnesPerUnit: '50' }],
    });
    assert.equal(result.ok, false);
    assert.equal(result.error, 'INVALID_INPUT');
    assert.equal(result.toleranceError, 'calculate.validation.toleranceNonNegative');
  });

  test('invalid sources -> ok:false, error INVALID_INPUT, sourceErrors populated', () => {
    const result = findBlendRecommendations({
      targetNi: 1.12,
      tolerance: 0.01,
      sources: [{ pileId: '', contractor: 'SMA', ni: '1.2', units: '5', tonnesPerUnit: '50' }],
    });
    assert.equal(result.ok, false);
    assert.equal(result.error, 'INVALID_INPUT');
    assert.equal(result.sourceErrors[0].pileId, 'calculate.validation.pileIdRequired');
  });

  test('tolerance omitted uses the exported default', () => {
    const result = findBlendRecommendations({
      targetNi: 1.2,
      sources: [{ pileId: 'A', contractor: 'SMA', ni: '1.2', units: '5', tonnesPerUnit: '50' }],
    });
    assert.equal(result.ok, true);
    assert.equal(result.tolerance, DEFAULT_RECOMMENDATION_TOLERANCE);
  });
});

describe('findBlendRecommendations() -- search-space safety bound (this task\'s Section 19)', () => {
  test('a pathologically large single-source fleet returns an explicit SEARCH_SPACE_TOO_LARGE status, never a silent truncation', () => {
    const result = findBlendRecommendations({
      targetNi: 1.2,
      tolerance: 0.01,
      sources: [{ pileId: 'A', contractor: 'SMA', ni: '1.2', units: '25000', tonnesPerUnit: '50' }],
    });
    assert.equal(result.ok, false);
    assert.equal(result.error, 'SEARCH_SPACE_TOO_LARGE');
  });
});

// ============================================================
// 24. KNOWN FLEET EXAMPLE -- 5 Higher Grade DT / 8 LGLO DT
// ============================================================
describe('24. Known fleet example -- 5 HG DT / 8 LGLO DT, target 1.120 +/- 0.010', () => {
  const sources = [
    { pileId: 'Higher', contractor: 'ContractorA', ni: '1.30', units: '5', tonnesPerUnit: '50' },
    { pileId: 'Lglo', contractor: 'ContractorB', ni: '1.03', units: '8', tonnesPerUnit: '50' },
  ];

  test('selects Higher active=4, LGLO active=8, Estimated Ni exactly 1.120, 12/13 fleet active', () => {
    const result = findBlendRecommendations({ targetNi: 1.120, tolerance: 0.010, sources });
    assert.equal(result.ok, true);
    assert.equal(result.status, 'OK');

    const { candidate } = result;
    assert.equal(candidate.withinTolerance, true);
    closeTo(candidate.estimatedNi, 1.120);
    assert.equal(candidate.totalFleetUnits, 13);
    assert.equal(candidate.totalActiveUnits, 12);
    assert.equal(candidate.totalSurplusUnits, 1);
    assert.equal(candidate.higherGradeUnits, 4);
    assert.equal(candidate.lgloUnits, 8);
    assert.deepEqual(candidate.unitRatio, { rawHigher: 4, rawLglo: 8, higher: 1, lglo: 2 });

    const higherSource = candidate.sources.find((s) => s.pileId === 'Higher');
    const lgloSource = candidate.sources.find((s) => s.pileId === 'Lglo');
    assert.equal(higherSource.activeUnits, 4, 'raw source-level allocation stays 4, never overwritten by the simplified 1:2 ratio');
    assert.equal(lgloSource.activeUnits, 8);
    assert.equal(higherSource.standbyUnits, 1, 'the un-forced 5th Higher Grade DT is surfaced as standby, never pushed into the blend');
  });

  test('16. the surplus DT is never forced into the pattern merely to claim full utilization', () => {
    const result = findBlendRecommendations({ targetNi: 1.120, tolerance: 0.010, sources });
    // The full-fleet (5,8) allocation computes to ~1.1338, outside
    // tolerance -- it must NOT be the selected candidate.
    assert.notEqual(result.candidate.totalActiveUnits, 13);
  });

  test('14. highest Ni alone is not automatically selected (pure-HGLO 1.30 is outside tolerance and loses)', () => {
    const result = findBlendRecommendations({ targetNi: 1.120, tolerance: 0.010, sources });
    assert.notEqual(result.candidate.estimatedNi, 1.30);
    assert.notEqual(result.candidate.lgloUnits, 0);
  });

  test('27. different Contractors blend freely in one candidate (Contractor boundary only limits fleet, not material)', () => {
    const result = findBlendRecommendations({ targetNi: 1.120, tolerance: 0.010, sources });
    const contractors = new Set(result.candidate.sources.map((s) => s.contractor));
    assert.ok(contractors.has('ContractorA') && contractors.has('ContractorB'));
    assert.equal(result.candidate.relocations.length, 0, 'no relocation is possible/needed across different Contractors');
  });

  test('11. integer allocations only', () => {
    const result = findBlendRecommendations({ targetNi: 1.120, tolerance: 0.010, sources });
    result.candidate.sources.forEach((s) => assert.ok(Number.isInteger(s.activeUnits)));
  });
});

// ============================================================
// 25. SAME-CONTRACTOR RELOCATION
// ============================================================
describe('25. Same-Contractor relocation -- both sources under SMA', () => {
  const sources = [
    { pileId: 'Higher', contractor: 'SMA', ni: '1.30', units: '5', tonnesPerUnit: '50' },
    { pileId: 'Lglo', contractor: 'SMA', ni: '1.03', units: '7', tonnesPerUnit: '50' },
  ];

  test('feasible via a 1 DT same-Contractor MOVE -> 12/12 active, 100% utilization, Hopper Pattern 1:2, Ni 1.120', () => {
    const result = findBlendRecommendations({ targetNi: 1.120, tolerance: 0.010, sources });
    assert.equal(result.ok, true);
    assert.equal(result.status, 'OK');

    const { candidate } = result;
    closeTo(candidate.estimatedNi, 1.120);
    assert.equal(candidate.totalFleetUnits, 12);
    assert.equal(candidate.totalActiveUnits, 12);
    assert.equal(candidate.fleetUtilization, 1);
    assert.equal(candidate.totalSurplusUnits, 0);
    assert.deepEqual(candidate.unitRatio, { rawHigher: 4, rawLglo: 8, higher: 1, lglo: 2 });
    assert.deepEqual(candidate.relocations, [{ contractor: 'SMA', fromPileId: 'Higher', toPileId: 'Lglo', units: 1 }]);

    const higherSource = candidate.sources.find((s) => s.pileId === 'Higher');
    const lgloSource = candidate.sources.find((s) => s.pileId === 'Lglo');
    assert.equal(higherSource.assignedUnits, 5);
    assert.equal(higherSource.activeUnits, 4);
    assert.equal(higherSource.moveOutUnits, 1);
    assert.equal(lgloSource.assignedUnits, 7);
    assert.equal(lgloSource.activeUnits, 8);
    assert.equal(lgloSource.moveInUnits, 1);
  });
});

// ============================================================
// 26. CROSS-CONTRACTOR NEGATIVE TEST
// ============================================================
describe('26. Cross-Contractor negative test -- Higher under SMA, LGLO under TII (assigned 7)', () => {
  const sources = [
    { pileId: 'Higher', contractor: 'SMA', ni: '1.30', units: '5', tonnesPerUnit: '50' },
    { pileId: 'Lglo', contractor: 'TII', ni: '1.03', units: '7', tonnesPerUnit: '50' },
  ];

  test('TII\'s active LGLO fleet is capped at its own 7 DT -- never inflated to 8 by borrowing from SMA', () => {
    const result = findBlendRecommendations({ targetNi: 1.120, tolerance: 0.010, sources });
    assert.equal(result.ok, true);
    assert.ok(result.candidate.lgloUnits <= 7, 'LGLO active units must never exceed TII\'s own assigned fleet');
    assert.notEqual(result.candidate.lgloUnits, 8, 'the (4,8) solution from the same-numbers same-Contractor case is infeasible here');
  });

  test('no relocation is ever produced between the two Contractors', () => {
    const result = findBlendRecommendations({ targetNi: 1.120, tolerance: 0.010, sources });
    assert.equal(result.candidate.relocations.length, 0);
  });

  test('the engine still finds a legal within-tolerance candidate (4 Higher / 7 LGLO, Ni ~1.1282)', () => {
    const result = findBlendRecommendations({ targetNi: 1.120, tolerance: 0.010, sources });
    assert.equal(result.status, 'OK');
    assert.equal(result.candidate.higherGradeUnits, 4);
    assert.equal(result.candidate.lgloUnits, 7);
    closeTo(result.candidate.estimatedNi, 620.5 / 550, 1e-9);
  });
});

// ============================================================
// 28. DIFFERENT TONNES/DT
// ============================================================
describe('28. Different tonnes/DT -- Estimated Ni and Tonnage Ratio use actual tonnage (architecture doc Section 13/19)', () => {
  const sources = [
    { pileId: 'Higher', contractor: 'HigherCo', ni: '1.50', units: '1', tonnesPerUnit: '50' },
    { pileId: 'Lglo', contractor: 'LgloCo', ni: '1.00', units: '2', tonnesPerUnit: '45' },
  ];

  test('matches the architecture doc\'s own 1:2 / 50t:90t worked example exactly', () => {
    const result = findBlendRecommendations({ targetNi: 1.15, tolerance: 0.1, sources });
    assert.equal(result.ok, true);
    const { candidate } = result;

    assert.equal(candidate.totalActiveUnits, 3, 'the full 1+2 fleet is used (only candidate at max utilization)');
    assert.deepEqual(candidate.unitRatio, { rawHigher: 1, rawLglo: 2, higher: 1, lglo: 2 });
    closeTo(candidate.higherGradeTonnage, 50);
    closeTo(candidate.lgloTonnage, 90);
    closeTo(candidate.tonnageRatio.higher, 50 / 140);
    closeTo(candidate.tonnageRatio.lglo, 90 / 140);
    // Must NOT be the (wrong) unit-ratio-derived 33.3%/66.7%.
    assert.notEqual(Number(candidate.tonnageRatio.higher.toFixed(3)), Number((1 / 3).toFixed(3)));
    closeTo(candidate.estimatedNi, (1.5 * 50 + 1.0 * 90) / 140);
  });
});

// ============================================================
// EXACT TARGET ACHIEVABLE / TOLERANCE = 0
// ============================================================
describe('Exact Target achievable, tolerance = 0 (this task\'s Section 16)', () => {
  test('a single-source blend at exactly the target Ni is accepted with zero tolerance, and full fleet wins', () => {
    const result = findBlendRecommendations({
      targetNi: 1.15,
      tolerance: 0,
      sources: [{ pileId: 'A', contractor: 'S', ni: '1.15', units: '4', tonnesPerUnit: '50' }],
    });
    assert.equal(result.ok, true);
    assert.equal(result.status, 'OK');
    closeTo(result.candidate.estimatedNi, 1.15);
    assert.equal(result.candidate.absoluteDeviation, 0);
    assert.equal(result.candidate.totalActiveUnits, 4, 'maximizes fleet utilization among the (all Ni-identical) exact-match candidates');
  });
});

describe('Target achievable only inside tolerance (not an exact match) -- architecture doc Section 37 test 2', () => {
  test('best candidate is the full-fleet allocation, landing inside tolerance without an exact hit', () => {
    const result = findBlendRecommendations({
      targetNi: 1.10,
      tolerance: 0.02,
      sources: [
        { pileId: 'Higher', contractor: 'H', ni: '1.25', units: '3', tonnesPerUnit: '50' },
        { pileId: 'Lglo', contractor: 'L', ni: '1.00', units: '5', tonnesPerUnit: '50' },
      ],
    });
    assert.equal(result.ok, true);
    assert.equal(result.status, 'OK');
    assert.equal(result.candidate.totalActiveUnits, 8);
    assert.equal(result.candidate.fleetUtilization, 1);
    closeTo(result.candidate.estimatedNi, 8.75 / 8);
    assert.notEqual(result.candidate.absoluteDeviation, 0, 'this scenario is within tolerance but deliberately not an exact match');
  });
});

// ============================================================
// 31. TARGET NOT ACHIEVABLE
// ============================================================
describe('31. Target Not Achievable', () => {
  const sources = [
    { pileId: 'Higher', contractor: 'X', ni: '2.00', units: '5', tonnesPerUnit: '50' },
    { pileId: 'Lglo', contractor: 'Y', ni: '0.10', units: '5', tonnesPerUnit: '50' },
  ];

  test('status is TARGET_NOT_ACHIEVABLE, never disguised as a successful OK result', () => {
    const result = findBlendRecommendations({ targetNi: 5.00, tolerance: 0.01, sources });
    assert.equal(result.ok, true);
    assert.equal(result.status, 'TARGET_NOT_ACHIEVABLE');
    assert.equal(result.candidate.withinTolerance, false);
  });

  test('best-attainable candidate minimizes absolute deviation first (pure HGLO, since Ni can never approach 5.00 otherwise)', () => {
    const result = findBlendRecommendations({ targetNi: 5.00, tolerance: 0.01, sources });
    closeTo(result.candidate.estimatedNi, 2.00);
    assert.equal(result.candidate.higherGradeUnits, 5);
    assert.equal(result.candidate.lgloUnits, 0);
    assert.deepEqual(result.candidate.unitRatio, { rawHigher: 5, rawLglo: 0, higher: 1, lglo: 0 });
    closeTo(result.bestAttainableNi, 2.00);
    closeTo(result.gap, 2.00 - 5.00);
    assert.equal(result.targetNi, 5.00);
    assert.equal(result.tolerance, 0.01);
  });
});

// ============================================================
// 32. DETERMINISM / SOURCE-ORDER INDEPENDENCE
// ============================================================
describe('32. Determinism and source-order independence', () => {
  const sourcesA = [
    { pileId: 'Higher', contractor: 'ContractorA', ni: '1.30', units: '5', tonnesPerUnit: '50' },
    { pileId: 'Lglo', contractor: 'ContractorB', ni: '1.03', units: '8', tonnesPerUnit: '50' },
  ];
  const sourcesReversed = [...sourcesA].reverse();

  test('identical inputs produce byte-identical results across repeated calls', () => {
    const r1 = findBlendRecommendations({ targetNi: 1.120, tolerance: 0.010, sources: sourcesA });
    const r2 = findBlendRecommendations({ targetNi: 1.120, tolerance: 0.010, sources: sourcesA });
    assert.equal(JSON.stringify(r1.candidate), JSON.stringify(r2.candidate));
  });

  test('reordering the input sources array does not change the selected candidate', () => {
    const r1 = findBlendRecommendations({ targetNi: 1.120, tolerance: 0.010, sources: sourcesA });
    const r2 = findBlendRecommendations({ targetNi: 1.120, tolerance: 0.010, sources: sourcesReversed });
    assert.equal(JSON.stringify(r1.candidate), JSON.stringify(r2.candidate));
  });
});

// ============================================================
// PHASE 3 NON-GOALS -- Material Action / Recovery / UI must not exist yet
// ============================================================
function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((line) => {
      const trimmed = line.trim();
      return trimmed.startsWith('//') ? '' : line;
    })
    .join('\n');
}

describe('Phase 3 non-goals -- no Material Action, no Recovery, no UI in the new pure modules', () => {
  const files = ['blending-recommendation.js', 'recommendation-ranking.js', 'fleet-allocation.js'];
  const sources = files.map((f) => stripComments(readFileSync(path.join(ROOT, 'js', 'pages', 'calculate', f), 'utf8')));

  test('USE/LIMIT/STOP/MOVE/SEPARATE/STANDBY action vocabulary does not appear in actual code', () => {
    sources.forEach((source, i) => {
      assert.doesNotMatch(source, /\bUSE\b|\bLIMIT\b|\bSTOP\b|\bSEPARATE\b|\bSTANDBY\b/, files[i]);
    });
  });

  test('no Planned Blend Recovery / New Dome concepts referenced', () => {
    sources.forEach((source, i) => {
      for (const forbidden of ['recovery', 'newDome', 'requiredNewNi', 'calculateRequiredNewDomeNi']) {
        assert.doesNotMatch(source, new RegExp(forbidden, 'i'), `${files[i]} must not reference ${forbidden}`);
      }
    });
  });

  test('no DOM/router/i18n/localStorage/network/license-service dependency', () => {
    sources.forEach((source, i) => {
      assert.doesNotMatch(source, /document\.|window\.|localStorage|from '\.\.\/\.\.\/i18n|from '\.\.\/\.\.\/router|from '\.\.\/\.\.\/services\/license-service/, files[i]);
    });
  });
});
