// V3.0 Phase 4C -- exact ranking-prefix pruning (docs/
// V3.0_SCALABLE_RECOMMENDATION_ENGINE_ARCHITECTURE.md Section 20's
// compareWithinTolerance rule chain; this task's "EXACT LEXICOGRAPHIC
// RANKING PRUNING").
//
// blending-recommendation.js's forEachCandidatePruned() now checks a
// SECOND, independent exact pruning condition once a within-tolerance
// incumbent exists: even the most favorable possible completion of a
// branch (rules A-E of compareWithinTolerance, optimized independently per
// rule -- see conservativeRankingBound()'s own proof comment) cannot
// outrank the incumbent. This file:
//
//   1. PROOF -- for randomized small partial branches, independently
//      re-derives the fixed/open bound (never importing production's own
//      pooling helpers) and, whenever boundCannotBeatIncumbent() says a
//      branch is prunable, exhaustively enumerates every feasible
//      completion of that branch and verifies NONE of them beats the
//      incumbent under the REAL compareWithinTolerance comparator.
//   2. EXACTNESS -- Phase 4C (production) vs Phase 3 (unpruned reference)
//      over many scenarios: status/candidate/candidateCount must be
//      byte-identical.
//   3. BENCHMARKS -- Phase 4B (chemistry-only) vs Phase 4C (chemistry +
//      ranking) on four scenarios, reporting completedCandidates reduction.
//
// Run with Node's built-in test runner:
//
//   node --test tests/v3-phase4c-ranking-bound.test.mjs
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  findBlendRecommendations,
  findBlendRecommendationsStreamingUnpruned,
  findBlendRecommendationsWithDiagnostics,
  findBlendRecommendationsMaterialized,
  prepareSearchUnbounded,
  runSearchDirect,
  buildCandidate,
  conservativeRankingBound,
  boundCannotBeatIncumbent,
  incumbentRankingMetrics,
} from '../js/pages/calculate/blending-recommendation.js';
import { compareWithinTolerance } from '../js/pages/calculate/recommendation-ranking.js';
import { enumerateOperationalAllocations, countOperationalAllocations } from '../js/pages/calculate/fleet-allocation.js';
import { normalizeSourceIdentity } from '../js/pages/calculate/calculate-validation.js';
import { CRITICAL_STANDBY_RATIO, MINOR_STANDBY_RATIO } from '../js/pages/calculate/operational-continuity.js';
import { mulberry32, randInt, pick, NAMED_SEEDS } from './reference/seeded-random.mjs';
import { generateScenario } from './reference/v3-scenario-generator.mjs';
import { canonicalizeRecommendationResult, firstCanonicalDifference } from './reference/canonical-recommendation-result.mjs';

// ============================================================
// SHARED TEST-LOCAL (INDEPENDENT) REIMPLEMENTATION of the per-allocation
// rank metrics and their per-group/pooled aggregation -- deliberately NOT
// imported from production (mirrors tests/v3-phase4b-chemistry-bound.test.mjs's
// own pooledOpenBound() philosophy: reimplement the simple pooling
// independently so the proof does not validate production against itself).
// ============================================================
function localAllocationMetrics(group, allocation, fleet) {
  let activeUnits = 0;
  let fullyUnusedCount = 0;
  allocation.forEach((v, i) => {
    activeUnits += v;
    if (group.sources[i].assignedUnits > 0 && v === 0) fullyUnusedCount += 1;
  });
  const standbyRatio = fleet > 0 ? (fleet - activeUnits) / fleet : 0;
  return {
    activeUnits,
    standbyRatio,
    isCritical: standbyRatio >= CRITICAL_STANDBY_RATIO,
    requiresMitigation: standbyRatio > MINOR_STANDBY_RATIO,
    fullyUnusedCount,
  };
}

function groupFleetOf(group) {
  return group.sources.reduce((sum, s) => sum + s.assignedUnits, 0);
}

