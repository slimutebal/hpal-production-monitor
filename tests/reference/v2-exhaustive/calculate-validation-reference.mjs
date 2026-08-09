// ============================================================
// V2.x EXHAUSTIVE REFERENCE IMPLEMENTATION
// TEST-ONLY
// FROZEN FOR V3.0 DIFFERENTIAL TESTING
// DO NOT OPTIMIZE OR "CLEAN UP"
//
// Frozen, test-only snapshot of js/pages/calculate/calculate-validation.js
// (captured at V3.0 Phase 1, production HEAD 5011a37), limited to the
// functions the Recommendation search path actually depends on:
// validatePileId/validateContractor/validateNi/validateUnits/
// validateTonnesPerUnit (per-source field validation) and
// normalizeSourceIdentity/normalizeContractorForComparison (the composite
// Pile ID + Contractor identity keys used as Map keys throughout
// blending-recommendation-reference.mjs and operational-continuity-
// reference.mjs's Contractor grouping).
//
// This is snapshotted rather than shared because normalizeSourceIdentity/
// normalizeContractorForComparison are exactly the kind of "Contractor
// decomposition"-adjacent identity logic the approved V3.0 direction may
// touch -- unlike ore classification/decimal parsing (genuinely stable,
// imported directly from production, see blending-recommendation-
// reference.mjs), a change here would be a search-semantics change, not a
// display-only change.
//
// Any INTENTIONAL modification to this file must be an explicit,
// Owner-approved oracle update. Nothing under js/, index.html, or
// service-worker.js may import this file.
// ============================================================

// Pure Blend Calculator input validation (V2.4 Phase 2 -- Blend
// Calculator). See
// docs/V2.4_CALCULATE_AND_BLENDING_RECOMMENDATION_ARCHITECTURE.md Section
// 29.
//
// LOCALE-AWARE DECIMAL INPUT (V2.4.1 Bug A): Ni and Tonnes/DT are DECIMAL
// fields -- both "1.15" and "1,15" must validate identically, via the one
// shared parseDecimalInput() (imported directly from production
// number-input.js -- see this file's header for why that import is safe).
import { parseDecimalInput } from '../../../js/pages/calculate/number-input.js';

// Trim + case-fold for duplicate comparison only -- never mutates or
// rewrites the Pile ID a user actually typed beyond what duplicate
// detection requires (architecture doc Section 9).
export function normalizePileIdForComparison(pileId) {
  return typeof pileId === 'string' ? pileId.trim().toLowerCase() : '';
}

// Same trim + case-fold normalization, applied to Contractor.
export function normalizeContractorForComparison(contractor) {
  return typeof contractor === 'string' ? contractor.trim().toLowerCase() : '';
}

// Composite source identity used for duplicate detection: the same Pile ID
// may legitimately appear more than once as long as Contractor differs
// (e.g. "L30/MRP" and "L30/TII" are distinct sources); only an identical
// normalized Pile ID + Contractor pair is a true duplicate.
export function normalizeSourceIdentity(pileId, contractor) {
  return JSON.stringify([normalizePileIdForComparison(pileId), normalizeContractorForComparison(contractor)]);
}

export function validatePileId(pileId, contractor, seenNormalizedIdentities = []) {
  const trimmed = typeof pileId === 'string' ? pileId.trim() : '';
  if (!trimmed) return 'calculate.validation.pileIdRequired';
  if (seenNormalizedIdentities.includes(normalizeSourceIdentity(pileId, contractor))) {
    return 'calculate.validation.pileIdDuplicate';
  }
  return null;
}

export function validateContractor(contractor) {
  const trimmed = typeof contractor === 'string' ? contractor.trim() : '';
  if (!trimmed) return 'calculate.validation.contractorRequired';
  return null;
}

export function validateNi(ni) {
  if (ni === '' || ni === null || ni === undefined) return 'calculate.validation.niRequired';
  const value = parseDecimalInput(ni);
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
  const value = parseDecimalInput(tonnesPerUnit);
  if (!Number.isFinite(value)) return 'calculate.validation.tonnesPerUnitInvalid';
  if (!(value > 0)) return 'calculate.validation.tonnesPerUnitPositive';
  return null;
}
