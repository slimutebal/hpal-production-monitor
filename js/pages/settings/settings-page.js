// Settings page (V2.3 Phase 4 -- Personnel Directory online write
// management; UI refinement -- summary-first main view + per-role
// management modal). Extends the Phase 2-3 read-only Personnel Directory
// view -- see docs/V2.3_AUTO_WEEK_AND_PERSONNEL_DIRECTORY_ARCHITECTURE.md
// sections 16-20 -- with Add / Edit / Deactivate / Reactivate for all
// four role types, and an Aktif/Nonaktif/Semua filter so inactive
// (deactivated, not deleted) records can still be reviewed.
//
// UI refinement: the main page used to render all four roles' full
// personnel lists inline (Add form + every row + Edit/Deactivate), which
// made the page very tall on mobile. It now shows one compact summary
// card per role (title, active/inactive counts, a "Kelola" button); the
// full list, search, status filter, and Add/Edit/Deactivate/Reactivate
// actions all live inside a per-role management modal opened by "Kelola".
// This is a UI-only change -- personnel write semantics, the API
// contract, and the write-then-verify flow are all untouched (see
// personnel-directory-service.js).
//
// Two modal layers, never shown simultaneously: the role MANAGEMENT modal
// (list/search/filter) and the generic add/edit/deactivate-confirm modal
// (reused as-is from the pre-refinement design). Opening Add/Edit/
// Deactivate from the management modal hides it (keeping its role/
// filter/search state) and shows the generic modal; closing the generic
// modal (Save success, Cancel, or Escape) re-shows the management modal,
// freshly re-rendered from the current authoritative snapshot -- this is
// what "role-management modal rerenders after a successful write" means
// in practice, and it works out of the box because every render function
// here always reads live from personnel-directory-service.js's snapshot,
// never a locally cached copy.
//
// There is no offline write queue yet (Phase 5, explicitly deferred) --
// every write requires connectivity and fails with a clear message rather
// than silently queuing. There are no user accounts: every write is
// attributed to the fixed audit-source label the service module owns
// (personnel-directory-service.js's `OWNER_WEB_APP` constant), never a
// real identity.
//
// Like report-page.js, the DOM is built once into #page-settings and never
// rebuilt on route change, so Settings -> Report -> Settings navigation
// never re-runs initSettingsPage(), never duplicates a listener, and never
// clears a previously loaded cache. Every write flow re-syncs from the
// server on success (never trusts its own write response as authoritative
// for the cache) and then re-renders from that fresh snapshot.
import {
  loadCachedPersonnelDirectory,
  syncPersonnelDirectory,
  getPersonnelDirectorySnapshot,
  getPersonnelByRole,
  addReportPersonnel,
  updateReportPersonnel,
  setReportPersonnelActive,
} from '../../services/personnel-directory-service.js';
import { buildRoleSummaryText, filterPersonnelBySearch } from './settings-personnel.js';

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

const MESSAGES = {
  success: 'Personnel directory synchronized.',
  cacheFallback: 'Synchronization failed. Showing the last saved personnel directory.',
  noCache: 'Personnel directory could not be loaded. Check the connection and try again.',
};

// Server error `code` -> user-facing message. VERSION_CONFLICT's message
// is the exact literal the architecture doc requires, never a
// server-supplied variant.
function describeWriteError(error) {
  if (!error) return 'Terjadi kesalahan. Coba lagi.';
  if (error.code === 'VERSION_CONFLICT') return 'Data sudah berubah di server. Sinkronkan ulang sebelum mencoba lagi.';
  if (error.code === 'DUPLICATE_PERSONNEL') return 'Personel dengan role, nama, dan organisasi yang sama sudah aktif di direktori.';
  if (error.code === 'NOT_FOUND') return 'Data tidak ditemukan di server. Sinkronkan ulang direktori.';
  if (error.code === 'VALIDATION_ERROR') return error.message || 'Data tidak valid.';
  if (error.code === 'NETWORK_UNAVAILABLE' || error.code === 'NETWORK_ERROR') return 'Tidak ada koneksi jaringan. Coba lagi saat online.';
  // The server acknowledged the write, but the record it claims to have
  // written could not be independently confirmed in the authoritative
  // resync -- never presented as success (see personnel-directory-service.js's
  // writeAndResync()/verifyRecord*()).
  if (error.code === 'WRITE_NOT_VISIBLE_AFTER_SYNC') {
    return 'Server menerima permintaan, tetapi perubahan belum dapat diverifikasi dari Personnel Directory. Sinkronkan ulang dan periksa Google Sheet.';
  }
  return error.message || 'Terjadi kesalahan saat menyimpan.';
}

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

// Generic add/edit/deactivate-confirm modal state.
let currentModalRecord = null;
let modalConfirmHandler = null;

