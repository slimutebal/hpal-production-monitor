// Settings page (V2.3 Phase 8 -- Simple Local License and Access Control,
// layered on top of Phase 4/5's Personnel Directory online write
// management + offline queue; UI refinement -- summary-first main view +
// per-role management modal). See
// docs/V2.3_AUTO_WEEK_AND_PERSONNEL_DIRECTORY_ARCHITECTURE.md sections
// 16-20 for the Personnel Directory design this still builds on, and the
// same document's updated License section for the access-gate design
// this file now also owns.
//
// ACCESS TIERS (V2.3 Phase 8): this page renders one of two distinct DOM
// shapes depending on licenseService.getAccessTier() --
//
//   MONITOR_ONLY -- exactly three sections: License, Language, Appearance.
//   Personnel Directory (summary cards, Sync Status, Pending Changes) is
//   not merely disabled, it is not present in the DOM at all -- per the
//   Owner's explicit requirement that an unlicensed device never even see
//   that those controls exist.
//
//   FULL_ACCESS -- the full page: License (now showing "Full Access" +
//   Remove License), Language, Appearance, Sync Status, Pending Changes,
//   and the four Personnel Directory summary cards (unchanged from the
//   pre-Phase-8 design below).
//
// The whole shell is rebuilt (buildMarkup()/collectElements()/wireEvents()
// all re-run) every time the access tier actually changes (subscribeAccessChange()
// at the bottom of initSettingsPage()) -- this is the one deliberate
// exception to this codebase's usual "build markup once, never rebuild on
// route change" rule (see report-page.js's own header comment for that
// rule), because unlike a route change, a license unlock/removal must
// make Personnel Directory controls appear/disappear immediately, without
// a reload, and "hidden via CSS" would not satisfy "must NOT be visible
// at all". Global listeners that must survive across those rebuilds
// (onLocaleChange, onRouteChange, the 'online'/'offline'/
// hpal:preferences-changed window listeners, subscribeFullAccessAttention)
// are registered exactly once in initSettingsPage() and always read the
// current module-level `page`/`els` at call time rather than closing over
// a snapshot, so they keep working correctly across every rebuild.
//
// Two modal layers, never shown simultaneously: the role MANAGEMENT modal
// (list/search/filter) and the generic add/edit/deactivate-confirm/
// remove-license-confirm modal (reused as-is from the pre-refinement
// design, now also reused for the License card's Remove License
// confirmation). Opening Add/Edit/Deactivate from the management modal
// hides it (keeping its role/filter/search state) and shows the generic
// modal; closing the generic modal (Save success, Cancel, or Escape)
// re-shows the management modal, freshly re-rendered from the current
// authoritative snapshot.
//
// Phase 5's offline write queue (js/services/personnel-write-queue.js):
// when the device is offline, or a write fails with a genuine
// network-transport error, Add/Edit/Deactivate/Reactivate enqueue the
// write instead of failing outright. Phase 8 adds one more gate on top:
// every queue trigger point here (startup, the 'online' event, after a
// manual Sync) is only ever wired/reachable in the FULL_ACCESS shell in
// the first place, and personnel-write-queue.js's own flushPersonnelWriteQueue()/
// retryQueueItem() independently re-check hasFullAccess() at the action
// boundary -- so a queue that was already pending when the license was
// removed stays dormant (never flushed, never displayed, never retried)
// until FULL_ACCESS is restored, per the architecture doc's explicit
// "PENDING PERSONNEL QUEUE" requirement.
import {
  loadCachedPersonnelDirectory,
  syncPersonnelDirectory,
  getPersonnelDirectorySnapshot,
  getPersonnelByRole,
  addReportPersonnel,
  updateReportPersonnel,
  setReportPersonnelActive,
} from '../../services/personnel-directory-service.js';
import {
  getWriteQueueSnapshot,
  getWriteQueueSummary,
  enqueueAddReportPersonnel,
  enqueueUpdateReportPersonnel,
  enqueueSetReportPersonnelActive,
  removeQueueItem,
  retryQueueItem,
  flushPersonnelWriteQueue,
  isWriteQueueFlushInFlight,
} from '../../services/personnel-write-queue.js';
import {
  buildRoleSummaryText,
  filterPersonnelBySearch,
  buildOfflineIndicatorText,
  buildQueueCountText,
  buildQueueItemViewModel,
  buildQueueOfflineSavedMessage,
  buildQueueVersionConflictReviewMessage,
} from './settings-personnel.js';
import { getPreferences, setAppearance, VALID_LOCALES, VALID_APPEARANCES } from '../../services/app-preferences-service.js';
import { t, setLocale as applyLocale, onLocaleChange, translatePage } from '../../i18n/i18n.js';
import { onRouteChange } from '../../router.js';
import {
  hasFullAccess,
  getLicenseStatus,
  verifyAndInstallLicense,
  removeLicense,
  subscribeAccessChange,
  subscribeFullAccessAttention,
} from '../../services/license-service.js';

// orgFixed: the role's organization is never user-editable, always this
// literal value. orgMode ('free-text' | 'sampler-select') only applies
// when orgFixed is null, and drives BOTH the Add and Edit form's
// organization field identically (buildPersonnelFormMarkup/
// populatePersonnelForm below) -- PIC_3RD deliberately keeps a
// sampler-derived <select> rather than a raw free-text organization field
// even though it is "editable": a PIC 3rd's organization must match an
// existing Independent Sampler's organization for Report's PIC-filtering
// (getActivePicThirdByOrganization) to ever surface it, so constraining
// the input to real sampler organizations prevents silently orphaning a
// PIC 3rd record behind a typo (e.g. "AWK" vs "AWK2"). Independent
// Sampler has no such constraint -- a new sampler genuinely introduces a
// new organization, so its organization field is plain free text.
const ROLE_DEFS = [
  { role: 'SPV_SCM', title: 'SPV SCM', namePlaceholder: 'Nama SPV', orgFixed: 'SCM' },
  { role: 'FRM_SCM', title: 'FRM SCM', namePlaceholder: 'Nama Foreman', orgFixed: 'SCM' },
  { role: 'SAMPLER', title: 'Independent Sampler', namePlaceholder: 'Nama Sampler', orgFixed: null, orgMode: 'free-text' },
  { role: 'PIC_3RD', title: 'PIC 3rd', namePlaceholder: 'Nama PIC', orgFixed: null, orgMode: 'sampler-select' },
];

const DEFAULT_STATUS = 'active';

// Functions, not a static object -- so each is re-evaluated in the
// current locale at the point of use (a plain object literal would freeze
// its value at whatever locale was active at module load time).
const MESSAGES = {
  success: () => t('settings.sync.successMessage'),
  cacheFallback: () => t('settings.sync.cacheFallbackMessage'),
  noCache: () => t('settings.sync.noCacheMessage'),
};

// Server error `code` -> user-facing message. VERSION_CONFLICT's message
// is the exact literal the architecture doc requires, never a
// server-supplied variant.
function describeWriteError(error) {
  if (!error) return t('errors.personnel.default');
  if (error.code === 'VERSION_CONFLICT') return t('errors.personnel.VERSION_CONFLICT');
  if (error.code === 'DUPLICATE_PERSONNEL') return t('errors.personnel.DUPLICATE_PERSONNEL');
  if (error.code === 'NOT_FOUND') return t('errors.personnel.NOT_FOUND');
  if (error.code === 'VALIDATION_ERROR') return error.message || t('errors.personnel.VALIDATION_ERROR');
  if (error.code === 'NETWORK_UNAVAILABLE' || error.code === 'NETWORK_ERROR') return t('errors.personnel.NETWORK');
  // The server acknowledged the write, but the record it claims to have
  // written could not be independently confirmed in the authoritative
  // resync -- never presented as success (see personnel-directory-service.js's
  // writeAndResync()/verifyRecord*()).
  if (error.code === 'WRITE_NOT_VISIBLE_AFTER_SYNC') {
    return t('errors.personnel.WRITE_NOT_VISIBLE_AFTER_SYNC');
  }
  if (error.code === 'LICENSE_REQUIRED') return t('license.fullAccessRequired');
  return error.message || t('errors.personnel.genericFallback');
}

// Distinguishes a genuine network/transport failure (the only case that
// falls back to the offline queue) from every other write outcome. Per the
// NETWORK FAILURE CLASSIFICATION requirement, application-level errors
// (VERSION_CONFLICT, DUPLICATE_PERSONNEL, VALIDATION_ERROR, NOT_FOUND, a
// malformed response, ...) must never be queued -- they are shown to the
// user immediately via describeWriteError() instead, same as before Phase 5.
// LICENSE_REQUIRED is likewise never queued -- it is a local action-boundary
// guard result (personnel-directory-service.js), not a server/network
// outcome, and Settings never even wires these write actions while
// unlicensed in the first place (this branch exists only as defense in
// depth against a direct programmatic call).
function isNetworkFailure(error) {
  return !!error && (error.code === 'NETWORK_ERROR' || error.code === 'NETWORK_UNAVAILABLE');
}

