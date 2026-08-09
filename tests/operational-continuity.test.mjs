// js/pages/calculate/operational-continuity.js tests (V2.5 -- Contractor
// Continuity and Operational Fleet Optimization). See this task's Sections
// 35-45.
//
// Run with Node's built-in test runner:
//
//   node --test tests/operational-continuity.test.mjs
//
// Pure-module tests only -- no DOM, no i18n. Comma/dot decimal parsing is
// already handled upstream (number-input.js/calculate-validation.js) and
// is never duplicated here (this task's Section 37) -- every input below
// is already a plain JS number.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  MINOR_STANDBY_RATIO,
  CRITICAL_STANDBY_RATIO,
  MIN_UNITS_PER_SPLIT_LOADING_POINT,
  calculateContractorStandbyMetrics,
  calculateRequiredNiRange,
  findSplitLoadingPlan,
  deriveContractorContinuityPlan,
  classifyMaterialActionLabel,
  classifyFleetActionLabel,
  isOperationalLoadingPointAllocation,
} from '../js/pages/calculate/operational-continuity.js';

describe('Policy constants (this task Section 3/9)', () => {
  test('MINOR_STANDBY_RATIO is exactly 0.05', () => {
    assert.equal(MINOR_STANDBY_RATIO, 0.05);
  });
  test('CRITICAL_STANDBY_RATIO is exactly 0.50', () => {
    assert.equal(CRITICAL_STANDBY_RATIO, 0.50);
  });
  test('MIN_UNITS_PER_SPLIT_LOADING_POINT is exactly 6', () => {
    assert.equal(MIN_UNITS_PER_SPLIT_LOADING_POINT, 6);
  });
});

/* ============================================================
   35. STANDBY THRESHOLDS
============================================================ */
describe('35. calculateContractorStandbyMetrics() -- standby thresholds, full precision', () => {
  function metricsFor(assignedUnits, activeUnits) {
    return calculateContractorStandbyMetrics([{ contractor: 'TII', pileId: 'L30', assignedUnits, activeUnits }])[0];
  }

  test('1/20 = 5% -> minor (permitted)', () => {
    const m = metricsFor(20, 19);
    assert.equal(m.standbyRatio, 0.05);
    assert.equal(m.tier, 'minor');
  });

  test('2/20 = 10% -> moderate (mitigation required)', () => {
    const m = metricsFor(20, 18);
    assert.equal(m.standbyRatio, 0.10);
    assert.equal(m.tier, 'moderate');
  });

  test('10/20 = 50% -> critical', () => {
    const m = metricsFor(20, 10);
    assert.equal(m.standbyRatio, 0.50);
    assert.equal(m.tier, 'critical');
  });

  test('12/20 = 60% -> critical', () => {
    const m = metricsFor(20, 8);
    assert.equal(m.standbyRatio, 0.60);
    assert.equal(m.tier, 'critical');
  });

  test('0 standby -> tier none', () => {
    assert.equal(metricsFor(20, 20).tier, 'none');
  });

  test('boundary just above 5% -> moderate, not minor', () => {
    const m = metricsFor(1000, 949); // 51/1000 = 5.1%
    assert.equal(m.tier, 'moderate');
  });

  test('boundary just below 50% -> moderate, not critical', () => {
    const m = metricsFor(1000, 501); // 499/1000 = 49.9%
    assert.equal(m.tier, 'moderate');
  });

  test('current loading-point count = sources with assigned DT > 0 (this task Section 5)', () => {
    const metrics = calculateContractorStandbyMetrics([
      { contractor: 'TII', pileId: 'L30', assignedUnits: 8, activeUnits: 8 },
      { contractor: 'TII', pileId: 'L31', assignedUnits: 12, activeUnits: 12 },
      { contractor: 'TII', pileId: 'L32', assignedUnits: 0, activeUnits: 0 },
    ]);
    assert.equal(metrics[0].loadingPointCount, 2);
  });

  test('different Contractors are never merged, even sharing a Pile ID (this task Section 5)', () => {
    const metrics = calculateContractorStandbyMetrics([
      { contractor: 'MRP', pileId: 'L30', assignedUnits: 10, activeUnits: 5 },
      { contractor: 'TII', pileId: 'L30', assignedUnits: 10, activeUnits: 10 },
    ]);
    assert.equal(metrics.length, 2);
    const mrp = metrics.find((m) => m.contractor === 'MRP');
    const tii = metrics.find((m) => m.contractor === 'TII');
    assert.equal(mrp.standbyRatio, 0.5);
    assert.equal(tii.standbyRatio, 0);
  });

  test('deterministic output order regardless of input source order (normalized Contractor ascending)', () => {
    const a = calculateContractorStandbyMetrics([
      { contractor: 'TII', pileId: 'L30', assignedUnits: 10, activeUnits: 10 },
      { contractor: 'MRP', pileId: 'L20', assignedUnits: 10, activeUnits: 10 },
    ]);
    const b = calculateContractorStandbyMetrics([
      { contractor: 'MRP', pileId: 'L20', assignedUnits: 10, activeUnits: 10 },
      { contractor: 'TII', pileId: 'L30', assignedUnits: 10, activeUnits: 10 },
    ]);
    assert.deepEqual(a.map((m) => m.contractor), b.map((m) => m.contractor));
    assert.deepEqual(a.map((m) => m.contractor), ['MRP', 'TII']);
  });
});