function computeFixedMetrics(groups, prefixAllocations) {
  let criticalCount = 0;
  let activeUnits = 0;
  let worstRatio = 0;
  let mitigationCount = 0;
  let fullyUnusedCount = 0;
  groups.forEach((group, i) => {
    const m = localAllocationMetrics(group, prefixAllocations[i], groupFleetOf(group));
    criticalCount += m.isCritical ? 1 : 0;
    activeUnits += m.activeUnits;
    worstRatio = Math.max(worstRatio, m.standbyRatio);
    mitigationCount += m.requiresMitigation ? 1 : 0;
    fullyUnusedCount += m.fullyUnusedCount;
  });
  return { criticalCount, activeUnits, worstRatio, mitigationCount, fullyUnusedCount };
}

function computeOpenBound(openGroups, openAllocationsPerGroup) {
  let minCriticalCount = 0;
  let maxActiveUnits = 0;
  let minWorstRatio = 0;
  let minMitigationCount = 0;
  let minFullyUnusedCount = 0;
  openGroups.forEach((group, i) => {
    const fleet = groupFleetOf(group);
    let groupMaxActive = 0;
    let groupMinRatio = Infinity;
    let groupMinCritical = 1;
    let groupMinMitigation = 1;
    let groupMinUnused = Infinity;
    openAllocationsPerGroup[i].forEach((allocation) => {
      const m = localAllocationMetrics(group, allocation, fleet);
      if (m.activeUnits > groupMaxActive) groupMaxActive = m.activeUnits;
      if (m.standbyRatio < groupMinRatio) groupMinRatio = m.standbyRatio;
      if (!m.isCritical) groupMinCritical = 0;
      if (!m.requiresMitigation) groupMinMitigation = 0;
      if (m.fullyUnusedCount < groupMinUnused) groupMinUnused = m.fullyUnusedCount;
    });
    minCriticalCount += groupMinCritical;
    maxActiveUnits += groupMaxActive;
    minWorstRatio = Math.max(minWorstRatio, groupMinRatio);
    minMitigationCount += groupMinMitigation;
    minFullyUnusedCount += groupMinUnused;
  });
  return { minCriticalCount, maxActiveUnits, minWorstRatio, minMitigationCount, minFullyUnusedCount };
}

function everyCombination(arraysOfArrays) {
  const results = [];
  function combine(idx, acc) {
    if (idx === arraysOfArrays.length) {
      results.push(acc.slice());
      return;
    }
    for (const item of arraysOfArrays[idx]) {
      acc.push(item);
      combine(idx + 1, acc);
      acc.pop();
    }
  }
  combine(0, []);
  return results;
}

function buildActiveMap(groups, chosenPerGroup) {
  const map = new Map();
  groups.forEach((group, i) => {
    group.sources.forEach((s, si) => {
      map.set(normalizeSourceIdentity(s.pileId, s.contractor), chosenPerGroup[i][si]);
    });
  });
  return map;
}

// ============================================================
// 1. PROOF -- randomized partial branches, exhaustive completion check
// (this task's Section 7).
// ============================================================
const proofStats = { partialStatesChecked: 0, prunablePartialStates: 0, completionsChecked: 0, violations: 0 };

