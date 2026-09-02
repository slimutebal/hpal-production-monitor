// V3.0 Phase 6C -- Source-Level Variable + Value Ordering PROTOTYPE (docs/
// V3.0_SCALABLE_RECOMMENDATION_ENGINE_ARCHITECTURE.md Section 23; this
// task's "test whether deterministic search ordering can make the existing
// exact bounds useful much earlier").
//
// Exercises findBlendRecommendationsSourceLazyOrdered() (Phase 6C addition
// to js/pages/calculate/blending-recommendation-source-lazy.js) --
// NOT production, not imported by any production file.
// findBlendRecommendationsSourceLazy() (Phase 6B, unchanged) remains the
// canonical baseline this file diffs against.
//
// SEARCH ORDER ONLY (this task's own instruction): every strategy below
// only changes WHICH already-valid branch is visited first, never whether
// it is valid/visited. Group (Contractor) visitation order stays FIXED at
// Phase 6B's own computeContractorSearchOrder() choice for every strategy
// -- this file isolates WITHIN-group source order + per-source value order.
//
// PART 1 -- EXACTNESS: a representative sample of source/value strategy
// PAIRS (not the full cross-product -- that would just repeat the same
// proof N times) run through the SAME randomized small scenarios as Phase
// 6B, each diffed against real production. Any mismatch is Phase-blocking.
//
// PART 2 -- C/D STRATEGY BENCHMARK: full 6 (source) x 3 (value) = 18
// combinations x {C, D} = 36 runs, reporting the PRIMARY metric this task
// asks for (does it complete below 500,000 source-level nodes?) plus the
// secondary diagnostics. Run once, honestly, in this one file -- not
// repeated per strategy across the full suite.
//
// PART 3 -- REGRESSION: A/B/E via findBlendRecommendationsSourceLazyOrdered()
// with the canonical/descending defaults (byte-identical to Phase 6B by
// construction -- see the production-file-side comment on those defaults).
//
// Run with Node's built-in test runner:
//
//   node --test tests/v3-phase6c-source-value-ordering.test.mjs
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  findBlendRecommendationsSourceLazy,
  findBlendRecommendationsSourceLazyOrdered,
} from '../js/pages/calculate/blending-recommendation-source-lazy.js';
import {
  findBlendRecommendationsWithDiagnostics,
  MAX_SEARCH_NODES,
} from '../js/pages/calculate/blending-recommendation.js';
import { MAX_ALLOCATIONS_PER_CONTRACTOR } from '../js/pages/calculate/fleet-allocation.js';
import { canonicalizeRecommendationResult, firstCanonicalDifference } from './reference/canonical-recommendation-result.mjs';
import { generateScenario } from './reference/v3-scenario-generator.mjs';
import { mulberry32 } from './reference/seeded-random.mjs';

function statusOf(result) {
  return result.ok ? result.status : result.error;
}

