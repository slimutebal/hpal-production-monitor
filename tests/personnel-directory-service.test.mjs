// Personnel Directory service (V2.3 Phase 2-3) tests.
//
// Run with Node's built-in test runner (Node 18+, zero new dependencies):
//
//   node --test tests/personnel-directory-service.test.mjs
//
// Never calls the live Google Apps Script endpoint -- every network path
// goes through a mock `globalThis.fetch`, and every cache path goes
// through a mock `globalThis.localStorage` (a Map-backed Storage
// look-alike), since Node has no built-in localStorage. The service module
// itself is a singleton (module-scoped `snapshot`), so every test that
// touches sync/cache state starts from a clean slate via beforeEach.

import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  validatePersonnelRecords,
  validatePersonnelResponsePayload,
  loadCachedPersonnelDirectory,
  syncPersonnelDirectory,
  getPersonnelDirectorySnapshot,
  getActivePersonnelByRole,
  getActivePicThirdByOrganization,
  getPersonnelByRole,
  clearPersonnelDirectoryCache,
  addReportPersonnel,
  updateReportPersonnel,
  setReportPersonnelActive,
} from '../js/services/personnel-directory-service.js';
import { initializeLicense, _buildValidLicenseRecordForTests } from '../js/services/license-service.js';

const CACHE_KEY = 'hpal.personnel.v1';
const LICENSE_KEY = 'hpal.license.v1';

function createMockStorage() {
  const map = new Map();
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => {
      map.set(key, String(value));
    },
    removeItem: (key) => {
      map.delete(key);
    },
  };
}

// V2.3 Phase 8: every write/sync function in personnel-directory-service.js
// now independently checks licenseService.hasFullAccess() (see that
// module's own header comment). This file predates licensing and tests
// personnel-directory-service.js's OWN behavior in isolation, so every
// test here runs under a FULL_ACCESS baseline installed via license-
// service.js's _buildValidLicenseRecordForTests() fixture -- which
// verifies against the real production verifier WITHOUT ever needing the
// actual plaintext key (see that helper's own doc comment). License-guard
// behavior itself (MONITOR_ONLY blocking these same functions) has its
// own dedicated coverage in tests/personnel-directory-license-guard.test.mjs.
function installMockStorage() {
  const storage = createMockStorage();
  globalThis.localStorage = storage;
  storage.setItem(LICENSE_KEY, JSON.stringify(_buildValidLicenseRecordForTests()));
  initializeLicense();
  return storage;
}

function mockResponse(payload, { ok = true } = {}) {
  return {
    ok,
    json: async () => payload,
  };
}

function makeRecord(overrides = {}) {
  return {
    id: 'frm-scm-adi-guna',
    role_type: 'FRM_SCM',
    name: 'Adi Guna',
    organization: 'SCM',
    active: true,
    created_at: '2026-08-06T16:55:00+08:00',
    updated_at: '2026-08-06T16:55:00+08:00',
    updated_by: 'OWNER_MANUAL',
    version: 1,
    ...overrides,
  };
}

// Builds a full API envelope around `records`, auto-deriving counts.returned
// and counts.byRole so per-test fixtures stay small and self-consistent.
function buildPayload(records, overrides = {}) {
  const byRole = {};
  records.forEach((record) => {
    byRole[record.role_type] = (byRole[record.role_type] || 0) + 1;
  });

  return {
    ok: true,
    action: 'listReportPersonnel',
    apiVersion: '1.0.0',
    schemaVersion: 1,
    generatedAt: '2026-08-06T09:00:00.000Z',
    filters: { role_type: null, organization: null, includeInactive: false },
    counts: {
      returned: records.length,
      totalActive: records.length,
      totalInactive: 0,
      byRole,
    },
    records,
    ...overrides,
  };
}