// Shared proof procedure (used by both the generic small-scenario pass
// below and the directed pass further down): for scenario `input`, walk
// every prefix depth k, draw one random fixed-prefix allocation per
// prefix group (a "partial branch" is one specific node -- one specific
// choice per decided group, matching what the real traversal visits, not
// every possible prefix), independently rederive the bound, and whenever
// it claims the branch is prunable, exhaustively verify no completion of
// the OPEN suffix beats the real, exhaustively-vetted global incumbent
// under the REAL compareWithinTolerance comparator. Mutates `stats`.
function proveBranchPruningForScenario(input, rng, label, stats) {
  const prepared = prepareSearchUnbounded(input);
  if (!prepared.ok) return; // INVALID_INPUT for this generated shape -- nothing to test here.
  const { groups, perContractorAllocations, targetNiValue, toleranceValue } = prepared;

  // Real, exhaustively-vetted incumbent for the WHOLE scenario -- the
  // toughest possible incumbent to test pruning against (see this file's
  // header for why using the true global winner, not just some
  // intermediate streaming incumbent, is a stronger and still fully valid
  // test of the bound's correctness).
  const materialized = findBlendRecommendationsMaterialized(input);
  if (!materialized.ok || materialized.status !== 'OK') return; // no within-tolerance incumbent to prune against.
  const incumbent = materialized.candidate;
  const incumbentMetrics = incumbentRankingMetrics(incumbent);

  for (let k = 0; k < groups.length; k += 1) {
    const prefixAllocations = groups.slice(0, k).map((g, gi) => {
      const options = perContractorAllocations[gi];
      return options[randInt(rng, 0, options.length - 1)];
    });
    const openGroups = groups.slice(k);
    const openAllocationsPerGroup = openGroups.map((g) => enumerateOperationalAllocations(groupFleetOf(g), g.sources.length));

    const totalCompletions = openAllocationsPerGroup.reduce((prod, a) => prod * a.length, 1);
    if (totalCompletions > 4000) continue; // keep this proof pass fast; other cases/seeds/depths still cover small shapes.

    const fixed = computeFixedMetrics(groups.slice(0, k), prefixAllocations);
    const openBound = computeOpenBound(openGroups, openAllocationsPerGroup);
    const bound = conservativeRankingBound(fixed, openBound);
    const prunable = boundCannotBeatIncumbent(bound, incumbentMetrics);

    stats.partialStatesChecked += 1;
    if (!prunable) continue;
    stats.prunablePartialStates += 1;

    const completions = everyCombination(openAllocationsPerGroup);
    completions.forEach((completionAllocations) => {
      const chosenPerGroup = [...prefixAllocations, ...completionAllocations];
      const activeMap = buildActiveMap(groups, chosenPerGroup);
      const candidate = buildCandidate(groups, activeMap, targetNiValue, toleranceValue);
      stats.completionsChecked += 1;
      if (!candidate || !candidate.withinTolerance) return; // pruning only ever claims "cannot win among within-tolerance candidates".
      if (compareWithinTolerance(candidate, incumbent) < 0) {
        stats.violations += 1;
      }
      assert.ok(
        compareWithinTolerance(candidate, incumbent) >= 0,
        `${label} k=${k}: a completion of a branch marked prunable actually BEAT the incumbent under compareWithinTolerance -- bound is unsound`,
      );
    });
  }
}

describe('V3.0 Phase 4C ranking-prefix bound -- exhaustive proof over randomized partial branches', () => {
  Object.entries(NAMED_SEEDS).forEach(([seedName, seed]) => {
    describe(`seed ${seedName} (0x${seed.toString(16)})`, () => {
      const rng = mulberry32(seed);
      const CASES_PER_SEED = 30;

      for (let i = 0; i < CASES_PER_SEED; i += 1) {
        const scenario = generateScenario(rng, i);

        test(`case #${i} (${scenario.kind}): every branch the bound says is prunable is verified unbeatable over ALL completions`, () => {
          proveBranchPruningForScenario(scenario.input, rng, scenario.name, proofStats);
        });
      }
    });
  });

  after(() => {
    // eslint-disable-next-line no-console
    console.log(`[v3-phase4c-ranking-bound] proof coverage (generic small scenarios): ${proofStats.partialStatesChecked} partial states checked, ${proofStats.prunablePartialStates} marked prunable, ${proofStats.completionsChecked} completions verified, ${proofStats.violations} violations (any violation would have thrown above)`);
  });
});

// ============================================================
// 1b. DIRECTED PROOF, BIASED TOWARD SHAPES WHERE RANKING PRUNING ACTUALLY
// FIRES -- tests/reference/v3-scenario-generator.mjs's small scenarios are
// mostly single-Contractor (so there is rarely more than one group left
// open to prune), and its jittered targets often land outside tolerance
// entirely -- both of which make "marked prunable" vanishingly rare there
// (see the 0-prunable proof-coverage line the generic pass above prints).
// This mirrors tests/v3-phase4b-chemistry-bound.test.mjs's own precedent
// (a dedicated bias pass complementing uniform-random coverage): 2-3
// Contractors, each with 2 domes whose Ni straddles an EXACTLY achievable
// target (so a full-utilization within-tolerance incumbent is essentially
// guaranteed), which is exactly the "IMPORTANT EXAMPLE" shape this task's
// Section 2 describes.
// ============================================================
function buildDirectedAchievableScenario(rng) {
  const niHigh = 1.30;
  const niLow = 1.00;
  const contractorCount = pick(rng, [2, 3]);
  const fleetPerSource = pick(rng, [6, 9, 12, 15]);
  const sources = [];
  for (let c = 0; c < contractorCount; c += 1) {
    for (let s = 0; s < 2; s += 1) {
      sources.push({
        pileId: `C${c}-S${s}`,
        contractor: `Contractor${c}`,
        ni: s % 2 === 0 ? String(niHigh) : String(niLow),
        units: String(fleetPerSource),
        tonnesPerUnit: '50',
      });
    }
  }
  // Every Contractor shares the identical two-Ni composition, so full
  // utilization of ANY subset already averages to exactly (niHigh+niLow)/2
  // -- the target is exactly reachable, not just approximately.
  const targetNi = (niHigh + niLow) / 2;
  const tolerance = pick(rng, [0.01, 0.02]);
  return { targetNi: String(targetNi), tolerance: String(tolerance), sources };
}

