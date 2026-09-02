// V3.0 Phase 6I -- Exact Full-Utilization Decomposition Prototype (this
// task's own spec). Phase 6H proved that once a witnessed incumbent's own
// rankMetrics satisfy criticalContractorCount===0 AND
// totalActiveUnits===globalMaxActiveUnits, A and B are PROVEN globally
// optimal for the ENTIRE remaining search, and its own Section 2 domain
// propagation already narrows every subsequent source-value choice to
// EXACTLY the full-utilization subspace -- yet D's own measured behavior
// (lock fires at node ~14,555, unrestricted continuation still exhausts
// 500,000 nodes) shows filtering-in-place is not, by itself, enough. This
// phase asks whether SWITCHING traversal strategy at the lock -- restarting
// a dedicated GROUP-granularity solver over ONLY the full-utilization
// subspace, instead of continuing the SOURCE-granularity tree -- can make D
// complete. See js/pages/calculate/blending-recommendation-source-lazy.js's
// own "PHASE 6I" comment block (above forEachFullUtilizationCandidate()) for
// the full switch-theorem proof and count-formula derivation this file
// verifies.
//
// REUSE, NOT REIMPLEMENTATION: every function under test is imported
// unchanged from the prototype file; every candidate compared below is a
// REAL buildCandidate() object, ranked by the REAL compareWithinTolerance()
// (recommendation-ranking.js) -- never a re-derived stand-in for either.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  binomialCoefficient,
  exactFullUtilizationCount,
  enumerateFullUtilizationAllocations,
  findBlendRecommendationsSourceLazyDecomposed,
  findBlendRecommendationsSourceLazyDecomposedBudgeted,
  findBlendRecommendationsSourceLazyCoupledBudgeted,
} from '../js/pages/calculate/blending-recommendation-source-lazy.js';
import {
  findBlendRecommendationsWithDiagnostics,
  MAX_SEARCH_NODES,
} from '../js/pages/calculate/blending-recommendation.js';
import { MIN_UNITS_PER_ACTIVE_LOADING_POINT, countOperationalAllocations } from '../js/pages/calculate/fleet-allocation.js';
import { canonicalizeRecommendationResult, firstCanonicalDifference } from './reference/canonical-recommendation-result.mjs';

function statusOf(result) {
  return result.ok ? result.status : result.error;
}

// ============================================================
// SECTION 2 -- exact-full-utilization COUNT FORMULA, verified against
// brute-force enumeration (this task's own "verify the formula against
// brute force for small F/n"). Scope matches the task's own: F>=MIN
// (operational Contractors); F<MIN (dead/empty) is a separate, single
// trivial all-zero state, handled by the decomposition solver itself, not
// by this formula.
// ============================================================
describe('V3.0 Phase 6I -- Section 2: exactFullUtilizationCount() formula proof', () => {
  const MIN = MIN_UNITS_PER_ACTIVE_LOADING_POINT;

  function bruteForceCount(fleet, sourceCount) {
    let count = 0;
    function rec(idx, remaining) {
      if (idx === sourceCount) {
        if (remaining === 0) count += 1;
        return;
      }
      rec(idx + 1, remaining);
      for (let v = MIN; v <= remaining; v += 1) rec(idx + 1, remaining - v);
    }
    rec(0, fleet);
    return count;
  }

  test('matches brute-force enumeration for every (fleet, sourceCount) pair, fleet 6-40 / sources 1-5', () => {
    let checked = 0;
    let violations = 0;
    for (let fleet = MIN; fleet <= 40; fleet += 1) {
      for (let n = 1; n <= 5; n += 1) {
        const claimed = exactFullUtilizationCount(fleet, n);
        const actual = bruteForceCount(fleet, n);
        checked += 1;
        if (claimed !== actual) {
          violations += 1;
          // eslint-disable-next-line no-console
          console.log(`[v3-phase6i] VIOLATION fleet=${fleet} n=${n} claimed=${claimed} actual=${actual}`);
        }
      }
    }
    // eslint-disable-next-line no-console
    console.log(`[v3-phase6i] Section 2 formula proof: checked=${checked} violations=${violations}`);
    assert.equal(violations, 0);
  });

  test('fleet<MIN (dead/empty Contractor): formula reports 0 -- caller treats this as a SEPARATE single all-zero state, not "zero states"', () => {
    for (let fleet = 0; fleet < MIN; fleet += 1) {
      assert.equal(exactFullUtilizationCount(fleet, 3), 0, `fleet=${fleet}`);
    }
  });

  test('binomialCoefficient() matches Pascal-triangle values for small n,k', () => {
    assert.equal(binomialCoefficient(5, 0), 1);
    assert.equal(binomialCoefficient(5, 5), 1);
    assert.equal(binomialCoefficient(5, 2), 10);
    assert.equal(binomialCoefficient(10, 3), 120);
    assert.equal(binomialCoefficient(3, 5), 0, 'k>n is 0');
    assert.equal(binomialCoefficient(3, -1), 0, 'k<0 is 0');
  });

  test('reported D/C/E per-Contractor magnitudes are FAR below the unrestricted per-Contractor operational count (this task\'s own Section 6)', () => {
    const cases = [
      ['D: F=40,n=4', 40, 4],
      ['D: F=30,n=3', 30, 3],
      ['C: F=20,n=2', 20, 2],
      ['E: F=50,n=5', 50, 5],
    ];
    cases.forEach(([name, fleet, n]) => {
      const operational = countOperationalAllocations(fleet, n);
      const fullUtil = exactFullUtilizationCount(fleet, n);
      // eslint-disable-next-line no-console
      console.log(`[v3-phase6i] ${name}: operational=${operational} fullUtilization=${fullUtil} ratio=${(fullUtil / operational).toFixed(6)}`);
      assert.ok(fullUtil < operational, `${name}: full-utilization count must be strictly smaller than the unrestricted operational count`);
    });
  });
});

