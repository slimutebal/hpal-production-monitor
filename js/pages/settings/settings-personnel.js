// Settings personnel-directory pure/DOM-free helpers (UI refinement --
// summary-first main view + per-role management modal). Mirrors
// js/pages/report/report-personnel.js's pattern: no DOM, no localStorage,
// no fetch, so this is independently unit-testable
// (tests/settings-personnel.test.mjs) without mocking the browser.
// settings-page.js owns all DOM rendering/event wiring; this module owns
// the summary-text formatting and the search-filter rule for the
// management modal's personnel list.
//
// Deliberately NOT imported by report-page.js/report-personnel.js and
// vice versa -- each page directory owns its own small pure-logic module
// rather than the two pages depending on each other, matching this
// project's existing modularity (report-personnel.js's own
// normalizeCompareKey() is duplicated there rather than imported from a
// shared location, for the identical reason).

// "10 aktif" when there are no inactive records for this role, or
// "10 aktif · 2 nonaktif" once at least one exists -- never shows
// "0 nonaktif". Pure formatting only; `activeCount`/`inactiveCount` are
// whatever the caller already counted (e.g. via
// personnel-directory-service.js's getPersonnelByRole()).
export function buildRoleSummaryText(activeCount, inactiveCount) {
  return inactiveCount > 0 ? `${activeCount} aktif · ${inactiveCount} nonaktif` : `${activeCount} aktif`;
}

function normalizeSearchKey(value) {
  return String(value ?? '').trim().toLowerCase();
}

// Case-insensitive, trimmed substring match against name and (unless
// disabled) organization -- the management modal's PIC 3rd list benefits
// from matching organization too (e.g. searching "awk" to jump to that
// group), unlike Report's SPV/FRM-only modal search where organization is
// always the fixed 'SCM' constant and would never usefully discriminate.
// A blank/whitespace-only query returns every record unfiltered. Never
// touches active/inactive filtering or any write state -- purely a
// display-visibility filter over whatever records array the caller
// already filtered by role/status.
export function filterPersonnelBySearch(records, query, options = {}) {
  const key = normalizeSearchKey(query);
  if (!key) return (records || []).slice();
  const matchOrganization = options.matchOrganization !== false;
  return (records || []).filter((r) => {
    if (normalizeSearchKey(r.name).includes(key)) return true;
    if (matchOrganization && normalizeSearchKey(r.organization).includes(key)) return true;
    return false;
  });
}

/* ============================================================
   OFFLINE PERSONNEL WRITE QUEUE -- pure/DOM-free display helpers only
   (V2.3 Phase 5). settings-page.js owns loading js/services/
   personnel-write-queue.js's queue items/summary and calling these to
   turn them into display text/view-models; this module never touches
   localStorage or the queue module itself, same separation as the rest of
   this file.
============================================================ */

// Exact literal required when a write is enqueued instead of sent, per the
// offline-write-queue requirement -- never a server-supplied or
// locally-rephrased variant.
export const QUEUE_OFFLINE_SAVED_MESSAGE = 'Perubahan disimpan sebagai antrean offline dan akan dikirim saat koneksi kembali.';

// Exact literal required for a blocked VERSION_CONFLICT item -- distinct
// from the ONLINE immediate-write VERSION_CONFLICT message
// (settings-page.js's describeWriteError()), since this one describes a
// queued item that failed during flush, not a write that just failed.
export const QUEUE_VERSION_CONFLICT_REVIEW_MESSAGE = 'Data sudah berubah di server. Sinkronkan ulang dan tinjau perubahan offline.';

// Exact literal required for the compact offline indicator.
export const OFFLINE_INDICATOR_MESSAGE = 'Offline — perubahan akan diantrikan.';

export function buildOfflineIndicatorText(isOnline) {
  return isOnline ? null : OFFLINE_INDICATOR_MESSAGE;
}

// "0 pending" (nothing queued or all somehow already flushed), "3 pending"
// (only pending items, no review needed yet), or "2 pending · 1 blocked"
// (at least one item needs manual review) -- mirrors
// buildRoleSummaryText()'s "never show a zero half" rule above: blocked is
// only appended when > 0.
export function buildQueueCountText(pendingCount, blockedCount) {
  const total = (pendingCount || 0) + (blockedCount || 0);
  if (total === 0) return '0 pending';
  if (!blockedCount) return `${total} pending`;
  return `${pendingCount} pending · ${blockedCount} blocked`;
}

const QUEUE_ACTION_LABELS = {
  addReportPersonnel: 'Tambah',
  updateReportPersonnel: 'Edit',
};

function queueActionLabel(item) {
  if (item.action === 'setReportPersonnelActive') return item.payload.active ? 'Aktifkan' : 'Nonaktifkan';
  return QUEUE_ACTION_LABELS[item.action] || item.action;
}

// Server error `code` (as stored in a blocked item's lastErrorCode) ->
// the exact reason text the QUEUE DISPLAY EXAMPLES require (e.g.
// "Blocked: version conflict"). Falls back to the raw stored message for
// any other code so a blocked item is never shown with no explanation at
// all.
function queueBlockReasonText(item) {
  if (item.lastErrorCode === 'VERSION_CONFLICT') return 'version conflict';
  if (item.lastErrorCode === 'DUPLICATE_PERSONNEL') return 'sudah ada personel dengan role/nama/organisasi yang sama';
  return item.lastError || 'kesalahan tidak diketahui';
}

// Turns one raw queue item (js/services/personnel-write-queue.js's shape)
// into the flat fields the queue review modal renders. `records` is the
// current Personnel Directory snapshot's records array -- only
// setReportPersonnelActive payloads need it (that action's payload has no
// name/organization/role, only id), so a missing/empty array degrades to
// showing the raw id rather than throwing.
export function buildQueueItemViewModel(item, records = []) {
  let name = '';
  let organization = '';
  let roleType = '';

  if (item.action === 'addReportPersonnel') {
    name = item.payload.name;
    organization = item.payload.organization;
    roleType = item.payload.role_type;
  } else if (item.action === 'updateReportPersonnel') {
    name = item.payload.name;
    organization = item.payload.organization;
    const match = (records || []).find((r) => r.id === item.payload.id);
    roleType = match ? match.role_type : '';
  } else {
    const match = (records || []).find((r) => r.id === item.payload.id);
    name = match ? match.name : item.payload.id;
    organization = match ? match.organization : '';
    roleType = match ? match.role_type : '';
  }

  return {
    queueId: item.queueId,
    actionLabel: queueActionLabel(item),
    name,
    organization,
    roleType,
    createdAt: item.createdAt,
    status: item.status,
    statusText: item.status === 'blocked' ? `Blocked: ${queueBlockReasonText(item)}` : 'Pending',
    canRetry: item.status === 'blocked',
  };
}
