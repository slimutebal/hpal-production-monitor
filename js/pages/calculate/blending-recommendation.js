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
  normalizePileIdForComparison,
} from './calculate-validation.js';
import {
  simplifyUnitRatio,
  calculateTonnageRatio,
  groupSourcesByContractor,
  countContractorAllocations,
  enumerateAllocations,
  planContractorRelocations,
  MAX_ALLOCATIONS_PER_CONTRACTOR,
  MAX_GLOBAL_CANDIDATES,
} from './fleet-allocation.js';
import {
  pickBestCandidate,
  RANKING_MODE_WITHIN_TOLERANCE,
  RANKING_MODE_BEST_ATTAINABLE,
} from './recommendation-ranking.js';

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
  const value = Number(targetNi);
  if (!Number.isFinite(value)) return 'calculate.validation.targetNiInvalid';
  if (!(value > 0)) return 'calculate.validation.targetNiPositive';
  return null;
}

export function validateTolerance(tolerance) {
  if (tolerance === '' || tolerance === null || tolerance === undefined) return 'calculate.validation.toleranceRequired';
  const value = Number(tolerance);
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
// Section 11).
export function validateRecommendationSources(sources) {
  const seen = [];
  const sourceErrors = sources.map((source) => {
    const pileIdError = validatePileId(source.pileId, seen);
    if (!pileIdError) seen.push(normalizePileIdForComparison(source.pileId));
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
  const ni = Number(source.ni);
  return {
    pileId: source.pileId.trim(),
    contractor: source.contractor.trim(),
    ni,
    assignedUnits: Number(source.units),
    tonnesPerUnit: Number(source.tonnesPerUnit),
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
// Pile-ID order). activeByPileId: Map<pileId, activeUnits> for THIS
// candidate. Returns null for the excluded all-zero allocation (this
// task's Section 19) or for any candidate that fails a defensive
// (structurally unreachable once totalActiveUnits > 0) invariant check.
function buildCandidate(groups, activeByPileId, targetNi, tolerance) {
  let totalActiveUnits = 0;
  activeByPileId.forEach((v) => { totalActiveUnits += v; });
  if (totalActiveUnits === 0) return null;

  const flatSources = [];
  const relocations = [];

  groups.forEach((group) => {
    const contractorGroup = group.sources.map((s) => ({
      pileId: s.pileId,
      contractor: s.contractor,
      assignedUnits: s.assignedUnits,
      activeUnits: activeByPileId.get(s.pileId),
    }));
    const { relocations: groupRelocations, perSource } = planContractorRelocations(contractorGroup);
    relocations.push(...groupRelocations);

    group.sources.forEach((s) => {
      const activeUnits = activeByPileId.get(s.pileId);
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
//   { ok: false, error: 'SEARCH_SPACE_TOO_LARGE', ... }        (Section 19)
//   { ok: false, error: 'NO_FEASIBLE_CANDIDATE' }               (defensive;
//     unreachable once validation requires totalFleet > 0, since that
//     guarantees at least one non-all-zero allocation exists)
//   { ok: true, status: 'OK', candidate, targetNi, tolerance, candidateCount }
//   { ok: true, status: 'TARGET_NOT_ACHIEVABLE', candidate, targetNi,
//     tolerance, bestAttainableNi, gap, candidateCount }
export function findBlendRecommendations({ targetNi, tolerance = DEFAULT_RECOMMENDATION_TOLERANCE, sources }) {
  const targetError = validateTargetNi(targetNi);
  const toleranceError = validateTolerance(tolerance);
  const { sourceErrors, fleetError, valid: sourcesValid } = validateRecommendationSources(sources);

  if (targetError || toleranceError || !sourcesValid) {
    return { ok: false, error: 'INVALID_INPUT', targetError, toleranceError, sourceErrors, fleetError };
  }

  const targetNiValue = Number(targetNi);
  const toleranceValue = Number(tolerance);
  const numericSources = sources.map(toNumericSource);
  const groups = groupSourcesByContractor(numericSources);

  // ---- Bound the search BEFORE generating anything (Section 19) --------
  let globalCount = 1;
  for (const group of groups) {
    const fleet = group.sources.reduce((sum, s) => sum + s.assignedUnits, 0);
    const count = countContractorAllocations(fleet, group.sources.length);
    if (count > MAX_ALLOCATIONS_PER_CONTRACTOR) {
      return { ok: false, error: 'SEARCH_SPACE_TOO_LARGE', contractor: group.contractorKey, allocationCount: count };
    }
    globalCount *= count;
    if (globalCount > MAX_GLOBAL_CANDIDATES) {
      return { ok: false, error: 'SEARCH_SPACE_TOO_LARGE', allocationCount: globalCount };
    }
  }

  // ---- Per-Contractor allocation sets, then Cartesian-combine ----------
  const perContractorAllocations = groups.map((group) => {
    const fleet = group.sources.reduce((sum, s) => sum + s.assignedUnits, 0);
    return enumerateAllocations(fleet, group.sources.length);
  });

  const candidates = [];
  function combine(groupIndex, activeByPileId) {
    if (groupIndex === groups.length) {
      const candidate = buildCandidate(groups, activeByPileId, targetNiValue, toleranceValue);
      if (candidate) candidates.push(candidate);
      return;
    }
    const group = groups[groupIndex];
    for (const allocation of perContractorAllocations[groupIndex]) {
      const next = new Map(activeByPileId);
      group.sources.forEach((s, i) => next.set(s.pileId, allocation[i]));
      combine(groupIndex + 1, next);
    }
  }
  combine(0, new Map());

  if (candidates.length === 0) {
    return { ok: false, error: 'NO_FEASIBLE_CANDIDATE' };
  }

  const withinTolerance = candidates.filter((c) => c.withinTolerance);
  if (withinTolerance.length > 0) {
    const best = pickBestCandidate(withinTolerance, RANKING_MODE_WITHIN_TOLERANCE);
    return {
      ok: true,
      status: 'OK',
      candidate: best,
      targetNi: targetNiValue,
      tolerance: toleranceValue,
      candidateCount: candidates.length,
    };
  }

  const best = pickBestCandidate(candidates, RANKING_MODE_BEST_ATTAINABLE);
  return {
    ok: true,
    status: 'TARGET_NOT_ACHIEVABLE',
    candidate: best,
    targetNi: targetNiValue,
    tolerance: toleranceValue,
    bestAttainableNi: best.estimatedNi,
    gap: best.deviation,
    candidateCount: candidates.length,
  };
}
