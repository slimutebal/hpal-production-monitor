// V3.0 Phase 3 -- streaming exact winner selection (this task's Section
// 28/29 of docs/V3.0_SCALABLE_RECOMMENDATION_ENGINE_ARCHITECTURE.md).
//
// findBlendRecommendations() (js/pages/calculate/blending-recommendation.js)
// no longer materializes a candidates[]/withinTolerance[] array or calls
// slice().sort()[0] to pick a winner -- it now tracks two rolling
// incumbents (bestWithinTolerance/bestAttainable) while candidates are
// generated, using the SAME exported comparators
// (compareWithinTolerance/compareBestAttainable from
// recommendation-ranking.js) that pickBestCandidate() used to sort with.
//
// findBlendRecommendationsMaterialized() (same production module,
// TEST-SUPPORT ONLY export) re-implements the pre-Phase-3
// materialize+filter+slice().sort()[0] selection on top of the exact same
// prepareSearch()/forEachCandidate()/buildCandidate() building blocks, so
// this suite can prove the streaming refactor changed nothing about WHICH
// candidate wins -- only how it is found.
//
// Run with Node's built-in test runner:
//
//   node --test tests/v3-phase3-streaming.test.mjs
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  findBlendRecommendations,
  findBlendRecommendationsMaterialized,
} from '../js/pages/calculate/blending-recommendation.js';
import { mulberry32, NAMED_SEEDS } from './reference/seeded-random.mjs';
import { generateScenario, permuteScenarioSources } from './reference/v3-scenario-generator.mjs';
import { canonicalizeRecommendationResult, firstCanonicalDifference } from './reference/canonical-recommendation-result.mjs';

function activeUnitsOf(candidate, pileId) {
  return candidate.sources.find((s) => s.pileId === pileId).activeUnits;
}

// ============================================================
// 1/2/3/4/6. STREAMING VS MATERIALIZED -- WINNER IDENTITY (this task's
// TESTS requirements 1-4, 6): several NAMED fixed seeds, each driving many
// directed+randomized small scenarios (covering WITHIN_TOLERANCE,
// TARGET_NOT_ACHIEVABLE, and deliberate near-ties -- see
// tests/reference/v3-scenario-generator.mjs's KINDS list) through BOTH
// selection strategies. Unlike tests/v3-differential.test.mjs (which
// compares production against the frozen PRE-Phase-2 legacy oracle and
// therefore tolerates the approved MIN_LOADING_POINT_6 delta), streaming
// vs. materialized share identical Phase 2 generation-time feasibility --
// there is no legitimate delta here. Every mismatch is a Phase 3 bug.
// firstCanonicalDifference() compares floats via Object.is (this task's
// TESTS requirement 6: full precision Ni preserved, not just "close to").
// ============================================================
const stats = { compared: 0, mismatches: 0 };

describe('V3.0 Phase 3 streaming vs materialized winner identity (this task\'s TESTS 1-4/6)', () => {
  Object.entries(NAMED_SEEDS).forEach(([seedName, seed]) => {
    describe(`seed ${seedName} (0x${seed.toString(16)})`, () => {
      const rng = mulberry32(seed);
      const CASES_PER_SEED = 60;

      for (let i = 0; i < CASES_PER_SEED; i += 1) {
        const scenario = generateScenario(rng, i);

        test(`case #${i} (${scenario.kind}): streaming winner is byte-identical to materialized winner`, () => {
          const streaming = findBlendRecommendations(scenario.input);
          const materialized = findBlendRecommendationsMaterialized(scenario.input);

          const streamingCanonical = canonicalizeRecommendationResult(streaming);
          const materializedCanonical = canonicalizeRecommendationResult(materialized);
          const diffResult = firstCanonicalDifference(materializedCanonical, streamingCanonical);

          stats.compared += 1;
          if (diffResult) stats.mismatches += 1;
          assert.equal(diffResult, null, `streaming/materialized mismatch for ${scenario.name}: ${diffResult}`);
        });
      }
    });
  });

  after(() => {
    // eslint-disable-next-line no-console
    console.log(`[v3-phase3-streaming] streaming-vs-materialized totals: ${stats.compared} compared, mismatches=${stats.mismatches}`);
  });
});

