// V3.0 Phase 7A -- PRODUCTION hard-case exact Recommendation solver
// (prefix-lock + Meet-In-The-Middle). Integration boundary for the proven
// Phase 6H/6I/6J/6K/6L R&D pipeline; see
// js/pages/calculate/blending-recommendation-source-lazy.js (kept, unchanged,
// as frozen prototype/proof evidence -- see its own header -- and NEVER
// imported from here) and tests/v3-phase6h..6l-*.test.mjs for the full
// exactness proofs this module relies on but does not re-derive.
//
// This file ports ONLY the ONE traversal configuration those phases proved
// best: descending value order / per-Contractor COUPLED chemistry bound
// (Phase 6D) / A-E ranking bound (Phase 4C) / prefix-lock domain propagation
// (Phase 6H). The experimental alternatives each phase's own benchmark
// rejected -- Phase 6C's other source/value orderings, Phase 6E's extended
// (G/H/I) ranking bound (proven byte-identical to A-E-only), Phase 6F's
// dominance frontier (proven no material benefit) -- are deliberately NOT
// ported: carrying dead experimental surface into production would violate
// this phase's own "reuse proven code, do not redesign it" instruction.
//
// PRODUCTION HARD-CASE PIPELINE (two independent phases):
//
//   PHASE A -- source-lazy, prefix-lock-propagated Branch-and-Bound
//   (Phase 6B/6D/6H). Decides ONE dome at a time (never an eager per-
//   Contractor allocation array -- this is what lets a concentrated
//   scenario like E reach this solver without
//   fleet-allocation.js's MAX_ALLOCATIONS_PER_CONTRACTOR=20000 gate ever
//   blocking it, this task's own Section 5). Runs until it either finishes
//   the whole search space, exhausts `nodeBudget`, or -- the instant a
//   witnessed within-tolerance incumbent PROVES (never assumes) the Phase
//   6H A+B theorem (criticalContractorCount===0 AND totalActiveUnits===
//   globalMaxActiveUnits) -- stops early (stopAtLock).
//
//   PHASE B -- ONLY once Phase A's lock actually fires: the direct Phase 6L
//   E -> F(Hopper) -> G(relocation) -> H(Ni deviation) -> I(active source
//   count) -> J(real comparator) MITM funnel over the full-utilization
//   subspace that the Phase 6H SWITCH THEOREM proves contains the eventual
//   winner. Phase 6I's own group-granularity decomposition Branch-and-Bound
//   is deliberately skipped -- Phase 6L's MITM funnel already supersedes it
//   (this is exactly what let D/E complete in ~248ms/~1.6s rather than via
//   Phase 6I's own multi-million-node group traversal).
//
// FALLBACK CONTRACT (this task's own Section 3 -- "never assume full
// utilization merely because a scenario is large"): if Phase A's lock never
// fires -- the search finishes on its own without ever needing it, or the
// node budget runs out first -- Phase B (the MITM funnel) is NEVER invoked.
// runHardCaseSearch() returns Phase A's own already-exact result (OK /
// TARGET_NOT_ACHIEVABLE / SEARCH_INCOMPLETE) in that case; SEARCH_INCOMPLETE
// remains a valid, honest safety state, never silently approximated.
import { normalizeSourceIdentity } from './calculate-validation.js';
import {
  isOperationalLoadingPointAllocation,
  MIN_UNITS_PER_ACTIVE_LOADING_POINT,
  countOperationalAllocations,
  simplifyUnitRatio,
  simplicityKey,
} from './fleet-allocation.js';
// Deliberate circular import (blending-recommendation.js imports
// runHardCaseSearch() from this file): safe under ESM live bindings because
// every reference below is resolved lazily, inside a function body, never
// at module top-level evaluation time. This is how the hard-case path
// reuses the SAME business logic (chemistry bound math, ranking-prefix
// bound math, candidate construction, the real ranking comparators) as the
// normal engine, rather than a second, drifting copy of any of it (this
// task's own "do not duplicate buildCandidate semantics, ranking
// comparator... use existing production helpers wherever possible").
import {
  buildCandidate,
  groupSourceNiExtent,
  groupMaxAchievableTonnage,
  boundIntersectsTolerance,
  conservativeRankingBound,
  boundCannotBeatIncumbent,
  incumbentRankingMetrics,
  computeContractorSearchOrder,
  MAX_SEARCH_NODES,
} from './blending-recommendation.js';
import { compareWithinTolerance, compareBestAttainable } from './recommendation-ranking.js';
import { CRITICAL_STANDBY_RATIO, MINOR_STANDBY_RATIO } from './operational-continuity.js';

// ============================================================
// PHASE A -- source-lazy prefix-lock search (Phase 6B/6D/6H)
// ============================================================

// See blending-recommendation-source-lazy.js's own "CLOSED-FORM
// PARTIAL-GROUP RANK BOUND -- PROOF" (Phase 6B) for the exactness proof.
function openBudgetRankContribution(remainingFleet, remainingSources) {
  const additionalMaxActiveUnits = isOperationalLoadingPointAllocation(remainingFleet) ? remainingFleet : 0;
  const occupiedCount = remainingSources.reduce((count, s) => count + (s.assignedUnits > 0 ? 1 : 0), 0);
  const activatable = Math.min(occupiedCount, Math.floor(remainingFleet / MIN_UNITS_PER_ACTIVE_LOADING_POINT));
  const minAdditionalFullyUnusedCount = occupiedCount - activatable;
  return { additionalMaxActiveUnits, minAdditionalFullyUnusedCount };
}

// See blending-recommendation-source-lazy.js's own "PHASE 6H ANALYSIS,
// SECTION 4" for the proof. `remainingSourceCount`/`requiredTotal` as there.
function canSatisfyExactRemainingTotal(remainingSourceCount, requiredTotal) {
  if (requiredTotal === 0) return true;
  if (remainingSourceCount <= 0) return false;
  return requiredTotal >= MIN_UNITS_PER_ACTIVE_LOADING_POINT;
}

// Descending value order only (Phase 6C's own 'descending' strategy,
// production's fixed choice -- reproduces the original Phase 6B hardcoded
// loop): {0} U [MIN, remainingFleet], largest first, 0 last.
function computeDescendingValueOrder(remainingFleet) {
  const values = [];
  for (let v = remainingFleet; v >= MIN_UNITS_PER_ACTIVE_LOADING_POINT; v -= 1) values.push(v);
  values.push(0);
  return values;
}