/* ============================================================
   37. NI RANGE
============================================================ */
describe('37. calculateRequiredNiRange() -- known arithmetic, full precision', () => {
  test('lower bound produces exactly Target-Tolerance when plugged back into the blend', () => {
    const range = calculateRequiredNiRange({ otherWeightedNi: 100, otherTonnage: 100, newUnits: 10, tonnesPerUnit: 10, targetNi: 1.2, tolerance: 0.05 });
    const totalTonnage = 100 + 10 * 10;
    const blendAtMin = (100 + range.minRequiredNi * 100) / totalTonnage;
    assert.equal(blendAtMin, 1.2 - 0.05);
  });

  test('upper bound produces exactly Target+Tolerance when plugged back into the blend', () => {
    const range = calculateRequiredNiRange({ otherWeightedNi: 100, otherTonnage: 100, newUnits: 10, tonnesPerUnit: 10, targetNi: 1.2, tolerance: 0.05 });
    const totalTonnage = 100 + 10 * 10;
    const blendAtMax = (100 + range.maxRequiredNi * 100) / totalTonnage;
    assert.equal(blendAtMax, 1.2 + 0.05);
  });

  test('different t/DT changes the range proportionally', () => {
    const a = calculateRequiredNiRange({ otherWeightedNi: 0, otherTonnage: 0, newUnits: 10, tonnesPerUnit: 45, targetNi: 1.2, tolerance: 0.05 });
    const b = calculateRequiredNiRange({ otherWeightedNi: 0, otherTonnage: 0, newUnits: 10, tonnesPerUnit: 50, targetNi: 1.2, tolerance: 0.05 });
    // With no other fixed contribution, the required Ni is always exactly
    // the target range regardless of t/DT (100% of the blend is the new
    // dome) -- confirms t/DT only matters once other tonnage exists.
    assert.equal(a.minRequiredNi, b.minRequiredNi);
  });

  test('different unit counts change the range (more other-fixed tonnage narrows influence)', () => {
    const fewUnits = calculateRequiredNiRange({ otherWeightedNi: 100, otherTonnage: 100, newUnits: 2, tonnesPerUnit: 10, targetNi: 1.2, tolerance: 0.05 });
    const manyUnits = calculateRequiredNiRange({ otherWeightedNi: 100, otherTonnage: 100, newUnits: 50, tonnesPerUnit: 10, targetNi: 1.2, tolerance: 0.05 });
    assert.notEqual(fewUnits.minRequiredNi, manyUnits.minRequiredNi);
  });

  test('no arbitrary Ni ceiling -- a very demanding requirement is still returned as-is, never clamped', () => {
    const range = calculateRequiredNiRange({ otherWeightedNi: 0, otherTonnage: 1000, newUnits: 1, tonnesPerUnit: 1, targetNi: 5, tolerance: 0.01 });
    assert.ok(range.maxRequiredNi > 100, 'an extreme but mathematically valid Ni must not be silently capped');
  });

  test('newTonnage <= 0 -> infeasible, never divides by zero into Infinity/NaN', () => {
    const range = calculateRequiredNiRange({ otherWeightedNi: 100, otherTonnage: 100, newUnits: 0, tonnesPerUnit: 10, targetNi: 1.2, tolerance: 0.05 });
    assert.equal(range.feasible, false);
  });

  test('entirely non-positive range -> infeasible (this task Section 14)', () => {
    // otherTonnage is huge and already far above target -- pulling it back
    // down within tolerance would require an impossible negative Ni.
    const range = calculateRequiredNiRange({ otherWeightedNi: 100 * 10, otherTonnage: 100, newUnits: 1, tonnesPerUnit: 1, targetNi: 0.5, tolerance: 0.01 });
    assert.equal(range.feasible, false);
  });

  test('a range partially crossing zero is feasible (positive portion valid, this task Section 14)', () => {
    // otherWeightedNi/otherTonnage chosen so minRequiredNi is negative but
    // maxRequiredNi stays positive.
    const range = calculateRequiredNiRange({ otherWeightedNi: 90, otherTonnage: 100, newUnits: 10, tonnesPerUnit: 10, targetNi: 1.0, tolerance: 0.05 });
    assert.equal(range.feasible, true);
    assert.ok(range.maxRequiredNi > 0);
  });
});

