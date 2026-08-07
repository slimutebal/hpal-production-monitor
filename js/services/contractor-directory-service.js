// Report's contractor (DT -> contractor) directory sync orchestration
// (shared-cache architecture round).
//
// Root cause this closes: contractor-assignment.js's synced List DT used
// to live only in a private in-memory closure (`state.existing`), never
// in localStorage -- Report had no real way to see what Monitor had just
// synced, and a Report-only background sync raced against uploads,
// silently classifying workbooks against stale/empty data. The actual
// fix is the shared bridge in contractor-directory-core.js
// (`hpal.contractors.v1` + the `hpal:contractor-directory-updated` event,
// written to by BOTH contractor-assignment.js's own sync and this
// module's own sync). This module is Report's consumer of that bridge:
// it owns Report's own independent remote read-sync (transport, in-flight
// dedup, timeout), the in-memory lookup snapshot, and subscribing to the
// update event so Report reacts when Monitor (or another Report sync)
// writes fresher data.
//
// Normalization and the cache schema themselves are NOT reimplemented
// here -- see contractor-directory-core.js's header comment for why that
// would just recreate the exact drift bug this fix closes. This module
// imports that file purely for its side effect (populating
// globalThis.HPALContractorDirectoryCore), which works identically
// whether this module is loaded in the browser (where the core is
// normally already loaded earlier via a classic <script>, see
// index.html) or under Node for tests.
import './contractor-directory-core.js';

// Deliberately the same literal endpoint URL contractor-assignment.js
// uses (that file has no exports to import from), the same pattern
// personnel-directory-service.js already established for its own,
// separately-deployed endpoint constant.
const CONTRACTOR_ENDPOINT = 'https://script.google.com/macros/s/AKfycbwoakor1_LBN52GYBACijgorUEE5cPqjrnR_ncmCBzJH2YKf6Yl42Ys2m3VpSVoSuFs/exec';
const FETCH_TIMEOUT_MS = 15000;

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
let inFlightSync = null;
let syncing = false;
let lastSyncError = null;

function getFetch() {
  return typeof globalThis.fetch === 'function' ? globalThis.fetch : null;
}

function getDefaultEventTarget() {
  return (typeof window !== 'undefined' && typeof window.addEventListener === 'function') ? window : null;
}

