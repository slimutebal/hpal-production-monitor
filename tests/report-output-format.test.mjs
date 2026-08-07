// V2.3 -- Report WhatsApp output spacing + ESG->EIEB user-visible naming.
//
// Run with Node's built-in test runner:
//   node --test tests/report-output-format.test.mjs
//
// Scope of this file: exact-string coverage of the generated Man Power and
// Support / Number of Truck / contractor-breakdown block for HYNC, SLNC,
// and the internal ESG buyer (displayed to the user as EIEB), plus the
// user-visible EIEB naming seam (getBuyerDisplayLabel) and confirmation
// that internal identifiers (BUYER_ESG, ESG_FORMAT_A/B, esg-profile.js's
// own buyer id) were left completely unchanged.
//
// esg-format-a-adapter.js / esg-format-b-adapter.js / esg-workbook-detector.js
// call the global `XLSX` (SheetJS), which only exists in the browser --
// this plain-Node suite cannot feed them a real workbook (the rest of this
// project's test suite has the same constraint, see report-week.test.mjs's
// own header comment). "ESG Format A/B still parses successfully" is
// therefore verified at the level this project's test suite can reach
// without a browser: the adapters/detector modules import cleanly and
// still export the exact same functions and internal format identifiers
// they did before this task -- i.e. nothing in the parsing layer was
// touched by the spacing/wording change. Real end-to-end parsing is
// covered by the manual WhatsApp validation checklist instead.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { buildReportText } from '../js/pages/report/profiles/shared-report-profile.js';
import { buildPersonnelOutputLines, getDefaultSamplerOrganization } from '../js/pages/report/report-personnel.js';
import { BUYER_HYNC, BUYER_SLNC, BUYER_ESG, getBuyerDisplayLabel, buyerFromPrevText } from '../js/pages/report/profiles/profile-registry.js';
import { ESG_BUYER, ESG_PROFILE, buildEsgFileSummary } from '../js/pages/report/profiles/esg-profile.js';
import { ESG_WORKBOOK_FORMAT } from '../js/pages/report/profiles/esg-workbook-detector.js';
import * as esgFormatAAdapter from '../js/pages/report/profiles/adapters/esg-format-a-adapter.js';
import * as esgFormatBAdapter from '../js/pages/report/profiles/adapters/esg-format-b-adapter.js';

/* ============================================================
   FIXTURES
============================================================ */
function directory() {
  return [
    { id: 'spv1', role_type: 'SPV_SCM', active: true, name: 'Hensi', organization: 'SCM' },
    { id: 'frm1', role_type: 'FRM_SCM', active: true, name: 'Novelesto', organization: 'SCM' },
    { id: 'frm2', role_type: 'FRM_SCM', active: true, name: 'Satya Bayu', organization: 'SCM' },
    { id: 'sam-awk', role_type: 'SAMPLER', active: true, name: 'AWK', organization: 'AWK' },
    { id: 'sam-atq', role_type: 'SAMPLER', active: true, name: 'ATQ', organization: 'ATQ' },
    { id: 'pic-awk', role_type: 'PIC_3RD', active: true, name: 'La Ode Osardi', organization: 'AWK' },
    { id: 'pic-atq', role_type: 'PIC_3RD', active: true, name: 'Khalifa Akbar', organization: 'ATQ' },
  ];
}

function baseParsed(overrides = {}) {
  return {
    fileDate: null,
    shiftLabel: 'Day Shift',
    totalDT: 65,
    totalADT: 0,
    contractorCounts: [['PMS', 9], ['MRP', 56]],
    domes: [],
    onShiftTon: 1234.5,
    onShiftRit: 42,
    ...overrides,
  };
}

function zeroTotals() {
  return { dailyTon: 0, dailyRit: 0, wtdTon: 0, wtdRit: 0, mtdTon: 0, mtdRit: 0, ytdTon: 0, ytdRit: 0 };
}

