// ESG workbook parsing entry point + aggregation layer.
//
// Phase 1 established isolated format detection/normalization
// (esg-workbook-detector.js, adapters/esg-format-a-adapter.js,
// adapters/esg-format-b-adapter.js) with zero live-app wiring. Phase 2
// (this file) adds the aggregation step that converts those adapters'
// normalized rows into the exact parsed-result shape the live Report page
// already expects from shared-report-profile.js's parseWeighbridgeWorkbook
// (sheetName, fileDate, records, domes, shiftLabel, shiftFallback,
// onShiftTon, onShiftRit, contractorCounts, totalADT, totalDT,
// unmatchedTrucks, dateMismatch, workbookBuyer, workbookBuyerIssues), plus
// workbookFormat. Producing that exact shape is what lets report-page.js's
// existing renderScaleDisplay/renderWarnings/renderDomeList/
// buildReportText/calculateTotals all work on an ESG-parsed workbook
// without new per-buyer branching in those functions.
//
// Per the Owner-approved decision: the Report buyer identity for ESG is
// the literal string "ESG" (not "EIEB" -- EIEB remains Monitor's own
// legacy internal identifier, untouched here).
//
// Daily/WTD/MTD/YTD are deliberately NOT calculated in this file -- that
// stays the shared, buyer-agnostic calculateTotals() in
// shared-report-profile.js, unchanged. This file only produces the
// `parsed` object that function already takes as input.

import { ESG_WORKBOOK_FORMAT, detectEsgWorkbookFormat } from './esg-workbook-detector.js';
import { parseEsgFormatA } from './adapters/esg-format-a-adapter.js';
import { parseEsgFormatB } from './adapters/esg-format-b-adapter.js';
import { lookupHyncContractor } from '../../../services/contractor-adapter.js';
import { formatDateID, fmtTon } from '../report-utils.js';

export { ESG_WORKBOOK_FORMAT };

export const ESG_BUYER = 'ESG';
export const ESG_PROFILE = { buyer: ESG_BUYER, label: 'ESG' };

/* ============================================================
   CONTRACTOR RESOLUTION
   Duplicated (not imported) from shared-report-profile.js's private
   CONTRACTOR_PRIORITY/CONTRACTOR_ALIAS/normalizeSlncDt -- that module must
   not be imported here beyond what Phase 1 already established
   (esg-workbook-detector.js et al. stay import-free of it), so the same
   small, already-approved values/logic are restated here rather than
   exported and shared, matching the precedent already set by
   adapters/esg-adapter-utils.js's classifyEsgOreClass. Values must stay in
   sync if the shared engine's contractor policy is ever revisited.
   contractor-adapter.js itself (the actual DT->contractor data) is
   imported directly, unchanged, unmodified -- no second contractor table.
============================================================ */
const CONTRACTOR_PRIORITY = ['PMS', 'MRP', 'TII', 'REAL', 'JAM', 'STM', 'MIM', 'HYNC'];
const CONTRACTOR_ALIAS = { HILLCON: 'PMS' };

// Mirrors shared-report-profile.js's normalizeSlncDt/resolveContractor
// (same fallback order), with one ESG-specific addition confirmed by
// running this exact logic against both real ESG sample workbooks: a small
// number of ESG rows have a trailing period after "DT" (e.g.
// "SCM-LIM 910 DT."), which shared-report-profile.js's SLNC-oriented
// regex (no evidence of this pattern in real SLNC data) does not strip.
// Without tolerating it, those rows show up as unmatched even though
// "SCM-LIM 910" is a real, already-approved entry in contractor-adapter.js
// -- confirmed by checking the exact affected vehicle numbers against the
// real table before adding this. This function is ESG-only and does not
// change shared-report-profile.js's own normalizeSlncDt or its HYNC/SLNC
// behavior in any way.
function normalizeEsgVehicleNo(vehicleNo) {
  let s = String(vehicleNo).trim();
  s = s.replace(/\s+DT\.?$/i, '');
  s = s.replace(/^SCM\s+LIM\s+/i, 'SCM-LIM ');
  return s;
}

function resolveEsgContractor(vehicleNo) {
  return lookupHyncContractor(vehicleNo) || lookupHyncContractor(normalizeEsgVehicleNo(vehicleNo));
}

