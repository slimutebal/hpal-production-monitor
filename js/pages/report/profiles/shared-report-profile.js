// Shared parsing/calculation/report-text engine used by both the HYNC and
// SLNC profiles. Extracted from what was originally hync-profile.js once a
// real SLNC sample workbook confirmed the same sheet name, header set,
// spec-column shape, ore-class thresholds, and Daily/WTD/MTD/YTD rules
// apply to both buyers -- only the buyer token (used in a few output
// lines) and the 备注 column's buyer prefix genuinely differ. See
// docs/V2.0_ARCHITECTURE_AND_ROADMAP.md's Report HYNC/SLNC section.
//
// This module must never import hync-profile.js or slnc-profile.js (that
// would create an import cycle, since those two import this module).

import { parseIDNumber, fmtTon, fmtRit, formatDateID, parseDateID, sameDate, cleanInvisible, classifyShift, deriveAccumulationResets, accumulatePeriodValue } from '../report-utils.js';
import { lookupHyncContractor } from '../../../services/contractor-adapter.js';
import { lookupContractor, canonicalDtId } from '../../../services/contractor-directory-service.js';
import { buyerFromRemark, getBuyerDisplayLabel } from './profile-registry.js';

export const SHEET_NAME = '过磅明细';
export const REQUIRED_HEADERS = ['流水号', '车号', '净重', '毛重时间', '日期', '规格'];
export const REMARK_HEADER = '备注';
export const AREA_OPTIONS = ['BR1', 'BR23E', 'BR23W', 'DS'];
const LOADING_POINT_ORDER = ['DS', 'BR1', 'BR23E', 'BR23W'];

// Priority order for non-ADT contractors in the report's truck breakdown.
// Anything not listed here is shown afterward, alphabetically. Reused
// as-is for SLNC: SLNC weighbridge exports use a different DT ID string
// format (see resolveContractor below) but resolve into the same
// contractor roster once normalized, per contractor-adapter.js's data and
// the DT-normalization precedent already proven in Monitor (index.html).
const CONTRACTOR_PRIORITY = ['PMS', 'MRP', 'TII', 'REAL', 'JAM', 'STM', 'MIM', 'HYNC'];

// Non-ADT contractors that must be merged into a single display name in the
// report. Add new rows here if another merge is approved operationally.
const CONTRACTOR_ALIAS = {
  HILLCON: 'PMS',
};

// Exact literal column widths for the contractor-breakdown lines in the
// generated WhatsApp report text ("<name>...: <count> Trucks"), confirmed
// against the Owner-approved HYNC/SLNC (PMS/MRP) and EIEB (TII/REAL)
// examples. These are hand-tuned per contractor name, not one generic
// padEnd formula (PMS/MRP both align at 34, but TII at 37 and REAL at 33
// -- genuinely different widths), so unlisted contractor names fall back
// to the pre-existing generic width instead of guessing a new literal.
const CONTRACTOR_LINE_WIDTH = { PMS: 34, MRP: 34, TII: 37, REAL: 33 };
const DEFAULT_CONTRACTOR_LINE_WIDTH = 20;

// "Number of Truck[.]" line: HYNC/SLNC keep the trailing period and a
// 25-column width; the internal ESG buyer (displayed as EIEB) drops the
// period and uses a 24-column width -- both Owner-approved literal
// examples, not derived from one shared rule.
const NUMBER_OF_TRUCK_LINE = {
  HYNC: { label: 'Number of Truck.', width: 25 },
  SLNC: { label: 'Number of Truck.', width: 25 },
  ESG: { label: 'Number of Truck', width: 24 },
};
const DEFAULT_NUMBER_OF_TRUCK_LINE = NUMBER_OF_TRUCK_LINE.HYNC;

// SLNC DT id normalization, mirrored from Monitor's own normalizeDT()
// (index.html) rather than re-derived: "SCM LIM 982 DT" -> "SCM-LIM 982".
// Applied only as a fallback after a raw lookup fails, so real HYNC ids
// (already hyphenated, no trailing " DT") are never affected -- confirmed
// no-op for HYNC id shapes since neither pattern below matches them.
function normalizeSlncDt(dt) {
  let s = String(dt).trim();
  s = s.replace(/\s+DT$/i, '');
  s = s.replace(/^SCM\s+LIM\s+/i, 'SCM-LIM ');
  return s;
}

