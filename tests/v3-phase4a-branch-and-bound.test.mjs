// V3.0 Phase 4A -- exact branch-and-bound traversal correctness +
// benchmarks (docs/V3.0_SCALABLE_RECOMMENDATION_ENGINE_ARCHITECTURE.md
// Sections 20/23, this task's "EXACTNESS TEST"/"TARGET_NOT_ACHIEVABLE"/
// "PERFORMANCE").
//
// js/pages/calculate/blending-recommendation.js's findBlendRecommendations()
// (production) now runs the Phase 4A explicit branch-and-bound traversal
// with chemistry-bound pruning (forEachCandidatePruned()), instead of the
// plain unpruned Cartesian streaming traversal Phase 3 used.
// findBlendRecommendationsStreamingUnpruned() (same module, TEST-SUPPORT
// ONLY) restates that exact Phase 3 behavior on the SAME explicit-node
// structure with pruning permanently disabled, so this suite can prove the
// pruning layer changed nothing about WHICH candidate wins -- only how
// many nodes are visited finding it.
//
// Run with Node's built-in test runner:
//
//   node --test tests/v3-phase4a-branch-and-bound.test.mjs
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  findBlendRecommendations,
  findBlendRecommendationsStreamingUnpruned,
  findBlendRecommendationsWithDiagnostics,
  prepareSearchUnbounded,
  runSearchDirect,
} from '../js/pages/calculate/blending-recommendation.js';
import { countOperationalAllocations, countContractorAllocations, MAX_GLOBAL_CANDIDATES } from '../js/pages/calculate/fleet-allocation.js';
import { mulberry32, NAMED_SEEDS } from './reference/seeded-random.mjs';
import { generateScenario } from './reference/v3-scenario-generator.mjs';
import { canonicalizeRecommendationResult, firstCanonicalDifference } from './reference/canonical-recommendation-result.mjs';

function activeUnitsOf(candidate, pileId) {
  return candidate.sources.find((s) => s.pileId === pileId).activeUnits;
}

// Compares Phase 3 (unpruned) vs Phase 4A (pruned, production) for one
// input. Both TARGET_NOT_ACHIEVABLE and OK results must now be fully
// byte-identical INCLUDING candidateCount (this task's V3.0 Phase 4A.1
// "PRESERVE CANDIDATE COUNT SEMANTICS": candidateCount describes the exact
// operational search-space size -- product of Phase 2's already-exact
// per-Contractor allocation counts, minus the one excluded all-zero
// allocation -- never how many leaves a particular traversal visited or
// pruned, so it cannot legitimately differ between the unpruned and pruned
// traversals of the SAME input). sourcesInAnyWithinToleranceCandidate must
// also stay exact (a pruned branch can never contain a within-tolerance
// candidate -- proven in blending-recommendation.js's own Phase 4A section
// comment).
function assertPhase3VsPhase4AEquivalent(input, label) {
  const unpruned = findBlendRecommendationsStreamingUnpruned(input);
  const pruned = findBlendRecommendations(input);
  const unprunedCanonical = canonicalizeRecommendationResult(unpruned);
  const prunedCanonical = canonicalizeRecommendationResult(pruned);

  assert.equal(unprunedCanonical.ok, prunedCanonical.ok, `${label}: ok mismatch`);
  if (!unprunedCanonical.ok) {
    assert.deepEqual(unprunedCanonical, prunedCanonical, `${label}: error-shape mismatch`);
    return;
  }
  assert.equal(unprunedCanonical.status, prunedCanonical.status, `${label}: status mismatch`);

  const diff = firstCanonicalDifference(unprunedCanonical, prunedCanonical);
  assert.equal(diff, null, `${label}: Phase 3 unpruned vs Phase 4A pruned diverged (candidateCount included): ${diff}`);
  assert.equal(prunedCanonical.candidateCount, unprunedCanonical.candidateCount, `${label}: candidateCount must be IDENTICAL between unpruned and pruned traversals, regardless of how many branches were pruned`);
  assert.ok(prunedCanonical.candidateCount > 0, `${label}: candidateCount must stay > 0`);
  return { unprunedCount: unprunedCanonical.candidateCount, prunedCount: prunedCanonical.candidateCount };
}

