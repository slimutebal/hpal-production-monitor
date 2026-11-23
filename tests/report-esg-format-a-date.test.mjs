// ESG Format A -- Date column parsing (numeric Excel serial AND "DD/MM/YYYY"
// strings) and the Night Shift date-rollover case that exposed the defect.
//
// Background: real Format A weighbridge files (e.g. "DATA TIMBANGAN 22
// NOVEMBER 2026 SHIFT 2.xlsx") store the Date column as text ("22/11/2026"),
// not as an Excel serial. The adapter used to accept only numbers, so every
// row failed validation, parsed.fileDate became null and the automatic Week
// showed "-".
//
// These tests run the REAL shipped parser. The browser-only SheetJS global
// is supplied from the repo's own vendored build (assets/vendor/xlsx.min.js)
// so workbooks are built and re-read exactly as the app does -- string cells
// stay strings, numeric cells stay numbers. The synthetic fixture mirrors
// the verified production workbook's structure (sheet "WS 221126 S2",
// header rows 15-16, data from row 18, Date = D, Time Loaded = E,
// Cargo Weighing = I, Kode Sample = J, Kode Dome = K, 141 rows on
// 22/11/2026 + 120 rows on 23/11/2026, 13,668.00 wmt). The production
// workbook itself is NOT used here.

import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
globalThis.XLSX = require('../assets/vendor/xlsx.min.js');

import { parseEsgDate } from '../js/pages/report/profiles/adapters/esg-format-a-adapter.js';
import { parseEsgWorkbook } from '../js/pages/report/profiles/esg-profile.js';
import { calculateTotals } from '../js/pages/report/profiles/shared-report-profile.js';
import { calculateIsoWeek, deriveWeekFromParsedWorkbook } from '../js/pages/report/report-utils.js';

/* ============================================================
   HELPERS
============================================================ */
// Independent Excel serial calculation (days since 1899-12-30), so the
// numeric-date test does not depend on the code under test.
function excelSerial(y, m, d) {
  return Math.round((Date.UTC(y, m - 1, d) - Date.UTC(1899, 11, 30)) / 86400000);
}

const NIGHT_SHIFT_ROWS = { onDay1: 141, onDay2: 120 };

// Builds a Format A workbook. `dateFor(i)` returns the Date cell value for
// data row i (0-based). Times alternate between 18:00-22:59 (day 1) and
// 00:00-04:59 (day 2) so every row is a valid Night Shift timestamp.
function buildFormatAWorkbook({ dateCells, rowCount = dateCells.length, weights, sellingCode = (i) => (i % 3 === 2 ? 'SCGEN-00002' : 'SCGEN-00001') }) {
  const aoa = [];
  for (let r = 0; r < 14; r++) aoa.push([]);
  aoa[7] = ['', '', 'Port : Stockpile ESG'];
  // Row 15 / 16 (1-based): two-row header, Kode Sample sits on row 15.
  aoa.push(['No', '', 'Vehicle No', 'Date', '', '', '', '', '', 'Kode Sample', 'Kode Dome']);
  aoa.push(['', '', '', '', 'Time Loaded', '', '', '', 'Cargo Weighing', '', '']);
  aoa.push([]); // row 17: blank
  for (let i = 0; i < rowCount; i++) {
    const hour = i < NIGHT_SHIFT_ROWS.onDay1 ? 18 + (i % 5) : (i % 5);
    const minute = (i * 7) % 60;
    aoa.push([
      i + 1, '', `SCM-${String(1000 + i)}`, dateCells[i],
      (hour * 60 + minute) / 1440, '', '', '', weights[i], sellingCode(i), 'L21-01 ( NI:1.25 )',
    ]);
  }
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'WS 221126 S2');
  // Round-trip through the file format, as an uploaded .xlsx would be.
  return XLSX.read(XLSX.write(wb, { type: 'array', bookType: 'xlsx' }), { type: 'array' });
}

// 261 integer-ton weights totalling exactly 13,668 t.
function productionWeights() {
  const total = NIGHT_SHIFT_ROWS.onDay1 + NIGHT_SHIFT_ROWS.onDay2;
  const w = new Array(total).fill(52);
  for (let i = 0; i < 13668 - 52 * total; i++) w[i] = 53;
  return w;
}

function stringDateCells() {
  return [
    ...new Array(NIGHT_SHIFT_ROWS.onDay1).fill('22/11/2026'),
    ...new Array(NIGHT_SHIFT_ROWS.onDay2).fill('23/11/2026'),
  ];
}

const PREV_DAY_SHIFT = {
  date: new Date(2026, 10, 22),
  daily: { ton: 14023.90, rit: 0 },
  wtd: { ton: 174005.31, rit: 0 },
  mtd: { ton: 952915.31, rit: 0 },
  ytdDap: { ton: 7782804.66, rit: 0 },
  ytdExw: { ton: 2429899.98, rit: 0 },
};

const ymd = (d) => [d.getFullYear(), d.getMonth() + 1, d.getDate()];

