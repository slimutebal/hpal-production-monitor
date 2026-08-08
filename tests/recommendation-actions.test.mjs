// js/pages/calculate/recommendation-actions.js tests (V2.4 Phase 5 --
// Material Action + Fleet Action). See
// docs/V2.4_CALCULATE_AND_BLENDING_RECOMMENDATION_ARCHITECTURE.md Section
// 23, and this task's Sections 1-17/30-31.
//
// Run with Node's built-in test runner:
//
//   node --test tests/recommendation-actions.test.mjs
//
// Two layers, mirroring tests/recommendation-ranking.test.mjs's own
// documented convention: hand-crafted `recommendation`/candidate fixtures
// below isolate ONE Material/Fleet Action condition at a time (a full
// combinatorial search makes that hard to control precisely -- changing
// one field tends to drag several others along with it); a handful of
// REAL findBlendRecommendations() calls, reusing tests/blending-
// recommendation.test.mjs's own already-proven reference scenarios
// (Known fleet example, Same-Contractor relocation, Cross-Contractor
// negative case), cross-check that the hand-crafted fixture shape below
// actually matches what the real engine produces. Full end-to-end UI
// scenarios (LGLO context-dependence, Target-change, known 5/8 example)
// live in tests/calculate-page.test.mjs.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  calculateMarginalPileImpact,
  deriveRecommendationActions,
  MATERIAL_ACTION_USE,
  MATERIAL_ACTION_LIMIT,
  MATERIAL_ACTION_STOP,
} from '../js/pages/calculate/recommendation-actions.js';
import { findBlendRecommendations } from '../js/pages/calculate/blending-recommendation.js';
import { normalizeSourceIdentity } from '../js/pages/calculate/calculate-validation.js';

/* ============================================================
   FIXTURE HELPERS -- the same minimal-stub convention
   tests/recommendation-ranking.test.mjs already establishes: only the
   fields recommendation-actions.js actually reads.
============================================================ */
function source(overrides) {
  return {
    pileId: 'A',
    contractor: 'SMA',
    oreClass: 'HGLO',
    ni: 1.30,
    tonnesPerUnit: 50,
    assignedUnits: 5,
    activeUnits: 5,
    moveInUnits: 0,
    moveOutUnits: 0,
    standbyUnits: 0,
    ...overrides,
  };
}

function candidate({ sources, estimatedNi, totalTonnage, relocations = [] }) {
  return { sources, estimatedNi, totalTonnage, relocations };
}

function recommendation({ candidate: c, targetNi, status = 'OK', sourcesInAnyWithinToleranceCandidate = new Set() }) {
  return { status, candidate: c, targetNi, tolerance: 0.010, sourcesInAnyWithinToleranceCandidate };
}

function materialActionFor(actionsResult, pileId) {
  return actionsResult.materialActions.find((m) => m.pileId === pileId);
}

function fleetActionFor(actionsResult, pileId) {
  return actionsResult.fleetActions.find((f) => f.pileId === pileId);
}

/* ============================================================
   calculateMarginalPileImpact() (this task's Section 8)
============================================================ */
describe('calculateMarginalPileImpact() -- pure marginal-load arithmetic', () => {
  test('matches the architecture doc Section 23.6 formula directly', () => {
    // New Ni = (CurrentNi*CurrentTonnage + PileNi*TonnesPerDT) / (CurrentTonnage + TonnesPerDT)
    const result = calculateMarginalPileImpact({ currentNi: 1.12, currentTonnage: 600, pileNi: 1.30, tonnesPerDt: 50 });
    const expectedNewNi = (1.12 * 600 + 1.30 * 50) / 650;
    assert.ok(Math.abs(result.newNi - expectedNewNi) < 1e-12);
    assert.ok(Math.abs(result.impact - (expectedNewNi - 1.12)) < 1e-12);
  });

  test('without targetNi, only { newNi, impact } are returned -- no deviation fields', () => {
    const result = calculateMarginalPileImpact({ currentNi: 1.12, currentTonnage: 600, pileNi: 1.30, tonnesPerDt: 50 });
    assert.deepEqual(Object.keys(result).sort(), ['impact', 'newNi']);
  });

  test('with targetNi, previousAbsoluteDeviation/newAbsoluteDeviation/movesTowardTarget are included', () => {
    const result = calculateMarginalPileImpact({ currentNi: 1.10, currentTonnage: 600, pileNi: 1.30, tonnesPerDt: 50, targetNi: 1.12 });
    assert.ok(Math.abs(result.previousAbsoluteDeviation - 0.02) < 1e-9);
    assert.ok(result.newAbsoluteDeviation < result.previousAbsoluteDeviation, 'adding a higher-Ni load must move a below-target blend closer');
    assert.equal(result.movesTowardTarget, true);
  });

  test('an exact tie (no deviation change) is never movesTowardTarget', () => {
    // Adding a load at exactly the current blend Ni changes newNi only
    // negligibly toward target when currentNi already equals target --
    // engineered here as current === target === pileNi, so newNi === target.
    const result = calculateMarginalPileImpact({ currentNi: 1.12, currentTonnage: 600, pileNi: 1.12, tonnesPerDt: 50, targetNi: 1.12 });
    assert.equal(result.newAbsoluteDeviation, result.previousAbsoluteDeviation);
    assert.equal(result.movesTowardTarget, false);
  });

  test('no rounding -- full floating-point precision is preserved', () => {
    const result = calculateMarginalPileImpact({ currentNi: 1 / 3, currentTonnage: 700, pileNi: 2 / 3, tonnesPerDt: 33 });
    assert.notEqual(result.newNi, Number(result.newNi.toFixed(3)));
  });
});

