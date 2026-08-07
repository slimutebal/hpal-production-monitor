// Report's contractor (DT -> contractor) directory READ consumer
// (Monitor-owned single-sync architecture round).
//
// Final business decision: there is exactly one List DT synchronization
// flow in the application -- Monitor's existing sync
// (contractor-assignment.js). Report never fetches contractor data
// itself; it only reads the shared, validated `hpal.contractors.v1`
// cache Monitor's sync writes (via contractor-directory-core.js) and
// reacts to the `hpal:contractor-directory-updated` event Monitor
// dispatches after each successful sync. This module owns: the in-memory
// lookup snapshot built from that shared cache, and subscribing to the
// update event so Report reclassifies an already-uploaded workbook
// without requiring re-upload.
//
// Root cause history: an earlier round gave Report its own independent
// background remote synchronization against the same Google Apps Script
// endpoint Monitor uses. That created a second, competing sync
// lifecycle -- racing against uploads, and (per the Owner's explicit
// final decision) simply unnecessary once Monitor already performs the
// one sync the whole application needs. This module contains no network
// request, no endpoint address, no timeout, and no in-flight-request
// tracking of any kind -- see this repository's own change history for
// the prior shape, if needed.
//
// Normalization and the cache schema are NOT reimplemented here -- see
// contractor-directory-core.js's header comment for why that would just
// recreate the exact drift bug this whole feature closes. This module
// imports that file purely for its side effect (populating
// globalThis.HPALContractorDirectoryCore), which works identically
// whether this module is loaded in the browser (where the core is
// normally already loaded earlier via a classic <script>, see
// index.html) or under Node for tests.
import './contractor-directory-core.js';

function getCore() {
  const core = globalThis.HPALContractorDirectoryCore;
  if (!core) {
    throw new Error('HPALContractorDirectoryCore is not available -- contractor-directory-core.js failed to load.');
  }
  return core;
}

function createEmptySnapshot() {
  return { source: 'none', records: [], fetchedAt: null };
}

let snapshot = createEmptySnapshot();
let lookupMap = new Map();

function getDefaultEventTarget() {
  return (typeof window !== 'undefined' && typeof window.addEventListener === 'function') ? window : null;
}

function buildLookupMap(records) {
  const map = new Map();
  records.forEach((r) => map.set(r.normalizedKey, r.contractor));
  return map;
}

function applySnapshot(cache, source) {
  snapshot = { source, records: cache.records, fetchedAt: cache.fetchedAt };
  lookupMap = buildLookupMap(snapshot.records);
}

// Re-exported from the shared core so existing callers/tests can keep
// importing normalization directly from this module without needing to
// know the core file exists -- both are thin delegations, never a second
// implementation.
export function canonicalDtId(value) {
  return getCore().canonicalDtId(value);
}

export function normalizedKey(value) {
  return getCore().normalizedKey(value);
}

export function validateContractorRecords(rawRows) {
  return getCore().validateContractorRows(rawRows);
}

/* ============================================================
   SHARED CACHE (read-only)
============================================================ */
// Reads and validates the shared hpal.contractors.v1 cache -- written
// exclusively by Monitor's own List DT sync (contractor-assignment.js) --
// and replaces the in-memory snapshot. Called once when Report
// initializes (never automatically re-fetched, and Report performs no
// network request of its own at all). Marks the resulting snapshot
// `source: 'cached'` -- data that was already on disk before this
// session observed any live Monitor sync, as distinct from `'synced'`
// (see subscribeContractorDirectoryUpdated() below), which means a
// hpal:contractor-directory-updated event was actually received this
// session. A malformed/corrupted/wrong-version/missing cache is rejected
// without throwing and without touching whatever snapshot already exists.
export function loadCachedContractorDirectory() {
  const cache = getCore().readSharedContractorCache();
  if (!cache) return null;
  applySnapshot(cache, 'cached');
  return getContractorDirectorySnapshot();
}

export function clearContractorDirectoryCache() {
  const core = getCore();
  try {
    globalThis.localStorage && globalThis.localStorage.removeItem(core.CACHE_KEY);
  } catch (_) {
    // Best-effort only -- the in-memory reset below is what matters.
  }
  snapshot = createEmptySnapshot();
  lookupMap = new Map();
}

/* ============================================================
   UPDATE EVENT SUBSCRIPTION -- the only mechanism through which Report's
   snapshot ever changes after initialization. Dispatched exclusively by
   Monitor's own sync (contractor-assignment.js, via the shared core)
   after it writes a fresh, validated hpal.contractors.v1.
============================================================ */
// Registers `callback(detail)` against the hpal:contractor-directory-updated
// event. Before invoking `callback`, this reloads the shared cache into
// this module's own snapshot/lookup (marked `source: 'synced'`, since
// receiving this event is itself live proof Monitor just synced) --
// callers (report-page.js) only need to react to the change (re-render
// status, reclassify), not remember to reload it themselves. Returns an
// unsubscribe function. In an environment with no real event target
// (e.g. a plain Node test that didn't inject one), this is a safe no-op:
// the returned unsubscribe function does nothing and `callback` is never
// called -- it never throws.
export function subscribeContractorDirectoryUpdated(callback, options = {}) {
  const target = options.eventTarget || getDefaultEventTarget();
  if (!target || typeof target.addEventListener !== 'function') {
    return () => {};
  }
  const core = getCore();
  const handler = (event) => {
    const cache = core.readSharedContractorCache();
    if (cache) applySnapshot(cache, 'synced');
    callback(event && event.detail);
  };
  target.addEventListener(core.DIRECTORY_UPDATED_EVENT, handler);
  return () => target.removeEventListener(core.DIRECTORY_UPDATED_EVENT, handler);
}

/* ============================================================
   READ ACCESS
============================================================ */
// `source` is 'synced' (a hpal:contractor-directory-updated event was
// received this session -- Monitor just synced), 'cached' (loaded from
// hpal.contractors.v1 at Report init, no live event yet this session), or
// 'none' (no valid shared cache exists at all -- Monitor has never
// synced, or its cache was cleared). There is no 'remote' state anymore:
// Report itself never fetches.
export function getContractorDirectorySnapshot() {
  return {
    source: snapshot.source,
    records: snapshot.records.slice(),
    fetchedAt: snapshot.fetchedAt,
  };
}

export function getContractorDirectoryStatus() {
  return {
    source: snapshot.source,
    recordCount: snapshot.records.length,
    fetchedAt: snapshot.fetchedAt,
  };
}

// Returns the contractor name for a raw workbook DT/vehicle id, resolved
// against the latest Monitor-synced snapshot only -- returns null (never
// a guess) when the snapshot has no match, so callers (Report's profile
// modules) can decide whether a static fallback is appropriate. For
// SCM-shaped ids (SCM-HLG/SCM-LIM), profile modules deliberately do NOT
// fall back to the static table once a Monitor cache exists to consult --
// see shared-report-profile.js's resolveContractor() for the full
// precedence rule.
export function lookupContractor(dtId) {
  const key = normalizedKey(dtId);
  if (!key) return null;
  return lookupMap.get(key) || null;
}
