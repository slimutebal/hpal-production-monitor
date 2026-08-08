// Pure Operational Hopper Pattern derivation (V2.4 Phase 6.1 -- Owner
// correction: "PHYSICAL FLEET ALLOCATION != HOPPER LOAD PATTERN"). See
// this task's Sections 1-13/23-25.
//
// PURE MODULE CONTRACT: no DOM, no router, no i18n, no localStorage, no
// network.
//
// THE PROBLEM THIS FIXES: before this task, the "Pola Hopper" (Hopper
// Pattern) UI showed candidate.unitRatio -- the SIMPLIFIED PHYSICAL
// ACTIVE-FLEET ratio (fleet-allocation.js's simplifyUnitRatio()) --
// directly and unconditionally. A physical allocation of 5 Higher Grade
// DT / 14 LGLO DT was therefore always displayed as Hopper Pattern
// "5 : 14", even when a much smaller repeating feed instruction (e.g.
// "1 : 3") would produce an Estimated Ni just as valid (within Target +-
// Tolerance) using the SAME already-selected candidate's material
// composition. The physical fleet count and the field feed instruction
// are two different questions -- this module answers the second one,
// completely independently of blending-recommendation.js's candidate
// search/ranking (which is UNCHANGED by this file: ranking's own
// "simplicity" rule, recommendation-ranking.js's compareSimplicity(),
// still scores candidates by their PHYSICAL unitRatio, exactly as before
// -- this task's Section 7 explicit "do not use physical fleet
// utilization as the Hopper Pattern simplicity metric" applies to THIS
// module's own search, not to candidate ranking).
//
// `candidate` here is always an ALREADY-SELECTED findBlendRecommendations()
// candidate (OK's primary pick or TARGET_NOT_ACHIEVABLE's best-attainable
// pick) -- this module never re-runs the fleet-allocation search and
// never influences which candidate got selected (Section 1's
// Inputs -> Candidate generation -> Primary selected Recommendation ->
// Hopper Pattern derivation chain is one-directional, matching
// recommendation-actions.js's own "derived after selection, never
// circular" rule).
import { gcd } from './fleet-allocation.js';
import { isWithinTolerance } from './blending-recommendation.js';

const HIGHER_GRADE_CLASSES = new Set(['HGLO', 'MGLO']);

// Explicit, documented, regression-tested small-pattern search bound (this
// task's Section 8) -- each side of a candidate pattern is searched over
// [1, MAX_OPERATIONAL_PATTERN_LOADS]. Chosen as a conservative
// "operationally memorable" ceiling: a field operator can reliably repeat
// "up to ~12 loads of one grade before the pattern repeats", comfortably
// covering every worked example in this task (1:1, 1:2, 1:3, 2:3, 2:1,
// 2:5, 4:7) while still bounding the search to a trivial 144-combination
// scan. This is a SEARCH BOUND, not a ranking weight -- it never
// influences WHICH pattern wins among those found, only which patterns are
// considered at all.
export const MAX_OPERATIONAL_PATTERN_LOADS = 12;

// Tonnage-weighted representative composition for one grade group (Higher
// Grade = HGLO+MGLO, or LGLO), built ONLY from the selected candidate's own
// ACTIVE sources (this task's Section 6) -- multi-source groups are never
// collapsed onto a single arbitrarily-chosen source, and the aggregation
// (plain sums) is inherently independent of the input source array's
// order (this task's Section 9 test 9/26 test 9).
//   effectiveNi:            tonnage-weighted average Ni across active
//                            sources in this group (same "never round a
//                            pile's contribution before summing" discipline
//                            blending-recommendation.js's buildCandidate()
//                            already uses for the overall estimatedNi).
//   effectiveTonnesPerLoad: unit-weighted average tonnes/DT across active
//                            sources in this group -- total active tonnage
//                            divided by total active units, so that
//                            `loads * effectiveTonnesPerLoad` always
//                            reproduces the group's true active tonnage
//                            when `loads` equals the group's true active
//                            unit count (this is what makes the exact-
//                            ratio fallback below mathematically identical
//                            to candidate.estimatedNi -- see
//                            exactFallback()).
function summarizeGroup(sources) {
  const tonnage = sources.reduce((sum, s) => sum + s.cycleTonnage, 0);
  const units = sources.reduce((sum, s) => sum + s.activeUnits, 0);
  if (tonnage <= 0 || units <= 0) {
    return { tonnage: 0, units: 0, effectiveNi: 0, effectiveTonnesPerLoad: 0 };
  }
  const niWeightedSum = sources.reduce((sum, s) => sum + s.ni * s.cycleTonnage, 0);
  return {
    tonnage,
    units,
    effectiveNi: niWeightedSum / tonnage,
    effectiveTonnesPerLoad: tonnage / units,
  };
}

// Evaluates ONE candidate (higherLoads, lgloLoads) pattern's Estimated Ni
// using the group summaries' effective Ni/tonnes-per-load -- always
// tonnage-weighted (this task's Section 5), NEVER a naive
// `(higherNi*higherLoads + lgloNi*lgloLoads) / totalLoads` load-count
// average, which would silently be wrong whenever the two groups' actual
// tonnes/load differ.
function evaluatePattern(higherLoads, lgloLoads, higherGroup, lgloGroup, targetNi, tolerance) {
  const higherTonnage = higherLoads * higherGroup.effectiveTonnesPerLoad;
  const lgloTonnage = lgloLoads * lgloGroup.effectiveTonnesPerLoad;
  const totalTonnage = higherTonnage + lgloTonnage;
  const estimatedNi = (higherGroup.effectiveNi * higherTonnage + lgloGroup.effectiveNi * lgloTonnage) / totalTonnage;
  const deviation = estimatedNi - targetNi;
  return {
    higherLoads,
    lgloLoads,
    estimatedNi,
    deviation,
    withinTolerance: isWithinTolerance(estimatedNi, targetNi, tolerance),
    isFallback: false,
  };
}