function manPowerBlock(text) {
  const lines = text.split('\n');
  const start = lines.indexOf('Man Power and Support');
  // 9 lines: header + 6 personnel lines + Number of Truck + first contractor line onward is variable,
  // callers slice as needed -- this helper only anchors the start index.
  return lines.slice(start);
}

/* ============================================================
   1-3. COMPLETE HYNC / SLNC / EIEB BLOCKS (exact strings)
============================================================ */
describe('Complete generated Man Power and Support block -- exact strings', () => {
  const hyncEieb = manPowerBlock; // alias for readability at call sites below

  test('1. complete HYNC block matches the approved literal template exactly', () => {
    const records = directory();
    const personnel = {
      spvScmIds: ['spv1'], frmScmIds: ['frm1'], samplerId: 'sam-awk', samplerSource: 'buyer-default',
      picThirdId: 'pic-awk', manpowerThirdParty: 24, totalManpower: 26,
    };
    const personnelLines = buildPersonnelOutputLines(records, personnel, BUYER_HYNC);
    const parsed = baseParsed();
    const text = buildReportText({ buyer: BUYER_HYNC, parsed, inputs: {}, domeAreas: {}, totals: zeroTotals(), weekNumber: 1, personnelLines });
    const block = hyncEieb(text).slice(0, 10).join('\n');
    assert.equal(block, [
      'Man Power and Support',
      'SPV SCM                      : Hensi',
      'FRM SCM                     : Novelesto',
      'Independent Sampler : AWK',
      'PIC AWK                       : La Ode Osardi',
      'Manpower AWK           : 24',
      'Total Manpower AWK  : 26',
      'Number of Truck.         : 65 DT + 0 ADT',
      'PMS                               : 9 Trucks',
      'MRP                               : 56 Trucks',
    ].join('\n'));
  });

  test('2. complete SLNC block uses the exact same literal template as HYNC', () => {
    const records = directory();
    const personnel = {
      spvScmIds: ['spv1'], frmScmIds: ['frm1'], samplerId: 'sam-awk', samplerSource: 'buyer-default',
      picThirdId: 'pic-awk', manpowerThirdParty: 24, totalManpower: 26,
    };
    const personnelLines = buildPersonnelOutputLines(records, personnel, BUYER_SLNC);
    const parsed = baseParsed();
    const text = buildReportText({ buyer: BUYER_SLNC, parsed, inputs: {}, domeAreas: {}, totals: zeroTotals(), weekNumber: 1, personnelLines });
    const block = hyncEieb(text).slice(0, 10).join('\n');
    assert.equal(block, [
      'Man Power and Support',
      'SPV SCM                      : Hensi',
      'FRM SCM                     : Novelesto',
      'Independent Sampler : AWK',
      'PIC AWK                       : La Ode Osardi',
      'Manpower AWK           : 24',
      'Total Manpower AWK  : 26',
      'Number of Truck.         : 65 DT + 0 ADT',
      'PMS                               : 9 Trucks',
      'MRP                               : 56 Trucks',
    ].join('\n'));
  });

  test('3. complete EIEB block matches the approved literal template exactly', () => {
    const records = directory();
    const personnel = {
      spvScmIds: ['spv1'], frmScmIds: ['frm1', 'frm2'], samplerId: 'sam-atq', samplerSource: 'buyer-default',
      picThirdId: 'pic-atq', manpowerThirdParty: 24, totalManpower: 25,
    };
    const personnelLines = buildPersonnelOutputLines(records, personnel, BUYER_ESG);
    const parsed = baseParsed({ totalDT: 79, contractorCounts: [['TII', 48], ['REAL', 11]] });
    const text = buildReportText({ buyer: BUYER_ESG, parsed, inputs: {}, domeAreas: {}, totals: zeroTotals(), weekNumber: 1, personnelLines });
    const block = hyncEieb(text).slice(0, 10).join('\n');
    assert.equal(block, [
      'Man Power and Support',
      'SPV SCM                      : Hensi',
      'FRM SCM                     : Novelesto, Satya Bayu',
      'Independent Sampler : ATQ',
      'PIC ATQ                        : Khalifa Akbar',
      'Manpower ATQ            : 24',
      'Total Manpower ATQ  : 25',
      'Number of Truck         : 79 DT + 0 ADT',
      'TII                                  : 48 Trucks',
      'REAL                             : 11 Trucks',
    ].join('\n'));
  });
});

