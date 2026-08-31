// V3.0 Phase 4B -- exact search ordering (docs/
// V3.0_SCALABLE_RECOMMENDATION_ENGINE_ARCHITECTURE.md Sections 20/23, this
// task's "EXACT SEARCH ORDERING"/"BENCHMARKS"/"SEARCH LIMIT").
//
// orderAllocationsForSearch() (js/pages/calculate/blending-recommendation.js)
// reorders each Contractor group's OWN allocation array -- higher fleet
// utilization first, then lower standby, then chemistry contribution closer
// to target, then a canonical lexicographic tie-break -- before the Phase 4B
// branch-and-bound traversal runs. This file proves that reordering:
//   1. is fully deterministic (same input -> byte-identical order, always);
//   2. actually produces the intended monotonic-utilization property;
//   3. never changes candidateCount or the winning candidate (reuses the
//      SAME Phase3-unpruned-vs-production differential harness shape as
//      tests/v3-phase4a-branch-and-bound.test.mjs, whose full seed sweep
//      already covers this exhaustively for the live production path -- this
//      file adds a focused, ordering-specific top-up rather than duplicating
//      that sweep).
// It also reports the Phase 4B benchmark table (this task's BENCHMARKS
// section), including a chemistry-separable "dominant fixed prefix" scenario
// designed specifically to exercise the new maxOpenTonnage-capped bound (see
// blending-recommendation.js's conservativeFinalNiBound() comment) somewhere
// the OLD Phase 4A pooled-extent-only bound provably could NOT prune.
//
// Run with Node's built-in test runner:
//
//   node --test tests/v3-phase4b-search-ordering.test.mjs
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  findBlendRecommendations,
  findBlendRecommendationsStreamingUnpruned,
  findBlendRecommendationsWithDiagnostics,
  orderAllocationsForSearch,
  prepareSearchUnbounded,
  runSearchDirect,
} from '../js/pages/calculate/blending-recommendation.js';
import { countOperationalAllocations, enumerateOperationalAllocations } from '../js/pages/calculate/fleet-allocation.js';
import { mulberry32, NAMED_SEEDS } from './reference/seeded-random.mjs';
import { generateScenario } from './reference/v3-scenario-generator.mjs';
import { canonicalizeRecommendationResult, firstCanonicalDifference } from './reference/canonical-recommendation-result.mjs';

// ============================================================
// 1. DETERMINISM -- same group/allocations/target in, byte-identical order
// out, every time.
// ============================================================
describe('V3.0 Phase 4B search ordering -- deterministic', () => {
  test('orderAllocationsForSearch() returns the identical sequence across repeated calls with the same input', () => {
    const group = {
      sources: [
        { ni: 1.30, tonnesPerUnit: 50, assignedUnits: 20 },
        { ni: 1.00, tonnesPerUnit: 40, assignedUnits: 15 },
      ],
    };
    const fleet = group.sources.reduce((sum, s) => sum + s.assignedUnits, 0);
    const allocations = enumerateOperationalAllocations(fleet, group.sources.length);

    const first = orderAllocationsForSearch(group, allocations, 1.15);
    const second = orderAllocationsForSearch(group, allocations, 1.15);
    assert.deepEqual(first, second);
  });

  test('prepareSearchUnbounded() produces the identical perContractorAllocations order across repeated calls', () => {
    const sources = [
      { pileId: 'A', contractor: 'Ctr1', ni: '1.30', units: '20', tonnesPerUnit: '50' },
      { pileId: 'B', contractor: 'Ctr1', ni: '1.00', units: '15', tonnesPerUnit: '40' },
      { pileId: 'C', contractor: 'Ctr2', ni: '1.10', units: '12', tonnesPerUnit: '45' },
    ];
    const first = prepareSearchUnbounded({ targetNi: '1.15', tolerance: '0.02', sources });
    const second = prepareSearchUnbounded({ targetNi: '1.15', tolerance: '0.02', sources });
    assert.deepEqual(first.perContractorAllocations, second.perContractorAllocations);
  });
});

