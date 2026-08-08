// js/pages/calculate/fleet-allocation.js tests (V2.4 Phase 3 --
// Recommendation engine). See
// docs/V2.4_CALCULATE_AND_BLENDING_RECOMMENDATION_ARCHITECTURE.md Sections
// 12-13/18-19, and this task's Sections 3-13/19/21.
//
// Run with Node's built-in test runner:
//
//   node --test tests/fleet-allocation.test.mjs
//
// Every function under test is pure (no DOM/router/i18n/localStorage).

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  gcd,
  simplifyUnitRatio,
  calculateTonnageRatio,
  simplicityKey,
  countContractorAllocations,
  enumerateAllocations,
  groupSourcesByContractor,
  planContractorRelocations,
  MAX_ALLOCATIONS_PER_CONTRACTOR,
  MAX_GLOBAL_CANDIDATES,
} from '../js/pages/calculate/fleet-allocation.js';

describe('gcd()', () => {
  test('basic cases', () => {
    assert.equal(gcd(4, 8), 4);
    assert.equal(gcd(6, 9), 3);
    assert.equal(gcd(7, 11), 1);
    assert.equal(gcd(12, 12), 12);
  });

  test('order/sign independence', () => {
    assert.equal(gcd(8, 4), 4);
    assert.equal(gcd(0, 5), 5);
    assert.equal(gcd(5, 0), 5);
  });
});

describe('simplifyUnitRatio() -- Hopper Pattern derivation (this task\'s Section 12)', () => {
  test('4:8 -> 1:2', () => {
    assert.deepEqual(simplifyUnitRatio(4, 8), { rawHigher: 4, rawLglo: 8, higher: 1, lglo: 2 });
  });

  test('6:9 -> 2:3', () => {
    assert.deepEqual(simplifyUnitRatio(6, 9), { rawHigher: 6, rawLglo: 9, higher: 2, lglo: 3 });
  });

  test('7:11 -> 7:11 (already coprime)', () => {
    assert.deepEqual(simplifyUnitRatio(7, 11), { rawHigher: 7, rawLglo: 11, higher: 7, lglo: 11 });
  });

  test('0:N -> 0:1 (deterministic zero-side rule)', () => {
    assert.deepEqual(simplifyUnitRatio(0, 5), { rawHigher: 0, rawLglo: 5, higher: 0, lglo: 1 });
  });

  test('N:0 -> 1:0 (deterministic zero-side rule)', () => {
    assert.deepEqual(simplifyUnitRatio(5, 0), { rawHigher: 5, rawLglo: 0, higher: 1, lglo: 0 });
  });

  test('0:0 -> null (invalid candidate)', () => {
    assert.equal(simplifyUnitRatio(0, 0), null);
  });

  test('4:8 simplifies to the SAME key as 1:2 (Section 21\'s "must have the same simplicity" rule)', () => {
    const unsimplified = simplifyUnitRatio(4, 8);
    const simplified = simplifyUnitRatio(1, 2);
    assert.deepEqual(simplicityKey(unsimplified), simplicityKey(simplified));
  });
});

describe('calculateTonnageRatio() -- always from actual tonnage, never inferred from Unit Ratio', () => {
  test('architecture doc Section 13 worked example: 1 DT x 50t + 2 DT x 45t -> 35.714%/64.285%, NOT 33.3%/66.7%', () => {
    const ratio = calculateTonnageRatio(50, 90);
    assert.ok(Math.abs(ratio.higher - 50 / 140) < 1e-12);
    assert.ok(Math.abs(ratio.lglo - 90 / 140) < 1e-12);
    // Confirm it is NOT the (wrong) unit-ratio-derived 33.3%/66.7%.
    assert.notEqual(Number(ratio.higher.toFixed(3)), Number((1 / 3).toFixed(3)));
  });

  test('zero total tonnage -> {0,0} rather than NaN', () => {
    assert.deepEqual(calculateTonnageRatio(0, 0), { higher: 0, lglo: 0 });
  });

  test('percentages sum to 1', () => {
    const ratio = calculateTonnageRatio(123, 456);
    assert.ok(Math.abs(ratio.higher + ratio.lglo - 1) < 1e-12);
  });
});

