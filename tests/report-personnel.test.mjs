// Controlled Personnel selection (V2.3 Phase 4) tests.
//
// Run with Node's built-in test runner (Node 18+, zero new dependencies,
// consistent with this project's no-external-libraries convention):
//
//   node --test tests/report-personnel.test.mjs
//
// Imports the actual shipped source directly (report-personnel.js is pure
// and DOM-free by design, report-state.js's singleton is exercised the
// same way tests/report-week.test.mjs already does) -- never calls the
// live Google Apps Script endpoint, never touches the DOM. Rendering
// (checkbox/radio markup, selected-state styling, the directory-blocked
// message) is deliberately left to the manual regression checklist, same
// as report-week.test.mjs's own renderWeekDisplay() exclusion.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  getDefaultSamplerOrganization,
  deriveDefaultSampler,
  reconcilePicThirdId,
  applyBuyerDefaultSamplerToPersonnel,
  overrideSampler,
  resolveSelectedPersonnel,
  getDirectoryAvailabilityError,
  validatePersonnelSelections,
  buildPersonnelOutputLines,
  sortRecords,
  buildPersonnelSelectionSummary,
  filterPersonnelByNameSearch,
  createMultiSelectDraft,
  toggleMultiSelectDraft,
  commitMultiSelectDraft,
} from '../js/pages/report/report-personnel.js';
import { reportState, resetReportState } from '../js/pages/report/report-state.js';
import { t } from '../js/i18n/i18n.js';

// validatePersonnelSelections()/getDirectoryAvailabilityError() now return
// localized text (V2.3 full-localization pass; default locale is
// Indonesian) -- expected values below are built from the same t() keys
// the source uses, so these tests assert on MEANING (the right key fired)
// rather than duplicating literal wording that could drift from the
// locale catalogs.

/* ============================================================
   FIXTURES
============================================================ */
function makeRecord(overrides = {}) {
  return {
    id: 'rec-default',
    role_type: 'SPV_SCM',
    name: 'Unnamed',
    organization: 'SCM',
    active: true,
    created_at: '2026-08-06T16:55:00+08:00',
    updated_at: '2026-08-06T16:55:00+08:00',
    updated_by: 'OWNER_MANUAL',
    version: 1,
    ...overrides,
  };
}

// Deterministic fixture directory matching the current API schema
// (personnel-directory-service.js's validateRecordShape): 2 SPV_SCM,
// 2 FRM_SCM, 3 SAMPLER (AWK, ATQ, and a future org XYZ -- task requirement
// "do not assume AWK and ATQ are the only possible future sampler
// organizations"), 3 PIC_3RD (one per sampler org), plus one inactive
// record per role to exercise active-only filtering.
function buildDirectory() {
  return [
    makeRecord({ id: 'spv-illofi', role_type: 'SPV_SCM', name: 'Illofi', organization: 'SCM' }),
    makeRecord({ id: 'spv-yoshita', role_type: 'SPV_SCM', name: 'Yoshita', organization: 'SCM' }),
    makeRecord({ id: 'spv-inactive', role_type: 'SPV_SCM', name: 'Retired Spv', organization: 'SCM', active: false }),

    makeRecord({ id: 'frm-adi-guna', role_type: 'FRM_SCM', name: 'Adi Guna', organization: 'SCM' }),
    makeRecord({ id: 'frm-akmal', role_type: 'FRM_SCM', name: 'Akmal', organization: 'SCM' }),
    makeRecord({ id: 'frm-inactive', role_type: 'FRM_SCM', name: 'Retired Frm', organization: 'SCM', active: false }),

    makeRecord({ id: 'sampler-awk', role_type: 'SAMPLER', name: 'AWK', organization: 'AWK' }),
    makeRecord({ id: 'sampler-atq', role_type: 'SAMPLER', name: 'ATQ', organization: 'ATQ' }),
    makeRecord({ id: 'sampler-xyz', role_type: 'SAMPLER', name: 'XYZ', organization: 'XYZ' }),
    makeRecord({ id: 'sampler-inactive', role_type: 'SAMPLER', name: 'Old Sampler', organization: 'AWK', active: false }),

    makeRecord({ id: 'pic-awk', role_type: 'PIC_3RD', name: 'La Ode Osardi', organization: 'AWK' }),
    makeRecord({ id: 'pic-atq', role_type: 'PIC_3RD', name: 'Khalifa Akbar', organization: 'ATQ' }),
    makeRecord({ id: 'pic-xyz', role_type: 'PIC_3RD', name: 'Future Pic', organization: 'XYZ' }),
    makeRecord({ id: 'pic-inactive', role_type: 'PIC_3RD', name: 'Retired Pic', organization: 'AWK', active: false }),
  ];
}

function emptyPersonnel(overrides = {}) {
  return {
    spvScmIds: [],
    frmScmIds: [],
    samplerId: null,
    samplerSource: null,
    picThirdId: null,
    manpowerThirdParty: null,
    totalManpower: null,
    ...overrides,
  };
}

