// V2.3 Report -- period-aware Daily/WTD/MTD/YTD accumulation.
//
// Run with Node's built-in test runner:
//   node --test tests/report-period-accumulation.test.mjs
//
// Confirmed bug: calculateTotals() previously accumulated WTD/MTD/YTD
// unconditionally (`prev.X + current`, no period-boundary check at all) --
// only Daily had a reset rule. This file proves each of the four buckets
// now resets independently at its own period boundary
// (report-utils.js's deriveAccumulationResets()/accumulatePeriodValue()),
// using calculateIsoWeek() as the sole ISO-week authority (never
// re-derived), and that the shared, buyer-agnostic calculateTotals() is
// what every Report profile (HYNC, SLNC, ESG Format A, ESG Format B) goes
// through -- there is no separate per-buyer accumulation rule to test.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  isSameCalendarDay,
  isSameIsoWeek,
  isSameCalendarMonth,
  isSameCalendarYear,
  accumulatePeriodValue,
  deriveAccumulationResets,
  findPreviousWeekMismatch,
  calculateIsoWeek,
} from '../js/pages/report/report-utils.js';
import { calculateTotals, parsePrevText } from '../js/pages/report/profiles/shared-report-profile.js';
import { calculateHyncTotals } from '../js/pages/report/profiles/hync-profile.js';
import { calculateSlncTotals } from '../js/pages/report/profiles/slnc-profile.js';

/* ============================================================
   FIXTURES
============================================================ */
function prevOf(date, overrides = {}) {
  return {
    date,
    week: null,
    daily: { ton: 0, rit: 0 },
    wtd: { ton: 200000, rit: 4000 },
    mtd: { ton: 500000, rit: 9000 },
    ytd: { ton: 7000000, rit: 100000 },
    ...overrides,
  };
}

function parsedOf(date, onShiftTon, onShiftRit, shiftLabel = 'Day Shift') {
  return { fileDate: date, shiftLabel, onShiftTon, onShiftRit };
}

/* ============================================================
   1-5, 9-10. CORE PERIOD BOUNDARY MATRIX
============================================================ */
describe('Independent period-reset matrix', () => {
  test('1. same day -> Daily continues (Night Shift, same calendar date)', () => {
    const prev = prevOf(new Date(2026, 7, 9), { daily: { ton: 1000, rit: 20 } });
    const parsed = parsedOf(new Date(2026, 7, 9), 500, 10, 'Night Shift');
    const t = calculateTotals({ parsed, prev });
    assert.equal(t.isNightContinuation, true);
    assert.equal(t.dailyTon, 1500);
    assert.equal(t.dailyRit, 30);
  });

  test('2. next day, same ISO week -> Daily resets, WTD continues', () => {
    // 2026-08-10 and 2026-08-11 both fall in ISO week 33/2026 (Mon 08-10 - Sun 08-16).
    assert.equal(isSameIsoWeek(new Date(2026, 7, 10), new Date(2026, 7, 11)), true);
    const prev = prevOf(new Date(2026, 7, 10), { daily: { ton: 1000, rit: 20 } });
    const parsed = parsedOf(new Date(2026, 7, 11), 500, 10, 'Day Shift');
    const t = calculateTotals({ parsed, prev });
    assert.equal(t.dailyTon, 500); // reset -- Day Shift always resets regardless of date
    assert.equal(t.periodResets.resetWtd, false);
    assert.equal(t.wtdTon, 200500);
  });

  test('3. new ISO week, same month -> WTD resets, MTD continues', () => {
    const prev = prevOf(new Date(2026, 7, 9)); // Week 32
    const parsed = parsedOf(new Date(2026, 7, 10), 20000, 400); // Week 33, still August
    const t = calculateTotals({ parsed, prev });
    assert.equal(t.periodResets.resetWtd, true);
    assert.equal(t.wtdTon, 20000);
    assert.equal(t.periodResets.resetMtd, false);
    assert.equal(t.mtdTon, 520000);
  });

  test('4. new month, same year -> MTD resets, YTD continues', () => {
    const prev = prevOf(new Date(2026, 7, 31), { mtd: { ton: 520000, rit: 9000 } });
    const parsed = parsedOf(new Date(2026, 8, 1), 18000, 300);
    const t = calculateTotals({ parsed, prev });
    assert.equal(t.periodResets.resetMtd, true);
    assert.equal(t.mtdTon, 18000);
    assert.equal(t.periodResets.resetYtd, false);
    assert.equal(t.ytdTon, 7018000);
  });

  test('5. new year -> WTD/MTD/YTD all reset (clean ISO-week-changing year boundary)', () => {
    // 2028-12-31 (Sun) is ISO week 52/2028; 2029-01-01 (Mon) is ISO week 1/2029 -- a genuine week reset too.
    const prev = prevOf(new Date(2028, 11, 31));
    const parsed = parsedOf(new Date(2029, 0, 1), 20000, 500);
    const t = calculateTotals({ parsed, prev });
    assert.deepEqual(t.periodResets, { resetDaily: true, resetWtd: true, resetMtd: true, resetYtd: true });
    assert.equal(t.wtdTon, 20000);
    assert.equal(t.mtdTon, 20000);
    assert.equal(t.ytdTon, 20000);
  });

  test('9. same month but different year resets MTD', () => {
    const prev = prevOf(new Date(2025, 7, 15), { mtd: { ton: 300000, rit: 5000 } });
    const parsed = parsedOf(new Date(2026, 7, 15), 10000, 200);
    const t = calculateTotals({ parsed, prev });
    assert.equal(t.periodResets.resetMtd, true);
    assert.equal(t.mtdTon, 10000);
  });

  test('10. same year across a month boundary preserves YTD', () => {
    const prev = prevOf(new Date(2026, 0, 31), { ytd: { ton: 999999, rit: 15000 } });
    const parsed = parsedOf(new Date(2026, 1, 1), 1, 1);
    const t = calculateTotals({ parsed, prev });
    assert.equal(t.periodResets.resetYtd, false);
    assert.equal(t.ytdTon, 1000000);
  });
});