function buildValidPayload() {
  const records = [];
  for (let i = 1; i <= 3; i += 1) {
    records.push(makeRecord({ id: `spv-scm-${i}`, role_type: 'SPV_SCM', name: `SPV ${i}` }));
  }
  for (let i = 1; i <= 10; i += 1) {
    records.push(makeRecord({ id: `frm-scm-${i}`, role_type: 'FRM_SCM', name: `FRM ${i}` }));
  }
  records.push(makeRecord({ id: 'sampler-awk', role_type: 'SAMPLER', name: 'AWK', organization: 'AWK' }));
  records.push(makeRecord({ id: 'sampler-atq', role_type: 'SAMPLER', name: 'ATQ', organization: 'ATQ' }));
  records.push(makeRecord({ id: 'pic3rd-laode', role_type: 'PIC_3RD', name: 'La Ode Osardi', organization: 'AWK' }));
  records.push(makeRecord({ id: 'pic3rd-khalifa', role_type: 'PIC_3RD', name: 'Khalifa Akbar', organization: 'ATQ' }));
  return buildPayload(records);
}

function buildValidCacheJson(records, overrides = {}) {
  return JSON.stringify({
    cacheVersion: 1,
    apiVersion: '1.0.0',
    schemaVersion: 1,
    source: 'remote',
    fetchedAt: '2026-08-06T09:00:00.000Z',
    serverGeneratedAt: '2026-08-06T09:00:00.000Z',
    records,
    ...overrides,
  });
}

beforeEach(() => {
  installMockStorage();
  clearPersonnelDirectoryCache();
  delete globalThis.fetch;
});

describe('validatePersonnelResponsePayload() -- pure, no DOM/network', () => {
  test('1. valid API response accepted', () => {
    assert.equal(validatePersonnelResponsePayload(buildValidPayload()).ok, true);
  });

  test('2. wrong apiVersion rejected', () => {
    const payload = buildValidPayload();
    payload.apiVersion = '9.9.9';
    assert.equal(validatePersonnelResponsePayload(payload).ok, false);
  });

  test('3. wrong schemaVersion rejected', () => {
    const payload = buildValidPayload();
    payload.schemaVersion = 2;
    assert.equal(validatePersonnelResponsePayload(payload).ok, false);
  });

  test('4. payload ok:false rejected', () => {
    const payload = buildValidPayload();
    payload.ok = false;
    assert.equal(validatePersonnelResponsePayload(payload).ok, false);
  });

  test('5. duplicate ID rejected', () => {
    const records = [makeRecord({ id: 'dup' }), makeRecord({ id: 'dup', name: 'Someone Else' })];
    assert.equal(validatePersonnelResponsePayload(buildPayload(records)).ok, false);
  });

  test('6. invalid role_type rejected', () => {
    const records = [makeRecord({ role_type: 'NOT_A_ROLE' })];
    assert.equal(validatePersonnelResponsePayload(buildPayload(records)).ok, false);
  });

  test('7. missing name rejected', () => {
    const records = [makeRecord({ name: '' })];
    assert.equal(validatePersonnelResponsePayload(buildPayload(records)).ok, false);
  });

  test('8. SPV_SCM with non-SCM organization rejected', () => {
    const records = [makeRecord({ role_type: 'SPV_SCM', organization: 'AWK' })];
    assert.equal(validatePersonnelResponsePayload(buildPayload(records)).ok, false);
  });

  test('9. FRM_SCM with non-SCM organization rejected', () => {
    const records = [makeRecord({ role_type: 'FRM_SCM', organization: 'ATQ' })];
    assert.equal(validatePersonnelResponsePayload(buildPayload(records)).ok, false);
  });

  test('10. SAMPLER with a future organization is accepted (no AWK/ATQ allowlist)', () => {
    const records = [makeRecord({ id: 'sampler-new', role_type: 'SAMPLER', name: 'NEWORG', organization: 'NEWORG' })];
    assert.equal(validatePersonnelResponsePayload(buildPayload(records)).ok, true);
  });

  test('11. PIC_3RD with a future organization is accepted (no AWK/ATQ allowlist)', () => {
    const records = [makeRecord({ id: 'pic3rd-new', role_type: 'PIC_3RD', name: 'Someone', organization: 'NEWORG' })];
    assert.equal(validatePersonnelResponsePayload(buildPayload(records)).ok, true);
  });

  test('12. active:false accepted (Phase 4 -- Settings must see inactive records)', () => {
    const records = [makeRecord({ active: false })];
    assert.equal(validatePersonnelResponsePayload(buildPayload(records)).ok, true);
  });

  test('13. counts.returned mismatch rejected', () => {
    const payload = buildPayload([makeRecord()]);
    payload.counts.returned = 2;
    assert.equal(validatePersonnelResponsePayload(payload).ok, false);
  });
});

