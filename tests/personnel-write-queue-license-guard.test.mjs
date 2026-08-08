// Personnel offline write queue action-boundary license guard tests
// (V2.3 Phase 8).
//
// Run with Node's built-in test runner:
//
//   node --test tests/personnel-write-queue-license-guard.test.mjs
//
// Verifies flushPersonnelWriteQueue()/retryQueueItem() independently check
// licenseService.hasFullAccess() at their own action boundary -- this is
// what makes "queued items remain dormant locally" under MONITOR_ONLY true
// regardless of which trigger fired (startup, the 'online' event, or a
// manual Sync in Settings), since all three ultimately call
// flushPersonnelWriteQueue(). See personnel-directory-license-guard.test.mjs's
// header comment for why FULL_ACCESS tests use license-service.js's
// _buildValidLicenseRecordForTests() fixture instead of a real key.

import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  clearWriteQueue,
  enqueueAddReportPersonnel,
  getWriteQueueSnapshot,
  getWriteQueueSummary,
  retryQueueItem,
  flushPersonnelWriteQueue,
} from '../js/services/personnel-write-queue.js';
import { clearPersonnelDirectoryCache } from '../js/services/personnel-directory-service.js';
import {
  removeLicense,
  initializeLicense,
  hasFullAccess,
  _buildValidLicenseRecordForTests,
} from '../js/services/license-service.js';

const LICENSE_KEY = 'hpal.license.v1';
const QUEUE_KEY = 'hpal.personnel.writeQueue.v1';

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
  clearWriteQueue();
  clearPersonnelDirectoryCache();
  delete globalThis.fetch;
  removeLicense();
});

function installFullAccess() {
  storage.setItem(LICENSE_KEY, JSON.stringify(_buildValidLicenseRecordForTests()));
  initializeLicense();
  assert.equal(hasFullAccess(), true, 'test setup: license fixture must actually verify as FULL_ACCESS');
}

describe('MONITOR_ONLY -- the offline queue stays dormant', () => {
  test('7. flushPersonnelWriteQueue() does not process anything and never calls fetch', async () => {
    enqueueAddReportPersonnel({ role_type: 'SPV_SCM', name: 'Budi', organization: 'SCM' });
    let fetchCalled = false;
    globalThis.fetch = async () => {
      fetchCalled = true;
      return mockResponse({ ok: true, record: makeRecord() });
    };

    const result = await flushPersonnelWriteQueue();

    assert.equal(result.processed, 0);
    assert.equal(result.stopReason, 'unlicensed');
    assert.equal(fetchCalled, false);
  });

  test('8/9. a pending item is left untouched -- an "online" style flush attempt does not consume or mutate it', async () => {
    enqueueAddReportPersonnel({ role_type: 'SPV_SCM', name: 'Budi', organization: 'SCM' });
    const before = getWriteQueueSnapshot();

    await flushPersonnelWriteQueue();

    const after = getWriteQueueSnapshot();
    assert.deepEqual(after.items, before.items);
    assert.equal(after.pendingCount, 1);
  });

  test('manual retryQueueItem() is also blocked (a blocked item stays blocked, never silently re-armed)', () => {
    const item = enqueueAddReportPersonnel({ role_type: 'SPV_SCM', name: 'Budi', organization: 'SCM' });
    // Force it into 'blocked' the same way a real flush would (via direct
    // queue mutation -- simplest way to reach the precondition retryQueueItem()
    // itself requires, without depending on flush's own error classification).
    const queue = JSON.parse(storage.getItem(QUEUE_KEY));
    queue.items[0].status = 'blocked';
    storage.setItem(QUEUE_KEY, JSON.stringify(queue));

    const retried = retryQueueItem(item.queueId);
    assert.equal(retried, false);
    const reloaded = JSON.parse(storage.getItem(QUEUE_KEY));
    assert.equal(reloaded.items[0].status, 'blocked');
  });
});

describe('FULL_ACCESS -- normal queue behavior resumes', () => {
  test('10. flushPersonnelWriteQueue() processes a pending item normally once FULL_ACCESS is restored', async () => {
    enqueueAddReportPersonnel({ role_type: 'SPV_SCM', name: 'Budi', organization: 'SCM' });
    installFullAccess();

    const written = makeRecord();
    globalThis.fetch = mockWriteThenSyncFetch({ ok: true, record: written }, buildSyncPayload([written]));

    const result = await flushPersonnelWriteQueue();

    assert.equal(result.succeeded, 1);
    assert.equal(getWriteQueueSummary().pending, 0);
  });

  test('retryQueueItem() moves a blocked item back to pending once licensed', () => {
    const item = enqueueAddReportPersonnel({ role_type: 'SPV_SCM', name: 'Budi', organization: 'SCM' });
    const queue = JSON.parse(storage.getItem(QUEUE_KEY));
    queue.items[0].status = 'blocked';
    storage.setItem(QUEUE_KEY, JSON.stringify(queue));

    installFullAccess();

    const retried = retryQueueItem(item.queueId);
    assert.equal(retried, true);
    const reloaded = JSON.parse(storage.getItem(QUEUE_KEY));
    assert.equal(reloaded.items[0].status, 'pending');
  });
});