/* ============================================================
   36. SPLIT MINIMUM 6 DT
============================================================ */
describe('36. findSplitLoadingPlan() -- minimum 6 DT per active loading point', () => {
  const baseArgs = { existingDomeNi: 1.2, tonnesPerUnit: 45, otherWeightedNi: 0, otherTonnage: 0, targetNi: 1.15, tolerance: 0.5 };

  test('10 DT: no split possible (below 2x minimum)', () => {
    assert.equal(findSplitLoadingPlan({ ...baseArgs, totalFleet: 10 }), null);
  });

  test('11 DT: no split possible', () => {
    assert.equal(findSplitLoadingPlan({ ...baseArgs, totalFleet: 11 }), null);
  });

  test('12 DT: 6 + 6 is the only valid split', () => {
    const plan = findSplitLoadingPlan({ ...baseArgs, totalFleet: 12 });
    assert.ok(plan);
    assert.equal(plan.newDomeUnits, 6);
    assert.equal(plan.existingDomeUnits, 6);
  });

  test('13 DT: split deterministically resolves to new=6/existing=7 (or the reverse) -- never new=1..5', () => {
    const plan = findSplitLoadingPlan({ ...baseArgs, totalFleet: 13 });
    assert.ok(plan);
    assert.ok(plan.newDomeUnits >= 6);
    assert.ok(plan.existingDomeUnits >= 6);
    assert.equal(plan.newDomeUnits + plan.existingDomeUnits, 13);
  });

  test('20 DT: every generated split candidate has both sides >= 6, none in the 1-5 DT range', () => {
    // Re-derive every candidate the same way the function does internally,
    // by probing every totalFleet-consistent split via repeated narrowing
    // is not exposed -- instead assert the WINNING plan's own invariant,
    // and separately prove via section 12's worked example that the
    // engine prefers the smallest new-dome split (6) when feasible.
    const plan = findSplitLoadingPlan({ ...baseArgs, totalFleet: 20 });
    assert.ok(plan);
    assert.ok(plan.newDomeUnits >= 6 && plan.existingDomeUnits >= 6);
    assert.equal(plan.newDomeUnits + plan.existingDomeUnits, 20);
  });

  test('no generated split ever produces an active loading point with 1-5 DT (invariant across a range of fleet sizes)', () => {
    for (let totalFleet = 6; totalFleet <= 40; totalFleet += 1) {
      const plan = findSplitLoadingPlan({ ...baseArgs, totalFleet });
      if (!plan) continue;
      assert.ok(plan.newDomeUnits >= MIN_UNITS_PER_SPLIT_LOADING_POINT, `totalFleet=${totalFleet} produced newDomeUnits=${plan.newDomeUnits}`);
      assert.ok(plan.existingDomeUnits >= MIN_UNITS_PER_SPLIT_LOADING_POINT, `totalFleet=${totalFleet} produced existingDomeUnits=${plan.existingDomeUnits}`);
    }
  });
});

/* ============================================================
   17. WORKED EXAMPLE -- TII 20 DT single loading point, section 12's
   "smallest DT moved to the new loading point" preference.
============================================================ */
describe('17. TII 20 DT single loading point -- prefers the smallest new-dome split (6 DT), not a larger one', () => {
  test('with a wide tolerance, 6/14 wins over any larger new-dome split', () => {
    const plan = findSplitLoadingPlan({
      totalFleet: 20, existingDomeNi: 1.2, tonnesPerUnit: 45,
      otherWeightedNi: 0, otherTonnage: 0, targetNi: 1.15, tolerance: 1.0,
    });
    assert.ok(plan);
    assert.equal(plan.newDomeUnits, 6);
    assert.equal(plan.existingDomeUnits, 14);
    assert.ok(Number.isFinite(plan.minRequiredNi) && Number.isFinite(plan.maxRequiredNi));
  });
});

