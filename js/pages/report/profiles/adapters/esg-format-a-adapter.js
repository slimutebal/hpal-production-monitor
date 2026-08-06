// ESG workbook Format A adapter ("ATQ" style weighing sheet). Responsible
// only for: validating Format A, locating its header/metadata, selecting
// valid data rows, parsing required row values, converting raw tons to the
// normalized kg convention, combining date + loaded-time, and normalizing
// specification/dome/grade/ore-class. Does not calculate Daily/WTD/MTD/YTD,
// build report text, assign loading areas, or resolve contractors -- those
// stay out of scope for this isolated parsing layer (see esg-profile.js).
//
// Confirmed from the real sample workbook
// (docs/references/DATA TIMBANGAN 5 AGUSTUS 2026 SHIFT 2.xlsx, local-only,
// git-ignored): sheet "WS 050826 S2", a letterhead block (rows 2-13)
// including "Port : Stockpile ESG", a 2-row header at rows 15-16, one blank
// row 17, data starting row 18. Column letters below are the *confirmed*
// fallback only -- header-text resolution is tried first.

import {
  cellText,
  normalizeHeaderText,
  findMarkerColumns,
  decodeExcelSerial,
  makeLocalDate,
  parseEsgSpec,
  classifyEsgOreClass,
  createIssue,
} from './esg-adapter-utils.js';

const REQUIRED_MARKERS = ['Vehicle No', 'Date', 'Time Loaded', 'Cargo Weighing', 'Kode Dome'];
const HEADER_WINDOW = { windowSize: 2, maxScanRow: 40 };
const VEHICLE_PREFIX = 'SCM';
const BUYER_EVIDENCE_TEXT = 'STOCKPILE ESG';

// Confirmed physical fallback columns (0-indexed) from the real sample --
// only used if header-text resolution fails, and only after this format
// has already been positively identified by the detector and the fallback
// columns' first data row is sanity-checked against expected data types.
const FALLBACK_COLUMNS = {
  'Vehicle No': 2, // C
  Date: 3,         // D
  'Time Loaded': 4, // E
  'Cargo Weighing': 8, // I
  'Kode Dome': 10,  // K
};

function resolveColumns(matrix) {
  const match = findMarkerColumns(matrix, REQUIRED_MARKERS, HEADER_WINDOW);
  if (match) {
    const columns = {};
    REQUIRED_MARKERS.forEach((marker) => { columns[marker] = match.columns[marker].col; });
    return { columns, dataStartRow: match.dataStartRow, headerStartRow: match.headerStartRow, source: 'header-text' };
  }

  // Fallback: fixed columns, sanity-checked against the first plausible
  // data row before being trusted (never applied blind).
  const probeRow = matrix.find((row) => row && String(row[FALLBACK_COLUMNS['Vehicle No']] || '').trim().toUpperCase().startsWith(VEHICLE_PREFIX));
  if (!probeRow) return null;
  const netProbe = probeRow[FALLBACK_COLUMNS['Cargo Weighing']];
  const dateProbe = probeRow[FALLBACK_COLUMNS.Date];
  if (typeof netProbe !== 'number' || typeof dateProbe !== 'number') return null;
  return { columns: FALLBACK_COLUMNS, dataStartRow: 0, headerStartRow: 0, source: 'fixed-column-fallback' };
}

function findBuyerEvidence(matrix, beforeRow) {
  for (let r = 0; r < Math.min(beforeRow, matrix.length); r++) {
    const row = matrix[r] || [];
    for (let c = 0; c < row.length; c++) {
      const text = normalizeHeaderText(row[c]);
      if (text.includes(BUYER_EVIDENCE_TEXT)) {
        return { type: 'letterhead-metadata', label: 'Port', value: cellText(row[c]), row: r + 1, col: c + 1 };
      }
    }
  }
  return null;
}

