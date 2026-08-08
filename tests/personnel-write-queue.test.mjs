// Personnel Directory offline write queue (V2.3 Phase 5) tests.
//
// Run with Node's built-in test runner (Node 18+, zero new dependencies):
//
//   node --test tests/personnel-write-queue.test.mjs
//
// Same conventions as tests/personnel-directory-service.test.mjs: a mock
// `globalThis.fetch` stands in for the network, a Map-backed mock
// `globalThis.localStorage` stands in for the browser storage Node lacks,
// and every test starts from a clean slate via beforeEach (this module's
// queue functions are stateless read-modify-write against storage, but
// personnel-directory-service.js's own snapshot is still a singleton that
// needs resetting between tests).

import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import {
  validateWriteQueueShape,
  loadWriteQueue,
  clearWriteQueue,
  getWriteQueueSnapshot,
  getWriteQueueSummary,
  enqueueAddReportPersonnel,
  enqueueUpdateReportPersonnel,
  enqueueSetReportPersonnelActive,
  removeQueueItem,
  retryQueueItem,
  flushPersonnelWriteQueue,
  isWriteQueueFlushInFlight,
} from '../js/services/personnel-write-queue.js';

import {
  getPersonnelDirectorySnapshot,
  getActivePersonnelByRole,
  clearPersonnelDirectoryCache,
} from '../js/services/personnel-directory-service.js';
import { initializeLicense, _buildValidLicenseRecordForTests } from '../js/services/license-service.js';

const QUEUE_KEY = 'hpal.personnel.writeQueue.v1';
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

// V2.3 Phase 8: flushPersonnelWriteQueue()/retryQueueItem() now
// independently check licenseService.hasFullAccess() (see that module's
// own header comment). This file predates licensing and tests the
// queue's OWN behavior in isolation, so every test here runs under a
// FULL_ACCESS baseline installed via license-service.js's
// _buildValidLicenseRecordForTests() fixture -- which verifies against
// the real production verifier WITHOUT ever needing the actual plaintext
// key (see that helper's own doc comment). License-guard behavior itself
// (MONITOR_ONLY blocking these same functions) has its own dedicated
// coverage in tests/personnel-write-queue-license-guard.test.mjs.
function installMockStorage() {
  const storage = createMockStorage();
  globalThis.localStorage = storage;
  storage.setItem(LICENSE_KEY, JSON.stringify(_buildValidLicenseRecordForTests()));
  initializeLicense();
  return storage;
}