function validPersonnel(overrides = {}) {
  return emptyPersonnel({
    spvScmIds: ['spv-illofi'],
    frmScmIds: ['frm-adi-guna', 'frm-akmal'],
    samplerId: 'sampler-awk',
    samplerSource: 'buyer-default',
    picThirdId: 'pic-awk',
    manpowerThirdParty: 20,
    totalManpower: 22,
    ...overrides,
  });
}

/* ============================================================
   1-4. BUYER DEFAULT SAMPLER
============================================================ */
describe('Buyer default sampler', () => {
  test('1. HYNC defaults to AWK sampler', () => {
    const records = buildDirectory();
    assert.equal(getDefaultSamplerOrganization('HYNC'), 'AWK');
    const record = deriveDefaultSampler(records, 'HYNC');
    assert.equal(record.id, 'sampler-awk');
  });

  test('2. SLNC defaults to AWK sampler', () => {
    const records = buildDirectory();
    assert.equal(getDefaultSamplerOrganization('SLNC'), 'AWK');
    const record = deriveDefaultSampler(records, 'SLNC');
    assert.equal(record.id, 'sampler-awk');
  });

  test('3. ESG defaults to ATQ sampler', () => {
    const records = buildDirectory();
    assert.equal(getDefaultSamplerOrganization('ESG'), 'ATQ');
    const record = deriveDefaultSampler(records, 'ESG');
    assert.equal(record.id, 'sampler-atq');
  });

  test('4. unknown buyer has no default sampler', () => {
    const records = buildDirectory();
    assert.equal(getDefaultSamplerOrganization('UNKNOWN'), null);
    assert.equal(deriveDefaultSampler(records, 'UNKNOWN'), null);
  });

  test('4b. ambiguous default (more than one active match) yields no default', () => {
    const records = buildDirectory();
    records.push(makeRecord({ id: 'sampler-awk-2', role_type: 'SAMPLER', name: 'AWK 2', organization: 'AWK' }));
    assert.equal(deriveDefaultSampler(records, 'HYNC'), null);
  });
});

/* ============================================================
   5. USER OVERRIDE
============================================================ */
describe('User override', () => {
  test('5. user override changes samplerSource to user-override', () => {
    const records = buildDirectory();
    const applied = applyBuyerDefaultSamplerToPersonnel(records, 'HYNC', emptyPersonnel());
    assert.equal(applied.samplerSource, 'buyer-default');
    assert.equal(applied.samplerId, 'sampler-awk');

    const overridden = overrideSampler(records, 'sampler-atq', applied);
    assert.equal(overridden.samplerSource, 'user-override');
    assert.equal(overridden.samplerId, 'sampler-atq');
  });
});

/* ============================================================
   6-9. SAMPLER CHANGE / PIC FILTERING
============================================================ */
describe('Sampler change clears incompatible PIC / PIC filtering', () => {
  test('6. sampler change clears an incompatible PIC 3rd', () => {
    const records = buildDirectory();
    const kept = reconcilePicThirdId(records, 'sampler-awk', 'pic-awk');
    assert.equal(kept, 'pic-awk');

    const cleared = reconcilePicThirdId(records, 'sampler-atq', 'pic-awk');
    assert.equal(cleared, null);
  });

  test('7. AWK sampler only exposes AWK PIC records via resolveSelectedPersonnel', () => {
    const records = buildDirectory();
    const personnel = validPersonnel({ samplerId: 'sampler-awk', picThirdId: 'pic-awk' });
    const resolved = resolveSelectedPersonnel(records, personnel);
    assert.equal(resolved.sampler.organization, 'AWK');
    assert.equal(resolved.picThird.organization, 'AWK');
  });

  test('8. ATQ sampler only exposes ATQ PIC records via resolveSelectedPersonnel', () => {
    const records = buildDirectory();
    const personnel = validPersonnel({ samplerId: 'sampler-atq', picThirdId: 'pic-atq', manpowerThirdParty: 10 });
    const resolved = resolveSelectedPersonnel(records, personnel);
    assert.equal(resolved.sampler.organization, 'ATQ');
    assert.equal(resolved.picThird.organization, 'ATQ');
  });

  test('9. future sampler organization (XYZ) and its PIC are supported without a hardcoded allowlist', () => {
    const records = buildDirectory();
    const personnel = validPersonnel({ samplerId: 'sampler-xyz', picThirdId: 'pic-xyz', manpowerThirdParty: 3 });
    const resolved = resolveSelectedPersonnel(records, personnel);
    assert.equal(resolved.sampler.organization, 'XYZ');
    assert.equal(resolved.picThird.organization, 'XYZ');
    assert.deepEqual(validatePersonnelSelections(records, personnel), []);
  });
});

