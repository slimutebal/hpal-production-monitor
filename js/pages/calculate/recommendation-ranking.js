// Pure deterministic ranking for the Recommendation engine (V2.4 Phase 3).
// See
// docs/V2.4_CALCULATE_AND_BLENDING_RECOMMENDATION_ARCHITECTURE.md Sections
// 18.2/24, and this task's Sections 20/21/22/23.
//
// PURE MODULE CONTRACT: no DOM, no router, no i18n, no localStorage, no
// network, no window/document, no license-service dependency.
//
// NO hidden numeric weighted scoring anywhere -- every comparison below is
// an ORDERED (lexicographic) rule chain, matching the architecture doc's
// explicit "use an ordered comparison rather than arbitrary hidden numeric
// weights" requirement (Section 18.2). The FIRST rule that distinguishes
// two candidates decides the outcome; ties fall through to the next rule.
// isOperationalLoadingPointAllocation is imported from fleet-allocation.js
// (its V3.0 Phase 2 single source of truth -- see that module's own
// header comment) rather than operational-continuity.js, even though the
// latter still re-exports it for backward compatibility: this is
// production code, so it goes straight to the canonical source rather
// than through a compatibility re-export hop.
import { simplicityKey, isOperationalLoadingPointAllocation } from './fleet-allocation.js';
// Contractor continuity (V2.5, this task's Section 7) -- see
// operational-continuity.js's own header comment for why NO separate
// "existing-dome reallocation search" is needed: this ranking change is
// what makes the ALREADY-EXISTING candidate search (fleet-allocation.js/
// blending-recommendation.js, unmodified) prefer whichever within-
// tolerance candidate keeps each Contractor's fleet productive, instead of
// only ever maximizing the GLOBAL total active unit count regardless of
// how unevenly it is distributed per Contractor.
import { calculateContractorStandbyMetrics, MINOR_STANDBY_RATIO } from './operational-continuity.js';

function byNumberAscending(readValue) {
  return (a, b) => readValue(a) - readValue(b);
}

function byNumberDescending(readValue) {
  return (a, b) => readValue(b) - readValue(a);
}

// Combines multiple (a,b)=>number comparators into one ordered chain:
// returns the first nonzero result, else 0 (a true tie).
function lexicographic(rules) {
  return (a, b) => {
    for (const rule of rules) {
      const result = rule(a, b);
      if (result !== 0) return result;
    }
    return 0;
  };
}

// Candidates must already carry a pre-SIMPLIFIED unitRatio (fleet-
// allocation.js's simplifyUnitRatio() output) -- see simplicityKey()'s own
// contract note for why an unsimplified 4:8 must never reach this compare
// with a different score than 1:2.
function compareSimplicity(a, b) {
  const ka = simplicityKey(a.unitRatio);
  const kb = simplicityKey(b.unitRatio);
  for (let i = 0; i < ka.length; i += 1) {
    if (ka[i] !== kb[i]) return ka[i] - kb[i];
  }
  return 0;
}

// Deterministic, fully order-independent final tie-break (this task's
// Section 20 rule 7 / Section 23 rule 6): a normalized Contractor + Pile
// ID + activeUnits signature, built by the caller (blending-
// recommendation.js's buildCandidate()) from sources already in canonical
// (Contractor-then-Pile-ID) order, so this reduces to a plain string
// comparison here.
function compareTieBreak(a, b) {
  return a.allocationSignature < b.allocationSignature ? -1 : a.allocationSignature > b.allocationSignature ? 1 : 0;
}

// ============================================================
// CONTRACTOR CONTINUITY METRICS (V2.5, this task's Section 7) -- memoized
// via a WeakMap keyed by the candidate object itself, never a property
// written onto the candidate (so candidate objects are never mutated --
// this module's own "no side effects" pure-module contract is preserved
// from every caller's perspective; the cache is purely an internal
// performance detail, garbage-collected automatically once a candidate is
// no longer referenced elsewhere). Sorting a large within-tolerance
// candidate set calls each comparator rule O(n log n) times, and
// candidate.sources can itself be non-trivial -- recomputing
// calculateContractorStandbyMetrics() on every single comparison (rather
// than once per candidate) measurably regressed
// tests/recommendation-performance.test.mjs's realistic 6-source
// benchmark from ~1s to >5s before this memoization was added.
// ============================================================
const contractorMetricsCache = new WeakMap();
function contractorMetricsFor(candidate) {
  if (!contractorMetricsCache.has(candidate)) {
    contractorMetricsCache.set(candidate, calculateContractorStandbyMetrics(candidate.sources));
  }
  return contractorMetricsCache.get(candidate);
}

function criticalContractorCount(candidate) {
  return contractorMetricsFor(candidate).filter((m) => m.tier === 'critical').length;
}

function worstContractorStandbyRatio(candidate) {
  return contractorMetricsFor(candidate).reduce((worst, m) => Math.max(worst, m.standbyRatio), 0);
}

function contractorsRequiringMitigationCount(candidate) {
  return contractorMetricsFor(candidate).filter((m) => m.standbyRatio > MINOR_STANDBY_RATIO).length;
}

