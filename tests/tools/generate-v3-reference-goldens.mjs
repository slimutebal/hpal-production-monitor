// V3.0 Phase 1 -- golden-fixture generator for
// tests/fixtures/v3-reference-goldens.json (this task's Section 13/14).
//
// MANUAL TOOL ONLY. Never imported/run by `node --test tests/*.test.mjs`
// (Node's test runner only picks up files matching that exact glob; this
// file lives outside tests/*.test.mjs by both directory AND filename, so
// there is no way a normal test run can execute it). Run explicitly and
// deliberately:
//
//   node tests/tools/generate-v3-reference-goldens.mjs           (preview only, does NOT write)
//   node tests/tools/generate-v3-reference-goldens.mjs --write   (writes tests/fixtures/v3-reference-goldens.json)
//
// Every "expected" value is computed directly from the FROZEN
// tests/reference/v2-exhaustive/ engine (findBlendRecommendationsReference()),
// never hand-typed -- this task's Section 14: "Do not hand-edit numerical
// outcomes unless required to correct an explicit fixture-generation bug."
// Re-running with --write after any INTENTIONAL, Owner-approved oracle
// change is the only sanctioned way to update the checked-in goldens.
import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { findBlendRecommendationsReference } from '../reference/v2-exhaustive/blending-recommendation-reference.mjs';
import { canonicalizeRecommendationResult } from '../reference/canonical-recommendation-result.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const OUTPUT_PATH = path.join(ROOT, 'tests', 'fixtures', 'v3-reference-goldens.json');