let page = null;
let els = null;
let syncInFlight = false;
let writeInFlight = false;
let lastFocusedBeforeModal = null;

// Role management modal state -- which role is currently open (or null),
// and its own local filter/search, scoped to whichever role is open
// (reset to the default filter and empty search every time a role is
// freshly opened via "Kelola").
let managedRole = null;
let managementStatus = DEFAULT_STATUS;
let managementSearchQuery = '';

// Generic add/edit/deactivate-confirm/remove-license-confirm modal state.
let currentModalRecord = null;
let modalConfirmHandler = null;

// License card state (V2.3 Phase 8).
let licenseKeyVisible = false;
let licenseVerifyInFlight = false;
// Set by a route-guard/action-boundary denial elsewhere in the app
// (subscribeFullAccessAttention below) when Settings itself is not yet
// the visible route -- flushed (message shown, License input focused and
// scrolled into view) the moment #/settings actually becomes active, by
// whichever of tryFlushPendingLicenseAttention()'s call sites runs first.
let pendingLicenseAttention = false;

export function initSettingsPage() {
  page = document.getElementById('page-settings');
  if (!page) return;

  renderForAccessTier();

  // Global listeners, registered exactly once for the lifetime of the
  // app -- each reads the current module-level `page`/`els` at call time,
  // so they keep working correctly across every renderForAccessTier()
  // rebuild below (see this file's header comment).
  onLocaleChange(() => {
    translatePage(page);
    renderPreferenceCards();
    renderLicenseCard();
    // Re-render whatever dynamic (non data-i18n) text is currently on
    // screen so a locale switch doesn't leave those strings behind in the
    // old language -- translatePage() above only ever touches static
    // data-i18n-tagged markup. Only meaningful in the FULL_ACCESS shell.
    if (hasFullAccess()) renderAll();
  });

  window.addEventListener('online', handleNetworkOnline);
  window.addEventListener('offline', () => {
    if (hasFullAccess()) renderOfflineIndicator();
  });
  // Monitor's own theme toggle (index.html's classic, non-module inline
  // script) cannot `import` app-preferences-service.js, so it dispatches
  // this same raw window event directly on every change instead -- this
  // keeps the Appearance card's active-button state in sync whenever the
  // user changes theme from Monitor, not only from this card.
  window.addEventListener('hpal:preferences-changed', renderPreferenceCards);

  // Flushes a pending License-card-attention request (see
  // subscribeFullAccessAttention below) once #/settings genuinely becomes
  // the active route -- router.js's applyRoute() toggles the page's
  // is-active class BEFORE calling onRouteChange listeners, so
  // tryFlushPendingLicenseAttention()'s own visibility check is reliable
  // here.
  onRouteChange((route) => {
    if (route === 'settings') tryFlushPendingLicenseAttention();
  });

  // The route guard (app.js, denying #/report) and report-page.js's own
  // action-boundary guard both call requestFullAccessAttention() instead
  // of reaching into this module directly -- this is the one subscriber.
  subscribeFullAccessAttention(() => {
    pendingLicenseAttention = true;
    tryFlushPendingLicenseAttention();
  });

  // Rebuilds the entire shell on every access-tier change (Unlock, Remove
  // License, or a corrupted-storage reset at some future startup) -- see
  // this file's header comment for why a full rebuild, not a hide/show
  // toggle, is required here.
  subscribeAccessChange(() => renderForAccessTier());
}

/* ============================================================
   ACCESS-TIER SHELL RENDER -- the one function that (re)builds the DOM
   shape appropriate for the current access tier. Called once at init and
   again every time subscribeAccessChange() fires.
============================================================ */
function renderForAccessTier() {
  const fullAccess = hasFullAccess();

  page.innerHTML = buildMarkup(fullAccess);
  els = collectElements(page, fullAccess);
  licenseKeyVisible = false;
  wireEvents(fullAccess);

  translatePage(page);
  renderLicenseCard();
  renderPreferenceCards();

  if (fullAccess) {
    loadCachedPersonnelDirectory();
    renderAll();

    // Auto flush on startup / on every access-tier transition into
    // FULL_ACCESS (trigger 2 of AUTO FLUSH, and also what makes a queue
    // that stayed dormant through a MONITOR_ONLY period resume normal
    // behavior the moment FULL_ACCESS is restored -- "Settings may show
    // them again; normal queue auto-flush behavior may resume"): only
    // when already online AND the queue actually has something pending.
    if (navigator.onLine && getWriteQueueSummary().pending > 0) {
      triggerAutoFlush();
    }
  }

  // A pending License-card-attention request may have arrived while this
  // shell still had the OLD tier's markup (most notably: Remove License
  // itself rebuilds the shell out from under an open modal -- see
  // handleRemoveLicenseConfirm()) -- re-attempt now that fresh elements
  // exist and the tier is settled.
  tryFlushPendingLicenseAttention();
}

/* ============================================================
   SHELL MARKUP
============================================================ */
function buildMarkup(fullAccess) {
  return `
    <div class="settings-shell">
      <header class="settings-header">
        <h1 class="settings-title" data-i18n="settings.pageTitle">Settings</h1>
      </header>

      <h2 class="settings-section-label" data-i18n="settings.section.access">Access</h2>
      ${buildLicenseCardMarkup()}

      <h2 class="settings-section-label" data-i18n="settings.section.preferences">Preferences</h2>
      <section class="settings-card settings-preferences-card" aria-labelledby="settings-language-title">
        <h2 id="settings-language-title" data-i18n="settings.language.title">Bahasa</h2>
        <p class="settings-card-subtitle" data-i18n="settings.language.subtitle"></p>
        <div class="settings-filter" role="group" aria-label="Pilih bahasa" data-i18n-aria-label="settings.language.groupLabel" id="settings-language-filter">
          <button type="button" class="settings-filter-btn" data-locale="id" data-i18n="settings.language.id">Bahasa Indonesia</button>
          <button type="button" class="settings-filter-btn" data-locale="en" data-i18n="settings.language.en">English</button>
        </div>
      </section>

      <section class="settings-card settings-preferences-card" aria-labelledby="settings-appearance-title">
        <h2 id="settings-appearance-title" data-i18n="settings.appearance.title">Tampilan</h2>
        <p class="settings-card-subtitle" data-i18n="settings.appearance.subtitle"></p>
        <div class="settings-filter" role="group" aria-label="Pilih tampilan" data-i18n-aria-label="settings.appearance.groupLabel" id="settings-appearance-filter">
          <button type="button" class="settings-filter-btn" data-appearance="dark" data-i18n="settings.appearance.dark">Gelap</button>
          <button type="button" class="settings-filter-btn" data-appearance="light" data-i18n="settings.appearance.light">Terang</button>
          <button type="button" class="settings-filter-btn" data-appearance="auto" data-i18n="settings.appearance.auto">Otomatis</button>
        </div>
      </section>

      ${fullAccess ? buildOperationalMarkup() : ''}
    </div>

    ${fullAccess ? buildRoleManagementModalMarkup() : ''}
    ${buildGenericModalMarkup()}
    ${fullAccess ? buildQueueModalMarkup() : ''}
  `;
}

// License card: both the "locked" (MONITOR_ONLY) and "unlocked"
// (FULL_ACCESS) blocks are always both present in the markup -- only one
// is ever shown at a time (renderLicenseCard() toggles `hidden`), which
// keeps this one card's own internal structure stable across a
// renderForAccessTier() rebuild rather than needing a third markup
// variant. This is the ONLY operational-looking card that intentionally
// always renders in both tiers -- everything Personnel-Directory-related
// is gated by buildOperationalMarkup() below instead.
function buildLicenseCardMarkup() {
  return `
    <section class="settings-card settings-license-card" id="settings-license-card" aria-labelledby="settings-license-title">
      <h2 id="settings-license-title" data-i18n="settings.license.title">License</h2>
      <p class="settings-license-status" id="settings-license-status">-</p>

      <div id="settings-license-locked-block">
        <div class="settings-form-group">
          <label for="settings-license-input" data-i18n="settings.license.input">License key</label>
          <div class="settings-license-input-row">
            <input type="password" class="settings-input" id="settings-license-input" name="hpal-license-key" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" data-i18n-placeholder="settings.license.inputPlaceholder" placeholder="Enter license key">
            <button type="button" class="settings-btn settings-btn-ghost settings-btn-small" id="settings-license-toggle-visibility" data-i18n="common.show">Show</button>
          </div>
        </div>
        <div class="settings-btn-row">
          <button type="button" class="settings-btn settings-btn-primary" id="settings-license-unlock-btn" data-i18n="settings.license.unlock">Unlock</button>
        </div>
      </div>

      <div id="settings-license-unlocked-block" hidden>
        <dl class="settings-sync-meta">
          <div class="settings-sync-meta__row">
            <dt data-i18n="settings.license.installedAt">Installed</dt>
            <dd id="settings-license-installed-at">-</dd>
          </div>
        </dl>
        <div class="settings-btn-row">
          <button type="button" class="settings-btn settings-btn-danger" id="settings-license-remove-btn" data-i18n="settings.license.remove">Remove License</button>
        </div>
      </div>

      <p class="settings-sync-message" id="settings-license-message" role="status" aria-live="polite"></p>
    </section>
  `;
}