// ============================================================
// 4. TIE-BREAK IDENTICAL -- explicit near-tie scenario (this task's TESTS
// requirement 4): two same-Contractor sources with identical Ni/Tonnes-per-
// DT (only Pile ID differs), so every ranking rule ties except the final
// deterministic allocationSignature tie-break (rule J/6). Both selection
// strategies must resolve the tie to the exact same allocationSignature.
// ============================================================
describe('4. Explicit near-tie: streaming and materialized resolve identically (this task\'s TESTS 4)', () => {
  const input = {
    targetNi: '1.20',
    tolerance: '0.05',
    sources: [
      { pileId: 'PA1', contractor: 'CTR-A', ni: '1.20', units: '6', tonnesPerUnit: '50' },
      { pileId: 'PA2', contractor: 'CTR-A', ni: '1.20', units: '6', tonnesPerUnit: '50' },
    ],
  };

  test('streaming and materialized pick the same allocationSignature', () => {
    const streaming = findBlendRecommendations(input);
    const materialized = findBlendRecommendationsMaterialized(input);
    assert.equal(streaming.ok, true);
    assert.equal(materialized.ok, true);
    assert.equal(streaming.candidate.allocationSignature, materialized.candidate.allocationSignature);
  });
});

// ============================================================
// 5. SOURCE-ORDER INDEPENDENCE PRESERVED (this task's TESTS requirement
// 5) -- the streaming production path must still be internally order-
// independent (groupSourcesByContractor() re-establishes canonical order
// regardless of input order), and must still agree with the materialized
// path on the permuted input too.
// ============================================================
describe('5. Source-order independence preserved under streaming (this task\'s TESTS 5)', () => {
  const rng = mulberry32(NAMED_SEEDS[Object.keys(NAMED_SEEDS)[0]]);
  const permutationRng = mulberry32(0xC0FFEE);

  for (let i = 0; i < 20; i += 1) {
    const scenario = generateScenario(rng, i);
    const permuted = permuteScenarioSources(scenario, permutationRng);

    test(`case #${i} (${scenario.kind}): streaming result is unchanged by source-order permutation`, () => {
      const original = canonicalizeRecommendationResult(findBlendRecommendations(scenario.input));
      const reordered = canonicalizeRecommendationResult(findBlendRecommendations(permuted.input));
      const diffResult = firstCanonicalDifference(original, reordered);
      assert.equal(diffResult, null, `streaming is order-dependent for ${scenario.name}: ${diffResult}`);
    });

    test(`case #${i} (${scenario.kind}): materialized result is unchanged by source-order permutation`, () => {
      const original = canonicalizeRecommendationResult(findBlendRecommendationsMaterialized(scenario.input));
      const reordered = canonicalizeRecommendationResult(findBlendRecommendationsMaterialized(permuted.input));
      const diffResult = firstCanonicalDifference(original, reordered);
      assert.equal(diffResult, null, `materialized is order-dependent for ${scenario.name}: ${diffResult}`);
    });
  }
});

// ============================================================
// 7. CANDIDATECOUNT UNCHANGED (this task's TESTS requirement 7) --
// candidateCount must still mean "number of non-all-zero built candidates"
// (never the raw gate count), reusing the audited Scenario A numbers
// (docs/V3.0_SCALABLE_RECOMMENDATION_ENGINE_ARCHITECTURE.md Sections 10-18,
// also exercised by tests/v3-phase2-performance.test.mjs): operational
// count 58,081 minus the single excluded all-zero combination = 58,080.
// ============================================================
describe('7. candidateCount compatibility (this task\'s TESTS 7)', () => {
  function buildScenarioA() {
    const sources = [];
    for (let c = 0; c < 2; c += 1) {
      for (let s = 0; s < 2; s += 1) {
        sources.push({
          pileId: `C${c}-S${s}`,
          contractor: `Contractor${c}`,
          ni: s % 2 === 0 ? '1.30' : '1.00',
          units: '15',
          tonnesPerUnit: '50',
        });
      }
    }
    return sources;
  }

  test('streaming candidateCount equals the audited 58,080 (58,081 operational allocations minus the excluded all-zero one)', () => {
    const result = findBlendRecommendations({ targetNi: 1.15, tolerance: 0.05, sources: buildScenarioA() });
    assert.equal(result.ok, true);
    assert.equal(result.candidateCount, 58080);
  });

  test('streaming candidateCount equals materialized candidates.length for several small scenarios', () => {
    const rng = mulberry32(0xABCDEF01);
    for (let i = 0; i < 15; i += 1) {
      const scenario = generateScenario(rng, i);
      const streaming = findBlendRecommendations(scenario.input);
      const materialized = findBlendRecommendationsMaterialized(scenario.input);
      if (streaming.ok && materialized.ok) {
        assert.equal(streaming.candidateCount, materialized.candidateCount, `candidateCount mismatch for ${scenario.name}`);
      } else {
        assert.equal(streaming.ok, materialized.ok, `ok/error-shape mismatch for ${scenario.name}`);
      }
    }
  });
});

