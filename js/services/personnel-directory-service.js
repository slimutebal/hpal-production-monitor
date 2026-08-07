// Personnel Directory read/write-sync service (V2.3 Phase 4).
//
// Mirrors contractor-assignment.js's proven Google Apps Script read
// pattern (plain GET, cache: 'no-store', redirect: 'follow', no custom
// headers, no mode: 'no-cors') for a second, independent data set: the
// report_personnel roster (SPV SCM, FRM SCM, Independent Sampler, PIC 3rd).
// This module never touches contractor-assignment.js or Monitor's
// contractor state.
//
// Online writes (add/edit/deactivate/reactivate) were added in Phase 4 --
// see docs/V2.3_AUTO_WEEK_AND_PERSONNEL_DIRECTORY_ARCHITECTURE.md sections
// 16-18. There is deliberately no offline write queue yet (Phase 5,
// explicitly deferred): every write function below requires connectivity
// and fails cleanly (never silently queues) when it is not available.
//
// Trust boundary: remote/cached data is only ever exposed through the
// module-scoped `snapshot` once it has passed validatePersonnelResponsePayload()
// (remote) or the equivalent cache checks (local). A failed validation never
// touches `snapshot`, so a bad remote response or a corrupted cache can
// never overwrite a previously good in-memory snapshot. A write's own HTTP
// response is never treated as authoritative for the cache either -- every
// successful write is followed by a fresh syncPersonnelDirectory() read
// (Section 18.1's "re-fetch after write" rule), never a manual cache
// mutation.
//
// CRITICAL INVARIANT (added after a live false-success incident: the POST
// for addReportPersonnel returned ok:true and the subsequent GET also
// returned ok:true, so the UI reported success and rendered the new
// record -- but the row never existed in the actual Google Sheet). A
// write is reported as successful ONLY when the specific mutation is
// independently confirmed present in the resynced authoritative records
// (matched by id, with the fields/version the write claims) -- a
// non-erroring POST plus a non-erroring GET is NOT sufficient on its own.
// See verifyRecordAdded/verifyRecordUpdated/verifyRecordActiveState below
// and their use inside writeAndResync().

const PERSONNEL_ENDPOINT = 'https://script.google.com/macros/s/AKfycbz-MHU0nRMFMVJbS0h_oMPKsmcCCHTlGARD8e7GlmUogVPOqGfVQQOcuajPfgHXL2xqzQ/exec';
const CACHE_KEY = 'hpal.personnel.v1';
const CACHE_VERSION = 1;
const API_VERSION = '1.0.0';
const SCHEMA_VERSION = 1;
const FETCH_TIMEOUT_MS = 15000;

// Audit-source label only -- there are no user accounts anywhere in this
// application (V2.3 architecture doc section 6/29). Every write from this
// web app is attributed to this single fixed constant so a row's
// `updated_by` column at least distinguishes "written by the web app"
// from a manual spreadsheet edit; it must never be presented as an
// authenticated identity.
const AUDIT_SOURCE = 'OWNER_WEB_APP';

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

