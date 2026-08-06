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
