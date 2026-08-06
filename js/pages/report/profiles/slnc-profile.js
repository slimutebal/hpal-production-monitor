// SLNC report profile. Mirrors hync-profile.js's shape: identity constants
// plus named wrappers around the shared engine in shared-report-profile.js
// (confirmed against a real SLNC sample workbook -- same sheet, same
// header set, same spec-column shape once the "NI:" prefix is treated as
// optional -- see docs/V2.0_ARCHITECTURE_AND_ROADMAP.md's Report HYNC/SLNC
// section). SLNC-specific configuration is limited to what's genuinely
// different: the buyer code and the 备注 remark prefix. Contractor
// mapping, ore-class thresholds, area options, and totals math are not
// duplicated here -- they are the same shared logic HYNC uses.
//
// The live Report page (report-page.js) does NOT import this file -- it
// calls shared-report-profile.js + profile-registry.js directly with an
// explicit buyer. This file exists as the SLNC-identity module the
// architecture calls for, and as a convenience surface symmetrical with
// hync-profile.js's compatibility exports.

import {
  parsePrevText,
  parseWeighbridgeWorkbook,
  buildFileSummary,
  calculateTotals,
  buildReportText,
} from './shared-report-profile.js';

export const SLNC_BUYER = 'SLNC';
export const SLNC_REMARK_PREFIX = 'SCSL';

export const SLNC_PROFILE = { buyer: SLNC_BUYER, remarkPrefix: SLNC_REMARK_PREFIX };

export function parseSlncPrevText(raw) {
  return parsePrevText(raw);
}

export function parseSlncWorkbook(workbook) {
  return parseWeighbridgeWorkbook(workbook);
}

export function buildSlncFileSummary(parsed) {
  return buildFileSummary(parsed);
}

export function calculateSlncTotals({ parsed, prev }) {
  return calculateTotals({ parsed, prev });
}

export function buildSlncReportText({ parsed, inputs, domeAreas, totals }) {
  return buildReportText({ buyer: SLNC_BUYER, parsed, inputs, domeAreas, totals });
}
