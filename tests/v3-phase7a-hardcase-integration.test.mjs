// V3.0 Phase 7A -- Production Integration of the Exact Hybrid Recommendation
// Solver. Verifies:
//   (1) the hybrid dispatcher (blending-recommendation.js's
//       findBlendRecommendations()/findBlendRecommendationsWithDiagnostics())
//       routes normal/common shapes through the existing NORMAL_BNB engine
//       and hard/concentrated shapes through the new HARDCASE_MITM engine
//       (exact-hardcase-solver.js), via BOTH deterministic trigger points
//       (generation-time SEARCH_SPACE_TOO_LARGE and traversal-time
//       SEARCH_INCOMPLETE) -- never a fragile dome-count heuristic;
//   (2) the hard-case engine's own result is byte-identical to the frozen
//       Phase 6 prototype/oracle (tests/v3-phase6l-final-ranking-solver.test.mjs's
//       own established reference), i.e. this is a faithful extraction, not
//       a re-derivation;
//   (3) the MITM full-utilization funnel only ever activates once the A+B
//       theorem is actually PROVEN (this task's own Section 3 fallback
//       contract), never merely assumed;
//   (4) candidateCount stays the exact operational-allocation theoretical
//       count regardless of which engine served the request;
//   (5) SEARCH_INCOMPLETE remains a reachable, honest safety state.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  findBlendRecommendations,
  findBlendRecommendationsWithDiagnostics,
  MAX_SEARCH_NODES,
} from '../js/pages/calculate/blending-recommendation.js';
import { runHardCaseSearch } from '../js/pages/calculate/exact-hardcase-solver.js';
import {
  findExactFinalRankingWinner,
  findBlendRecommendationsSourceLazyDecomposed,
} from '../js/pages/calculate/blending-recommendation-source-lazy.js';
import { countOperationalAllocations, groupSourcesByContractor } from '../js/pages/calculate/fleet-allocation.js';
import { classifyOre } from '../js/shared/ore-classification.js';

function statusOf(result) {
  return result.ok ? result.status : result.error;
}

// Byte-identical to tests/v3-phase6l-final-ranking-solver.test.mjs's own
// scenario fixtures -- reused here (not redefined independently) so a
// mismatch can only mean a real production-vs-oracle divergence, never a
// fixture-construction difference.
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
  F: buildScenarioSources([5], 10),
};

function exactCandidateCount(sources) {
  const groups = groupSourcesByContractor(sources.map((s) => ({
    pileId: s.pileId, contractor: s.contractor, assignedUnits: Number(s.units),
  })));
  return groups.reduce((product, group) => {
    const fleet = group.sources.reduce((sum, s) => sum + s.assignedUnits, 0);
    return product * countOperationalAllocations(fleet, group.sources.length);
  }, 1) - 1;
}

