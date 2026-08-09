// V3.0 Phase 2 -- curated edge-case coverage for the generation-time
// operational feasibility change (this task's Section 24-29). Every
// scenario below was verified against the ACTUAL frozen reference and
// production engines before being written (never hand-derived numbers)
// -- see this task's Section 24's "Do not hardcode which valid
// alternative wins unless the scenario is constructed specifically to
// prove that result."
//
// Run with Node's built-in test runner:
//
//   node --test tests/v3-phase2-edge-cases.test.mjs
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { findBlendRecommendations } from '../js/pages/calculate/blending-recommendation.js';
import { findBlendRecommendationsReference } from './reference/v2-exhaustive/blending-recommendation-reference.mjs';
import { canonicalizeRecommendationResult, firstCanonicalDifference } from './reference/canonical-recommendation-result.mjs';
import { APPROVED_DELTAS } from './reference/assert-recommendation-equivalent.mjs';

function activeUnitsOf(candidate, pileId) {
  return candidate.sources.find((s) => s.pileId === pileId).activeUnits;
}

// ============================================================
// 24. LEGACY 34/1-STYLE REGRESSION -- legacy's own winning within-
// tolerance candidate is a 34/1 split; production must never generate the
// "1" leg and instead lands on whatever the search/ranking actually
// produces once that allocation no longer exists (here: no valid
// allocation remains within tolerance at all).
// ============================================================
describe('24. Legacy 34/1-style regression (this task\'s Section 24)', () => {
  const input = {
    targetNi: '1.017142857',
    tolerance: '0.002',
    sources: [
      { pileId: 'L1', contractor: 'CTR-A', ni: '1.00', units: '34', tonnesPerUnit: '50' },
      { pileId: 'L2', contractor: 'CTR-A', ni: '1.60', units: '1', tonnesPerUnit: '50' },
    ],
  };

  test('legacy reference: OK, winning candidate is exactly L1=34 / L2=1 (an invalid 1-5 DT loading point)', () => {
    const result = findBlendRecommendationsReference(input);
    assert.equal(result.ok, true);
    assert.equal(result.status, 'OK');
    assert.equal(activeUnitsOf(result.candidate, 'L1'), 34);
    assert.equal(activeUnitsOf(result.candidate, 'L2'), 1);
  });

  test('V3 production: that 34/1 allocation is never generated; production lands on TARGET_NOT_ACHIEVABLE with L1=35 (all fleet consolidated, 0-or->=6 valid)', () => {
    const result = findBlendRecommendations(input);
    assert.equal(result.ok, true);
    assert.equal(result.status, 'TARGET_NOT_ACHIEVABLE');
    assert.equal(activeUnitsOf(result.candidate, 'L1'), 35);
    assert.equal(activeUnitsOf(result.candidate, 'L2'), 0);
    result.candidate.sources.forEach((s) => {
      assert.ok(s.activeUnits === 0 || s.activeUnits >= 6, `source ${s.pileId} has an invalid activeUnits=${s.activeUnits}`);
    });
  });

  test('classified as the approved MIN_LOADING_POINT_6 delta, not an unexpected mismatch', () => {
    const legacyCanonical = canonicalizeRecommendationResult(findBlendRecommendationsReference(input));
    const productionCanonical = canonicalizeRecommendationResult(findBlendRecommendations(input));
    assert.notEqual(firstCanonicalDifference(legacyCanonical, productionCanonical), null, 'sanity: the two engines really do disagree here');
    const outcome = APPROVED_DELTAS.MIN_LOADING_POINT_6(legacyCanonical, productionCanonical);
    assert.equal(outcome.resolved, true);
    assert.equal(outcome.tier, 'winner-changed');
  });
});