/* ============================================================
   MATERIAL ACTION (this task's Section 30, numbered per that section)
============================================================ */
describe('deriveRecommendationActions() -- Material Action', () => {
  test('1. a source with activeUnits > 0 in the selected candidate -> USE', () => {
    const c = candidate({
      sources: [source({ pileId: 'A', activeUnits: 4, assignedUnits: 5 })],
      estimatedNi: 1.30,
      totalTonnage: 200,
    });
    const actions = deriveRecommendationActions(recommendation({ candidate: c, targetNi: 1.30 }));
    assert.equal(materialActionFor(actions, 'A').action, MATERIAL_ACTION_USE);
  });

  test('2. zero allocation alone does NOT automatically imply STOP (a tie in deviation is not "worse")', () => {
    const c = candidate({
      sources: [
        source({ pileId: 'A', ni: 1.12, activeUnits: 12, assignedUnits: 12 }),
        source({ pileId: 'Z', ni: 1.12, activeUnits: 0, assignedUnits: 3, contractor: 'TII' }), // same Ni as the baseline -- adding it is a pure tie
      ],
      estimatedNi: 1.12,
      totalTonnage: 600,
    });
    const actions = deriveRecommendationActions(recommendation({ candidate: c, targetNi: 1.12 }));
    assert.notEqual(materialActionFor(actions, 'Z').action, MATERIAL_ACTION_STOP);
    assert.equal(materialActionFor(actions, 'Z').action, MATERIAL_ACTION_LIMIT);
  });

  test('3. adding one load that moves TOWARD Target prevents STOP', () => {
    const c = candidate({
      sources: [
        source({ pileId: 'A', ni: 1.30, activeUnits: 12, assignedUnits: 12 }),
        // Baseline (1.30) is above target (1.20); a lower-Ni zero-alloc
        // source pulls the blend DOWN, toward target.
        source({ pileId: 'Z', ni: 1.10, activeUnits: 0, assignedUnits: 3, contractor: 'TII' }),
      ],
      estimatedNi: 1.30,
      totalTonnage: 600,
    });
    const actions = deriveRecommendationActions(recommendation({ candidate: c, targetNi: 1.20 }));
    assert.equal(materialActionFor(actions, 'Z').action, MATERIAL_ACTION_LIMIT);
  });

  test('4. STOP requires ALL THREE conditions -- a truth table over (worsens, requiredElsewhere)', () => {
    const baseCandidate = () => candidate({
      sources: [
        source({ pileId: 'A', ni: 1.12, activeUnits: 12, assignedUnits: 12 }),
        source({ pileId: 'Z', ni: 0.50, activeUnits: 0, assignedUnits: 3, contractor: 'TII', oreClass: 'LGLO' }),
      ],
      estimatedNi: 1.12,
      totalTonnage: 600,
    });
    const zIdentity = normalizeSourceIdentity('Z', 'TII');

    // worsens=true (0.50 is far below target, pulls away), requiredElsewhere=false -> STOP
    const stop = deriveRecommendationActions(recommendation({
      candidate: baseCandidate(), targetNi: 1.12, sourcesInAnyWithinToleranceCandidate: new Set(),
    }));
    assert.equal(materialActionFor(stop, 'Z').action, MATERIAL_ACTION_STOP);

    // worsens=true, requiredElsewhere=true -> LIMIT (condition 3 fails)
    const limitRequired = deriveRecommendationActions(recommendation({
      candidate: baseCandidate(), targetNi: 1.12, sourcesInAnyWithinToleranceCandidate: new Set([zIdentity]),
    }));
    assert.equal(materialActionFor(limitRequired, 'Z').action, MATERIAL_ACTION_LIMIT);

    // worsens=false (target moved to make 0.50 a step TOWARD it), requiredElsewhere=false -> LIMIT (condition 2 fails)
    const limitImproves = deriveRecommendationActions(recommendation({
      candidate: baseCandidate(), targetNi: 0.90, sourcesInAnyWithinToleranceCandidate: new Set(),
    }));
    assert.equal(materialActionFor(limitImproves, 'Z').action, MATERIAL_ACTION_LIMIT);
  });

  test('5. LIMIT when additional usage would worsen distance from Target, but the source is still required by another within-tolerance candidate', () => {
    const c = candidate({
      sources: [
        source({ pileId: 'A', ni: 1.12, activeUnits: 12, assignedUnits: 12 }),
        source({ pileId: 'Z', ni: 0.50, activeUnits: 0, assignedUnits: 3, contractor: 'TII' }),
      ],
      estimatedNi: 1.12,
      totalTonnage: 600,
    });
    const zIdentity = normalizeSourceIdentity('Z', 'TII');
    const actions = deriveRecommendationActions(recommendation({
      candidate: c, targetNi: 1.12, sourcesInAnyWithinToleranceCandidate: new Set([zIdentity]),
    }));
    assert.equal(materialActionFor(actions, 'Z').action, MATERIAL_ACTION_LIMIT);
  });

  test('6. LGLO may be USE', () => {
    const c = candidate({
      sources: [source({ pileId: 'L', oreClass: 'LGLO', ni: 1.03, activeUnits: 8, assignedUnits: 8 })],
      estimatedNi: 1.03,
      totalTonnage: 400,
    });
    const actions = deriveRecommendationActions(recommendation({ candidate: c, targetNi: 1.03 }));
    assert.equal(materialActionFor(actions, 'L').action, MATERIAL_ACTION_USE);
  });

  test('7. the SAME LGLO source may become LIMIT under a different Target (blend already at/above target)', () => {
    // Same LGLO source (Ni 1.03), zero-allocated this time; baseline blend
    // is already AT the (now-low) target, so adding more LGLO (which is
    // lower than 1.03? no -- LGLO here IS the marginal source, and the
    // baseline Higher-only blend is already above a low target) pulls the
    // blend toward -- not away -- from target, per this task's Section 22.
    const c = candidate({
      sources: [
        source({ pileId: 'H', ni: 1.30, activeUnits: 12, assignedUnits: 12 }),
        source({ pileId: 'L', oreClass: 'LGLO', ni: 1.03, activeUnits: 0, assignedUnits: 8, contractor: 'TII' }),
      ],
      estimatedNi: 1.30,
      totalTonnage: 600,
    });
    // Target far below both -- adding LGLO (1.03) is a step toward a low
    // target, so it must not be STOP; the required-elsewhere set is empty
    // (matches condition 3 being irrelevant once condition 2 fails).
    const actions = deriveRecommendationActions(recommendation({ candidate: c, targetNi: 0.80 }));
    assert.equal(materialActionFor(actions, 'L').action, MATERIAL_ACTION_LIMIT);
  });

  test('8. the SAME LGLO source may become STOP under yet another valid scenario', () => {
    const c = candidate({
      sources: [
        source({ pileId: 'H', ni: 1.12, activeUnits: 12, assignedUnits: 12 }),
        source({ pileId: 'L', oreClass: 'LGLO', ni: 1.03, activeUnits: 0, assignedUnits: 8, contractor: 'TII' }),
      ],
      estimatedNi: 1.12,
      totalTonnage: 600,
    });
    // Baseline already exactly on target (deviation 0) -- any LGLO addition
    // (lower Ni) can only worsen, and nothing requires it -> STOP.
    const actions = deriveRecommendationActions(recommendation({
      candidate: c, targetNi: 1.12, sourcesInAnyWithinToleranceCandidate: new Set(),
    }));
    assert.equal(materialActionFor(actions, 'L').action, MATERIAL_ACTION_STOP);
  });

  test('9. HGLO is not universally USE -- a zero-allocated HGLO source can be LIMIT/STOP', () => {
    const c = candidate({
      sources: [
        source({ pileId: 'L', oreClass: 'LGLO', ni: 1.03, activeUnits: 12, assignedUnits: 12 }),
        source({ pileId: 'H', oreClass: 'HGLO', ni: 1.50, activeUnits: 0, assignedUnits: 5, contractor: 'TII' }),
      ],
      estimatedNi: 1.03,
      totalTonnage: 600,
    });
    // Baseline already exactly on target -- adding the higher-Ni HGLO
    // source can only worsen, and nothing requires it -> STOP, never a
    // reflexive USE just because it is HGLO.
    const actions = deriveRecommendationActions(recommendation({
      candidate: c, targetNi: 1.03, sourcesInAnyWithinToleranceCandidate: new Set(),
    }));
    assert.notEqual(materialActionFor(actions, 'H').action, MATERIAL_ACTION_USE);
    assert.equal(materialActionFor(actions, 'H').action, MATERIAL_ACTION_STOP);
  });

  test('10. TARGET_NOT_ACHIEVABLE uses the best-attainable candidate as the baseline (only 2 STOP conditions, condition 3 vacuous)', () => {
    const c = candidate({
      sources: [
        source({ pileId: 'H', ni: 1.087, activeUnits: 10, assignedUnits: 10 }),
        source({ pileId: 'Z', ni: 0.50, activeUnits: 0, assignedUnits: 3, contractor: 'TII' }),
      ],
      estimatedNi: 1.087,
      totalTonnage: 500,
    });
    // Even though `sourcesInAnyWithinToleranceCandidate` is omitted
    // (defaults to empty, exactly what blending-recommendation.js always
    // returns for TARGET_NOT_ACHIEVABLE), Z must still resolve deterministically.
    const actions = deriveRecommendationActions(recommendation({
      candidate: c, targetNi: 1.120, status: 'TARGET_NOT_ACHIEVABLE',
    }));
    assert.equal(actions.status, 'TARGET_NOT_ACHIEVABLE');
    assert.equal(materialActionFor(actions, 'H').action, MATERIAL_ACTION_USE);
    // 0.50 is far below the 1.087 best-attainable baseline -- adding it
    // worsens progress toward 1.120, and nothing "requires" it (the set is
    // always empty in this status) -> STOP.
    assert.equal(materialActionFor(actions, 'Z').action, MATERIAL_ACTION_STOP);
  });

  test('11. same Pile ID, different Contractor -- actions stay fully independent', () => {
    const c = candidate({
      sources: [
        source({ pileId: 'L30', contractor: 'MRP', ni: 1.12, activeUnits: 12, assignedUnits: 12 }),
        source({ pileId: 'L30', contractor: 'TII', ni: 0.40, activeUnits: 0, assignedUnits: 4 }),
      ],
      estimatedNi: 1.12,
      totalTonnage: 600,
    });
    const actions = deriveRecommendationActions(recommendation({
      candidate: c, targetNi: 1.12, sourcesInAnyWithinToleranceCandidate: new Set(),
    }));
    const mrp = actions.materialActions.find((m) => m.contractor === 'MRP');
    const tii = actions.materialActions.find((m) => m.contractor === 'TII');
    assert.notEqual(mrp.sourceIdentity, tii.sourceIdentity);
    assert.equal(mrp.action, MATERIAL_ACTION_USE);
    assert.equal(tii.action, MATERIAL_ACTION_STOP);
  });

  test('12. deterministic repeated output -- calling twice on the same recommendation produces byte-identical results', () => {
    const c = candidate({
      sources: [
        source({ pileId: 'H', ni: 1.30, activeUnits: 4, assignedUnits: 5 }),
        source({ pileId: 'L', oreClass: 'LGLO', ni: 1.03, activeUnits: 8, assignedUnits: 8, contractor: 'TII' }),
      ],
      estimatedNi: 1.12,
      totalTonnage: 600,
    });
    const rec = recommendation({ candidate: c, targetNi: 1.12 });
    const first = deriveRecommendationActions(rec);
    const second = deriveRecommendationActions(rec);
    assert.deepEqual(first, second);
  });
});