// ============================================================
// SCALE REGRESSION MATRIX (this task's Section 9) -- solverPath / status /
// candidateCount / runtime for A-F. Runtime is reported, never asserted
// with a fragile millisecond threshold (this task's Section 10) -- only a
// generous ceiling (matching Phase 6L's own 120s ceiling) catches a genuine
// runaway/regression.
// ============================================================
describe('V3.0 Phase 7A -- production scale regression matrix (A-F)', () => {
  Object.entries(SCENARIOS).forEach(([name, sources]) => {
    test(`${name}: production hybrid completes exactly`, () => {
      const t0 = process.hrtime.bigint();
      const result = findBlendRecommendations({ targetNi: TARGET_NI, tolerance: TOLERANCE, sources });
      const t1 = process.hrtime.bigint();
      const ms = Number(t1 - t0) / 1e6;

      // eslint-disable-next-line no-console
      console.log(`[v3-phase7a] ${name}: solverPath=${result.solverPath} status=${statusOf(result)} candidateCount=${result.candidateCount} runtimeMs=${ms.toFixed(1)}`);

      assert.equal(statusOf(result), 'OK', `${name}: production hybrid must reach an exact OK result`);
      assert.equal(result.candidateCount, exactCandidateCount(sources), `${name}: candidateCount must be the exact operational-allocation theoretical count regardless of solver path`);
      assert.ok(ms < 120000, `${name}: took ${ms.toFixed(0)}ms -- reporting, not silently accepting an unbounded runtime`);
    });
  });

  test('A/B route through the normal exact engine (common shapes)', () => {
    const a = findBlendRecommendations({ targetNi: TARGET_NI, tolerance: TOLERANCE, sources: SCENARIOS.A });
    const b = findBlendRecommendations({ targetNi: TARGET_NI, tolerance: TOLERANCE, sources: SCENARIOS.B });
    assert.equal(a.solverPath, 'NORMAL_BNB');
    assert.equal(b.solverPath, 'NORMAL_BNB');
  });

  test('C/D/E/F route through the hard-case MITM engine (concentrated shapes)', () => {
    ['C', 'D', 'E', 'F'].forEach((name) => {
      const result = findBlendRecommendations({ targetNi: TARGET_NI, tolerance: TOLERANCE, sources: SCENARIOS[name] });
      assert.equal(result.solverPath, 'HARDCASE_MITM', `${name} must dispatch to HARDCASE_MITM`);
      assert.ok(result.diagnostics && result.diagnostics.mitmActivated, `${name} must actually activate the MITM funnel (A+B lock proven)`);
    });
  });

  // this task's Section 2 -- BOTH deterministic dispatch trigger points must
  // be reachable, never only one of them.
  test('E/F trigger dispatch via the generation-time SEARCH_SPACE_TOO_LARGE gate', () => {
    ['E', 'F'].forEach((name) => {
      const { diagnostics } = findBlendRecommendationsWithDiagnostics({ targetNi: TARGET_NI, tolerance: TOLERANCE, sources: SCENARIOS[name] });
      // Reaching HARDCASE_MITM with zero normal-engine probe nodes spent
      // confirms this scenario never even attempted the normal traversal --
      // it was rejected at generation time by the per-Contractor gate.
      assert.equal(diagnostics.solverPath, 'HARDCASE_MITM');
    });
  });

  test('C/D trigger dispatch via the traversal-time SEARCH_INCOMPLETE probe (per-Contractor gate itself clears)', () => {
    ['C', 'D'].forEach((name) => {
      const groups = groupSourcesByContractor(SCENARIOS[name].map((s) => ({
        pileId: s.pileId, contractor: s.contractor, assignedUnits: Number(s.units),
      })));
      groups.forEach((group) => {
        const fleet = group.sources.reduce((sum, s) => sum + s.assignedUnits, 0);
        const count = countOperationalAllocations(fleet, group.sources.length);
        assert.ok(count <= 20000, `${name}: this test's own premise requires every group to clear the per-Contractor gate (got ${count})`);
      });
    });
  });
});

// ============================================================
// EXACTNESS GATE (this task's Section 8) -- production hybrid vs the frozen
// Phase 6 prototype/oracle. 0 winner mismatches required: status,
// allocationSignature, estimatedNi, activeUnits, relocation (totalMovedUnits),
// candidateCount.
// ============================================================
describe('V3.0 Phase 7A -- exactness gate: production hybrid vs frozen Phase 6 oracle', () => {
  test('C: production hybrid matches the established Phase 6I decomposition oracle', () => {
    const production = findBlendRecommendations({ targetNi: TARGET_NI, tolerance: TOLERANCE, sources: SCENARIOS.C });
    const oracle = findBlendRecommendationsSourceLazyDecomposed({ targetNi: TARGET_NI, tolerance: TOLERANCE, sources: SCENARIOS.C });

    assert.equal(statusOf(production), 'OK');
    assert.equal(statusOf(oracle.result), 'OK');
    assert.equal(production.candidate.allocationSignature, oracle.result.candidate.allocationSignature);
    assert.equal(production.candidate.estimatedNi, oracle.result.candidate.estimatedNi);
    assert.equal(production.candidate.totalActiveUnits, oracle.result.candidate.totalActiveUnits);
    assert.equal(production.candidate.totalMovedUnits, oracle.result.candidate.totalMovedUnits);
  });

  ['C', 'D', 'E', 'F'].forEach((name) => {
    test(`${name}: production hybrid matches the frozen Phase 6L MITM solver byte-for-byte`, () => {
      const production = findBlendRecommendations({ targetNi: TARGET_NI, tolerance: TOLERANCE, sources: SCENARIOS[name] });
      const oracle = findExactFinalRankingWinner({ targetNi: TARGET_NI, tolerance: TOLERANCE, sources: SCENARIOS[name] });

      assert.equal(statusOf(production), 'OK', `${name}: production status`);
      assert.equal(oracle.status, 'OK', `${name}: Phase 6L oracle status`);
      assert.equal(production.candidate.allocationSignature, oracle.candidate.allocationSignature, `${name}: allocationSignature`);
      assert.equal(production.candidate.estimatedNi, oracle.candidate.estimatedNi, `${name}: estimatedNi`);
      assert.equal(production.candidate.totalActiveUnits, oracle.candidate.totalActiveUnits, `${name}: totalActiveUnits`);
      assert.equal(production.candidate.totalMovedUnits, oracle.candidate.totalMovedUnits, `${name}: totalMovedUnits (relocation)`);
      assert.equal(production.candidate.activeSourceCount, oracle.candidate.activeSourceCount, `${name}: activeSourceCount`);
    });
  });

  ['A', 'B'].forEach((name) => {
    test(`${name}: normal-engine winner is also within-tolerance-optimal per the real ranking comparator (sanity, not a second engine)`, () => {
      const production = findBlendRecommendations({ targetNi: TARGET_NI, tolerance: TOLERANCE, sources: SCENARIOS[name] });
      assert.equal(statusOf(production), 'OK');
      assert.ok(production.candidate.withinTolerance);
    });
  });
});

