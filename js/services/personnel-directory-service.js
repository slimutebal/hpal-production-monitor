// Personnel Directory read-sync service (V2.3 Phase 2-3).
//
// Mirrors contractor-assignment.js's proven Google Apps Script read
// pattern (plain GET, cache: 'no-store', redirect: 'follow', no custom
// headers, no mode: 'no-cors') for a second, independent data set: the
// report_personnel roster (SPV SCM, FRM SCM, Independent Sampler, PIC 3rd).
// This module never touches contractor-assignment.js or Monitor's
// contractor state, and it never writes back to the Google Sheet -- V2.3
// Phase 2-3 is read-only by design (see
// docs/V2.3_AUTO_WEEK_AND_PERSONNEL_DIRECTORY_ARCHITECTURE.md section 17).
//
// Trust boundary: remote/cached data is only ever exposed through the
// module-scoped `snapshot` once it has passed validatePersonnelResponsePayload()
// (remote) or the equivalent cache checks (local). A failed validation never
// touches `snapshot`, so a bad remote response or a corrupted cache can
// never overwrite a previously good in-memory snapshot.

const PERSONNEL_ENDPOINT = 'https://script.google.com/macros/s/AKfycbz-MHU0nRMFMVJbS0h_oMPKsmcCCHTlGARD8e7GlmUogVPOqGfVQQOcuajPfgHXL2xqzQ/exec';
const CACHE_KEY = 'hpal.personnel.v1';
const CACHE_VERSION = 1;
const API_VERSION = '1.0.0';
const SCHEMA_VERSION = 1;
const FETCH_TIMEOUT_MS = 15000;

export const ROLE_TYPES = ['SPV_SCM', 'FRM_SCM', 'SAMPLER', 'PIC_3RD'];
const SCM_ONLY_ROLES = new Set(['SPV_SCM', 'FRM_SCM']);

function createEmptySnapshot() {
  return { source: 'none', records: [], fetchedAt: null, serverGeneratedAt: null };
}

let snapshot = createEmptySnapshot();
let inFlightSync = null;
let syncing = false;
let lastSyncError = null;

function getStorage() {
  try {
    return globalThis.localStorage || null;
  } catch (_) {
    return null;
  }
}

function getFetch() {
  return typeof globalThis.fetch === 'function' ? globalThis.fetch : null;
}

