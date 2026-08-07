// Personnel Directory offline write queue (V2.3 Phase 5).
//
// This module is a pending-command log, NOT a second copy of the
// Personnel Directory. It never stores a personnel record itself -- only
// the write intention (action + payload) needed to replay
// addReportPersonnel/updateReportPersonnel/setReportPersonnelActive later.
// The authoritative source stays exactly what it already was: Google
// Sheet -> Apps Script -> personnel-directory-service.js's
// syncPersonnelDirectory()/snapshot. This module never writes into that
// snapshot directly -- every flushed item goes through the real service
// function, which already performs its own write-then-verify-then-resync
// (see personnel-directory-service.js's writeAndResync()), so a flushed
// item is only ever removed from the queue after the exact same
// authoritative-read-sync-and-verify guarantee the online path already has.
//
// Storage: one dedicated localStorage key (hpal.personnel.writeQueue.v1),
// read-modify-write on every mutating call -- there is no long-lived
// in-memory queue snapshot to go stale, unlike
// personnel-directory-service.js's `snapshot` (which exists because it is
// read on every UI render; this queue is only read when Settings needs to
// show/flush it).
//
// Deliberately talks to personnel-directory-service.js's existing
// addReportPersonnel/updateReportPersonnel/setReportPersonnelActive only --
// no endpoint URL, no fetch call, no POST-body construction lives here.
// See flushPersonnelWriteQueue()/callServiceForItem() below.

import {
  addReportPersonnel,
  updateReportPersonnel,
  setReportPersonnelActive,
} from './personnel-directory-service.js';

const QUEUE_KEY = 'hpal.personnel.writeQueue.v1';
const QUEUE_CORRUPTED_BACKUP_KEY = 'hpal.personnel.writeQueue.v1.corrupted';
const QUEUE_VERSION = 1;

export const QUEUE_ACTIONS = ['addReportPersonnel', 'updateReportPersonnel', 'setReportPersonnelActive'];
const QUEUE_STATUSES = ['pending', 'blocked'];

