// Pure Recommendation engine orchestration (V2.4 Phase 3). See
// docs/V2.4_CALCULATE_AND_BLENDING_RECOMMENDATION_ARCHITECTURE.md Sections
// 12-31/36, and this task's Sections 3-19/23/34.
//
// PURE MODULE CONTRACT: no DOM, no router, no i18n, no localStorage, no
// network, no window/document, no license-service dependency. Every
// exported validate*() function returns a stable i18n KEY (or null for
// "valid"), matching calculate-validation.js's own convention -- never a
// localized string. These keys are NOT yet added to js/i18n/locales/*.js:
// this phase has no UI consumer for them (Section 36 of this task
// forbids adding Recommendation UI), so Phase 4 is responsible for adding
// the id/en catalog entries when a UI actually renders them.
//
// PHYSICAL FLEET, NOT CONSUMABLE INVENTORY (this task's Sections 3/6):
// `units` on a Recommendation source means the physical reusable DT/fleet
// currently assigned to that source -- never a one-shot load count. This
// module never decrements a "remaining" counter and never derives a
// maximum-cycles figure from a physical DT count.
//
// NO Material Action (USE/LIMIT/STOP), NO Planned Blend Recovery, NO
// Recommendation UI -- all deliberately out of scope for this phase (this
// task's Section 2).
import { classifyOre } from '../../shared/ore-classification.js';
import {
  validatePileId,
  validateContractor,
  validateNi,
  validateUnits,
  validateTonnesPerUnit,
  normalizeSourceIdentity,
} from './calculate-validation.js';
// Locale-aware decimal parsing (V2.4.1 Bug A, this task's Section 7) --
// Target Ni/Tolerance and each source's Ni/Tonnes-per-DT are all DECIMAL
// fields, so "1,120"/"0,010" must parse identically to "1.120"/"0.010".
import { parseDecimalInput } from './number-input.js';
import {
  simplifyUnitRatio,
  calculateTonnageRatio,
  groupSourcesByContractor,
  countOperationalAllocations,
  enumerateOperationalAllocations,
  planContractorRelocations,
  MAX_ALLOCATIONS_PER_CONTRACTOR,
  MIN_UNITS_PER_ACTIVE_LOADING_POINT,
} from './fleet-allocation.js';
import {
  compareWithinTolerance,
  compareBestAttainable,
  criticalContractorCount,
  worstContractorStandbyRatio,
  contractorsRequiringMitigationCount,
  fullyUnusedLoadingPointCount,
} from './recommendation-ranking.js';
// V3.0 Phase 4C ranking-prefix pruning (see that section below) reuses the
// SAME critical/mitigation threshold constants recommendation-ranking.js's
// per-Contractor tier classification is built on (via
// calculateContractorStandbyMetrics()/classifyStandbyTier() there), rather
// than inventing a second copy of the 0.05/0.50 boundaries.
import { CRITICAL_STANDBY_RATIO, MINOR_STANDBY_RATIO } from './operational-continuity.js';
// V3.0 Phase 7A -- hard-case (prefix-lock + MITM) exact solver, dispatched
// to below ONLY when the normal engine's own generation-time gate rejects a
// Contractor group (SEARCH_SPACE_TOO_LARGE) or its traversal exhausts
// MAX_SEARCH_NODES (SEARCH_INCOMPLETE) -- see dispatchHardCase() below and
// exact-hardcase-solver.js's own header for the full fallback contract.
// Deliberate circular import (that module imports several business-logic
// functions back from this file) -- safe under ESM live bindings since
// every use on both sides is deferred to function-call time, never module
// top-level evaluation.
import { runHardCaseSearch } from './exact-hardcase-solver.js';

// Gate A decision (architecture doc Section 16.1/41, this task's Section
// 15): default ±0.010% Ni, user-editable in a future UI (step 0.001,
// minimum 0). This constant is exported for that future UI to seed its
// input with -- calculation itself never silently overrides a caller-
// provided valid tolerance.
export const DEFAULT_RECOMMENDATION_TOLERANCE = 0.010;

// Representation-noise-only guard for the tolerance-boundary comparison
// (this task's Section 15/16) -- NEVER widens the business tolerance
// itself. Only absorbs floating-point summation noise at the ~1e-9 scale;
// a candidate genuinely 0.0001 outside tolerance is still rejected.
const FLOAT_EPSILON = 1e-9;

const HIGHER_GRADE_CLASSES = new Set(['HGLO', 'MGLO']);

// ============================================================
// VALIDATION (architecture doc Section 29, this task's Section 34)
// ============================================================

export function validateTargetNi(targetNi) {
  if (targetNi === '' || targetNi === null || targetNi === undefined) return 'calculate.validation.targetNiRequired';
  const value = parseDecimalInput(targetNi);
  if (!Number.isFinite(value)) return 'calculate.validation.targetNiInvalid';
  if (!(value > 0)) return 'calculate.validation.targetNiPositive';
  return null;
}

export function validateTolerance(tolerance) {
  if (tolerance === '' || tolerance === null || tolerance === undefined) return 'calculate.validation.toleranceRequired';
  const value = parseDecimalInput(tolerance);
  if (!Number.isFinite(value)) return 'calculate.validation.toleranceInvalid';
  if (value < 0) return 'calculate.validation.toleranceNonNegative';
  return null;
}

// Per-source field validation reuses calculate-validation.js's Blend-mode
// validators byte-for-byte (Pile ID/Contractor/Ni/units/tonnesPerUnit
// rules are identical between Blend and Recommendation -- only the MEANING
// of `units` differs, which is a semantic/documentation distinction, not a
// different validation rule). This also keeps Recommendation from
// introducing a second independent validation-rule copy, the same
// discipline already applied to ore classification (architecture doc
// Section 11). Duplicate detection uses the same composite Pile ID +
// Contractor identity as Blend (this task's Section 9/10) -- "L30/MRP"
// and "L30/TII" are distinct sources, never merged.
export function validateRecommendationSources(sources) {
  const seen = [];
  const sourceErrors = sources.map((source) => {
    const pileIdError = validatePileId(source.pileId, source.contractor, seen);
    if (!pileIdError) seen.push(normalizeSourceIdentity(source.pileId, source.contractor));
    return {
      pileId: pileIdError,
      contractor: validateContractor(source.contractor),
      ni: validateNi(source.ni),
      units: validateUnits(source.units),
      tonnesPerUnit: validateTonnesPerUnit(source.tonnesPerUnit),
    };
  });

  const hasFieldErrors = sourceErrors.some((e) => e.pileId || e.contractor || e.ni || e.units || e.tonnesPerUnit);

  let fleetError = null;
  if (!hasFieldErrors) {
    const totalFleet = sources.reduce((sum, s) => sum + Number(s.units), 0);
    if (!(totalFleet > 0)) fleetError = 'calculate.validation.noPhysicalFleet';
  }

  return { sourceErrors, fleetError, valid: !hasFieldErrors && !fleetError };
}

function toNumericSource(source) {
  const ni = parseDecimalInput(source.ni);
  return {
    pileId: source.pileId.trim(),
    contractor: source.contractor.trim(),
    ni,
    assignedUnits: Number(source.units),
    tonnesPerUnit: parseDecimalInput(source.tonnesPerUnit),
    oreClass: classifyOre(ni),
  };
}

// Exported so callers/tests can exercise the exact boundary-comparison
// arithmetic (this task's Section 15/16/33) without needing a full search.
// Inclusive comparison using unrounded internal precision, per architecture
// doc Section 16.1: `abs(EstimatedNi - TargetNi) <= Tolerance`.
export function isWithinTolerance(estimatedNi, targetNi, tolerance) {
  return Math.abs(estimatedNi - targetNi) <= tolerance + FLOAT_EPSILON;
}

// ============================================================
// CANDIDATE CONSTRUCTION (this task's Section 4/12-13/17)
// ============================================================

// groups: groupSourcesByContractor() output (canonical Contractor-then-
// Pile-ID order). activeBySourceKey: Map<normalizeSourceIdentity(pileId,
// contractor), activeUnits> for THIS candidate -- keyed by the COMPOSITE
// Pile ID + Contractor identity, never Pile ID alone (this task's Section
// 9/10: "L30/MRP" and "L30/TII" must remain distinct here; a Pile-ID-only
// key would let the second Contractor's allocation silently overwrite the
// first's in this Map once sources are combined across Contractor groups).
// Returns null for the excluded all-zero allocation (this task's Section
// 19) or for any candidate that fails a defensive (structurally
// unreachable once totalActiveUnits > 0) invariant check.
//
// Exported (V3.0 Phase 4C) so tests/v3-phase4c-ranking-bound.test.mjs's
// proof pass can materialize the EXACT SAME candidate shape production
// uses for an arbitrary (fixed-prefix + independently-enumerated
// completion) combination, and run it through the REAL compareWithinTolerance
// comparator -- never a re-implemented copy of candidate construction.
export function buildCandidate(groups, activeBySourceKey, targetNi, tolerance) {
  let totalActiveUnits = 0;
  activeBySourceKey.forEach((v) => { totalActiveUnits += v; });
  if (totalActiveUnits === 0) return null;

  const flatSources = [];
  const relocations = [];

  groups.forEach((group) => {
    const contractorGroup = group.sources.map((s) => ({
      pileId: s.pileId,
      contractor: s.contractor,
      assignedUnits: s.assignedUnits,
      activeUnits: activeBySourceKey.get(normalizeSourceIdentity(s.pileId, s.contractor)),
    }));
    const { relocations: groupRelocations, perSource } = planContractorRelocations(contractorGroup);
    relocations.push(...groupRelocations);

    group.sources.forEach((s) => {
      const activeUnits = activeBySourceKey.get(normalizeSourceIdentity(s.pileId, s.contractor));
      // perSource (fleet-allocation.js's planContractorRelocations()) is
      // keyed by Pile ID alone, which is safe here ONLY because
      // contractorGroup is already scoped to ONE Contractor -- duplicate
      // validation guarantees Pile ID is unique within a single
      // Contractor's own sources.
      const moves = perSource.get(s.pileId);
      flatSources.push({
        pileId: s.pileId,
        contractor: s.contractor,
        oreClass: s.oreClass,
        ni: s.ni,
        tonnesPerUnit: s.tonnesPerUnit,
        assignedUnits: s.assignedUnits,
        activeUnits,
        cycleTonnage: activeUnits * s.tonnesPerUnit,
        moveInUnits: moves.moveInUnits,
        moveOutUnits: moves.moveOutUnits,
        standbyUnits: moves.standbyUnits,
      });
    });
  });

  const totalFleetUnits = flatSources.reduce((sum, s) => sum + s.assignedUnits, 0);
  const totalTonnage = flatSources.reduce((sum, s) => sum + s.cycleTonnage, 0);
  // Defensive only -- cannot occur once totalActiveUnits > 0, since every
  // source's tonnesPerUnit is validated > 0 (Section 34).
  if (!(totalTonnage > 0)) return null;

  // Full-precision accumulation, division exactly once (architecture doc
  // Section 14's "never round a pile's contribution before summing").
  const estimatedNiNumerator = flatSources.reduce((sum, s) => sum + s.ni * s.cycleTonnage, 0);
  const estimatedNi = estimatedNiNumerator / totalTonnage;

  const higherSources = flatSources.filter((s) => HIGHER_GRADE_CLASSES.has(s.oreClass));
  const lgloSources = flatSources.filter((s) => s.oreClass === 'LGLO');
  const higherGradeUnits = higherSources.reduce((sum, s) => sum + s.activeUnits, 0);
  const lgloUnits = lgloSources.reduce((sum, s) => sum + s.activeUnits, 0);
  const higherGradeTonnage = higherSources.reduce((sum, s) => sum + s.cycleTonnage, 0);
  const lgloTonnage = lgloSources.reduce((sum, s) => sum + s.cycleTonnage, 0);

  const unitRatio = simplifyUnitRatio(higherGradeUnits, lgloUnits);
  // Defensive only -- cannot occur once totalActiveUnits > 0 (every active
  // source is either Higher Grade or LGLO, so higher+lglo > 0).
  if (!unitRatio) return null;

  const tonnageRatio = calculateTonnageRatio(higherGradeTonnage, lgloTonnage);

  const deviation = estimatedNi - targetNi;
  const absoluteDeviation = Math.abs(deviation);
  const withinTolerance = isWithinTolerance(estimatedNi, targetNi, tolerance);

  const totalSurplusUnits = totalFleetUnits - totalActiveUnits;
  const totalMovedUnits = relocations.reduce((sum, r) => sum + r.units, 0);
  const activeSourceCount = flatSources.filter((s) => s.activeUnits > 0).length;

  // Deterministic normalized-Contractor+Pile-ID+activeUnits tie-break
  // signature (this task's Section 20 rule 7 / Section 23 rule 6) --
  // flatSources is already in canonical order (groups/each group's
  // sources were pre-sorted by groupSourcesByContractor()).
  const allocationSignature = flatSources
    .map((s) => `${s.contractor.trim().toLowerCase()}|${s.pileId.trim().toLowerCase()}|${s.activeUnits}`)
    .join(';');

  relocations.sort((a, b) => {
    const ka = `${a.contractor}|${a.fromPileId}|${a.toPileId}`;
    const kb = `${b.contractor}|${b.fromPileId}|${b.toPileId}`;
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });

  return {
    estimatedNi,
    targetNi,
    tolerance,
    deviation,
    absoluteDeviation,
    withinTolerance,

    totalFleetUnits,
    totalActiveUnits,
    totalSurplusUnits,
    fleetUtilization: totalActiveUnits / totalFleetUnits,

    totalTonnage,

    higherGradeUnits,
    lgloUnits,
    higherGradeTonnage,
    lgloTonnage,

    unitRatio,
    tonnageRatio,

    sources: flatSources,
    relocations,
    totalMovedUnits,
    activeSourceCount,
    allocationSignature,
  };
}

