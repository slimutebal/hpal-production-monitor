// V3.0 Phase 6D -- Coupled (per-Contractor, never pooled) Chemistry Bound
// PROTOTYPE conservativeness proof (docs/
// V3.0_SCALABLE_RECOMMENDATION_ENGINE_ARCHITECTURE.md Section 20/23; this
// task's Section 3, MANDATORY).
//
// Tests conservativeFinalNiBoundCoupled() (js/pages/calculate/
// blending-recommendation-source-lazy.js) IN ISOLATION from the full
// traversal: a "partial state" is exactly (fixedNumerator, fixedTonnage,
// list of still-open Contractor group envelopes) -- however that state
// arose during a real search is irrelevant to whether the BOUND MATH itself
// is safe, so this file constructs many deterministic small states
// directly and, for each:
//   1. computes the new coupled bound;
//   2. exhaustively enumerates EVERY real feasible source-level completion
//      of every open group (fleet-allocation.js's own
//      enumerateOperationalAllocations() -- the SAME generator production/
//      Phase 6B/6C rely on, never a re-implemented enumerator);
//   3. computes the ACTUAL final Ni for every such completion;
//   4. asserts bound.minNi <= actualNi <= bound.maxNi for ALL of them.
// 0 violations required, per this task's own instruction.
//
// It also compares the coupled bound's WIDTH against the OLD Phase 4B/6B
// POOLED bound (conservativeFinalNiBound(), imported/unchanged) on the
// EXACT SAME state, reporting how often the new bound is strictly tighter.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  conservativeFinalNiBoundCoupled,
} from '../js/pages/calculate/blending-recommendation-source-lazy.js';
import {
  groupSourceNiExtent,
  groupMaxAchievableTonnage,
  conservativeFinalNiBound,
} from '../js/pages/calculate/blending-recommendation.js';
import { enumerateOperationalAllocations } from '../js/pages/calculate/fleet-allocation.js';

const FLOAT_EPSILON = 1e-9;

// One synthetic still-open Contractor group: `sources` are {ni, tonnesPerUnit}
// (assignedUnits/pileId are irrelevant to the chemistry bound, so omitted),
// `fleet` is its own remaining fleet.
function makeGroup(fleet, sources) {
  return { fleet, sources };
}

function envelopeOf(group) {
  const extent = groupSourceNiExtent(group.sources);
  const thiTonnage = groupMaxAchievableTonnage(group.fleet, group.sources);
  return { minNi: extent.minNi, maxNi: extent.maxNi, thiTonnage };
}

// Exhaustive REAL completions of one group: every operationally-feasible
// tuple (fleet-allocation.js's own generator), each converted to its own
// (numerator, tonnage) contribution.
function realCompletionsOf(group) {
  const tuples = enumerateOperationalAllocations(group.fleet, group.sources.length);
  return tuples.map((tuple) => {
    let numerator = 0;
    let tonnage = 0;
    tuple.forEach((v, i) => {
      const t = v * group.sources[i].tonnesPerUnit;
      tonnage += t;
      numerator += group.sources[i].ni * t;
    });
    return { numerator, tonnage };
  });
}

// Cartesian product of every group's own real completions -> actual final
// Ni for every joint combination.
function everyActualFinalNi(fixedNumerator, fixedTonnage, groups) {
  const perGroupCompletions = groups.map(realCompletionsOf);
  const results = [];

  function combine(i, numerator, tonnage) {
    if (i === perGroupCompletions.length) {
      if (tonnage > 0) results.push(numerator / tonnage);
      return;
    }
    perGroupCompletions[i].forEach((c) => {
      combine(i + 1, numerator + c.numerator, tonnage + c.tonnage);
    });
  }

  combine(0, fixedNumerator, fixedTonnage);
  return results;
}

function pooledBoundOf(fixedNumerator, fixedTonnage, envelopes) {
  const minNi = Math.min(...envelopes.map((e) => e.minNi));
  const maxNi = Math.max(...envelopes.map((e) => e.maxNi));
  const maxOpenTonnage = envelopes.reduce((sum, e) => sum + e.thiTonnage, 0);
  return conservativeFinalNiBound(fixedNumerator, fixedTonnage, { minNi, maxNi, maxOpenTonnage });
}

// Deterministic scenario table (this task's "many deterministic small
// partial states"): varies group count, fleet sizes (including <6, forcing
// a group to be structurally zero-only), Ni spreads (including ties across
// groups), and the FIXED portion (none / low / high / between the groups'
// own extremes).
const GROUP_SETS = {
  twoGroupsDisjointRanges: [
    makeGroup(12, [{ ni: 1.00, tonnesPerUnit: 40 }, { ni: 1.10, tonnesPerUnit: 45 }]),
    makeGroup(18, [{ ni: 1.40, tonnesPerUnit: 50 }, { ni: 1.50, tonnesPerUnit: 55 }]),
  ],
  twoGroupsOverlappingRanges: [
    makeGroup(15, [{ ni: 1.00, tonnesPerUnit: 50 }, { ni: 1.30, tonnesPerUnit: 50 }]),
    makeGroup(9, [{ ni: 1.10, tonnesPerUnit: 50 }, { ni: 1.25, tonnesPerUnit: 50 }]),
  ],
  threeGroupsMixedFleet: [
    makeGroup(6, [{ ni: 0.90, tonnesPerUnit: 30 }]),
    makeGroup(24, [{ ni: 1.20, tonnesPerUnit: 40 }, { ni: 1.35, tonnesPerUnit: 42 }, { ni: 1.10, tonnesPerUnit: 38 }]),
    makeGroup(12, [{ ni: 1.60, tonnesPerUnit: 60 }, { ni: 1.55, tonnesPerUnit: 58 }]),
  ],
  groupWithForcedZero: [
    makeGroup(3, [{ ni: 0.5, tonnesPerUnit: 20 }, { ni: 1.9, tonnesPerUnit: 25 }]), // fleet<6 -- can never go active
    makeGroup(20, [{ ni: 1.15, tonnesPerUnit: 50 }, { ni: 1.20, tonnesPerUnit: 50 }]),
  ],
  tiedExtremesAcrossGroups: [
    makeGroup(12, [{ ni: 1.30, tonnesPerUnit: 50 }, { ni: 1.00, tonnesPerUnit: 50 }]),
    makeGroup(12, [{ ni: 1.30, tonnesPerUnit: 50 }, { ni: 1.00, tonnesPerUnit: 50 }]),
  ],
  fourGroupsSmall: [
    makeGroup(6, [{ ni: 1.00, tonnesPerUnit: 45 }]),
    makeGroup(7, [{ ni: 1.05, tonnesPerUnit: 40 }]),
    makeGroup(6, [{ ni: 1.45, tonnesPerUnit: 55 }]),
    makeGroup(8, [{ ni: 1.50, tonnesPerUnit: 50 }]),
  ],
};

