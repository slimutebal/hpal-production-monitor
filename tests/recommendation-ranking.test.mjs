// js/pages/calculate/recommendation-ranking.js tests (V2.4 Phase 3 --
// Recommendation engine). See
// docs/V2.4_CALCULATE_AND_BLENDING_RECOMMENDATION_ARCHITECTURE.md Sections
// 18.2/24, and this task's Sections 20-23/29-30.
//
// Run with Node's built-in test runner:
//
//   node --test tests/recommendation-ranking.test.mjs
//
// These tests exercise the ranking RULES in isolation against handcrafted
// candidate objects (the same shape blending-recommendation.js's
// buildCandidate() produces) rather than through a full combinatorial
// search -- this precisely isolates one ranking dimension per test, which
// a full end-to-end search makes difficult to control (changing one field
// like totalActiveUnits tends to drag several others along with it). The
// full-search integration tests (known 5 HG / 8 LGLO example,
// same/cross-Contractor cases, etc.) live in
// tests/blending-recommendation.test.mjs.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { simplifyUnitRatio } from '../js/pages/calculate/fleet-allocation.js';
import {
  compareWithinTolerance,
  compareBestAttainable,
  pickBestCandidate,
  RANKING_MODE_WITHIN_TOLERANCE,
  RANKING_MODE_BEST_ATTAINABLE,
} from '../js/pages/calculate/recommendation-ranking.js';

// Minimal candidate stub carrying only the fields the comparators read.
function candidate(overrides) {
  return {
    totalActiveUnits: 10,
    unitRatio: simplifyUnitRatio(1, 2),
    totalMovedUnits: 0,
    absoluteDeviation: 0,
    activeSourceCount: 2,
    allocationSignature: 'default',
    ...overrides,
  };
}

describe('compareWithinTolerance() -- architecture doc Section 18.2 / this task\'s Section 20', () => {
  test('29. rule 2: MORE totalActiveUnits wins even with a WORSE (larger) deviation', () => {
    const a = candidate({ totalActiveUnits: 10, absoluteDeviation: 0.05, allocationSignature: 'a' });
    const b = candidate({ totalActiveUnits: 7, absoluteDeviation: 0.007, allocationSignature: 'b' });
    const winner = pickBestCandidate([a, b], RANKING_MODE_WITHIN_TOLERANCE);
    assert.equal(winner, a, 'fleet utilization outranks a smaller Ni deviation once both are within tolerance');
  });

  test('30. rule 3: equal totalActiveUnits -> the SIMPLER pattern wins even with a WORSE deviation', () => {
    // 3:6 simplifies to 1:2 (simple); 4:5 is already coprime (less simple).
    // Both allocations have the same totalActiveUnits (9).
    const simple = candidate({
      totalActiveUnits: 9,
      unitRatio: simplifyUnitRatio(3, 6),
      absoluteDeviation: 0.0333,
      allocationSignature: 'simple',
    });
    const complex = candidate({
      totalActiveUnits: 9,
      unitRatio: simplifyUnitRatio(4, 5),
      absoluteDeviation: 0.0222, // closer to target, but must still lose
      allocationSignature: 'complex',
    });
    const winner = pickBestCandidate([simple, complex], RANKING_MODE_WITHIN_TOLERANCE);
    assert.equal(winner, simple, 'a simpler Hopper Pattern must win before a tiny Ni-deviation improvement');
  });

  test('rule 4: equal totalActiveUnits and simplicity -> FEWER totalMovedUnits wins', () => {
    const noMove = candidate({ totalMovedUnits: 0, absoluteDeviation: 0.02, allocationSignature: 'a' });
    const withMove = candidate({ totalMovedUnits: 3, absoluteDeviation: 0.001, allocationSignature: 'b' });
    const winner = pickBestCandidate([noMove, withMove], RANKING_MODE_WITHIN_TOLERANCE);
    assert.equal(winner, noMove, 'minimizing unnecessary relocation outranks a smaller deviation');
  });

  test('rule 5: equal through rule 4 -> smaller absolute deviation wins', () => {
    const closer = candidate({ absoluteDeviation: 0.001, allocationSignature: 'a' });
    const farther = candidate({ absoluteDeviation: 0.008, allocationSignature: 'b' });
    const winner = pickBestCandidate([closer, farther], RANKING_MODE_WITHIN_TOLERANCE);
    assert.equal(winner, closer);
  });

  test('rule 6: equal through rule 5 -> fewer active sources wins (less switching complexity)', () => {
    const fewerSources = candidate({ activeSourceCount: 2, allocationSignature: 'a' });
    const moreSources = candidate({ activeSourceCount: 4, allocationSignature: 'b' });
    const winner = pickBestCandidate([fewerSources, moreSources], RANKING_MODE_WITHIN_TOLERANCE);
    assert.equal(winner, fewerSources);
  });

  test('rule 7: fully tied except allocationSignature -> deterministic lexicographic tie-break, order-independent', () => {
    const a = candidate({ allocationSignature: 'aaa|pile1|3' });
    const b = candidate({ allocationSignature: 'aaa|pile2|3' });
    const winner1 = pickBestCandidate([a, b], RANKING_MODE_WITHIN_TOLERANCE);
    const winner2 = pickBestCandidate([b, a], RANKING_MODE_WITHIN_TOLERANCE);
    assert.equal(winner1, a);
    assert.equal(winner2, a, 'the same candidate must win regardless of input array order');
  });

  test('compareWithinTolerance never mutates the input array (pickBestCandidate sorts a copy)', () => {
    const list = [candidate({ allocationSignature: 'b' }), candidate({ allocationSignature: 'a' })];
    const originalOrder = list.slice();
    pickBestCandidate(list, RANKING_MODE_WITHIN_TOLERANCE);
    assert.deepEqual(list, originalOrder);
  });
});