// ============================================================
// V3.0 Phase 4A/4B -- EXACT chemistry-bound pruning (docs/
// V3.0_SCALABLE_RECOMMENDATION_ENGINE_ARCHITECTURE.md Sections 20/23).
//
// PROOF OF CONSERVATIVENESS (must hold for every partial node, proven by
// tests/v3-phase4a-chemistry-bound.test.mjs and
// tests/v3-phase4b-chemistry-bound.test.mjs): once some Contractor groups
// are decided and others are still open, the final blend Ni is
//
//   finalNi = (fixedNumerator + Sum openGroupNumerator_i)
//           / (fixedTonnage   + Sum openGroupTonnage_i)
//
// i.e. a WEIGHTED AVERAGE of the fixed portion's own Ni (fixedNumerator /
// fixedTonnage, weight fixedTonnage) and, for each still-open group, that
// group's own achieved average Ni (weight = whatever tonnage that group
// ends up contributing, 0..groupMaxTonnage_i). Phase 4A stopped here and
// bounded the weights as completely unconstrained (0..Infinity), which
// yields a correct but LOOSE bound: minFinalNi/maxFinalNi collapse to the
// pooled open-group Ni extent as soon as ANY fixed prefix exists, because
// an unbounded weight can always be imagined to overwhelm the fixed
// portion.
//
// V3.0 Phase 4B TIGHTENING: each open group's own achievable tonnage is
// NOT actually unbounded -- feasible allocations only ever place up to
// that group's own physical fleet on its single highest-tonnesPerUnit
// source (enumerateOperationalAllocations() allows one active source to
// take the group's ENTIRE fleet), so
//
//   groupMaxTonnage_i = fleet_i >= MIN_UNITS_PER_ACTIVE_LOADING_POINT
//                        ? fleet_i * max(tonnesPerUnit over group i's sources)
//                        : 0   (fleet_i < 6 -- EVERY source in this group is
//                               structurally forced to 0 active units, so the
//                               group can only ever contribute (0, 0))
//
// is a proven exact ceiling on group i's own achievable tonnage. Pooling
// every still-open group's own (minNi, maxNi, groupMaxTonnage) gives one
// aggregate open "budget": total open tonnage T_agg is confined to
// [0, maxOpenTonnage] (maxOpenTonnage = Sum groupMaxTonnage_i over open
// groups), and the corresponding open numerator W_agg is confined to
// [T_agg * pooledMinNi, T_agg * pooledMaxNi] (pooledMinNi/pooledMaxNi being
// the SAME Phase 4A per-group-Ni-extent pooling as before -- this box is a
// RELAXATION/superset of the true achievable (T_agg, W_agg) region, so
// bounding over it stays conservative).
//
// finalNi(T_agg) = (fixedNumerator + a*T_agg) / (fixedTonnage + T_agg), for
// a in {pooledMinNi, pooledMaxNi}, is a Mobius function of T_agg whose
// derivative sign (a*fixedTonnage - fixedNumerator, over (fixedTonnage +
// T_agg)^2) does NOT depend on T_agg -- so it is monotonic across the whole
// [0, maxOpenTonnage] interval, meaning its min/max over that interval is
// always attained at one of the two ENDPOINTS (T_agg=0, giving exactly
// fixedNi; or T_agg=maxOpenTonnage). Evaluating both endpoints and taking
// min/max is therefore exact for the relaxed box, hence still a valid
// (possibly loose, NEVER too narrow) outer bound on the true finalNi:
//
//   minFinalNi = min( fixedNi, (fixedNumerator + pooledMinNi*maxOpenTonnage)
//                              / (fixedTonnage + maxOpenTonnage) )
//   maxFinalNi = max( fixedNi, (fixedNumerator + pooledMaxNi*maxOpenTonnage)
//                              / (fixedTonnage + maxOpenTonnage) )
//
// As maxOpenTonnage -> Infinity this collapses back to Phase 4A's original
// pooled-extent-only bound (sanity limit, never asserted with literal
// Infinity since that divides Infinity/Infinity in floating point --
// maxOpenTonnage is always a real finite ceiling derived from actual
// fleet/tonnesPerUnit numbers). When maxOpenTonnage is 0 (every remaining
// open group's own fleet is below the 6 DT minimum), no open group can
// EVER contribute nonzero tonnage from this node, so finalNi is pinned
// EXACTLY at fixedNi -- the tightest possible bound, a single point.
// ============================================================

// Per-group source Ni extremes (pure). `sources` are already-numeric
// (toNumericSource() output) -- called once per group per search, not per
// node, since a group's OWN sources never change mid-search.
export function groupSourceNiExtent(sources) {
  let minNi = Infinity;
  let maxNi = -Infinity;
  sources.forEach((s) => {
    if (s.ni < minNi) minNi = s.ni;
    if (s.ni > maxNi) maxNi = s.ni;
  });
  return { minNi, maxNi };
}

function combineExtents(a, b) {
  return { minNi: Math.min(a.minNi, b.minNi), maxNi: Math.max(a.maxNi, b.maxNi) };
}

// Exact ceiling on ONE group's own achievable tonnage (any feasible
// allocation, any nonzero one included) -- see the Phase 4B derivation
// above. `sources` need only `tonnesPerUnit`; `fleet` is that group's own
// total physical DT (Sum of assignedUnits). Exported so both production and
// the bound-proof test (which independently exhausts every feasible
// allocation) call the EXACT SAME formula, never a re-implemented copy.
export function groupMaxAchievableTonnage(fleet, sources) {
  if (fleet < MIN_UNITS_PER_ACTIVE_LOADING_POINT) return 0;
  let maxTonnesPerUnit = 0;
  sources.forEach((s) => {
    if (s.tonnesPerUnit > maxTonnesPerUnit) maxTonnesPerUnit = s.tonnesPerUnit;
  });
  return fleet * maxTonnesPerUnit;
}

// suffixBounds[i] = the combined (minNi, maxNi, maxOpenTonnage) across
// groups [i .. groups.length), i.e. "every group not yet decided at depth
// i". suffixBounds[groups.length] = {Infinity, -Infinity, 0} (no open
// groups -- never consulted for pruning, since a bound check only ever
// runs when groupIndex < groups.length, at which point group[groupIndex]
// itself is always open and contributes finite extremes). Computed once per
// search (V3.0 Phase 4B "CACHE CONTRACTOR BOUNDS" -- never recomputed per
// node), same cost shape as Phase 4A's suffixExtents.
// `searchOrder` (V3.0 Phase 6A -- see that section below) is an array of
// CANONICAL group indices giving the TRAVERSAL order; suffixBounds[i] is
// therefore "every group not yet decided at DEPTH i", i.e. groups
// searchOrder[i..n). Passing the canonical identity order (searchOrder[i]
// === i) reproduces Phase 4B's original canonical-order behavior exactly.
function computeSuffixBounds(groups, searchOrder) {
  const n = searchOrder.length;
  const suffixBounds = new Array(n + 1);
  suffixBounds[n] = { minNi: Infinity, maxNi: -Infinity, maxOpenTonnage: 0 };
  for (let i = n - 1; i >= 0; i -= 1) {
    const group = groups[searchOrder[i]];
    const fleet = group.sources.reduce((sum, s) => sum + s.assignedUnits, 0);
    const extent = combineExtents(groupSourceNiExtent(group.sources), suffixBounds[i + 1]);
    const maxOpenTonnage = groupMaxAchievableTonnage(fleet, group.sources) + suffixBounds[i + 1].maxOpenTonnage;
    suffixBounds[i] = { minNi: extent.minNi, maxNi: extent.maxNi, maxOpenTonnage };
  }
  return suffixBounds;
}

// Pure bound function -- see the proof above this section. `openBound` is
// {minNi, maxNi, maxOpenTonnage} for every still-open group (suffixBounds[i]
// above). Exported so the bound-proof test exercises the EXACT function
// production uses, never a re-implemented copy.
export function conservativeFinalNiBound(fixedNumerator, fixedTonnage, openBound) {
  const { minNi, maxNi, maxOpenTonnage } = openBound;
  if (fixedTonnage <= 0) return { minNi, maxNi };

  const fixedNi = fixedNumerator / fixedTonnage;
  if (maxOpenTonnage <= 0) return { minNi: fixedNi, maxNi: fixedNi };

  const totalTonnage = fixedTonnage + maxOpenTonnage;
  const minEndpointNi = (fixedNumerator + minNi * maxOpenTonnage) / totalTonnage;
  const maxEndpointNi = (fixedNumerator + maxNi * maxOpenTonnage) / totalTonnage;
  return {
    minNi: Math.min(fixedNi, minEndpointNi),
    maxNi: Math.max(fixedNi, maxEndpointNi),
  };
}