// See blending-recommendation-source-lazy.js's own "CLOSED-FORM PARTIAL-
// GROUP CHEMISTRY BOUND -- PROOF" (Phase 6D) for the exactness proof: each
// still-open group's own choice collapses to a binary "excluded" or
// "active at its own extreme Ni, full remaining tonnage" corner, solved by
// a greedy exchange-argument walk sorted by extreme Ni.
const FLOAT_EPSILON_COUPLED = 1e-9;

function extremeFinalNi(fixedNumerator, fixedTonnage, envelopes, mode) {
  const candidates = envelopes
    .filter((e) => e.thiTonnage > 0)
    .map((e) => ({ value: mode === 'min' ? e.minNi : e.maxNi, thiTonnage: e.thiTonnage }))
    .sort((a, b) => (mode === 'min' ? a.value - b.value : b.value - a.value));

  let numerator = fixedNumerator;
  let tonnage = fixedTonnage;
  for (const candidate of candidates) {
    if (tonnage > 0) {
      const currentAvg = numerator / tonnage;
      const favorable = mode === 'min'
        ? candidate.value < currentAvg + FLOAT_EPSILON_COUPLED
        : candidate.value > currentAvg - FLOAT_EPSILON_COUPLED;
      if (!favorable) break;
    }
    numerator += candidate.value * candidate.thiTonnage;
    tonnage += candidate.thiTonnage;
  }

  if (tonnage > 0) return numerator / tonnage;
  return mode === 'min' ? Infinity : -Infinity;
}

function conservativeFinalNiBoundCoupled(fixedNumerator, fixedTonnage, envelopes) {
  return {
    minNi: extremeFinalNi(fixedNumerator, fixedTonnage, envelopes, 'min'),
    maxNi: extremeFinalNi(fixedNumerator, fixedTonnage, envelopes, 'max'),
  };
}

// Static per-search traversal plan (computed once, never per node) -- see
// blending-recommendation-source-lazy.js's own buildTraversalPlan() for the
// full derivation. Trimmed here to only what the fixed 'coupled' chemistry
// bound / 'ae' ranking bound / prefix-propagation configuration needs (no
// pooled-chemistry suffix, no dominance-frontier state).
function buildTraversalPlan(groups, groupFleets, searchOrder) {
  const travGroups = searchOrder.map((i) => groups[i]);
  const travFleets = searchOrder.map((i) => groupFleets[i]);

  const flatSources = [];
  const remainingSourcesFrom = [];
  const groupIndexOf = [];
  travGroups.forEach((group, depthIndex) => {
    group.sources.forEach((_, k) => {
      remainingSourcesFrom.push(group.sources.slice(k));
      groupIndexOf.push(depthIndex);
    });
    flatSources.push(...group.sources);
  });

  const n = travGroups.length;
  const suffixRankAfterGroup = new Array(n + 1);
  const groupEnvelopes = new Array(n);
  suffixRankAfterGroup[n] = {
    minCriticalCount: 0, maxActiveUnits: 0, minWorstRatio: 0, minMitigationCount: 0, minFullyUnusedCount: 0,
  };
  for (let d = n - 1; d >= 0; d -= 1) {
    const group = travGroups[d];
    const fleet = travFleets[d];
    const extent = groupSourceNiExtent(group.sources);
    const maxTonnage = groupMaxAchievableTonnage(fleet, group.sources);
    groupEnvelopes[d] = { minNi: extent.minNi, maxNi: extent.maxNi, thiTonnage: maxTonnage };

    const { additionalMaxActiveUnits, minAdditionalFullyUnusedCount } = openBudgetRankContribution(fleet, group.sources);
    const minStandbyRatio = fleet > 0 ? (fleet - additionalMaxActiveUnits) / fleet : 0;
    const restRank = suffixRankAfterGroup[d + 1];
    suffixRankAfterGroup[d] = {
      minCriticalCount: (minStandbyRatio >= CRITICAL_STANDBY_RATIO ? 1 : 0) + restRank.minCriticalCount,
      maxActiveUnits: additionalMaxActiveUnits + restRank.maxActiveUnits,
      minWorstRatio: Math.max(minStandbyRatio, restRank.minWorstRatio),
      minMitigationCount: (minStandbyRatio > MINOR_STANDBY_RATIO ? 1 : 0) + restRank.minMitigationCount,
      minFullyUnusedCount: minAdditionalFullyUnusedCount + restRank.minFullyUnusedCount,
    };
  }

  const requiredGroupActive = travFleets.map((fleet) => (isOperationalLoadingPointAllocation(fleet) ? fleet : 0));
  const globalMaxActiveUnits = requiredGroupActive.reduce((sum, v) => sum + v, 0);

  return {
    flatSources, remainingSourcesFrom, groupIndexOf, travFleets, suffixRankAfterGroup, groupEnvelopes,
    requiredGroupActive, globalMaxActiveUnits,
  };
}