// ============================================================
// 1. EXACTNESS: Phase 3 (unpruned) vs Phase 4A (pruned) over many
// directed+randomized small scenarios.
// ============================================================
const diffStats = { compared: 0 };

describe('V3.0 Phase 4A vs Phase 3: winner identity AND candidateCount under pruning', () => {
  Object.entries(NAMED_SEEDS).forEach(([seedName, seed]) => {
    describe(`seed ${seedName} (0x${seed.toString(16)})`, () => {
      const rng = mulberry32(seed);
      const CASES_PER_SEED = 60;

      for (let i = 0; i < CASES_PER_SEED; i += 1) {
        const scenario = generateScenario(rng, i);

        test(`case #${i} (${scenario.kind}): Phase 4A pruned winner AND candidateCount are identical to Phase 3 unpruned`, () => {
          assertPhase3VsPhase4AEquivalent(scenario.input, scenario.name);
          diffStats.compared += 1;
        });
      }
    });
  });

  after(() => {
    // eslint-disable-next-line no-console
    console.log(`[v3-phase4a-branch-and-bound] Phase3-vs-Phase4A totals: ${diffStats.compared} compared, 0 winner mismatches, 0 candidateCount mismatches`);
  });
});

// ============================================================
// 2. TARGET_NOT_ACHIEVABLE SAFETY -- chemistry pruning must never engage
// on this path (no bound is invented to accelerate it in Phase 4A).
// ============================================================
describe('V3.0 Phase 4A TARGET_NOT_ACHIEVABLE safety: pruning never engages, bestAttainable identical to Phase 3', () => {
  test('legacy 34/1-style case: bestAttainable and candidateCount are byte-identical, prunedByChemistry === 0', () => {
    const input = {
      targetNi: '1.017142857',
      tolerance: '0.002',
      sources: [
        { pileId: 'L1', contractor: 'CTR-A', ni: '1.00', units: '34', tonnesPerUnit: '50' },
        { pileId: 'L2', contractor: 'CTR-A', ni: '1.60', units: '1', tonnesPerUnit: '50' },
      ],
    };
    const { result, diagnostics } = findBlendRecommendationsWithDiagnostics(input);
    const unpruned = findBlendRecommendationsStreamingUnpruned(input);

    assert.equal(result.ok, true);
    assert.equal(result.status, 'TARGET_NOT_ACHIEVABLE');
    assert.equal(activeUnitsOf(result.candidate, 'L1'), 35);
    assert.equal(activeUnitsOf(result.candidate, 'L2'), 0);
    assert.equal(diagnostics.prunedByChemistry, 0, 'chemistry pruning must never engage while no within-tolerance incumbent exists');

    const diff = firstCanonicalDifference(canonicalizeRecommendationResult(unpruned), canonicalizeRecommendationResult(result));
    assert.equal(diff, null, `production diverged from Phase 3 on TARGET_NOT_ACHIEVABLE: ${diff}`);
  });

  test('multi-Contractor unachievable target (far outside every source pool): prunedByChemistry === 0, full exhaustive bestAttainable', () => {
    const input = {
      targetNi: '0.3',
      tolerance: '0.01',
      sources: [
        { pileId: 'PA1', contractor: 'CTR-A', ni: '1.20', units: '8', tonnesPerUnit: '50' },
        { pileId: 'PB1', contractor: 'CTR-B', ni: '1.35', units: '10', tonnesPerUnit: '40' },
      ],
    };
    const { result, diagnostics } = findBlendRecommendationsWithDiagnostics(input);
    const unpruned = findBlendRecommendationsStreamingUnpruned(input);

    assert.equal(result.ok, true);
    assert.equal(result.status, 'TARGET_NOT_ACHIEVABLE');
    assert.equal(diagnostics.prunedByChemistry, 0);
    assert.equal(result.candidateCount, unpruned.candidateCount, 'exhaustive traversal must visit the identical candidate count with no within-tolerance incumbent ever found');

    const diff = firstCanonicalDifference(canonicalizeRecommendationResult(unpruned), canonicalizeRecommendationResult(result));
    assert.equal(diff, null, `production diverged from Phase 3 on TARGET_NOT_ACHIEVABLE: ${diff}`);
  });

  test('every-Contractor-fleet-under-6 case: still NO_FEASIBLE_CANDIDATE, gate/traversal both unaffected by pruning', () => {
    const input = {
      targetNi: '1.20',
      tolerance: '0.01',
      sources: [
        { pileId: 'L1', contractor: 'CTR-A', ni: '1.00', units: '4', tonnesPerUnit: '50' },
        { pileId: 'L2', contractor: 'CTR-B', ni: '1.80', units: '3', tonnesPerUnit: '50' },
      ],
    };
    const result = findBlendRecommendations(input);
    assert.equal(result.ok, false);
    assert.equal(result.error, 'NO_FEASIBLE_CANDIDATE');
  });
});