// Reuses the SAME FLOAT_EPSILON as isWithinTolerance() so a branch is
// never pruned for a target that a completed candidate would itself still
// accept as within-tolerance (representation-noise-only guard, never a
// business-tolerance widening -- see FLOAT_EPSILON's own comment).
export function boundIntersectsTolerance(bound, targetNi, tolerance) {
  const low = targetNi - tolerance - FLOAT_EPSILON;
  const high = targetNi + tolerance + FLOAT_EPSILON;
  return bound.maxNi >= low && bound.minNi <= high;
}

// ============================================================
// V3.0 Phase 4B -- EXACT search ordering (docs/
// V3.0_SCALABLE_RECOMMENDATION_ENGINE_ARCHITECTURE.md Section 20/23's
// "traversal order may change only to find a strong incumbent earlier").
//
// This ONLY reorders each Contractor group's OWN allocation array -- it
// never discards, merges, or invents an allocation, never changes
// candidateCount (operationalCandidateSpaceSize() below only ever reads
// .length), and never participates in the pruning decision itself
// (conservativeFinalNiBound/boundIntersectsTolerance above are computed
// identically regardless of visit order). It exists purely so a
// within-tolerance incumbent tends to stream through EARLIER, which lets
// pruningGate.active flip to true sooner and gives chemistry pruning more
// of the traversal to actually work with.
//
// Composite deterministic sort key per allocation, applied once per
// Contractor group at search setup (never recomputed per node):
//   1. higher fleet utilization first (activeUnits / fleet, descending) --
//      a fuller allocation is a more "operationally realistic" candidate.
//   2. lower standby (idle) units first, ascending -- fleet - activeUnits;
//      for a single group this tracks utilization exactly (same
//      information, kept as an explicit secondary key per spec).
//   3. chemistry contribution closer to target direction first -- this
//      allocation's OWN weighted-average Ni (numerator/tonnage), ascending
//      distance from targetNi; the all-zero allocation (tonnage 0, no
//      defined average) sorts last via +Infinity distance.
//   4. canonical lexicographic order of the allocation tuple itself, so
//      ties are resolved the SAME way regardless of the JS engine's
//      Array#sort stability guarantees -- required for "same input
//      remains deterministic" across environments.
// ============================================================
function allocationOrderKey(allocation, sources, fleet, targetNiValue) {
  let activeUnits = 0;
  let numerator = 0;
  let tonnage = 0;
  allocation.forEach((v, i) => {
    activeUnits += v;
    const t = v * sources[i].tonnesPerUnit;
    tonnage += t;
    numerator += sources[i].ni * t;
  });
  return {
    utilization: fleet > 0 ? activeUnits / fleet : 0,
    standby: fleet - activeUnits,
    chemDistance: tonnage > 0 ? Math.abs(numerator / tonnage - targetNiValue) : Infinity,
  };
}

// Exported so tests can assert the ordering directly (production applies
// this once per group inside prepareSearch()/prepareSearchUnbounded() below,
// never per node).
export function orderAllocationsForSearch(group, allocations, targetNiValue) {
  const fleet = group.sources.reduce((sum, s) => sum + s.assignedUnits, 0);
  return allocations
    .map((allocation) => ({ allocation, key: allocationOrderKey(allocation, group.sources, fleet, targetNiValue) }))
    .sort((a, b) => {
      if (b.key.utilization !== a.key.utilization) return b.key.utilization - a.key.utilization;
      if (a.key.standby !== b.key.standby) return a.key.standby - b.key.standby;
      if (a.key.chemDistance !== b.key.chemDistance) return a.key.chemDistance - b.key.chemDistance;
      const aKey = a.allocation.join(',');
      const bKey = b.allocation.join(',');
      return aKey < bKey ? -1 : aKey > bKey ? 1 : 0;
    })
    .map((entry) => entry.allocation);
}

// ============================================================
// V3.0 Phase 4C -- EXACT ranking-prefix pruning (docs/
// V3.0_SCALABLE_RECOMMENDATION_ENGINE_ARCHITECTURE.md Section 20's
// compareWithinTolerance rule chain).
//
// Phase 4A/4B chemistry pruning only discards a branch whose Ni is
// provably unreachable. Once a within-tolerance incumbent already exists,
// a second, INDEPENDENT reason to discard a branch is available: even if
// every remaining open Contractor group is completed in the single most
// favorable way possible, the resulting candidate still cannot outrank the
// incumbent under compareWithinTolerance's rule chain (recommendation-
// ranking.js: 0 invalidLoadingPointCount, A criticalContractorCount, B
// totalActiveUnits, C worstContractorStandbyRatio, D
// contractorsRequiringMitigationCount, E fullyUnusedLoadingPointCount,
// F..J unbounded here).
//
// PROOF (multi-key lexicographic domination -- must hold for every
// partial node, re-verified exhaustively by
// tests/v3-phase4c-ranking-bound.test.mjs): groups are decided
// independently of one another (the search is a plain Cartesian product
// across Contractor groups, and every rule A-E below is either a per-
// Contractor-group quantity summed/maxed across groups, or additive
// across groups) -- so for rules A/B/D/E (each a SUM over groups of a
// per-group quantity) and rule C (a MAX over groups of a per-group
// quantity), the single best achievable value of that rule ACROSS THE
// WHOLE BRANCH is obtained by independently optimizing EACH remaining
// open group for that one rule alone (no group's choice constrains any
// other group's own optimum for the same rule, since compareContractor
// Standby metrics are computed per-Contractor and Contractor groups here
// are exactly fleet-allocation.js's groupSourcesByContractor() groups --
// one group IS one Contractor). This is what
// conservativeRankingBound() below computes: the DECIDED (fixed) groups'
// exact contribution plus, for each rule, the sum/max of each remaining
// open group's own best-case contribution (independently chosen per rule,
// not required to share one single completion across rules).
//
// This composite "best of all worlds" value is therefore an OPTIMISTIC
// bound on what ANY single real completion could achieve at each
// individual rule (a real completion's actual value at rule i can never
// beat -- only tie or fall short of -- this bound, since the bound already
// assumes independently-optimal per-group choices). Given that,
// boundCannotBeatIncumbent() below applies the SAME rule ordering
// compareWithinTolerance uses: walk rules A..E in order; the first rule
// where the bound is not tied with the incumbent's actual value decides
// the outcome -- if the bound is strictly WORSE there, every real
// completion is provably tied-or-worse at every earlier rule (their
// actual values can never beat a bound that already ties/loses) and
// strictly worse at this one, so the branch can never lexicographically
// beat the incumbent: PRUNE. If the bound is strictly BETTER there, some
// real completion might still beat the incumbent at this rule (the bound
// does not prove otherwise): do not prune. If every rule A..E ties at the
// bound, no conclusion is drawn (rules F..J are intentionally left
// unbounded, per this task's scope) -- do not prune.
//
// Reused ONLY while pruningGate.active is true (an actual within-tolerance
// incumbent already exists) -- see forEachCandidatePruned()'s own gate
// check, identical in spirit to the chemistry bound's gate. Before that,
// TARGET_NOT_ACHIEVABLE's exhaustive bestAttainable traversal is
// untouched, exactly like Phase 4A/4B (this task's Section 5).
// ============================================================

// Rule-0 (invalidLoadingPointCount) is deliberately NOT bounded here: V3.0
// Phase 2 already makes 0-or->=6 a GENERATION-time feasibility rule (see
// fleet-allocation.js's enumerateOperationalAllocations()), so every
// candidate this search can ever complete -- branch or incumbent alike --
// has invalidLoadingPointCount exactly 0. Rule 0 therefore never
// distinguishes any two candidates this engine produces; adding a bound
// for it would be dead code, not a stronger prune.

