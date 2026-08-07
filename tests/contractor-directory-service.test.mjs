// Shared contractor directory service (contractor directory drift fix)
// tests.
//
// Run with Node's built-in test runner (Node 18+, zero new dependencies):
//
//   node --test tests/contractor-directory-service.test.mjs
//
// Never calls the live Google Apps Script endpoint -- every network path
// goes through a mock `globalThis.fetch`, and every cache path goes
// through a mock `globalThis.localStorage` (a Map-backed Storage
// look-alike), mirroring tests/personnel-directory-service.test.mjs's own
// conventions exactly since this service is a deliberate structural
// mirror of that one. The service module is a singleton (module-scoped
// `snapshot`), so every test that touches sync/cache state resets via
// beforeEach.

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
  syncContractorDirectory,
  getContractorDirectorySnapshot,
  getContractorDirectoryStatus,
  lookupContractor,
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

function mockResponse(payload, { ok = true } = {}) {
  return { ok, json: async () => payload };
}

function row(dtId, contractor) {
  return { dtId, contractor };
}

beforeEach(() => {
  installMockStorage();
  clearContractorDirectoryCache();
  delete globalThis.fetch;
});

/* ============================================================
   NORMALIZATION
============================================================ */
describe('canonicalDtId() / normalizedKey() -- consolidated Report lookup normalization', () => {
  test('6. all required variants resolve to one key', () => {
    const variants = ['SCM-LIM 949', 'SCM LIM 949', 'SCM_LIM_949', 'SCM-LIM-949', 'SCM-LIM 949 DT', 'SCM-LIM 949 DT.'];
    const keys = variants.map(normalizedKey);
    assert.ok(keys.every((k) => k === 'SCMLIM949'), `expected all variants to resolve to SCMLIM949, got ${JSON.stringify(keys)}`);
    assert.ok(variants.every((v) => canonicalDtId(v) === 'SCM-LIM 949'));
  });

  test('7. unrelated ids do not collide', () => {
    // Different digits, different letter groups, and a non-SCM id all
    // must produce distinct (or empty, for the non-SCM case) keys.
    assert.notEqual(normalizedKey('SCM-LIM 94'), normalizedKey('SCM-LIM 949'));
    assert.notEqual(normalizedKey('SCM-ABC 1'), normalizedKey('SCM-ABD 1'));
    assert.notEqual(normalizedKey('SCM-LIM 949'), normalizedKey('SCM-LIM 9490'));
    // Non-SCM-prefixed ids (covered only by the static fallback table,
    // never the synced directory) canonicalize to an empty key rather
    // than colliding with anything.
    assert.equal(normalizedKey('ADT 001'), '');
    assert.equal(normalizedKey('MIM 117'), '');
    assert.equal(normalizedKey('DT014KS'), '');
  });

  test('lowercase and mixed-case input normalize the same as uppercase', () => {
    assert.equal(normalizedKey('scm-lim 949'), 'SCMLIM949');
    assert.equal(normalizedKey('Scm-Lim 949'), 'SCMLIM949');
  });
});

/* ============================================================
   VALIDATION
============================================================ */
describe('validateContractorRecords() -- pure, no DOM/network', () => {
  test('1. valid remote-shaped rows accepted', () => {
    const result = validateContractorRecords([row('SCM-LIM 949', 'TII'), row('SCM-LIM 601', 'REAL')]);
    assert.equal(result.ok, true);
    assert.equal(result.records.length, 2);
  });

  test('2. invalid response (not an array) rejected', () => {
    assert.equal(validateContractorRecords({ not: 'an array' }).ok, false);
    assert.equal(validateContractorRecords(null).ok, false);
    assert.equal(validateContractorRecords('nope').ok, false);
  });

  test('3. malformed row rejected (whole set fails closed)', () => {
    const missingContractor = validateContractorRecords([row('SCM-LIM 949', 'TII'), { dtId: 'SCM-LIM 950' }]);
    assert.equal(missingContractor.ok, false);

    const missingId = validateContractorRecords([row('SCM-LIM 949', 'TII'), { contractor: 'REAL' }]);
    assert.equal(missingId.ok, false);

    const nonScmId = validateContractorRecords([row('SCM-LIM 949', 'TII'), row('ADT 001', 'ADT HILLCON')]);
    // "ADT 001" canonicalizes to an empty key (not SCM-shaped) -> the row
    // itself is treated as malformed for this service's own directory
    // (it belongs only to the static fallback table).
    assert.equal(nonScmId.ok, false);
  });

  test('4. duplicate identical record accepted deterministically', () => {
    const result = validateContractorRecords([row('SCM-LIM 949', 'TII'), row('SCM LIM 949', 'TII')]);
    assert.equal(result.ok, true);
    assert.equal(result.records.length, 1);
    assert.equal(result.records[0].contractor, 'TII');
  });

  test('5. duplicate conflicting record rejected', () => {
    const result = validateContractorRecords([row('SCM-LIM 601', 'HYNC'), row('SCM LIM 601', 'REAL')]);
    assert.equal(result.ok, false);
    assert.match(result.error, /conflicting/i);
  });
});

