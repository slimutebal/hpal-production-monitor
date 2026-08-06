// Automatic Week (V2.3 Phase 1) tests.
//
// Run with Node's built-in test runner (Node 18+, zero new dependencies,
// consistent with this project's no-external-libraries convention):
//
//   node --test tests/report-week.test.mjs
//
// These import the actual shipped source files directly (ES modules,
// native to Node -- no bundler/transpiler needed) rather than
// re-implementing the logic under test. shared-report-profile.js and
// esg-adapter-utils.js both reference the global `XLSX` (SheetJS) inside
// some of their functions, but never inside parseFlexibleDate()'s
// string-input branch or makeLocalDate() -- the two functions exercised
// here -- so importing them and calling only those functions is safe in a
// plain Node environment with no XLSX/browser globals defined.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { calculateIsoWeek, deriveWeekFromParsedWorkbook } from '../js/pages/report/report-utils.js';
import { parseFlexibleDate } from '../js/pages/report/profiles/shared-report-profile.js';
import { makeLocalDate } from '../js/pages/report/profiles/adapters/esg-adapter-utils.js';
import { reportState, resetReportState } from '../js/pages/report/report-state.js';

// Local calendar-date constructor, matching exactly how every profile
// already builds its fileDate (see report-utils.js's calculateIsoWeek
// header comment): new Date(year, month0, day) -- never a string passed
// through Date.parse().
function localDate(year, month1, day) {
  return new Date(year, month1 - 1, day);
}

describe('calculateIsoWeek() -- pure ISO-8601 week math', () => {
  test('ordinary Monday (2026-08-03) is week 32', () => {
    const result = calculateIsoWeek(localDate(2026, 8, 3));
    assert.deepEqual(result, { weekNumber: 32, weekYear: 2026, weekStart: '2026-08-03', weekEnd: '2026-08-09' });
  });

  test('ordinary Sunday (2026-08-09) is the same week 32', () => {
    const result = calculateIsoWeek(localDate(2026, 8, 9));
    assert.deepEqual(result, { weekNumber: 32, weekYear: 2026, weekStart: '2026-08-03', weekEnd: '2026-08-09' });
  });

  test('ISO year starts in the previous calendar year (2025-12-29)', () => {
    const result = calculateIsoWeek(localDate(2025, 12, 29));
    assert.deepEqual(result, { weekNumber: 1, weekYear: 2026, weekStart: '2025-12-29', weekEnd: '2026-01-04' });
  });

  test('2026-01-01 belongs to ISO week 1 of 2026', () => {
    const result = calculateIsoWeek(localDate(2026, 1, 1));
    assert.equal(result.weekYear, 2026);
    assert.equal(result.weekNumber, 1);
  });

  test('2026-01-04 is still ISO week 1 of 2026 (same week as 2025-12-29)', () => {
    const result = calculateIsoWeek(localDate(2026, 1, 4));
    assert.deepEqual(result, { weekNumber: 1, weekYear: 2026, weekStart: '2025-12-29', weekEnd: '2026-01-04' });
  });

  test('2026-01-05 rolls over to ISO week 2', () => {
    const result = calculateIsoWeek(localDate(2026, 1, 5));
    assert.deepEqual(result, { weekNumber: 2, weekYear: 2026, weekStart: '2026-01-05', weekEnd: '2026-01-11' });
  });

  test('ISO year ends in the following calendar year -- a 53-week ISO year (2026-12-31)', () => {
    const result = calculateIsoWeek(localDate(2026, 12, 31));
    assert.equal(result.weekYear, 2026);
    assert.equal(result.weekNumber, 53);
  });

  test('2027-01-01 still belongs to ISO week 53 of 2026', () => {
    const result = calculateIsoWeek(localDate(2027, 1, 1));
    assert.equal(result.weekYear, 2026);
    assert.equal(result.weekNumber, 53);
  });

  test('2027-01-04 is ISO week 1 of 2027', () => {
    const result = calculateIsoWeek(localDate(2027, 1, 4));
    assert.equal(result.weekYear, 2027);
    assert.equal(result.weekNumber, 1);
  });

  test('leap-year date (2024-02-29)', () => {
    const result = calculateIsoWeek(localDate(2024, 2, 29));
    assert.deepEqual(result, { weekNumber: 9, weekYear: 2024, weekStart: '2024-02-26', weekEnd: '2024-03-03' });
  });

  test('invalid Date input returns null, never throws', () => {
    assert.equal(calculateIsoWeek(new Date('not-a-real-date')), null);
  });

  test('missing input (null/undefined/non-Date) returns null, never throws', () => {
    assert.equal(calculateIsoWeek(null), null);
    assert.equal(calculateIsoWeek(undefined), null);
    assert.equal(calculateIsoWeek('2026-08-03'), null); // a string is not a Date instance -- must not be silently coerced
    assert.equal(calculateIsoWeek(42), null);
  });

  test('device/system date never affects the result -- same input always produces the same output', () => {
    const a = calculateIsoWeek(localDate(2026, 8, 3));
    const b = calculateIsoWeek(localDate(2026, 8, 3));
    assert.deepEqual(a, b);
    // calculateIsoWeek() takes exactly one argument (workbookDate) -- there
    // is no second parameter for "now" or any other implicit input, so it
    // has no way to read the device clock even if it wanted to.
    assert.equal(calculateIsoWeek.length, 1);
  });

  test('previous-report text/date has no way to reach this function -- single-argument, pure', () => {
    // Architectural guarantee, not a runtime behavior to poke at:
    // calculateIsoWeek's only parameter is the workbook date. There is no
    // previous-report/UI-state argument it could read even by mistake.
    assert.equal(calculateIsoWeek.length, 1);
  });
});

