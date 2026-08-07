// Report page (HYNC + SLNC + ESG, one shared UI). Builds the Step 1/2/3 DOM
// once into #page-report and never rebuilds it on route change, so field
// values, the active step, and generated output survive Report <->
// Monitor/Settings navigation (see docs/V2.0_ARCHITECTURE_AND_ROADMAP.md
// section 12). Everything here is module-scoped -- no globals, no inline
// onclick attributes.
//
// Buyer is detected automatically from the previous-report text and the
// uploaded workbook; this page never imports hync-profile.js or
// slnc-profile.js directly, and reaches ESG only through
// report-workbook-dispatcher.js's parseUploadedWorkbook() -- it never
// imports esg-profile.js's workbook-parsing pieces directly either. Every
// workbook upload goes through one dispatcher that decides HYNC/SLNC vs
// ESG Format A vs ESG Format B vs unsupported, so the UI truly is one
// shared page rather than buyer-specific branches bolted on.
import { escapeHtml, formatDateID, fmtTon, fmtRit, deriveWeekFromParsedWorkbook, recomputeContractorAggregates } from './report-utils.js';
import { reportState, resetReportState, BUYER_STATUS } from './report-state.js';
import {
  AREA_OPTIONS,
  parsePrevText,
  buildFileSummary,
  calculateTotals,
  buildReportText,
  resolveContractor,
} from './profiles/shared-report-profile.js';
import { buyerFromPrevText, getProfile } from './profiles/profile-registry.js';
import { parseUploadedWorkbook } from './profiles/report-workbook-dispatcher.js';
import { ESG_WORKBOOK_FORMAT, buildEsgFileSummary, resolveEsgContractor } from './profiles/esg-profile.js';
import {
  loadCachedPersonnelDirectory,
  getPersonnelDirectorySnapshot,
  getActivePersonnelByRole,
  getActivePicThirdByOrganization,
} from '../../services/personnel-directory-service.js';
import {
  loadCachedContractorDirectory,
  syncContractorDirectory,
  getContractorDirectoryStatus,
  subscribeContractorDirectoryUpdated,
} from '../../services/contractor-directory-service.js';
import { onRouteChange, navigateTo } from '../../router.js';
import {
  sortRecords,
  resolveSelectedPersonnel,
  getDirectoryAvailabilityError,
  validatePersonnelSelections,
  buildPersonnelOutputLines,
  applyBuyerDefaultSamplerToPersonnel,
  overrideSampler,
} from './report-personnel.js';

let els = null; // cached DOM references, populated once in initReportPage()
let lastFocusedBeforeModal = null;

export function initReportPage() {
  const page = document.getElementById('page-report');
  if (!page) return;

  page.innerHTML = buildShellMarkup();
  els = collectElements(page);
  wireEvents();
  loadCachedPersonnelDirectory();
  loadCachedContractorDirectory();
  renderContractorDirectoryStatus(); // shows the shared-cache/none state immediately -- never silently reports static fallback as "synchronized"
  // Shared-cache architecture: react whenever ANY source (Monitor's own
  // List DT sync, or this page's own sync below) writes
  // hpal.contractors.v1 -- reload the snapshot, refresh the visible
  // status, and reclassify the currently uploaded workbook if one exists.
  // Registered exactly once here, since initReportPage() itself is only
  // ever called once by app.js at bootstrap (same assumption every other
  // one-time registration in this file already makes) -- never
  // duplicated on route changes.
  subscribeContractorDirectoryUpdated(handleContractorDirectoryUpdatedEvent);
  // One controlled, read-only sync against the same synced List DT
  // endpoint Monitor uses, fired once at Report init (never on every
  // route visit -- see onRouteChange below, which only re-renders
  // personnel selectors, not this). This alone does not guarantee a
  // workbook uploaded moments later sees fresh data -- that guarantee
  // comes from handleFileChange() awaiting its own sync before
  // classifying (see below) -- this init-time call only means the status
  // line and an early upload are as fresh as possible without waiting.
  syncContractorDirectory().catch(() => undefined);
  renderStep(reportState.step);
  renderWeekDisplay();
  renderPersonnelSection();
  autoGrowTextarea(els.prevText);

  // Refreshes selector options from the current directory snapshot every
  // time Report becomes the active route (e.g. after syncing the
  // Personnel Directory in Settings and navigating back) -- without
  // rebuilding #page-report or touching any other Report state.
  // initReportPage() itself is only ever called once by app.js at
  // bootstrap (same assumption every other page here already makes), so
  // this registers exactly one listener for the lifetime of the app.
  onRouteChange((route) => {
    if (route === 'report') renderPersonnelSection();
  });
}