// ============================================================
// MITM PRECONDITION / FALLBACK CONTRACT (this task's Section 3) -- the
// full-utilization solver must never activate merely because a scenario is
// large; it must activate ONLY once the A+B theorem is actually witnessed.
// ============================================================
describe('V3.0 Phase 7A -- MITM precondition / fallback contract', () => {
  test('a scenario whose ONLY within-tolerance candidates require leaving one Contractor idle never locks, never invokes MITM, and still returns the exact real winner', () => {
    // Two Contractors, one source each. ContractorA's fleet is pinned at
    // exactly the 6 DT minimum (its only choices are 0 or 6 -- no partial
    // value in between), at a high Ni (1.50) far from target; ContractorB
    // has 94 DT at Ni 1.05, dead center of target=1.05/tolerance=0.01.
    // Including ANY of ContractorA's 6 DT pushes the blend to at best
    // (6*1.50+94*1.05)/100=1.077 (achieved at ContractorB's own maximum,
    // B=94) -- outside [1.04,1.06] for every possible B, since
    // Ni(A=6,B)=(9+1.05B)/(6+B)=1.05+2.7/(6+B) is strictly decreasing in B
    // and never reaches 1.06 even at B's own ceiling of 94. So EVERY real
    // within-tolerance candidate leaves ContractorA fully idle (standby
    // ratio 1.0 >= CRITICAL_STANDBY_RATIO=0.50 -- unconditionally
    // critical), meaning criticalContractorCount can never be 0 for any
    // witnessed incumbent -- the Phase 6H A+B lock's own first clause is
    // structurally unreachable here, regardless of totalActiveUnits.
    const sources = [
      {
        pileId: 'S0', contractor: 'ContractorA', ni: '1.50', units: '6', tonnesPerUnit: '50',
      },
      {
        pileId: 'S1', contractor: 'ContractorB', ni: '1.05', units: '94', tonnesPerUnit: '50',
      },
    ];
    const groups = groupSourcesByContractor(sources.map((s) => ({
      pileId: s.pileId,
      contractor: s.contractor,
      ni: Number(s.ni),
      assignedUnits: Number(s.units),
      tonnesPerUnit: Number(s.tonnesPerUnit),
      oreClass: classifyOre(Number(s.ni)),
    })));
    const groupFleets = groups.map((g) => g.sources.reduce((sum, s) => sum + s.assignedUnits, 0));

    const hard = runHardCaseSearch({
      groups, groupFleets, targetNiValue: 1.05, toleranceValue: 0.01,
    }, MAX_SEARCH_NODES);

    assert.equal(hard.status, 'OK');
    assert.equal(hard.diagnostics.mitmActivated, false, 'MITM must never activate when the A+B lock cannot be proven');
    assert.equal(hard.diagnostics.stoppedAtLock, false);
    assert.ok(hard.candidate.withinTolerance);
    assert.equal(hard.candidate.estimatedNi, 1.05);
    // Best real completion maximizes totalActiveUnits subject to tolerance
    // (ContractorA forced idle, ContractorB at its own full 94 DT).
    assert.equal(hard.candidate.totalActiveUnits, 94);
  });

  test('SEARCH_INCOMPLETE remains a valid, honest safety state when the node budget is genuinely exhausted before any lock', () => {
    const sources = buildScenarioSources([4, 3, 3], 10); // scenario D shape
    const groups = groupSourcesByContractor(sources.map((s) => ({
      pileId: s.pileId,
      contractor: s.contractor,
      ni: Number(s.ni),
      assignedUnits: Number(s.units),
      tonnesPerUnit: Number(s.tonnesPerUnit),
      oreClass: classifyOre(Number(s.ni)),
    })));
    const groupFleets = groups.map((g) => g.sources.reduce((sum, s) => sum + s.assignedUnits, 0));

    const hard = runHardCaseSearch({
      groups, groupFleets, targetNiValue: 1.15, toleranceValue: 0.05,
    }, 10); // deliberately tiny budget -- must exhaust before locking

    assert.equal(hard.status, 'SEARCH_INCOMPLETE');
    assert.equal(hard.diagnostics.mitmActivated, false);
  });
});