const directedProofStats = { partialStatesChecked: 0, prunablePartialStates: 0, completionsChecked: 0, violations: 0 };

describe('V3.0 Phase 4C ranking-prefix bound -- directed proof biased toward achievable multi-Contractor targets', () => {
  Object.entries(NAMED_SEEDS).forEach(([seedName, seed]) => {
    describe(`seed ${seedName} (0x${seed.toString(16)})`, () => {
      const rng = mulberry32(seed);
      const CASES_PER_SEED = 15;

      for (let i = 0; i < CASES_PER_SEED; i += 1) {
        test(`directed case #${i}: every branch the bound says is prunable is verified unbeatable over ALL completions`, () => {
          const input = buildDirectedAchievableScenario(rng);
          proveBranchPruningForScenario(input, rng, `directed#${i}`, directedProofStats);
        });
      }
    });
  });

  after(() => {
    assert.ok(directedProofStats.prunablePartialStates > 0, 'expected the directed bias to actually produce at least one branch marked prunable -- otherwise this pass proves nothing beyond the generic one');
    // eslint-disable-next-line no-console
    console.log(`[v3-phase4c-ranking-bound] proof coverage (directed achievable-target scenarios): ${directedProofStats.partialStatesChecked} partial states checked, ${directedProofStats.prunablePartialStates} marked prunable, ${directedProofStats.completionsChecked} completions verified, ${directedProofStats.violations} violations (any violation would have thrown above)`);
  });
});

// ============================================================
// 2. EXACTNESS -- Phase 4C (production) vs Phase 3 (unpruned reference)
// over many directed+randomized scenarios (this task's Section 6).
// ============================================================
const diffStats = { compared: 0 };

function assertPhase3VsPhase4CEquivalent(input, label) {
  const unpruned = findBlendRecommendationsStreamingUnpruned(input);
  const pruned = findBlendRecommendations(input);
  const unprunedCanonical = canonicalizeRecommendationResult(unpruned);
  const prunedCanonical = canonicalizeRecommendationResult(pruned);

  assert.equal(unprunedCanonical.ok, prunedCanonical.ok, `${label}: ok mismatch`);
  if (!unprunedCanonical.ok) {
    assert.deepEqual(unprunedCanonical, prunedCanonical, `${label}: error-shape mismatch`);
    return;
  }
  assert.equal(unprunedCanonical.status, prunedCanonical.status, `${label}: status mismatch`);
  const diff = firstCanonicalDifference(unprunedCanonical, prunedCanonical);
  assert.equal(diff, null, `${label}: Phase 3 unpruned vs Phase 4C pruned diverged (candidateCount included): ${diff}`);
  assert.equal(prunedCanonical.candidateCount, unprunedCanonical.candidateCount, `${label}: candidateCount must be IDENTICAL regardless of pruning`);
}

describe('V3.0 Phase 4C vs Phase 3: winner identity AND candidateCount under composed chemistry+ranking pruning', () => {
  Object.entries(NAMED_SEEDS).forEach(([seedName, seed]) => {
    describe(`seed ${seedName} (0x${seed.toString(16)})`, () => {
      const rng = mulberry32(seed);
      const CASES_PER_SEED = 60;

      for (let i = 0; i < CASES_PER_SEED; i += 1) {
        const scenario = generateScenario(rng, i);
        test(`case #${i} (${scenario.kind}): Phase 4C pruned winner AND candidateCount are identical to Phase 3 unpruned`, () => {
          assertPhase3VsPhase4CEquivalent(scenario.input, scenario.name);
          diffStats.compared += 1;
        });
      }
    });
  });

  after(() => {
    // eslint-disable-next-line no-console
    console.log(`[v3-phase4c-ranking-bound] Phase3-vs-Phase4C totals: ${diffStats.compared} compared, 0 mismatches`);
  });
});