// Truck count is based on unique normalized vehicle units (one entry per
// distinct vehicleNo), never ritase count -- mirrors
// shared-report-profile.js's own truckContractor/bucketCounts logic.
// Unmatched contractors are warnings (unmatchedTrucks), never a block.
function aggregateEsgContractors(rows) {
  const truckContractor = new Map();
  const unmatched = new Set();
  rows.forEach((r) => {
    if (truckContractor.has(r.vehicleNo)) return;
    const contractor = resolveEsgContractor(r.vehicleNo);
    if (!contractor) unmatched.add(r.vehicleNo);
    truckContractor.set(r.vehicleNo, contractor || 'TIDAK DIKENALI');
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

  return { totalDT, totalADT, contractorCounts: nonAdtEntries, unmatchedTrucks: Array.from(unmatched) };
}

/* ============================================================
   SHIFT DETECTION (ESG-specific -- confirmed from the ATQ-ESG reference)
   Inspects the first 10 valid loaded-time rows; Day Shift is 05:00
   through 16:59; majority count decides (dayCount >= nightCount -> Day
   Shift). Deliberately not the same algorithm as HYNC/SLNC's
   average-time-of-day-over-20-rows rule in shared-report-profile.js --
   that rule is untouched and this one only applies to ESG rows.
============================================================ */
function detectEsgShift(rows) {
  const withTime = rows.filter((r) => r.loadedAt instanceof Date && !isNaN(r.loadedAt));
  const sample = withTime.slice(0, 10);
  if (!sample.length) return { shiftLabel: 'Day Shift', shiftFallback: true };
  let dayCount = 0;
  let nightCount = 0;
  sample.forEach((r) => {
    const totalMin = r.loadedAt.getHours() * 60 + r.loadedAt.getMinutes();
    const isDay = totalMin >= 5 * 60 && totalMin < 17 * 60;
    if (isDay) dayCount++; else nightCount++;
  });
  return { shiftLabel: dayCount >= nightCount ? 'Day Shift' : 'Night Shift', shiftFallback: false };
}

/* ============================================================
   DOME AGGREGATION (ESG-specific)
   Unique key is dome + grade (not dome alone) -- a real dome code can
   legitimately carry different grades across shipments, and the ESG
   reference keeps those as separate groups rather than merging them.
   domeGroups is sorted by descending tonnage, matching the confirmed ESG
   reference behavior. `domes` (dome name only, first-seen order) is
   derived separately for compatibility with the existing shared Loading
   Point renderer and Step 2's per-dome-name area assignment, which are
   both name-keyed -- exactly mirroring HYNC/SLNC's own `domes` construction
   in shared-report-profile.js, not a new mechanism.
============================================================ */
function aggregateEsgDomeGroups(rows) {
  const groups = new Map();
  rows.forEach((r) => {
    const key = `${r.dome}|${r.grade}`;
    if (!groups.has(key)) groups.set(key, { dome: r.dome, grade: r.grade, oreClass: r.oreClass, tonnageKg: 0, rit: 0 });
    const g = groups.get(key);
    g.tonnageKg += r.netKg;
    g.rit += 1;
  });
  return Array.from(groups.values()).sort((a, b) => b.tonnageKg - a.tonnageKg);
}

function buildDomesArray(rows) {
  const seen = new Set();
  const domes = [];
  rows.forEach((r) => {
    if (!seen.has(r.dome)) {
      seen.add(r.dome);
      domes.push({ dome: r.dome, oreClass: r.oreClass });
    }
  });
  return domes;
}

/* ============================================================
   BUYER STATUS DERIVATION
   Reuses the adapter's own `issues`/`buyerEvidence` output (Phase 1) --
   any blocking issue means the workbook cannot be confirmed as ESG for
   buyer-resolution purposes, surfaced through the exact same
   workbookBuyer/workbookBuyerIssues fields report-page.js's existing
   recomputeBuyerResolution() already reads for HYNC/SLNC, so no new
   buyer-resolution branching is needed there for the "is the workbook
   buyer confirmed" question -- only for ESG-specific message wording.
============================================================ */
function deriveWorkbookBuyerStatus(esgResult) {
  if (esgResult.issues && esgResult.issues.length) {
    return { workbookBuyer: null, workbookBuyerIssues: esgResult.issues };
  }
  return { workbookBuyer: ESG_BUYER, workbookBuyerIssues: null };
}

// Converts one ESG adapter result (Format A or B, both already in the
// Phase 1 normalized row shape) into the full parsed-result contract the
// live Report page expects.
function buildEsgParsedResult(esgResult) {
  const { rows, warnings, sheetName, workbookFormat } = esgResult;

  const { shiftLabel, shiftFallback } = detectEsgShift(rows);
  const onShiftRit = rows.length;
  const onShiftTon = rows.reduce((sum, r) => sum + r.netKg, 0) / 1000;
  const fileDate = rows.length ? rows[0].date : null;
  const dateMismatch = (warnings || []).some((w) => w.type === 'date-mismatch');

  const domeGroups = aggregateEsgDomeGroups(rows);
  const domes = buildDomesArray(rows);

  const { totalDT, totalADT, contractorCounts, unmatchedTrucks } = aggregateEsgContractors(rows);

  const records = rows.map((r) => ({
    carNo: r.vehicleNo,
    netKg: r.netKg,
    grossTime: r.loadedAt,
    dome: r.dome,
    grade: r.grade,
    oreClass: r.oreClass,
    contractor: resolveEsgContractor(r.vehicleNo) || 'TIDAK DIKENALI',
  }));

  const { workbookBuyer, workbookBuyerIssues } = deriveWorkbookBuyerStatus(esgResult);

  return {
    sheetName,
    fileDate,
    records,
    domes,
    shiftLabel,
    shiftFallback,
    onShiftTon,
    onShiftRit,
    contractorCounts,
    totalADT,
    totalDT,
    unmatchedTrucks,
    dateMismatch,
    workbookBuyer,
    workbookBuyerIssues,
    // ESG-only additions, not read by the shared HYNC/SLNC render path:
    workbookFormat,
    domeGroups,
    buyerEvidence: esgResult.buyerEvidence,
    issues: esgResult.issues,
  };
}

// workbook: a SheetJS workbook (from XLSX.read), exactly like
// shared-report-profile.js's parseWeighbridgeWorkbook takes. Runs
// deterministic format detection first, dispatches to the matching
// adapter, then aggregates into the full parsed-result contract. Never
// classifies a workbook as ESG merely because it failed to match some
// other buyer's rules elsewhere -- detection here is always a positive
// structural match against one of the two known ESG formats.
//
// Throws an Error (with .code and .diagnostics attached) for AMBIGUOUS or
// UNSUPPORTED workbooks, matching the throwing convention
// shared-report-profile.js's own parseWeighbridgeWorkbook already uses for
// structurally unparseable files. A successfully detected format is never
// thrown for -- row-level problems are returned in the result's
// `workbookBuyerIssues` field instead (same field HYNC/SLNC already use),
// leaving the "does this block progression" decision to report-page.js's
// existing buyer-resolution state machine, unchanged.
export function parseEsgWorkbook(workbook) {
  const detection = detectEsgWorkbookFormat(workbook);

  if (detection.status === ESG_WORKBOOK_FORMAT.AMBIGUOUS) {
    const err = new Error('Format workbook ESG ambigu: lebih dari satu sheet/format yang cocok ditemukan.');
    err.code = detection.status;
    err.diagnostics = detection;
    throw err;
  }
  if (detection.status === ESG_WORKBOOK_FORMAT.UNSUPPORTED) {
    const err = new Error('File timbangan tidak dikenali sebagai format ESG yang didukung (Format A maupun Format B).');
    err.code = detection.status;
    err.diagnostics = detection;
    throw err;
  }

  let esgResult;
  if (detection.status === ESG_WORKBOOK_FORMAT.ESG_FORMAT_A) {
    esgResult = parseEsgFormatA(workbook, detection);
  } else if (detection.status === ESG_WORKBOOK_FORMAT.ESG_FORMAT_B) {
    esgResult = parseEsgFormatB(workbook, detection);
  } else {
    // Unreachable: detectEsgWorkbookFormat only ever returns one of the
    // four ESG_WORKBOOK_FORMAT statuses. Fail loudly rather than silently
    // if that contract is ever violated.
    const err = new Error('Status deteksi format ESG tidak dikenali: ' + detection.status);
    err.diagnostics = detection;
    throw err;
  }

  return buildEsgParsedResult(esgResult);
}

// File-upload success summary shown in Step 1, mirroring
// shared-report-profile.js's buildFileSummary but with the ESG-specific
// fields the task requires (buyer, detected format, selected sheet) that
// HYNC/SLNC's summary has no equivalent of. report-page.js picks this
// function instead of buildFileSummary whenever parsed.workbookFormat is
// set (i.e. the workbook was parsed by the ESG path).
export function buildEsgFileSummary(parsed) {
  const formatLabel = parsed.workbookFormat === ESG_WORKBOOK_FORMAT.ESG_FORMAT_A ? 'ESG Format A' : 'ESG Format B';
  let s = 'File berhasil dibaca\n';
  s += `Buyer: ${ESG_BUYER}\n`;
  s += `Format: ${formatLabel}\n`;
  s += `Sheet: ${parsed.sheetName}\n`;
  s += `Tanggal: ${parsed.fileDate ? formatDateID(parsed.fileDate) : '-'}\n`;
  s += `Shift: ${parsed.shiftLabel}\n`;
  s += `Tonase: ${fmtTon(parsed.onShiftTon)} wmt\n`;
  s += `Data: ${parsed.onShiftRit} rit`;
  if (parsed.unmatchedTrucks.length) {
    s += `\n⚠ ${parsed.unmatchedTrucks.length} no. truck tidak ada di daftar kontraktor: ${parsed.unmatchedTrucks.slice(0, 6).join(', ')}${parsed.unmatchedTrucks.length > 6 ? ', ...' : ''}`;
  }
  return s;
}