// Fixed-portion variants tried against EVERY group set above: none, and a
// handful of (numerator,tonnage) pairs representing an already-decided
// prefix with its own average BELOW, WITHIN, and ABOVE the open groups'
// combined Ni range.
function fixedVariantsFor(groups) {
  const allNi = groups.flatMap((g) => g.sources.map((s) => s.ni));
  const lo = Math.min(...allNi);
  const hi = Math.max(...allNi);
  const mid = (lo + hi) / 2;
  return [
    { name: 'no-fixed', fixedNumerator: 0, fixedTonnage: 0 },
    { name: 'fixed-below-range', fixedNumerator: (lo - 0.2) * 30, fixedTonnage: 30 },
    { name: 'fixed-within-range', fixedNumerator: mid * 25, fixedTonnage: 25 },
    { name: 'fixed-above-range', fixedNumerator: (hi + 0.2) * 20, fixedTonnage: 20 },
  ];
}

describe('V3.0 Phase 6D -- coupled chemistry bound: exhaustive conservativeness proof (0 violations required)', () => {
  let totalStates = 0;
  let totalCompletionsChecked = 0;
  let totalViolations = 0;
  let strictlyTighterCount = 0;
  let comparableBoundCount = 0;

  Object.entries(GROUP_SETS).forEach(([setName, groups]) => {
    fixedVariantsFor(groups).forEach(({ name: variantName, fixedNumerator, fixedTonnage }) => {
      test(`${setName} / ${variantName}: 0 bound violations across every real completion`, () => {
        const envelopes = groups.map(envelopeOf);
        const bound = conservativeFinalNiBoundCoupled(fixedNumerator, fixedTonnage, envelopes);
        const pooled = pooledBoundOf(fixedNumerator, fixedTonnage, envelopes);
        const actuals = everyActualFinalNi(fixedNumerator, fixedTonnage, groups);

        totalStates += 1;
        totalCompletionsChecked += actuals.length;

        let violations = 0;
        actuals.forEach((actualNi) => {
          const ok = bound.minNi <= actualNi + FLOAT_EPSILON && actualNi <= bound.maxNi + FLOAT_EPSILON;
          if (!ok) violations += 1;
        });
        totalViolations += violations;

        assert.equal(violations, 0, `${setName}/${variantName}: ${violations}/${actuals.length} completions violated bound [${bound.minNi}, ${bound.maxNi}]`);
        assert.ok(actuals.length > 0, `${setName}/${variantName}: expected at least one real completion`);

        // Width comparison (this task's "compare new bound width against
        // Phase 6B bound... report how often it is strictly tighter").
        // Only meaningful when the pooled bound is itself finite (both
        // bounds degenerate identically in the "nothing can ever be
        // active" edge case).
        if (Number.isFinite(pooled.minNi) && Number.isFinite(pooled.maxNi) && Number.isFinite(bound.minNi) && Number.isFinite(bound.maxNi)) {
          comparableBoundCount += 1;
          const pooledWidth = pooled.maxNi - pooled.minNi;
          const coupledWidth = bound.maxNi - bound.minNi;
          if (coupledWidth < pooledWidth - FLOAT_EPSILON) strictlyTighterCount += 1;
          // The coupled bound must NEVER be wider than pooled by more than
          // float noise -- it is a refinement of the same relaxation, so it
          // can only match or improve.
          assert.ok(coupledWidth <= pooledWidth + FLOAT_EPSILON, `${setName}/${variantName}: coupled bound (${coupledWidth}) is WIDER than pooled (${pooledWidth}) -- should never happen`);
        }
      });
    });
  });

  test('SUMMARY (informational)', () => {
    // eslint-disable-next-line no-console
    console.log([
      '[v3-phase6d] CONSERVATIVENESS PROOF SUMMARY',
      `  states tested                : ${totalStates}`,
      `  real completions checked     : ${totalCompletionsChecked}`,
      `  bound violations             : ${totalViolations}`,
      `  comparable (finite) states   : ${comparableBoundCount}`,
      `  strictly tighter than pooled : ${strictlyTighterCount} / ${comparableBoundCount} (${comparableBoundCount > 0 ? ((100 * strictlyTighterCount) / comparableBoundCount).toFixed(1) : 'n/a'}%)`,
    ].join('\n'));
    assert.equal(totalViolations, 0);
  });
});
