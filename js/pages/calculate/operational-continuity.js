// Pure Contractor Continuity and Operational Fleet Optimization module
// (V2.5). See this task's Sections 1-26/33-34.
//
// PURE MODULE CONTRACT: no DOM, no router, no i18n, no localStorage, no
// network, no window/document. Every function here takes plain
// numbers/arrays/objects (already-numeric candidate.sources, never raw
// string input -- comma/dot decimal parsing already happened upstream in
// number-input.js/calculate-validation.js and is never duplicated here,
// this task's Section 37) and returns plain numbers/arrays/objects.
//
// CORE PRINCIPLE (this task's Section 2): "Material may change. Dome may
// change. Fleet should stay productive as much as possible." A dome
// (source row) may be closed/replaced; a Contractor's FLEET should not be
// left idle if a reasonable operational alternative exists. Cross-
// Contractor DT relocation remains forbidden everywhere in this module --
// every search/plan here is scoped to ONE Contractor at a time.
//
// ARCHITECTURE NOTE -- why there is no separate "existing-dome
// reallocation search" function here (this task's Sections 18-20): the
// EXISTING fleet-allocation.js/blending-recommendation.js search already
// brute-forces every integer allocation across a Contractor's OWN sources
// (bounded by MAX_ALLOCATIONS_PER_CONTRACTOR), including every possible
// "move DT from L30 to L31" redistribution -- recommendation-ranking.js's
// planContractorRelocations() already derives the resulting MOVE/CLOSE
// fleet actions from whichever allocation wins. The gap this task closes
// is that the OLD ranking never scored candidates by how evenly that
// existing search space's outcome was distributed per-Contractor -- see
// this file's calculateContractorStandbyMetrics(), consumed by
// recommendation-ranking.js's new contractor-continuity comparator rules
// (Section 7). Once ranking prefers a within-tolerance candidate that
// keeps a Contractor's existing domes fully active, that candidate is
// already what the search selects -- no second search is needed. This
// module's own NEW search (findSplitLoadingPlan()) is for a genuinely new
// capability the existing engine has no concept of at all: a HYPOTHETICAL
// dome that does not exist in the input sources (Sections 9-17).
import { normalizeContractorForComparison } from './calculate-validation.js';
import { MIN_UNITS_PER_ACTIVE_LOADING_POINT, isOperationalLoadingPointAllocation } from './fleet-allocation.js';

// ============================================================
// POLICY CONSTANTS (this task's Section 3/9)
// ============================================================

// standbyRatio <= this value: a minor, operationally acceptable fleet
// reduction (user-facing "REDUCE N DT"). Boundary is INCLUSIVE (exactly
// 5% is minor, this task's Section 3).
export const MINOR_STANDBY_RATIO = 0.05;

// standbyRatio >= this value: a Contractor continuity problem, never
// presented as a normal STANDBY/reduction recommendation. Boundary is
// INCLUSIVE (exactly 50% is critical, this task's Section 3).
export const CRITICAL_STANDBY_RATIO = 0.50;

// ============================================================
// LOADING-POINT OPERATIONAL VALIDITY -- V3.0 Phase 2 promoted this from a
// ranking-only preference (V2.5.1) to a HARD generation-time feasibility
// rule, so MIN_UNITS_PER_ACTIVE_LOADING_POINT/isOperationalLoadingPointAllocation
// now live in fleet-allocation.js (the module that actually generates
// candidate allocations) and are re-exported here unchanged, so this
// module's own consumers (deriveContractorContinuityPlan()'s SPLIT sizing
// below, calculateContractorStandbyMetrics()'s hasInvalidLoadingPoint
// defensive check) and any external importer keep a single source of
// truth instead of a second copy (this task's Section 4).
//
// MIN_UNITS_PER_SPLIT_LOADING_POINT (below) is kept as a backward-
// compatible alias of the same value -- a hypothetical SPLIT dome is
// itself an active loading point, so it was always describing this same
// physical rule under a narrower name, never a genuinely different
// constant.
// ============================================================
export { MIN_UNITS_PER_ACTIVE_LOADING_POINT, isOperationalLoadingPointAllocation };
export const MIN_UNITS_PER_SPLIT_LOADING_POINT = MIN_UNITS_PER_ACTIVE_LOADING_POINT;

function normalizeKey(contractor) {
  return normalizeContractorForComparison(contractor);
}