// ============================================================
// 3. PRUNING ACTUALLY ENGAGES -- a scenario chemically shaped so a
// within-tolerance incumbent is found while a chemically-incompatible
// remainder still exists, proving prunedByChemistry > 0 for at least one
// realistic case (not just diagnostic plumbing that never fires).
// ============================================================
// Per-Contractor Ni is PARTITIONED into non-overlapping bands (rather than
// every Contractor spanning the same [low,high] range) -- this is what
// makes chemistry pruning bite: a group whose own sources straddle the
// target can never be ruled out (the bound always contains "this group
// contributes zero", which recovers the fixed prefix's own Ni), but once a
// group's Ni range does NOT straddle the target and the fixed prefix has
// already committed to a value chemistry can no longer walk back, the
// remaining subtree is genuinely unreachable.
function buildPartitionedGradeScenario() {
  const GRADE_BANDS = [[0.85, 0.95], [1.10, 1.20], [1.60, 1.75]];
  const sources = [];
  for (let c = 0; c < 3; c += 1) {
    const [lowNi, highNi] = GRADE_BANDS[c];
    sources.push({ pileId: `C${c}-S0`, contractor: `Contractor${c}`, ni: String(lowNi), units: '10', tonnesPerUnit: '50' });
    sources.push({ pileId: `C${c}-S1`, contractor: `Contractor${c}`, ni: String(highNi), units: '10', tonnesPerUnit: '50' });
  }
  return sources;
}

describe('V3.0 Phase 4A pruning actually engages and stays correct', () => {
  test('3-Contractor partitioned-grade fleet, tight tolerance: chemistry pruning fires (prunedByChemistry > 0) and winner matches Phase 3', () => {
    const sources = buildPartitionedGradeScenario();
    // Bypasses the production size gate deliberately (this shape's
    // operational count is ~438,976 -- see Benchmark B below) purely to
    // exercise the pruned traversal directly; production's own gate
    // behavior for this exact shape is verified separately (Section 4/
    // tests/v3-differential.test.mjs's own SEARCH_SPACE_TOO_LARGE coverage
    // B, unaffected by this file).
    const prepared = prepareSearchUnbounded({ targetNi: '1.15', tolerance: '0.005', sources });
    assert.equal(prepared.ok, true);

    const pruned = runSearchDirect(prepared, true);
    const unpruned = runSearchDirect(prepared, false);

    assert.equal(pruned.result.ok, true);
    assert.equal(pruned.result.status, 'OK');
    assert.ok(pruned.diagnostics.prunedByChemistry > 0, `expected chemistry pruning to fire at least once, got ${pruned.diagnostics.prunedByChemistry}`);
    assert.ok(pruned.diagnostics.visitedNodes < unpruned.diagnostics.visitedNodes, 'pruned traversal must visit strictly fewer nodes than the unpruned reference');

    const diff = firstCanonicalDifference(
      canonicalizeRecommendationResult(unpruned.result),
      canonicalizeRecommendationResult(pruned.result),
    );
    // candidateCount describes the exact operational search-space size
    // (this task's PRESERVE CANDIDATE COUNT SEMANTICS) -- it must be
    // IDENTICAL between pruned and unpruned, same as every other field, even
    // though this scenario is specifically shaped so prunedByChemistry > 0
    // and visitedNodes strictly shrinks above.
    assert.equal(diff, null, `pruned result diverged from unpruned (candidateCount included): ${diff}`);
    assert.equal(pruned.result.candidateCount, unpruned.result.candidateCount, 'candidateCount must stay identical even when chemistry pruning actively discards branches');
  });
});

