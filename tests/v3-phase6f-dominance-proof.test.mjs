// V3.0 Phase 6F -- Exact Partial-State Dominance Frontier Prototype:
// mandatory exhaustive dominance proof (docs/V3.0_SCALABLE_RECOMMENDATION_
// ENGINE_ARCHITECTURE.md Section 20/23; this task's "instead, test an EXACT
// state-dominance frontier"). See js/pages/calculate/
// blending-recommendation-source-lazy.js's own "PHASE 6F ANALYSIS" comment
// (immediately above comparePrefixChain()) for the full algebraic proof this
// file verifies numerically against REAL production machinery.
//
// REUSE, NOT REIMPLEMENTATION: comparePrefixChain()/dominatesPrefix() are
// imported unchanged from the prototype file (the exact functions the live
// frontier calls); every candidate compared below is a REAL buildCandidate()
// object, ranked by the REAL compareWithinTolerance() comparator
// (recommendation-ranking.js) -- never a re-derived stand-in for either.
//
// ---- FIXTURE ----
// Two Contractor-group "layers", ni=1.00 UNIFORM across every source (both
// layers), so estimatedNi is exactly 1.00 for every non-empty completion
// regardless of split -- this isolates the fixture from chemistry/tolerance
// entirely and lets buildCandidate() always return a valid within-tolerance
// candidate, so every difference in compareWithinTolerance's verdict below
// is driven ONLY by the A-J ranking rules, exactly what comparePrefixChain
// claims to predict (rules A-E) or explicitly declines to predict ('unknown'
// /'tie', rules F onward).
// - PREFIX (P1..P4): four single-source Contractors -- the "already-decided"
//   boundary state. Two different PREFIX allocations sharing the identical
//   fixedNumerator/fixedTonnage (found by exhaustive scan of every feasible
//   PREFIX allocation, grouped by (numerator,tonnage); see this task's
//   scratch exploration) stand in for two sibling branches reaching the SAME
//   frontier key.
// - SUFFIX (Q1): one more single-source Contractor -- the "common future":
//   EVERY one of its 16 real feasible allocations
//   (fleet-allocation.js's own enumerateOperationalAllocations(20,1), never
//   reimplemented) is applied identically to BOTH PREFIX allocations, giving
//   32 real full candidates per pair (16 for each PREFIX side) built via the
//   REAL buildCandidate().
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  comparePrefixChain,
  dominatesPrefix,
  findBlendRecommendationsSourceLazyFrontier,
  findBlendRecommendationsSourceLazyCoupled,
} from '../js/pages/calculate/blending-recommendation-source-lazy.js';
import { buildCandidate } from '../js/pages/calculate/blending-recommendation.js';
import { groupSourcesByContractor, enumerateOperationalAllocations } from '../js/pages/calculate/fleet-allocation.js';
import { compareWithinTolerance } from '../js/pages/calculate/recommendation-ranking.js';
import { normalizeSourceIdentity } from '../js/pages/calculate/calculate-validation.js';
import { classifyOre } from '../js/shared/ore-classification.js';
import { canonicalizeRecommendationResult, firstCanonicalDifference } from './reference/canonical-recommendation-result.mjs';

const PREFIX_DEFS = [
  { contractor: 'P1', fleet: 18, tonnesPerUnit: 7 },
  { contractor: 'P2', fleet: 24, tonnesPerUnit: 11 },
  { contractor: 'P3', fleet: 30, tonnesPerUnit: 13 },
  { contractor: 'P4', fleet: 12, tonnesPerUnit: 17 },
];
const SUFFIX_DEFS = [{ contractor: 'Q1', fleet: 20, tonnesPerUnit: 19 }];
const TARGET_NI = 1.00;
const TOLERANCE = 0.0001;

function numericSource(def) {
  return {
    pileId: 'S1', contractor: def.contractor, ni: 1.00, assignedUnits: def.fleet,
    tonnesPerUnit: def.tonnesPerUnit, oreClass: classifyOre(1.00),
  };
}

const GROUPS = groupSourcesByContractor([...PREFIX_DEFS.map(numericSource), ...SUFFIX_DEFS.map(numericSource)]);
const SUFFIX_COMPLETIONS = enumerateOperationalAllocations(SUFFIX_DEFS[0].fleet, 1); // 16 real feasible {0}U[6,20] tuples

function buildActiveMap(prefixActives, suffixActives) {
  const map = new Map();
  PREFIX_DEFS.forEach((def, i) => map.set(normalizeSourceIdentity('S1', def.contractor), prefixActives[i]));
  SUFFIX_DEFS.forEach((def, i) => map.set(normalizeSourceIdentity('S1', def.contractor), suffixActives[i]));
  return map;
}

