// V3.0 Phase 6B -- Source-Level Lazy Search PROTOTYPE (docs/
// V3.0_SCALABLE_RECOMMENDATION_ENGINE_ARCHITECTURE.md Section 23; this
// task's PROTOTYPE / PROOF FIRST instruction).
//
// Exercises js/pages/calculate/blending-recommendation-source-lazy.js --
// NOT production, not imported by any production file. GOAL: find out
// whether pruning at individual-dome (source) granularity, instead of only
// at Contractor-group boundaries (today's forEachCandidatePruned()), can
// (a) complete Scenario C/D (10 dome / 5-or-3 Contractor / 100 DT, both
// SEARCH_INCOMPLETE at the UNCHANGED 500,000-node budget per Phase 6A) and
// (b) let Scenario E (10 dome / 2 Contractor / 100 DT concentrated) at
// least begin traversing instead of being rejected before search starts by
// the eager 20,000-per-Contractor MAX_ALLOCATIONS_PER_CONTRACTOR gate.
//
// PART 1 -- EXACTNESS: randomized small scenarios (tests/reference/
// v3-scenario-generator.mjs, the SAME generator tests/v3-differential.test.mjs
// uses) are run through BOTH the prototype and the real production
// findBlendRecommendationsWithDiagnostics(), asserting byte-identical
// results via the SAME canonicalizeRecommendationResult()/
// firstCanonicalDifference() helpers Phase 6A's own exactness proof uses.
// Any mismatch is Phase-blocking, per this task's EXACTNESS section.
//
// PART 2 -- A/B/C/D/E BENCHMARK: identical scenario construction to
// tests/v3-phase5-operational-scale.test.mjs / tests/v3-phase6a-search-order.test.mjs
// (buildScenarioSources(), same target/tolerance) so before/after numbers
// are directly comparable. A/B must stay exact and OK (sanity that the
// prototype is not merely "faster because wrong"); C/D/E are reported
// HONESTLY -- this file does not force an "improved" narrative if the
// numbers do not show one (this task's "If the prototype does NOT
// materially improve C/D: STOP and report").
//
// Run with Node's built-in test runner:
//
//   node --test tests/v3-phase6b-source-lazy.test.mjs
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { findBlendRecommendationsSourceLazy } from '../js/pages/calculate/blending-recommendation-source-lazy.js';
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

// ============================================================
// PART 1 -- EXACTNESS: small-case exhaustive-style differential (this
// task's "small-case differential = 0 mismatches" phase-gate requirement).
// ============================================================
describe('V3.0 Phase 6B prototype -- exactness vs production (randomized small scenarios)', () => {
  const SEEDS = [1, 2, 3, 4, 5];
  const CASES_PER_SEED = 60;

  SEEDS.forEach((seed) => {
    test(`seed ${seed}: ${CASES_PER_SEED} scenarios, prototype byte-identical to production`, () => {
      const rng = mulberry32(seed);
      let compared = 0;
      for (let i = 0; i < CASES_PER_SEED; i += 1) {
        const scenario = generateScenario(rng, i);
        const production = findBlendRecommendationsWithDiagnostics(scenario.input);
        const prototype = findBlendRecommendationsSourceLazy(scenario.input);

        // Both sides share the identical MAX_ALLOCATIONS_PER_CONTRACTOR-free
        // gating story EXCEPT production still applies that gate
        // (this task's scope: the prototype does not) -- these small
        // scenarios are constructed with tiny fleets (Section: generator's
        // own fleetRange caps of 8 or fewer per source), so neither side
        // should ever actually hit that gate; if production's own result
        // is itself SEARCH_SPACE_TOO_LARGE for some generated case, skip it
        // (nothing to differentially compare -- the prototype has no
        // equivalent rejection point by design).
        if (!production.result.ok && production.result.error === 'SEARCH_SPACE_TOO_LARGE') continue;

        compared += 1;
        const diff = firstCanonicalDifference(
          canonicalizeRecommendationResult(production.result),
          canonicalizeRecommendationResult(prototype.result),
        );
        assert.equal(diff, null, `seed ${seed} case ${i} (${scenario.name}): prototype diverged from production: ${diff}`);
      }
      assert.ok(compared > 0, `seed ${seed}: expected at least one comparable scenario`);
    });
  });
});

