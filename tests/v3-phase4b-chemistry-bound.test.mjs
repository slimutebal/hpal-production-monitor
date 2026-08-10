// V3.0 Phase 4B -- tighter chemistry-bound conservativeness AND tightening
// proof (docs/V3.0_SCALABLE_RECOMMENDATION_ENGINE_ARCHITECTURE.md Sections
// 20/23, this task's "TIGHTER CHEMISTRY BOUNDS"/"BOUND PROOF").
//
// tests/v3-phase4a-chemistry-bound.test.mjs already re-proves conservativeness
// of the CURRENT (Phase 4B) conservativeFinalNiBound() exhaustively (its
// pooledOpenBound() helper now derives real maxOpenTonnage from each open
// group's own fleet/tonnesPerUnit). This file adds two things that file does
// NOT cover:
//
//   1. DIRECTED comparisons proving the Phase 4B bound is STRICTLY TIGHTER
//      (never wider) than the Phase 4A bound it replaces, for scenarios
//      shaped so the tightening actually matters (large fixed prefix, small
//      remaining open tonnage).
//   2. A dedicated exhaustive-completion proof pass biased toward exactly
//      those "large fixed prefix, small open tonnage" partial states, since
//      tests/v3-phase4a-chemistry-bound.test.mjs's own randomized generator
//      draws fleets uniformly and rarely produces that shape by chance.
//
// Run with Node's built-in test runner:
//
//   node --test tests/v3-phase4b-chemistry-bound.test.mjs
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { enumerateOperationalAllocations, MIN_UNITS_PER_ACTIVE_LOADING_POINT } from '../js/pages/calculate/fleet-allocation.js';
import {
  groupSourceNiExtent,
  groupMaxAchievableTonnage,
  conservativeFinalNiBound,
} from '../js/pages/calculate/blending-recommendation.js';
import { mulberry32, randInt, pick, NAMED_SEEDS } from './reference/seeded-random.mjs';

const BOUND_EPSILON = 1e-9;

// The Phase 4A bound this task replaces, restated verbatim here ONLY for
// side-by-side comparison in this file's own directed tests (production no
// longer contains this looser formula -- see conservativeFinalNiBound()'s
// own comment in blending-recommendation.js for the full derivation of why
// Phase 4B's maxOpenTonnage-capped version is a superset-safe tightening of
// exactly this).
function phase4aBound(fixedNumerator, fixedTonnage, openExtent) {
  let minNi = openExtent.minNi;
  let maxNi = openExtent.maxNi;
  if (fixedTonnage > 0) {
    const fixedNi = fixedNumerator / fixedTonnage;
    minNi = Math.min(minNi, fixedNi);
    maxNi = Math.max(maxNi, fixedNi);
  }
  return { minNi, maxNi };
}

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

function assertBoundHoldsForAllCompletions(fixedNumerator, fixedTonnage, openGroups, label) {
  const bound = conservativeFinalNiBound(fixedNumerator, fixedTonnage, pooledOpenBound(openGroups));
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
    if (!(tonnage > 0)) return;
    const actualFinalNi = numerator / tonnage;
    checked += 1;
    assert.ok(
      actualFinalNi >= bound.minNi - BOUND_EPSILON && actualFinalNi <= bound.maxNi + BOUND_EPSILON,
      `${label}: actualFinalNi=${actualFinalNi} outside bound [${bound.minNi}, ${bound.maxNi}]`,
    );
  });
  return { bound, checked };
}

