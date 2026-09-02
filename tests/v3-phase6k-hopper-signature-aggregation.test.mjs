// V3.0 Phase 6K -- Exact Hopper-F Signature Aggregation Prototype (this
// task's own spec). Phase 6J proved the chemistry+E MITM join is exact and
// sub-Cartesian but left D's E-optimal survivor set at 6,858,982 -- still
// far too large for candidate reconstruction. This file proves ranking
// rule F (recommendation-ranking.js's REAL compareSimplicity(), which scores
// simplicityKey(simplifyUnitRatio(higherGradeUnits, lgloUnits)) --
// fleet-allocation.js's own GLOBAL, gcd-reduced-ONLY-ONCE active-unit ratio)
// is EXACTLY composable from an additive per-half primitive
// (higherUnits/lgloUnits), then measures how much it reduces D's remaining
// survivor space -- WITHOUT ever enumerating the 6.86M combinations.
//
// REUSE, NOT REIMPLEMENTATION: every function under test is imported
// unchanged from the prototype file; simplifyUnitRatio()/simplicityKey()
// (fleet-allocation.js) and buildCandidate()/isWithinTolerance()
// (blending-recommendation.js) and fullyUnusedLoadingPointCount()
// (recommendation-ranking.js) are the REAL production functions, used
// unchanged as the ground-truth oracle throughout.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  computeMitmChemistryFeasibility,
  buildAggregateHalfStates,
  buildActiveMapFromChoices,
  hopperSignatureKeyOf,
  exactSimplicityKeyForCombinedPrimitive,
  compareHopperSimplicityKeys,
  groupStatesByHopperSignature,
  computeHopperSignatureOpportunity,
  computeHopperAwareMinimumF,
  bruteForceFullUtilizationHopperFCount,
  findBlendRecommendationsSourceLazyDecomposed,
} from '../js/pages/calculate/blending-recommendation-source-lazy.js';
import { buildCandidate, isWithinTolerance } from '../js/pages/calculate/blending-recommendation.js';
import { simplifyUnitRatio, simplicityKey as prodSimplicityKey } from '../js/pages/calculate/fleet-allocation.js';
import { fullyUnusedLoadingPointCount } from '../js/pages/calculate/recommendation-ranking.js';

function statusOf(result) {
  return result.ok ? result.status : result.error;
}

// ============================================================
// SCENARIO FIXTURES -- byte-identical to tests/v3-phase6j-mitm-chemistry.test.mjs
// (this task's own reused fixtures), reproduced here so this file has no
// cross-test-file dependency.
// ============================================================
function buildScenarioSources(domesPerContractor, dtPerDome, niHigh = '1.30', niLow = '1.00') {
  const sources = [];
  domesPerContractor.forEach((domeCount, c) => {
    for (let s = 0; s < domeCount; s += 1) {
      sources.push({
        pileId: `C${c}-S${s}`,
        contractor: `Contractor${c}`,
        ni: s % 2 === 0 ? niHigh : niLow,
        units: String(dtPerDome),
        tonnesPerUnit: '50',
      });
    }
  });
  return sources;
}

const TARGET_NI = '1.15';
const TOLERANCE = '0.05';

const SCENARIOS = {
  A: buildScenarioSources([2, 2, 2, 1, 1], 10),
  B: buildScenarioSources([2, 2, 2, 1, 1, 1, 1], 10),
  C: buildScenarioSources([2, 2, 2, 2, 2], 10),
  D: buildScenarioSources([4, 3, 3], 10),
  E: buildScenarioSources([5, 5], 10),
};

const SCENARIO_DEAD_CONTRACTOR = [
  { pileId: 'X-S0', contractor: 'ContractorX', ni: '1.30', units: '4', tonnesPerUnit: '50' },
  { pileId: 'Y-S0', contractor: 'ContractorY', ni: '1.30', units: '12', tonnesPerUnit: '50' },
  { pileId: 'Y-S1', contractor: 'ContractorY', ni: '1.00', units: '12', tonnesPerUnit: '50' },
  { pileId: 'Z-S0', contractor: 'ContractorZ', ni: '1.30', units: '20', tonnesPerUnit: '50' },
  { pileId: 'Z-S1', contractor: 'ContractorZ', ni: '1.00', units: '10', tonnesPerUnit: '50' },
];