/* ============================================================
   SHELL MARKUP
============================================================ */
function buildShellMarkup() {
  return `
    <div class="hync-shell">
      <header class="hync-header">
        <div class="hync-eyebrow" id="hync-eyebrow">SCM · HPAL ORE SELLING — FPP</div>
        <h1 class="hync-title">Daily Production Geology Report</h1>
        <div class="hync-subtitle" id="hync-subtitle">Generator laporan shift dari data timbangan buyer</div>
        <div class="hync-buyer-status" id="hync-buyer-status">Buyer belum terdeteksi</div>
      </header>

      <div class="hync-stepper">
        <div class="hync-step-pill active" id="hync-pill-1">1 · Input</div>
        <div class="hync-step-pill" id="hync-pill-2">2 · Area Muat</div>
        <div class="hync-step-pill" id="hync-pill-3">3 · Hasil</div>
      </div>

      <section class="hync-panel active" id="hync-step-1">
        <div class="hync-card">
          <h2>Teks Report Sebelumnya</h2>
          <div class="hync-hint" id="hync-prev-text-hint">Paste teks "DAILY PRODUCTION GEOLOGY REPORT" dari WA Group (shift sebelumnya). Dipakai untuk ambil tanggal &amp; angka WTD/MTD/YTD/Daily lama, dan untuk mendeteksi buyer (FPP HYNC / FPP SLNC / FPP ESG).</div>
          <div class="hync-field">
            <label class="hync-req" for="hync-prev-text" id="hync-prev-text-label">Teks report sebelumnya</label>
            <textarea id="hync-prev-text" class="hync-textarea hync-mono-area" placeholder="Paste teks report shift sebelumnya di sini..."></textarea>
          </div>
        </div>

        <div class="hync-card">
          <h2 id="hync-workbook-title">Data Timbangan</h2>
          <div class="hync-hint" id="hync-workbook-hint">Upload file timbangan dan pastikan buyer sesuai dengan teks report sebelumnya.</div>
          <label class="hync-file-drop" id="hync-file-drop" for="hync-file-input">
            <div class="hync-file-icon">📁</div>
            <div id="hync-file-drop-text">Klik untuk upload file timbangan (.xlsx/.xls)</div>
            <input type="file" id="hync-file-input" accept=".xlsx,.xls">
          </label>
          <div class="hync-file-status" id="hync-file-status"></div>

          <div class="hync-contractor-status-row">
            <p class="hync-contractor-status" id="hync-contractor-status">List DT: Unavailable</p>
            <button type="button" class="hync-btn hync-btn-ghost hync-btn-small" id="hync-contractor-refresh-btn">🔄 Refresh List DT</button>
          </div>
          <p class="hync-contractor-status-warn" id="hync-contractor-status-warn" hidden>List DT terbaru tidak dapat dimuat. Report menggunakan daftar bawaan yang mungkin belum mencakup unit terbaru.</p>
        </div>

        <div class="hync-card">
          <h2>Man Power &amp; Support</h2>
          <div class="hync-field">
            <label id="hync-week-label">Week</label>
            <div class="hync-week-display" id="hync-week-display" aria-live="polite" aria-labelledby="hync-week-label">
              <span class="hync-week-number" id="hync-week-number">—</span>
              <span class="hync-week-range" id="hync-week-range">Dihitung otomatis dari tanggal file timbangan setelah upload.</span>
            </div>
          </div>

          <div class="hync-personnel-blocked" id="hync-personnel-blocked" hidden>
            <p>Personnel Directory belum tersedia di perangkat ini. Sinkronkan Personnel Directory di Settings terlebih dahulu sebelum membuat Report.</p>
            <button type="button" class="hync-btn hync-btn-ghost" id="hync-personnel-goto-settings">Buka Settings</button>
          </div>

          <div id="hync-personnel-fields">
            <div class="hync-field">
              <label class="hync-req">SPV SCM</label>
              <p class="hync-personnel-count" id="hync-spv-count">0 dipilih</p>
              <div class="hync-personnel-list" id="hync-spv-list" role="group" aria-label="SPV SCM"></div>
            </div>

            <div class="hync-field">
              <label class="hync-req">FRM SCM</label>
              <p class="hync-personnel-count" id="hync-frm-count">0 dipilih</p>
              <div class="hync-personnel-list" id="hync-frm-list" role="group" aria-label="FRM SCM"></div>
            </div>

            <div class="hync-field">
              <label class="hync-req">Independent Sampler</label>
              <div class="hync-personnel-list" id="hync-sampler-list" role="radiogroup" aria-label="Independent Sampler"></div>
            </div>

            <div class="hync-field">
              <label class="hync-req" id="hync-pic-third-label">PIC Independent Sampler</label>
              <div class="hync-personnel-list" id="hync-pic-third-list" role="radiogroup" aria-label="PIC 3rd"></div>
            </div>

            <div class="hync-field hync-field--inline-2">
              <div>
                <label class="hync-req" for="hync-mp-third" id="hync-mp-third-label">Manpower Independent Sampler</label>
                <input type="number" id="hync-mp-third" class="hync-input" min="0" step="1" placeholder="15">
              </div>
              <div>
                <label class="hync-req" for="hync-mp-total" id="hync-mp-total-label">Total Manpower Independent Sampler</label>
                <input type="number" id="hync-mp-total" class="hync-input" min="0" step="1" placeholder="22">
              </div>
            </div>
          </div>
        </div>

        <div class="hync-card">
          <h2>Problem &amp; Action</h2>
          <div class="hync-field">
            <label for="hync-problem">Problem <span class="hync-optional">(boleh kosong)</span></label>
            <textarea id="hync-problem" class="hync-textarea" rows="2" placeholder="Tulis problem jika ada..."></textarea>
          </div>
          <div class="hync-field">
            <label for="hync-action">Preventive Action <span class="hync-optional">(boleh kosong)</span></label>
            <textarea id="hync-action" class="hync-textarea" rows="2" placeholder="Tulis preventive action jika ada..."></textarea>
          </div>
        </div>

        <div id="hync-step1-errors"></div>

        <div class="hync-btn-row">
          <button type="button" class="hync-btn hync-btn-ghost" id="hync-btn-reset-1">↺ Reset</button>
          <button type="button" class="hync-btn hync-btn-primary" id="hync-btn-next">Lanjut →</button>
        </div>
      </section>

      <section class="hync-panel" id="hync-step-2">
        <div class="hync-card">
          <h2>Pilih Area Tiap Dome</h2>
          <div class="hync-hint">Dome diambil dari data timbangan yang diupload. Pilih salah satu area (BR1 / BR23E / BR23W / DS) untuk tiap dome.</div>
          <div id="hync-dome-list"></div>
        </div>
        <div id="hync-step2-errors"></div>
        <div class="hync-btn-row">
          <button type="button" class="hync-btn hync-btn-ghost" id="hync-btn-back-to-1">← Kembali</button>
          <button type="button" class="hync-btn hync-btn-primary" id="hync-btn-generate">Generate Laporan →</button>
        </div>
      </section>

      <section class="hync-panel" id="hync-step-3">
        <div class="hync-scale-display" id="hync-scale-display"></div>
        <div id="hync-step3-warnings"></div>
        <div class="hync-card">
          <h2>Teks Laporan</h2>
          <div class="hync-hint">Cek dulu sebelum di-copy ke WA Group. Bisa diedit manual langsung di kotak ini kalau perlu.</div>
          <textarea class="hync-output-box" id="hync-output" readonly></textarea>
          <div class="hync-btn-row" style="margin-top:12px;">
            <button type="button" class="hync-btn hync-btn-primary" id="hync-btn-copy">📋 Copy Laporan</button>
          </div>
          <div class="hync-copy-feedback" id="hync-copy-feedback">✓ Tersalin ke clipboard</div>
        </div>
        <div class="hync-btn-row">
          <button type="button" class="hync-btn hync-btn-ghost" id="hync-btn-back-to-2">← Kembali Pilih Area</button>
          <button type="button" class="hync-btn hync-btn-ghost" id="hync-btn-reset-3">↺ Reset</button>
        </div>
      </section>

      <div class="hync-footnote" id="hync-footnote">Internal use — SCM HPAL Ore Selling</div>
    </div>

    <div class="hync-modal-overlay" id="hync-buyer-modal-overlay" hidden>
      <div class="hync-modal-box" role="dialog" aria-modal="true" aria-labelledby="hync-buyer-modal-title">
        <h3 id="hync-buyer-modal-title">Buyer tidak sesuai</h3>
        <div id="hync-buyer-modal-body"></div>
        <div class="hync-btn-row">
          <button type="button" class="hync-btn hync-btn-primary" id="hync-buyer-modal-close">Tutup</button>
        </div>
      </div>
    </div>
  `;
}

function collectElements(page) {
  const byId = (id) => page.querySelector(`#${id}`);
  return {
    eyebrow: byId('hync-eyebrow'),
    subtitle: byId('hync-subtitle'),
    buyerStatus: byId('hync-buyer-status'),
    workbookTitle: byId('hync-workbook-title'),
    workbookHint: byId('hync-workbook-hint'),
    footnote: byId('hync-footnote'),

    prevText: byId('hync-prev-text'),
    prevTextHint: byId('hync-prev-text-hint'),
    prevTextLabel: byId('hync-prev-text-label'),
    fileInput: byId('hync-file-input'),
    fileDropText: byId('hync-file-drop-text'),
    fileStatus: byId('hync-file-status'),
    contractorStatus: byId('hync-contractor-status'),
    contractorStatusWarn: byId('hync-contractor-status-warn'),
    contractorRefreshBtn: byId('hync-contractor-refresh-btn'),
    weekDisplay: byId('hync-week-display'),
    weekNumber: byId('hync-week-number'),
    weekRange: byId('hync-week-range'),

    personnelBlocked: byId('hync-personnel-blocked'),
    personnelGotoSettings: byId('hync-personnel-goto-settings'),
    personnelFields: byId('hync-personnel-fields'),
    spvCount: byId('hync-spv-count'),
    spvList: byId('hync-spv-list'),
    frmCount: byId('hync-frm-count'),
    frmList: byId('hync-frm-list'),
    samplerList: byId('hync-sampler-list'),
    picThirdLabel: byId('hync-pic-third-label'),
    picThirdList: byId('hync-pic-third-list'),
    mpThird: byId('hync-mp-third'),
    mpThirdLabel: byId('hync-mp-third-label'),
    mpTotal: byId('hync-mp-total'),
    mpTotalLabel: byId('hync-mp-total-label'),

    problem: byId('hync-problem'),
    action: byId('hync-action'),
    step1Errors: byId('hync-step1-errors'),
    btnNext: byId('hync-btn-next'),
    btnResetStep1: byId('hync-btn-reset-1'),

    domeList: byId('hync-dome-list'),
    step2Errors: byId('hync-step2-errors'),
    btnBackTo1: byId('hync-btn-back-to-1'),
    btnGenerate: byId('hync-btn-generate'),

    scaleDisplay: byId('hync-scale-display'),
    step3Warnings: byId('hync-step3-warnings'),
    output: byId('hync-output'),
    btnCopy: byId('hync-btn-copy'),
    copyFeedback: byId('hync-copy-feedback'),
    btnBackTo2: byId('hync-btn-back-to-2'),
    btnResetStep3: byId('hync-btn-reset-3'),

    pill1: byId('hync-pill-1'),
    pill2: byId('hync-pill-2'),
    pill3: byId('hync-pill-3'),
    step1: byId('hync-step-1'),
    step2: byId('hync-step-2'),
    step3: byId('hync-step-3'),

    buyerModalOverlay: byId('hync-buyer-modal-overlay'),
    buyerModalTitle: byId('hync-buyer-modal-title'),
    buyerModalBody: byId('hync-buyer-modal-body'),
    buyerModalClose: byId('hync-buyer-modal-close'),
  };
}

/* ============================================================
   EVENT WIRING
============================================================ */
function wireEvents() {
  els.fileInput.addEventListener('change', handleFileChange);
  els.contractorRefreshBtn.addEventListener('click', handleRefreshContractorDirectory);
  els.btnNext.addEventListener('click', goToStep2);
  els.btnResetStep1.addEventListener('click', handleResetClick);
  els.btnResetStep3.addEventListener('click', handleResetClick);
  els.btnBackTo1.addEventListener('click', () => renderStep(1));
  els.btnGenerate.addEventListener('click', goToStep3);
  els.btnBackTo2.addEventListener('click', () => renderStep(2));
  els.btnCopy.addEventListener('click', copyOutput);
  els.domeList.addEventListener('change', handleDomeAreaChange);
  // 'input' (not just 'paste') covers typing, paste, deletion, mobile IME,
  // and autofill -- anything that changes the textarea's value. Buyer
  // detection is recalculated on every change per the requirement, but the
  // mismatch popup itself only opens on the status *transition* into a
  // problem state (see recomputeBuyerResolution), not on every keystroke.
  els.prevText.addEventListener('input', () => {
    autoGrowTextarea(els.prevText);
    recomputeBuyerResolution({ openPopupOnNewMismatch: true });
  });

  els.buyerModalClose.addEventListener('click', closeBuyerMismatchPopup);
  els.buyerModalOverlay.addEventListener('click', (event) => {
    if (event.target === els.buyerModalOverlay) closeBuyerMismatchPopup();
  });

  els.personnelGotoSettings.addEventListener('click', () => navigateTo('settings'));
  els.spvList.addEventListener('change', handleSpvListChange);
  els.frmList.addEventListener('change', handleFrmListChange);
  els.samplerList.addEventListener('change', handleSamplerListChange);
  els.picThirdList.addEventListener('change', handlePicThirdListChange);
  els.mpThird.addEventListener('input', handleManpowerThirdInput);
  els.mpTotal.addEventListener('input', handleTotalManpowerInput);
}

