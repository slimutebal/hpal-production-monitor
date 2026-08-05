// Central, module-scoped state for the Report page. This is the app's
// in-memory persistence for the HYNC workflow (see
// docs/V2.0_ARCHITECTURE_AND_ROADMAP.md section 12) -- it survives
// Report <-> Monitor/Settings navigation because #page-report is only ever
// hidden/shown, never rebuilt, and this module is a singleton for the
// lifetime of the page. It is NOT persisted to localStorage/IndexedDB, so
// it is lost on refresh, tab close, or an explicit reset.

function createDefaultState() {
  return {
    step: 1,
    fileParsed: false,
    fileName: '',
    prevText: '',
    inputs: { week: '', picScm: '', picAwk: '', mpAwk: '', mpTotal: '', problem: '', action: '' },
    parsed: null, // output of parseHyncWorkbook()
    prev: null, // output of parseHyncPrevText()
    domeAreas: {}, // dome name -> 'BR' | 'BR 23' | 'DS'
    totals: null, // output of calculateHyncTotals()
    reportText: '',
  };
}

export const reportState = createDefaultState();

export function resetReportState() {
  Object.assign(reportState, createDefaultState());
}
