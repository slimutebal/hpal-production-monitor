// Pure Planned Blend Recovery (V2.4 Phase 6). See
// docs/V2.4_CALCULATE_AND_BLENDING_RECOMMENDATION_ARCHITECTURE.md Sections
// 24-26, and this task's Sections 1/3-6/12-17.
//
// PURE MODULE CONTRACT: no DOM, no i18n, no router, no license, no
// localStorage, no network. Every exported validate*() function returns a
// stable i18n KEY (or null for "valid"), matching blending-recommendation.js's
// own validateTargetNi()/validateTolerance() convention -- never a
// localized string.
//
// V2.4 CORE BASELINE (architecture doc Section 25.1, this task's Section
// 1): this module has NO concept of Monitor, Report, actual cumulative
// FPP production, lab-feed cumulative results, planned total shift
// tonnage, or sampling history. `currentNi`/`currentTonnage` are always
// caller-supplied numbers -- the caller (calculate-page.js) is
// responsible for sourcing them from the best-attainable Recommendation
// candidate's own `estimatedNi`/`totalTonnage` (never the live sticky
// Blend summary) per architecture doc Section 25.1's explicit
// requirement. This module has no way to know or enforce which baseline
// the caller actually used -- that responsibility lives entirely in
// calculate-page.js, and is covered by tests/calculate-page.test.mjs.
import { normalizeContractorForComparison, normalizePileIdForComparison } from './calculate-validation.js';

// ============================================================
// VALIDATION (this task's Section 5)
// ============================================================
export function validateAddedUnits(addedUnits) {
  if (addedUnits === '' || addedUnits === null || addedUnits === undefined) return 'calculate.validation.recoveryAddedUnitsRequired';
  const value = Number(addedUnits);
  if (!Number.isFinite(value)) return 'calculate.validation.recoveryAddedUnitsInvalid';
  if (!Number.isInteger(value)) return 'calculate.validation.recoveryAddedUnitsInteger';
  if (!(value > 0)) return 'calculate.validation.recoveryAddedUnitsPositive';
  return null;
}

export function validateRecoveryTonnesPerUnit(tonnesPerUnit) {
  if (tonnesPerUnit === '' || tonnesPerUnit === null || tonnesPerUnit === undefined) return 'calculate.validation.recoveryTonnesPerUnitRequired';
  const value = Number(tonnesPerUnit);
  if (!Number.isFinite(value)) return 'calculate.validation.recoveryTonnesPerUnitInvalid';
  if (!(value > 0)) return 'calculate.validation.recoveryTonnesPerUnitPositive';
  return null;
}