/* ============================================================
   AUTO-GROW: Previous Report textarea
============================================================ */
function autoGrowTextarea(textarea) {
  if (!textarea) return;
  // While #page-report (or an ancestor) is display:none -- e.g. Monitor is
  // the active route -- scrollHeight reads 0. Skip the measurement rather
  // than collapsing an already-correctly-sized textarea; the inline height
  // set the last time it was visible stays applied and reappears correctly
  // when the page is shown again.
  if (textarea.offsetParent === null) return;
  textarea.style.height = 'auto';
  textarea.style.height = textarea.scrollHeight + 'px';
}

/* ============================================================
   BUYER RESOLUTION
============================================================ */
// Recomputes previousReportBuyer / resolvedBuyer / buyerValidationStatus
// from the current textarea value and the already-stored workbook buyer
// state, updates the dynamic UI labels, and -- only on the transition into
// a mismatch/invalid/ambiguous state -- opens the informational popup.
// Called from the prevText input handler, after a file finishes parsing,
// and again at the Step 1 -> 2 gate (so both "recalculate on every text
// change" and "recheck when the user tries to continue" are satisfied
// without reopening the popup on every keystroke while already blocked).
function recomputeBuyerResolution({ openPopupOnNewMismatch }) {
  const prevTextRaw = els.prevText.value;
  const prevIsEmpty = !prevTextRaw.trim();
  const prevResult = buyerFromPrevText(prevTextRaw);
  reportState.previousReportBuyer = prevResult.status === 'ok' ? prevResult.buyer : null;
  const prevAmbiguous = prevResult.status === 'ambiguous';

  const workbookBuyer = reportState.workbookBuyer;
  const workbookIssues = reportState.workbookBuyerIssues;
  const workbookProfile = workbookBuyer ? getProfile(workbookBuyer) : null;
  // An empty previous report is a complete, valid state for a buyer whose
  // profile allows it (currently ESG only, per the Owner-approved rule:
  // no previous report = first report / new accumulation period, so
  // Daily/WTD/MTD/YTD all equal On Shift) -- not "pending", and not
  // dependent on any token being found in an empty string.
  const emptyPrevAllowed = prevIsEmpty && workbookProfile && workbookProfile.previousReportOptional;

  let status;
  let resolvedBuyer = null;

  if (prevAmbiguous) {
    status = BUYER_STATUS.AMBIGUOUS_PREVIOUS_REPORT;
  } else if (workbookIssues && workbookIssues.length) {
    status = BUYER_STATUS.INVALID_WORKBOOK;
  } else if (emptyPrevAllowed) {
    status = BUYER_STATUS.CONFIRMED;
    resolvedBuyer = workbookBuyer;
  } else if (reportState.previousReportBuyer && workbookBuyer) {
    if (reportState.previousReportBuyer === workbookBuyer) {
      status = BUYER_STATUS.CONFIRMED;
      resolvedBuyer = workbookBuyer;
    } else {
      status = BUYER_STATUS.MISMATCH;
    }
  } else if (reportState.previousReportBuyer && !workbookBuyer) {
    status = BUYER_STATUS.PENDING_WORKBOOK;
    resolvedBuyer = reportState.previousReportBuyer; // provisional only
  } else if (!reportState.previousReportBuyer && workbookBuyer) {
    status = BUYER_STATUS.PENDING_PREVIOUS_REPORT;
    resolvedBuyer = workbookBuyer; // provisional only
  } else {
    status = BUYER_STATUS.UNKNOWN;
  }

  const problemStatuses = [BUYER_STATUS.MISMATCH, BUYER_STATUS.INVALID_WORKBOOK, BUYER_STATUS.AMBIGUOUS_PREVIOUS_REPORT];
  const wasProblem = problemStatuses.includes(reportState.buyerValidationStatus);
  const isProblem = problemStatuses.includes(status);

  const oldResolvedBuyer = reportState.resolvedBuyer;
  reportState.buyerValidationStatus = status;
  reportState.resolvedBuyer = status === BUYER_STATUS.CONFIRMED ? resolvedBuyer : (isProblem ? null : resolvedBuyer);

  // A confirmed buyer flipping (or being lost) must not leave a stale
  // report generated under the old buyer's label.
  if (oldResolvedBuyer && oldResolvedBuyer !== reportState.resolvedBuyer) {
    reportState.reportText = '';
  }

  // Buyer default sampler (V2.3 Phase 4): applied only on a genuine
  // resolved-buyer change while CONFIRMED, never on every keystroke or
  // provisional guess. Per the approved "simple behavior", every buyer
  // change reapplies that buyer's default sampler unconditionally
  // (samplerSource becomes 'buyer-default'), overriding any earlier
  // user override -- the user can override again afterward.
  if (status === BUYER_STATUS.CONFIRMED && reportState.resolvedBuyer !== oldResolvedBuyer) {
    applyBuyerDefaultSampler(reportState.resolvedBuyer);
  }

  updateBuyerUI();
  renderPersonnelSection();

  if (openPopupOnNewMismatch && isProblem && !wasProblem) {
    openBuyerMismatchPopup();
  }

  return status;
}

function buyerGateErrorMessage(status) {
  switch (status) {
    case BUYER_STATUS.UNKNOWN:
      return 'Buyer belum terdeteksi dari teks report sebelumnya maupun file timbangan.';
    case BUYER_STATUS.PENDING_WORKBOOK:
      return 'Buyer baru terdeteksi dari teks report sebelumnya — upload file timbangan untuk konfirmasi.';
    case BUYER_STATUS.PENDING_PREVIOUS_REPORT:
      return 'Buyer baru terdeteksi dari file timbangan — lengkapi teks report sebelumnya untuk konfirmasi.';
    case BUYER_STATUS.MISMATCH:
      return 'Buyer teks report sebelumnya dan file timbangan tidak sesuai — lihat detail di popup.';
    case BUYER_STATUS.INVALID_WORKBOOK:
      return 'Data buyer pada file timbangan tidak valid — lihat detail di popup.';
    case BUYER_STATUS.AMBIGUOUS_PREVIOUS_REPORT:
      return 'Teks report sebelumnya menyebutkan lebih dari satu buyer — lihat detail di popup.';
    default:
      return 'Buyer belum terkonfirmasi.';
  }
}

/* ============================================================
   DYNAMIC BUYER LABELS
============================================================ */
const NEUTRAL_LABELS = {
  eyebrow: 'SCM · HPAL ORE SELLING — FPP',
  subtitle: 'Generator laporan shift dari data timbangan buyer',
  workbookTitle: 'Data Timbangan',
  workbookHint: 'Upload file timbangan dan pastikan buyer sesuai dengan teks report sebelumnya.',
  footnote: 'Internal use — SCM HPAL Ore Selling',
};

function buyerLabelSet(buyer) {
  return {
    eyebrow: `SCM · HPAL Ore Selling — FPP ${buyer}`,
    subtitle: `Generator laporan shift dari data timbangan ${buyer}`,
    workbookTitle: `Data Timbangan (khusus ${buyer})`,
    workbookHint: `Upload file timbangan (.xlsx/.xls) sheet 过磅明细 — pastikan ini data milik buyer ${buyer}, bukan buyer lain.`,
    footnote: `FPP ${buyer} · Internal use — SCM HPAL Ore Selling`,
  };
}

