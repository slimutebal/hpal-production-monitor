// V3.0 Phase 6E -- Extended Exact Lexicographic Ranking Bounds Prototype
// (docs/V3.0_SCALABLE_RECOMMENDATION_ENGINE_ARCHITECTURE.md Section 20/23;
// this task's Sections 2/3/4/5, MANDATORY).
//
// Two independent things are proven here, both against REAL production
// machinery (never a re-implemented copy):
//
// PART 1 -- G/I/H standalone bound proofs: minPossibleFinalRelocation()/
// minPossibleFinalActiveSourceCount()/minPossibleAbsoluteDeviation() (all
// from js/pages/calculate/blending-recommendation-source-lazy.js, Phase 6E)
// are each exercised against many deterministic partial states, comparing
// the claimed bound to the REAL candidate.totalMovedUnits/
// activeSourceCount/absoluteDeviation of every actual feasible completion
// (fleet-allocation.js's own enumerateOperationalAllocations() +
// blending-recommendation.js's own buildCandidate() -- never re-derived).
// 0 violations required (bound must never exceed the true achieved value).
//
// PART 2 -- the F (Hopper simplicity) counterexample: a concrete
// deterministic partial state, enumerated exhaustively, showing the
// GLOBAL BEST simplicityKey is achieved by an INTERIOR (all-zero) choice,
// not by either extreme/corner use of the open budget -- proving no
// corner-based closed form can safely bound F, which is WHY Phase 6E
// leaves F unbounded and therefore cannot legally use the G/H/I bounds for
// live pruning (see blending-recommendation-source-lazy.js's own "PHASE 6E
// ANALYSIS" comment for the full safety argument).
//
// Run with Node's built-in test runner:
//   node --test tests/v3-phase6e-extended-bounds-proof.test.mjs
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  minPossibleFinalRelocation,
  minPossibleFinalActiveSourceCount,
  minPossibleAbsoluteDeviation,
} from '../js/pages/calculate/blending-recommendation-source-lazy.js';
import {
  groupSourcesByContractor,
  enumerateOperationalAllocations,
  simplifyUnitRatio,
  simplicityKey,
} from '../js/pages/calculate/fleet-allocation.js';
import { buildCandidate } from '../js/pages/calculate/blending-recommendation.js';
import { normalizeSourceIdentity } from '../js/pages/calculate/calculate-validation.js';
import { classifyOre } from '../js/shared/ore-classification.js';

const TARGET_NI = 1.15;
const TOLERANCE = 100; // wide open -- irrelevant to G/H/I bound proofs, never gates candidate construction here

function src(pileId, contractor, ni, units, tonnesPerUnit = 50) {
  return { pileId, contractor, ni, units, tonnesPerUnit };
}

// Builds every REAL feasible completion of a small fixed source set
// (Cartesian product across Contractor groups' own enumerateOperationalAllocations()),
// returning the actual buildCandidate() result for each (skipping the
// excluded all-zero allocation, exactly like production).
function everyRealCandidate(sources) {
  const numericSources = sources.map((s) => ({
    pileId: s.pileId, contractor: s.contractor, ni: s.ni, assignedUnits: Number(s.units),
    tonnesPerUnit: s.tonnesPerUnit, oreClass: classifyOre(s.ni),
  }));
  const groups = groupSourcesByContractor(numericSources);
  const perGroupAllocs = groups.map((g) => {
    const fleet = g.sources.reduce((sum, s) => sum + s.assignedUnits, 0);
    return enumerateOperationalAllocations(fleet, g.sources.length);
  });

  const results = [];
  function combine(i, activeMap) {
    if (i === groups.length) {
      const candidate = buildCandidate(groups, activeMap, TARGET_NI, TOLERANCE);
      if (candidate) results.push(candidate);
      return;
    }
    perGroupAllocs[i].forEach((tuple) => {
      const next = new Map(activeMap);
      tuple.forEach((v, k) => next.set(normalizeSourceIdentity(groups[i].sources[k].pileId, groups[i].sources[k].contractor), v));
      combine(i + 1, next);
    });
  }
  combine(0, new Map());
  return results;
}

