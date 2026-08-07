// Shift classification bug fix tests.
//
// Run with Node's built-in test runner (Node 18+, zero new dependencies):
//
//   node --test tests/report-shift.test.mjs
//
// Imports report-utils.js's classifyShift() directly -- the single shared,
// pure, DOM-free utility every Report profile (HYNC, SLNC, ESG Format A,
// ESG Format B) now feeds its full set of valid timestamps into. See that
// function's header comment for the confirmed root cause of the Owner's
// reported bug (06-08-2026 PAGI A.xlsx misclassified as Night Shift) and
// the two buyer-specific day-window boundaries it preserves.
//
// The operational .xlsx workbook that reproduced the bug is never
// committed here -- every fixture below is a sanitized, synthetic
// timestamp array reproducing the same *shape* of the bug (an early,
// boundary-adjacent minority sample vs. an overwhelming full-dataset
// majority), not the real file's contents.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { classifyShift } from '../js/pages/report/report-utils.js';

// HYNC/SLNC's documented window (shared-report-profile.js,
// docs/V2.1_HYNC_SLNC_REPORT_ARCHITECTURE.md Section 12): 05:01-17:00,
// inclusive at both ends.
const HYNC_SLNC_WINDOW = { dayStartSec: 5 * 3600 + 60, dayEndSec: 17 * 3600, dayEndInclusive: true };
// ESG's window (esg-profile.js) is classifyShift()'s default: 05:00
// inclusive - 17:00 exclusive. No options object needed for ESG fixtures.

// Arbitrary fixed calendar date -- classifyShift() only reads time-of-day
// (getHours/getMinutes/getSeconds), so the date component is irrelevant to
// every assertion below; kept constant so fixtures stay easy to read.
function at(h, m = 0, s = 0) {
  return new Date(2026, 7, 6, h, m, s);
}

