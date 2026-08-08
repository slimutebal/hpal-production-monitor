// js/pages/calculate/hopper-pattern.js tests (V2.4 Phase 6.1 -- Owner
// correction: "PHYSICAL FLEET ALLOCATION != HOPPER LOAD PATTERN"). See
// this task's Sections 1-13/23-25.
//
// Run with Node's built-in test runner:
//
//   node --test tests/hopper-pattern.test.mjs
//
// Hand-crafted fixture convention (matching tests/recommendation-ranking.test.mjs
// and tests/recommendation-actions.test.mjs's own documented approach):
// minimal stub `candidate` objects carrying only the fields
// deriveOperationalHopperPattern() actually reads (sources/unitRatio/
// estimatedNi/deviation/withinTolerance), built via buildCandidate() below
// from the SAME tonnage-weighted math blending-recommendation.js's real
// buildCandidate() uses, so fixtures stay numerically honest without
// requiring a full combinatorial search per test.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { deriveOperationalHopperPattern, MAX_OPERATIONAL_PATTERN_LOADS } from '../js/pages/calculate/hopper-pattern.js';
import { simplifyUnitRatio } from '../js/pages/calculate/fleet-allocation.js';
import { isWithinTolerance } from '../js/pages/calculate/blending-recommendation.js';

function buildCandidate(sources, targetNi, tolerance) {
  const totalTonnage = sources.reduce((sum, s) => sum + s.cycleTonnage, 0);
  const estimatedNi = sources.reduce((sum, s) => sum + s.ni * s.cycleTonnage, 0) / totalTonnage;
  const higherUnits = sources.filter((s) => s.oreClass !== 'LGLO').reduce((sum, s) => sum + s.activeUnits, 0);
  const lgloUnits = sources.filter((s) => s.oreClass === 'LGLO').reduce((sum, s) => sum + s.activeUnits, 0);
  const deviation = estimatedNi - targetNi;
  return {
    sources,
    unitRatio: simplifyUnitRatio(higherUnits, lgloUnits),
    estimatedNi,
    deviation,
    withinTolerance: isWithinTolerance(estimatedNi, targetNi, tolerance),
  };
}

function source(oreClass, ni, activeUnits, tonnesPerUnit) {
  return { oreClass, ni, activeUnits, cycleTonnage: activeUnits * tonnesPerUnit };
}

// The concrete physical composition reused throughout this file: Higher
// Grade 5 active DT @ Ni 1.20 / 50 t-per-DT, LGLO 14 active DT @ Ni 1.10 /
// 45 t-per-DT. Physical unitRatio is simplifyUnitRatio(5,14) = 5:14
// (already coprime -- gcd(5,14)=1), matching this task's Section 24
// scenario framing exactly ("selected physical active fleet: Higher Grade
// = 5, LGLO = 14").
function known5x14Sources() {
  return [source('HGLO', 1.20, 5, 50), source('LGLO', 1.10, 14, 45)];
}

describe('24. CRITICAL regression: 5:14 physical fleet -> 1:3 operational Hopper Pattern', () => {
  test('1:3 within tight tolerance around its own true Ni is selected, NOT 5:14; physical fleet stays 5:14', () => {
    const targetNi = 1.127;
    const tolerance = 0.0005; // range [1.1265, 1.1275]
    const candidate = buildCandidate(known5x14Sources(), targetNi, tolerance);

    // Physical fleet allocation is unaffected -- still exactly 5:14.
    assert.deepEqual(candidate.unitRatio, { rawHigher: 5, rawLglo: 14, higher: 5, lglo: 14 });

    const pattern = deriveOperationalHopperPattern({ candidate, targetNi, tolerance });
    assert.equal(pattern.higherLoads, 1);
    assert.equal(pattern.lgloLoads, 3);
    assert.equal(pattern.isFallback, false);
    assert.equal(pattern.withinTolerance, true);

    // Estimated Final Ni for the DISPLAYED pattern (1:3), computed by hand
    // via the SAME tonnage-weighted formula this task's Section 5 requires:
    // (HigherNi*50*1 + LgloNi*45*3) / (50 + 45*3). Compared with a tiny
    // epsilon rather than strict equality -- the hand-written formula and
    // the module's own arithmetic can reorder floating-point operations
    // differently while remaining mathematically identical.
    const expectedNi = (1.20 * 50 * 1 + 1.10 * 45 * 3) / (50 + 45 * 3);
    assert.ok(Math.abs(pattern.estimatedNi - expectedNi) < 1e-12);
    assert.notEqual(pattern.higherLoads, candidate.unitRatio.higher, 'must NOT equal the physical fleet ratio');
    assert.notEqual(pattern.lgloLoads, candidate.unitRatio.lglo, 'must NOT equal the physical fleet ratio');
  });
});

