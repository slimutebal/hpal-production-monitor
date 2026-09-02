// V3.0 Phase 6L -- Exact Final MITM Ranking Solver Prototype (this task's
// own spec). Phase 6K narrowed D's E-optimal survivors to those also F
// (Hopper simplicity) optimal, entirely via additive per-half primitives +
// the exact chemistry join -- never a Cartesian reconstruction. This file
// carries the SAME technique through the remaining production ranking
// chain (recommendation-ranking.js's compareWithinTolerance, UNCHANGED --
// rules G/totalMovedUnits, H/absoluteDeviation, I/activeSourceCount,
// J/allocationSignature tie-break) and differentially proves the result
// against a REAL buildCandidate() + REAL compareWithinTolerance() brute
// force on small scenarios (mandatory Section 8), then reports the C/D/E
// primary results this task requires.
//
// REUSE, NOT REIMPLEMENTATION: every function under test is imported
// unchanged from the prototype file; buildCandidate()/compareWithinTolerance()/
// fullyUnusedLoadingPointCount() and fleet-allocation.js's
// simplifyUnitRatio()/simplicityKey() are the REAL production functions,
// used unchanged as the ground truth throughout.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildGroupFullUtilizationStates,
  withChemistryScores,
  bucketByIntegerKey,
  findMinimumFeasibleAdditiveTotal,
  computeMinimumFeasibleG,
  findMinimumAbsoluteDeviationAmongPairs,
  selectMinimumActiveSourceCountPairs,
  findExactFinalRankingWinner,
  bruteForceFullUtilizationFinalWinner,
  findBlendRecommendationsSourceLazyDecomposed,
  computeMitmChemistryFeasibility,
} from '../js/pages/calculate/blending-recommendation-source-lazy.js';
import { compareWithinTolerance, fullyUnusedLoadingPointCount } from '../js/pages/calculate/recommendation-ranking.js';
import { simplicityKey as prodSimplicityKey } from '../js/pages/calculate/fleet-allocation.js';
import { mulberry32, randInt, pick } from '../tests/reference/seeded-random.mjs';

function statusOf(result) {
  return result.ok ? result.status : result.error;
}

// ============================================================
// SCENARIO FIXTURES -- byte-identical to tests/v3-phase6j-mitm-chemistry.test.mjs
// / tests/v3-phase6k-hopper-signature-aggregation.test.mjs (this task's own
// reused fixtures), reproduced here so this file has no cross-test-file
// dependency.
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

// Hopper 1:1 case -- symmetric two-Contractor, two-source-each shape whose
// only within-tolerance full-utilization region sits exactly on a 1:1
// Higher:LGLO ratio (mirrors this task's own "Hopper 1:1 case" requirement).
const SCENARIO_HOPPER_1_1 = [
  { pileId: 'H1-S0', contractor: 'ContractorH1', ni: '1.30', units: '12', tonnesPerUnit: '50' },
  { pileId: 'H1-S1', contractor: 'ContractorH1', ni: '1.00', units: '12', tonnesPerUnit: '50' },
  { pileId: 'H2-S0', contractor: 'ContractorH2', ni: '1.30', units: '6', tonnesPerUnit: '50' },
  { pileId: 'H2-S1', contractor: 'ContractorH2', ni: '1.00', units: '6', tonnesPerUnit: '50' },
];

// ============================================================
// RANDOMIZED SMALL SCENARIOS -- broad coverage across G/H/I/J-decided ties,
// deterministic (mulberry32, no Math.random -- same convention as
// tests/v3-differential.test.mjs). Kept small (2-3 Contractors, 2-3 sources
// each, fleet <=24) so the brute-force oracle stays fast.
// ============================================================
function generateRandomScenario(rng) {
  const contractorCount = randInt(rng, 2, 3);
  const niChoices = ['1.00', '1.05', '1.15', '1.20', '1.30'];
  const tonnesChoices = ['40', '50', '60'];
  const unitsChoices = [4, 6, 8, 10, 12];
  const sources = [];
  for (let c = 0; c < contractorCount; c += 1) {
    const sourceCount = randInt(rng, 2, 3);
    for (let s = 0; s < sourceCount; s += 1) {
      sources.push({
        pileId: `R${c}-S${s}`,
        contractor: `RContractor${c}`,
        ni: pick(rng, niChoices),
        units: String(pick(rng, unitsChoices)),
        tonnesPerUnit: pick(rng, tonnesChoices),
      });
    }
  }
  return sources;
}

