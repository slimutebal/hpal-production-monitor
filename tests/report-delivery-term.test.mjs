// V3.1 Report -- delivery term (DAP/EXW) derived from the uploaded
// workbook's own selling code, buyer-agnostic (HYNC/SLNC/EIEB alike), plus
// the resulting split YTD DAP / YTD EXW previous-report baseline parsing.
//
// Run with Node's built-in test runner:
//   node --test tests/report-delivery-term.test.mjs
//
// Scope: the pure classifier/resolver (report-utils.js), the previous-report
// text parser's new split-YTD baseline + legacy-single-YTD fail-closed
// migration path (shared-report-profile.js's parsePrevText), the ESG
// aggregation step that turns adapter rows into a resolved workbook-level
// delivery term (esg-profile.js's buildEsgParsedResult, exported for this
// purpose), and the two ESG adapters' selling-code column resolution
// ("Kode Sample" / "PILE ID") verified directly against literal matrices
// shaped exactly like the real local reference workbooks
// (docs/references/*.xlsx, git-ignored) confirmed via manual inspection.
// Full end-to-end workbook parsing (parseWeighbridgeWorkbook/
// parseEsgWorkbook) needs the global `XLSX` (SheetJS) object, only ever
// loaded in the browser -- same constraint documented in this project's
// other Report test files (see report-week.test.mjs's header comment).

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  DELIVERY_TERM_DAP,
  DELIVERY_TERM_EXW,
  detectDeliveryTerm,
  resolveWorkbookDeliveryTerm,
} from '../js/pages/report/report-utils.js';
import { parsePrevText } from '../js/pages/report/profiles/shared-report-profile.js';
import { buildEsgParsedResult } from '../js/pages/report/profiles/esg-profile.js';
import { findMarkerColumns } from '../js/pages/report/profiles/adapters/esg-adapter-utils.js';

/* ============================================================
   DELIVERY-TERM CLASSIFIER
============================================================ */
describe('detectDeliveryTerm -- one shared classifier for every buyer prefix', () => {
  test('SCHY without an EX suffix -> DAP', () => {
    assert.equal(detectDeliveryTerm('SCHY-0000012'), DELIVERY_TERM_DAP);
  });
  test('SCHY with an EX suffix -> EXW', () => {
    assert.equal(detectDeliveryTerm('SCHY-EX-0000012'), DELIVERY_TERM_EXW);
  });
  test('SCSL without an EX suffix -> DAP', () => {
    assert.equal(detectDeliveryTerm('SCSL-0000033'), DELIVERY_TERM_DAP);
  });
  test('SCSL with an EX suffix -> EXW', () => {
    assert.equal(detectDeliveryTerm('SCSL-EX-0000033'), DELIVERY_TERM_EXW);
  });
  test('SCESG without an EX suffix -> DAP', () => {
    assert.equal(detectDeliveryTerm('SCESG-000202'), DELIVERY_TERM_DAP);
  });
  test('SCESG with an EX suffix -> EXW (confirmed real production value: "SCESG-EX-000202")', () => {
    assert.equal(detectDeliveryTerm('SCESG-EX-000202'), DELIVERY_TERM_EXW);
  });

  test('lowercase and surrounding whitespace are normalized before classification', () => {
    assert.equal(detectDeliveryTerm('  schy-ex-0000012  '), DELIVERY_TERM_EXW);
    assert.equal(detectDeliveryTerm('  scsl-0000033  '), DELIVERY_TERM_DAP);
  });

  test('separators actually found in production data (hyphen) are tolerated', () => {
    assert.equal(detectDeliveryTerm('SCESG-EX-000202'), DELIVERY_TERM_EXW);
  });

  test('invalid/missing selling code resolves to null, never a guessed default', () => {
    assert.equal(detectDeliveryTerm(''), null);
    assert.equal(detectDeliveryTerm('   '), null);
    assert.equal(detectDeliveryTerm(null), null);
    assert.equal(detectDeliveryTerm(undefined), null);
    assert.equal(detectDeliveryTerm('UNRECOGNIZED-CODE'), null);
  });

  test('never a loose code.includes("EX") false positive', () => {
    // "EXPORT" starts with EX but is not the standalone "EX" token the
    // business rule requires immediately after the buyer prefix.
    assert.equal(detectDeliveryTerm('SCHY-EXPORT-00001'), DELIVERY_TERM_DAP);
    // "EX" appearing later in the code (not immediately after the prefix)
    // must not trigger EXW either.
    assert.equal(detectDeliveryTerm('SCHY-00001-EX'), DELIVERY_TERM_DAP);
  });
});