// ============================================================
// 25. ONLY-INVALID-WITHIN-TOLERANCE CASE -- the crucial approved semantic
// change: the SAME scenario as Section 24 above already demonstrates it
// (legacy's only within-tolerance candidate needed L2=1), reproduced here
// with an explicit focus on the OK -> TARGET_NOT_ACHIEVABLE transition
// itself (this task's Section 25).
// ============================================================
describe('25. Only-invalid-within-tolerance case: OK -> TARGET_NOT_ACHIEVABLE (this task\'s Section 25)', () => {
  const input = {
    targetNi: '1.017142857',
    tolerance: '0.002',
    sources: [
      { pileId: 'L1', contractor: 'CTR-A', ni: '1.00', units: '34', tonnesPerUnit: '50' },
      { pileId: 'L2', contractor: 'CTR-A', ni: '1.60', units: '1', tonnesPerUnit: '50' },
    ],
  };

  test('legacy status is OK; production status is TARGET_NOT_ACHIEVABLE for the identical input', () => {
    const legacy = findBlendRecommendationsReference(input);
    const production = findBlendRecommendations(input);
    assert.equal(legacy.status, 'OK');
    assert.equal(production.status, 'TARGET_NOT_ACHIEVABLE');
  });

  test('production never disguises this as OK -- ok:true but status explicitly TARGET_NOT_ACHIEVABLE with bestAttainableNi/gap present', () => {
    const production = findBlendRecommendations(input);
    assert.equal(production.ok, true);
    assert.equal(production.status, 'TARGET_NOT_ACHIEVABLE');
    assert.ok(Number.isFinite(production.bestAttainableNi));
    assert.ok(Number.isFinite(production.gap));
  });
});

// ============================================================
// 26. BEST-ATTAINABLE INVALID LEGACY CASE -- a TARGET_NOT_ACHIEVABLE
// scenario where legacy's closest (best-attainable) candidate itself uses
// 1-5 DT; the BEST_ATTAINABLE comparator does not prioritize operational
// validity, so this is a genuinely different code path from Section 24/25
// (which were within-tolerance/OK cases).
// ============================================================
describe('26. Best-attainable invalid legacy case (this task\'s Section 26)', () => {
  const input = {
    targetNi: '1.05',
    tolerance: '0',
    sources: [
      { pileId: 'L1', contractor: 'CTR-A', ni: '1.00', units: '15', tonnesPerUnit: '50' },
      { pileId: 'L2', contractor: 'CTR-A', ni: '2', units: '1', tonnesPerUnit: '50' },
    ],
  };

  test('legacy reference: TARGET_NOT_ACHIEVABLE, best-attainable is L1=15 / L2=1 (estimatedNi 1.0625, an invalid 1-5 DT loading point)', () => {
    const result = findBlendRecommendationsReference(input);
    assert.equal(result.status, 'TARGET_NOT_ACHIEVABLE');
    assert.equal(activeUnitsOf(result.candidate, 'L1'), 15);
    assert.equal(activeUnitsOf(result.candidate, 'L2'), 1);
    assert.equal(result.candidate.estimatedNi, 1.0625);
  });

  test('V3 production: still TARGET_NOT_ACHIEVABLE, but the best-attainable candidate excludes the 1-5 DT point (L1=16 / L2=0)', () => {
    const result = findBlendRecommendations(input);
    assert.equal(result.status, 'TARGET_NOT_ACHIEVABLE');
    assert.equal(activeUnitsOf(result.candidate, 'L1'), 16);
    assert.equal(activeUnitsOf(result.candidate, 'L2'), 0);
    result.candidate.sources.forEach((s) => {
      assert.ok(s.activeUnits === 0 || s.activeUnits >= 6, `source ${s.pileId} has an invalid activeUnits=${s.activeUnits}`);
    });
  });

  test('classified as the approved MIN_LOADING_POINT_6 delta', () => {
    const legacyCanonical = canonicalizeRecommendationResult(findBlendRecommendationsReference(input));
    const productionCanonical = canonicalizeRecommendationResult(findBlendRecommendations(input));
    const outcome = APPROVED_DELTAS.MIN_LOADING_POINT_6(legacyCanonical, productionCanonical);
    assert.equal(outcome.resolved, true);
    assert.equal(outcome.tier, 'winner-changed');
  });
});