describe('V3.0 Phase 4C TARGET_NOT_ACHIEVABLE safety: ranking pruning never engages without a within-tolerance incumbent', () => {
  test('legacy 34/1-style case: prunedByRanking === 0, bestAttainable identical to Phase 3', () => {
    const input = {
      targetNi: '1.017142857',
      tolerance: '0.002',
      sources: [
        { pileId: 'L1', contractor: 'CTR-A', ni: '1.00', units: '34', tonnesPerUnit: '50' },
        { pileId: 'L2', contractor: 'CTR-A', ni: '1.60', units: '1', tonnesPerUnit: '50' },
      ],
    };
    const { result, diagnostics } = findBlendRecommendationsWithDiagnostics(input);
    assert.equal(result.ok, true);
    assert.equal(result.status, 'TARGET_NOT_ACHIEVABLE');
    assert.equal(diagnostics.prunedByRanking, 0, 'ranking pruning must never engage while no within-tolerance incumbent exists');
    assert.equal(diagnostics.prunedByChemistry, 0);
  });
});

// ============================================================
// 3. BENCHMARKS -- Phase 4B (chemistry-only) vs Phase 4C (chemistry +
// ranking), four scenarios (this task's Section 8).
// ============================================================
function buildScenarioA_4dome2contractor60dt() {
  const sources = [];
  for (let c = 0; c < 2; c += 1) {
    for (let s = 0; s < 2; s += 1) {
      sources.push({ pileId: `C${c}-S${s}`, contractor: `Contractor${c}`, ni: s % 2 === 0 ? '1.30' : '1.00', units: '15', tonnesPerUnit: '50' });
    }
  }
  return sources;
}

function buildScenarioB_6dome3contractor60dt() {
  const sources = [];
  for (let c = 0; c < 3; c += 1) {
    for (let s = 0; s < 2; s += 1) {
      sources.push({ pileId: `C${c}-S${s}`, contractor: `Contractor${c}`, ni: s % 2 === 0 ? '1.30' : '1.00', units: '10', tonnesPerUnit: '50' });
    }
  }
  return sources;
}

function buildScenarioC_chemistrySeparable() {
  // Same partitioned-grade shape as tests/v3-phase4a-branch-and-bound.test.mjs
  // and tests/v3-phase4b-chemistry-bound.test.mjs's Phase 4B chemistry-bound
  // demonstration -- non-overlapping per-Contractor Ni bands so chemistry
  // pruning alone is already effective.
  const GRADE_BANDS = [[0.85, 0.95], [1.10, 1.20], [1.60, 1.75]];
  const sources = [];
  for (let c = 0; c < 3; c += 1) {
    const [lowNi, highNi] = GRADE_BANDS[c];
    sources.push({ pileId: `C${c}-S0`, contractor: `Contractor${c}`, ni: String(lowNi), units: '10', tonnesPerUnit: '50' });
    sources.push({ pileId: `C${c}-S1`, contractor: `Contractor${c}`, ni: String(highNi), units: '10', tonnesPerUnit: '50' });
  }
  return { sources, targetNi: '1.15', tolerance: '0.005' };
}

function buildScenarioD_earlyFullUtilizationIncumbent() {
  // 2 Contractors x 2 domes x 15 DT = 60 DT total, IDENTICAL composition
  // per Contractor (this task's "IMPORTANT EXAMPLE"): full utilization of
  // BOTH Contractors' entire fleet lands exactly on target
  // ((1.30+1.00)/2 = 1.15), and Phase 4B's own search-ordering already
  // visits max-utilization allocations first -- so a criticalContractorCount=0,
  // totalActiveUnits=60 (the full physical fleet) incumbent is found almost
  // immediately. Every other branch that leaves ANY DT idle can then never
  // beat it on rule B alone, regardless of its own chemistry.
  const sources = [];
  for (let c = 0; c < 2; c += 1) {
    for (let s = 0; s < 2; s += 1) {
      sources.push({ pileId: `C${c}-S${s}`, contractor: `Contractor${c}`, ni: s % 2 === 0 ? '1.30' : '1.00', units: '15', tonnesPerUnit: '50' });
    }
  }
  return { sources, targetNi: '1.15', tolerance: '0.001' };
}