// ============================================================
// RECOVERY FORMULA (architecture doc Section 25, this task's Section 3-4)
//
//   AddedTonnage  = AddedUnits * TonnesPerUnit
//   RequiredNewNi = (TargetNi*(CurrentTonnage+AddedTonnage) - CurrentNi*CurrentTonnage) / AddedTonnage
//
// `currentNi`/`currentTonnage`/`targetNi` are trusted numeric baseline
// values (the caller's already-validated best-attainable Recommendation
// output) -- only `addedUnits`/`tonnesPerUnit` are raw, possibly-string UI
// input and go through the validators above. Returns raw numeric values,
// no rounding anywhere in this module (formatting is the DOM layer's job,
// same convention as blend-calculator.js/blending-recommendation.js).
//
// Returns:
//   { ok: false, error: 'INVALID_INPUT', addedUnitsError, tonnesPerUnitError }
//   { ok: false, error: 'INVALID_BASELINE' }   (defensive; see below)
//   { ok: false, error: 'ADDED_TONNAGE_ZERO' } (defensive; see below)
//   { ok: true, currentNi, currentTonnage, targetNi, addedUnits,
//     tonnesPerUnit, addedTonnage, requiredNi }
// ============================================================
export function calculateRequiredNewDomeNi({ currentNi, currentTonnage, targetNi, addedUnits, tonnesPerUnit }) {
  const addedUnitsError = validateAddedUnits(addedUnits);
  const tonnesPerUnitError = validateRecoveryTonnesPerUnit(tonnesPerUnit);
  if (addedUnitsError || tonnesPerUnitError) {
    return { ok: false, error: 'INVALID_INPUT', addedUnitsError, tonnesPerUnitError };
  }

  // Defensive only -- unreachable via calculate-page.js, which only ever
  // supplies currentNi/currentTonnage/targetNi from an already-successful
  // TARGET_NOT_ACHIEVABLE findBlendRecommendations() result (this task's
  // Section 1). Kept explicit per this task's Section 5 ("Current planned
  // tonnage: finite, > 0; Target/current Ni: finite") rather than trusting
  // the caller silently.
  if (!Number.isFinite(currentNi) || !Number.isFinite(currentTonnage) || !(currentTonnage > 0) || !Number.isFinite(targetNi)) {
    return { ok: false, error: 'INVALID_BASELINE' };
  }

  const addedUnitsValue = Number(addedUnits);
  const tonnesPerUnitValue = Number(tonnesPerUnit);
  const addedTonnage = addedUnitsValue * tonnesPerUnitValue;

  // Defensive only -- unreachable given the two validators above (a
  // positive integer times a positive finite number is always positive),
  // kept explicit per this task's Section 5 ("AddedTonnage = 0: validation
  // failure. Do not silently return Infinity/NaN.").
  if (!(addedTonnage > 0)) {
    return { ok: false, error: 'ADDED_TONNAGE_ZERO' };
  }

  // Full-precision arithmetic, division exactly once -- no rounding
  // before the final display (this task's Section 3/24J).
  const requiredNi = (targetNi * (currentTonnage + addedTonnage) - currentNi * currentTonnage) / addedTonnage;

  return {
    ok: true,
    currentNi,
    currentTonnage,
    targetNi,
    addedUnits: addedUnitsValue,
    tonnesPerUnit: tonnesPerUnitValue,
    addedTonnage,
    requiredNi,
  };
}

// ============================================================
// AVAILABLE DOME MATCHING (architecture doc Section 26, this task's
// Sections 14-17)
//
// `sources`: the best-attainable candidate's own `.sources` array
// (pileId/contractor/ni already numeric, canonical Contractor-then-
// Pile-ID order) -- the SAME array Material/Fleet Actions already read,
// never a second independent lookup.
//
// This is a CHEMICAL-ONLY match: source.ni >= requiredNi, compared at
// full unrounded precision (this task's Section 25 test 4). It proves
// NOTHING about available tonnage, stockpile inventory, or whether enough
// loads can be supplied for a finite campaign (this task's Section 16) --
// `source.units` here means physical reusable fleet, not consumable
// material tonnage. A qualifying source may also already be fully
// committed to the best-attainable candidate itself (this task's Section
// 17) -- the caller must present this list as "meets minimum Ni", never
// as "guaranteed available correction material".
//
// Deterministic ordering (this task's Section 15 -- an explicit
// narrowing of architecture doc Section 26's fuller "must still consider
// fleet utilization/operational simplicity" language for THIS phase, not
// a contradiction of it: Phase 6 does not invent a second optimizer):
//   1. lowest qualifying Ni first (never highest-Ni-first);
//   2. then normalized Contractor;
//   3. then normalized Pile ID.
// ============================================================
export function findQualifyingSources(sources, requiredNi) {
  return sources
    .filter((s) => s.ni >= requiredNi)
    .slice()
    .sort((a, b) => {
      if (a.ni !== b.ni) return a.ni - b.ni;
      const ca = normalizeContractorForComparison(a.contractor);
      const cb = normalizeContractorForComparison(b.contractor);
      if (ca !== cb) return ca < cb ? -1 : 1;
      const pa = normalizePileIdForComparison(a.pileId);
      const pb = normalizePileIdForComparison(b.pileId);
      return pa < pb ? -1 : pa > pb ? 1 : 0;
    });
}
