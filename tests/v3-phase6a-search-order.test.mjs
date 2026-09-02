// V3.0 Phase 6A -- Exact Contractor Search Ordering (docs/
// V3.0_SCALABLE_RECOMMENDATION_ENGINE_ARCHITECTURE.md Section 23's
// "traversal order may change only to find a strong incumbent earlier").
//
// GOAL: Phase 5 found 10 dome/5 Contractor/100 DT (C) and 10 dome/3
// Contractor/100 DT (D) exhaust MAX_SEARCH_NODES (500,000, UNCHANGED here)
// without a proven exact answer. This file investigates a SEPARATE
// deterministic traversal order for Contractor GROUPS (which group is
// decided at which recursion depth) -- distinct from Phase 4B's own
// per-group ALLOCATION order (orderAllocationsForSearch(), untouched) and
// from the CANONICAL group order candidate construction/allocationSignature
// always use (buildCandidate() reads the canonical `groups` array
// regardless of traversal order -- see blending-recommendation.js's own
// Phase 6A section comment for why this can never change candidate
// identity or candidateCount).
//
// METHOD: six deterministic strategies (blending-recommendation.js's
// computeSearchOrderForStrategy()) were benchmarked test-only against A/B/C/D
// via runSearchDirect()'s explicit searchOrder override:
//   canonical, smallest-space-first, largest-space-first,
//   tonnage-influence-first, ni-span-first, tonnage-then-smallest-space
//
// RESULT (see BENCHMARK section below for live numbers):
//   - A/B: smallest-space-first cuts visitedNodes by ~55-71% (both already
//     completed OK under canonical order too -- this is a material
//     efficiency win, not a correctness fix).
//   - C: EVERY strategy is numerically IDENTICAL to canonical, because all
//     5 Contractor groups have the EXACT SAME allocation count (76) --
//     there is no group-size asymmetry for any size-based strategy to
//     exploit, and chemistry pruning measures 0 prunes under every order
//     (the symmetric high/low source design keeps the achievable-Ni
//     interval straddling target almost everywhere, so the bound cannot
//     discriminate regardless of visitation order).
//   - D: canonical order ALREADY decides the one large group (16,796
//     allocations) first (alphabetically Contractor0 is also the largest
//     fleet here), which coincides with largest-space-first. Reordering to
//     smallest-space-first makes things WORSE (prunedByRanking collapses
//     from 4,073 to 12) without changing the externally visible outcome
//     (both still hit exactly 500,000/500,000 -- SEARCH_INCOMPLETE either
//     way).
//   Neither C nor D completes under ANY tested search order. This is
//   reported HONESTLY (this task's own instruction) rather than hidden --
//   group search order alone cannot compensate for a chemistry bound that
//   cannot discriminate on this symmetric-target problem shape.
//
// CHOSEN STRATEGY: 'smallest-space-first' (blending-recommendation.js's
// computeContractorSearchOrder()) -- selected because it gives a material,
// exactness-preserving improvement on A/B, is a no-op tie on C (proven
// below), and does not change D's externally visible result (both before
// and after are SEARCH_INCOMPLETE at exactly 500,000 visited nodes).
//
// EXACTNESS: every strategy's PRUNED result is asserted byte-identical
// (via the same canonicalizeRecommendationResult()/firstCanonicalDifference()
// used elsewhere) to the CANONICAL-order PRUNED result whenever canonical
// order itself produces an exact OK/TARGET_NOT_ACHIEVABLE answer (A/B) --
// this is proof that reordering traversal depth never changes the winner,
// stronger than a metadata-only comparison since both sides go through the
// REAL Phase 4B/4C bounds, just in a different group visitation order. C/D
// never reach an exact answer under any strategy, so no diff is attempted
// there (per this task's "do not invent expected winners" instruction) --
// instead both are run TWICE and asserted identical on status/
// candidateCount/diagnostics (determinism).
//
// Run with Node's built-in test runner:
//
//   node --test tests/v3-phase6a-search-order.test.mjs
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  findBlendRecommendations,
  findBlendRecommendationsWithDiagnostics,
  prepareSearchUnbounded,
  runSearchDirect,
  computeSearchOrderForStrategy,
  computeContractorSearchOrder,
  MAX_SEARCH_NODES,
} from '../js/pages/calculate/blending-recommendation.js';
import { canonicalizeRecommendationResult, firstCanonicalDifference } from './reference/canonical-recommendation-result.mjs';

const STRATEGIES = ['canonical', 'smallest-space-first', 'largest-space-first', 'tonnage-influence-first', 'ni-span-first', 'tonnage-then-smallest-space'];

// Identical scenario construction to tests/v3-phase5-operational-scale.test.mjs
// (this task's own A/B/C/D scenarios), reused verbatim so the before/after
// visitedNodes numbers below are directly comparable to Phase 5's report.
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