// ============================================================
// 15/27. SMALL CONTRACTOR FLEET < 6 -- no valid active allocation exists
// other than 0. If every Contractor ends up 0, buildCandidate() cannot
// produce a feasible candidate; the engine's EXISTING stable
// NO_FEASIBLE_CANDIDATE status is used, never a silently-relaxed 1-5
// exception (this task's Section 15).
// ============================================================
describe('15/27. Contractor fleet < 6 (this task\'s Section 15)', () => {
  test('single Contractor, single source, fleet=5: legacy finds OK (active=5); production returns NO_FEASIBLE_CANDIDATE', () => {
    const input = {
      targetNi: '1.20',
      tolerance: '0.01',
      sources: [{ pileId: 'L1', contractor: 'CTR-A', ni: '1.20', units: '5', tonnesPerUnit: '50' }],
    };
    const legacy = findBlendRecommendationsReference(input);
    assert.equal(legacy.ok, true);
    assert.equal(legacy.status, 'OK');
    assert.equal(activeUnitsOf(legacy.candidate, 'L1'), 5);

    const production = findBlendRecommendations(input);
    assert.equal(production.ok, false);
    assert.equal(production.error, 'NO_FEASIBLE_CANDIDATE');
  });

  test('every Contractor fleet < 6 (two separate Contractors, fleets 4 and 3): legacy finds OK; production returns NO_FEASIBLE_CANDIDATE', () => {
    const input = {
      targetNi: '1.20',
      tolerance: '0.01',
      sources: [
        { pileId: 'L1', contractor: 'CTR-A', ni: '1.00', units: '4', tonnesPerUnit: '50' },
        { pileId: 'L2', contractor: 'CTR-B', ni: '1.80', units: '3', tonnesPerUnit: '50' },
      ],
    };
    const legacy = findBlendRecommendationsReference(input);
    assert.equal(legacy.ok, true);
    assert.equal(legacy.status, 'OK');

    const production = findBlendRecommendations(input);
    assert.equal(production.ok, false);
    assert.equal(production.error, 'NO_FEASIBLE_CANDIDATE');
  });

  test('production never silently relaxes the minimum -- no candidate.sources entry ever shows an activeUnits in [1,5] anywhere it does succeed', () => {
    // A companion positive check: a fleet of exactly 6 (the smallest
    // FEASIBLE nonzero fleet) succeeds normally.
    const input = {
      targetNi: '1.20',
      tolerance: '0.01',
      sources: [{ pileId: 'L1', contractor: 'CTR-A', ni: '1.20', units: '6', tonnesPerUnit: '50' }],
    };
    const production = findBlendRecommendations(input);
    assert.equal(production.ok, true);
    assert.equal(production.status, 'OK');
    assert.equal(activeUnitsOf(production.candidate, 'L1'), 6);
  });
});

// ============================================================
// 28/29. EXPLICIT BOUNDARY SCENARIOS AT THE FULL-ENGINE LEVEL (the
// primitive-level equivalents live in tests/v3-operational-allocation.test.mjs;
// these confirm the same boundaries hold end-to-end through
// findBlendRecommendations()).
// ============================================================
describe('28. 6-DT boundary at the full-engine level (this task\'s Section 28)', () => {
  test('F=5 (below minimum): production has no feasible candidate; F=6 (at minimum): production succeeds with active=6', () => {
    const belowInput = {
      targetNi: '1.20',
      tolerance: '0',
      sources: [{ pileId: 'L1', contractor: 'CTR-A', ni: '1.20', units: '5', tonnesPerUnit: '50' }],
    };
    const atInput = {
      targetNi: '1.20',
      tolerance: '0',
      sources: [{ pileId: 'L1', contractor: 'CTR-A', ni: '1.20', units: '6', tonnesPerUnit: '50' }],
    };
    assert.equal(findBlendRecommendations(belowInput).ok, false);
    assert.equal(findBlendRecommendations(belowInput).error, 'NO_FEASIBLE_CANDIDATE');

    const atResult = findBlendRecommendations(atInput);
    assert.equal(atResult.ok, true);
    assert.equal(atResult.status, 'OK');
    assert.equal(activeUnitsOf(atResult.candidate, 'L1'), 6);
  });
});