// The selected candidate's own EXACT aggregate ratio (this task's Sections
// 8-9) -- used whenever a grade group has zero active material (the "1:0"/
// "0:1" deterministic zero-side rule, no search needed/possible), and as
// the deterministic fallback when no small pattern within
// MAX_OPERATIONAL_PATTERN_LOADS lands within tolerance. Deliberately
// copies candidate.estimatedNi/deviation/withinTolerance VERBATIM rather
// than recomputing them from the group summaries -- this is what
// guarantees the fallback is byte-for-byte numerically consistent with the
// physical candidate's own already-approved numbers (never a second,
// potentially-diverging floating-point path to the "same" answer).
function exactFallback(candidate) {
  return {
    higherLoads: candidate.unitRatio.higher,
    lgloLoads: candidate.unitRatio.lglo,
    estimatedNi: candidate.estimatedNi,
    deviation: candidate.deviation,
    withinTolerance: candidate.withinTolerance,
    isFallback: true,
  };
}

// Deterministic small-pattern ranking (this task's Section 7), applied
// ONLY to patterns that already passed the withinTolerance filter:
//   1. smallest total loads (higherLoads + lgloLoads)
//   2. smaller max(higherLoads, lgloLoads)
//   3. smaller absolute Ni deviation
//   4. deterministic numeric tie-break (smaller higherLoads first -- the
//      only remaining case is a swapped pair like 2:3 vs 3:2, which always
//      share the same sum and max)
// Never physical fleet utilization/activeUnits -- those already decided
// which CANDIDATE got selected; this ranking only ever compares PATTERNS
// derived from that one, already-fixed candidate.
function comparePatterns(a, b) {
  const sumA = a.higherLoads + a.lgloLoads;
  const sumB = b.higherLoads + b.lgloLoads;
  if (sumA !== sumB) return sumA - sumB;
  const maxA = Math.max(a.higherLoads, a.lgloLoads);
  const maxB = Math.max(b.higherLoads, b.lgloLoads);
  if (maxA !== maxB) return maxA - maxB;
  const devA = Math.abs(a.deviation);
  const devB = Math.abs(b.deviation);
  if (devA !== devB) return devA - devB;
  return a.higherLoads - b.higherLoads;
}

// ============================================================
// ENTRY POINT (this task's Section 3/10)
//
// candidate: an already-selected findBlendRecommendations() candidate
//            (candidate.sources/unitRatio/estimatedNi/deviation/
//            withinTolerance already computed by blending-recommendation.js
//            -- read-only here, never mutated or recomputed).
// targetNi/tolerance: the SAME Target Ni / Tolerance the Recommendation was
//            calculated against (result.targetNi/result.tolerance).
//
// Returns { higherLoads, lgloLoads, estimatedNi, deviation, withinTolerance,
//           isFallback }. Never overwrites/replaces candidate.unitRatio or
// any other physical-fleet field (this task's Section 10) -- the caller
// (calculate-page.js) keeps both the candidate object and this result
// simultaneously available.
// ============================================================
export function deriveOperationalHopperPattern({ candidate, targetNi, tolerance }) {
  const higherSources = candidate.sources.filter((s) => HIGHER_GRADE_CLASSES.has(s.oreClass) && s.activeUnits > 0);
  const lgloSources = candidate.sources.filter((s) => s.oreClass === 'LGLO' && s.activeUnits > 0);

  const higherGroup = summarizeGroup(higherSources);
  const lgloGroup = summarizeGroup(lgloSources);

  // Zero-side (this task's Section 9): a grade group with zero active
  // material can never appear in a searched pattern -- 1:0 / 0:1 is the
  // only representable instruction, and it is already exactly
  // candidate.unitRatio, so no search is meaningful or possible.
  if (higherGroup.tonnage === 0 || lgloGroup.tonnage === 0) {
    return exactFallback(candidate);
  }

  let best = null;
  for (let higherLoads = 1; higherLoads <= MAX_OPERATIONAL_PATTERN_LOADS; higherLoads += 1) {
    for (let lgloLoads = 1; lgloLoads <= MAX_OPERATIONAL_PATTERN_LOADS; lgloLoads += 1) {
      // Restrict the search to already-coprime pairs -- a reducible pair
      // (e.g. 2:4) always produces the IDENTICAL Estimated Ni as its
      // simplified form (1:2, a ratio-only computation) while having a
      // strictly larger total-loads score, so it can never win and would
      // only add redundant work.
      if (gcd(higherLoads, lgloLoads) !== 1) continue;
      const pattern = evaluatePattern(higherLoads, lgloLoads, higherGroup, lgloGroup, targetNi, tolerance);
      if (!pattern.withinTolerance) continue;
      if (!best || comparePatterns(pattern, best) < 0) best = pattern;
    }
  }

  return best || exactFallback(candidate);
}