// ============================================================
// 8. PHASE 2 MINIMUM-6 BEHAVIOR UNCHANGED (this task's TESTS requirement
// 8) -- reuses tests/v3-phase2-edge-cases.test.mjs's own already-verified
// fixtures (Sections 24-27) unchanged, proving Phase 3's refactor did not
// touch generation-time feasibility at all: buildCandidate()/
// enumerateOperationalAllocations() are shared, untouched code.
// ============================================================
describe('8. Phase 2 minimum-6 behavior unchanged under streaming (this task\'s TESTS 8)', () => {
  test('legacy 34/1-style case: production still lands on TARGET_NOT_ACHIEVABLE with L1=35/L2=0 (no 1-5 DT loading point ever generated)', () => {
    const input = {
      targetNi: '1.017142857',
      tolerance: '0.002',
      sources: [
        { pileId: 'L1', contractor: 'CTR-A', ni: '1.00', units: '34', tonnesPerUnit: '50' },
        { pileId: 'L2', contractor: 'CTR-A', ni: '1.60', units: '1', tonnesPerUnit: '50' },
      ],
    };
    const result = findBlendRecommendations(input);
    assert.equal(result.ok, true);
    assert.equal(result.status, 'TARGET_NOT_ACHIEVABLE');
    assert.equal(activeUnitsOf(result.candidate, 'L1'), 35);
    assert.equal(activeUnitsOf(result.candidate, 'L2'), 0);
    result.candidate.sources.forEach((s) => {
      assert.ok(s.activeUnits === 0 || s.activeUnits >= 6, `source ${s.pileId} has an invalid activeUnits=${s.activeUnits}`);
    });
  });

  test('every-Contractor-fleet-under-6 case: production still returns NO_FEASIBLE_CANDIDATE, never a silently relaxed 1-5 DT candidate', () => {
    const input = {
      targetNi: '1.20',
      tolerance: '0.01',
      sources: [
        { pileId: 'L1', contractor: 'CTR-A', ni: '1.00', units: '4', tonnesPerUnit: '50' },
        { pileId: 'L2', contractor: 'CTR-B', ni: '1.80', units: '3', tonnesPerUnit: '50' },
      ],
    };
    const result = findBlendRecommendations(input);
    assert.equal(result.ok, false);
    assert.equal(result.error, 'NO_FEASIBLE_CANDIDATE');
  });

  test('fleet of exactly 6 (smallest feasible nonzero fleet) still succeeds with active=6', () => {
    const input = {
      targetNi: '1.20',
      tolerance: '0.01',
      sources: [{ pileId: 'L1', contractor: 'CTR-A', ni: '1.20', units: '6', tonnesPerUnit: '50' }],
    };
    const result = findBlendRecommendations(input);
    assert.equal(result.ok, true);
    assert.equal(result.status, 'OK');
    assert.equal(activeUnitsOf(result.candidate, 'L1'), 6);
  });
});

// ============================================================
// 9. SEARCH_SPACE_TOO_LARGE BEHAVIOR (this task's TESTS requirement 9) --
// the per-Contractor bound-before-generating gate (prepareSearch()) must
// still reject a single oversized Contractor group identically, before any
// streaming/materialization begins. V3.0 Phase 4D removed the SIBLING
// cross-Contractor MAX_GLOBAL_CANDIDATES gate (see the second test below,
// updated to reflect that removal) -- this describe block's per-Contractor
// coverage itself is otherwise unchanged.
// ============================================================
describe('9. SEARCH_SPACE_TOO_LARGE behavior (this task\'s TESTS 9)', () => {
  // V3.0 Phase 7A UPDATE: the per-Contractor prepareSearch() gate below
  // still rejects this exact shape at generation time (verified by the
  // "materialized test-support path" test below, which calls prepareSearch()
  // directly with no hard-case fallback) -- but findBlendRecommendations()
  // itself no longer surfaces that rejection to the caller: the hybrid
  // dispatcher routes it to the hard-case (prefix-lock + MITM) engine
  // instead, which needs no eager per-Contractor array and solves it
  // exactly (this task's own Section 5).
  test('a genuinely oversized single-source fleet (F=25000, n=1) is solved exactly by the hard-case engine, not rejected', () => {
    const input = {
      targetNi: 1.2,
      tolerance: 0.01,
      sources: [{ pileId: 'A', contractor: 'SMA', ni: '1.2', units: '25000', tonnesPerUnit: '50' }],
    };
    const result = findBlendRecommendations(input);
    assert.equal(result.ok, true);
    assert.equal(result.status, 'OK');
    assert.equal(result.solverPath, 'HARDCASE_MITM');
  });

  test('V3.0 Phase 4D UPDATE: 3 Contractors x 2 sources x 10 DT (operational count 438,976) is now UNBLOCKED -- the removed MAX_GLOBAL_CANDIDATES gate no longer rejects it; a single oversized Contractor group (test above) still is', () => {
    const sources = [];
    for (let c = 0; c < 3; c += 1) {
      for (let s = 0; s < 2; s += 1) {
        sources.push({
          pileId: `C${c}-S${s}`,
          contractor: `Contractor${c}`,
          ni: s % 2 === 0 ? '1.30' : '1.00',
          units: '10',
          tonnesPerUnit: '50',
        });
      }
    }
    const result = findBlendRecommendations({ targetNi: 1.15, tolerance: 0.05, sources });
    assert.equal(result.ok, true);
    assert.equal(result.status, 'OK');
    assert.equal(result.candidateCount, 438975);
  });

  // V3.0 Phase 7A UPDATE: findBlendRecommendationsMaterialized() is
  // TEST-SUPPORT ONLY and deliberately never gained the hard-case
  // dispatcher (it calls prepareSearch() directly and returns its raw
  // ok:false result on the per-Contractor gate, exactly as before) -- so it
  // still proves the SHARED prepareSearch() gate itself is unchanged, even
  // though findBlendRecommendations() (production) now resolves the
  // identical input via the hard-case engine instead of surfacing that
  // same rejection. This is an intentional divergence between the
  // production entry point and this benchmark-only helper, not a shared-gate
  // regression.
  test('the materialized test-support path still surfaces the raw per-Contractor gate (proves prepareSearch() itself is unchanged), while production resolves the same input via the hard-case engine', () => {
    const input = {
      targetNi: 1.2,
      tolerance: 0.01,
      sources: [{ pileId: 'A', contractor: 'SMA', ni: '1.2', units: '25000', tonnesPerUnit: '50' }],
    };
    const streaming = findBlendRecommendations(input);
    const materialized = findBlendRecommendationsMaterialized(input);

    assert.equal(materialized.ok, false);
    assert.equal(materialized.error, 'SEARCH_SPACE_TOO_LARGE');

    assert.equal(streaming.ok, true);
    assert.equal(streaming.status, 'OK');
    assert.equal(streaming.solverPath, 'HARDCASE_MITM');
  });
});