describe('Local cache validation', () => {
  test('14. valid cache accepted', () => {
    const storage = globalThis.localStorage;
    storage.setItem(CACHE_KEY, buildValidCacheJson([makeRecord()]));

    const result = loadCachedPersonnelDirectory();
    assert.ok(result);
    assert.equal(result.records.length, 1);
    assert.equal(getPersonnelDirectorySnapshot().source, 'cached');
  });

  test('15. malformed JSON cache rejected, without throwing', () => {
    const storage = globalThis.localStorage;
    storage.setItem(CACHE_KEY, '{not valid json');

    assert.doesNotThrow(() => {
      const result = loadCachedPersonnelDirectory();
      assert.equal(result, null);
    });
  });

  test('16. wrong cacheVersion rejected', () => {
    const storage = globalThis.localStorage;
    storage.setItem(CACHE_KEY, buildValidCacheJson([makeRecord()], { cacheVersion: 2 }));

    assert.equal(loadCachedPersonnelDirectory(), null);
  });
});

describe('Remote sync -- cache/snapshot integrity', () => {
  test('17. corrupted cache does not replace a previous valid in-memory snapshot', async () => {
    const storage = globalThis.localStorage;
    globalThis.fetch = async () => mockResponse(buildValidPayload());

    await syncPersonnelDirectory();
    assert.equal(getPersonnelDirectorySnapshot().records.length, 17);

    storage.setItem(CACHE_KEY, 'not json at all');
    const result = loadCachedPersonnelDirectory();

    assert.equal(result, null);
    assert.equal(getPersonnelDirectorySnapshot().records.length, 17);
  });

  test('18. remote failure preserves a valid cache', async () => {
    globalThis.fetch = async () => mockResponse(buildValidPayload());
    await syncPersonnelDirectory();
    assert.equal(getPersonnelDirectorySnapshot().records.length, 17);

    globalThis.fetch = async () => {
      throw new Error('network down');
    };
    const result = await syncPersonnelDirectory();

    assert.equal(result.ok, false);
    assert.equal(getPersonnelDirectorySnapshot().records.length, 17);
  });

  test('19. successful sync replaces the persisted cache', async () => {
    const storage = globalThis.localStorage;

    globalThis.fetch = async () => mockResponse(buildPayload([makeRecord({ id: 'a' })]));
    await syncPersonnelDirectory();

    globalThis.fetch = async () => mockResponse(
      buildPayload([makeRecord({ id: 'b' }), makeRecord({ id: 'c', name: 'Other Name' })])
    );
    const result = await syncPersonnelDirectory();

    assert.equal(result.ok, true);
    assert.equal(result.snapshot.records.length, 2);

    const stored = JSON.parse(storage.getItem(CACHE_KEY));
    assert.equal(stored.records.length, 2);
  });
});

describe('Deterministic filtering and sorting', () => {
  test('20. sorting is deterministic (organization, then name, then id)', () => {
    const records = [
      makeRecord({ id: 'z', role_type: 'FRM_SCM', name: 'Zeta', organization: 'SCM' }),
      makeRecord({ id: 'a', role_type: 'FRM_SCM', name: 'Alpha', organization: 'SCM' }),
      makeRecord({ id: 'm', role_type: 'FRM_SCM', name: 'Alpha', organization: 'SCM' }),
    ];
    globalThis.localStorage.setItem(CACHE_KEY, buildValidCacheJson(records));
    loadCachedPersonnelDirectory();

    const sorted = getActivePersonnelByRole('FRM_SCM');
    assert.deepEqual(sorted.map((record) => record.id), ['a', 'm', 'z']);
  });

  test('21. PIC_3RD filtering by organization is case-insensitive', () => {
    const records = [
      makeRecord({ id: 'pic-awk', role_type: 'PIC_3RD', name: 'La Ode Osardi', organization: 'AWK' }),
      makeRecord({ id: 'pic-atq', role_type: 'PIC_3RD', name: 'Khalifa Akbar', organization: 'ATQ' }),
    ];
    globalThis.localStorage.setItem(CACHE_KEY, buildValidCacheJson(records));
    loadCachedPersonnelDirectory();

    const result = getActivePicThirdByOrganization('awk');
    assert.equal(result.length, 1);
    assert.equal(result[0].id, 'pic-awk');
  });
});

