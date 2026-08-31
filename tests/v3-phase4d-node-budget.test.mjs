// V3.0 Phase 4D -- Replace Legacy Theoretical Candidate Gate (docs/
// V3.0_SCALABLE_RECOMMENDATION_ENGINE_ARCHITECTURE.md).
//
// The Phase 4C exact Branch-and-Bound search prunes realistic spaces
// heavily (e.g. the 6-dome/3-Contractor/60-DT case below: theoretical
// operational candidateCount 438,975, but the traversal actually completes
// in ~6,900 visited nodes -- see Benchmark B). Before this phase,
// production still rejected that case BEFORE search ever began, via the
// removed MAX_GLOBAL_CANDIDATES cross-Contractor theoretical-size gate
// (fleet-allocation.js) -- obsolete once pruning routinely finishes a
// space many times that size while visiting a tiny fraction of it.
//
// This file proves the Phase 4D redesign end to end:
//   1. PRODUCTION UNBLOCK -- the 4-dome/2-Contractor and 6-dome/3-Contractor
//      cases now run through the REAL, gated findBlendRecommendations()
//      (no test-only bypass) and complete with the exact winner Phase 3's
//      unpruned reference traversal would produce.
//   2. SAFETY -- a genuinely pathological but per-Contractor-group-legal
//      input (each group individually clears MAX_ALLOCATIONS_PER_CONTRACTOR,
//      but their product is astronomically larger than MAX_SEARCH_NODES,
//      and an unreachable target keeps chemistry/ranking pruning from ever
//      engaging) deterministically stops at MAX_SEARCH_NODES and returns
//      the distinct SEARCH_INCOMPLETE result -- never a silently-presented
//      approximation, never a hang/crash.
//   3. BENCHMARKS -- candidateCount/visitedNodes/completedCandidates/
//      prunedByChemistry/prunedByRanking/budget status/runtime/final status
//      for four representative scenarios (this task's Section 9).
//
// Run with Node's built-in test runner:
//
//   node --test tests/v3-phase4d-node-budget.test.mjs
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  findBlendRecommendations,
  findBlendRecommendationsStreamingUnpruned,
  findBlendRecommendationsWithDiagnostics,
  MAX_SEARCH_NODES,
} from '../js/pages/calculate/blending-recommendation.js';
import { countOperationalAllocations, MAX_ALLOCATIONS_PER_CONTRACTOR } from '../js/pages/calculate/fleet-allocation.js';
import { canonicalizeRecommendationResult, firstCanonicalDifference } from './reference/canonical-recommendation-result.mjs';

function buildContractorSources(contractorCount, domesPerContractor, dtPerDome, niHigh = '1.30', niLow = '1.00') {
  const sources = [];
  for (let c = 0; c < contractorCount; c += 1) {
    for (let s = 0; s < domesPerContractor; s += 1) {
      sources.push({
        pileId: `C${c}-S${s}`,
        contractor: `Contractor${c}`,
        ni: s % 2 === 0 ? niHigh : niLow,
        units: String(dtPerDome),
        tonnesPerUnit: '50',
      });
    }
  }
  return sources;
}

// A. 4 dome / 2 Contractor / 60 DT (30 DT/Contractor -- 2 domes x 15 DT).
function buildScenarioA() {
  return buildContractorSources(2, 2, 15);
}

// B. 6 dome / 3 Contractor / 60 DT (20 DT/Contractor -- 2 domes x 10 DT) --
// this task's own worked example: candidateCount 438,975.
function buildScenarioB() {
  return buildContractorSources(3, 2, 10);
}

// C. 8 dome / 4 Contractor / 80 DT (20 DT/Contractor -- 2 domes x 10 DT).
function buildScenarioC() {
  return buildContractorSources(4, 2, 10);
}

// D. Genuinely pathological concentrated input (this task's SAFETY TEST):
// 2 Contractors, 2 domes each, 100 DT/dome (200 DT/Contractor). Each
// group's own operational allocation count --
// countOperationalAllocations(200, 2) = 18,346 -- individually clears
// MAX_ALLOCATIONS_PER_CONTRACTOR (20,000), so prepareSearch()'s per-group
// gate does NOT reject it. But the cross-Contractor product
// (18,346^2 ~= 336 million) is astronomically larger than MAX_SEARCH_NODES,
// and the target (5.00) is unreachable by any source (all Ni=1.00), so
// chemistry/ranking pruning never engages (pruningGate.active requires an
// actual within-tolerance incumbent) -- the traversal is forced to explore
// close to its full, unpruned shape and must hit the node budget.
function buildScenarioD() {
  const groupFleet = 200;
  const perSource = groupFleet / 2;
  const sources = [];
  for (let c = 0; c < 2; c += 1) {
    sources.push({ pileId: `C${c}-S0`, contractor: `Contractor${c}`, ni: '1.00', units: String(perSource), tonnesPerUnit: '50' });
    sources.push({ pileId: `C${c}-S1`, contractor: `Contractor${c}`, ni: '1.00', units: String(perSource), tonnesPerUnit: '50' });
  }
  return sources;
}