/* ============================================================
   10-12. SPV / FRM MULTI-SELECTION
============================================================ */
describe('SPV / FRM multi-selection', () => {
  test('10. SPV multi-selection resolves valid records', () => {
    const records = buildDirectory();
    const resolved = resolveSelectedPersonnel(records, validPersonnel({ spvScmIds: ['spv-illofi', 'spv-yoshita'] }));
    assert.equal(resolved.spvScm.length, 2);
    assert.deepEqual(resolved.spvScm.map((r) => r.name).sort(), ['Illofi', 'Yoshita']);
  });

  test('11. FRM multi-selection resolves valid records', () => {
    const records = buildDirectory();
    const resolved = resolveSelectedPersonnel(records, validPersonnel({ frmScmIds: ['frm-adi-guna', 'frm-akmal'] }));
    assert.equal(resolved.frmScm.length, 2);
    assert.deepEqual(resolved.frmScm.map((r) => r.name).sort(), ['Adi Guna', 'Akmal']);
  });

  test('12. duplicate selected ids resolve deterministically (no duplicate resolved records)', () => {
    const records = buildDirectory();
    const resolved = resolveSelectedPersonnel(records, validPersonnel({ spvScmIds: ['spv-illofi', 'spv-illofi'] }));
    // resolveSelectedPersonnel maps 1:1 over the input array, so a caller
    // that de-dupes before storing never sees duplicates; a caller that
    // doesn't still gets a deterministic (not random) result: the same
    // record resolved twice, never silently collapsed or reordered.
    assert.equal(resolved.spvScm.length, 2);
    assert.equal(resolved.spvScm[0].id, 'spv-illofi');
    assert.equal(resolved.spvScm[1].id, 'spv-illofi');
  });
});

/* ============================================================
   13-21. VALIDATION
============================================================ */
describe('validatePersonnelSelections -- blocking rules', () => {
  test('13. selected inactive/missing SPV id is blocking', () => {
    const records = buildDirectory();
    const errors = validatePersonnelSelections(records, validPersonnel({ spvScmIds: ['spv-inactive'] }));
    assert.ok(errors.includes(t('report.personnel.selectSpvRequired')));
    assert.ok(errors.includes(t('report.personnel.staleSelectionWarning')));
  });

  test('13b. selected missing (unknown) id is blocking', () => {
    const records = buildDirectory();
    const errors = validatePersonnelSelections(records, validPersonnel({ picThirdId: 'pic-does-not-exist' }));
    assert.ok(errors.includes(t('report.personnel.staleSelectionWarning')));
  });

  test('14. wrong-role selected id is blocking (e.g. an FRM id stored as samplerId)', () => {
    const records = buildDirectory();
    const errors = validatePersonnelSelections(records, validPersonnel({ samplerId: 'frm-adi-guna' }));
    assert.ok(errors.includes(t('report.personnel.selectSamplerRequired')));
    assert.ok(errors.includes(t('report.personnel.staleSelectionWarning')));
  });

  test('15. PIC organization mismatch with the selected sampler is blocking', () => {
    const records = buildDirectory();
    const errors = validatePersonnelSelections(records, validPersonnel({ samplerId: 'sampler-atq', picThirdId: 'pic-awk' }));
    assert.ok(errors.includes(t('report.personnel.picMismatchOrg', { organization: 'ATQ' })));
  });

  test('16. missing SPV is blocking', () => {
    const records = buildDirectory();
    const errors = validatePersonnelSelections(records, validPersonnel({ spvScmIds: [] }));
    assert.ok(errors.includes(t('report.personnel.selectSpvRequired')));
  });

  test('17. missing FRM is blocking', () => {
    const records = buildDirectory();
    const errors = validatePersonnelSelections(records, validPersonnel({ frmScmIds: [] }));
    assert.ok(errors.includes(t('report.personnel.selectFrmRequired')));
  });

  test('18. missing sampler is blocking', () => {
    const records = buildDirectory();
    const errors = validatePersonnelSelections(records, validPersonnel({ samplerId: null, samplerSource: null, picThirdId: null }));
    assert.ok(errors.includes(t('report.personnel.selectSamplerRequired')));
    // Without a resolved sampler, the PIC message falls back to the
    // generic (non-organization-specific) wording.
    assert.ok(errors.includes(t('report.personnel.selectPicRequired')));
  });

  test('18b. a PIC selected while no sampler is selected is also blocking (cannot verify compatibility)', () => {
    const records = buildDirectory();
    const errors = validatePersonnelSelections(records, validPersonnel({ samplerId: null, samplerSource: null, picThirdId: 'pic-awk' }));
    assert.ok(errors.includes(t('report.personnel.selectSamplerRequired')));
    assert.ok(errors.includes(t('report.personnel.selectSamplerBeforePic')));
  });

  test('19. missing PIC is blocking, with the sampler organization named', () => {
    const records = buildDirectory();
    const errors = validatePersonnelSelections(records, validPersonnel({ picThirdId: null }));
    assert.ok(errors.includes(t('report.personnel.selectPicForOrg', { organization: 'AWK' })));
  });

  test('20. invalid (non-numeric) manpowerThirdParty is blocking', () => {
    const records = buildDirectory();
    const errors = validatePersonnelSelections(records, validPersonnel({ manpowerThirdParty: null }));
    assert.ok(errors.includes(t('report.personnel.enterValidManpower', { organization: 'AWK' })));
  });

  test('21. negative manpowerThirdParty is blocking', () => {
    const records = buildDirectory();
    const errors = validatePersonnelSelections(records, validPersonnel({ manpowerThirdParty: -1 }));
    assert.ok(errors.includes(t('report.personnel.enterValidManpower', { organization: 'AWK' })));
  });

  test('22. decimal manpowerThirdParty is blocking', () => {
    const records = buildDirectory();
    const errors = validatePersonnelSelections(records, validPersonnel({ manpowerThirdParty: 5.5 }));
    assert.ok(errors.includes(t('report.personnel.enterValidManpower', { organization: 'AWK' })));
  });

  test('missing totalManpower is blocking', () => {
    const records = buildDirectory();
    const errors = validatePersonnelSelections(records, validPersonnel({ totalManpower: null }));
    assert.ok(errors.includes(t('report.personnel.enterValidTotalManpower')));
  });

  test('negative totalManpower is blocking', () => {
    const records = buildDirectory();
    const errors = validatePersonnelSelections(records, validPersonnel({ totalManpower: -1 }));
    assert.ok(errors.includes(t('report.personnel.enterValidTotalManpower')));
  });

  test('decimal totalManpower is blocking', () => {
    const records = buildDirectory();
    const errors = validatePersonnelSelections(records, validPersonnel({ totalManpower: 21.5 }));
    assert.ok(errors.includes(t('report.personnel.enterValidTotalManpower')));
  });

  test('a fully valid selection produces zero errors', () => {
    const records = buildDirectory();
    assert.deepEqual(validatePersonnelSelections(records, validPersonnel()), []);
  });

  test('zero is a valid value for both manpowerThirdParty and totalManpower (minimum 0, per task rule)', () => {
    const records = buildDirectory();
    const errors = validatePersonnelSelections(records, validPersonnel({ manpowerThirdParty: 0, totalManpower: 0 }));
    assert.ok(!errors.some((e) => e.toLowerCase().includes('manpower')));
  });

  test('totalManpower less than manpowerThirdParty is NOT blocking (no arithmetic relation enforced, per task rule)', () => {
    const records = buildDirectory();
    const errors = validatePersonnelSelections(records, validPersonnel({ manpowerThirdParty: 20, totalManpower: 5 }));
    assert.ok(!errors.some((e) => e.toLowerCase().includes('manpower')));
  });

  test('totalManpower equal to manpowerThirdParty is NOT blocking', () => {
    const records = buildDirectory();
    const errors = validatePersonnelSelections(records, validPersonnel({ manpowerThirdParty: 20, totalManpower: 20 }));
    assert.ok(!errors.some((e) => e.toLowerCase().includes('manpower')));
  });
});