describe('Sync concurrency and failure safety', () => {
  test('22. concurrent sync calls reuse one in-flight request', async () => {
    let callCount = 0;
    globalThis.fetch = async () => {
      callCount += 1;
      await new Promise((resolve) => setTimeout(resolve, 10));
      return mockResponse(buildValidPayload());
    };

    const first = syncPersonnelDirectory();
    const second = syncPersonnelDirectory();
    assert.equal(first, second);

    await Promise.all([first, second]);
    assert.equal(callCount, 1);
  });

  test('23. network failure returns a safe service error, never raw internals', async () => {
    globalThis.fetch = async () => {
      throw new Error('ECONNRESET some internal socket detail');
    };

    const result = await syncPersonnelDirectory();
    assert.equal(result.ok, false);
    assert.equal(typeof result.error, 'string');
    assert.doesNotMatch(result.error, /ECONNRESET/);
  });
});

describe('getPersonnelByRole() -- Settings status filter (Phase 4)', () => {
  function seedMixedRecords() {
    const records = [
      makeRecord({ id: 'a', role_type: 'FRM_SCM', name: 'Active One', active: true }),
      makeRecord({ id: 'b', role_type: 'FRM_SCM', name: 'Inactive One', active: false }),
    ];
    globalThis.localStorage.setItem(CACHE_KEY, buildValidCacheJson(records));
    loadCachedPersonnelDirectory();
  }

  test('default status is active-only', () => {
    seedMixedRecords();
    assert.deepEqual(getPersonnelByRole('FRM_SCM').map((r) => r.id), ['a']);
  });

  test("status: 'inactive' returns only inactive records", () => {
    seedMixedRecords();
    assert.deepEqual(getPersonnelByRole('FRM_SCM', 'inactive').map((r) => r.id), ['b']);
  });

  test("status: 'all' returns both active and inactive records", () => {
    seedMixedRecords();
    assert.equal(getPersonnelByRole('FRM_SCM', 'all').length, 2);
  });
});