function buyerStatusMessage(status) {
  const prev = reportState.previousReportBuyer;
  const wb = reportState.workbookBuyer;
  switch (status) {
    case BUYER_STATUS.PENDING_WORKBOOK:
      return `Buyer terdeteksi: ${prev} (dari teks report) — menunggu file timbangan.`;
    case BUYER_STATUS.PENDING_PREVIOUS_REPORT:
      return `Buyer terdeteksi: ${wb} (dari file timbangan) — menunggu teks report sebelumnya.`;
    case BUYER_STATUS.CONFIRMED:
      return `Buyer terkonfirmasi: ${reportState.resolvedBuyer}.`;
    case BUYER_STATUS.MISMATCH:
      return '⚠ Buyer tidak sesuai — lihat detail.';
    case BUYER_STATUS.INVALID_WORKBOOK:
      return '⚠ Data buyer file timbangan tidak valid — lihat detail.';
    case BUYER_STATUS.AMBIGUOUS_PREVIOUS_REPORT:
      return '⚠ Teks report sebelumnya menyebutkan lebih dari satu buyer — lihat detail.';
    default:
      return 'Buyer belum terdeteksi';
  }
}

function buyerStatusClass(status) {
  if (status === BUYER_STATUS.CONFIRMED) return 'hync-buyer-status--confirmed';
  if (status === BUYER_STATUS.PENDING_WORKBOOK || status === BUYER_STATUS.PENDING_PREVIOUS_REPORT) return 'hync-buyer-status--provisional';
  if (status === BUYER_STATUS.MISMATCH || status === BUYER_STATUS.INVALID_WORKBOOK || status === BUYER_STATUS.AMBIGUOUS_PREVIOUS_REPORT) return 'hync-buyer-status--problem';
  return '';
}

function updateBuyerUI() {
  const status = reportState.buyerValidationStatus;
  const provisionalBuyer = reportState.resolvedBuyer || reportState.previousReportBuyer || reportState.workbookBuyer;
  const labels = provisionalBuyer ? buyerLabelSet(provisionalBuyer) : NEUTRAL_LABELS;
  const profile = provisionalBuyer ? getProfile(provisionalBuyer) : null;
  const previousReportOptional = !!(profile && profile.previousReportOptional);

  els.eyebrow.textContent = labels.eyebrow;
  els.subtitle.textContent = labels.subtitle;
  els.workbookTitle.textContent = labels.workbookTitle;
  els.workbookHint.textContent = labels.workbookHint;
  els.footnote.textContent = labels.footnote;

  // Previous Report is optional only for a buyer whose profile says so
  // (currently ESG) -- the required-marker (*) and hint text must reflect
  // that accurately rather than always showing "required".
  els.prevTextLabel.classList.toggle('hync-req', !previousReportOptional);
  els.prevTextHint.textContent = previousReportOptional
    ? 'Paste teks "DAILY PRODUCTION GEOLOGY REPORT" dari WA Group (shift sebelumnya), atau kosongkan jika ini laporan pertama / mulai periode akumulasi baru. Dipakai untuk ambil tanggal & angka WTD/MTD/YTD/Daily lama, dan untuk mendeteksi buyer (FPP HYNC / FPP SLNC / FPP ESG).'
    : 'Paste teks "DAILY PRODUCTION GEOLOGY REPORT" dari WA Group (shift sebelumnya). Dipakai untuk ambil tanggal & angka WTD/MTD/YTD/Daily lama, dan untuk mendeteksi buyer (FPP HYNC / FPP SLNC / FPP ESG).';

  els.buyerStatus.textContent = buyerStatusMessage(status);
  els.buyerStatus.className = 'hync-buyer-status ' + buyerStatusClass(status);
}

/* ============================================================
   BUYER MISMATCH / INVALID-WORKBOOK POPUP
============================================================ */
function buildBuyerModalContent(status) {
  if (status === BUYER_STATUS.MISMATCH) {
    return {
      title: 'Buyer tidak sesuai',
      bodyHtml: `
        <p>Teks report sebelumnya terdeteksi sebagai <b>${escapeHtml(reportState.previousReportBuyer)}</b>,
        sedangkan file timbangan terdeteksi sebagai <b>${escapeHtml(reportState.workbookBuyer)}</b>.</p>
        <p>Pastikan teks report sebelumnya dan file timbangan berasal dari buyer yang sama.</p>
      `,
    };
  }
  if (status === BUYER_STATUS.INVALID_WORKBOOK) {
    if (reportState.workbookFormat) {
      return buildEsgInvalidWorkbookContent();
    }
    const issues = reportState.workbookBuyerIssues || [];
    const mixed = issues.filter((i) => i.type === 'mixed');
    if (mixed.length) {
      const rowsSummary = mixed
        .map((i) => `${escapeHtml(i.buyer)}: ${i.rows.length} baris (contoh baris ${i.rows.slice(0, 5).join(', ')})`)
        .join('<br>');
      return {
        title: 'Buyer file timbangan tidak konsisten',
        bodyHtml: `
          <p>Kolom <b>备注</b> berisi data HYNC dan SLNC dalam satu file:</p>
          <p>${rowsSummary}</p>
          <p>Pastikan file timbangan hanya berisi data dari satu buyer.</p>
        `,
      };
    }
    const unrec = issues.find((i) => i.type === 'unrecognized');
    const rowsList = unrec && unrec.rows.length ? unrec.rows.slice(0, 10).join(', ') : '';
    return {
      title: 'Buyer file timbangan tidak dapat dikenali',
      bodyHtml: `
        <p>Terdapat baris data dengan nilai <b>备注</b> yang kosong atau tidak menggunakan kode SCSL/SCHY${rowsList ? ` (baris: ${escapeHtml(rowsList)})` : ''}.</p>
        <p>Periksa file timbangan sebelum melanjutkan.</p>
      `,
    };
  }
  if (status === BUYER_STATUS.AMBIGUOUS_PREVIOUS_REPORT) {
    return {
      title: 'Teks report sebelumnya ambigu',
      bodyHtml: `
        <p>Teks report sebelumnya menyebutkan lebih dari satu buyer (<b>FPP HYNC</b> / <b>FPP SLNC</b> / <b>FPP ESG</b>) sekaligus.</p>
        <p>Pastikan teks report sebelumnya hanya berasal dari satu buyer.</p>
      `,
    };
  }
  return null;
}

// ESG-specific invalid-workbook detail, shown instead of the HYNC/SLNC
// 备注-prefix wording whenever reportState.workbookFormat is set (i.e. the
// current workbook went through the ESG parsing path). Sourced from the
// ESG adapters' own row-level issue records (Phase 1), which already carry
// human-readable messages and 1-based source-row numbers -- this function
// only groups and titles them per the task's required message shapes.
function buildEsgInvalidWorkbookContent() {
  const issues = reportState.workbookBuyerIssues || [];
  const formatLabel = reportState.workbookFormat === ESG_WORKBOOK_FORMAT.ESG_FORMAT_A ? 'ESG Format A' : 'ESG Format B';
  const sheetName = reportState.parsed ? reportState.parsed.sheetName : null;
  const sheetText = sheetName ? `sheet <b>${escapeHtml(sheetName)}</b>` : 'sheet tidak diketahui';

  const workbookLevel = issues.filter((i) => !i.sourceRow);
  const rowLevel = issues.filter((i) => i.sourceRow);

  if (workbookLevel.length && !rowLevel.length) {
    const detail = workbookLevel.map((i) => escapeHtml(i.message)).join('<br>');
    return {
      title: 'Data ESG tidak valid',
      bodyHtml: `
        <p>Buyer/format ESG tidak dapat dipastikan dari file timbangan (${escapeHtml(formatLabel)}, ${sheetText}):</p>
        <p>${detail}</p>
        <p>Periksa file timbangan sebelum melanjutkan.</p>
      `,
    };
  }

  const rowsSummary = rowLevel.slice(0, 8).map((i) => `baris ${i.sourceRow}: ${escapeHtml(i.message)}`).join('<br>');
  const remaining = rowLevel.length > 8 ? `<br>... dan ${rowLevel.length - 8} baris lainnya` : '';
  return {
    title: 'Data ESG tidak valid',
    bodyHtml: `
      <p>Terdapat baris timbangan valid dengan tanggal, waktu, tonase, atau kode ore yang tidak dapat dibaca (${escapeHtml(formatLabel)}, ${sheetText}).</p>
      ${rowsSummary ? `<p>${rowsSummary}${remaining}</p>` : ''}
      <p>Periksa file timbangan sebelum melanjutkan.</p>
    `,
  };
}

function openBuyerMismatchPopup() {
  const content = buildBuyerModalContent(reportState.buyerValidationStatus);
  if (!content) return;
  els.buyerModalTitle.textContent = content.title;
  els.buyerModalBody.innerHTML = content.bodyHtml;

  lastFocusedBeforeModal = document.activeElement;
  els.buyerModalOverlay.hidden = false;
  document.addEventListener('keydown', handleBuyerModalKeydown, true);
  els.buyerModalClose.focus();
}

function closeBuyerMismatchPopup() {
  if (els.buyerModalOverlay.hidden) return;
  els.buyerModalOverlay.hidden = true;
  document.removeEventListener('keydown', handleBuyerModalKeydown, true);
  if (lastFocusedBeforeModal && typeof lastFocusedBeforeModal.focus === 'function') {
    lastFocusedBeforeModal.focus();
  }
  lastFocusedBeforeModal = null;
}