// FULL_ACCESS-only markup: the Personnel Directory intro (heading +
// description -- UI refinement, moved here from the page header so
// "Personnel Directory" reads as the introduction to this operational
// section rather than competing with the page's own "Settings" title),
// the Sync Status + Pending Changes card, and the four Personnel
// Directory role summary cards -- the latter two verbatim the same
// structure as the pre-Phase-8 design, just now only ever constructed
// when hasFullAccess() is true (see buildMarkup() above). Reuses the
// existing .settings-title/.settings-subtitle classes rather than
// inventing a new heading style, per the existing typography-token
// discipline this file already follows elsewhere.
function buildOperationalMarkup() {
  return `
    <div class="settings-section-intro">
      <h2 class="settings-title" data-i18n="settings.title">Personnel Directory</h2>
      <p class="settings-subtitle" data-i18n="settings.subtitle"></p>
    </div>

    <h2 class="settings-section-label" data-i18n="settings.section.operational">Operational Data</h2>
    <section class="settings-card settings-sync-card" aria-labelledby="settings-sync-title">
      <h2 id="settings-sync-title" data-i18n="settings.sync.title">Sync Status</h2>
      <dl class="settings-sync-meta">
        <div class="settings-sync-meta__row">
          <dt data-i18n="settings.sync.statusLabel">Status</dt>
          <dd id="settings-sync-status">-</dd>
        </div>
        <div class="settings-sync-meta__row">
          <dt data-i18n="settings.sync.sourceLabel">Sumber</dt>
          <dd id="settings-sync-source">-</dd>
        </div>
        <div class="settings-sync-meta__row">
          <dt data-i18n="settings.sync.lastSyncLabel">Terakhir sinkron</dt>
          <dd id="settings-sync-time">-</dd>
        </div>
        <div class="settings-sync-meta__row">
          <dt data-i18n="settings.sync.totalLabel">Total personel</dt>
          <dd id="settings-sync-total">0</dd>
        </div>
      </dl>
      <div class="settings-btn-row">
        <button type="button" class="settings-btn settings-btn-primary" id="settings-sync-btn" data-i18n="common.sync">Sync</button>
      </div>
      <p class="settings-sync-message" id="settings-sync-message" role="status" aria-live="polite" data-i18n="settings.sync.defaultMessage">Tekan Sync untuk memuat direktori personel.</p>
      <p class="settings-sync-message settings-sync-message--warn" id="settings-offline-indicator" role="status" aria-live="polite" hidden></p>
      <div class="settings-queue-status" id="settings-queue-status">
        <div class="settings-queue-status__text">
          <span class="settings-queue-status__label" data-i18n="settings.queue.pendingLabel">Pending Changes</span>
          <span class="settings-queue-status__count" id="settings-queue-count">0 pending</span>
        </div>
        <button type="button" class="settings-btn settings-btn-secondary settings-btn-small" id="settings-queue-review-btn" hidden data-i18n="settings.queue.reviewButton">Review</button>
      </div>
    </section>

    <section class="settings-personnel-grid">
      ${ROLE_DEFS.map((def) => buildRoleSummaryCardMarkup(def)).join('')}
    </section>
  `;
}

function buildRoleManagementModalMarkup() {
  return `
    <div class="modal-overlay" id="settings-role-modal-overlay">
      <div class="modal-box settings-role-modal-box" role="dialog" aria-modal="true" aria-labelledby="settings-role-modal-title">
        <div class="settings-role-modal-header">
          <div>
            <h3 id="settings-role-modal-title">Role</h3>
            <p class="settings-role-modal-count" id="settings-role-modal-count">0 aktif</p>
          </div>
          <button type="button" class="settings-btn settings-btn-ghost settings-btn-small" id="settings-role-modal-close" aria-label="Tutup" data-i18n-aria-label="common.close">✕</button>
        </div>

        <div class="settings-btn-row">
          <button type="button" class="settings-btn settings-btn-primary" id="settings-role-modal-add-btn" data-i18n="settings.role.addButton">+ Tambah Personel</button>
        </div>

        <input type="text" class="settings-input" id="settings-role-modal-search" placeholder="Cari nama..." data-i18n-placeholder="settings.role.searchPlaceholder" autocomplete="off">

        <div class="settings-filter" role="group" aria-label="Filter status personel">
          <button type="button" class="settings-filter-btn is-active" data-status="active" data-i18n="common.filterActive">Aktif</button>
          <button type="button" class="settings-filter-btn" data-status="inactive" data-i18n="common.filterInactive">Nonaktif</button>
          <button type="button" class="settings-filter-btn" data-status="all" data-i18n="common.filterAll">Semua</button>
        </div>

        <p class="settings-sync-message" id="settings-role-modal-message" role="status" aria-live="polite"></p>

        <ul class="settings-personnel-list" id="settings-role-modal-list"></ul>
      </div>
    </div>
  `;
}

// Generic modal shell -- reused for Add / Edit / Deactivate-confirm
// (FULL_ACCESS only, wired inside role management) AND Remove License
// confirmation (both tiers can, in principle, reach a "confirm a
// destructive action" moment, though in practice Remove License is the
// only such action reachable from MONITOR_ONLY-adjacent state -- it is
// FULL_ACCESS's own License card). Always rendered so the License card's
// Remove button (visible only in the FULL_ACCESS shell) always has a
// modal to open.
function buildGenericModalMarkup() {
  return `
    <div class="modal-overlay" id="settings-modal-overlay">
      <div class="modal-box" role="dialog" aria-modal="true" aria-labelledby="settings-modal-title">
        <h3 id="settings-modal-title"></h3>
        <div id="settings-modal-body"></div>
        <p class="settings-modal-message" id="settings-modal-message" role="alert"></p>
        <div class="settings-modal-actions">
          <button type="button" class="settings-btn settings-btn-ghost" id="settings-modal-cancel" data-i18n="settings.modal.cancel">Batal</button>
          <button type="button" class="settings-btn settings-btn-primary" id="settings-modal-confirm" data-i18n="settings.modal.confirm">Simpan</button>
        </div>
      </div>
    </div>
  `;
}

function buildQueueModalMarkup() {
  return `
    <div class="modal-overlay" id="settings-queue-modal-overlay">
      <div class="modal-box settings-role-modal-box" role="dialog" aria-modal="true" aria-labelledby="settings-queue-modal-title">
        <div class="settings-role-modal-header">
          <div>
            <h3 id="settings-queue-modal-title" data-i18n="settings.queue.modalTitle">Antrean Offline</h3>
            <p class="settings-role-modal-count" id="settings-queue-modal-count">0 pending</p>
          </div>
          <button type="button" class="settings-btn settings-btn-ghost settings-btn-small" id="settings-queue-modal-close" aria-label="Tutup" data-i18n-aria-label="common.close">✕</button>
        </div>
        <p class="settings-sync-message" id="settings-queue-modal-message" role="status" aria-live="polite"></p>
        <ul class="settings-personnel-list" id="settings-queue-modal-list"></ul>
      </div>
    </div>
  `;
}

function buildRoleSummaryCardMarkup(def) {
  return `
    <article class="settings-card settings-summary-card" id="settings-summary-${def.role}">
      <h2>${def.title}</h2>
      <p class="settings-summary-count" id="settings-summary-count-${def.role}">No data loaded</p>
      <button type="button" class="settings-btn settings-btn-primary settings-btn-small" data-role="${def.role}" data-i18n="settings.role.manageButton">Kelola</button>
    </article>
  `;
}