describe('29. 12-DT 6+6 case at the full-engine level (this task\'s Section 29)', () => {
  test('two same-Contractor sources, 6 DT each (fleet=12): production can activate BOTH simultaneously (6/6), matching legacy exactly (strict-compatibility case, this task\'s Section 27)', () => {
    const input = {
      targetNi: '1.30',
      tolerance: '0.05',
      sources: [
        { pileId: 'L1', contractor: 'CTR-A', ni: '1.10', units: '6', tonnesPerUnit: '50' },
        { pileId: 'L2', contractor: 'CTR-A', ni: '1.50', units: '6', tonnesPerUnit: '50' },
      ],
    };
    const legacy = findBlendRecommendationsReference(input);
    const production = findBlendRecommendations(input);
    assert.equal(activeUnitsOf(legacy.candidate, 'L1'), 6);
    assert.equal(activeUnitsOf(legacy.candidate, 'L2'), 6);
    assert.equal(activeUnitsOf(production.candidate, 'L1'), 6);
    assert.equal(activeUnitsOf(production.candidate, 'L2'), 6);

    // STRICT-COMPATIBILITY (Section 27): the winning candidate itself
    // (every field Section 27 lists) is byte-for-byte identical --
    // classified as a 'metadata-only' delta (candidateCount alone
    // differs: 90 raw-equivalent legacy allocations vs. 15 operational).
    const legacyCanonical = canonicalizeRecommendationResult(legacy);
    const productionCanonical = canonicalizeRecommendationResult(production);
    const outcome = APPROVED_DELTAS.MIN_LOADING_POINT_6(legacyCanonical, productionCanonical);
    assert.equal(outcome.resolved, true);
    assert.equal(outcome.tier, 'metadata-only');
    assert.equal(legacyCanonical.candidateCount, 90);
    assert.equal(productionCanonical.candidateCount, 15);
  });
});

// ============================================================
// 27. STRICT-COMPATIBILITY CASES -- full canonical equality required
// (candidateCount aside, per its own documented exemption) when the
// legacy winner already has every active source at 0 or >= 6.
// ============================================================
describe('27. Strict-compatibility cases (this task\'s Section 27)', () => {
  test('a same-Contractor relocation scenario whose legacy winner is already fully valid (0 or >=6) requires complete candidate-level equality', () => {
    // 40 DT / 10 DT split, both sides comfortably >= 6 either way.
    const input = {
      targetNi: '1.40',
      tolerance: '0.02',
      sources: [
        { pileId: 'L1', contractor: 'CTR-A', ni: '1.30', units: '40', tonnesPerUnit: '50' },
        { pileId: 'L2', contractor: 'CTR-A', ni: '1.90', units: '10', tonnesPerUnit: '50' },
      ],
    };
    const legacy = findBlendRecommendationsReference(input);
    const production = findBlendRecommendations(input);
    assert.equal(legacy.status, 'OK');
    legacy.candidate.sources.forEach((s) => assert.ok(s.activeUnits === 0 || s.activeUnits >= 6));

    assert.equal(production.status, legacy.status);
    assert.equal(production.candidate.estimatedNi, legacy.candidate.estimatedNi);
    assert.equal(production.candidate.absoluteDeviation, legacy.candidate.absoluteDeviation);
    assert.equal(production.candidate.totalActiveUnits, legacy.candidate.totalActiveUnits);
    assert.equal(production.candidate.fleetUtilization, legacy.candidate.fleetUtilization);
    assert.equal(production.candidate.allocationSignature, legacy.candidate.allocationSignature);
    assert.deepEqual(production.candidate.relocations, legacy.candidate.relocations);
    assert.deepEqual(
      production.candidate.sources.map((s) => ({ pileId: s.pileId, activeUnits: s.activeUnits })),
      legacy.candidate.sources.map((s) => ({ pileId: s.pileId, activeUnits: s.activeUnits })),
    );
  });
});
