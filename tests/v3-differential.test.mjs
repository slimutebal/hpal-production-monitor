// V3.0 Phase 1/2 -- differential test harness (Phase 1 Section 16-23,
// Phase 2 Section 16-18/28-29). See tests/reference/v2-exhaustive/ for the
// frozen legacy oracle, tests/reference/assert-recommendation-equivalent.mjs
// for the comparison helper (and its Phase 2 MIN_LOADING_POINT_6
// APPROVED_DELTAS handler), and tests/reference/v3-scenario-generator.mjs
// for the directed+randomized scenario generator.
//
// Run with Node's built-in test runner:
//
//   node --test tests/v3-differential.test.mjs
//
// STRUCTURE (this task's Section 35 self-check first, then randomized):
//   1. Reference self-check -- the frozen reference reproduces a set of
//      KNOWN, already-verified Recommendation numbers (reused verbatim
//      from tests/blending-recommendation.test.mjs's own worked
//      examples), independent of production. Catches a mistake introduced
//      while copying the oracle itself before it is ever trusted as a
//      comparison baseline.
//   2. Legacy SEARCH_SPACE_TOO_LARGE coverage -- both engines must still
//      agree on the current V2.x safety-bound behavior, EXCEPT where the
//      exact new operational count legitimately clears the limit (Phase 2
//      Section 30) -- verified mathematically, not assumed.
//   3. Deterministic randomized differential -- several NAMED fixed seeds
//      (tests/reference/seeded-random.mjs), each driving many small,
//      directed+randomized scenarios through both engines. Every call
//      passes expectedApprovedDelta: 'MIN_LOADING_POINT_6' (Phase 2
//      Section 17) -- this does NOT weaken equality: the handler only
//      suppresses a difference in the three narrow, explicitly-defined
//      cases documented in tests/reference/assert-recommendation-
//      equivalent.mjs; every other difference still fails loudly. A
//      shared `stats` counter (Phase 2 Section 18/28) tracks how many
//      scenarios were strict matches vs. approved deltas vs. genuinely
//      unexpected, reported at the end of the suite.
//   4. Source-order permutation coverage on a subset of generated cases.
//
// This suite is intentionally READ-ONLY / non-generative: it never writes
// fixtures, never calls Math.random(), and never widens numeric tolerance
// to hide a mismatch (this task's Section 11).
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { findBlendRecommendations } from '../js/pages/calculate/blending-recommendation.js';
import { findBlendRecommendationsReference } from './reference/v2-exhaustive/blending-recommendation-reference.mjs';
import { mulberry32, NAMED_SEEDS } from './reference/seeded-random.mjs';
import { generateScenario, permuteScenarioSources } from './reference/v3-scenario-generator.mjs';
import { assertRecommendationEquivalent } from './reference/assert-recommendation-equivalent.mjs';
import { canonicalizeRecommendationResult, firstCanonicalDifference } from './reference/canonical-recommendation-result.mjs';

function closeTo(actual, expected, epsilon = 1e-9) {
  assert.ok(Math.abs(actual - expected) < epsilon, `expected ${actual} to be close to ${expected}`);
}