describe('simplicityKey() -- deterministic operational-simplicity ordering (this task\'s Section 21)', () => {
  test('1:2 sorts before 4:7 (smaller key = simpler)', () => {
    const a = simplicityKey(simplifyUnitRatio(1, 2));
    const b = simplicityKey(simplifyUnitRatio(4, 7));
    assert.ok(a[0] < b[0], 'sum(1+2=3) must be less than sum(4+7=11)');
  });

  test('2:3 sorts before 7:11', () => {
    const a = simplicityKey(simplifyUnitRatio(2, 3));
    const b = simplicityKey(simplifyUnitRatio(7, 11));
    assert.ok(a[0] < b[0]);
  });
});

describe('countContractorAllocations() -- stars-and-bars "at most fleet" count', () => {
  test('fleet=12, 2 sources -> 91 (matches manual sum_{a=0}^{12}(13-a))', () => {
    assert.equal(countContractorAllocations(12, 2), 91);
  });

  test('fleet=5, 1 source -> 6 (0..5 inclusive)', () => {
    assert.equal(countContractorAllocations(5, 1), 6);
  });

  test('fleet=0, any sourceCount -> 1 (only the all-zero tuple)', () => {
    assert.equal(countContractorAllocations(0, 3), 1);
  });
});

describe('enumerateAllocations() -- exhaustive integer tuples, Sum <= fleet', () => {
  test('matches countContractorAllocations() for several (fleet, sourceCount) pairs', () => {
    for (const [fleet, n] of [[5, 1], [12, 2], [6, 3], [3, 2]]) {
      const all = enumerateAllocations(fleet, n);
      assert.equal(all.length, countContractorAllocations(fleet, n), `fleet=${fleet} n=${n}`);
    }
  });

  test('every tuple sums to <= fleet and has no negative/non-integer values', () => {
    const all = enumerateAllocations(6, 3);
    for (const tuple of all) {
      assert.equal(tuple.length, 3);
      const sum = tuple.reduce((s, v) => s + v, 0);
      assert.ok(sum <= 6);
      tuple.forEach((v) => {
        assert.ok(Number.isInteger(v));
        assert.ok(v >= 0);
      });
    }
  });

  test('includes the all-zero tuple and the full-fleet tuple(s)', () => {
    const all = enumerateAllocations(5, 1);
    assert.ok(all.some((t) => t[0] === 0));
    assert.ok(all.some((t) => t[0] === 5));
  });

  test('single-source fleet=7 -> allocations range exactly 0..7 (used by the cross-Contractor negative test\'s TII fleet cap)', () => {
    const all = enumerateAllocations(7, 1).map((t) => t[0]).sort((a, b) => a - b);
    assert.deepEqual(all, [0, 1, 2, 3, 4, 5, 6, 7]);
  });
});

describe('safety bounds are exported and sane', () => {
  test('MAX_ALLOCATIONS_PER_CONTRACTOR and MAX_GLOBAL_CANDIDATES are positive finite integers', () => {
    assert.ok(Number.isInteger(MAX_ALLOCATIONS_PER_CONTRACTOR) && MAX_ALLOCATIONS_PER_CONTRACTOR > 0);
    assert.ok(Number.isInteger(MAX_GLOBAL_CANDIDATES) && MAX_GLOBAL_CANDIDATES > 0);
  });
});

describe('groupSourcesByContractor() -- deterministic grouping/order (this task\'s Section 7/32)', () => {
  test('groups sources by Contractor, sources within a group sorted by normalized Pile ID', () => {
    const groups = groupSourcesByContractor([
      { pileId: 'B', contractor: 'SMA' },
      { pileId: 'A', contractor: 'SMA' },
      { pileId: 'X', contractor: 'TII' },
    ]);
    assert.equal(groups.length, 2);
    const sma = groups.find((g) => g.contractorKey === 'sma');
    assert.deepEqual(sma.sources.map((s) => s.pileId), ['A', 'B']);
  });

  test('Contractor grouping is case/whitespace-insensitive', () => {
    const groups = groupSourcesByContractor([
      { pileId: 'A', contractor: '  SMA ' },
      { pileId: 'B', contractor: 'sma' },
    ]);
    assert.equal(groups.length, 1);
    assert.equal(groups[0].sources.length, 2);
  });

  test('group/source order is independent of input array order (determinism, this task\'s Section 32)', () => {
    const order1 = groupSourcesByContractor([
      { pileId: 'B', contractor: 'TII' },
      { pileId: 'A', contractor: 'SMA' },
    ]);
    const order2 = groupSourcesByContractor([
      { pileId: 'A', contractor: 'SMA' },
      { pileId: 'B', contractor: 'TII' },
    ]);
    assert.deepEqual(order1.map((g) => g.contractorKey), order2.map((g) => g.contractorKey));
    assert.deepEqual(
      order1.map((g) => g.sources.map((s) => s.pileId)),
      order2.map((g) => g.sources.map((s) => s.pileId)),
    );
  });
});