// Source-level (one dome per node) Branch-and-Bound with the fixed
// production configuration. `pruningGate`/`visit` mirror
// blending-recommendation.js's own forEachCandidatePruned() contract.
// `stopAtLock` -- see blending-recommendation-source-lazy.js's own "PHASE 6I
// ANALYSIS" (SWITCH THEOREM) for why cutting the traversal short the
// instant the A+B lock fires is safe: every surviving branch from that
// point on already belongs to the full-utilization subspace Phase B
// re-derives directly.
function forEachCandidateSourceLazy(canonicalGroups, plan, targetNiValue, toleranceValue, pruningGate, visit, nodeBudget, stopAtLock) {
  const {
    flatSources, remainingSourcesFrom, groupIndexOf, travFleets, suffixRankAfterGroup, groupEnvelopes, requiredGroupActive,
  } = plan;
  const total = flatSources.length;
  const diagnostics = {
    visitedNodes: 0,
    prunedByChemistry: 0,
    prunedByRanking: 0,
    completedCandidates: 0,
    incomplete: false,
    eliminatedByPrefixPropagation: 0,
    eliminatedByEPropagation: 0,
    nodeAtPrefixLock: null,
    nodeAtELock: null,
    stoppedAtLock: false,
    globalMaxActiveUnits: plan.globalMaxActiveUnits,
  };

  function combine(flatIdx, activeBySourceKey, fixedNumerator, fixedTonnage, completedFixed, groupState) {
    if (diagnostics.incomplete || diagnostics.stoppedAtLock) return;
    if (diagnostics.visitedNodes >= nodeBudget) {
      diagnostics.incomplete = true;
      return;
    }
    diagnostics.visitedNodes += 1;

    if (flatIdx === total) {
      const candidate = buildCandidate(canonicalGroups, activeBySourceKey, targetNiValue, toleranceValue);
      if (candidate) {
        diagnostics.completedCandidates += 1;
        visit(candidate, diagnostics);
      }
      return;
    }

    const depthIndex = groupIndexOf[flatIdx];
    const gs = (groupState && groupState.depthIndex === depthIndex)
      ? groupState
      : {
        depthIndex, alreadyActive: 0, remainingFleet: travFleets[depthIndex], fullyUnusedSoFar: 0,
      };

    if (pruningGate.active) {
      const remainingSources = remainingSourcesFrom[flatIdx];
      const partialExtent = groupSourceNiExtent(remainingSources);
      const partialMaxTonnage = groupMaxAchievableTonnage(gs.remainingFleet, remainingSources);
      const chemBound = conservativeFinalNiBoundCoupled(fixedNumerator, fixedTonnage, [
        { minNi: partialExtent.minNi, maxNi: partialExtent.maxNi, thiTonnage: partialMaxTonnage },
        ...groupEnvelopes.slice(depthIndex + 1),
      ]);
      if (!boundIntersectsTolerance(chemBound, targetNiValue, toleranceValue)) {
        diagnostics.prunedByChemistry += 1;
        return;
      }

      const totalGroupFleet = travFleets[depthIndex];
      const { additionalMaxActiveUnits, minAdditionalFullyUnusedCount } = openBudgetRankContribution(gs.remainingFleet, remainingSources);
      const bestFinalActiveInGroup = gs.alreadyActive + additionalMaxActiveUnits;
      const minStandbyRatioGroup = totalGroupFleet > 0 ? (totalGroupFleet - bestFinalActiveInGroup) / totalGroupFleet : 0;
      const afterRank = suffixRankAfterGroup[depthIndex + 1];
      const rankBound = conservativeRankingBound(
        {
          criticalCount: completedFixed.criticalCount,
          activeUnits: completedFixed.activeUnits + gs.alreadyActive,
          worstRatio: completedFixed.worstRatio,
          mitigationCount: completedFixed.mitigationCount,
          fullyUnusedCount: completedFixed.fullyUnusedCount,
        },
        {
          minCriticalCount: (minStandbyRatioGroup >= CRITICAL_STANDBY_RATIO ? 1 : 0) + afterRank.minCriticalCount,
          maxActiveUnits: additionalMaxActiveUnits + afterRank.maxActiveUnits,
          minWorstRatio: Math.max(minStandbyRatioGroup, afterRank.minWorstRatio),
          minMitigationCount: (minStandbyRatioGroup > MINOR_STANDBY_RATIO ? 1 : 0) + afterRank.minMitigationCount,
          minFullyUnusedCount: (gs.fullyUnusedSoFar + minAdditionalFullyUnusedCount) + afterRank.minFullyUnusedCount,
        },
      );
      if (boundCannotBeatIncumbent(rankBound, pruningGate.rankMetrics)) {
        diagnostics.prunedByRanking += 1;
        return;
      }
    }

    const source = flatSources[flatIdx];
    const identity = normalizeSourceIdentity(source.pileId, source.contractor);
    const isLastInGroup = (flatIdx + 1 === total) || (groupIndexOf[flatIdx + 1] !== depthIndex);

    let candidateValues = computeDescendingValueOrder(gs.remainingFleet);

    // Phase 6H domain propagation -- only ever REMOVES already-valid
    // choices this node would otherwise generate, never adds one; see
    // blending-recommendation-source-lazy.js's own "PHASE 6H ANALYSIS,
    // SECTIONS 2/3" for the proof.
    if (pruningGate.rankingPrefixLocked) {
      const afterCount = remainingSourcesFrom[flatIdx].length - 1;
      const neededFromHere = requiredGroupActive[depthIndex] - gs.alreadyActive;
      const beforeExact = candidateValues.length;
      candidateValues = candidateValues.filter((value) => canSatisfyExactRemainingTotal(afterCount, neededFromHere - value));
      diagnostics.eliminatedByPrefixPropagation += beforeExact - candidateValues.length;

      if (pruningGate.eZeroLocked && source.assignedUnits > 0) {
        const beforeE = candidateValues.length;
        candidateValues = candidateValues.filter((value) => value !== 0);
        diagnostics.eliminatedByEPropagation += beforeE - candidateValues.length;
      }
    }

    for (const value of candidateValues) {
      if (diagnostics.incomplete || diagnostics.stoppedAtLock) break;

      const next = new Map(activeBySourceKey);
      next.set(identity, value);
      const tonnage = value * source.tonnesPerUnit;
      const numerator = source.ni * tonnage;

      const nextGs = {
        depthIndex,
        alreadyActive: gs.alreadyActive + value,
        remainingFleet: gs.remainingFleet - value,
        fullyUnusedSoFar: gs.fullyUnusedSoFar + ((source.assignedUnits > 0 && value === 0) ? 1 : 0),
      };

      let nextCompletedFixed = completedFixed;
      let carryGroupState = nextGs;
      if (isLastInGroup) {
        const totalGroupFleet = travFleets[depthIndex];
        const finalStandbyRatio = totalGroupFleet > 0 ? (totalGroupFleet - nextGs.alreadyActive) / totalGroupFleet : 0;
        nextCompletedFixed = {
          activeUnits: completedFixed.activeUnits + nextGs.alreadyActive,
          criticalCount: completedFixed.criticalCount + (finalStandbyRatio >= CRITICAL_STANDBY_RATIO ? 1 : 0),
          worstRatio: Math.max(completedFixed.worstRatio, finalStandbyRatio),
          mitigationCount: completedFixed.mitigationCount + (finalStandbyRatio > MINOR_STANDBY_RATIO ? 1 : 0),
          fullyUnusedCount: completedFixed.fullyUnusedCount + nextGs.fullyUnusedSoFar,
        };
        carryGroupState = null;
      }

      combine(flatIdx + 1, next, fixedNumerator + numerator, fixedTonnage + tonnage, nextCompletedFixed, carryGroupState);
    }
  }

  combine(0, new Map(), 0, 0, {
    activeUnits: 0, criticalCount: 0, worstRatio: 0, mitigationCount: 0, fullyUnusedCount: 0,
  }, null);
  return diagnostics;
}

