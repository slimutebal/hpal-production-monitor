// Pure Material Action + Fleet Action derivation (V2.4 Phase 5). See
// docs/V2.4_CALCULATE_AND_BLENDING_RECOMMENDATION_ARCHITECTURE.md Section
// 23, and this task's Sections 1-17/20.
//
// PURE MODULE CONTRACT: no DOM, no router, no i18n, no localStorage, no
// network. Every value returned is a raw enum string/number -- calculate-
// page.js (the DOM layer) is the only place that ever calls t() or renders
// a reason/explanation sentence for an action.
//
// HARD ARCHITECTURAL RULE (this task's Section 1): Material/Fleet Actions
// are DERIVED FROM the already-selected primary Recommendation candidate
// (blending-recommendation.js's findBlendRecommendations() result) --
//
//   Inputs -> Candidate generation -> Primary selected Recommendation
//     -> Material Actions -> Fleet Actions / presentation
//
// This module never re-runs the search, never selects a different
// candidate, never recomputes Hopper Pattern/Estimated Ni/fleet
// allocation/ranking, and never feeds its own output back into candidate
// generation (no circular logic). It only reads `recommendation.candidate`
// (and, for STOP's condition 3, the compact
// `recommendation.sourcesInAnyWithinToleranceCandidate` set
// blending-recommendation.js already derives from the same search) --
// see deriveRecommendationActions()'s own header comment below.
//
// MATERIAL ACTION vs FLEET ACTION (this task's Section 2) are two
// different questions and are never merged into one status: Material
// Action answers "should material from this source be fed under the
// current Target Ni conditions" (USE/LIMIT/STOP); Fleet Action answers
// "what should happen to the physical DT assigned to this source"
// (a quantity breakdown: useUnits/moveOutUnits/moveInUnits/separateUnits
// -- a source can be Material USE while some of its own assigned DT are
// Fleet MOVE/SEPARATE, e.g. the worked example in architecture doc
// Section 23.4).
import { normalizeSourceIdentity } from './calculate-validation.js';

export const MATERIAL_ACTION_USE = 'USE';
export const MATERIAL_ACTION_LIMIT = 'LIMIT';
export const MATERIAL_ACTION_STOP = 'STOP';

// ============================================================
// MARGINAL PILE IMPACT (architecture doc Section 23.6, this task's
// Section 8) -- one additional load of `pileNi`/`tonnesPerDt` added on top
// of a current blend state. Pure arithmetic only: no rounding (callers
// format for display), no i18n, no DOM. `targetNi` is optional -- passing
// it also computes the before/after absolute-deviation-from-target
// comparison Material Action LIMIT/STOP evaluation needs; omitting it
// returns only the raw { newNi, impact } the architecture doc's own
// Section 23.6 formula produces, for callers that only want the marginal
// Ni shift itself.
// ============================================================
export function calculateMarginalPileImpact({ currentNi, currentTonnage, pileNi, tonnesPerDt, targetNi }) {
  const newTonnage = currentTonnage + tonnesPerDt;
  const newNi = (currentNi * currentTonnage + pileNi * tonnesPerDt) / newTonnage;
  const impact = newNi - currentNi;

  const result = { newNi, impact };
  if (typeof targetNi === 'number') {
    const previousAbsoluteDeviation = Math.abs(currentNi - targetNi);
    const newAbsoluteDeviation = Math.abs(newNi - targetNi);
    result.previousAbsoluteDeviation = previousAbsoluteDeviation;
    result.newAbsoluteDeviation = newAbsoluteDeviation;
    // Strict improvement only -- an exact tie (newAbsoluteDeviation ===
    // previousAbsoluteDeviation) is neither "moves toward" nor "moves
    // farther", and must never itself satisfy a STOP condition (this
    // task's Section 6/30 test 3: "adding one load toward Target prevents
    // STOP" -- a tie is not "farther", so it also prevents STOP).
    result.movesTowardTarget = newAbsoluteDeviation < previousAbsoluteDeviation;
  }
  return result;
}

// ============================================================
// MATERIAL ACTION -- one source at a time (this task's Sections 3-7).
// `baselineCandidate`/`targetNi` are the SELECTED primary candidate (OK
// status) or the SELECTED best-attainable candidate (TARGET_NOT_ACHIEVABLE
// status) -- the caller (deriveRecommendationActions() below) is
// responsible for choosing the right one; this function itself has no
// status branching, per architecture doc Section 23.3's "Section 24's
// best-attainable candidate becomes the baseline" -- the SAME USE/LIMIT/
// STOP evaluation applies to whichever candidate is the baseline.
//
// `requiredByAnyWithinToleranceCandidate` implements STOP condition 3.
// Callers pass `false` for every source when the baseline is a
// best-attainable (TARGET_NOT_ACHIEVABLE) candidate -- by definition no
// within-tolerance candidate exists in that state (architecture doc
// Section 23.3 lists only 2 STOP conditions there, not 3), so condition 3
// is vacuously satisfied rather than skipped as a special case.
// ============================================================
function deriveMaterialAction(source, baselineCandidate, targetNi, requiredByAnyWithinToleranceCandidate) {
  // USE (this task's Section 3): unconditional whenever the source has a
  // positive contribution in the selected baseline -- never re-evaluated
  // against a marginal "adding even more" scenario (Section 3's own two
  // conditions are both already satisfied the moment activeUnits > 0; see
  // this module's header comment on why LIMIT/STOP are a zero-allocation
  // pair, not alternatives USE competes with).
  if (source.activeUnits > 0) {
    return MATERIAL_ACTION_USE;
  }

  // Zero allocation alone is NEVER automatically STOP (this task's
  // Section 6) -- every zero-allocation source starts as a LIMIT
  // candidate and only becomes STOP if ALL of Section 5's conditions hold.
  const impact = calculateMarginalPileImpact({
    currentNi: baselineCandidate.estimatedNi,
    currentTonnage: baselineCandidate.totalTonnage,
    pileNi: source.ni,
    tonnesPerDt: source.tonnesPerUnit,
    targetNi,
  });

  // Condition 2: adding one additional load moves the result farther from
  // Target than the current baseline -- a strict worsening, not merely
  // "not an improvement" (a tie never triggers STOP -- see
  // calculateMarginalPileImpact()'s own movesTowardTarget comment).
  const worsensDistance = impact.newAbsoluteDeviation > impact.previousAbsoluteDeviation;

  // Condition 3 (OK status only -- vacuously true for TARGET_NOT_ACHIEVABLE,
  // see this function's header comment): no feasible within-tolerance
  // recommendation requires this source.
  const notRequiredElsewhere = !requiredByAnyWithinToleranceCandidate;

  if (worsensDistance && notRequiredElsewhere) {
    return MATERIAL_ACTION_STOP;
  }
  return MATERIAL_ACTION_LIMIT;
}