const SCENARIO_EXACT_BOUNDARY = [
  { pileId: 'B-S0', contractor: 'ContractorB', ni: '1.30', units: '6', tonnesPerUnit: '50' },
  { pileId: 'W-S0', contractor: 'ContractorW', ni: '1.30', units: '18', tonnesPerUnit: '50' },
  { pileId: 'W-S1', contractor: 'ContractorW', ni: '1.00', units: '18', tonnesPerUnit: '50' },
];

const SCENARIO_RELOCATION = [
  { pileId: 'R-S0', contractor: 'ContractorR', ni: '1.30', units: '3', tonnesPerUnit: '50' },
  { pileId: 'R-S1', contractor: 'ContractorR', ni: '1.00', units: '27', tonnesPerUnit: '50' },
  { pileId: 'Q-S0', contractor: 'ContractorQ', ni: '1.30', units: '15', tonnesPerUnit: '50' },
  { pileId: 'Q-S1', contractor: 'ContractorQ', ni: '1.00', units: '15', tonnesPerUnit: '50' },
];

const SCENARIO_BOUNDARY_TOLERANCE = [
  { pileId: 'P-S0', contractor: 'ContractorP', ni: '1.30', units: '9', tonnesPerUnit: '50' },
  { pileId: 'P-S1', contractor: 'ContractorP', ni: '1.00', units: '9', tonnesPerUnit: '50' },
  { pileId: 'X-S0', contractor: 'ContractorX', ni: '1.30', units: '4', tonnesPerUnit: '50' },
];

function allBipartitions(n) {
  const result = [];
  for (let mask = 0; mask < (1 << n); mask += 1) {
    const left = [];
    const right = [];
    for (let i = 0; i < n; i += 1) (mask & (1 << i) ? left : right).push(i);
    result.push({ left, right });
  }
  return result;
}

// ============================================================
// SECTION 3 -- MANDATORY COMPOSABILITY PROOF: for many small full-utilization
// scenarios, split the Contractor GROUPS every possible way (not just the
// one balanced split the production MITM path picks), combine each half's
// own higherUnits/lgloUnits primitive by plain addition, derive the exact
// rule-F key from that combined primitive, and assert it is BYTE-IDENTICAL
// to the REAL production key (simplicityKey(candidate.unitRatio) from an
// actual buildCandidate() call) -- for every combo, not just within-tolerance
// ones, so this proof is independent of Phase 6J's own chemistry join.
// ============================================================
describe('V3.0 Phase 6K -- Section 3: composability proof across every group bipartition', () => {
  [
    ['exact-6-boundary', SCENARIO_EXACT_BOUNDARY],
    ['boundary-tolerance', SCENARIO_BOUNDARY_TOLERANCE],
    ['dead-Contractor', SCENARIO_DEAD_CONTRACTOR],
    ['relocation', SCENARIO_RELOCATION],
  ].forEach(([name, sources]) => {
    test(`${name}: combined-primitive key === real production simplicityKey(candidate.unitRatio) for every non-degenerate bipartition`, () => {
      const report = computeMitmChemistryFeasibility({ targetNi: TARGET_NI, tolerance: TOLERANCE, sources });
      assert.ok(report.ok);
      const n = report.groupStatesList.length;
      let checked = 0;

      allBipartitions(n).forEach(({ left: leftIdx, right: rightIdx }) => {
        if (leftIdx.length === 0 || rightIdx.length === 0) return;
        const leftStates = buildAggregateHalfStates(leftIdx, report.groupStatesList);
        const rightStates = buildAggregateHalfStates(rightIdx, report.groupStatesList);

        leftStates.forEach((left) => {
          rightStates.forEach((right) => {
            const activeMap = buildActiveMapFromChoices(report.groups, report.groupStatesList, [...left.choices, ...right.choices]);
            const candidate = buildCandidate(report.groups, activeMap, report.targetNiValue, report.toleranceValue);
            if (!candidate) return; // all-zero combination -- production itself excludes it, nothing to compare
            const expectedKey = prodSimplicityKey(candidate.unitRatio);
            const actualKey = exactSimplicityKeyForCombinedPrimitive(left.higherUnits + right.higherUnits, left.lgloUnits + right.lgloUnits);
            assert.deepEqual(actualKey, expectedKey, `${name} split [${leftIdx}]|[${rightIdx}]: combined-primitive key mismatch`);
            checked += 1;
          });
        });
      });

      assert.ok(checked > 0, `${name}: composability proof must exercise at least one combination`);
      // eslint-disable-next-line no-console
      console.log(`[v3-phase6k] ${name}: composability proof — ${checked} combinations across ${(1 << n) - 2} non-degenerate bipartitions, 0 mismatches`);
    });
  });
});