describe('Regression: dateMismatch must not block a resolved canonical date (real ESG Format A Night Shift bug)', () => {
  // Reproduces, without the real operational workbook (git-ignored, never
  // committed -- see docs/references/), the exact shape esg-profile.js's
  // buildEsgParsedResult() produces for the Owner's real failing file:
  // "DATA TIMBANGAN 5 AGUSTUS 2026 SHIFT 2.xlsx", sheet "WS 050826 S2",
  // Night Shift, 475 rows, canonical date 5 Agustus 2026 (2026-08-05).
  // Some rows loaded after midnight legitimately carry a Date-column value
  // of 2026-08-06, which is exactly what sets dateMismatch = true -- this
  // is the same legacy/informational flag shared-report-profile.js and
  // esg-profile.js both already surface as a non-blocking warning
  // ("Ada lebih dari 1 tanggal berbeda...dipakai tanggal dari baris
  // pertama."), never as a blocking one.
  const nightShiftFormatAFixture = {
    buyer: 'ESG',
    workbookFormat: 'ESG_FORMAT_A',
    sheetName: 'WS 050826 S2',
    fileDate: makeLocalDate(2026, 8, 5), // first valid row's date -- deterministic canonical date
    dateMismatch: true, // a later row's Date-column value rolled to 2026-08-06 past midnight
    shiftLabel: 'Night Shift',
    onShiftRit: 475,
    onShiftTon: 23061.48,
  };

  test('valid canonical date with dateMismatch=true still calculates Week (does not block)', () => {
    const week = deriveWeekFromParsedWorkbook(nightShiftFormatAFixture);
    assert.notEqual(week, null);
  });

  test('real ESG Format A Night Shift case: canonical date 2026-08-05 -> Week 32, 2026-08-03..2026-08-09', () => {
    const week = deriveWeekFromParsedWorkbook(nightShiftFormatAFixture);
    assert.deepEqual(week, { weekNumber: 32, weekYear: 2026, weekStart: '2026-08-03', weekEnd: '2026-08-09' });
  });

  test('the same fixture with dateMismatch=false (no rollover) produces the identical Week -- dateMismatch has no effect either way', () => {
    const withMismatch = deriveWeekFromParsedWorkbook(nightShiftFormatAFixture);
    const withoutMismatch = deriveWeekFromParsedWorkbook({ ...nightShiftFormatAFixture, dateMismatch: false });
    assert.deepEqual(withMismatch, withoutMismatch);
  });

  test('missing canonical date (fileDate: null) remains blocked, regardless of dateMismatch', () => {
    assert.equal(deriveWeekFromParsedWorkbook({ ...nightShiftFormatAFixture, fileDate: null }), null);
    assert.equal(deriveWeekFromParsedWorkbook({ ...nightShiftFormatAFixture, fileDate: null, dateMismatch: false }), null);
  });

  test('invalid canonical date (an Invalid Date instance) remains blocked, regardless of dateMismatch', () => {
    const invalidDate = new Date('not-a-real-date');
    assert.equal(deriveWeekFromParsedWorkbook({ ...nightShiftFormatAFixture, fileDate: invalidDate }), null);
  });

  test('an explicitly unresolved workbook (no parsed result at all) remains blocked', () => {
    // The current parser architecture has exactly one way to signal "no
    // safe canonical date": fileDate is null/invalid. There is no separate
    // "unresolved" flag to introduce -- deriveWeekFromParsedWorkbook(null)
    // (no successfully parsed workbook yet, or a parse that threw) is the
    // genuinely-unresolved case, and it must still block.
    assert.equal(deriveWeekFromParsedWorkbook(null), null);
    assert.equal(deriveWeekFromParsedWorkbook(undefined), null);
  });

  test('ESG Format B (no dateMismatch involved in this file) remains Week 32 -- unaffected by this fix', () => {
    const formatBFixture = {
      buyer: 'ESG',
      workbookFormat: 'ESG_FORMAT_B',
      sheetName: 'DATA ORE 05 AGUSTUS 2026',
      fileDate: makeLocalDate(2026, 8, 5),
      dateMismatch: false,
    };
    assert.deepEqual(deriveWeekFromParsedWorkbook(formatBFixture), { weekNumber: 32, weekYear: 2026, weekStart: '2026-08-03', weekEnd: '2026-08-09' });
  });

  test('HYNC remains valid -- unaffected by this fix', () => {
    const hyncFixture = { workbookBuyer: 'HYNC', fileDate: parseFlexibleDate('2026-08-03'), dateMismatch: false };
    assert.deepEqual(deriveWeekFromParsedWorkbook(hyncFixture), { weekNumber: 32, weekYear: 2026, weekStart: '2026-08-03', weekEnd: '2026-08-09' });
  });

  test('SLNC remains valid -- unaffected by this fix (same shared parser/shape as HYNC)', () => {
    const slncFixture = { workbookBuyer: 'SLNC', fileDate: parseFlexibleDate('2026-08-03'), dateMismatch: false };
    assert.deepEqual(deriveWeekFromParsedWorkbook(slncFixture), { weekNumber: 32, weekYear: 2026, weekStart: '2026-08-03', weekEnd: '2026-08-09' });
  });

  test('HYNC/SLNC with a real dateMismatch=true (multiple 日期 values across rows) also still calculates Week', () => {
    const hyncMismatchFixture = { workbookBuyer: 'HYNC', fileDate: parseFlexibleDate('2026-08-03'), dateMismatch: true };
    assert.deepEqual(deriveWeekFromParsedWorkbook(hyncMismatchFixture), { weekNumber: 32, weekYear: 2026, weekStart: '2026-08-03', weekEnd: '2026-08-09' });
  });
});