function runStreamingSearchSourceLazy(canonicalGroups, plan, targetNiValue, toleranceValue, nodeBudget, stopAtLock) {
  let bestWithinTolerance = null;
  let bestAttainable = null;
  const sourcesInAnyWithinToleranceCandidate = new Set();
  const pruningGate = {
    active: false, rankMetrics: null, rankingPrefixLocked: false, eZeroLocked: false,
  };

  const diagnostics = forEachCandidateSourceLazy(canonicalGroups, plan, targetNiValue, toleranceValue, pruningGate, (candidate, liveDiagnostics) => {
    if (bestAttainable === null || compareBestAttainable(candidate, bestAttainable) < 0) {
      bestAttainable = candidate;
    }
    if (candidate.withinTolerance) {
      candidate.sources.forEach((source) => {
        if (source.activeUnits > 0) {
          sourcesInAnyWithinToleranceCandidate.add(normalizeSourceIdentity(source.pileId, source.contractor));
        }
      });
      if (bestWithinTolerance === null || compareWithinTolerance(candidate, bestWithinTolerance) < 0) {
        bestWithinTolerance = candidate;
        pruningGate.rankMetrics = incumbentRankingMetrics(candidate);
      }
      pruningGate.active = true;

      // Phase 6H SECTION 1 -- prove (never assume) the A+B global-optimality
      // theorem the instant a witnessed incumbent's own metrics satisfy it.
      if (!pruningGate.rankingPrefixLocked
          && pruningGate.rankMetrics.criticalContractorCount === 0
          && pruningGate.rankMetrics.totalActiveUnits === plan.globalMaxActiveUnits) {
        pruningGate.rankingPrefixLocked = true;
        liveDiagnostics.nodeAtPrefixLock = liveDiagnostics.visitedNodes;
        if (stopAtLock) liveDiagnostics.stoppedAtLock = true;
      }
      if (pruningGate.rankingPrefixLocked && !pruningGate.eZeroLocked
          && pruningGate.rankMetrics.fullyUnusedLoadingPointCount === 0) {
        pruningGate.eZeroLocked = true;
        liveDiagnostics.nodeAtELock = liveDiagnostics.visitedNodes;
      }
    }
  }, nodeBudget, stopAtLock);

  return {
    bestWithinTolerance, bestAttainable, sourcesInAnyWithinToleranceCandidate, diagnostics,
  };
}

// ============================================================
// PHASE B -- Meet-In-The-Middle full-utilization funnel (Phase 6I/6J/6K/6L)
// ============================================================

function binomialCoefficient(n, k) {
  if (k < 0 || k > n || n < 0) return 0;
  const kk = Math.min(k, n - k);
  let result = 1;
  for (let i = 0; i < kk; i += 1) {
    result = (result * (n - i)) / (i + 1);
  }
  return Math.round(result);
}

// Lazy (generator) ascending k-subset index enumerator.
function* enumerateCombinationIndices(n, k, start = 0, prefix = []) {
  if (prefix.length === k) { yield prefix; return; }
  const remainingNeeded = k - prefix.length;
  for (let i = start; i <= n - remainingNeeded; i += 1) {
    yield* enumerateCombinationIndices(n, k, i + 1, [...prefix, i]);
  }
}

// Lazy (generator) composition enumerator: every ordered k-tuple of
// integers >= `min` summing to exactly `total`.
function* enumerateCompositions(total, parts, min) {
  if (parts === 1) {
    if (total >= min) yield [total];
    return;
  }
  const maxFirst = total - min * (parts - 1);
  for (let first = maxFirst; first >= min; first -= 1) {
    for (const rest of enumerateCompositions(total - first, parts - 1, min)) {
      yield [first, ...rest];
    }
  }
}

// Lazy full-utilization allocation enumerator for ONE Contractor group --
// no eager array, no MAX_ALLOCATIONS_PER_CONTRACTOR gate needed (this
// task's own Section 5). Yields every value array (parallel to that
// group's own canonical source order) with values in {0} U [MIN, fleet]
// summing to EXACTLY fleet.
function* enumerateFullUtilizationAllocations(fleet, sourceCount) {
  const MIN = MIN_UNITS_PER_ACTIVE_LOADING_POINT;
  if (fleet < MIN) return;
  const maxK = Math.min(sourceCount, Math.floor(fleet / MIN));
  for (let k = 1; k <= maxK; k += 1) {
    for (const indices of enumerateCombinationIndices(sourceCount, k)) {
      for (const composition of enumerateCompositions(fleet, k, MIN)) {
        const values = new Array(sourceCount).fill(0);
        indices.forEach((sourceIdx, j) => { values[sourceIdx] = composition[j]; });
        yield values;
      }
    }
  }
}

const HOPPER_HIGHER_GRADE_CLASSES = new Set(['HGLO', 'MGLO']);

