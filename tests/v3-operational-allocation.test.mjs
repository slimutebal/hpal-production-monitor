// V3.0 Phase 2 -- generation-time operational feasibility primitives
// (this task's Section 4-9/20-23). Tests
// js/pages/calculate/fleet-allocation.js's
// MIN_UNITS_PER_ACTIVE_LOADING_POINT / isOperationalLoadingPointAllocation
// / countOperationalAllocations() / enumerateOperationalAllocations() in
// isolation, independent of the full Recommendation search.
//
// Run with Node's built-in test runner:
//
//   node --test tests/v3-operational-allocation.test.mjs
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  MIN_UNITS_PER_ACTIVE_LOADING_POINT,
  isOperationalLoadingPointAllocation,
  countOperationalAllocations,
  enumerateOperationalAllocations,
} from '../js/pages/calculate/fleet-allocation.js';

describe('MIN_UNITS_PER_ACTIVE_LOADING_POINT / isOperationalLoadingPointAllocation (this task\'s Section 0/4)', () => {
  test('the minimum is exactly 6', () => {
    assert.equal(MIN_UNITS_PER_ACTIVE_LOADING_POINT, 6);
  });

  test('0 is feasible (closed/idle)', () => {
    assert.equal(isOperationalLoadingPointAllocation(0), true);
  });

  test('1-5 is infeasible', () => {
    [1, 2, 3, 4, 5].forEach((n) => assert.equal(isOperationalLoadingPointAllocation(n), false, `${n} must be infeasible`));
  });

  test('6 and above is feasible', () => {
    [6, 7, 8, 40, 1000].forEach((n) => assert.equal(isOperationalLoadingPointAllocation(n), true, `${n} must be feasible`));
  });
});

// ============================================================
// COUNTING UNIT TEST MATRIX (this task's Section 20) -- countOperationalAllocations()
// must match brute-force enumerateOperationalAllocations().length() EXACTLY,
// no approximate combinatorics, across a matrix wide enough to catch an
// off-by-one in the closed-form derivation.
// ============================================================
describe('countOperationalAllocations() === enumerateOperationalAllocations().length exactly (this task\'s Section 20)', () => {
  test('F = 0..30, n = 1..5 -- full matrix', () => {
    for (let fleet = 0; fleet <= 30; fleet += 1) {
      for (let sourceCount = 1; sourceCount <= 5; sourceCount += 1) {
        const counted = countOperationalAllocations(fleet, sourceCount);
        const actual = enumerateOperationalAllocations(fleet, sourceCount).length;
        assert.equal(counted, actual, `fleet=${fleet} sourceCount=${sourceCount}: counted=${counted} actual=${actual}`);
      }
    }
  });

  test('larger selected (fleet, sourceCount) pairs', () => {
    const pairs = [[40, 6], [60, 2], [35, 2], [100, 3], [50, 4], [17, 3], [6, 6], [5, 6]];
    pairs.forEach(([fleet, sourceCount]) => {
      const counted = countOperationalAllocations(fleet, sourceCount);
      const actual = enumerateOperationalAllocations(fleet, sourceCount).length;
      assert.equal(counted, actual, `fleet=${fleet} sourceCount=${sourceCount}`);
    });
  });

  // this task's Section 8/11 -- independently re-derived audit numbers.
  test('audit Scenario A (2 domes / 30 DT per Contractor): 496 raw-equivalent shape reduces to 241 operational', () => {
    assert.equal(countOperationalAllocations(30, 2), 241);
  });

  test('audit "3 Contractors x 2 sources x 10 DT" per-Contractor shape (F=20,n=2): 76 operational (231 raw)', () => {
    assert.equal(countOperationalAllocations(20, 2), 76);
  });
});

// ============================================================
// ALL-ZERO ALLOCATION (this task's Section 9) -- the counter includes the
// all-zero tuple, exactly like the pre-Phase-2 countContractorAllocations()
// did; buildCandidate() (blending-recommendation.js) is what excludes
// totalActiveUnits === 0 from actual candidates, not this counter.
// ============================================================
describe('all-zero allocation is counted (this task\'s Section 9)', () => {
  test('fleet=0, any sourceCount -> exactly 1 (only the all-zero tuple)', () => {
    assert.equal(countOperationalAllocations(0, 3), 1);
    assert.deepEqual(enumerateOperationalAllocations(0, 3), [[0, 0, 0]]);
  });

  test('fleet=5, sourceCount=1 (below the minimum) -> the all-zero tuple is still the only one', () => {
    assert.equal(countOperationalAllocations(5, 1), 1);
    assert.deepEqual(enumerateOperationalAllocations(5, 1), [[0]]);
  });

  test('the all-zero tuple is always present alongside nonzero ones once fleet >= minimum', () => {
    const all = enumerateOperationalAllocations(12, 2);
    assert.ok(all.some((t) => t.every((v) => v === 0)));
  });
});

