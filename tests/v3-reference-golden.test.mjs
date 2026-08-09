// V3.0 Phase 1/2 -- curated golden-case regression suite (Phase 1 Section
// 12-14, Phase 2 Section 19). See tests/fixtures/v3-reference-goldens.json
// for the checked-in scenarios (UNCHANGED since Phase 1 -- this task's
// Section 19: "Do NOT regenerate all Phase 1 golden outputs. They
// represent historical V2.x behavior.") and
// tests/tools/generate-v3-reference-goldens.mjs for how they were
// produced.
//
// This file ONLY READS the checked-in fixture -- it never regenerates or
// rewrites it (Phase 1 Section 13: "Normal [test runs] must only READ and
// VERIFY the checked-in goldens. Never auto-update expected values during
// tests."). Every scenario is asserted TWICE:
//
//   1. against the FROZEN reference engine (tests/reference/v2-exhaustive/)
//      -- this is the reference's own regression guard: if a future
//      accidental edit to the frozen reference changes its behavior, this
//      catches it immediately, independent of production. Always STRICT
//      equality -- the reference is frozen, so it must always reproduce
//      the golden exactly, with no delta ever applying here.
//   2. against the CURRENT PRODUCTION engine (js/pages/calculate/) -- an
//      extra, human-curated differential layer alongside
//      tests/v3-differential.test.mjs's randomized cases. Phase 2 changed
//      production's generation-time feasibility, so this comparison now
//      goes through the SAME tests/reference/assert-recommendation-
//      equivalent.mjs APPROVED_DELTAS.MIN_LOADING_POINT_6 classifier the
//      randomized suite uses (not a second, possibly-diverging notion of
//      "acceptable difference") -- most goldens still require byte-for-
//      byte equality; a handful (whichever golden's own STORED winning
//      candidate already contains a 1-5 DT active source, e.g.
//      legacy_1_5_dt_allocation/same_contractor_relocation/tie_break_scenario)
//      are expected to now diverge for the approved reason, and are
//      asserted as such explicitly, not silently skipped.
//
// If EITHER assertion ever fails for any OTHER reason, do not "fix" it by
// editing this file's expectations by hand -- re-run
// tests/tools/generate-v3-reference-goldens.mjs --write against the
// (still frozen, until an explicit oracle update is approved) reference
// engine instead, per that tool's own header comment.

import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { findBlendRecommendations } from '../js/pages/calculate/blending-recommendation.js';
import { findBlendRecommendationsReference } from './reference/v2-exhaustive/blending-recommendation-reference.mjs';
import { canonicalizeRecommendationResult, firstCanonicalDifference } from './reference/canonical-recommendation-result.mjs';
import { APPROVED_DELTAS } from './reference/assert-recommendation-equivalent.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURE_PATH = path.join(ROOT, 'tests', 'fixtures', 'v3-reference-goldens.json');
const fixture = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8'));

describe('V3.0 Phase 1 golden fixture provenance', () => {
  test('fixture records how it was generated and which reference produced it', () => {
    assert.equal(fixture.generatedBy, 'tests/tools/generate-v3-reference-goldens.mjs');
    assert.equal(fixture.generatedFromReference, 'tests/reference/v2-exhaustive/blending-recommendation-reference.mjs');
    assert.ok(Array.isArray(fixture.scenarios) && fixture.scenarios.length > 0);
  });
});

// Phase 2 Section 18/28-style visibility counters for the golden suite's
// own production-vs-golden comparison (separate from
// tests/v3-differential.test.mjs's randomized-suite counters).
const goldenStats = { strictMatches: 0, approvedDeltas: 0, unexpectedMismatches: 0 };

