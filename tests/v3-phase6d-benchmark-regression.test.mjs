// V3.0 Phase 6D -- Coupled Chemistry Bound: C/D benchmark, A/B/E regression,
// exactness differential (docs/V3.0_SCALABLE_RECOMMENDATION_ENGINE_ARCHITECTURE.md
// Section 20/23; this task's Sections 5/6/7/8).
//
// Exercises findBlendRecommendationsSourceLazyCoupled() (Phase 6D addition
// to js/pages/calculate/blending-recommendation-source-lazy.js) against
// findBlendRecommendationsSourceLazy() (Phase 6B, pooled bound, unchanged)
// and real production. Traversal order is fixed at Phase 6C's own default
// (canonical source order / descending value order) throughout -- this
// task's own "use the best/fastest safe Phase 6C ordering only as a fixed
// traversal choice; do not benchmark ordering again".
//
// Run with Node's built-in test runner:
//
//   node --test tests/v3-phase6d-benchmark-regression.test.mjs
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  findBlendRecommendationsSourceLazy,
  findBlendRecommendationsSourceLazyCoupled,
} from '../js/pages/calculate/blending-recommendation-source-lazy.js';
import {
  findBlendRecommendationsWithDiagnostics,
  MAX_SEARCH_NODES,
} from '../js/pages/calculate/blending-recommendation.js';
import { MAX_ALLOCATIONS_PER_CONTRACTOR } from '../js/pages/calculate/fleet-allocation.js';
import { canonicalizeRecommendationResult, firstCanonicalDifference } from './reference/canonical-recommendation-result.mjs';
import { generateScenario } from './reference/v3-scenario-generator.mjs';
import { mulberry32 } from './reference/seeded-random.mjs';

function statusOf(result) {
  return result.ok ? result.status : result.error;
}

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

// ============================================================
// PART 1 -- EXACTNESS (this task's Section 7): coupled lazy vs pooled
// lazy vs production, for randomized small scenarios.
// ============================================================
describe('V3.0 Phase 6D -- exactness: coupled bound vs pooled bound vs production', () => {
  const SEEDS = [1, 2, 3];
  const CASES_PER_SEED = 50;

  SEEDS.forEach((seed) => {
    test(`seed ${seed}: ${CASES_PER_SEED} scenarios, coupled byte-identical to pooled and to production`, () => {
      const rng = mulberry32(seed);
      let compared = 0;
      for (let i = 0; i < CASES_PER_SEED; i += 1) {
        const scenario = generateScenario(rng, i);
        const production = findBlendRecommendationsWithDiagnostics(scenario.input);
        if (!production.result.ok && production.result.error === 'SEARCH_SPACE_TOO_LARGE') continue;

        const pooled = findBlendRecommendationsSourceLazy(scenario.input);
        const coupled = findBlendRecommendationsSourceLazyCoupled(scenario.input);
        compared += 1;

        const diffVsProd = firstCanonicalDifference(
          canonicalizeRecommendationResult(production.result),
          canonicalizeRecommendationResult(coupled.result),
        );
        assert.equal(diffVsProd, null, `seed ${seed} case ${i} (${scenario.name}): coupled diverged from production: ${diffVsProd}`);

        const diffVsPooled = firstCanonicalDifference(
          canonicalizeRecommendationResult(pooled.result),
          canonicalizeRecommendationResult(coupled.result),
        );
        assert.equal(diffVsPooled, null, `seed ${seed} case ${i} (${scenario.name}): coupled diverged from Phase 6B pooled: ${diffVsPooled}`);

        // candidateCount must be UNCHANGED (this task's own requirement) --
        // the bound only prunes branches, it never changes the theoretical
        // search-space size.
        assert.equal(coupled.result.candidateCount, pooled.result.candidateCount, `seed ${seed} case ${i}: candidateCount changed`);
      }
      assert.ok(compared > 0, `seed ${seed}: expected at least one comparable scenario`);
    });
  });
});

// ============================================================
// PART 2 -- C/D BENCHMARK (this task's Section 5, PRIMARY)
// ============================================================
function runBoth(name, sources) {
  const input = { targetNi: TARGET_NI, tolerance: TOLERANCE, sources };

  const t0 = process.hrtime.bigint();
  const pooled = findBlendRecommendationsSourceLazy(input);
  const t1 = process.hrtime.bigint();
  const coupled = findBlendRecommendationsSourceLazyCoupled(input);
  const t2 = process.hrtime.bigint();

  const pooledMs = Number(t1 - t0) / 1e6;
  const coupledMs = Number(t2 - t1) / 1e6;

  // eslint-disable-next-line no-console
  console.log([
    `[v3-phase6d] BENCHMARK ${name}`,
    `  POOLED  (Phase 6B) status=${statusOf(pooled.result).padEnd(18)} visited=${pooled.diagnostics ? pooled.diagnostics.visitedNodes : 'n/a'} completed=${pooled.diagnostics ? pooled.diagnostics.completedCandidates : 'n/a'} prunedChem=${pooled.diagnostics ? pooled.diagnostics.prunedByChemistry : 'n/a'} prunedRank=${pooled.diagnostics ? pooled.diagnostics.prunedByRanking : 'n/a'} runtime=${pooledMs.toFixed(1)}ms`,
    `  COUPLED (Phase 6D) status=${statusOf(coupled.result).padEnd(18)} visited=${coupled.diagnostics ? coupled.diagnostics.visitedNodes : 'n/a'} completed=${coupled.diagnostics ? coupled.diagnostics.completedCandidates : 'n/a'} prunedChem=${coupled.diagnostics ? coupled.diagnostics.prunedByChemistry : 'n/a'} prunedRank=${coupled.diagnostics ? coupled.diagnostics.prunedByRanking : 'n/a'} runtime=${coupledMs.toFixed(1)}ms`,
    `  bound-overhead (coupled/pooled runtime ratio): ${(coupledMs / pooledMs).toFixed(3)}x`,
  ].join('\n'));

  return { pooled, coupled, pooledMs, coupledMs };
}

