// Generic formatting/parsing helpers shared by report profiles (only HYNC
// exists in V2.0; ESG/SLNC are future profiles per
// docs/V2.0_ARCHITECTURE_AND_ROADMAP.md section 6.4). Nothing in this file
// is buyer-specific -- buyer rules (header names, ore-class thresholds,
// shift windows, contractor bucketing) belong in a profile module such as
// js/pages/report/profiles/hync-profile.js, not here.

const MONTHS_ID = [
  'Januari', 'Februari', 'Maret', 'April', 'Mei', 'Juni',
  'Juli', 'Agustus', 'September', 'Oktober', 'November', 'Desember',
];

// Indonesian number formatting: "1.234,56" -> 1234.56
export function parseIDNumber(str) {
  if (str === null || str === undefined) return NaN;
  const cleaned = String(str).trim().replace(/\./g, '').replace(',', '.');
  return parseFloat(cleaned);
}

export function fmtTon(num) {
  return num.toLocaleString('id-ID', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export function fmtRit(num) {
  return Math.round(num).toLocaleString('id-ID');
}

export function formatDateID(d) {
  return `${d.getDate()} ${MONTHS_ID[d.getMonth()]} ${d.getFullYear()}`;
}

export function parseDateID(str) {
  const m = str.match(/(\d{1,2})\s+([A-Za-zÀ-ÿ]+)\s+(\d{4})/);
  if (!m) return null;
  const day = parseInt(m[1], 10);
  const monthName = m[2].toLowerCase();
  const monthIdx = MONTHS_ID.findIndex((mo) => mo.toLowerCase() === monthName);
  if (monthIdx === -1) return null;
  const year = parseInt(m[3], 10);
  return new Date(year, monthIdx, day);
}

export function sameDate(a, b) {
  if (!a || !b) return false;
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

// Automatic Week (V2.3 Phase 1). Pure, buyer/format-agnostic ISO-8601 week
// calculation -- the single shared implementation every Report profile
// (HYNC, SLNC, ESG Format A, ESG Format B) feeds its parsed workbook date
// into, so ISO-week math is never duplicated per profile. Deliberately does
// not read the device clock, previous-report text, or any UI state -- its
// only input is the workbook date already produced by the parser.
//
// `workbookDate` must be a real, valid Date built from local calendar
// components (exactly what every profile already produces: HYNC/SLNC's
// parseFlexibleDate() and ESG's makeLocalDate() both construct
// `new Date(year, month - 1, day, ...)` -- never from an ambiguous
// locale-formatted string passed through Date.parse()). Returns null for a
// missing/invalid date rather than throwing, since "no valid workbook
// date" is an expected, caller-handled condition (see report-page.js's
// blocking Step 1 validation), not an exceptional one.
//
// Calculation approach: the input Date's year/month/day are read via the
// local getters (matching how the Date was constructed), then every
// subsequent day-arithmetic step (finding the ISO week's Thursday, Monday,
// Sunday, and the week-year's Jan 1) is done against a UTC-midnight
// representation of those same calendar components. This avoids the
// classic bug where adding/subtracting days on a local-time Date silently
// lands on the wrong calendar day around a DST transition -- UTC has no
// DST, so "add N days" is always exactly N*24h with no local-clock
// surprises. Verified against Python's stdlib datetime.isocalendar() across
// 20,000 random dates spanning 1990-2100 (zero mismatches) plus every
// boundary case in docs/V2.3_AUTO_WEEK_AND_PERSONNEL_DIRECTORY_ARCHITECTURE.md.
export function calculateIsoWeek(workbookDate) {
  if (!(workbookDate instanceof Date) || isNaN(workbookDate)) return null;

  const year = workbookDate.getFullYear();
  const month = workbookDate.getMonth(); // 0-based, matches Date's own convention
  const day = workbookDate.getDate();

  const utcDate = new Date(Date.UTC(year, month, day));
  if (isNaN(utcDate)) return null;

  // ISO weekday: Monday = 1 ... Sunday = 7 (JS's own getUTCDay() gives
  // Sunday = 0, so remap it to 7 rather than treating it as "day zero").
  const isoWeekday = utcDate.getUTCDay() || 7;

  // The Thursday of the same ISO week always falls inside the correct ISO
  // week-year (the ISO year-boundary rule is defined in terms of which
  // year owns that week's Thursday).
  const thursday = new Date(utcDate);
  thursday.setUTCDate(thursday.getUTCDate() + (4 - isoWeekday));
  const weekYear = thursday.getUTCFullYear();

  const yearStart = new Date(Date.UTC(weekYear, 0, 1));
  const dayDiff = Math.round((thursday - yearStart) / 86400000);
  const weekNumber = Math.ceil((dayDiff + 1) / 7);

  const monday = new Date(utcDate);
  monday.setUTCDate(monday.getUTCDate() - (isoWeekday - 1));
  const sunday = new Date(monday);
  sunday.setUTCDate(monday.getUTCDate() + 6);

  return {
    weekNumber,
    weekYear,
    weekStart: formatIsoDateUtc(monday),
    weekEnd: formatIsoDateUtc(sunday),
  };
}

// Automatic Week integration helper: derives the Week result (or null)
// from an already-parsed workbook result object -- the exact same
// decision report-page.js's applyWeekFromParsed() applies after every
// upload. Kept here (pure, no DOM) rather than inline in report-page.js so
// it is directly unit-testable, and so every profile (HYNC, SLNC, ESG
// Format A, ESG Format B) goes through one single implementation of "which
// field on `parsed` feeds Week".
//
// `parsed.dateMismatch` is deliberately NOT consulted here. It is a
// pre-existing, informational-only signal (HYNC/SLNC via
// shared-report-profile.js, both ESG formats via esg-profile.js -- same
// shape/semantics in all three) meaning "more than one distinct row date
// was seen; the first valid row's date was used as the canonical date
// regardless" -- already surfaced as a non-blocking warning in
// report-page.js's renderWarnings(). It does not mean parsed.fileDate is
// unresolved: fileDate is always deterministic (the first valid row's
// date) whether or not dateMismatch is set. A real ESG Format A Night
// Shift workbook legitimately sets dateMismatch when rows roll past
// midnight into the next calendar day -- expected, not an error. Week is
// blocked only when there is genuinely no valid date to work with, i.e.
// calculateIsoWeek() itself returns null for a missing/invalid fileDate.
export function deriveWeekFromParsedWorkbook(parsed) {
  if (!parsed) return null;
  return calculateIsoWeek(parsed.fileDate);
}

function formatIsoDateUtc(utcDate) {
  const y = utcDate.getUTCFullYear();
  const m = String(utcDate.getUTCMonth() + 1).padStart(2, '0');
  const d = String(utcDate.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

// Shift classification bug fix (V2.3 Report Personnel fixes). Buyer-agnostic,
// pure, DOM-free -- the single shared implementation every Report profile
// (HYNC, SLNC, ESG Format A, ESG Format B) now feeds its full set of valid
// gross/loaded timestamps into, so shift math is never duplicated per
// profile and never re-samples a subset of rows.
//
// Root cause of the reported bug (06-08-2026 PAGI A.xlsx misclassified as
// Night Shift): the previous HYNC/SLNC implementation sorted rows by time
// and averaged only the first 20 chronologically-earliest timestamps; a Day
// Shift file whose earliest deliveries land right at the shift boundary can
// average out below the cutoff even though the shift's full timestamp
// distribution is overwhelmingly Day. The previous ESG implementation had
// the same class of bug via a different mechanism: it inspected only the
// first 10 rows in raw (non-chronological) file order. Neither used the
// complete dataset. This function fixes both by classifying every valid
// timestamp individually and deciding by majority vote across the whole
// set -- order-independent, so it produces the same result regardless of
// row order or workbook layout.
//
// Day-window boundaries are parameterized (not hardcoded) because the two
// buyer families currently have two different *documented* boundaries that
// predate this fix and are preserved exactly rather than silently
// unified:
//   - HYNC/SLNC: 05:01:00-17:00:00, inclusive at both ends (documented in
//     docs/V2.1_HYNC_SLNC_REPORT_ARCHITECTURE.md, Section 12 "Workbook
//     Parsing": "classifies 05:01-17:00 as Day Shift, otherwise Night
//     Shift").
//   - ESG (both formats): 05:00:00 inclusive - 17:00:00 exclusive (the
//     window esg-profile.js's previous detectEsgShift() already used,
//     "confirmed from the ATQ-ESG reference").
// Callers pass their own confirmed window; the default here matches ESG's
// window since ESG has no separate architecture-doc citation to quote.
//
// Ties and "no valid timestamp" are never silently resolved to a default
// shift -- both come back as `status: 'unresolved'` with `shiftLabel: null`
// so the caller can block Report progression with a specific message,
// per the Owner-approved rule that shift must never be guessed.
export function classifyShift(timestamps, options = {}) {
  const dayStartSec = options.dayStartSec != null ? options.dayStartSec : 5 * 3600;
  const dayEndSec = options.dayEndSec != null ? options.dayEndSec : 17 * 3600;
  const dayEndInclusive = options.dayEndInclusive === true;

  let dayCount = 0;
  let nightCount = 0;
  let invalidCount = 0;

  (timestamps || []).forEach((t) => {
    if (!(t instanceof Date) || isNaN(t)) {
      invalidCount++;
      return;
    }
    const sec = t.getHours() * 3600 + t.getMinutes() * 60 + t.getSeconds();
    const isDay = dayEndInclusive
      ? sec >= dayStartSec && sec <= dayEndSec
      : sec >= dayStartSec && sec < dayEndSec;
    if (isDay) dayCount++; else nightCount++;
  });

  const totalValid = dayCount + nightCount;

  if (totalValid === 0 || dayCount === nightCount) {
    return { shiftLabel: null, dayCount, nightCount, invalidCount, totalValid, status: 'unresolved' };
  }

  return {
    shiftLabel: dayCount > nightCount ? 'Day Shift' : 'Night Shift',
    dayCount,
    nightCount,
    invalidCount,
    totalValid,
    status: 'resolved',
  };
}

// Contractor directory drift fix -- "Refresh List DT" reclassification.
// Same bucket/priority/alias rules shared-report-profile.js's
// parseWeighbridgeWorkbook() and esg-profile.js's aggregateEsgContractors()
// each already implement independently for their own initial parse
// (duplicated there per the existing codebase convention -- see
// esg-profile.js's own header comment on why CONTRACTOR_PRIORITY/
// CONTRACTOR_ALIAS are restated per module rather than imported).
// Restated here a third time, deliberately: this function's job is not
// the initial parse (which stays untouched, proven, and buyer-specific)
// but recomputing the *same* aggregates from an already-parsed workbook's
// `records` array against a freshly synced contractor directory, without
// re-parsing the file -- report-page.js's "Refresh List DT" action is the
// only caller.
const CONTRACTOR_PRIORITY = ['PMS', 'MRP', 'TII', 'REAL', 'JAM', 'STM', 'MIM', 'HYNC'];
const CONTRACTOR_ALIAS = { HILLCON: 'PMS' };

// `records` must already be in the shared HYNC/SLNC/ESG parsed-result
// shape ({ carNo, ... }) -- exactly what parseWeighbridgeWorkbook() and
// esg-profile.js's buildEsgParsedResult() both already produce.
// `resolveContractorFn` is the caller's own buyer-appropriate resolver
// (shared-report-profile.js's resolveContractor for HYNC/SLNC,
// esg-profile.js's resolveEsgContractor for ESG) -- this function never
// imports either itself, keeping it buyer-agnostic and DOM-free. Returns
// only the contractor-derived fields (contractorCounts, totalADT,
// totalDT, unmatchedTrucks); tonnage, ritase, date, shift, and dome data
// are untouched because this function never reads or returns them.
export function recomputeContractorAggregates(records, resolveContractorFn) {
  const truckContractor = new Map();
  const unmatched = new Set();
  records.forEach((r) => {
    if (truckContractor.has(r.carNo)) return;
    const contractor = resolveContractorFn(r.carNo);
    if (!contractor) unmatched.add(r.carNo);
    truckContractor.set(r.carNo, contractor || 'TIDAK DIKENALI');
  });

  const bucketCounts = new Map();
  truckContractor.forEach((contractor) => {
    let bucket = contractor.toUpperCase().startsWith('ADT') ? 'ADT' : contractor;
    if (CONTRACTOR_ALIAS[bucket.toUpperCase()]) bucket = CONTRACTOR_ALIAS[bucket.toUpperCase()];
    bucketCounts.set(bucket, (bucketCounts.get(bucket) || 0) + 1);
  });

  const totalADT = bucketCounts.get('ADT') || 0;
  const totalTrucks = truckContractor.size;
  const totalDT = totalTrucks - totalADT;

  const nonAdtEntries = Array.from(bucketCounts.entries()).filter(([k]) => k !== 'ADT');
  nonAdtEntries.sort((a, b) => {
    const pa = CONTRACTOR_PRIORITY.indexOf(a[0]);
    const pb = CONTRACTOR_PRIORITY.indexOf(b[0]);
    const ra = pa === -1 ? 999 : pa;
    const rb = pb === -1 ? 999 : pb;
    if (ra !== rb) return ra - rb;
    return a[0].localeCompare(b[0]);
  });

  return {
    contractorCounts: nonAdtEntries,
    totalADT,
    totalDT,
    unmatchedTrucks: Array.from(unmatched),
  };
}

// Strips zero-width/BOM characters that sometimes ride along when text is
// pasted from WhatsApp/other apps into the "previous report" textarea.
// Built from character codes (rather than a literal escape sequence in the
// regex) so the zero-width characters themselves never appear in this file.
const ZERO_WIDTH_CHARS = [0x200b, 0x200c, 0x200d, 0x200e, 0x200f, 0xfeff]
  .map((code) => String.fromCharCode(code))
  .join('');
const ZERO_WIDTH_PATTERN = new RegExp(`[${ZERO_WIDTH_CHARS}]`, 'g');

export function cleanInvisible(str) {
  return str.replace(ZERO_WIDTH_PATTERN, '');
}

export function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