/* ============================================================
   6-8. ISO WEEK-YEAR IDENTITY
============================================================ */
describe('ISO week-year identity (weekNumber + weekYear together, never weekNumber alone)', () => {
  test('6. ISO week-year boundary: week 53/2026 -> week 1/2027 resets WTD', () => {
    // 2027-01-03 is still ISO week 53/2026; 2027-01-04 is ISO week 1/2027 -- confirmed via calculateIsoWeek().
    assert.deepEqual(calculateIsoWeek(new Date(2027, 0, 3)), { weekNumber: 53, weekYear: 2026, weekStart: '2026-12-28', weekEnd: '2027-01-03' });
    assert.deepEqual(calculateIsoWeek(new Date(2027, 0, 4)), { weekNumber: 1, weekYear: 2027, weekStart: '2027-01-04', weekEnd: '2027-01-10' });
    const prev = prevOf(new Date(2027, 0, 3));
    const parsed = parsedOf(new Date(2027, 0, 4), 15000, 300);
    const t = calculateTotals({ parsed, prev });
    assert.equal(t.periodResets.resetWtd, true);
    assert.equal(t.wtdTon, 15000);
  });

  test('7. same displayed week number (1) but different ISO week-year resets WTD', () => {
    assert.equal(calculateIsoWeek(new Date(2026, 0, 1)).weekNumber, 1);
    assert.equal(calculateIsoWeek(new Date(2026, 0, 1)).weekYear, 2026);
    assert.equal(calculateIsoWeek(new Date(2027, 0, 6)).weekNumber, 1);
    assert.equal(calculateIsoWeek(new Date(2027, 0, 6)).weekYear, 2027);
    assert.equal(isSameIsoWeek(new Date(2026, 0, 1), new Date(2027, 0, 6)), false);
    const prev = prevOf(new Date(2026, 0, 1));
    const parsed = parsedOf(new Date(2027, 0, 6), 5000, 100);
    const t = calculateTotals({ parsed, prev });
    assert.equal(t.periodResets.resetWtd, true);
    assert.equal(t.wtdTon, 5000);
  });

  test('8. previous report Date is canonical over an inconsistent pasted Week -- WTD reset decision follows the Date, not the stale Week text', () => {
    // Previous report's Date is 2026-08-09 (Week 32), but its pasted "Week" line was hand-edited/stale to say 99.
    const prevText = [
      'Date    : 9 Agustus 2026',
      'Week  : 99',
      'Daily         : 100,00 wmt [ 1 Rit ]',
      'WTD         : 200.000,00 wmt [ 4.000 Rit ]',
      'MTD         : 500.000,00 wmt [ 9.000 Rit ]',
      'YTD          : 7.000.000,00 wmt [ 100.000 Rit ]',
    ].join('\n');
    const prev = parsePrevText(prevText);
    assert.equal(prev.errors.length, 0);
    assert.equal(prev.week, 99);
    // Same ISO week as the workbook (Week 32, 2026-08-09) -- WTD continues,
    // decided purely from prev.date, never from the bogus prev.week=99.
    const parsed = parsedOf(new Date(2026, 7, 9), 500, 10, 'Night Shift');
    const t = calculateTotals({ parsed, prev });
    assert.equal(t.periodResets.resetWtd, false);
    assert.equal(t.wtdTon, 200500);
    // The mismatch itself is still detectable for a caller that wants to warn about it.
    const mismatch = findPreviousWeekMismatch(prev.date, prev.week);
    assert.deepEqual(mismatch, { displayedWeek: 99, calculatedWeek: 32 });
  });

  test('findPreviousWeekMismatch returns null when the previous Week matches, or when there is nothing to compare', () => {
    assert.equal(findPreviousWeekMismatch(new Date(2026, 7, 9), 32), null); // matches
    assert.equal(findPreviousWeekMismatch(new Date(2026, 7, 9), null), null); // no previous Week parsed
    assert.equal(findPreviousWeekMismatch(null, 32), null); // no previous Date
    assert.equal(findPreviousWeekMismatch(new Date(NaN), 32), null); // invalid previous Date
  });
});

