// Pure Blend Calculator input validation (V2.4 Phase 2 -- Blend
// Calculator). See
// docs/V2.4_CALCULATE_AND_BLENDING_RECOMMENDATION_ARCHITECTURE.md Section
// 29.
//
// PURE MODULE CONTRACT: no DOM access, no router import, no i18n import,
// no localStorage, no network, no side effects. Every exported function
// returns a stable i18n KEY (or null for "valid") -- never a localized
// string -- so calculate-page.js (the DOM layer) is the only place that
// ever calls t(). Raw pile input fields (pileId/ni/units/tonnesPerUnit)
// are treated as the exact strings/values a text input would hand back
// (possibly '', null, or undefined for an empty field) -- never assumed
// to already be clean numbers.

// Trim + case-fold for duplicate comparison only -- never mutates or
// rewrites the Pile ID a user actually typed beyond what duplicate
// detection requires (architecture doc Section 9 / this task's Section 9).
export function normalizePileIdForComparison(pileId) {
  return typeof pileId === 'string' ? pileId.trim().toLowerCase() : '';
}

export function validatePileId(pileId, seenNormalizedIds = []) {
  const trimmed = typeof pileId === 'string' ? pileId.trim() : '';
  if (!trimmed) return 'calculate.validation.pileIdRequired';
  if (seenNormalizedIds.includes(normalizePileIdForComparison(pileId))) {
    return 'calculate.validation.pileIdDuplicate';
  }
  return null;
}

// Contractor (this task's revision -- architecture doc Section 12/29):
// required for every active row, no whitelist/directory lookup, no
// automatic replacement -- just trim outer whitespace and reject blank.
export function validateContractor(contractor) {
  const trimmed = typeof contractor === 'string' ? contractor.trim() : '';
  if (!trimmed) return 'calculate.validation.contractorRequired';
  return null;
}

export function validateNi(ni) {
  if (ni === '' || ni === null || ni === undefined) return 'calculate.validation.niRequired';
  const value = Number(ni);
  if (!Number.isFinite(value)) return 'calculate.validation.niInvalid';
  if (!(value > 0)) return 'calculate.validation.niPositive';
  return null;
}

export function validateUnits(units) {
  if (units === '' || units === null || units === undefined) return 'calculate.validation.unitsRequired';
  const value = Number(units);
  if (!Number.isFinite(value)) return 'calculate.validation.unitsInvalid';
  if (!Number.isInteger(value)) return 'calculate.validation.unitsInteger';
  if (value < 0) return 'calculate.validation.unitsNonNegative';
  return null;
}

export function validateTonnesPerUnit(tonnesPerUnit) {
  if (tonnesPerUnit === '' || tonnesPerUnit === null || tonnesPerUnit === undefined) {
    return 'calculate.validation.tonnesPerUnitRequired';
  }
  const value = Number(tonnesPerUnit);
  if (!Number.isFinite(value)) return 'calculate.validation.tonnesPerUnitInvalid';
  if (!(value > 0)) return 'calculate.validation.tonnesPerUnitPositive';
  return null;
}

// The trailing-blank-row UX rule (updated for this task's Contractor
// revision -- see calculate-page.js's grid input model): a pile row with
// all FIVE fields still empty is an input AFFORDANCE, not an active pile,
// and must be excluded from validation/calculation entirely. Whitespace-only
// Pile ID/Contractor counts as empty (matches validatePileId()/
// validateContractor()'s own trim-based emptiness check); a field
// containing "0" is NOT empty -- the user typed something meaningful, even
// if it will later fail as non-positive.
export function isRowBlank(pile) {
  return !pile.pileId?.trim() && !pile.contractor?.trim() && !pile.ni && !pile.units && !pile.tonnesPerUnit;
}

// Converts one already-valid raw pile (all five validate*() calls above
// returned null for it) into the numeric shape blend-calculator.js's
// calculateWeightedBlend() expects. Never call this on a pile that hasn't
// passed validation -- it does not re-check anything itself. Contractor is
// trimmed like Pile ID but stays a string (metadata only -- Section 3/12).
export function toNumericPile(pile) {
  return {
    pileId: pile.pileId.trim(),
    contractor: pile.contractor.trim(),
    ni: Number(pile.ni),
    units: Number(pile.units),
    tonnesPerUnit: Number(pile.tonnesPerUnit),
  };
}

// Validates a whole pile list at once, in array order -- duplicate
// detection is therefore deterministic: the FIRST occurrence of a given
// (trimmed, case-folded) Pile ID is never itself flagged, only a LATER
// row reusing the same normalized id is (architecture doc Section 9's
// "deterministic behavior" requirement). Field errors on one pile never
// suppress field errors on another; the overall `valid` flag is false if
// ANY pile has ANY field error, or if the whole-blend tonnage check below
// fails.
//
// Returns:
//   {
//     pileErrors: [{ pileId, ni, units, tonnesPerUnit }, ...],  // one per
//       input pile, each field either an i18n key or null
//     blendError: i18n key | null,   // "at least one pile must
//       contribute positive tonnage" -- only ever checked once every
//       pile's own fields are individually valid, so it never fires
//       merely because a field was left blank
//     valid: boolean,
//   }
export function validatePiles(piles) {
  const seen = [];
  const pileErrors = piles.map((pile) => {
    const pileIdError = validatePileId(pile.pileId, seen);
    if (!pileIdError) seen.push(normalizePileIdForComparison(pile.pileId));
    return {
      pileId: pileIdError,
      contractor: validateContractor(pile.contractor),
      ni: validateNi(pile.ni),
      units: validateUnits(pile.units),
      tonnesPerUnit: validateTonnesPerUnit(pile.tonnesPerUnit),
    };
  });

  const hasFieldErrors = pileErrors.some((e) => e.pileId || e.contractor || e.ni || e.units || e.tonnesPerUnit);

  let blendError = null;
  if (!hasFieldErrors) {
    const totalTonnage = piles.reduce((sum, p) => sum + Number(p.units) * Number(p.tonnesPerUnit), 0);
    if (!(totalTonnage > 0)) blendError = 'calculate.validation.noPositiveTonnage';
  }

  return { pileErrors, blendError, valid: !hasFieldErrors && !blendError };
}