/* ============================================================
   LOCAL CACHE
============================================================ */
describe('Local cache', () => {
  test('20. cached directory works offline (no fetch involved)', () => {
    const storage = globalThis.localStorage;
    storage.setItem(CACHE_KEY, JSON.stringify({
      cacheVersion: 1,
      source: 'remote',
      fetchedAt: '2026-08-07T00:00:00.000Z',
      records: [{ dtId: 'SCM-LIM 949', normalizedKey: 'SCMLIM949', contractor: 'TII' }],
    }));

    const result = loadCachedContractorDirectory();
    assert.ok(result);
    assert.equal(result.source, 'shared-cache');
    assert.equal(lookupContractor('SCM-LIM 949'), 'TII');
  });

  test('malformed cache is rejected without throwing and without touching the existing snapshot', () => {
    const storage = globalThis.localStorage;
    storage.setItem(CACHE_KEY, 'not json');
    const result = loadCachedContractorDirectory();
    assert.equal(result, null);
    assert.equal(getContractorDirectorySnapshot().source, 'none');
  });

  test('wrong cacheVersion is rejected', () => {
    const storage = globalThis.localStorage;
    storage.setItem(CACHE_KEY, JSON.stringify({ cacheVersion: 999, records: [] }));
    assert.equal(loadCachedContractorDirectory(), null);
  });
});

/* ============================================================
   REMOTE SYNC
============================================================ */
describe('Remote sync', () => {
  test('successful sync replaces the persisted cache and in-memory snapshot', async () => {
    globalThis.fetch = async () => mockResponse([row('SCM-LIM 949', 'TII')]);
    const result = await syncContractorDirectory();
    assert.equal(result.ok, true);
    assert.equal(getContractorDirectorySnapshot().source, 'remote');
    assert.equal(lookupContractor('SCM-LIM 949'), 'TII');

    const storage = globalThis.localStorage;
    const cached = JSON.parse(storage.getItem(CACHE_KEY));
    assert.equal(cached.records.length, 1);
  });

  test('21. failed remote sync preserves a previously valid cache', async () => {
    globalThis.fetch = async () => mockResponse([row('SCM-LIM 949', 'TII')]);
    await syncContractorDirectory();
    assert.equal(lookupContractor('SCM-LIM 949'), 'TII');

    globalThis.fetch = async () => mockResponse(null, { ok: false });
    const result = await syncContractorDirectory();
    assert.equal(result.ok, false);
    // The previously synced snapshot must still be intact.
    assert.equal(lookupContractor('SCM-LIM 949'), 'TII');
  });

  test('invalid remote payload never overwrites a valid cache', async () => {
    globalThis.fetch = async () => mockResponse([row('SCM-LIM 949', 'TII')]);
    await syncContractorDirectory();

    globalThis.fetch = async () => mockResponse([row('SCM-LIM 601', 'HYNC'), row('SCM LIM 601', 'REAL')]); // conflicting
    const result = await syncContractorDirectory();
    assert.equal(result.ok, false);
    assert.equal(lookupContractor('SCM-LIM 949'), 'TII');
    assert.equal(lookupContractor('SCM-LIM 601'), null);
  });

  test('22. concurrent sync calls reuse one in-flight request', async () => {
    let callCount = 0;
    globalThis.fetch = async () => {
      callCount++;
      return mockResponse([row('SCM-LIM 949', 'TII')]);
    };
    const [a, b] = [syncContractorDirectory(), syncContractorDirectory()];
    assert.equal(a, b); // same in-flight promise object
    await Promise.all([a, b]);
    assert.equal(callCount, 1);
  });

  test('network failure returns a safe service error, never raw internals', async () => {
    globalThis.fetch = async () => {
      throw new Error('ECONNRESET some raw internal detail');
    };
    const result = await syncContractorDirectory();
    assert.equal(result.ok, false);
    assert.doesNotMatch(result.error, /ECONNRESET/);
  });

  test('uses the proven transport pattern: GET, cache no-store, redirect follow, cache-busting timestamp, no custom headers/mode', async () => {
    let capturedUrl;
    let capturedInit;
    globalThis.fetch = async (url, init) => {
      capturedUrl = url;
      capturedInit = init;
      return mockResponse([]);
    };
    await syncContractorDirectory();
    assert.match(capturedUrl, /\?t=\d+$/);
    assert.equal(capturedInit.method, 'GET');
    assert.equal(capturedInit.cache, 'no-store');
    assert.equal(capturedInit.redirect, 'follow');
    assert.equal(capturedInit.headers, undefined);
    assert.equal(capturedInit.mode, undefined);
    assert.equal(capturedInit.credentials, undefined);
  });
});