export function parseEsgFormatA(workbook, detection) {
  const sheetName = detection.selectedSheet;
  const ws = workbook.Sheets[sheetName];
  const matrix = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: '' });

  const resolved = resolveColumns(matrix);
  const issues = [];
  const warnings = [];
  const rows = [];

  if (!resolved) {
    issues.push(createIssue('header-resolution-failed', 'Kolom Format A tidak dapat ditemukan (header text maupun fallback kolom tetap gagal divalidasi).'));
    return { buyer: 'ESG', workbookFormat: 'ESG_FORMAT_A', sheetName, rows, buyerEvidence: null, warnings, issues };
  }

  const col = resolved.columns;
  const buyerEvidence = findBuyerEvidence(matrix, resolved.headerStartRow);
  if (!buyerEvidence) {
    issues.push(createIssue('missing-buyer-evidence', 'Tidak ditemukan bukti buyer ESG pada metadata/letterhead (mis. "Stockpile ESG").'));
  }

  const datesSeen = new Set();

  for (let r = resolved.dataStartRow; r < matrix.length; r++) {
    const row = matrix[r] || [];
    const sourceRow = r + 1;
    const vehicleRaw = row[col['Vehicle No']];
    const vehicleNo = cellText(vehicleRaw);
    if (!vehicleNo) continue; // non-data row (blank), silently excluded
    if (!vehicleNo.toUpperCase().startsWith(VEHICLE_PREFIX)) continue; // does not match the valid-row signature (letterhead/footer/signature text)

    // From here the row matches the valid-row signature -- every problem
    // below is a blocking issue, not a silent skip.
    let rowOk = true;

    const dateSerial = row[col.Date];
    const dateParts = typeof dateSerial === 'number' ? decodeExcelSerial(dateSerial) : null;
    if (!dateParts) {
      issues.push(createIssue('invalid-date', `Tanggal tidak valid pada baris ${sourceRow}.`, { sourceRow, vehicleNo }));
      rowOk = false;
    }

    const timeSerial = row[col['Time Loaded']];
    const timeParts = typeof timeSerial === 'number' ? decodeExcelSerial(timeSerial) : null;
    if (!timeParts) {
      issues.push(createIssue('invalid-loaded-time', `Jam timbang isi (Time Loaded) tidak valid pada baris ${sourceRow}.`, { sourceRow, vehicleNo }));
      rowOk = false;
    }

    const netRaw = row[col['Cargo Weighing']];
    const netTon = typeof netRaw === 'number' ? netRaw : NaN;
    if (isNaN(netTon)) {
      issues.push(createIssue('invalid-weight', `Berat (Cargo Weighing) bukan angka pada baris ${sourceRow}.`, { sourceRow, vehicleNo }));
      rowOk = false;
    } else if (netTon <= 0) {
      issues.push(createIssue('non-positive-weight', `Berat harus lebih dari nol pada baris ${sourceRow} (nilai: ${netTon}).`, { sourceRow, vehicleNo }));
      rowOk = false;
    }

    const specRaw = row[col['Kode Dome']];
    const spec = parseEsgSpec(specRaw);
    if (!spec.valid) {
      issues.push(createIssue('invalid-specification', `Spesifikasi/Kode Dome tidak valid pada baris ${sourceRow} (nilai: "${cellText(specRaw)}").`, { sourceRow, vehicleNo }));
      rowOk = false;
    }

    if (!rowOk) continue;

    const date = makeLocalDate(dateParts.y, dateParts.m, dateParts.d);
    const loadedAt = makeLocalDate(dateParts.y, dateParts.m, dateParts.d, timeParts.H, timeParts.M, timeParts.S);
    if (!date || !loadedAt) {
      issues.push(createIssue('invalid-date', `Tanggal/jam tidak dapat dibentuk menjadi Date yang valid pada baris ${sourceRow}.`, { sourceRow, vehicleNo }));
      continue;
    }

    datesSeen.add(`${dateParts.y}-${dateParts.m}-${dateParts.d}`);

    rows.push({
      sourceRow,
      vehicleNo,
      netKg: netTon * 1000,
      loadedAt,
      date,
      dome: spec.dome,
      grade: spec.grade,
      oreClass: classifyEsgOreClass(spec.grade),
    });
  }

  if (datesSeen.size > 1) {
    warnings.push({ type: 'date-mismatch', message: `Ada lebih dari 1 tanggal berbeda di antara baris valid (${datesSeen.size} tanggal ditemukan).` });
  }

  return {
    buyer: 'ESG',
    workbookFormat: 'ESG_FORMAT_A',
    sheetName,
    rows,
    buyerEvidence,
    warnings,
    issues,
  };
}