function shuffle(array, seed) {
  // Deterministic shuffle (no Math.random) so a failing test is
  // reproducible: a simple seeded swap pattern is enough to reorder the
  // array without depending on external randomness.
  const out = array.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = (i * 7 + seed) % (i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

describe('classifyShift() -- full-dataset majority vote', () => {
  test('1. all Day rows -> Day Shift', () => {
    const result = classifyShift([at(6), at(9), at(12), at(16, 59)], HYNC_SLNC_WINDOW);
    assert.equal(result.shiftLabel, 'Day Shift');
    assert.equal(result.status, 'resolved');
    assert.equal(result.dayCount, 4);
    assert.equal(result.nightCount, 0);
    assert.equal(result.totalValid, 4);
  });

  test('2. all Night rows -> Night Shift', () => {
    const result = classifyShift([at(18), at(20), at(23), at(2), at(4)], HYNC_SLNC_WINDOW);
    assert.equal(result.shiftLabel, 'Night Shift');
    assert.equal(result.status, 'resolved');
    assert.equal(result.dayCount, 0);
    assert.equal(result.nightCount, 5);
  });

  test('3. first 10 rows Night, remaining majority Day -> Day Shift', () => {
    const nightFirst10 = Array.from({ length: 10 }, (_, i) => at(2, i));
    const dayMajority = Array.from({ length: 40 }, (_, i) => at(8 + (i % 8), i % 60));
    const result = classifyShift([...nightFirst10, ...dayMajority], HYNC_SLNC_WINDOW);
    assert.equal(result.shiftLabel, 'Day Shift');
    assert.equal(result.dayCount, 40);
    assert.equal(result.nightCount, 10);
  });

  test('4. first 10 rows Day, remaining majority Night -> Night Shift', () => {
    const dayFirst10 = Array.from({ length: 10 }, (_, i) => at(10, i));
    const nightMajority = Array.from({ length: 40 }, (_, i) => at(18 + (i % 6), i % 60));
    const result = classifyShift([...dayFirst10, ...nightMajority], HYNC_SLNC_WINDOW);
    assert.equal(result.shiftLabel, 'Night Shift');
    assert.equal(result.dayCount, 10);
    assert.equal(result.nightCount, 40);
  });

  test('5. mixed rows with Day majority', () => {
    const result = classifyShift([at(6), at(7), at(8), at(20)], HYNC_SLNC_WINDOW);
    assert.equal(result.shiftLabel, 'Day Shift');
    assert.equal(result.dayCount, 3);
    assert.equal(result.nightCount, 1);
  });

  test('6. mixed rows with Night majority', () => {
    const result = classifyShift([at(6), at(20), at(21), at(22)], HYNC_SLNC_WINDOW);
    assert.equal(result.shiftLabel, 'Night Shift');
    assert.equal(result.dayCount, 1);
    assert.equal(result.nightCount, 3);
  });

  test('7. exact tie -> unresolved/blocking, never silently picks a shift', () => {
    const result = classifyShift([at(6), at(9), at(20), at(22)], HYNC_SLNC_WINDOW);
    assert.equal(result.shiftLabel, null);
    assert.equal(result.status, 'unresolved');
    assert.equal(result.dayCount, 2);
    assert.equal(result.nightCount, 2);
  });

  test('8. no valid timestamps -> unresolved/blocking, never defaults to Day Shift', () => {
    const result = classifyShift([], HYNC_SLNC_WINDOW);
    assert.equal(result.shiftLabel, null);
    assert.equal(result.status, 'unresolved');
    assert.equal(result.totalValid, 0);
  });

  test('8b. only invalid timestamps -> unresolved/blocking', () => {
    const result = classifyShift([null, new Date('not a date'), undefined], HYNC_SLNC_WINDOW);
    assert.equal(result.shiftLabel, null);
    assert.equal(result.status, 'unresolved');
    assert.equal(result.totalValid, 0);
    assert.equal(result.invalidCount, 3);
  });

  test('9. invalid timestamps are ignored for the vote but counted separately', () => {
    const result = classifyShift([at(8), at(9), null, new Date('invalid'), at(10)], HYNC_SLNC_WINDOW);
    assert.equal(result.shiftLabel, 'Day Shift');
    assert.equal(result.dayCount, 3);
    assert.equal(result.invalidCount, 2);
    assert.equal(result.totalValid, 3);
  });

  test('14. filename plays no role -- classifyShift() takes only timestamps (+ options), never a filename or device clock', () => {
    // Only `timestamps` is a required parameter; `options` carries a
    // default, so arity is 1 -- there is no way for a filename or the
    // device's current time to reach this function.
    assert.equal(classifyShift.length, 1);
  });

  test('15. row order does not affect the final result', () => {
    const rows = [
      ...Array.from({ length: 12 }, (_, i) => at(3, i)), // Night
      ...Array.from({ length: 30 }, (_, i) => at(9 + (i % 7), i % 60)), // Day
    ];
    const baseline = classifyShift(rows, HYNC_SLNC_WINDOW);
    for (let seed = 0; seed < 5; seed++) {
      const shuffled = classifyShift(shuffle(rows, seed), HYNC_SLNC_WINDOW);
      assert.deepEqual(shuffled, baseline);
    }
  });
});

describe('Owner-reported bug reproduction (sanitized, deterministic fixture)', () => {
  test('initial rows classify as Night; full-workbook majority is Day -> final result is Day Shift', () => {
    // Reproduces the Owner's confirmed HYNC bug (06-08-2026 PAGI A.xlsx):
    // the workbook's chronologically-earliest deliveries landed right at
    // the shift boundary (04:40-05:00, before the 05:01 HYNC/SLNC cutoff),
    // which is exactly the kind of sample the OLD "average the first 20
    // chronologically-sorted rows" algorithm used on its own -- 20 such
    // rows alone average well under the 05:01 cutoff and would have been
    // misclassified Night. The rest of the operational day (180 rows) is
    // solidly Day. The new full-dataset majority vote correctly resolves
    // this as Day Shift.
    const earlyBoundaryRows = Array.from({ length: 20 }, (_, i) => at(4, 40 + (i % 20)));
    const restOfDay = Array.from({ length: 180 }, (_, i) => at(6 + (i % 10), i % 60));
    const result = classifyShift([...earlyBoundaryRows, ...restOfDay], HYNC_SLNC_WINDOW);

    assert.equal(result.shiftLabel, 'Day Shift');
    assert.equal(result.status, 'resolved');
    assert.equal(result.dayCount, 180);
    assert.equal(result.nightCount, 20);

    // Sanity-check the premise: the old sorted-first-20 sample really was
    // all-Night on its own, confirming this fixture actually reproduces
    // the bug rather than coincidentally passing.
    const oldSampleOnly = classifyShift(earlyBoundaryRows, HYNC_SLNC_WINDOW);
    assert.equal(oldSampleOnly.shiftLabel, 'Night Shift');
  });
});

describe('Profile coverage -- each buyer classified with its own confirmed window', () => {
  test('10. HYNC real-shape timestamps (05:01-17:00 inclusive window)', () => {
    // Real HYNC files run 毛重时间 across a full day shift.
    const timestamps = [at(5, 1), at(8, 15), at(11, 30), at(14, 45), at(17, 0)];
    const result = classifyShift(timestamps, HYNC_SLNC_WINDOW);
    assert.equal(result.shiftLabel, 'Day Shift');
    // Boundary values are both inclusive for HYNC/SLNC.
    assert.equal(classifyShift([at(5, 1, 0)], HYNC_SLNC_WINDOW).shiftLabel, 'Day Shift');
    assert.equal(classifyShift([at(17, 0, 0)], HYNC_SLNC_WINDOW).shiftLabel, 'Day Shift');
    assert.equal(classifyShift([at(5, 0, 59)], HYNC_SLNC_WINDOW).shiftLabel, 'Night Shift');
    assert.equal(classifyShift([at(17, 0, 1)], HYNC_SLNC_WINDOW).shiftLabel, 'Night Shift');
  });

  test('11. SLNC real-shape timestamps (same shared window as HYNC)', () => {
    const timestamps = [at(18, 0), at(21, 30), at(0, 15), at(3, 45)];
    const result = classifyShift(timestamps, HYNC_SLNC_WINDOW);
    assert.equal(result.shiftLabel, 'Night Shift');
  });

  test('12. ESG Format A real-shape timestamps (Time Loaded column, ESG default window)', () => {
    const timestamps = [at(6, 0), at(9, 30), at(13, 0), at(16, 59)];
    const result = classifyShift(timestamps);
    assert.equal(result.shiftLabel, 'Day Shift');
    // ESG's window is 05:00 inclusive, 17:00 exclusive.
    assert.equal(classifyShift([at(5, 0, 0)]).shiftLabel, 'Day Shift');
    assert.equal(classifyShift([at(16, 59, 59)]).shiftLabel, 'Day Shift');
    assert.equal(classifyShift([at(17, 0, 0)]).shiftLabel, 'Night Shift');
    assert.equal(classifyShift([at(4, 59, 59)]).shiftLabel, 'Night Shift');
  });

  test('13. ESG Format B real-shape timestamps (JAM TIMBANG ISI column, same ESG default window)', () => {
    const timestamps = [at(19, 0), at(22, 15), at(1, 0), at(4, 30)];
    const result = classifyShift(timestamps);
    assert.equal(result.shiftLabel, 'Night Shift');
  });
});