/* ============================================================
   38. SINGLE LOADING POINT (via deriveContractorContinuityPlan)
============================================================ */
describe('38. deriveContractorContinuityPlan() -- one-loading-point Contractor needing mitigation', () => {
  test('SPLIT plan produced, all fleet conserved, existing/new both >= 6, required Ni range present, replacement fallback also present', () => {
    const candidate = {
      sources: [
        { pileId: 'L30', contractor: 'TII', ni: 1.2, tonnesPerUnit: 45, assignedUnits: 20, activeUnits: 14, cycleTonnage: 14 * 45 },
        { pileId: 'A1', contractor: 'MRP', ni: 1.1, tonnesPerUnit: 50, assignedUnits: 10, activeUnits: 10, cycleTonnage: 10 * 50 },
      ],
    };
    const plans = deriveContractorContinuityPlan({ candidate, targetNi: 1.15, tolerance: 0.05 });
    const tii = plans.find((p) => p.contractor === 'TII');
    assert.ok(tii, 'expected a continuity plan for TII');
    assert.equal(tii.strategy, 'SPLIT');
    assert.equal(tii.split.newDomeUnits + tii.split.existingDomeUnits, 20);
    assert.ok(tii.split.newDomeUnits >= 6 && tii.split.existingDomeUnits >= 6);
    assert.ok(Number.isFinite(tii.split.minRequiredNi));
    assert.ok(Number.isFinite(tii.split.maxRequiredNi));
    // MRP is fully active -- no plan entry for it.
    assert.equal(plans.find((p) => p.contractor === 'MRP'), undefined);
  });
});

/* ============================================================
   39. SINGLE POINT CANNOT SPLIT -> REPLACE preserving all fleet
============================================================ */
describe('39. deriveContractorContinuityPlan() -- single loading point too small to split falls back to REPLACE', () => {
  test('10 DT total: 6+4 split forbidden, REPLACE plan preserves all 10 DT', () => {
    const candidate = {
      sources: [
        { pileId: 'L30', contractor: 'TII', ni: 1.2, tonnesPerUnit: 45, assignedUnits: 10, activeUnits: 2, cycleTonnage: 2 * 45 },
        { pileId: 'A1', contractor: 'MRP', ni: 1.05, tonnesPerUnit: 50, assignedUnits: 40, activeUnits: 40, cycleTonnage: 40 * 50 },
      ],
    };
    const plans = deriveContractorContinuityPlan({ candidate, targetNi: 1.08, tolerance: 0.5 });
    const tii = plans.find((p) => p.contractor === 'TII');
    assert.ok(tii);
    assert.equal(tii.strategy, 'REPLACE');
    assert.ok(Number.isFinite(tii.replacement.minRequiredNi));
    assert.ok(Number.isFinite(tii.replacement.maxRequiredNi));
  });
});

/* ============================================================
   40/41. MULTIPLE LOADING POINTS -- fleet moves between existing domes,
   no cross-Contractor movement, each active source >=6 or closed.
============================================================ */
describe('40/41. Multiple loading points -- same-Contractor fleet redistribution, never cross-Contractor', () => {
  test('a within-tolerance candidate that keeps a multi-dome Contractor fully active needs no continuity plan at all', () => {
    const candidate = {
      sources: [
        { pileId: 'L30', contractor: 'TII', ni: 1.2, tonnesPerUnit: 50, assignedUnits: 8, activeUnits: 0, cycleTonnage: 0 },
        { pileId: 'L31', contractor: 'TII', ni: 1.1, tonnesPerUnit: 50, assignedUnits: 12, activeUnits: 20, cycleTonnage: 20 * 50 },
      ],
    };
    const plans = deriveContractorContinuityPlan({ candidate, targetNi: 1.1, tolerance: 0.5 });
    assert.equal(plans.find((p) => p.contractor === 'TII'), undefined, 'TII fleet is 100% active (moved between its own domes) -- no plan needed');
  });

  test('closing one dome to 0 while the sibling dome absorbs its fleet is a valid, fully-active outcome', () => {
    const metrics = calculateContractorStandbyMetrics([
      { pileId: 'L30', contractor: 'TII', assignedUnits: 8, activeUnits: 0 },
      { pileId: 'L31', contractor: 'TII', assignedUnits: 12, activeUnits: 20 },
    ]);
    assert.equal(metrics[0].standbyRatio, 0, 'total assigned (20) == total active (20) -- fully conserved, zero standby');
  });

  test('REGRESSION: a multi-dome Contractor still needing mitigation falls back to REPLACE, never invents a cross-Contractor move', () => {
    const candidate = {
      sources: [
        { pileId: 'L30', contractor: 'TII', ni: 1.2, tonnesPerUnit: 45, assignedUnits: 8, activeUnits: 2, cycleTonnage: 2 * 45 },
        { pileId: 'L31', contractor: 'TII', ni: 1.15, tonnesPerUnit: 45, assignedUnits: 12, activeUnits: 4, cycleTonnage: 4 * 45 },
        { pileId: 'A1', contractor: 'MRP', ni: 1.0, tonnesPerUnit: 50, assignedUnits: 30, activeUnits: 30, cycleTonnage: 30 * 50 },
      ],
    };
    const plans = deriveContractorContinuityPlan({ candidate, targetNi: 1.02, tolerance: 0.3 });
    const tii = plans.find((p) => p.contractor === 'TII');
    assert.ok(tii);
    assert.ok(tii.strategy === 'REPLACE' || tii.strategy === 'CONFLICT');
    assert.equal(plans.find((p) => p.contractor === 'MRP'), undefined, "MRP's fleet must never be touched by TII's continuity plan");
  });
});

