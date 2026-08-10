// V3.0 Phase 4A/4B -- chemistry-bound conservativeness proof (docs/
// V3.0_SCALABLE_RECOMMENDATION_ENGINE_ARCHITECTURE.md Sections 20/23, this
// task's "CHEMISTRY BOUND SAFETY"/"BOUND PROOF TEST").
//
// This is the MANDATORY prerequisite before the bound may be trusted for
// pruning (js/pages/calculate/blending-recommendation.js's
// conservativeFinalNiBound()/boundIntersectsTolerance()/
// groupSourceNiExtent()/groupMaxAchievableTonnage() -- exported so this test
// exercises the EXACT functions production uses, never a re-implemented
// copy). conservativeFinalNiBound() now takes the V3.0 Phase 4B tightened
// {minNi, maxNi, maxOpenTonnage} shape (see that function's own comment in
// production) rather than Phase 4A's plain {minNi, maxNi} -- this file's
// pooledOpenBound() below computes the real maxOpenTonnage from each open
// group's actual fleet/tonnesPerUnit, so every exhaustive-completion check
// in this file now proves the TIGHTER Phase 4B bound, not the original
// looser Phase 4A one. See tests/v3-phase4b-chemistry-bound.test.mjs for
// directed tests that specifically demonstrate the tightening.
//
// For every tested partial node (some Contractor groups DECIDED with one
// concrete allocation, the rest OPEN):
//   1. compute the conservative bound from the decided groups' actual
//      accumulated numerator/tonnage plus the open groups' own source Ni
//      extremes;
//   2. enumerate EVERY feasible completion of the open groups (real
//      enumerateOperationalAllocations() from fleet-allocation.js -- the
//      same generator production uses, respecting the 0-or->=6 rule);
//   3. compute each completion's ACTUAL final Ni at full precision (no
//      rounding/discretization anywhere in this file);
//   4. assert bound.minNi <= actualFinalNi <= bound.maxNi for every one.
//
// Many deterministic randomized small scenarios (seeded-random.mjs,
// never Math.random()) plus a handful of directed edge cases.
//
// Run with Node's built-in test runner:
//
//   node --test tests/v3-phase4a-chemistry-bound.test.mjs
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { enumerateOperationalAllocations } from '../js/pages/calculate/fleet-allocation.js';
import {
  groupSourceNiExtent,
  groupMaxAchievableTonnage,
  conservativeFinalNiBound,
  boundIntersectsTolerance,
} from '../js/pages/calculate/blending-recommendation.js';
import { mulberry32, randInt, pick, NAMED_SEEDS } from './reference/seeded-random.mjs';

const BOUND_EPSILON = 1e-9;

// Deterministic small-scenario generator (this file's own -- directed at
// PARTIAL-NODE shapes, distinct from tests/reference/v3-scenario-generator.mjs
// which generates full findBlendRecommendations() inputs). Each group is
// { ni: number, tonnesPerUnit: number }[]; fleet is that group's total
// physical DT.
function randomGroup(rng, sourceCountRange, fleetRange, niRange) {
  const sourceCount = randInt(rng, sourceCountRange[0], sourceCountRange[1]);
  const sources = [];
  for (let i = 0; i < sourceCount; i += 1) {
    sources.push({
      ni: Number((niRange[0] + rng() * (niRange[1] - niRange[0])).toFixed(4)),
      tonnesPerUnit: pick(rng, [30, 35, 40, 45, 50, 55, 60]),
    });
  }
  const fleet = randInt(rng, fleetRange[0], fleetRange[1]);
  return { sources, fleet };
}

// Combines multiple groups' own source Ni extremes AND their own achievable
// tonnage ceilings into one pooled open bound -- deliberately computed
// WITHOUT reusing blending-recommendation.js's internal suffix-array reduce
// (that's the production optimization detail under test), so this test
// independently re-derives the same mathematically-required quantity a
// different way: pool every open group's sources into one flat array for
// the Ni extreme (min/max combination is associative/commutative, so this
// must match combining per-group extents pairwise), and sum each group's
// own groupMaxAchievableTonnage() independently for the tonnage ceiling.
function pooledOpenBound(openGroups) {
  const allSources = openGroups.flatMap((g) => g.sources);
  const extent = groupSourceNiExtent(allSources);
  const maxOpenTonnage = openGroups.reduce((sum, g) => sum + groupMaxAchievableTonnage(g.fleet, g.sources), 0);
  return { ...extent, maxOpenTonnage };
}

function accumulateAllocation(group, allocation) {
  let numerator = 0;
  let tonnage = 0;
  group.sources.forEach((s, i) => {
    const t = allocation[i] * s.tonnesPerUnit;
    tonnage += t;
    numerator += s.ni * t;
  });
  return { numerator, tonnage };
}