/* ============================================================
   FLEET ACTION (this task's Section 31, numbered per that section)
============================================================ */
describe('deriveRecommendationActions() -- Fleet Action', () => {
  test('1. assigned=5, active=4, no relocation possible -> USE=4, SEPARATE=1', () => {
    const c = candidate({
      sources: [source({ pileId: 'A', assignedUnits: 5, activeUnits: 4, standbyUnits: 1 })],
      estimatedNi: 1.30,
      totalTonnage: 200,
    });
    const actions = deriveRecommendationActions(recommendation({ candidate: c, targetNi: 1.30 }));
    const fleet = fleetActionFor(actions, 'A');
    assert.equal(fleet.useUnits, 4);
    assert.equal(fleet.moveOutUnits, 0);
    assert.equal(fleet.moveInUnits, 0);
    assert.equal(fleet.separateUnits, 1);
  });

  test('2. same Contractor donor/receiver -- A: assigned5/active4/moveOut1; B: assigned7/active8/moveIn1', () => {
    const relocations = [{ contractor: 'SMA', fromPileId: 'A', toPileId: 'B', units: 1 }];
    const c = candidate({
      sources: [
        source({ pileId: 'A', assignedUnits: 5, activeUnits: 4, moveOutUnits: 1, standbyUnits: 0 }),
        source({ pileId: 'B', assignedUnits: 7, activeUnits: 8, moveInUnits: 1 }),
      ],
      estimatedNi: 1.12,
      totalTonnage: 600,
      relocations,
    });
    const actions = deriveRecommendationActions(recommendation({ candidate: c, targetNi: 1.12 }));

    const a = fleetActionFor(actions, 'A');
    assert.equal(a.useUnits, 4);
    assert.equal(a.moveOutUnits, 1);
    assert.equal(a.separateUnits, 0);
    assert.deepEqual(a.relocationsOut, relocations);
    assert.deepEqual(a.relocationsIn, []);

    const b = fleetActionFor(actions, 'B');
    assert.equal(b.useUnits, 7); // min(assignedUnits=7, activeUnits=8)
    assert.equal(b.moveInUnits, 1);
    assert.deepEqual(b.relocationsIn, relocations);
    assert.deepEqual(b.relocationsOut, []);
  });

  test('3. per-Contractor fleet balances: assignedUnits = useUnits + moveOutUnits + separateUnits (donor side)', () => {
    const c = candidate({
      sources: [
        source({ pileId: 'A', assignedUnits: 5, activeUnits: 4, moveOutUnits: 1, standbyUnits: 0 }),
        source({ pileId: 'B', assignedUnits: 7, activeUnits: 8, moveInUnits: 1 }),
      ],
      estimatedNi: 1.12,
      totalTonnage: 600,
      relocations: [{ contractor: 'SMA', fromPileId: 'A', toPileId: 'B', units: 1 }],
    });
    const actions = deriveRecommendationActions(recommendation({ candidate: c, targetNi: 1.12 }));
    actions.fleetActions.forEach((f) => {
      assert.equal(f.assignedUnits, f.useUnits + f.moveOutUnits + f.separateUnits, `${f.pileId}: assignedUnits invariant`);
    });
  });

  test('4. cross-Contractor MOVE is never produced (real engine cross-Contractor scenario)', () => {
    // Reuses tests/blending-recommendation.test.mjs's own proven Cross-
    // Contractor negative case shape (Higher SMA / LGLO TII).
    const result = findBlendRecommendations({
      targetNi: 1.120,
      tolerance: 0.010,
      sources: [
        { pileId: 'Higher', contractor: 'SMA', ni: '1.30', units: '5', tonnesPerUnit: '50' },
        { pileId: 'Lglo', contractor: 'TII', ni: '1.03', units: '8', tonnesPerUnit: '50' },
      ],
    });
    assert.equal(result.ok, true);
    assert.equal(result.candidate.relocations.length, 0);

    const actions = deriveRecommendationActions(result);
    actions.fleetActions.forEach((f) => {
      assert.deepEqual(f.relocationsOut, []);
      assert.deepEqual(f.relocationsIn, []);
    });
    // The real engine's own known numbers -- Higher is a would-be donor
    // with no same-Contractor receiver, so its idle capacity is SEPARATE.
    const higher = fleetActionFor(actions, 'Higher');
    assert.equal(higher.useUnits, 4);
    assert.equal(higher.moveOutUnits, 0);
    assert.equal(higher.separateUnits, 1);
  });

  test('5. total physical fleet is conserved -- moved-out units equal moved-in units, real engine Same-Contractor scenario', () => {
    // Reuses tests/blending-recommendation.test.mjs's own proven Same-
    // Contractor relocation scenario (both sources under SMA).
    const result = findBlendRecommendations({
      targetNi: 1.120,
      tolerance: 0.010,
      sources: [
        { pileId: 'Higher', contractor: 'SMA', ni: '1.30', units: '5', tonnesPerUnit: '50' },
        { pileId: 'Lglo', contractor: 'SMA', ni: '1.03', units: '7', tonnesPerUnit: '50' },
      ],
    });
    assert.equal(result.ok, true);

    const actions = deriveRecommendationActions(result);
    const totalAssigned = actions.fleetActions.reduce((sum, f) => sum + f.assignedUnits, 0);
    const totalUse = actions.fleetActions.reduce((sum, f) => sum + f.useUnits, 0);
    const totalMoveOut = actions.fleetActions.reduce((sum, f) => sum + f.moveOutUnits, 0);
    const totalMoveIn = actions.fleetActions.reduce((sum, f) => sum + f.moveInUnits, 0);
    const totalSeparate = actions.fleetActions.reduce((sum, f) => sum + f.separateUnits, 0);

    assert.equal(totalMoveOut, totalMoveIn, 'every moved-out DT must be accounted for as moved-in somewhere -- no DT created or destroyed');
    assert.equal(totalAssigned, totalUse + totalMoveOut + totalSeparate, 'no DT may disappear or be created (donor-side accounting)');
    assert.equal(totalAssigned, 12); // 5 + 7, matches the proven reference scenario
  });

  test('6. a source with assignedUnits === activeUnits: all USE, zero MOVE/SEPARATE', () => {
    const c = candidate({
      sources: [source({ pileId: 'A', assignedUnits: 8, activeUnits: 8 })],
      estimatedNi: 1.03,
      totalTonnage: 400,
    });
    const actions = deriveRecommendationActions(recommendation({ candidate: c, targetNi: 1.03 }));
    const fleet = fleetActionFor(actions, 'A');
    assert.equal(fleet.useUnits, 8);
    assert.equal(fleet.moveOutUnits, 0);
    assert.equal(fleet.moveInUnits, 0);
    assert.equal(fleet.separateUnits, 0);
  });
});

