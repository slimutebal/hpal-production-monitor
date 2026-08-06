// Report page (HYNC + SLNC, one shared UI). Builds the Step 1/2/3 DOM once
// into #page-report and never rebuilds it on route change, so field
// values, the active step, and generated output survive Report <->
// Monitor/Settings navigation (see docs/V2.0_ARCHITECTURE_AND_ROADMAP.md
// section 12). Everything here is module-scoped -- no globals, no inline
// onclick attributes.
//
// Buyer (HYNC vs SLNC) is detected automatically from the previous-report
// text and the uploaded workbook; this page never imports hync-profile.js
// or slnc-profile.js directly -- it calls the shared parsing/report engine
// (shared-report-profile.js) with whichever buyer profile-registry.js
// resolves, so the UI truly is one shared page rather than two branches of
// HYNC-specific code with SLNC bolted on.

import { escapeHtml, formatDateID, fmtTon, fmtRit } from './report-utils.js';
import { reportState, resetReportState, BUYER_STATUS } from './report-state.js';
import {
  AREA_OPTIONS,
  parsePrevText,
  parseWeighbridgeWorkbook,
  buildFileSummary,
  calculateTotals,
  buildReportText,
} from './profiles/shared-report-profile.js';
import { buyerFromPrevText } from './profiles/profile-registry.js';

let els = null; // cached DOM references, populated once in initReportPage()
let lastFocusedBeforeModal = null;