// ============================================================
// 1. REFERENCE SELF-CHECK (this task's Section 35) -- known-correct
// numbers reused verbatim from tests/blending-recommendation.test.mjs's
// own "24. Known fleet example" / "25. Same-Contractor relocation" /
// "Composite source identity" describe blocks, run ONLY against the
// frozen reference (never production) to prove the copy itself is
// faithful before it is trusted as a comparison oracle.
// ============================================================
describe('V3.0 Phase 1 reference self-check (this task\'s Section 35)', () => {
  test('known fleet example (5 HG DT / 8 LGLO DT, target 1.120 +/- 0.010) reproduces the exact known numbers', () => {
    const result = findBlendRecommendationsReference({
      targetNi: 1.12,
      tolerance: 0.01,
      sources: [
        { pileId: 'Higher', contractor: 'ContractorA', ni: '1.30', units: '5', tonnesPerUnit: '50' },
        { pileId: 'Lglo', contractor: 'ContractorB', ni: '1.03', units: '8', tonnesPerUnit: '50' },
      ],
    });
    assert.equal(result.ok, true);
    assert.equal(result.status, 'OK');
    closeTo(result.candidate.estimatedNi, 1.12);
    assert.equal(result.candidate.totalFleetUnits, 13);
    assert.equal(result.candidate.totalActiveUnits, 12);
    assert.equal(result.candidate.higherGradeUnits, 4);
    assert.equal(result.candidate.lgloUnits, 8);
    assert.deepEqual(result.candidate.unitRatio, { rawHigher: 4, rawLglo: 8, higher: 1, lglo: 2 });
  });

  test('same-Contractor relocation (Higher/Lglo both under SMA) reproduces the exact known 1 DT MOVE', () => {
    const result = findBlendRecommendationsReference({
      targetNi: 1.12,
      tolerance: 0.01,
      sources: [
        { pileId: 'Higher', contractor: 'SMA', ni: '1.30', units: '5', tonnesPerUnit: '50' },
        { pileId: 'Lglo', contractor: 'SMA', ni: '1.03', units: '7', tonnesPerUnit: '50' },
      ],
    });
    assert.equal(result.ok, true);
    closeTo(result.candidate.estimatedNi, 1.12);
    assert.equal(result.candidate.totalFleetUnits, 12);
    assert.equal(result.candidate.totalActiveUnits, 12);
    assert.equal(result.candidate.fleetUtilization, 1);
    assert.deepEqual(result.candidate.unitRatio, { rawHigher: 4, rawLglo: 8, higher: 1, lglo: 2 });
    assert.deepEqual(result.candidate.relocations, [{ contractor: 'SMA', fromPileId: 'Higher', toPileId: 'Lglo', units: 1 }]);
  });

  test('composite source identity (same Pile ID "L30" under two different Contractors) never collides', () => {
    const result = findBlendRecommendationsReference({
      targetNi: 1.12,
      tolerance: 0.01,
      sources: [
        { pileId: 'L30', contractor: 'SMA', ni: '1.30', units: '5', tonnesPerUnit: '50' },
        { pileId: 'L30', contractor: 'TII', ni: '1.03', units: '8', tonnesPerUnit: '50' },
      ],
    });
    assert.equal(result.ok, true);
    closeTo(result.candidate.estimatedNi, 1.12);
    assert.equal(result.candidate.totalFleetUnits, 13);
    assert.equal(result.candidate.totalActiveUnits, 12);
    assert.equal(result.candidate.relocations.length, 0);
    const smaSource = result.candidate.sources.find((s) => s.contractor === 'SMA');
    const tiiSource = result.candidate.sources.find((s) => s.contractor === 'TII');
    assert.equal(smaSource.activeUnits, 4);
    assert.equal(tiiSource.activeUnits, 8);
  });
});

// ============================================================
// 2. LEGACY SEARCH_SPACE_TOO_LARGE COVERAGE (this task's Section 23) --
// both engines must still agree on the current V2.x safety-bound
// behavior. Do NOT change this expectation in Phase 1; it is the
// historical baseline a later V3.0 phase's scalable engine will
// eventually improve on.
// ============================================================
describe('V3.0 Phase 1/2 legacy SEARCH_SPACE_TOO_LARGE coverage (Phase 1 Section 23, Phase 2 Section 30)', () => {
  test('A. a genuinely oversized single-source fleet is rejected by both engines (operational count 24,996 for F=25000,n=1 still exceeds MAX_ALLOCATIONS_PER_CONTRACTOR=20,000)', () => {
    const input = {
      targetNi: 1.2,
      tolerance: 0.01,
      sources: [{ pileId: 'A', contractor: 'SMA', ni: '1.2', units: '25000', tonnesPerUnit: '50' }],
    };
    const production = findBlendRecommendations(input);
    const reference = findBlendRecommendationsReference(input);
    assert.equal(production.ok, false);
    assert.equal(production.error, 'SEARCH_SPACE_TOO_LARGE');
    assert.equal(reference.ok, false);
    assert.equal(reference.error, 'SEARCH_SPACE_TOO_LARGE');
  });

  test('B. realistic-but-rejected 3 Contractors x 2 sources x 10 DT is STILL rejected by both engines under Phase 2 (this task\'s Section 30: raw ~12.3M, operational ~438,976 per audit -- still > MAX_GLOBAL_CANDIDATES=200,000, verified mathematically below, not assumed)', () => {
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
    const input = { targetNi: 1.15, tolerance: 0.05, sources };
    const production = findBlendRecommendations(input);
    const reference = findBlendRecommendationsReference(input);
    assert.equal(production.ok, false);
    assert.equal(production.error, 'SEARCH_SPACE_TOO_LARGE');
    assert.equal(reference.ok, false);
    assert.equal(reference.error, 'SEARCH_SPACE_TOO_LARGE');
  });
});