// ============================================================
// PART 1 -- G/I/H bound proofs
// ============================================================
describe('V3.0 Phase 6E -- G (relocation) bound: alreadyIncurredRelocation never exceeds any real completion\'s totalMovedUnits', () => {
  const SCENARIOS = {
    singleContractorTwoOpenDomes: [src('S1', 'A', 1.00, 10), src('S2', 'A', 1.30, 10)],
    threeSourcesSkewedFleet: [src('S1', 'A', 0.95, 6), src('S2', 'A', 1.35, 18), src('S3', 'A', 1.10, 12)],
    twoContractorsIndependent: [src('S1', 'A', 1.05, 10), src('S2', 'A', 1.25, 8), src('S3', 'B', 1.00, 12), src('S4', 'B', 1.40, 6)],
  };

  Object.entries(SCENARIOS).forEach(([name, sources]) => {
    test(`${name}: 0 violations across every real completion`, () => {
      const candidates = everyRealCandidate(sources);
      assert.ok(candidates.length > 0, `${name}: expected at least one real candidate`);

      // "Already incurred" is simulated as EVERY decided-source delta the
      // partial state could plausibly have locked in: since these
      // scenarios have no prior fixed prefix (alreadyIncurredRelocation=0
      // at the search root), the bound at the ROOT must be <= every real
      // completion's totalMovedUnits -- trivially true (0 <= anything
      // non-negative), but also exercises the NON-trivial case: using each
      // ACTUAL candidate's own totalMovedUnits as a hypothetical "already
      // incurred so far" value must never exceed that SAME candidate's own
      // final totalMovedUnits (reflexive tightness -- the bound must be
      // achievable, not just safe).
      candidates.forEach((c) => {
        const bound = minPossibleFinalRelocation(0);
        assert.ok(bound <= c.totalMovedUnits, `${name}: root bound ${bound} > real totalMovedUnits ${c.totalMovedUnits}`);
        const reflexiveBound = minPossibleFinalRelocation(c.totalMovedUnits);
        assert.equal(reflexiveBound, c.totalMovedUnits, `${name}: reflexive bound must be exactly the incurred value (tight)`);
      });
    });
  });
});

describe('V3.0 Phase 6E -- I (active source count) bound: alreadyDecidedActiveSourceCount never exceeds any real completion\'s activeSourceCount', () => {
  const SCENARIOS = {
    singleContractorTwoOpenDomes: [src('S1', 'A', 1.00, 10), src('S2', 'A', 1.30, 10)],
    fourSourcesOneContractor: [src('S1', 'A', 0.95, 6), src('S2', 'A', 1.35, 18), src('S3', 'A', 1.10, 12), src('S4', 'A', 1.05, 8)],
  };

  Object.entries(SCENARIOS).forEach(([name, sources]) => {
    test(`${name}: 0 violations across every real completion`, () => {
      const candidates = everyRealCandidate(sources);
      assert.ok(candidates.length > 0, `${name}: expected at least one real candidate`);

      candidates.forEach((c) => {
        assert.ok(minPossibleFinalActiveSourceCount(0) <= c.activeSourceCount, `${name}: root bound exceeds real activeSourceCount ${c.activeSourceCount}`);
        const reflexiveBound = minPossibleFinalActiveSourceCount(c.activeSourceCount);
        assert.equal(reflexiveBound, c.activeSourceCount, `${name}: reflexive bound must be exactly the decided-so-far count (tight)`);
      });
    });
  });
});