describe('Write actions -- add/update/setActive (Phase 4)', () => {
  function mockWriteThenSyncFetch(writeResponse, syncPayload = buildValidPayload()) {
    return async (url, options = {}) => {
      if (options.method === 'POST') return mockResponse(writeResponse);
      return mockResponse(syncPayload);
    };
  }

  // Regression coverage for a live incident: a personnel POST returned
  // ok:true and the subsequent GET also returned ok:true, so the UI
  // reported success and rendered a new record -- but the row never
  // existed in the actual Google Sheet, because nothing cross-checked
  // that the specific written record was actually present in the
  // resynced authoritative data. Every test below exercises that
  // cross-check (verifyRecordAdded/verifyRecordUpdated/
  // verifyRecordActiveState inside writeAndResync()).

  test('addReportPersonnel: success ONLY when the authoritative GET actually contains the new id (task case 2)', async () => {
    const newRecord = makeRecord({ id: 'spv-new', role_type: 'SPV_SCM', name: 'New Person', organization: 'SCM', version: 1 });
    globalThis.fetch = mockWriteThenSyncFetch(
      { ok: true, action: 'addReportPersonnel', apiVersion: '1.0.0', schemaVersion: 1, record: newRecord },
      buildPayload([makeRecord({ id: 'spv-scm-1' }), newRecord])
    );

    const result = await addReportPersonnel({ role_type: 'SPV_SCM', name: 'New Person', organization: 'SCM' });

    assert.equal(result.ok, true);
    assert.equal(result.snapshot.records.length, 2);
    assert.ok(result.snapshot.records.some((r) => r.id === 'spv-new'));
  });

  test('addReportPersonnel: POST ok but the authoritative GET does NOT contain the new id -> failure, never a false success (task case 1)', async () => {
    const claimedRecord = makeRecord({ id: 'spv-ghost', role_type: 'SPV_SCM', name: 'Ghost Person', organization: 'SCM', version: 1 });
    // This is the exact shape of the live incident: POST says ok:true,
    // but the GET that follows shows the Sheet was never actually
    // mutated -- spv-ghost is nowhere in it.
    globalThis.fetch = mockWriteThenSyncFetch(
      { ok: true, action: 'addReportPersonnel', apiVersion: '1.0.0', schemaVersion: 1, record: claimedRecord },
      buildPayload([makeRecord({ id: 'spv-scm-1' })])
    );

    const result = await addReportPersonnel({ role_type: 'SPV_SCM', name: 'Ghost Person', organization: 'SCM' });

    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'WRITE_NOT_VISIBLE_AFTER_SYNC');
  });

  test('addReportPersonnel: POST ok but the authoritative GET reports a different version for the same id -> failure (task case 3)', async () => {
    const claimedRecord = makeRecord({ id: 'spv-new', role_type: 'SPV_SCM', name: 'New Person', organization: 'SCM', version: 1 });
    const staleReflection = makeRecord({ id: 'spv-new', role_type: 'SPV_SCM', name: 'New Person', organization: 'SCM', version: 2 });
    globalThis.fetch = mockWriteThenSyncFetch(
      { ok: true, action: 'addReportPersonnel', apiVersion: '1.0.0', schemaVersion: 1, record: claimedRecord },
      buildPayload([staleReflection])
    );

    const result = await addReportPersonnel({ role_type: 'SPV_SCM', name: 'New Person', organization: 'SCM' });

    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'WRITE_NOT_VISIBLE_AFTER_SYNC');
  });

  test('frontend never trusts the POST record over the authoritative GET record -- a field mismatch at the same id/version fails verification (task case 7)', async () => {
    const claimedRecord = makeRecord({ id: 'spv-new', role_type: 'SPV_SCM', name: 'POST Claimed Name', organization: 'SCM', version: 1 });
    // Same id/version, but the authoritative GET disagrees on the name --
    // must never be papered over by trusting the POST response as if it
    // were itself authoritative.
    const authoritative = makeRecord({ id: 'spv-new', role_type: 'SPV_SCM', name: 'GET Authoritative Name', organization: 'SCM', version: 1 });
    globalThis.fetch = mockWriteThenSyncFetch(
      { ok: true, action: 'addReportPersonnel', apiVersion: '1.0.0', schemaVersion: 1, record: claimedRecord },
      buildPayload([authoritative])
    );

    const result = await addReportPersonnel({ role_type: 'SPV_SCM', name: 'POST Claimed Name', organization: 'SCM' });

    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'WRITE_NOT_VISIBLE_AFTER_SYNC');
  });

  test('cache is left exactly as the authoritative GET returned it when write verification fails -- no fabricated merge (task case 8)', async () => {
    const claimedRecord = makeRecord({ id: 'spv-ghost', role_type: 'SPV_SCM', name: 'Ghost Person', organization: 'SCM', version: 1 });
    const actualServerState = [makeRecord({ id: 'spv-scm-1', role_type: 'SPV_SCM', name: 'Existing Person', organization: 'SCM' })];
    globalThis.fetch = mockWriteThenSyncFetch(
      { ok: true, action: 'addReportPersonnel', apiVersion: '1.0.0', schemaVersion: 1, record: claimedRecord },
      buildPayload(actualServerState)
    );

    const result = await addReportPersonnel({ role_type: 'SPV_SCM', name: 'Ghost Person', organization: 'SCM' });
    assert.equal(result.ok, false);

    const snapshot = getPersonnelDirectorySnapshot();
    assert.deepEqual(snapshot.records, actualServerState);
  });

  test('updateReportPersonnel: success ONLY when the authoritative GET reflects the new name/organization/version (task case 4)', async () => {
    const updatedRecord = makeRecord({ id: 'frm-scm-1', role_type: 'FRM_SCM', name: 'Renamed Person', organization: 'SCM', version: 2 });
    globalThis.fetch = mockWriteThenSyncFetch(
      { ok: true, action: 'updateReportPersonnel', apiVersion: '1.0.0', schemaVersion: 1, record: updatedRecord },
      buildPayload([updatedRecord])
    );

    const result = await updateReportPersonnel({ id: 'frm-scm-1', name: 'Renamed Person', organization: 'SCM', expected_version: 1 });

    assert.equal(result.ok, true);
    assert.equal(result.snapshot.records[0].name, 'Renamed Person');
  });

  test('updateReportPersonnel: POST ok but GET still shows the OLD name -> failure, never a false success', async () => {
    const claimedRecord = makeRecord({ id: 'frm-scm-1', role_type: 'FRM_SCM', name: 'Renamed Person', organization: 'SCM', version: 2 });
    const staleReflection = makeRecord({ id: 'frm-scm-1', role_type: 'FRM_SCM', name: 'Original Name', organization: 'SCM', version: 1 });
    globalThis.fetch = mockWriteThenSyncFetch(
      { ok: true, action: 'updateReportPersonnel', apiVersion: '1.0.0', schemaVersion: 1, record: claimedRecord },
      buildPayload([staleReflection])
    );

    const result = await updateReportPersonnel({ id: 'frm-scm-1', name: 'Renamed Person', organization: 'SCM', expected_version: 1 });

    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'WRITE_NOT_VISIBLE_AFTER_SYNC');
  });

  test('setReportPersonnelActive(false): success ONLY when the authoritative GET reflects active:false (task case 5)', async () => {
    const deactivatedRecord = makeRecord({ id: 'frm-scm-1', role_type: 'FRM_SCM', name: 'Adi Guna', organization: 'SCM', active: false, version: 2 });
    globalThis.fetch = mockWriteThenSyncFetch(
      { ok: true, action: 'setReportPersonnelActive', apiVersion: '1.0.0', schemaVersion: 1, record: deactivatedRecord },
      buildPayload([deactivatedRecord])
    );

    const result = await setReportPersonnelActive({ id: 'frm-scm-1', active: false, expected_version: 1 });

    assert.equal(result.ok, true);
    assert.equal(result.snapshot.records[0].active, false);
  });

  test('setReportPersonnelActive(false): POST ok but GET still shows active:true -> failure', async () => {
    const claimedRecord = makeRecord({ id: 'frm-scm-1', role_type: 'FRM_SCM', name: 'Adi Guna', organization: 'SCM', active: false, version: 2 });
    const staleReflection = makeRecord({ id: 'frm-scm-1', role_type: 'FRM_SCM', name: 'Adi Guna', organization: 'SCM', active: true, version: 1 });
    globalThis.fetch = mockWriteThenSyncFetch(
      { ok: true, action: 'setReportPersonnelActive', apiVersion: '1.0.0', schemaVersion: 1, record: claimedRecord },
      buildPayload([staleReflection])
    );

    const result = await setReportPersonnelActive({ id: 'frm-scm-1', active: false, expected_version: 1 });

    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'WRITE_NOT_VISIBLE_AFTER_SYNC');
  });

  test('setReportPersonnelActive(true): success ONLY when the authoritative GET reflects active:true (task case 6)', async () => {
    const reactivatedRecord = makeRecord({ id: 'frm-scm-1', role_type: 'FRM_SCM', name: 'Adi Guna', organization: 'SCM', active: true, version: 2 });
    globalThis.fetch = mockWriteThenSyncFetch(
      { ok: true, action: 'setReportPersonnelActive', apiVersion: '1.0.0', schemaVersion: 1, record: reactivatedRecord },
      buildPayload([reactivatedRecord])
    );

    const result = await setReportPersonnelActive({ id: 'frm-scm-1', active: true, expected_version: 1 });

    assert.equal(result.ok, true);
    assert.equal(result.snapshot.records[0].active, true);
  });

  test('setReportPersonnelActive(true): POST ok but GET still shows active:false -> failure', async () => {
    const claimedRecord = makeRecord({ id: 'frm-scm-1', role_type: 'FRM_SCM', name: 'Adi Guna', organization: 'SCM', active: true, version: 2 });
    const staleReflection = makeRecord({ id: 'frm-scm-1', role_type: 'FRM_SCM', name: 'Adi Guna', organization: 'SCM', active: false, version: 1 });
    globalThis.fetch = mockWriteThenSyncFetch(
      { ok: true, action: 'setReportPersonnelActive', apiVersion: '1.0.0', schemaVersion: 1, record: claimedRecord },
      buildPayload([staleReflection])
    );

    const result = await setReportPersonnelActive({ id: 'frm-scm-1', active: true, expected_version: 1 });

    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'WRITE_NOT_VISIBLE_AFTER_SYNC');
  });

  test('addReportPersonnel: a POST response missing a valid record is rejected before any resync is attempted', async () => {
    let syncAttempted = false;
    globalThis.fetch = async (url, options = {}) => {
      if (options.method === 'POST') return mockResponse({ ok: true, action: 'addReportPersonnel', apiVersion: '1.0.0', schemaVersion: 1 });
      syncAttempted = true;
      return mockResponse(buildValidPayload());
    };

    const result = await addReportPersonnel({ role_type: 'SPV_SCM', name: 'New Person', organization: 'SCM' });

    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'INVALID_RESPONSE');
    assert.equal(syncAttempted, false);
  });

  test('updateReportPersonnel: a VERSION_CONFLICT from the server is surfaced without ever resyncing', async () => {
    let syncAttempted = false;
    globalThis.fetch = async (url, options = {}) => {
      if (options.method === 'POST') {
        return mockResponse({ ok: false, error: { code: 'VERSION_CONFLICT', message: 'stale', currentVersion: 4 } });
      }
      syncAttempted = true;
      return mockResponse(buildValidPayload());
    };

    const result = await updateReportPersonnel({ id: 'frm-scm-1', name: 'Renamed', organization: 'SCM', expected_version: 1 });

    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'VERSION_CONFLICT');
    assert.equal(result.error.currentVersion, 4);
    assert.equal(syncAttempted, false);
  });

  test('addReportPersonnel: a DUPLICATE_PERSONNEL error from the server is surfaced as-is', async () => {
    globalThis.fetch = async (url, options = {}) => {
      if (options.method === 'POST') return mockResponse({ ok: false, error: { code: 'DUPLICATE_PERSONNEL', message: 'Already exists.' } });
      return mockResponse(buildValidPayload());
    };

    const result = await addReportPersonnel({ role_type: 'SPV_SCM', name: 'Dup', organization: 'SCM' });

    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'DUPLICATE_PERSONNEL');
  });

  test('setReportPersonnelActive: a network failure never throws and returns a structured error', async () => {
    globalThis.fetch = async () => {
      throw new Error('offline');
    };

    const result = await setReportPersonnelActive({ id: 'x', active: false, expected_version: 1 });

    assert.equal(result.ok, false);
    assert.equal(typeof result.error.message, 'string');
  });

  test('setReportPersonnelActive: a non-boolean active is rejected locally with no network call at all', async () => {
    let called = false;
    globalThis.fetch = async () => {
      called = true;
      return mockResponse({ ok: true });
    };

    const result = await setReportPersonnelActive({ id: 'x', active: 'yes', expected_version: 1 });

    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'VALIDATION_ERROR');
    assert.equal(called, false);
  });

  test('a write that succeeds but whose resync fails surfaces SYNC_AFTER_WRITE_FAILED, not a false success', async () => {
    globalThis.fetch = async (url, options = {}) => {
      if (options.method === 'POST') {
        return mockResponse({ ok: true, action: 'setReportPersonnelActive', apiVersion: '1.0.0', schemaVersion: 1, record: makeRecord() });
      }
      throw new Error('network down for resync');
    };

    const result = await setReportPersonnelActive({ id: 'x', active: true, expected_version: 1 });

    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'SYNC_AFTER_WRITE_FAILED');
  });
});

describe('validatePersonnelRecords() -- exported for independent reuse', () => {
  test('accepts an empty array', () => {
    assert.equal(validatePersonnelRecords([]).ok, true);
  });

  test('rejects a non-array', () => {
    assert.equal(validatePersonnelRecords(null).ok, false);
  });
});

describe('clearPersonnelDirectoryCache()', () => {
  test('resets the in-memory snapshot and removes the stored cache', async () => {
    globalThis.fetch = async () => mockResponse(buildValidPayload());
    await syncPersonnelDirectory();
    assert.equal(getPersonnelDirectorySnapshot().records.length, 17);

    clearPersonnelDirectoryCache();

    assert.equal(getPersonnelDirectorySnapshot().records.length, 0);
    assert.equal(getPersonnelDirectorySnapshot().source, 'none');
    assert.equal(globalThis.localStorage.getItem(CACHE_KEY), null);
  });
});