function handleBuyerModalKeydown(event) {
  if (event.key === 'Escape') {
    event.preventDefault();
    closeBuyerMismatchPopup();
    return;
  }
  // This dialog only ever contains one focusable control (the close
  // button), so Tab/Shift+Tab simply keep focus there instead of a full
  // multi-element focus trap.
  if (event.key === 'Tab') {
    event.preventDefault();
    els.buyerModalClose.focus();
  }
}

/* ============================================================
   AUTOMATIC WEEK (V2.3 Phase 1)
   Read-only in V2.3 -- no manual override exists. Derived solely from the
   just-parsed workbook via report-utils.js's deriveWeekFromParsedWorkbook()
   (dateMismatch handling and calculateIsoWeek() both live there -- see
   that function's header comment for the full dateMismatch-is-informational
   rationale and the Night Shift regression it fixes), never from the
   device clock or the previous-report text. Called from handleFileChange()
   on every successful AND failed parse (so a failed re-upload never leaves
   a previous file's Week visible), and reset to the neutral state by
   handleResetClick().
============================================================ */
function applyWeekFromParsed(parsed) {
  const week = deriveWeekFromParsedWorkbook(parsed);

  reportState.weekNumber = week ? week.weekNumber : null;
  reportState.weekYear = week ? week.weekYear : null;
  reportState.weekStart = week ? week.weekStart : null;
  reportState.weekEnd = week ? week.weekEnd : null;

  renderWeekDisplay();
}

// Builds a local (not UTC) Date from a calculateIsoWeek()-produced
// 'YYYY-MM-DD' string, for display formatting only (formatDateID()) --
// never re-parsed through Date.parse() or any locale-ambiguous path.
function dateFromIsoString(isoDate) {
  const [y, m, d] = isoDate.split('-').map(Number);
  return new Date(y, m - 1, d);
}

function renderWeekDisplay() {
  if (reportState.weekNumber != null) {
    els.weekNumber.textContent = String(reportState.weekNumber);
    els.weekRange.textContent = `${formatDateID(dateFromIsoString(reportState.weekStart))} – ${formatDateID(dateFromIsoString(reportState.weekEnd))}`;
    els.weekDisplay.classList.remove('hync-week-display--error');
  } else if (reportState.fileParsed) {
    // A workbook was successfully parsed, but no valid canonical date was
    // found on any row (parsed.fileDate is missing or invalid) -- never
    // silently fall back to the device date, and never leave a previous,
    // now-stale Week value on screen. Multiple distinct row dates
    // (parsed.dateMismatch) alone do NOT reach this branch -- see
    // applyWeekFromParsed()'s header comment.
    els.weekNumber.textContent = '—';
    els.weekRange.textContent = 'Tidak dapat dihitung — tanggal pada file timbangan tidak ditemukan atau tidak valid.';
    els.weekDisplay.classList.add('hync-week-display--error');
  } else {
    els.weekNumber.textContent = '—';
    els.weekRange.textContent = 'Dihitung otomatis dari tanggal file timbangan setelah upload.';
    els.weekDisplay.classList.remove('hync-week-display--error');
  }
}

/* ============================================================
   CONTROLLED PERSONNEL SELECTION (V2.3 Phase 4)
   Report never creates personnel -- SPV SCM / FRM SCM / Independent
   Sampler / PIC 3rd are all selected from the Personnel Directory's
   already-synced snapshot (personnel-directory-service.js), resolved live
   on every render/generate via report-personnel.js (pure, DOM-free).
   reportState.personnel stores stable record ids only, never names.
============================================================ */
function applyBuyerDefaultSampler(buyer) {
  const snapshot = getPersonnelDirectorySnapshot();
  reportState.personnel = applyBuyerDefaultSamplerToPersonnel(snapshot.records, buyer, reportState.personnel);
}

function renderPersonnelSection() {
  const snapshot = getPersonnelDirectorySnapshot();
  const hasDirectory = snapshot.source !== 'none';

  els.personnelBlocked.hidden = hasDirectory;
  els.personnelFields.hidden = !hasDirectory;
  if (!hasDirectory) return;

  renderSpvList();
  renderFrmList();
  renderSamplerList();
  renderPicThirdList();
  renderManpowerLabel();
  syncManpowerInputs();
}

// Manpower AWK/ATQ/... and Total Manpower are both manual operational
// records (bug fix: Total Manpower was previously auto-calculated from
// selected SPV/FRM counts, which is wrong -- SPV/FRM selections identify
// names only and must never alter either manpower number). This only
// pushes reportState.personnel's current values into the two inputs; it
// is called from renderPersonnelSection() (init/reset/route-refresh)
// only -- never from the SPV/FRM/sampler/PIC change handlers, so neither
// input's value is ever touched as a side effect of a personnel selection
// change.
function syncManpowerInputs() {
  els.mpThird.value = reportState.personnel.manpowerThirdParty == null ? '' : String(reportState.personnel.manpowerThirdParty);
  els.mpTotal.value = reportState.personnel.totalManpower == null ? '' : String(reportState.personnel.totalManpower);
}

function personnelOptionMarkup({ inputType, name, id, value, checked, label, badgeHtml }) {
  return `
    <label class="hync-personnel-option${checked ? ' hync-personnel-option--selected' : ''}" for="${id}">
      <input type="${inputType}"${name ? ` name="${name}"` : ''} id="${id}" value="${escapeHtml(value)}" ${checked ? 'checked' : ''}>
      <span class="hync-personnel-name">${escapeHtml(label)}</span>
      ${badgeHtml || ''}
    </label>
  `;
}

function renderSpvList() {
  const active = getActivePersonnelByRole('SPV_SCM');
  const selected = reportState.personnel.spvScmIds;
  const activeIds = new Set(active.map((r) => r.id));
  const staleCount = selected.filter((id) => !activeIds.has(id)).length;
  els.spvCount.textContent = `${selected.length} dipilih` + (staleCount ? ` (${staleCount} tidak aktif, periksa kembali)` : '');

  const sorted = sortRecords(active);
  els.spvList.innerHTML = sorted.length
    ? sorted.map((r) => personnelOptionMarkup({
        inputType: 'checkbox',
        id: `hync-spv-${escapeHtml(r.id)}`,
        value: r.id,
        checked: selected.includes(r.id),
        label: r.name,
      })).join('')
    : '<p class="hync-personnel-empty">Tidak ada SPV SCM aktif.</p>';
}

function renderFrmList() {
  const active = getActivePersonnelByRole('FRM_SCM');
  const selected = reportState.personnel.frmScmIds;
  const activeIds = new Set(active.map((r) => r.id));
  const staleCount = selected.filter((id) => !activeIds.has(id)).length;
  els.frmCount.textContent = `${selected.length} dipilih` + (staleCount ? ` (${staleCount} tidak aktif, periksa kembali)` : '');

  const sorted = sortRecords(active);
  els.frmList.innerHTML = sorted.length
    ? sorted.map((r) => personnelOptionMarkup({
        inputType: 'checkbox',
        id: `hync-frm-${escapeHtml(r.id)}`,
        value: r.id,
        checked: selected.includes(r.id),
        label: r.name,
      })).join('')
    : '<p class="hync-personnel-empty">Tidak ada FRM SCM aktif.</p>';
}

function renderSamplerList() {
  const active = getActivePersonnelByRole('SAMPLER');
  const selectedId = reportState.personnel.samplerId;
  const sorted = sortRecords(active);

  els.samplerList.innerHTML = sorted.length
    ? sorted.map((r) => {
        const checked = r.id === selectedId;
        const isDefault = checked && reportState.personnel.samplerSource === 'buyer-default';
        return personnelOptionMarkup({
          inputType: 'radio',
          name: 'hync-sampler',
          id: `hync-sampler-${escapeHtml(r.id)}`,
          value: r.id,
          checked,
          label: r.organization,
          badgeHtml: isDefault ? '<span class="hync-personnel-badge hync-personnel-badge--default">Default buyer</span>' : '',
        });
      }).join('')
    : '<p class="hync-personnel-empty">Tidak ada Independent Sampler aktif.</p>';

  if (selectedId && !active.some((r) => r.id === selectedId)) {
    els.samplerList.insertAdjacentHTML('beforeend', '<p class="hync-personnel-empty">Sampler yang sebelumnya dipilih sudah tidak aktif -- pilih ulang.</p>');
  }
}

