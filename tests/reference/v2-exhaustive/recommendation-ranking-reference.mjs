// ============================================================
// V2.x EXHAUSTIVE REFERENCE IMPLEMENTATION
// TEST-ONLY
// FROZEN FOR V3.0 DIFFERENTIAL TESTING
// DO NOT OPTIMIZE OR "CLEAN UP"
//
// Frozen, test-only snapshot of
// js/pages/calculate/recommendation-ranking.js (captured at V3.0 Phase 1,
// production HEAD 5011a37). This is the deterministic lexicographic
// ranking comparator chain that future V3.0 best-first-traversal work
// must reproduce the RESULT of (traversal order may change; the winning
// candidate for a given input must not, until an Owner-approved semantic
// delta is introduced -- see this task's Section 29/Phase 2 minimum-6
// note below).
//
// Any INTENTIONAL modification to this file must be an explicit,
// Owner-approved oracle update. Nothing under js/, index.html, or
// service-worker.js may import this file.
// ============================================================

// Pure deterministic ranking for the Recommendation engine (V2.4 Phase 3).
//
// NO hidden numeric weighted scoring anywhere -- every comparison below is
// an ORDERED (lexicographic) rule chain. The FIRST rule that distinguishes
// two candidates decides the outcome; ties fall through to the next rule.
import { simplicityKey } from './fleet-allocation-reference.mjs';
import {
  calculateContractorStandbyMetrics,
  MINOR_STANDBY_RATIO,
  isOperationalLoadingPointAllocation,
} from './operational-continuity-reference.mjs';

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

// Candidates must already carry a pre-SIMPLIFIED unitRatio.
function compareSimplicity(a, b) {
  const ka = simplicityKey(a.unitRatio);
  const kb = simplicityKey(b.unitRatio);
  for (let i = 0; i < ka.length; i += 1) {
    if (ka[i] !== kb[i]) return ka[i] - kb[i];
  }
  return 0;
}

// Deterministic, fully order-independent final tie-break: a normalized
// Contractor + Pile ID + activeUnits signature, built by the caller
// (blending-recommendation-reference.mjs's buildCandidate()) from sources
// already in canonical (Contractor-then-Pile-ID) order.
function compareTieBreak(a, b) {
  return a.allocationSignature < b.allocationSignature ? -1 : a.allocationSignature > b.allocationSignature ? 1 : 0;
}

// ============================================================
// CONTRACTOR CONTINUITY METRICS (V2.5) -- memoized via a WeakMap keyed by
// the candidate object itself, never a property written onto the
// candidate (so candidate objects are never mutated).
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

// V2.5.1 corrective pass -- a candidate can have PERFECT aggregate
// Contractor utilization (zero standby) while still leaving an individual
// loading point at an operationally unacceptable 1-5 active DT. This
// count uses the SAME single shared predicate
// operational-continuity-reference.mjs exports.
const invalidLoadingPointCountCache = new WeakMap();
function invalidLoadingPointCount(candidate) {
  if (!invalidLoadingPointCountCache.has(candidate)) {
    invalidLoadingPointCountCache.set(candidate, candidate.sources.filter((s) => !isOperationalLoadingPointAllocation(s.activeUnits)).length);
  }
  return invalidLoadingPointCountCache.get(candidate);
}

// A directly-computable proxy for "fully-unused current loading points
// where an equivalent USE/LIMIT alternative exists": every source with
// assigned fleet but zero active allocation in THIS candidate.
function fullyUnusedLoadingPointCount(candidate) {
  return candidate.sources.filter((s) => s.assignedUnits > 0 && s.activeUnits === 0).length;
}

// Applied ONLY to candidates that are ALREADY within tolerance (callers
// must filter first; this comparator does not check withinTolerance
// itself). V2.5 inserts FIVE contractor-continuity rules (A-E) ahead of
// the pre-existing simplicity/relocation/deviation/source-count/tie-break
// chain (now F-J); the V2.5.1 corrective pass inserts ONE MORE rule (0)
// ahead of ALL of those -- no active loading point at an operationally
// invalid 1-5 DT allocation.
//
// KNOWN FUTURE PHASE-2 APPROVED DELTA (this task's Section 29): rule 0
// below currently only PENALIZES a 1-5 DT candidate in ranking -- it can
// never fully exclude one if it is the only within-tolerance option
// (generation in fleet-allocation-reference.mjs/blending-recommendation-
// reference.mjs still produces 1-5 DT allocations). A Phase 2 production
// engine intentionally making 1-5 DT infeasible at GENERATION time is an
// approved semantic difference from this frozen reference, classified as
// MIN_LOADING_POINT_6 in the differential harness -- never a silent
// global-equality weakening.
export const compareWithinTolerance = lexicographic([
  byNumberAscending(invalidLoadingPointCount), // 0. no active loading point at 1-5 DT (V2.5.1)
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

// The best-attainable path, used when NO candidate falls within tolerance.
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