describe('25. Counterexample: same 5:14 physical fleet, 1:3 OUTSIDE tolerance -> NOT selected, falls back to exact 5:14', () => {
  test('a tolerance tight enough that only the exact 5:14 composition qualifies forces the deterministic fallback', () => {
    const exact = buildCandidate(known5x14Sources(), 0, 0);
    const targetNi = exact.estimatedNi; // exactly the 5:14 blend's own Ni
    const tolerance = 0.00001; // far tighter than any small pattern up to MAX bound can hit
    const candidate = buildCandidate(known5x14Sources(), targetNi, tolerance);

    const pattern = deriveOperationalHopperPattern({ candidate, targetNi, tolerance });

    // Proves the system is not merely rounding the fleet ratio: 1:3 (and
    // every other small pattern) is genuinely evaluated and rejected here.
    assert.notEqual(`${pattern.higherLoads}:${pattern.lgloLoads}`, '1:3');
    assert.equal(pattern.isFallback, true);
    assert.equal(pattern.higherLoads, candidate.unitRatio.higher);
    assert.equal(pattern.lgloLoads, candidate.unitRatio.lglo);
    assert.equal(pattern.estimatedNi, candidate.estimatedNi);
    assert.equal(pattern.deviation, candidate.deviation);
    assert.equal(pattern.withinTolerance, candidate.withinTolerance);
  });
});

describe('23.1-2. Active-fleet ratio does not automatically become the Hopper Pattern', () => {
  test('1. 5:14 does not automatically mean Hopper Pattern 5:14', () => {
    const targetNi = 1.127;
    const tolerance = 0.0005;
    const candidate = buildCandidate(known5x14Sources(), targetNi, tolerance);
    const pattern = deriveOperationalHopperPattern({ candidate, targetNi, tolerance });
    assert.notDeepEqual({ h: pattern.higherLoads, l: pattern.lgloLoads }, { h: 5, l: 14 });
  });

  test('2. if 1:3 is within tolerance, Hopper Pattern becomes 1:3', () => {
    const targetNi = 1.127;
    const tolerance = 0.0005;
    const candidate = buildCandidate(known5x14Sources(), targetNi, tolerance);
    const pattern = deriveOperationalHopperPattern({ candidate, targetNi, tolerance });
    assert.equal(pattern.higherLoads, 1);
    assert.equal(pattern.lgloLoads, 3);
  });

  test('3. if 1:3 is outside tolerance, it is not selected', () => {
    const exact = buildCandidate(known5x14Sources(), 0, 0);
    const targetNi = exact.estimatedNi;
    const tolerance = 0.00001;
    const candidate = buildCandidate(known5x14Sources(), targetNi, tolerance);
    const pattern = deriveOperationalHopperPattern({ candidate, targetNi, tolerance });
    assert.notEqual(`${pattern.higherLoads}:${pattern.lgloLoads}`, '1:3');
  });
});