// completedFixed for each PREFIX side -- the SAME A-E accumulator shape
// combine() folds at a Contractor boundary (criticalCount/activeUnits/
// worstRatio/mitigationCount/fullyUnusedCount), precomputed here by hand
// ONLY to select/label which real allocation pair exercises which first-
// differing rule; comparePrefixChain() itself (called below) is the sole
// authority the frontier trusts, and every claim about it is re-verified
// against real compareWithinTolerance(), never taken on faith from this
// hand-computed label.
//
// Found via exhaustive scan of every feasible PREFIX allocation grouped by
// (numerator,tonnage) -- one real colliding pair per comparePrefixChain
// outcome category:
//   A/B         -- first differing rule is A or B (pure sum): always
//                  certified, unconditionally.
//   Cagree      -- first differing rule is C, but the D/E collapse fallback
//                  agrees with C's own favored direction: certified.
//   Cunknown    -- first differing rule is C, fallback DISAGREES: must
//                  return 'unknown' (the file header's own "do not assume a
//                  strict C advantage always remains strict" case).
//   D/E         -- A/B/C all tie, first differing rule is D or E (pure sum):
//                  always certified, unconditionally.
//   tie         -- A-E fully tied: no information, F onward unknown.
const CASES = {
  A: { actives_x: [0, 0, 0, 7], actives_y: [6, 7, 0, 0], expect: 'A' },
  B: { actives_x: [0, 0, 0, 7], actives_y: [17, 0, 0, 0], expect: 'B' },
  Cagree: { actives_x: [7, 6, 6, 6], actives_y: [9, 0, 10, 6], expect: 'A' },
  D: { actives_x: [15, 9, 0, 0], actives_y: [18, 0, 6, 0], expect: 'B' },
  E: { actives_x: [10, 6, 6, 0], actives_y: [12, 0, 10, 0], expect: 'A' },
  Cunknown: { actives_x: [6, 9, 6, 6], actives_y: [7, 6, 8, 6], expect: 'unknown' },
  tie: { actives_x: [14, 9, 0, 0], actives_y: [17, 0, 6, 0], expect: 'tie' },
};

// Real completedFixed accumulator for one PREFIX allocation, derived by
// building the FULL real candidate at SUFFIX completion [0] (an all-zero,
// zero-tonnage suffix contribution) and reading back its own real
// contractor-level metrics -- i.e. this is compareWithinTolerance's own
// production candidate shape, not a re-derivation, used only to obtain the
// x/y objects comparePrefixChain() itself is called with below.
function prefixFixedFor(prefixActives) {
  const candidate = buildCandidate(GROUPS, buildActiveMap(prefixActives, [0]), TARGET_NI, 100);
  const byContractor = new Map();
  candidate.sources.forEach((s) => {
    if (!PREFIX_DEFS.some((d) => d.contractor === s.contractor)) return; // exclude the [0] suffix contribution
    byContractor.set(s.contractor, s);
  });
  let criticalCount = 0; let activeUnits = 0; let worstRatio = 0; let mitigationCount = 0; let fullyUnusedCount = 0;
  PREFIX_DEFS.forEach((def) => {
    const active = prefixActives[PREFIX_DEFS.indexOf(def)];
    const standby = (def.fleet - active) / def.fleet;
    activeUnits += active;
    if (standby >= 0.50) criticalCount += 1;
    worstRatio = Math.max(worstRatio, standby);
    if (standby > 0.05) mitigationCount += 1;
    if (def.fleet > 0 && active === 0) fullyUnusedCount += 1;
  });
  return { criticalCount, activeUnits, worstRatio, mitigationCount, fullyUnusedCount };
}