// ============================================================
// SECTION 3 (continued) -- the known Phase 6E non-monotonic GCD/pattern
// counterexample (tests/v3-phase6e-extended-bounds-proof.test.mjs Part 2):
// proves the NEW combined-primitive machinery reproduces the exact same
// "global best key is an INTERIOR (all-zero) choice, not either corner"
// result Phase 6E already proved directly against simplifyUnitRatio()/
// simplicityKey() -- i.e. this new composable-signature path carries the
// same non-monotonic case through correctly (it never bounds/prunes F, so
// it cannot be fooled by it).
// ============================================================
describe('V3.0 Phase 6K -- Section 3: Phase 6E non-monotonic counterexample regression', () => {
  test('fixedHigher=4/fixedLglo=4, one open group (budget 10): best combined key is still the interior all-zero choice', () => {
    const fixedHigher = 4;
    const fixedLglo = 4;
    const remainingFleet = 10;
    const feasibleValues = [0, 6, 7, 8, 9, 10];

    const results = [];
    feasibleValues.forEach((deltaHigher) => {
      feasibleValues.forEach((deltaLglo) => {
        if (deltaHigher + deltaLglo > remainingFleet) return;
        const finalHigher = fixedHigher + deltaHigher;
        const finalLglo = fixedLglo + deltaLglo;
        const key = exactSimplicityKeyForCombinedPrimitive(finalHigher, finalLglo);
        results.push({ deltaHigher, deltaLglo, key });
      });
    });

    const best = results.reduce((acc, r) => (compareHopperSimplicityKeys(r.key, acc.key) < 0 ? r : acc));
    assert.equal(best.deltaHigher, 0, 'best key must be at deltaHigher=0 (all-zero), not a corner');
    assert.equal(best.deltaLglo, 0, 'best key must be at deltaLglo=0 (all-zero), not a corner');
    assert.deepEqual(best.key, [2, 1, 1, 1], 'best key must be the preserved 1:1 ratio');

    const cornerHigh = results.find((r) => r.deltaHigher === remainingFleet && r.deltaLglo === 0);
    const cornerLglo = results.find((r) => r.deltaHigher === 0 && r.deltaLglo === remainingFleet);
    assert.ok(compareHopperSimplicityKeys(best.key, cornerHigh.key) < 0, 'interior all-zero choice must strictly beat the high-corner');
    assert.ok(compareHopperSimplicityKeys(best.key, cornerLglo.key) < 0, 'interior all-zero choice must strictly beat the lglo-corner');
  });
});