function renderPicThirdList() {
  const snapshot = getPersonnelDirectorySnapshot();
  const sampler = resolveSelectedPersonnel(snapshot.records, reportState.personnel).sampler;
  const selectedId = reportState.personnel.picThirdId;

  if (!sampler) {
    // Label fix: the PIC label always follows the selected Independent
    // Sampler organization -- "PIC 3rd" and parenthetical explanatory
    // text are both forbidden output/label shapes. "PIC Independent
    // Sampler" is only the neutral placeholder shown before any sampler
    // is selected, mirroring the Manpower label's own neutral fallback.
    els.picThirdLabel.textContent = 'PIC Independent Sampler';
    els.picThirdList.innerHTML = '<p class="hync-personnel-empty">Pilih Independent Sampler terlebih dahulu.</p>';
    return;
  }

  els.picThirdLabel.textContent = `PIC ${sampler.organization}`;
  const active = getActivePicThirdByOrganization(sampler.organization);
  els.picThirdList.innerHTML = active.length
    ? active.map((r) => personnelOptionMarkup({
        inputType: 'radio',
        name: 'hync-pic-third',
        id: `hync-pic-third-${escapeHtml(r.id)}`,
        value: r.id,
        checked: r.id === selectedId,
        label: r.name,
      })).join('')
    : `<p class="hync-personnel-empty">Tidak ada PIC 3rd aktif untuk ${escapeHtml(sampler.organization)}.</p>`;

  if (selectedId && !active.some((r) => r.id === selectedId)) {
    els.picThirdList.insertAdjacentHTML('beforeend', '<p class="hync-personnel-empty">PIC 3rd yang sebelumnya dipilih sudah tidak sesuai/tidak aktif -- pilih ulang.</p>');
  }
}

function renderManpowerLabel() {
  const snapshot = getPersonnelDirectorySnapshot();
  const sampler = resolveSelectedPersonnel(snapshot.records, reportState.personnel).sampler;
  els.mpThirdLabel.textContent = sampler ? `Manpower ${sampler.organization}` : 'Manpower Independent Sampler';
  els.mpTotalLabel.textContent = sampler ? `Total Manpower ${sampler.organization}` : 'Total Manpower Independent Sampler';
}

function toggleArrayValue(array, value, present) {
  const idx = array.indexOf(value);
  if (present && idx === -1) array.push(value);
  if (!present && idx !== -1) array.splice(idx, 1);
}

function handleSpvListChange(event) {
  const input = event.target;
  if (!(input instanceof HTMLInputElement) || input.type !== 'checkbox') return;
  toggleArrayValue(reportState.personnel.spvScmIds, input.value, input.checked);
  reportState.reportText = '';
  renderSpvList();
}

function handleFrmListChange(event) {
  const input = event.target;
  if (!(input instanceof HTMLInputElement) || input.type !== 'checkbox') return;
  toggleArrayValue(reportState.personnel.frmScmIds, input.value, input.checked);
  reportState.reportText = '';
  renderFrmList();
}

function handleSamplerListChange(event) {
  const input = event.target;
  if (!(input instanceof HTMLInputElement) || input.type !== 'radio' || !input.checked) return;
  const snapshot = getPersonnelDirectorySnapshot();
  reportState.personnel = overrideSampler(snapshot.records, input.value, reportState.personnel);
  reportState.reportText = '';
  renderSamplerList();
  renderPicThirdList();
  // Only the Manpower label follows the new sampler organization -- the
  // entered manpowerThirdParty/totalManpower values are untouched (bug
  // fix: they must never be cleared or recalculated on a sampler change).
  renderManpowerLabel();
}

function handlePicThirdListChange(event) {
  const input = event.target;
  if (!(input instanceof HTMLInputElement) || input.type !== 'radio' || !input.checked) return;
  reportState.personnel.picThirdId = input.value;
  reportState.reportText = '';
  renderPicThirdList();
}

function handleManpowerThirdInput() {
  const raw = els.mpThird.value;
  reportState.personnel.manpowerThirdParty = raw === '' ? null : Number(raw);
  reportState.reportText = '';
}

function handleTotalManpowerInput() {
  const raw = els.mpTotal.value;
  reportState.personnel.totalManpower = raw === '' ? null : Number(raw);
  reportState.reportText = '';
}