// Per-group full-utilization STATE list -- numerator/tonnage plus every
// additive per-half primitive (fullyUnusedCount for E, higherUnits/lgloUnits
// for F, movedUnits/activeSourceCount for G/I), never a full buildCandidate()
// object (those are only ever built lazily for the final tied set). See
// blending-recommendation-source-lazy.js's own "PHASE 6J/6K/6L ANALYSIS"
// sections for the exactness proofs of each of these additive primitives.
function buildGroupFullUtilizationStates(group, fleet) {
  const { sources } = group;
  const states = [];
  function emit(values) {
    let tonnage = 0;
    let numerator = 0;
    let fullyUnusedCount = 0;
    let higherUnits = 0;
    let lgloUnits = 0;
    let movedUnits = 0;
    let activeSourceCount = 0;
    for (let i = 0; i < sources.length; i += 1) {
      const s = sources[i];
      const v = values[i];
      const t = v * s.tonnesPerUnit;
      tonnage += t;
      numerator += s.ni * t;
      if (s.assignedUnits > 0 && v === 0) fullyUnusedCount += 1;
      if (HOPPER_HIGHER_GRADE_CLASSES.has(s.oreClass)) higherUnits += v; else lgloUnits += v;
      if (v > s.assignedUnits) movedUnits += v - s.assignedUnits;
      if (v > 0) activeSourceCount += 1;
    }
    states.push({
      values, numerator, tonnage, fullyUnusedCount, higherUnits, lgloUnits, movedUnits, activeSourceCount,
    });
  }
  if (fleet === 0 || !isOperationalLoadingPointAllocation(fleet)) {
    emit(new Array(sources.length).fill(0));
  } else {
    for (const values of enumerateFullUtilizationAllocations(fleet, sources.length)) {
      emit(values);
    }
  }
  return states;
}

// Deterministic balanced LEFT/RIGHT split of Contractor groups, balancing
// each side's own aggregate (product) state count via greedy largest-first
// bin assignment on log(count).
function balanceContractorGroupsForMitm(perGroupStateCounts) {
  const order = perGroupStateCounts
    .map((count, index) => ({ index, count, logCount: count > 0 ? Math.log(count) : 0 }))
    .sort((a, b) => (b.count - a.count) || (a.index - b.index));
  const leftIndices = [];
  const rightIndices = [];
  let leftLog = 0;
  let rightLog = 0;
  order.forEach(({ index, logCount }) => {
    if (leftLog <= rightLog) {
      leftIndices.push(index);
      leftLog += logCount;
    } else {
      rightIndices.push(index);
      rightLog += logCount;
    }
  });
  leftIndices.sort((a, b) => a - b);
  rightIndices.sort((a, b) => a - b);
  return { leftIndices, rightIndices };
}

// Aggregate half-state list: Cartesian product WITHIN one half only.
// `choices` retains {groupIndex, stateIndex} pairs so the real per-source
// allocation can be reconstructed later, for the tiny final tied set only.
function buildAggregateHalfStates(groupIndices, groupStatesList) {
  let aggregates = [{
    numerator: 0, tonnage: 0, fullyUnusedCount: 0, higherUnits: 0, lgloUnits: 0, movedUnits: 0, activeSourceCount: 0, choices: [],
  }];
  groupIndices.forEach((groupIndex) => {
    const states = groupStatesList[groupIndex];
    const next = [];
    aggregates.forEach((agg) => {
      states.forEach((state, stateIndex) => {
        next.push({
          numerator: agg.numerator + state.numerator,
          tonnage: agg.tonnage + state.tonnage,
          fullyUnusedCount: agg.fullyUnusedCount + state.fullyUnusedCount,
          higherUnits: agg.higherUnits + state.higherUnits,
          lgloUnits: agg.lgloUnits + state.lgloUnits,
          movedUnits: agg.movedUnits + state.movedUnits,
          activeSourceCount: agg.activeSourceCount + state.activeSourceCount,
          choices: [...agg.choices, { groupIndex, stateIndex }],
        });
      });
    });
    aggregates = next;
  });
  return aggregates;
}

// lowScore/highScore -- see blending-recommendation-source-lazy.js's own
// "EXACT CHEMISTRY JOIN CONDITION -- PROOF" (Phase 6J): a within-tolerance
// combination is exactly left.lowScore+right.lowScore>=0 AND
// left.highScore+right.highScore<=0, no epsilon, no rounding.
function withChemistryScores(states, targetNiValue, toleranceValue) {
  const low = targetNiValue - toleranceValue;
  const high = targetNiValue + toleranceValue;
  return states.map((state) => ({
    ...state,
    lowScore: state.numerator - low * state.tonnage,
    highScore: state.numerator - high * state.tonnage,
  }));
}

class FenwickTree {
  constructor(size) {
    this.size = size;
    this.tree = new Array(size + 1).fill(0);
  }

  add(i, delta) {
    for (let x = i; x <= this.size; x += x & (-x)) this.tree[x] += delta;
  }

  prefixSum(i) {
    let sum = 0;
    for (let x = i; x > 0; x -= x & (-x)) sum += this.tree[x];
    return sum;
  }
}

// Exact COUNT of (left,right) pairs satisfying the chemistry join --
// O((L+R) log R), never O(L*R). See blending-recommendation-source-lazy.js's
// own comment on this same algorithm (Phase 6J) for the full derivation.
function countWithinToleranceMITM(leftStates, rightStates) {
  if (leftStates.length === 0 || rightStates.length === 0) return 0;

  const sortedHigh = Array.from(new Set(rightStates.map((r) => r.highScore))).sort((a, b) => a - b);

  function upperBoundRank(value) {
    let lo = 0;
    let hi = sortedHigh.length - 1;
    let ans = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (sortedHigh[mid] <= value) { ans = mid; lo = mid + 1; } else { hi = mid - 1; }
    }
    return ans;
  }

  function exactRank(value) {
    let lo = 0;
    let hi = sortedHigh.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (sortedHigh[mid] < value) lo = mid + 1; else hi = mid;
    }
    return lo;
  }

  const rightSorted = [...rightStates].sort((a, b) => b.lowScore - a.lowScore);
  const leftSorted = [...leftStates].sort((a, b) => a.lowScore - b.lowScore);

  const fenwick = new FenwickTree(sortedHigh.length);
  let rp = 0;
  let total = 0;
  leftSorted.forEach((left) => {
    const lowThreshold = -left.lowScore;
    const highThreshold = -left.highScore;
    while (rp < rightSorted.length && rightSorted[rp].lowScore >= lowThreshold) {
      fenwick.add(exactRank(rightSorted[rp].highScore) + 1, 1);
      rp += 1;
    }
    const upTo = upperBoundRank(highThreshold);
    if (upTo >= 0) total += fenwick.prefixSum(upTo + 1);
  });
  return total;
}

function bucketByFullyUnusedCount(states) {
  const buckets = new Map();
  states.forEach((state) => {
    const e = state.fullyUnusedCount;
    if (!buckets.has(e)) buckets.set(e, []);
    buckets.get(e).push(state);
  });
  return buckets;
}