/* ============================================================
   MANDATORY DATE CASES
============================================================ */
describe('Mandatory date cases', () => {
  test('2026-08-09 -> 2026-08-10 (Week 32 -> Week 33): Daily reset, WTD reset, MTD continue, YTD continue', () => {
    const prev = prevOf(new Date(2026, 7, 9));
    const parsed = parsedOf(new Date(2026, 7, 10), 20000, 400);
    const t = calculateTotals({ parsed, prev });
    assert.equal(t.dailyTon, 20000); // Day Shift always resets
    assert.equal(t.periodResets.resetWtd, true);
    assert.equal(t.wtdTon, 20000);
    assert.equal(t.periodResets.resetMtd, false);
    assert.equal(t.mtdTon, 520000);
    assert.equal(t.periodResets.resetYtd, false);
    assert.equal(t.ytdTon, 7020000);
  });

  test('2026-08-31 -> 2026-09-01: Daily reset, WTD follows the actual ISO comparison (continues here), MTD reset, YTD continue', () => {
    assert.equal(isSameIsoWeek(new Date(2026, 7, 31), new Date(2026, 8, 1)), true); // both fall in the same ISO week
    const prev = prevOf(new Date(2026, 7, 31), { mtd: { ton: 520000, rit: 9000 } });
    const parsed = parsedOf(new Date(2026, 8, 1), 18000, 300);
    const t = calculateTotals({ parsed, prev });
    assert.equal(t.dailyTon, 18000);
    assert.equal(t.periodResets.resetWtd, false);
    assert.equal(t.wtdTon, 218000);
    assert.equal(t.periodResets.resetMtd, true);
    assert.equal(t.mtdTon, 18000);
    assert.equal(t.periodResets.resetYtd, false);
    assert.equal(t.ytdTon, 7018000);
  });

  test('2026-12-31 -> 2027-01-01: Daily reset, MTD reset, YTD reset -- WTD does NOT reset (ISO edge case: still the same ISO week-year, 53/2026)', () => {
    assert.equal(isSameIsoWeek(new Date(2026, 11, 31), new Date(2027, 0, 1)), true);
    const prev = prevOf(new Date(2026, 11, 31), { mtd: { ton: 200000, rit: 3000 }, ytd: { ton: 7900000, rit: 150000 } });
    const parsed = parsedOf(new Date(2027, 0, 1), 20000, 500);
    const t = calculateTotals({ parsed, prev });
    assert.equal(t.dailyTon, 20000);
    assert.equal(t.periodResets.resetWtd, false); // the ISO edge case: calendar year changed, ISO week-year did not
    assert.equal(t.wtdTon, 220000);
    assert.equal(t.periodResets.resetMtd, true);
    assert.equal(t.mtdTon, 20000);
    assert.equal(t.periodResets.resetYtd, true);
    assert.equal(t.ytdTon, 20000);
  });

  test('ISO edge case, explicit: a calendar-year change alone must never be assumed to mean an ISO-week reset without consulting calculateIsoWeek()', () => {
    // Same pair as above, verified directly against the authoritative ISO-week utility rather than assumed from the calendar year change.
    const a = calculateIsoWeek(new Date(2026, 11, 31));
    const b = calculateIsoWeek(new Date(2027, 0, 1));
    assert.equal(a.weekNumber, 53);
    assert.equal(a.weekYear, 2026);
    assert.equal(b.weekNumber, 53);
    assert.equal(b.weekYear, 2026);
    assert.deepEqual(deriveAccumulationResets(new Date(2026, 11, 31), new Date(2027, 0, 1)), {
      resetDaily: true, resetWtd: false, resetMtd: true, resetYtd: true,
    });
  });
});