// Per-group, per-allocation rank-relevant metrics (pure). `group` is one
// Contractor's own { sources } (fleet-allocation.js's groupSourcesByContractor()
// entry); `allocation` is one of that group's own enumerateOperationalAllocations()
// tuples (activeUnits per source, same index order as group.sources).
function allocationRankMetrics(group, allocation, fleet) {
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

// One group's own best-case contribution to each rule, independently
// optimized PER RULE (see the proof above for why that is sound) --
// scanned once per group over its own already-enumerated allocation set
// (perContractorAllocations[i], the EXACT set combine() below iterates
// over -- never a re-generated or re-filtered copy).
function computeGroupRankProfile(group, allocations) {
  const fleet = group.sources.reduce((sum, s) => sum + s.assignedUnits, 0);
  let maxActiveUnits = 0;
  let minStandbyRatio = Infinity;
  let minCriticalCount = 1;
  let minMitigationCount = 1;
  let minFullyUnusedCount = Infinity;

  allocations.forEach((allocation) => {
    const m = allocationRankMetrics(group, allocation, fleet);
    if (m.activeUnits > maxActiveUnits) maxActiveUnits = m.activeUnits;
    if (m.standbyRatio < minStandbyRatio) minStandbyRatio = m.standbyRatio;
    if (!m.isCritical) minCriticalCount = 0;
    if (!m.requiresMitigation) minMitigationCount = 0;
    if (m.fullyUnusedCount < minFullyUnusedCount) minFullyUnusedCount = m.fullyUnusedCount;
  });

  return { maxActiveUnits, minStandbyRatio, minCriticalCount, minMitigationCount, minFullyUnusedCount };
}

// suffixRankBounds[i] = the pooled best-case contribution of every group
// NOT YET decided at depth i (groups[i..end)), one aggregate per rule.
// Computed once per search (never per node), same cost shape/contract as
// Phase 4B's computeSuffixBounds() above. suffixRankBounds[groups.length]
// is the empty-contribution identity (no open groups left).
// `searchOrder` -- see computeSuffixBounds()'s own comment; the SAME
// permutation must be used for both bound arrays within one search so
// depth `i` means the same "still open" set in each.
function computeSuffixRankBounds(groups, perContractorAllocations, searchOrder) {
  const n = searchOrder.length;
  const profiles = groups.map((group, i) => computeGroupRankProfile(group, perContractorAllocations[i]));
  const suffixRankBounds = new Array(n + 1);
  suffixRankBounds[n] = { minCriticalCount: 0, maxActiveUnits: 0, minWorstRatio: 0, minMitigationCount: 0, minFullyUnusedCount: 0 };
  for (let i = n - 1; i >= 0; i -= 1) {
    const p = profiles[searchOrder[i]];
    const rest = suffixRankBounds[i + 1];
    suffixRankBounds[i] = {
      minCriticalCount: p.minCriticalCount + rest.minCriticalCount,
      maxActiveUnits: p.maxActiveUnits + rest.maxActiveUnits,
      minWorstRatio: Math.max(p.minStandbyRatio, rest.minWorstRatio),
      minMitigationCount: p.minMitigationCount + rest.minMitigationCount,
      minFullyUnusedCount: p.minFullyUnusedCount + rest.minFullyUnusedCount,
    };
  }
  return suffixRankBounds;
}

// Combines the DECIDED groups' exact running totals (`fixed`, threaded
// through combine() below) with the still-open groups' pooled best case
// (`openBound`, suffixRankBounds[groupIndex]) into one optimistic
// composite -- see the proof above for why this composite is a valid
// per-rule upper/lower bound even though it is not necessarily achieved by
// any single real completion.
export function conservativeRankingBound(fixed, openBound) {
  return {
    bestCriticalContractorCount: fixed.criticalCount + openBound.minCriticalCount,
    bestTotalActiveUnits: fixed.activeUnits + openBound.maxActiveUnits,
    bestWorstContractorStandbyRatio: Math.max(fixed.worstRatio, openBound.minWorstRatio),
    bestContractorsRequiringMitigationCount: fixed.mitigationCount + openBound.minMitigationCount,
    bestFullyUnusedLoadingPointCount: fixed.fullyUnusedCount + openBound.minFullyUnusedCount,
  };
}

// Exact incumbent-side metrics -- computed ONCE per new incumbent (never
// per node), reusing recommendation-ranking.js's OWN rule functions
// (never a re-implemented copy) so the pruning bound is always compared
// against exactly what compareWithinTolerance would compute for the same
// candidate.
export function incumbentRankingMetrics(candidate) {
  return {
    criticalContractorCount: criticalContractorCount(candidate),
    totalActiveUnits: candidate.totalActiveUnits,
    worstContractorStandbyRatio: worstContractorStandbyRatio(candidate),
    contractorsRequiringMitigationCount: contractorsRequiringMitigationCount(candidate),
    fullyUnusedLoadingPointCount: fullyUnusedLoadingPointCount(candidate),
  };
}

// See the proof above this section. Walks rules A..E in
// compareWithinTolerance's own order; returns true only once a rule shows
// the bound is STRICTLY worse than the incumbent while every earlier rule
// tied (never on a heuristic "probably worse" signal, and never past a
// rule where the bound is still strictly better, which means some
// completion might still win). Ratio comparisons use FLOAT_EPSILON (same
// constant isWithinTolerance() uses) so representation noise alone can
// never trigger a prune.
export function boundCannotBeatIncumbent(bound, incumbent) {
  // A. fewer critical Contractors (ascending -- lower wins).
  if (bound.bestCriticalContractorCount > incumbent.criticalContractorCount) return true;
  if (bound.bestCriticalContractorCount < incumbent.criticalContractorCount) return false;

  // B. maximize total active units (descending -- higher wins).
  if (bound.bestTotalActiveUnits < incumbent.totalActiveUnits) return true;
  if (bound.bestTotalActiveUnits > incumbent.totalActiveUnits) return false;

  // C. lower worst Contractor standby ratio (ascending -- lower wins).
  if (bound.bestWorstContractorStandbyRatio > incumbent.worstContractorStandbyRatio + FLOAT_EPSILON) return true;
  if (bound.bestWorstContractorStandbyRatio < incumbent.worstContractorStandbyRatio - FLOAT_EPSILON) return false;

  // D. fewer Contractors requiring >5% mitigation (ascending -- lower wins).
  if (bound.bestContractorsRequiringMitigationCount > incumbent.contractorsRequiringMitigationCount) return true;
  if (bound.bestContractorsRequiringMitigationCount < incumbent.contractorsRequiringMitigationCount) return false;

  // E. fewer fully-unused loading points (ascending -- lower wins).
  if (bound.bestFullyUnusedLoadingPointCount > incumbent.fullyUnusedLoadingPointCount) return true;

  // Tied through E, or the bound is strictly better at some rule (already
  // returned false above) -- rules F..J are unbounded, so no conclusion.
  return false;
}

// ============================================================
// V3.0 Phase 6A -- EXACT Contractor search order (docs/
// V3.0_SCALABLE_RECOMMENDATION_ENGINE_ARCHITECTURE.md "Contractor-Level
// Decomposition", this task's Section 1).
//
// This ONLY reorders which Contractor group is DECIDED at which recursion
// DEPTH in forEachCandidatePruned() -- never which groups exist, never
// which allocations exist within a group (that is Phase 4B's OWN,
// unrelated per-group orderAllocationsForSearch()), and critically never
// candidate identity: buildCandidate() always iterates the CANONICAL
// `groups` array regardless of traversal order (activeBySourceKey is keyed
// by source identity, not by group/traversal position -- see
// buildCandidate()'s own comment), so allocationSignature and
// candidateCount are exactly as before. The Phase 4B chemistry bound and
// Phase 4C ranking-prefix bound are themselves UNCHANGED here (see
// computeSuffixBounds()/computeSuffixRankBounds() above, both now
// parameterized by `searchOrder` but computing the exact same math) -- this
// section exists purely so those two EXISTING exact bounds see a smaller
// pooled "open" budget earlier in the traversal, letting them fire sooner.
// ============================================================

// Pure per-group metrics relevant to search-order decisions (called once
// per group per search, never per node). `allocationCount` is that group's
// own already-computed enumerateOperationalAllocations() length -- never
// re-enumerated here.
export function groupSearchOrderMetrics(group, allocationCount) {
  const fleet = group.sources.reduce((sum, s) => sum + s.assignedUnits, 0);
  const { minNi, maxNi } = groupSourceNiExtent(group.sources);
  return {
    allocationCount,
    niSpan: group.sources.length > 0 ? maxNi - minNi : 0,
    maxTonnageInfluence: groupMaxAchievableTonnage(fleet, group.sources),
  };
}

// Deterministic canonical-Contractor-key tie-break shared by every strategy
// below -- NEVER iteration order/object identity, so the resulting
// permutation is reproducible regardless of how `groups` was constructed
// (this task's DETERMINISM requirement).
function bySearchOrderStrategy(groups, primaryCompare) {
  return (a, b) => {
    const primary = primaryCompare(a, b);
    if (primary !== 0) return primary;
    return groups[a].contractorKey < groups[b].contractorKey ? -1 : groups[a].contractorKey > groups[b].contractorKey ? 1 : 0;
  };
}

// TEST-SUPPORT ONLY -- computes a candidate group TRAVERSAL order (an array
// of CANONICAL indices into `groups`/`perContractorAllocations`) for one
// NAMED strategy at a time, so tests/v3-phase6a-search-order.test.mjs can
// benchmark each strategy against the identical production traversal
// (forEachCandidatePruned() accepts any permutation of `groups`'s own
// indices). Production's own prepareSearch() NEVER calls this directly --
// it always calls computeContractorSearchOrder() below (the ONE strategy
// this task's benchmark selected), never a runtime string the hot path
// would have to branch on.
export function computeSearchOrderForStrategy(groups, perContractorAllocations, strategy) {
  const metrics = groups.map((group, i) => groupSearchOrderMetrics(group, perContractorAllocations[i].length));
  const indices = groups.map((_, i) => i);

  switch (strategy) {
    case 'canonical':
      return indices;
    case 'smallest-space-first':
      return indices.slice().sort(bySearchOrderStrategy(groups, (a, b) => metrics[a].allocationCount - metrics[b].allocationCount));
    case 'largest-space-first':
      return indices.slice().sort(bySearchOrderStrategy(groups, (a, b) => metrics[b].allocationCount - metrics[a].allocationCount));
    case 'tonnage-influence-first':
      return indices.slice().sort(bySearchOrderStrategy(groups, (a, b) => metrics[b].maxTonnageInfluence - metrics[a].maxTonnageInfluence));
    case 'ni-span-first':
      return indices.slice().sort(bySearchOrderStrategy(groups, (a, b) => metrics[b].niSpan - metrics[a].niSpan));
    case 'tonnage-then-smallest-space':
      return indices.slice().sort(bySearchOrderStrategy(groups, (a, b) => {
        if (metrics[b].maxTonnageInfluence !== metrics[a].maxTonnageInfluence) return metrics[b].maxTonnageInfluence - metrics[a].maxTonnageInfluence;
        return metrics[a].allocationCount - metrics[b].allocationCount;
      }));
    default:
      throw new Error(`unknown V3.0 Phase 6A search order strategy: ${strategy}`);
  }
}

// PRODUCTION search order -- this task's chosen strategy, selected by
// tests/v3-phase6a-search-order.test.mjs's benchmark against Phase 5's C/D
// (see that file's header for the measured evidence). Deliberately NOT a
// runtime switch over computeSearchOrderForStrategy() -- one fixed,
// unconditional computation, matching this task's "select ONE strategy
// only if evidence shows material improvement" instruction.
export function computeContractorSearchOrder(groups, perContractorAllocations) {
  return computeSearchOrderForStrategy(groups, perContractorAllocations, 'smallest-space-first');
}

// ============================================================
// V3.0 Phase 4D -- ACTUAL-WORK search-space safety bound (docs/
// V3.0_SCALABLE_RECOMMENDATION_ENGINE_ARCHITECTURE.md "Replace Legacy
// Theoretical Candidate Gate"). Replaces the removed MAX_GLOBAL_CANDIDATES
// pre-search gate (fleet-allocation.js's own comment explains why that
// gate is obsolete): a real B&B traversal's cost tracks how many search
// NODES it actually visits, not the theoretical candidateCount, and Phase
// 4C's chemistry/ranking-prefix pruning routinely visits a tiny fraction
// of candidateCount once an incumbent streams through. This bound is
// therefore enforced INSIDE forEachCandidatePruned() below (against
// diagnostics.visitedNodes, incremented once per node -- internal or
// leaf), never before generation, and is a fixed node COUNT, never a
// wall-clock timeout (this task's "Do NOT introduce time-based
// correctness decisions... hardware-dependent timing is not
// deterministic").
//
// Chosen from measured evidence (tests/v3-phase4d-node-budget.test.mjs
// reproduces these numbers), not an arbitrary round number:
//   - 4 dome / 2 Contractor / 60 DT   (candidateCount 58,080)  -> ~4,800 nodes
//   - 6 dome / 3 Contractor / 60 DT   (candidateCount 438,975) -> ~6,900 nodes
//   - 8 dome / 4 Contractor / 80 DT   (candidateCount ~33.4M)  -> ~62,300 nodes
// 500,000 gives the two REQUIRED scenarios a 70-100x margin, comfortably
// covers the 8-dome case above (~8x margin) as real headroom for gradual
// scale-up, and still turns a genuinely pathological shape (few
// Contractor groups, each near the per-group MAX_ALLOCATIONS_PER_CONTRACTOR
// ceiling, with a target that never lets pruning engage -- see this task's
// SAFETY TEST) into a bounded, deterministic SEARCH_INCOMPLETE within a
// fraction of a second rather than a multi-minute/unbounded traversal.
// This is NOT a claim that every input up to this node count is "fast
// enough for production" in every sense -- only that it is the point past
// which this phase deliberately stops guaranteeing an exact answer.
export const MAX_SEARCH_NODES = 500000;

// V3.0 Phase 7A -- dispatch-only probe budget (this task's own Section 2:
// "dispatch affects PERFORMANCE only, never correctness"; Section 10: "do
// not put fragile millisecond thresholds into normal CI tests" -- this is a
// NODE COUNT budget, the same deterministic mechanism MAX_SEARCH_NODES
// itself already is, never a wall-clock timeout). The normal engine's FIRST
// attempt below (findBlendRecommendations()/findBlendRecommendationsWithDiagnostics())
// runs capped at this smaller budget rather than the full MAX_SEARCH_NODES:
// for every shape the normal group-granularity engine can actually resolve,
// this codebase's own measured evidence (this file's MAX_SEARCH_NODES
// comment above: 4,800 / 6,900 / ~62,300 nodes for the cited Phase 4D
// scenarios; V3.0 Phase 5/6's own A/B benchmark scenarios: ~6,900/~6,700
// nodes) finishes in well under 1/5 of MAX_SEARCH_NODES -- so capping the
// FIRST attempt here costs a genuinely "normal" shape nothing but redirects
// a concentrated/symmetric HARD shape (whose pruning provably does not
// converge by this point -- more nodes only ever re-confirms the same
// non-convergence, never resolves it) to the hard-case engine immediately,
// instead of first burning the full 500,000-node budget on a doomed
// traversal. This can never cost correctness: if the probe is cut short,
// dispatchHardCase() below runs its OWN full MAX_SEARCH_NODES-budgeted
// search (a finer, source-level granularity that this codebase's own
// benchmark evidence shows resolves shapes the group-granularity engine
// cannot) rather than surfacing a premature SEARCH_INCOMPLETE.
export const NORMAL_ENGINE_PROBE_NODES = 100000;

// Explicit branch-and-bound traversal (this task's Section "SEARCH
// STRUCTURE"/"Refactor... into explicit partial-node traversal"). Replaces
// the plain recursive Cartesian combine with one that threads running
// accumulators (contractor depth, weighted-Ni numerator, tonnage) so the
// chemistry bound can be evaluated at every node BEFORE its subtree is
// explored, without recomputing anything from scratch.
//
// PRUNING SAFETY (this task's "IMPORTANT BEST-ATTAINABLE RULE"): pruning
// only ever consults `pruningGate.active`, which the caller sets true ONLY
// once a within-tolerance candidate has actually streamed through. Before
// that, every node is fully explored (pruningGate.active stays false), so
// TARGET_NOT_ACHIEVABLE's bestAttainable is always found by the same
// exhaustive traversal Phase 3 used -- no bound is invented for that path.
// Once a within-tolerance incumbent exists, the final status is
// permanently 'OK' regardless of what is pruned afterward (bestWithinTolerance
// is never reset to null), so pruning bestAttainable-only branches from that
// point on cannot change the returned result.
//
// Also proves sourcesInAnyWithinToleranceCandidate stays exact under
// pruning: a branch is only pruned when its bound CANNOT intersect
// [target-tolerance, target+tolerance], which by the proof above means NO
// completion in that branch can be within tolerance -- so pruning never
// discards a source that would have participated in a within-tolerance
// candidate. The SAME argument applies to the V3.0 Phase 4C ranking-prefix
// bound below: it only discards a branch when NO completion could
// outrank the current bestWithinTolerance, so it can never discard the
// eventual winner either (proven by tests/v3-phase4c-ranking-bound.test.mjs).
// `searchOrder` (V3.0 Phase 6A, see that section below) -- an array of
// CANONICAL indices into `groups`/`perContractorAllocations` giving the
// TRAVERSAL order (searchOrder[depth] = which canonical group is decided
// at that recursion depth). Passing the canonical identity order
// reproduces the exact pre-Phase-6A traversal. This NEVER affects
// candidate identity: buildCandidate() below always reads the CANONICAL
// `groups` array, and activeBySourceKey is keyed by source identity, not
// by traversal position -- see buildCandidate()'s own comment.
function forEachCandidatePruned(groups, perContractorAllocations, targetNiValue, toleranceValue, pruningGate, visit, searchOrder, nodeBudget = MAX_SEARCH_NODES) {
  const suffixBounds = computeSuffixBounds(groups, searchOrder);
  // V3.0 Phase 4C -- pooled best-case ranking contribution of each
  // still-open suffix of groups, computed once per search (never per
  // node), same cost shape as suffixBounds above.
  const suffixRankBounds = computeSuffixRankBounds(groups, perContractorAllocations, searchOrder);
  // Each group's own total fleet, computed once per search -- combine()
  // below reads groupFleets[groupIndex] rather than re-reducing
  // group.sources on every node reached at that depth.
  const groupFleets = groups.map((group) => group.sources.reduce((sum, s) => sum + s.assignedUnits, 0));
  const diagnostics = { visitedNodes: 0, prunedByChemistry: 0, prunedByRanking: 0, completedCandidates: 0, incomplete: false };

  // groupIndex: current Contractor depth. fixedNumerator/fixedTonnage:
  // accumulated weighted-Ni numerator/tonnage across DECIDED groups only.
  // fixedActiveUnits: accumulated active units across decided groups --
  // now also the EXACT rule-B contribution the Phase 4C ranking bound
  // below consumes (previously diagnostic-only under Phase 4A/4B).
  // fixedCriticalCount/fixedWorstRatio/fixedMitigationCount/
  // fixedFullyUnusedCount: the remaining exact rule-A/C/D/E contributions
  // of the DECIDED groups only (V3.0 Phase 4C). activeBySourceKey: enough
  // state (every decided group's chosen allocation) to call
  // buildCandidate() exactly once groupIndex reaches groups.length.
  //
  // V3.0 Phase 4D node budget (see MAX_SEARCH_NODES's own comment above):
  // checked BEFORE incrementing visitedNodes, so once the budget is hit
  // diagnostics.incomplete flips exactly once and diagnostics.visitedNodes
  // never exceeds MAX_SEARCH_NODES. Every already-in-flight recursive call
  // (this function, or a parent's for-loop below) checks
  // diagnostics.incomplete first and returns/breaks immediately -- no
  // further node is scored, pruned, or built once the budget is spent, so
  // any candidate visit() was already called with (via runStreamingSearch's
  // bestWithinTolerance/bestAttainable) remains merely "best seen so far",
  // never asserted as exhaustively optimal.
  function combine(depth, activeBySourceKey, fixedNumerator, fixedTonnage, fixedActiveUnits, fixedCriticalCount, fixedWorstRatio, fixedMitigationCount, fixedFullyUnusedCount) {
    if (diagnostics.incomplete) return;
    if (diagnostics.visitedNodes >= nodeBudget) {
      diagnostics.incomplete = true;
      return;
    }
    diagnostics.visitedNodes += 1;

    if (depth === searchOrder.length) {
      const candidate = buildCandidate(groups, activeBySourceKey, targetNiValue, toleranceValue);
      if (candidate) {
        diagnostics.completedCandidates += 1;
        visit(candidate);
      }
      return;
    }

    if (pruningGate.active) {
      const bound = conservativeFinalNiBound(fixedNumerator, fixedTonnage, suffixBounds[depth]);
      if (!boundIntersectsTolerance(bound, targetNiValue, toleranceValue)) {
        diagnostics.prunedByChemistry += 1;
        return;
      }

      if (pruningGate.rankingEnabled) {
        const rankBound = conservativeRankingBound(
          { criticalCount: fixedCriticalCount, activeUnits: fixedActiveUnits, worstRatio: fixedWorstRatio, mitigationCount: fixedMitigationCount, fullyUnusedCount: fixedFullyUnusedCount },
          suffixRankBounds[depth],
        );
        if (boundCannotBeatIncumbent(rankBound, pruningGate.rankMetrics)) {
          diagnostics.prunedByRanking += 1;
          return;
        }
      }
    }

    // V3.0 Phase 6A: `depth` is a position in TRAVERSAL order, never a
    // canonical group index directly -- searchOrder[depth] maps it back to
    // the canonical group actually being decided here.
    const canonicalIndex = searchOrder[depth];
    const group = groups[canonicalIndex];
    const fleet = groupFleets[canonicalIndex];
    for (const allocation of perContractorAllocations[canonicalIndex]) {
      if (diagnostics.incomplete) break;
      const next = new Map(activeBySourceKey);
      let allocNumerator = 0;
      let allocTonnage = 0;
      group.sources.forEach((s, i) => {
        next.set(normalizeSourceIdentity(s.pileId, s.contractor), allocation[i]);
        const tonnage = allocation[i] * s.tonnesPerUnit;
        allocTonnage += tonnage;
        allocNumerator += s.ni * tonnage;
      });
      const allocMetrics = allocationRankMetrics(group, allocation, fleet);
      combine(
        depth + 1,
        next,
        fixedNumerator + allocNumerator,
        fixedTonnage + allocTonnage,
        fixedActiveUnits + allocMetrics.activeUnits,
        fixedCriticalCount + (allocMetrics.isCritical ? 1 : 0),
        Math.max(fixedWorstRatio, allocMetrics.standbyRatio),
        fixedMitigationCount + (allocMetrics.requiresMitigation ? 1 : 0),
        fixedFullyUnusedCount + allocMetrics.fullyUnusedCount,
      );
    }
  }

  combine(0, new Map(), 0, 0, 0, 0, 0, 0, 0);
  return diagnostics;
}

// Shared streaming-incumbent core (this task's preserved Phase 3
// contract) -- identical for both the Phase 4A/4B/4C pruned production
// path and the Phase 3 (gate permanently disabled) test-support reference
// below, so the ONLY behavioral difference between them is whether
// `enablePruningGate` ever lets chemistry/ranking-prefix pruning engage.
// `enableRankingPruning` (default true -- production always leaves it on)
// is a TEST-SUPPORT-ONLY sub-toggle: when enablePruningGate is true but
// this is false, chemistry pruning alone runs (the Phase 4B production
// behavior), letting tests/v3-phase4c-ranking-bound.test.mjs's benchmark
// compare Phase 4B against Phase 4C on the identical traversal. Production
// code never passes a third argument here.
function runStreamingSearch(groups, perContractorAllocations, targetNiValue, toleranceValue, enablePruningGate, enableRankingPruning = true, searchOrder, nodeBudget = MAX_SEARCH_NODES) {
  let bestWithinTolerance = null;
  let bestAttainable = null;
  const sourcesInAnyWithinToleranceCandidate = new Set();
  // rankMetrics: V3.0 Phase 4C -- the CURRENT bestWithinTolerance's exact
  // rule A/B/C/D/E values, recomputed only when a strictly better
  // incumbent replaces it (never per node) so forEachCandidatePruned()'s
  // ranking-bound check always compares against the live incumbent.
  const pruningGate = { active: false, rankMetrics: null, rankingEnabled: enableRankingPruning };

  // Actual visit count lives in diagnostics.completedCandidates (below) --
  // this function never tracks its own separate copy, since that would
  // invite the exact Phase 4A bug this task fixes: a traversal-visit count
  // masquerading as the search space's own SIZE (see
  // operationalCandidateSpaceSize(), which callers use for the real
  // candidateCount instead).
  const diagnostics = forEachCandidatePruned(groups, perContractorAllocations, targetNiValue, toleranceValue, pruningGate, (candidate) => {
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
        if (enablePruningGate) pruningGate.rankMetrics = incumbentRankingMetrics(candidate);
      }
      if (enablePruningGate) pruningGate.active = true;
    }
  }, searchOrder, nodeBudget);

  return { bestWithinTolerance, bestAttainable, sourcesInAnyWithinToleranceCandidate, diagnostics };
}