// Cartesian product of each open group's own feasible allocation set (real
// enumerateOperationalAllocations() -- respects 0-or->=6 exactly like
// production generation).
function everyCompletion(openGroups) {
  const perGroupAllocations = openGroups.map((g) => enumerateOperationalAllocations(g.fleet, g.sources.length));
  const completions = [];
  function combine(index, acc) {
    if (index === openGroups.length) {
      completions.push(acc.slice());
      return;
    }
    for (const allocation of perGroupAllocations[index]) {
      acc.push(allocation);
      combine(index + 1, acc);
      acc.pop();
    }
  }
  combine(0, []);
  return completions;
}

// Verifies bound.minNi <= actualFinalNi <= bound.maxNi (within
// BOUND_EPSILON, a pure floating-point-representation guard, never a
// business tolerance) for every feasible completion of `openGroups`, given
// a fixed prefix already contributing (fixedNumerator, fixedTonnage).
// Returns how many completions were checked (so callers/after() can report
// real coverage, not just "it ran").
function assertBoundHoldsForAllCompletions(fixedNumerator, fixedTonnage, openGroups, label) {
  const openBound = pooledOpenBound(openGroups);
  const bound = conservativeFinalNiBound(fixedNumerator, fixedTonnage, openBound);
  assert.ok(bound.minNi <= bound.maxNi + BOUND_EPSILON, `${label}: degenerate inverted bound [${bound.minNi}, ${bound.maxNi}]`);

  const completions = everyCompletion(openGroups);
  let checked = 0;
  completions.forEach((completionAllocations) => {
    let numerator = fixedNumerator;
    let tonnage = fixedTonnage;
    openGroups.forEach((group, i) => {
      const { numerator: n, tonnage: t } = accumulateAllocation(group, completionAllocations[i]);
      numerator += n;
      tonnage += t;
    });
    if (!(tonnage > 0)) return; // all-zero completion -- no candidate is ever built from this (buildCandidate() excludes it); Ni is undefined.
    const actualFinalNi = numerator / tonnage;
    checked += 1;
    assert.ok(
      actualFinalNi >= bound.minNi - BOUND_EPSILON && actualFinalNi <= bound.maxNi + BOUND_EPSILON,
      `${label}: actualFinalNi=${actualFinalNi} outside bound [${bound.minNi}, ${bound.maxNi}]`,
    );
  });
  return checked;
}

// ============================================================
// 1. DIRECTED EDGE CASES
// ============================================================
describe('V3.0 Phase 4A chemistry bound -- directed edge cases', () => {
  test('no decided prefix (fixedTonnage=0): bound collapses to the open groups\' own pooled source Ni extent', () => {
    const openGroups = [
      { sources: [{ ni: 1.0, tonnesPerUnit: 50 }, { ni: 1.5, tonnesPerUnit: 50 }], fleet: 8 },
      { sources: [{ ni: 1.2, tonnesPerUnit: 40 }], fleet: 6 },
    ];
    const bound = conservativeFinalNiBound(0, 0, pooledOpenBound(openGroups));
    assert.equal(bound.minNi, 1.0);
    assert.equal(bound.maxNi, 1.5);
    assertBoundHoldsForAllCompletions(0, 0, openGroups, 'no-decided-prefix');
  });

  test('no open groups remaining (fixedTonnage>0 only): bound collapses to the exact fixed Ni, single point', () => {
    const fixedNumerator = 1.25 * 900; // e.g. 6 units * 50 t/DT * 1.25 Ni + ...
    const fixedTonnage = 900;
    const bound = conservativeFinalNiBound(fixedNumerator, fixedTonnage, { minNi: Infinity, maxNi: -Infinity, maxOpenTonnage: 0 });
    assert.equal(bound.minNi, 1.25);
    assert.equal(bound.maxNi, 1.25);
  });

  test('single open group whose extreme achievable average IS one of its own source Ni values (all-fleet-on-one-source allocation)', () => {
    // Group with two sources; fleet large enough that "all fleet on the
    // lowest-Ni source alone" is itself a feasible 0-or->=6 allocation.
    const openGroups = [{ sources: [{ ni: 0.9, tonnesPerUnit: 50 }, { ni: 1.7, tonnesPerUnit: 50 }], fleet: 12 }];
    const checked = assertBoundHoldsForAllCompletions(0, 0, openGroups, 'single-open-extreme-achievable');
    assert.ok(checked > 0, 'expected at least one nonzero completion to be checked');
  });

  test('wide fixed-vs-open Ni gap (fixed portion far from open groups\' range) still bounds every completion', () => {
    // Fixed prefix locked at Ni=1.8 (weight 1000 tonnage); open group only
    // ever reaches 0.9-1.0. True finalNi should stay skewed toward 1.8 for
    // small open tonnage and drift toward the open range only as the open
    // group's tonnage share grows -- bound must contain the whole span.
    const fixedNumerator = 1.8 * 1000;
    const fixedTonnage = 1000;
    const openGroups = [{ sources: [{ ni: 0.9, tonnesPerUnit: 50 }, { ni: 1.0, tonnesPerUnit: 50 }], fleet: 40 }];
    assertBoundHoldsForAllCompletions(fixedNumerator, fixedTonnage, openGroups, 'wide-gap');
  });

  test('three open groups combined (pooled extent spans all three) still bounds every completion', () => {
    const openGroups = [
      { sources: [{ ni: 0.85, tonnesPerUnit: 30 }], fleet: 6 },
      { sources: [{ ni: 1.3, tonnesPerUnit: 40 }, { ni: 1.1, tonnesPerUnit: 45 }], fleet: 8 },
      { sources: [{ ni: 1.75, tonnesPerUnit: 50 }], fleet: 6 },
    ];
    assertBoundHoldsForAllCompletions(500, 300, openGroups, 'three-open-groups');
  });
});