// ============================================================
// CURATED SCENARIOS (this task's Section 12) -- small enough for
// exhaustive reference execution. Each `name` matches this task's
// numbered scenario list in its own comment.
// ============================================================
const SCENARIOS = [
  {
    name: 'single_contractor_single_dome',
    description: '1. Single Contractor, single dome -- trivial baseline.',
    input: {
      targetNi: '1.30',
      tolerance: '0.010',
      sources: [{ pileId: 'L1', contractor: 'CTR-A', ni: '1.30', units: '8', tonnesPerUnit: '50' }],
    },
  },
  {
    name: 'single_contractor_two_domes',
    description: '2. One Contractor, two domes.',
    input: {
      targetNi: '1.25',
      tolerance: '0.050',
      sources: [
        { pileId: 'L1', contractor: 'CTR-A', ni: '1.50', units: '4', tonnesPerUnit: '50' },
        { pileId: 'L2', contractor: 'CTR-A', ni: '1.00', units: '4', tonnesPerUnit: '50' },
      ],
    },
  },
  {
    name: 'multiple_contractors',
    description: '3. Multiple Contractors.',
    input: {
      targetNi: '1.25',
      tolerance: '0.050',
      sources: [
        { pileId: 'L1', contractor: 'CTR-A', ni: '1.50', units: '4', tonnesPerUnit: '50' },
        { pileId: 'L2', contractor: 'CTR-B', ni: '1.00', units: '4', tonnesPerUnit: '50' },
      ],
    },
  },
  {
    name: 'different_tonnes_per_dt',
    description: '4. Different t/DT across sources.',
    input: {
      targetNi: '1.20',
      tolerance: '0.050',
      sources: [
        { pileId: 'L1', contractor: 'CTR-A', ni: '1.50', units: '4', tonnesPerUnit: '30' },
        { pileId: 'L2', contractor: 'CTR-A', ni: '1.00', units: '4', tonnesPerUnit: '70' },
      ],
    },
  },
  {
    name: 'lglo_mglo_blend',
    description: '5. LGLO + MGLO.',
    input: {
      targetNi: '1.20',
      tolerance: '0.050',
      sources: [
        { pileId: 'L1', contractor: 'CTR-A', ni: '1.10', units: '6', tonnesPerUnit: '50' },
        { pileId: 'L2', contractor: 'CTR-A', ni: '1.30', units: '6', tonnesPerUnit: '50' },
      ],
    },
  },
  {
    name: 'lglo_hglo_blend',
    description: '6. LGLO + HGLO.',
    input: {
      targetNi: '1.30',
      tolerance: '0.100',
      sources: [
        { pileId: 'L1', contractor: 'CTR-A', ni: '1.10', units: '6', tonnesPerUnit: '50' },
        { pileId: 'L2', contractor: 'CTR-A', ni: '1.55', units: '6', tonnesPerUnit: '50' },
      ],
    },
  },
  {
    name: 'all_higher_grade',
    description: '7. All higher-grade (MGLO + HGLO, no LGLO).',
    input: {
      targetNi: '1.40',
      tolerance: '0.100',
      sources: [
        { pileId: 'L1', contractor: 'CTR-A', ni: '1.30', units: '6', tonnesPerUnit: '50' },
        { pileId: 'L2', contractor: 'CTR-A', ni: '1.55', units: '6', tonnesPerUnit: '50' },
      ],
    },
  },
  {
    name: 'target_exactly_reached',
    description: '8. Target exactly reached (single fixed-Ni source, zero tolerance).',
    input: {
      targetNi: '1.20',
      tolerance: '0',
      sources: [{ pileId: 'L1', contractor: 'CTR-A', ni: '1.20', units: '10', tonnesPerUnit: '50' }],
    },
  },
  {
    name: 'target_at_tolerance_boundary',
    description: '9. Target at the inclusive tolerance boundary (deviation === tolerance exactly).',
    input: {
      targetNi: '1.20',
      tolerance: '0.010',
      sources: [{ pileId: 'L1', contractor: 'CTR-A', ni: '1.21', units: '10', tonnesPerUnit: '50' }],
    },
  },
  {
    name: 'target_not_achievable',
    description: '10. Target not achievable (single fixed-Ni source, target far outside reach).',
    input: {
      targetNi: '2.00',
      tolerance: '0.010',
      sources: [{ pileId: 'L1', contractor: 'CTR-A', ni: '1.00', units: '5', tonnesPerUnit: '50' }],
    },
  },
  {
    name: 'same_contractor_relocation',
    description: '11. Same-Contractor relocation (DT physically moved from a donor dome to a receiver dome).',
    input: {
      targetNi: '1.45',
      tolerance: '0.050',
      sources: [
        { pileId: 'L1', contractor: 'CTR-A', ni: '1.00', units: '2', tonnesPerUnit: '50' },
        { pileId: 'L2', contractor: 'CTR-A', ni: '1.60', units: '2', tonnesPerUnit: '50' },
      ],
    },
  },
  {
    name: 'source_closure',
    description: '12. Source closure (a dome with assigned fleet ends the winning candidate fully idle, 100% relocated away).',
    input: {
      targetNi: '1.50',
      tolerance: '0.010',
      sources: [
        { pileId: 'L1', contractor: 'CTR-A', ni: '1.00', units: '3', tonnesPerUnit: '50' },
        { pileId: 'L2', contractor: 'CTR-A', ni: '1.50', units: '3', tonnesPerUnit: '50' },
      ],
    },
  },
  {
    name: 'tie_break_scenario',
    description: '13. Symmetric two-Contractor scenario exercising the deterministic allocationSignature tie-break.',
    input: {
      targetNi: '1.50',
      tolerance: '0.500',
      sources: [
        { pileId: 'L1', contractor: 'CTR-A', ni: '1.50', units: '4', tonnesPerUnit: '50' },
        { pileId: 'L1', contractor: 'CTR-B', ni: '1.50', units: '4', tonnesPerUnit: '50' },
      ],
    },
  },
  {
    name: 'source_order_independence',
    description: '14. Same sources/values as multiple_contractors, supplied in REVERSED input order -- must canonically match that scenario\'s candidate (see tests/v3-reference-golden.test.mjs\'s dedicated order-independence assertion).',
    input: {
      targetNi: '1.25',
      tolerance: '0.050',
      sources: [
        { pileId: 'L2', contractor: 'CTR-B', ni: '1.00', units: '4', tonnesPerUnit: '50' },
        { pileId: 'L1', contractor: 'CTR-A', ni: '1.50', units: '4', tonnesPerUnit: '50' },
      ],
    },
  },
  {
    name: 'legacy_1_5_dt_allocation',
    description: '15. Candidate with 1-5 active DT illustrating current legacy behavior (fleet capped at 5, so no allocation can ever reach the 6-DT operational threshold -- this task\'s Section 9/22, must NOT be "fixed" in Phase 1).',
    input: {
      targetNi: '1.00',
      tolerance: '0',
      sources: [{ pileId: 'L1', contractor: 'CTR-A', ni: '1.00', units: '5', tonnesPerUnit: '50' }],
    },
  },
  {
    name: 'minor_contractor_standby',
    description: '16. Minor Contractor standby (<=5%, acceptable, no mitigation search triggered) -- winning candidate leaves CTR-A at a small standbyRatio after a partial same-Contractor relocation.',
    input: {
      targetNi: '1.180',
      tolerance: '0.004',
      sources: [
        { pileId: 'L1', contractor: 'CTR-A', ni: '1.00', units: '20', tonnesPerUnit: '50' },
        { pileId: 'L2', contractor: 'CTR-A', ni: '1.60', units: '4', tonnesPerUnit: '50' },
      ],
    },
  },
  {
    name: 'critical_contractor_standby',
    description: '17. Critical Contractor standby (>=50%, a Contractor-continuity problem, this task\'s Section 3).',
    input: {
      targetNi: '1.55',
      tolerance: '0.020',
      sources: [
        { pileId: 'L1', contractor: 'CTR-A', ni: '1.00', units: '10', tonnesPerUnit: '50' },
        { pileId: 'L2', contractor: 'CTR-B', ni: '1.55', units: '6', tonnesPerUnit: '50' },
      ],
    },
  },
  {
    name: 'decimal_comma_input_equivalence',
    description: '18. Decimal comma input ("1,30" etc.) end-to-end through the full search, not just isolated parseDecimalInput() unit coverage.',
    input: {
      targetNi: '1,30',
      tolerance: '0,010',
      sources: [{ pileId: 'L1', contractor: 'CTR-A', ni: '1,30', units: '8', tonnesPerUnit: '50,0' }],
    },
  },
];

