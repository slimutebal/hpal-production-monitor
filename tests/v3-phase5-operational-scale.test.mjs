// V3.0 Phase 5 -- Operational Scale Validation (docs/
// V3.0_SCALABLE_RECOMMENDATION_ENGINE_ARCHITECTURE.md Phase 45).
//
// MEASUREMENT ONLY -- no algorithm change. This file exercises the REAL,
// gated production API (findBlendRecommendations() /
// findBlendRecommendationsWithDiagnostics(), never a bypass helper) at the
// Owner's real target scale (up to 10 dome / 7 Contractor / 100+ DT) and
// reports what actually happens: per-Contractor operational allocation
// counts, theoretical candidateCount, visitedNodes, completedCandidates,
// prunedByRanking, prunedByChemistry, runtime, and final status. It does
// NOT raise MAX_SEARCH_NODES (500,000) or MAX_ALLOCATIONS_PER_CONTRACTOR
// (20,000) -- if a scenario hits either limit, that is the honest result
// this file exists to surface, not a bug to work around here.
//
// EXACTNESS: for the one scenario (F) small enough for the Phase 3 unpruned
// reference to itself finish inside MAX_SEARCH_NODES, this file asserts
// byte-for-byte equality against findBlendRecommendationsStreamingUnpruned()
// (never a hand-derived "expected winner"). Every other scenario here
// (A-E) has a theoretical candidateCount far beyond what an UNPRUNED
// traversal could finish within the same node budget (the unpruned
// reference shares MAX_SEARCH_NODES too -- see blending-recommendation.js's
// forEachCandidatePruned()), so no unpruned reference run is attempted for
// them; per this task's own instruction, no expected winner is invented for
// those. Instead, each large scenario is run TWICE and asserted identical
// on status/candidateCount/winning allocationSignature/diagnostics --
// proving determinism, which is the only exactness property available
// stand-alone software (without a second implementation) can verify for
// input at this scale.
//
// Run with Node's built-in test runner:
//
//   node --test tests/v3-phase5-operational-scale.test.mjs
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  findBlendRecommendations,
  findBlendRecommendationsWithDiagnostics,
  findBlendRecommendationsStreamingUnpruned,
  MAX_SEARCH_NODES,
} from '../js/pages/calculate/blending-recommendation.js';
import {
  countOperationalAllocations,
  groupSourcesByContractor,
  MAX_ALLOCATIONS_PER_CONTRACTOR,
} from '../js/pages/calculate/fleet-allocation.js';
import { canonicalizeRecommendationResult, firstCanonicalDifference } from './reference/canonical-recommendation-result.mjs';

// domesPerContractor: e.g. [2,2,2,1,1] -- one entry per Contractor, giving
// how many domes (sources) that Contractor operates. dtPerDome: total DT
// for a Contractor with k domes is k*dtPerDome (deterministic, no
// randomness -- this task's "deterministic representative scenarios").
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

// Exact per-Contractor operational allocation counts + theoretical global
// candidateCount, computed the SAME way production's own prepareSearch()
// gate does (fleet-allocation.js's countOperationalAllocations() per
// group) -- this reporting never invents its own count. BigInt so the
// product never silently overflows/loses precision at billions of
// candidates.
function describeSearchSpace(sources) {
  const grouped = groupSourcesByContractor(
    sources.map((s) => ({ pileId: s.pileId, contractor: s.contractor, assignedUnits: Number(s.units) })),
  );
  const perContractor = grouped.map((group) => {
    const fleet = group.sources.reduce((sum, s) => sum + s.assignedUnits, 0);
    const sourceCount = group.sources.length;
    const count = countOperationalAllocations(fleet, sourceCount);
    return { contractor: group.contractorKey, fleet, sourceCount, count };
  });
  const theoreticalGlobal = perContractor.reduce((product, g) => product * BigInt(g.count), 1n);
  return { perContractor, theoreticalGlobal };
}

