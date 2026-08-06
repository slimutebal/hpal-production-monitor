// Shared, format-agnostic helpers used by both ESG workbook adapters (and
// the detector). Nothing here knows about Format A's or Format B's column
// letters/header text -- that mapping lives in each adapter file. This
// module is part of the isolated ESG parsing layer (see esg-profile.js's
// header comment): it is not imported by profile-registry.js,
// shared-report-profile.js, or report-page.js, and does not import them
// either.

// Normalizes a header/marker cell value for case-insensitive,
// whitespace-tolerant comparison: trim, collapse internal whitespace,
// uppercase. Used only for matching header text, never for data values
// (use cellText() for those, which preserves case).
export function normalizeHeaderText(value) {
  return String(value == null ? '' : value).trim().replace(/\s+/g, ' ').toUpperCase();
}

// Trims a data cell to a plain string without altering case, e.g. for
// vehicle numbers, PENERIMA values, spec strings.
export function cellText(value) {
  return String(value == null ? '' : value).trim();
}

// Searches a 0-indexed row-matrix (as produced by
// XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: '' })) for a
// window of `windowSize` consecutive rows that together contain every
// marker in `requiredMarkers` (matched case-insensitively, by exact cell
// text or substring -- real headers sometimes carry extra words, e.g.
// "Weighing Truck + Cargo" around "Cargo Weighing"). This is the "composite
// header resolver" for formats whose header spans more than one physical
// row (Format A splits its header across two rows because of a merged
// parent cell); a single-row header is just windowSize: 1.
//
// Returns null if no window in the scanned range satisfies every marker.
// Otherwise returns { headerStartRow, headerEndRow, dataStartRow, columns }
// with all row numbers 0-indexed (matching the input matrix) and `columns`
// mapping each requested marker string to { row, col } (also 0-indexed).
export function findMarkerColumns(matrix, requiredMarkers, { windowSize = 1, maxScanRow = 60 } = {}) {
  const normMarkers = requiredMarkers.map(normalizeHeaderText);
  const scanLimit = Math.min(maxScanRow, matrix.length);

  for (let start = 0; start < scanLimit; start++) {
    const end = Math.min(start + windowSize, matrix.length);
    const found = {};
    for (let r = start; r < end; r++) {
      const row = matrix[r] || [];
      for (let c = 0; c < row.length; c++) {
        const text = normalizeHeaderText(row[c]);
        if (!text) continue;
        normMarkers.forEach((marker, i) => {
          const key = requiredMarkers[i];
          if (found[key]) return; // first match in the window wins
          if (text === marker || text.includes(marker)) {
            found[key] = { row: r, col: c };
          }
        });
      }
    }
    if (Object.keys(found).length === requiredMarkers.length) {
      return { headerStartRow: start, headerEndRow: end - 1, dataStartRow: end, columns: found };
    }
  }
  return null;
}

// Best-effort partial-match diagnostic. Unlike findMarkerColumns (which
// requires every marker to be found together before returning anything),
// this reports the largest number of markers found together in any single
// scanned window, plus which markers were never found anywhere in range.
// Used only for distinguishing "this workbook shows some ESG structural
// evidence but is broken/incomplete" from "this workbook shows no ESG
// evidence at all" (see report-workbook-dispatcher.js) -- it never affects
// whether a workbook is accepted as a positively-identified Format A/B
// match, only the wording of a blocking error when it is not.
export function scanMarkerCoverage(matrix, requiredMarkers, { windowSize = 1, maxScanRow = 60 } = {}) {
  const normMarkers = requiredMarkers.map(normalizeHeaderText);
  const scanLimit = Math.min(maxScanRow, matrix.length);
  let bestCount = 0;
  const everFound = new Set();

  for (let start = 0; start < scanLimit; start++) {
    const end = Math.min(start + windowSize, matrix.length);
    const foundInWindow = new Set();
    for (let r = start; r < end; r++) {
      const row = matrix[r] || [];
      for (let c = 0; c < row.length; c++) {
        const text = normalizeHeaderText(row[c]);
        if (!text) continue;
        normMarkers.forEach((marker, i) => {
          if (text === marker || text.includes(marker)) {
            foundInWindow.add(requiredMarkers[i]);
            everFound.add(requiredMarkers[i]);
          }
        });
      }
    }
    if (foundInWindow.size > bestCount) bestCount = foundInWindow.size;
  }

  return {
    bestWindowMatchCount: bestCount,
    totalMarkers: requiredMarkers.length,
    everFoundAnywhere: Array.from(everFound),
    missingEverywhere: requiredMarkers.filter((m) => !everFound.has(m)),
  };
}

