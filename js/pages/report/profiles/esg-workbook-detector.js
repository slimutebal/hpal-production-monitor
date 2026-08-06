// Deterministic ESG workbook format detection. Inspects actual sheet
// contents (header text, row shape) -- never the workbook's filename,
// upload order, or a bare "first sheet" assumption. This module is
// intentionally narrow: it scans and classifies, and returns diagnostics.
// It does not calculate tonnage, shift, contractors, or report output, and
// it never touches Report state -- see js/pages/report/profiles/esg-profile.js
// for how a caller uses its result.
//
// Two real ESG workbook formats are known (see
// docs/references/*.html and the two sample .xlsx files, both local-only
// and git-ignored):
//   Format A ("ATQ" style) -- a single sheet, a multi-row (2-row) header
//     around rows 15-16 in the confirmed sample, letterhead/metadata rows
//     above it (including "Stockpile ESG" as positive buyer evidence),
//     Vehicle No values starting with "SCM".
//   Format B ("SCM/ESG raw data" style) -- typically multiple sheets (one
//     raw-data sheet, one pre-aggregated summary sheet); the raw sheet has
//     a single-row header around row 4 with NO.NOTA/NO. DT/PENERIMA/...;
//     valid rows have a NO.NOTA value starting with "20".
//
// Detection is purely structural (header + row-shape signatures); it does
// NOT check buyer evidence (e.g. "Stockpile ESG" text, or the PENERIMA
// value) -- that is deliberately left to each adapter (see
// esg-format-a-adapter.js / esg-format-b-adapter.js), because buyer-evidence
// validation is a per-row/per-workbook *business* rule, not a structural
// shape signature. This keeps "is this workbook shaped like Format A/B"
// separate from "does this workbook actually belong to ESG".

import { findMarkerColumns, scanMarkerCoverage } from './adapters/esg-adapter-utils.js';

export const ESG_WORKBOOK_FORMAT = {
  ESG_FORMAT_A: 'ESG_FORMAT_A',
  ESG_FORMAT_B: 'ESG_FORMAT_B',
  AMBIGUOUS: 'AMBIGUOUS',
  UNSUPPORTED: 'UNSUPPORTED',
};

// Format A's required structural markers, confirmed from the real sample
// workbook's row 15/16 header (Vehicle No + Date on row 15; Time Loaded +
// Cargo Weighing on row 16 under the merged "Weighing Bridge" parent cell).
// "Date" is included here (in addition to the task's stated 4-marker list)
// because the detector's window search doubles as the structural
// confirmation the adapter later reuses for its own column resolution.
const FORMAT_A_MARKERS = ['Vehicle No', 'Date', 'Time Loaded', 'Cargo Weighing', 'Kode Dome'];
const FORMAT_A_WINDOW = { windowSize: 2, maxScanRow: 40 };
// Column used for the valid-row signature check (see FORMAT_A_MARKERS index).
const FORMAT_A_ROW_MARKER = 'Vehicle No';
const FORMAT_A_ROW_PREFIX = 'SCM';

// Format B's required structural markers -- exactly the task's confirmed
// signature list, taken verbatim from the real raw-data sheet's row 4.
const FORMAT_B_MARKERS = ['NO.NOTA', 'NO. DT', 'PENERIMA', 'TIMBANGAN BERSIH', 'JAM TIMBANG ISI', 'TANGGAL', 'KODE ORE'];
const FORMAT_B_WINDOW = { windowSize: 1, maxScanRow: 20 };
const FORMAT_B_ROW_MARKER = 'NO.NOTA';
const FORMAT_B_ROW_PREFIX = '20';

function sheetMatrix(workbook, sheetName) {
  const ws = workbook.Sheets[sheetName];
  if (!ws) return [];
  return XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: '' });
}

// Counts rows (from dataStartRow onward) whose value in the row-marker
// column satisfies the format's valid-row prefix. Used both to confirm a
// sheet has *any* parseable data (required for a sheet to fully qualify --
// a header-only sheet must not be treated as a match) and to report how
// many candidate rows exist, for diagnostics.
function countSignatureRows(matrix, headerMatch, rowMarkerKey, prefix) {
  const col = headerMatch.columns[rowMarkerKey].col;
  let count = 0;
  for (let r = headerMatch.dataStartRow; r < matrix.length; r++) {
    const row = matrix[r] || [];
    const v = row[col];
    if (v === null || v === undefined || String(v).trim() === '') continue;
    if (String(v).trim().toUpperCase().startsWith(prefix)) count++;
  }
  return count;
}