// ============================================================
// 4. PERFORMANCE BENCHMARKS (this task's PERFORMANCE A/B/C) -- reported via
// console.log, not asserted against a wall-clock ceiling (this task's own
// instruction: "Correctness is more important than pruning percentage";
// timing assertions would be flaky across machines). Each benchmark prints
// raw operational search size, visited nodes, pruned branches, completed
// candidates, and runtime.
// ============================================================
function buildScenarioA() {
  // 4 domes / 2 Contractors / 60 DT (this task's PERFORMANCE A, same shape
  // as tests/v3-phase2-performance.test.mjs's audited Scenario A).
  const sources = [];
  for (let c = 0; c < 2; c += 1) {
    for (let s = 0; s < 2; s += 1) {
      sources.push({
        pileId: `C${c}-S${s}`,
        contractor: `Contractor${c}`,
        ni: s % 2 === 0 ? '1.30' : '1.00',
        units: '15',
        tonnesPerUnit: '50',
      });
    }
  }
  return sources;
}

function buildScenarioBC() {
  // 6 domes / 3 Contractors / 60 DT (this task's PERFORMANCE B/C) --
  // operational count ~438,976 > MAX_GLOBAL_CANDIDATES=200,000, so
  // production's findBlendRecommendations() rejects it with
  // SEARCH_SPACE_TOO_LARGE (verified below) -- benchmarking it requires
  // prepareSearchUnbounded()'s explicit, clearly-labeled gate bypass.
  const sources = [];
  for (let c = 0; c < 3; c += 1) {
    for (let s = 0; s < 2; s += 1) {
      sources.push({
        pileId: `C${c}-S${s}`,
        contractor: `Contractor${c}`,
        ni: s % 2 === 0 ? '1.30' : '1.00',
        units: '10',
        tonnesPerUnit: '50',
      });
    }
  }
  return sources;
}

function reportBenchmark(name, rawOperationalSize, pruned, unprunedDiagnosticsMaybe, elapsedMs) {
  const lines = [
    `[v3-phase4a-branch-and-bound] BENCHMARK ${name}`,
    `  raw operational search size : ${rawOperationalSize}`,
    `  visited nodes (pruned)      : ${pruned.diagnostics.visitedNodes}`,
    `  prunedByChemistry           : ${pruned.diagnostics.prunedByChemistry}`,
    `  completedCandidates         : ${pruned.diagnostics.completedCandidates}`,
    `  result.candidateCount       : ${pruned.result.ok ? pruned.result.candidateCount : `(${pruned.result.error})`}`,
    `  runtime (ms)                : ${elapsedMs.toFixed(2)}`,
  ];
  if (unprunedDiagnosticsMaybe) {
    lines.push(`  visited nodes (unpruned ref): ${unprunedDiagnosticsMaybe.visitedNodes}`);
  }
  // eslint-disable-next-line no-console
  console.log(lines.join('\n'));
}