/* ============================================================
   GROUP A -- DATE PARSING
============================================================ */
describe('Group A: parseEsgDate', () => {
  test('numeric Excel serial still decodes', () => {
    const p = parseEsgDate(excelSerial(2026, 11, 22));
    assert.deepEqual([p.y, p.m, p.d], [2026, 11, 22]);
  });

  test('numeric serial 46348 decodes through the unchanged decodeExcelSerial path', () => {
    const p = parseEsgDate(46348);
    assert.deepEqual([p.y, p.m, p.d], [2026, 11, 22]);
  });

  test('"22/11/2026" -> 22 November 2026 (DD/MM, never MM/DD)', () => {
    const p = parseEsgDate('22/11/2026');
    assert.deepEqual([p.y, p.m, p.d], [2026, 11, 22]);
  });

  test('"23/11/2026" -> 23 November 2026', () => {
    const p = parseEsgDate('23/11/2026');
    assert.deepEqual([p.y, p.m, p.d], [2026, 11, 23]);
  });

  test('ambiguous day/month values are read as DD/MM', () => {
    const p = parseEsgDate('03/04/2026');
    assert.deepEqual([p.y, p.m, p.d], [2026, 4, 3]);
  });

  test('surrounding whitespace is trimmed', () => {
    const p = parseEsgDate(' 22/11/2026 ');
    assert.deepEqual([p.y, p.m, p.d], [2026, 11, 22]);
  });

  test('leap day 29/02/2024 is valid', () => {
    const p = parseEsgDate('29/02/2024');
    assert.deepEqual([p.y, p.m, p.d], [2024, 2, 29]);
  });

  test('century rule: 29/02/2000 valid, 29/02/2100 invalid', () => {
    assert.notEqual(parseEsgDate('29/02/2000'), null);
    assert.equal(parseEsgDate('29/02/2100'), null);
  });

  for (const bad of ['29/02/2026', '31/02/2026', '31/04/2026', '32/11/2026', '00/11/2026', '22/13/2026', '22/00/2026', '', '   ', 'not a date', '2026-11-22', '22-11-2026', '22/11/26', '22/11/2026 10:00']) {
    test(`invalid value ${JSON.stringify(bad)} -> null (not normalized by JS Date rollover)`, () => {
      assert.equal(parseEsgDate(bad), null);
    });
  }

  test('non-string/non-number values -> null', () => {
    assert.equal(parseEsgDate(null), null);
    assert.equal(parseEsgDate(undefined), null);
    assert.equal(parseEsgDate(NaN), null);
    assert.equal(parseEsgDate(new Date(2026, 10, 22)), null);
  });
});

/* ============================================================
   GROUP B -- NIGHT SHIFT ROLLOVER (string dates)
============================================================ */
describe('Group B: Night Shift rollover fixture (141 x 22/11 + 120 x 23/11, string dates)', () => {
  let parsed;
  before(() => {
    parsed = parseEsgWorkbook(buildFormatAWorkbook({ dateCells: stringDateCells(), weights: productionWeights() }));
  });

  test('the fixture really stores string dates', () => {
    const wb = buildFormatAWorkbook({ dateCells: stringDateCells(), weights: productionWeights() });
    const matrix = XLSX.utils.sheet_to_json(wb.Sheets['WS 221126 S2'], { header: 1, raw: true, defval: '' });
    assert.equal(typeof matrix[17][3], 'string');
    assert.equal(matrix[17][3], '22/11/2026');
  });

  test('261 valid records, no issues', () => {
    assert.equal(parsed.workbookFormat, 'ESG_FORMAT_A');
    assert.equal(parsed.records.length, 261);
    assert.equal(parsed.onShiftRit, 261);
    assert.deepEqual(parsed.issues, []);
  });

  test('tonnage and ritase unchanged: 13,668.00 wmt / 261', () => {
    assert.equal(parsed.onShiftTon, 13668);
  });

  test('report date is the FIRST transaction date: 22 November 2026', () => {
    assert.deepEqual(ymd(parsed.fileDate), [2026, 11, 22]);
  });

  test('Shift = Night Shift', () => {
    assert.equal(parsed.shiftLabel, 'Night Shift');
  });

  test('two calendar dates raise dateMismatch but do not invalidate Week', () => {
    assert.equal(parsed.dateMismatch, true);
    const week = deriveWeekFromParsedWorkbook(parsed);
    assert.notEqual(week, null);
    assert.equal(week.weekNumber, 47);
    assert.equal(week.weekYear, 2026);
    assert.equal(week.weekStart, '2026-11-16');
    assert.equal(week.weekEnd, '2026-11-22');
  });

  test('ISO week boundary: 22/11/2026 -> 47, 23/11/2026 -> 48 (rollover must not leak Week 48)', () => {
    assert.equal(calculateIsoWeek(new Date(2026, 10, 22)).weekNumber, 47);
    assert.equal(calculateIsoWeek(new Date(2026, 10, 23)).weekNumber, 48);
  });

  test('row timestamps keep their own calendar date (23/11 rows are loaded on 23 Nov)', () => {
    const last = parsed.records[parsed.records.length - 1].grossTime;
    assert.deepEqual(ymd(last), [2026, 11, 23]);
    const first = parsed.records[0].grossTime;
    assert.deepEqual(ymd(first), [2026, 11, 22]);
  });
});

