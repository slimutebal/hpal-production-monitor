// V3.0 Phase 1/2 -- differential assertion helper (Phase 1 Section 16,
// Phase 2 Section 16-18).
//
// Runs BOTH the current production engine (js/pages/calculate/
// blending-recommendation.js) and the frozen legacy reference engine
// (tests/reference/v2-exhaustive/blending-recommendation-reference.mjs)
// against the same input, canonicalizes both results, and asserts they
// are IDENTICAL (strict numeric equality -- Phase 1 Section 11: "Do NOT
// immediately hide mismatches behind toFixed()/rounding/large epsilon
// tolerance") UNLESS the caller opts into a registered, narrowly-scoped
// APPROVED_DELTAS classification (Phase 2 Section 16-18: "STRICT equality
// must remain the default. Only one approved semantic delta exists:
// MIN_LOADING_POINT_6. Do NOT weaken global equality."). On an
// unresolved mismatch, throws an Error whose message is a compact,
// actionable diagnostic (Phase 1 Section 28): seed, scenario name/index,
// the exact input, and the first differing field -- enough to reproduce
// the failure exactly without dumping megabytes of objects.
import assert from 'node:assert/strict';
import { findBlendRecommendations } from '../../js/pages/calculate/blending-recommendation.js';
import { findBlendRecommendationsReference } from './v2-exhaustive/blending-recommendation-reference.mjs';
import { canonicalizeRecommendationResult, firstCanonicalDifference } from './canonical-recommendation-result.mjs';

// Fields that describe the SIZE/SHAPE of the search space rather than the
// winning candidate's own identity -- Phase 2 Section 27's strict-
// equality list ("status, activeUnits, estimatedNi, full precision
// fields, relocations, fleet utilization, allocationSignature, etc.")
// names candidate-identity fields only. Neither of these two is one:
//   - candidateCount: how many allocations existed in the search space.
//   - sourcesInAnyWithinToleranceCandidate: blending-recommendation.js's
//     own doc comment calls this "a compact DERIVED set... of every
//     source that has activeUnits > 0 in AT LEAST ONE within-tolerance
//     candidate" -- an aggregate over the WHOLE within-tolerance set, not
//     the selected winner.
// Both are DERIVED from exactly how many operationally-feasible
// allocations exist, so Phase 2 mechanically shrinks (never grows) them
// for almost any multi-value fleet, independent of whether the winning
// candidate itself changed.
function omitSearchSpaceMetadata(canonical) {
  if (!canonical.ok) return canonical;
  const { candidateCount, sourcesInAnyWithinToleranceCandidate, ...rest } = canonical;
  return rest;
}

function isSubsetOf(subset, superset) {
  const supersetValues = new Set(superset);
  return subset.every((item) => supersetValues.has(item));
}