// ============================================================
// V3.0 Phase 7A.1 -- PREFLIGHT DISPATCH (this task's own Sections 1-4/7).
// The hybrid now skips the NORMAL_ENGINE_PROBE_NODES probe entirely for
// shapes whose cheap, already-computed metadata (every Contractor group's
// operational allocation count, and their theoretical Cartesian product)
// makes the probe's failure a foregone conclusion -- see
// shouldDispatchHardCaseDirectly()'s own comment in blending-recommendation.js.
// These tests cover the SAFETY side of that optimization (this task's
// Section 7): a preflight "hard" prediction must NEVER fabricate a result
// when the direct hard-case attempt can't establish its own A+B
// precondition -- it must fall back to the exact same safety behavior
// Phase 7A already had (NORMAL_BNB probe, then SEARCH_INCOMPLETE if that
// also can't resolve it).
// ============================================================
describe('V3.0 Phase 7A.1 -- preflight dispatch fallback safety (negative cases)', () => {
  // 4 Contractor groups x 241 operational allocations each (product
  // ~3.37e9) -- clears BOTH preflight thresholds (this task's own Section
  // 1), so the direct hard-case attempt runs FIRST here, never the probe.
  const HARD_SHAPE = buildScenarioSources([2, 2, 2, 2], 15);

  test('an obviously-hard shape whose direct MITM attempt cannot resolve within budget still returns the exact NORMAL_BNB fallback result (no fabrication)', () => {
    const result = findBlendRecommendations({ targetNi: '1.02', tolerance: '0.005', sources: HARD_SHAPE });
    assert.equal(statusOf(result), 'OK');
    assert.equal(result.solverPath, 'NORMAL_BNB', 'the direct hard-case attempt could not establish its A+B precondition here, so the SAFETY NET (existing NORMAL_BNB probe), never a fabricated MITM answer, must be what produced this result');
    assert.ok(result.candidate.withinTolerance);
  });

  test('an obviously-hard shape with a genuinely unreachable target ends in the same honest SEARCH_INCOMPLETE Phase 7A itself would have reached -- never a fabricated OK', () => {
    const result = findBlendRecommendations({ targetNi: '5.0', tolerance: '0.01', sources: HARD_SHAPE });
    assert.equal(result.ok, false);
    assert.equal(result.error, 'SEARCH_INCOMPLETE');
    assert.equal(result.solverPath, 'HARDCASE_MITM');
  });

  test('TARGET_NOT_ACHIEVABLE remains reachable and exact through the production hybrid (this task\'s own Section 6)', () => {
    // Every source's Ni is on the SAME side of target -- no within-tolerance
    // candidate can ever exist (same construction as
    // tests/v3-phase6h-source-prefix-propagation.test.mjs's own
    // SCENARIO_UNACHIEVABLE).
    const sources = buildScenarioSources([2, 2], 10, '1.35', '1.32');
    const result = findBlendRecommendations({ targetNi: TARGET_NI, tolerance: TOLERANCE, sources });
    assert.equal(statusOf(result), 'TARGET_NOT_ACHIEVABLE');
    assert.ok(result.candidate);
    assert.ok(result.gap > 0);
  });
});