// Exact size of the OPERATIONAL Cartesian product across every Contractor
// group, INCLUDING the single global all-zero allocation -- computed
// directly from each group's own enumerateOperationalAllocations() output
// length, which is exact BY CONSTRUCTION (cross-checked against
// countOperationalAllocations() by tests/v3-operational-allocation.test.mjs's
// counting matrix and by prepareSearch()'s own gate above, which rejects
// before generation using the identical countOperationalAllocations() per
// group). This is what makes candidateCount below independent of Branch-
// and-Bound traversal: it is derived from the SEARCH SPACE (Phase 2's
// already-exact operational allocation counts), never from how many leaves
// a particular traversal happened to visit or prune (this task's "Use the
// already-exact Phase 2 operational allocation counts").
function operationalCandidateSpaceSize(perContractorAllocations) {
  return perContractorAllocations.reduce((product, allocations) => product * allocations.length, 1);
}

// candidateCount below is the total operational Cartesian size MINUS the
// one global all-zero allocation (this task's REQUIRED section): that
// all-zero tuple is counted once by the per-group allocation sets (each
// group's own set includes its own all-zero tuple), but buildCandidate()
// always excludes it from actual candidates (totalActiveUnits === 0), so
// subtracting exactly 1 -- never more -- restores the pre-pruning,
// pre-Phase-4A semantic meaning of candidateCount: "how many
// operationally-feasible non-all-zero candidates does this search space
// represent", NOT "how many completed leaves did Branch-and-Bound visit".
function buildResultFromSearch(search, targetNiValue, toleranceValue, candidateCount) {
  if (candidateCount === 0) {
    return { ok: false, error: 'NO_FEASIBLE_CANDIDATE' };
  }

  // V3.0 Phase 4D EXACTNESS CONTRACT: MAX_SEARCH_NODES was spent before
  // forEachCandidatePruned() finished the traversal (see its own
  // diagnostics.incomplete comment) -- checked BEFORE bestWithinTolerance
  // below, and unconditionally, so an incumbent found before the budget
  // ran out is NEVER returned as an exact 'OK'/'TARGET_NOT_ACHIEVABLE':
  // pruning bounds and the exhaustive bestAttainable rule alike both
  // depend on having actually visited (or provably ruled out) every
  // remaining branch, which an early-terminated traversal cannot claim.
  // No approximation is returned as if it were exact -- 'diagnostics' here
  // is explicitly for internal/diagnostic use (visitedNodes/
  // completedCandidates), never a `candidate` field a caller could mistake
  // for a real recommendation.
  if (search.diagnostics.incomplete) {
    return {
      ok: false,
      error: 'SEARCH_INCOMPLETE',
      targetNi: targetNiValue,
      tolerance: toleranceValue,
      candidateCount,
      diagnostics: {
        visitedNodes: search.diagnostics.visitedNodes,
        completedCandidates: search.diagnostics.completedCandidates,
        prunedByChemistry: search.diagnostics.prunedByChemistry,
        prunedByRanking: search.diagnostics.prunedByRanking,
      },
    };
  }

  if (search.bestWithinTolerance) {
    return {
      ok: true,
      status: 'OK',
      candidate: search.bestWithinTolerance,
      targetNi: targetNiValue,
      tolerance: toleranceValue,
      candidateCount,
      sourcesInAnyWithinToleranceCandidate: search.sourcesInAnyWithinToleranceCandidate,
    };
  }

  return {
    ok: true,
    status: 'TARGET_NOT_ACHIEVABLE',
    candidate: search.bestAttainable,
    targetNi: targetNiValue,
    tolerance: toleranceValue,
    bestAttainableNi: search.bestAttainable.estimatedNi,
    gap: search.bestAttainable.deviation,
    candidateCount,
    // Always empty here BY DEFINITION -- reaching this branch already
    // means no candidate streamed through was within tolerance, so no
    // within-tolerance candidate exists for ANY source to participate in.
    // Included (rather than omitted) so every 'ok: true' result carries
    // the same field shape regardless of status, and recommendation-
    // actions.js never needs a status-specific branch just to read it.
    sourcesInAnyWithinToleranceCandidate: new Set(),
  };
}

