// Central, module-scoped state for the Report page. This is the app's
// in-memory persistence for the HYNC/SLNC workflow (see
// docs/V2.0_ARCHITECTURE_AND_ROADMAP.md section 12) -- it survives
// Report <-> Monitor/Settings navigation because #page-report is only ever
// hidden/shown, never rebuilt, and this module is a singleton for the
// lifetime of the page. It is NOT persisted to localStorage/IndexedDB, so
// it is lost on refresh, tab close, or an explicit reset.

// Buyer-resolution status, recomputed from previousReportBuyer +
// workbookBuyer + workbookBuyerIssues whenever either source changes.
// resolvedBuyer is only ever non-null when status is CONFIRMED (or,
// provisionally, when only one source has reported in yet -- see
// report-page.js's recomputeBuyerResolution).
export const BUYER_STATUS = {
  UNKNOWN: 'unknown',
  PENDING_WORKBOOK: 'pendingWorkbook',
  PENDING_PREVIOUS_REPORT: 'pendingPreviousReport',
  CONFIRMED: 'confirmed',
  MISMATCH: 'mismatch',
  INVALID_WORKBOOK: 'invalidWorkbook',
  AMBIGUOUS_PREVIOUS_REPORT: 'ambiguousPreviousReport',
};

function createDefaultState() {
  return {
    step: 1,
    fileParsed: false,
    fileName: '',
    prevText: '',
    inputs: { problem: '', action: '' },

    // Controlled Personnel selection (V2.3 Phase 4). Stores stable
    // personnel-directory record ids only, never cached names/orgs --
    // report-personnel.js resolves ids against the live directory snapshot
    // whenever rendering or generating output, so a Settings-side edit is
    // always reflected without stale copies living in this state.
    // samplerSource is 'buyer-default' when applied automatically from the
    // resolved buyer, 'user-override' once the user picks a different
    // sampler, or null before any buyer/sampler has been resolved.
    // manpowerThirdParty and totalManpower are both manual operational
    // numbers entered directly by the user (bug fix: totalManpower used to
    // be auto-calculated from spvScmIds.length + frmScmIds.length +
    // manpowerThirdParty -- that was wrong; SPV/FRM selections identify
    // names only and must never alter either manpower value). Neither is
    // ever recalculated from a personnel selection change.
    personnel: {
      spvScmIds: [],
      frmScmIds: [],
      samplerId: null,
      samplerSource: null,
      picThirdId: null,
      manpowerThirdParty: null,
      totalManpower: null,
    },

    parsed: null, // output of parseWeighbridgeWorkbook() / esg-profile.js's parseEsgWorkbook()
    prev: null, // output of parsePrevText(), or a zero-accumulation object for an empty ESG previous report
    domeAreas: {}, // dome name -> 'BR1' | 'BR23E' | 'BR23W' | 'DS'
    totals: null, // output of calculateTotals()
    reportText: '',

    // Automatic Week (V2.3 Phase 1). Derived from parsed.fileDate via
    // report-utils.js's calculateIsoWeek() -- never manually entered, never
    // derived from the device clock or the previous-report text. All four
    // fields are set together (report-page.js's applyWeekFromParsed()) and
    // cleared together to null whenever no valid, unambiguous workbook date
    // is available (no file parsed yet, parse failure, missing/invalid
    // date, or a workbook the parser itself flagged as date-inconsistent).
    weekNumber: null,
    weekYear: null,
    weekStart: null, // 'YYYY-MM-DD' (Monday of the ISO week)
    weekEnd: null, // 'YYYY-MM-DD' (Sunday of the ISO week)

    // Buyer resolution (HYNC/SLNC/ESG). previousReportBuyer/workbookBuyer
    // are 'HYNC' | 'SLNC' | 'ESG' | null; workbookBuyerIssues is null when
    // the workbook cleanly resolves to one buyer, otherwise an array of
    // issue records (HYNC/SLNC: { type: 'mixed'|'unrecognized', ... } from
    // shared-report-profile.js's resolveWorkbookBuyer; ESG: the ESG
    // adapters' own row-level issue records). resolvedBuyer and
    // buyerValidationStatus are the two fields the rest of the UI reads.
    previousReportBuyer: null,
    workbookBuyer: null,
    workbookBuyerIssues: null,
    resolvedBuyer: null,
    buyerValidationStatus: BUYER_STATUS.UNKNOWN,

    // Which ESG workbook format produced `parsed` -- null for HYNC/SLNC or
    // when no workbook has been parsed yet, otherwise 'ESG_FORMAT_A' |
    // 'ESG_FORMAT_B' (see esg-workbook-detector.js's ESG_WORKBOOK_FORMAT).
    // Not derived from `parsed.workbookFormat` at render time because
    // `parsed` is replaced/cleared independently (e.g. on a failed
    // re-upload) and the UI needs a stable, always-present field to read.
    workbookFormat: null,
  };
}

export const reportState = createDefaultState();

export function resetReportState() {
  Object.assign(reportState, createDefaultState());
}