// ============================================================
// PART 2 -- A/B/C/D/E BENCHMARK
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

function runBoth(name, sources) {
  const input = { targetNi: TARGET_NI, tolerance: TOLERANCE, sources };

  const prodStart = process.hrtime.bigint();
  const production = findBlendRecommendationsWithDiagnostics(input);
  const prodMs = Number(process.hrtime.bigint() - prodStart) / 1e6;

  const protoStart = process.hrtime.bigint();
  const prototype = findBlendRecommendationsSourceLazy(input);
  const protoMs = Number(process.hrtime.bigint() - protoStart) / 1e6;

  // eslint-disable-next-line no-console
  console.log([
    `[v3-phase6b] BENCHMARK ${name}`,
    `  theoretical candidateCount        : ${production.result.candidateCount ?? prototype.result.candidateCount ?? 'n/a'}`,
    `  PRODUCTION (group-level, eager per-Contractor array)`,
    `    status                          : ${statusOf(production.result)}`,
    `    visitedNodes (group-level)      : ${production.diagnostics ? production.diagnostics.visitedNodes : 'n/a (gate-rejected before search)'}`,
    `    completedCandidates             : ${production.diagnostics ? production.diagnostics.completedCandidates : 'n/a'}`,
    `    prunedByChemistry/prunedByRanking: ${production.diagnostics ? `${production.diagnostics.prunedByChemistry}/${production.diagnostics.prunedByRanking}` : 'n/a'}`,
    `    runtime (ms)                    : ${prodMs.toFixed(2)}`,
    `  PROTOTYPE (source-level, lazy)`,
    `    status                          : ${statusOf(prototype.result)}`,
    `    visitedNodes (source-level)     : ${prototype.diagnostics ? prototype.diagnostics.visitedNodes : 'n/a'}`,
    `    completedCandidates             : ${prototype.diagnostics ? prototype.diagnostics.completedCandidates : 'n/a'}`,
    `    prunedByChemistry/prunedByRanking: ${prototype.diagnostics ? `${prototype.diagnostics.prunedByChemistry}/${prototype.diagnostics.prunedByRanking}` : 'n/a'}`,
    `    runtime (ms)                    : ${protoMs.toFixed(2)}`,
  ].join('\n'));

  return { production, prototype, prodMs, protoMs };
}