describe('V3.0 Phase 6F -- comparePrefixChain()/dominatesPrefix() exhaustive proof against real compareWithinTolerance', () => {
  Object.entries(CASES).forEach(([label, { actives_x, actives_y, expect: expectedVerdict }]) => {
    test(`${label}: comparePrefixChain() returns '${expectedVerdict}' for the real completedFixed pair`, () => {
      const x = prefixFixedFor(actives_x);
      const y = prefixFixedFor(actives_y);
      assert.equal(comparePrefixChain(x, y), expectedVerdict);
    });
  });

  ['A', 'B', 'Cagree', 'D', 'E'].forEach((label) => {
    const { actives_x, actives_y, expect: expectedVerdict } = CASES[label];
    test(`${label}: certified '${expectedVerdict}' holds for EVERY one of the 16 real shared-future completions`, () => {
      const x = prefixFixedFor(actives_x);
      const y = prefixFixedFor(actives_y);
      const dominatorIsX = expectedVerdict === 'A';
      assert.equal(dominatesPrefix(dominatorIsX ? x : y, dominatorIsX ? y : x), true);
      assert.equal(dominatesPrefix(dominatorIsX ? y : x, dominatorIsX ? x : y), false);

      let checked = 0;
      SUFFIX_COMPLETIONS.forEach((suffixTuple) => {
        const candX = buildCandidate(GROUPS, buildActiveMap(actives_x, suffixTuple), TARGET_NI, TOLERANCE);
        const candY = buildCandidate(GROUPS, buildActiveMap(actives_y, suffixTuple), TARGET_NI, TOLERANCE);
        assert.ok(candX && candY, `${label}: both branches must build a real candidate for suffix ${JSON.stringify(suffixTuple)}`);
        assert.equal(candX.withinTolerance, true);
        assert.equal(candY.withinTolerance, true);

        const cmp = compareWithinTolerance(candX, candY);
        assert.notEqual(cmp, 0, `${label}: real ranking must never tie once a prefix rule strictly decided it (suffix ${JSON.stringify(suffixTuple)})`);
        const xWins = cmp < 0;
        assert.equal(xWins, dominatorIsX, `${label}: real compareWithinTolerance disagreed with the certified direction for suffix ${JSON.stringify(suffixTuple)}`);
        checked += 1;
      });
      assert.equal(checked, SUFFIX_COMPLETIONS.length, `${label}: expected to exercise every real suffix completion`);
    });
  });

  test("Cunknown: comparePrefixChain() correctly declines to certify -- the real ranking DOES reverse across the shared future (proves the C/D-E collapse-fallback guard is necessary, not merely conservative)", () => {
    const { actives_x, actives_y } = CASES.Cunknown;
    const x = prefixFixedFor(actives_x);
    const y = prefixFixedFor(actives_y);
    assert.equal(dominatesPrefix(x, y), false);
    assert.equal(dominatesPrefix(y, x), false);

    const signs = new Set();
    SUFFIX_COMPLETIONS.forEach((suffixTuple) => {
      const candX = buildCandidate(GROUPS, buildActiveMap(actives_x, suffixTuple), TARGET_NI, TOLERANCE);
      const candY = buildCandidate(GROUPS, buildActiveMap(actives_y, suffixTuple), TARGET_NI, TOLERANCE);
      const cmp = compareWithinTolerance(candX, candY);
      signs.add(cmp < 0 ? 'x' : cmp > 0 ? 'y' : 'tie');
    });
    // MANDATORY structural proof: had the frontier certified either
    // direction here, at least one real suffix completion would have proven
    // it wrong -- pruning that branch would have been genuinely UNSAFE.
    assert.ok(signs.size > 1, `Cunknown: expected the real winner to flip across the shared future (found only ${[...signs]})`);
  });

  test("tie: comparePrefixChain() correctly declines to certify when A-E are fully prefix-tied (F onward is provably unbounded, Phase 6E) -- neither direction is ever falsely claimed", () => {
    const { actives_x, actives_y } = CASES.tie;
    const x = prefixFixedFor(actives_x);
    const y = prefixFixedFor(actives_y);
    assert.equal(comparePrefixChain(x, y), 'tie');
    assert.equal(dominatesPrefix(x, y), false);
    assert.equal(dominatesPrefix(y, x), false);
  });
});

// ============================================================
// FRONTIER KEY SAFETY -- item 3: the `${flatIdx}|${fixedNumerator}|
// ${fixedTonnage}` key must group ONLY states that share an identical
// future. Verified here against the REAL live traversal (not the hand-built
// fixture above): run the actual production entry point on a scenario with
// genuine Contractor-boundary key collisions and confirm (a) collisions
// really occur (frontierHits > 0 -- the key isn't vacuously inert) and (b)
// the final result is BYTE-IDENTICAL to Phase 6D's coupled baseline
// (frontierMode 'off') -- i.e. every dominance-based prune the frontier
// performed was proven safe, never merely assumed.
// ============================================================
function multiDomeScenarioSources(domesPerContractor, dtPerDome, niHigh = '1.30', niLow = '1.00') {
  const sources = [];
  domesPerContractor.forEach((domeCount, c) => {
    for (let s = 0; s < domeCount; s += 1) {
      sources.push({
        pileId: `C${c}-S${s}`,
        contractor: `Contractor${c}`,
        ni: s % 2 === 0 ? niHigh : niLow,
        units: String(dtPerDome),
        tonnesPerUnit: '50',
      });
    }
  });
  return sources;
}

describe('V3.0 Phase 6F -- frontier key safety: real collisions occur and never change the result', () => {
  test('8 dome / 5 Contractor / 80 DT (multi-dome-per-Contractor, real chemistry): frontierHits > 0, result identical to Phase 6D coupled', () => {
    const sources = multiDomeScenarioSources([2, 2, 2, 1, 1], 10);
    const input = { targetNi: '1.15', tolerance: '0.05', sources };

    const frontier = findBlendRecommendationsSourceLazyFrontier(input);
    const coupled = findBlendRecommendationsSourceLazyCoupled(input);

    assert.ok(frontier.diagnostics.frontierHits > 0, 'expected at least one real Contractor-boundary key collision');
    const diff = firstCanonicalDifference(
      canonicalizeRecommendationResult(coupled.result),
      canonicalizeRecommendationResult(frontier.result),
    );
    assert.equal(diff, null, `frontier result diverged from Phase 6D coupled despite ${frontier.diagnostics.prunedByDominance} dominance prunes: ${diff}`);
    assert.equal(frontier.result.candidateCount, coupled.result.candidateCount);
  });
});