// Exact minimum feasible E (Phase 6J Section 6): scans E totals ascending,
// reusing countWithinToleranceMITM() per (leftE,rightE) split.
function findMinimumFeasibleE(leftStates, rightStates) {
  const leftBuckets = bucketByFullyUnusedCount(leftStates);
  const rightBuckets = bucketByFullyUnusedCount(rightStates);
  const leftEs = [...leftBuckets.keys()].sort((a, b) => a - b);
  const rightEs = [...rightBuckets.keys()];
  if (leftEs.length === 0 || rightEs.length === 0) return { minimumE: null, count: 0 };
  const maxETotal = Math.max(...leftEs) + Math.max(...rightEs);

  for (let eTotal = 0; eTotal <= maxETotal; eTotal += 1) {
    let count = 0;
    leftEs.forEach((eLeft) => {
      const eRight = eTotal - eLeft;
      if (rightBuckets.has(eRight)) {
        count += countWithinToleranceMITM(leftBuckets.get(eLeft), rightBuckets.get(eRight));
      }
    });
    if (count > 0) return { minimumE: eTotal, count };
  }
  return { minimumE: null, count: 0 };
}

// Reconstructs the REAL per-source active-unit Map for one matched
// (leftChoice,rightChoice) pair -- small, final tied set only.
function buildActiveMapFromChoices(groups, groupStatesList, choices) {
  const activeBySourceKey = new Map();
  choices.forEach(({ groupIndex, stateIndex }) => {
    const group = groups[groupIndex];
    const { values } = groupStatesList[groupIndex][stateIndex];
    group.sources.forEach((s, i) => {
      activeBySourceKey.set(normalizeSourceIdentity(s.pileId, s.contractor), values[i]);
    });
  });
  return activeBySourceKey;
}

function hopperSignatureKeyOf(state) {
  return `${state.higherUnits}:${state.lgloUnits}`;
}

// Real production rule-F key for one already-combined primitive -- the SAME
// two calls compareSimplicity() (recommendation-ranking.js) itself makes,
// fed the MITM-composed totals instead of one candidate's own unitRatio.
function exactSimplicityKeyForCombinedPrimitive(higherUnits, lgloUnits) {
  const ratio = simplifyUnitRatio(higherUnits, lgloUnits);
  return ratio ? simplicityKey(ratio) : null;
}

function compareHopperSimplicityKeys(ka, kb) {
  for (let i = 0; i < ka.length; i += 1) {
    if (ka[i] !== kb[i]) return ka[i] - kb[i];
  }
  return 0;
}

function groupStatesByHopperSignature(states) {
  const map = new Map();
  states.forEach((state) => {
    const key = hopperSignatureKeyOf(state);
    if (!map.has(key)) map.set(key, { higherUnits: state.higherUnits, lgloUnits: state.lgloUnits, states: [] });
    map.get(key).states.push(state);
  });
  return map;
}

function statesAtExactETotal(leftStates, rightStates, eTotal) {
  const leftBuckets = bucketByFullyUnusedCount(leftStates);
  const rightBuckets = bucketByFullyUnusedCount(rightStates);
  const splits = [];
  [...leftBuckets.keys()].forEach((eLeft) => {
    const eRight = eTotal - eLeft;
    if (rightBuckets.has(eRight)) splits.push({
      eLeft, eRight, left: leftBuckets.get(eLeft), right: rightBuckets.get(eRight),
    });
  });
  return splits;
}

function computeHopperSignatureOpportunity(leftStates, rightStates, minimumFeasibleE) {
  if (minimumFeasibleE === null) return { ok: false };
  const splits = statesAtExactETotal(leftStates, rightStates, minimumFeasibleE);
  const leftStatesAtMinE = splits.flatMap((s) => s.left);
  const rightStatesAtMinE = splits.flatMap((s) => s.right);
  return { ok: true, splits, leftStatesAtMinE, rightStatesAtMinE };
}

// Exact Hopper-aware minimum F (Phase 6K): for every signature pair that is
// ACTUALLY chemistry-feasible at E=minimumFeasibleE, derive the exact
// combined rule-F key, then reduce to the global minimum F and its exact
// survivor entries -- no signature pair's raw member states are ever
// scanned individually for this step.
function computeHopperAwareMinimumF(leftStates, rightStates, minimumFeasibleE) {
  const opportunity = computeHopperSignatureOpportunity(leftStates, rightStates, minimumFeasibleE);
  if (!opportunity.ok) return { ok: false };

  const feasibleEntries = [];
  opportunity.splits.forEach(({ eLeft, left, right }) => {
    const leftSig = groupStatesByHopperSignature(left);
    const rightSig = groupStatesByHopperSignature(right);
    leftSig.forEach((bucketL, sigKeyL) => {
      rightSig.forEach((bucketR, sigKeyR) => {
        const pairCount = countWithinToleranceMITM(bucketL.states, bucketR.states);
        if (pairCount === 0) return;
        const key = exactSimplicityKeyForCombinedPrimitive(
          bucketL.higherUnits + bucketR.higherUnits,
          bucketL.lgloUnits + bucketR.lgloUnits,
        );
        feasibleEntries.push({
          eLeft, sigKeyL, sigKeyR, key, pairCount, leftStates: bucketL.states, rightStates: bucketR.states,
        });
      });
    });
  });

  if (feasibleEntries.length === 0) return { ok: false };

  const minimumFeasibleSimplicityKey = feasibleEntries.reduce(
    (best, entry) => (compareHopperSimplicityKeys(entry.key, best) < 0 ? entry.key : best),
    feasibleEntries[0].key,
  );
  const winningEntries = feasibleEntries.filter(
    (entry) => compareHopperSimplicityKeys(entry.key, minimumFeasibleSimplicityKey) === 0,
  );

  return { ok: true, minimumFeasibleSimplicityKey, winningEntries };
}

function bucketByIntegerKey(states, keyFn) {
  const buckets = new Map();
  states.forEach((state) => {
    const k = keyFn(state);
    if (!buckets.has(k)) buckets.set(k, []);
    buckets.get(k).push(state);
  });
  return buckets;
}

