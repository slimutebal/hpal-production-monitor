// V3.0 Phase 6G -- Exact Source-Level Completion Envelope: MEASUREMENT ONLY
// (docs/V3.0_SCALABLE_RECOMMENDATION_ENGINE_ARCHITECTURE.md Section 20/23;
// this task's "before designing another algorithm, determine how much exact
// work C/D actually require to COMPLETE").
//
// No new pruning algorithm. No new chemistry/dominance/ranking-bound logic.
// Uses the SAME "best proven exact lazy configuration" as Phase 6D/6E/6F's
// own benchmark files (canonical source order / descending value order /
// COUPLED chemistry bound; Phase 6E's extended ranking bound and Phase 6F's
// dominance frontier are both excluded -- neither reduced C/D's node count,
// see those phases' own benchmark files) via the SOLE new addition this
// phase makes: findBlendRecommendationsSourceLazyCoupledBudgeted()
// (blending-recommendation-source-lazy.js, Phase 6G), a TEST-ONLY explicit
// `nodeBudget` override of the SAME imported MAX_SEARCH_NODES constant
// every earlier phase hardcoded -- production's own MAX_SEARCH_NODES is
// never touched (sanity-checked below).
//
// Run with Node's built-in test runner:
//   node --test tests/v3-phase6g-budget-sweep.test.mjs
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  findBlendRecommendationsSourceLazyCoupled,
  findBlendRecommendationsSourceLazyCoupledBudgeted,
} from '../js/pages/calculate/blending-recommendation-source-lazy.js';
import {
  findBlendRecommendationsWithDiagnostics,
  MAX_SEARCH_NODES,
} from '../js/pages/calculate/blending-recommendation.js';

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

const BUDGET_TIERS = [500000, 1000000, 2000000, 5000000];

function runAtTier(sources, tier) {
  const input = { targetNi: TARGET_NI, tolerance: TOLERANCE, sources };
  const t0 = process.hrtime.bigint();
  const { result, diagnostics } = findBlendRecommendationsSourceLazyCoupledBudgeted(input, tier);
  const t1 = process.hrtime.bigint();
  return { result, diagnostics, ms: Number(t1 - t0) / 1e6 };
}

// Sweeps BUDGET_TIERS in order, stopping (this task's own "stop increasing
// as soon as the scenario completes") the first time status is no longer
// SEARCH_INCOMPLETE. Never tries a tier past 5,000,000 (this task's "if it
// still does not complete at 5M: STOP and report").
function sweep(name, sources) {
  const rows = [];
  let completedAt = null;
  for (const tier of BUDGET_TIERS) {
    const { result, diagnostics, ms } = runAtTier(sources, tier);
    rows.push({ tier, status: statusOf(result), diagnostics, ms });
    // eslint-disable-next-line no-console
    console.log(`[v3-phase6g] ${name} tier=${tier} status=${statusOf(result)} visited=${diagnostics.visitedNodes} completed=${diagnostics.completedCandidates} prunedChem=${diagnostics.prunedByChemistry} prunedRank=${diagnostics.prunedByRanking} runtime=${ms.toFixed(1)}ms`);
    if (statusOf(result) !== 'SEARCH_INCOMPLETE') {
      completedAt = rows[rows.length - 1];
      break;
    }
  }
  return { rows, completedAt };
}

describe('V3.0 Phase 6G -- sanity: production MAX_SEARCH_NODES untouched, budgeted entry point defaults to it', () => {
  test('production MAX_SEARCH_NODES is still exactly 500000', () => {
    assert.equal(MAX_SEARCH_NODES, 500000);
  });

  test('findBlendRecommendationsSourceLazyCoupledBudgeted() with no budget argument is byte-identical to findBlendRecommendationsSourceLazyCoupled()', () => {
    const input = { targetNi: TARGET_NI, tolerance: TOLERANCE, sources: SCENARIOS.A };
    const coupled = findBlendRecommendationsSourceLazyCoupled(input);
    const budgetedDefault = findBlendRecommendationsSourceLazyCoupledBudgeted(input);
    assert.equal(budgetedDefault.diagnostics.visitedNodes, coupled.diagnostics.visitedNodes);
    assert.equal(statusOf(budgetedDefault.result), statusOf(coupled.result));
    assert.deepEqual(budgetedDefault.result.candidate, coupled.result.candidate);
  });
});