function collectElements(page, fullAccess) {
  const base = {
    fullAccess,
    languageBtns: [...page.querySelectorAll('#settings-language-filter .settings-filter-btn')],
    appearanceBtns: [...page.querySelectorAll('#settings-appearance-filter .settings-filter-btn')],
    license: {
      card: page.querySelector('#settings-license-card'),
      status: page.querySelector('#settings-license-status'),
      lockedBlock: page.querySelector('#settings-license-locked-block'),
      unlockedBlock: page.querySelector('#settings-license-unlocked-block'),
      input: page.querySelector('#settings-license-input'),
      toggleVisibilityBtn: page.querySelector('#settings-license-toggle-visibility'),
      unlockBtn: page.querySelector('#settings-license-unlock-btn'),
      removeBtn: page.querySelector('#settings-license-remove-btn'),
      installedAt: page.querySelector('#settings-license-installed-at'),
      message: page.querySelector('#settings-license-message'),
    },
    modal: {
      overlay: page.querySelector('#settings-modal-overlay'),
      title: page.querySelector('#settings-modal-title'),
      body: page.querySelector('#settings-modal-body'),
      message: page.querySelector('#settings-modal-message'),
      cancelBtn: page.querySelector('#settings-modal-cancel'),
      confirmBtn: page.querySelector('#settings-modal-confirm'),
    },
  };

  if (!fullAccess) return base;

  return {
    ...base,
    syncBtn: page.querySelector('#settings-sync-btn'),
    syncStatus: page.querySelector('#settings-sync-status'),
    syncSource: page.querySelector('#settings-sync-source'),
    syncTime: page.querySelector('#settings-sync-time'),
    syncTotal: page.querySelector('#settings-sync-total'),
    syncMessage: page.querySelector('#settings-sync-message'),
    offlineIndicator: page.querySelector('#settings-offline-indicator'),
    queueCount: page.querySelector('#settings-queue-count'),
    queueReviewBtn: page.querySelector('#settings-queue-review-btn'),
    queueModal: {
      overlay: page.querySelector('#settings-queue-modal-overlay'),
      count: page.querySelector('#settings-queue-modal-count'),
      closeBtn: page.querySelector('#settings-queue-modal-close'),
      message: page.querySelector('#settings-queue-modal-message'),
      list: page.querySelector('#settings-queue-modal-list'),
    },
    summaryCounts: Object.fromEntries(ROLE_DEFS.map((d) => [d.role, page.querySelector(`#settings-summary-count-${d.role}`)])),
    manageBtns: [...page.querySelectorAll('.settings-summary-card [data-role]')],
    roleModal: {
      overlay: page.querySelector('#settings-role-modal-overlay'),
      title: page.querySelector('#settings-role-modal-title'),
      count: page.querySelector('#settings-role-modal-count'),
      closeBtn: page.querySelector('#settings-role-modal-close'),
      addBtn: page.querySelector('#settings-role-modal-add-btn'),
      searchInput: page.querySelector('#settings-role-modal-search'),
      filterBtns: [...page.querySelectorAll('#settings-role-modal-overlay .settings-filter-btn')],
      message: page.querySelector('#settings-role-modal-message'),
      list: page.querySelector('#settings-role-modal-list'),
    },
  };
}

function wireEvents(fullAccess) {
  els.languageBtns.forEach((btn) => btn.addEventListener('click', () => handleLanguageChange(btn.dataset.locale)));
  els.appearanceBtns.forEach((btn) => btn.addEventListener('click', () => handleAppearanceChange(btn.dataset.appearance)));

  els.license.toggleVisibilityBtn.addEventListener('click', handleToggleLicenseVisibility);
  els.license.unlockBtn.addEventListener('click', handleUnlockClick);
  els.license.removeBtn.addEventListener('click', openRemoveLicenseConfirm);
  els.license.input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      handleUnlockClick();
    }
  });

  els.modal.cancelBtn.addEventListener('click', closeModal);
  els.modal.overlay.addEventListener('click', (event) => {
    if (event.target.id === 'settings-modal-overlay') closeModal();
  });

  if (!fullAccess) return;

  els.syncBtn.addEventListener('click', handleSyncClick);
  els.manageBtns.forEach((btn) => btn.addEventListener('click', () => openRoleManagementModal(btn.dataset.role)));

  els.roleModal.closeBtn.addEventListener('click', closeRoleManagementModal);
  els.roleModal.overlay.addEventListener('click', (event) => {
    if (event.target.id === 'settings-role-modal-overlay') closeRoleManagementModal();
  });
  els.roleModal.addBtn.addEventListener('click', () => openAddModal(roleDef(managedRole)));
  els.roleModal.searchInput.addEventListener('input', handleManagementSearchInput);
  els.roleModal.filterBtns.forEach((btn) => btn.addEventListener('click', () => handleManagementFilterChange(btn.dataset.status)));
  els.roleModal.list.addEventListener('click', handleManagementListClick);

  els.queueReviewBtn.addEventListener('click', openQueueReviewModal);
  els.queueModal.closeBtn.addEventListener('click', closeQueueReviewModal);
  els.queueModal.overlay.addEventListener('click', (event) => {
    if (event.target.id === 'settings-queue-modal-overlay') closeQueueReviewModal();
  });
  els.queueModal.list.addEventListener('click', handleQueueModalListClick);
}

function roleDef(role) {
  return ROLE_DEFS.find((d) => d.role === role);
}

/* ============================================================
   LICENSE CARD (V2.3 Phase 8)
============================================================ */
function renderLicenseCard() {
  const fullAccess = hasFullAccess();
  const status = getLicenseStatus();

  els.license.status.textContent = fullAccess ? t('settings.license.status.fullAccess') : t('settings.license.status.monitorOnly');
  els.license.lockedBlock.hidden = fullAccess;
  els.license.unlockedBlock.hidden = !fullAccess;

  if (fullAccess) {
    const installedText = status.installedAt ? formatTimestamp(status.installedAt) : '-';
    els.license.installedAt.textContent = `${installedText} — ${t('settings.license.verifiedLocally')}`;
  }
}

function setLicenseMessage(text, type) {
  els.license.message.textContent = text || '';
  els.license.message.className = `settings-sync-message${type ? ` settings-sync-message--${type}` : ''}`;
}

function handleToggleLicenseVisibility() {
  licenseKeyVisible = !licenseKeyVisible;
  els.license.input.type = licenseKeyVisible ? 'text' : 'password';
  els.license.toggleVisibilityBtn.textContent = licenseKeyVisible ? t('common.hide') : t('common.show');
}

// The entered key is read exactly as typed -- no .trim(), no case
// normalization -- a single leading/trailing space or a case difference
// must fail verification (see license-service.js's own header comment).
// Cleared from the input immediately after the attempt, success or
// failure alike, and never logged, never placed in an exception message,
// never written anywhere except transiently into verifyAndInstallLicense()
// itself.
async function handleUnlockClick() {
  if (licenseVerifyInFlight) return;

  const inputEl = els.license.input;
  const unlockBtn = els.license.unlockBtn;
  const value = inputEl.value;

  if (!value) {
    setLicenseMessage(t('settings.license.invalid'), 'error');
    return;
  }

  licenseVerifyInFlight = true;
  unlockBtn.disabled = true;

  const result = await verifyAndInstallLicense(value);

  inputEl.value = '';
  licenseVerifyInFlight = false;
  unlockBtn.disabled = false;

  if (!result.ok) {
    setLicenseMessage(t('settings.license.invalid'), 'error');
    return;
  }

  // On success, subscribeAccessChange() (registered in initSettingsPage())
  // already rebuilt the entire shell into its FULL_ACCESS state -- via a
  // *synchronous* notify() call inside verifyAndInstallLicense(), which
  // runs (and therefore reassigns the module-level `els`) before the
  // `await` above ever resolves -- so `els` here already refers to the
  // fresh FULL_ACCESS elements, not the ones `inputEl`/`unlockBtn` were
  // captured from above.
  setLicenseMessage(t('settings.license.unlockedMessage'), 'ok');
}

function openRemoveLicenseConfirm() {
  if (!hasFullAccess() || !els.modal.overlay) return;
  hideRoleManagementModal();
  currentModalRecord = null;

  els.modal.title.textContent = t('settings.license.remove');
  els.modal.body.replaceChildren();
  const p = document.createElement('p');
  p.textContent = t('license.removeConfirm');
  els.modal.body.appendChild(p);
  els.modal.message.textContent = '';
  els.modal.confirmBtn.textContent = t('settings.license.remove');
  els.modal.confirmBtn.className = 'settings-btn settings-btn-danger';
  modalConfirmHandler = handleRemoveLicenseConfirm;
  showModal();
}