// Monitor-owned single-sync architecture: the shared, Monitor-synced
// contractor directory (contractor-directory-service.js, reading
// hpal.contractors.v1 -- the one and only List DT sync in the
// application, owned by contractor-assignment.js) is always consulted
// first, so a DT added or corrected through Monitor's sync is recognized
// here without touching this file's own logic.
//
// For an SCM-shaped id (canonicalDtId(carNo) non-empty -- i.e. the
// "SCM-HLG"/"SCM-LIM" family this synced directory actually covers), the
// Monitor-synced directory is the SOLE authoritative source: no static
// fallback is consulted, even though contractor-adapter.js's static
// HYNC_DT_LIST happens to also contain many SCM-LIM entries -- those are
// a stale, hand-copied snapshot (see that file's own header comment) and
// must never silently stand in for a live Monitor sync once that sync is
// the approved source of truth for this id family. An SCM-shaped id with
// no synced match is unmatched, not silently guessed from static data.
//
// contractor-adapter.js's static table remains the fallback only for ids
// genuinely outside the SCM-shaped family (ADT/MIM/STM/legacy DT-prefixed
// units), which canonicalDtId() never resolves to a key at all -- those
// were never part of the synced directory's key space in the first
// place. SLNC is not given a second, separately-maintained static table
// -- only a normalization fallback in front of the same read-only static
// lookup, per the task's explicit "do not create a second contractor
// table" instruction.
//
// Exported (like parseFlexibleDate() above) so tests can exercise the real
// HYNC/SLNC contractor-resolution precedence directly, without needing a
// full XLSX workbook fixture -- see tests/report-contractor-sync.test.mjs.
export function resolveContractor(carNo) {
  const synced = lookupContractor(carNo);
  if (synced) return synced;
  if (canonicalDtId(carNo)) return null; // SCM-shaped: Monitor-synced directory is authoritative, no static fallback
  return lookupHyncContractor(carNo) || lookupHyncContractor(normalizeSlncDt(carNo));
}

/* ============================================================
   PREVIOUS REPORT TEXT PARSING
============================================================ */
export function parsePrevText(raw) {
  const text = cleanInvisible(raw);
  const errors = [];
  const out = { date: null, week: null, daily: { ton: 0, rit: 0 }, wtd: { ton: 0, rit: 0 }, mtd: { ton: 0, rit: 0 }, ytd: { ton: 0, rit: 0 } };

  const dateMatch = text.match(/Date\s*:\s*([^\n\r]+)/i);
  if (!dateMatch) {
    errors.push('Tidak menemukan baris "Date" di teks report sebelumnya.');
  } else {
    out.date = parseDateID(dateMatch[1].trim());
    if (!out.date) errors.push(`Tidak bisa membaca format tanggal: "${dateMatch[1].trim()}"`);
  }

  // Week is parsed for validation/display consistency only (see
  // report-utils.js's findPreviousWeekMismatch()) -- it never decides
  // period resets and its absence is never an error; the previous report's
  // own Date remains the sole canonical period source.
  const weekMatch = text.match(/Week\s*:\s*(\d+)/i);
  out.week = weekMatch ? parseInt(weekMatch[1], 10) : null;

  function grab(label) {
    const re = new RegExp(label + '\\s*:\\s*([\\d.,]+)\\s*wmt\\s*\\[\\s*([\\d.,]+)\\s*Rit', 'i');
    const m = text.match(re);
    if (!m) {
      errors.push(`Tidak menemukan baris "${label}" (format: ... wmt [ ... Rit ]).`);
      return { ton: 0, rit: 0 };
    }
    return { ton: parseIDNumber(m[1]), rit: parseIDNumber(m[2]) };
  }
  out.daily = grab('Daily');
  out.wtd = grab('WTD');
  out.mtd = grab('MTD');
  out.ytd = grab('YTD');

  return { ...out, errors };
}