/* ============================================================
   HARD ARCHITECTURAL RULE (this task's Sections 1/17) -- derivation never
   alters the primary Recommendation candidate/ranking/Hopper Pattern.
============================================================ */
describe('Non-circularity -- action derivation never mutates or re-selects the candidate', () => {
  test('the input recommendation object is never mutated', () => {
    const c = candidate({
      sources: [source({ pileId: 'A', activeUnits: 4, assignedUnits: 5 })],
      estimatedNi: 1.30,
      totalTonnage: 200,
    });
    const rec = recommendation({ candidate: c, targetNi: 1.30 });
    const snapshot = JSON.parse(JSON.stringify(rec, (key, value) => (value instanceof Set ? [...value] : value)));
    deriveRecommendationActions(rec);
    const after = JSON.parse(JSON.stringify(rec, (key, value) => (value instanceof Set ? [...value] : value)));
    assert.deepEqual(after, snapshot);
  });

  test('real-engine integration: Known fleet example (Higher SMA 5 DT / LGLO TII 8 DT) -- actions never change candidate.unitRatio/estimatedNi', () => {
    const result = findBlendRecommendations({
      targetNi: 1.120,
      tolerance: 0.010,
      sources: [
        { pileId: 'Higher', contractor: 'SMA', ni: '1.30', units: '5', tonnesPerUnit: '50' },
        { pileId: 'Lglo', contractor: 'TII', ni: '1.03', units: '8', tonnesPerUnit: '50' },
      ],
    });
    const unitRatioBefore = { ...result.candidate.unitRatio };
    const estimatedNiBefore = result.candidate.estimatedNi;

    deriveRecommendationActions(result);

    assert.deepEqual(result.candidate.unitRatio, unitRatioBefore);
    assert.equal(result.candidate.estimatedNi, estimatedNiBefore);
  });
});