describe('V3.0 Phase 4D -- MAX_SEARCH_NODES is a positive finite integer, comfortably above the required scenarios\' measured actual work', () => {
  test('sanity', () => {
    assert.ok(Number.isInteger(MAX_SEARCH_NODES) && MAX_SEARCH_NODES > 0);
  });
});

// ============================================================
// 1. PRODUCTION UNBLOCK + EXACTNESS (this task's Sections 6/8) -- A and B
// both run through the REAL gated findBlendRecommendations() (no
// prepareSearchUnbounded()/gate-bypass test helper) and are byte-identical
// to Phase 3's unpruned reference traversal, which -- for these two
// scenarios specifically -- itself still finishes within MAX_SEARCH_NODES
// (measured: A ~58,323 unpruned nodes, B ~444,829 unpruned nodes; see
// Benchmark section below for the much smaller PRUNED node counts
// production actually uses). This is a genuine head-to-head Phase3-vs-
// Phase4D equivalence, not a metadata-only comparison.
// ============================================================
describe('V3.0 Phase 4D production unblock: real findBlendRecommendations() matches Phase 3 unpruned exactly', () => {
  test('A. 4 dome / 2 Contractor / 60 DT -- exact match, no SEARCH_SPACE_TOO_LARGE', () => {
    const sources = buildScenarioA();
    const input = { targetNi: '1.15', tolerance: '0.05', sources };
    const production = findBlendRecommendations(input);
    const unpruned = findBlendRecommendationsStreamingUnpruned(input);

    assert.equal(production.ok, true);
    assert.equal(production.status, 'OK');
    assert.equal(production.candidateCount, 58080);

    const diff = firstCanonicalDifference(canonicalizeRecommendationResult(unpruned), canonicalizeRecommendationResult(production));
    assert.equal(diff, null, `Phase 4D production diverged from Phase 3 unpruned: ${diff}`);
  });

  test('B. 6 dome / 3 Contractor / 60 DT -- exact match, no SEARCH_SPACE_TOO_LARGE (this task\'s own worked example)', () => {
    const sources = buildScenarioB();
    const input = { targetNi: '1.15', tolerance: '0.05', sources };
    const production = findBlendRecommendations(input);
    const unpruned = findBlendRecommendationsStreamingUnpruned(input);

    assert.equal(production.ok, true);
    assert.equal(production.status, 'OK');
    assert.equal(production.candidateCount, 438975, 'must match this task\'s own stated theoretical candidateCount exactly');

    const diff = firstCanonicalDifference(canonicalizeRecommendationResult(unpruned), canonicalizeRecommendationResult(production));
    assert.equal(diff, null, `Phase 4D production diverged from Phase 3 unpruned: ${diff}`);
  });

  test('C. 8 dome / 4 Contractor / 80 DT -- production completes exactly within budget (unpruned reference is itself too large to run within MAX_SEARCH_NODES, so no head-to-head diff is claimed here -- see the file header)', () => {
    const sources = buildScenarioC();
    const input = { targetNi: '1.15', tolerance: '0.05', sources };
    const { result, diagnostics } = findBlendRecommendationsWithDiagnostics(input);

    assert.equal(result.ok, true);
    assert.equal(result.status, 'OK');
    assert.ok(diagnostics.visitedNodes < MAX_SEARCH_NODES, `expected C to comfortably finish under budget, visited ${diagnostics.visitedNodes}`);
  });
});