function buildGoldens() {
  return SCENARIOS.map((scenario) => {
    const result = findBlendRecommendationsReference(scenario.input);
    return {
      name: scenario.name,
      description: scenario.description,
      input: scenario.input,
      expected: canonicalizeRecommendationResult(result),
    };
  });
}

function main() {
  const write = process.argv.includes('--write');
  const goldens = buildGoldens();
  const payload = {
    // Provenance (this task's Section 14) -- how to reproduce this file.
    generatedBy: 'tests/tools/generate-v3-reference-goldens.mjs',
    generatedFromReference: 'tests/reference/v2-exhaustive/blending-recommendation-reference.mjs',
    productionHeadAtPhase1Capture: '5011a37',
    scenarios: goldens,
  };
  const json = `${JSON.stringify(payload, null, 2)}\n`;

  console.log(`[generate-v3-reference-goldens] ${goldens.length} scenario(s) computed.`);
  goldens.forEach((g) => {
    console.log(`  - ${g.name}: ok=${g.expected.ok} status=${g.expected.status ?? g.expected.error}`);
  });

  if (!write) {
    const existing = existsSync(OUTPUT_PATH) ? readFileSync(OUTPUT_PATH, 'utf8') : null;
    const changed = existing !== json;
    console.log(`\n[generate-v3-reference-goldens] PREVIEW ONLY -- not written. Pass --write to update ${path.relative(ROOT, OUTPUT_PATH)}.`);
    console.log(`[generate-v3-reference-goldens] Would ${changed ? 'CHANGE' : 'leave unchanged'} the checked-in file.`);
    return;
  }

  writeFileSync(OUTPUT_PATH, json, 'utf8');
  console.log(`\n[generate-v3-reference-goldens] Wrote ${path.relative(ROOT, OUTPUT_PATH)}`);
}

main();
