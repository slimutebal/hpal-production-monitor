// Recommendation engine search-performance benchmark (V2.4 Phase 3). See
// this task's Section 38.
//
// Run with Node's built-in test runner:
//
//   node --test tests/recommendation-performance.test.mjs
//
// ALGORITHM (see js/pages/calculate/fleet-allocation.js/blending-
// recommendation.js for the implementation):
//
//   1. Sources are grouped by Contractor. Within a Contractor with total
//      physical fleet F distributed over n sources, EVERY integer tuple
//      (a_1..a_n), a_i >= 0, Sum(a_i) <= F is enumerated -- this is
//      EXHAUSTIVE over the space Section 19 defines (physical fleet
//      allocation, never a consumable-load search), so no candidate that
//      satisfies the architecture doc's feasibility rules can be missed.
//      Its size is C(F+n, n) (stars-and-bars).
//   2. Per-Contractor allocation sets are combined via a full Cartesian
//      product across Contractors (material may freely blend across
//      Contractors, so no candidate that differs only in which Contractor
//      supplies which units can be pruned away).
//   3. Every candidate is built (tonnage-weighted Ni, ratios, relocations)
//      and partitioned into within-tolerance vs not; the deterministic
//      lexicographic ranking (recommendation-ranking.js) picks the winner.
//
// Before generating anything, blending-recommendation.js computes the
// EXACT candidate count via the closed-form binomial formula and compares
// it against MAX_ALLOCATIONS_PER_CONTRACTOR / MAX_GLOBAL_CANDIDATES
// (fleet-allocation.js) -- so a pathological input returns an explicit
// SEARCH_SPACE_TOO_LARGE result instead of ever attempting an
// exponential-time enumeration. No random/heuristic search is used
// anywhere; the bound only ever REJECTS a search, never truncates one that
// was already in progress.
//
// This file reports timings/candidate counts to the console for the
// Owner/CI to read (this task's Section 38 deliverable item 20) rather
// than hard-failing on absolute milliseconds, which would make the suite
// flaky across different machines. Each scenario DOES assert that the
// search actually completes (ok:true, no SEARCH_SPACE_TOO_LARGE) and stays
// under a generous (5s) sanity ceiling, as a regression guard against an
// accidental algorithmic blow-up.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { findBlendRecommendations } from '../js/pages/calculate/blending-recommendation.js';

function buildScenario({ contractorCount, sourcesPerContractor, fleetPerSource }) {
  const sources = [];
  for (let c = 0; c < contractorCount; c += 1) {
    for (let s = 0; s < sourcesPerContractor; s += 1) {
      const isHigher = s % 2 === 0;
      sources.push({
        pileId: `C${c}-S${s}`,
        contractor: `Contractor${c}`,
        ni: isHigher ? '1.30' : '1.00',
        units: String(fleetPerSource),
        tonnesPerUnit: '50',
      });
    }
  }
  return sources;
}

function runScenario(label, sources) {
  const start = performance.now();
  const result = findBlendRecommendations({ targetNi: 1.15, tolerance: 0.05, sources });
  const elapsedMs = performance.now() - start;
  const totalUnits = sources.length;
  // eslint-disable-next-line no-console
  console.log(`[recommendation-performance] ${label}: ${totalUnits} sources, ${elapsedMs.toFixed(2)}ms, candidateCount=${result.ok ? result.candidateCount : `N/A (${result.error})`}`);
  return { result, elapsedMs };
}

describe('Recommendation search performance -- realistic synthetic source sets (this task\'s Section 38)', () => {
  test('2 sources (1 Contractor x 2 sources, 10 DT each)', () => {
    // 1 Contractor, fleet F = 2 x 10 = 20, n=2 -> C(22,2) = 231 global candidates.
    const sources = buildScenario({ contractorCount: 1, sourcesPerContractor: 2, fleetPerSource: 10 });
    const { result, elapsedMs } = runScenario('2 sources', sources);
    assert.equal(result.ok, true);
    assert.notEqual(result.error, 'SEARCH_SPACE_TOO_LARGE');
    assert.ok(elapsedMs < 5000);
  });

  test('4 sources (2 Contractors x 2 sources, 10 DT each)', () => {
    // Each Contractor: fleet F = 2 x 10 = 20, n=2 -> C(22,2) = 231
    // allocations; 2 Contractors -> 231^2 = 53,361 global candidates.
    const sources = buildScenario({ contractorCount: 2, sourcesPerContractor: 2, fleetPerSource: 10 });
    const { result, elapsedMs } = runScenario('4 sources', sources);
    assert.equal(result.ok, true);
    assert.notEqual(result.error, 'SEARCH_SPACE_TOO_LARGE');
    assert.ok(elapsedMs < 5000);
  });

  test('6 sources (3 Contractors x 2 sources, 4 DT each)', () => {
    // Each Contractor: fleet F = 2 sources x 4 DT = 8, n=2 ->
    // C(8+2,2) = 45 allocations; 3 Contractors -> 45^3 = 91,125 global
    // candidates, comfortably under MAX_GLOBAL_CANDIDATES (200,000).
    const sources = buildScenario({ contractorCount: 3, sourcesPerContractor: 2, fleetPerSource: 4 });
    const { result, elapsedMs } = runScenario('6 sources', sources);
    assert.equal(result.ok, true);
    assert.notEqual(result.error, 'SEARCH_SPACE_TOO_LARGE');
    assert.ok(elapsedMs < 5000);
  });

  test('a deliberately oversized scenario is rejected explicitly rather than left to run unbounded', () => {
    // Each Contractor: fleet F = 2 sources x 10 DT = 20, n=2 ->
    // C(22,2) = 231 allocations (under the per-Contractor bound); 3
    // Contractors -> 231^3 ~= 12.3M global candidates, far over
    // MAX_GLOBAL_CANDIDATES -- must be rejected before any enumeration.
    const sources = buildScenario({ contractorCount: 3, sourcesPerContractor: 2, fleetPerSource: 10 });
    const { result } = runScenario('oversized (rejected)', sources);
    assert.equal(result.ok, false);
    assert.equal(result.error, 'SEARCH_SPACE_TOO_LARGE');
  });
});