// Error codes that mean "the network/transport itself failed" -- the only
// codes that ever stop a flush and leave an item pending for automatic
// retry. Every other error code (VERSION_CONFLICT, DUPLICATE_PERSONNEL,
// VALIDATION_ERROR, NOT_FOUND, INVALID_RESPONSE, WRITE_NOT_VISIBLE_AFTER_SYNC,
// SYNC_AFTER_WRITE_FAILED, or anything unrecognized) is an application-level
// outcome, not a connectivity failure -- it blocks the single item and the
// flush moves on to the next one, per "queue only on genuine network-type
// failures" / "do not queue on HTTP/application error response".
const NETWORK_FAILURE_CODES = new Set(['NETWORK_ERROR', 'NETWORK_UNAVAILABLE']);

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function isPositiveInteger(value) {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

function nowIso() {
  return new Date().toISOString();
}

function getStorage() {
  try {
    return globalThis.localStorage || null;
  } catch (_) {
    return null;
  }
}

function genQueueId() {
  try {
    if (globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function') {
      return globalThis.crypto.randomUUID();
    }
  } catch (_) {
    // Fall through to the manual fallback below.
  }
  return `q-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

/* ============================================================
   SCHEMA VALIDATION -- pure, DOM-free, network-free
============================================================ */

function validatePayloadForAction(action, payload) {
  if (!isPlainObject(payload)) return false;
  if (action === 'addReportPersonnel') {
    return isNonEmptyString(payload.role_type) && isNonEmptyString(payload.name) && isNonEmptyString(payload.organization);
  }
  if (action === 'updateReportPersonnel') {
    return isNonEmptyString(payload.id)
      && isNonEmptyString(payload.name)
      && isNonEmptyString(payload.organization)
      && isPositiveInteger(payload.expected_version);
  }
  if (action === 'setReportPersonnelActive') {
    return isNonEmptyString(payload.id)
      && typeof payload.active === 'boolean'
      && isPositiveInteger(payload.expected_version);
  }
  return false;
}

function validateQueueItemShape(item) {
  if (!isPlainObject(item)) return false;
  if (!isNonEmptyString(item.queueId)) return false;
  if (!QUEUE_ACTIONS.includes(item.action)) return false;
  if (!validatePayloadForAction(item.action, item.payload)) return false;
  if (!isNonEmptyString(item.createdAt)) return false;
  if (!Number.isInteger(item.attemptCount) || item.attemptCount < 0) return false;
  if (item.lastAttemptAt !== null && !isNonEmptyString(item.lastAttemptAt)) return false;
  if (item.lastError !== null && typeof item.lastError !== 'string') return false;
  if (item.lastErrorCode !== null && typeof item.lastErrorCode !== 'string') return false;
  if (!QUEUE_STATUSES.includes(item.status)) return false;
  return true;
}

// Exported for independent unit testing against fixture JSON, same pattern
// as personnel-directory-service.js's validatePersonnelResponsePayload().
export function validateWriteQueueShape(raw) {
  if (!isPlainObject(raw)) return { ok: false, error: 'queue is not an object' };
  if (raw.queueVersion !== QUEUE_VERSION) return { ok: false, error: 'unsupported queueVersion' };
  if (!Array.isArray(raw.items)) return { ok: false, error: 'items is not an array' };

  const seenIds = new Set();
  for (const item of raw.items) {
    if (!validateQueueItemShape(item)) return { ok: false, error: 'invalid queue item shape' };
    if (seenIds.has(item.queueId)) return { ok: false, error: 'duplicate queueId' };
    seenIds.add(item.queueId);
  }

  return { ok: true };
}

/* ============================================================
   LOAD / SAVE -- read-modify-write on every mutating call, no long-lived
   in-memory copy to go stale.
============================================================ */

function createEmptyQueue() {
  return { queueVersion: QUEUE_VERSION, updatedAt: null, items: [] };
}

// A malformed/corrupted queue is quarantined (best-effort copy to a
// diagnostic backup key) and reset to empty rather than thrown -- it must
// never execute a malformed command and must never crash the app around
// it (CORRUPTED QUEUE requirement).
function quarantineCorruptedQueue(storage, rawValue) {
  try {
    storage.setItem(QUEUE_CORRUPTED_BACKUP_KEY, rawValue);
  } catch (_) {
    // Best-effort only -- losing the diagnostic backup is acceptable, an
    // app-wide throw is not.
  }
  try {
    storage.removeItem(QUEUE_KEY);
  } catch (_) {
    // Ignored -- the in-memory empty queue returned below is what actually
    // matters to the caller.
  }
}

export function loadWriteQueue() {
  const storage = getStorage();
  if (!storage) return createEmptyQueue();

  let raw;
  try {
    raw = storage.getItem(QUEUE_KEY);
  } catch (_) {
    return createEmptyQueue();
  }
  if (!raw) return createEmptyQueue();

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (_) {
    quarantineCorruptedQueue(storage, raw);
    return createEmptyQueue();
  }

  const check = validateWriteQueueShape(parsed);
  if (!check.ok) {
    quarantineCorruptedQueue(storage, raw);
    return createEmptyQueue();
  }

  return { queueVersion: parsed.queueVersion, updatedAt: parsed.updatedAt || null, items: parsed.items };
}

// Returns true on success, false if the write could not be persisted
// (e.g. localStorage unavailable/full) -- callers treat a save failure as
// non-fatal (the in-memory result of the operation is still returned),
// same posture as personnel-directory-service.js's writeCache().
function saveWriteQueue(queue) {
  const storage = getStorage();
  if (!storage) return false;

  const shape = { queueVersion: QUEUE_VERSION, updatedAt: nowIso(), items: queue.items };
  try {
    storage.setItem(QUEUE_KEY, JSON.stringify(shape));
  } catch (_) {
    return false;
  }
  return true;
}

// Test/diagnostic helper -- removes the queue entirely (not a normal app
// operation; Settings never lets a user wipe the whole queue at once, only
// individual items via removeQueueItem()).
export function clearWriteQueue() {
  const storage = getStorage();
  if (storage) {
    try {
      storage.removeItem(QUEUE_KEY);
    } catch (_) {
      // Ignored -- best-effort clear only.
    }
  }
}

/* ============================================================
   READ ACCESS
============================================================ */

export function getWriteQueueSnapshot() {
  const queue = loadWriteQueue();
  return {
    updatedAt: queue.updatedAt,
    items: queue.items.slice(),
    pendingCount: queue.items.filter((it) => it.status === 'pending').length,
    blockedCount: queue.items.filter((it) => it.status === 'blocked').length,
  };
}

export function getWriteQueueSummary() {
  const snapshot = getWriteQueueSnapshot();
  return { total: snapshot.items.length, pending: snapshot.pendingCount, blocked: snapshot.blockedCount };
}

/* ============================================================
   ENQUEUE -- add / update / setActive. Update and setActive coalesce
   against an existing PENDING item for the same id (and the same
   expected_version, so two edits that were not both based on the same
   last-known server state are kept as separate items rather than merged --
   "prefer safety over aggressive compaction"). Update and setActive are
   never coalesced with EACH OTHER (rule 3: they may remain separate).
============================================================ */

function makeQueueItem(action, payload) {
  return {
    queueId: genQueueId(),
    action,
    payload,
    createdAt: nowIso(),
    attemptCount: 0,
    lastAttemptAt: null,
    lastError: null,
    lastErrorCode: null,
    status: 'pending',
  };
}

// Rule 4: an offline add never has a server id yet (this app has no
// deterministic id prediction), so there is nothing here that lets a
// later offline update/setActive target it -- Settings only ever offers
// Edit/Deactivate/Reactivate on records already present in the
// authoritative snapshot, so this case cannot arise from the UI. Enqueued
// as-is; the server assigns id/created_at/updated_at/version on flush,
// exactly like the online path.
export function enqueueAddReportPersonnel({ role_type, name, organization }) {
  const queue = loadWriteQueue();
  const item = makeQueueItem('addReportPersonnel', {
    role_type,
    name: String(name ?? '').trim(),
    organization: String(organization ?? '').trim(),
  });
  queue.items.push(item);
  saveWriteQueue(queue);
  return item;
}

// Coalescing rule 1: multiple pending updates for the same id (based on
// the same expected_version) collapse into one item holding the latest
// requested name/organization -- never increments expected_version
// locally, and never touches any item that is already 'blocked' (a
// blocked item needs explicit user review/retry, not silent replacement).
export function enqueueUpdateReportPersonnel({ id, name, organization, expected_version }) {
  const queue = loadWriteQueue();
  const trimmedName = String(name ?? '').trim();
  const trimmedOrganization = String(organization ?? '').trim();

  const existing = queue.items.find((it) => it.status === 'pending'
    && it.action === 'updateReportPersonnel'
    && it.payload.id === id
    && it.payload.expected_version === expected_version);

  if (existing) {
    existing.payload = { id, name: trimmedName, organization: trimmedOrganization, expected_version };
    saveWriteQueue(queue);
    return existing;
  }

  const item = makeQueueItem('updateReportPersonnel', { id, name: trimmedName, organization: trimmedOrganization, expected_version });
  queue.items.push(item);
  saveWriteQueue(queue);
  return item;
}

// Coalescing rule 2: multiple pending setReportPersonnelActive items for
// the same id (based on the same expected_version) collapse into one item
// holding only the latest requested active boolean -- deactivate then
// reactivate before any flush collapses to a single reactivate item (and
// vice versa), never two round-trips for a state the user already undid
// locally.
export function enqueueSetReportPersonnelActive({ id, active, expected_version }) {
  const queue = loadWriteQueue();

  const existing = queue.items.find((it) => it.status === 'pending'
    && it.action === 'setReportPersonnelActive'
    && it.payload.id === id
    && it.payload.expected_version === expected_version);

  if (existing) {
    existing.payload = { id, active, expected_version };
    saveWriteQueue(queue);
    return existing;
  }

  const item = makeQueueItem('setReportPersonnelActive', { id, active, expected_version });
  queue.items.push(item);
  saveWriteQueue(queue);
  return item;
}

/* ============================================================
   MANUAL QUEUE CONTROL -- remove / retry (blocked -> pending). Never
   accepts raw JSON edits; only these two typed operations.
============================================================ */

export function removeQueueItem(queueId) {
  const queue = loadWriteQueue();
  const nextItems = queue.items.filter((it) => it.queueId !== queueId);
  const removed = nextItems.length !== queue.items.length;
  if (removed) {
    queue.items = nextItems;
    saveWriteQueue(queue);
  }
  return removed;
}

// Only moves a 'blocked' item back to 'pending' -- a no-op (returns false)
// for an id that does not exist or is already 'pending', since retrying an
// already-pending item has no meaning (it will be attempted on the next
// flush regardless).
export function retryQueueItem(queueId) {
  const queue = loadWriteQueue();
  const item = queue.items.find((it) => it.queueId === queueId);
  if (!item || item.status !== 'blocked') return false;

  item.status = 'pending';
  saveWriteQueue(queue);
  return true;
}

function recordAttemptResult(queueId, { block, message, code }) {
  const queue = loadWriteQueue();
  const item = queue.items.find((it) => it.queueId === queueId);
  if (!item) return;

  item.attemptCount += 1;
  item.lastAttemptAt = nowIso();
  item.lastError = message || null;
  item.lastErrorCode = code || null;
  if (block) item.status = 'blocked';
  saveWriteQueue(queue);
}

/* ============================================================
   FLUSH -- sequential FIFO, one item in flight at a time (never parallel,
   per the version-sequencing/deterministic-conflict-behavior requirement).
   Calls ONLY the existing personnel-directory-service.js write functions --
   no endpoint URL, no fetch, no POST body construction lives in this
   module (see file header).
============================================================ */

function callServiceForItem(item, writeOptions) {
  if (item.action === 'addReportPersonnel') return addReportPersonnel(item.payload, writeOptions);
  if (item.action === 'updateReportPersonnel') return updateReportPersonnel(item.payload, writeOptions);
  return setReportPersonnelActive(item.payload, writeOptions);
}

let flushInFlight = null;

export function isWriteQueueFlushInFlight() {
  return flushInFlight !== null;
}

async function performFlush(options) {
  const writeOptions = options.fetchImpl ? { fetchImpl: options.fetchImpl } : {};
  const result = { processed: 0, succeeded: 0, blocked: 0, stopped: false, stopReason: null };

  for (;;) {
    const queue = loadWriteQueue();
    const next = queue.items.find((it) => it.status === 'pending');
    if (!next) break;

    result.processed += 1;

    let writeResult;
    try {
      writeResult = await callServiceForItem(next, writeOptions);
    } catch (_) {
      // Defensive only -- personnel-directory-service.js's write functions
      // already resolve to { ok: false, error } rather than throwing, but a
      // thrown error here must still be classified as a network failure
      // (never as an app-level block) so the item is preserved, not lost.
      writeResult = { ok: false, error: { code: 'NETWORK_ERROR', message: 'Network request failed.' } };
    }

    if (writeResult.ok) {
      removeQueueItem(next.queueId);
      result.succeeded += 1;
      continue;
    }

    const errorCode = writeResult.error && writeResult.error.code;
    const errorMessage = (writeResult.error && writeResult.error.message) || 'Write failed.';

    if (NETWORK_FAILURE_CODES.has(errorCode)) {
      recordAttemptResult(next.queueId, { block: false, message: errorMessage, code: errorCode });
      result.stopped = true;
      result.stopReason = 'network';
      break;
    }

    // Every other error code -- VERSION_CONFLICT, DUPLICATE_PERSONNEL,
    // VALIDATION_ERROR, NOT_FOUND, INVALID_RESPONSE,
    // WRITE_NOT_VISIBLE_AFTER_SYNC, SYNC_AFTER_WRITE_FAILED, or anything
    // unrecognized -- blocks this single item (never an endless automatic
    // retry) and the flush continues to the next pending item.
    recordAttemptResult(next.queueId, { block: true, message: errorMessage, code: errorCode || 'UNKNOWN_ERROR' });
    result.blocked += 1;
  }

  return result;
}

// Deliberately not `async` itself, same reasoning as
// personnel-directory-service.js's syncPersonnelDirectory(): the in-flight
// guard must run synchronously so two calls issued back-to-back (e.g. the
// 'online' event firing while a manual "Review" flush is already running)
// are guaranteed to share one flush rather than racing.
export function flushPersonnelWriteQueue(options = {}) {
  if (flushInFlight) return flushInFlight;
  flushInFlight = performFlush(options).finally(() => {
    flushInFlight = null;
  });
  return flushInFlight;
}