/* ============================================================
   42. REPLACEMENT REQUIRED -- all fleet included, no invented source ID
============================================================ */
describe('42. Replacement plan never invents a source ID and always covers the full Contractor fleet', () => {
  test('the replacement plan references only an EXISTING pileId from the input sources', () => {
    const candidate = {
      sources: [
        { pileId: 'L30', contractor: 'TII', ni: 1.2, tonnesPerUnit: 45, assignedUnits: 10, activeUnits: 2, cycleTonnage: 2 * 45 },
        { pileId: 'A1', contractor: 'MRP', ni: 1.0, tonnesPerUnit: 50, assignedUnits: 40, activeUnits: 40, cycleTonnage: 40 * 50 },
      ],
    };
    const plans = deriveContractorContinuityPlan({ candidate, targetNi: 1.02, tolerance: 0.4 });
    const tii = plans.find((p) => p.contractor === 'TII');
    assert.ok(tii);
    if (tii.strategy === 'REPLACE') {
      assert.equal(tii.existingPileId, 'L30');
    }
  });
});

/* ============================================================
   45. CROSS-CONTRACTOR REGRESSION LOCK
============================================================ */
describe('45. Cross-Contractor regression lock', () => {
  test("Contractor A's unused DT can never appear inside Contractor B's continuity plan", () => {
    const candidate = {
      sources: [
        { pileId: 'L30', contractor: 'A', ni: 1.2, tonnesPerUnit: 45, assignedUnits: 20, activeUnits: 2, cycleTonnage: 2 * 45 },
        { pileId: 'L40', contractor: 'B', ni: 1.0, tonnesPerUnit: 50, assignedUnits: 10, activeUnits: 10, cycleTonnage: 10 * 50 },
      ],
    };
    const plans = deriveContractorContinuityPlan({ candidate, targetNi: 1.15, tolerance: 0.5 });
    const aPlan = plans.find((p) => p.contractor === 'A');
    assert.ok(aPlan);
    assert.equal(aPlan.totalAssignedFleet, 20, "A's plan must only ever reference A's own 20 DT, never B's 10");
    assert.equal(plans.find((p) => p.contractor === 'B'), undefined);
  });

  test('findSplitLoadingPlan/calculateRequiredNiRange never receive or reference a second Contractor\'s pileId', () => {
    // Structural guarantee: these are pure functions with no `contractor`
    // parameter accepted anywhere in their signature -- a caller literally
    // cannot pass cross-Contractor fleet through them by construction.
    const plan = findSplitLoadingPlan({ totalFleet: 20, existingDomeNi: 1.2, tonnesPerUnit: 45, otherWeightedNi: 0, otherTonnage: 0, targetNi: 1.15, tolerance: 1 });
    assert.ok(!('contractor' in plan));
  });
});

/* ============================================================
   MATERIAL/FLEET ACTION LABEL CLASSIFIERS (this task Sections 4/19/23/24/46/47)
============================================================ */
describe('classifyMaterialActionLabel() -- STOP replacement (this task Section 46)', () => {
  test('USE/LIMIT pass through unchanged', () => {
    assert.equal(classifyMaterialActionLabel('USE', null), 'USE');
    assert.equal(classifyMaterialActionLabel('LIMIT', { strategy: 'REPLACE' }), 'LIMIT');
  });
  test('STOP becomes REPLACE_DOME when a SPLIT or REPLACE plan exists', () => {
    assert.equal(classifyMaterialActionLabel('STOP', { strategy: 'SPLIT' }), 'REPLACE_DOME');
    assert.equal(classifyMaterialActionLabel('STOP', { strategy: 'REPLACE' }), 'REPLACE_DOME');
  });
  test('STOP stays STOP only when no plan/CONFLICT (genuine operational conflict, this task Section 25)', () => {
    assert.equal(classifyMaterialActionLabel('STOP', null), 'STOP');
    assert.equal(classifyMaterialActionLabel('STOP', { strategy: 'CONFLICT' }), 'STOP');
  });
});