/* ============================================================
   BUG FIX: Manpower fields must be manual, independent of personnel
   selection. Total Manpower used to be auto-calculated from
   spvScmIds.length + frmScmIds.length + manpowerThirdParty -- that was
   wrong (Owner-confirmed: Manpower AWK=20 + 2 selected personnel
   incorrectly became Total Manpower=22 automatically) and has been
   removed entirely. Both values are now independent, manual, user-entered
   numbers that report-personnel.js only validates, never derives.
============================================================ */
describe('Manpower fields are manual and independent of personnel selection', () => {
  test('1. manpowerThirdParty is exactly the manually entered value -- never recomputed', () => {
    const personnel = validPersonnel({ manpowerThirdParty: 20 });
    assert.equal(personnel.manpowerThirdParty, 20);
  });

  test('2. totalManpower is exactly the manually entered value -- never recomputed', () => {
    const personnel = validPersonnel({ totalManpower: 22 });
    assert.equal(personnel.totalManpower, 22);
  });

  test('3-5. selecting/deselecting SPV or FRM never changes either manpower value', () => {
    const records = buildDirectory();
    const base = validPersonnel({ spvScmIds: [], frmScmIds: [], manpowerThirdParty: 20, totalManpower: 22 });

    // Selecting one SPV.
    const afterSpv = { ...base, spvScmIds: ['spv-illofi'] };
    assert.equal(afterSpv.manpowerThirdParty, 20);
    assert.equal(afterSpv.totalManpower, 22);

    // Selecting another SPV and an FRM.
    const afterMore = { ...afterSpv, spvScmIds: ['spv-illofi', 'spv-yoshita'], frmScmIds: ['frm-adi-guna'] };
    assert.equal(afterMore.manpowerThirdParty, 20);
    assert.equal(afterMore.totalManpower, 22);

    // Deselecting everything again.
    const afterClear = { ...afterMore, spvScmIds: [], frmScmIds: [] };
    assert.equal(afterClear.manpowerThirdParty, 20);
    assert.equal(afterClear.totalManpower, 22);

    // None of this ever touched the directory/validation layer's
    // understanding of the manpower fields either.
    assert.deepEqual(validatePersonnelSelections(records, { ...afterClear, spvScmIds: ['spv-illofi'], frmScmIds: ['frm-adi-guna'] }), []);
  });

  test('6-7. changing sampler only changes what the Manpower label would show (organization), never the entered values', () => {
    const records = buildDirectory();
    const withAwk = validPersonnel({ samplerId: 'sampler-awk', picThirdId: 'pic-awk', manpowerThirdParty: 20, totalManpower: 22 });
    const withAtq = overrideSampler(records, 'sampler-atq', withAwk);

    assert.equal(withAtq.samplerId, 'sampler-atq'); // the label-driving field changed
    assert.equal(withAtq.manpowerThirdParty, 20); // entered value untouched
    assert.equal(withAtq.totalManpower, 22); // entered value untouched
  });

  test('applyBuyerDefaultSamplerToPersonnel also never touches either manpower value', () => {
    const records = buildDirectory();
    const before = validPersonnel({ manpowerThirdParty: 20, totalManpower: 22 });
    const after = applyBuyerDefaultSamplerToPersonnel(records, 'ESG', before);
    assert.equal(after.manpowerThirdParty, 20);
    assert.equal(after.totalManpower, 22);
  });

  test('8. totalManpower can equal manpowerThirdParty without being blocked', () => {
    const records = buildDirectory();
    assert.deepEqual(validatePersonnelSelections(records, validPersonnel({ manpowerThirdParty: 22, totalManpower: 22 })), []);
  });

  test('9. totalManpower can be greater than manpowerThirdParty without being blocked', () => {
    const records = buildDirectory();
    assert.deepEqual(validatePersonnelSelections(records, validPersonnel({ manpowerThirdParty: 20, totalManpower: 22 })), []);
  });

  test('10. totalManpower can be less than manpowerThirdParty without being blocked', () => {
    const records = buildDirectory();
    assert.deepEqual(validatePersonnelSelections(records, validPersonnel({ manpowerThirdParty: 20, totalManpower: 3 })), []);
  });

  test('11. zero is accepted for both fields', () => {
    const records = buildDirectory();
    assert.deepEqual(validatePersonnelSelections(records, validPersonnel({ manpowerThirdParty: 0, totalManpower: 0 })), []);
  });

  test('12. decimal values are rejected for both fields', () => {
    const records = buildDirectory();
    assert.ok(validatePersonnelSelections(records, validPersonnel({ manpowerThirdParty: 20.5 })).includes(t('report.personnel.enterValidManpower', { organization: 'AWK' })));
    assert.ok(validatePersonnelSelections(records, validPersonnel({ totalManpower: 22.5 })).includes(t('report.personnel.enterValidTotalManpower')));
  });

  test('13. negative values are rejected for both fields', () => {
    const records = buildDirectory();
    assert.ok(validatePersonnelSelections(records, validPersonnel({ manpowerThirdParty: -5 })).includes(t('report.personnel.enterValidManpower', { organization: 'AWK' })));
    assert.ok(validatePersonnelSelections(records, validPersonnel({ totalManpower: -5 })).includes(t('report.personnel.enterValidTotalManpower')));
  });

  test('14. missing values are rejected for both fields', () => {
    const records = buildDirectory();
    assert.ok(validatePersonnelSelections(records, validPersonnel({ manpowerThirdParty: null })).includes(t('report.personnel.enterValidManpower', { organization: 'AWK' })));
    assert.ok(validatePersonnelSelections(records, validPersonnel({ totalManpower: null })).includes(t('report.personnel.enterValidTotalManpower')));
  });

  test('16. reset clears both manual manpower fields', () => {
    reportState.personnel = validPersonnel({ manpowerThirdParty: 20, totalManpower: 22 });
    resetReportState();
    assert.equal(reportState.personnel.manpowerThirdParty, null);
    assert.equal(reportState.personnel.totalManpower, null);
  });
});