describe('planContractorRelocations() -- same-Contractor MOVE derivation (this task\'s Section 10/25)', () => {
  test('one donor, one receiver -> a single relocation, no standby', () => {
    const { relocations, perSource } = planContractorRelocations([
      { pileId: 'HigherGrade', contractor: 'SMA', assignedUnits: 5, activeUnits: 4 },
      { pileId: 'Lglo', contractor: 'SMA', assignedUnits: 7, activeUnits: 8 },
    ]);
    assert.deepEqual(relocations, [{ contractor: 'SMA', fromPileId: 'HigherGrade', toPileId: 'Lglo', units: 1 }]);
    assert.equal(perSource.get('HigherGrade').moveOutUnits, 1);
    assert.equal(perSource.get('HigherGrade').standbyUnits, 0);
    assert.equal(perSource.get('Lglo').moveInUnits, 1);
  });

  test('no relocation needed when every source is already at its assigned level', () => {
    const { relocations, perSource } = planContractorRelocations([
      { pileId: 'A', contractor: 'SMA', assignedUnits: 5, activeUnits: 5 },
      { pileId: 'B', contractor: 'SMA', assignedUnits: 7, activeUnits: 7 },
    ]);
    assert.deepEqual(relocations, []);
    assert.equal(perSource.get('A').moveInUnits, 0);
    assert.equal(perSource.get('A').moveOutUnits, 0);
    assert.equal(perSource.get('A').standbyUnits, 0);
  });

  test('leftover donor capacity beyond receiver need becomes standby, not a relocation', () => {
    const { relocations, perSource } = planContractorRelocations([
      { pileId: 'Donor', contractor: 'SMA', assignedUnits: 5, activeUnits: 2 }, // capacity 3
      { pileId: 'Receiver', contractor: 'SMA', assignedUnits: 3, activeUnits: 4 }, // need 1
    ]);
    assert.deepEqual(relocations, [{ contractor: 'SMA', fromPileId: 'Donor', toPileId: 'Receiver', units: 1 }]);
    assert.equal(perSource.get('Donor').moveOutUnits, 1);
    assert.equal(perSource.get('Donor').standbyUnits, 2);
  });

  test('multiple donors/receivers pair deterministically by (already-sorted) Pile ID order', () => {
    const { relocations } = planContractorRelocations([
      { pileId: 'A', contractor: 'SMA', assignedUnits: 5, activeUnits: 2 }, // donor, capacity 3
      { pileId: 'B', contractor: 'SMA', assignedUnits: 2, activeUnits: 6 }, // receiver, need 4
      { pileId: 'C', contractor: 'SMA', assignedUnits: 4, activeUnits: 3 }, // donor, capacity 1
    ]);
    // A's capacity (3) is consumed first by B's need (4); remaining 1 need
    // is then satisfied by C.
    assert.deepEqual(relocations, [
      { contractor: 'SMA', fromPileId: 'A', toPileId: 'B', units: 3 },
      { contractor: 'SMA', fromPileId: 'C', toPileId: 'B', units: 1 },
    ]);
  });

  test('single-source group can never produce a relocation (no receiver possible)', () => {
    const { relocations, perSource } = planContractorRelocations([
      { pileId: 'Solo', contractor: 'SMA', assignedUnits: 5, activeUnits: 3 },
    ]);
    assert.deepEqual(relocations, []);
    assert.equal(perSource.get('Solo').standbyUnits, 2);
  });

  test('empty group returns no relocations, no throw', () => {
    assert.deepEqual(planContractorRelocations([]), { relocations: [], perSource: new Map() });
  });
});