function classifyRuntime(ms) {
  if (ms < 500) return '<500ms';
  if (ms < 1000) return '500ms-1s';
  if (ms < 2000) return '1-2s';
  if (ms < 3000) return '2-3s';
  return '>3s';
}

function runOnce(input) {
  const start = process.hrtime.bigint();
  const { result, diagnostics } = findBlendRecommendationsWithDiagnostics(input);
  const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6;
  return { result, diagnostics, elapsedMs };
}

function statusOf(result) {
  return result.ok ? result.status : result.error;
}

// Determinism proof for a single scenario run twice (this task's NODE
// BUDGET / EXACTNESS sections) -- the only exactness property verifiable
// stand-alone at a scale where no independent reference implementation can
// finish.
function assertIdenticalRuns(name, run1, run2) {
  assert.equal(statusOf(run1.result), statusOf(run2.result), `${name}: status changed between runs`);
  assert.equal(run1.result.candidateCount, run2.result.candidateCount, `${name}: candidateCount changed between runs`);
  const sig1 = run1.result.candidate ? run1.result.candidate.allocationSignature : null;
  const sig2 = run2.result.candidate ? run2.result.candidate.allocationSignature : null;
  assert.equal(sig1, sig2, `${name}: winning allocationSignature changed between runs`);
  assert.deepEqual(run1.diagnostics, run2.diagnostics, `${name}: diagnostics changed between runs`);
}

function reportBenchmark(name, sources, targetNi = '1.15', tolerance = '0.05') {
  const input = { targetNi, tolerance, sources };
  const space = describeSearchSpace(sources);
  const gatedContractor = space.perContractor.find((g) => g.count > MAX_ALLOCATIONS_PER_CONTRACTOR);

  const run1 = runOnce(input);
  const run2 = runOnce(input);
  assertIdenticalRuns(name, run1, run2);

  const { result, diagnostics, elapsedMs } = run1;
  const budgetStatus = diagnostics === null
    ? 'n/a (rejected before search -- 20k per-Contractor gate)'
    : diagnostics.incomplete
      ? `EXHAUSTED (${diagnostics.visitedNodes}/${MAX_SEARCH_NODES})`
      : `within budget (${diagnostics.visitedNodes}/${MAX_SEARCH_NODES})`;

  // eslint-disable-next-line no-console
  console.log([
    `[v3-phase5] BENCHMARK ${name}`,
    `  per-Contractor allocation counts : ${space.perContractor.map((g) => `${g.contractor}(F=${g.fleet},n=${g.sourceCount})=${g.count}`).join(', ')}`,
    `  20k per-Contractor gate          : ${gatedContractor ? `HIT (${gatedContractor.contractor} count=${gatedContractor.count} > ${MAX_ALLOCATIONS_PER_CONTRACTOR})` : 'clear'}`,
    `  theoretical candidateCount       : ${space.theoreticalGlobal.toString()}`,
    `  reported candidateCount          : ${result.ok ? result.candidateCount : (result.candidateCount ?? 'n/a (gate-rejected)')}`,
    `  visitedNodes                     : ${diagnostics ? diagnostics.visitedNodes : 'n/a'}`,
    `  completedCandidates              : ${diagnostics ? diagnostics.completedCandidates : 'n/a'}`,
    `  prunedByChemistry                : ${diagnostics ? diagnostics.prunedByChemistry : 'n/a'}`,
    `  prunedByRanking                  : ${diagnostics ? diagnostics.prunedByRanking : 'n/a'}`,
    `  node budget status               : ${budgetStatus}`,
    `  runtime (ms)                     : ${elapsedMs.toFixed(2)} [${classifyRuntime(elapsedMs)}]`,
    `  final status                     : ${statusOf(result)}`,
    `  determinism (2 runs)             : IDENTICAL (status/candidateCount/allocationSignature/diagnostics)`,
  ].join('\n'));

  return { name, space, gatedContractor, result, diagnostics, elapsedMs };
}