/* ============================================================
   WEIGHBRIDGE WORKBOOK PARSING
============================================================ */
function parseFlexibleDateTime(val) {
  if (val instanceof Date && !isNaN(val)) return val;
  if (typeof val === 'string') {
    const m = val.match(/(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/);
    if (m) return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
    const d = new Date(val);
    if (!isNaN(d)) return d;
  }
  if (typeof val === 'number') {
    const d = XLSX.SSF.parse_date_code(val);
    if (d) return new Date(d.y, d.m - 1, d.d, d.H || 0, d.M || 0, Math.floor(d.S || 0));
    return null;
  }
  return null;
}

// Exported so Automatic Week's tests can exercise HYNC/SLNC's real
// date-construction path (not a re-implementation of it) -- see
// tests/report-week.test.mjs. No behavioral change: this function's body,
// call sites, and every result it already produced are unchanged.
export function parseFlexibleDate(val) {
  if (typeof val === 'number') {
    const d = XLSX.SSF.parse_date_code(val);
    if (d) return new Date(d.y, d.m - 1, d.d);
    return null;
  }
  if (typeof val === 'string') {
    const m = val.match(/(\d{4})-(\d{2})-(\d{2})/);
    if (m) return new Date(+m[1], +m[2] - 1, +m[3]);
  }
  if (val instanceof Date && !isNaN(val)) return new Date(val.getFullYear(), val.getMonth(), val.getDate());
  return null;
}

// Dome/grade extraction. Supports both "DOME ( NI:1.25 )" (existing HYNC
// data) and "DOME (1.25)" (SLNC, per the task's confirmed examples) -- the
// "NI:" token is optional, everything else about the original HYNC regex
// (anchored full match, comma-or-dot decimal) is unchanged, so every
// previously-valid HYNC spec string parses to the exact same {dome, grade}
// as before. On no match, degrades the same way the original code did
// (dome falls back to the raw spec text, grade/oreClass stay unset) rather
// than throwing -- preserving the existing non-blocking behavior for rows
// with a malformed 规格 cell.
export function parseSpec(specRaw) {
  const str = String(specRaw || '').trim();
  const m = str.match(/^(.*?)\s*\(\s*(?:NI\s*:\s*)?([\d.,]+)\s*\)\s*$/i);
  if (m) {
    const dome = m[1].trim();
    const grade = parseFloat(m[2].replace(',', '.'));
    if (dome && !isNaN(grade)) return { dome, grade, valid: true };
  }
  return { dome: str || '(tanpa spesifikasi)', grade: null, valid: false };
}

// Ore-class thresholds are unchanged and buyer-agnostic (also confirmed by
// Monitor's own identical classifyOre() in index.html, applied there for
// both HYNC and SLNC alike).
export function classifyOreClass(grade) {
  if (grade === null || grade === undefined || isNaN(grade)) return '-';
  return grade > 1.4 ? 'HGLO' : (grade < 1.2 ? 'LGLO' : 'MGLO');
}

// Resolves the buyer for one already-parsed workbook from the per-row 备注
// classifications collected during the row loop. Implements the workbook
// validation rules: a single confirmed buyer succeeds; any blank or
// unsupported (non-SCHY/SCSL) value blocks as "unrecognized"; more than
// one buyer prefix present blocks as "mixed". Multiple distinct codes for
// the SAME buyer (e.g. two different SCSL-xxxxxxx values) are explicitly
// not an issue -- only prefix identity is tallied, never the full code.
function resolveWorkbookBuyer(remarkTally) {
  const buyersFound = new Set();
  const unrecognized = [];
  remarkTally.forEach(({ excelRow, rawValue, result }) => {
    if (result.status === 'ok') buyersFound.add(result.buyer);
    else unrecognized.push({ row: excelRow, value: rawValue });
  });

  if (unrecognized.length) {
    return {
      workbookBuyer: null,
      workbookBuyerIssues: [{ type: 'unrecognized', rows: unrecognized.map((e) => e.row), samples: unrecognized.slice(0, 5) }],
    };
  }
  if (buyersFound.size > 1) {
    const issues = Array.from(buyersFound).map((buyer) => ({
      type: 'mixed',
      buyer,
      rows: remarkTally.filter((t) => t.result.status === 'ok' && t.result.buyer === buyer).map((t) => t.excelRow),
    }));
    return { workbookBuyer: null, workbookBuyerIssues: issues };
  }
  if (buyersFound.size === 1) {
    return { workbookBuyer: Array.from(buyersFound)[0], workbookBuyerIssues: null };
  }
  // No rows at all reached this point (shouldn't happen -- the caller
  // already throws earlier if `records` is empty), but fail closed.
  return { workbookBuyer: null, workbookBuyerIssues: [{ type: 'unrecognized', rows: [], samples: [] }] };
}

// workbook: a SheetJS workbook (from XLSX.read). Throws on any structural
// problem (empty sheet, missing header, no data rows) with a message meant
// to be shown to the user as-is. Buyer-agnostic: does not need to know the
// buyer in advance, since the buyer is itself detected from this same
// parse (see workbookBuyer/workbookBuyerIssues on the return value).
export function parseWeighbridgeWorkbook(workbook) {
  if (typeof XLSX === 'undefined' || !XLSX.utils) {
    throw new Error('Library Excel belum siap. Muat ulang aplikasi lalu coba lagi.');
  }

  const sheetName = workbook.SheetNames.includes(SHEET_NAME) ? SHEET_NAME : workbook.SheetNames[0];
  const ws = workbook.Sheets[sheetName];
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: '' });

  if (!rows.length) throw new Error('Sheet kosong / tidak terbaca.');

  const header = rows[0].map((h) => String(h).trim());
  const idx = {};
  REQUIRED_HEADERS.forEach((col) => {
    const i = header.indexOf(col);
    if (i === -1) throw new Error(`Kolom "${col}" tidak ditemukan di sheet "${sheetName}". Pastikan upload data timbangan yang benar.`);
    idx[col] = i;
  });
  // 备注 (buyer remark) is read for buyer detection but, unlike the
  // structural headers above, its absence doesn't abort the parse -- every
  // row simply reads as a blank remark, which resolveWorkbookBuyer already
  // reports as "unrecognized" (blocking buyer confirmation, same end
  // result as a hard error, but surfaced through the buyer-validation UI
  // rather than the file-upload error box).
  const remarkIdx = header.indexOf(REMARK_HEADER);

  const records = [];
  const unmatched = new Set();
  const remarkTally = [];
  let detectedDate = null;
  let dateMismatch = false;

  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    if (!row || row.length === 0) continue;
    const carNoRaw = row[idx['车号']];
    if (!carNoRaw || String(carNoRaw).trim() === '') continue;
    const carNo = String(carNoRaw).trim();

    const netKg = parseFloat(row[idx['净重']]) || 0;
    const grossTime = parseFlexibleDateTime(row[idx['毛重时间']]);
    const rowDate = parseFlexibleDate(row[idx['日期']]);
    if (rowDate) {
      if (!detectedDate) detectedDate = rowDate;
      else if (!sameDate(detectedDate, rowDate)) dateMismatch = true;
    }

    const specParsed = parseSpec(row[idx['规格']]);
    const dome = specParsed.dome;
    const grade = specParsed.grade;
    const oreClass = classifyOreClass(grade);

    const contractor = resolveContractor(carNo);
    if (!contractor) unmatched.add(carNo);

    records.push({ carNo, netKg, grossTime, dome, grade, oreClass, contractor: contractor || 'TIDAK DIKENALI' });

    const remarkRaw = remarkIdx === -1 ? '' : row[remarkIdx];
    remarkTally.push({ excelRow: r + 1, rawValue: String(remarkRaw ?? '').trim(), result: buyerFromRemark(remarkRaw) });
  }

  if (!records.length) throw new Error('Tidak ada baris data yang terbaca (cek isi file).');

  const onShiftRit = records.length;
  const onShiftTon = records.reduce((sum, r) => sum + r.netKg, 0) / 1000;

  // Shift detection (bug fix): classifies every valid 毛重时间 timestamp in
  // the workbook -- not a sorted-first-20 sample -- and decides by majority
  // vote via report-utils.js's classifyShift(). Preserves the exact
  // documented HYNC/SLNC window (05:01-17:00, inclusive both ends; see
  // classifyShift()'s header comment for the citation). A tie or a
  // workbook with no valid timestamp at all comes back unresolved
  // (shiftLabel: null) rather than silently defaulting to Day Shift --
  // goToStep2() in report-page.js blocks progression in that case.
  const shiftResult = classifyShift(records.map((r) => r.grossTime), {
    dayStartSec: 5 * 3600 + 60,
    dayEndSec: 17 * 3600,
    dayEndInclusive: true,
  });
  const shiftLabel = shiftResult.shiftLabel;
  const shiftFallback = shiftResult.status === 'unresolved';

  // Unique domes, first-seen order.
  const seen = new Set();
  const domes = [];
  records.forEach((r) => {
    if (!seen.has(r.dome)) {
      seen.add(r.dome);
      domes.push({ dome: r.dome, oreClass: r.oreClass });
    }
  });

  // Contractor breakdown (unique trucks).
  const truckContractor = new Map();
  records.forEach((r) => {
    if (!truckContractor.has(r.carNo)) truckContractor.set(r.carNo, r.contractor);
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

  const { workbookBuyer, workbookBuyerIssues } = resolveWorkbookBuyer(remarkTally);

  return {
    sheetName,
    fileDate: detectedDate,
    records,
    domes,
    shiftLabel,
    shiftFallback,
    shiftStatus: shiftResult.status,
    shiftDayCount: shiftResult.dayCount,
    shiftNightCount: shiftResult.nightCount,
    shiftInvalidCount: shiftResult.invalidCount,
    onShiftTon,
    onShiftRit,
    contractorCounts: nonAdtEntries,
    totalADT,
    totalDT,
    unmatchedTrucks: Array.from(unmatched),
    dateMismatch,
    workbookBuyer,
    workbookBuyerIssues,
  };
}

export function buildFileSummary(parsed) {
  let s = `${parsed.records.length} baris timbangan terbaca\n`;
  s += `Tanggal terdeteksi : ${parsed.fileDate ? formatDateID(parsed.fileDate) : '-'}\n`;
  s += `Shift terdeteksi    : ${parsed.shiftLabel || 'Tidak dapat ditentukan'}\n`;
  s += `On Shift            : ${fmtTon(parsed.onShiftTon)} wmt [ ${fmtRit(parsed.onShiftRit)} Rit ]\n`;
  s += `Dome ditemukan      : ${parsed.domes.length}`;
  if (parsed.unmatchedTrucks.length) {
    s += `\n⚠ ${parsed.unmatchedTrucks.length} no. truck tidak ada di List_DT: ${parsed.unmatchedTrucks.slice(0, 6).join(', ')}${parsed.unmatchedTrucks.length > 6 ? ', ...' : ''}`;
  }
  return s;
}

/* ============================================================
   DAILY / WTD / MTD / YTD CALCULATION
============================================================ */
// Bug fix (period-aware accumulation): WTD/MTD/YTD used to accumulate
// unconditionally (`prev.X + current`) with no period-boundary check at
// all, so a new ISO week/month/year never reset them -- only Daily had a
// reset rule. Each of the four buckets is now period-scoped independently
// (see report-utils.js's deriveAccumulationResets(), reused unchanged by
// every buyer profile via this one shared function):
//   - Daily: unchanged, pre-existing rule -- Day Shift is always the first
//     shift of an operational day and always resets; Night Shift continues
//     the same day's Day Shift only if the previous report's date actually
//     matches the file's date (otherwise the previous Daily figure is
//     stale and resets too). Deliberately NOT swapped for the generic
//     resetDaily from deriveAccumulationResets(), which does not know
//     about shiftLabel.
//   - WTD: resets on any ISO week OR ISO week-year change.
//   - MTD: resets on any calendar month or year change.
//   - YTD: resets on any calendar year change.
// A missing/invalid previous date (e.g. the ESG empty-previous-report
// case) makes every one of these comparisons false, so every bucket
// naturally resets to the current On Shift alone -- never a literal 0
// unless On Shift itself is 0 (accumulatePeriodValue()'s own rule).
export function calculateTotals({ parsed, prev }) {
  const prevDate = prev && prev.date;
  const resets = deriveAccumulationResets(prevDate, parsed.fileDate);

  const isNightContinuation = parsed.shiftLabel === 'Night Shift' && sameDate(prevDate, parsed.fileDate);
  const dailyTon = accumulatePeriodValue(prev.daily.ton, parsed.onShiftTon, isNightContinuation);
  const dailyRit = accumulatePeriodValue(prev.daily.rit, parsed.onShiftRit, isNightContinuation);
  const wtdTon = accumulatePeriodValue(prev.wtd.ton, parsed.onShiftTon, !resets.resetWtd);
  const wtdRit = accumulatePeriodValue(prev.wtd.rit, parsed.onShiftRit, !resets.resetWtd);
  const mtdTon = accumulatePeriodValue(prev.mtd.ton, parsed.onShiftTon, !resets.resetMtd);
  const mtdRit = accumulatePeriodValue(prev.mtd.rit, parsed.onShiftRit, !resets.resetMtd);
  const ytdTon = accumulatePeriodValue(prev.ytd.ton, parsed.onShiftTon, !resets.resetYtd);
  const ytdRit = accumulatePeriodValue(prev.ytd.rit, parsed.onShiftRit, !resets.resetYtd);

  return { isNightContinuation, periodResets: resets, dailyTon, dailyRit, wtdTon, wtdRit, mtdTon, mtdRit, ytdTon, ytdRit };
}

/* ============================================================
   REPORT TEXT
============================================================ */
// `buyer` ('HYNC' | 'SLNC' | 'ESG') is the only thing that varies the
// header between the approved formats -- everything else (section order,
// spacing, punctuation) is unconfirmed to differ and so is kept identical.
// `weekNumber` (V2.3 Phase 1: Automatic Week) is the caller's
// already-computed ISO week number for the workbook's date
// (report-utils.js's calculateIsoWeek()) -- this function does not
// calculate it and does not know about weekYear/weekStart/weekEnd; the
// output line only ever shows the numeric week, matching the pre-existing
// approved "Week  : <value>" format exactly. `personnelLines` (V2.3
// Phase 4: controlled personnel selection) is the caller's already-built
// personnel-section output (report-personnel.js's
// buildPersonnelOutputLines()) -- this function does not resolve
// personnel-directory ids or know about SPV/FRM/sampler/PIC shapes, it only
// places the lines the caller hands it, exactly like it already treats
// `weekNumber` as a pre-computed value rather than deriving it itself.
export function buildReportText({ buyer, parsed, inputs, domeAreas, totals, weekNumber, personnelLines }) {
  const buyerDisplay = getBuyerDisplayLabel(buyer);
  const numberOfTruckLine = NUMBER_OF_TRUCK_LINE[buyer] || DEFAULT_NUMBER_OF_TRUCK_LINE;
  const lines = [];
  lines.push('*DAILY PRODUCTION GEOLOGY REPORT*');
  lines.push('');
  lines.push(`*HPAL Ore Selling SCM - FPP ${buyerDisplay}*`);
  lines.push(`*Date    : ${parsed.fileDate ? formatDateID(parsed.fileDate) : '-'}*`);
  lines.push(`*Week  : ${weekNumber}*`);
  lines.push(`*Shift    : ${parsed.shiftLabel}*`);
  lines.push('');
  lines.push('Man Power and Support');
  (personnelLines || []).forEach((line) => lines.push(line));
  lines.push(`${numberOfTruckLine.label.padEnd(numberOfTruckLine.width, ' ')}: ${parsed.totalDT} DT + ${parsed.totalADT} ADT`);
  parsed.contractorCounts.forEach(([name, count]) => {
    const width = CONTRACTOR_LINE_WIDTH[name] || DEFAULT_CONTRACTOR_LINE_WIDTH;
    lines.push(`${name.padEnd(width, ' ')}: ${count} Trucks`);
  });
  if (parsed.totalADT > 0) {
    lines.push(`${'ADT'.padEnd(DEFAULT_CONTRACTOR_LINE_WIDTH, ' ')}: ${parsed.totalADT} Trucks`);
  }
  lines.push('');
  lines.push('Loading Point');
  LOADING_POINT_ORDER.forEach((area) => {
    const domesInArea = parsed.domes.filter((d) => domeAreas[d.dome] === area);
    if (domesInArea.length) {
      lines.push(`Pit ${area} :`);
      domesInArea.forEach((d, i) => lines.push(`${i + 1}. ${d.dome} (${d.oreClass})`));
      lines.push('');
    }
  });
  lines.push(`A. Ore Delivered to FPP ${buyerDisplay}`);
  lines.push(`On Shift    : ${fmtTon(parsed.onShiftTon)} wmt [ ${fmtRit(parsed.onShiftRit)} Rit ]`);
  lines.push(`Daily         : ${fmtTon(totals.dailyTon)} wmt [ ${fmtRit(totals.dailyRit)} Rit ]`);
  lines.push(`WTD         : ${fmtTon(totals.wtdTon)} wmt [ ${fmtRit(totals.wtdRit)} Rit ]`);
  lines.push(`MTD         : ${fmtTon(totals.mtdTon)} wmt [ ${fmtRit(totals.mtdRit)} Rit ]`);
  lines.push(`YTD          : ${fmtTon(totals.ytdTon)} wmt [ ${fmtRit(totals.ytdRit)} Rit ]`);
  lines.push('');
  lines.push('B. Problem and Action');
  lines.push(`1. Problem : ${inputs.problem || '-'}`);
  lines.push('');
  lines.push(`2. Preventive action : ${inputs.action || '-'}`);
  lines.push('');
  lines.push('TANGGUH');
  lines.push('SEMANGAT');
  lines.push('LUAR BIASA');

  return lines.join('\n');
}