// ============================================================
// SECTION 10 -- BRUTE-FORCE PROOF against REAL production candidates: for
// small scenarios, compare MITM Hopper-aware minimumE -> minimumF -> exact
// count-at-both against a direct double-loop that reconstructs every
// chemistry-feasible (left,right) pair into a real buildCandidate() and
// reads its REAL fullyUnusedLoadingPointCount()/simplicityKey(unitRatio).
// 0 mismatches required.
// ============================================================
describe('V3.0 Phase 6K -- Section 10: brute-force proof against real production candidates', () => {
  [
    ['A', SCENARIOS.A],
    ['B', SCENARIOS.B],
    ['exact-6-boundary', SCENARIO_EXACT_BOUNDARY],
    ['boundary-tolerance', SCENARIO_BOUNDARY_TOLERANCE],
    ['dead-Contractor', SCENARIO_DEAD_CONTRACTOR],
    ['relocation', SCENARIO_RELOCATION],
  ].forEach(([name, sources]) => {
    test(`${name}: MITM Hopper-aware minE/minF/count exactly match real production ranking`, () => {
      const report = computeMitmChemistryFeasibility({ targetNi: TARGET_NI, tolerance: TOLERANCE, sources });
      assert.ok(report.ok);
      const hopperF = computeHopperAwareMinimumF(report);

      let bruteMinE = null;
      let atMinE = [];
      report.leftStates.forEach((left) => {
        report.rightStates.forEach((right) => {
          const withinJoin = (left.lowScore + right.lowScore >= 0) && (left.highScore + right.highScore <= 0);
          if (!withinJoin) return;
          const activeMap = buildActiveMapFromChoices(report.groups, report.groupStatesList, [...left.choices, ...right.choices]);
          const candidate = buildCandidate(report.groups, activeMap, report.targetNiValue, report.toleranceValue);
          if (!candidate || !isWithinTolerance(candidate.estimatedNi, report.targetNiValue, report.toleranceValue)) return;
          const e = fullyUnusedLoadingPointCount(candidate);
          if (bruteMinE === null || e < bruteMinE) { bruteMinE = e; atMinE = [candidate]; } else if (e === bruteMinE) atMinE.push(candidate);
        });
      });

      if (bruteMinE === null) {
        assert.equal(hopperF.ok, false, `${name}: no brute-force within-tolerance candidate exists, so hopperF must report NO_FEASIBLE_E/SIGNATURE_PAIR`);
        return;
      }

      let bruteMinF = null;
      let bruteCountAtMinEF = 0;
      atMinE.forEach((c) => {
        const key = prodSimplicityKey(c.unitRatio);
        if (bruteMinF === null || compareHopperSimplicityKeys(key, bruteMinF) < 0) { bruteMinF = key; bruteCountAtMinEF = 1; } else if (compareHopperSimplicityKeys(key, bruteMinF) === 0) bruteCountAtMinEF += 1;
      });

      // eslint-disable-next-line no-console
      console.log(`[v3-phase6k] ${name}: brute minE=${bruteMinE}/MITM=${report.metrics.minimumFeasibleE} brute minF=${JSON.stringify(bruteMinF)}/MITM=${JSON.stringify(hopperF.minimumFeasibleSimplicityKey)} brute count=${bruteCountAtMinEF}/MITM=${hopperF.withinToleranceAtMinimumEAndF}`);

      assert.equal(report.metrics.minimumFeasibleE, bruteMinE, `${name}: minimumE mismatch`);
      assert.ok(hopperF.ok, `${name}: hopperF must succeed whenever a brute-force within-tolerance candidate exists`);
      assert.deepEqual(hopperF.minimumFeasibleSimplicityKey, bruteMinF, `${name}: minimumF mismatch`);
      assert.equal(hopperF.withinToleranceAtMinimumEAndF, bruteCountAtMinEF, `${name}: count-at-minimumE-and-F mismatch`);
    });
  });
});

// ============================================================
// PRIMARY BENCHMARKS -- D (primary), then C (cross-checked against the
// lightweight numeric brute-force oracle, safe at C's 161,051-leaf scale),
// then E (opportunity/F metrics only -- its own ~1.22B/~94.7M scales are
// never enumerated, per this task's explicit instruction).
// ============================================================
describe('V3.0 Phase 6K -- D primary benchmark: Hopper signature opportunity + exact minimum F', () => {
  test('D: 10 dome / 3 Contractor / 100 DT -- PRIMARY RESULT', () => {
    const t0 = process.hrtime.bigint();
    const memBefore = process.memoryUsage().heapUsed;

    const report = computeMitmChemistryFeasibility({ targetNi: TARGET_NI, tolerance: TOLERANCE, sources: SCENARIOS.D });
    assert.ok(report.ok);
    const opportunity = computeHopperSignatureOpportunity(report);
    assert.ok(opportunity.ok);
    const hopperF = computeHopperAwareMinimumF(report);
    assert.ok(hopperF.ok);

    const t1 = process.hrtime.bigint();
    const memAfter = process.memoryUsage().heapUsed;
    const ms = Number(t1 - t0) / 1e6;

    // eslint-disable-next-line no-console
    console.log(`[v3-phase6k] D: fullUtilization=${report.metrics.totalCartesianCombinations} withinTolerance=${report.metrics.withinToleranceCount} minimumFeasibleE=${report.metrics.minimumFeasibleE} withinToleranceAtMinimumE=${report.metrics.withinToleranceAtMinimumE} rawLeftAtMinE=${opportunity.metrics.rawLeftStates} rawRightAtMinE=${opportunity.metrics.rawRightStates} distinctLeftSig=${opportunity.metrics.distinctLeftSignatures} distinctRightSig=${opportunity.metrics.distinctRightSignatures} theoreticalSigPairs=${opportunity.metrics.theoreticalSignaturePairCount} feasibleSigPairs=${hopperF.feasibleSignaturePairCount} minimumF=${JSON.stringify(hopperF.minimumFeasibleSimplicityKey)} withinToleranceAtMinimumEAndF=${hopperF.withinToleranceAtMinimumEAndF} runtimeMs=${ms.toFixed(1)} heapDeltaBytes=${memAfter - memBefore}`);

    assert.equal(report.metrics.totalCartesianCombinations, 51325051, 'D: theoretical full-utilization Cartesian total must match Phase 6I/6J');
    assert.equal(report.metrics.withinToleranceAtMinimumE, 6858982, 'D: E-optimal survivor count must match Phase 6J');
    assert.ok(opportunity.metrics.rawLeftStates <= report.metrics.leftStateCount, 'D: E-restricted left population must not exceed the full left state count');
    assert.ok(opportunity.metrics.rawRightStates <= report.metrics.rightStateCount, 'D: E-restricted right population must not exceed the full right state count');
    assert.ok(opportunity.metrics.distinctLeftSignatures <= opportunity.metrics.rawLeftStates, 'D: distinct signatures can never exceed raw state count');
    assert.ok(opportunity.metrics.distinctRightSignatures <= opportunity.metrics.rawRightStates);
    assert.ok(hopperF.withinToleranceAtMinimumEAndF > 0, 'D: at least one E+F-optimal combination must exist');
    assert.ok(hopperF.withinToleranceAtMinimumEAndF <= report.metrics.withinToleranceAtMinimumE, 'D: F cannot ever increase the survivor count already fixed by E');
  });
});

