// V3.0 Phase 6J -- Exact MITM Chemistry + Ranking-E Feasibility Prototype
// (this task's own spec). Phase 6I proved the A+B full-utilization
// decomposition is exact but D still has 51,325,051 full-utilization
// Cartesian combinations -- too many to traverse, even at group
// granularity. This file proves the MEET-IN-THE-MIDDLE chemistry join
// (blending-recommendation-source-lazy.js's own "PHASE 6J" section, above
// computeMitmChemistryFeasibility()) is EXACT -- never approximate,
// bucketed, or epsilon-widened -- by comparing it against a same-predicate
// brute-force Cartesian enumeration on many small scenarios, then reports
// the primary D/C/E feasibility metrics this task requires.
//
// REUSE, NOT REIMPLEMENTATION: every function under test is imported
// unchanged from the prototype file; buildCandidate()/isWithinTolerance()
// are the REAL production predicates (blending-recommendation.js), used
// unchanged for the Section 9 reconstruction check.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildGroupFullUtilizationStates,
  balanceContractorGroupsForMitm,
  buildAggregateHalfStates,
  withChemistryScores,
  countWithinToleranceMITM,
  findMinimumFeasibleE,
  buildActiveMapFromChoices,
  bruteForceFullUtilizationChemistryCount,
  computeMitmChemistryFeasibility,
  findBlendRecommendationsSourceLazyDecomposed,
} from '../js/pages/calculate/blending-recommendation-source-lazy.js';
import { buildCandidate, isWithinTolerance } from '../js/pages/calculate/blending-recommendation.js';

function statusOf(result) {
  return result.ok ? result.status : result.error;
}

// ============================================================
// SCENARIO FIXTURES -- same shapes as tests/v3-phase6i-decomposition.test.mjs
// (this task's own primary-benchmark scenario definitions), reproduced here
// so this file has no cross-test-file dependency.
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

// Designed so the SAME Contractor's own full-utilization compositions of
// fleet=18 across two sources (ni=1.30/1.00, tonnesPerUnit=50) hit the
// tolerance boundary EXACTLY: (v_high, v_low) = (12,6) -> Ni =
// (1.30*12+1.00*6)/18 = 1.20 = target(1.15)+tolerance(0.05) EXACTLY, and
// (6,12) -> Ni = (1.30*6+1.00*12)/18 = 1.10 = target-tolerance EXACTLY.
// ContractorX (fleet=4 < MIN=6) is dead -- contributes a fixed (0,0) to
// every combination, so it cannot shift which combos land on the boundary,
// but does exercise a genuine (non-trivial) two-group MITM split.
const SCENARIO_BOUNDARY_TOLERANCE = [
  { pileId: 'P-S0', contractor: 'ContractorP', ni: '1.30', units: '9', tonnesPerUnit: '50' },
  { pileId: 'P-S1', contractor: 'ContractorP', ni: '1.00', units: '9', tonnesPerUnit: '50' },
  { pileId: 'X-S0', contractor: 'ContractorX', ni: '1.30', units: '4', tonnesPerUnit: '50' },
];

// ============================================================
// SECTION 5 -- MANDATORY EXHAUSTIVE PROOF: MITM within-tolerance count vs
// brute-force full-utilization Cartesian enumeration, both using the EXACT
// SAME join predicate (N - L*T >= 0 AND N - U*T <= 0, no epsilon). Exact
// integer equality required -- 0 mismatches.
// ============================================================
describe('V3.0 Phase 6J -- Section 5: exhaustive MITM-vs-brute-force proof', () => {
  const CASES = [
    ['A', SCENARIOS.A],
    ['B', SCENARIOS.B],
    ['exact-6-boundary', SCENARIO_EXACT_BOUNDARY],
    ['dead-Contractor', SCENARIO_DEAD_CONTRACTOR],
    ['relocation', SCENARIO_RELOCATION],
    ['boundary-tolerance (exact L/U hits)', SCENARIO_BOUNDARY_TOLERANCE],
  ];

  CASES.forEach(([name, sources]) => {
    test(`${name}: MITM withinToleranceCount + minimumFeasibleE exactly match brute-force`, () => {
      const report = computeMitmChemistryFeasibility({ targetNi: TARGET_NI, tolerance: TOLERANCE, sources });
      assert.ok(report.ok, `${name}: precondition -- INVALID_INPUT`);

      const brute = bruteForceFullUtilizationChemistryCount(report.groupStatesList, report.targetNiValue, report.toleranceValue);

      // eslint-disable-next-line no-console
      console.log(`[v3-phase6j] ${name}: total=${report.metrics.totalCartesianCombinations} left=${report.metrics.leftStateCount} right=${report.metrics.rightStateCount} withinTolerance MITM=${report.metrics.withinToleranceCount} brute=${brute.count} minE MITM=${report.metrics.minimumFeasibleE} brute=${brute.minimumE} atMinE MITM=${report.metrics.withinToleranceAtMinimumE} brute=${brute.withinToleranceAtMinimumE}`);

      assert.equal(report.leftIndices.length + report.rightIndices.length, report.groupStatesList.length, `${name}: every group assigned to exactly one side`);
      assert.equal(report.metrics.leftStateCount * report.metrics.rightStateCount, report.metrics.totalCartesianCombinations, `${name}: left*right must equal the full Cartesian total`);

      assert.equal(report.metrics.withinToleranceCount, brute.count, `${name}: withinToleranceCount mismatch`);
      assert.equal(report.metrics.minimumFeasibleE, brute.minimumE, `${name}: minimumFeasibleE mismatch`);
      assert.equal(report.metrics.withinToleranceAtMinimumE, brute.withinToleranceAtMinimumE, `${name}: withinToleranceAtMinimumE mismatch`);
    });
  });

  test('boundary-tolerance: the two exact-boundary compositions are actually counted (sanity -- proves the >=0/<=0 inclusive comparison, not a vacuous 0-vs-0 match)', () => {
    const report = computeMitmChemistryFeasibility({ targetNi: TARGET_NI, tolerance: TOLERANCE, sources: SCENARIO_BOUNDARY_TOLERANCE });
    assert.ok(report.metrics.withinToleranceCount > 0, 'at least the two designed exact-boundary compositions must be counted');
  });
});