// ============================================================
// PART 1 -- EXACTNESS (this task's Section 5)
// ============================================================
describe('V3.0 Phase 6C -- exactness: ordered lazy vs production (randomized small scenarios)', () => {
  const SEEDS = [1, 2, 3];
  const CASES_PER_SEED = 40;
  const REPRESENTATIVE_PAIRS = [
    { sourceStrategy: 'canonical', valueStrategy: 'descending' }, // must equal Phase 6B exactly
    { sourceStrategy: 'ni-distance-first', valueStrategy: 'ascending' },
    { sourceStrategy: 'chemistry-leverage-first', valueStrategy: 'chem-directed' },
    { sourceStrategy: 'most-constrained-first', valueStrategy: 'descending' },
    { sourceStrategy: 'hybrid', valueStrategy: 'ascending' },
  ];

  REPRESENTATIVE_PAIRS.forEach(({ sourceStrategy, valueStrategy }) => {
    SEEDS.forEach((seed) => {
      test(`src=${sourceStrategy} val=${valueStrategy}, seed ${seed}: ${CASES_PER_SEED} scenarios, byte-identical to production`, () => {
        const rng = mulberry32(seed);
        let compared = 0;
        for (let i = 0; i < CASES_PER_SEED; i += 1) {
          const scenario = generateScenario(rng, i);
          const production = findBlendRecommendationsWithDiagnostics(scenario.input);
          if (!production.result.ok && production.result.error === 'SEARCH_SPACE_TOO_LARGE') continue;

          const ordered = findBlendRecommendationsSourceLazyOrdered(scenario.input, { sourceStrategy, valueStrategy });
          compared += 1;
          const diff = firstCanonicalDifference(
            canonicalizeRecommendationResult(production.result),
            canonicalizeRecommendationResult(ordered.result),
          );
          assert.equal(diff, null, `src=${sourceStrategy} val=${valueStrategy} seed ${seed} case ${i} (${scenario.name}): diverged from production: ${diff}`);
        }
        assert.ok(compared > 0, `seed ${seed}: expected at least one comparable scenario`);
      });
    });
  });

  test('sanity: canonical/descending defaults reproduce Phase 6B EXACTLY on a moderate scenario', () => {
    const sources = [];
    [2, 2, 2, 1, 1].forEach((domeCount, c) => {
      for (let s = 0; s < domeCount; s += 1) {
        sources.push({ pileId: `C${c}-S${s}`, contractor: `Contractor${c}`, ni: s % 2 === 0 ? '1.30' : '1.00', units: '10', tonnesPerUnit: '50' });
      }
    });
    const input = { targetNi: '1.15', tolerance: '0.05', sources };
    const phase6b = findBlendRecommendationsSourceLazy(input);
    const phase6cDefault = findBlendRecommendationsSourceLazyOrdered(input);
    assert.deepEqual(phase6cDefault.diagnostics, phase6b.diagnostics, 'default strategy diagnostics must be IDENTICAL to Phase 6B (not just the same winner) -- proves the refactor changed nothing behaviorally');
    const diff = firstCanonicalDifference(canonicalizeRecommendationResult(phase6b.result), canonicalizeRecommendationResult(phase6cDefault.result));
    assert.equal(diff, null, `default ordered strategy diverged from Phase 6B baseline: ${diff}`);
  });
});

