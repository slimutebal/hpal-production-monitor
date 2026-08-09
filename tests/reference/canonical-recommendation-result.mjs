// V3.0 Phase 1 -- test-only canonicalization helper for
// findBlendRecommendations()/findBlendRecommendationsReference() results.
//
// Converts either engine's result into a stable, minimal plain-object
// shape so tests/v3-differential.test.mjs and
// tests/v3-reference-golden.test.mjs can compare/serialize results without
// depending on object identity, Map/Set instances, or any other
// runtime-only implementation detail. This file is a plain data
// transform, not part of the frozen oracle itself -- it may be extended
// (never behaviorally "fixed" retroactively against a specific golden)
// as later phases need more fields, since it does not implement any
// Recommendation business rule of its own.

// `result`: whatever findBlendRecommendations()/findBlendRecommendationsReference()
// returned.
export function canonicalizeRecommendationResult(result) {
  if (!result.ok) {
    return canonicalizeError(result);
  }

  const canonical = {
    ok: true,
    status: result.status,
    targetNi: result.targetNi,
    tolerance: result.tolerance,
    candidateCount: result.candidateCount,
    candidate: canonicalizeCandidate(result.candidate),
    sourcesInAnyWithinToleranceCandidate: [...result.sourcesInAnyWithinToleranceCandidate].sort(),
  };
  if (result.status === 'TARGET_NOT_ACHIEVABLE') {
    canonical.bestAttainableNi = result.bestAttainableNi;
    canonical.gap = result.gap;
  }
  return canonical;
}

function canonicalizeError(result) {
  const canonical = { ok: false, error: result.error };
  if ('contractor' in result) canonical.contractor = result.contractor;
  if ('allocationCount' in result) canonical.allocationCount = result.allocationCount;
  if ('targetError' in result) canonical.targetError = result.targetError;
  if ('toleranceError' in result) canonical.toleranceError = result.toleranceError;
  if ('fleetError' in result) canonical.fleetError = result.fleetError;
  if ('sourceErrors' in result) canonical.sourceErrors = result.sourceErrors;
  return canonical;
}

function canonicalizeCandidate(candidate) {
  return {
    estimatedNi: candidate.estimatedNi,
    deviation: candidate.deviation,
    absoluteDeviation: candidate.absoluteDeviation,
    totalFleetUnits: candidate.totalFleetUnits,
    totalActiveUnits: candidate.totalActiveUnits,
    totalSurplusUnits: candidate.totalSurplusUnits,
    fleetUtilization: candidate.fleetUtilization,
    totalTonnage: candidate.totalTonnage,
    higherGradeUnits: candidate.higherGradeUnits,
    lgloUnits: candidate.lgloUnits,
    higherGradeTonnage: candidate.higherGradeTonnage,
    lgloTonnage: candidate.lgloTonnage,
    unitRatio: { higher: candidate.unitRatio.higher, lglo: candidate.unitRatio.lglo },
    tonnageRatio: { higher: candidate.tonnageRatio.higher, lglo: candidate.tonnageRatio.lglo },
    totalMovedUnits: candidate.totalMovedUnits,
    activeSourceCount: candidate.activeSourceCount,
    allocationSignature: candidate.allocationSignature,
    sources: candidate.sources.map((s) => ({
      pileId: s.pileId,
      contractor: s.contractor,
      oreClass: s.oreClass,
      ni: s.ni,
      tonnesPerUnit: s.tonnesPerUnit,
      assignedUnits: s.assignedUnits,
      activeUnits: s.activeUnits,
      cycleTonnage: s.cycleTonnage,
      moveInUnits: s.moveInUnits,
      moveOutUnits: s.moveOutUnits,
      standbyUnits: s.standbyUnits,
    })),
    relocations: candidate.relocations.map((r) => ({
      contractor: r.contractor,
      fromPileId: r.fromPileId,
      toPileId: r.toPileId,
      units: r.units,
    })),
  };
}

// Returns a short, actionable string describing the FIRST leaf field that
// differs between two canonical results (or null if they are identical),
// e.g. "candidate.sources[2].activeUnits: legacy=6 production=7". Depth-
// first, deterministic key order (object key insertion order / array
// index) so the same mismatch always produces the same message.
export function firstCanonicalDifference(legacyCanonical, productionCanonical) {
  return diff(legacyCanonical, productionCanonical, '$');
}

function diff(a, b, path) {
  if (Object.is(a, b)) return null;

  const aIsArray = Array.isArray(a);
  const bIsArray = Array.isArray(b);
  if (aIsArray !== bIsArray) return `${path}: legacy=${describe(a)} production=${describe(b)}`;

  if (aIsArray) {
    if (a.length !== b.length) return `${path}.length: legacy=${a.length} production=${b.length}`;
    for (let i = 0; i < a.length; i += 1) {
      const result = diff(a[i], b[i], `${path}[${i}]`);
      if (result) return result;
    }
    return null;
  }

  const aIsObject = a !== null && typeof a === 'object';
  const bIsObject = b !== null && typeof b === 'object';
  if (aIsObject !== bIsObject) return `${path}: legacy=${describe(a)} production=${describe(b)}`;

  if (aIsObject) {
    const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])];
    for (const key of keys) {
      const result = diff(a[key], b[key], `${path}.${key}`);
      if (result) return result;
    }
    return null;
  }

  return `${path}: legacy=${describe(a)} production=${describe(b)}`;
}

function describe(value) {
  if (typeof value === 'number') return String(value);
  if (typeof value === 'string') return JSON.stringify(value);
  return String(value);
}