// ============================================================
// SECTION 3 -- LAZY GENERATION correctness: enumerateFullUtilizationAllocations()
// yields exactly exactFullUtilizationCount(fleet,n) DISTINCT allocations,
// every one summing to `fleet` with every value 0-or->=MIN (this task's own
// "0 OR >=6" domain), and NEVER caps a source by any originally-assigned
// fleet (the generator only ever sees `fleet`/`sourceCount`, no per-source
// ceiling parameter exists at all).
// ============================================================
describe('V3.0 Phase 6I -- Section 3: enumerateFullUtilizationAllocations() lazy generation proof', () => {
  const MIN = MIN_UNITS_PER_ACTIVE_LOADING_POINT;

  test('every yielded allocation is valid and distinct; count matches the closed-form formula, for fleet 6-36 / sources 1-4', () => {
    let casesChecked = 0;
    for (let fleet = MIN; fleet <= 36; fleet += 1) {
      for (let n = 1; n <= 4; n += 1) {
        const seen = new Set();
        let count = 0;
        for (const values of enumerateFullUtilizationAllocations(fleet, n)) {
          count += 1;
          assert.equal(values.length, n);
          const key = values.join(',');
          assert.ok(!seen.has(key), `duplicate allocation ${key} for fleet=${fleet} n=${n}`);
          seen.add(key);
          const sum = values.reduce((a, b) => a + b, 0);
          assert.equal(sum, fleet, `allocation ${key} must sum to fleet=${fleet}`);
          values.forEach((v) => assert.ok(v === 0 || v >= MIN, `value ${v} violates the 0-or->=MIN domain`));
        }
        assert.equal(count, exactFullUtilizationCount(fleet, n), `fleet=${fleet} n=${n}: generator count must match the closed-form formula`);
        casesChecked += 1;
      }
    }
    // eslint-disable-next-line no-console
    console.log(`[v3-phase6i] Section 3 generation proof: casesChecked=${casesChecked}`);
  });

  test('fleet<MIN yields nothing (dead/empty Contractor has no full-utilization state via this generator -- handled as a separate trivial state)', () => {
    for (let fleet = 0; fleet < MIN; fleet += 1) {
      const values = Array.from(enumerateFullUtilizationAllocations(fleet, 3));
      assert.equal(values.length, 0, `fleet=${fleet}`);
    }
  });
});

// ============================================================
// SCENARIO FIXTURES -- same shapes as tests/v3-phase6h-source-prefix-propagation.test.mjs
// (this task's own primary-benchmark scenario definitions: C=10 dome/5
// Contractor/100 DT, D=10 dome/3 Contractor/100 DT, E=10 dome/2
// Contractor/100 DT concentrated), reproduced here so this file has no
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

