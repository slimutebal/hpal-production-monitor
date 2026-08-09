// Pure locale-aware decimal input utility (V2.4.1 Bug A). See
// docs/V2.4_CALCULATE_AND_BLENDING_RECOMMENDATION_ARCHITECTURE.md and this
// task's Sections 2-10/31/34.
//
// PURE MODULE CONTRACT: no DOM, no navigator dependency for PARSING, no
// i18n, no localStorage, no network, no side effects -- same discipline as
// calculate-validation.js/blending-recommendation.js. formatDecimalForLocale()
// below is the one exception to "no locale" -- it takes `locale` as an
// explicit argument rather than reading navigator.language itself, so it
// stays pure/testable; the DOM layer (calculate-page.js) is the only place
// that ever reads navigator.language and passes it in.
//
// REAL PRODUCTION PROBLEM this fixes: an Indonesian-locale iPhone's decimal
// keyboard produces "1,15" (comma), not "1.15" (dot). `Number("1,15")` is
// NaN, so every decimal Calculate field rejected a perfectly valid,
// device-correct keystroke. parseDecimalInput() below understands BOTH
// forms identically, on every device, so `inputmode="decimal"` can stay
// exactly as-is (never switched to `type="number"`, never any per-device
// branching) -- the browser/device keyboard choice was already correct;
// only the app's OWN parsing was wrong.

// Accepts an optional sign, digits, and AT MOST ONE decimal separator
// (either "." or ",") followed by digits -- e.g. "1", "1.15", "1,15",
// "0.010", ".5", "5.". Deliberately NOT a thousands/group-separator
// grammar (this task's Section 5): "1,234" must parse as decimal 1.234,
// never as one thousand two hundred thirty-four, so at most one separator
// character is ever permitted anywhere in the string. Anything with two
// separators, mixed separators, or any non-digit/non-separator character
// is rejected outright rather than partially parsed (this task's Section
// 6: "Do NOT use parseFloat() in a way that accepts garbage suffixes").
const DECIMAL_INPUT_PATTERN = /^[+-]?\d*[.,]?\d*$/;

// Returns a finite JS number for a syntactically valid single-decimal-
// separator numeric string, or `null` for anything else (including "",
// whitespace-only, a bare sign/separator with no digits, or a malformed
// multi-separator string). Never returns NaN -- `null` is the one, explicit
// "not a valid numeric value" sentinel a caller needs to check for, the
// same convention calculate-page.js's own parseFiniteNumber() already
// uses for its live-preview values.
//
// Also accepts an already-numeric `raw` (pass-through, finite-only) --
// callers throughout this pure Calculate engine (and its own test suite)
// have always been free to hand these validate*()/toNumeric*() functions
// a plain JS number directly, never only a live text-input string; this
// function's contract must not narrow that.
export function parseDecimalInput(raw) {
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (!DECIMAL_INPUT_PATTERN.test(trimmed)) return null;
  if (!/\d/.test(trimmed)) return null; // reject "+", "-", ".", "," etc. with no digits at all

  const normalized = trimmed.replace(',', '.');
  const value = Number(normalized);
  return Number.isFinite(value) ? value : null;
}

// Formats a plain number using DEVICE/browser numeric-locale conventions
// (this task's Section 9) -- e.g. locale "id-ID" -> "0,010", "en-US" ->
// "0.010". Deliberately takes `locale` as a parameter instead of reading
// navigator.language itself (keeps this module pure/testable without a
// DOM/navigator global, and lets tests provide an explicit locale rather
// than depending on the CI host's own locale, this task's Section 34).
// This is entirely independent of the app's own Indonesian/English UI
// language setting (js/i18n/i18n.js) -- an English-UI app on an
// Indonesian-locale phone still displays "0,010" here.
export function formatDecimalForLocale(value, locale, fractionDigits = 3) {
  try {
    return new Intl.NumberFormat(locale, {
      useGrouping: false,
      minimumFractionDigits: fractionDigits,
      maximumFractionDigits: fractionDigits,
    }).format(value);
  } catch {
    // Intl unavailable/locale rejected (very old runtime) -- safe fallback
    // to a literal "." decimal point (this task's Section 9), never a
    // thrown error.
    return value.toFixed(fractionDigits);
  }
}
