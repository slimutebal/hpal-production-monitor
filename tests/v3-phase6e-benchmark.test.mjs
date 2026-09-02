// V3.0 Phase 6E -- Extended Exact Lexicographic Ranking Bounds Prototype:
// C/D primary benchmark, A/B/E regression, exactness differential (this
// task's Sections 7/8/9/10).
//
// Exercises findBlendRecommendationsSourceLazyExtendedRanking() (Phase 6E
// addition to js/pages/calculate/blending-recommendation-source-lazy.js)
// against findBlendRecommendationsSourceLazyCoupled() (Phase 6D, unchanged)
// and real production. Traversal order/chemistry bound are both held fixed
// at Phase 6D's own settings (canonical source order / descending value
// order / coupled chemistry) throughout -- this task's own "use one
// already-proven deterministic Phase 6C traversal order... do NOT re-run
// the 18-strategy ordering experiment."
//
// Run with Node's built-in test runner:
//   node --test tests/v3-phase6e-benchmark.test.mjs
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  findBlendRecommendationsSourceLazyCoupled,
  findBlendRecommendationsSourceLazyExtendedRanking,
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
// PART 1 -- EXACTNESS: extended-ranking lazy vs coupled lazy (Phase 6D) vs
// production. Since boundCannotBeatIncumbentExtended() is proven identical
// to boundCannotBeatIncumbent() (see the source file's own PHASE 6E
// ANALYSIS), this is expected to be a byte-identical, zero-divergence
// differential -- run anyway per this task's own "no approximation, 0
// mismatches" requirement.
// ============================================================
describe('V3.0 Phase 6E -- exactness: extended-ranking bound vs coupled bound vs production', () => {
  const SEEDS = [1, 2, 3];
  const CASES_PER_SEED = 50;

  SEEDS.forEach((seed) => {
    test(`seed ${seed}: ${CASES_PER_SEED} scenarios, extended byte-identical to coupled and to production`, () => {
      const rng = mulberry32(seed);
      let compared = 0;
      for (let i = 0; i < CASES_PER_SEED; i += 1) {
        const scenario = generateScenario(rng, i);
        const production = findBlendRecommendationsWithDiagnostics(scenario.input);
        if (!production.result.ok && production.result.error === 'SEARCH_SPACE_TOO_LARGE') continue;

        const coupled = findBlendRecommendationsSourceLazyCoupled(scenario.input);
        const extended = findBlendRecommendationsSourceLazyExtendedRanking(scenario.input);
        compared += 1;

        const diffVsProd = firstCanonicalDifference(
          canonicalizeRecommendationResult(production.result),
          canonicalizeRecommendationResult(extended.result),
        );
        assert.equal(diffVsProd, null, `seed ${seed} case ${i} (${scenario.name}): extended diverged from production: ${diffVsProd}`);

        const diffVsCoupled = firstCanonicalDifference(
          canonicalizeRecommendationResult(coupled.result),
          canonicalizeRecommendationResult(extended.result),
        );
        assert.equal(diffVsCoupled, null, `seed ${seed} case ${i} (${scenario.name}): extended diverged from Phase 6D coupled: ${diffVsCoupled}`);

        assert.equal(extended.result.candidateCount, coupled.result.candidateCount, `seed ${seed} case ${i}: candidateCount changed`);

        // MANDATORY structural proof (this task's Section 10, "verified AT
        // RUNTIME") -- the extended ranking bound must never have found a
        // NEW prune the A-E bound didn't already find.
        if (extended.diagnostics) {
          assert.equal(extended.diagnostics.prunedByRankingExtended, 0, `seed ${seed} case ${i}: prunedByRankingExtended must be 0 (F blocks G/H/I)`);
        }
      }
      assert.ok(compared > 0, `seed ${seed}: expected at least one comparable scenario`);
    });
  });
});

// ============================================================
// PART 2 -- C/D BENCHMARK (this task's Section 7, PRIMARY)
// ============================================================
function runBoth(name, sources) {
  const input = { targetNi: TARGET_NI, tolerance: TOLERANCE, sources };

  const t0 = process.hrtime.bigint();
  const coupled = findBlendRecommendationsSourceLazyCoupled(input);
  const t1 = process.hrtime.bigint();
  const extended = findBlendRecommendationsSourceLazyExtendedRanking(input);
  const t2 = process.hrtime.bigint();

  const coupledMs = Number(t1 - t0) / 1e6;
  const extendedMs = Number(t2 - t1) / 1e6;

  // eslint-disable-next-line no-console
  console.log([
    `[v3-phase6e] BENCHMARK ${name}`,
    `  COUPLED  (Phase 6D, A-E only) status=${statusOf(coupled.result).padEnd(18)} visited=${coupled.diagnostics ? coupled.diagnostics.visitedNodes : 'n/a'} completed=${coupled.diagnostics ? coupled.diagnostics.completedCandidates : 'n/a'} prunedChem=${coupled.diagnostics ? coupled.diagnostics.prunedByChemistry : 'n/a'} prunedRankAE=${coupled.diagnostics ? coupled.diagnostics.prunedByRanking : 'n/a'} runtime=${coupledMs.toFixed(1)}ms`,
    `  EXTENDED (Phase 6E)        status=${statusOf(extended.result).padEnd(18)} visited=${extended.diagnostics ? extended.diagnostics.visitedNodes : 'n/a'} completed=${extended.diagnostics ? extended.diagnostics.completedCandidates : 'n/a'} prunedChem=${extended.diagnostics ? extended.diagnostics.prunedByChemistry : 'n/a'} prunedRankAE=${extended.diagnostics ? extended.diagnostics.prunedByRankingAE : 'n/a'} prunedRankExtended=${extended.diagnostics ? extended.diagnostics.prunedByRankingExtended : 'n/a'} runtime=${extendedMs.toFixed(1)}ms`,
  ].join('\n'));

  return { coupled, extended, coupledMs, extendedMs };
}

