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
import { simplicityKey } from './fleet-allocation.js';

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

// Architecture doc Section 18.2 / this task's Section 20 -- applied ONLY to
// candidates that are ALREADY within tolerance (callers must filter first;
// this comparator does not check withinTolerance itself).
export const compareWithinTolerance = lexicographic([
  byNumberDescending((c) => c.totalActiveUnits), // 2. maximize fleet utilization
  compareSimplicity, // 3. prefer smallest/simplest Hopper Pattern
  byNumberAscending((c) => c.totalMovedUnits), // 4. minimize unnecessary relocation
  byNumberAscending((c) => c.absoluteDeviation), // 5. minimize absolute Ni deviation
  byNumberAscending((c) => c.activeSourceCount), // 6. minimize source-switching complexity
  compareTieBreak, // 7. deterministic tie-break
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