describe('Profile integration -- each profile\'s real date-construction path feeds calculateIsoWeek() correctly', () => {
  test('HYNC/SLNC: shared-report-profile.js\'s parseFlexibleDate() (real 日期 column shape) -> calculateIsoWeek()', () => {
    // parseFlexibleDate's string branch matches the 'YYYY-MM-DD...' shape
    // SheetJS can produce for a date cell; this exercises the actual
    // function both HYNC and SLNC workbooks parse their file date through
    // (shared-report-profile.js's parseWeighbridgeWorkbook -> detectedDate).
    const fileDate = parseFlexibleDate('2026-08-03');
    assert.ok(fileDate instanceof Date && !isNaN(fileDate));
    const result = calculateIsoWeek(fileDate);
    assert.deepEqual(result, { weekNumber: 32, weekYear: 2026, weekStart: '2026-08-03', weekEnd: '2026-08-09' });
  });

  test('HYNC/SLNC: parseFlexibleDate() also accepts an already-parsed Date, unchanged', () => {
    const fileDate = parseFlexibleDate(localDate(2025, 12, 29));
    const result = calculateIsoWeek(fileDate);
    assert.deepEqual(result, { weekNumber: 1, weekYear: 2026, weekStart: '2025-12-29', weekEnd: '2026-01-04' });
  });

  test('HYNC/SLNC: an unparseable 日期 value produces a null fileDate, which calculateIsoWeek() safely rejects', () => {
    const fileDate = parseFlexibleDate('not a date at all');
    assert.equal(fileDate, null);
    assert.equal(calculateIsoWeek(fileDate), null);
  });

  test('ESG Format A: esg-adapter-utils.js\'s makeLocalDate() (real date+"Time Loaded" combination path) -> calculateIsoWeek()', () => {
    // Format A's adapter builds its row date via
    // makeLocalDate(dateParts.y, dateParts.m, dateParts.d) -- decoded from
    // an Excel date serial, independent of the "Time Loaded" time-of-day.
    const fileDate = makeLocalDate(2026, 8, 3);
    const result = calculateIsoWeek(fileDate);
    assert.deepEqual(result, { weekNumber: 32, weekYear: 2026, weekStart: '2026-08-03', weekEnd: '2026-08-09' });
  });

  test('ESG Format B: the same makeLocalDate() call shape Format B\'s adapter uses for its TANGGAL column -> calculateIsoWeek()', () => {
    // Format B builds its row date the same way: makeLocalDate(dateParts.y,
    // dateParts.m, dateParts.d) from TANGGAL, independent of the separate
    // JAM TIMBANG ISI timestamp used only for shift/loadedAt purposes.
    const fileDate = makeLocalDate(2025, 12, 29);
    const result = calculateIsoWeek(fileDate);
    assert.deepEqual(result, { weekNumber: 1, weekYear: 2026, weekStart: '2025-12-29', weekEnd: '2026-01-04' });
  });

  test('makeLocalDate() with genuinely non-numeric components returns null, which calculateIsoWeek() safely rejects', () => {
    // NOTE: JS's Date constructor *rolls over* out-of-range but numeric
    // components (e.g. day 31 of a 30-day month becomes the 1st of the
    // next month) rather than producing an invalid Date -- so that is NOT
    // a usable "invalid date" test case here. A genuinely invalid Date
    // only results from a non-numeric/NaN component, which is what
    // decodeExcelSerial() returning null upstream (an unparseable Excel
    // date serial) would translate into if ever passed through unguarded.
    const fileDate = makeLocalDate(NaN, NaN, NaN);
    assert.equal(fileDate, null);
    assert.equal(calculateIsoWeek(fileDate), null);
  });
});