// ============================================================
// SEARCH + RANKING ENTRY POINT (this task's Section 1/18-19/20/23)
// ============================================================
//
// sources: [{ pileId, contractor, ni, units, tonnesPerUnit }] -- raw
// (possibly string) field values, exactly as calculate-validation.js's
// Blend validators expect; `units` means physical reusable DT/fleet here
// (this task's Section 3), never loads actually used.
//
// Returns one of:
//   { ok: false, error: 'INVALID_INPUT', targetError, toleranceError,
//     sourceErrors, fleetError }
//   { ok: false, error: 'SEARCH_SPACE_TOO_LARGE', ... }        (Section 19;
//     V3.0 Phase 4D: a single Contractor group's own operational
//     allocation count alone exceeds MAX_ALLOCATIONS_PER_CONTRACTOR --
//     generation-time only, never the removed cross-Contractor product gate)
//   { ok: false, error: 'SEARCH_INCOMPLETE', candidateCount, diagnostics }
//     (V3.0 Phase 4D: MAX_SEARCH_NODES was spent before the traversal could
//     prove an exact OK/TARGET_NOT_ACHIEVABLE result -- NEVER an
//     approximation of one; no `candidate` field, see buildResultFromSearch()'s
//     own comment)
//   { ok: false, error: 'NO_FEASIBLE_CANDIDATE' }               (defensive;
//     unreachable once validation requires totalFleet > 0, since that
//     guarantees at least one non-all-zero allocation exists)
//   { ok: true, status: 'OK', candidate, targetNi, tolerance, candidateCount }
//   { ok: true, status: 'TARGET_NOT_ACHIEVABLE', candidate, targetNi,
//     tolerance, bestAttainableNi, gap, candidateCount }
//
// V3.0 Phase 4A.1 (this task's PRESERVE CANDIDATE COUNT SEMANTICS):
// candidateCount is the exact operational Cartesian size (product of each
// Contractor group's already-exact Phase 2 allocation count) minus the one
// excluded all-zero allocation -- it describes the SEARCH SPACE, never how
// many leaves Branch-and-Bound happened to visit or prune. It is therefore
// IDENTICAL whether chemistry pruning discards zero branches or thousands
// (see operationalCandidateSpaceSize()'s own comment, and
// tests/v3-phase4a-branch-and-bound.test.mjs's Phase3-vs-Phase4A
// candidateCount equality assertion). Use completedCandidates/visitedNodes/
// prunedByChemistry (findBlendRecommendationsWithDiagnostics()) to observe
// actual traversal work; the WINNING candidate itself is unaffected either
// way (proven above: pruning never discards a branch that could still win).
// V3.0 Phase 7A -- hybrid dispatch (this task's own Sections 2/4/6):
// PERFORMANCE ONLY, never correctness -- both branches return the exact
// same public Recommendation contract via buildResultFromSearch()/
// buildHardCaseResult(). The normal engine always runs first; the hard-case
// (prefix-lock + MITM) engine only ever activates from the two deterministic
// trigger points dispatchHardCase() itself documents (SEARCH_SPACE_TOO_LARGE
// at generation time, or SEARCH_INCOMPLETE after an exhausted traversal) --
// never a fragile shape-based heuristic ("if N domes then MITM").
// `solverPath` ('NORMAL_BNB' | 'HARDCASE_MITM') is added to every result as
// an ADDITIONAL diagnostic field -- no existing field changes meaning.
// V3.0 Phase 7A.1 -- cheap PRE-DISPATCH metadata check (this task's own
// Section 1), evaluated on `perContractorAllocations` that prepareSearch()
// already built (no extra enumeration/search work). Two deterministic,
// already-exact signals, both required together:
//
//   - HARD_CASE_MIN_GROUP_COUNT_FLOOR: every Contractor group's own
//     operational allocation count exceeds this floor. This codebase's own
//     A-F measured matrix (this task's Section 2) shows the normal engine's
//     Branch-and-Bound prunes fast whenever ANY group is small (A/B: a
//     smallest-group count of 6, finishing in ~120-150ms) -- a small group
//     gives the traversal an early, cheap incumbent/bound. Once EVERY group
//     is large (C/D: smallest-group counts of 76/1101), that cheap anchor
//     never exists and the probe burns its full budget without converging.
//   - HARD_CASE_CANDIDATE_COUNT_THRESHOLD: the theoretical global Cartesian
//     candidateCount (same measured matrix: A=1.58e7, B=5.69e8 vs.
//     C=2.54e9, D=2.04e10) is large enough that the probe's fixed node
//     budget is negligible against it.
//
// Deliberately NOT a domeCount/ContractorCount/scenario-name special case
// (this task's Section 1/6's own explicit prohibition) -- both signals are
// generic properties of any input's already-computed allocation counts.
// PERFORMANCE ONLY: see the call sites below for the exactness-preserving
// fallback when this predicts "hard" but the hard-case engine itself can't
// establish its A+B precondition within budget (Section 3/4).
const HARD_CASE_MIN_GROUP_COUNT_FLOOR = 50;
const HARD_CASE_CANDIDATE_COUNT_THRESHOLD = 1000000000;

function shouldDispatchHardCaseDirectly(perContractorAllocations) {
  const perGroupCounts = perContractorAllocations.map((allocations) => allocations.length);
  const minPerGroup = Math.min(...perGroupCounts);
  if (minPerGroup <= HARD_CASE_MIN_GROUP_COUNT_FLOOR) return false;
  const globalCandidateCount = perGroupCounts.reduce((product, count) => product * count, 1) - 1;
  return globalCandidateCount > HARD_CASE_CANDIDATE_COUNT_THRESHOLD;
}

export function findBlendRecommendations({ targetNi, tolerance = DEFAULT_RECOMMENDATION_TOLERANCE, sources }) {
  const prepared = prepareSearch({ targetNi, tolerance, sources });
  if (!prepared.ok) {
    if (prepared.result.error === 'SEARCH_SPACE_TOO_LARGE') return dispatchHardCase(prepared);
    return prepared.result;
  }
  const {
    groups, groupFleets, perContractorAllocations, targetNiValue, toleranceValue, searchOrder,
  } = prepared;

  let directHardCaseAttempt = null;
  if (shouldDispatchHardCaseDirectly(perContractorAllocations)) {
    directHardCaseAttempt = dispatchHardCase({
      groups, groupFleets, targetNiValue, toleranceValue,
    });
    if (directHardCaseAttempt.error !== 'SEARCH_INCOMPLETE') return directHardCaseAttempt;
    // Preflight predicted an obviously-hard shape, but even the hard-case
    // engine's own full MAX_SEARCH_NODES budget could not establish its
    // A+B precondition (Section 3/4's fallback contract) -- give the
    // existing NORMAL_BNB probe below its own (different traversal order)
    // chance, byte-identical to pre-Phase-7A.1 behavior.
  }

  const search = runStreamingSearch(groups, perContractorAllocations, targetNiValue, toleranceValue, true, true, searchOrder, NORMAL_ENGINE_PROBE_NODES);
  const candidateCount = operationalCandidateSpaceSize(perContractorAllocations) - 1;
  const result = buildResultFromSearch(search, targetNiValue, toleranceValue, candidateCount);
  if (result.error === 'SEARCH_INCOMPLETE') {
    // dispatchHardCase() is a pure function of (groups, groupFleets,
    // targetNiValue, toleranceValue) at a fixed MAX_SEARCH_NODES budget --
    // if the direct attempt above already ran it on this exact input, a
    // second call would recompute the identical SEARCH_INCOMPLETE and pay
    // for that full traversal twice. Reuse it instead.
    return directHardCaseAttempt ?? dispatchHardCase({
      groups, groupFleets, targetNiValue, toleranceValue,
    });
  }
  result.solverPath = 'NORMAL_BNB';
  return result;
}