// ============================================================
// 1. DIRECTED TIGHTENING COMPARISON -- Phase 4B bound vs Phase 4A bound,
// same input, proving Phase 4B is a SUBSET (never a superset) of Phase 4A's
// interval.
// ============================================================
describe('V3.0 Phase 4B chemistry bound -- strictly tighter than Phase 4A, never narrower', () => {
  test('dominant fixed prefix, small remaining open tonnage: Phase 4B collapses toward fixedNi, Phase 4A stays at the full pooled extent', () => {
    // Fixed prefix: 1000 t at Ni=0.90 (e.g. a large Contractor fully
    // decided, far below target). One small open group left (fleet=6,
    // tonnesPerUnit=50 -> max open tonnage 300) whose own sources span
    // 1.0-1.8 -- an order of magnitude less tonnage than the fixed prefix.
    const fixedNumerator = 0.9 * 1000;
    const fixedTonnage = 1000;
    const openGroups = [{ sources: [{ ni: 1.0, tonnesPerUnit: 50 }, { ni: 1.8, tonnesPerUnit: 50 }], fleet: 6 }];
    const openBound = pooledOpenBound(openGroups);

    const oldBound = phase4aBound(fixedNumerator, fixedTonnage, openBound);
    const newBound = conservativeFinalNiBound(fixedNumerator, fixedTonnage, openBound);

    assert.equal(oldBound.minNi, 0.9, 'Phase 4A lower bound: min(fixedNi, openMin) = min(0.9,1.0) = 0.9');
    assert.equal(oldBound.maxNi, 1.8, 'Phase 4A upper bound: max(fixedNi, openMax) = max(0.9,1.8) = 1.8 -- ignores that only 300t of the 1300t final blend can ever be at 1.8');

    assert.ok(newBound.minNi >= oldBound.minNi - BOUND_EPSILON, 'Phase 4B lower bound must never be looser than Phase 4A');
    assert.ok(newBound.maxNi <= oldBound.maxNi + BOUND_EPSILON, 'Phase 4B upper bound must never be looser than Phase 4A');
    assert.ok(newBound.maxNi < oldBound.maxNi - 0.1, `expected a materially tighter upper bound, got Phase4B=${newBound.maxNi} vs Phase4A=${oldBound.maxNi}`);

    // Exact closed form: (900 + 1.8*300) / 1300 = 1440/1300
    assert.ok(Math.abs(newBound.maxNi - 1440 / 1300) < BOUND_EPSILON);

    assertBoundHoldsForAllCompletions(fixedNumerator, fixedTonnage, openGroups, 'dominant-fixed-prefix');
  });

  test('every remaining open group below the 6 DT minimum: Phase 4B pins finalNi exactly at fixedNi; Phase 4A still shows the full open Ni spread', () => {
    const fixedNumerator = 1.25 * 500;
    const fixedTonnage = 500;
    // Two open groups whose OWN fleets are individually and combined under
    // MIN_UNITS_PER_ACTIVE_LOADING_POINT -- neither can ever place a single
    // active source, so groupMaxAchievableTonnage() is exactly 0 for both.
    const openGroups = [
      { sources: [{ ni: 0.5, tonnesPerUnit: 50 }], fleet: MIN_UNITS_PER_ACTIVE_LOADING_POINT - 1 },
      { sources: [{ ni: 2.0, tonnesPerUnit: 50 }], fleet: MIN_UNITS_PER_ACTIVE_LOADING_POINT - 2 },
    ];
    const openBound = pooledOpenBound(openGroups);
    assert.equal(openBound.maxOpenTonnage, 0);

    const oldBound = phase4aBound(fixedNumerator, fixedTonnage, openBound);
    const newBound = conservativeFinalNiBound(fixedNumerator, fixedTonnage, openBound);

    assert.equal(oldBound.minNi, 0.5);
    assert.equal(oldBound.maxNi, 2.0);
    assert.equal(newBound.minNi, 1.25);
    assert.equal(newBound.maxNi, 1.25);

    const { checked } = assertBoundHoldsForAllCompletions(fixedNumerator, fixedTonnage, openGroups, 'dead-open-groups');
    // Both open groups can only ever be all-zero (fleet < 6), so there is
    // exactly ONE feasible completion overall -- the fixed prefix alone,
    // which already has nonzero tonnage (fixedTonnage=500), so it still
    // counts as one checked completion (finalNi === fixedNi exactly).
    assert.equal(checked, 1, 'the only feasible completion is the fixed prefix with both open groups contributing nothing');
  });

  test('as maxOpenTonnage grows very large relative to the fixed prefix, Phase 4B converges toward (but never exceeds) the Phase 4A pooled extent', () => {
    const fixedNumerator = 1.0 * 10;
    const fixedTonnage = 10;
    const openGroups = [{ sources: [{ ni: 0.8, tonnesPerUnit: 50 }, { ni: 1.6, tonnesPerUnit: 50 }], fleet: 100000 }];
    const openBound = pooledOpenBound(openGroups);
    const oldBound = phase4aBound(fixedNumerator, fixedTonnage, openBound);
    const newBound = conservativeFinalNiBound(fixedNumerator, fixedTonnage, openBound);

    assert.ok(Math.abs(newBound.maxNi - oldBound.maxNi) < 0.001, 'with overwhelming open tonnage available, Phase 4B should nearly match Phase 4A (both approach the pure open-group extreme)');
    assert.ok(newBound.maxNi <= oldBound.maxNi + BOUND_EPSILON);
    assert.ok(newBound.minNi >= oldBound.minNi - BOUND_EPSILON);
  });
});