function runBoth(prepared) {
  const phase4b = runSearchDirect(prepared, true, false); // chemistry-only
  const phase4c = runSearchDirect(prepared, true, true); // chemistry + ranking
  return { phase4b, phase4c };
}

function reportComparison(name, rawOperationalSize, phase4b, phase4c, elapsed4bMs, elapsed4cMs) {
  const reduction = phase4b.diagnostics.completedCandidates > 0
    ? (100 * (1 - phase4c.diagnostics.completedCandidates / phase4b.diagnostics.completedCandidates)).toFixed(1)
    : '0.0';
  // eslint-disable-next-line no-console
  console.log([
    `[v3-phase4c-ranking-bound] BENCHMARK ${name}`,
    `  raw operational search size      : ${rawOperationalSize}`,
    `  candidateCount (search space)     : ${phase4c.result.ok ? phase4c.result.candidateCount : `(${phase4c.result.error})`}`,
    `  Phase4B (chemistry only)          : visitedNodes=${phase4b.diagnostics.visitedNodes} completedCandidates=${phase4b.diagnostics.completedCandidates} prunedByChemistry=${phase4b.diagnostics.prunedByChemistry} runtime=${elapsed4bMs.toFixed(2)}ms`,
    `  Phase4C (chemistry + ranking)     : visitedNodes=${phase4c.diagnostics.visitedNodes} completedCandidates=${phase4c.diagnostics.completedCandidates} prunedByChemistry=${phase4c.diagnostics.prunedByChemistry} prunedByRanking=${phase4c.diagnostics.prunedByRanking} runtime=${elapsed4cMs.toFixed(2)}ms`,
    `  completedCandidates reduction     : ${reduction}%`,
  ].join('\n'));
}