// ============================================================
// PART 2 -- C/D STRATEGY BENCHMARK (this task's Section 3)
// ============================================================
function buildScenarioSources(domesPerContractor, dtPerDome, niHigh = '1.30', niLow = '1.00') {
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

const TARGET_NI = '1.15';
const TOLERANCE = '0.05';
const SCENARIOS = {
  A: buildScenarioSources([2, 2, 2, 1, 1], 10),
  B: buildScenarioSources([2, 2, 2, 1, 1, 1, 1], 10),
  C: buildScenarioSources([2, 2, 2, 2, 2], 10),
  D: buildScenarioSources([4, 3, 3], 10),
  E: buildScenarioSources([5, 5], 10),
};

const SOURCE_STRATEGIES = ['canonical', 'tonnage-influence-first', 'ni-distance-first', 'chemistry-leverage-first', 'most-constrained-first', 'hybrid'];
const VALUE_STRATEGIES = ['descending', 'ascending', 'chem-directed'];

describe('V3.0 Phase 6C -- C/D strategy benchmark (18 combinations x 2 scenarios, primary metric: completes below 500,000 nodes?)', () => {
  test('sanity: node budget unchanged', () => {
    assert.equal(MAX_SEARCH_NODES, 500000);
  });

  ['C', 'D'].forEach((name) => {
    test(`Scenario ${name}: benchmark all 18 source/value combinations`, () => {
      const input = { targetNi: TARGET_NI, tolerance: TOLERANCE, sources: SCENARIOS[name] };
      let anyCompleted = false;

      SOURCE_STRATEGIES.forEach((sourceStrategy) => {
        VALUE_STRATEGIES.forEach((valueStrategy) => {
          const start = process.hrtime.bigint();
          const { result, diagnostics } = findBlendRecommendationsSourceLazyOrdered(input, { sourceStrategy, valueStrategy });
          const ms = Number(process.hrtime.bigint() - start) / 1e6;
          const status = statusOf(result);
          if (status !== 'SEARCH_INCOMPLETE') anyCompleted = true;

          // eslint-disable-next-line no-console
          console.log([
            `[v3-phase6c] ${name}`,
            `src=${sourceStrategy.padEnd(24)}`,
            `val=${valueStrategy.padEnd(14)}`,
            `status=${status.padEnd(18)}`,
            `visited=${String(diagnostics ? diagnostics.visitedNodes : 'n/a').padStart(7)}`,
            `completed=${String(diagnostics ? diagnostics.completedCandidates : 'n/a').padStart(7)}`,
            `prunedChem=${String(diagnostics ? diagnostics.prunedByChemistry : 'n/a').padStart(7)}`,
            `prunedRank=${String(diagnostics ? diagnostics.prunedByRanking : 'n/a').padStart(7)}`,
            `firstIncumbent=${String(diagnostics ? diagnostics.firstIncumbentNode : 'n/a').padStart(7)}`,
            `ms=${ms.toFixed(0)}`,
          ].join(' '));

          // Node budget must never be exceeded regardless of strategy (this
          // task's "keep exactly 500,000... do not raise it").
          if (diagnostics) assert.ok(diagnostics.visitedNodes <= MAX_SEARCH_NODES, `${name} src=${sourceStrategy} val=${valueStrategy}: exceeded node budget`);
        });
      });

      // eslint-disable-next-line no-console
      console.log(`[v3-phase6c] HONEST RESULT ${name}: ${anyCompleted ? 'AT LEAST ONE combination completed below 500,000 nodes' : 'NO combination (0/18) completed below 500,000 nodes -- ordering alone does not close this gap'}`);
    });
  });
});

// ============================================================
// PART 3 -- REGRESSION (this task's Section 4) -- canonical/descending
// defaults, which must remain exact and OK for A/B, and must let E begin
// traversal without the eager 20k gate.
// ============================================================
describe('V3.0 Phase 6C -- A/B/E regression (canonical/descending defaults)', () => {
  test('sanity: per-Contractor gate constant unchanged', () => {
    assert.equal(MAX_ALLOCATIONS_PER_CONTRACTOR, 20000);
  });

  test('A. 8 dome / 5 Contractor / 80 DT -- exact and OK', () => {
    const input = { targetNi: TARGET_NI, tolerance: TOLERANCE, sources: SCENARIOS.A };
    const production = findBlendRecommendationsWithDiagnostics(input);
    const ordered = findBlendRecommendationsSourceLazyOrdered(input);
    assert.equal(production.result.ok, true);
    assert.equal(production.result.status, 'OK');
    const diff = firstCanonicalDifference(canonicalizeRecommendationResult(production.result), canonicalizeRecommendationResult(ordered.result));
    assert.equal(diff, null, `A: diverged from production: ${diff}`);
  });

  test('B. 10 dome / 7 Contractor / 100 DT balanced -- exact and OK', () => {
    const input = { targetNi: TARGET_NI, tolerance: TOLERANCE, sources: SCENARIOS.B };
    const production = findBlendRecommendationsWithDiagnostics(input);
    const ordered = findBlendRecommendationsSourceLazyOrdered(input);
    assert.equal(production.result.ok, true);
    assert.equal(production.result.status, 'OK');
    const diff = firstCanonicalDifference(canonicalizeRecommendationResult(production.result), canonicalizeRecommendationResult(ordered.result));
    assert.equal(diff, null, `B: diverged from production: ${diff}`);
  });

  test('E. 10 dome / 2 Contractor / 100 DT concentrated -- still begins traversal without eager 20k gate', () => {
    const input = { targetNi: TARGET_NI, tolerance: TOLERANCE, sources: SCENARIOS.E };
    const production = findBlendRecommendationsWithDiagnostics(input);
    const ordered = findBlendRecommendationsSourceLazyOrdered(input);
    assert.equal(production.result.ok, false);
    assert.equal(production.result.error, 'SEARCH_SPACE_TOO_LARGE');
    assert.notEqual(ordered.result.error, 'SEARCH_SPACE_TOO_LARGE', 'ordered prototype must not apply the eager 20k per-Contractor gate');
    assert.ok(ordered.diagnostics, 'ordered prototype must have actually traversed (diagnostics present)');
  });
});