// ============================================================
// CONTRACTOR STANDBY METRICS (this task's Sections 3/5/35)
// ============================================================
//
// `sources`: candidate.sources (blending-recommendation.js's
// buildCandidate() output) -- each { pileId, contractor, assignedUnits,
// activeUnits, ni, tonnesPerUnit, cycleTonnage, ... }. Grouping/ordering
// mirrors fleet-allocation.js's own groupSourcesByContractor() (normalized
// Contractor, ascending) so output here is independent of input order
// (this task's Section 32 precedent).
//
// Returns one entry per Contractor present in `sources`, ALWAYS (including
// tier 'none' for a fully-active Contractor) -- callers filter for the
// subset that needs a continuity plan.
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
    // Full precision -- boundary comparisons below are exact fraction
    // comparisons, never pre-rounded (this task's Section 3/35).
    const standbyRatio = totalAssignedFleet > 0 ? standbyUnits / totalAssignedFleet : 0;
    return {
      contractor: group.contractor,
      totalAssignedFleet,
      totalActiveFleet,
      standbyUnits,
      standbyRatio,
      // Current loading-point count = this Contractor's sources with
      // assigned DT > 0 (this task's Section 5) -- a blank/zero-fleet row
      // is not an operating loading point.
      loadingPointCount: group.sources.filter((s) => s.assignedUnits > 0).length,
      sources: group.sources,
      tier: classifyStandbyTier(standbyRatio),
      // V2.5.1 (this task's Sections 5/22): true whenever ANY of this
      // Contractor's sources ends the candidate at 1-5 active DT --
      // checked against activeUnits regardless of assignedUnits, since a
      // source that started at 0 assigned can still become an invalid
      // 1-5 DT loading point after relocation. This can be true even when
      // standbyRatio is exactly 0 (e.g. 34/1 across two domes: nothing is
      // idle in aggregate, but the 1-DT point is still not an acceptable
      // final operating allocation) -- deriveContractorContinuityPlan()
      // below triggers on this independently of standbyRatio.
      hasInvalidLoadingPoint: group.sources.some((s) => !isOperationalLoadingPointAllocation(s.activeUnits)),
      invalidLoadingPointSources: group.sources.filter((s) => !isOperationalLoadingPointAllocation(s.activeUnits)),
    };
  });
}

// 'none' (fully active) / 'minor' (<=5%, acceptable) / 'moderate' (>5%,
// <50%, mitigation required) / 'critical' (>=50%, contractor continuity
// problem, this task's Section 3).
function classifyStandbyTier(standbyRatio) {
  if (standbyRatio <= 0) return 'none';
  if (standbyRatio <= MINOR_STANDBY_RATIO) return 'minor';
  if (standbyRatio < CRITICAL_STANDBY_RATIO) return 'moderate';
  return 'critical';
}

// ============================================================
// REQUIRED NI RANGE (this task's Sections 13/14/37) -- for a hypothetical/
// replacement dome contributing `newUnits` at `tonnesPerUnit`, holding
// every OTHER already-fixed contribution (`otherWeightedNi`/`otherTonnage`
// -- sum(Ni_i * Tonnage_i) / sum(Tonnage_i) across every source NOT part
// of this plan) constant, solve independently for the Ni that lands the
// FINAL BLEND exactly at Target-Tolerance (minRequiredNi) and exactly at
// Target+Tolerance (maxRequiredNi). Full precision throughout; the caller
// rounds only for display (this task's Section 13/32).
// ============================================================
export function calculateRequiredNiRange({ otherWeightedNi, otherTonnage, newUnits, tonnesPerUnit, targetNi, tolerance }) {
  const newTonnage = newUnits * tonnesPerUnit;
  if (!(newTonnage > 0)) {
    return { minRequiredNi: null, maxRequiredNi: null, feasible: false };
  }

  const totalTonnage = otherTonnage + newTonnage;
  const lowerTarget = targetNi - tolerance;
  const upperTarget = targetNi + tolerance;

  const minRequiredNi = (lowerTarget * totalTonnage - otherWeightedNi) / newTonnage;
  const maxRequiredNi = (upperTarget * totalTonnage - otherWeightedNi) / newTonnage;

  // This task's Section 14: no invented ceiling -- `feasible` only checks
  // the application's existing Ni > 0 floor. If the range partially
  // crosses zero (minRequiredNi <= 0 < maxRequiredNi), it is still
  // feasible -- the positive portion (0, maxRequiredNi] is valid; the
  // exact (possibly non-positive) minRequiredNi is still returned
  // unclamped so the caller has the full-precision range internally, per
  // Section 14's explicit "keep the exact full-precision range
  // internally" requirement.
  const feasible = Number.isFinite(minRequiredNi) && Number.isFinite(maxRequiredNi) && maxRequiredNi > 0;

  return { minRequiredNi, maxRequiredNi, feasible };
}

