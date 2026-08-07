// Report's contractor directory READ consumer (Monitor-owned single-sync
// architecture round) tests.
//
// Run with Node's built-in test runner (Node 18+, zero new dependencies):
//
//   node --test tests/contractor-directory-service.test.mjs
//
// Report performs NO network request of its own for contractor data --
// Monitor's existing List DT sync (contractor-assignment.js) is the one
// and only synchronization flow in the application. This module only
// reads the shared hpal.contractors.v1 cache and reacts to the
// hpal:contractor-directory-updated event. Every test here uses a mock
// `globalThis.localStorage` and an injected `EventTarget` -- there is no
// `globalThis.fetch` mock anymore because there is nothing left in this
// module that calls fetch.

import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  canonicalDtId,
  normalizedKey,
  validateContractorRecords,
  loadCachedContractorDirectory,
  clearContractorDirectoryCache,
  getContractorDirectorySnapshot,
  getContractorDirectoryStatus,
  lookupContractor,
  subscribeContractorDirectoryUpdated,
} from '../js/services/contractor-directory-service.js';

const CACHE_KEY = 'hpal.contractors.v1';

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

function row(dtId, contractor) {
  return { dtId, contractor };
}

function writeCacheDirect(storage, records, overrides = {}) {
  storage.setItem(CACHE_KEY, JSON.stringify({
    cacheVersion: 1,
    source: 'remote',
    fetchedAt: '2026-08-07T00:00:00.000Z',
    records,
    ...overrides,
  }));
}

beforeEach(() => {
  installMockStorage();
  clearContractorDirectoryCache();
});

/* ============================================================
   NORMALIZATION
============================================================ */
describe('canonicalDtId() / normalizedKey() -- delegated to the shared core', () => {
  test('all required variants resolve to one key', () => {
    const variants = ['SCM-LIM 949', 'SCM LIM 949', 'SCM_LIM_949', 'SCM-LIM-949', 'SCM-LIM 949 DT', 'SCM-LIM 949 DT.'];
    const keys = variants.map(normalizedKey);
    assert.ok(keys.every((k) => k === 'SCMLIM949'));
    assert.ok(variants.every((v) => canonicalDtId(v) === 'SCM-LIM 949'));
  });

  test('unrelated ids do not collide', () => {
    assert.notEqual(normalizedKey('SCM-LIM 94'), normalizedKey('SCM-LIM 949'));
    assert.equal(normalizedKey('ADT 001'), '');
    assert.equal(normalizedKey('MIM 117'), '');
  });
});

/* ============================================================
   VALIDATION -- mixed-response tolerance
============================================================ */
describe('validateContractorRecords() -- mixed real List DT response tolerance', () => {
  test('valid remote-shaped rows accepted', () => {
    const result = validateContractorRecords([row('SCM-LIM 949', 'TII'), row('SCM-LIM 601', 'REAL')]);
    assert.equal(result.ok, true);
    assert.equal(result.records.length, 2);
  });

  test('the exact mixed response example: blank + ADT + MIM rows skipped, 3 SCM rows accepted', () => {
    const mixed = [
      { dtId: '', contractor: '' },
      { dtId: 'ADT 001', contractor: 'ADT HILLCON' },
      { dtId: 'MIM 117', contractor: 'MIM' },
      { dtId: 'SCM-HLG 960', contractor: 'TII' },
      { dtId: 'SCM-HLG 946', contractor: 'TII' },
      { dtId: 'SCM-LIM 228', contractor: 'REAL' },
    ];
    const result = validateContractorRecords(mixed);
    assert.equal(result.ok, true);
    assert.equal(result.records.length, 3);
    assert.deepEqual(result.records.map((r) => r.normalizedKey).sort(), ['SCMHLG946', 'SCMHLG960', 'SCMLIM228'].sort());
  });

  test('invalid response (not an array) rejected', () => {
    assert.equal(validateContractorRecords({ not: 'an array' }).ok, false);
    assert.equal(validateContractorRecords(null).ok, false);
  });

  test('zero accepted SCM rows rejects the update (an all-unsupported/blank response never wipes a valid cache)', () => {
    const allUnsupported = [
      { dtId: '', contractor: '' },
      { dtId: 'ADT 001', contractor: 'ADT HILLCON' },
      { dtId: 'MIM 117', contractor: 'MIM' },
    ];
    assert.equal(validateContractorRecords(allUnsupported).ok, false);
  });

  test('conflicting SCM duplicates reject the update', () => {
    const result = validateContractorRecords([row('SCM-LIM 601', 'HYNC'), row('SCM LIM 601', 'REAL')]);
    assert.equal(result.ok, false);
    assert.match(result.error, /conflicting/i);
  });

  test('identical SCM duplicates are merged deterministically, not rejected', () => {
    const result = validateContractorRecords([row('SCM-LIM 949', 'TII'), row('SCM LIM 949', 'TII')]);
    assert.equal(result.ok, true);
    assert.equal(result.records.length, 1);
  });
});