function mockResponse(payload, { ok = true } = {}) {
  return { ok, json: async () => payload };
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

// A fetch mock covering one write-then-resync round trip: the POST gets
// `writeResponse`, any subsequent GET gets `syncPayload`.
function mockWriteThenSyncFetch(writeResponse, syncPayload) {
  return async (url, options = {}) => {
    if (options.method === 'POST') return mockResponse(writeResponse);
    return mockResponse(syncPayload || buildSyncPayload([]));
  };
}

beforeEach(() => {
  installMockStorage();
  clearWriteQueue();
  clearPersonnelDirectoryCache();
  delete globalThis.fetch;
});

describe('Queue schema validation -- pure, no DOM/network (items 1-3)', () => {
  test('1. empty queue loads safely (nothing in storage)', () => {
    const queue = loadWriteQueue();
    assert.deepEqual(queue.items, []);
    assert.equal(queue.updatedAt, null);
  });

  test('2. a valid queue persists across load calls', () => {
    enqueueAddReportPersonnel({ role_type: 'SPV_SCM', name: 'Budi', organization: 'SCM' });
    const reloaded = loadWriteQueue();
    assert.equal(reloaded.items.length, 1);
    assert.equal(reloaded.items[0].action, 'addReportPersonnel');
  });

  test('3. malformed/corrupted queue JSON is rejected safely, never throws', () => {
    globalThis.localStorage.setItem(QUEUE_KEY, '{not valid json');
    assert.doesNotThrow(() => {
      const queue = loadWriteQueue();
      assert.deepEqual(queue.items, []);
    });
  });

  test('3b. a structurally wrong queue (bad queueVersion) is also rejected safely', () => {
    globalThis.localStorage.setItem(QUEUE_KEY, JSON.stringify({ queueVersion: 99, items: [] }));
    assert.equal(loadWriteQueue().items.length, 0);
  });

  test('validateWriteQueueShape() rejects a queue item with an invalid action', () => {
    const raw = {
      queueVersion: 1,
      updatedAt: null,
      items: [{
        queueId: 'q1',
        action: 'deletePersonnel',
        payload: {},
        createdAt: '2026-08-07T00:00:00.000Z',
        attemptCount: 0,
        lastAttemptAt: null,
        lastError: null,
        lastErrorCode: null,
        status: 'pending',
      }],
    };
    assert.equal(validateWriteQueueShape(raw).ok, false);
  });
});

describe('Enqueue -- add/update/deactivate/reactivate (items 4-7)', () => {
  test('4. add enqueues a pending addReportPersonnel item', () => {
    const item = enqueueAddReportPersonnel({ role_type: 'SPV_SCM', name: 'Budi', organization: 'SCM' });
    assert.equal(item.action, 'addReportPersonnel');
    assert.equal(item.status, 'pending');
    assert.equal(item.payload.name, 'Budi');
    assert.equal(getWriteQueueSummary().pending, 1);
  });

  test('5. update enqueues a pending updateReportPersonnel item', () => {
    const item = enqueueUpdateReportPersonnel({ id: 'frm-1', name: 'Novelesto', organization: 'SCM', expected_version: 2 });
    assert.equal(item.action, 'updateReportPersonnel');
    assert.equal(item.status, 'pending');
    assert.equal(item.payload.expected_version, 2);
  });

  test('6. deactivate enqueues a pending setReportPersonnelActive(active:false) item', () => {
    const item = enqueueSetReportPersonnelActive({ id: 'frm-1', active: false, expected_version: 3 });
    assert.equal(item.action, 'setReportPersonnelActive');
    assert.equal(item.payload.active, false);
    assert.equal(item.status, 'pending');
  });

  test('7. reactivate enqueues a pending setReportPersonnelActive(active:true) item', () => {
    const item = enqueueSetReportPersonnelActive({ id: 'frm-1', active: true, expected_version: 3 });
    assert.equal(item.payload.active, true);
    assert.equal(item.status, 'pending');
  });
});

describe('Persistence (item 8)', () => {
  test('8. queue survives a reload/storage round trip', () => {
    enqueueAddReportPersonnel({ role_type: 'SAMPLER', name: 'AWK Person', organization: 'AWK' });
    enqueueSetReportPersonnelActive({ id: 'frm-1', active: false, expected_version: 1 });

    // Simulate a page reload: read the exact same storage-backed key fresh.
    const rawAfterReload = globalThis.localStorage.getItem(QUEUE_KEY);
    assert.ok(rawAfterReload);
    const reloaded = loadWriteQueue();
    assert.equal(reloaded.items.length, 2);
  });
});

describe('FIFO ordering (item 9)', () => {
  test('9. queue preserves FIFO order and flush processes items in that order', async () => {
    enqueueAddReportPersonnel({ role_type: 'SPV_SCM', name: 'First', organization: 'SCM' });
    enqueueAddReportPersonnel({ role_type: 'SPV_SCM', name: 'Second', organization: 'SCM' });
    enqueueAddReportPersonnel({ role_type: 'SPV_SCM', name: 'Third', organization: 'SCM' });

    const snapshotBefore = getWriteQueueSnapshot();
    assert.deepEqual(snapshotBefore.items.map((it) => it.payload.name), ['First', 'Second', 'Third']);

    const processedOrder = [];
    let counter = 0;
    globalThis.fetch = async (url, options = {}) => {
      if (options.method === 'POST') {
        const body = JSON.parse(options.body);
        processedOrder.push(body.name);
        counter += 1;
        return mockResponse({
          ok: true,
          action: 'addReportPersonnel',
          apiVersion: '1.0.0',
          schemaVersion: 1,
          record: makeRecord({ id: `spv-${counter}`, role_type: 'SPV_SCM', name: body.name, organization: 'SCM' }),
        });
      }
      return mockResponse(buildSyncPayload([
        makeRecord({ id: 'spv-1', role_type: 'SPV_SCM', name: 'First', organization: 'SCM' }),
        makeRecord({ id: 'spv-2', role_type: 'SPV_SCM', name: 'Second', organization: 'SCM' }),
        makeRecord({ id: 'spv-3', role_type: 'SPV_SCM', name: 'Third', organization: 'SCM' }),
      ]));
    };

    await flushPersonnelWriteQueue();
    assert.deepEqual(processedOrder, ['First', 'Second', 'Third']);
    assert.equal(getWriteQueueSummary().total, 0);
  });
});

describe('Successful flush (items 10-11)', () => {
  test('10. successful flush removes exactly the flushed item', async () => {
    enqueueAddReportPersonnel({ role_type: 'SPV_SCM', name: 'Budi', organization: 'SCM' });
    const newRecord = makeRecord({ id: 'spv-new', role_type: 'SPV_SCM', name: 'Budi', organization: 'SCM', version: 1 });
    globalThis.fetch = mockWriteThenSyncFetch(
      { ok: true, action: 'addReportPersonnel', apiVersion: '1.0.0', schemaVersion: 1, record: newRecord },
      buildSyncPayload([newRecord])
    );

    const result = await flushPersonnelWriteQueue();

    assert.equal(result.succeeded, 1);
    assert.equal(getWriteQueueSummary().total, 0);
  });

  test('11. successful flush resyncs the authoritative Personnel Directory (queue never fabricates the record itself)', async () => {
    enqueueAddReportPersonnel({ role_type: 'SPV_SCM', name: 'Budi', organization: 'SCM' });
    const newRecord = makeRecord({ id: 'spv-new', role_type: 'SPV_SCM', name: 'Budi', organization: 'SCM', version: 1 });
    globalThis.fetch = mockWriteThenSyncFetch(
      { ok: true, action: 'addReportPersonnel', apiVersion: '1.0.0', schemaVersion: 1, record: newRecord },
      buildSyncPayload([newRecord])
    );

    assert.equal(getPersonnelDirectorySnapshot().records.length, 0);
    await flushPersonnelWriteQueue();

    const snapshot = getPersonnelDirectorySnapshot();
    assert.equal(snapshot.source, 'remote');
    assert.equal(snapshot.records.length, 1);
    assert.equal(snapshot.records[0].id, 'spv-new');
  });
});

describe('Network failure classification (item 12)', () => {
  test('12. a network failure stops the flush and preserves the item as pending', async () => {
    enqueueAddReportPersonnel({ role_type: 'SPV_SCM', name: 'Budi', organization: 'SCM' });
    globalThis.fetch = async () => {
      throw new Error('offline');
    };

    const result = await flushPersonnelWriteQueue();

    assert.equal(result.stopped, true);
    assert.equal(result.stopReason, 'network');
    const snapshot = getWriteQueueSnapshot();
    assert.equal(snapshot.items.length, 1);
    assert.equal(snapshot.items[0].status, 'pending');
    assert.equal(snapshot.items[0].attemptCount, 1);
  });

  test('12b. a network failure stops the flush BEFORE later items in the queue', async () => {
    enqueueAddReportPersonnel({ role_type: 'SPV_SCM', name: 'First', organization: 'SCM' });
    enqueueAddReportPersonnel({ role_type: 'SPV_SCM', name: 'Second', organization: 'SCM' });
    globalThis.fetch = async () => {
      throw new Error('offline');
    };

    const result = await flushPersonnelWriteQueue();

    assert.equal(result.processed, 1);
    assert.equal(getWriteQueueSummary().pending, 2);
  });
});

describe('Conflict / duplicate blocking (items 13-14)', () => {
  test('13. VERSION_CONFLICT marks the item blocked, never silently rewrites expected_version', async () => {
    enqueueUpdateReportPersonnel({ id: 'frm-1', name: 'Renamed', organization: 'SCM', expected_version: 1 });
    globalThis.fetch = async (url, options = {}) => {
      if (options.method === 'POST') {
        return mockResponse({ ok: false, error: { code: 'VERSION_CONFLICT', message: 'stale', currentVersion: 4 } });
      }
      return mockResponse(buildSyncPayload([]));
    };

    const result = await flushPersonnelWriteQueue();

    assert.equal(result.blocked, 1);
    const snapshot = getWriteQueueSnapshot();
    assert.equal(snapshot.items[0].status, 'blocked');
    assert.equal(snapshot.items[0].payload.expected_version, 1);
  });

  test('14. DUPLICATE_PERSONNEL marks the item blocked', async () => {
    enqueueAddReportPersonnel({ role_type: 'SPV_SCM', name: 'Dup', organization: 'SCM' });
    globalThis.fetch = async (url, options = {}) => {
      if (options.method === 'POST') return mockResponse({ ok: false, error: { code: 'DUPLICATE_PERSONNEL', message: 'Already exists.' } });
      return mockResponse(buildSyncPayload([]));
    };

    await flushPersonnelWriteQueue();

    assert.equal(getWriteQueueSnapshot().items[0].status, 'blocked');
  });
});

describe('Non-network application errors never loop forever (items 15-16)', () => {
  test('15. an INVALID_PARAMETER-style validation error blocks the item instead of retrying endlessly', async () => {
    enqueueAddReportPersonnel({ role_type: 'SPV_SCM', name: 'Bad', organization: 'SCM' });
    let postCalls = 0;
    globalThis.fetch = async (url, options = {}) => {
      if (options.method === 'POST') {
        postCalls += 1;
        return mockResponse({ ok: false, error: { code: 'INVALID_PARAMETER', message: 'Nama tidak valid.' } });
      }
      return mockResponse(buildSyncPayload([]));
    };

    await flushPersonnelWriteQueue();
    assert.equal(postCalls, 1);
    assert.equal(getWriteQueueSnapshot().items[0].status, 'blocked');
    assert.equal(getWriteQueueSnapshot().items[0].attemptCount, 1);
  });

  test('16. blocked items are not auto-retried by a later flush', async () => {
    enqueueAddReportPersonnel({ role_type: 'SPV_SCM', name: 'Bad', organization: 'SCM' });
    let postCalls = 0;
    globalThis.fetch = async (url, options = {}) => {
      if (options.method === 'POST') {
        postCalls += 1;
        return mockResponse({ ok: false, error: { code: 'INVALID_PARAMETER', message: 'Nama tidak valid.' } });
      }
      return mockResponse(buildSyncPayload([]));
    };

    await flushPersonnelWriteQueue();
    assert.equal(postCalls, 1);

    await flushPersonnelWriteQueue();
    assert.equal(postCalls, 1, 'a second flush must not re-attempt the now-blocked item');
  });
});

describe('Manual queue control (items 17-18)', () => {
  test('17. manual retry moves a blocked item back to pending', async () => {
    const item = enqueueAddReportPersonnel({ role_type: 'SPV_SCM', name: 'Bad', organization: 'SCM' });
    globalThis.fetch = async (url, options = {}) => {
      if (options.method === 'POST') return mockResponse({ ok: false, error: { code: 'VALIDATION_ERROR', message: 'bad' } });
      return mockResponse(buildSyncPayload([]));
    };
    await flushPersonnelWriteQueue();
    assert.equal(getWriteQueueSnapshot().items[0].status, 'blocked');

    const retried = retryQueueItem(item.queueId);
    assert.equal(retried, true);
    assert.equal(getWriteQueueSnapshot().items[0].status, 'pending');
  });

  test("17b. retrying an id that isn't blocked (or doesn't exist) is a safe no-op", () => {
    const item = enqueueAddReportPersonnel({ role_type: 'SPV_SCM', name: 'Still Pending', organization: 'SCM' });
    assert.equal(retryQueueItem(item.queueId), false);
    assert.equal(retryQueueItem('nonexistent-id'), false);
  });

  test('18. removing a queued item works', () => {
    const item = enqueueAddReportPersonnel({ role_type: 'SPV_SCM', name: 'Budi', organization: 'SCM' });
    assert.equal(getWriteQueueSummary().total, 1);

    const removed = removeQueueItem(item.queueId);
    assert.equal(removed, true);
    assert.equal(getWriteQueueSummary().total, 0);
    assert.equal(removeQueueItem(item.queueId), false, 'removing an already-removed id returns false');
  });
});

describe('Coalescing rules (items 19-20)', () => {
  test('19. duplicate update coalescing: same id + same expected_version collapses to one item with the latest values', () => {
    enqueueUpdateReportPersonnel({ id: 'frm-1', name: 'First Edit', organization: 'SCM', expected_version: 5 });
    enqueueUpdateReportPersonnel({ id: 'frm-1', name: 'Second Edit', organization: 'SCM', expected_version: 5 });

    const snapshot = getWriteQueueSnapshot();
    assert.equal(snapshot.items.length, 1);
    assert.equal(snapshot.items[0].payload.name, 'Second Edit');
  });

  test('19b. updates with different expected_version are kept separate (safety over aggressive compaction)', () => {
    enqueueUpdateReportPersonnel({ id: 'frm-1', name: 'Edit A', organization: 'SCM', expected_version: 5 });
    enqueueUpdateReportPersonnel({ id: 'frm-1', name: 'Edit B', organization: 'SCM', expected_version: 6 });

    assert.equal(getWriteQueueSnapshot().items.length, 2);
  });

  test('20. deactivate then reactivate coalescing: same id + same expected_version collapses to one item with the final active value', () => {
    enqueueSetReportPersonnelActive({ id: 'frm-1', active: false, expected_version: 5 });
    enqueueSetReportPersonnelActive({ id: 'frm-1', active: true, expected_version: 5 });

    const snapshot = getWriteQueueSnapshot();
    assert.equal(snapshot.items.length, 1);
    assert.equal(snapshot.items[0].payload.active, true);
  });

  test('20b. update and setActive for the same id remain separate items (rule 3)', () => {
    enqueueUpdateReportPersonnel({ id: 'frm-1', name: 'Edit', organization: 'SCM', expected_version: 5 });
    enqueueSetReportPersonnelActive({ id: 'frm-1', active: false, expected_version: 5 });

    assert.equal(getWriteQueueSnapshot().items.length, 2);
  });

  test('20c. a blocked item is never silently overwritten by later coalescing', async () => {
    const first = enqueueSetReportPersonnelActive({ id: 'frm-1', active: false, expected_version: 5 });
    globalThis.fetch = async (url, options = {}) => {
      if (options.method === 'POST') return mockResponse({ ok: false, error: { code: 'VERSION_CONFLICT', message: 'stale', currentVersion: 9 } });
      return mockResponse(buildSyncPayload([]));
    };
    await flushPersonnelWriteQueue();
    assert.equal(getWriteQueueSnapshot().items[0].status, 'blocked');

    enqueueSetReportPersonnelActive({ id: 'frm-1', active: true, expected_version: 5 });

    const snapshot = getWriteQueueSnapshot();
    assert.equal(snapshot.items.length, 2, 'the new request queues alongside the blocked one, never merges into it');
    assert.equal(snapshot.items.find((it) => it.queueId === first.queueId).status, 'blocked');
  });
});

describe('Concurrency (item 21)', () => {
  test('21. concurrent flush calls dedupe into a single in-flight run', async () => {
    enqueueAddReportPersonnel({ role_type: 'SPV_SCM', name: 'Budi', organization: 'SCM' });
    let postCalls = 0;
    globalThis.fetch = async (url, options = {}) => {
      if (options.method === 'POST') {
        postCalls += 1;
        await new Promise((resolve) => setTimeout(resolve, 5));
        return mockResponse({ ok: true, action: 'addReportPersonnel', apiVersion: '1.0.0', schemaVersion: 1, record: makeRecord({ id: 'spv-1', role_type: 'SPV_SCM', name: 'Budi', organization: 'SCM' }) });
      }
      return mockResponse(buildSyncPayload([makeRecord({ id: 'spv-1', role_type: 'SPV_SCM', name: 'Budi', organization: 'SCM' })]));
    };

    assert.equal(isWriteQueueFlushInFlight(), false);
    const first = flushPersonnelWriteQueue();
    const second = flushPersonnelWriteQueue();
    assert.equal(first, second);
    assert.equal(isWriteQueueFlushInFlight(), true);

    await Promise.all([first, second]);
    assert.equal(postCalls, 1);
    assert.equal(isWriteQueueFlushInFlight(), false);
  });
});

describe('Endpoint/transport isolation (items 22-23)', () => {
  const moduleSource = readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'js', 'services', 'personnel-write-queue.js'),
    'utf8'
  );

  test('22. the queue module never hardcodes the Apps Script endpoint URL', () => {
    assert.doesNotMatch(moduleSource, /script\.google\.com/);
  });

  test('23. the queue module never performs a raw fetch() call itself', () => {
    assert.doesNotMatch(moduleSource, /[^.]\bfetch\(/);
  });
});

describe('Authoritative cache / Report isolation (items 24-25)', () => {
  test('24. enqueueing a write never mutates the Personnel Directory cache as if it were authoritative', () => {
    assert.equal(getPersonnelDirectorySnapshot().records.length, 0);
    enqueueAddReportPersonnel({ role_type: 'SPV_SCM', name: 'Ghost', organization: 'SCM' });
    assert.equal(getPersonnelDirectorySnapshot().records.length, 0);
    assert.equal(getPersonnelDirectorySnapshot().source, 'none');
  });

  test('25. a queued (not yet flushed) add never appears in Report-facing active-personnel reads', () => {
    enqueueAddReportPersonnel({ role_type: 'SPV_SCM', name: 'Ghost SPV', organization: 'SCM' });
    const active = getActivePersonnelByRole('SPV_SCM');
    assert.equal(active.length, 0);
    assert.ok(!active.some((r) => r.name === 'Ghost SPV'));
  });
});
