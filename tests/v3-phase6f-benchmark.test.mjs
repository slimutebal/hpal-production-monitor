// V3.0 Phase 6F -- Exact Partial-State Dominance Frontier Prototype: C/D
// primary benchmark, A/B/E regression, exactness differential (mirrors
// tests/v3-phase6e-benchmark.test.mjs's own structure/scenarios exactly --
// this task's own "use one fixed, already-proven source/value order/coupled
// chemistry bound -- do NOT re-run ordering/chemistry experiments").
//
// Exercises findBlendRecommendationsSourceLazyFrontier() (Phase 6F addition)
// against findBlendRecommendationsSourceLazyCoupled() (Phase 6D, unchanged)
// and real production.
//
// Run with Node's built-in test runner:
//   node --test tests/v3-phase6f-benchmark.test.mjs
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  findBlendRecommendationsSourceLazyCoupled,
  findBlendRecommendationsSourceLazyFrontier,
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
// PART 1 -- EXACTNESS: frontier lazy vs coupled lazy (Phase 6D) vs
// production. The frontier only ever discards a branch when
// dominatesPrefix() certifies it (proven safe by
// tests/v3-phase6f-dominance-proof.test.mjs's exhaustive real-comparator
// proof) -- expected 0 mismatches, run anyway per this task's own "no
// approximation, 0 mismatches" requirement.
// ============================================================
describe('V3.0 Phase 6F -- exactness: dominance-frontier lazy vs coupled lazy vs production', () => {
  const SEEDS = [1, 2, 3];
  const CASES_PER_SEED = 50;

  SEEDS.forEach((seed) => {
    test(`seed ${seed}: ${CASES_PER_SEED} scenarios, frontier byte-identical to coupled and to production`, () => {
      const rng = mulberry32(seed);
      let compared = 0;
      for (let i = 0; i < CASES_PER_SEED; i += 1) {
        const scenario = generateScenario(rng, i);
        const production = findBlendRecommendationsWithDiagnostics(scenario.input);
        if (!production.result.ok && production.result.error === 'SEARCH_SPACE_TOO_LARGE') continue;

        const coupled = findBlendRecommendationsSourceLazyCoupled(scenario.input);
        const frontier = findBlendRecommendationsSourceLazyFrontier(scenario.input);
        compared += 1;

        const diffVsProd = firstCanonicalDifference(
          canonicalizeRecommendationResult(production.result),
          canonicalizeRecommendationResult(frontier.result),
        );
        assert.equal(diffVsProd, null, `seed ${seed} case ${i} (${scenario.name}): frontier diverged from production: ${diffVsProd}`);

        const diffVsCoupled = firstCanonicalDifference(
          canonicalizeRecommendationResult(coupled.result),
          canonicalizeRecommendationResult(frontier.result),
        );
        assert.equal(diffVsCoupled, null, `seed ${seed} case ${i} (${scenario.name}): frontier diverged from Phase 6D coupled: ${diffVsCoupled}`);

        assert.equal(frontier.result.candidateCount, coupled.result.candidateCount, `seed ${seed} case ${i}: candidateCount changed`);

        // MANDATORY structural proof -- every dominance prune must be a
        // subset of what the frontier's own diagnostics recorded (sanity on
        // the diagnostic wiring itself, never negative).
        if (frontier.diagnostics) {
          assert.ok(frontier.diagnostics.prunedByDominance >= 0);
          assert.ok(frontier.diagnostics.prunedByDominance <= frontier.diagnostics.frontierHits);
        }
      }
      assert.ok(compared > 0, `seed ${seed}: expected at least one comparable scenario`);
    });
  });
});

// ============================================================
// PART 2 -- C/D BENCHMARK (PRIMARY GATE). Per this task's explicit
// instruction: "If C or D still reaches 500,000 nodes, REJECT and STOP. Do
// not add another optimization." This test reports the gate outcome; it
// does NOT fail the suite on a REJECT verdict (the whole point of the
// prototype is to find out), but DOES assert the diagnostic invariants that
// must hold either way (dominance pruning must never itself explain away a
// node-count regression, and frontierHits/prunedByDominance must be real,
// non-negative counts).
// ============================================================
function runBoth(name, sources) {
  const input = { targetNi: TARGET_NI, tolerance: TOLERANCE, sources };

  const t0 = process.hrtime.bigint();
  const coupled = findBlendRecommendationsSourceLazyCoupled(input);
  const t1 = process.hrtime.bigint();
  const frontier = findBlendRecommendationsSourceLazyFrontier(input);
  const t2 = process.hrtime.bigint();

  const coupledMs = Number(t1 - t0) / 1e6;
  const frontierMs = Number(t2 - t1) / 1e6;

  // eslint-disable-next-line no-console
  console.log([
    `[v3-phase6f] BENCHMARK ${name}`,
    `  COUPLED  (Phase 6D, no frontier) status=${statusOf(coupled.result).padEnd(18)} visited=${coupled.diagnostics ? coupled.diagnostics.visitedNodes : 'n/a'} completed=${coupled.diagnostics ? coupled.diagnostics.completedCandidates : 'n/a'} runtime=${coupledMs.toFixed(1)}ms`,
    `  FRONTIER (Phase 6F)         status=${statusOf(frontier.result).padEnd(18)} visited=${frontier.diagnostics ? frontier.diagnostics.visitedNodes : 'n/a'} completed=${frontier.diagnostics ? frontier.diagnostics.completedCandidates : 'n/a'} frontierHits=${frontier.diagnostics ? frontier.diagnostics.frontierHits : 'n/a'} prunedByDominance=${frontier.diagnostics ? frontier.diagnostics.prunedByDominance : 'n/a'} frontierEntries=${frontier.diagnostics ? frontier.diagnostics.frontierEntries : 'n/a'} peakFrontierEntries=${frontier.diagnostics ? frontier.diagnostics.peakFrontierEntries : 'n/a'} runtime=${frontierMs.toFixed(1)}ms`,
  ].join('\n'));

  return { coupled, frontier, coupledMs, frontierMs };
}