// ============================================================
// FLEET ACTION -- one source at a time (this task's Sections 11-15).
// Reuses fleet-allocation.js's own already-computed per-source relocation
// fields (assignedUnits/activeUnits/moveInUnits/moveOutUnits/standbyUnits,
// set by blending-recommendation.js's buildCandidate() via
// planContractorRelocations()) -- this is "the existing same-Contractor
// relocation output" this task's Section 12 requires reusing, not a
// second independent relocation computation. `standbyUnits` IS this
// task's Phase 5 "SEPARATE" concept (Section 13's own "It is equivalent
// to the architecture's surplus/standby concept").
// ============================================================
function deriveFleetAction(source, relocations) {
  const identity = normalizeSourceIdentity(source.pileId, source.contractor);

  // Fleet accounting invariant (this task's Section 14):
  //   assignedUnits = useUnits + moveOutUnits + separateUnits   (donor side)
  //   activeUnits    = (assignedUnits retained) + moveInUnits    (receiver side)
  // useUnits is the physical DT that stay productively active AT THIS
  // SOURCE -- capped at assignedUnits, since a receiver's activeUnits can
  // exceed its own assignedUnits (the excess is moveInUnits from another
  // same-Contractor source, not this source's own fleet).
  const useUnits = Math.min(source.assignedUnits, source.activeUnits);
  const moveOutUnits = source.moveOutUnits;
  const moveInUnits = source.moveInUnits;
  const separateUnits = source.standbyUnits;

  const relocationsOut = relocations.filter((r) => normalizeSourceIdentity(r.fromPileId, r.contractor) === identity);
  const relocationsIn = relocations.filter((r) => normalizeSourceIdentity(r.toPileId, r.contractor) === identity);

  return {
    sourceIdentity: identity,
    pileId: source.pileId,
    contractor: source.contractor,
    assignedUnits: source.assignedUnits,
    activeUnits: source.activeUnits,
    useUnits,
    moveOutUnits,
    moveInUnits,
    separateUnits,
    relocationsOut,
    relocationsIn,
  };
}

// ============================================================
// ENTRY POINT (this task's Section 16)
//
// `recommendation` must be an `ok: true` result from
// blending-recommendation.js's findBlendRecommendations() -- callers are
// responsible for only invoking this once a primary Recommendation
// already exists (this task's Section 1/17), exactly like calculate-
// page.js's existing renderRecommendationResult()/
// buildRecommendationResultChildren() already assume `lastRecommendationResult`
// is the ok:true shape before ever reading `.candidate`.
//
// Returns:
//   {
//     status,           // 'OK' | 'TARGET_NOT_ACHIEVABLE', mirrors recommendation.status
//     materialActions: [{ sourceIdentity, pileId, contractor, oreClass, ni, action }],
//     fleetActions: [{ sourceIdentity, pileId, contractor, assignedUnits,
//                       activeUnits, useUnits, moveOutUnits, moveInUnits,
//                       separateUnits, relocationsOut, relocationsIn }],
//   }
//
// Both arrays are in the SAME deterministic (Contractor-then-Pile-ID)
// order candidate.sources already carries (fleet-allocation.js's
// groupSourcesByContractor()) -- never re-sorted here, so output order is
// as deterministic as the underlying candidate itself.
// ============================================================
export function deriveRecommendationActions(recommendation) {
  const { candidate, targetNi, status } = recommendation;
  const requiredSet = recommendation.sourcesInAnyWithinToleranceCandidate || new Set();

  const materialActions = candidate.sources.map((source) => {
    const identity = normalizeSourceIdentity(source.pileId, source.contractor);
    const action = deriveMaterialAction(source, candidate, targetNi, requiredSet.has(identity));
    return {
      sourceIdentity: identity,
      pileId: source.pileId,
      contractor: source.contractor,
      oreClass: source.oreClass,
      ni: source.ni,
      action,
    };
  });

  const fleetActions = candidate.sources.map((source) => deriveFleetAction(source, candidate.relocations));

  return { status, materialActions, fleetActions };
}
