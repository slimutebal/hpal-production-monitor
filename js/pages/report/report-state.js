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
    inputs: { week: '', picScm: '', picAwk: '', mpAwk: '', mpTotal: '', problem: '', action: '' },
    parsed: null, // output of parseWeighbridgeWorkbook()
    prev: null, // output of parsePrevText()
    domeAreas: {}, // dome name -> 'BR1' | 'BR23E' | 'BR23W' | 'DS'
    totals: null, // output of calculateTotals()
    reportText: '',

    // Buyer resolution (HYNC/SLNC). previousReportBuyer/workbookBuyer are
    // 'HYNC' | 'SLNC' | null; workbookBuyerIssues is null when the
    // workbook's 备注 column cleanly resolves to one buyer, otherwise an
    // array of { type: 'mixed'|'unrecognized', ... } issue records (see
    // shared-report-profile.js's resolveWorkbookBuyer). resolvedBuyer and
    // buyerValidationStatus are the two fields the rest of the UI reads.
    previousReportBuyer: null,
    workbookBuyer: null,
    workbookBuyerIssues: null,
    resolvedBuyer: null,
    buyerValidationStatus: BUYER_STATUS.UNKNOWN,
  };
}

export const reportState = createDefaultState();

export function resetReportState() {
  Object.assign(reportState, createDefaultState());
}