const SCENARIO_UNACHIEVABLE = buildScenarioSources([2, 2], 10, '1.35', '1.32');

// ============================================================
// SECTION 9 -- mandatory exhaustive SWITCH-THEOREM proof: 6I decomposition
// vs the ordinary (unpropagated) exhaustive lazy search, requiring EXACT
// equality of winner/status/candidateCount/estimatedNi/allocationSignature/
// relocation (via the full canonicalized-result comparison, which covers
// all of those fields). Covers: lock fires early (A, node 835), lock fires
// late (C, node 4750; B, node 4750), lock never fires (dead-Contractor,
// permanently critical), TARGET_NOT_ACHIEVABLE (no incumbent ever exists),
// exact-6-boundary and relocation (constrained per-Contractor shapes).
// 0 mismatches required.
// ============================================================
describe('V3.0 Phase 6I -- Section 9: exhaustive switch-theorem proof (decomposition vs ordinary lazy)', () => {
  const CASES = [
    ['A (lock fires early)', SCENARIOS.A, MAX_SEARCH_NODES],
    ['B (lock fires late)', SCENARIOS.B, MAX_SEARCH_NODES],
    // C's own ORDINARY (unpropagated) lazy engine needs >500,000 nodes to
    // complete (Phase 6G's own established finding: 585,528) -- the default
    // budget is not itself the oracle for this scenario; a fair oracle here
    // is the SAME 1,000,000-node budget Phase 6H's own primary-benchmark
    // test used for C.
    ['C (lock fires late, larger)', SCENARIOS.C, 1000000],
    ['dead-Contractor (lock never fires)', SCENARIO_DEAD_CONTRACTOR, MAX_SEARCH_NODES],
    ['exact-6-boundary', SCENARIO_EXACT_BOUNDARY, MAX_SEARCH_NODES],
    ['relocation', SCENARIO_RELOCATION, MAX_SEARCH_NODES],
    ['zero-allocations (TARGET_NOT_ACHIEVABLE)', SCENARIO_UNACHIEVABLE, MAX_SEARCH_NODES],
  ];

  CASES.forEach(([name, sources, oracleNodeBudget]) => {
    test(`${name}: decomposition result byte-identical to ordinary (unpropagated) exhaustive lazy`, () => {
      const input = { targetNi: TARGET_NI, tolerance: TOLERANCE, sources };
      const decomposed = findBlendRecommendationsSourceLazyDecomposed(input);
      const ordinary = findBlendRecommendationsSourceLazyCoupledBudgeted(input, oracleNodeBudget);

      assert.notEqual(statusOf(ordinary.result), 'SEARCH_INCOMPLETE', `${name}: precondition -- the ordinary-lazy oracle itself must complete at nodeBudget=${oracleNodeBudget}`);
      assert.equal(statusOf(decomposed.result), statusOf(ordinary.result), `${name}: status mismatch`);
      const canonD = canonicalizeRecommendationResult(decomposed.result);
      const canonO = canonicalizeRecommendationResult(ordinary.result);
      const mismatch = firstCanonicalDifference(canonO, canonD);
      assert.equal(mismatch, null, `${name}: ${mismatch}`);
      assert.equal(decomposed.result.candidateCount, ordinary.result.candidateCount, `${name}: candidateCount (theoretical operational space, unchanged by decomposition)`);
    });
  });

  ['A (lock fires early)', 'B (lock fires late)'].forEach((name) => {
    const sources = name.startsWith('A') ? SCENARIOS.A : SCENARIOS.B;
    test(`${name}: decomposition result also byte-identical to production (group-level)`, () => {
      const input = { targetNi: TARGET_NI, tolerance: TOLERANCE, sources };
      const decomposed = findBlendRecommendationsSourceLazyDecomposed(input);
      const production = findBlendRecommendationsWithDiagnostics(input);
      assert.equal(statusOf(decomposed.result), 'OK');
      assert.equal(statusOf(production.result), 'OK');
      const mismatch = firstCanonicalDifference(
        canonicalizeRecommendationResult(production.result),
        canonicalizeRecommendationResult(decomposed.result),
      );
      assert.equal(mismatch, null, `${name}: ${mismatch}`);
    });
  });

  test('TARGET_NOT_ACHIEVABLE stays exact: decomposition never switches, result matches ordinary lazy exactly', () => {
    const input = { targetNi: TARGET_NI, tolerance: TOLERANCE, sources: SCENARIO_UNACHIEVABLE };
    const { result, diagnostics } = findBlendRecommendationsSourceLazyDecomposed(input);
    assert.equal(statusOf(result), 'TARGET_NOT_ACHIEVABLE');
    assert.equal(diagnostics.switchedToDecomposition, false, 'no within-tolerance candidate ever exists, so the A/B lock -- and the switch -- can never fire');
    assert.equal(diagnostics.decompositionVisitedNodes, 0);
  });

  test('dead-Contractor: lock never fires (permanently critical), decomposition never switches', () => {
    const input = { targetNi: TARGET_NI, tolerance: TOLERANCE, sources: SCENARIO_DEAD_CONTRACTOR };
    const { diagnostics } = findBlendRecommendationsSourceLazyDecomposed(input);
    assert.equal(diagnostics.switchedToDecomposition, false);
    assert.equal(diagnostics.nodeAtPrefixLock, null);
    assert.equal(diagnostics.decompositionVisitedNodes, 0);
  });

  test('determinism: two independent decomposed runs on scenario C produce an identical result', () => {
    const input = { targetNi: TARGET_NI, tolerance: TOLERANCE, sources: SCENARIOS.C };
    const run1 = findBlendRecommendationsSourceLazyDecomposed(input);
    const run2 = findBlendRecommendationsSourceLazyDecomposed(input);
    assert.equal(statusOf(run1.result), statusOf(run2.result));
    assert.deepEqual(run1.result.candidate, run2.result.candidate);
    assert.equal(run1.diagnostics.decompositionVisitedNodes, run2.diagnostics.decompositionVisitedNodes);
    assert.equal(run1.diagnostics.nodeAtPrefixLock, run2.diagnostics.nodeAtPrefixLock);
  });
});