describe('V3.0 Phase 5 -- Operational Scale Validation (real findBlendRecommendations()/findBlendRecommendationsWithDiagnostics(), MAX_SEARCH_NODES=500000 unchanged)', () => {
  test('sanity: node budget and per-Contractor gate constants unchanged by this phase', () => {
    assert.equal(MAX_SEARCH_NODES, 500000);
    assert.equal(MAX_ALLOCATIONS_PER_CONTRACTOR, 20000);
  });

  // A. 8 dome / 5 Contractor / 80 DT -- domes [2,2,2,1,1], 10 DT/dome.
  test('A. 8 dome / 5 Contractor / 80 DT', () => {
    const sources = buildScenarioSources([2, 2, 2, 1, 1], 10);
    const { result, gatedContractor } = reportBenchmark('A (8 dome / 5 Contractor / 80 DT)', sources);
    assert.equal(gatedContractor, undefined, 'A must not hit the 20k per-Contractor gate (each group F<=20,n<=2)');
    assert.ok(['OK', 'TARGET_NOT_ACHIEVABLE', 'SEARCH_INCOMPLETE'].includes(statusOf(result)));
  });

  // B. 10 dome / 7 Contractor / 100 DT balanced -- domes [2,2,2,1,1,1,1],
  // 10 DT/dome (3 Contractors x 2 domes @20DT, 4 Contractors x 1 dome
  // @10DT -- this task's own "balanced" shape).
  test('B. 10 dome / 7 Contractor / 100 DT -- balanced', () => {
    const sources = buildScenarioSources([2, 2, 2, 1, 1, 1, 1], 10);
    const { result, gatedContractor } = reportBenchmark('B (10 dome / 7 Contractor / 100 DT, balanced)', sources);
    assert.equal(gatedContractor, undefined, 'B must not hit the 20k per-Contractor gate (each group F<=20,n<=2)');
    assert.ok(['OK', 'TARGET_NOT_ACHIEVABLE', 'SEARCH_INCOMPLETE'].includes(statusOf(result)));
  });

  // C. 10 dome / 5 Contractor / 100 DT -- domes [2,2,2,2,2], 10 DT/dome
  // (every Contractor identically sized, F=20/n=2 -- the most symmetric
  // 5-Contractor split of 10 domes).
  test('C. 10 dome / 5 Contractor / 100 DT', () => {
    const sources = buildScenarioSources([2, 2, 2, 2, 2], 10);
    const { result, gatedContractor } = reportBenchmark('C (10 dome / 5 Contractor / 100 DT)', sources);
    assert.equal(gatedContractor, undefined, 'C must not hit the 20k per-Contractor gate (each group F=20,n=2)');
    assert.ok(['OK', 'TARGET_NOT_ACHIEVABLE', 'SEARCH_INCOMPLETE'].includes(statusOf(result)));
  });

  // D. 10 dome / 3 Contractor / 100 DT -- domes [4,3,3], 10 DT/dome (most
  // balanced 3-way split of 10 domes: one Contractor runs 4 domes/40 DT,
  // two run 3 domes/30 DT each -- each group individually clears the 20k
  // per-Contractor gate, F=40/n=4 -> 16,796; F=30/n=3 -> 1,101).
  test('D. 10 dome / 3 Contractor / 100 DT', () => {
    const sources = buildScenarioSources([4, 3, 3], 10);
    const { result, gatedContractor } = reportBenchmark('D (10 dome / 3 Contractor / 100 DT)', sources);
    assert.equal(gatedContractor, undefined, 'D must not hit the 20k per-Contractor gate (largest group F=40,n=4 -> 16,796)');
    assert.ok(['OK', 'TARGET_NOT_ACHIEVABLE', 'SEARCH_INCOMPLETE'].includes(statusOf(result)));
  });

  // E. concentrated difficult case: 10 dome / 2 Contractor / 100 DT --
  // domes [5,5], 10 DT/dome. Each group's own operational allocation count
  // (F=50,n=5 -> 263,631) individually EXCEEDS MAX_ALLOCATIONS_PER_CONTRACTOR
  // (20,000) -- this is the scenario this task's "PER-CONTRACTOR 20K GATE"
  // section originally asked this file to specifically identify as a
  // GENERATION-time rejection. V3.0 Phase 7A UPDATE: the normal engine's
  // own per-Contractor gate still rejects it exactly as before (that gate
  // is unchanged -- fleet-allocation.js's own MAX_ALLOCATIONS_PER_CONTRACTOR
  // comment), but findBlendRecommendations() no longer surfaces that as a
  // hard failure -- the hybrid dispatcher routes it to the hard-case
  // (prefix-lock + MITM) engine instead, which needs no eager
  // per-Contractor array and solves it exactly (this task's own Section 5:
  // "Scenario E must reach the MITM path without
  // MAX_ALLOCATIONS_PER_CONTRACTOR=20000 blocking it").
  test('E. 10 dome / 2 Contractor / 100 DT -- concentrated, clears the 20k per-Contractor gate via the hard-case engine', () => {
    const sources = buildScenarioSources([5, 5], 10);
    const { result, gatedContractor, diagnostics } = reportBenchmark('E (10 dome / 2 Contractor / 100 DT, concentrated)', sources);
    assert.ok(gatedContractor, 'E is specifically designed so BOTH Contractor groups (F=50,n=5 -> 263,631) individually exceed the 20k gate');
    assert.equal(result.ok, true);
    assert.equal(result.status, 'OK');
    assert.equal(result.solverPath, 'HARDCASE_MITM');
    assert.ok(diagnostics, 'the hard-case engine reports its own diagnostics (prefixLockNode/mitmActivated/etc.), never null');
    assert.equal(diagnostics.mitmActivated, true, 'E requires the MITM funnel (the A+B lock is provably reachable for this shape)');
  });

  // F. single-Contractor concentration, deliberately pushed close to (but
  // under) the 20k per-Contractor gate WITHOUT exceeding it: 1 Contractor,
  // 3 domes, 20 DT/dome (F=60,n=3 -> 18,031 operational allocations,
  // ~90.2% of the 20,000 gate) -- this is the scenario this task's "SAFE
  // 20K CONCENTRATION" requirement asks for. Being a SINGLE Contractor
  // group, there is no cross-Contractor combination at all, so its
  // theoretical candidateCount (18,030, excluding the all-zero allocation)
  // is small enough that the Phase 3 UNPRUNED reference itself finishes
  // well inside MAX_SEARCH_NODES -- the one scenario in this file where an
  // exact byte-for-byte equality check against a second implementation
  // (rather than only determinism) is possible, per this task's EXACTNESS
  // requirement.
  test('F. 1 Contractor / 3 dome / 60 DT -- concentrated, safely under the 20k per-Contractor gate; exact match against Phase 3 unpruned reference', () => {
    const sources = buildScenarioSources([3], 20);
    const input = { targetNi: '1.15', tolerance: '0.05', sources };
    const { result, gatedContractor } = reportBenchmark('F (1 Contractor / 3 dome / 60 DT)', sources, input.targetNi, input.tolerance);
    assert.equal(gatedContractor, undefined, 'F must stay under the 20k per-Contractor gate by design (F=60,n=3 -> 18,031)');
    assert.equal(result.ok, true);
    assert.equal(result.status, 'OK');
    assert.equal(result.candidateCount, 18030);

    const unpruned = findBlendRecommendationsStreamingUnpruned(input);
    const diff = firstCanonicalDifference(canonicalizeRecommendationResult(unpruned), canonicalizeRecommendationResult(result));
    assert.equal(diff, null, `F: production diverged from Phase 3 unpruned reference: ${diff}`);
  });
});