export function initSettingsPage() {
  const page = document.getElementById('page-settings');
  if (!page) return;

  page.innerHTML = buildMarkup();
  els = collectElements(page);

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

  els.modal.cancelBtn.addEventListener('click', closeModal);
  els.modal.overlay.addEventListener('click', (event) => {
    if (event.target.id === 'settings-modal-overlay') closeModal();
  });

  loadCachedPersonnelDirectory();
  renderAll();
}

/* ============================================================
   SHELL MARKUP
============================================================ */
function buildMarkup() {
  return `
    <div class="settings-shell">
      <header class="settings-header">
        <div class="settings-eyebrow">SETTINGS</div>
        <h1 class="settings-title">Personnel Directory</h1>
        <p class="settings-subtitle">Direktori SPV SCM, FRM SCM, Independent Sampler, dan PIC 3rd -- disinkron dari Google Sheet. Tekan Kelola pada tiap role untuk menambah, edit, nonaktifkan, atau aktifkan kembali personel.</p>
      </header>

      <section class="settings-card settings-sync-card" aria-labelledby="settings-sync-title">
        <h2 id="settings-sync-title">Sync Status</h2>
        <dl class="settings-sync-meta">
          <div class="settings-sync-meta__row">
            <dt>Status</dt>
            <dd id="settings-sync-status">-</dd>
          </div>
          <div class="settings-sync-meta__row">
            <dt>Sumber</dt>
            <dd id="settings-sync-source">-</dd>
          </div>
          <div class="settings-sync-meta__row">
            <dt>Terakhir sinkron</dt>
            <dd id="settings-sync-time">-</dd>
          </div>
          <div class="settings-sync-meta__row">
            <dt>Total personel</dt>
            <dd id="settings-sync-total">0</dd>
          </div>
        </dl>
        <div class="settings-btn-row">
          <button type="button" class="settings-btn settings-btn-primary" id="settings-sync-btn">Sync</button>
        </div>
        <p class="settings-sync-message" id="settings-sync-message" role="status" aria-live="polite">Tekan Sync untuk memuat direktori personel.</p>
      </section>

      <section class="settings-personnel-grid">
        ${ROLE_DEFS.map((def) => buildRoleSummaryCardMarkup(def)).join('')}
      </section>
    </div>

    <div class="modal-overlay" id="settings-role-modal-overlay">
      <div class="modal-box settings-role-modal-box" role="dialog" aria-modal="true" aria-labelledby="settings-role-modal-title">
        <div class="settings-role-modal-header">
          <div>
            <h3 id="settings-role-modal-title">Role</h3>
            <p class="settings-role-modal-count" id="settings-role-modal-count">0 aktif</p>
          </div>
          <button type="button" class="settings-btn settings-btn-ghost settings-btn-small" id="settings-role-modal-close" aria-label="Tutup">✕</button>
        </div>

        <div class="settings-btn-row">
          <button type="button" class="settings-btn settings-btn-primary" id="settings-role-modal-add-btn">+ Tambah Personel</button>
        </div>

        <input type="text" class="settings-input" id="settings-role-modal-search" placeholder="Cari nama..." autocomplete="off">

        <div class="settings-filter" role="group" aria-label="Filter status personel">
          <button type="button" class="settings-filter-btn is-active" data-status="active">Aktif</button>
          <button type="button" class="settings-filter-btn" data-status="inactive">Nonaktif</button>
          <button type="button" class="settings-filter-btn" data-status="all">Semua</button>
        </div>

        <p class="settings-sync-message" id="settings-role-modal-message" role="status" aria-live="polite"></p>

        <ul class="settings-personnel-list" id="settings-role-modal-list"></ul>
      </div>
    </div>

    <div class="modal-overlay" id="settings-modal-overlay">
      <div class="modal-box" role="dialog" aria-modal="true" aria-labelledby="settings-modal-title">
        <h3 id="settings-modal-title"></h3>
        <div id="settings-modal-body"></div>
        <p class="settings-modal-message" id="settings-modal-message" role="alert"></p>
        <div class="settings-modal-actions">
          <button type="button" class="settings-btn settings-btn-ghost" id="settings-modal-cancel">Batal</button>
          <button type="button" class="settings-btn settings-btn-primary" id="settings-modal-confirm">Simpan</button>
        </div>
      </div>
    </div>
  `;
}

function buildRoleSummaryCardMarkup(def) {
  return `
    <article class="settings-card settings-summary-card" id="settings-summary-${def.role}">
      <h2>${def.title}</h2>
      <p class="settings-summary-count" id="settings-summary-count-${def.role}">No data loaded</p>
      <button type="button" class="settings-btn settings-btn-primary settings-btn-small" data-role="${def.role}">Kelola</button>
    </article>
  `;
}