// ============================================================
// 10. NO CANDIDATE ARRAY/SORT REQUIRED IN THE PRODUCTION SEARCH PATH (this
// task's TESTS requirement 10 / GOAL's "No candidate array should be
// required for winner selection") -- a structural check on the actual
// production source text: everything ABOVE the "TEST-SUPPORT ONLY" marker
// (findBlendRecommendations()/prepareSearch()/forEachCandidate()) must
// contain neither a `.sort(` call against a ranking comparator nor a
// `candidates.push(`/`candidates = []` collection pattern. (relocations
// .sort() is unrelated business logic -- ordering a candidate's OWN
// relocation list for display -- and is deliberately matched separately
// with its own distinct signature so it can never mask a regression here.)
// ============================================================
describe('10. No candidate array/sort in the production search path (this task\'s TESTS 10)', () => {
  const modulePath = fileURLToPath(new URL('../js/pages/calculate/blending-recommendation.js', import.meta.url));
  const source = readFileSync(modulePath, 'utf8');
  const markerIndex = source.indexOf('TEST-SUPPORT ONLY');
  const productionSource = markerIndex === -1 ? source : source.slice(0, markerIndex);

  test('the marker itself is present (guards against this check silently scanning nothing)', () => {
    assert.notEqual(markerIndex, -1, 'expected a TEST-SUPPORT ONLY marker separating production code from test-only materialized helpers');
  });

  test('production code never calls .sort(compareWithinTolerance) or .sort(compareBestAttainable)', () => {
    assert.ok(!productionSource.includes('.sort(compareWithinTolerance'), 'found a comparator-based sort in the production search path');
    assert.ok(!productionSource.includes('.sort(compareBestAttainable'), 'found a comparator-based sort in the production search path');
  });

  test('production code never builds a growing "candidates" collection', () => {
    assert.ok(!productionSource.includes('candidates.push('), 'found candidates.push( in the production search path');
    assert.ok(!/\bconst candidates\s*=\s*\[\]/.test(productionSource), 'found a candidates = [] array literal in the production search path');
  });

  test('production code no longer imports pickBestCandidate (the sort-based selector)', () => {
    const importBlockMatch = source.match(/import \{[^}]*\} from '\.\/recommendation-ranking\.js';/);
    assert.ok(importBlockMatch, "expected a recognizable import from './recommendation-ranking.js'");
    assert.ok(!importBlockMatch[0].includes('pickBestCandidate'), 'production still imports the sort-based pickBestCandidate()');
    assert.ok(importBlockMatch[0].includes('compareWithinTolerance'), 'expected compareWithinTolerance to be imported directly');
    assert.ok(importBlockMatch[0].includes('compareBestAttainable'), 'expected compareBestAttainable to be imported directly');
  });
});