// ============================================================
// UNIT COVERAGE -- generic additive-total scan (Stage G's own machinery)
// ============================================================
describe('V3.0 Phase 6L -- unit coverage: bucketByIntegerKey / findMinimumFeasibleAdditiveTotal', () => {
  test('bucketByIntegerKey partitions without losing any state', () => {
    const states = [{ k: 0, tag: 'a' }, { k: 2, tag: 'b' }, { k: 0, tag: 'c' }, { k: 5, tag: 'd' }];
    const buckets = bucketByIntegerKey(states, (s) => s.k);
    assert.equal(buckets.size, 3);
    assert.equal(buckets.get(0).length, 2);
    assert.equal(buckets.get(2).length, 1);
    assert.equal(buckets.get(5).length, 1);
  });

  test('findMinimumFeasibleAdditiveTotal finds the exact minimum sum satisfying the chemistry join, verified against direct enumeration', () => {
    // Synthetic left/right states: numerator/tonnage chosen so the join
    // (target=10, tolerance=1, i.e. [9,11]) is satisfied only by specific
    // pairs; `g` is the additive primitive under test.
    const target = 10;
    const tol = 1;
    const withScores = (arr) => withChemistryScores(arr, target, tol);
    const leftRaw = [
      { numerator: 90, tonnage: 10, g: 3 }, // Ni=9
      { numerator: 100, tonnage: 10, g: 1 }, // Ni=10
      { numerator: 80, tonnage: 10, g: 0 }, // Ni=8 (out of range alone)
    ];
    const rightRaw = [
      { numerator: 100, tonnage: 10, g: 2 }, // Ni=10
      { numerator: 130, tonnage: 10, g: 0 }, // Ni=13 (out of range alone)
    ];
    const left = withScores(leftRaw);
    const right = withScores(rightRaw);

    const result = findMinimumFeasibleAdditiveTotal(left, right, (s) => s.g);

    // Direct enumeration oracle.
    let bruteMin = null;
    left.forEach((l) => {
      right.forEach((r) => {
        const ni = (l.numerator + r.numerator) / (l.tonnage + r.tonnage);
        if (Math.abs(ni - target) > tol) return;
        const total = l.g + r.g;
        if (bruteMin === null || total < bruteMin) bruteMin = total;
      });
    });

    assert.equal(result.minimumTotal, bruteMin);
    assert.ok(result.splits.length > 0);
  });
});

describe('V3.0 Phase 6L -- unit coverage: G/H/I stage functions on synthetic winningEntries/splits', () => {
  test('computeMinimumFeasibleG picks the global minimum movedUnits across multiple E+F-optimal entries', () => {
    const target = 10;
    const tol = 1;
    const withScores = (arr) => withChemistryScores(arr, target, tol);
    // Entry 1: only feasible split has movedUnits total 5.
    const entry1 = {
      leftStates: withScores([{ numerator: 95, tonnage: 10, movedUnits: 3 }]),
      rightStates: withScores([{ numerator: 100, tonnage: 10, movedUnits: 2 }]),
    };
    // Entry 2: a feasible split with movedUnits total 1 -- must win globally.
    const entry2 = {
      leftStates: withScores([{ numerator: 95, tonnage: 10, movedUnits: 1 }]),
      rightStates: withScores([{ numerator: 100, tonnage: 10, movedUnits: 0 }]),
    };
    const g = computeMinimumFeasibleG([entry1, entry2]);
    assert.equal(g.minimumG, 1);
    assert.ok(g.splits.every((s) => s.kLeft + s.kRight === 1));
  });

  test('findMinimumAbsoluteDeviationAmongPairs re-validates the exact join and finds the closest-to-target pair only', () => {
    const target = 10;
    const tol = 2;
    const withScores = (arr) => withChemistryScores(arr, target, tol);
    const left = withScores([{ numerator: 80, tonnage: 10 }]); // Ni=8, alone
    const right = withScores([
      { numerator: 100, tonnage: 10 }, // combined Ni=9, |dev|=1
      { numerator: 110, tonnage: 10 }, // combined Ni=9.5, |dev|=0.5 -- closer
      { numerator: 400, tonnage: 10 }, // combined Ni=24 -- outside join, must be excluded
    ]);
    const result = findMinimumAbsoluteDeviationAmongPairs([{ left, right }], target);
    assert.equal(result.pairsScanned, 3);
    assert.equal(result.minimumDeviation, 0.5);
    assert.equal(result.winners.length, 1);
    assert.equal(result.winners[0].right.numerator, 110);
  });

  test('selectMinimumActiveSourceCountPairs picks the pair(s) with the fewest combined active sources', () => {
    const pairs = [
      { left: { activeSourceCount: 2 }, right: { activeSourceCount: 3 } }, // 5
      { left: { activeSourceCount: 1 }, right: { activeSourceCount: 2 } }, // 3 -- winner
      { left: { activeSourceCount: 2 }, right: { activeSourceCount: 1 } }, // 3 -- tied winner
    ];
    const result = selectMinimumActiveSourceCountPairs(pairs);
    assert.equal(result.minimumI, 3);
    assert.equal(result.winners.length, 2);
  });
});

