// ============================================================
// V2.x EXHAUSTIVE REFERENCE IMPLEMENTATION
// TEST-ONLY
// FROZEN FOR V3.0 DIFFERENTIAL TESTING
// DO NOT OPTIMIZE OR "CLEAN UP"
//
// Frozen, test-only snapshot of
// js/pages/calculate/blending-recommendation.js (captured at V3.0 Phase 1,
// production HEAD 5011a37) -- the Recommendation search+ranking
// orchestration entry point. Exposes findBlendRecommendationsReference(),
// a drop-in test-only equivalent of production's
// findBlendRecommendations(), reproducing current V2.x legacy behavior
// exactly (including the current 1-5 DT active-loading-point edge case --
// see operational-continuity-reference.mjs's header comment).
//
// SHARED (NOT snapshotted) production imports: classifyOre
// (js/shared/ore-classification.js) and parseDecimalInput
// (js/pages/calculate/number-input.js). Both are stable domain utilities
// (an ore-grade threshold rule and locale-aware decimal string parsing)
// with zero relationship to search/traversal/ranking algorithms -- V3.0's
// approved direction (generation-time feasibility, streaming incumbents,
// branch-and-bound, Contractor decomposition, best-first traversal, an
// optional Web Worker) cannot alter either without also changing basic
// Blend Calculator behavior across the whole app, which would immediately
// surface via tests/ore-classification.test.mjs and
// tests/number-input.test.mjs failing independently of this oracle. This
// is the one deliberate exception to "snapshot everything search-related"
// (this task's Section 5).
//
// Everything else this file needs (search primitives, source-identity
// validation, ranking) is imported from this same tests/reference/
// v2-exhaustive/ directory, never from js/pages/calculate/ directly -- see
// tests/v3-reference-guard.test.mjs for the automated import-boundary
// check that enforces this.
//
// Any INTENTIONAL modification to this file must be an explicit,
// Owner-approved oracle update. Nothing under js/, index.html, or
// service-worker.js may import this file.
// ============================================================

// Pure Recommendation engine orchestration (V2.4 Phase 3).
//
// PHYSICAL FLEET, NOT CONSUMABLE INVENTORY: `units` on a Recommendation
// source means the physical reusable DT/fleet currently assigned to that
// source -- never a one-shot load count. This module never decrements a
// "remaining" counter and never derives a maximum-cycles figure from a
// physical DT count.
import { classifyOre } from '../../../js/shared/ore-classification.js';
import {
  validatePileId,
  validateContractor,
  validateNi,
  validateUnits,
  validateTonnesPerUnit,
  normalizeSourceIdentity,
} from './calculate-validation-reference.mjs';
import { parseDecimalInput } from '../../../js/pages/calculate/number-input.js';
import {
  simplifyUnitRatio,
  calculateTonnageRatio,
  groupSourcesByContractor,
  countContractorAllocations,
  enumerateAllocations,
  planContractorRelocations,
  MAX_ALLOCATIONS_PER_CONTRACTOR,
  MAX_GLOBAL_CANDIDATES,
} from './fleet-allocation-reference.mjs';
import {
  pickBestCandidate,
  RANKING_MODE_WITHIN_TOLERANCE,
  RANKING_MODE_BEST_ATTAINABLE,
} from './recommendation-ranking-reference.mjs';

// Gate A decision: default +/-0.010% Ni. This constant is exported for
// parity with production; calculation itself never silently overrides a
// caller-provided valid tolerance.
export const DEFAULT_RECOMMENDATION_TOLERANCE = 0.010;

// Representation-noise-only guard for the tolerance-boundary comparison --
// NEVER widens the business tolerance itself. Only absorbs floating-point
// summation noise at the ~1e-9 scale; a candidate genuinely 0.0001 outside
// tolerance is still rejected.
const FLOAT_EPSILON = 1e-9;

const HIGHER_GRADE_CLASSES = new Set(['HGLO', 'MGLO']);