// Accepts a fully-trusted record set: every record valid, every id unique.
// Used identically for a remote payload's `records` and for a loaded local
// cache's `records`, so both paths enforce the exact same trust bar.
//
// Both active and inactive records are accepted here (Phase 4 -- Settings
// must be able to display deactivated personnel, per the architecture
// doc's "Active / Inactive Display" requirement). This does NOT weaken
// Report's own guarantee of consuming active records only: every
// Report-facing read (getActivePersonnelByRole, getActivePicThirdByOrganization
// below) independently filters on `active === true` regardless of what
// the cache itself contains.
export function validatePersonnelRecords(records) {
  if (!Array.isArray(records)) return { ok: false, error: 'records is not an array' };

  const seenIds = new Set();
  for (const record of records) {
    if (!validateRecordShape(record)) return { ok: false, error: 'invalid record shape' };
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
    // Always requests the full roster (active + inactive) -- Settings
    // (Phase 4) must be able to display deactivated personnel behind an
    // Aktif/Nonaktif/Semua filter, and there is exactly one shared cache
    // (hpal.personnel.v1), not a separate active-only vs. full fetch.
    // Report's own accessors still filter to active-only independently
    // (see getActivePersonnelByRole below), so this never leaks inactive
    // records into Report's selectors.
    url.searchParams.set('includeInactive', 'true');
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

// Settings-facing accessor (Phase 4): unlike getActivePersonnelByRole,
// this can also surface inactive records so the four Settings cards can
// render an Aktif/Nonaktif/Semua filter. `status` is 'active' | 'inactive'
// | 'all' (default 'active', matching the architecture doc's required
// default). Report never calls this -- it only ever calls
// getActivePersonnelByRole/getActivePicThirdByOrganization above.
export function getPersonnelByRole(roleType, status = 'active') {
  return snapshot.records
    .filter((record) => {
      if (record.role_type !== roleType) return false;
      if (status === 'active') return record.active === true;
      if (status === 'inactive') return record.active === false;
      return true;
    })
    .sort(compareRecords);
}

/* ============================================================
   WRITE (Phase 4 -- online add/edit/deactivate/reactivate)

   No offline queue: every function below requires connectivity and
   returns a structured failure (never queues, never retries blindly) when
   the network is unavailable or the request fails. Every successful write
   is followed by a fresh syncPersonnelDirectory() read -- a write's own
   response is never used to mutate `snapshot` directly (see file header).
============================================================ */

function isBoolean(value) {
  return typeof value === 'boolean';
}

// Posts one write action using the same text/plain;charset=utf-8 body
// trick contractor-assignment.js's appendListDt action already uses, so
// the browser never issues a CORS preflight against this endpoint (the
// architecture doc requires this transport explicitly). Returns a
// structured { ok, error } result -- never throws, never exposes a raw
// network/parse error message to the caller. On success, also returns the
// server's claimed `record` -- this is an ACKNOWLEDGMENT only, never
// treated as authoritative by itself (see writeAndResync()).
async function performWrite(fetchImpl, body) {
  if (typeof fetchImpl !== 'function') {
    return { ok: false, error: { code: 'NETWORK_UNAVAILABLE', message: 'Network request is not available in this environment.' } };
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  let response;
  try {
    response = await fetchImpl(PERSONNEL_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(body),
      redirect: 'follow',
      signal: controller.signal,
    });
  } catch (_) {
    return { ok: false, error: { code: 'NETWORK_ERROR', message: 'Network request failed.' } };
  } finally {
    clearTimeout(timeoutId);
  }

  if (!response || !response.ok) {
    return { ok: false, error: { code: 'SERVER_ERROR', message: 'Server responded with an error.' } };
  }

  let payload;
  try {
    payload = await response.json();
  } catch (_) {
    return { ok: false, error: { code: 'INVALID_RESPONSE', message: 'Server response was not valid JSON.' } };
  }

  if (!isPlainObject(payload) || payload.ok !== true) {
    const serverError = isPlainObject(payload) && isPlainObject(payload.error) ? payload.error : {};
    return {
      ok: false,
      error: {
        code: isNonEmptyString(serverError.code) ? serverError.code : 'UNKNOWN_ERROR',
        message: isNonEmptyString(serverError.message) ? serverError.message : 'Write request failed.',
        currentVersion: isPositiveInteger(serverError.currentVersion) ? serverError.currentVersion : undefined,
      },
    };
  }

  // payload.ok === true is not enough by itself -- a response claiming
  // success must still name the record it claims to have written, with at
  // least an id and a version, or there is nothing to verify against the
  // resync below and the claim is worthless.
  if (!isPlainObject(payload.record) || !isNonEmptyString(payload.record.id) || !isPositiveInteger(payload.record.version)) {
    return { ok: false, error: { code: 'INVALID_RESPONSE', message: 'Server response did not include a valid written record.' } };
  }

  return { ok: true, record: payload.record };
}

const WRITE_NOT_VISIBLE_MESSAGE = 'Server menerima permintaan, tetapi perubahan belum dapat diverifikasi dari Personnel Directory. Sinkronkan ulang dan periksa Google Sheet.';

// Confirms an addReportPersonnel write is actually observable: the id the
// server claims to have created must exist in the authoritative resync,
// active, and matching every field the server itself returned (not merely
// present under any shape).
function verifyRecordAdded(resyncedRecords, writtenRecord) {
  const match = resyncedRecords.find((r) => r.id === writtenRecord.id);
  if (!match) return false;
  if (match.active !== true) return false;
  if (match.version !== writtenRecord.version) return false;
  if (match.role_type !== writtenRecord.role_type) return false;
  if (normalizeCompareKey(match.name) !== normalizeCompareKey(writtenRecord.name)) return false;
  if (normalizeCompareKey(match.organization) !== normalizeCompareKey(writtenRecord.organization)) return false;
  return true;
}

// Confirms an updateReportPersonnel write is actually observable: same id,
// the exact new version the server claims, and the name/organization the
// server says it wrote.
function verifyRecordUpdated(resyncedRecords, writtenRecord) {
  const match = resyncedRecords.find((r) => r.id === writtenRecord.id);
  if (!match) return false;
  if (match.version !== writtenRecord.version) return false;
  if (normalizeCompareKey(match.name) !== normalizeCompareKey(writtenRecord.name)) return false;
  if (normalizeCompareKey(match.organization) !== normalizeCompareKey(writtenRecord.organization)) return false;
  return true;
}

// Confirms a setReportPersonnelActive write is actually observable: same
// id, the exact new version, and the exact active state the server claims
// to have set (covers both deactivate and reactivate).
function verifyRecordActiveState(resyncedRecords, writtenRecord) {
  const match = resyncedRecords.find((r) => r.id === writtenRecord.id);
  if (!match) return false;
  if (match.version !== writtenRecord.version) return false;
  if (match.active !== writtenRecord.active) return false;
  return true;
}

// Shared write-then-verify-then-resync flow. A POST that merely returns
// ok:true is an ACKNOWLEDGMENT, not proof -- this only reports success once
// `verifyMutation` confirms the exact written record is independently
// observable in a fresh, fully-validated GET of the authoritative
// Personnel Directory. If the write itself fails, no sync is attempted and
// the existing snapshot is left untouched. If the write is acknowledged but
// the resync does not confirm it, the resync's real (unmodified) result is
// still what `snapshot` reflects afterward -- this function never pushes,
// splices, or otherwise fabricates a record into the cache to make a claim
// "look" successful.
async function writeAndResync(fetchImpl, body, verifyMutation) {
  const writeResult = await performWrite(fetchImpl, body);
  if (!writeResult.ok) return writeResult;

  logPersonnelDirectory('[Personnel Directory] write response', {
    action: body.action,
    ok: true,
    id: writeResult.record.id,
    version: writeResult.record.version,
  });

  const syncResult = await syncPersonnelDirectory({ fetchImpl });
  if (!syncResult.ok) {
    return {
      ok: false,
      error: {
        code: 'SYNC_AFTER_WRITE_FAILED',
        message: 'Write succeeded but refreshing the directory failed. Press Sync to retry.',
      },
    };
  }

  const verified = verifyMutation(syncResult.snapshot.records, writeResult.record);

  logPersonnelDirectory('[Personnel Directory] authoritative resync', {
    returned: syncResult.snapshot.records.length,
    foundWrittenId: verified,
  });

  if (!verified) {
    return {
      ok: false,
      error: { code: 'WRITE_NOT_VISIBLE_AFTER_SYNC', message: WRITE_NOT_VISIBLE_MESSAGE },
    };
  }

  return { ok: true, snapshot: syncResult.snapshot };
}

// Safe, non-sensitive debug logging only -- never the endpoint URL, never
// the full dataset, never localStorage contents. Best-effort: a
// console-less environment (some test runners) must never break the write
// flow over a missing console.
function logPersonnelDirectory(label, details) {
  try {
    if (typeof console !== 'undefined' && typeof console.info === 'function') {
      console.info(label, details);
    }
  } catch (_) {
    // Ignored -- logging must never be able to fail a write.
  }
}

// Creates a new personnel record. `role_type`/`name`/`organization` are
// the only caller-supplied fields -- id, created_at, updated_at, version,
// and active are all server-generated (architecture doc, action A).
export function addReportPersonnel({ role_type, name, organization }, options = {}) {
  const fetchImpl = options.fetchImpl || getFetch();
  return writeAndResync(fetchImpl, {
    action: 'addReportPersonnel',
    role_type,
    name: String(name ?? '').trim(),
    organization: String(organization ?? '').trim(),
    updated_by: AUDIT_SOURCE,
    expected_schema_version: SCHEMA_VERSION,
  }, verifyRecordAdded);
}

// Edits name/organization on an existing record. role_type, id, and
// active are immutable through this action (architecture doc, action B) --
// `expected_version` is required so the server can reject a stale edit as
// a VERSION_CONFLICT instead of silently overwriting a concurrent change.
export function updateReportPersonnel({ id, name, organization, expected_version }, options = {}) {
  const fetchImpl = options.fetchImpl || getFetch();
  return writeAndResync(fetchImpl, {
    action: 'updateReportPersonnel',
    id,
    name: String(name ?? '').trim(),
    organization: String(organization ?? '').trim(),
    expected_version,
    updated_by: AUDIT_SOURCE,
  }, verifyRecordUpdated);
}

// Deactivates (active: false) or reactivates (active: true) a record --
// never a physical delete (architecture doc, action C). `expected_version`
// is required for the same optimistic-concurrency reason as
// updateReportPersonnel above.
export function setReportPersonnelActive({ id, active, expected_version }, options = {}) {
  if (!isBoolean(active)) {
    return Promise.resolve({ ok: false, error: { code: 'VALIDATION_ERROR', message: 'active must be a boolean.' } });
  }
  const fetchImpl = options.fetchImpl || getFetch();
  return writeAndResync(fetchImpl, {
    action: 'setReportPersonnelActive',
    id,
    active,
    expected_version,
    updated_by: AUDIT_SOURCE,
  }, verifyRecordActiveState);
}