// ============================================================
// C -- 10 dome / 5 Contractor / 100 DT
// ============================================================
describe('V3.0 Phase 6G -- C budget sweep: 10 dome / 5 Contractor / 100 DT', () => {
  test('sweep completes at or before 1,000,000 nodes; report exact completion point', () => {
    const { rows, completedAt } = sweep('C', SCENARIOS.C);
    assert.equal(rows[0].tier, 500000);
    assert.equal(rows[0].status, 'SEARCH_INCOMPLETE', 'C: must still be incomplete at the unchanged production-calibrated 500k tier (matches Phase 6D/E/F baseline)');
    assert.equal(rows[0].diagnostics.visitedNodes, 500000);

    assert.ok(completedAt, 'C: expected to complete at or before the 5,000,000-node ceiling');
    assert.notEqual(completedAt.status, 'SEARCH_INCOMPLETE');
    assert.ok(completedAt.diagnostics.visitedNodes < completedAt.tier, 'C: actual visitedNodes at completion must be below the tier ceiling it completed under (search stopped on its own, not because it hit the cap)');
    // eslint-disable-next-line no-console
    console.log(`[v3-phase6g] C EXACT COMPLETION: tier=${completedAt.tier} visitedNodes=${completedAt.diagnostics.visitedNodes} completedCandidates=${completedAt.diagnostics.completedCandidates} prunedByChemistry=${completedAt.diagnostics.prunedByChemistry} prunedByRanking=${completedAt.diagnostics.prunedByRanking} runtime=${completedAt.ms.toFixed(1)}ms status=${completedAt.status}`);
  });

  test('determinism: two independent runs at the completing tier produce an identical result', () => {
    const run1 = runAtTier(SCENARIOS.C, 1000000);
    const run2 = runAtTier(SCENARIOS.C, 1000000);
    assert.notEqual(statusOf(run1.result), 'SEARCH_INCOMPLETE', 'precondition: C must complete at tier 1,000,000');
    assert.equal(statusOf(run1.result), statusOf(run2.result));
    assert.equal(run1.result.candidateCount, run2.result.candidateCount);
    assert.equal(run1.result.candidate.allocationSignature, run2.result.candidate.allocationSignature);
    assert.deepEqual(run1.result.candidate, run2.result.candidate);
    assert.equal(run1.diagnostics.visitedNodes, run2.diagnostics.visitedNodes);
    assert.equal(run1.diagnostics.completedCandidates, run2.diagnostics.completedCandidates);
    assert.equal(run1.diagnostics.prunedByChemistry, run2.diagnostics.prunedByChemistry);
    assert.equal(run1.diagnostics.prunedByRanking, run2.diagnostics.prunedByRanking);
  });

  // V3.0 Phase 7A UPDATE: production's own hybrid dispatcher now resolves C
  // exactly via the hard-case (prefix-lock + MITM) engine -- the
  // group-level Branch-and-Bound engine alone still cannot (unchanged, per
  // this file's own budget-sweep findings above), but it is no longer the
  // only engine production runs. Kept as the historical "before" baseline
  // this same production entry point now improves on (this task's own
  // Section 11).
  test('production (via the hard-case dispatcher) now completes C exactly, where the group-level engine alone still could not', () => {
    const production = findBlendRecommendationsWithDiagnostics({ targetNi: TARGET_NI, tolerance: TOLERANCE, sources: SCENARIOS.C });
    assert.equal(statusOf(production.result), 'OK');
    assert.equal(production.result.solverPath, 'HARDCASE_MITM');
  });
});

// ============================================================
// D -- 10 dome / 3 Contractor / 100 DT
// ============================================================
describe('V3.0 Phase 6G -- D budget sweep: 10 dome / 3 Contractor / 100 DT', () => {
  test('sweep does NOT complete by 5,000,000 nodes -- stop and report (no 10M+ attempt)', () => {
    const { rows, completedAt } = sweep('D', SCENARIOS.D);
    assert.equal(rows.length, BUDGET_TIERS.length, 'D: expected the full 500k/1M/2M/5M sweep to run (never completes early)');
    rows.forEach((row) => {
      assert.equal(row.status, 'SEARCH_INCOMPLETE', `D: tier ${row.tier} unexpectedly completed`);
      assert.equal(row.diagnostics.visitedNodes, row.tier);
    });
    assert.equal(completedAt, null, 'D: must not complete at any tier up to 5,000,000');
    const last = rows[rows.length - 1];
    // eslint-disable-next-line no-console
    console.log(`[v3-phase6g] D DOES NOT COMPLETE <=5,000,000: visitedNodes=${last.diagnostics.visitedNodes} completedCandidates=${last.diagnostics.completedCandidates} prunedByChemistry=${last.diagnostics.prunedByChemistry} prunedByRanking=${last.diagnostics.prunedByRanking} runtime=${last.ms.toFixed(1)}ms status=${last.status}`);
  });
});