export function initReportPage() {
  const page = document.getElementById('page-report');
  if (!page) return;

  page.innerHTML = buildShellMarkup();
  els = collectElements(page);
  wireEvents();
  renderStep(reportState.step);
  autoGrowTextarea(els.prevText);
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
          <div class="hync-hint">Paste teks "DAILY PRODUCTION GEOLOGY REPORT" dari WA Group (shift sebelumnya). Dipakai untuk ambil tanggal &amp; angka WTD/MTD/YTD/Daily lama, dan untuk mendeteksi buyer (FPP HYNC / FPP SLNC).</div>
          <div class="hync-field">
            <label class="hync-req" for="hync-prev-text">Teks report sebelumnya</label>
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
        </div>

        <div class="hync-card">
          <h2>Man Power &amp; Support</h2>
          <div class="hync-field">
            <label class="hync-req" for="hync-week">Week</label>
            <input type="text" id="hync-week" class="hync-input" placeholder="contoh: 26">
          </div>
          <div class="hync-field">
            <label class="hync-req" for="hync-pic-scm">PIC SCM</label>
            <input type="text" id="hync-pic-scm" class="hync-input" placeholder="contoh: Illofi, Adi guna (pisahkan koma jika lebih dari satu)">
          </div>
          <div class="hync-field">
            <label class="hync-req" for="hync-pic-awk">PIC AWK</label>
            <input type="text" id="hync-pic-awk" class="hync-input" placeholder="contoh: La Ode Osardi">
          </div>
          <div class="hync-field hync-field--inline-2">
            <div>
              <label class="hync-req" for="hync-mp-awk">Manpower AWK</label>
              <input type="number" id="hync-mp-awk" class="hync-input" placeholder="25">
            </div>
            <div>
              <label class="hync-req" for="hync-mp-total">Total Manpower</label>
              <input type="number" id="hync-mp-total" class="hync-input" placeholder="27">
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
    fileInput: byId('hync-file-input'),
    fileDropText: byId('hync-file-drop-text'),
    fileStatus: byId('hync-file-status'),
    week: byId('hync-week'),
    picScm: byId('hync-pic-scm'),
    picAwk: byId('hync-pic-awk'),
    mpAwk: byId('hync-mp-awk'),
    mpTotal: byId('hync-mp-total'),
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
  const prevResult = buyerFromPrevText(els.prevText.value);
  reportState.previousReportBuyer = prevResult.status === 'ok' ? prevResult.buyer : null;
  const prevAmbiguous = prevResult.status === 'ambiguous';

  const workbookBuyer = reportState.workbookBuyer;
  const workbookIssues = reportState.workbookBuyerIssues;

  let status;
  let resolvedBuyer = null;

  if (prevAmbiguous) {
    status = BUYER_STATUS.AMBIGUOUS_PREVIOUS_REPORT;
  } else if (workbookIssues && workbookIssues.length) {
    status = BUYER_STATUS.INVALID_WORKBOOK;
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

  updateBuyerUI();

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

  els.eyebrow.textContent = labels.eyebrow;
  els.subtitle.textContent = labels.subtitle;
  els.workbookTitle.textContent = labels.workbookTitle;
  els.workbookHint.textContent = labels.workbookHint;
  els.footnote.textContent = labels.footnote;

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
        <p>Teks report sebelumnya menyebutkan <b>FPP HYNC</b> dan <b>FPP SLNC</b> sekaligus.</p>
        <p>Pastikan teks report sebelumnya hanya berasal dari satu buyer.</p>
      `,
    };
  }
  return null;
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
   STEP 1: FILE UPLOAD
============================================================ */
function handleFileChange(event) {
  const file = event.target.files[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = (evt) => {
    try {
      if (typeof XLSX === 'undefined') {
        throw new Error('Library Excel belum siap. Muat ulang aplikasi lalu coba lagi.');
      }
      const data = new Uint8Array(evt.target.result);
      const workbook = XLSX.read(data, { type: 'array' });
      const parsed = parseWeighbridgeWorkbook(workbook);

      reportState.parsed = parsed;
      reportState.fileName = file.name;
      reportState.fileParsed = true;
      reportState.domeAreas = {};
      reportState.workbookBuyer = parsed.workbookBuyer;
      reportState.workbookBuyerIssues = parsed.workbookBuyerIssues;

      renderFileStatus(true, buildFileSummary(parsed));
      els.fileDropText.textContent = '✓ ' + file.name;
    } catch (err) {
      reportState.fileParsed = false;
      reportState.parsed = null;
      reportState.workbookBuyer = null;
      reportState.workbookBuyerIssues = null;
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
   STEP 1 -> 2
============================================================ */
function goToStep2() {
  const errors = [];

  const prevTextRaw = els.prevText.value;
  if (!prevTextRaw.trim()) errors.push('Teks report sebelumnya belum diisi.');
  if (!reportState.fileParsed) errors.push('File data timbangan belum berhasil diupload/dibaca.');

  const week = els.week.value.trim();
  const picScm = els.picScm.value.trim();
  const picAwk = els.picAwk.value.trim();
  const mpAwk = els.mpAwk.value.trim();
  const mpTotal = els.mpTotal.value.trim();
  if (!week) errors.push('Week belum diisi.');
  if (!picScm) errors.push('PIC SCM belum diisi.');
  if (!picAwk) errors.push('PIC AWK belum diisi.');
  if (!mpAwk) errors.push('Manpower AWK belum diisi.');
  if (!mpTotal) errors.push('Total Manpower belum diisi.');

  let prevParsed = null;
  if (prevTextRaw.trim()) {
    prevParsed = parsePrevText(prevTextRaw);
    if (prevParsed.errors.length) errors.push(...prevParsed.errors);
  }

  const buyerStatus = recomputeBuyerResolution({ openPopupOnNewMismatch: true });
  if (buyerStatus !== BUYER_STATUS.CONFIRMED) errors.push(buyerGateErrorMessage(buyerStatus));

  if (errors.length) {
    renderAlert(els.step1Errors, errors);
    return;
  }
  els.step1Errors.innerHTML = '';

  reportState.inputs = {
    week,
    picScm,
    picAwk,
    mpAwk,
    mpTotal,
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
  els.step2Errors.innerHTML = '';

  const totals = calculateTotals({ parsed: reportState.parsed, prev: reportState.prev });
  reportState.totals = totals;

  const reportText = buildReportText({
    buyer: reportState.resolvedBuyer,
    parsed: reportState.parsed,
    inputs: reportState.inputs,
    domeAreas: reportState.domeAreas,
    totals,
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
  els.week.value = '';
  els.picScm.value = '';
  els.picAwk.value = '';
  els.mpAwk.value = '';
  els.mpTotal.value = '';
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