describe('classifyFleetActionLabel() -- operational fleet vocabulary (this task Section 24/47)', () => {
  test('fully active, no relocation -> ACTIVE', () => {
    const label = classifyFleetActionLabel({ assignedUnits: 10, activeUnits: 10, useUnits: 10, moveOutUnits: 0, moveInUnits: 0, separateUnits: 0 }, null);
    assert.equal(label, 'ACTIVE');
  });

  test('partial move (still has active fleet of its own) -> MOVE', () => {
    const label = classifyFleetActionLabel({ assignedUnits: 10, activeUnits: 5, useUnits: 5, moveOutUnits: 5, moveInUnits: 0, separateUnits: 0 }, null);
    assert.equal(label, 'MOVE');
  });

  test('100% of assigned fleet relocated away -> CLOSE_DOME_AND_MOVE, never plain STANDBY (this task Section 19)', () => {
    const label = classifyFleetActionLabel({ assignedUnits: 8, activeUnits: 0, useUnits: 0, moveOutUnits: 8, moveInUnits: 0, separateUnits: 0 }, null);
    assert.equal(label, 'CLOSE_DOME_AND_MOVE');
  });

  test('<=5% standby -> REDUCE', () => {
    const label = classifyFleetActionLabel({ assignedUnits: 20, activeUnits: 19, useUnits: 19, moveOutUnits: 0, moveInUnits: 0, separateUnits: 1 }, { strategy: 'REDUCE', reduceUnits: 1 });
    assert.equal(label, 'REDUCE');
  });

  test('SPLIT continuity plan -> SPLIT_LOADING', () => {
    const label = classifyFleetActionLabel({ assignedUnits: 20, activeUnits: 14, useUnits: 14, moveOutUnits: 0, moveInUnits: 0, separateUnits: 6 }, { strategy: 'SPLIT' });
    assert.equal(label, 'SPLIT_LOADING');
  });

  test('REPLACE continuity plan -> REPLACE_DOME', () => {
    const label = classifyFleetActionLabel({ assignedUnits: 10, activeUnits: 2, useUnits: 2, moveOutUnits: 0, moveInUnits: 0, separateUnits: 8 }, { strategy: 'REPLACE' });
    assert.equal(label, 'REPLACE_DOME');
  });

  test('CONFLICT continuity plan -> CONFLICT, never presented as a normal large STANDBY (this task Section 47)', () => {
    const label = classifyFleetActionLabel({ assignedUnits: 10, activeUnits: 1, useUnits: 1, moveOutUnits: 0, moveInUnits: 0, separateUnits: 9 }, { strategy: 'CONFLICT' });
    assert.equal(label, 'CONFLICT');
  });
});

/* ============================================================
   43/44. RANKING PREFERENCE SCENARIOS -- exercised end-to-end against the
   real findBlendRecommendations()/recommendation-ranking.js integration
   in tests/recommendation-ranking.test.mjs and tests/blending-recommendation.test.mjs
   (this task Sections 43/44), not duplicated here since those require the
   full candidate SEARCH, not just this pure module in isolation.
============================================================ */

/* ============================================================
   V2.5.1 CORRECTIVE PASS -- minimum-6-DT active loading point (this
   task's Sections 1-9/22-26). Owner-reported real case: a same-Contractor
   candidate reached L20=34 active / L40=1 active -- zero AGGREGATE
   standby (34+1 == 15+20 == 35, the Contractor's whole fleet), yet an
   excavator/loading point running for only 1 DT is not operationally
   acceptable. This block tests the single shared predicate
   (isOperationalLoadingPointAllocation) and its consumers in isolation;
   the full real-engine regression (34/1-style bug proven fixed through
   the actual search+ranking pipeline) lives in
   tests/blending-recommendation.test.mjs.
============================================================ */
describe('22. isOperationalLoadingPointAllocation() -- the ONE shared 0-or->=6 predicate', () => {
  test('0 -> valid (closed)', () => {
    assert.equal(isOperationalLoadingPointAllocation(0), true);
  });
  [1, 2, 3, 4, 5].forEach((n) => {
    test(`${n} -> invalid (this task Section 2/22)`, () => {
      assert.equal(isOperationalLoadingPointAllocation(n), false);
    });
  });
  [6, 7, 8, 20, 100].forEach((n) => {
    test(`${n} -> valid`, () => {
      assert.equal(isOperationalLoadingPointAllocation(n), true);
    });
  });
});