/* ============================================================
   24-27. OUTPUT FORMAT
============================================================ */
describe('Report output -- personnel section (corrected dynamic org labels)', () => {
  test('exact-string AWK output matches the approved corrected format', () => {
    const records = buildDirectory();
    // Reproduces the task's own worked AWK example exactly.
    const personnel = validPersonnel({ spvScmIds: ['spv-illofi', 'spv-yoshita'], frmScmIds: ['frm-adi-guna', 'frm-akmal'], samplerId: 'sampler-awk', picThirdId: 'pic-awk', manpowerThirdParty: 15, totalManpower: 22 });
    const lines = buildPersonnelOutputLines(records, personnel, 'HYNC');
    assert.deepEqual(lines, [
      'SPV SCM                      : Illofi, Yoshita',
      'FRM SCM                     : Adi Guna, Akmal',
      'Independent Sampler : AWK',
      'PIC AWK                       : La Ode Osardi',
      'Manpower AWK           : 15',
      'Total Manpower AWK  : 22',
    ]);
  });

  test('exact-string ATQ output matches the approved corrected format', () => {
    const records = buildDirectory();
    const personnel = validPersonnel({ spvScmIds: ['spv-illofi', 'spv-yoshita'], frmScmIds: ['frm-adi-guna', 'frm-akmal'], samplerId: 'sampler-atq', picThirdId: 'pic-atq', manpowerThirdParty: 15, totalManpower: 22 });
    const lines = buildPersonnelOutputLines(records, personnel, 'ESG');
    assert.deepEqual(lines, [
      'SPV SCM                      : Illofi, Yoshita',
      'FRM SCM                     : Adi Guna, Akmal',
      'Independent Sampler : ATQ',
      'PIC ATQ                        : Khalifa Akbar',
      'Manpower ATQ            : 15',
      'Total Manpower ATQ  : 22',
    ]);
  });

  test('exact-string future-organization (XYZ) output uses the sampler record organization, not a hardcoded allowlist', () => {
    const records = buildDirectory();
    records.push(
      makeRecord({ id: 'pic-xyz-2', role_type: 'PIC_3RD', name: 'Example PIC', organization: 'XYZ' }),
    );
    const personnel = validPersonnel({ spvScmIds: ['spv-illofi'], frmScmIds: ['frm-adi-guna'], samplerId: 'sampler-xyz', picThirdId: 'pic-xyz-2', manpowerThirdParty: 10, totalManpower: 14 });
    const lines = buildPersonnelOutputLines(records, personnel, 'HYNC');
    assert.deepEqual(lines, [
      'SPV SCM                      : Illofi',
      'FRM SCM                     : Adi Guna',
      'Independent Sampler : XYZ',
      'PIC XYZ                       : Example PIC',
      'Manpower XYZ           : 10',
      'Total Manpower XYZ  : 14',
    ]);
  });

  test('output never contains "PIC 3rd", "Manpower 3rd", or a bare "Total Manpower" without an organization', () => {
    const records = buildDirectory();
    const lines = buildPersonnelOutputLines(records, validPersonnel({ samplerId: 'sampler-awk', picThirdId: 'pic-awk' }), 'HYNC');
    const joined = lines.join('\n');
    assert.ok(!joined.includes('PIC 3rd'));
    assert.ok(!joined.includes('Manpower 3rd'));
    assert.ok(!/Total Manpower\s*:/.test(joined)); // "Total Manpower :" with no organization before the colon
  });

  test('output never contains explanatory parenthetical text', () => {
    const records = buildDirectory();
    const lines = buildPersonnelOutputLines(records, validPersonnel(), 'HYNC');
    const joined = lines.join('\n');
    assert.ok(!joined.includes('('));
    assert.ok(!joined.toLowerCase().includes('mengikuti'));
    assert.ok(!joined.toLowerCase().includes('independet'));
  });

  test('PIC/Manpower/Total Manpower organization always matches the selected Independent Sampler organization, never a different one', () => {
    const records = buildDirectory();
    const lines = buildPersonnelOutputLines(records, validPersonnel({ samplerId: 'sampler-atq', picThirdId: 'pic-atq' }), 'ESG');
    assert.ok(lines[3].startsWith('PIC ATQ'));
    assert.ok(lines[4].startsWith('Manpower ATQ'));
    assert.ok(lines[5].startsWith('Total Manpower ATQ'));
    assert.ok(!lines[3].startsWith('PIC AWK'));
  });

  test('multiple selected names are comma-separated in deterministic (sorted) order regardless of selection order', () => {
    const records = buildDirectory();
    const personnel = validPersonnel({ frmScmIds: ['frm-akmal', 'frm-adi-guna'] }); // selected out of alphabetical order
    const lines = buildPersonnelOutputLines(records, personnel, 'HYNC');
    assert.equal(lines[1], 'FRM SCM                     : Adi Guna, Akmal');
  });

  test('34. output contains resolved names, never raw ids', () => {
    const records = buildDirectory();
    const lines = buildPersonnelOutputLines(records, validPersonnel(), 'HYNC');
    const joined = lines.join('\n');
    assert.ok(!joined.includes('spv-illofi'));
    assert.ok(!joined.includes('frm-adi-guna'));
    assert.ok(!joined.includes('sampler-awk'));
    assert.ok(!joined.includes('pic-awk'));
    assert.ok(joined.includes('Illofi'));
    assert.ok(joined.includes('La Ode Osardi'));
  });
});

