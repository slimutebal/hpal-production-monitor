// ESG workbook Format B adapter ("SCM/ESG raw data" style). Responsible
// only for: validating Format B, locating its header, selecting valid data
// rows, parsing required row values, converting raw tons to the normalized
// kg convention, combining/validating date + text loaded-time, and
// normalizing specification/dome/grade/ore-class. Does not calculate
// Daily/WTD/MTD/YTD, build report text, assign loading areas, or resolve
// contractors -- see esg-profile.js for the isolated-layer scope.
//
// Confirmed from the real sample workbook
// (docs/references/08月05日SCM-ESG送矿汇总表 (Data Timbangan Ore 05 Agustus
// 2026) NIGHT SHIFT.xlsx, local-only, git-ignored): two sheets -- a raw
// data sheet ("DATA ORE 05 AGUSTUS 2026", header at row 4, 475 valid rows)
// and a separate pre-aggregated summary sheet, which must never be selected
// as the source (it does not carry this format's required header markers
// at all, so it is excluded by construction, not by name).

import {
  cellText,
  findMarkerColumns,
  decodeExcelSerial,
  makeLocalDate,
  parseEsgSpec,
  classifyEsgOreClass,
  createIssue,
} from './esg-adapter-utils.js';

const REQUIRED_MARKERS = ['NO.NOTA', 'NO. DT', 'PENERIMA', 'TIMBANGAN BERSIH', 'JAM TIMBANG ISI', 'TANGGAL', 'KODE ORE'];
const HEADER_WINDOW = { windowSize: 1, maxScanRow: 20 };
const NOTA_PREFIX = '20';
const PENERIMA_EXPECTED = 'ESG-FPP';

// Confirmed physical fallback columns (0-indexed) from the real sample --
// only used if header-text resolution fails, sanity-checked before use.
const FALLBACK_COLUMNS = {
  'NO.NOTA': 2,             // C
  'NO. DT': 3,              // D
  PENERIMA: 6,              // G
  'TIMBANGAN BERSIH': 9,    // J
  'JAM TIMBANG ISI': 10,    // K
  TANGGAL: 13,              // N
  'KODE ORE': 15,           // P
};

// Format B's "Time Loaded" column is text like "26-08-05 19:02" -- a
// 2-digit year, confirmed YY-MM-DD HH:MM shape (mirrors the app's own
// Monitor precedent, parseESGTime in index.html). Deliberately not routed
// through Date.parse(), which is locale/engine-dependent for this exact
// ambiguous shape; matched with a strict anchored regex instead so an
// unexpected string shape fails closed rather than silently misparsing.
function parseLoadedTimeText(raw) {
  const str = cellText(raw);
  const m = str.match(/^(\d{2})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2})$/);
  if (!m) return null;
  const y = 2000 + parseInt(m[1], 10);
  const mo = parseInt(m[2], 10);
  const d = parseInt(m[3], 10);
  const h = parseInt(m[4], 10);
  const mnt = parseInt(m[5], 10);
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mnt > 59) return null;
  return { y, m: mo, d, H: h, M: mnt, S: 0 };
}

function resolveColumns(matrix) {
  const match = findMarkerColumns(matrix, REQUIRED_MARKERS, HEADER_WINDOW);
  if (match) {
    const columns = {};
    REQUIRED_MARKERS.forEach((marker) => { columns[marker] = match.columns[marker].col; });
    return { columns, dataStartRow: match.dataStartRow, source: 'header-text' };
  }

  const probeRow = matrix.find((row) => row && String(row[FALLBACK_COLUMNS['NO.NOTA']] || '').trim().startsWith(NOTA_PREFIX));
  if (!probeRow) return null;
  const netProbe = probeRow[FALLBACK_COLUMNS['TIMBANGAN BERSIH']];
  const dateProbe = probeRow[FALLBACK_COLUMNS.TANGGAL];
  if (typeof netProbe !== 'number' || typeof dateProbe !== 'number') return null;
  return { columns: FALLBACK_COLUMNS, dataStartRow: 0, source: 'fixed-column-fallback' };
}

