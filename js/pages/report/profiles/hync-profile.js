// HYNC report profile. As of the HYNC/SLNC dual-profile refactor, all
// actual parsing/calculation/report-text logic lives in
// shared-report-profile.js (confirmed buyer-agnostic against a real SLNC
// sample workbook -- see docs/V2.0_ARCHITECTURE_AND_ROADMAP.md's Report
// HYNC/SLNC section). This file now holds only:
//   1. HYNC's identity (buyer code, 备注 remark prefix), and
//   2. backward-compatible named exports so anything still importing the
//      old function names from this file keeps working, unchanged, with
//      the exact same HYNC behavior as before the refactor.
//
// The live Report page (report-page.js) does NOT import this file -- it
// calls shared-report-profile.js + profile-registry.js directly with an
// explicit buyer, so the SLNC feature path never depends on this
// compatibility layer and vice versa.

import {
  AREA_OPTIONS,
  SHEET_NAME,
  REQUIRED_HEADERS,
  parsePrevText,
  parseWeighbridgeWorkbook,
  buildFileSummary,
  calculateTotals,
  buildReportText,
} from './shared-report-profile.js';

export const HYNC_BUYER = 'HYNC';
export const HYNC_REMARK_PREFIX = 'SCHY';

export const HYNC_PROFILE = { buyer: HYNC_BUYER, remarkPrefix: HYNC_REMARK_PREFIX };

/* ============================================================
   BACKWARD-COMPATIBLE EXPORTS (unchanged names/signatures/behavior)
============================================================ */
export const HYNC_SHEET_NAME = SHEET_NAME;
export const HYNC_REQUIRED_HEADERS = REQUIRED_HEADERS;
export const HYNC_AREA_OPTIONS = AREA_OPTIONS;

export function parseHyncPrevText(raw) {
  return parsePrevText(raw);
}

export function parseHyncWorkbook(workbook) {
  return parseWeighbridgeWorkbook(workbook);
}

export function buildHyncFileSummary(parsed) {
  return buildFileSummary(parsed);
}

export function calculateHyncTotals({ parsed, prev }) {
  return calculateTotals({ parsed, prev });
}

export function buildHyncReportText({ parsed, inputs, domeAreas, totals, weekNumber, personnelLines }) {
  return buildReportText({ buyer: HYNC_BUYER, parsed, inputs, domeAreas, totals, weekNumber, personnelLines });
}