function normalizeCompareKey(value) {
  return String(value ?? '').trim().replace(/\s+/g, ' ').toLowerCase();
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function isPositiveInteger(value) {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

/* ============================================================
   VALIDATION -- pure, DOM-free, network-free
============================================================ */

function validateRecordShape(record) {
  if (!isPlainObject(record)) return false;
  if (!isNonEmptyString(record.id)) return false;
  if (!ROLE_TYPES.includes(record.role_type)) return false;
  if (!isNonEmptyString(record.name)) return false;
  if (!isNonEmptyString(record.organization)) return false;
  if (typeof record.active !== 'boolean') return false;
  if (!isNonEmptyString(record.created_at)) return false;
  if (!isNonEmptyString(record.updated_at)) return false;
  if (!isNonEmptyString(record.updated_by)) return false;
  if (!isPositiveInteger(record.version)) return false;

  // SAMPLER and PIC_3RD deliberately accept any non-empty organization --
  // AWK/ATQ are today's only examples, never a hardcoded allowlist, per the
  // architecture doc's explicit instruction that more sampler organizations
  // may be added later without a code change here.
  if (SCM_ONLY_ROLES.has(record.role_type) && record.organization !== 'SCM') return false;

  return true;
}

// Accepts only a fully-trusted, active-only record set: every record valid,
// every id unique, every record active. Used identically for a remote
// payload's `records` and for a loaded local cache's `records`, so both
// paths enforce the exact same trust bar.
export function validatePersonnelRecords(records) {
  if (!Array.isArray(records)) return { ok: false, error: 'records is not an array' };

  const seenIds = new Set();
  for (const record of records) {
    if (!validateRecordShape(record)) return { ok: false, error: 'invalid record shape' };
    if (record.active !== true) return { ok: false, error: 'inactive record in an active-only set' };
    if (seenIds.has(record.id)) return { ok: false, error: 'duplicate record id' };
    seenIds.add(record.id);
  }

  return { ok: true };
}

function validateCountsShape(counts) {
  if (!isPlainObject(counts)) return false;
  if (!Number.isInteger(counts.returned)) return false;
  if (!Number.isInteger(counts.totalActive)) return false;
  if (!Number.isInteger(counts.totalInactive)) return false;
  if (!isPlainObject(counts.byRole)) return false;
  return true;
}

// Full API-envelope validation (payload.ok/action/apiVersion/schemaVersion,
// counts, and every record). Exported so it is independently unit-testable
// against fixture JSON, without any fetch/localStorage/DOM involved.
export function validatePersonnelResponsePayload(payload) {
  if (!isPlainObject(payload)) return { ok: false, error: 'payload is not an object' };
  if (payload.ok !== true) return { ok: false, error: 'payload.ok is not true' };
  if (payload.action !== 'listReportPersonnel') return { ok: false, error: 'unexpected action' };
  if (payload.apiVersion !== API_VERSION) return { ok: false, error: 'unsupported apiVersion' };
  if (payload.schemaVersion !== SCHEMA_VERSION) return { ok: false, error: 'unsupported schemaVersion' };
  if (!Array.isArray(payload.records)) return { ok: false, error: 'records is not an array' };
  if (!validateCountsShape(payload.counts)) return { ok: false, error: 'invalid counts object' };
  if (payload.counts.returned !== payload.records.length) return { ok: false, error: 'counts.returned mismatch' };

  const recordsCheck = validatePersonnelRecords(payload.records);
  if (!recordsCheck.ok) return recordsCheck;

  // Optional cross-check, not a blind trust of the server: byRole must
  // agree with what the records array actually contains for any role the
  // server chose to report.
  const actualByRole = {};
  payload.records.forEach((record) => {
    actualByRole[record.role_type] = (actualByRole[record.role_type] || 0) + 1;
  });
  for (const role of Object.keys(payload.counts.byRole)) {
    const reported = payload.counts.byRole[role];
    const actual = actualByRole[role] || 0;
    if (reported !== actual) return { ok: false, error: `counts.byRole.${role} mismatch` };
  }

  return { ok: true };
}

/* ============================================================
   LOCAL CACHE
============================================================ */

// Loads and validates hpal.personnel.v1, replacing the in-memory snapshot
// only on success. Called once when Settings initializes (never on every
// route visit) -- a malformed/corrupted/wrong-version cache is rejected
// without throwing and without touching whatever snapshot already exists.
export function loadCachedPersonnelDirectory() {
  const storage = getStorage();
  if (!storage) return null;

  let raw;
  try {
    raw = storage.getItem(CACHE_KEY);
  } catch (_) {
    return null;
  }
  if (!raw) return null;

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (_) {
    return null;
  }

  if (!isPlainObject(parsed)) return null;
  if (parsed.cacheVersion !== CACHE_VERSION) return null;
  if (parsed.schemaVersion !== SCHEMA_VERSION) return null;

  const recordsCheck = validatePersonnelRecords(parsed.records);
  if (!recordsCheck.ok) return null;

  snapshot = {
    source: 'cached',
    records: parsed.records,
    fetchedAt: isNonEmptyString(parsed.fetchedAt) ? parsed.fetchedAt : null,
    serverGeneratedAt: isNonEmptyString(parsed.serverGeneratedAt) ? parsed.serverGeneratedAt : null,
  };
  return getPersonnelDirectorySnapshot();
}

// Returns the client-generated fetchedAt on success, or null if the cache
// could not be written (e.g. localStorage unavailable/full) -- a write
// failure here must never surface as an uncaught error or block the sync
// result, since the freshly-fetched records are still valid to display.
function writeCache(records, serverGeneratedAt) {
  const storage = getStorage();
  if (!storage) return null;

  const fetchedAt = new Date().toISOString();
  const shape = {
    cacheVersion: CACHE_VERSION,
    apiVersion: API_VERSION,
    schemaVersion: SCHEMA_VERSION,
    source: 'remote',
    fetchedAt,
    serverGeneratedAt: serverGeneratedAt || null,
    records,
  };

  try {
    storage.setItem(CACHE_KEY, JSON.stringify(shape));
  } catch (_) {
    return null;
  }
  return fetchedAt;
}

export function clearPersonnelDirectoryCache() {
  const storage = getStorage();
  if (storage) {
    try {
      storage.removeItem(CACHE_KEY);
    } catch (_) {
      // Ignored -- clearing is best-effort; the in-memory snapshot reset
      // below is what actually matters to the rest of the application.
    }
  }
  snapshot = createEmptySnapshot();
  lastSyncError = null;
}

/* ============================================================
   REMOTE SYNC
============================================================ */

async function performSync(fetchImpl) {
  syncing = true;
  try {
    if (typeof fetchImpl !== 'function') {
      lastSyncError = 'Network request is not available in this environment.';
      return { ok: false, error: lastSyncError, snapshot: getPersonnelDirectorySnapshot() };
    }

    const url = new URL(PERSONNEL_ENDPOINT);
    url.searchParams.set('action', 'listReportPersonnel');
    url.searchParams.set('t', String(Date.now()));

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    let response;
    try {
      response = await fetchImpl(url.toString(), {
        method: 'GET',
        cache: 'no-store',
        redirect: 'follow',
        signal: controller.signal,
      });
    } catch (_) {
      lastSyncError = 'Network request failed.';
      return { ok: false, error: lastSyncError, snapshot: getPersonnelDirectorySnapshot() };
    } finally {
      clearTimeout(timeoutId);
    }

    if (!response || !response.ok) {
      lastSyncError = 'Server responded with an error.';
      return { ok: false, error: lastSyncError, snapshot: getPersonnelDirectorySnapshot() };
    }

    let payload;
    try {
      payload = await response.json();
    } catch (_) {
      lastSyncError = 'Server response was not valid JSON.';
      return { ok: false, error: lastSyncError, snapshot: getPersonnelDirectorySnapshot() };
    }

    const validation = validatePersonnelResponsePayload(payload);
    if (!validation.ok) {
      lastSyncError = 'Server response failed validation.';
      return { ok: false, error: lastSyncError, snapshot: getPersonnelDirectorySnapshot() };
    }

    const fetchedAt = writeCache(payload.records, payload.generatedAt) || new Date().toISOString();
    snapshot = {
      source: 'remote',
      records: payload.records,
      fetchedAt,
      serverGeneratedAt: isNonEmptyString(payload.generatedAt) ? payload.generatedAt : null,
    };
    lastSyncError = null;
    return { ok: true, snapshot: getPersonnelDirectorySnapshot() };
  } finally {
    syncing = false;
  }
}

// Deliberately not `async` itself: the in-flight guard must run and assign
// `inFlightSync` synchronously, before any `await`, so two calls issued
// back-to-back in the same tick (e.g. a doubled click event) are guaranteed
// to see the same in-flight promise rather than racing to start two fetches.
export function syncPersonnelDirectory(options = {}) {
  if (inFlightSync) return inFlightSync;

  const fetchImpl = options.fetchImpl || getFetch();
  inFlightSync = performSync(fetchImpl).finally(() => {
    inFlightSync = null;
  });
  return inFlightSync;
}

/* ============================================================
   READ ACCESS
============================================================ */

export function getPersonnelDirectorySnapshot() {
  return {
    source: snapshot.source,
    records: snapshot.records.slice(),
    fetchedAt: snapshot.fetchedAt,
    serverGeneratedAt: snapshot.serverGeneratedAt,
    syncing,
    lastSyncError,
  };
}

function compareRecords(a, b) {
  const orgCompare = normalizeCompareKey(a.organization).localeCompare(normalizeCompareKey(b.organization));
  if (orgCompare !== 0) return orgCompare;
  const nameCompare = normalizeCompareKey(a.name).localeCompare(normalizeCompareKey(b.name));
  if (nameCompare !== 0) return nameCompare;
  return String(a.id).localeCompare(String(b.id));
}

export function getActivePersonnelByRole(roleType) {
  return snapshot.records
    .filter((record) => record.role_type === roleType && record.active === true)
    .sort(compareRecords);
}

export function getActivePicThirdByOrganization(organization) {
  const key = normalizeCompareKey(organization);
  return snapshot.records
    .filter((record) => record.role_type === 'PIC_3RD' && record.active === true && normalizeCompareKey(record.organization) === key)
    .sort(compareRecords);
}