/* ============================================================
   11-14. TONNAGE AND RIT RESET TOGETHER
============================================================ */
describe('Tonnage and Rit reset together for every bucket, never independently', () => {
  test('11. WTD tonnage and Rit both reset together', () => {
    const prev = prevOf(new Date(2026, 7, 9), { wtd: { ton: 123384.11, rit: 2610 } });
    const parsed = parsedOf(new Date(2026, 7, 16), 21594.72, 447); // new ISO week
    const t = calculateTotals({ parsed, prev });
    assert.equal(t.periodResets.resetWtd, true);
    assert.equal(t.wtdTon, 21594.72);
    assert.equal(t.wtdRit, 447);
  });

  test('11b. WTD tonnage and Rit both continue together within the same ISO week', () => {
    const prev = prevOf(new Date(2026, 7, 10), { wtd: { ton: 123384.11, rit: 2610 } });
    const parsed = parsedOf(new Date(2026, 7, 11), 21594.72, 447); // same ISO week (33/2026)
    const t = calculateTotals({ parsed, prev });
    assert.equal(t.periodResets.resetWtd, false);
    assert.ok(Math.abs(t.wtdTon - 144978.83) < 1e-9);
    assert.equal(t.wtdRit, 3057);
  });

  test('12. MTD tonnage and Rit both reset together', () => {
    const prev = prevOf(new Date(2026, 7, 31), { mtd: { ton: 999999, rit: 12345 } });
    const parsed = parsedOf(new Date(2026, 8, 1), 18000, 300);
    const t = calculateTotals({ parsed, prev });
    assert.equal(t.mtdTon, 18000);
    assert.equal(t.mtdRit, 300);
  });

  test('13. YTD tonnage and Rit both reset together', () => {
    const prev = prevOf(new Date(2026, 11, 31), { ytd: { ton: 7900000, rit: 150000 } });
    const parsed = parsedOf(new Date(2027, 0, 10), 20000, 500); // clean new ISO year too, past the week-53 edge
    const t = calculateTotals({ parsed, prev });
    assert.equal(t.ytdTon, 20000);
    assert.equal(t.ytdRit, 500);
  });

  test('14. Daily tonnage and Rit both reset together (Day Shift)', () => {
    const prev = prevOf(new Date(2026, 7, 9), { daily: { ton: 999, rit: 88 } });
    const parsed = parsedOf(new Date(2026, 7, 9), 500, 10, 'Day Shift');
    const t = calculateTotals({ parsed, prev });
    assert.equal(t.dailyTon, 500);
    assert.equal(t.dailyRit, 10);
  });
});