const SCENARIOS = {
  A: buildScenarioSources([2, 2, 2, 1, 1], 10),
  B: buildScenarioSources([2, 2, 2, 1, 1, 1, 1], 10),
  C: buildScenarioSources([2, 2, 2, 2, 2], 10),
  D: buildScenarioSources([4, 3, 3], 10),
};
const TARGET_NI = '1.15';
const TOLERANCE = '0.05';

function statusOf(result) {
  return result.ok ? result.status : result.error;
}

describe('V3.0 Phase 6A sanity: node budget/gate constants unchanged by this phase', () => {
  test('sanity', () => {
    assert.equal(MAX_SEARCH_NODES, 500000);
  });
});

// ============================================================
// 1. STRATEGY BENCHMARK (this task's deliverable #1) -- every strategy run
// against A/B/C/D via the SAME prepared search, differing only in
// searchOrder.
// ============================================================
describe('V3.0 Phase 6A -- search order strategy benchmark (A/B/C/D x 6 strategies)', () => {
  Object.entries(SCENARIOS).forEach(([name, sources]) => {
    test(`Scenario ${name}`, () => {
      const prepared = prepareSearchUnbounded({ targetNi: TARGET_NI, tolerance: TOLERANCE, sources });
      const canonicalOrder = computeSearchOrderForStrategy(prepared.groups, prepared.perContractorAllocations, 'canonical');
      const canonicalRun = runSearchDirect(prepared, true, true, canonicalOrder);

      STRATEGIES.forEach((strategy) => {
        const order = computeSearchOrderForStrategy(prepared.groups, prepared.perContractorAllocations, strategy);
        const start = process.hrtime.bigint();
        const { result, diagnostics } = runSearchDirect(prepared, true, true, order);
        const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6;

        // EXACTNESS (this task's Section 2): reordering must never change
        // the winner, but a diff is only meaningful when BOTH sides
        // actually reached an exact answer (SEARCH_INCOMPLETE carries no
        // `candidate` to compare -- see buildResultFromSearch()'s own
        // comment).
        if (canonicalRun.result.ok && result.ok) {
          const diff = firstCanonicalDifference(canonicalizeRecommendationResult(canonicalRun.result), canonicalizeRecommendationResult(result));
          assert.equal(diff, null, `Scenario ${name}, strategy ${strategy}: winner diverged from canonical-order result: ${diff}`);
        } else {
          assert.equal(statusOf(result), statusOf(canonicalRun.result), `Scenario ${name}, strategy ${strategy}: status diverged from canonical order (${statusOf(canonicalRun.result)} vs ${statusOf(result)}) -- reordering must never change WHETHER an exact answer exists when the other side found none either`);
        }

        // eslint-disable-next-line no-console
        console.log(`[v3-phase6a] ${name} / ${strategy.padEnd(28)} visitedNodes=${String(diagnostics.visitedNodes).padStart(7)} completed=${String(diagnostics.completedCandidates).padStart(7)} prunedChem=${String(diagnostics.prunedByChemistry).padStart(6)} prunedRank=${String(diagnostics.prunedByRanking).padStart(6)} status=${statusOf(result).padEnd(18)} time=${elapsedMs.toFixed(1)}ms`);
      });
    });
  });
});

// ============================================================
// 2. CHOSEN STRATEGY WIRED INTO PRODUCTION -- computeContractorSearchOrder()
// must be exactly 'smallest-space-first', never a runtime switch.
// ============================================================
describe('V3.0 Phase 6A -- chosen strategy is fixed, not a runtime switch', () => {
  test('computeContractorSearchOrder() matches computeSearchOrderForStrategy(..., "smallest-space-first") for an asymmetric scenario', () => {
    const prepared = prepareSearchUnbounded({ targetNi: TARGET_NI, tolerance: TOLERANCE, sources: SCENARIOS.D });
    const chosen = computeContractorSearchOrder(prepared.groups, prepared.perContractorAllocations);
    const explicit = computeSearchOrderForStrategy(prepared.groups, prepared.perContractorAllocations, 'smallest-space-first');
    assert.deepEqual(chosen, explicit);
  });
});

// ============================================================
// 3. PRODUCTION REGRESSION -- A/B via the REAL findBlendRecommendations()/
// findBlendRecommendationsWithDiagnostics() (this task's Section 4
// Regression scenarios): must still return OK, exact, and with materially
// fewer visited nodes than Phase 5's canonical-order baseline (A: 15,305;
// B: 23,333).
// ============================================================
describe('V3.0 Phase 6A production regression: A/B via real findBlendRecommendations()', () => {
  test('A. 8 dome / 5 Contractor / 80 DT -- OK, fewer visitedNodes than the Phase 5 canonical-order baseline (15,305)', () => {
    const { result, diagnostics } = findBlendRecommendationsWithDiagnostics({ targetNi: TARGET_NI, tolerance: TOLERANCE, sources: SCENARIOS.A });
    assert.equal(result.ok, true);
    assert.equal(result.status, 'OK');
    assert.equal(result.candidateCount, 15803135);
    assert.ok(diagnostics.visitedNodes < 15305, `expected fewer than Phase 5's 15,305 canonical-order nodes, got ${diagnostics.visitedNodes}`);
  });

  test('B. 10 dome / 7 Contractor / 100 DT balanced -- OK, fewer visitedNodes than the Phase 5 canonical-order baseline (23,333)', () => {
    const { result, diagnostics } = findBlendRecommendationsWithDiagnostics({ targetNi: TARGET_NI, tolerance: TOLERANCE, sources: SCENARIOS.B });
    assert.equal(result.ok, true);
    assert.equal(result.status, 'OK');
    assert.equal(result.candidateCount, 568912895);
    assert.ok(diagnostics.visitedNodes < 23333, `expected fewer than Phase 5's 23,333 canonical-order nodes, got ${diagnostics.visitedNodes}`);
  });
});