// ============================================================
// SECTION 8 -- MANDATORY BRUTE-FORCE PROOF: findExactFinalRankingWinner()
// vs bruteForceFullUtilizationFinalWinner() (REAL buildCandidate() + REAL
// compareWithinTolerance()), across curated + randomized small scenarios.
// Required exact equality on status/allocationSignature/estimatedNi/
// activeUnits/relocation/E/F/G/H/I. 0 mismatches required.
// ============================================================
function assertExactMatch(name, mitm, brute, targetNiValue, toleranceValue) {
  if (brute === null) {
    assert.equal(mitm.status, 'NO_WITHIN_TOLERANCE_CANDIDATE', `${name}: brute found no within-tolerance candidate, MITM must agree`);
    assert.equal(mitm.candidate, null, `${name}: no candidate expected`);
    return;
  }
  assert.equal(mitm.status, 'OK', `${name}: MITM must report OK when brute force found a within-tolerance winner`);
  assert.ok(mitm.candidate, `${name}: MITM must produce a candidate`);
  const c = mitm.candidate;

  assert.equal(c.allocationSignature, brute.allocationSignature, `${name}: allocationSignature (rule J) mismatch`);
  assert.equal(c.estimatedNi, brute.estimatedNi, `${name}: estimatedNi mismatch`);
  assert.equal(c.totalActiveUnits, brute.totalActiveUnits, `${name}: totalActiveUnits (rule B) mismatch`);
  assert.deepEqual(c.relocations, brute.relocations, `${name}: relocations mismatch`);
  assert.equal(c.totalMovedUnits, brute.totalMovedUnits, `${name}: totalMovedUnits (rule G) mismatch`);
  assert.equal(c.absoluteDeviation, brute.absoluteDeviation, `${name}: absoluteDeviation (rule H) mismatch`);
  assert.equal(c.activeSourceCount, brute.activeSourceCount, `${name}: activeSourceCount (rule I) mismatch`);
  assert.equal(fullyUnusedLoadingPointCount(c), fullyUnusedLoadingPointCount(brute), `${name}: fullyUnusedLoadingPointCount (rule E) mismatch`);
  assert.deepEqual(prodSimplicityKey(c.unitRatio), prodSimplicityKey(brute.unitRatio), `${name}: simplicityKey (rule F) mismatch`);
  // Final verification boundary (this task's Section 12): the REAL
  // comparator must see these as a tie (0), never a strict loss for the
  // MITM winner against the brute-force winner.
  assert.equal(compareWithinTolerance(c, brute), 0, `${name}: real compareWithinTolerance must rank MITM winner == brute winner`);
}

function runDifferentialCase(name, sources) {
  test(`${name}: MITM final winner === brute-force full-utilization winner (0 mismatches)`, () => {
    const input = { targetNi: TARGET_NI, tolerance: TOLERANCE, sources };
    const mitm = findExactFinalRankingWinner(input);
    assert.ok(mitm.ok, `${name}: solver must not error`);

    // Independent oracle: reconstruct group states directly (same
    // prepareSourceLazySearch-derived groups the solver itself used --
    // reconstructed via findExactFinalRankingWinner's own internal call
    // shape is not exposed, so this rebuilds groups from the same
    // production entry path used elsewhere in this file).
    const { groups, groupFleets, targetNiValue, toleranceValue } = internalPrepare(sources);
    const groupStatesList = groups.map((g, i) => buildGroupFullUtilizationStates(g, groupFleets[i]));
    const brute = bruteForceFullUtilizationFinalWinner(groups, groupStatesList, targetNiValue, toleranceValue);

    assertExactMatch(name, mitm, brute, targetNiValue, toleranceValue);
  });
}