// V3.0 Phase 2 (this task's Section 0/1): the Owner-approved hard
// generation-time feasibility rule -- an active loading point is only
// feasible at 0 or >= MIN_UNITS_PER_ACTIVE_LOADING_POINT (6) DT. This is
// the ONE registered approved delta. Its handler recognizes exactly THREE
// mechanical consequences of that single domain change, and nothing else
// (this task's Section 17: "Do not broadly whitelist any scenario merely
// because some losing legacy candidate somewhere in the search space
// contained 1-5 DT").
//
// Returns { resolved, tier, diagnostic }:
//   tier 'metadata-only' -- the winning candidate (and everything else
//     Section 27 lists) is byte-for-byte identical; only the search-space
//     -SIZE metadata shrank. Counted as a strictMatch by
//     assertRecommendationEquivalent() below, since the candidate-level
//     contract Section 27 actually cares about held.
//   tier 'winner-changed' -- production's selected candidate/status
//     genuinely differs from legacy's, explained entirely by the removal
//     of a specific now-infeasible legacy allocation. Counted as an
//     approvedDelta.
export const APPROVED_DELTAS = {
  MIN_LOADING_POINT_6: (legacyCanonical, productionCanonical) => {
    // Sub-case A: the ONLY difference is search-space-metadata (see
    // omitSearchSpaceMetadata() above), and production's metadata is a
    // shrinkage (candidateCount did not increase; sourcesInAny... is a
    // subset), never a divergence -- the winning candidate itself, and
    // everything else, is byte-for-byte identical. This is always the
    // direct, always-expected mechanical consequence of the same
    // approved delta -- never a case-by-case judgment call.
    if (legacyCanonical.ok && productionCanonical.ok) {
      const countShrankOrEqual = !Number.isFinite(legacyCanonical.candidateCount) || !Number.isFinite(productionCanonical.candidateCount)
        || productionCanonical.candidateCount <= legacyCanonical.candidateCount;
      const sourcesShrankOrEqual = isSubsetOf(productionCanonical.sourcesInAnyWithinToleranceCandidate, legacyCanonical.sourcesInAnyWithinToleranceCandidate);
      if (countShrankOrEqual && sourcesShrankOrEqual) {
        const restDifference = firstCanonicalDifference(omitSearchSpaceMetadata(legacyCanonical), omitSearchSpaceMetadata(productionCanonical));
        if (restDifference === null) return { resolved: true, tier: 'metadata-only' };
      }
    }

    // Sub-case B (this task's Section 17's literal definition): the
    // LEGACY engine's own SELECTED/winning candidate (OK or
    // TARGET_NOT_ACHIEVABLE's best-attainable candidate) itself contains
    // at least one active source with 1-5 DT. Under Phase 2 that exact
    // allocation no longer exists, so production is free to land on any
    // other status/candidate -- the whole remaining canonical difference
    // is accepted without further inspection, because the root cause
    // (that specific candidate was never generated) explains it
    // entirely.
    if (legacyCanonical.ok && legacyCanonical.candidate) {
      const legacyHasInvalidLoadingPoint = legacyCanonical.candidate.sources.some((s) => s.activeUnits >= 1 && s.activeUnits <= 5);
      if (legacyHasInvalidLoadingPoint) return { resolved: true, tier: 'winner-changed' };
    }

    // Sub-case C (this task's Section 11/30/31's "newly-unblocked"
    // effect): legacy was rejected outright by the OLD, larger raw
    // candidate-count safety gate (SEARCH_SPACE_TOO_LARGE), but
    // production's OPERATIONAL count for the identical input clears
    // MAX_ALLOCATIONS_PER_CONTRACTOR/MAX_GLOBAL_CANDIDATES because 1-5 DT
    // states are no longer counted/generated at all. This is the same
    // root cause as sub-case A, just manifesting before generation even
    // starts rather than in a shrunk-but-still-populated result.
    if (!legacyCanonical.ok && legacyCanonical.error === 'SEARCH_SPACE_TOO_LARGE') {
      const productionStillRejected = !productionCanonical.ok && productionCanonical.error === 'SEARCH_SPACE_TOO_LARGE';
      if (!productionStillRejected) return { resolved: true, tier: 'winner-changed' };
    }

    return {
      resolved: false,
      diagnostic: 'MIN_LOADING_POINT_6 does not apply: legacy\'s own winning candidate has no active source in [1,5], legacy was not SEARCH_SPACE_TOO_LARGE-now-unblocked, and the two canonical results differ in more than just search-space metadata -- this is an UNEXPECTED mismatch, not an approved delta',
    };
  },
};

// input: findBlendRecommendations()-shaped input.
// context: {
//   seedName, seed, scenarioName, scenarioIndex,
//   expectedApprovedDelta,   // e.g. 'MIN_LOADING_POINT_6' -- see APPROVED_DELTAS above
//   stats,                   // optional { strictMatches, approvedDeltas, unexpectedMismatches } counter object, mutated in place (Phase 2 Section 18/28)
// }
export function assertRecommendationEquivalent(input, context = {}) {
  const productionResult = findBlendRecommendations(input);
  const referenceResult = findBlendRecommendationsReference(input);
  const productionCanonical = canonicalizeRecommendationResult(productionResult);
  const referenceCanonical = canonicalizeRecommendationResult(referenceResult);

  const strictDifference = firstCanonicalDifference(referenceCanonical, productionCanonical);
  let difference = strictDifference;

  if (difference && context.expectedApprovedDelta) {
    const handler = APPROVED_DELTAS[context.expectedApprovedDelta];
    if (!handler) {
      throw new Error(`unknown/unregistered approved delta "${context.expectedApprovedDelta}" -- Phase 2 must register a handler in tests/reference/assert-recommendation-equivalent.mjs before any test may reference it`);
    }
    const outcome = handler(referenceCanonical, productionCanonical);
    if (outcome.resolved) {
      difference = null;
      if (context.stats) {
        if (outcome.tier === 'metadata-only') context.stats.strictMatches += 1;
        else context.stats.approvedDeltas += 1;
      }
    } else {
      difference = outcome.diagnostic;
      if (context.stats) context.stats.unexpectedMismatches += 1;
    }
  } else if (context.stats) {
    if (strictDifference === null) context.stats.strictMatches += 1;
    else context.stats.unexpectedMismatches += 1;
  }

  if (difference) {
    const diagnostic = [
      'V3 differential mismatch',
      '',
      `seed: ${context.seedName ?? '(none)'} (${context.seed ?? 'n/a'})`,
      `case: ${context.scenarioName ?? '(unnamed)'}${context.scenarioIndex !== undefined ? ` #${context.scenarioIndex}` : ''}`,
      '',
      'INPUT:',
      JSON.stringify(input),
      '',
      'FIRST DIFFERENCE:',
      difference,
      '',
      'LEGACY (reference) canonical:',
      JSON.stringify(referenceCanonical),
      '',
      'PRODUCTION canonical:',
      JSON.stringify(productionCanonical),
    ].join('\n');
    assert.fail(diagnostic);
  }
}