/* ============================================================
   GROUP C -- EXISTING BEHAVIOR
============================================================ */
describe('Group C: existing behavior preserved', () => {
  test('numeric Excel serial dates still parse end to end', () => {
    const serial22 = excelSerial(2026, 11, 22);
    const serial23 = excelSerial(2026, 11, 23);
    const dateCells = [
      ...new Array(NIGHT_SHIFT_ROWS.onDay1).fill(serial22),
      ...new Array(NIGHT_SHIFT_ROWS.onDay2).fill(serial23),
    ];
    const parsed = parseEsgWorkbook(buildFormatAWorkbook({ dateCells, weights: productionWeights() }));
    assert.equal(parsed.records.length, 261);
    assert.equal(parsed.onShiftTon, 13668);
    assert.deepEqual(ymd(parsed.fileDate), [2026, 11, 22]);
    assert.equal(parsed.dateMismatch, true);
    assert.equal(deriveWeekFromParsedWorkbook(parsed).weekNumber, 47);
  });

  test('mixed numeric + string dates in one file both parse', () => {
    const dateCells = [excelSerial(2026, 11, 22), '22/11/2026', '23/11/2026', excelSerial(2026, 11, 23)];
    const parsed = parseEsgWorkbook(buildFormatAWorkbook({ dateCells, weights: [10, 20, 30, 40] }));
    assert.equal(parsed.records.length, 4);
    assert.equal(parsed.onShiftTon, 100);
  });

  test('a single-date file has no dateMismatch warning', () => {
    const parsed = parseEsgWorkbook(buildFormatAWorkbook({ dateCells: ['22/11/2026', '22/11/2026'], weights: [10, 20] }));
    assert.equal(parsed.dateMismatch, false);
    assert.equal(parsed.records.length, 2);
  });

  test('an impossible string date is NOT rolled over: the row is rejected with an invalid-date issue', () => {
    const parsed = parseEsgWorkbook(buildFormatAWorkbook({ dateCells: ['22/11/2026', '31/02/2026', 'garbage', ''], weights: [10, 20, 30, 40] }));
    assert.equal(parsed.records.length, 1);
    assert.equal(parsed.onShiftTon, 10);
    const dateIssues = parsed.issues.filter((i) => i.type === 'invalid-date' || i.code === 'invalid-date');
    assert.equal(dateIssues.length, 3);
    assert.deepEqual(ymd(parsed.fileDate), [2026, 11, 22]);
  });

  test('a file whose dates are ALL unparseable yields no fileDate (no system-date fallback) and no Week', () => {
    const parsed = parseEsgWorkbook(buildFormatAWorkbook({ dateCells: ['31/02/2026', 'x'], weights: [10, 20] }));
    assert.equal(parsed.records.length, 0);
    assert.equal(parsed.fileDate, null);
    assert.equal(deriveWeekFromParsedWorkbook(parsed), null);
  });

  test('other validation (non-positive weight) is unchanged', () => {
    const parsed = parseEsgWorkbook(buildFormatAWorkbook({ dateCells: ['22/11/2026', '22/11/2026'], weights: [10, 0] }));
    assert.equal(parsed.records.length, 1);
    assert.ok(parsed.issues.some((i) => (i.type || i.code) === 'non-positive-weight'));
  });
});

/* ============================================================
   GROUP D -- PREVIOUS REPORT ACCUMULATION
   Depends on the SCGEN delivery-term support (separate task, currently an
   uncommitted change in report-utils.js): without it deliveryTerm would be
   null and YTD DAP would not move.
============================================================ */
describe('Group D: Night Shift accumulation on top of the 22 Nov Day Shift report', () => {
  test('Daily / WTD / MTD / YTD DAP / YTD EXW', () => {
    const parsed = parseEsgWorkbook(buildFormatAWorkbook({ dateCells: stringDateCells(), weights: productionWeights() }));
    assert.equal(parsed.deliveryTerm, 'DAP');
    const t = calculateTotals({ parsed, prev: PREV_DAY_SHIFT });
    const r2 = (n) => Math.round(n * 100) / 100;
    assert.equal(r2(parsed.onShiftTon), 13668);
    assert.equal(r2(t.dailyTon), 27691.90);
    assert.equal(r2(t.wtdTon), 187673.31);
    assert.equal(r2(t.mtdTon), 966583.31);
    assert.equal(r2(t.ytdDapTon), 7796472.66);
    assert.equal(r2(t.ytdExwTon), 2429899.98);
    assert.equal(t.isNightContinuation, true);
  });
});