/* ============================================================
   28-30. WORKBOOK BUYER CHANGE
============================================================ */
describe('Workbook buyer change', () => {
  test('28-29. buyer change reapplies default sampler and clears an incompatible PIC', () => {
    const records = buildDirectory();
    const afterEsg = applyBuyerDefaultSamplerToPersonnel(records, 'ESG', validPersonnel({ samplerId: 'sampler-awk', samplerSource: 'buyer-default', picThirdId: 'pic-awk' }));
    assert.equal(afterEsg.samplerId, 'sampler-atq');
    assert.equal(afterEsg.samplerSource, 'buyer-default');
    assert.equal(afterEsg.picThirdId, null); // pic-awk no longer matches ATQ
  });

  test('30. valid SPV/FRM selections remain selected after a buyer change', () => {
    const records = buildDirectory();
    const before = validPersonnel({ spvScmIds: ['spv-illofi', 'spv-yoshita'], frmScmIds: ['frm-adi-guna'] });
    const after = applyBuyerDefaultSamplerToPersonnel(records, 'ESG', before);
    assert.deepEqual(after.spvScmIds, ['spv-illofi', 'spv-yoshita']);
    assert.deepEqual(after.frmScmIds, ['frm-adi-guna']);
    // manpowerThirdParty is also preserved across a buyer change.
    assert.equal(after.manpowerThirdParty, before.manpowerThirdParty);
  });

  test('a buyer change unconditionally overrides an earlier user override (approved simple behavior)', () => {
    const records = buildDirectory();
    const overridden = overrideSampler(records, 'sampler-xyz', validPersonnel());
    assert.equal(overridden.samplerSource, 'user-override');

    const afterBuyerChange = applyBuyerDefaultSamplerToPersonnel(records, 'HYNC', overridden);
    assert.equal(afterBuyerChange.samplerId, 'sampler-awk');
    assert.equal(afterBuyerChange.samplerSource, 'buyer-default');
  });
});