/* ============================================================
   STEP 1: FILE UPLOAD
============================================================ */
function handleFileChange(event) {
  const file = event.target.files[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = async (evt) => {
    // Contractor directory drift fix: exactly one List DT read sync per
    // upload, awaited before contractor classification runs -- reuses an
    // already in-flight sync (e.g. the one fired at page init) via the
    // service's own in-flight dedup, or starts exactly one fresh request
    // otherwise. This is what actually closes the race the previous
    // fire-and-forget-at-init-only approach left open: a workbook is now
    // never classified against a directory snapshot older than this
    // specific upload attempt. Never fetches per-row -- one attempt, once,
    // per upload event.
    renderFileStatus(true, 'Menyinkronkan List DT sebelum membaca file...');
    await syncContractorDirectory().catch(() => undefined);
    renderContractorDirectoryStatus();

    try {
      if (typeof XLSX === 'undefined') {
        throw new Error('Library Excel belum siap. Muat ulang aplikasi lalu coba lagi.');
      }
      const data = new Uint8Array(evt.target.result);
      const workbook = XLSX.read(data, { type: 'array' });
      // parseUploadedWorkbook (report-workbook-dispatcher.js) decides
      // HYNC/SLNC vs ESG Format A vs ESG Format B vs unsupported/ambiguous
      // ESG-shaped file -- this page never sends a workbook to the
      // HYNC/SLNC parser directly. Contractor resolution inside this call
      // (shared-report-profile.js's resolveContractor() /
      // esg-profile.js's resolveEsgContractor()) now reads the directory
      // snapshot the sync above just refreshed.
      const parsed = parseUploadedWorkbook(workbook);

      reportState.parsed = parsed;
      reportState.fileName = file.name;
      reportState.fileParsed = true;
      reportState.domeAreas = {};
      reportState.workbookBuyer = parsed.workbookBuyer;
      reportState.workbookBuyerIssues = parsed.workbookBuyerIssues;
      reportState.workbookFormat = parsed.workbookFormat || null;
      applyWeekFromParsed(parsed);

      const summary = parsed.workbookFormat ? buildEsgFileSummary(parsed) : buildFileSummary(parsed);
      renderFileStatus(true, summary);
      els.fileDropText.textContent = '✓ ' + file.name;
    } catch (err) {
      // Do not clear the already-selected filename/drop-zone display on
      // error -- only the parse result and buyer state reset, so the user
      // can see which file failed without re-selecting it to try again.
      reportState.fileParsed = false;
      reportState.parsed = null;
      reportState.workbookBuyer = null;
      reportState.workbookBuyerIssues = null;
      reportState.workbookFormat = null;
      applyWeekFromParsed(null);
      renderFileStatus(false, 'Gagal membaca file: ' + err.message);
    }
    recomputeBuyerResolution({ openPopupOnNewMismatch: true });
  };
  reader.readAsArrayBuffer(file);
}

function renderFileStatus(ok, msg) {
  els.fileStatus.className = 'hync-file-status ' + (ok ? 'ok' : 'err');
  els.fileStatus.textContent = msg;
}

/* ============================================================
   CONTRACTOR DIRECTORY STATUS + MANUAL REFRESH (shared-cache
   architecture round). Report must never silently present the static
   embedded fallback as if it were synchronized -- this status line always
   tells the user which of the three real tiers (this instance's own live
   Remote fetch / the Shared cache written by Monitor or Report / the
   Static embedded fallback) the just-parsed or about-to-be-parsed
   workbook's contractor breakdown actually came from. "Shared cache" is
   deliberately not called a private Report cache -- hpal.contractors.v1
   may have been written by Monitor's own sync, not this Report session.
============================================================ */
function renderContractorDirectoryStatus() {
  const status = getContractorDirectoryStatus();
  let text;
  const isFallback = status.source === 'none';

  if (status.source === 'remote') {
    text = `List DT: Remote — ${status.recordCount} records`;
  } else if (status.source === 'shared-cache') {
    text = `List DT: Shared cache — ${status.recordCount} records`;
  } else {
    // The static embedded table (contractor-adapter.js) is always present
    // in the shipped app -- "List DT: Unavailable" (a fourth status the
    // Owner asked for) would require the static table itself to also be
    // empty, which cannot happen in a normal build, so it is never
    // reachable here in practice; documented rather than built as dead
    // code. source 'none' always means "no synced/shared-cache directory
    // yet, running on the static fallback only."
    text = 'List DT: Static fallback — data may be outdated';
  }
  if ((status.source === 'remote' || status.source === 'shared-cache') && status.fetchedAt) {
    text += ` · sinkron terakhir ${formatContractorTimestamp(status.fetchedAt)}`;
  }

  els.contractorStatus.textContent = text;
  els.contractorStatus.classList.toggle('hync-contractor-status--warn', isFallback);

  // Local file:// mode (bug fix): a fetch failure under file:// must never
  // be silently reported as if the remote endpoint were simply empty --
  // the browser's own file:// origin restrictions can block the request
  // before it ever reaches the network, which is a very different problem
  // from "the endpoint has no data." Owner testing must use
  // http://127.0.0.1:<port>/ or http://localhost:<port>/, never file:///.
  const isFileProtocol = typeof location !== 'undefined' && location.protocol === 'file:';
  if (isFallback && isFileProtocol) {
    els.contractorStatusWarn.textContent = 'Sinkronisasi List DT tidak dapat divalidasi dari mode file lokal. Jalankan aplikasi melalui Live Server atau localhost.';
    els.contractorStatusWarn.hidden = false;
  } else if (isFallback) {
    els.contractorStatusWarn.textContent = 'List DT terbaru tidak dapat dimuat. Report menggunakan daftar bawaan yang mungkin belum mencakup unit terbaru.';
    els.contractorStatusWarn.hidden = false;
  } else {
    els.contractorStatusWarn.hidden = true;
  }
}

function formatContractorTimestamp(isoString) {
  const date = new Date(isoString);
  if (isNaN(date)) return '-';
  return date.toLocaleString('id-ID', { dateStyle: 'medium', timeStyle: 'short' });
}

// Reclassifies the currently uploaded workbook's contractor breakdown
// (DT/ADT totals, contractor counts, unmatched list) from its already-
// preserved raw records against whatever the directory snapshot
// currently holds, without requiring re-upload. Tonnage, ritase, workbook
// date, shift, buyer/profile, Automatic Week, dome data, loading-point
// assignments, personnel selections, manpower inputs, and Problem/Action
// are all untouched -- recomputeContractorAggregates() (report-utils.js)
// only ever reads/returns contractor-derived fields. A no-op if no
// workbook has been parsed yet. Shared by the manual "Refresh List DT"
// button and the hpal:contractor-directory-updated event handler below,
// so there is exactly one reclassification code path.
function reclassifyCurrentWorkbookIfParsed() {
  if (!reportState.fileParsed || !reportState.parsed) return;

  const resolver = reportState.resolvedBuyer === 'ESG' ? resolveEsgContractor : resolveContractor;
  const aggregates = recomputeContractorAggregates(reportState.parsed.records, resolver);
  reportState.parsed = { ...reportState.parsed, ...aggregates };

  // A previously generated report may have been built from the old,
  // stale contractor breakdown -- invalidate it rather than leave a
  // mismatched output on screen; the user regenerates from Step 3.
  reportState.reportText = '';
  els.output.value = '';

  const summary = reportState.parsed.workbookFormat ? buildEsgFileSummary(reportState.parsed) : buildFileSummary(reportState.parsed);
  renderFileStatus(true, summary);

  if (reportState.step === 3) {
    renderScaleDisplay(reportState.parsed);
    renderWarnings(reportState.parsed);
  }
}

// Reacts to hpal:contractor-directory-updated -- dispatched by EITHER
// Monitor's own List DT sync (contractor-assignment.js, via the shared
// core) or this page's own sync (syncContractorDirectory() below), so
// Report picks up a Monitor-driven sync it did not itself trigger.
// Registered exactly once in initReportPage() (see
// subscribeContractorDirectoryUpdated()'s own single-registration
// comment there).
function handleContractorDirectoryUpdatedEvent() {
  loadCachedContractorDirectory();
  renderContractorDirectoryStatus();
  reclassifyCurrentWorkbookIfParsed();
}

// "Refresh List DT" -- read-only: fetches the latest List DT. Status
// re-render and workbook reclassification both happen via
// handleContractorDirectoryUpdatedEvent() above once the sync's own
// success path dispatches the update event (dispatchEvent runs listeners
// synchronously, so this has already happened by the time the awaited
// promise below resolves) -- kept as one single reclassification code
// path rather than duplicated here. The explicit render call after the
// await only covers the failure case, where no event fires.
async function handleRefreshContractorDirectory() {
  const originalLabel = els.contractorRefreshBtn.textContent;
  els.contractorRefreshBtn.disabled = true;
  els.contractorRefreshBtn.textContent = 'Menyinkronkan...';

  await syncContractorDirectory().catch(() => undefined);
  renderContractorDirectoryStatus();

  els.contractorRefreshBtn.disabled = false;
  els.contractorRefreshBtn.textContent = originalLabel;
}

/* ============================================================
   STEP 1 -> 2
============================================================ */
function goToStep2() {
  const errors = [];

  const prevTextRaw = els.prevText.value;
  // Previous Report is required for every buyer except one whose profile
  // says otherwise (currently ESG only). Which buyer applies is already
  // known reliably from the uploaded workbook at this point (upload
  // happens independently, before this gate runs); if no workbook has
  // been uploaded yet, default to "required" -- the file-required error
  // below already blocks in that case regardless.
  const workbookProfile = reportState.workbookBuyer ? getProfile(reportState.workbookBuyer) : null;
  const prevReportRequired = !(workbookProfile && workbookProfile.previousReportOptional);

  if (prevReportRequired && !prevTextRaw.trim()) errors.push('Teks report sebelumnya belum diisi.');
  if (!reportState.fileParsed) errors.push('File data timbangan belum berhasil diupload/dibaca.');
  // Automatic Week (V2.3 Phase 1): only surfaced once a workbook has
  // actually been parsed -- if no file was uploaded at all, the
  // "File data timbangan belum berhasil diupload/dibaca." error above
  // already explains why Week is empty, so this avoids a redundant second
  // message for the same underlying cause.
  if (reportState.fileParsed && reportState.weekNumber == null) {
    errors.push('Week tidak dapat dihitung dari tanggal file timbangan — periksa kembali file yang diupload.');
  }

  // Shift detection bug fix: classifyShift() (report-utils.js) never
  // guesses a shift on a tie or when no row has a valid timestamp -- both
  // come back as reportState.parsed.shiftLabel === null, which blocks
  // here with a specific message rather than silently defaulting, same
  // gating pattern as the Week check above.
  if (reportState.fileParsed && reportState.parsed && reportState.parsed.shiftLabel == null) {
    const p = reportState.parsed;
    if (p.shiftDayCount > 0 && p.shiftDayCount === p.shiftNightCount) {
      errors.push(`Shift tidak dapat ditentukan — distribusi jam Day Shift dan Night Shift pada file timbangan sama besar (${p.shiftDayCount} baris masing-masing).`);
    } else {
      errors.push('Shift tidak dapat ditentukan — tidak ada jam timbang yang valid pada file timbangan.');
    }
  }

  // Controlled Personnel selection (V2.3 Phase 4): a missing directory
  // snapshot blocks before any per-field check even runs; otherwise every
  // selection-level rule (required fields, stale/inactive ids, PIC/sampler
  // organization match, manpower range) is enforced by the same pure
  // function Report's output-generation gate reuses in goToStep3().
  const personnelSnapshot = getPersonnelDirectorySnapshot();
  const directoryError = getDirectoryAvailabilityError(personnelSnapshot.source);
  if (directoryError) {
    errors.push(directoryError);
  } else {
    errors.push(...validatePersonnelSelections(personnelSnapshot.records, reportState.personnel));
  }

  let prevParsed = null;
  if (prevTextRaw.trim()) {
    prevParsed = parsePrevText(prevTextRaw);
    if (prevParsed.errors.length) errors.push(...prevParsed.errors);
  } else if (!prevReportRequired) {
    // Empty previous report, allowed for this buyer: zero previous
    // accumulation, so calculateTotals() (unchanged, shared, buyer-
    // agnostic) naturally produces Daily = WTD = MTD = YTD = On Shift --
    // isNightContinuation/sameDate both treat a null `date` as "no
    // match", so every accumulator resets to onShift alone, exactly the
    // approved ESG first-report/new-period behavior.
    prevParsed = { date: null, daily: { ton: 0, rit: 0 }, wtd: { ton: 0, rit: 0 }, mtd: { ton: 0, rit: 0 }, ytd: { ton: 0, rit: 0 }, errors: [] };
  }

  const buyerStatus = recomputeBuyerResolution({ openPopupOnNewMismatch: true });
  if (buyerStatus !== BUYER_STATUS.CONFIRMED) errors.push(buyerGateErrorMessage(buyerStatus));

  if (errors.length) {
    renderAlert(els.step1Errors, errors);
    return;
  }
  els.step1Errors.innerHTML = '';

  reportState.inputs = {
    problem: els.problem.value.trim(),
    action: els.action.value.trim(),
  };
  reportState.prevText = prevTextRaw;
  reportState.prev = prevParsed;

  renderDomeList();
  renderStep(2);
}

function renderAlert(container, messages) {
  container.innerHTML = '<div class="hync-alert">⚠ ' + messages.map(escapeHtml).join('<br>⚠ ') + '</div>';
}

/* ============================================================
   STEP 2: DOME / AREA SELECTION
============================================================ */
function renderDomeList() {
  const domes = reportState.parsed.domes;
  els.domeList.innerHTML = domes
    .map((d, i) => {
      const areaOptions = AREA_OPTIONS.map((area) => {
        const slug = area.replace(/\s/g, '');
        const radioId = `hync-area-${i}-${slug}`;
        return `
          <div class="hync-area-opt">
            <input type="radio" name="hync-area-${i}" id="${radioId}" value="${escapeHtml(area)}" data-dome-index="${i}">
            <label for="${radioId}">${escapeHtml(area)}</label>
          </div>
        `;
      }).join('');
      return `
        <div class="hync-dome-row" id="hync-dome-row-${i}">
          <div><span class="hync-dome-name">${escapeHtml(d.dome)}</span><span class="hync-dome-class">${escapeHtml(d.oreClass)}</span></div>
          <div class="hync-area-options">${areaOptions}</div>
        </div>
      `;
    })
    .join('');

  // Re-apply any area already chosen (e.g. user went back from step 3).
  domes.forEach((d, i) => {
    const area = reportState.domeAreas[d.dome];
    if (!area) return;
    const slug = area.replace(/\s/g, '');
    const radio = document.getElementById(`hync-area-${i}-${slug}`);
    if (radio) radio.checked = true;
  });
}

function handleDomeAreaChange(event) {
  const input = event.target;
  if (!(input instanceof HTMLInputElement) || input.type !== 'radio') return;
  const idx = Number(input.dataset.domeIndex);
  const dome = reportState.parsed.domes[idx];
  if (!dome) return;
  reportState.domeAreas[dome.dome] = input.value;
  document.getElementById('hync-dome-row-' + idx)?.classList.remove('hync-dome-row--missing');
}

/* ============================================================
   STEP 2 -> 3: GENERATE
============================================================ */
function goToStep3() {
  if (reportState.buyerValidationStatus !== BUYER_STATUS.CONFIRMED || !reportState.resolvedBuyer) {
    renderAlert(els.step2Errors, ['Buyer belum terkonfirmasi. Kembali ke Step 1 dan pastikan teks report serta file timbangan berasal dari buyer yang sama.']);
    return;
  }

  const domes = reportState.parsed.domes;
  const missing = domes.filter((d) => !reportState.domeAreas[d.dome]);
  if (missing.length) {
    renderAlert(els.step2Errors, [`Pilih area untuk semua dome dulu (${missing.length} belum dipilih, ditandai merah).`]);
    missing.forEach((d) => {
      const idx = domes.findIndex((x) => x.dome === d.dome);
      document.getElementById('hync-dome-row-' + idx)?.classList.add('hync-dome-row--missing');
    });
    return;
  }
  // Stale-directory handling (V2.3 Phase 4): resolve and revalidate
  // personnel selections against the *current* directory snapshot again
  // at generation time, not just at the Step 1 -> 2 gate -- Settings could
  // have been synced (or the cache could have been cleared) since Step 1.
  const personnelSnapshot = getPersonnelDirectorySnapshot();
  const directoryError = getDirectoryAvailabilityError(personnelSnapshot.source);
  const personnelErrors = directoryError ? [directoryError] : validatePersonnelSelections(personnelSnapshot.records, reportState.personnel);
  if (personnelErrors.length) {
    renderAlert(els.step2Errors, personnelErrors);
    return;
  }
  els.step2Errors.innerHTML = '';

  const totals = calculateTotals({ parsed: reportState.parsed, prev: reportState.prev });
  reportState.totals = totals;

  const personnelLines = buildPersonnelOutputLines(personnelSnapshot.records, reportState.personnel);
  const reportText = buildReportText({
    buyer: reportState.resolvedBuyer,
    parsed: reportState.parsed,
    inputs: reportState.inputs,
    domeAreas: reportState.domeAreas,
    totals,
    weekNumber: reportState.weekNumber,
    personnelLines,
  });
  reportState.reportText = reportText;
  els.output.value = reportText;

  renderScaleDisplay(reportState.parsed);
  renderWarnings(reportState.parsed);

  renderStep(3);
}

function renderScaleDisplay(parsed) {
  els.scaleDisplay.innerHTML = `
    <div class="hync-scale-row"><span class="hync-scale-label">Tanggal</span><span class="hync-scale-value">${parsed.fileDate ? escapeHtml(formatDateID(parsed.fileDate)) : '-'}</span></div>
    <div class="hync-scale-row"><span class="hync-scale-label">Shift</span><span class="hync-scale-value">${escapeHtml(parsed.shiftLabel)}</span></div>
    <div class="hync-scale-row"><span class="hync-scale-label">On Shift</span><span class="hync-scale-value">${escapeHtml(fmtTon(parsed.onShiftTon))} wmt</span></div>
    <div class="hync-scale-row"><span class="hync-scale-label">Ritase Shift</span><span class="hync-scale-value">${escapeHtml(fmtRit(parsed.onShiftRit))} Rit</span></div>
    <div class="hync-scale-row"><span class="hync-scale-label">Truck</span><span class="hync-scale-value">${parsed.totalDT} DT + ${parsed.totalADT} ADT</span></div>
  `;
}

function renderWarnings(parsed) {
  const warns = [];
  if (parsed.shiftFallback) warns.push('Tidak ada jam timbang valid terbaca — shift otomatis di-set "Day Shift", mohon cek manual.');
  if (parsed.dateMismatch) warns.push('Ada lebih dari 1 tanggal berbeda di dalam file timbangan ini — dipakai tanggal dari baris pertama.');
  if (parsed.unmatchedTrucks.length) warns.push(`${parsed.unmatchedTrucks.length} no. truck tidak ditemukan di List_DT (dianggap "TIDAK DIKENALI"): ${parsed.unmatchedTrucks.join(', ')}`);
  els.step3Warnings.innerHTML = warns.length
    ? `<div class="hync-warn-box">${warns.map((w) => '⚠ ' + escapeHtml(w)).join('<br>')}</div>`
    : '';
}

/* ============================================================
   COPY TO CLIPBOARD
============================================================ */
async function copyOutput() {
  const text = els.output.value;
  els.output.focus();
  els.output.select();

  let ok = false;
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(text);
      ok = true;
    } else {
      ok = document.execCommand('copy');
    }
  } catch (_err) {
    try {
      ok = document.execCommand('copy');
    } catch (_fallbackErr) {
      ok = false;
    }
  }
  showCopyFeedback(ok);
}