function tryFormat(matrix, markers, window, rowMarkerKey, rowPrefix) {
  const headerMatch = findMarkerColumns(matrix, markers, window);
  if (!headerMatch) {
    // No window satisfied every required marker. Report how close it came
    // (scanMarkerCoverage) so a caller like report-workbook-dispatcher.js
    // can tell "this looks like a broken/incomplete ESG file" (at least
    // one marker found) apart from "this workbook has no ESG evidence at
    // all" (zero markers found anywhere) -- needed to produce the correct
    // ESG-specific error instead of silently falling through to the
    // HYNC/SLNC parser for a file that is clearly ESG-shaped but invalid.
    const coverage = scanMarkerCoverage(matrix, markers, window);
    return { matched: false, missingMarkers: coverage.missingEverywhere, foundMarkerCount: coverage.bestWindowMatchCount };
  }
  const rowCount = countSignatureRows(matrix, headerMatch, rowMarkerKey, rowPrefix);
  if (rowCount === 0) return { matched: false, missingMarkers: [], headerMatch, rowCount: 0, foundMarkerCount: markers.length, reason: 'header found but no valid data rows matched the row signature' };
  return { matched: true, headerMatch, rowCount };
}

// Scans every sheet in the workbook and classifies it. Returns one of:
//   { status: 'ESG_FORMAT_A' | 'ESG_FORMAT_B', selectedSheet, headerStartRow,
//     headerEndRow, dataStartRow, matchedMarkers, rowCount, candidateSheets }
//   { status: 'AMBIGUOUS', candidateSheets, ambiguityReason }
//   { status: 'UNSUPPORTED', candidateSheets: [], sheetDiagnostics }
// All row numbers in the returned diagnostics are 1-based (Excel-visible).
export function detectEsgWorkbookFormat(workbook) {
  if (typeof XLSX === 'undefined' || !XLSX.utils) {
    throw new Error('Library Excel belum siap. Muat ulang aplikasi lalu coba lagi.');
  }
  if (!workbook || !Array.isArray(workbook.SheetNames) || workbook.SheetNames.length === 0) {
    return { status: ESG_WORKBOOK_FORMAT.UNSUPPORTED, candidateSheets: [], sheetDiagnostics: [], reason: 'workbook has no sheets' };
  }

  const candidates = []; // { sheetName, format, headerMatch, rowCount }
  const sheetDiagnostics = [];

  workbook.SheetNames.forEach((sheetName) => {
    const matrix = sheetMatrix(workbook, sheetName);

    const a = tryFormat(matrix, FORMAT_A_MARKERS, FORMAT_A_WINDOW, FORMAT_A_ROW_MARKER, FORMAT_A_ROW_PREFIX);
    if (a.matched) candidates.push({ sheetName, format: ESG_WORKBOOK_FORMAT.ESG_FORMAT_A, headerMatch: a.headerMatch, rowCount: a.rowCount });

    const b = tryFormat(matrix, FORMAT_B_MARKERS, FORMAT_B_WINDOW, FORMAT_B_ROW_MARKER, FORMAT_B_ROW_PREFIX);
    if (b.matched) candidates.push({ sheetName, format: ESG_WORKBOOK_FORMAT.ESG_FORMAT_B, headerMatch: b.headerMatch, rowCount: b.rowCount });

    sheetDiagnostics.push({
      sheetName,
      formatA: { matched: a.matched, rowCount: a.rowCount || 0, missingMarkers: a.missingMarkers || [], foundMarkerCount: a.foundMarkerCount || 0 },
      formatB: { matched: b.matched, rowCount: b.rowCount || 0, missingMarkers: b.missingMarkers || [], foundMarkerCount: b.foundMarkerCount || 0 },
    });
  });

  if (candidates.length === 0) {
    return { status: ESG_WORKBOOK_FORMAT.UNSUPPORTED, candidateSheets: [], sheetDiagnostics, reason: 'no sheet matched the Format A or Format B structural signature with at least one valid data row' };
  }

  if (candidates.length > 1) {
    return {
      status: ESG_WORKBOOK_FORMAT.AMBIGUOUS,
      candidateSheets: candidates.map((c) => ({ sheetName: c.sheetName, format: c.format, rowCount: c.rowCount })),
      ambiguityReason: candidates.every((c) => c.format === candidates[0].format)
        ? `more than one sheet fully qualifies for ${candidates[0].format}`
        : 'both ESG_FORMAT_A and ESG_FORMAT_B signatures were found (on the same or different sheets)',
      sheetDiagnostics,
    };
  }

  const only = candidates[0];
  return {
    status: only.format,
    selectedSheet: only.sheetName,
    headerStartRow: only.headerMatch.headerStartRow + 1,
    headerEndRow: only.headerMatch.headerEndRow + 1,
    dataStartRow: only.headerMatch.dataStartRow + 1,
    matchedMarkers: Object.keys(only.headerMatch.columns),
    rowCount: only.rowCount,
    candidateSheets: [{ sheetName: only.sheetName, format: only.format, rowCount: only.rowCount }],
    sheetDiagnostics,
  };
}