// ============================================================
// 2. boundIntersectsTolerance -- pure interval-disjoint logic
// ============================================================
describe('V3.0 Phase 4A boundIntersectsTolerance -- interval-disjoint logic', () => {
  test('bound strictly above target+tolerance: no intersection', () => {
    assert.equal(boundIntersectsTolerance({ minNi: 1.5, maxNi: 1.6 }, 1.0, 0.01), false);
  });

  test('bound strictly below target-tolerance: no intersection', () => {
    assert.equal(boundIntersectsTolerance({ minNi: 0.5, maxNi: 0.6 }, 1.0, 0.01), false);
  });

  test('bound overlapping the tolerance window: intersects', () => {
    assert.equal(boundIntersectsTolerance({ minNi: 0.95, maxNi: 1.05 }, 1.0, 0.01), true);
  });

  test('bound touching exactly at the inclusive boundary: intersects (never prunes a reachable-exactly-at-boundary value)', () => {
    assert.equal(boundIntersectsTolerance({ minNi: 1.01, maxNi: 1.2 }, 1.0, 0.01), true);
    assert.equal(boundIntersectsTolerance({ minNi: 0.5, maxNi: 0.99 }, 1.0, 0.01), true);
  });

  test('bound entirely containing the tolerance window: intersects', () => {
    assert.equal(boundIntersectsTolerance({ minNi: 0.0, maxNi: 2.0 }, 1.0, 0.01), true);
  });
});

// ============================================================
// 3. groupSourceNiExtent -- pure per-group extremes
// ============================================================
describe('V3.0 Phase 4A groupSourceNiExtent', () => {
  test('single source: min === max === that source\'s Ni', () => {
    const extent = groupSourceNiExtent([{ ni: 1.234 }]);
    assert.equal(extent.minNi, 1.234);
    assert.equal(extent.maxNi, 1.234);
  });

  test('several sources: extremes are the true min/max regardless of array order', () => {
    const extent = groupSourceNiExtent([{ ni: 1.3 }, { ni: 0.9 }, { ni: 1.7 }, { ni: 1.1 }]);
    assert.equal(extent.minNi, 0.9);
    assert.equal(extent.maxNi, 1.7);
  });
});

// ============================================================
// 4. DETERMINISTIC RANDOMIZED PROPERTY TEST -- many small partial states,
// varying decided-prefix depth, group/source counts, fleets, and Ni pools.
// ============================================================
const stats = { partialStatesChecked: 0, completionsChecked: 0 };

describe('V3.0 Phase 4A chemistry bound -- randomized property proof (many small partial states)', () => {
  Object.entries(NAMED_SEEDS).forEach(([seedName, seed]) => {
    describe(`seed ${seedName} (0x${seed.toString(16)})`, () => {
      const rng = mulberry32(seed);
      const CASES_PER_SEED = 40;

      for (let i = 0; i < CASES_PER_SEED; i += 1) {
        test(`partial state #${i}: every feasible completion lies inside the conservative bound`, () => {
          const totalGroups = randInt(rng, 2, 4);
          const allGroups = [];
          for (let g = 0; g < totalGroups; g += 1) {
            allGroups.push(randomGroup(rng, [1, 2], [0, 10], [0.8, 1.8]));
          }
          const decidedCount = randInt(rng, 0, totalGroups - 1); // at least one group stays open
          const decidedGroups = allGroups.slice(0, decidedCount);
          const openGroups = allGroups.slice(decidedCount);

          let fixedNumerator = 0;
          let fixedTonnage = 0;
          decidedGroups.forEach((group) => {
            const allocations = enumerateOperationalAllocations(group.fleet, group.sources.length);
            const chosen = pick(rng, allocations);
            const { numerator, tonnage } = accumulateAllocation(group, chosen);
            fixedNumerator += numerator;
            fixedTonnage += tonnage;
          });

          const checked = assertBoundHoldsForAllCompletions(fixedNumerator, fixedTonnage, openGroups, `${seedName}#${i}`);
          stats.partialStatesChecked += 1;
          stats.completionsChecked += checked;
        });
      }
    });
  });

  after(() => {
    // eslint-disable-next-line no-console
    console.log(`[v3-phase4a-chemistry-bound] proof coverage: ${stats.partialStatesChecked} partial states, ${stats.completionsChecked} completions, 0 violations (any violation would have thrown above)`);
  });
});