/* ============================================================
   SHARED CACHE (read-only, written exclusively by Monitor)
============================================================ */
describe('Shared cache read (Monitor-owned single-sync architecture)', () => {
  test('loadCachedContractorDirectory() reads a valid Monitor-written cache, marked "cached"', () => {
    const storage = globalThis.localStorage;
    writeCacheDirect(storage, [{ dtId: 'SCM-LIM 949', normalizedKey: 'SCMLIM949', contractor: 'TII' }]);

    const result = loadCachedContractorDirectory();
    assert.ok(result);
    assert.equal(result.source, 'cached');
    assert.equal(lookupContractor('SCM-LIM 949'), 'TII');
  });

  test('malformed cache is rejected without throwing and without touching the existing snapshot', () => {
    globalThis.localStorage.setItem(CACHE_KEY, 'not json');
    const result = loadCachedContractorDirectory();
    assert.equal(result, null);
    assert.equal(getContractorDirectorySnapshot().source, 'none');
  });

  test('wrong cacheVersion is rejected', () => {
    globalThis.localStorage.setItem(CACHE_KEY, JSON.stringify({ cacheVersion: 999, records: [] }));
    assert.equal(loadCachedContractorDirectory(), null);
  });

  test('missing cache produces "none" -- Report never claims a static fallback is the current List DT', () => {
    assert.equal(getContractorDirectorySnapshot().source, 'none');
    assert.equal(getContractorDirectoryStatus().recordCount, 0);
  });

  test('cached directory works fully offline (no fetch involved at all -- this module has none)', () => {
    const storage = globalThis.localStorage;
    writeCacheDirect(storage, [{ dtId: 'SCM-HLG 960', normalizedKey: 'SCMHLG960', contractor: 'STM' }]);
    loadCachedContractorDirectory();
    assert.equal(lookupContractor('SCM-HLG 960'), 'STM');
  });
});

/* ============================================================
   UPDATE EVENT SUBSCRIPTION
============================================================ */
describe('subscribeContractorDirectoryUpdated()', () => {
  test('reloading via the event marks the snapshot "synced" (distinct from "cached")', () => {
    const storage = globalThis.localStorage;
    const eventTarget = new EventTarget();

    // Nothing cached yet at "init".
    assert.equal(loadCachedContractorDirectory(), null);
    assert.equal(getContractorDirectorySnapshot().source, 'none');

    let received = null;
    const unsubscribe = subscribeContractorDirectoryUpdated((detail) => { received = detail; }, { eventTarget });

    // Simulate Monitor's sync: write the cache directly, then dispatch
    // the event exactly like contractor-directory-core.js's
    // dispatchDirectoryUpdated() does.
    writeCacheDirect(storage, [{ dtId: 'SCM-LIM 601', normalizedKey: 'SCMLIM601', contractor: 'REAL' }]);
    eventTarget.dispatchEvent(new CustomEvent('hpal:contractor-directory-updated', { detail: { source: 'remote', recordCount: 1, fetchedAt: '2026-08-07T00:00:00.000Z' } }));

    assert.ok(received);
    assert.equal(getContractorDirectorySnapshot().source, 'synced');
    assert.equal(lookupContractor('SCM-LIM 601'), 'REAL');

    unsubscribe();
  });

  test('unsubscribe() stops further reloads', () => {
    const storage = globalThis.localStorage;
    const eventTarget = new EventTarget();
    let calls = 0;
    const unsubscribe = subscribeContractorDirectoryUpdated(() => { calls++; }, { eventTarget });
    unsubscribe();

    writeCacheDirect(storage, [{ dtId: 'SCM-LIM 601', normalizedKey: 'SCMLIM601', contractor: 'REAL' }]);
    eventTarget.dispatchEvent(new CustomEvent('hpal:contractor-directory-updated', { detail: {} }));
    assert.equal(calls, 0);
  });

  test('with no usable event target, subscribing is a safe no-op (never throws)', () => {
    const unsubscribe = subscribeContractorDirectoryUpdated(() => { throw new Error('must never be called'); }, { eventTarget: null });
    assert.doesNotThrow(() => unsubscribe());
  });
});