// ============================================================
// SECTION 7/8/13 -- PRIMARY BENCHMARK + PHASE GATE. Compare against Phase
// 6H's own findings (D locks at node 14,555 but the unrestricted
// continuation still exhausts 500,000). Node budgets below are
// deliberately test-scoped (this task's own "prototype may use the
// existing test-only budget mechanism... do not raise production
// MAX_SEARCH_NODES") and kept smaller than the full theoretical
// full-utilization subspace so this suite finishes in reasonable CI time;
// see this file's own console diagnostics, and the task's written report,
// for the extrapolated full-budget runtime.
// ============================================================
describe('V3.0 Phase 6I -- Section 7/8/13: primary benchmark + phase gate', () => {
  test('sanity: production MAX_SEARCH_NODES still exactly 500000 (never modified by this prototype)', () => {
    assert.equal(MAX_SEARCH_NODES, 500000);
  });

  test('C: 10 dome / 5 Contractor / 100 DT -- must complete, byte-identical to the Phase 6G/6H oracle', () => {
    const input = { targetNi: TARGET_NI, tolerance: TOLERANCE, sources: SCENARIOS.C };
    const t0 = process.hrtime.bigint();
    const { result, diagnostics } = findBlendRecommendationsSourceLazyDecomposedBudgeted(input, 500000, 500000);
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    // eslint-disable-next-line no-console
    console.log(`[v3-phase6i] C: status=${statusOf(result)} nodeAtPrefixLock=${diagnostics.nodeAtPrefixLock} phaseA.visitedNodes=${diagnostics.visitedNodes} decompositionVisitedNodes=${diagnostics.decompositionVisitedNodes} fullUtilizationStatesGenerated=${diagnostics.fullUtilizationStatesGenerated} perGroupStateCounts=${JSON.stringify(diagnostics.perGroupStateCounts)} completedCandidates=${diagnostics.completedCandidates} prunedByChemistry=${diagnostics.prunedByChemistry} prunedByRanking=${diagnostics.prunedByRanking} runtime=${ms.toFixed(1)}ms`);

    assert.notEqual(statusOf(result), 'SEARCH_INCOMPLETE', 'PRIMARY GATE: C must complete');
    assert.ok(diagnostics.switchedToDecomposition, 'precondition: C must actually exercise the decomposition switch');

    const oracle = findBlendRecommendationsSourceLazyCoupledBudgeted(input, 1000000);
    assert.notEqual(statusOf(oracle.result), 'SEARCH_INCOMPLETE', 'precondition: oracle must itself complete (Phase 6G baseline)');
    const mismatch = firstCanonicalDifference(
      canonicalizeRecommendationResult(oracle.result),
      canonicalizeRecommendationResult(result),
    );
    assert.equal(mismatch, null, `C: decomposition winner must match the Phase 6G/6H oracle exactly: ${mismatch}`);
  });

  test('D: 10 dome / 3 Contractor / 100 DT -- report against the PRIMARY GATE honestly (this task\'s own Section 10/13 REJECT/STOP branch)', () => {
    const input = { targetNi: TARGET_NI, tolerance: TOLERANCE, sources: SCENARIOS.D };
    const t0 = process.hrtime.bigint();
    const { result, diagnostics } = findBlendRecommendationsSourceLazyDecomposedBudgeted(input, 500000, 1000000);
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    const gateMet = statusOf(result) !== 'SEARCH_INCOMPLETE';
    const theoreticalCombinations = diagnostics.perGroupStateCounts ? diagnostics.perGroupStateCounts.reduce((a, b) => a * b, 1) : null;
    // eslint-disable-next-line no-console
    console.log(`[v3-phase6i] D: status=${statusOf(result)} nodeAtPrefixLock=${diagnostics.nodeAtPrefixLock} phaseA.visitedNodes=${diagnostics.visitedNodes} decompositionVisitedNodes=${diagnostics.decompositionVisitedNodes} fullUtilizationStatesGenerated=${diagnostics.fullUtilizationStatesGenerated} perGroupStateCounts=${JSON.stringify(diagnostics.perGroupStateCounts)} theoreticalFullUtilCombinations=${theoreticalCombinations} completedCandidates=${diagnostics.completedCandidates} prunedByChemistry=${diagnostics.prunedByChemistry} prunedByRanking=${diagnostics.prunedByRanking} runtime=${ms.toFixed(1)}ms PRIMARY_GATE=${gateMet ? 'PASS' : 'FAIL -- see task Section 10/13 REJECT/STOP'}`);

    assert.ok(diagnostics.decompositionVisitedNodes <= 1000000);
    assert.ok(diagnostics.switchedToDecomposition, 'precondition: D must actually exercise the decomposition switch (matches this task\'s own "locks at node 14,555")');
    assert.equal(diagnostics.nodeAtPrefixLock, 14555, 'D\'s own lock node, matching this task\'s own stated figure');

    // No oracle available for D (ordinary lazy never completes D even at
    // 5,000,000 -- Phase 6H's own finding) -- only determinism is checked,
    // mirroring Phase 6H's own D handling.
    const repeat = findBlendRecommendationsSourceLazyDecomposedBudgeted(input, 500000, 1000000);
    assert.equal(repeat.diagnostics.decompositionVisitedNodes, diagnostics.decompositionVisitedNodes, 'D: determinism -- two independent runs must visit the same node count');
  });

  test('E: 10 dome / 2 Contractor / 100 DT concentrated -- report honestly, must not compromise C/D correctness', () => {
    const input = { targetNi: TARGET_NI, tolerance: TOLERANCE, sources: SCENARIOS.E };
    const t0 = process.hrtime.bigint();
    const { result, diagnostics } = findBlendRecommendationsSourceLazyDecomposedBudgeted(input, 500000, 500000);
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    const theoreticalCombinations = diagnostics.perGroupStateCounts ? diagnostics.perGroupStateCounts.reduce((a, b) => a * b, 1) : null;
    // eslint-disable-next-line no-console
    console.log(`[v3-phase6i] E: status=${statusOf(result)} nodeAtPrefixLock=${diagnostics.nodeAtPrefixLock} decompositionVisitedNodes=${diagnostics.decompositionVisitedNodes} perGroupStateCounts=${JSON.stringify(diagnostics.perGroupStateCounts)} theoreticalFullUtilCombinations=${theoreticalCombinations} runtime=${ms.toFixed(1)}ms`);
    assert.ok(diagnostics.decompositionVisitedNodes <= 500000);
  });
});