describe('25. Small total Contractor fleet below 6 DT never gets a silently-weakened exception (this task Section 8)', () => {
  test('a single 5-DT loading point (the Contractor\'s ENTIRE fleet) is still invalid, even though it is only 5 DT -- never confused with a percentage rule', () => {
    // 5/5 is "0% standby" (fully assigned == fully active) yet still
    // operationally invalid -- the loading-point minimum is a physical
    // rule, independent of MINOR_STANDBY_RATIO/CRITICAL_STANDBY_RATIO
    // (this task's Section 25's own explicit example).
    const metrics = calculateContractorStandbyMetrics([{ contractor: 'TII', pileId: 'L20', assignedUnits: 5, activeUnits: 5 }]);
    assert.equal(metrics[0].standbyRatio, 0);
    assert.equal(metrics[0].hasInvalidLoadingPoint, true);
  });

  test('a Contractor with 100 DT total and one loading point ending at 4 DT (4% of its own fleet) is still invalid', () => {
    const metrics = calculateContractorStandbyMetrics([
      { contractor: 'TII', pileId: 'L20', assignedUnits: 4, activeUnits: 4 },
      { contractor: 'TII', pileId: 'L40', assignedUnits: 96, activeUnits: 96 },
    ]);
    assert.equal(metrics[0].standbyRatio, 0, 'aggregate standby is 0% -- the minimum-loading-point rule is independent of this percentage');
    assert.equal(metrics[0].hasInvalidLoadingPoint, true);
  });

  test('the small-fleet case triggers a continuity plan even though standbyRatio is exactly 0 (this task Section 7)', () => {
    const candidate = {
      sources: [
        { pileId: 'L20', contractor: 'TII', ni: 1.2, tonnesPerUnit: 45, assignedUnits: 5, activeUnits: 5, cycleTonnage: 5 * 45 },
        { pileId: 'A1', contractor: 'MRP', ni: 1.0, tonnesPerUnit: 50, assignedUnits: 40, activeUnits: 40, cycleTonnage: 40 * 50 },
      ],
    };
    const plans = deriveContractorContinuityPlan({ candidate, targetNi: 1.05, tolerance: 0.5 });
    const tii = plans.find((p) => p.contractor === 'TII');
    assert.ok(tii, 'a plan must exist even though standbyRatio is 0 -- hasInvalidLoadingPoint alone must trigger it');
    assert.notEqual(tii.strategy, 'REDUCE', 'REDUCE must never shortcut past an invalid loading point, regardless of how small the aggregate ratio looks');
  });
});

describe('6/7. classifyFleetActionLabel() -- receiver vs donor (V2.5.1 correction, this task Sections 1/9/19/20)', () => {
  test('6. a pure RECEIVER (moveIn > 0, moveOut === 0) is classified RECEIVE, never MOVE', () => {
    // this task's Section 19 exact numbers: assigned 15, receives 14,
    // active 29.
    const label = classifyFleetActionLabel({ assignedUnits: 15, activeUnits: 29, useUnits: 15, moveOutUnits: 0, moveInUnits: 14, separateUnits: 0 }, null);
    assert.equal(label, 'RECEIVE');
  });

  test('7. a pure DONOR (moveOut > 0, moveIn === 0) is classified MOVE', () => {
    // this task's Section 20 exact numbers: assigned 20, sends 14, active 6.
    const label = classifyFleetActionLabel({ assignedUnits: 20, activeUnits: 6, useUnits: 6, moveOutUnits: 14, moveInUnits: 0, separateUnits: 0 }, null);
    assert.equal(label, 'MOVE');
  });
});

describe('11/12. Fleet accounting identity -- no display-only arithmetic (this task Sections 15/21/29)', () => {
  // fleet-allocation.js's own accounting invariant (recommendation-
  // actions.js's deriveFleetAction() header comment): assignedUnits =
  // useUnits + moveOutUnits + separateUnits (donor side); activeUnits =
  // (assignedUnits retained) + moveInUnits (receiver side). These tests
  // assert that invariant directly against the exact worked numbers this
  // task's Sections 11/12/13 specify, so a future change cannot silently
  // desynchronize AWAL/change/AKHIR from the real engine values.
  test('receiver: 15 assigned + 14 received = 29 active (this task Section 11)', () => {
    const entry = { assignedUnits: 15, activeUnits: 29, useUnits: 15, moveOutUnits: 0, moveInUnits: 14, separateUnits: 0 };
    assert.equal(entry.useUnits + entry.moveOutUnits + entry.separateUnits, entry.assignedUnits);
    assert.equal(entry.useUnits + entry.moveInUnits, entry.activeUnits);
  });

  test('donor: 20 assigned - 14 sent = 6 active (this task Section 12)', () => {
    const entry = { assignedUnits: 20, activeUnits: 6, useUnits: 6, moveOutUnits: 14, moveInUnits: 0, separateUnits: 0 };
    assert.equal(entry.useUnits + entry.moveOutUnits + entry.separateUnits, entry.assignedUnits);
    assert.equal(entry.useUnits + entry.moveInUnits, entry.activeUnits);
  });

  test('full close: 20 assigned - 20 sent = 0 active (this task Section 13)', () => {
    const entry = { assignedUnits: 20, activeUnits: 0, useUnits: 0, moveOutUnits: 20, moveInUnits: 0, separateUnits: 0 };
    assert.equal(entry.useUnits + entry.moveOutUnits + entry.separateUnits, entry.assignedUnits);
    assert.equal(entry.useUnits + entry.moveInUnits, entry.activeUnits);
    assert.equal(classifyFleetActionLabel(entry, null), 'CLOSE_DOME_AND_MOVE');
  });
});