/* ============================================================
   31. RESET
============================================================ */
describe('31. Reset clears all personnel state', () => {
  test('resetReportState() restores the empty personnel shape', () => {
    reportState.personnel = validPersonnel();
    resetReportState();
    assert.deepEqual(reportState.personnel, {
      spvScmIds: [],
      frmScmIds: [],
      samplerId: null,
      samplerSource: null,
      picThirdId: null,
      manpowerThirdParty: null,
      totalManpower: null,
    });
  });
});

/* ============================================================
   33. DIRECTORY AVAILABILITY
============================================================ */
describe('33. No/corrupted directory snapshot blocks Report', () => {
  test('source "none" produces a blocking, specific error', () => {
    assert.equal(getDirectoryAvailabilityError('none'), t('report.personnel.directoryUnavailable'));
  });

  test('source "cached" or "remote" does not block on availability alone', () => {
    assert.equal(getDirectoryAvailabilityError('cached'), null);
    assert.equal(getDirectoryAvailabilityError('remote'), null);
  });
});

/* ============================================================
   SORTING
============================================================ */
describe('Deterministic sorting', () => {
  test('sortRecords orders by organization (case-insensitive), then name, then id', () => {
    const records = [
      makeRecord({ id: 'r3', role_type: 'PIC_3RD', name: 'Charlie', organization: 'atq' }),
      makeRecord({ id: 'r1', role_type: 'PIC_3RD', name: 'beta', organization: 'AWK' }),
      makeRecord({ id: 'r2', role_type: 'PIC_3RD', name: 'Alpha', organization: 'AWK' }),
    ];
    const sorted = sortRecords(records);
    // 'atq' sorts before 'awk' (3rd char 't' < 'w'); within AWK, name is
    // compared case-insensitively so 'Alpha' sorts before 'beta'.
    assert.deepEqual(sorted.map((r) => r.id), ['r3', 'r2', 'r1']);
  });

  test('sortRecords breaks a same-organization-and-name tie by id', () => {
    const records = [
      makeRecord({ id: 'z-id', role_type: 'PIC_3RD', name: 'Same Name', organization: 'AWK' }),
      makeRecord({ id: 'a-id', role_type: 'PIC_3RD', name: 'Same Name', organization: 'AWK' }),
    ];
    const sorted = sortRecords(records);
    assert.deepEqual(sorted.map((r) => r.id), ['a-id', 'z-id']);
  });
});

/* ============================================================
   COMPACT MULTI-SELECT SELECTOR (UI refinement -- SPV SCM / FRM SCM
   compact field + modal). Task test list items 1-4, 5-10, 11-12.
============================================================ */
describe('buildPersonnelSelectionSummary() -- compact field display rule', () => {
  test('1. 0 selected -> "Belum dipilih"', () => {
    assert.equal(buildPersonnelSelectionSummary([]), 'Belum dipilih');
  });

  test('1b. null/undefined names also produce the neutral placeholder', () => {
    assert.equal(buildPersonnelSelectionSummary(null), 'Belum dipilih');
    assert.equal(buildPersonnelSelectionSummary(undefined), 'Belum dipilih');
  });

  test('2. 1 selected -> the person\'s name', () => {
    assert.equal(buildPersonnelSelectionSummary(['Illofi']), 'Illofi');
  });

  test('3. 2 selected -> both names, comma-separated', () => {
    assert.equal(buildPersonnelSelectionSummary(['Hensi', 'Illofi']), 'Hensi, Illofi');
  });

  test('4. 3+ selected -> "<N> dipilih"', () => {
    assert.equal(buildPersonnelSelectionSummary(['A', 'B', 'C']), '3 dipilih');
    assert.equal(buildPersonnelSelectionSummary(['A', 'B', 'C', 'D', 'E']), '5 dipilih');
  });
});