// Shared validation + numeric-conversion + canonical-grouping prefix,
// factored out (V3.0 Phase 7A) so both the normal engine's own
// per-Contractor gate below AND the hard-case dispatcher (dispatchHardCase()
// below) can reach `groups`/`groupFleets` from the SAME single validation
// pass -- never a second independent copy of it. Deliberately does NOT
// apply the MAX_ALLOCATIONS_PER_CONTRACTOR gate itself (prepareSearch()
// below does that on top), since the hard-case path must be reachable even
// when that gate would have rejected the normal engine (this task's own
// Section 5).
function prepareGroups({ targetNi, tolerance, sources }) {
  const targetError = validateTargetNi(targetNi);
  const toleranceError = validateTolerance(tolerance);
  const { sourceErrors, fleetError, valid: sourcesValid } = validateRecommendationSources(sources);

  if (targetError || toleranceError || !sourcesValid) {
    return { ok: false, result: { ok: false, error: 'INVALID_INPUT', targetError, toleranceError, sourceErrors, fleetError } };
  }

  const targetNiValue = parseDecimalInput(targetNi);
  const toleranceValue = parseDecimalInput(tolerance);
  const numericSources = sources.map(toNumericSource);
  const groups = groupSourcesByContractor(numericSources);
  const groupFleets = groups.map((group) => group.sources.reduce((sum, s) => sum + s.assignedUnits, 0));

  return {
    ok: true, groups, groupFleets, targetNiValue, toleranceValue,
  };
}

// Shared validation + generation-time-feasibility gate + per-Contractor
// allocation-set setup (this task's Section 19's bound-before-generating
// gate, unchanged from Phase 2) -- factored out so the Phase 3 streaming
// production path above and the test-only materialized differential path
// below (findBlendRecommendationsMaterialized()) run through byte-identical
// setup and can never silently diverge on validation/gating behavior.
function prepareSearch({ targetNi, tolerance, sources }) {
  const base = prepareGroups({ targetNi, tolerance, sources });
  if (!base.ok) return base;
  const {
    groups, groupFleets, targetNiValue, toleranceValue,
  } = base;

  // ---- Bound GENERATION (never traversal) BEFORE generating anything ---
  // (Section 19; V3.0 Phase 4D narrows this to per-Contractor only -- see
  // fleet-allocation.js's own MAX_ALLOCATIONS_PER_CONTRACTOR comment for
  // why this specific check survives Phase 4D unchanged: it protects
  // enumerateOperationalAllocations()'s EAGER array materialization for a
  // single group, a cost Branch-and-Bound pruning/the node budget below
  // can never see or bound). V3.0 Phase 2 (Owner-approved, this task's
  // Section 0): an active loading point is only operationally feasible at
  // 0 or >= MIN_UNITS_PER_ACTIVE_LOADING_POINT DT, so both this count and
  // the actual generation below use fleet-allocation.js's
  // countOperationalAllocations()/enumerateOperationalAllocations() --
  // the OPERATIONALLY FEASIBLE subset of what the pre-Phase-2
  // countContractorAllocations()/enumerateAllocations() counted/generated
  // (those two are kept, unused by this search, only because
  // tests/fleet-allocation.test.mjs still exercises them as pure
  // primitives). Count and generation MUST describe the exact same set
  // (this task's Section 7) -- verified by
  // tests/v3-operational-allocation.test.mjs's counting matrix.
  //
  // The former GLOBAL (cross-Contractor product) gate is REMOVED here as
  // of V3.0 Phase 4D -- see MAX_SEARCH_NODES's own comment above for why:
  // it bounded the THEORETICAL space, not actual traversal work, and
  // routinely rejected inputs Phase 4C's pruning completes in a tiny
  // fraction of that space (e.g. the 6-dome/3-Contractor/60-DT case).
  // forEachCandidatePruned()'s own MAX_SEARCH_NODES budget is what now
  // protects the traversal that follows this per-group gate.
  for (let i = 0; i < groups.length; i += 1) {
    const count = countOperationalAllocations(groupFleets[i], groups[i].sources.length);
    if (count > MAX_ALLOCATIONS_PER_CONTRACTOR) {
      // V3.0 Phase 7A -- `groups`/`groupFleets`/`targetNiValue`/`toleranceValue`
      // are exposed as SIBLINGS of `result` (never inside it -- `result` stays
      // exactly the public error contract every existing caller already
      // reads) so dispatchHardCase() below can reach the hard-case solver
      // without re-running validation/grouping a second time. This is safe:
      // prepareSearch() is a private function, and every other caller only
      // ever reads `.ok`/`.result` on its ok:false branch.
      return {
        ok: false,
        result: { ok: false, error: 'SEARCH_SPACE_TOO_LARGE', contractor: groups[i].contractorKey, allocationCount: count },
        groups,
        groupFleets,
        targetNiValue,
        toleranceValue,
      };
    }
  }

  // ---- Per-Contractor allocation sets, then Cartesian-combine ----------
  // V3.0 Phase 4B: each group's own allocation set is reordered (never
  // filtered/resized -- see orderAllocationsForSearch()'s own comment) so a
  // strong incumbent tends to stream through earlier in the traversal.
  const perContractorAllocations = groups.map((group, i) => {
    const allocations = enumerateOperationalAllocations(groupFleets[i], group.sources.length);
    return orderAllocationsForSearch(group, allocations, targetNiValue);
  });

  // V3.0 Phase 6A -- see that section's own comment: this ONLY decides
  // which Contractor group is visited at which recursion depth, never
  // candidate identity/candidateCount.
  const searchOrder = computeContractorSearchOrder(groups, perContractorAllocations);

  return {
    ok: true, groups, groupFleets, perContractorAllocations, targetNiValue, toleranceValue, searchOrder,
  };
}

// V3.0 Phase 7A -- dispatches to the hard-case (prefix-lock + MITM) exact
// solver (exact-hardcase-solver.js). Called ONLY from two deterministic,
// exact-preflight-driven trigger points (never wall-clock timing, per this
// task's own Section 2):
//   (a) prepareSearch()'s own per-Contractor MAX_ALLOCATIONS_PER_CONTRACTOR
//       gate rejected generation (SEARCH_SPACE_TOO_LARGE) -- the normal
//       engine's eager per-Contractor array would have been too large to
//       even build; the hard-case path never needs that array at all.
//   (b) the normal engine's own Branch-and-Bound traversal exhausted
//       MAX_SEARCH_NODES (SEARCH_INCOMPLETE) -- the search space passed
//       generation but proved too large to finish exactly within budget.
// `candidateCount` is computed with the EXACT SAME per-group operational
// allocation formula the normal engine uses (never a MITM state count --
// this task's own Section 6 "candidateCount remains the exact original
// theoretical operational candidate count").
function dispatchHardCase({
  groups, groupFleets, targetNiValue, toleranceValue,
}) {
  const hard = runHardCaseSearch({
    groups, groupFleets, targetNiValue, toleranceValue,
  }, MAX_SEARCH_NODES);
  const candidateCount = groups.reduce(
    (product, group, i) => product * countOperationalAllocations(groupFleets[i], group.sources.length),
    1,
  ) - 1;
  return buildHardCaseResult(hard, targetNiValue, toleranceValue, candidateCount);
}

// Wraps exact-hardcase-solver.js's internal { status, candidate,
// sourcesInAnyWithinToleranceCandidate, diagnostics } shape into the SAME
// public Recommendation contract buildResultFromSearch() produces for the
// normal engine (this task's own Section 6 "no existing UI field should
// silently change meaning") -- `solverPath`/`diagnostics` are ADDITIONAL
// fields, never a replacement for any existing one.
function buildHardCaseResult(hard, targetNiValue, toleranceValue, candidateCount) {
  if (candidateCount === 0) {
    return { ok: false, error: 'NO_FEASIBLE_CANDIDATE', solverPath: 'HARDCASE_MITM' };
  }

  if (hard.status === 'SEARCH_INCOMPLETE' || hard.status === 'NO_FEASIBLE_CANDIDATE') {
    return {
      ok: false,
      error: hard.status,
      targetNi: targetNiValue,
      tolerance: toleranceValue,
      candidateCount,
      solverPath: 'HARDCASE_MITM',
      diagnostics: hard.diagnostics,
    };
  }

  if (hard.status === 'OK') {
    return {
      ok: true,
      status: 'OK',
      candidate: hard.candidate,
      targetNi: targetNiValue,
      tolerance: toleranceValue,
      candidateCount,
      sourcesInAnyWithinToleranceCandidate: hard.sourcesInAnyWithinToleranceCandidate,
      solverPath: 'HARDCASE_MITM',
      diagnostics: hard.diagnostics,
    };
  }

  // TARGET_NOT_ACHIEVABLE
  return {
    ok: true,
    status: 'TARGET_NOT_ACHIEVABLE',
    candidate: hard.candidate,
    targetNi: targetNiValue,
    tolerance: toleranceValue,
    bestAttainableNi: hard.candidate.estimatedNi,
    gap: hard.candidate.deviation,
    candidateCount,
    sourcesInAnyWithinToleranceCandidate: new Set(),
    solverPath: 'HARDCASE_MITM',
    diagnostics: hard.diagnostics,
  };
}

// Shared leaf-candidate generator (this task's Section 28/29) -- the same
// Cartesian-combine traversal used by BOTH the Phase 3 streaming production
// path above and the test-only materialized path below, so differential
// tests compare two different CONSUMPTION strategies over the identical
// candidate stream/order, never two different generators.
function forEachCandidate(groups, perContractorAllocations, targetNiValue, toleranceValue, visit) {
  // Keyed by normalizeSourceIdentity(pileId, contractor), never pileId
  // alone -- see buildCandidate()'s own comment for why a Pile-ID-only key
  // would silently collide once two different Contractors share a Pile ID.
  function combine(groupIndex, activeBySourceKey) {
    if (groupIndex === groups.length) {
      const candidate = buildCandidate(groups, activeBySourceKey, targetNiValue, toleranceValue);
      if (candidate) visit(candidate);
      return;
    }
    const group = groups[groupIndex];
    for (const allocation of perContractorAllocations[groupIndex]) {
      const next = new Map(activeBySourceKey);
      group.sources.forEach((s, i) => next.set(normalizeSourceIdentity(s.pileId, s.contractor), allocation[i]));
      combine(groupIndex + 1, next);
    }
  }
  combine(0, new Map());
}

// TEST-SUPPORT-ONLY exhaustive-materialization safety bound. This helper's
// forEachCandidate() has NO Branch-and-Bound pruning and NO
// MAX_SEARCH_NODES traversal budget (it is the deliberate full-enumeration
// ground truth production no longer uses) -- so once V3.0 Phase 4D removed
// the cross-Contractor MAX_GLOBAL_CANDIDATES pre-gate from prepareSearch(),
// this is the ONLY thing left standing between a multi-Contractor scenario
// whose per-group counts each individually clear MAX_ALLOCATIONS_PER_CONTRACTOR
// (so prepareSearch() itself no longer refuses it) and an out-of-memory
// crash from actually materializing their full product as real candidate
// objects. NOT a production safety mechanism (see MAX_SEARCH_NODES for
// that) -- this exists purely so this test-only exhaustive comparison
// helper keeps its pre-Phase-4D "safe to call on anything prepareSearch()
// accepts" contract.
const MAX_MATERIALIZED_CANDIDATES = 200000;