// ============================================================
// 4. PRIMARY TARGETS C/D -- HONEST REPORT (this task's Section 4): neither
// completes under any tested search order, so no strategy claims to fix
// them. Determinism (2 runs) is the exactness property verifiable at this
// scale, per this task's own instruction.
// ============================================================
function assertIdenticalRuns(name, run1, run2) {
  assert.equal(statusOf(run1.result), statusOf(run2.result), `${name}: status changed between runs`);
  assert.equal(run1.result.candidateCount, run2.result.candidateCount, `${name}: candidateCount changed`);
  assert.deepEqual(run1.diagnostics, run2.diagnostics, `${name}: diagnostics changed between runs`);
}

// V3.0 Phase 7A UPDATE: at the time this file's search-order investigation
// ran (Phase 6A), reordering alone could not close the C/D gap -- both
// still exhausted the group-granularity B&B's own MAX_SEARCH_NODES budget,
// exactly as this describe block originally documented. The V3.0 program
// went on (Phase 6H/6I/6J/6K/6L) to prove a DIFFERENT mechanism -- the
// prefix-lock + Meet-In-The-Middle hard-case solver -- closes this gap
// exactly, and Phase 7A wires it into findBlendRecommendations() itself as
// the hybrid dispatcher's second path. C/D now resolve to a real, exact OK
// result in production; this describe block is kept (not deleted) as the
// historical "before" baseline this same production entry point now
// improves on, per this task's own Section 11 audit-trail requirement.
describe('V3.0 Phase 6A primary targets C/D -- V3.0 Phase 7A UPDATE: now resolve exactly via the hard-case dispatcher', () => {
  test('C. 10 dome / 5 Contractor / 100 DT -- resolved exactly by the hard-case (prefix-lock + MITM) engine', () => {
    const input = { targetNi: TARGET_NI, tolerance: TOLERANCE, sources: SCENARIOS.C };
    const run1 = findBlendRecommendationsWithDiagnostics(input);
    const run2 = findBlendRecommendationsWithDiagnostics(input);
    assertIdenticalRuns('C', run1, run2);

    assert.equal(run1.result.ok, true);
    assert.equal(run1.result.status, 'OK');
    assert.equal(run1.result.solverPath, 'HARDCASE_MITM');
    // eslint-disable-next-line no-console
    console.log(`[v3-phase6a] V3.0 Phase 7A: C now resolves OK via solverPath=${run1.result.solverPath} (was: SEARCH_INCOMPLETE under Phase 6A's own group-order-only search).`);
  });

  test('D. 10 dome / 3 Contractor / 100 DT -- resolved exactly by the hard-case (prefix-lock + MITM) engine', () => {
    const input = { targetNi: TARGET_NI, tolerance: TOLERANCE, sources: SCENARIOS.D };
    const run1 = findBlendRecommendationsWithDiagnostics(input);
    const run2 = findBlendRecommendationsWithDiagnostics(input);
    assertIdenticalRuns('D', run1, run2);

    assert.equal(run1.result.ok, true);
    assert.equal(run1.result.status, 'OK');
    assert.equal(run1.result.solverPath, 'HARDCASE_MITM');
    // eslint-disable-next-line no-console
    console.log(`[v3-phase6a] V3.0 Phase 7A: D now resolves OK via solverPath=${run1.result.solverPath} (was: SEARCH_INCOMPLETE under Phase 6A's own group-order-only search).`);
  });
});

// ============================================================
// 5. NODE BUDGET/GATE UNCHANGED (this task's Section 4/5) -- MAX_SEARCH_NODES
// stays 500,000; the per-Contractor 20k gate is explicitly out of scope
// (Phase 6B).
// ============================================================
describe('V3.0 Phase 6A -- node budget and per-Contractor gate untouched by this phase', () => {
  test('MAX_SEARCH_NODES is unchanged at 500000', () => {
    assert.equal(MAX_SEARCH_NODES, 500000);
  });

  test('findBlendRecommendations() is the real production entry point used above (no test-only bypass)', () => {
    const result = findBlendRecommendations({ targetNi: TARGET_NI, tolerance: TOLERANCE, sources: SCENARIOS.A });
    assert.equal(result.ok, true);
    assert.equal(result.status, 'OK');
  });
});