/* ============================================================
   4-6. "Number of Truck[.]" PUNCTUATION PER BUYER
============================================================ */
describe('"Number of Truck" line punctuation is buyer-specific and never normalized', () => {
  function numberOfTruckLine(buyer) {
    const text = buildReportText({
      buyer, parsed: baseParsed(), inputs: {}, domeAreas: {}, totals: zeroTotals(), weekNumber: 1, personnelLines: [],
    });
    return text.split('\n').find((l) => l.startsWith('Number of Truck'));
  }

  test('4. HYNC output contains "Number of Truck."', () => {
    assert.ok(numberOfTruckLine(BUYER_HYNC).includes('Number of Truck.'));
  });

  test('5. SLNC output contains "Number of Truck."', () => {
    assert.ok(numberOfTruckLine(BUYER_SLNC).includes('Number of Truck.'));
  });

  test('6. EIEB output contains "Number of Truck" without a period', () => {
    const line = numberOfTruckLine(BUYER_ESG);
    assert.ok(line.startsWith('Number of Truck '));
    assert.ok(!line.includes('Number of Truck.'));
  });
});

/* ============================================================
   7. NO LITERAL "ESG" IN EIEB USER-VISIBLE OUTPUT
============================================================ */
describe('EIEB user-visible output never contains the standalone word "ESG"', () => {
  test('7. generated report text for the ESG buyer contains no standalone "ESG" token', () => {
    const records = directory();
    const personnel = {
      spvScmIds: ['spv1'], frmScmIds: ['frm1', 'frm2'], samplerId: 'sam-atq', samplerSource: 'buyer-default',
      picThirdId: 'pic-atq', manpowerThirdParty: 24, totalManpower: 25,
    };
    const personnelLines = buildPersonnelOutputLines(records, personnel, BUYER_ESG);
    const parsed = baseParsed({ totalDT: 79, contractorCounts: [['TII', 48], ['REAL', 11]] });
    const text = buildReportText({ buyer: BUYER_ESG, parsed, inputs: {}, domeAreas: {}, totals: zeroTotals(), weekNumber: 1, personnelLines });
    assert.ok(!/\bESG\b/.test(text));
    assert.ok(text.includes('FPP EIEB'));
  });

  test('buildEsgFileSummary shows EIEB, never ESG', () => {
    const summary = buildEsgFileSummary({
      workbookFormat: ESG_WORKBOOK_FORMAT.ESG_FORMAT_A,
      sheetName: 'Sheet1',
      fileDate: null,
      shiftLabel: 'Day Shift',
      onShiftTon: 100,
      onShiftRit: 10,
      unmatchedTrucks: [],
    });
    assert.ok(!/\bESG\b/.test(summary));
    assert.ok(summary.includes('Buyer: EIEB'));
    assert.ok(summary.includes('Format: EIEB Format A'));
  });

  test('getBuyerDisplayLabel maps ESG -> EIEB and leaves HYNC/SLNC unchanged', () => {
    assert.equal(getBuyerDisplayLabel(BUYER_ESG), 'EIEB');
    assert.equal(getBuyerDisplayLabel(BUYER_HYNC), 'HYNC');
    assert.equal(getBuyerDisplayLabel(BUYER_SLNC), 'SLNC');
  });

  test('previous-report-text buyer detection accepts both legacy "FPP ESG" and the new "FPP EIEB" token, both resolving to the internal ESG buyer', () => {
    assert.deepEqual(buyerFromPrevText('... FPP ESG ...'), { status: 'ok', buyer: BUYER_ESG });
    assert.deepEqual(buyerFromPrevText('... FPP EIEB ...'), { status: 'ok', buyer: BUYER_ESG });
  });
});

