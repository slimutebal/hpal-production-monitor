// ============================================================
// V2.x EXHAUSTIVE REFERENCE IMPLEMENTATION
// TEST-ONLY
// FROZEN FOR V3.0 DIFFERENTIAL TESTING
// DO NOT OPTIMIZE OR "CLEAN UP"
//
// Frozen, test-only snapshot of the THREE exports of
// js/pages/calculate/operational-continuity.js that recommendation-
// ranking.js actually consumes (captured at V3.0 Phase 1, production HEAD
// 5011a37): calculateContractorStandbyMetrics, MINOR_STANDBY_RATIO,
// isOperationalLoadingPointAllocation (plus its own
// MIN_UNITS_PER_SPLIT_LOADING_POINT dependency).
//
// Everything else in the production module (calculateRequiredNiRange,
// findSplitLoadingPlan, deriveContractorContinuityPlan,
// classifyMaterialActionLabel, classifyFleetActionLabel) belongs to the
// Contractor Continuity mitigation-plan UI feature, not the Recommendation
// SEARCH/RANKING path findBlendRecommendations() exercises, so it is
// intentionally NOT duplicated here (this task's Section 5: "do not
// blindly duplicate unrelated modules").
//
// IMPORTANT LEGACY EDGE CASE (this task's Section 9/22): the current V2.x
// engine still GENERATES active loading-point allocations of 1-5 DT; the
// MIN_UNITS_PER_SPLIT_LOADING_POINT / isOperationalLoadingPointAllocation
// rule below is currently RANKING-ONLY (it only ever penalizes a 1-5 DT
// candidate via recommendation-ranking-reference.mjs's
// invalidLoadingPointCount rule, never removes it from the search space).
// This frozen reference must keep reproducing that exact historical
// behavior -- do NOT "fix" it into a generation-time exclusion here. A
// future Phase 2 production engine intentionally diverging from this is
// an APPROVED DOMAIN DELTA (see tests/v3-differential.test.mjs), not a
// regression this oracle should ever start agreeing with early.
//
// Any INTENTIONAL modification to this file must be an explicit,
// Owner-approved oracle update. Nothing under js/, index.html, or
// service-worker.js may import this file.
// ============================================================

import { normalizeContractorForComparison } from './calculate-validation-reference.mjs';

// standbyRatio <= this value: a minor, operationally acceptable fleet
// reduction (user-facing "REDUCE N DT"). Boundary is INCLUSIVE (exactly
// 5% is minor).
export const MINOR_STANDBY_RATIO = 0.05;

// standbyRatio >= this value: a Contractor continuity problem. Boundary is
// INCLUSIVE (exactly 50% is critical). Not consumed by
// recommendation-ranking-reference.mjs directly, but kept alongside
// classifyStandbyTier() below since both constants define the same tier
// classification together.
export const CRITICAL_STANDBY_RATIO = 0.50;

// When a Contractor's fleet is split across multiple SIMULTANEOUSLY
// ACTIVE loading points (existing or hypothetical), each active point
// must carry at least this many DT. An inactive/closed point may be 0.
export const MIN_UNITS_PER_SPLIT_LOADING_POINT = 6;

// ============================================================
// LOADING-POINT OPERATIONAL VALIDITY (V2.5.1 corrective pass). ONE shared
// predicate consumed by recommendation-ranking-reference.mjs's
// invalidLoadingPointCount rule. A PHYSICAL operating-point rule,
// deliberately independent of MINOR_STANDBY_RATIO/CRITICAL_STANDBY_RATIO.
// ============================================================
export function isOperationalLoadingPointAllocation(activeUnits) {
  return activeUnits === 0 || activeUnits >= MIN_UNITS_PER_SPLIT_LOADING_POINT;
}

function normalizeKey(contractor) {
  return normalizeContractorForComparison(contractor);
}

// ============================================================
// CONTRACTOR STANDBY METRICS
// ============================================================
//
// `sources`: candidate.sources (blending-recommendation-reference.mjs's
// buildCandidate() output). Grouping/ordering mirrors fleet-allocation-
// reference.mjs's own groupSourcesByContractor() (normalized Contractor,
// ascending) so output here is independent of input order.
//
// Returns one entry per Contractor present in `sources`, ALWAYS (including
// tier 'none' for a fully-active Contractor).
export function calculateContractorStandbyMetrics(sources) {
  const byContractor = new Map();
  sources.forEach((source) => {
    const key = normalizeKey(source.contractor);
    if (!byContractor.has(key)) byContractor.set(key, { contractor: source.contractor.trim(), sources: [] });
    byContractor.get(key).sources.push(source);
  });

  return [...byContractor.keys()].sort().map((key) => {
    const group = byContractor.get(key);
    const totalAssignedFleet = group.sources.reduce((sum, s) => sum + s.assignedUnits, 0);
    const totalActiveFleet = group.sources.reduce((sum, s) => sum + s.activeUnits, 0);
    const standbyUnits = totalAssignedFleet - totalActiveFleet;
    const standbyRatio = totalAssignedFleet > 0 ? standbyUnits / totalAssignedFleet : 0;
    return {
      contractor: group.contractor,
      totalAssignedFleet,
      totalActiveFleet,
      standbyUnits,
      standbyRatio,
      loadingPointCount: group.sources.filter((s) => s.assignedUnits > 0).length,
      sources: group.sources,
      tier: classifyStandbyTier(standbyRatio),
      hasInvalidLoadingPoint: group.sources.some((s) => !isOperationalLoadingPointAllocation(s.activeUnits)),
      invalidLoadingPointSources: group.sources.filter((s) => !isOperationalLoadingPointAllocation(s.activeUnits)),
    };
  });
}

// 'none' (fully active) / 'minor' (<=5%, acceptable) / 'moderate' (>5%,
// <50%, mitigation required) / 'critical' (>=50%, contractor continuity
// problem).
function classifyStandbyTier(standbyRatio) {
  if (standbyRatio <= 0) return 'none';
  if (standbyRatio <= MINOR_STANDBY_RATIO) return 'minor';
  if (standbyRatio < CRITICAL_STANDBY_RATIO) return 'moderate';
  return 'critical';
}
