// HYNC report profile: sheet/header validation, dome/ore-class extraction,
// shift detection, previous-report parsing, Daily/WTD/MTD/YTD calculation,
// and the final report text builder. Preserves the exact operational
// behavior of docs/references/HYNC_daily_report_WAG.html.
//
// Function names are HYNC-specific on purpose (parseHyncWorkbook, not
// parseExcel) per docs/V2.0_ARCHITECTURE_AND_ROADMAP.md section 6.4, so a
// future ESG/SLNC profile can sit alongside this one without name clashes.

import { parseIDNumber, fmtTon, fmtRit, formatDateID, parseDateID, sameDate, cleanInvisible } from '../report-utils.js';
import { lookupHyncContractor } from '../../../services/contractor-adapter.js';

export const HYNC_SHEET_NAME = '过磅明细';
export const HYNC_REQUIRED_HEADERS = ['流水号', '车号', '净重', '毛重时间', '日期', '规格'];
export const HYNC_AREA_OPTIONS = ['BR', 'BR 23', 'DS'];

// Priority order for non-ADT contractors in the report's truck breakdown.
// Anything not listed here is shown afterward, alphabetically.
const CONTRACTOR_PRIORITY = ['PMS', 'MRP', 'TII', 'REAL', 'JAM', 'STM', 'MIM', 'HYNC'];

// Non-ADT contractors that must be merged into a single display name in the
// report. Add new rows here if another merge is approved operationally.
const CONTRACTOR_ALIAS = {
  HILLCON: 'PMS',
};

/* ============================================================
   PREVIOUS REPORT TEXT PARSING
============================================================ */
export function parseHyncPrevText(raw) {
  const text = cleanInvisible(raw);
  const errors = [];
  const out = { date: null, daily: { ton: 0, rit: 0 }, wtd: { ton: 0, rit: 0 }, mtd: { ton: 0, rit: 0 }, ytd: { ton: 0, rit: 0 } };

  const dateMatch = text.match(/Date\s*:\s*([^\n\r]+)/i);
  if (!dateMatch) {
    errors.push('Tidak menemukan baris "Date" di teks report sebelumnya.');
  } else {
    out.date = parseDateID(dateMatch[1].trim());
    if (!out.date) errors.push(`Tidak bisa membaca format tanggal: "${dateMatch[1].trim()}"`);
  }

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

function parseFlexibleDate(val) {
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

// workbook: a SheetJS workbook (from XLSX.read). Throws on any structural
// problem (empty sheet, missing header, no data rows) with a message meant
// to be shown to the user as-is.
export function parseHyncWorkbook(workbook) {
  if (typeof XLSX === 'undefined' || !XLSX.utils) {
    throw new Error('Library Excel belum siap. Muat ulang aplikasi lalu coba lagi.');
  }

  const sheetName = workbook.SheetNames.includes(HYNC_SHEET_NAME) ? HYNC_SHEET_NAME : workbook.SheetNames[0];
  const ws = workbook.Sheets[sheetName];
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: '' });

  if (!rows.length) throw new Error('Sheet kosong / tidak terbaca.');

  const header = rows[0].map((h) => String(h).trim());
  const idx = {};
  HYNC_REQUIRED_HEADERS.forEach((col) => {
    const i = header.indexOf(col);
    if (i === -1) throw new Error(`Kolom "${col}" tidak ditemukan di sheet "${sheetName}". Pastikan upload data timbangan yang benar.`);
    idx[col] = i;
  });

  const records = [];
  const unmatched = new Set();
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

    const specRaw = String(row[idx['规格']] || '').trim();
    const specMatch = specRaw.match(/^(.*?)\s*\(\s*NI\s*:\s*([\d.,]+)\s*\)\s*$/i);
    let dome;
    let grade;
    let oreClass;
    if (specMatch) {
      dome = specMatch[1].trim();
      grade = parseFloat(specMatch[2].replace(',', '.'));
      oreClass = grade > 1.4 ? 'HGLO' : (grade < 1.2 ? 'LGLO' : 'MGLO');
    } else {
      dome = specRaw || '(tanpa spesifikasi)';
      grade = null;
      oreClass = '-';
    }

    const contractor = lookupHyncContractor(carNo);
    if (!contractor) unmatched.add(carNo);

    records.push({ carNo, netKg, grossTime, dome, grade, oreClass, contractor: contractor || 'TIDAK DIKENALI' });
  }

  if (!records.length) throw new Error('Tidak ada baris data yang terbaca (cek isi file).');

  const onShiftRit = records.length;
  const onShiftTon = records.reduce((sum, r) => sum + r.netKg, 0) / 1000;

  // Shift detection: sort by grossTime, first 20, average time-of-day.
  const withTime = records
    .filter((r) => r.grossTime instanceof Date && !isNaN(r.grossTime))
    .slice()
    .sort((a, b) => a.grossTime - b.grossTime);
  let shiftLabel;
  let shiftFallback = false;
  if (withTime.length) {
    const sample = withTime.slice(0, 20);
    const avgSec = sample.reduce((s, r) => {
      const t = r.grossTime;
      return s + t.getHours() * 3600 + t.getMinutes() * 60 + t.getSeconds();
    }, 0) / sample.length;
    const dayStart = 5 * 3600 + 60; // 05:01:00
    const dayEnd = 17 * 3600; // 17:00:00
    shiftLabel = (avgSec >= dayStart && avgSec <= dayEnd) ? 'Day Shift' : 'Night Shift';
  } else {
    shiftLabel = 'Day Shift';
    shiftFallback = true;
  }

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

  return {
    sheetName,
    fileDate: detectedDate,
    records,
    domes,
    shiftLabel,
    shiftFallback,
    onShiftTon,
    onShiftRit,
    contractorCounts: nonAdtEntries,
    totalADT,
    totalDT,
    unmatchedTrucks: Array.from(unmatched),
    dateMismatch,
  };
}

