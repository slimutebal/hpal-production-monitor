// Deterministic workbook dispatcher: the single place in the active
// application that decides whether an uploaded file is ESG-shaped or
// belongs to the existing HYNC/SLNC parser. Nothing else in report-page.js
// should contain dispatch logic -- it only calls parseUploadedWorkbook().
//
// Routing rule (never "not HYNC/SLNC therefore ESG"):
//   1. Positive ESG Format A or Format B structural match -> ESG parser.
//   2. Detector says AMBIGUOUS (more than one candidate sheet/format)
//      -> block with an ESG-specific ambiguous-format error.
//   3. Detector says UNSUPPORTED, but the workbook shows at least one ESG
//      structural marker somewhere (a broken/incomplete ESG file, e.g. a
//      renamed/edited template missing a required column) -> block with an
//      ESG-specific unsupported/missing-header error. Never silently fall
//      through to the HYNC/SLNC parser in this case, since that produces
//      the exact misleading "Kolom 流水号 tidak ditemukan" error this task
//      exists to fix.
//   4. Detector says UNSUPPORTED with zero ESG structural evidence
//      anywhere -> this is not an ESG workbook; use the existing
//      HYNC/SLNC parser, completely unchanged.

import { ESG_WORKBOOK_FORMAT, detectEsgWorkbookFormat } from './esg-workbook-detector.js';
import { parseEsgWorkbook } from './esg-profile.js';
import { parseWeighbridgeWorkbook } from './shared-report-profile.js';

function hasAnyEsgEvidence(detection) {
  return (detection.sheetDiagnostics || []).some(
    (d) => (d.formatA && (d.formatA.foundMarkerCount > 0 || d.formatA.rowCount > 0))
      || (d.formatB && (d.formatB.foundMarkerCount > 0 || d.formatB.rowCount > 0))
  );
}

// workbook: a SheetJS workbook (from XLSX.read). Returns the parsed-result
// shape the active Report page already expects (see
// shared-report-profile.js's parseWeighbridgeWorkbook / esg-profile.js's
// parseEsgWorkbook, both of which converge on the same fields). Throws an
// Error (with .code and .diagnostics where available) for a workbook that
// cannot be parsed at all -- mirroring both underlying parsers' own
// throwing convention, so the existing handleFileChange() catch block in
// report-page.js needs no new error-handling shape.
export function parseUploadedWorkbook(workbook) {
  const esgDetection = detectEsgWorkbookFormat(workbook);

  if (esgDetection.status === ESG_WORKBOOK_FORMAT.ESG_FORMAT_A || esgDetection.status === ESG_WORKBOOK_FORMAT.ESG_FORMAT_B) {
    return parseEsgWorkbook(workbook);
  }

  if (esgDetection.status === ESG_WORKBOOK_FORMAT.AMBIGUOUS) {
    const err = new Error('Format workbook EIEB ambigu: lebih dari satu sheet memenuhi struktur data EIEB. Pastikan hanya satu sheet sumber data yang valid.');
    err.code = esgDetection.status;
    err.diagnostics = esgDetection;
    throw err;
  }

  // esgDetection.status === UNSUPPORTED from here on.
  if (hasAnyEsgEvidence(esgDetection)) {
    const err = new Error('Format EIEB tidak didukung: struktur file menyerupai data EIEB, tetapi header wajib tidak lengkap.');
    err.code = esgDetection.status;
    err.diagnostics = esgDetection;
    throw err;
  }

  return parseWeighbridgeWorkbook(workbook);
}