/* ============================================================
   8-10. INTERNAL ESG IDENTIFIERS / PARSING LAYER UNCHANGED
============================================================ */
describe('Internal ESG identifiers and parsing layer are unaffected by the EIEB display change', () => {
  test('8. internal ESG buyer/profile identifiers remain the literal string "ESG"', () => {
    assert.equal(BUYER_ESG, 'ESG');
    assert.equal(ESG_BUYER, 'ESG');
    assert.equal(ESG_PROFILE.buyer, 'ESG');
    assert.equal(ESG_WORKBOOK_FORMAT.ESG_FORMAT_A, 'ESG_FORMAT_A');
    assert.equal(ESG_WORKBOOK_FORMAT.ESG_FORMAT_B, 'ESG_FORMAT_B');
  });

  test('9. ESG Format A adapter module is untouched -- exports the same parsing function', () => {
    assert.equal(typeof esgFormatAAdapter.parseEsgFormatA, 'function');
  });

  test('10. ESG Format B adapter module is untouched -- exports the same parsing function', () => {
    assert.equal(typeof esgFormatBAdapter.parseEsgFormatB, 'function');
  });
});

/* ============================================================
   11-12. DEFAULT SAMPLER ORGANIZATION UNCHANGED
============================================================ */
describe('Default sampler organization per buyer is unchanged', () => {
  test('11. EIEB (internal ESG buyer) default sampler remains ATQ', () => {
    assert.equal(getDefaultSamplerOrganization('ESG'), 'ATQ');
  });

  test('12. HYNC/SLNC default sampler remains AWK', () => {
    assert.equal(getDefaultSamplerOrganization('HYNC'), 'AWK');
    assert.equal(getDefaultSamplerOrganization('SLNC'), 'AWK');
  });
});

/* ============================================================
   13-15. CALCULATIONS/VALUES UNCHANGED BY THE SPACING/WORDING CHANGE
============================================================ */
describe('Manpower, contractor totals, and tonnage/ritase are unaffected by the spacing/wording change', () => {
  test('13. manpower values are printed exactly as manually entered, never recomputed from SPV/FRM selection size', () => {
    const records = directory();
    const personnel = {
      spvScmIds: ['spv1'], frmScmIds: ['frm1', 'frm2'], samplerId: 'sam-awk', picThirdId: 'pic-awk',
      manpowerThirdParty: 7, totalManpower: 3,
    };
    const lines = buildPersonnelOutputLines(records, personnel, BUYER_HYNC);
    assert.ok(lines[4].endsWith(': 7'));
    assert.ok(lines[5].endsWith(': 3'));
  });

  test('14. contractor totals (name/count pairs) flow through unchanged, only their line spacing changes', () => {
    const parsed = baseParsed({ contractorCounts: [['PMS', 3], ['MRP', 12], ['STM', 1]] });
    const text = buildReportText({ buyer: BUYER_HYNC, parsed, inputs: {}, domeAreas: {}, totals: zeroTotals(), weekNumber: 1, personnelLines: [] });
    assert.ok(text.includes(': 3 Trucks'));
    assert.ok(text.includes(': 12 Trucks'));
    assert.ok(text.includes(': 1 Trucks'));
    // STM has no literal example -- must fall back to the pre-existing generic width, not a guessed new one.
    assert.ok(text.includes(`${'STM'.padEnd(20, ' ')}: 1 Trucks`));
  });

  test('15. On Shift tonnage/ritase formatting is unchanged', () => {
    const parsed = baseParsed({ onShiftTon: 1234.5, onShiftRit: 42 });
    const text = buildReportText({ buyer: BUYER_HYNC, parsed, inputs: {}, domeAreas: {}, totals: zeroTotals(), weekNumber: 1, personnelLines: [] });
    const onShiftLine = text.split('\n').find((l) => l.startsWith('On Shift'));
    assert.equal(onShiftLine, 'On Shift    : 1.234,50 wmt [ 42 Rit ]');
  });
});