// ============================================================
// ENUMERATION INVARIANT TEST (this task's Section 21) -- no 1-5 allocation
// may ever be emitted, and every tuple respects the fleet budget.
// ============================================================
describe('enumerateOperationalAllocations() invariant: every value is 0 or >= 6, sum <= fleet (this task\'s Section 21)', () => {
  test('across a spread of (fleet, sourceCount) pairs, every emitted value is feasible and every tuple respects the fleet budget', () => {
    const pairs = [[0, 1], [5, 1], [6, 1], [11, 2], [12, 2], [17, 3], [24, 2], [30, 2]];
    pairs.forEach(([fleet, sourceCount]) => {
      const all = enumerateOperationalAllocations(fleet, sourceCount);
      all.forEach((tuple) => {
        assert.equal(tuple.length, sourceCount);
        tuple.forEach((v) => {
          assert.ok(Number.isInteger(v) && v >= 0, `value ${v} must be a non-negative integer`);
          assert.ok(v === 0 || v >= MIN_UNITS_PER_ACTIVE_LOADING_POINT, `value ${v} must be 0 or >= ${MIN_UNITS_PER_ACTIVE_LOADING_POINT}`);
        });
        const sum = tuple.reduce((s, v) => s + v, 0);
        assert.ok(sum <= fleet, `tuple ${JSON.stringify(tuple)} sums to ${sum} > fleet ${fleet}`);
      });
    });
  });

  test('no duplicate tuples are ever emitted', () => {
    const all = enumerateOperationalAllocations(24, 3);
    const seen = new Set(all.map((t) => t.join(',')));
    assert.equal(seen.size, all.length);
  });
});

// ============================================================
// EXPLICIT BOUNDARY TESTS (this task's Section 22)
// ============================================================
describe('explicit boundary cases (this task\'s Section 22)', () => {
  test('F=0, n=1 -> [[0]] only', () => {
    assert.deepEqual(enumerateOperationalAllocations(0, 1), [[0]]);
  });

  test('F=1, n=1 -> [[0]] only (1 DT is below the minimum)', () => {
    assert.deepEqual(enumerateOperationalAllocations(1, 1), [[0]]);
  });

  test('F=5, n=1 -> [[0]] only', () => {
    assert.deepEqual(enumerateOperationalAllocations(5, 1), [[0]]);
  });

  test('F=6, n=1 -> [[0], [6]]', () => {
    const all = enumerateOperationalAllocations(6, 1).map((t) => t[0]).sort((a, b) => a - b);
    assert.deepEqual(all, [0, 6]);
  });

  test('F=7, n=1 -> [[0], [6], [7]]', () => {
    const all = enumerateOperationalAllocations(7, 1).map((t) => t[0]).sort((a, b) => a - b);
    assert.deepEqual(all, [0, 6, 7]);
  });

  test('F=11, n=2 -> no both-active pair (6+6=12 > 11), only one-side-active or all-zero', () => {
    const all = enumerateOperationalAllocations(11, 2);
    all.forEach((tuple) => {
      const activeCount = tuple.filter((v) => v > 0).length;
      assert.ok(activeCount <= 1, `tuple ${JSON.stringify(tuple)} has more than one active source, impossible at F=11`);
    });
    // Every single-source value 6..11 must appear on each side.
    for (let v = 6; v <= 11; v += 1) {
      assert.ok(all.some((t) => t[0] === v && t[1] === 0), `[${v},0] missing`);
      assert.ok(all.some((t) => t[0] === 0 && t[1] === v), `[0,${v}] missing`);
    }
    assert.ok(all.some((t) => t[0] === 0 && t[1] === 0));
  });

  test('F=12, n=2 -> [6,6] becomes valid (both sides simultaneously active)', () => {
    const all = enumerateOperationalAllocations(12, 2);
    assert.ok(all.some((t) => t[0] === 6 && t[1] === 6));
    // And nothing exceeds the fleet budget.
    all.forEach((t) => assert.ok(t[0] + t[1] <= 12));
  });
});

// ============================================================
// SAME-CONTRACTOR REALLOCATION COMPATIBILITY (this task's Section 5/23) --
// a source's active allocation is bounded only by the Contractor GROUP's
// total fleet, never by that individual source's own original
// assignedUnits (fleet conservation/relocation logic is separate).
// ============================================================
describe('same-Contractor reallocation compatibility (this task\'s Section 23)', () => {
  test('source A originally assigned 15, source B originally assigned 20 (fleet=35): the generator can still place 29/6, 35/0, 6/29 -- not capped at each source\'s own original assignment', () => {
    const all = enumerateOperationalAllocations(35, 2);
    const has = (a, b) => all.some((t) => t[0] === a && t[1] === b);
    assert.ok(has(29, 6), '29/6 must be reachable even though source A was only originally assigned 15');
    assert.ok(has(35, 0), '35/0 (source A takes the entire group fleet) must be reachable');
    assert.ok(has(6, 29), '6/29 must be reachable even though source B was only originally assigned 20');
  });
});
