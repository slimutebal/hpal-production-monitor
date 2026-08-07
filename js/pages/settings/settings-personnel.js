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
//
// V2.3 Phase 7 (Language and Localization): every user-facing string this
// module returns is now looked up through js/i18n/i18n.js's t() rather
// than hardcoded Indonesian -- t() itself is DOM-free/pure (see its own
// header comment), so this file stays independently unit-testable under
// Node exactly as before (tests/settings-personnel.test.mjs), just with
// the current locale as an added axis those tests now also cover.
import { t } from '../../i18n/i18n.js';

// "10 aktif" when there are no inactive records for this role, or
// "10 aktif · 2 nonaktif" once at least one exists -- never shows
// "0 nonaktif". Pure formatting only; `activeCount`/`inactiveCount` are
// whatever the caller already counted (e.g. via
// personnel-directory-service.js's getPersonnelByRole()).
export function buildRoleSummaryText(activeCount, inactiveCount) {
  return inactiveCount > 0
    ? t('settings.role.summaryActiveInactive', { active: activeCount, inactive: inactiveCount })
    : t('settings.role.summaryActiveOnly', { active: activeCount });
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

// Locale-aware replacements for what were, before V2.3 Phase 7, fixed
// exported string constants (QUEUE_OFFLINE_SAVED_MESSAGE /
// QUEUE_VERSION_CONFLICT_REVIEW_MESSAGE) -- the earlier offline-queue task
// required an exact Indonesian literal, which is preserved byte-for-byte
// as the `id` locale's translation (see js/i18n/locales/id.js), so a
// caller that never switches language sees no change at all.
export function buildQueueOfflineSavedMessage() {
  return t('settings.queue.offlineSavedMessage');
}

export function buildQueueVersionConflictReviewMessage() {
  return t('settings.queue.versionConflictReviewMessage');
}

export function buildOfflineIndicatorText(isOnline) {
  return isOnline ? null : t('settings.offlineIndicator');
}

// "0 pending" (nothing queued or all somehow already flushed), "3 pending"
// (only pending items, no review needed yet), or "2 pending · 1 blocked"
// (at least one item needs manual review) -- mirrors
// buildRoleSummaryText()'s "never show a zero half" rule above: blocked is
// only appended when > 0.
export function buildQueueCountText(pendingCount, blockedCount) {
  const total = (pendingCount || 0) + (blockedCount || 0);
  if (!blockedCount) return t('settings.queue.countPendingOnly', { total });
  return t('settings.queue.countPendingBlocked', { pending: pendingCount, blocked: blockedCount });
}

function queueActionLabel(item) {
  if (item.action === 'setReportPersonnelActive') return item.payload.active ? t('common.reactivate') : t('common.deactivate');
  if (item.action === 'addReportPersonnel') return t('common.add');
  if (item.action === 'updateReportPersonnel') return t('common.edit');
  return item.action;
}

// Server error `code` (as stored in a blocked item's lastErrorCode) ->
// the exact reason text the QUEUE DISPLAY EXAMPLES require in the default
// `id` locale (e.g. "Blocked: version conflict"). Falls back to the raw
// stored message for any other code so a blocked item is never shown with
// no explanation at all.
function queueBlockReasonText(item) {
  if (item.lastErrorCode === 'VERSION_CONFLICT') return t('settings.queue.reasonVersionConflict');
  if (item.lastErrorCode === 'DUPLICATE_PERSONNEL') return t('settings.queue.reasonDuplicate');
  return item.lastError || t('settings.queue.reasonUnknown');
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
    statusText: item.status === 'blocked' ? t('settings.queue.statusBlocked', { reason: queueBlockReasonText(item) }) : t('settings.queue.statusPending'),
    canRetry: item.status === 'blocked',
  };
}