function buildLookupMap(records) {
  const map = new Map();
  records.forEach((r) => map.set(r.normalizedKey, r.contractor));
  return map;
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
   LOCAL/SHARED CACHE
============================================================ */
// Loads and validates the SHARED hpal.contractors.v1 cache (written by
// either Monitor's own sync or this module's own sync -- see
// contractor-directory-core.js), replacing the in-memory snapshot. Called
// once when Report initializes and again whenever the
// hpal:contractor-directory-updated event fires (see
// subscribeContractorDirectoryUpdated below) -- never automatically on
// every route visit. A malformed/corrupted/wrong-version cache is
// rejected without throwing and without touching whatever snapshot
// already exists.
//
// Deliberately does NOT downgrade an already-fresher in-memory 'remote'
// snapshot (this Report instance's own just-completed live fetch) back to
// 'shared-cache' when the cache being read back is the exact same write
// that fetch itself just made (compares fetchedAt, not just presence) --
// otherwise reacting to this module's own dispatched update event would
// immediately relabel "Remote" as "Shared cache" for no reason.
export function loadCachedContractorDirectory() {
  const core = getCore();
  const cache = core.readSharedContractorCache();
  if (!cache) return null;

  if (snapshot.source === 'remote' && snapshot.fetchedAt === cache.fetchedAt) {
    return getContractorDirectorySnapshot();
  }

  snapshot = { source: 'shared-cache', records: cache.records, fetchedAt: cache.fetchedAt };
  lookupMap = buildLookupMap(snapshot.records);
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
  lastSyncError = null;
}

/* ============================================================
   REMOTE SYNC -- same proven transport contractor-assignment.js's
   fetchExistingContractors() already uses: plain GET, cache: 'no-store',
   redirect: 'follow', cache-busting timestamp query param, no custom
   headers, no mode: 'no-cors', no credentials. Adds only an
   AbortController timeout (personnel-directory-service.js's existing
   precedent), which the original function doesn't have.
============================================================ */
async function performSync(fetchImpl, eventTarget) {
  syncing = true;
  try {
    if (typeof fetchImpl !== 'function') {
      lastSyncError = 'Network request is not available in this environment.';
      return { ok: false, error: lastSyncError, snapshot: getContractorDirectorySnapshot() };
    }

    const url = `${CONTRACTOR_ENDPOINT}?t=${Date.now()}`;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    let response;
    try {
      response = await fetchImpl(url, {
        method: 'GET',
        cache: 'no-store',
        redirect: 'follow',
        signal: controller.signal,
      });
    } catch (_) {
      lastSyncError = 'Network request failed.';
      return { ok: false, error: lastSyncError, snapshot: getContractorDirectorySnapshot() };
    } finally {
      clearTimeout(timeoutId);
    }

    if (!response || !response.ok) {
      lastSyncError = 'Server responded with an error.';
      return { ok: false, error: lastSyncError, snapshot: getContractorDirectorySnapshot() };
    }

    let payload;
    try {
      payload = await response.json();
    } catch (_) {
      lastSyncError = 'Server response was not valid JSON.';
      return { ok: false, error: lastSyncError, snapshot: getContractorDirectorySnapshot() };
    }

    const core = getCore();
    // writeSharedContractorCache() re-validates `payload` independently
    // (never trusts a prior check) and returns null on any invalid row or
    // conflicting duplicate -- the existing shared cache is never
    // overwritten with a bad result.
    const cache = core.writeSharedContractorCache(payload, { source: 'remote' });
    if (!cache) {
      lastSyncError = 'Server response failed validation.';
      return { ok: false, error: lastSyncError, snapshot: getContractorDirectorySnapshot() };
    }

    snapshot = { source: 'remote', records: cache.records, fetchedAt: cache.fetchedAt };
    lookupMap = buildLookupMap(snapshot.records);
    lastSyncError = null;

    // Notifies any other listener (report-page.js's own subscription,
    // and -- symmetrically, though nothing currently listens on that
    // side -- Monitor) that fresh data is available, exactly like
    // contractor-assignment.js's own sync does after its write.
    core.dispatchDirectoryUpdated(cache, eventTarget || getDefaultEventTarget());

    return { ok: true, snapshot: getContractorDirectorySnapshot() };
  } finally {
    syncing = false;
  }
}

// Deliberately not `async` itself -- the in-flight guard runs and assigns
// `inFlightSync` synchronously, before any `await`, so two calls issued in
// the same tick reuse one in-flight request rather than racing to start
// two fetches (same pattern as personnel-directory-service.js's
// syncPersonnelDirectory()).
export function syncContractorDirectory(options = {}) {
  if (inFlightSync) return inFlightSync;

  const fetchImpl = options.fetchImpl || getFetch();
  inFlightSync = performSync(fetchImpl, options.eventTarget).finally(() => {
    inFlightSync = null;
  });
  return inFlightSync;
}

/* ============================================================
   UPDATE EVENT SUBSCRIPTION
============================================================ */
// Registers `callback(detail)` against the hpal:contractor-directory-updated
// event -- fired whenever ANY source (Monitor's own sync, or this
// module's own successful sync) writes the shared cache. Returns an
// unsubscribe function. In an environment with no real event target
// (e.g. a plain Node test that didn't inject one), this is a safe no-op:
// the returned unsubscribe function does nothing and `callback` is simply
// never called -- it never throws.
export function subscribeContractorDirectoryUpdated(callback, options = {}) {
  const target = options.eventTarget || getDefaultEventTarget();
  if (!target || typeof target.addEventListener !== 'function') {
    return () => {};
  }
  const core = getCore();
  const handler = (event) => callback(event && event.detail);
  target.addEventListener(core.DIRECTORY_UPDATED_EVENT, handler);
  return () => target.removeEventListener(core.DIRECTORY_UPDATED_EVENT, handler);
}

/* ============================================================
   READ ACCESS
============================================================ */
// `source` is 'remote' (this Report instance's own live fetch just
// succeeded), 'shared-cache' (loaded from hpal.contractors.v1, written by
// either Monitor or a prior Report sync -- deliberately never called a
// "Report cache", since it may not be this Report instance's own data),
// or 'none' (nothing available -- callers fall back to the static
// embedded table).
export function getContractorDirectorySnapshot() {
  return {
    source: snapshot.source,
    records: snapshot.records.slice(),
    fetchedAt: snapshot.fetchedAt,
    syncing,
    lastSyncError,
  };
}

export function getContractorDirectoryStatus() {
  return {
    source: snapshot.source,
    recordCount: snapshot.records.length,
    fetchedAt: snapshot.fetchedAt,
    syncing,
    lastSyncError,
  };
}

// Returns the contractor name for a raw workbook DT/vehicle id, resolved
// against the latest synchronized-or-shared-cache snapshot only --
// returns null (never a guess) when the snapshot has no match, so callers
// (Report's profile modules) can fall through to contractor-adapter.js's
// static fallback themselves. This function never touches the static
// table -- keeping that fallback decision in the caller is what lets each
// profile module's existing fallback order stay a single, readable
// precedence chain (synced/shared-cache -> static -> unmatched).
export function lookupContractor(dtId) {
  const key = normalizedKey(dtId);
  if (!key) return null;
  return lookupMap.get(key) || null;
}