// Mirrors exactly what report-page.js's applyWeekFromParsed() does to
// reportState (minus the DOM-touching renderWeekDisplay() call, which
// needs a real page and is covered by the manual regression checklist
// instead) -- real function, real state object, no DOM.
function applyWeekToState(parsed) {
  const week = deriveWeekFromParsedWorkbook(parsed);
  reportState.weekNumber = week ? week.weekNumber : null;
  reportState.weekYear = week ? week.weekYear : null;
  reportState.weekStart = week ? week.weekStart : null;
  reportState.weekEnd = week ? week.weekEnd : null;
}

describe('Report state -- Automatic Week fields', () => {
  test('replacing the workbook clears the previous Week before recalculating -- no stale value survives', () => {
    const workbookA = { fileDate: parseFlexibleDate('2026-08-03'), dateMismatch: false }; // week 32
    const workbookB = { fileDate: parseFlexibleDate('2026-01-05'), dateMismatch: false }; // week 2

    applyWeekToState(workbookA);
    assert.equal(reportState.weekNumber, 32);
    assert.equal(reportState.weekStart, '2026-08-03');

    applyWeekToState(workbookB);
    assert.equal(reportState.weekNumber, 2);
    assert.equal(reportState.weekStart, '2026-01-05');
    assert.equal(reportState.weekEnd, '2026-01-11'); // no residue from workbook A's 2026-08-09
  });

  test('replacing a valid workbook with a failed/undated one clears Week entirely -- never keeps the previous file\'s value', () => {
    const workbookA = { fileDate: parseFlexibleDate('2026-08-03'), dateMismatch: false };
    applyWeekToState(workbookA);
    assert.equal(reportState.weekNumber, 32);

    applyWeekToState(null); // failed parse / no valid date, mirroring handleFileChange()'s catch path
    assert.equal(reportState.weekNumber, null);
    assert.equal(reportState.weekYear, null);
    assert.equal(reportState.weekStart, null);
    assert.equal(reportState.weekEnd, null);
  });

  test('resetReportState() clears weekNumber/weekYear/weekStart/weekEnd to null', () => {
    // Simulate a previously-calculated Week (as report-page.js's
    // applyWeekFromParsed() would have set after a successful upload).
    reportState.weekNumber = 32;
    reportState.weekYear = 2026;
    reportState.weekStart = '2026-08-03';
    reportState.weekEnd = '2026-08-09';

    resetReportState();

    assert.equal(reportState.weekNumber, null);
    assert.equal(reportState.weekYear, null);
    assert.equal(reportState.weekStart, null);
    assert.equal(reportState.weekEnd, null);
  });

  test('createDefaultState() no longer exposes a manually-editable inputs.week field', () => {
    resetReportState();
    assert.equal('week' in reportState.inputs, false);
  });
});