// Excel date/time serials (as read by SheetJS with `raw: true`, i.e. plain
// numbers, not JS Dates) decode through the same SSF routine the app
// already uses elsewhere (see shared-report-profile.js's
// parseFlexibleDateTime and the ATQ-ESG reference's own
// formatDateFromSerial/parseTimeSerial). A pure time-of-day serial (no date
// component, e.g. Format A's "Time Loaded" column) still decodes correctly
// through parse_date_code -- only H/M/S are meaningful in that case.
export function decodeExcelSerial(serial) {
  if (typeof XLSX === 'undefined' || !XLSX.SSF) return null;
  if (typeof serial !== 'number' || isNaN(serial)) return null;
  const d = XLSX.SSF.parse_date_code(serial);
  if (!d) return null;
  return { y: d.y, m: d.m, d: d.d, H: d.H || 0, M: d.M || 0, S: Math.floor(d.S || 0) };
}

// Constructs a local (not UTC) Date from validated numeric components so
// the operational date/time is never shifted by a timezone conversion.
// `month` is 1-based (matches decodeExcelSerial's `m`).
export function makeLocalDate(year, month, day, hour = 0, minute = 0, second = 0) {
  const dt = new Date(year, month - 1, day, hour, minute, second);
  return isNaN(dt) ? null : dt;
}

// Dome/grade extraction shared by both ESG formats. Supports every
// variant confirmed in the two real reference workbooks plus the task's
// required set: "DOME ( NI:1.25 )", "DOME (Ni 1.25)", "DOME (NI:1.25)",
// "DOME (1.25)" -- "NI"/"Ni" case-insensitive, colon optional, comma or
// dot decimal. Dome names are normalized (trim, hyphen -> underscore) to
// match the existing HYNC/SLNC underscore convention, since both real ESG
// workbooks use hyphens in their raw dome codes (e.g. "L21-01").
export function parseEsgSpec(rawSpec) {
  const str = cellText(rawSpec);
  const m = str.match(/^(.*?)\s*\(\s*(?:NI\s*:?\s*)?([\d.,]+)\s*\)\s*$/i);
  if (!m) return { dome: null, grade: null, valid: false };
  const dome = m[1].trim().replace(/-/g, '_');
  const grade = parseFloat(m[2].replace(',', '.'));
  if (!dome || isNaN(grade)) return { dome: null, grade: null, valid: false };
  return { dome, grade, valid: true };
}

// Ore-class thresholds, intentionally duplicated (not imported) from
// shared-report-profile.js's classifyOreClass -- this file must stay
// import-free from the active HYNC/SLNC module graph so the ESG layer
// remains fully isolated per this task's scope. The values themselves
// (>1.4 HGLO, <1.2 LGLO, else MGLO) must stay in sync if ever revisited;
// they are also restated as a literal requirement in the ESG task spec.
export function classifyEsgOreClass(grade) {
  if (grade === null || grade === undefined || isNaN(grade)) return null;
  return grade > 1.4 ? 'HGLO' : (grade < 1.2 ? 'LGLO' : 'MGLO');
}

// Normalized issue/warning record shape used by both adapters.
// `sourceRow` is the 1-based, Excel-visible row number, or null for a
// workbook-level (not row-specific) issue such as missing buyer evidence.
export function createIssue(type, message, { sourceRow = null, ...extra } = {}) {
  return { type, message, sourceRow, ...extra };
}