function collectElements(page) {
  return {
    syncBtn: page.querySelector('#settings-sync-btn'),
    syncStatus: page.querySelector('#settings-sync-status'),
    syncSource: page.querySelector('#settings-sync-source'),
    syncTime: page.querySelector('#settings-sync-time'),
    syncTotal: page.querySelector('#settings-sync-total'),
    syncMessage: page.querySelector('#settings-sync-message'),
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
    modal: {
      overlay: page.querySelector('#settings-modal-overlay'),
      title: page.querySelector('#settings-modal-title'),
      body: page.querySelector('#settings-modal-body'),
      message: page.querySelector('#settings-modal-message'),
      cancelBtn: page.querySelector('#settings-modal-cancel'),
      confirmBtn: page.querySelector('#settings-modal-confirm'),
    },
  };
}

function roleDef(role) {
  return ROLE_DEFS.find((d) => d.role === role);
}

/* ============================================================
   MAIN PAGE RENDERING -- summary cards + sync status only. The full
   personnel list for any role only ever renders inside the management
   modal (renderRoleModalList below) -- the main page never lists
   individual personnel rows, per the summary-first design.
============================================================ */
function renderAll() {
  renderSummaryCards();
  renderSyncMeta();
  // Defensive: the Sync button is unreachable while the role modal covers
  // the page, but if renderAll() is ever called while managedRole is
  // still set (e.g. a future caller), keep the open modal's own list in
  // sync with the same fresh snapshot rather than leaving it stale.
  if (managedRole) {
    renderRoleModalHeader();
    renderRoleModalList();
  }
}

function renderSummaryCards() {
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
    setSyncMessage(MESSAGES.success, 'ok');
  } else if (result.snapshot.records.length > 0) {
    setSyncMessage(MESSAGES.cacheFallback, 'warn');
  } else {
    setSyncMessage(MESSAGES.noCache, 'error');
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
    els.roleModal.list.replaceChildren(emptyStateNode('Belum ada data. Sinkronkan direktori terlebih dahulu.'));
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
  if (query.trim()) return `Tidak ada ${title} yang cocok dengan pencarian.`;
  if (status === 'active') return `Tidak ada ${title} aktif.`;
  if (status === 'inactive') return `Tidak ada ${title} nonaktif.`;
  return `Belum ada ${title}.`;
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
    badge.textContent = 'Nonaktif';
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
  toggleBtn.textContent = record.active ? 'Nonaktifkan' : 'Aktifkan';
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
   ADD / EDIT / DEACTIVATE-CONFIRM (generic modal, reused for all three)
   Always opened FROM the role management modal (hides it) and always
   returns to it on close (Save success, Cancel, Escape, or backdrop
   click) -- see closeModal()'s reopen logic below. Reactivate is the one
   action that does NOT use this modal (no confirmation, per the
   architecture doc) -- it runs directly from handleManagementListClick().
============================================================ */
function openAddModal(def) {
  hideRoleManagementModal();

  els.modal.title.textContent = `Tambah ${def.title}`;
  els.modal.body.innerHTML = buildPersonnelFormMarkup(def, 'add');
  populatePersonnelForm(null, def, 'add');
  els.modal.message.textContent = '';
  els.modal.confirmBtn.textContent = 'Tambah';
  els.modal.confirmBtn.className = 'settings-btn settings-btn-primary';
  modalConfirmHandler = () => handleAddSave(def);
  showModal();
}

function openEditModal(record) {
  hideRoleManagementModal();
  currentModalRecord = record;
  const def = roleDef(record.role_type);

  els.modal.title.textContent = `Edit ${def.title}`;
  els.modal.body.innerHTML = buildPersonnelFormMarkup(def, 'edit');
  populatePersonnelForm(record, def, 'edit');
  els.modal.message.textContent = '';
  els.modal.confirmBtn.textContent = 'Simpan';
  els.modal.confirmBtn.className = 'settings-btn settings-btn-primary';
  modalConfirmHandler = () => handleEditSave(def);
  showModal();
}

function openDeactivateConfirm(record) {
  hideRoleManagementModal();
  currentModalRecord = record;

  els.modal.title.textContent = 'Nonaktifkan Personel';
  els.modal.body.replaceChildren();
  const p = document.createElement('p');
  p.textContent = `Nonaktifkan ${record.name} dari Personnel Directory?`;
  els.modal.body.appendChild(p);
  els.modal.message.textContent = '';
  els.modal.confirmBtn.textContent = 'Nonaktifkan';
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
         <label>Organisasi</label>
         <input class="settings-input" name="organization" disabled />
       </div>`
    : def.orgMode === 'sampler-select'
      ? `<div class="settings-form-group">
           <label for="settings-form-organization">Organisasi (Sampler)</label>
           <select class="settings-input" id="settings-form-organization" name="organization"></select>
         </div>`
      : `<div class="settings-form-group">
           <label for="settings-form-organization">Organisasi</label>
           <input class="settings-input" id="settings-form-organization" name="organization" />
         </div>`;

  const readonlyBlock = mode === 'edit'
    ? `<div class="settings-form-readonly">
         <div><span>Role</span><strong>${def.title}</strong></div>
         <div><span>ID</span><code id="settings-form-id"></code></div>
         <div><span>Versi</span><span id="settings-form-version"></span></div>
       </div>`
    : '';

  return `
    ${readonlyBlock}
    <div class="settings-form-group">
      <label for="settings-form-name">Nama</label>
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
    placeholder.textContent = orgs.length ? 'Pilih Sampler' : 'Tidak ada Sampler aktif';
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
    opt.textContent = `${record.organization} (tidak aktif)`;
    orgField.appendChild(opt);
  }
  orgField.value = matchedActiveOrg || record.organization;
}