describe('V3.0 Phase 6K -- C: cross-checked against the lightweight numeric brute-force oracle', () => {
  test('C: 10 dome / 5 Contractor / 100 DT', () => {
    const t0 = process.hrtime.bigint();
    const report = computeMitmChemistryFeasibility({ targetNi: TARGET_NI, tolerance: TOLERANCE, sources: SCENARIOS.C });
    assert.ok(report.ok);
    const opportunity = computeHopperSignatureOpportunity(report);
    const hopperF = computeHopperAwareMinimumF(report);
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;

    const brute = bruteForceFullUtilizationHopperFCount(report.groupStatesList, report.targetNiValue, report.toleranceValue);

    // eslint-disable-next-line no-console
    console.log(`[v3-phase6k] C: fullUtilization=${report.metrics.totalCartesianCombinations} rawLeftAtMinE=${opportunity.metrics.rawLeftStates} rawRightAtMinE=${opportunity.metrics.rawRightStates} distinctLeftSig=${opportunity.metrics.distinctLeftSignatures} distinctRightSig=${opportunity.metrics.distinctRightSignatures} minimumF MITM=${JSON.stringify(hopperF.minimumFeasibleSimplicityKey)} brute=${JSON.stringify(brute.minimumF)} countAtMinEF MITM=${hopperF.withinToleranceAtMinimumEAndF} brute=${brute.countAtMinimumEAndF} runtimeMs=${ms.toFixed(1)}`);

    assert.equal(report.metrics.minimumFeasibleE, brute.minimumE, 'C: minimumE mismatch vs full 161,051-leaf brute force');
    assert.deepEqual(hopperF.minimumFeasibleSimplicityKey, brute.minimumF, 'C: minimumF mismatch vs full brute force');
    assert.equal(hopperF.withinToleranceAtMinimumEAndF, brute.countAtMinimumEAndF, 'C: count-at-minimumE-and-F mismatch vs full brute force');
  });
});