// Display-only floor clamp (this task's Section 14's "only the positive
// valid portion may be treated as feasible" applied to what a UI shows) --
// never used for the internal exact range, only when rendering a
// human-readable minimum.
export function displayableMinRequiredNi(range) {
  if (!range || !range.feasible) return null;
  return range.minRequiredNi > 0 ? range.minRequiredNi : 0;
}

// ============================================================
// SPLIT LOADING POINT SEARCH (this task's Sections 9-12/17/36) -- for a
// Contractor currently operating exactly ONE loading point. Searches
// every integer split (newDomeUnits, existingDomeUnits) with both sides
// >= MIN_UNITS_PER_ACTIVE_LOADING_POINT and existingDomeUnits +
// newDomeUnits === totalFleet (all fleet stays active, this task's
// Section 10), computing the hypothetical new dome's required Ni range
// for each. Returns the single best split (this task's Section 12's
// ranking, which -- since newDomeUnits alone already uniquely identifies
// each generated candidate -- reduces to: smallest newDomeUnits that is
// chemically feasible), or `null` if no split is geometrically possible
// (totalFleet < 2 * MIN_UNITS_PER_ACTIVE_LOADING_POINT) or none is
// chemically feasible.
// ============================================================
export function findSplitLoadingPlan({ totalFleet, existingDomeNi, tonnesPerUnit, otherWeightedNi, otherTonnage, targetNi, tolerance }) {
  const candidates = [];

  for (let newDomeUnits = MIN_UNITS_PER_ACTIVE_LOADING_POINT; newDomeUnits <= totalFleet - MIN_UNITS_PER_ACTIVE_LOADING_POINT; newDomeUnits += 1) {
    const existingDomeUnits = totalFleet - newDomeUnits;
    const existingDomeTonnage = existingDomeUnits * tonnesPerUnit;
    // The existing dome keeps its OWN known Ni (this task's Section 15:
    // "use the donating fleet/source's existing Tonnes/DT" -- the same
    // discipline applies to Ni, it is never re-solved-for), so its
    // contribution folds into the "other, already-fixed" side of the
    // equation alongside every other Contractor's candidate allocation.
    const range = calculateRequiredNiRange({
      otherWeightedNi: otherWeightedNi + existingDomeNi * existingDomeTonnage,
      otherTonnage: otherTonnage + existingDomeTonnage,
      newUnits: newDomeUnits,
      tonnesPerUnit,
      targetNi,
      tolerance,
    });
    if (!range.feasible) continue;
    candidates.push({
      newDomeUnits,
      existingDomeUnits,
      minRequiredNi: range.minRequiredNi,
      maxRequiredNi: range.maxRequiredNi,
      // Always true for anything pushed here (the `continue` above already
      // filtered out infeasible ranges) -- kept explicit so this shape
      // matches calculateRequiredNiRange()'s own return shape, letting
      // displayableMinRequiredNi() work uniformly across split/replace/
      // replacementFallback without a caller-side special case.
      feasible: true,
      rangeWidth: range.maxRequiredNi - range.minRequiredNi,
      midpointDeviation: Math.abs((range.minRequiredNi + range.maxRequiredNi) / 2 - targetNi),
    });
  }

  if (candidates.length === 0) return null;

  // this task's Section 12: 3. smallest DT moved to the new loading point
  // -> 4. wider valid Ni range -> 5. lower absolute midpoint deviation ->
  // 6. deterministic numeric tie-break. (Rules 1/2 -- "all fleet active"/
  // "both loading points >= 6" -- are invariant across every candidate
  // generated above, by construction of the search bounds, so they are
  // not differentiators here.)
  candidates.sort((a, b) => (
    a.newDomeUnits - b.newDomeUnits
    || b.rangeWidth - a.rangeWidth
    || a.midpointDeviation - b.midpointDeviation
    || a.newDomeUnits - b.newDomeUnits
  ));

  return candidates[0];
}

// ============================================================
// CONTRACTOR CONTINUITY PLAN (this task's Sections 6/16/21/25) --
// orchestrates the full decision hierarchy for ONE already-selected
// candidate. Returns one plan per Contractor whose standbyRatio > 0 OR
// which has an invalid (1-5 DT) active loading point (V2.5.1, this task's
// Sections 5/7/22 -- a bad 34/1 split has standbyRatio 0% and would
// otherwise never reach a plan at all), covering the whole tier range
// (minor/moderate/critical) so callers never need a second lookup for
// "is this Contractor fine".
// ============================================================
export function deriveContractorContinuityPlan({ candidate, targetNi, tolerance }) {
  const metrics = calculateContractorStandbyMetrics(candidate.sources);
  return metrics
    .filter((metric) => metric.standbyRatio > 0 || metric.hasInvalidLoadingPoint)
    .map((metric) => buildContractorPlan(metric, candidate.sources, targetNi, tolerance));
}