export function parseEsgFormatB(workbook, detection) {
  const sheetName = detection.selectedSheet;
  const ws = workbook.Sheets[sheetName];
  const matrix = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: '' });

  const resolved = resolveColumns(matrix);
  const issues = [];
  const warnings = [];
  const rows = [];
  let buyerEvidence = null;

  if (!resolved) {
    issues.push(createIssue('header-resolution-failed', 'Kolom Format B tidak dapat ditemukan (header text maupun fallback kolom tetap gagal divalidasi).'));
    return { buyer: 'ESG', workbookFormat: 'ESG_FORMAT_B', sheetName, rows, buyerEvidence, warnings, issues };
  }

  const col = resolved.columns;
  const datesSeen = new Set();

  for (let r = resolved.dataStartRow; r < matrix.length; r++) {
    const row = matrix[r] || [];
    const sourceRow = r + 1;
    const notaRaw = row[col['NO.NOTA']];
    const nota = cellText(notaRaw);
    if (!nota) continue; // non-data row (blank), silently excluded
    if (!nota.startsWith(NOTA_PREFIX)) continue; // footer/subtotal/signature rows do not satisfy the NO.NOTA signature

    let rowOk = true;

    const vehicleNo = cellText(row[col['NO. DT']]);
    if (!vehicleNo) {
      issues.push(createIssue('missing-vehicle-no', `NO. DT kosong pada baris ${sourceRow}.`, { sourceRow, nota }));
      rowOk = false;
    }

    const penerimaRaw = cellText(row[col.PENERIMA]);
    const penerimaOk = penerimaRaw.trim().toUpperCase() === PENERIMA_EXPECTED;
    if (!penerimaOk) {
      issues.push(createIssue('unsupported-penerima', `PENERIMA tidak sesuai "${PENERIMA_EXPECTED}" pada baris ${sourceRow} (nilai: "${penerimaRaw}").`, { sourceRow, vehicleNo, value: penerimaRaw }));
      rowOk = false;
    } else if (!buyerEvidence) {
      buyerEvidence = { type: 'penerima-field', label: 'PENERIMA', value: penerimaRaw, sourceRow };
    }

    const dateSerial = row[col.TANGGAL];
    const dateParts = typeof dateSerial === 'number' ? decodeExcelSerial(dateSerial) : null;
    if (!dateParts) {
      issues.push(createIssue('invalid-date', `TANGGAL tidak valid pada baris ${sourceRow}.`, { sourceRow, vehicleNo }));
      rowOk = false;
    }

    const timeText = row[col['JAM TIMBANG ISI']];
    const timeParts = parseLoadedTimeText(timeText);
    if (!timeParts) {
      issues.push(createIssue('invalid-loaded-time', `JAM TIMBANG ISI tidak sesuai format "YY-MM-DD HH:MM" pada baris ${sourceRow} (nilai: "${cellText(timeText)}").`, { sourceRow, vehicleNo }));
      rowOk = false;
    }

    // TANGGAL and the date embedded in JAM TIMBANG ISI's text are two
    // independent sources for the same operational event, but they are not
    // always the same calendar date by design: TANGGAL records the shift's
    // operational date, while JAM TIMBANG ISI is the actual weigh-in
    // timestamp, which legitimately rolls into the next calendar day for
    // loads weighed after midnight during a night shift (confirmed against
    // the real sample workbook: TANGGAL stays 2026-08-05 for the whole
    // NIGHT SHIFT file while JAM TIMBANG ISI shows 2026-08-06 for rows
    // timestamped after 00:00 -- treating that as an error would incorrectly
    // block ~40% of that file's otherwise-valid rows). A same-day or
    // next-day relationship is accepted; anything else (JAM TIMBANG ISI
    // before TANGGAL, or more than one day after it) is not explained by
    // the midnight-crossover case and is treated as a genuine inconsistency.
    if (dateParts && timeParts) {
      const tanggalOrdinal = Date.UTC(dateParts.y, dateParts.m - 1, dateParts.d);
      const jamOrdinal = Date.UTC(timeParts.y, timeParts.m - 1, timeParts.d);
      const dayDiff = Math.round((jamOrdinal - tanggalOrdinal) / 86400000);
      if (dayDiff !== 0 && dayDiff !== 1) {
        issues.push(createIssue('date-time-mismatch', `TANGGAL dan tanggal pada JAM TIMBANG ISI tidak konsisten pada baris ${sourceRow} (selisih ${dayDiff} hari).`, { sourceRow, vehicleNo }));
        rowOk = false;
      }
    }

    const netRaw = row[col['TIMBANGAN BERSIH']];
    const netTon = typeof netRaw === 'number' ? netRaw : NaN;
    if (isNaN(netTon)) {
      issues.push(createIssue('invalid-weight', `TIMBANGAN BERSIH bukan angka pada baris ${sourceRow}.`, { sourceRow, vehicleNo }));
      rowOk = false;
    } else if (netTon <= 0) {
      issues.push(createIssue('non-positive-weight', `TIMBANGAN BERSIH harus lebih dari nol pada baris ${sourceRow} (nilai: ${netTon}).`, { sourceRow, vehicleNo }));
      rowOk = false;
    }

    const specRaw = row[col['KODE ORE']];
    const spec = parseEsgSpec(specRaw);
    if (!spec.valid) {
      issues.push(createIssue('invalid-specification', `KODE ORE tidak valid pada baris ${sourceRow} (nilai: "${cellText(specRaw)}").`, { sourceRow, vehicleNo }));
      rowOk = false;
    }

    if (!rowOk) continue;

    const date = makeLocalDate(dateParts.y, dateParts.m, dateParts.d);
    const loadedAt = makeLocalDate(timeParts.y, timeParts.m, timeParts.d, timeParts.H, timeParts.M, timeParts.S);
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

  if (!buyerEvidence) {
    issues.push(createIssue('missing-buyer-evidence', `Tidak ada baris valid dengan PENERIMA = "${PENERIMA_EXPECTED}".`));
  }
  if (datesSeen.size > 1) {
    warnings.push({ type: 'date-mismatch', message: `Ada lebih dari 1 tanggal berbeda di antara baris valid (${datesSeen.size} tanggal ditemukan).` });
  }

  return {
    buyer: 'ESG',
    workbookFormat: 'ESG_FORMAT_B',
    sheetName,
    rows,
    buyerEvidence,
    warnings,
    issues,
  };
}