// ============================================================
// 2. RANDOMIZED PROOF, BIASED TOWARD "DOMINANT FIXED PREFIX" SHAPES -- the
// shape where Phase 4B's tightening actually engages, complementing
// tests/v3-phase4a-chemistry-bound.test.mjs's uniformly-random coverage.
// ============================================================
const stats = { partialStatesChecked: 0, completionsChecked: 0, tighterThanPhase4A: 0 };

describe('V3.0 Phase 4B chemistry bound -- randomized proof biased toward dominant-fixed-prefix partial states', () => {
  Object.entries(NAMED_SEEDS).forEach(([seedName, seed]) => {
    describe(`seed ${seedName} (0x${seed.toString(16)})`, () => {
      const rng = mulberry32(seed);
      const CASES_PER_SEED = 40;

      for (let i = 0; i < CASES_PER_SEED; i += 1) {
        test(`biased partial state #${i}: every feasible completion lies inside the tighter Phase 4B bound`, () => {
          // Fixed prefix: LARGE tonnage (simulates several already-decided
          // Contractor groups), Ni drawn from a narrow band far from the
          // open groups' own band -- exactly the shape that makes Phase 4B's
          // tonnage cap matter.
          const fixedTonnage = randInt(rng, 200, 2000);
          const fixedNi = 0.85 + rng() * 0.1; // [0.85, 0.95]
          const fixedNumerator = fixedNi * fixedTonnage;

          const openGroupCount = randInt(rng, 1, 3);
          const openGroups = [];
          for (let g = 0; g < openGroupCount; g += 1) {
            const sourceCount = randInt(rng, 1, 2);
            const sources = [];
            for (let s = 0; s < sourceCount; s += 1) {
              sources.push({ ni: Number((1.3 + rng() * 0.5).toFixed(4)), tonnesPerUnit: pick(rng, [30, 40, 50]) }); // [1.3, 1.8], far above fixedNi
            }
            // Small fleet relative to fixedTonnage -- keeps maxOpenTonnage
            // modest so the fixed prefix dominates, the shape under test.
            openGroups.push({ sources, fleet: pick(rng, [0, 6, 7, 12, 18]) });
          }

          const { bound, checked } = assertBoundHoldsForAllCompletions(fixedNumerator, fixedTonnage, openGroups, `${seedName}#${i}`);
          const oldBound = phase4aBound(fixedNumerator, fixedTonnage, pooledOpenBound(openGroups));
          assert.ok(bound.maxNi <= oldBound.maxNi + BOUND_EPSILON, `${seedName}#${i}: Phase 4B upper bound must never exceed Phase 4A's`);
          assert.ok(bound.minNi >= oldBound.minNi - BOUND_EPSILON, `${seedName}#${i}: Phase 4B lower bound must never be below Phase 4A's`);
          if (bound.maxNi < oldBound.maxNi - BOUND_EPSILON || bound.minNi > oldBound.minNi + BOUND_EPSILON) {
            stats.tighterThanPhase4A += 1;
          }

          stats.partialStatesChecked += 1;
          stats.completionsChecked += checked;
        });
      }
    });
  });

  after(() => {
    // eslint-disable-next-line no-console
    console.log(`[v3-phase4b-chemistry-bound] proof coverage: ${stats.partialStatesChecked} partial states, ${stats.completionsChecked} completions, ${stats.tighterThanPhase4A} strictly tighter than Phase 4A, 0 violations (any violation would have thrown above)`);
  });
});