// Generic bucket-by-integer / ascending-total-scan / per-split MITM-count
// pattern (Phase 6J's own findMinimumFeasibleE(), generalized) -- reused
// here for G (movedUnits).
function findMinimumFeasibleAdditiveTotal(leftStates, rightStates, keyFn) {
  const leftBuckets = bucketByIntegerKey(leftStates, keyFn);
  const rightBuckets = bucketByIntegerKey(rightStates, keyFn);
  const leftKeys = [...leftBuckets.keys()].sort((a, b) => a - b);
  const rightKeys = [...rightBuckets.keys()];
  if (leftKeys.length === 0 || rightKeys.length === 0) return { minimumTotal: null, splits: [] };
  const maxTotal = Math.max(...leftKeys) + Math.max(...rightKeys);

  for (let total = 0; total <= maxTotal; total += 1) {
    const splits = [];
    leftKeys.forEach((kLeft) => {
      const kRight = total - kLeft;
      if (!rightBuckets.has(kRight)) return;
      const left = leftBuckets.get(kLeft);
      const right = rightBuckets.get(kRight);
      const count = countWithinToleranceMITM(left, right);
      if (count > 0) splits.push({
        kLeft, kRight, left, right, count,
      });
    });
    if (splits.length > 0) return { minimumTotal: total, splits };
  }
  return { minimumTotal: null, splits: [] };
}

// Stage G -- global minimum totalMovedUnits across every E+F-optimal entry.
function computeMinimumFeasibleG(winningEntries) {
  let minimumG = null;
  let splits = [];
  winningEntries.forEach((entry) => {
    const g = findMinimumFeasibleAdditiveTotal(entry.leftStates, entry.rightStates, (s) => s.movedUnits);
    if (g.minimumTotal === null) return;
    if (minimumG === null || g.minimumTotal < minimumG) {
      minimumG = g.minimumTotal;
      splits = g.splits;
    } else if (g.minimumTotal === minimumG) {
      splits = splits.concat(g.splits);
    }
  });
  return { minimumG, splits };
}

// Stage H -- Ni deviation is a ratio, not a sum, so no additive-total scan
// applies; this is a direct scan of the (by now tiny) G-optimal survivor
// set, each pair re-validated against the exact chemistry join.
function findMinimumAbsoluteDeviationAmongPairs(splits, targetNiValue) {
  let minimumDeviation = null;
  let winners = [];
  let pairsScanned = 0;
  splits.forEach(({ left, right }) => {
    left.forEach((l) => {
      right.forEach((r) => {
        pairsScanned += 1;
        if (l.lowScore + r.lowScore < 0 || l.highScore + r.highScore > 0) return;
        const tonnage = l.tonnage + r.tonnage;
        const ni = (l.numerator + r.numerator) / tonnage;
        const deviation = Math.abs(ni - targetNiValue);
        if (minimumDeviation === null || deviation < minimumDeviation) {
          minimumDeviation = deviation;
          winners = [{ left: l, right: r }];
        } else if (deviation === minimumDeviation) {
          winners.push({ left: l, right: r });
        }
      });
    });
  });
  return { minimumDeviation, winners, pairsScanned };
}

// Stage I -- plain additive min-scan over the (already H-optimal, hence
// tiny) tied pair set.
function selectMinimumActiveSourceCountPairs(pairs) {
  let minimumI = null;
  let winners = [];
  pairs.forEach((pair) => {
    const i = pair.left.activeSourceCount + pair.right.activeSourceCount;
    if (minimumI === null || i < minimumI) {
      minimumI = i;
      winners = [pair];
    } else if (i === minimumI) {
      winners.push(pair);
    }
  });
  return { minimumI, winners };
}

// Runs the full E->F->G->H->I->J MITM funnel over the canonical
// (Contractor-then-Pile-ID order, NOT traversal order) `groups`/
// `groupFleets` -- fully independent of Phase A's own traversal plan. Only
// the FINAL I-optimal tied pairs are ever turned into real buildCandidate()
// objects (this task's own "reconstruct ONLY the final winner, or a tiny
// tied set if mathematically necessary"); stage J itself is the REAL,
// unchanged compareWithinTolerance() comparator, never a reimplemented
// tie-break (this task's own "final verification boundary").
function runMitmFunnel(groups, groupFleets, targetNiValue, toleranceValue) {
  const groupStatesList = groups.map((g, i) => buildGroupFullUtilizationStates(g, groupFleets[i]));
  const perGroupStateCounts = groupStatesList.map((s) => s.length);
  const totalCartesianCombinations = perGroupStateCounts.reduce((a, b) => a * b, 1);

  const { leftIndices, rightIndices } = balanceContractorGroupsForMitm(perGroupStateCounts);
  const leftStates = withChemistryScores(buildAggregateHalfStates(leftIndices, groupStatesList), targetNiValue, toleranceValue);
  const rightStates = withChemistryScores(buildAggregateHalfStates(rightIndices, groupStatesList), targetNiValue, toleranceValue);

  const funnel = {
    candidate: null,
    totalCartesianCombinations,
    leftStateCount: leftStates.length,
    rightStateCount: rightStates.length,
    withinToleranceCount: 0,
    minimumE: null,
    minimumF: null,
    minimumG: null,
    hPairsScanned: 0,
    minimumH: null,
    minimumI: null,
  };

  const withinToleranceCount = countWithinToleranceMITM(leftStates, rightStates);
  funnel.withinToleranceCount = withinToleranceCount;
  if (withinToleranceCount === 0) return funnel;

  const eResult = findMinimumFeasibleE(leftStates, rightStates);
  funnel.minimumE = eResult.minimumE;

  const hopperF = computeHopperAwareMinimumF(leftStates, rightStates, eResult.minimumE);
  if (!hopperF.ok) return funnel;
  funnel.minimumF = hopperF.minimumFeasibleSimplicityKey;

  const gResult = computeMinimumFeasibleG(hopperF.winningEntries);
  if (gResult.minimumG === null) return funnel;
  funnel.minimumG = gResult.minimumG;

  const hResult = findMinimumAbsoluteDeviationAmongPairs(gResult.splits, targetNiValue);
  funnel.hPairsScanned = hResult.pairsScanned;
  if (hResult.minimumDeviation === null) return funnel;
  funnel.minimumH = hResult.minimumDeviation;

  const iResult = selectMinimumActiveSourceCountPairs(hResult.winners);
  funnel.minimumI = iResult.minimumI;

  const finalCandidates = iResult.winners
    .map((pair) => {
      const activeMap = buildActiveMapFromChoices(groups, groupStatesList, [...pair.left.choices, ...pair.right.choices]);
      return buildCandidate(groups, activeMap, targetNiValue, toleranceValue);
    })
    .filter(Boolean);
  finalCandidates.sort(compareWithinTolerance);
  funnel.candidate = finalCandidates[0] ?? null;

  return funnel;
}

