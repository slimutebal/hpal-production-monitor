// Settings page (V2.3 Phase 2-3). Replaces the V2.0 static placeholder with
// a read-only Personnel Directory view -- see
// docs/V2.3_AUTO_WEEK_AND_PERSONNEL_DIRECTORY_ARCHITECTURE.md sections 16-20.
//
// Scope for this phase: read + Sync only. There is deliberately no Add,
// Edit, Deactivate, or Reactivate control anywhere below -- personnel
// management is a later phase, gated behind the license mechanism that does
// not exist yet. Building operational controls that call nothing would be
// worse than not having them.
//
// Like report-page.js, the DOM is built once into #page-settings and never
// rebuilt on route change, so Settings -> Report -> Settings navigation
// never re-runs initSettingsPage(), never duplicates the Sync listener, and
// never clears a previously loaded cache.
import {
  loadCachedPersonnelDirectory,
  syncPersonnelDirectory,
  getPersonnelDirectorySnapshot,
  getActivePersonnelByRole,
} from '../../services/personnel-directory-service.js';

const ROLE_CARDS = [
  { role: 'SPV_SCM', title: 'SPV SCM', emptyMessage: 'Tidak ada SPV SCM aktif.' },
  { role: 'FRM_SCM', title: 'FRM SCM', emptyMessage: 'Tidak ada FRM SCM aktif.' },
  { role: 'SAMPLER', title: 'Independent Sampler', emptyMessage: 'Tidak ada Independent Sampler aktif.' },
];

const MESSAGES = {
  success: 'Personnel directory synchronized.',
  cacheFallback: 'Synchronization failed. Showing the last saved personnel directory.',
  noCache: 'Personnel directory could not be loaded. Check the connection and try again.',
};

let els = null;
let syncInFlight = false;

export function initSettingsPage() {
  const page = document.getElementById('page-settings');
  if (!page) return;

  page.innerHTML = buildMarkup();
  els = collectElements(page);
  els.syncBtn.addEventListener('click', handleSyncClick);

  loadCachedPersonnelDirectory();
  renderPersonnelCards();
  renderSyncMeta();
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
        <p class="settings-subtitle">Direktori SPV SCM, FRM SCM, Independent Sampler, dan PIC 3rd -- disinkron dari Google Sheet, tampilan saat ini bersifat read-only.</p>
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
            <dt>Total personel aktif</dt>
            <dd id="settings-sync-total">0</dd>
          </div>
        </dl>
        <div class="settings-btn-row">
          <button type="button" class="settings-btn settings-btn-primary" id="settings-sync-btn">Sync</button>
        </div>
        <p class="settings-sync-message" id="settings-sync-message" role="status" aria-live="polite">Tekan Sync untuk memuat direktori personel.</p>
      </section>

      <section class="settings-personnel-grid">
        ${ROLE_CARDS.map((card) => buildRoleCardMarkup(card)).join('')}
        ${buildPicThirdCardMarkup()}
      </section>
    </div>
  `;
}

function buildRoleCardMarkup({ role, title }) {
  return `
    <article class="settings-card settings-personnel-card" id="settings-card-${role}">
      <h2>${title}</h2>
      <p class="settings-card-count" id="settings-count-${role}">No data loaded</p>
      <ul class="settings-personnel-list" id="settings-list-${role}"></ul>
      <p class="settings-card-note">Penambahan, edit, dan nonaktifkan personel akan tersedia di versi berikutnya.</p>
    </article>
  `;
}

function buildPicThirdCardMarkup() {
  return `
    <article class="settings-card settings-personnel-card" id="settings-card-PIC_3RD">
      <h2>PIC 3rd</h2>
      <p class="settings-card-count" id="settings-count-PIC_3RD">No data loaded</p>
      <ul class="settings-personnel-list" id="settings-list-PIC_3RD"></ul>
      <p class="settings-card-note">Penambahan, edit, dan nonaktifkan personel akan tersedia di versi berikutnya.</p>
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
    counts: Object.fromEntries(
      [...ROLE_CARDS.map((c) => c.role), 'PIC_3RD'].map((role) => [role, page.querySelector(`#settings-count-${role}`)])
    ),
    lists: Object.fromEntries(
      [...ROLE_CARDS.map((c) => c.role), 'PIC_3RD'].map((role) => [role, page.querySelector(`#settings-list-${role}`)])
    ),
  };
}

/* ============================================================
   RENDERING
============================================================ */
function renderPersonnelCards() {
  const snapshot = getPersonnelDirectorySnapshot();
  ROLE_CARDS.forEach(({ role, emptyMessage }) => renderRoleCard(role, emptyMessage, snapshot));
  renderPicThirdCard(snapshot);
}

function renderRoleCard(role, emptyMessage, snapshot) {
  const countEl = els.counts[role];
  const listEl = els.lists[role];

  if (snapshot.source === 'none') {
    countEl.textContent = 'No data loaded';
    listEl.replaceChildren(emptyStateNode('Belum ada data. Tekan Sync untuk memuat direktori.'));
    return;
  }

  const records = getActivePersonnelByRole(role);
  countEl.textContent = `${records.length} data loaded`;
  listEl.replaceChildren(...(records.length ? records.map(buildPersonRow) : [emptyStateNode(emptyMessage)]));
}

function renderPicThirdCard(snapshot) {
  const countEl = els.counts.PIC_3RD;
  const listEl = els.lists.PIC_3RD;

  if (snapshot.source === 'none') {
    countEl.textContent = 'No data loaded';
    listEl.replaceChildren(emptyStateNode('Belum ada data. Tekan Sync untuk memuat direktori.'));
    return;
  }

  const records = getActivePersonnelByRole('PIC_3RD');
  countEl.textContent = `${records.length} data loaded`;

  if (!records.length) {
    listEl.replaceChildren(emptyStateNode('Tidak ada PIC 3rd aktif.'));
    return;
  }

  // getActivePersonnelByRole() already sorts by organization first, so
  // consecutive records sharing an organization form one visual group --
  // no re-sort needed here, only a group-boundary scan.
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
  listEl.replaceChildren(...nodes);
}

function buildPersonRow(record) {
  const li = document.createElement('li');
  li.className = 'settings-personnel-row';
  li.textContent = record.name;
  return li;
}

function emptyStateNode(message) {
  const li = document.createElement('li');
  li.className = 'settings-personnel-empty';
  li.textContent = message;
  return li;
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

/* ============================================================
   SYNC ACTION
============================================================ */
async function handleSyncClick() {
  if (syncInFlight) return;
  syncInFlight = true;

  els.syncBtn.disabled = true;
  els.syncBtn.textContent = 'Syncing...';
  setSyncMessage('Menyinkronkan direktori personel...', 'info');
  renderSyncMeta();

  const result = await syncPersonnelDirectory();

  syncInFlight = false;
  els.syncBtn.disabled = false;
  els.syncBtn.textContent = 'Sync';

  renderPersonnelCards();
  renderSyncMeta();

  if (result.ok) {
    setSyncMessage(MESSAGES.success, 'ok');
  } else if (result.snapshot.records.length > 0) {
    setSyncMessage(MESSAGES.cacheFallback, 'warn');
  } else {
    setSyncMessage(MESSAGES.noCache, 'error');
  }
}