describe('V3.0 Phase 4C benchmarks -- Phase 4B (chemistry-only) vs Phase 4C (chemistry + ranking)', () => {
  test('A. 4 domes / 2 Contractors / 60 DT', () => {
    const sources = buildScenarioA_4dome2contractor60dt();
    const prepared = prepareSearchUnbounded({ targetNi: '1.15', tolerance: '0.05', sources });
    assert.equal(prepared.ok, true);
    const rawOperationalSize = countOperationalAllocations(30, 2) ** 2;

    const start4b = process.hrtime.bigint();
    const phase4b = runSearchDirect(prepared, true, false);
    const elapsed4bMs = Number(process.hrtime.bigint() - start4b) / 1e6;
    const start4c = process.hrtime.bigint();
    const phase4c = runSearchDirect(prepared, true, true);
    const elapsed4cMs = Number(process.hrtime.bigint() - start4c) / 1e6;

    assert.equal(phase4c.result.ok, true);
    assert.equal(phase4c.result.status, 'OK');
    assert.equal(phase4c.result.candidateCount, phase4b.result.candidateCount);
    reportComparison('A (4 dome / 2 Contractor / 60 DT)', rawOperationalSize, phase4b, phase4c, elapsed4bMs, elapsed4cMs);
  });

  test('B. 6 domes / 3 Contractors / 60 DT (V3.0 Phase 4D: now runs through the REAL gated production path)', () => {
    const sources = buildScenarioB_6dome3contractor60dt();
    // V3.0 Phase 4D PRODUCTION UNBLOCK: the removed MAX_GLOBAL_CANDIDATES
    // pre-gate no longer rejects this scenario outright -- the gated
    // production entry point itself now completes it exactly, well under
    // MAX_SEARCH_NODES (see tests/v3-phase4d-node-budget.test.mjs for the
    // dedicated diagnostics/benchmark coverage of this exact case).
    const gated = findBlendRecommendations({ targetNi: '1.15', tolerance: '0.05', sources });
    assert.equal(gated.ok, true);
    assert.equal(gated.status, 'OK');
    assert.equal(gated.candidateCount, 438975);

    const prepared = prepareSearchUnbounded({ targetNi: '1.15', tolerance: '0.05', sources });
    assert.equal(prepared.ok, true);
    const rawOperationalSize = countOperationalAllocations(20, 2) ** 3;

    const start4b = process.hrtime.bigint();
    const phase4b = runSearchDirect(prepared, true, false);
    const elapsed4bMs = Number(process.hrtime.bigint() - start4b) / 1e6;
    const start4c = process.hrtime.bigint();
    const phase4c = runSearchDirect(prepared, true, true);
    const elapsed4cMs = Number(process.hrtime.bigint() - start4c) / 1e6;

    assert.equal(phase4c.result.ok, true);
    assert.equal(phase4c.result.candidateCount, phase4b.result.candidateCount);
    reportComparison('B (6 dome / 3 Contractor / 60 DT)', rawOperationalSize, phase4b, phase4c, elapsed4bMs, elapsed4cMs);
  });

  test('C. Phase 4B chemistry-separable case (partitioned Ni bands)', () => {
    const { sources, targetNi, tolerance } = buildScenarioC_chemistrySeparable();
    const prepared = prepareSearchUnbounded({ targetNi, tolerance, sources });
    assert.equal(prepared.ok, true);
    const rawOperationalSize = countOperationalAllocations(20, 2) ** 3;

    const start4b = process.hrtime.bigint();
    const phase4b = runSearchDirect(prepared, true, false);
    const elapsed4bMs = Number(process.hrtime.bigint() - start4b) / 1e6;
    const start4c = process.hrtime.bigint();
    const phase4c = runSearchDirect(prepared, true, true);
    const elapsed4cMs = Number(process.hrtime.bigint() - start4c) / 1e6;

    assert.equal(phase4c.result.ok, true);
    assert.equal(phase4c.result.status, 'OK');
    assert.equal(phase4c.result.candidateCount, phase4b.result.candidateCount);
    const diff = firstCanonicalDifference(canonicalizeRecommendationResult(phase4b.result), canonicalizeRecommendationResult(phase4c.result));
    assert.equal(diff, null, `Phase 4B and Phase 4C winners diverged: ${diff}`);
    reportComparison('C (chemistry-separable, partitioned Ni bands)', rawOperationalSize, phase4b, phase4c, elapsed4bMs, elapsed4cMs);
  });

  test('D. early full-utilization within-tolerance incumbent -- ranking pruning should dominate', () => {
    const { sources, targetNi, tolerance } = buildScenarioD_earlyFullUtilizationIncumbent();
    const prepared = prepareSearchUnbounded({ targetNi, tolerance, sources });
    assert.equal(prepared.ok, true);
    const rawOperationalSize = countOperationalAllocations(30, 2) ** 2;

    const start4b = process.hrtime.bigint();
    const phase4b = runSearchDirect(prepared, true, false);
    const elapsed4bMs = Number(process.hrtime.bigint() - start4b) / 1e6;
    const start4c = process.hrtime.bigint();
    const phase4c = runSearchDirect(prepared, true, true);
    const elapsed4cMs = Number(process.hrtime.bigint() - start4c) / 1e6;

    assert.equal(phase4c.result.ok, true);
    assert.equal(phase4c.result.status, 'OK');
    assert.equal(phase4c.result.candidate.totalActiveUnits, 60, 'expected the full-fleet incumbent to win');
    assert.equal(phase4c.result.candidateCount, phase4b.result.candidateCount);
    const diff = firstCanonicalDifference(canonicalizeRecommendationResult(phase4b.result), canonicalizeRecommendationResult(phase4c.result));
    assert.equal(diff, null, `Phase 4B and Phase 4C winners diverged: ${diff}`);
    assert.ok(phase4c.diagnostics.prunedByRanking > 0, `expected ranking pruning to fire, got ${phase4c.diagnostics.prunedByRanking}`);
    assert.ok(
      phase4c.diagnostics.completedCandidates <= phase4b.diagnostics.completedCandidates,
      `expected Phase 4C to complete no more candidates than Phase 4B (4C=${phase4c.diagnostics.completedCandidates}, 4B=${phase4b.diagnostics.completedCandidates})`,
    );
    reportComparison('D (early full-utilization incumbent)', rawOperationalSize, phase4b, phase4c, elapsed4bMs, elapsed4cMs);
  });
});