describe('compareBestAttainable() -- architecture doc Section 24 / this task\'s Section 23', () => {
  test('31. rule 1: smaller absolute deviation wins outright, even with far fewer active units', () => {
    const closer = candidate({ absoluteDeviation: 0.01, totalActiveUnits: 2, allocationSignature: 'a' });
    const farther = candidate({ absoluteDeviation: 0.05, totalActiveUnits: 20, allocationSignature: 'b' });
    const winner = pickBestCandidate([closer, farther], RANKING_MODE_BEST_ATTAINABLE);
    assert.equal(winner, closer, 'minimizing absolute deviation is the FIRST priority when nothing is within tolerance');
  });

  test('rule 2: equal deviation -> more totalActiveUnits wins', () => {
    const moreFleet = candidate({ absoluteDeviation: 0.03, totalActiveUnits: 10, allocationSignature: 'a' });
    const lessFleet = candidate({ absoluteDeviation: 0.03, totalActiveUnits: 4, allocationSignature: 'b' });
    const winner = pickBestCandidate([moreFleet, lessFleet], RANKING_MODE_BEST_ATTAINABLE);
    assert.equal(winner, moreFleet);
  });

  test('rule 3: equal deviation and totalActiveUnits -> simpler pattern wins', () => {
    const simple = candidate({ absoluteDeviation: 0.03, totalActiveUnits: 9, unitRatio: simplifyUnitRatio(1, 2), allocationSignature: 'a' });
    const complex = candidate({ absoluteDeviation: 0.03, totalActiveUnits: 9, unitRatio: simplifyUnitRatio(4, 5), allocationSignature: 'b' });
    const winner = pickBestCandidate([simple, complex], RANKING_MODE_BEST_ATTAINABLE);
    assert.equal(winner, simple);
  });

  test('rule 4: equal through rule 3 -> fewer totalMovedUnits wins', () => {
    const noMove = candidate({ totalMovedUnits: 0, allocationSignature: 'a' });
    const withMove = candidate({ totalMovedUnits: 2, allocationSignature: 'b' });
    const winner = pickBestCandidate([noMove, withMove], RANKING_MODE_BEST_ATTAINABLE);
    assert.equal(winner, noMove);
  });

  test('rule 5: equal through rule 4 -> fewer active sources wins', () => {
    const fewer = candidate({ activeSourceCount: 1, allocationSignature: 'a' });
    const more = candidate({ activeSourceCount: 3, allocationSignature: 'b' });
    const winner = pickBestCandidate([fewer, more], RANKING_MODE_BEST_ATTAINABLE);
    assert.equal(winner, fewer);
  });

  test('rule 6: fully tied except allocationSignature -> deterministic tie-break', () => {
    const a = candidate({ allocationSignature: 'aaa' });
    const b = candidate({ allocationSignature: 'bbb' });
    assert.equal(pickBestCandidate([a, b], RANKING_MODE_BEST_ATTAINABLE), a);
    assert.equal(pickBestCandidate([b, a], RANKING_MODE_BEST_ATTAINABLE), a);
  });
});

describe('No arbitrary hidden numeric weighting (architecture doc Section 18.2)', () => {
  test('compareWithinTolerance and compareBestAttainable are exported as ordered comparator chains, not opaque scoring functions', () => {
    assert.equal(typeof compareWithinTolerance, 'function');
    assert.equal(typeof compareBestAttainable, 'function');
    // A comparator takes exactly two candidates and returns a number --
    // never an object/weighted-score shape.
    const result = compareWithinTolerance(candidate({ allocationSignature: 'a' }), candidate({ allocationSignature: 'b' }));
    assert.equal(typeof result, 'number');
  });
});