/* ============================================================
   WORKBOOK-LEVEL RESOLUTION
============================================================ */
describe('resolveWorkbookDeliveryTerm -- one delivery term per workbook, or a blocking result', () => {
  test('all DAP rows -> resolved DAP', () => {
    const result = resolveWorkbookDeliveryTerm(['SCHY-0001', 'SCHY-0002', 'SCHY-0003']);
    assert.deepEqual(result, { status: 'resolved', deliveryTerm: DELIVERY_TERM_DAP });
  });

  test('all EXW rows -> resolved EXW', () => {
    const result = resolveWorkbookDeliveryTerm(['SCESG-EX-000202', 'SCESG-EX-000202', 'SCESG-EX-000203']);
    assert.deepEqual(result, { status: 'resolved', deliveryTerm: DELIVERY_TERM_EXW });
  });

  test('mixed DAP + EXW rows -> mixed (blocking)', () => {
    const result = resolveWorkbookDeliveryTerm(['SCHY-0001', 'SCHY-EX-0002']);
    assert.equal(result.status, 'mixed');
    assert.deepEqual(new Set(result.terms), new Set([DELIVERY_TERM_DAP, DELIVERY_TERM_EXW]));
  });

  test('no valid selling code anywhere -> unresolved (fail closed, never inferred as DAP)', () => {
    assert.deepEqual(resolveWorkbookDeliveryTerm([]), { status: 'unresolved' });
    assert.deepEqual(resolveWorkbookDeliveryTerm(['', '  ', null, undefined]), { status: 'unresolved' });
    assert.deepEqual(resolveWorkbookDeliveryTerm(['GARBAGE', 'ALSO-GARBAGE']), { status: 'unresolved' });
  });

  test('a handful of unclassifiable rows alongside a clean, single-term majority still resolves normally', () => {
    const result = resolveWorkbookDeliveryTerm(['SCHY-0001', 'SCHY-0002', '']);
    assert.deepEqual(result, { status: 'resolved', deliveryTerm: DELIVERY_TERM_DAP });
  });
});

/* ============================================================
   ESG ADAPTER SELLING-CODE COLUMN RESOLUTION
   Verified directly against literal matrices shaped exactly like the real
   local reference workbooks (manual inspection via openpyxl), independent
   of the browser-only XLSX.utils.sheet_to_json step the adapters otherwise
   need.
============================================================ */
describe('ESG selling-code column resolves to the real, confirmed production column', () => {
  test('Format A: "Kode Sample" is found on the composite row 15/16 header, between "Cargo Weighing" and "Kode Dome"', () => {
    const matrix = Array.from({ length: 14 }, () => []);
    matrix.push(['', 'Nomor', 'Vehicle No', 'Date', 'Weighing Bridge', '', '', '', '', 'Kode Sample', 'Kode Dome', 'Retase']); // row 15
    matrix.push(['', '', '', '', 'Time Loaded', 'Time Empty', 'Weighing Truck + Cargo', 'Weighing Truck', 'Cargo Weighing', '', '', '']); // row 16
    const match = findMarkerColumns(matrix, ['Kode Sample'], { windowSize: 2, maxScanRow: 40 });
    assert.ok(match);
    assert.equal(match.columns['Kode Sample'].col, 9); // column J, matches the adapter's fixed fallback
  });

  test('Format B: "PILE ID" is found on the single-row header, between "TANGGAL" and "KODE ORE"', () => {
    const matrix = [[], [], []];
    matrix.push(['', 'NO', 'NO.NOTA', 'NO. DT', 'MATERIAL', 'PENYUPLAI', 'PENERIMA', 'TIMBANGAN ISI', 'TIMBANGAN KOSONG', 'TIMBANGAN BERSIH', 'JAM TIMBANG ISI', 'JAM TIMBANG KOSONG', 'LOKASI DUMPING', 'TANGGAL', 'PILE ID', 'KODE ORE']); // row 4
    const match = findMarkerColumns(matrix, ['PILE ID'], { windowSize: 1, maxScanRow: 20 });
    assert.ok(match);
    assert.equal(match.columns['PILE ID'].col, 14); // column O, matches the adapter's fixed fallback
  });
});

/* ============================================================
   ESG AGGREGATION -- delivery term flows through the shared engine
============================================================ */
describe('buildEsgParsedResult resolves delivery term from adapter rows through the shared resolver', () => {
  function esgRow(overrides = {}) {
    return {
      sourceRow: 1,
      vehicleNo: 'SCM-LIM 930',
      netKg: 52140,
      loadedAt: new Date(2026, 7, 5, 19, 2),
      date: new Date(2026, 7, 5),
      dome: 'L21_01',
      grade: 1.15,
      oreClass: 'MGLO',
      sellingCode: 'SCESG-EX-000202',
      ...overrides,
    };
  }

  function esgResult(rows, overrides = {}) {
    return { rows, warnings: [], issues: [], buyerEvidence: { type: 'test' }, sheetName: 'Test', workbookFormat: 'ESG_FORMAT_A', ...overrides };
  }

  test('all-EXW rows resolve parsed.deliveryTerm to EXW', () => {
    const parsed = buildEsgParsedResult(esgResult([esgRow(), esgRow({ sourceRow: 2 })]));
    assert.equal(parsed.deliveryTerm, DELIVERY_TERM_EXW);
    assert.deepEqual(parsed.deliveryTermResolution, { status: 'resolved', deliveryTerm: DELIVERY_TERM_EXW });
  });

  test('all-DAP rows resolve parsed.deliveryTerm to DAP', () => {
    const parsed = buildEsgParsedResult(esgResult([esgRow({ sellingCode: 'SCESG-000202' })]));
    assert.equal(parsed.deliveryTerm, DELIVERY_TERM_DAP);
  });

  test('mixed rows resolve to a blocking mixed status, parsed.deliveryTerm is null', () => {
    const parsed = buildEsgParsedResult(esgResult([
      esgRow({ sellingCode: 'SCESG-000202' }),
      esgRow({ sourceRow: 2, sellingCode: 'SCESG-EX-000203' }),
    ]));
    assert.equal(parsed.deliveryTerm, null);
    assert.equal(parsed.deliveryTermResolution.status, 'mixed');
  });

  test('no rows / no selling code resolves to unresolved, parsed.deliveryTerm is null (fail closed)', () => {
    const parsed = buildEsgParsedResult(esgResult([esgRow({ sellingCode: '' })]));
    assert.equal(parsed.deliveryTerm, null);
    assert.equal(parsed.deliveryTermResolution.status, 'unresolved');
  });
});