/* ============================================================
   4-6. SOURCE STATUS REPORTING
   Report must never silently present the static fallback as if it were
   synchronized -- getContractorDirectoryStatus()'s `source` field is what
   the visible "List DT: Remote/Cached/Static fallback" status line reads.
============================================================ */
describe('Source status reporting', () => {
  test('4. source status reports Remote after a successful sync', async () => {
    globalThis.fetch = async () => mockResponse([row('SCM-LIM 949', 'TII'), row('SCM-LIM 601', 'REAL')]);
    await syncContractorDirectory();
    const status = getContractorDirectoryStatus();
    assert.equal(status.source, 'remote');
    assert.equal(status.recordCount, 2);
  });

  test('5. source status reports Shared cache when loaded from the shared localStorage cache without a fetch', () => {
    globalThis.localStorage.setItem(CACHE_KEY, JSON.stringify({
      cacheVersion: 1,
      source: 'remote',
      fetchedAt: '2026-08-07T00:00:00.000Z',
      records: [{ dtId: 'SCM-LIM 949', normalizedKey: 'SCMLIM949', contractor: 'TII' }],
    }));
    loadCachedContractorDirectory();
    const status = getContractorDirectoryStatus();
    assert.equal(status.source, 'shared-cache');
    assert.equal(status.recordCount, 1);
  });

  test('6. source status reports "none" (rendered as Static fallback by report-page.js) with no sync and no cache', () => {
    const status = getContractorDirectoryStatus();
    assert.equal(status.source, 'none');
    assert.equal(status.recordCount, 0);
  });
});

/* ============================================================
   LOOKUP PRECEDENCE (service level)
============================================================ */
describe('lookupContractor()', () => {
  test('8. a synced record is returned', async () => {
    globalThis.fetch = async () => mockResponse([row('SCM-LIM 601', 'REAL')]);
    await syncContractorDirectory();
    assert.equal(lookupContractor('SCM-LIM 601'), 'REAL');
  });

  test('9. a cached record (loaded without any fetch) is returned the same way a synced one is', () => {
    const storage = globalThis.localStorage;
    storage.setItem(CACHE_KEY, JSON.stringify({
      cacheVersion: 1,
      source: 'remote',
      fetchedAt: '2026-08-07T00:00:00.000Z',
      records: [{ dtId: 'SCM-LIM 601', normalizedKey: 'SCMLIM601', contractor: 'REAL' }],
    }));
    loadCachedContractorDirectory();
    assert.equal(lookupContractor('SCM-LIM 601'), 'REAL');
  });

  test('11. an unmatched DT stays unmatched (null, never a guess)', async () => {
    globalThis.fetch = async () => mockResponse([row('SCM-LIM 601', 'REAL')]);
    await syncContractorDirectory();
    assert.equal(lookupContractor('SCM-LIM 999999'), null);
    assert.equal(lookupContractor('TOTALLY-UNKNOWN-ID'), null);
  });

  test('10. with no sync and no cache, lookupContractor() returns null for everything (caller falls through to the static fallback)', () => {
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
   23-24. NO MONITOR DOM DEPENDENCY / NO WRITE API
============================================================ */
describe('Module boundary', () => {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  const source = fs.readFileSync(path.join(__dirname, '../js/services/contractor-directory-service.js'), 'utf8');

  test('23. no direct Monitor DOM dependency exists', () => {
    // Checks actual code, not prose comments explaining the *absence* of
    // this dependency (this file's header comment legitimately mentions
    // "contractor-assignment.js" by name to document why it is NOT
    // imported) -- strip comments first so the check inspects only
    // executable statements. `window.addEventListener`/`window` as a
    // browser event-target default is explicitly approved architecture
    // for this shared-cache-bridge round (production browser event
    // integration uses window.addEventListener/dispatchEvent) -- it is
    // not "Monitor DOM" and is intentionally not forbidden here; only
    // actual DOM manipulation (document.*, getElementById) and importing
    // from contractor-assignment.js are.
    const codeOnly = source
      .split('\n')
      .filter((line) => !line.trim().startsWith('//'))
      .join('\n')
      .replace(/\/\*[\s\S]*?\*\//g, '');
    assert.doesNotMatch(codeOnly, /document\./);
    assert.doesNotMatch(codeOnly, /getElementById/);
    assert.doesNotMatch(codeOnly, /from ['"].*contractor-assignment/);
  });

  test('24. no write API exists', () => {
    assert.doesNotMatch(source, /upsert/i);
    assert.doesNotMatch(source, /POST/);
    assert.doesNotMatch(source, /writeContractor/i);
    assert.doesNotMatch(source, /method:\s*['"]POST['"]/i);
  });
});