/* ============================================================
   LOOKUP
============================================================ */
describe('lookupContractor()', () => {
  test('a cached record is returned', () => {
    writeCacheDirect(globalThis.localStorage, [{ dtId: 'SCM-LIM 601', normalizedKey: 'SCMLIM601', contractor: 'REAL' }]);
    loadCachedContractorDirectory();
    assert.equal(lookupContractor('SCM-LIM 601'), 'REAL');
  });

  test('an unmatched DT stays unmatched (null, never a guess)', () => {
    writeCacheDirect(globalThis.localStorage, [{ dtId: 'SCM-LIM 601', normalizedKey: 'SCMLIM601', contractor: 'REAL' }]);
    loadCachedContractorDirectory();
    assert.equal(lookupContractor('SCM-LIM 999999'), null);
  });

  test('with no cache, lookupContractor() returns null for everything', () => {
    assert.equal(getContractorDirectorySnapshot().source, 'none');
    assert.equal(lookupContractor('SCM-LIM 949'), null);
  });

  test('getContractorDirectoryStatus() reports a summary without the full records array', () => {
    const status = getContractorDirectoryStatus();
    assert.equal(status.source, 'none');
    assert.equal(status.recordCount, 0);
    assert.ok(!('records' in status));
  });
});

/* ============================================================
   MODULE BOUNDARY -- no fetch, no endpoint, no DOM, no write API
============================================================ */
describe('Module boundary', () => {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  const source = fs.readFileSync(path.join(__dirname, '../js/services/contractor-directory-service.js'), 'utf8');

  test('Report performs no fetch and owns no endpoint constant', () => {
    const codeOnly = source
      .split('\n')
      .filter((line) => !line.trim().startsWith('//'))
      .join('\n')
      .replace(/\/\*[\s\S]*?\*\//g, '');
    assert.doesNotMatch(codeOnly, /\bfetch\(/);
    assert.doesNotMatch(codeOnly, /CONTRACTOR_ENDPOINT/);
    assert.doesNotMatch(codeOnly, /script\.google\.com/);
    assert.doesNotMatch(codeOnly, /AbortController/);
  });

  test('no direct Monitor DOM dependency exists', () => {
    const codeOnly = source
      .split('\n')
      .filter((line) => !line.trim().startsWith('//'))
      .join('\n')
      .replace(/\/\*[\s\S]*?\*\//g, '');
    assert.doesNotMatch(codeOnly, /document\./);
    assert.doesNotMatch(codeOnly, /getElementById/);
    assert.doesNotMatch(codeOnly, /from ['"].*contractor-assignment/);
  });

  test('no write API exists', () => {
    assert.doesNotMatch(source, /upsert/i);
    assert.doesNotMatch(source, /POST/);
    assert.doesNotMatch(source, /writeContractor/i);
    assert.doesNotMatch(source, /method:\s*['"]POST['"]/i);
  });
});