function showCopyFeedback(ok) {
  els.copyFeedback.textContent = ok ? '✓ Tersalin ke clipboard' : '✗ Gagal menyalin otomatis, silakan copy manual dari kotak di atas';
  els.copyFeedback.classList.toggle('hync-copy-feedback--error', !ok);
  els.copyFeedback.style.display = 'block';
  window.setTimeout(() => {
    els.copyFeedback.style.display = 'none';
  }, 2500);
}

/* ============================================================
   RESET
============================================================ */
function handleResetClick() {
  const confirmed = window.confirm('Reset semua data laporan yang sudah diisi?');
  if (!confirmed) return;

  resetReportState();
  els.prevText.value = '';
  renderWeekDisplay(); // resetReportState() already nulled weekNumber/weekYear/weekStart/weekEnd; this repaints the neutral placeholder
  // resetReportState() already restored reportState.personnel to its empty
  // defaults (all ids/manpower nulled, samplerSource null) -- this repaints
  // the selectors/manpower input/total to match, same pattern as Week above.
  renderPersonnelSection();
  els.problem.value = '';
  els.action.value = '';
  els.fileInput.value = '';
  els.fileDropText.textContent = 'Klik untuk upload file timbangan (.xlsx/.xls)';
  els.fileStatus.className = 'hync-file-status';
  els.fileStatus.textContent = '';
  els.step1Errors.innerHTML = '';
  els.step2Errors.innerHTML = '';
  els.domeList.innerHTML = '';
  els.scaleDisplay.innerHTML = '';
  els.step3Warnings.innerHTML = '';
  els.output.value = '';

  closeBuyerMismatchPopup();
  updateBuyerUI();

  renderStep(1);
  autoGrowTextarea(els.prevText);
}

/* ============================================================
   STEP NAV
============================================================ */
function renderStep(n) {
  reportState.step = n;
  [1, 2, 3].forEach((i) => {
    const panel = els[`step${i}`];
    const pill = els[`pill${i}`];
    panel.classList.toggle('active', i === n);
    pill.classList.toggle('active', i === n);
    pill.classList.toggle('done', i < n);
  });
  window.scrollTo({ top: 0, behavior: 'smooth' });
}