describe('V3.0 Phase 6F -- C/D benchmark (primary): must complete below 500,000 nodes to pass the phase gate', () => {
  test('sanity: node budget unchanged', () => {
    assert.equal(MAX_SEARCH_NODES, 500000);
  });

  test('C. 10 dome / 5 Contractor / 100 DT', () => {
    const { coupled, frontier } = runBoth('C (10 dome / 5 Contractor / 100 DT)', SCENARIOS.C);
    assert.ok(frontier.diagnostics.visitedNodes <= coupled.diagnostics.visitedNodes, 'C: frontier must never visit MORE nodes than Phase 6D coupled');
    assert.ok(frontier.diagnostics.prunedByDominance >= 0);
    const gatePasses = statusOf(frontier.result) !== 'SEARCH_INCOMPLETE';
    // eslint-disable-next-line no-console
    console.log(`[v3-phase6f] C GATE: ${gatePasses ? 'PASSES phase gate' : 'FAILS phase gate (still SEARCH_INCOMPLETE at ' + frontier.diagnostics.visitedNodes + ' nodes)'}`);
  });

  test('D. 10 dome / 3 Contractor / 100 DT', () => {
    const { coupled, frontier } = runBoth('D (10 dome / 3 Contractor / 100 DT)', SCENARIOS.D);
    assert.ok(frontier.diagnostics.visitedNodes <= coupled.diagnostics.visitedNodes, 'D: frontier must never visit MORE nodes than Phase 6D coupled');
    assert.ok(frontier.diagnostics.prunedByDominance >= 0);
    const gatePasses = statusOf(frontier.result) !== 'SEARCH_INCOMPLETE';
    // eslint-disable-next-line no-console
    console.log(`[v3-phase6f] D GATE: ${gatePasses ? 'PASSES phase gate' : 'FAILS phase gate (still SEARCH_INCOMPLETE at ' + frontier.diagnostics.visitedNodes + ' nodes)'}`);
  });
});

// ============================================================
// PART 3 -- A/B/E REGRESSION -- run regardless of the C/D gate outcome so
// the report has real numbers (matches Phase 6E's own precedent).
// ============================================================
describe('V3.0 Phase 6F -- A/B/E regression', () => {
  test('sanity: per-Contractor gate constant unchanged', () => {
    assert.equal(MAX_ALLOCATIONS_PER_CONTRACTOR, 20000);
  });

  test('A. 8 dome / 5 Contractor / 80 DT -- exact and OK', () => {
    const { coupled, frontier } = runBoth('A (8 dome / 5 Contractor / 80 DT)', SCENARIOS.A);
    const production = findBlendRecommendationsWithDiagnostics({ targetNi: TARGET_NI, tolerance: TOLERANCE, sources: SCENARIOS.A });
    assert.equal(production.result.ok, true);
    assert.equal(production.result.status, 'OK');
    const diff = firstCanonicalDifference(canonicalizeRecommendationResult(production.result), canonicalizeRecommendationResult(frontier.result));
    assert.equal(diff, null, `A: frontier diverged from production: ${diff}`);
    assert.equal(frontier.result.candidateCount, coupled.result.candidateCount);
  });

  test('B. 10 dome / 7 Contractor / 100 DT balanced -- exact and OK', () => {
    const { coupled, frontier } = runBoth('B (10 dome / 7 Contractor / 100 DT, balanced)', SCENARIOS.B);
    const production = findBlendRecommendationsWithDiagnostics({ targetNi: TARGET_NI, tolerance: TOLERANCE, sources: SCENARIOS.B });
    assert.equal(production.result.ok, true);
    assert.equal(production.result.status, 'OK');
    const diff = firstCanonicalDifference(canonicalizeRecommendationResult(production.result), canonicalizeRecommendationResult(frontier.result));
    assert.equal(diff, null, `B: frontier diverged from production: ${diff}`);
    assert.equal(frontier.result.candidateCount, coupled.result.candidateCount);
  });

  // V3.0 Phase 7A UPDATE: production's own hybrid dispatcher now clears
  // this gate via the hard-case engine too.
  test('E. 10 dome / 2 Contractor / 100 DT concentrated -- V3.0 Phase 7A: production now clears the 20k per-Contractor gate too', () => {
    const { frontier } = runBoth('E (10 dome / 2 Contractor / 100 DT, concentrated)', SCENARIOS.E);
    const production = findBlendRecommendationsWithDiagnostics({ targetNi: TARGET_NI, tolerance: TOLERANCE, sources: SCENARIOS.E });
    assert.equal(production.result.ok, true);
    assert.equal(production.result.status, 'OK');
    assert.equal(production.result.solverPath, 'HARDCASE_MITM');
    assert.notEqual(frontier.result.error, 'SEARCH_SPACE_TOO_LARGE', 'frontier prototype must not apply the eager 20k per-Contractor gate');
    assert.ok(frontier.diagnostics, 'frontier prototype must have actually traversed (diagnostics present)');
  });
});