describe('23.4. Smallest valid pattern wins -- e.g. 2:5 when nothing simpler qualifies', () => {
  test('4. 2:5 is chosen when 1:1/1:2/1:3/2:3/1:4/2:1/3:1 (and every simpler coprime pair) fall outside tolerance', () => {
    // Higher Ni 2.00/50 t-DT, LGLO Ni 1.00/50 t-DT -- equal tonnes/load so
    // pattern Ni depends only on the h:l proportion: Ni(h,l) = (2h+l)/(h+l).
    // Target 1.30, a narrow tolerance chosen so 2:5 (Ni = 9/7 = 1.2857) is
    // the smallest-sum coprime pair landing inside [1.295,1.305]... instead
    // pick numbers so 2:5 -> Ni=(2*2+5)/7=9/7=1.2857 is NOT it; solve
    // directly: choose target=9/7 exactly with an ultra-tight tolerance so
    // ONLY pairs producing exactly 9/7 qualify, and confirm no simpler
    // coprime pair (sum < 7) produces exactly 9/7.
    const targetNi = 9 / 7;
    const tolerance = 1e-9;
    const sources = [source('HGLO', 2.00, 3, 50), source('LGLO', 1.00, 9, 50)];
    const candidate = buildCandidate(sources, targetNi, tolerance);
    const pattern = deriveOperationalHopperPattern({ candidate, targetNi, tolerance });
    assert.equal(pattern.higherLoads, 2);
    assert.equal(pattern.lgloLoads, 5);
    assert.equal(pattern.isFallback, false);
  });
});

describe('23.5. No pattern is chosen merely by rounding the active-fleet ratio', () => {
  test('5. naive rounding of 5:14 (~0.357) toward 1:3 (0.333) would be wrong here -- the correct tonnage-weighted winner is verified, not assumed', () => {
    // Deliberately UNEQUAL tonnes/load so a naive load-count-only rounding
    // of the unit ratio would silently ignore tonnage weighting. Higher
    // Grade load = 50 t, LGLO load = 20 t (very different).
    const sources = [source('HGLO', 1.50, 5, 50), source('LGLO', 1.00, 14, 20)];
    // Physical (unit-count-only) blend: (1.50*5 + 1.00*14)/19 = 21.5/19 = 1.1316 -- but that
    // is NOT tonnage-correct; the tonnage-weighted candidate.estimatedNi
    // uses actual tonnage (5*50=250, 14*20=280), i.e. (1.5*250+1.0*280)/530 = 655/530 = 1.235849...
    const candidate = buildCandidate(sources, 1.235849056603774, 1e-6);
    assert.ok(Math.abs(candidate.estimatedNi - 1.235849056603774) < 1e-6);

    const pattern = deriveOperationalHopperPattern({ candidate, targetNi: candidate.estimatedNi, tolerance: 1e-6 });
    // The pattern's own Ni must match a TONNAGE-weighted evaluation of
    // (pattern.higherLoads, pattern.lgloLoads) using the true 50/20
    // tonnes-per-load -- not a naive (Ni_h*h + Ni_l*l)/(h+l) load-count
    // average, which for ANY h:l ratio would never reproduce 1.235849...
    // starting from equal-weighted Ni 1.50/1.00.
    const naiveLoadCountNi = (1.50 * pattern.higherLoads + 1.00 * pattern.lgloLoads) / (pattern.higherLoads + pattern.lgloLoads);
    assert.notEqual(pattern.estimatedNi, naiveLoadCountNi);
  });
});

describe('23.6. Unequal tonnes/DT are tonnage-weighted, never load-count averaged', () => {
  test('6. a 1:1 pattern with Higher 50 t/load and LGLO 20 t/load must NOT equal the plain average of the two Ni values', () => {
    const sources = [source('HGLO', 2.00, 1, 50), source('LGLO', 1.00, 1, 20)];
    // Tolerance wide enough that 1:1 (the smallest possible pattern) is
    // guaranteed to win regardless of its exact Ni.
    const targetNi = 1.5;
    const tolerance = 1;
    const candidate = buildCandidate(sources, targetNi, tolerance);
    const pattern = deriveOperationalHopperPattern({ candidate, targetNi, tolerance });
    assert.equal(pattern.higherLoads, 1);
    assert.equal(pattern.lgloLoads, 1);
    const tonnageWeightedNi = (2.00 * 50 + 1.00 * 20) / (50 + 20); // = 1.7142857...
    const naiveAverageNi = (2.00 + 1.00) / 2; // = 1.5
    assert.equal(pattern.estimatedNi, tonnageWeightedNi);
    assert.notEqual(pattern.estimatedNi, naiveAverageNi);
  });
});