describe('V3.0 Phase 1/2 curated golden cases (Phase 1 Section 12, Phase 2 Section 19)', () => {
  fixture.scenarios.forEach((scenario) => {
    describe(scenario.name, () => {
      test(`${scenario.description}`, () => {
        assert.ok(scenario.input && scenario.expected, `${scenario.name} must carry both input and expected`);
      });

      test('frozen reference engine reproduces the checked-in expected result exactly (always strict -- the reference never moves)', () => {
        const referenceResult = findBlendRecommendationsReference(scenario.input);
        const referenceCanonical = canonicalizeRecommendationResult(referenceResult);
        const difference = firstCanonicalDifference(scenario.expected, referenceCanonical);
        assert.equal(difference, null, `reference drifted from golden ${scenario.name}: ${difference}`);
      });

      test('current production engine matches the golden strictly, or diverges ONLY under the approved MIN_LOADING_POINT_6 delta', () => {
        const productionResult = findBlendRecommendations(scenario.input);
        const productionCanonical = canonicalizeRecommendationResult(productionResult);
        const strictDifference = firstCanonicalDifference(scenario.expected, productionCanonical);

        if (strictDifference === null) {
          goldenStats.strictMatches += 1;
          return;
        }

        const outcome = APPROVED_DELTAS.MIN_LOADING_POINT_6(scenario.expected, productionCanonical);
        if (outcome.resolved) {
          if (outcome.tier === 'metadata-only') goldenStats.strictMatches += 1;
          else goldenStats.approvedDeltas += 1;
          return;
        }

        goldenStats.unexpectedMismatches += 1;
        assert.fail(`production diverged from golden ${scenario.name} for an UNAPPROVED reason: ${outcome.diagnostic}\nSTRICT DIFFERENCE: ${strictDifference}`);
      });
    });
  });

  after(() => {
    const total = goldenStats.strictMatches + goldenStats.approvedDeltas + goldenStats.unexpectedMismatches;
    // eslint-disable-next-line no-console
    console.log(`[v3-reference-golden] production-vs-golden totals: ${total} scenarios, strictMatches=${goldenStats.strictMatches}, approvedMin6Deltas=${goldenStats.approvedDeltas}, unexpectedMismatches=${goldenStats.unexpectedMismatches}`);
  });
});

describe('V3.0 Phase 1 dedicated source-order independence check (this task\'s Section 12 item 14 / Section 22)', () => {
  test('multiple_contractors and source_order_independence carry the same sources in reversed order, and produce the identical canonical candidate', () => {
    const original = fixture.scenarios.find((s) => s.name === 'multiple_contractors');
    const reordered = fixture.scenarios.find((s) => s.name === 'source_order_independence');
    assert.ok(original && reordered, 'both scenarios must exist in the fixture');

    const originalPileIds = original.input.sources.map((s) => `${s.contractor}/${s.pileId}`).sort();
    const reorderedPileIds = reordered.input.sources.map((s) => `${s.contractor}/${s.pileId}`).sort();
    assert.deepEqual(originalPileIds, reorderedPileIds, 'both scenarios must describe the same set of sources');

    const difference = firstCanonicalDifference(original.expected.candidate, reordered.expected.candidate);
    assert.equal(difference, null, `source order changed the winning candidate: ${difference}`);
  });
});

describe('V3.0 Phase 1 legacy 1-5 DT edge case is preserved, not "fixed" (this task\'s Section 9/22)', () => {
  test('legacy_1_5_dt_allocation golden still selects an active loading point below the 6-DT threshold', () => {
    const scenario = fixture.scenarios.find((s) => s.name === 'legacy_1_5_dt_allocation');
    assert.ok(scenario, 'legacy_1_5_dt_allocation golden must exist');
    assert.equal(scenario.expected.ok, true);
    assert.equal(scenario.expected.status, 'OK');
    const activeUnitsValues = scenario.expected.candidate.sources.map((s) => s.activeUnits).filter((v) => v > 0);
    assert.ok(activeUnitsValues.every((v) => v >= 1 && v <= 5), 'every active source must sit inside the legacy 1-5 DT band');
  });
});