describe('V3.0 Phase 6E -- C/D benchmark (primary): must complete below 500,000 nodes to pass the phase gate', () => {
  test('sanity: node budget unchanged', () => {
    assert.equal(MAX_SEARCH_NODES, 500000);
  });

  test('C. 10 dome / 5 Contractor / 100 DT', () => {
    const { coupled, extended } = runBoth('C (10 dome / 5 Contractor / 100 DT)', SCENARIOS.C);
    assert.equal(extended.diagnostics.visitedNodes, coupled.diagnostics.visitedNodes, 'C: extended must visit exactly the same node count as Phase 6D (no new pruning is legally possible)');
    assert.equal(extended.diagnostics.prunedByRankingExtended, 0, 'C: extended ranking bound must never fire (F blocks G/H/I)');
    // eslint-disable-next-line no-console
    console.log(`[v3-phase6e] C GATE: ${statusOf(extended.result) === 'SEARCH_INCOMPLETE' ? 'FAILS phase gate (still SEARCH_INCOMPLETE)' : 'PASSES phase gate'}`);
  });

  test('D. 10 dome / 3 Contractor / 100 DT', () => {
    const { coupled, extended } = runBoth('D (10 dome / 3 Contractor / 100 DT)', SCENARIOS.D);
    assert.equal(extended.diagnostics.visitedNodes, coupled.diagnostics.visitedNodes, 'D: extended must visit exactly the same node count as Phase 6D (no new pruning is legally possible)');
    assert.equal(extended.diagnostics.prunedByRankingExtended, 0, 'D: extended ranking bound must never fire (F blocks G/H/I)');
    // eslint-disable-next-line no-console
    console.log(`[v3-phase6e] D GATE: ${statusOf(extended.result) === 'SEARCH_INCOMPLETE' ? 'FAILS phase gate (still SEARCH_INCOMPLETE)' : 'PASSES phase gate'}`);
  });
});

// ============================================================
// PART 3 -- A/B/E REGRESSION (this task's Section 8) -- run regardless of
// the C/D gate outcome so the report has real numbers.
// ============================================================
describe('V3.0 Phase 6E -- A/B/E regression', () => {
  test('sanity: per-Contractor gate constant unchanged', () => {
    assert.equal(MAX_ALLOCATIONS_PER_CONTRACTOR, 20000);
  });

  test('A. 8 dome / 5 Contractor / 80 DT -- exact and OK', () => {
    const { coupled, extended } = runBoth('A (8 dome / 5 Contractor / 80 DT)', SCENARIOS.A);
    const production = findBlendRecommendationsWithDiagnostics({ targetNi: TARGET_NI, tolerance: TOLERANCE, sources: SCENARIOS.A });
    assert.equal(production.result.ok, true);
    assert.equal(production.result.status, 'OK');
    const diff = firstCanonicalDifference(canonicalizeRecommendationResult(production.result), canonicalizeRecommendationResult(extended.result));
    assert.equal(diff, null, `A: extended diverged from production: ${diff}`);
    assert.equal(extended.result.candidateCount, coupled.result.candidateCount);
    assert.equal(extended.diagnostics.prunedByRankingExtended, 0);
  });

  test('B. 10 dome / 7 Contractor / 100 DT balanced -- exact and OK', () => {
    const { coupled, extended } = runBoth('B (10 dome / 7 Contractor / 100 DT, balanced)', SCENARIOS.B);
    const production = findBlendRecommendationsWithDiagnostics({ targetNi: TARGET_NI, tolerance: TOLERANCE, sources: SCENARIOS.B });
    assert.equal(production.result.ok, true);
    assert.equal(production.result.status, 'OK');
    const diff = firstCanonicalDifference(canonicalizeRecommendationResult(production.result), canonicalizeRecommendationResult(extended.result));
    assert.equal(diff, null, `B: extended diverged from production: ${diff}`);
    assert.equal(extended.result.candidateCount, coupled.result.candidateCount);
    assert.equal(extended.diagnostics.prunedByRankingExtended, 0);
  });

  test('E. 10 dome / 2 Contractor / 100 DT concentrated -- still begins traversal without eager 20k gate', () => {
    const { extended } = runBoth('E (10 dome / 2 Contractor / 100 DT, concentrated)', SCENARIOS.E);
    const production = findBlendRecommendationsWithDiagnostics({ targetNi: TARGET_NI, tolerance: TOLERANCE, sources: SCENARIOS.E });
    assert.equal(production.result.ok, false);
    assert.equal(production.result.error, 'SEARCH_SPACE_TOO_LARGE');
    assert.notEqual(extended.result.error, 'SEARCH_SPACE_TOO_LARGE', 'extended prototype must not apply the eager 20k per-Contractor gate');
    assert.ok(extended.diagnostics, 'extended prototype must have actually traversed (diagnostics present)');
    assert.equal(extended.diagnostics.prunedByRankingExtended, 0);
  });
});
