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
  clearPersonnelDirectoryCache,
} from '../js/services/personnel-directory-service.js';

const CACHE_KEY = 'hpal.personnel.v1';

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

function installMockStorage() {
  const storage = createMockStorage();
  globalThis.localStorage = storage;
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

  test('12. active:false rejected from an active-only sync', () => {
    const records = [makeRecord({ active: false })];
    assert.equal(validatePersonnelResponsePayload(buildPayload(records)).ok, false);
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