describe('V3.0 Phase 6B -- A/B/C/D/E benchmark (prototype vs production, MAX_SEARCH_NODES=500000 unchanged for both)', () => {
  test('sanity: node budget / per-Contractor gate constants unchanged', () => {
    assert.equal(MAX_SEARCH_NODES, 500000);
    assert.equal(MAX_ALLOCATIONS_PER_CONTRACTOR, 20000);
  });

  test('A. 8 dome / 5 Contractor / 80 DT -- prototype must stay exact and OK', () => {
    const { production, prototype } = runBoth('A (8 dome / 5 Contractor / 80 DT)', SCENARIOS.A);
    assert.equal(production.result.ok, true);
    assert.equal(production.result.status, 'OK');
    const diff = firstCanonicalDifference(canonicalizeRecommendationResult(production.result), canonicalizeRecommendationResult(prototype.result));
    assert.equal(diff, null, `A: prototype diverged from production: ${diff}`);
  });

  test('B. 10 dome / 7 Contractor / 100 DT balanced -- prototype must stay exact and OK', () => {
    const { production, prototype } = runBoth('B (10 dome / 7 Contractor / 100 DT, balanced)', SCENARIOS.B);
    assert.equal(production.result.ok, true);
    assert.equal(production.result.status, 'OK');
    const diff = firstCanonicalDifference(canonicalizeRecommendationResult(production.result), canonicalizeRecommendationResult(prototype.result));
    assert.equal(diff, null, `B: prototype diverged from production: ${diff}`);
  });

  // V3.0 Phase 7A UPDATE: production's own hybrid dispatcher now reaches
  // this prototype's exact conclusion directly (via exact-hardcase-solver.js,
  // a production port of this same Phase 6H/6I/6J/6K/6L pipeline) -- C/D no
  // longer remain SEARCH_INCOMPLETE in production. Kept in this describe
  // block (not deleted) as the historical "before" baseline this same
  // production entry point now improves on (this task's own Section 11).
  test('C. 10 dome / 5 Contractor / 100 DT -- V3.0 Phase 7A: now resolved exactly in production too', () => {
    const { production, prototype } = runBoth('C (10 dome / 5 Contractor / 100 DT)', SCENARIOS.C);
    assert.equal(production.result.ok, true);
    assert.equal(production.result.status, 'OK');
    assert.equal(production.result.solverPath, 'HARDCASE_MITM');
    // eslint-disable-next-line no-console
    console.log(`[v3-phase6b] C: production now resolves via solverPath=${production.result.solverPath} (was: SEARCH_INCOMPLETE), prototype=${statusOf(prototype.result)}`);
  });

  test('D. 10 dome / 3 Contractor / 100 DT -- V3.0 Phase 7A: now resolved exactly in production too', () => {
    const { production, prototype } = runBoth('D (10 dome / 3 Contractor / 100 DT)', SCENARIOS.D);
    assert.equal(production.result.ok, true);
    assert.equal(production.result.status, 'OK');
    assert.equal(production.result.solverPath, 'HARDCASE_MITM');
    // eslint-disable-next-line no-console
    console.log(`[v3-phase6b] D: production now resolves via solverPath=${production.result.solverPath} (was: SEARCH_INCOMPLETE), prototype=${statusOf(prototype.result)}`);
  });

  test('E. 10 dome / 2 Contractor / 100 DT concentrated -- V3.0 Phase 7A: production now clears the 20k per-Contractor gate via the hard-case engine', () => {
    const { production, prototype } = runBoth('E (10 dome / 2 Contractor / 100 DT, concentrated)', SCENARIOS.E);
    assert.equal(production.result.ok, true);
    assert.equal(production.result.status, 'OK');
    assert.equal(production.result.solverPath, 'HARDCASE_MITM');
    assert.ok(production.diagnostics, 'production reports hard-case diagnostics, never null');

    // The prototype has NO per-Contractor eager-array gate -- it must reach
    // MAX_SEARCH_NODES-bounded traversal (diagnostics non-null), never the
    // SEARCH_SPACE_TOO_LARGE rejection production used to return.
    assert.notEqual(prototype.result.error, 'SEARCH_SPACE_TOO_LARGE', 'prototype must not apply the eager 20k per-Contractor gate');
    assert.ok(prototype.diagnostics, 'prototype must have actually traversed (diagnostics present)');
    // eslint-disable-next-line no-console
    console.log(`[v3-phase6b] E: production now resolves via solverPath=${production.result.solverPath} (was: SEARCH_SPACE_TOO_LARGE), prototype=${statusOf(prototype.result)} (visitedNodes=${prototype.diagnostics.visitedNodes})`);
  });
});

// ============================================================
// PART 3 -- DETERMINISM for the two scenarios that cannot be checked
// against production (C/D, if the prototype does not reach an exact
// answer there either).
// ============================================================
describe('V3.0 Phase 6B -- prototype determinism (C/D run twice)', () => {
  ['C', 'D'].forEach((name) => {
    test(`${name}: two prototype runs are identical`, () => {
      const input = { targetNi: TARGET_NI, tolerance: TOLERANCE, sources: SCENARIOS[name] };
      const run1 = findBlendRecommendationsSourceLazy(input);
      const run2 = findBlendRecommendationsSourceLazy(input);
      assert.equal(statusOf(run1.result), statusOf(run2.result), `${name}: status changed between runs`);
      assert.equal(run1.result.candidateCount, run2.result.candidateCount, `${name}: candidateCount changed`);
      assert.deepEqual(run1.diagnostics, run2.diagnostics, `${name}: diagnostics changed between runs`);
    });
  });
});