describe('V3.0 Phase 6D -- C/D benchmark (primary): must complete below 500,000 nodes to pass the phase gate', () => {
  test('sanity: node budget unchanged', () => {
    assert.equal(MAX_SEARCH_NODES, 500000);
  });

  test('C. 10 dome / 5 Contractor / 100 DT', () => {
    const { coupled } = runBoth('C (10 dome / 5 Contractor / 100 DT)', SCENARIOS.C);
    // eslint-disable-next-line no-console
    console.log(`[v3-phase6d] C GATE: ${statusOf(coupled.result) === 'SEARCH_INCOMPLETE' ? 'FAILS phase gate (still SEARCH_INCOMPLETE)' : 'PASSES phase gate'}`);
  });

  test('D. 10 dome / 3 Contractor / 100 DT', () => {
    const { coupled } = runBoth('D (10 dome / 3 Contractor / 100 DT)', SCENARIOS.D);
    // eslint-disable-next-line no-console
    console.log(`[v3-phase6d] D GATE: ${statusOf(coupled.result) === 'SEARCH_INCOMPLETE' ? 'FAILS phase gate (still SEARCH_INCOMPLETE)' : 'PASSES phase gate'}`);
  });
});

// ============================================================
// PART 3 -- A/B/E REGRESSION (this task's Section 6) -- run regardless of
// the C/D gate outcome so the report has real numbers, per this file's own
// role as the evidence-gathering artifact for the deliverable.
// ============================================================
describe('V3.0 Phase 6D -- A/B/E regression', () => {
  test('sanity: per-Contractor gate constant unchanged', () => {
    assert.equal(MAX_ALLOCATIONS_PER_CONTRACTOR, 20000);
  });

  test('A. 8 dome / 5 Contractor / 80 DT -- exact and OK', () => {
    const { pooled, coupled } = runBoth('A (8 dome / 5 Contractor / 80 DT)', SCENARIOS.A);
    const production = findBlendRecommendationsWithDiagnostics({ targetNi: TARGET_NI, tolerance: TOLERANCE, sources: SCENARIOS.A });
    assert.equal(production.result.ok, true);
    assert.equal(production.result.status, 'OK');
    const diff = firstCanonicalDifference(canonicalizeRecommendationResult(production.result), canonicalizeRecommendationResult(coupled.result));
    assert.equal(diff, null, `A: coupled diverged from production: ${diff}`);
    assert.equal(coupled.result.candidateCount, pooled.result.candidateCount);
  });

  test('B. 10 dome / 7 Contractor / 100 DT balanced -- exact and OK', () => {
    const { pooled, coupled } = runBoth('B (10 dome / 7 Contractor / 100 DT, balanced)', SCENARIOS.B);
    const production = findBlendRecommendationsWithDiagnostics({ targetNi: TARGET_NI, tolerance: TOLERANCE, sources: SCENARIOS.B });
    assert.equal(production.result.ok, true);
    assert.equal(production.result.status, 'OK');
    const diff = firstCanonicalDifference(canonicalizeRecommendationResult(production.result), canonicalizeRecommendationResult(coupled.result));
    assert.equal(diff, null, `B: coupled diverged from production: ${diff}`);
    assert.equal(coupled.result.candidateCount, pooled.result.candidateCount);
  });

  test('E. 10 dome / 2 Contractor / 100 DT concentrated -- still begins traversal without eager 20k gate', () => {
    const { coupled } = runBoth('E (10 dome / 2 Contractor / 100 DT, concentrated)', SCENARIOS.E);
    const production = findBlendRecommendationsWithDiagnostics({ targetNi: TARGET_NI, tolerance: TOLERANCE, sources: SCENARIOS.E });
    assert.equal(production.result.ok, false);
    assert.equal(production.result.error, 'SEARCH_SPACE_TOO_LARGE');
    assert.notEqual(coupled.result.error, 'SEARCH_SPACE_TOO_LARGE', 'coupled prototype must not apply the eager 20k per-Contractor gate');
    assert.ok(coupled.diagnostics, 'coupled prototype must have actually traversed (diagnostics present)');
  });
});