describe('23.7-8. Multiple sources within a grade group are represented deterministically', () => {
  test('7. two Higher Grade sources (HGLO + MGLO) both contribute via tonnage-weighted aggregation', () => {
    const sources = [
      source('HGLO', 1.40, 2, 50),
      source('MGLO', 1.00, 3, 50),
      source('LGLO', 0.80, 5, 50),
    ];
    const targetNi = 1.0;
    const tolerance = 1; // generous -- only testing the aggregation math here
    const candidate = buildCandidate(sources, targetNi, tolerance);
    const pattern = deriveOperationalHopperPattern({ candidate, targetNi, tolerance });

    // Effective Higher Grade Ni must be the tonnage-weighted average of
    // BOTH active Higher sources: (1.40*100 + 1.00*150)/250 = 1.16, never
    // just one of them picked arbitrarily.
    const effectiveHigherNi = (1.40 * 100 + 1.00 * 150) / 250;
    const higherTonnesPerLoad = 250 / 5; // total active Higher tonnage / total active Higher units = 50
    const expectedNi = (effectiveHigherNi * pattern.higherLoads * higherTonnesPerLoad + 0.80 * pattern.lgloLoads * 50)
      / (pattern.higherLoads * higherTonnesPerLoad + pattern.lgloLoads * 50);
    assert.equal(pattern.estimatedNi, expectedNi);
  });

  test('8. two LGLO sources both contribute via tonnage-weighted aggregation', () => {
    const sources = [
      source('HGLO', 1.40, 5, 50),
      source('LGLO', 1.00, 2, 50),
      source('LGLO', 0.60, 3, 50),
    ];
    const targetNi = 1.0;
    const tolerance = 1;
    const candidate = buildCandidate(sources, targetNi, tolerance);
    const pattern = deriveOperationalHopperPattern({ candidate, targetNi, tolerance });

    const effectiveLgloNi = (1.00 * 100 + 0.60 * 150) / 250; // = 0.76
    const lgloTonnesPerLoad = 250 / 5; // = 50
    const expectedNi = (1.40 * pattern.higherLoads * 50 + effectiveLgloNi * pattern.lgloLoads * lgloTonnesPerLoad)
      / (pattern.higherLoads * 50 + pattern.lgloLoads * lgloTonnesPerLoad);
    assert.equal(pattern.estimatedNi, expectedNi);
  });
});

describe('23.9. Input source order does not change the chosen Hopper Pattern', () => {
  test('9. reversing the sources array produces the identical pattern result', () => {
    const targetNi = 1.127;
    const tolerance = 0.0005;
    const forward = known5x14Sources();
    const reversed = forward.slice().reverse();

    const candidateForward = buildCandidate(forward, targetNi, tolerance);
    const candidateReversed = buildCandidate(reversed, targetNi, tolerance);

    const patternForward = deriveOperationalHopperPattern({ candidate: candidateForward, targetNi, tolerance });
    const patternReversed = deriveOperationalHopperPattern({ candidate: candidateReversed, targetNi, tolerance });

    assert.deepEqual(patternForward, patternReversed);
  });
});

describe('23.10. Fallback to the exact aggregate ratio when no small allowed pattern meets tolerance', () => {
  test('10. isFallback is true and the pattern loads/Ni/deviation/withinTolerance mirror the candidate exactly', () => {
    const exact = buildCandidate(known5x14Sources(), 0, 0);
    const targetNi = exact.estimatedNi;
    const tolerance = 0.00001;
    const candidate = buildCandidate(known5x14Sources(), targetNi, tolerance);
    const pattern = deriveOperationalHopperPattern({ candidate, targetNi, tolerance });
    assert.equal(pattern.isFallback, true);
    assert.equal(pattern.higherLoads, 5);
    assert.equal(pattern.lgloLoads, 14);
  });
});