// Every OTHER source's fixed (already-selected-candidate) contribution --
// i.e. every source that does NOT belong to `excludeContractorKey`. Used
// as the "other, already-fixed" side of calculateRequiredNiRange()'s
// equation when this Contractor's own material is the one being
// split/replaced.
function computeOtherContribution(allSources, excludeContractorKey) {
  let otherWeightedNi = 0;
  let otherTonnage = 0;
  allSources.forEach((source) => {
    if (normalizeKey(source.contractor) === excludeContractorKey) return;
    otherWeightedNi += source.ni * source.cycleTonnage;
    otherTonnage += source.cycleTonnage;
  });
  return { otherWeightedNi, otherTonnage };
}

function buildContractorPlan(metric, allSources, targetNi, tolerance) {
  const base = {
    contractor: metric.contractor,
    totalAssignedFleet: metric.totalAssignedFleet,
    loadingPointCount: metric.loadingPointCount,
    standbyUnits: metric.standbyUnits,
    standbyRatio: metric.standbyRatio,
    tier: metric.tier,
  };

  // <=5%: a minor, operationally acceptable reduction -- never a
  // mitigation search, just the explicit REDUCE quantity (this task's
  // Sections 3/4). Guarded by `!hasInvalidLoadingPoint` (V2.5.1, this
  // task's Section 25): a small aggregate standby ratio never shortcuts
  // past an active 1-5 DT loading point sitting somewhere in this
  // Contractor's own sources -- that always needs the full SPLIT/REPLACE
  // mitigation search below instead, regardless of how small the
  // Contractor-level percentage looks.
  if (metric.tier === 'minor' && !metric.hasInvalidLoadingPoint) {
    return { ...base, strategy: 'REDUCE', reduceUnits: metric.standbyUnits };
  }

  const contractorKey = normalizeKey(metric.contractor);
  const { otherWeightedNi, otherTonnage } = computeOtherContribution(allSources, contractorKey);

  // ---- ONE current loading point (this task's Sections 9-17) ----------
  if (metric.loadingPointCount === 1) {
    const existingSource = metric.sources.find((s) => s.assignedUnits > 0);
    const splitPlan = findSplitLoadingPlan({
      totalFleet: metric.totalAssignedFleet,
      existingDomeNi: existingSource.ni,
      tonnesPerUnit: existingSource.tonnesPerUnit,
      otherWeightedNi,
      otherTonnage,
      targetNi,
      tolerance,
    });
    // Always ALSO compute the full-replacement fallback (this task's
    // Section 16) -- the application never knows whether a second
    // excavator/loading point can actually be opened, so both the SPLIT
    // primary and the REPLACE fallback are offered together whenever
    // SPLIT is geometrically/chemically possible.
    const replacementRange = calculateRequiredNiRange({
      otherWeightedNi,
      otherTonnage,
      newUnits: metric.totalAssignedFleet,
      tonnesPerUnit: existingSource.tonnesPerUnit,
      targetNi,
      tolerance,
    });

    if (splitPlan) {
      return {
        ...base,
        strategy: 'SPLIT',
        existingPileId: existingSource.pileId,
        tonnesPerUnit: existingSource.tonnesPerUnit,
        split: splitPlan,
        replacementFallback: replacementRange.feasible ? replacementRange : null,
      };
    }
    if (replacementRange.feasible) {
      return { ...base, strategy: 'REPLACE', existingPileId: existingSource.pileId, replacement: replacementRange };
    }
    return { ...base, strategy: 'CONFLICT' };
  }

  // ---- Multiple current loading points (this task's Sections 18-21) ---
  // The physical candidate search already explored every integer
  // reallocation across THIS Contractor's own existing sources (see this
  // file's header comment); the new contractor-continuity-aware ranking
  // (recommendation-ranking.js) already prefers whichever within-tolerance
  // outcome keeps this Contractor's existing domes fullest. Reaching this
  // branch means the SELECTED candidate still leaves this Contractor above
  // the minor threshold -- i.e. no reallocation among its existing domes
  // achieved a better in-tolerance result -- so the only remaining
  // mitigation is a full-Contractor replacement dome. (A partial
  // reallocate-some/replace-the-remainder mixed plan is a materially
  // harder combined discrete+continuous problem and is intentionally not
  // attempted here -- see this file's own module-level note.)
  const representativeSource = metric.sources
    .slice()
    .sort((a, b) => b.assignedUnits - a.assignedUnits || (a.pileId < b.pileId ? -1 : a.pileId > b.pileId ? 1 : 0))[0];
  const replacementRange = calculateRequiredNiRange({
    otherWeightedNi,
    otherTonnage,
    newUnits: metric.totalAssignedFleet,
    tonnesPerUnit: representativeSource.tonnesPerUnit,
    targetNi,
    tolerance,
  });
  if (replacementRange.feasible) {
    return { ...base, strategy: 'REPLACE', existingPileId: representativeSource.pileId, replacement: replacementRange };
  }
  return { ...base, strategy: 'CONFLICT' };
}