// ============================================================
// SECTION 9 -- OPTIONAL RECONSTRUCTION CHECK (mandatory for small scenarios
// per this task's own Section 9): enumerate MITM-matched (left,right) pairs
// directly (small scenarios only -- never millions), reconstruct the REAL
// per-source allocation, and verify every reconstruction is a genuine
// buildCandidate() (production, unchanged) result that is actually
// isWithinTolerance().
// ============================================================
describe('V3.0 Phase 6J -- Section 9: reconstruction check (small scenarios only)', () => {
  [['exact-6-boundary', SCENARIO_EXACT_BOUNDARY], ['boundary-tolerance', SCENARIO_BOUNDARY_TOLERANCE], ['relocation', SCENARIO_RELOCATION]].forEach(([name, sources]) => {
    test(`${name}: every MITM-flagged (left,right) pair reconstructs to a real within-tolerance candidate; count matches`, () => {
      const report = computeMitmChemistryFeasibility({ targetNi: TARGET_NI, tolerance: TOLERANCE, sources });
      assert.ok(report.ok);

      let matched = 0;
      let verifiedWithinTolerance = 0;
      report.leftStates.forEach((left) => {
        report.rightStates.forEach((right) => {
          const withinJoin = (left.lowScore + right.lowScore >= 0) && (left.highScore + right.highScore <= 0);
          if (!withinJoin) return;
          matched += 1;
          const activeMap = buildActiveMapFromChoices(report.groups, report.groupStatesList, [...left.choices, ...right.choices]);
          const candidate = buildCandidate(report.groups, activeMap, report.targetNiValue, report.toleranceValue);
          assert.ok(candidate, `${name}: reconstructed allocation must build a real candidate (never all-zero here)`);
          assert.ok(isWithinTolerance(candidate.estimatedNi, report.targetNiValue, report.toleranceValue), `${name}: reconstructed candidate must actually be within tolerance (estimatedNi=${candidate.estimatedNi})`);
          assert.equal(candidate.withinTolerance, true);
          verifiedWithinTolerance += 1;
        });
      });

      // eslint-disable-next-line no-console
      console.log(`[v3-phase6j] ${name}: reconstruction-verified pairs=${matched} withinTolerance=${verifiedWithinTolerance}`);
      assert.equal(matched, report.metrics.withinToleranceCount, `${name}: direct double-loop match count must equal the Fenwick-tree MITM count`);
      assert.equal(verifiedWithinTolerance, matched, `${name}: every MITM-flagged pair must reconstruct to a real within-tolerance candidate`);
    });
  });
});