// ============================================================
// E -- 10 dome / 2 Contractor / 100 DT concentrated. Same sweep, run only
// because runtime at each tier stayed well under a minute (measured: ~4s/
// ~9s/~18s/~52s at 500k/1M/2M/5M respectively, roughly linear in node
// count) -- reasonable to run to completion or the 5M ceiling either way.
// ============================================================
describe('V3.0 Phase 6G -- E budget sweep: 10 dome / 2 Contractor / 100 DT concentrated', () => {
  test('sweep does NOT complete by 5,000,000 nodes -- eliminating the eager 20k-per-Contractor gate alone is not enough to make E tractable', () => {
    const { rows, completedAt } = sweep('E', SCENARIOS.E);
    assert.equal(rows.length, BUDGET_TIERS.length, 'E: expected the full 500k/1M/2M/5M sweep to run (never completes early)');
    rows.forEach((row) => {
      assert.equal(row.status, 'SEARCH_INCOMPLETE', `E: tier ${row.tier} unexpectedly completed`);
      assert.equal(row.diagnostics.visitedNodes, row.tier);
    });
    assert.equal(completedAt, null, 'E: must not complete at any tier up to 5,000,000');
    const last = rows[rows.length - 1];
    // eslint-disable-next-line no-console
    console.log(`[v3-phase6g] E DOES NOT COMPLETE <=5,000,000: visitedNodes=${last.diagnostics.visitedNodes} completedCandidates=${last.diagnostics.completedCandidates} prunedByChemistry=${last.diagnostics.prunedByChemistry} prunedByRanking=${last.diagnostics.prunedByRanking} runtime=${last.ms.toFixed(1)}ms status=${last.status}`);
  });
});

// ============================================================
// WORK-UNIT COMPARISON (Section 5) -- group-level (production) vs
// source-level (this prototype) cost per VISITED node, for the two
// scenarios where BOTH complete (A/B). Node counts differ between the two
// searches (different granularity/traversal), so this reports wall-clock
// cost per each engine's OWN node, never a claim that the node types are
// equivalent or directly interchangeable (this task's own "do not claim
// these node types are equivalent").
// ============================================================
describe('V3.0 Phase 6G -- work-unit comparison: group-level (production) vs source-level (lazy) cost per visited node', () => {
  ['A', 'B'].forEach((name) => {
    test(`${name}: both engines complete -- report visitedNodes/runtime/us-per-node for each`, () => {
      const input = { targetNi: TARGET_NI, tolerance: TOLERANCE, sources: SCENARIOS[name] };

      // One warmup call each (JIT), then the measured call -- matches this
      // task's own emphasis on REPORTING real numbers, not synthetic ones.
      findBlendRecommendationsWithDiagnostics(input);
      findBlendRecommendationsSourceLazyCoupledBudgeted(input);

      const t0 = process.hrtime.bigint();
      const production = findBlendRecommendationsWithDiagnostics(input);
      const t1 = process.hrtime.bigint();
      const lazy = findBlendRecommendationsSourceLazyCoupledBudgeted(input);
      const t2 = process.hrtime.bigint();

      const prodMs = Number(t1 - t0) / 1e6;
      const lazyMs = Number(t2 - t1) / 1e6;
      const prodUsPerNode = (prodMs * 1000) / production.diagnostics.visitedNodes;
      const lazyUsPerNode = (lazyMs * 1000) / lazy.diagnostics.visitedNodes;

      assert.equal(statusOf(production.result), 'OK');
      assert.equal(statusOf(lazy.result), 'OK');

      // eslint-disable-next-line no-console
      console.log([
        `[v3-phase6g] ${name} WORK-UNIT COMPARISON`,
        `  PRODUCTION (group-level)  visitedNodes=${production.diagnostics.visitedNodes} runtime=${prodMs.toFixed(2)}ms us/node=${prodUsPerNode.toFixed(3)}`,
        `  SOURCE-LAZY (source-level) visitedNodes=${lazy.diagnostics.visitedNodes} runtime=${lazyMs.toFixed(2)}ms us/node=${lazyUsPerNode.toFixed(3)}`,
      ].join('\n'));
    });
  });
});