describe('V3.0 Phase 6K -- E: opportunity/F metrics only (its own ~1.22B/~94.7M scales are never enumerated)', () => {
  test('E: 10 dome / 2 Contractor / 100 DT concentrated', () => {
    const t0 = process.hrtime.bigint();
    const report = computeMitmChemistryFeasibility({ targetNi: TARGET_NI, tolerance: TOLERANCE, sources: SCENARIOS.E });
    assert.ok(report.ok);
    const opportunity = computeHopperSignatureOpportunity(report);
    assert.ok(opportunity.ok);
    const hopperF = computeHopperAwareMinimumF(report);
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;

    // eslint-disable-next-line no-console
    console.log(`[v3-phase6k] E: fullUtilization=${report.metrics.totalCartesianCombinations} withinToleranceAtMinimumE=${report.metrics.withinToleranceAtMinimumE} rawLeftAtMinE=${opportunity.metrics.rawLeftStates} rawRightAtMinE=${opportunity.metrics.rawRightStates} distinctLeftSig=${opportunity.metrics.distinctLeftSignatures} distinctRightSig=${opportunity.metrics.distinctRightSignatures} theoreticalSigPairs=${opportunity.metrics.theoreticalSignaturePairCount} minimumF=${hopperF.ok ? JSON.stringify(hopperF.minimumFeasibleSimplicityKey) : hopperF.reason} withinToleranceAtMinimumEAndF=${hopperF.ok ? hopperF.withinToleranceAtMinimumEAndF : 'n/a'} runtimeMs=${ms.toFixed(1)}`);

    assert.ok(report.metrics.totalCartesianCombinations > 1000000000, 'E: precondition -- the task-stated ~1.22B Cartesian total');
    assert.ok(opportunity.metrics.rawLeftStates + opportunity.metrics.rawRightStates < 200000, 'E: E-restricted raw population must stay far below the full Cartesian product');
    assert.ok(ms < 60000, 'E: must complete in reasonable time without ever enumerating the full Cartesian product or its ~94.7M E-optimal survivors');
  });
});

// ============================================================
// UNIT-LEVEL COVERAGE for the individual Phase 6K primitives.
// ============================================================
describe('V3.0 Phase 6K -- unit coverage', () => {
  test('hopperSignatureKeyOf / groupStatesByHopperSignature: distinct (higherUnits,lgloUnits) pairs group correctly, no state lost', () => {
    const states = [
      { higherUnits: 6, lgloUnits: 0, tag: 'a' },
      { higherUnits: 6, lgloUnits: 0, tag: 'b' },
      { higherUnits: 0, lgloUnits: 6, tag: 'c' },
      { higherUnits: 3, lgloUnits: 3, tag: 'd' },
    ];
    const map = groupStatesByHopperSignature(states);
    assert.equal(map.size, 3);
    assert.equal(map.get(hopperSignatureKeyOf(states[0])).states.length, 2);
    assert.equal(map.get(hopperSignatureKeyOf(states[2])).states.length, 1);
    assert.equal(map.get(hopperSignatureKeyOf(states[3])).states.length, 1);
  });

  test('exactSimplicityKeyForCombinedPrimitive matches simplifyUnitRatio+simplicityKey composed directly, including zero-side rules', () => {
    assert.deepEqual(exactSimplicityKeyForCombinedPrimitive(4, 8), prodSimplicityKey(simplifyUnitRatio(4, 8)));
    assert.deepEqual(exactSimplicityKeyForCombinedPrimitive(0, 12), prodSimplicityKey(simplifyUnitRatio(0, 12)));
    assert.deepEqual(exactSimplicityKeyForCombinedPrimitive(9, 0), prodSimplicityKey(simplifyUnitRatio(9, 0)));
  });

  test('compareHopperSimplicityKeys matches recommendation-ranking.js compareSimplicity ordering', () => {
    const k12 = exactSimplicityKeyForCombinedPrimitive(1, 2); // [3,2,1,2]
    const k47 = exactSimplicityKeyForCombinedPrimitive(4, 7); // [11,7,4,7]
    assert.ok(compareHopperSimplicityKeys(k12, k47) < 0, '1:2 must sort before 4:7');
  });
});

// ============================================================
// SANITY -- Phase 6K adds pure post-hoc aggregation on top of Phase 6I/6J's
// own state model; it must not change their search behavior or results.
// ============================================================
describe('V3.0 Phase 6K -- regression sanity: Phase 6I/6J unaffected', () => {
  test('findBlendRecommendationsSourceLazyDecomposed(A) still OK and unchanged', () => {
    const input = { targetNi: TARGET_NI, tolerance: TOLERANCE, sources: SCENARIOS.A };
    const { result } = findBlendRecommendationsSourceLazyDecomposed(input);
    assert.equal(statusOf(result), 'OK');
  });

  test('computeMitmChemistryFeasibility(D) metrics unchanged by the new higherUnits/lgloUnits fields', () => {
    const report = computeMitmChemistryFeasibility({ targetNi: TARGET_NI, tolerance: TOLERANCE, sources: SCENARIOS.D });
    assert.equal(report.metrics.totalCartesianCombinations, 51325051);
    assert.equal(report.metrics.withinToleranceCount, 35919151);
    assert.equal(report.metrics.minimumFeasibleE, 0);
    assert.equal(report.metrics.withinToleranceAtMinimumE, 6858982);
  });
});