// ============================================================
// 2. ORDERING PROPERTY -- higher fleet utilization must sort first within
// each group's own allocation array (this task's ordering rule #2/#3).
// ============================================================
describe('V3.0 Phase 4B search ordering -- monotonic utilization property', () => {
  test('a Contractor group\'s ordered allocations never increase in utilization as the array is walked', () => {
    const group = {
      sources: [
        { ni: 1.30, tonnesPerUnit: 50, assignedUnits: 24 },
        { ni: 1.00, tonnesPerUnit: 40, assignedUnits: 18 },
        { ni: 0.90, tonnesPerUnit: 35, assignedUnits: 12 },
      ],
    };
    const fleet = group.sources.reduce((sum, s) => sum + s.assignedUnits, 0);
    const allocations = enumerateOperationalAllocations(fleet, group.sources.length);
    const ordered = orderAllocationsForSearch(group, allocations, 1.10);

    let previousUtilization = Infinity;
    ordered.forEach((allocation) => {
      const activeUnits = allocation.reduce((sum, v) => sum + v, 0);
      const utilization = activeUnits / fleet;
      assert.ok(utilization <= previousUtilization + 1e-9, `utilization must be non-increasing: saw ${utilization} after ${previousUtilization}`);
      previousUtilization = utilization;
    });
    // The all-zero allocation (utilization 0) must be the very last entry --
    // every other allocation strictly uses more fleet.
    const last = ordered[ordered.length - 1];
    assert.equal(last.reduce((sum, v) => sum + v, 0), 0);
  });

  test('within a tied utilization band, chemistry distance to target breaks the tie (closer-to-target sorts first)', () => {
    // Two independent sources, same tonnesPerUnit, fleet chosen so several
    // 1-source-active allocations share IDENTICAL utilization (any single
    // source active at exactly 6 units) -- their own average Ni differs, so
    // chemistry distance is the only thing that can break the tie.
    const group = {
      sources: [
        { ni: 1.50, tonnesPerUnit: 50, assignedUnits: 6 }, // far from target
        { ni: 1.12, tonnesPerUnit: 50, assignedUnits: 6 }, // closer to target
      ],
    };
    const fleet = 12;
    const allocations = enumerateOperationalAllocations(fleet, group.sources.length);
    const ordered = orderAllocationsForSearch(group, allocations, 1.10);

    const sixSixZero = ordered.filter((a) => a.reduce((s, v) => s + v, 0) === 6);
    const indexOfCloser = ordered.findIndex((a) => a[1] === 6 && a[0] === 0); // Ni=1.12 source active
    const indexOfFarther = ordered.findIndex((a) => a[0] === 6 && a[1] === 0); // Ni=1.50 source active
    assert.ok(sixSixZero.length >= 2, 'expected at least two utilization-tied single-source allocations');
    assert.ok(indexOfCloser < indexOfFarther, 'the allocation whose own Ni is closer to target must sort first among utilization ties');
  });
});

// ============================================================
// 3. WINNER/CANDIDATECOUNT UNAFFECTED BY ORDERING -- focused top-up sweep
// (tests/v3-phase4a-branch-and-bound.test.mjs's own 300-case sweep already
// covers this for the live production path; this is a smaller confirmation
// specific to this file's own concern).
// ============================================================
describe('V3.0 Phase 4B search ordering never changes the winner or candidateCount', () => {
  const rng = mulberry32(NAMED_SEEDS.V3_SEED_A1);
  const CASES = 30;
  let compared = 0;

  for (let i = 0; i < CASES; i += 1) {
    const scenario = generateScenario(rng, i);
    test(`case #${i} (${scenario.kind}): Phase 3 unpruned vs Phase 4B production -- exact canonical equality`, () => {
      const unpruned = findBlendRecommendationsStreamingUnpruned(scenario.input);
      const pruned = findBlendRecommendations(scenario.input);
      const unprunedCanonical = canonicalizeRecommendationResult(unpruned);
      const prunedCanonical = canonicalizeRecommendationResult(pruned);
      const diff = firstCanonicalDifference(unprunedCanonical, prunedCanonical);
      assert.equal(diff, null, `${scenario.name}: ${diff}`);
      compared += 1;
    });
  }

  after(() => {
    // eslint-disable-next-line no-console
    console.log(`[v3-phase4b-search-ordering] Phase3-vs-Phase4B top-up: ${compared} compared, 0 mismatches`);
  });
});

// ============================================================
// 4. BENCHMARKS (this task's BENCHMARKS/SEARCH LIMIT sections) -- console
// reporting only, no wall-clock assertions (correctness over pruning %).
// ============================================================
function reportBenchmark(name, rawOperationalSize, run, unprunedDiagnosticsMaybe, elapsedMs) {
  const lines = [
    `[v3-phase4b-search-ordering] BENCHMARK ${name}`,
    `  raw operational search size : ${rawOperationalSize}`,
    `  visited nodes (pruned)      : ${run.diagnostics.visitedNodes}`,
    `  prunedByChemistry           : ${run.diagnostics.prunedByChemistry}`,
    `  completedCandidates         : ${run.diagnostics.completedCandidates}`,
    `  result.candidateCount       : ${run.result.ok ? run.result.candidateCount : `(${run.result.error})`}`,
    `  runtime (ms)                : ${elapsedMs.toFixed(2)}`,
  ];
  if (unprunedDiagnosticsMaybe) {
    lines.push(`  visited nodes (unpruned ref): ${unprunedDiagnosticsMaybe.visitedNodes}`);
    const reduction = 100 * (1 - run.diagnostics.completedCandidates / unprunedDiagnosticsMaybe.completedCandidates);
    lines.push(`  completed-candidate reduction vs unpruned Phase 3: ${reduction.toFixed(3)}%`);
  }
  // eslint-disable-next-line no-console
  console.log(lines.join('\n'));
}