async function handleAddSave(def) {
  if (writeInFlight) return;

  const name = els.modal.body.querySelector('[name="name"]').value.trim();
  if (!name) {
    els.modal.message.textContent = 'Nama wajib diisi.';
    els.modal.message.className = 'settings-modal-message settings-modal-message--error';
    return;
  }

  const organization = def.orgFixed ? def.orgFixed : els.modal.body.querySelector('[name="organization"]').value.trim();
  if (!organization) {
    els.modal.message.textContent = def.orgMode === 'sampler-select'
      ? 'Pilih Independent Sampler aktif terlebih dahulu.'
      : 'Organisasi wajib diisi.';
    els.modal.message.className = 'settings-modal-message settings-modal-message--error';
    return;
  }

  writeInFlight = true;
  setModalBusy(true);

  const result = await addReportPersonnel({ role_type: def.role, name, organization });

  writeInFlight = false;
  setModalBusy(false);

  if (result.ok) {
    closeModal();
    renderAll();
    setManagementMessage(`${name} ditambahkan.`, 'ok');
  } else {
    els.modal.message.textContent = describeWriteError(result.error);
    els.modal.message.className = 'settings-modal-message settings-modal-message--error';
  }
}

async function handleEditSave(def) {
  if (writeInFlight) return;

  const name = els.modal.body.querySelector('[name="name"]').value.trim();
  if (!name) {
    els.modal.message.textContent = 'Nama wajib diisi.';
    els.modal.message.className = 'settings-modal-message settings-modal-message--error';
    return;
  }

  const organization = def.orgFixed ? def.orgFixed : els.modal.body.querySelector('[name="organization"]').value.trim();
  if (!organization) {
    els.modal.message.textContent = 'Organisasi wajib diisi.';
    els.modal.message.className = 'settings-modal-message settings-modal-message--error';
    return;
  }

  writeInFlight = true;
  setModalBusy(true);

  const result = await updateReportPersonnel({
    id: currentModalRecord.id,
    name,
    organization,
    expected_version: currentModalRecord.version,
  });

  writeInFlight = false;
  setModalBusy(false);

  if (result.ok) {
    closeModal();
    renderAll();
    setManagementMessage(`${name} diperbarui.`, 'ok');
  } else {
    els.modal.message.textContent = describeWriteError(result.error);
    els.modal.message.className = 'settings-modal-message settings-modal-message--error';
  }
}

async function handleDeactivateConfirm() {
  if (writeInFlight) return;

  writeInFlight = true;
  setModalBusy(true);

  const result = await setReportPersonnelActive({
    id: currentModalRecord.id,
    active: false,
    expected_version: currentModalRecord.version,
  });

  writeInFlight = false;
  setModalBusy(false);

  if (result.ok) {
    const name = currentModalRecord.name;
    closeModal();
    renderAll();
    setManagementMessage(`${name} dinonaktifkan.`, 'ok');
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
  setManagementMessage(`Mengaktifkan kembali ${record.name}...`, 'info');

  const result = await setReportPersonnelActive({ id: record.id, active: true, expected_version: record.version });

  writeInFlight = false;
  renderAll();

  if (result.ok) {
    setManagementMessage(`${record.name} diaktifkan kembali.`, 'ok');
  } else {
    setManagementMessage(describeWriteError(result.error), 'error');
  }
}

/* ============================================================
   GENERIC MODAL SHELL (Add / Edit / Deactivate-confirm)
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
// modal -- re-shows that modal rather than returning to the bare page.
function closeModal() {
  els.modal.overlay.style.display = 'none';
  els.modal.confirmBtn.onclick = null;
  document.removeEventListener('keydown', handleGenericModalKeydown, true);
  currentModalRecord = null;
  modalConfirmHandler = null;

  if (managedRole) {
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