// ============================================================
// VALIDATION
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
// arithmetic without needing a full search. Inclusive comparison using
// unrounded internal precision: `abs(EstimatedNi - TargetNi) <= Tolerance`.
export function isWithinTolerance(estimatedNi, targetNi, tolerance) {
  return Math.abs(estimatedNi - targetNi) <= tolerance + FLOAT_EPSILON;
}

// ============================================================
// CANDIDATE CONSTRUCTION
// ============================================================

// groups: groupSourcesByContractor() output (canonical Contractor-then-
// Pile-ID order). activeBySourceKey: Map<normalizeSourceIdentity(pileId,
// contractor), activeUnits> for THIS candidate -- keyed by the COMPOSITE
// Pile ID + Contractor identity, never Pile ID alone.
// Returns null for the excluded all-zero allocation or for any candidate
// that fails a defensive (structurally unreachable once
// totalActiveUnits > 0) invariant check.
function buildCandidate(groups, activeBySourceKey, targetNi, tolerance) {
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
      // perSource (fleet-allocation-reference.mjs's
      // planContractorRelocations()) is keyed by Pile ID alone, which is
      // safe here ONLY because contractorGroup is already scoped to ONE
      // Contractor -- duplicate validation guarantees Pile ID is unique
      // within a single Contractor's own sources.
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
  // source's tonnesPerUnit is validated > 0.
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
  // signature -- flatSources is already in canonical order (groups/each
  // group's sources were pre-sorted by groupSourcesByContractor()).
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
// SEARCH + RANKING ENTRY POINT
// ============================================================
//
// sources: [{ pileId, contractor, ni, units, tonnesPerUnit }] -- raw
// (possibly string) field values; `units` means physical reusable
// DT/fleet here, never loads actually used.
//
// Returns one of:
//   { ok: false, error: 'INVALID_INPUT', targetError, toleranceError,
//     sourceErrors, fleetError }
//   { ok: false, error: 'SEARCH_SPACE_TOO_LARGE', ... }
//   { ok: false, error: 'NO_FEASIBLE_CANDIDATE' }               (defensive;
//     unreachable once validation requires totalFleet > 0)
//   { ok: true, status: 'OK', candidate, targetNi, tolerance, candidateCount }
//   { ok: true, status: 'TARGET_NOT_ACHIEVABLE', candidate, targetNi,
//     tolerance, bestAttainableNi, gap, candidateCount }
export function findBlendRecommendationsReference({ targetNi, tolerance = DEFAULT_RECOMMENDATION_TOLERANCE, sources }) {
  const targetError = validateTargetNi(targetNi);
  const toleranceError = validateTolerance(tolerance);
  const { sourceErrors, fleetError, valid: sourcesValid } = validateRecommendationSources(sources);

  if (targetError || toleranceError || !sourcesValid) {
    return { ok: false, error: 'INVALID_INPUT', targetError, toleranceError, sourceErrors, fleetError };
  }

  const targetNiValue = parseDecimalInput(targetNi);
  const toleranceValue = parseDecimalInput(tolerance);
  const numericSources = sources.map(toNumericSource);
  const groups = groupSourcesByContractor(numericSources);

  // ---- Bound the search BEFORE generating anything --------
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
  // Keyed by normalizeSourceIdentity(pileId, contractor), never pileId
  // alone.
  function combine(groupIndex, activeBySourceKey) {
    if (groupIndex === groups.length) {
      const candidate = buildCandidate(groups, activeBySourceKey, targetNiValue, toleranceValue);
      if (candidate) candidates.push(candidate);
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
      sourcesInAnyWithinToleranceCandidate: collectActiveSourceIdentities(withinTolerance),
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
    // Always empty here BY DEFINITION -- reaching this branch already
    // means withinTolerance.length === 0.
    sourcesInAnyWithinToleranceCandidate: new Set(),
  };
}

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