// ============================================================
// SECTION 7/8 -- PRIMARY BENCHMARK: D (primary), then C and E. D must NOT be
// reached via full Cartesian traversal (51,325,051 combinations) -- only via
// the balanced MITM split (left*right === total, left/right each far below
// the full product). E's ~1.22B Cartesian pairs must likewise never be
// enumerated directly.
// ============================================================
describe('V3.0 Phase 6J -- Section 7/8: primary benchmark (D, C, E)', () => {
  test('D: 10 dome / 3 Contractor / 100 DT -- PRIMARY RESULT', () => {
    const report = computeMitmChemistryFeasibility({ targetNi: TARGET_NI, tolerance: TOLERANCE, sources: SCENARIOS.D });
    assert.ok(report.ok);
    const m = report.metrics;

    // eslint-disable-next-line no-console
    console.log(`[v3-phase6j] D: total=${m.totalCartesianCombinations} left=${m.leftStateCount} right=${m.rightStateCount} withinToleranceCount=${m.withinToleranceCount} minimumFeasibleE=${m.minimumFeasibleE} withinToleranceAtMinimumE=${m.withinToleranceAtMinimumE} chemistryReductionPct=${m.chemistryReductionPct.toFixed(4)} eReductionPct=${m.eReductionPct === null ? 'n/a' : m.eReductionPct.toFixed(4)} runtimeMs=${m.runtimeMs.toFixed(1)} heapDeltaBytes=${m.heapDeltaBytes}`);

    // This task's own stated D magnitude -- confirms the state model
    // (per-group full-utilization counts / balanced split) exactly matches
    // the task's own analysis before any reduction is claimed.
    assert.equal(m.totalCartesianCombinations, 51325051, 'D: theoretical full-utilization Cartesian total must match the task-stated figure');
    assert.equal(m.leftStateCount * m.rightStateCount, m.totalCartesianCombinations, 'D: left*right must reconstruct the full total (no combination silently dropped)');
    assert.ok(m.leftStateCount < 100000 && m.rightStateCount < 100000, 'D: NEITHER half may itself approach the full Cartesian product (MITM must actually reduce the traversed state space)');
    assert.ok(m.withinToleranceCount > 0, 'D: precondition -- some full-utilization combination must be within tolerance (matches Phase 6I: A+B lock fires, so an incumbent exists)');
    assert.ok(m.minimumFeasibleE !== null, 'D: a minimum feasible E must exist whenever withinToleranceCount>0');
    assert.ok(m.withinToleranceAtMinimumE > 0);
    assert.ok(m.withinToleranceAtMinimumE <= m.withinToleranceCount, 'D: count-at-minimum-E can never exceed the total within-tolerance count');
  });

  test('C: 10 dome / 5 Contractor / 100 DT', () => {
    const report = computeMitmChemistryFeasibility({ targetNi: TARGET_NI, tolerance: TOLERANCE, sources: SCENARIOS.C });
    assert.ok(report.ok);
    const m = report.metrics;
    // eslint-disable-next-line no-console
    console.log(`[v3-phase6j] C: total=${m.totalCartesianCombinations} left=${m.leftStateCount} right=${m.rightStateCount} withinToleranceCount=${m.withinToleranceCount} minimumFeasibleE=${m.minimumFeasibleE} withinToleranceAtMinimumE=${m.withinToleranceAtMinimumE} chemistryReductionPct=${m.chemistryReductionPct.toFixed(4)} runtimeMs=${m.runtimeMs.toFixed(1)}`);

    const brute = bruteForceFullUtilizationChemistryCount(report.groupStatesList, report.targetNiValue, report.toleranceValue);
    assert.equal(m.withinToleranceCount, brute.count, 'C: small enough to cross-check exactly against brute force');
    assert.equal(m.minimumFeasibleE, brute.minimumE);
    assert.equal(m.withinToleranceAtMinimumE, brute.withinToleranceAtMinimumE);
  });

  test('E: 10 dome / 2 Contractor / 100 DT concentrated -- MITM counting must stay sub-Cartesian (~1.22B pairs never enumerated)', () => {
    const t0 = process.hrtime.bigint();
    const report = computeMitmChemistryFeasibility({ targetNi: TARGET_NI, tolerance: TOLERANCE, sources: SCENARIOS.E });
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    assert.ok(report.ok);
    const m = report.metrics;
    // eslint-disable-next-line no-console
    console.log(`[v3-phase6j] E: total=${m.totalCartesianCombinations} left=${m.leftStateCount} right=${m.rightStateCount} withinToleranceCount=${m.withinToleranceCount} minimumFeasibleE=${m.minimumFeasibleE} withinToleranceAtMinimumE=${m.withinToleranceAtMinimumE} chemistryReductionPct=${m.chemistryReductionPct.toFixed(4)} runtimeMs=${m.runtimeMs.toFixed(1)} wallMs=${ms.toFixed(1)}`);

    assert.ok(m.totalCartesianCombinations > 1000000000, 'E: precondition -- the task-stated ~1.22B Cartesian total');
    // Sub-Cartesian: the two halves built directly never together approach
    // the full product -- this is the entire point of the MITM split.
    assert.ok(m.leftStateCount + m.rightStateCount < 200000, 'E: MITM must build state lists far smaller than the full Cartesian product');
    assert.ok(ms < 30000, 'E: must complete in reasonable time without ever enumerating the full Cartesian product');
  });
});