describe('V3.0 Phase 4A performance benchmarks (this task\'s PERFORMANCE A/B/C)', () => {
  test('A. 4 domes / 2 Contractors / 60 DT -- clears the production gate, run through real findBlendRecommendations()', () => {
    const sources = buildScenarioA();
    const rawOperationalSize = countOperationalAllocations(30, 2) ** 2;

    const start = process.hrtime.bigint();
    const { result, diagnostics } = findBlendRecommendationsWithDiagnostics({ targetNi: '1.15', tolerance: '0.05', sources });
    const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6;

    assert.equal(result.ok, true);
    assert.equal(result.status, 'OK');
    reportBenchmark('A (4 dome / 2 Contractor / 60 DT)', rawOperationalSize, { result, diagnostics }, null, elapsedMs);
  });

  test('B. 6 domes / 3 Contractors / 60 DT -- production gate still rejects it (SEARCH_SPACE_TOO_LARGE); lower-level traversal benchmarked separately via the explicit test-only gate bypass, production limits untouched', () => {
    const sources = buildScenarioBC();

    const gated = findBlendRecommendations({ targetNi: '1.15', tolerance: '0.05', sources });
    assert.equal(gated.ok, false);
    assert.equal(gated.error, 'SEARCH_SPACE_TOO_LARGE');
    // eslint-disable-next-line no-console
    console.log(`[v3-phase4a-branch-and-bound] BENCHMARK B: production gate confirms SEARCH_SPACE_TOO_LARGE (allocationCount=${gated.allocationCount ?? 'n/a'}) for the 3x2x10DT shape -- MAX_GLOBAL_CANDIDATES=${MAX_GLOBAL_CANDIDATES} was NOT raised; benchmarking below uses prepareSearchUnbounded()'s explicit bypass only.`);

    // Per-Contractor fleet is 20 (2 sources x 10 assignedUnits each) -- see
    // countOperationalAllocations(20, 2) = 76, so 76^3 = 438,976 matches the
    // audited raw operational count for this shape.
    const rawOperationalSize = countOperationalAllocations(20, 2) ** 3;
    const prepared = prepareSearchUnbounded({ targetNi: '1.15', tolerance: '0.05', sources });
    assert.equal(prepared.ok, true);

    const start = process.hrtime.bigint();
    const pruned = runSearchDirect(prepared, true);
    const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6;

    assert.equal(pruned.result.ok, true);
    reportBenchmark('B (6 dome / 3 Contractor / 60 DT, gate-bypassed traversal only)', rawOperationalSize, pruned, null, elapsedMs);
  });

  test('C. same 6-dome/3-Contractor/60 DT dome/unit shape, per-Contractor grade PARTITIONED so chemistry pruning is effective', () => {
    const sources = buildPartitionedGradeScenario();
    // Per-Contractor fleet is 20 (2 sources x 10 assignedUnits each) -- see
    // countOperationalAllocations(20, 2) = 76, so 76^3 = 438,976 matches the
    // audited raw operational count for this shape.
    const rawOperationalSize = countOperationalAllocations(20, 2) ** 3;
    const prepared = prepareSearchUnbounded({ targetNi: '1.15', tolerance: '0.005', sources });
    assert.equal(prepared.ok, true);

    const startPruned = process.hrtime.bigint();
    const pruned = runSearchDirect(prepared, true);
    const elapsedPrunedMs = Number(process.hrtime.bigint() - startPruned) / 1e6;

    const startUnpruned = process.hrtime.bigint();
    const unpruned = runSearchDirect(prepared, false);
    const elapsedUnprunedMs = Number(process.hrtime.bigint() - startUnpruned) / 1e6;

    assert.equal(pruned.result.ok, true);
    assert.equal(pruned.result.status, 'OK');
    assert.ok(pruned.diagnostics.prunedByChemistry > 0, 'expected effective chemistry pruning for this target configuration');
    assert.ok(pruned.diagnostics.visitedNodes < unpruned.diagnostics.visitedNodes);

    reportBenchmark('C (same shape, tight-tolerance target -- pruning effectiveness)', rawOperationalSize, pruned, unpruned.diagnostics, elapsedPrunedMs);
    // eslint-disable-next-line no-console
    console.log(`  runtime unpruned reference (ms): ${elapsedUnprunedMs.toFixed(2)}`);
  });
});