// ============================================================
// PUBLIC ENTRY POINT
// ============================================================

// `groups`/`groupFleets` -- already-validated, canonical (Contractor-then-
// Pile-ID order) numeric groups, exactly as blending-recommendation.js's
// own prepareSearch() produces (this module never re-validates or
// re-groups). Returns { status, candidate?, sourcesInAnyWithinToleranceCandidate?, diagnostics }
// where `status` is 'OK' | 'TARGET_NOT_ACHIEVABLE' | 'SEARCH_INCOMPLETE' |
// 'NO_FEASIBLE_CANDIDATE' -- blending-recommendation.js's own
// buildHardCaseResult() wraps this into the public Recommendation contract.
export function runHardCaseSearch({ groups, groupFleets, targetNiValue, toleranceValue }, nodeBudget = MAX_SEARCH_NODES) {
  const perGroupCounts = groups.map((g, i) => countOperationalAllocations(groupFleets[i], g.sources.length));
  const fakeAllocationLengths = perGroupCounts.map((count) => ({ length: count }));
  const searchOrder = computeContractorSearchOrder(groups, fakeAllocationLengths);
  const plan = buildTraversalPlan(groups, groupFleets, searchOrder);

  const phaseA = runStreamingSearchSourceLazy(groups, plan, targetNiValue, toleranceValue, nodeBudget, true);

  const baseDiagnostics = {
    solverPath: 'HARDCASE_MITM',
    prefixLockNode: phaseA.diagnostics.nodeAtPrefixLock,
    sourceLazyVisitedNodes: phaseA.diagnostics.visitedNodes,
    stoppedAtLock: phaseA.diagnostics.stoppedAtLock,
    mitmActivated: false,
  };

  if (phaseA.diagnostics.incomplete && !phaseA.diagnostics.stoppedAtLock) {
    return {
      status: 'SEARCH_INCOMPLETE',
      diagnostics: {
        ...baseDiagnostics,
        completedCandidates: phaseA.diagnostics.completedCandidates,
        prunedByChemistry: phaseA.diagnostics.prunedByChemistry,
        prunedByRanking: phaseA.diagnostics.prunedByRanking,
      },
    };
  }

  if (!phaseA.diagnostics.stoppedAtLock) {
    // Fallback contract (this task's own Section 3): the A+B lock never
    // fired -- either the search finished on its own (small/normal shape)
    // or genuinely has no within-tolerance completion. Phase B (MITM) is
    // NEVER invoked here; Phase A's own already-exact result is final.
    return finalizeFromPhaseA(phaseA, baseDiagnostics);
  }

  const mitm = runMitmFunnel(groups, groupFleets, targetNiValue, toleranceValue);
  if (!mitm.candidate) {
    // Defensive only -- should be unreachable once the lock has witnessed a
    // real full-utilization incumbent, but never invent a result: fall back
    // to Phase A's own already-proven-exact incumbent instead.
    return finalizeFromPhaseA(phaseA, baseDiagnostics);
  }

  const sourcesInAnyWithinToleranceCandidate = new Set(phaseA.sourcesInAnyWithinToleranceCandidate);
  mitm.candidate.sources.forEach((source) => {
    if (source.activeUnits > 0) {
      sourcesInAnyWithinToleranceCandidate.add(normalizeSourceIdentity(source.pileId, source.contractor));
    }
  });

  return {
    status: 'OK',
    candidate: mitm.candidate,
    // Safe SUBSET of the true "any within-tolerance candidate" set (see
    // this file's own top-of-function comment on why): the true set can be
    // tens of millions of full-utilization candidates for a scenario like D
    // (this task's own funnel.withinToleranceCount), which re-enumerating
    // per-source would defeat the entire purpose of the MITM funnel. Union
    // of every source witnessed active in a real within-tolerance candidate
    // during Phase A's own traversal, plus the final MITM winner's own
    // active sources -- never an overcount (every source in this set truly
    // does appear in a real within-tolerance candidate), only a possible
    // undercount relative to full exhaustive enumeration. Downstream this
    // only makes recommendation-actions.js's Material Action STOP
    // condition MORE conservative for a source this set happens to miss
    // (it can still fall through to LIMIT), never falsely permissive.
    sourcesInAnyWithinToleranceCandidate,
    diagnostics: {
      ...baseDiagnostics,
      mitmActivated: true,
      fullUtilizationCombinationCount: mitm.totalCartesianCombinations,
      mitmLeftStates: mitm.leftStateCount,
      mitmRightStates: mitm.rightStateCount,
      withinToleranceCount: mitm.withinToleranceCount,
      minimumE: mitm.minimumE,
      minimumF: mitm.minimumF,
      minimumG: mitm.minimumG,
      hCandidatePairs: mitm.hPairsScanned,
      minimumH: mitm.minimumH,
      minimumI: mitm.minimumI,
    },
  };
}

function finalizeFromPhaseA(phaseA, baseDiagnostics) {
  const diagnostics = { ...baseDiagnostics, mitmActivated: false };
  if (phaseA.bestWithinTolerance) {
    return {
      status: 'OK',
      candidate: phaseA.bestWithinTolerance,
      sourcesInAnyWithinToleranceCandidate: phaseA.sourcesInAnyWithinToleranceCandidate,
      diagnostics,
    };
  }
  if (phaseA.bestAttainable) {
    return {
      status: 'TARGET_NOT_ACHIEVABLE',
      candidate: phaseA.bestAttainable,
      sourcesInAnyWithinToleranceCandidate: new Set(),
      diagnostics,
    };
  }
  return { status: 'NO_FEASIBLE_CANDIDATE', diagnostics };
}