// removeLicense() synchronously rebuilds the ENTIRE shell (subscribeAccessChange
// in initSettingsPage()) into its MONITOR_ONLY state, destroying this very
// modal's DOM out from under this handler -- the document-level keydown
// listener showModal() attached must be removed explicitly first, since
// the normal closeModal() cleanup path is never reached (there is nothing
// left to "close" once the shell has already been replaced).
function handleRemoveLicenseConfirm() {
  document.removeEventListener('keydown', handleGenericModalKeydown, true);
  modalConfirmHandler = null;
  currentModalRecord = null;
  removeLicense();
}

/* ============================================================
   LICENSE-CARD ATTENTION (route guard / Report action-boundary denial)
============================================================ */
function tryFlushPendingLicenseAttention() {
  if (!pendingLicenseAttention) return;
  if (!page || !page.classList.contains('is-active')) return;
  if (!els || !els.license || !els.license.card) return;

  pendingLicenseAttention = false;
  setLicenseMessage(t('license.fullAccessRequired'), 'warn');
  if (els.license.input) els.license.input.focus();
  if (typeof els.license.card.scrollIntoView === 'function') {
    els.license.card.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
}

/* ============================================================
   MAIN PAGE RENDERING -- summary cards + sync status only (FULL_ACCESS
   only -- never called while MONITOR_ONLY, see renderForAccessTier()).
   The full personnel list for any role only ever renders inside the
   management modal (renderRoleModalList below) -- the main page never
   lists individual personnel rows, per the summary-first design.
============================================================ */
function renderAll() {
  renderSummaryCards();
  renderSyncMeta();
  renderOfflineIndicator();
  renderQueueStatus();
  // Defensive: the Sync button is unreachable while the role modal covers
  // the page, but if renderAll() is ever called while managedRole is
  // still set (e.g. a future caller), keep the open modal's own list in
  // sync with the same fresh snapshot rather than leaving it stale.
  if (managedRole) {
    renderRoleModalHeader();
    renderRoleModalList();
  }
  // Same defensive reasoning for the queue review modal -- if it happens
  // to be open (e.g. a flush completed while the user was reviewing it),
  // keep its list current rather than stale.
  if (els.queueModal.overlay.style.display === 'flex') {
    renderQueueModal();
  }
}

/* ============================================================
   LANGUAGE + APPEARANCE CARDS (V2.3 Phase 7). Two independent segmented
   button groups reusing the existing .settings-filter/.settings-filter-btn
   pattern (Aktif/Nonaktif/Semua) rather than inventing a second control
   style. Language persists+applies through i18n.js's setLocale() (which
   itself persists via app-preferences-service.js and re-translates the
   page); Appearance persists+applies directly through
   app-preferences-service.js's setAppearance() (there is no separate
   "appearance i18n" layer -- the theme is not language-dependent). Both
   are available in BOTH access tiers (V2.3 Phase 8 requirement) -- neither
   handler here checks hasFullAccess() at all, by design.
============================================================ */
function handleLanguageChange(locale) {
  if (!VALID_LOCALES.includes(locale)) return;
  // i18n.js's setLocale() already persists via app-preferences-service.js
  // internally and re-translates the page -- see this file's own
  // onLocaleChange() subscriber (registered in initSettingsPage()) for
  // what runs after this.
  applyLocale(locale);
}

function handleAppearanceChange(appearance) {
  if (!VALID_APPEARANCES.includes(appearance)) return;
  setAppearance(appearance);
  renderPreferenceCards();
}

function renderPreferenceCards() {
  const prefs = getPreferences();
  els.languageBtns.forEach((btn) => btn.classList.toggle('is-active', btn.dataset.locale === prefs.locale));
  els.appearanceBtns.forEach((btn) => btn.classList.toggle('is-active', btn.dataset.appearance === prefs.appearance));
}

/* ============================================================
   OFFLINE INDICATOR + QUEUE STATUS (compact, in the Sync Status card).
   FULL_ACCESS only -- each guards on its own top element so a stray call
   while MONITOR_ONLY (e.g. from a window-level listener registered once,
   see initSettingsPage()) is a safe no-op rather than a crash.
============================================================ */
function renderOfflineIndicator() {
  if (!els.offlineIndicator) return;
  const text = buildOfflineIndicatorText(navigator.onLine);
  if (text) {
    els.offlineIndicator.textContent = text;
    els.offlineIndicator.hidden = false;
  } else {
    els.offlineIndicator.hidden = true;
  }
}

function renderQueueStatus() {
  if (!els.queueCount) return;
  const summary = getWriteQueueSummary();
  els.queueCount.textContent = buildQueueCountText(summary.pending, summary.blocked);
  els.queueReviewBtn.hidden = summary.total === 0;
}

function renderSummaryCards() {
  if (!els.summaryCounts) return;
  const snapshot = getPersonnelDirectorySnapshot();
  ROLE_DEFS.forEach((def) => {
    const countEl = els.summaryCounts[def.role];
    if (snapshot.source === 'none') {
      countEl.textContent = 'No data loaded';
      return;
    }
    const active = getPersonnelByRole(def.role, 'active').length;
    const inactive = getPersonnelByRole(def.role, 'inactive').length;
    countEl.textContent = buildRoleSummaryText(active, inactive);
  });
}

function renderSyncMeta() {
  if (!els.syncSource) return;
  const snapshot = getPersonnelDirectorySnapshot();

  const sourceLabel = snapshot.source === 'remote' ? 'Remote' : snapshot.source === 'cached' ? 'Cached' : 'No data';
  els.syncSource.textContent = sourceLabel;

  els.syncStatus.textContent = snapshot.syncing
    ? 'Menyinkronkan...'
    : snapshot.source === 'remote'
      ? 'Tersinkron'
      : snapshot.source === 'cached'
        ? 'Menampilkan data tersimpan'
        : 'Belum ada data';

  els.syncTime.textContent = snapshot.fetchedAt ? formatTimestamp(snapshot.fetchedAt) : '-';
  els.syncTotal.textContent = String(snapshot.records.length);
}

function setSyncMessage(text, type) {
  els.syncMessage.textContent = text;
  els.syncMessage.className = `settings-sync-message${type ? ` settings-sync-message--${type}` : ''}`;
}

function formatTimestamp(isoString) {
  const date = new Date(isoString);
  if (isNaN(date)) return '-';
  return date.toLocaleString('id-ID', { dateStyle: 'medium', timeStyle: 'short' });
}

function uniqueActiveSamplerOrganizations() {
  const seen = new Set();
  const orgs = [];
  getPersonnelByRole('SAMPLER', 'active').forEach((record) => {
    const key = record.organization.trim().toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    orgs.push(record.organization);
  });
  return orgs;
}

/* ============================================================
   SYNC ACTION
============================================================ */
async function handleSyncClick() {
  if (syncInFlight || writeInFlight) return;
  syncInFlight = true;

  els.syncBtn.disabled = true;
  els.syncBtn.textContent = 'Syncing...';
  setSyncMessage('Menyinkronkan direktori personel...', 'info');
  renderSyncMeta();

  const result = await syncPersonnelDirectory();

  syncInFlight = false;
  els.syncBtn.disabled = false;
  els.syncBtn.textContent = 'Sync';

  renderAll();

  if (result.ok) {
    setSyncMessage(MESSAGES.success(), 'ok');
  } else if (result.snapshot.records.length > 0) {
    setSyncMessage(MESSAGES.cacheFallback(), 'warn');
  } else {
    setSyncMessage(MESSAGES.noCache(), 'error');
  }

  // AUTO FLUSH trigger 3 (optional): a manual Sync is a natural moment to
  // also try flushing anything queued, since the user just proved the
  // device is online. triggerAutoFlush() itself is fully guarded (skips
  // when offline, when nothing is pending, when a flush is already in
  // flight, or when unlicensed), so this is always safe to call
  // unconditionally.
  triggerAutoFlush();
}

/* ============================================================
   OFFLINE PERSONNEL WRITE QUEUE -- auto flush wiring + the queue review
   modal (Settings-facing surface for js/services/personnel-write-queue.js).
   Owns: the 'online' event listener, startup/manual-sync auto-flush,
   and the review modal's list/Retry/Remove actions. Never edits raw JSON,
   never talks to the network directly -- every action here calls into
   personnel-write-queue.js, which in turn only ever calls
   personnel-directory-service.js's existing write functions.
============================================================ */
function handleNetworkOnline() {
  // V2.3 Phase 8: the 'online' event must NOT flush (or even inspect) the
  // queue while unlicensed -- queued items "remain dormant locally". This
  // is UI-side belt; personnel-write-queue.js's flushPersonnelWriteQueue()
  // independently re-checks hasFullAccess() as the actual suspenders.
  if (!hasFullAccess()) return;
  renderOfflineIndicator();
  triggerAutoFlush();
}

// Guarded, safe to call from any trigger point (startup, 'online' event,
// after a manual Sync): does nothing while offline, while a manual
// Add/Edit/Deactivate/Reactivate write is in flight, while a flush is
// already running (personnel-write-queue.js's own single-flight guard
// would no-op anyway, but checking here avoids a redundant renderAll()),
// while unlicensed, or when the queue has no pending items at all.
async function triggerAutoFlush() {
  if (!hasFullAccess() || !navigator.onLine || writeInFlight || isWriteQueueFlushInFlight()) return;
  if (getWriteQueueSummary().pending === 0) return;

  const result = await flushPersonnelWriteQueue();
  renderAll();

  if (result.blocked > 0) {
    setSyncMessage(`${result.succeeded} perubahan offline terkirim, ${result.blocked} memerlukan tinjauan (lihat Pending Changes).`, 'warn');
  } else if (result.succeeded > 0) {
    setSyncMessage(`${result.succeeded} perubahan offline berhasil dikirim ke Personnel Directory.`, 'ok');
  }
  // result.stopped (a network failure mid-flush, or the license guard
  // itself) intentionally leaves the current sync message untouched -- the
  // offline indicator/queue count already reflect the still-pending
  // state, no extra message needed.
}

function openQueueReviewModal() {
  renderQueueModal();
  lastFocusedBeforeModal = document.activeElement;
  els.queueModal.overlay.style.display = 'flex';
  document.addEventListener('keydown', handleQueueModalKeydown, true);
}

function closeQueueReviewModal() {
  els.queueModal.overlay.style.display = 'none';
  document.removeEventListener('keydown', handleQueueModalKeydown, true);
  restoreFocusAfterModal();
}

function handleQueueModalKeydown(event) {
  if (event.key === 'Escape') {
    event.preventDefault();
    closeQueueReviewModal();
  }
}

function renderQueueModal() {
  const snapshot = getWriteQueueSnapshot();
  const records = getPersonnelDirectorySnapshot().records;
  els.queueModal.count.textContent = buildQueueCountText(snapshot.pendingCount, snapshot.blockedCount);

  const hasVersionConflict = snapshot.items.some((item) => item.status === 'blocked' && item.lastErrorCode === 'VERSION_CONFLICT');
  els.queueModal.message.textContent = hasVersionConflict ? buildQueueVersionConflictReviewMessage() : '';
  els.queueModal.message.className = `settings-sync-message${hasVersionConflict ? ' settings-sync-message--warn' : ''}`;

  if (!snapshot.items.length) {
    els.queueModal.list.replaceChildren(emptyStateNode(t('settings.queue.emptyMessage')));
    return;
  }

  els.queueModal.list.replaceChildren(...snapshot.items.map((item) => buildQueueRow(buildQueueItemViewModel(item, records))));
}

function buildQueueRow(vm) {
  const li = document.createElement('li');
  li.className = `settings-personnel-row${vm.status === 'blocked' ? ' settings-personnel-row--inactive' : ''}`;

  const main = document.createElement('div');
  main.className = 'settings-personnel-row__main';

  const nameEl = document.createElement('span');
  nameEl.className = 'settings-personnel-row__name';
  nameEl.textContent = `${vm.actionLabel} — ${vm.name}`;
  main.appendChild(nameEl);

  const badge = document.createElement('span');
  badge.className = `settings-personnel-badge${vm.status === 'blocked' ? ' settings-personnel-badge--inactive' : ''}`;
  badge.textContent = vm.statusText;
  main.appendChild(badge);

  const actions = document.createElement('div');
  actions.className = 'settings-personnel-row__actions';

  if (vm.canRetry) {
    const retryBtn = document.createElement('button');
    retryBtn.type = 'button';
    retryBtn.className = 'settings-btn settings-btn-secondary settings-btn-small';
    retryBtn.textContent = 'Retry';
    retryBtn.dataset.queueAction = 'retry';
    retryBtn.dataset.queueId = vm.queueId;
    actions.appendChild(retryBtn);
  }

  const removeBtn = document.createElement('button');
  removeBtn.type = 'button';
  removeBtn.className = 'settings-btn settings-btn-danger settings-btn-small';
  removeBtn.textContent = 'Hapus';
  removeBtn.dataset.queueAction = 'remove';
  removeBtn.dataset.queueId = vm.queueId;
  actions.appendChild(removeBtn);

  li.appendChild(main);
  li.appendChild(actions);
  return li;
}

function handleQueueModalListClick(event) {
  const btn = event.target.closest('button[data-queue-action]');
  if (!btn) return;
  const { queueAction, queueId } = btn.dataset;

  if (queueAction === 'remove') {
    removeQueueItem(queueId);
    renderQueueModal();
    renderQueueStatus();
  } else if (queueAction === 'retry') {
    if (retryQueueItem(queueId)) {
      renderQueueModal();
      renderQueueStatus();
      triggerAutoFlush();
    }
  }
}

/* ============================================================
   ROLE MANAGEMENT MODAL -- opened by a summary card's "Kelola" button.
   Owns: role title/count, the Add trigger, search, the Aktif/Nonaktif/
   Semua filter, and the personnel rows (Edit/Deactivate/Reactivate).
============================================================ */
function openRoleManagementModal(role) {
  managedRole = role;
  managementStatus = DEFAULT_STATUS;
  managementSearchQuery = '';
  els.roleModal.searchInput.value = '';
  els.roleModal.filterBtns.forEach((btn) => btn.classList.toggle('is-active', btn.dataset.status === DEFAULT_STATUS));
  setManagementMessage('', null);

  renderRoleModalHeader();
  renderRoleModalList();

  lastFocusedBeforeModal = document.activeElement;
  showRoleManagementModal();
}

// Visual show/hide only -- does not touch managedRole/filter/search state,
// so hiding to open Add/Edit/Deactivate and later re-showing restores the
// exact same view the user was looking at (just re-rendered fresh).
function showRoleManagementModal() {
  els.roleModal.overlay.style.display = 'flex';
  document.addEventListener('keydown', handleRoleModalKeydown, true);
}

function hideRoleManagementModal() {
  if (!els.roleModal) return;
  els.roleModal.overlay.style.display = 'none';
  document.removeEventListener('keydown', handleRoleModalKeydown, true);
}

// Full close -- clears managedRole, so renderAll() stops refreshing the
// (now closed) modal's list, and restores focus to whatever opened it.
function closeRoleManagementModal() {
  hideRoleManagementModal();
  managedRole = null;
  restoreFocusAfterModal();
}

function handleRoleModalKeydown(event) {
  if (event.key === 'Escape') {
    event.preventDefault();
    closeRoleManagementModal();
  }
}

function renderRoleModalHeader() {
  const def = roleDef(managedRole);
  const snapshot = getPersonnelDirectorySnapshot();
  els.roleModal.title.textContent = def.title;

  if (snapshot.source === 'none') {
    els.roleModal.count.textContent = 'No data loaded';
    return;
  }
  const active = getPersonnelByRole(managedRole, 'active').length;
  const inactive = getPersonnelByRole(managedRole, 'inactive').length;
  els.roleModal.count.textContent = buildRoleSummaryText(active, inactive);
}

function renderRoleModalList() {
  const def = roleDef(managedRole);
  const snapshot = getPersonnelDirectorySnapshot();

  if (snapshot.source === 'none') {
    els.roleModal.list.replaceChildren(emptyStateNode(t('settings.role.noDirectoryYet')));
    return;
  }

  const byStatus = getPersonnelByRole(managedRole, managementStatus);
  // PIC 3rd's list also benefits from matching organization (jumping to
  // an AWK/ATQ group by typing it) -- SPV/FRM/Independent Sampler search
  // by name only, since their organization is either fixed or IS the name.
  const filtered = filterPersonnelBySearch(byStatus, managementSearchQuery, { matchOrganization: def.role === 'PIC_3RD' });

  if (!filtered.length) {
    els.roleModal.list.replaceChildren(emptyStateNode(buildManagementEmptyMessage(def.title, managementStatus, managementSearchQuery)));
    return;
  }

  if (def.role === 'PIC_3RD') {
    els.roleModal.list.replaceChildren(...buildGroupedRows(filtered));
  } else {
    els.roleModal.list.replaceChildren(...filtered.map(buildPersonRow));
  }
}

function buildManagementEmptyMessage(title, status, query) {
  if (query.trim()) return t('settings.role.emptyNoMatch', { title });
  if (status === 'active') return t('settings.role.emptyNoActive', { title });
  if (status === 'inactive') return t('settings.role.emptyNoInactive', { title });
  return t('settings.role.emptyNone', { title });
}

// getPersonnelByRole() sorts by organization first, so consecutive
// records sharing an organization form one visual group -- no re-sort
// needed here, only a group-boundary scan.
function buildGroupedRows(records) {
  const nodes = [];
  let currentOrgKey = null;
  records.forEach((record) => {
    const orgKey = record.organization.trim().toLowerCase();
    if (orgKey !== currentOrgKey) {
      currentOrgKey = orgKey;
      const header = document.createElement('li');
      header.className = 'settings-personnel-group-header';
      header.textContent = record.organization;
      nodes.push(header);
    }
    nodes.push(buildPersonRow(record));
  });
  return nodes;
}

function buildPersonRow(record) {
  const li = document.createElement('li');
  li.className = `settings-personnel-row${record.active ? '' : ' settings-personnel-row--inactive'}`;

  const main = document.createElement('div');
  main.className = 'settings-personnel-row__main';

  const nameEl = document.createElement('span');
  nameEl.className = 'settings-personnel-row__name';
  nameEl.textContent = record.name;
  main.appendChild(nameEl);

  if (!record.active) {
    const badge = document.createElement('span');
    badge.className = 'settings-personnel-badge settings-personnel-badge--inactive';
    badge.textContent = t('settings.role.inactiveBadge');
    main.appendChild(badge);
  }

  const actions = document.createElement('div');
  actions.className = 'settings-personnel-row__actions';

  const editBtn = document.createElement('button');
  editBtn.type = 'button';
  editBtn.className = 'settings-btn settings-btn-ghost settings-btn-small';
  editBtn.textContent = 'Edit';
  editBtn.dataset.action = 'edit';
  editBtn.dataset.id = record.id;
  actions.appendChild(editBtn);

  const toggleBtn = document.createElement('button');
  toggleBtn.type = 'button';
  toggleBtn.className = record.active
    ? 'settings-btn settings-btn-danger settings-btn-small'
    : 'settings-btn settings-btn-secondary settings-btn-small';
  toggleBtn.textContent = record.active ? t('common.deactivate') : t('common.reactivate');
  toggleBtn.dataset.action = record.active ? 'deactivate' : 'reactivate';
  toggleBtn.dataset.id = record.id;
  actions.appendChild(toggleBtn);

  li.appendChild(main);
  li.appendChild(actions);
  return li;
}

function emptyStateNode(message) {
  const li = document.createElement('li');
  li.className = 'settings-personnel-empty';
  li.textContent = message;
  return li;
}

function handleManagementListClick(event) {
  const btn = event.target.closest('button[data-action]');
  if (!btn) return;
  const { action, id } = btn.dataset;
  const record = getPersonnelDirectorySnapshot().records.find((r) => r.id === id);
  if (!record) return;

  if (action === 'edit') openEditModal(record);
  else if (action === 'deactivate') openDeactivateConfirm(record);
  else if (action === 'reactivate') handleReactivate(record);
}

function handleManagementFilterChange(status) {
  if (status === managementStatus) return;
  managementStatus = status;
  els.roleModal.filterBtns.forEach((btn) => btn.classList.toggle('is-active', btn.dataset.status === status));
  renderRoleModalList();
}

function handleManagementSearchInput() {
  managementSearchQuery = els.roleModal.searchInput.value;
  renderRoleModalList();
}

function setManagementMessage(text, type) {
  els.roleModal.message.textContent = text;
  els.roleModal.message.className = `settings-sync-message${type ? ` settings-sync-message--${type}` : ''}`;
}

/* ============================================================
   ADD / EDIT / DEACTIVATE-CONFIRM (generic modal, reused for all three,
   and for Remove License -- see openRemoveLicenseConfirm() above).
   Always opened FROM the role management modal (hides it) and always
   returns to it on close (Save success, Cancel, Escape, or backdrop
   click) -- see closeModal()'s reopen logic below. Reactivate is the one
   action that does NOT use this modal (no confirmation, per the
   architecture doc) -- it runs directly from handleManagementListClick().
============================================================ */
function openAddModal(def) {
  hideRoleManagementModal();

  els.modal.title.textContent = t('settings.modal.addTitle', { title: def.title });
  els.modal.body.innerHTML = buildPersonnelFormMarkup(def, 'add');
  populatePersonnelForm(null, def, 'add');
  els.modal.message.textContent = '';
  els.modal.confirmBtn.textContent = t('common.add');
  els.modal.confirmBtn.className = 'settings-btn settings-btn-primary';
  modalConfirmHandler = () => handleAddSave(def);
  showModal();
}

function openEditModal(record) {
  hideRoleManagementModal();
  currentModalRecord = record;
  const def = roleDef(record.role_type);

  els.modal.title.textContent = t('settings.modal.editTitle', { title: def.title });
  els.modal.body.innerHTML = buildPersonnelFormMarkup(def, 'edit');
  populatePersonnelForm(record, def, 'edit');
  els.modal.message.textContent = '';
  els.modal.confirmBtn.textContent = t('common.save');
  els.modal.confirmBtn.className = 'settings-btn settings-btn-primary';
  modalConfirmHandler = () => handleEditSave(def);
  showModal();
}

function openDeactivateConfirm(record) {
  hideRoleManagementModal();
  currentModalRecord = record;

  els.modal.title.textContent = t('settings.modal.deactivateTitle');
  els.modal.body.replaceChildren();
  const p = document.createElement('p');
  p.textContent = t('settings.modal.deactivateConfirm', { name: record.name });
  els.modal.body.appendChild(p);
  els.modal.message.textContent = '';
  els.modal.confirmBtn.textContent = t('common.deactivate');
  els.modal.confirmBtn.className = 'settings-btn settings-btn-danger';
  modalConfirmHandler = handleDeactivateConfirm;
  showModal();
}

// Shared Add/Edit form shape: Name + Organization (per-role rule, see
// ROLE_DEFS's own header comment), plus a read-only Role/ID/Version block
// in Edit mode only (nothing to show yet for a not-yet-created record).
function buildPersonnelFormMarkup(def, mode) {
  const orgFieldMarkup = def.orgFixed
    ? `<div class="settings-form-group">
         <label>${t('settings.form.organizationLabel')}</label>
         <input class="settings-input" name="organization" disabled />
       </div>`
    : def.orgMode === 'sampler-select'
      ? `<div class="settings-form-group">
           <label for="settings-form-organization">${t('settings.form.organizationSamplerLabel')}</label>
           <select class="settings-input" id="settings-form-organization" name="organization"></select>
         </div>`
      : `<div class="settings-form-group">
           <label for="settings-form-organization">${t('settings.form.organizationLabel')}</label>
           <input class="settings-input" id="settings-form-organization" name="organization" />
         </div>`;

  const readonlyBlock = mode === 'edit'
    ? `<div class="settings-form-readonly">
         <div><span>Role</span><strong>${def.title}</strong></div>
         <div><span>ID</span><code id="settings-form-id"></code></div>
         <div><span>${t('settings.form.versionLabel')}</span><span id="settings-form-version"></span></div>
       </div>`
    : '';

  return `
    ${readonlyBlock}
    <div class="settings-form-group">
      <label for="settings-form-name">${t('settings.form.nameLabel')}</label>
      <input class="settings-input" id="settings-form-name" name="name" required />
    </div>
    ${orgFieldMarkup}
  `;
}

function populatePersonnelForm(record, def, mode) {
  if (mode === 'edit') {
    els.modal.body.querySelector('#settings-form-id').textContent = record.id;
    els.modal.body.querySelector('#settings-form-version').textContent = String(record.version);
  }
  els.modal.body.querySelector('[name="name"]').value = record ? record.name : '';

  const orgField = els.modal.body.querySelector('[name="organization"]');
  if (def.orgFixed) {
    orgField.value = def.orgFixed;
    return;
  }

  if (def.orgMode !== 'sampler-select') {
    orgField.value = record ? record.organization : '';
    return;
  }

  const orgs = uniqueActiveSamplerOrganizations();
  orgField.replaceChildren(...orgs.map((org) => {
    const opt = document.createElement('option');
    opt.value = org;
    opt.textContent = org;
    return opt;
  }));

  if (mode === 'add') {
    const placeholder = document.createElement('option');
    placeholder.value = '';
    placeholder.textContent = orgs.length ? t('settings.form.pickSamplerPlaceholder') : t('settings.form.noActiveSamplerPlaceholder');
    placeholder.disabled = true;
    placeholder.selected = true;
    orgField.insertBefore(placeholder, orgField.firstChild);
    orgField.value = '';
    orgField.disabled = orgs.length === 0;
    return;
  }

  // Edit mode: matched case-insensitively, then selected using the
  // ACTIVE sampler's own stored casing (not record.organization's) -- a
  // <select>'s value assignment is an exact string match, so if the two
  // only differ in casing, using record.organization's casing here would
  // silently fail to select anything.
  const matchedActiveOrg = orgs.find((org) => org.trim().toLowerCase() === record.organization.trim().toLowerCase());
  if (!matchedActiveOrg) {
    const opt = document.createElement('option');
    opt.value = record.organization;
    opt.textContent = t('settings.form.inactiveOrgSuffix', { organization: record.organization });
    orgField.appendChild(opt);
  }
  orgField.value = matchedActiveOrg || record.organization;
}

async function handleAddSave(def) {
  if (writeInFlight) return;

  const name = els.modal.body.querySelector('[name="name"]').value.trim();
  if (!name) {
    els.modal.message.textContent = t('settings.form.nameRequired');
    els.modal.message.className = 'settings-modal-message settings-modal-message--error';
    return;
  }

  const organization = def.orgFixed ? def.orgFixed : els.modal.body.querySelector('[name="organization"]').value.trim();
  if (!organization) {
    els.modal.message.textContent = def.orgMode === 'sampler-select'
      ? t('settings.form.pickActiveSamplerFirst')
      : t('settings.form.organizationRequired');
    els.modal.message.className = 'settings-modal-message settings-modal-message--error';
    return;
  }

  writeInFlight = true;
  setModalBusy(true);

  // OFFLINE UI BEHAVIOR / ONLINE UI BEHAVIOR: while offline, skip the
  // network attempt entirely and enqueue directly -- the online path
  // (write, then fall back to the queue only on a genuine transport
  // failure) stays the preferred flow whenever the device IS online.
  if (!navigator.onLine) {
    enqueueAddReportPersonnel({ role_type: def.role, name, organization });
    writeInFlight = false;
    setModalBusy(false);
    closeModal();
    renderAll();
    setManagementMessage(buildQueueOfflineSavedMessage(), 'info');
    return;
  }

  const result = await addReportPersonnel({ role_type: def.role, name, organization });

  writeInFlight = false;
  setModalBusy(false);

  if (result.ok) {
    closeModal();
    renderAll();
    setManagementMessage(t('settings.role.addedMessage', { name }), 'ok');
  } else if (isNetworkFailure(result.error)) {
    enqueueAddReportPersonnel({ role_type: def.role, name, organization });
    closeModal();
    renderAll();
    setManagementMessage(buildQueueOfflineSavedMessage(), 'info');
  } else {
    els.modal.message.textContent = describeWriteError(result.error);
    els.modal.message.className = 'settings-modal-message settings-modal-message--error';
  }
}

async function handleEditSave(def) {
  if (writeInFlight) return;

  const name = els.modal.body.querySelector('[name="name"]').value.trim();
  if (!name) {
    els.modal.message.textContent = t('settings.form.nameRequired');
    els.modal.message.className = 'settings-modal-message settings-modal-message--error';
    return;
  }

  const organization = def.orgFixed ? def.orgFixed : els.modal.body.querySelector('[name="organization"]').value.trim();
  if (!organization) {
    els.modal.message.textContent = t('settings.form.organizationRequired');
    els.modal.message.className = 'settings-modal-message settings-modal-message--error';
    return;
  }

  writeInFlight = true;
  setModalBusy(true);

  const updatePayload = {
    id: currentModalRecord.id,
    name,
    organization,
    expected_version: currentModalRecord.version,
  };

  if (!navigator.onLine) {
    enqueueUpdateReportPersonnel(updatePayload);
    writeInFlight = false;
    setModalBusy(false);
    closeModal();
    renderAll();
    setManagementMessage(buildQueueOfflineSavedMessage(), 'info');
    return;
  }

  const result = await updateReportPersonnel(updatePayload);

  writeInFlight = false;
  setModalBusy(false);

  if (result.ok) {
    closeModal();
    renderAll();
    setManagementMessage(t('settings.role.updatedMessage', { name }), 'ok');
  } else if (isNetworkFailure(result.error)) {
    enqueueUpdateReportPersonnel(updatePayload);
    closeModal();
    renderAll();
    setManagementMessage(buildQueueOfflineSavedMessage(), 'info');
  } else {
    els.modal.message.textContent = describeWriteError(result.error);
    els.modal.message.className = 'settings-modal-message settings-modal-message--error';
  }
}

async function handleDeactivateConfirm() {
  if (writeInFlight) return;

  writeInFlight = true;
  setModalBusy(true);

  const activePayload = {
    id: currentModalRecord.id,
    active: false,
    expected_version: currentModalRecord.version,
  };
  const name = currentModalRecord.name;

  if (!navigator.onLine) {
    enqueueSetReportPersonnelActive(activePayload);
    writeInFlight = false;
    setModalBusy(false);
    closeModal();
    renderAll();
    setManagementMessage(buildQueueOfflineSavedMessage(), 'info');
    return;
  }

  const result = await setReportPersonnelActive(activePayload);

  writeInFlight = false;
  setModalBusy(false);

  if (result.ok) {
    closeModal();
    renderAll();
    setManagementMessage(t('settings.role.deactivatedMessage', { name }), 'ok');
  } else if (isNetworkFailure(result.error)) {
    enqueueSetReportPersonnelActive(activePayload);
    closeModal();
    renderAll();
    setManagementMessage(buildQueueOfflineSavedMessage(), 'info');
  } else {
    els.modal.message.textContent = describeWriteError(result.error);
    els.modal.message.className = 'settings-modal-message settings-modal-message--error';
  }
}

// No confirmation dialog for reactivation, per the architecture doc.
// Unlike Add/Edit/Deactivate, this never hides the role modal -- it runs
// directly from a row click, and feedback is shown in the role modal's
// own message area (not the page-level sync message, which is
// unreachable behind the modal backdrop anyway).
async function handleReactivate(record) {
  if (writeInFlight || syncInFlight) return;

  writeInFlight = true;

  const activePayload = { id: record.id, active: true, expected_version: record.version };

  if (!navigator.onLine) {
    enqueueSetReportPersonnelActive(activePayload);
    writeInFlight = false;
    renderAll();
    setManagementMessage(buildQueueOfflineSavedMessage(), 'info');
    return;
  }

  setManagementMessage(t('settings.role.reactivatingMessage', { name: record.name }), 'info');

  const result = await setReportPersonnelActive(activePayload);

  writeInFlight = false;
  renderAll();

  if (result.ok) {
    setManagementMessage(t('settings.role.reactivatedMessage', { name: record.name }), 'ok');
  } else if (isNetworkFailure(result.error)) {
    enqueueSetReportPersonnelActive(activePayload);
    setManagementMessage(buildQueueOfflineSavedMessage(), 'info');
  } else {
    setManagementMessage(describeWriteError(result.error), 'error');
  }
}

/* ============================================================
   GENERIC MODAL SHELL (Add / Edit / Deactivate-confirm / Remove-License-
   confirm)
============================================================ */
// Matches the app's existing contractor modal convention (index.html's
// #contractorModalOverlay): toggled via style.display, not a class or the
// [hidden] attribute.
function showModal() {
  els.modal.overlay.style.display = 'flex';
  els.modal.confirmBtn.onclick = () => modalConfirmHandler && modalConfirmHandler();
  document.addEventListener('keydown', handleGenericModalKeydown, true);
}

// Escape and the Cancel button both route here: closing without saving,
// which -- since this modal is only ever opened from the role management
// modal or the License card -- re-shows the role management modal if one
// was open, or simply restores focus otherwise (Remove License's own
// success path never reaches this function at all -- see
// handleRemoveLicenseConfirm()'s own header comment).
function closeModal() {
  els.modal.overlay.style.display = 'none';
  els.modal.confirmBtn.onclick = null;
  document.removeEventListener('keydown', handleGenericModalKeydown, true);
  currentModalRecord = null;
  modalConfirmHandler = null;

  if (managedRole && els.roleModal) {
    renderRoleModalHeader();
    renderRoleModalList();
    showRoleManagementModal();
    els.roleModal.searchInput.focus();
  } else {
    restoreFocusAfterModal();
  }
}

function handleGenericModalKeydown(event) {
  if (event.key === 'Escape') {
    event.preventDefault();
    closeModal();
  }
}

function setModalBusy(busy) {
  els.modal.body.querySelectorAll('input, select').forEach((el) => {
    el.disabled = busy;
  });
  els.modal.confirmBtn.disabled = busy;
  els.modal.cancelBtn.disabled = busy;
}

function restoreFocusAfterModal() {
  if (lastFocusedBeforeModal && typeof lastFocusedBeforeModal.focus === 'function') {
    lastFocusedBeforeModal.focus();
  }
  lastFocusedBeforeModal = null;
}