describe('V3.0 Phase 4B benchmarks -- A/B/D (C is covered by tests/v3-phase4a-branch-and-bound.test.mjs, now exercising the Phase 4B bound+ordering automatically)', () => {
  test('A. 4 domes / 2 Contractors / 60 DT -- production gate, real findBlendRecommendations()', () => {
    const sources = [];
    for (let c = 0; c < 2; c += 1) {
      for (let s = 0; s < 2; s += 1) {
        sources.push({ pileId: `C${c}-S${s}`, contractor: `Contractor${c}`, ni: s % 2 === 0 ? '1.30' : '1.00', units: '15', tonnesPerUnit: '50' });
      }
    }
    const rawOperationalSize = countOperationalAllocations(30, 2) ** 2;
    const start = process.hrtime.bigint();
    const { result, diagnostics } = findBlendRecommendationsWithDiagnostics({ targetNi: '1.15', tolerance: '0.05', sources });
    const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6;
    assert.equal(result.ok, true);
    assert.equal(result.status, 'OK');
    reportBenchmark('A (4 dome / 2 Contractor / 60 DT)', rawOperationalSize, { result, diagnostics }, null, elapsedMs);
  });

  test('B. 6 domes / 3 Contractors / 60 DT -- V3.0 Phase 4D: production gate no longer rejects it, real findBlendRecommendations() completes it exactly', () => {
    const sources = [];
    for (let c = 0; c < 3; c += 1) {
      for (let s = 0; s < 2; s += 1) {
        sources.push({ pileId: `C${c}-S${s}`, contractor: `Contractor${c}`, ni: s % 2 === 0 ? '1.30' : '1.00', units: '10', tonnesPerUnit: '50' });
      }
    }
    const gated = findBlendRecommendations({ targetNi: '1.15', tolerance: '0.05', sources });
    assert.equal(gated.ok, true);
    assert.equal(gated.status, 'OK');
    assert.equal(gated.candidateCount, 438975);

    const rawOperationalSize = countOperationalAllocations(20, 2) ** 3;
    const prepared = prepareSearchUnbounded({ targetNi: '1.15', tolerance: '0.05', sources });
    assert.equal(prepared.ok, true);

    const start = process.hrtime.bigint();
    const pruned = runSearchDirect(prepared, true);
    const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6;
    assert.equal(pruned.result.ok, true);
    reportBenchmark('B (6 dome / 3 Contractor / 60 DT)', rawOperationalSize, pruned, null, elapsedMs);
  });

  test('D. chemistry-separable "dominant fixed prefix" scenario -- designed so Phase 4B\'s tonnage-capped bound prunes where Phase 4A\'s pooled-extent-only bound provably could not', () => {
    // Contractor A: dominant fleet (60 DT across 2 sources), both sources
    // Ni=0.50 (far below target). Contractor B/C: small fleets (6 DT each,
    // single source), Ni=1.50/1.55 respectively.
    //
    // Target 1.52 +/- 0.02 (window [1.50, 1.54]) is only reachable when
    // Contractor A stays mostly/entirely OFF. Once A commits a large active
    // allocation, fixedNi~=0.50 with fixedTonnage dominating -- the OLD
    // Phase 4A bound would still show maxNi=1.55 (B/C's own pooled extreme)
    // and WRONGLY conclude the window is still reachable; Phase 4B's
    // maxOpenTonnage cap on B/C's own small remaining tonnage correctly
    // shows the window is unreachable once A is large, and prunes it.
    const sources = [
      { pileId: 'A1', contractor: 'ContractorA', ni: '0.50', units: '30', tonnesPerUnit: '50' },
      { pileId: 'A2', contractor: 'ContractorA', ni: '0.50', units: '30', tonnesPerUnit: '50' },
      { pileId: 'B1', contractor: 'ContractorB', ni: '1.50', units: '6', tonnesPerUnit: '50' },
      { pileId: 'C1', contractor: 'ContractorC', ni: '1.55', units: '6', tonnesPerUnit: '50' },
    ];
    const input = { targetNi: '1.52', tolerance: '0.02', sources };

    const rawOperationalSize = countOperationalAllocations(60, 2) * 2 * 2;
    const start = process.hrtime.bigint();
    const { result, diagnostics } = findBlendRecommendationsWithDiagnostics(input);
    const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6;
    const unpruned = findBlendRecommendationsStreamingUnpruned(input);

    assert.equal(result.ok, true);
    assert.ok(diagnostics.prunedByChemistry > 0, `expected the dominant-fixed-prefix shape to trigger real pruning, got ${diagnostics.prunedByChemistry}`);

    const diff = firstCanonicalDifference(canonicalizeRecommendationResult(unpruned), canonicalizeRecommendationResult(result));
    assert.equal(diff, null, `production diverged from Phase 3 unpruned: ${diff}`);

    reportBenchmark('D (dominant fixed prefix, chemistry-separable)', rawOperationalSize, { result, diagnostics }, null, elapsedMs);
  });
});