// V2.5.1 corrective pass -- originally needed because a candidate could
// have PERFECT aggregate Contractor utilization (zero standby, so rules
// A-E above never distinguish it) while still leaving an individual
// loading point at an operationally unacceptable 1-5 active DT (e.g. a
// 34/1 split across two same-Contractor domes).
//
// V3.0 Phase 2 made 0-or->=6 a GENERATION-time feasibility rule (fleet-
// allocation.js's enumerateOperationalAllocations()), so no engine-
// generated candidate should ever reach this comparator with a nonzero
// invalidLoadingPointCount any more -- this rule is intentionally KEPT as
// a defensive rule 0, not removed, because it remains a real safety net
// against any candidate object constructed outside the normal generator
// (tests, future callers) and costs nothing when it never fires (this
// task's Section 13/14: "leave the defensive invalidLoadingPoint rule in
// ranking for now"). Uses the SAME single shared predicate
// fleet-allocation.js's own generator also checks (never a second,
// possibly-diverging copy of the 0-or->=6 rule) -- memoized alongside the
// contractor metrics for the same performance reason.
const invalidLoadingPointCountCache = new WeakMap();
function invalidLoadingPointCount(candidate) {
  if (!invalidLoadingPointCountCache.has(candidate)) {
    invalidLoadingPointCountCache.set(candidate, candidate.sources.filter((s) => !isOperationalLoadingPointAllocation(s.activeUnits)).length);
  }
  return invalidLoadingPointCountCache.get(candidate);
}

// A directly-computable proxy for "fully-unused current loading points
// where an equivalent USE/LIMIT alternative exists" (this task's Section
// 7 rule E): every source with assigned fleet but zero active allocation
// in THIS candidate. A full cross-candidate "could this specific source
// have been used instead" analysis is not attempted inside a pairwise
// comparator -- this count already captures the same directional
// preference (fewer idle current loading points wins) the rule asks for.
function fullyUnusedLoadingPointCount(candidate) {
  return candidate.sources.filter((s) => s.assignedUnits > 0 && s.activeUnits === 0).length;
}

// Architecture doc Section 18.2 / this task's Section 20 -- applied ONLY to
// candidates that are ALREADY within tolerance (callers must filter first;
// this comparator does not check withinTolerance itself). V2.5 (this
// task's Section 7) inserts FIVE contractor-continuity rules (A-E) ahead
// of the pre-existing simplicity/relocation/deviation/source-count/
// tie-break chain (now F-J); the V2.5.1 corrective pass (this task's
// Section 6) inserts ONE MORE rule (0) ahead of ALL of those -- no active
// loading point at an operationally invalid 1-5 DT allocation. Target +/-
// Tolerance remains the quality gate (only within-tolerance candidates
// ever reach this comparator at all); Ni deviation (H) still never
// outranks either operational validity or contractor continuity among
// candidates that are already inside tolerance, per this task's explicit
// requirement -- "lower deviation/simpler pattern/fewer sources/lower
// relocation" must never let a 1-5 DT loading point win over a valid
// alternative.
export const compareWithinTolerance = lexicographic([
  byNumberAscending(invalidLoadingPointCount), // 0. no active loading point at 1-5 DT (this task's Section 6/22, V2.5.1)
  byNumberAscending(criticalContractorCount), // A. prefer zero Contractors with critical (>=50%) standby
  byNumberDescending((c) => c.totalActiveUnits), // B. maximize overall fleet utilization
  byNumberAscending(worstContractorStandbyRatio), // C. lower worst standby ratio among individual Contractors
  byNumberAscending(contractorsRequiringMitigationCount), // D. fewer Contractors requiring >5% reduction
  byNumberAscending(fullyUnusedLoadingPointCount), // E. fewer fully-unused current loading points
  compareSimplicity, // F. prefer smallest/simplest Hopper Pattern
  byNumberAscending((c) => c.totalMovedUnits), // G. minimize unnecessary relocation
  byNumberAscending((c) => c.absoluteDeviation), // H. minimize absolute Ni deviation
  byNumberAscending((c) => c.activeSourceCount), // I. minimize source-switching complexity
  compareTieBreak, // J. deterministic tie-break
]);

// Architecture doc Section 24 / this task's Section 23 -- the best-
// attainable path, used when NO candidate falls within tolerance.
export const compareBestAttainable = lexicographic([
  byNumberAscending((c) => c.absoluteDeviation), // 1. minimize absolute Ni deviation
  byNumberDescending((c) => c.totalActiveUnits), // 2. maximize fleet utilization
  compareSimplicity, // 3. prefer simplest Hopper Pattern
  byNumberAscending((c) => c.totalMovedUnits), // 4. minimize same-Contractor relocation
  byNumberAscending((c) => c.activeSourceCount), // 5. minimize source-switching complexity
  compareTieBreak, // 6. deterministic tie-break
]);

export const RANKING_MODE_WITHIN_TOLERANCE = 'WITHIN_TOLERANCE';
export const RANKING_MODE_BEST_ATTAINABLE = 'BEST_ATTAINABLE';

// Never mutates the input array (sort() on a copy) -- callers may reuse
// the candidate list afterward.
export function pickBestCandidate(candidates, mode) {
  const comparator = mode === RANKING_MODE_WITHIN_TOLERANCE ? compareWithinTolerance : compareBestAttainable;
  return candidates.slice().sort(comparator)[0];
}