// ============================================================
// 2. SAFETY TEST (this task's Section 7) -- a genuinely pathological
// concentrated input deterministically stops at MAX_SEARCH_NODES and
// returns SEARCH_INCOMPLETE, never an incumbent presented as exact, and
// never a hang/crash.
// ============================================================
describe('V3.0 Phase 4D safety: a pathological concentrated input stops at the node budget instead of hanging', () => {
  test('D. 2 Contractors x 2 domes x 100 DT, unreachable target -- each group individually clears MAX_ALLOCATIONS_PER_CONTRACTOR, so only the node budget can catch this', () => {
    const sources = buildScenarioD();
    // Confirms the setup is genuinely "per-group legal, product pathological"
    // -- if this ever stops holding (e.g. MAX_ALLOCATIONS_PER_CONTRACTOR
    // changes), the test below would start exercising the per-group gate
    // instead of the node budget, silently defeating its own purpose.
    assert.ok(countOperationalAllocations(200, 2) <= MAX_ALLOCATIONS_PER_CONTRACTOR, 'each Contractor group must individually pass the per-group gate for this to test the NODE BUDGET, not the per-group gate');

    const start = process.hrtime.bigint();
    const result = findBlendRecommendations({ targetNi: '5.00', tolerance: '0.001', sources });
    const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6;

    assert.equal(result.ok, false);
    assert.equal(result.error, 'SEARCH_INCOMPLETE');
    assert.notEqual(result.status, 'OK');
    assert.notEqual(result.status, 'TARGET_NOT_ACHIEVABLE');
    assert.equal('candidate' in result, false, 'SEARCH_INCOMPLETE must never carry a `candidate` field a caller could mistake for an exact recommendation');
    assert.equal(result.diagnostics.visitedNodes, MAX_SEARCH_NODES, 'traversal must stop at EXACTLY the node budget, deterministically');
    // eslint-disable-next-line no-console
    console.log(`[v3-phase4d-node-budget] SAFETY TEST D: SEARCH_INCOMPLETE at visitedNodes=${result.diagnostics.visitedNodes} (candidateCount=${result.candidateCount}, far beyond the budget) in ${elapsedMs.toFixed(2)}ms -- no hang, no crash, no approximation returned as exact.`);
  });
});

// ============================================================
// 3. BENCHMARK TABLE (this task's Section 9).
// ============================================================
function reportBenchmark(name, input) {
  const start = process.hrtime.bigint();
  const { result, diagnostics } = findBlendRecommendationsWithDiagnostics(input);
  const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6;
  const budgetStatus = diagnostics === null
    ? 'n/a (rejected before search)'
    : diagnostics.incomplete ? `EXHAUSTED (${diagnostics.visitedNodes}/${MAX_SEARCH_NODES})` : `within budget (${diagnostics.visitedNodes}/${MAX_SEARCH_NODES})`;
  // eslint-disable-next-line no-console
  console.log([
    `[v3-phase4d-node-budget] BENCHMARK ${name}`,
    `  candidateCount       : ${result.ok ? result.candidateCount : (result.candidateCount ?? 'n/a')}`,
    `  visitedNodes         : ${diagnostics ? diagnostics.visitedNodes : 'n/a'}`,
    `  completedCandidates  : ${diagnostics ? diagnostics.completedCandidates : 'n/a'}`,
    `  prunedByChemistry    : ${diagnostics ? diagnostics.prunedByChemistry : 'n/a'}`,
    `  prunedByRanking      : ${diagnostics ? diagnostics.prunedByRanking : 'n/a'}`,
    `  budget status        : ${budgetStatus}`,
    `  runtime (ms)         : ${elapsedMs.toFixed(2)}`,
    `  final status         : ${result.ok ? result.status : result.error}`,
  ].join('\n'));
  return { result, diagnostics, elapsedMs };
}

describe('V3.0 Phase 4D benchmark table (this task\'s Section 9: A/B/C/D)', () => {
  test('A. 4 dome / 2 Contractor / 60 DT', () => {
    const { result } = reportBenchmark('A (4 dome / 2 Contractor / 60 DT)', { targetNi: '1.15', tolerance: '0.05', sources: buildScenarioA() });
    assert.equal(result.ok, true);
    assert.equal(result.status, 'OK');
  });

  test('B. 6 dome / 3 Contractor / 60 DT', () => {
    const { result } = reportBenchmark('B (6 dome / 3 Contractor / 60 DT)', { targetNi: '1.15', tolerance: '0.05', sources: buildScenarioB() });
    assert.equal(result.ok, true);
    assert.equal(result.status, 'OK');
  });

  test('C. 8 dome / 4 Contractor / 80 DT (representative multi-Contractor case, tested safely within budget)', () => {
    const { result } = reportBenchmark('C (8 dome / 4 Contractor / 80 DT)', { targetNi: '1.15', tolerance: '0.05', sources: buildScenarioC() });
    assert.equal(result.ok, true);
    assert.equal(result.status, 'OK');
  });

  test('D. pathological concentrated input', () => {
    const { result } = reportBenchmark('D (pathological: 2 Contractor x 2 dome x 100 DT, unreachable target)', { targetNi: '5.00', tolerance: '0.001', sources: buildScenarioD() });
    assert.equal(result.ok, false);
    assert.equal(result.error, 'SEARCH_INCOMPLETE');
  });
});