/* ============================================================
   15-16. RESET USES CURRENT ON SHIFT, NEVER A LITERAL ZERO
============================================================ */
describe('A reset bucket always equals the current On Shift value, never a literal zero unless On Shift itself is zero', () => {
  test('15. reset uses current On Shift, not zero', () => {
    const prev = prevOf(new Date(2026, 7, 9));
    const parsed = parsedOf(new Date(2026, 7, 10), 12345.67, 89);
    const t = calculateTotals({ parsed, prev });
    assert.equal(t.wtdTon, 12345.67);
    assert.equal(t.wtdRit, 89);
    assert.notEqual(t.wtdTon, 0);
  });

  test('16. zero On Shift remains zero correctly (a genuine zero is not confused with "no reset happened")', () => {
    const prev = prevOf(new Date(2026, 7, 9), { wtd: { ton: 500, rit: 5 } });
    const parsed = parsedOf(new Date(2026, 7, 16), 0, 0); // new ISO week, zero On Shift
    const t = calculateTotals({ parsed, prev });
    assert.equal(t.periodResets.resetWtd, true);
    assert.equal(t.wtdTon, 0);
    assert.equal(t.wtdRit, 0);
  });

  test('accumulatePeriodValue itself: continues on true, restarts at currentValue on false', () => {
    assert.equal(accumulatePeriodValue(100, 50, true), 150);
    assert.equal(accumulatePeriodValue(100, 50, false), 50);
    assert.equal(accumulatePeriodValue(100, 0, false), 0);
  });
});

/* ============================================================
   17-20. BUYER COVERAGE -- ONE SHARED PERIOD LOGIC
============================================================ */
describe('Every buyer profile shares the exact same period-reset logic (no separate per-buyer accumulation rule)', () => {
  const prev = prevOf(new Date(2026, 7, 9));
  const parsed = parsedOf(new Date(2026, 7, 10), 20000, 400); // new ISO week

  test('17. HYNC (calculateHyncTotals) delegates to the shared calculateTotals, same reset behavior', () => {
    const t = calculateHyncTotals({ parsed, prev });
    assert.equal(t.periodResets.resetWtd, true);
    assert.equal(t.wtdTon, 20000);
  });

  test('18. SLNC (calculateSlncTotals) delegates to the shared calculateTotals, same reset behavior', () => {
    const t = calculateSlncTotals({ parsed, prev });
    assert.equal(t.periodResets.resetWtd, true);
    assert.equal(t.wtdTon, 20000);
  });

  test('19. EIEB internal ESG Format A workbook shape uses the exact same shared calculateTotals (no separate ESG accumulation function exists)', () => {
    // esg-profile.js's buildEsgParsedResult() produces the same {fileDate, shiftLabel, onShiftTon, onShiftRit} fields calculateTotals() reads, regardless of workbookFormat -- simulated here directly since parsing itself requires the browser XLSX global.
    const esgParsedFormatA = { ...parsed, workbookFormat: 'ESG_FORMAT_A' };
    const t = calculateTotals({ parsed: esgParsedFormatA, prev });
    assert.equal(t.periodResets.resetWtd, true);
    assert.equal(t.wtdTon, 20000);
  });

  test('20. EIEB internal ESG Format B workbook shape uses the exact same shared calculateTotals', () => {
    const esgParsedFormatB = { ...parsed, workbookFormat: 'ESG_FORMAT_B' };
    const t = calculateTotals({ parsed: esgParsedFormatB, prev });
    assert.equal(t.periodResets.resetWtd, true);
    assert.equal(t.wtdTon, 20000);
  });
});

/* ============================================================
   PURE HELPER UNIT COVERAGE
============================================================ */
describe('Pure period helpers -- null/invalid safety', () => {
  test('every comparison helper treats a missing/invalid date as "not the same period"', () => {
    assert.equal(isSameCalendarDay(null, new Date()), false);
    assert.equal(isSameIsoWeek(null, new Date()), false);
    assert.equal(isSameCalendarMonth(null, new Date()), false);
    assert.equal(isSameCalendarYear(null, new Date()), false);
    assert.equal(isSameCalendarDay(new Date(NaN), new Date()), false);
    assert.equal(isSameIsoWeek(new Date(NaN), new Date()), false);
  });

  test('deriveAccumulationResets with no previous date resets every bucket (first report / empty previous report)', () => {
    assert.deepEqual(deriveAccumulationResets(null, new Date(2026, 7, 9)), {
      resetDaily: true, resetWtd: true, resetMtd: true, resetYtd: true,
    });
  });

  test('calculateTotals with a null previous date (empty ESG previous report) resets every bucket to On Shift alone', () => {
    const prev = prevOf(null);
    const parsed = parsedOf(new Date(2026, 7, 9), 30000, 600, 'Day Shift');
    const t = calculateTotals({ parsed, prev });
    assert.equal(t.dailyTon, 30000);
    assert.equal(t.wtdTon, 30000);
    assert.equal(t.mtdTon, 30000);
    assert.equal(t.ytdTon, 30000);
  });
});