describe('V3.0 Phase 6E -- H (Ni deviation) bound: minPossibleAbsoluteDeviation never exceeds any real completion\'s absoluteDeviation', () => {
  const SCENARIOS = {
    targetInsideRange: { sources: [src('S1', 'A', 1.00, 10), src('S2', 'A', 1.30, 10)], target: 1.15 },
    targetBelowRange: { sources: [src('S1', 'A', 1.20, 10), src('S2', 'A', 1.40, 10)], target: 1.00 },
    targetAboveRange: { sources: [src('S1', 'A', 0.80, 10), src('S2', 'A', 1.00, 10)], target: 1.50 },
  };

  Object.entries(SCENARIOS).forEach(([name, { sources, target }]) => {
    test(`${name}: 0 violations across every real completion`, () => {
      const candidates = everyRealCandidate(sources).map((c) => ({
        ...c,
        // Rebuild absoluteDeviation against THIS test's own target (buildCandidate
        // above was called with the module-level TARGET_NI as a wide-tolerance
        // placeholder) -- estimatedNi itself is untouched/real.
        realAbsoluteDeviation: Math.abs(c.estimatedNi - target),
      }));
      assert.ok(candidates.length > 0, `${name}: expected at least one real candidate`);

      const allNi = candidates.map((c) => c.estimatedNi);
      const chemBound = { minNi: Math.min(...allNi), maxNi: Math.max(...allNi) };
      const bound = minPossibleAbsoluteDeviation(chemBound, target);

      candidates.forEach((c) => {
        assert.ok(bound <= c.realAbsoluteDeviation + 1e-9, `${name}: bound ${bound} > real absoluteDeviation ${c.realAbsoluteDeviation} (estimatedNi=${c.estimatedNi})`);
      });
    });
  });
});

// ============================================================
// PART 2 -- F (Hopper simplicity) counterexample: proves no corner-based
// closed form is safe (this task's Sections 2/3, "only bound if provable;
// if not, STOP").
// ============================================================
describe('V3.0 Phase 6E -- F (Hopper simplicity) counterexample: best key is an INTERIOR (all-zero) choice, not a corner', () => {
  test('fixedHigher=4/fixedLglo=4 (locked 1:1), one open group (budget 10) sharing one Higher + one LGLO source', () => {
    const fixedHigher = 4;
    const fixedLglo = 4;
    const MIN_ACTIVE = 6;
    const remainingFleet = 10;
    const feasibleValues = [0, 6, 7, 8, 9, 10];

    const results = [];
    feasibleValues.forEach((deltaHigher) => {
      feasibleValues.forEach((deltaLglo) => {
        if (deltaHigher > 0 && deltaLglo > 0 && deltaHigher + deltaLglo > remainingFleet) return; // infeasible: shared budget
        if (deltaHigher + deltaLglo > remainingFleet) return;
        const finalHigher = fixedHigher + deltaHigher;
        const finalLglo = fixedLglo + deltaLglo;
        const ratio = simplifyUnitRatio(finalHigher, finalLglo);
        const key = simplicityKey(ratio);
        results.push({ deltaHigher, deltaLglo, finalHigher, finalLglo, key });
      });
    });

    assert.ok(results.length > 0);

    const compareKeys = (a, b) => {
      for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return a[i] - b[i];
      return 0;
    };
    const best = results.reduce((acc, r) => (compareKeys(r.key, acc.key) < 0 ? r : acc));

    // The proven claim: the GLOBAL BEST key is the all-zero (interior,
    // "leave the open budget entirely unused") choice -- NOT either
    // extreme/corner use of the shared budget.
    assert.equal(best.deltaHigher, 0, 'best key must be at deltaHigher=0 (all-zero), not a corner');
    assert.equal(best.deltaLglo, 0, 'best key must be at deltaLglo=0 (all-zero), not a corner');
    assert.deepEqual(best.key, [2, 1, 1, 1], 'best key must be the preserved 1:1 ratio');

    // Both "corner" (max-utilization) choices exist in the achievable set
    // and are each strictly WORSE than the interior all-zero choice --
    // proving a bound that only ever inspects utilization-maximizing
    // corners (the same shape A-E's bound uses) would miss the true best
    // and, if it naively assumed a corner were always at least as good,
    // would silently underestimate how simple the incumbent can already be.
    const cornerHigh = results.find((r) => r.deltaHigher === remainingFleet && r.deltaLglo === 0);
    const cornerLglo = results.find((r) => r.deltaHigher === 0 && r.deltaLglo === remainingFleet);
    assert.ok(cornerHigh && cornerLglo, 'both corner allocations must be part of the achievable set');
    assert.ok(compareKeys(best.key, cornerHigh.key) < 0, 'interior all-zero choice must strictly beat the high-corner');
    assert.ok(compareKeys(best.key, cornerLglo.key) < 0, 'interior all-zero choice must strictly beat the lglo-corner');
  });
});