/* ============================================================
   PREVIOUS-REPORT PARSER -- split YTD DAP/EXW baseline
============================================================ */
describe('parsePrevText -- new tonnage-only Daily/WTD/MTD/YTD DAP/YTD EXW format', () => {
  function newFormatText({ ytdDapLine = 'YTD DAP   : 5.012.022,52 wmt', ytdExwLine = 'YTD EXW  : 2.429.899,98 wmt' } = {}) {
    return [
      'Date    : 28 September 2026',
      'Week  : 40',
      'Daily          : 33.316,40 wmt',
      'WTD           : 33.316,40 wmt',
      'MTD           : 1.690.214,05 wmt',
      ytdDapLine,
      ytdExwLine,
    ].join('\n');
  }

  test('parses new tonnage-only Daily/WTD/MTD (no ritase bracket required)', () => {
    const prev = parsePrevText(newFormatText());
    assert.deepEqual(prev.errors, []);
    assert.deepEqual(prev.daily, { ton: 33316.4, rit: 0 });
    assert.deepEqual(prev.wtd, { ton: 33316.4, rit: 0 });
    assert.deepEqual(prev.mtd, { ton: 1690214.05, rit: 0 });
  });

  test('parses "YTD DAP" and "YTD EXW" into independent buckets', () => {
    const prev = parsePrevText(newFormatText());
    assert.deepEqual(prev.ytdDap, { ton: 5012022.52, rit: 0 });
    assert.deepEqual(prev.ytdExw, { ton: 2429899.98, rit: 0 });
  });

  test('still parses the legacy "[ n Rit ]" syntax for Daily/WTD/MTD where practical', () => {
    const text = [
      'Date    : 28 September 2026',
      'Daily         : 33.316,40 wmt [ 700 Rit ]',
      'WTD         : 33.316,40 wmt [ 700 Rit ]',
      'MTD         : 1.690.214,05 wmt [ 35.000 Rit ]',
      'YTD DAP   : 5.012.022,52 wmt',
      'YTD EXW  : 2.429.899,98 wmt',
    ].join('\n');
    const prev = parsePrevText(text);
    assert.deepEqual(prev.errors, []);
    assert.deepEqual(prev.daily, { ton: 33316.4, rit: 700 });
    assert.deepEqual(prev.mtd, { ton: 1690214.05, rit: 35000 });
  });

  test('detects an unresolved legacy single-YTD baseline instead of guessing a split', () => {
    const text = [
      'Date    : 28 September 2026',
      'Daily         : 33.316,40 wmt [ 700 Rit ]',
      'WTD         : 33.316,40 wmt [ 700 Rit ]',
      'MTD         : 1.690.214,05 wmt [ 35.000 Rit ]',
      'YTD          : 7.441.922,50 wmt [ 150000 Rit ]',
    ].join('\n');
    const prev = parsePrevText(text);
    assert.ok(prev.errors.length > 0);
    // Never silently mapped to DAP, EXW, or divided.
    assert.deepEqual(prev.ytdDap, { ton: 0, rit: 0 });
    assert.deepEqual(prev.ytdExw, { ton: 0, rit: 0 });
  });

  test('an incomplete split baseline (only one of YTD DAP / YTD EXW present) is also treated as unresolved', () => {
    const text = [
      'Date    : 28 September 2026',
      'Daily         : 33.316,40 wmt',
      'WTD         : 33.316,40 wmt',
      'MTD         : 1.690.214,05 wmt',
      'YTD DAP   : 5.012.022,52 wmt',
    ].join('\n');
    const prev = parsePrevText(text);
    assert.ok(prev.errors.length > 0);
  });

  test('neither the legacy YTD line nor the split lines are present at all -- reported as not found', () => {
    const text = [
      'Date    : 28 September 2026',
      'Daily         : 33.316,40 wmt',
      'WTD         : 33.316,40 wmt',
      'MTD         : 1.690.214,05 wmt',
    ].join('\n');
    const prev = parsePrevText(text);
    assert.ok(prev.errors.some((e) => e.includes('YTD')));
  });
});