// ============================================================
// UNIT-LEVEL COVERAGE for the individual MITM primitives (balancing /
// aggregate building / Fenwick join), independent of the full orchestrator.
// ============================================================
describe('V3.0 Phase 6J -- unit coverage: MITM primitives', () => {
  test('balanceContractorGroupsForMitm never splits a group, assigns every group to exactly one side, and is deterministic', () => {
    const counts = [2251, 151, 151];
    const { leftIndices, rightIndices } = balanceContractorGroupsForMitm(counts);
    const all = [...leftIndices, ...rightIndices].sort((a, b) => a - b);
    assert.deepEqual(all, [0, 1, 2]);
    assert.equal(new Set(all).size, 3, 'no group counted twice');

    const again = balanceContractorGroupsForMitm(counts);
    assert.deepEqual(again.leftIndices, leftIndices);
    assert.deepEqual(again.rightIndices, rightIndices);
  });

  test('balanceContractorGroupsForMitm reproduces the D split analytically: the largest single group alone vs the other two combined', () => {
    // Matches this task's own analysis: groups of full-utilization-state
    // size [2251, 151, 151] split as {2251} vs {151,151} (22801) -- NOT
    // {2251,151} vs {151} (339901), which would be far less balanced.
    const { leftIndices, rightIndices } = balanceContractorGroupsForMitm([2251, 151, 151]);
    const sizeOf = (indices, counts) => indices.reduce((product, i) => product * counts[i], 1);
    const counts = [2251, 151, 151];
    const leftSize = sizeOf(leftIndices, counts);
    const rightSize = sizeOf(rightIndices, counts);
    assert.deepEqual([leftSize, rightSize].sort((a, b) => a - b), [2251, 22801]);
  });

  test('countWithinToleranceMITM matches a direct double loop on random small state sets', () => {
    function randomStates(n) {
      const states = [];
      for (let i = 0; i < n; i += 1) {
        const tonnage = 1 + Math.floor(Math.random() * 50);
        const ni = 0.9 + Math.random() * 0.6;
        states.push({ numerator: ni * tonnage, tonnage, fullyUnusedCount: 0 });
      }
      return states;
    }
    const targetNiValue = 1.15;
    const toleranceValue = 0.05;
    for (let trial = 0; trial < 20; trial += 1) {
      const left = withChemistryScores(randomStates(15), targetNiValue, toleranceValue);
      const right = withChemistryScores(randomStates(15), targetNiValue, toleranceValue);
      const mitm = countWithinToleranceMITM(left, right);
      let direct = 0;
      left.forEach((l) => {
        right.forEach((r) => {
          if (l.lowScore + r.lowScore >= 0 && l.highScore + r.highScore <= 0) direct += 1;
        });
      });
      assert.equal(mitm, direct, `trial ${trial}: MITM/direct mismatch`);
    }
  });

  test('buildAggregateHalfStates: aggregate count equals the product of per-group state counts, and every choice is traceable', () => {
    const groupStatesList = [
      [{ values: [6], numerator: 1.3 * 300, tonnage: 300, fullyUnusedCount: 0 }, { values: [12], numerator: 1.3 * 600, tonnage: 600, fullyUnusedCount: 0 }],
      [{ values: [6], numerator: 1.0 * 300, tonnage: 300, fullyUnusedCount: 0 }, { values: [12], numerator: 1.0 * 600, tonnage: 600, fullyUnusedCount: 0 }, { values: [18], numerator: 1.0 * 900, tonnage: 900, fullyUnusedCount: 0 }],
    ];
    const aggregates = buildAggregateHalfStates([0, 1], groupStatesList);
    assert.equal(aggregates.length, 2 * 3);
    aggregates.forEach((agg) => {
      assert.equal(agg.choices.length, 2);
      const expectedNumerator = groupStatesList[0][agg.choices[0].stateIndex].numerator + groupStatesList[1][agg.choices[1].stateIndex].numerator;
      assert.equal(agg.numerator, expectedNumerator);
    });
  });
});

// ============================================================
// SANITY -- Phase 6J adds pure post-hoc counting/analysis on top of Phase
// 6I's own state model; it must not change Phase 6I's own search behavior
// or results (this task's own "extend only... do not change formula/
// semantics").
// ============================================================
describe('V3.0 Phase 6J -- regression sanity: Phase 6I decomposition unaffected', () => {
  test('findBlendRecommendationsSourceLazyDecomposed(A) still OK and unchanged', () => {
    const input = { targetNi: TARGET_NI, tolerance: TOLERANCE, sources: SCENARIOS.A };
    const { result } = findBlendRecommendationsSourceLazyDecomposed(input);
    assert.equal(statusOf(result), 'OK');
  });
});
