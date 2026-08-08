// Personnel Directory action-boundary license guard tests (V2.3 Phase 8).
//
// Run with Node's built-in test runner:
//
//   node --test tests/personnel-directory-license-guard.test.mjs
//
// Verifies syncPersonnelDirectory()/addReportPersonnel()/
// updateReportPersonnel()/setReportPersonnelActive() independently check
// licenseService.hasFullAccess() at their own action boundary -- not only
// via Settings hiding the UI. MONITOR_ONLY tests need no license key at
// all (it is the default state); FULL_ACCESS tests install a valid
// license record via license-service.js's _buildValidLicenseRecordForTests()
// helper, which verifies against the real production verifier WITHOUT
// ever needing the actual plaintext key (see that helper's own doc
// comment) -- this file never imports or contains the production key.

import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  syncPersonnelDirectory,
  addReportPersonnel,
  updateReportPersonnel,
  setReportPersonnelActive,
  clearPersonnelDirectoryCache,
} from '../js/services/personnel-directory-service.js';
import {
  removeLicense,
  initializeLicense,
  hasFullAccess,
  _buildValidLicenseRecordForTests,
} from '../js/services/license-service.js';

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

function installMockStorage() {
  const storage = createMockStorage();
  globalThis.localStorage = storage;
  return storage;
}

function mockResponse(payload, { ok = true } = {}) {
  return { ok, json: async () => payload };
}

function makeRecord(overrides = {}) {
  return {
    id: 'spv-scm-budi',
    role_type: 'SPV_SCM',
    name: 'Budi',
    organization: 'SCM',
    active: true,
    created_at: '2026-08-06T16:55:00+08:00',
    updated_at: '2026-08-06T16:55:00+08:00',
    updated_by: 'OWNER_WEB_APP',
    version: 1,
    ...overrides,
  };
}

function buildSyncPayload(records) {
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
    filters: { role_type: null, organization: null, includeInactive: true },
    counts: { returned: records.length, totalActive: records.length, totalInactive: 0, byRole },
    records,
  };
}

function mockWriteThenSyncFetch(writeResponse, syncPayload) {
  return async (url, options = {}) => {
    if (options.method === 'POST') return mockResponse(writeResponse);
    return mockResponse(syncPayload || buildSyncPayload([]));
  };
}

let storage;

beforeEach(() => {
  storage = installMockStorage();
  clearPersonnelDirectoryCache();
  delete globalThis.fetch;
  // Baseline every test at MONITOR_ONLY -- license-service.js's production
  // singleton keeps its access tier in memory across calls within this
  // process, so it must be explicitly reset here rather than assumed from
  // a fresh module import (see this file's header comment).
  removeLicense();
});

function installFullAccess() {
  storage.setItem(LICENSE_KEY, JSON.stringify(_buildValidLicenseRecordForTests()));
  initializeLicense();
  assert.equal(hasFullAccess(), true, 'test setup: license fixture must actually verify as FULL_ACCESS');
}

describe('MONITOR_ONLY (default, no key installed) -- every Personnel Directory action is blocked', () => {
  test('3. syncPersonnelDirectory() is blocked, never calls fetch', async () => {
    let fetchCalled = false;
    globalThis.fetch = async () => {
      fetchCalled = true;
      return mockResponse(buildSyncPayload([]));
    };
    const result = await syncPersonnelDirectory();
    assert.equal(result.ok, false);
    assert.equal(fetchCalled, false);
  });

  test('4. addReportPersonnel() is blocked with LICENSE_REQUIRED, never calls fetch', async () => {
    let fetchCalled = false;
    globalThis.fetch = async () => {
      fetchCalled = true;
      return mockResponse({ ok: true, record: makeRecord() });
    };
    const result = await addReportPersonnel({ role_type: 'SPV_SCM', name: 'Budi', organization: 'SCM' });
    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'LICENSE_REQUIRED');
    assert.equal(fetchCalled, false);
  });

  test('5. updateReportPersonnel() is blocked with LICENSE_REQUIRED, never calls fetch', async () => {
    let fetchCalled = false;
    globalThis.fetch = async () => {
      fetchCalled = true;
      return mockResponse({ ok: true, record: makeRecord({ version: 2 }) });
    };
    const result = await updateReportPersonnel({ id: 'spv-scm-budi', name: 'Budi Santoso', organization: 'SCM', expected_version: 1 });
    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'LICENSE_REQUIRED');
    assert.equal(fetchCalled, false);
  });

  test('6. setReportPersonnelActive() is blocked with LICENSE_REQUIRED, never calls fetch', async () => {
    let fetchCalled = false;
    globalThis.fetch = async () => {
      fetchCalled = true;
      return mockResponse({ ok: true, record: makeRecord({ active: false, version: 2 }) });
    };
    const result = await setReportPersonnelActive({ id: 'spv-scm-budi', active: false, expected_version: 1 });
    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'LICENSE_REQUIRED');
    assert.equal(fetchCalled, false);
  });
});

describe('FULL_ACCESS (fixture license installed) -- every Personnel Directory action proceeds normally', () => {
  test('syncPersonnelDirectory() reaches the network and succeeds', async () => {
    installFullAccess();
    globalThis.fetch = async () => mockResponse(buildSyncPayload([makeRecord()]));
    const result = await syncPersonnelDirectory();
    assert.equal(result.ok, true);
    assert.equal(result.snapshot.records.length, 1);
  });

  test('addReportPersonnel() reaches the network and succeeds (write-then-verify-then-resync)', async () => {
    installFullAccess();
    const written = makeRecord();
    globalThis.fetch = mockWriteThenSyncFetch({ ok: true, record: written }, buildSyncPayload([written]));
    const result = await addReportPersonnel({ role_type: 'SPV_SCM', name: 'Budi', organization: 'SCM' });
    assert.equal(result.ok, true);
  });

  test('updateReportPersonnel() reaches the network and succeeds', async () => {
    installFullAccess();
    const updated = makeRecord({ name: 'Budi Santoso', version: 2 });
    globalThis.fetch = mockWriteThenSyncFetch({ ok: true, record: updated }, buildSyncPayload([updated]));
    const result = await updateReportPersonnel({ id: 'spv-scm-budi', name: 'Budi Santoso', organization: 'SCM', expected_version: 1 });
    assert.equal(result.ok, true);
  });

  test('setReportPersonnelActive() reaches the network and succeeds', async () => {
    installFullAccess();
    const deactivated = makeRecord({ active: false, version: 2 });
    globalThis.fetch = mockWriteThenSyncFetch({ ok: true, record: deactivated }, buildSyncPayload([deactivated]));
    const result = await setReportPersonnelActive({ id: 'spv-scm-budi', active: false, expected_version: 1 });
    assert.equal(result.ok, true);
  });
});
