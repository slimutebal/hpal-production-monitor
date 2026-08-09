// V3.0 Phase 2 -- newly-unblocked performance coverage (this task's
// Section 11/31/32). Demonstrates the audit's own headline finding
// (docs/V3.0_SCALABLES_RECOMMENDATION_ENGINE_ARCHITECTURE.md Sections
// 10-18): a realistic 4-dome / 2-Contractor / 60-DT scenario that legacy
// V2.x rejects outright (raw candidate count 246,016 > 200,000) now
// SUCCEEDS under Phase 2, because the operationally-feasible count for
// the identical input (58,081) clears the SAME unchanged
// MAX_ALLOCATIONS_PER_CONTRACTOR/MAX_GLOBAL_CANDIDATES limits.
//
// This does NOT claim V3.0 scalability at the 10-dome/7-Contractor/100+DT
// target envelope (this task's Section 12) -- that remains for a later
// Branch-and-Bound phase. It proves exactly one thing: Phase 2 already
// makes SOME previously-rejected realistic scenarios pass, using nothing
// but generation-time feasibility pruning.
//
// Run with Node's built-in test runner:
//
//   node --test tests/v3-phase2-performance.test.mjs
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { findBlendRecommendations } from '../js/pages/calculate/blending-recommendation.js';
import { findBlendRecommendationsReference } from './reference/v2-exhaustive/blending-recommendation-reference.mjs';
import {
  countContractorAllocations,
  countOperationalAllocations,
  MAX_GLOBAL_CANDIDATES,
} from '../js/pages/calculate/fleet-allocation.js';

// 4 domes / 2 Contractors / 60 DT total -- each Contractor's OWN fleet is
// 30 DT spread across its 2 domes (this task's Section 11's own audited
// "balanced" Scenario A: "2 dome x 30 DT/Contractor" means each
// Contractor's total is 30 DT, not each dome individually -- confirmed by
// countContractorAllocations(30, 2) = 496, which is exactly the
// per-Contractor factor of the audited raw global count 246,016 = 496^2).
function buildScenarioA() {
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

describe('V3.0 Phase 2 newly-unblocked performance case (this task\'s Section 11/31/32)', () => {
  test('raw vs. operational candidate counts for the audited 4-dome/2-Contractor/60-DT shape (2 domes x 30 DT per Contractor)', () => {
    // Per-Contractor shape: F=30 DT across n=2 domes.
    const rawPerContractor = countContractorAllocations(30, 2);
    const operationalPerContractor = countOperationalAllocations(30, 2);
    assert.equal(rawPerContractor, 496);
    assert.equal(operationalPerContractor, 241);

    const rawGlobal = rawPerContractor ** 2;
    const operationalGlobal = operationalPerContractor ** 2;
    assert.equal(rawGlobal, 246016, 'must match the audit doc\'s own re-derived raw count exactly');
    assert.equal(operationalGlobal, 58081, 'must match the audit doc\'s own re-derived operational count exactly');

    assert.ok(rawGlobal > MAX_GLOBAL_CANDIDATES, 'the raw (legacy) count must still exceed the unchanged 200,000 limit');
    assert.ok(operationalGlobal < MAX_GLOBAL_CANDIDATES, 'the operational (Phase 2) count must clear the SAME unchanged 200,000 limit');
  });

  test('legacy frozen reference REJECTS this scenario as SEARCH_SPACE_TOO_LARGE', () => {
    const sources = buildScenarioA();
    const result = findBlendRecommendationsReference({ targetNi: 1.15, tolerance: 0.05, sources });
    assert.equal(result.ok, false);
    assert.equal(result.error, 'SEARCH_SPACE_TOO_LARGE');
  });

  test('V3 Phase 2 production ACCEPTS the identical scenario -- newly unblocked purely by generation-time feasibility pruning, same safety limits', () => {
    const sources = buildScenarioA();
    const start = performance.now();
    const result = findBlendRecommendations({ targetNi: 1.15, tolerance: 0.05, sources });
    const elapsedMs = performance.now() - start;
    // eslint-disable-next-line no-console
    console.log(`[v3-phase2-performance] Scenario A (4 domes/2 Contractors/60 DT): ${elapsedMs.toFixed(2)}ms, candidateCount=${result.ok ? result.candidateCount : `N/A (${result.error})`}`);

    assert.equal(result.ok, true);
    assert.notEqual(result.error, 'SEARCH_SPACE_TOO_LARGE');
    // candidateCount (candidates.length) is the gate count (58,081) MINUS
    // the single globally-all-zero combination buildCandidate() excludes
    // (this task's Section 9 -- "count includes all-zero, candidate count
    // excludes it").
    assert.equal(result.candidateCount, 58080);
    // Generous sanity ceiling (this task's Section 32: "no hardcoded
    // overly-tight millisecond threshold that makes CI flaky"), not a
    // tight performance budget.
    assert.ok(elapsedMs < 5000);
  });

  test('the existing ~12.3M-candidate oversized case (3 Contractors x 2 sources x 10 DT) is STILL rejected under Phase 2 (this task\'s Section 30) -- operational count 438,976 still exceeds 200,000', () => {
    const perContractorOperational = countOperationalAllocations(20, 2);
    assert.equal(perContractorOperational, 76);
    const globalOperational = perContractorOperational ** 3;
    assert.equal(globalOperational, 438976, 'must match the audit doc\'s own re-derived Scenario C operational count exactly');
    assert.ok(globalOperational > MAX_GLOBAL_CANDIDATES);

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
    const result = findBlendRecommendations({ targetNi: 1.15, tolerance: 0.05, sources });
    assert.equal(result.ok, false);
    assert.equal(result.error, 'SEARCH_SPACE_TOO_LARGE');
  });
});