// Minimal local re-derivation of prepareSourceLazySearch()'s own
// groups/groupFleets/targetNiValue/toleranceValue outputs, using ONLY
// already-exported production/prototype functions (prepareSourceLazySearch
// itself is not exported -- this file must not modify the prototype file
// just to expose an internal helper for its own oracle harness). Byte-for-byte
// mirrors that function's own group/fleet derivation via
// findExactFinalRankingWinner's own sibling entry point
// computeMitmChemistryFeasibility(), which IS exported and returns exactly
// these fields already.
function internalPrepare(sources) {
  const report = computeMitmChemistryFeasibility({ targetNi: TARGET_NI, tolerance: TOLERANCE, sources });
  assert.ok(report.ok, 'internalPrepare: computeMitmChemistryFeasibility must succeed for a differential-test scenario');
  return {
    groups: report.groups,
    groupFleets: report.groupFleets,
    targetNiValue: report.targetNiValue,
    toleranceValue: report.toleranceValue,
  };
}

describe('V3.0 Phase 6L -- Section 8: mandatory brute-force proof (curated scenarios)', () => {
  runDifferentialCase('A', SCENARIOS.A);
  runDifferentialCase('B', SCENARIOS.B);
  runDifferentialCase('dead-Contractor', SCENARIO_DEAD_CONTRACTOR);
  runDifferentialCase('exact-6-boundary', SCENARIO_EXACT_BOUNDARY);
  runDifferentialCase('relocation-decided (G)', SCENARIO_RELOCATION);
  runDifferentialCase('boundary-tolerance', SCENARIO_BOUNDARY_TOLERANCE);
  runDifferentialCase('Hopper-1:1', SCENARIO_HOPPER_1_1);
});

describe('V3.0 Phase 6L -- Section 8: mandatory brute-force proof (randomized small scenarios)', () => {
  const rng = mulberry32(0x6C6C36C1); // 'll6' seed, arbitrary fixed constant
  const CASE_COUNT = 40;
  for (let i = 0; i < CASE_COUNT; i += 1) {
    const sources = generateRandomScenario(rng);
    runDifferentialCase(`random-${i}`, sources);
  }
});

// ============================================================
// C -- ESTABLISHED ORACLE (Phase 6G/6H/6I): findBlendRecommendationsSourceLazyDecomposed(C)
// already returns a completed exact winner for C (161,051 full-utilization
// leaves, small enough for group-granularity decomposition to finish).
// Phase 6L's own independent solver must return a byte-identical canonical
// winner.
// ============================================================
describe('V3.0 Phase 6L -- C: established oracle match', () => {
  test('C: 10 dome / 5 Contractor / 100 DT -- byte-identical winner vs Phase 6I decomposition oracle', () => {
    const input = { targetNi: TARGET_NI, tolerance: TOLERANCE, sources: SCENARIOS.C };

    const t0 = process.hrtime.bigint();
    const oracle = findBlendRecommendationsSourceLazyDecomposed(input);
    const t1 = process.hrtime.bigint();
    assert.equal(statusOf(oracle.result), 'OK', 'C: Phase 6I decomposition oracle must complete OK');

    const t2 = process.hrtime.bigint();
    const mitm = findExactFinalRankingWinner(input);
    const t3 = process.hrtime.bigint();
    assert.equal(mitm.status, 'OK', 'C: Phase 6L solver must complete OK');

    // eslint-disable-next-line no-console
    console.log(`[v3-phase6l] C: oracleRuntimeMs=${(Number(t1 - t0) / 1e6).toFixed(1)} mitmRuntimeMs=${(Number(t3 - t2) / 1e6).toFixed(1)} allocationSignature match=${oracle.result.candidate.allocationSignature === mitm.candidate.allocationSignature}`);

    assert.equal(mitm.candidate.allocationSignature, oracle.result.candidate.allocationSignature, 'C: allocationSignature must be byte-identical to the established oracle');
    assert.equal(mitm.candidate.estimatedNi, oracle.result.candidate.estimatedNi, 'C: estimatedNi must be byte-identical to the established oracle');
    assert.equal(mitm.candidate.totalActiveUnits, oracle.result.candidate.totalActiveUnits);
    assert.equal(mitm.candidate.totalMovedUnits, oracle.result.candidate.totalMovedUnits);
    assert.equal(mitm.candidate.activeSourceCount, oracle.result.candidate.activeSourceCount);
  });
});