// ============================================================
// 3-4. DETERMINISTIC RANDOMIZED DIFFERENTIAL + SOURCE-ORDER PERMUTATION
// (this task's Section 17-22) -- several NAMED fixed seeds, each driving
// CASES_PER_SEED directed+randomized small scenarios through both
// engines. Every 5th scenario per seed additionally gets a source-order
// permutation check (this task's Section 22).
// ============================================================
const CASES_PER_SEED = 100;
const PERMUTATION_STRIDE = 5;

// Phase 2 Section 18/28 -- shared counters across the whole randomized
// suite, reported via `after()` below. `assertRecommendationEquivalent()`
// itself still throws (failing the specific test) on any UNEXPECTED
// mismatch -- these counters are a visibility/reporting aid, not a
// substitute gate.
const stats = { strictMatches: 0, approvedDeltas: 0, unexpectedMismatches: 0 };

describe(`V3.0 Phase 1/2 deterministic randomized differential (${Object.keys(NAMED_SEEDS).length} seeds x ${CASES_PER_SEED} cases)`, () => {
  Object.entries(NAMED_SEEDS).forEach(([seedName, seed]) => {
    describe(`seed ${seedName} (0x${seed.toString(16)})`, () => {
      const rng = mulberry32(seed);
      // A SEPARATE rng stream (offset from the scenario stream) drives
      // permutation shuffling, so adding/removing a permutation check
      // never reshuffles which scenarios later indices in this same seed
      // produce.
      const permutationRng = mulberry32(seed ^ 0x9e3779b9);

      for (let i = 0; i < CASES_PER_SEED; i += 1) {
        const scenario = generateScenario(rng, i);

        test(`case #${i} (${scenario.kind}): production matches frozen reference (strictly, or under the approved MIN_LOADING_POINT_6 delta)`, () => {
          assertRecommendationEquivalent(scenario.input, {
            seedName,
            seed,
            scenarioName: scenario.name,
            scenarioIndex: i,
            expectedApprovedDelta: 'MIN_LOADING_POINT_6',
            stats,
          });
        });

        if (i % PERMUTATION_STRIDE === 0) {
          test(`case #${i} (${scenario.kind}): source-order permutation -- both engines are order-independent and still agree with each other`, () => {
            const permuted = permuteScenarioSources(scenario, permutationRng);

            // Cross-engine equivalence on the permuted order too.
            assertRecommendationEquivalent(permuted.input, {
              seedName,
              seed,
              scenarioName: permuted.name,
              scenarioIndex: i,
              expectedApprovedDelta: 'MIN_LOADING_POINT_6',
              stats,
            });

            // Order-independence CONTRACT: each engine, on its own, must
            // produce the identical canonical candidate regardless of
            // input source order (fleet-allocation.js/-reference.mjs's
            // groupSourcesByContractor() is responsible for this). This
            // is NOT weakened by Phase 2 (Section 29) -- both engines
            // must still be internally order-independent, strictly, with
            // no delta involved (a source-order artifact would never be
            // an approved MIN_LOADING_POINT_6 consequence).
            const productionOriginal = canonicalizeRecommendationResult(findBlendRecommendations(scenario.input));
            const productionPermuted = canonicalizeRecommendationResult(findBlendRecommendations(permuted.input));
            const productionDiff = firstCanonicalDifference(productionOriginal, productionPermuted);
            assert.equal(productionDiff, null, `production is order-dependent for ${scenario.name}: ${productionDiff}`);

            const referenceOriginal = canonicalizeRecommendationResult(findBlendRecommendationsReference(scenario.input));
            const referencePermuted = canonicalizeRecommendationResult(findBlendRecommendationsReference(permuted.input));
            const referenceDiff = firstCanonicalDifference(referenceOriginal, referencePermuted);
            assert.equal(referenceDiff, null, `reference is order-dependent for ${scenario.name}: ${referenceDiff}`);
          });
        }
      }
    });
  });

  after(() => {
    const total = stats.strictMatches + stats.approvedDeltas + stats.unexpectedMismatches;
    // eslint-disable-next-line no-console
    console.log(`[v3-differential] randomized totals: ${total} compared, strictMatches=${stats.strictMatches}, approvedMin6Deltas=${stats.approvedDeltas}, unexpectedMismatches=${stats.unexpectedMismatches}`);
  });
});