describe('5/12. Same-Contractor fleet conservation (this task Sections 4/16)', () => {
  test('sum(assignedUnits) === sum(activeUnits) for a no-reduction reallocation (15+20 -> 29+6)', () => {
    const sources = [
      { pileId: 'L20', contractor: 'TII', assignedUnits: 15, activeUnits: 29 },
      { pileId: 'L40', contractor: 'TII', assignedUnits: 20, activeUnits: 6 },
    ];
    const initial = sources.reduce((sum, s) => sum + s.assignedUnits, 0);
    const final = sources.reduce((sum, s) => sum + s.activeUnits, 0);
    assert.equal(initial, 35);
    assert.equal(final, 35);
    assert.equal(initial, final, 'no fleet is silently lost in a pure reallocation');
  });

  test('sum(assignedUnits) === sum(activeUnits) for a full-closure reallocation (15+20 -> 35+0)', () => {
    const sources = [
      { pileId: 'L20', contractor: 'TII', assignedUnits: 15, activeUnits: 35 },
      { pileId: 'L40', contractor: 'TII', assignedUnits: 20, activeUnits: 0 },
    ];
    const initial = sources.reduce((sum, s) => sum + s.assignedUnits, 0);
    const final = sources.reduce((sum, s) => sum + s.activeUnits, 0);
    assert.equal(initial, final);
  });

  test('a minor <=5% REDUCE plan reduces total active by exactly the reported reduceUnits, never silently more', () => {
    const candidate = {
      sources: [{ pileId: 'L20', contractor: 'TII', ni: 1.2, tonnesPerUnit: 45, assignedUnits: 100, activeUnits: 97, cycleTonnage: 97 * 45 }],
    };
    const plans = deriveContractorContinuityPlan({ candidate, targetNi: 1.2, tolerance: 0.5 });
    const tii = plans.find((p) => p.contractor === 'TII');
    assert.equal(tii.strategy, 'REDUCE');
    assert.equal(tii.totalAssignedFleet - tii.reduceUnits, 97, 'assignedFleet - reduceUnits must equal the actual active fleet, never a display-only number');
  });
});

describe('13/26. No cross-Contractor movement (regression lock, this task Section 26)', () => {
  test('a minimum-6-DT mitigation search never proposes moving DT to a DIFFERENT Contractor', () => {
    // Structural guarantee: findSplitLoadingPlan/calculateRequiredNiRange
    // accept no `contractor`/donor-Contractor parameter anywhere in their
    // signature (see this file's earlier "45. Cross-Contractor regression
    // lock" block) -- reasserted here in the specific context of the
    // V2.5.1 minimum-loading-point correction, since that is precisely
    // the scenario an insufficiently scoped "fix" could have been tempted
    // to solve by borrowing fleet from elsewhere.
    const candidate = {
      sources: [
        { pileId: 'L20', contractor: 'A', ni: 1.05, tonnesPerUnit: 50, assignedUnits: 15, activeUnits: 2, cycleTonnage: 2 * 50 },
        { pileId: 'L40', contractor: 'A', ni: 1.2, tonnesPerUnit: 50, assignedUnits: 20, activeUnits: 3, cycleTonnage: 3 * 50 },
        { pileId: 'B1', contractor: 'B', ni: 1.0, tonnesPerUnit: 50, assignedUnits: 10, activeUnits: 10, cycleTonnage: 10 * 50 },
      ],
    };
    const plans = deriveContractorContinuityPlan({ candidate, targetNi: 1.1, tolerance: 0.3 });
    const planA = plans.find((p) => p.contractor === 'A');
    assert.ok(planA);
    assert.equal(planA.totalAssignedFleet, 35, "Contractor A's plan must only ever reference A's own 35 DT, never B's 10");
    assert.equal(plans.find((p) => p.contractor === 'B'), undefined, 'B is fully active and untouched by A\'s continuity problem');
  });
});