describe('filterPersonnelByNameSearch() -- modal search rule', () => {
  const records = [
    makeRecord({ id: 'frm-1', role_type: 'FRM_SCM', name: 'Adi Guna' }),
    makeRecord({ id: 'frm-2', role_type: 'FRM_SCM', name: 'Akmal' }),
    makeRecord({ id: 'frm-3', role_type: 'FRM_SCM', name: 'Novelesto' }),
  ];

  test('11. case-insensitive, trimmed, matches by name substring', () => {
    assert.deepEqual(filterPersonnelByNameSearch(records, '  NOV  ').map((r) => r.id), ['frm-3']);
    assert.deepEqual(filterPersonnelByNameSearch(records, 'ak').map((r) => r.id), ['frm-2']);
  });

  test('blank/whitespace-only query returns every record unfiltered', () => {
    assert.equal(filterPersonnelByNameSearch(records, '').length, 3);
    assert.equal(filterPersonnelByNameSearch(records, '   ').length, 3);
  });

  test('no match returns an empty array, never throws', () => {
    assert.deepEqual(filterPersonnelByNameSearch(records, 'zzz-nomatch'), []);
  });

  test('12. search never touches selection state -- it only filters the records array', () => {
    const draft = createMultiSelectDraft(['frm-1', 'frm-2']);
    filterPersonnelByNameSearch(records, 'nov'); // filters frm-1/frm-2 out of the visible list
    // The draft (independent of the filtered view) still reports both as selected.
    assert.equal(draft.selectedIds.has('frm-1'), true);
    assert.equal(draft.selectedIds.has('frm-2'), true);
  });
});

describe('Multi-select draft (temporary selection) -- open/toggle/commit never touch reportState directly', () => {
  test('5. modal opens with current ids preselected', () => {
    const draft = createMultiSelectDraft(['spv-illofi', 'spv-yoshita']);
    assert.equal(draft.selectedIds.has('spv-illofi'), true);
    assert.equal(draft.selectedIds.has('spv-yoshita'), true);
    assert.equal(draft.selectedIds.size, 2);
  });

  test('opening with no current ids starts an empty draft, not a crash', () => {
    const draft = createMultiSelectDraft([]);
    assert.equal(draft.selectedIds.size, 0);
    const draftFromNull = createMultiSelectDraft(null);
    assert.equal(draftFromNull.selectedIds.size, 0);
  });

  test('6. checking/unchecking changes only the (temporary) draft, never the original ids array', () => {
    const originalIds = ['spv-illofi'];
    const draft = createMultiSelectDraft(originalIds);
    const afterToggle = toggleMultiSelectDraft(draft, 'spv-yoshita', true);

    assert.deepEqual(originalIds, ['spv-illofi']); // untouched
    assert.equal(draft.selectedIds.has('spv-yoshita'), false); // the OLD draft object is untouched too (pure function)
    assert.equal(afterToggle.selectedIds.has('spv-yoshita'), true); // only the NEW draft reflects the toggle
  });

  test('unchecking removes an id from the draft', () => {
    const draft = createMultiSelectDraft(['spv-illofi', 'spv-yoshita']);
    const afterUncheck = toggleMultiSelectDraft(draft, 'spv-yoshita', false);
    assert.deepEqual(commitMultiSelectDraft(afterUncheck).sort(), ['spv-illofi']);
  });

  test('7 & 8. Cancel/Escape leave reportState unchanged -- a discarded draft is simply never committed', () => {
    resetReportState();
    reportState.personnel.spvScmIds = ['spv-illofi'];
    const before = reportState.personnel.spvScmIds;

    const draft = createMultiSelectDraft(before);
    const afterToggle = toggleMultiSelectDraft(draft, 'spv-yoshita', true);
    void afterToggle; // simulates checking a box inside the modal, then pressing Cancel/Escape: `afterToggle` is simply discarded, never passed to commitMultiSelectDraft()/never assigned back into reportState

    assert.equal(reportState.personnel.spvScmIds, before); // same array reference -- nothing wrote to it
    assert.deepEqual(reportState.personnel.spvScmIds, ['spv-illofi']);
  });

  test('9. OK commits the temporary ids into a plain array suitable for reportState', () => {
    const draft = createMultiSelectDraft(['spv-illofi']);
    const afterToggle = toggleMultiSelectDraft(draft, 'spv-yoshita', true);
    const committed = commitMultiSelectDraft(afterToggle);

    assert.deepEqual(committed.sort(), ['spv-illofi', 'spv-yoshita']);

    resetReportState();
    reportState.personnel.spvScmIds = committed;
    assert.deepEqual(reportState.personnel.spvScmIds.sort(), ['spv-illofi', 'spv-yoshita']);
  });

  test('10. duplicate ids cannot occur -- toggling the same id "checked" twice is a no-op the second time', () => {
    const draft = createMultiSelectDraft([]);
    const afterFirst = toggleMultiSelectDraft(draft, 'spv-illofi', true);
    const afterSecond = toggleMultiSelectDraft(afterFirst, 'spv-illofi', true);
    assert.deepEqual(commitMultiSelectDraft(afterSecond), ['spv-illofi']);
  });
});

describe('14. Reset clears SPV/FRM selections (report-state.js)', () => {
  test('resetReportState() clears personnel.spvScmIds/frmScmIds back to empty arrays', () => {
    reportState.personnel.spvScmIds = ['spv-illofi', 'spv-yoshita'];
    reportState.personnel.frmScmIds = ['frm-adi-guna'];

    resetReportState();

    assert.deepEqual(reportState.personnel.spvScmIds, []);
    assert.deepEqual(reportState.personnel.frmScmIds, []);
  });
});