// ============================================================
// D -- PRIMARY HARD CASE
// ============================================================
describe('V3.0 Phase 6L -- D primary hard case: full E->F->G->H->I->J funnel', () => {
  test('D: 10 dome / 3 Contractor / 100 DT -- PRIMARY RESULT', () => {
    const input = { targetNi: TARGET_NI, tolerance: TOLERANCE, sources: SCENARIOS.D };
    const t0 = process.hrtime.bigint();
    const result = findExactFinalRankingWinner(input);
    const t1 = process.hrtime.bigint();
    const ms = Number(t1 - t0) / 1e6;

    assert.equal(result.status, 'OK', 'D: Phase 6L solver must complete OK');
    const f = result.funnel;

    // eslint-disable-next-line no-console
    console.log(`[v3-phase6l] D: total=${f.totalCartesianCombinations} withinTolerance=${f.withinToleranceCount} minE=${f.minimumFeasibleE} atMinE=${f.withinToleranceAtMinimumE} minF=${JSON.stringify(f.minimumFeasibleSimplicityKey)} atMinEF=${f.withinToleranceAtMinimumEAndF} minG=${f.minimumFeasibleG} hPairsScanned=${f.hPairsScanned} minH=${f.minimumFeasibleH} hTieCount=${f.hTieCount} minI=${f.minimumFeasibleI} iTieCount=${f.iTieCount} finalReconstructed=${f.finalReconstructedCount} runtimeMs=${ms.toFixed(1)} heapDeltaBytes=${result.metrics.heapDeltaBytes}`);
    console.log(`[v3-phase6l] D: winner allocationSignature=${result.candidate.allocationSignature} estimatedNi=${result.candidate.estimatedNi} totalActiveUnits=${result.candidate.totalActiveUnits} totalMovedUnits=${result.candidate.totalMovedUnits} activeSourceCount=${result.candidate.activeSourceCount}`);

    // Cross-check against the already-established (Phase 6J/6K, unchanged)
    // chemistry/E metrics for D -- must not have drifted.
    assert.equal(f.totalCartesianCombinations, 51325051, 'D: theoretical full-utilization Cartesian total must match Phase 6I/6J/6K');
    assert.equal(f.withinToleranceCount, 35919151, 'D: chemistry-valid survivor count must match Phase 6J');
    assert.equal(f.minimumFeasibleE, 0, 'D: minimumFeasibleE must match Phase 6J/6K');
    assert.equal(f.withinToleranceAtMinimumE, 6858982, 'D: E-optimal survivor count must match Phase 6J/6K');
    assert.ok(f.minimumFeasibleG !== null, 'D: a feasible G must exist');
    assert.ok(f.minimumFeasibleH !== null, 'D: a feasible H must exist');
    assert.ok(f.minimumFeasibleI !== null, 'D: a feasible I must exist');
    assert.ok(result.candidate.withinTolerance, 'D: final winner must be within tolerance');

    // PRIMARY PERFORMANCE TARGET (this task's own honesty requirement --
    // no hard failure on a slow-but-correct run, only a generous ceiling
    // to catch a genuine runaway/regression).
    assert.ok(ms < 120000, `D: MITM ranking work took ${ms.toFixed(0)}ms -- reporting, not silently accepting an unbounded runtime`);
  });
});

// ============================================================
// E -- EXTREME CASE (best-effort; failure here does NOT invalidate D)
// ============================================================
describe('V3.0 Phase 6L -- E extreme case: best-effort, does not gate D correctness', () => {
  test('E: 10 dome / 2 Contractor / 100 DT concentrated', () => {
    const input = { targetNi: TARGET_NI, tolerance: TOLERANCE, sources: SCENARIOS.E };
    const t0 = process.hrtime.bigint();
    const result = findExactFinalRankingWinner(input);
    const t1 = process.hrtime.bigint();
    const ms = Number(t1 - t0) / 1e6;

    if (result.status === 'OK') {
      const f = result.funnel;
      // eslint-disable-next-line no-console
      console.log(`[v3-phase6l] E: total=${f.totalCartesianCombinations} withinTolerance=${f.withinToleranceCount} minE=${f.minimumFeasibleE} atMinE=${f.withinToleranceAtMinimumE} minF=${JSON.stringify(f.minimumFeasibleSimplicityKey)} atMinEF=${f.withinToleranceAtMinimumEAndF} minG=${f.minimumFeasibleG} hPairsScanned=${f.hPairsScanned} minH=${f.minimumFeasibleH} minI=${f.minimumFeasibleI} runtimeMs=${ms.toFixed(1)}`);
    } else {
      // eslint-disable-next-line no-console
      console.log(`[v3-phase6l] E: status=${result.status} runtimeMs=${ms.toFixed(1)} -- reported honestly, does not invalidate D`);
    }
    assert.ok(result.ok, 'E: solver must not throw/error even if the result is not a full OK');
  });
});