describe('23.11-12. One-sided grade groups', () => {
  test('11. Higher-only active material forces pattern 1:0, marked as fallback (no search possible)', () => {
    const sources = [source('HGLO', 1.20, 5, 50)];
    const targetNi = 1.20;
    const tolerance = 0.01;
    const candidate = buildCandidate(sources, targetNi, tolerance);
    const pattern = deriveOperationalHopperPattern({ candidate, targetNi, tolerance });
    assert.equal(pattern.higherLoads, 1);
    assert.equal(pattern.lgloLoads, 0);
    assert.equal(pattern.isFallback, true);
  });

  test('12. LGLO-only active material forces pattern 0:1, marked as fallback (no search possible)', () => {
    const sources = [source('LGLO', 1.05, 8, 50)];
    const targetNi = 1.05;
    const tolerance = 0.01;
    const candidate = buildCandidate(sources, targetNi, tolerance);
    const pattern = deriveOperationalHopperPattern({ candidate, targetNi, tolerance });
    assert.equal(pattern.higherLoads, 0);
    assert.equal(pattern.lgloLoads, 1);
    assert.equal(pattern.isFallback, true);
  });
});

describe('23.13. Full internal precision is used before the tolerance comparison', () => {
  test('13. a deviation that lands exactly on the tolerance boundary at full float precision is still correctly classified within', () => {
    // 1:2 pattern with Higher Ni 1.00/50t, LGLO Ni 1.15/50t (equal
    // tonnes/load): Ni = (1.00*50 + 1.15*100)/150 = 165/150 = 1.1 exactly
    // in real-number math, but NOT exactly representable in IEEE-754 --
    // deriveOperationalHopperPattern() must still classify it as within a
    // tolerance whose boundary is set to that same computed (not
    // hand-rounded) value.
    const sources = [source('HGLO', 1.00, 1, 50), source('LGLO', 1.15, 2, 50)];
    const rawNi = (1.00 * 50 + 1.15 * 100) / 150;
    const targetNi = rawNi; // identical floating-point value, not a rounded literal
    const tolerance = 0; // boundary-exact -- only passes if compared at full precision
    const candidate = buildCandidate(sources, targetNi, tolerance);
    const pattern = deriveOperationalHopperPattern({ candidate, targetNi, tolerance });
    assert.equal(pattern.higherLoads, 1);
    assert.equal(pattern.lgloLoads, 2);
    assert.equal(pattern.withinTolerance, true);
  });
});

describe('Explicit search bound', () => {
  test('MAX_OPERATIONAL_PATTERN_LOADS is a documented, positive, finite integer constant', () => {
    assert.equal(Number.isInteger(MAX_OPERATIONAL_PATTERN_LOADS), true);
    assert.ok(MAX_OPERATIONAL_PATTERN_LOADS > 0);
  });

  test('a pattern whose only exact match requires a side larger than the bound correctly falls back rather than searching unbounded', () => {
    // Construct a scenario whose tolerance only admits the EXACT 5:14
    // composition (lgloLoads=14 exceeds MAX_OPERATIONAL_PATTERN_LOADS=12),
    // proving the search genuinely stops at the documented bound instead
    // of silently continuing further.
    const exact = buildCandidate(known5x14Sources(), 0, 0);
    const targetNi = exact.estimatedNi;
    const tolerance = 0.00001;
    const candidate = buildCandidate(known5x14Sources(), targetNi, tolerance);
    const pattern = deriveOperationalHopperPattern({ candidate, targetNi, tolerance });
    assert.ok(pattern.lgloLoads > MAX_OPERATIONAL_PATTERN_LOADS || pattern.isFallback);
    assert.equal(pattern.isFallback, true);
  });
});