export function buildHyncFileSummary(parsed) {
  let s = `${parsed.records.length} baris timbangan terbaca\n`;
  s += `Tanggal terdeteksi : ${parsed.fileDate ? formatDateID(parsed.fileDate) : '-'}\n`;
  s += `Shift terdeteksi    : ${parsed.shiftLabel}\n`;
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
// Day Shift is always the first shift of an operational day -> always
// resets. Night Shift continues the same day's Day Shift -> accumulates,
// but only if the previous report's date actually matches the file's date
// (otherwise treat the previous Daily figure as stale and reset too).
export function calculateHyncTotals({ parsed, prev }) {
  const isNightContinuation = parsed.shiftLabel === 'Night Shift' && sameDate(prev && prev.date, parsed.fileDate);
  const dailyTon = isNightContinuation ? (prev.daily.ton + parsed.onShiftTon) : parsed.onShiftTon;
  const dailyRit = isNightContinuation ? (prev.daily.rit + parsed.onShiftRit) : parsed.onShiftRit;
  const wtdTon = prev.wtd.ton + parsed.onShiftTon;
  const wtdRit = prev.wtd.rit + parsed.onShiftRit;
  const mtdTon = prev.mtd.ton + parsed.onShiftTon;
  const mtdRit = prev.mtd.rit + parsed.onShiftRit;
  const ytdTon = prev.ytd.ton + parsed.onShiftTon;
  const ytdRit = prev.ytd.rit + parsed.onShiftRit;

  return { isNightContinuation, dailyTon, dailyRit, wtdTon, wtdRit, mtdTon, mtdRit, ytdTon, ytdRit };
}

/* ============================================================
   REPORT TEXT
============================================================ */
export function buildHyncReportText({ parsed, inputs, domeAreas, totals }) {
  const picScmJoined = inputs.picScm.split(',').map((s) => s.trim()).filter(Boolean).join(' & ');

  const lines = [];
  lines.push('*DAILY PRODUCTION GEOLOGY REPORT*');
  lines.push('');
  lines.push('*HPAL Ore Selling SCM - FPP HYNC*');
  lines.push(`*Date    : ${parsed.fileDate ? formatDateID(parsed.fileDate) : '-'}*`);
  lines.push(`*Week  : ${inputs.week}*`);
  lines.push(`*Shift    : ${parsed.shiftLabel}*`);
  lines.push('');
  lines.push('Man Power and Support');
  lines.push(`PIC SCM : ${picScmJoined}`);
  lines.push(`PIC AWK : ${inputs.picAwk}`);
  lines.push(`Manpower AWK  : ${inputs.mpAwk}`);
  lines.push(`Total Manpower  : ${inputs.mpTotal}`);
  lines.push(`Number of Truck : ${parsed.totalDT} DT + ${parsed.totalADT} ADT`);
  parsed.contractorCounts.forEach(([name, count]) => {
    lines.push(`${name.padEnd(20, ' ')}: ${count} Trucks`);
  });
  if (parsed.totalADT > 0) {
    lines.push(`${'ADT'.padEnd(20, ' ')}: ${parsed.totalADT} Trucks`);
  }
  lines.push('');
  lines.push('Loading Point');
  ['DS', 'BR', 'BR 23'].forEach((area) => {
    const domesInArea = parsed.domes.filter((d) => domeAreas[d.dome] === area);
    if (domesInArea.length) {
      lines.push(`Pit ${area} :`);
      domesInArea.forEach((d, i) => lines.push(`${i + 1}. ${d.dome} (${d.oreClass})`));
      lines.push('');
    }
  });
  lines.push('A. Ore Delivered to FPP HYNC');
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