// ============================================================
// TEST-SUPPORT ONLY -- Phase 2-style materialized selection (this task's
// TESTS requirement #1: "streaming winner equals existing ranking winner").
// Re-materializes the full candidate list (candidates[]/withinTolerance[]
// arrays + slice().sort()[0], exactly like findBlendRecommendations() did
// before V3.0 Phase 3) so tests/v3-phase3-streaming.test.mjs can assert the
// Phase 3 streaming winner above is byte-identical to what full
// materialization would have produced, for every tractable scenario.
// Shares prepareSearch()/forEachCandidate()/buildCandidate() with the real
// production path -- the ONLY thing duplicated here is the
// collect-then-sort SHAPE being replaced, never the business rules
// (buildCandidate, compareWithinTolerance, compareBestAttainable) that
// decide what a candidate looks like or which one wins. NEVER call this
// from production code -- it deliberately reintroduces the O(candidateCount)
// materialization this phase removes.
// ============================================================
export function findBlendRecommendationsMaterialized({ targetNi, tolerance = DEFAULT_RECOMMENDATION_TOLERANCE, sources }) {
  const prepared = prepareSearch({ targetNi, tolerance, sources });
  if (!prepared.ok) return prepared.result;
  const { groups, perContractorAllocations, targetNiValue, toleranceValue } = prepared;

  const operationalSize = operationalCandidateSpaceSize(perContractorAllocations);
  if (operationalSize > MAX_MATERIALIZED_CANDIDATES) {
    return { ok: false, error: 'SEARCH_SPACE_TOO_LARGE', allocationCount: operationalSize };
  }

  const candidates = [];
  forEachCandidate(groups, perContractorAllocations, targetNiValue, toleranceValue, (candidate) => {
    candidates.push(candidate);
  });

  if (candidates.length === 0) {
    return { ok: false, error: 'NO_FEASIBLE_CANDIDATE' };
  }

  const withinTolerance = candidates.filter((c) => c.withinTolerance);
  if (withinTolerance.length > 0) {
    const best = withinTolerance.slice().sort(compareWithinTolerance)[0];
    return {
      ok: true,
      status: 'OK',
      candidate: best,
      targetNi: targetNiValue,
      tolerance: toleranceValue,
      candidateCount: candidates.length,
      sourcesInAnyWithinToleranceCandidate: collectActiveSourceIdentities(withinTolerance),
    };
  }

  const best = candidates.slice().sort(compareBestAttainable)[0];
  return {
    ok: true,
    status: 'TARGET_NOT_ACHIEVABLE',
    candidate: best,
    targetNi: targetNiValue,
    tolerance: toleranceValue,
    bestAttainableNi: best.estimatedNi,
    gap: best.deviation,
    candidateCount: candidates.length,
    sourcesInAnyWithinToleranceCandidate: new Set(),
  };
}

// Compact derived participation set (this task's Section 9) -- TEST-SUPPORT
// ONLY, used by findBlendRecommendationsMaterialized() above. Production's
// streaming path accumulates this inline instead (see
// findBlendRecommendations()).
function collectActiveSourceIdentities(candidateList) {
  const identities = new Set();
  candidateList.forEach((candidate) => {
    candidate.sources.forEach((source) => {
      if (source.activeUnits > 0) {
        identities.add(normalizeSourceIdentity(source.pileId, source.contractor));
      }
    });
  });
  return identities;
}

// ============================================================
// TEST-SUPPORT ONLY -- V3.0 Phase 4A benchmarking/differential helpers.
// These reuse forEachCandidatePruned()/runStreamingSearch()/
// buildResultFromSearch() from the production section above byte-for-byte
// (never a re-implemented copy) -- the ONLY thing each helper below adds is
// a different way of DRIVING that same traversal (gate permanently
// disabled, diagnostics surfaced, or the SEARCH_SPACE_TOO_LARGE gate
// bypassed). NEVER call any of these from production code.
// ============================================================

// Phase 3 reference, restated on the Phase 4A explicit-node traversal
// structure with chemistry pruning permanently disabled (pruningGate.active
// never set true) -- so tests/v3-phase4a-branch-and-bound.test.mjs can diff
// "Phase 3 unpruned" against production's Phase 4A pruned result while
// holding the traversal SHAPE identical, isolating the comparison to the
// pruning decision itself. Behaviorally equivalent to calling
// findBlendRecommendations() before this phase's edit.
export function findBlendRecommendationsStreamingUnpruned({ targetNi, tolerance = DEFAULT_RECOMMENDATION_TOLERANCE, sources }) {
  const prepared = prepareSearch({ targetNi, tolerance, sources });
  if (!prepared.ok) return prepared.result;
  const { groups, perContractorAllocations, targetNiValue, toleranceValue, searchOrder } = prepared;

  const search = runStreamingSearch(groups, perContractorAllocations, targetNiValue, toleranceValue, false, true, searchOrder);
  const candidateCount = operationalCandidateSpaceSize(perContractorAllocations) - 1;
  return buildResultFromSearch(search, targetNiValue, toleranceValue, candidateCount);
}

// Same production Phase 4A search as findBlendRecommendations(), but also
// returns the { visitedNodes, prunedByChemistry, completedCandidates }
// diagnostics -- kept OUT of findBlendRecommendations()'s own return shape
// so no existing exact-equality/canonicalization test is affected (this
// task's "isolated to tests/dev use").
export function findBlendRecommendationsWithDiagnostics({ targetNi, tolerance = DEFAULT_RECOMMENDATION_TOLERANCE, sources }) {
  const prepared = prepareSearch({ targetNi, tolerance, sources });
  if (!prepared.ok) {
    if (prepared.result.error === 'SEARCH_SPACE_TOO_LARGE') {
      const hardResult = dispatchHardCase(prepared);
      return { result: hardResult, diagnostics: hardResult.diagnostics ?? null };
    }
    return { result: prepared.result, diagnostics: null };
  }
  const {
    groups, groupFleets, perContractorAllocations, targetNiValue, toleranceValue, searchOrder,
  } = prepared;

  let directHardCaseAttempt = null;
  if (shouldDispatchHardCaseDirectly(perContractorAllocations)) {
    directHardCaseAttempt = dispatchHardCase({
      groups, groupFleets, targetNiValue, toleranceValue,
    });
    if (directHardCaseAttempt.error !== 'SEARCH_INCOMPLETE') {
      return { result: directHardCaseAttempt, diagnostics: directHardCaseAttempt.diagnostics ?? null };
    }
    // See findBlendRecommendations()'s own comment on this same fallback.
  }

  const search = runStreamingSearch(groups, perContractorAllocations, targetNiValue, toleranceValue, true, true, searchOrder, NORMAL_ENGINE_PROBE_NODES);
  const candidateCount = operationalCandidateSpaceSize(perContractorAllocations) - 1;
  const result = buildResultFromSearch(search, targetNiValue, toleranceValue, candidateCount);
  if (result.error === 'SEARCH_INCOMPLETE') {
    // See findBlendRecommendations()'s own comment: avoid recomputing an
    // already-known-identical SEARCH_INCOMPLETE a second time.
    const hardResult = directHardCaseAttempt ?? dispatchHardCase({
      groups, groupFleets, targetNiValue, toleranceValue,
    });
    return { result: hardResult, diagnostics: hardResult.diagnostics ?? null };
  }
  result.solverPath = 'NORMAL_BNB';
  return { result, diagnostics: { solverPath: 'NORMAL_BNB', ...search.diagnostics } };
}

// Identical to prepareSearch() (validation, numeric conversion, canonical
// grouping, per-Contractor operational allocation sets) but WITHOUT the
// MAX_ALLOCATIONS_PER_CONTRACTOR per-group safety gate -- exists ONLY so a
// benchmark can exercise the real Branch-and-Bound traversal at sizes
// production's generation-time gate deliberately refuses (this task's
// PERFORMANCE Scenario B), without raising that limit itself. The
// traversal it feeds still goes through forEachCandidatePruned()'s own
// MAX_SEARCH_NODES budget (runSearchDirect() below shares that code path
// with production), so this bypass is a generation-time-only escape
// hatch, never an unbounded one. Production code must always go through
// prepareSearch()'s gated path.
export function prepareSearchUnbounded({ targetNi, tolerance, sources }) {
  const targetError = validateTargetNi(targetNi);
  const toleranceError = validateTolerance(tolerance);
  const { sourceErrors, fleetError, valid: sourcesValid } = validateRecommendationSources(sources);

  if (targetError || toleranceError || !sourcesValid) {
    return { ok: false, result: { ok: false, error: 'INVALID_INPUT', targetError, toleranceError, sourceErrors, fleetError } };
  }

  const targetNiValue = parseDecimalInput(targetNi);
  const toleranceValue = parseDecimalInput(tolerance);
  const numericSources = sources.map(toNumericSource);
  const groups = groupSourcesByContractor(numericSources);
  const perContractorAllocations = groups.map((group) => {
    const fleet = group.sources.reduce((sum, s) => sum + s.assignedUnits, 0);
    const allocations = enumerateOperationalAllocations(fleet, group.sources.length);
    return orderAllocationsForSearch(group, allocations, targetNiValue);
  });

  return { ok: true, groups, perContractorAllocations, targetNiValue, toleranceValue };
}

// Runs the Phase 4A/4B/4C pruned search directly against
// prepareSearchUnbounded()'s output (or prepareSearch()'s -- either shares
// the same shape), returning both the result and its diagnostics.
// Benchmark-only counterpart to findBlendRecommendationsWithDiagnostics()
// that skips prepareSearch()'s own gate call entirely (the caller already
// decided to bypass it via prepareSearchUnbounded()). `enablePruning`
// defaults to true; pass false to benchmark/diff the same traversal shape
// with ALL pruning permanently disabled (the Phase 3 reference behavior).
// `enableRankingPruning` (default true) is the V3.0 Phase 4C sub-toggle --
// pass false (with enablePruning true) to isolate chemistry-only pruning
// (the Phase 4B production behavior) for a Phase 4B-vs-4C comparison.
// `searchOrder` (V3.0 Phase 6A) -- an explicit array of canonical group
// indices to traverse in, e.g. from computeSearchOrderForStrategy() below,
// letting tests/v3-phase6a-search-order.test.mjs benchmark different
// strategies against the SAME prepared groups/perContractorAllocations.
// Defaults to computeContractorSearchOrder()'s production strategy when
// omitted, so every pre-Phase-6A caller of this function (Phase 4A/4B/4C/4D
// benchmarks) keeps working unchanged, now exercising the chosen strategy.
export function runSearchDirect({ groups, perContractorAllocations, targetNiValue, toleranceValue }, enablePruning = true, enableRankingPruning = true, searchOrder = null) {
  const order = searchOrder || computeContractorSearchOrder(groups, perContractorAllocations);
  const search = runStreamingSearch(groups, perContractorAllocations, targetNiValue, toleranceValue, enablePruning, enableRankingPruning, order);
  const candidateCount = operationalCandidateSpaceSize(perContractorAllocations) - 1;
  return { result: buildResultFromSearch(search, targetNiValue, toleranceValue, candidateCount), diagnostics: search.diagnostics };
}