// ============================================================
// USER-FACING LABEL CLASSIFIERS (this task's Sections 4/8/19/22-24) --
// pure mapping from the EXISTING per-source Material/Fleet Action fields
// (recommendation-actions.js's own output, never recomputed here) plus
// this Contractor's continuity plan (or `null` if it has none, i.e. fully
// active) to the NEW user-facing operational vocabulary. Internal
// MATERIAL_ACTION_STOP/`separateUnits` values are untouched upstream
// (this task's Section 4/23 "internal domain values may remain") -- these
// functions only decide what the UI shows.
// ============================================================

// materialAction: one of MATERIAL_ACTION_USE/LIMIT/STOP (recommendation-
// actions.js). Returns 'USE' | 'LIMIT' | 'REPLACE_DOME' | 'STOP' -- 'STOP'
// is returned ONLY when no replacement plan could be derived at all (an
// operational conflict, this task's Section 25/46 "where applicable").
export function classifyMaterialActionLabel(materialAction, continuityPlan) {
  if (materialAction !== 'STOP') return materialAction;
  if (continuityPlan && (continuityPlan.strategy === 'SPLIT' || continuityPlan.strategy === 'REPLACE')) {
    return 'REPLACE_DOME';
  }
  return 'STOP';
}

// fleetAction: { assignedUnits, activeUnits, useUnits, moveOutUnits,
// moveInUnits, separateUnits } (recommendation-actions.js's deriveFleetAction()
// output). Returns one of:
//   'ACTIVE'              -- fully active, no idle fleet, no relocation
//   'MOVE'                -- this source SENDS fleet away (moveOutUnits >
//                            0) and still keeps SOME of its own fleet
//                            active (V2.5.1 correction, this task's
//                            Sections 1/9: a pure RECEIVER must never be
//                            classified MOVE just because it is the
//                            counterpart of someone else's move)
//   'RECEIVE'              -- this source ONLY receives fleet (moveInUnits
//                            > 0, moveOutUnits === 0) -- fleet-allocation.js's
//                            planContractorRelocations() guarantees a
//                            single source is never simultaneously a donor
//                            AND a receiver, so these two checks are
//                            mutually exclusive by construction.
//   'CLOSE_DOME_AND_MOVE' -- 100% of this source's own assigned fleet
//                            relocated to a sibling dome (this task's
//                            Section 19 "DOME CLOSED does NOT mean
//                            CONTRACTOR/FLEET STOPPED")
//   'REDUCE'              -- <=5% Contractor-level standby (Section 4)
//   'SPLIT_LOADING'       -- this Contractor's continuity plan is SPLIT
//   'REPLACE_DOME'        -- this Contractor's continuity plan is REPLACE
//   'CONFLICT'            -- no mitigation could be derived (Section 25)
export function classifyFleetActionLabel(fleetAction, continuityPlan) {
  const { assignedUnits, useUnits, moveOutUnits, moveInUnits, separateUnits } = fleetAction;

  if (assignedUnits > 0 && useUnits === 0 && moveOutUnits === assignedUnits) {
    return 'CLOSE_DOME_AND_MOVE';
  }
  if (moveOutUnits > 0) return 'MOVE';
  if (moveInUnits > 0) return 'RECEIVE';
  if (separateUnits === 0) return 'ACTIVE';

  // separateUnits > 0 here: idle fleet exists at this source that is
  // NEITHER fully relocated away nor part of a partial move -- this is
  // exactly the standby fleet the Contractor's own continuity plan (or
  // lack thereof) explains.
  if (!continuityPlan) return 'ACTIVE';
  if (continuityPlan.strategy === 'REDUCE') return 'REDUCE';
  if (continuityPlan.strategy === 'SPLIT') return 'SPLIT_LOADING';
  if (continuityPlan.strategy === 'REPLACE') return 'REPLACE_DOME';
  return 'CONFLICT';
}
