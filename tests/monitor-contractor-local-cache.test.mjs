// Contractor local-first startup cache tests (V2.5.1 -- Offline-First
// Cold Startup, startup audit Root Cause D / this task's Sections
// 17-23/26/27/41/42).
//
// Run with Node's built-in test runner:
//
//   node --test tests/monitor-contractor-local-cache.test.mjs
//
// Covers, in order:
//   - readLocalJson()/writeLocalJson() (the window.storage replacement)
//   - loadRemoteContractorCache()/saveRemoteContractorCache() (the new
//     "last SUCCESSFULLY-synced Google Sheet dataset" local cache)
//   - loadPendingQueue()/savePendingQueue() (the same window.storage
//     repair applied to the offline write queue)
//   - manual contractor override persistence across a simulated reload
//   - source precedence: personal override > live Google Sheet > embedded
//     fallback (UNCHANGED by this task -- the new remote cache only ever
//     seeds the "live Google Sheet" tier)
//
// index.html is not an ES module and depends on many browser-only
// globals impractical to fully mock in Node (same posture as
// tests/monitor-contractor-bridge.test.mjs, whose extractFunctionSource()
// helper is reused here). Every function under test here is DOM-free by
// design (this task's Section 17 requirement), so each is extracted
// VERBATIM (brace matching) and actually executed via Node's vm module
// against a minimal mock `window.localStorage` -- this runs the real,
// shipped persistence code, not a re-implementation of it. Never touches
// the real filesystem/network/DOM.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const indexHtmlPath = path.join(ROOT, 'index.html');
const indexHtml = fs.readFileSync(indexHtmlPath, 'utf8');

// Objects/arrays CREATED BY CODE RUNNING INSIDE a vm.Context (object/array
// literals evaluated there use that context's OWN Object/Array
// intrinsics, a different realm than this test file's) compare as
// "same structure but not reference-equal" under assert.deepEqual/
// deepStrictEqual against a plain host-realm object, even when their
// contents are identical -- a well-known Node `vm` cross-realm quirk, not
// a real behavioral difference. Round-tripping through JSON.stringify
// (executed INSIDE the vm context) + JSON.parse (executed OUT HERE, in
// the host realm) always yields a plain host-realm value, safe to compare
// normally regardless of which realm the original value was constructed
// in.
function pull(context, expr) {
  return JSON.parse(vm.runInContext(`JSON.stringify(${expr})`, context));
}

function extractFunctionSource(source, name) {
  const startMatch = source.match(new RegExp(`function\\s+${name}\\s*\\([^)]*\\)\\s*\\{`));
  if (!startMatch) throw new Error(`function ${name} not found`);
  const bodyStart = startMatch.index + startMatch[0].length;
  let depth = 1;
  let i = bodyStart;
  for (; i < source.length && depth > 0; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') depth--;
  }
  if (depth !== 0) throw new Error(`unbalanced braces extracting ${name}`);
  return source.slice(startMatch.index, i);
}

// A tiny real-ish localStorage mock -- getItem/setItem/removeItem against
// a plain Map, plus opt-in failure injection for the quota/security-error
// tests below.
function createMockLocalStorage(initial, { throwOnGet, throwOnSet } = {}) {
  const store = new Map(Object.entries(initial || {}));
  return {
    getItem: (key) => {
      if (throwOnGet) throw new Error('SecurityError: storage access denied');
      return store.has(key) ? store.get(key) : null;
    },
    setItem: (key, value) => {
      if (throwOnSet) throw new Error('QuotaExceededError: storage full');
      store.set(key, String(value));
    },
    removeItem: (key) => store.delete(key),
    _store: store,
  };
}

/* ============================================================
   17. readLocalJson()/writeLocalJson() -- the window.storage replacement
============================================================ */
describe('17. readLocalJson()/writeLocalJson() -- safe local persistence, no network dependency', () => {
  const helperSource = `${extractFunctionSource(indexHtml, 'readLocalJson')}\n${extractFunctionSource(indexHtml, 'writeLocalJson')}`;

  function buildSandbox(localStorage) {
    const sandbox = { window: { localStorage }, JSON };
    const context = vm.createContext(sandbox);
    vm.runInContext(helperSource, context);
    return context;
  }

  test('readLocalJson() returns the parsed value when present and valid', () => {
    const ctx = buildSandbox(createMockLocalStorage({ myKey: JSON.stringify({ a: 1 }) }));
    const result = vm.runInContext("readLocalJson('myKey', null)", ctx);
    assert.deepEqual(result, { a: 1 });
  });

  test('readLocalJson() returns the fallback when the key is missing', () => {
    const ctx = buildSandbox(createMockLocalStorage({}));
    const result = vm.runInContext("readLocalJson('missing', 'FALLBACK')", ctx);
    assert.equal(result, 'FALLBACK');
  });

  test('E. readLocalJson() returns the fallback (never crashes/throws) on corrupted JSON', () => {
    const ctx = buildSandbox(createMockLocalStorage({ myKey: '{not valid json' }));
    assert.doesNotThrow(() => {
      const result = vm.runInContext("readLocalJson('myKey', 'FALLBACK')", ctx);
      assert.equal(result, 'FALLBACK');
    });
  });

  test('readLocalJson() returns the fallback (never throws) when localStorage.getItem itself throws (Safari private-mode SecurityError)', () => {
    const ctx = buildSandbox(createMockLocalStorage({}, { throwOnGet: true }));
    assert.doesNotThrow(() => {
      const result = vm.runInContext("readLocalJson('myKey', 'FALLBACK')", ctx);
      assert.equal(result, 'FALLBACK');
    });
  });

  test('readLocalJson() returns the fallback when window.localStorage itself is unavailable', () => {
    const sandbox = { window: {}, JSON };
    const context = vm.createContext(sandbox);
    vm.runInContext(helperSource, context);
    const result = vm.runInContext("readLocalJson('myKey', 'FALLBACK')", context);
    assert.equal(result, 'FALLBACK');
  });

  test('writeLocalJson() persists a JSON-serialized value and returns true on success', () => {
    const storage = createMockLocalStorage({});
    const ctx = buildSandbox(storage);
    const ok = vm.runInContext("writeLocalJson('myKey', { hello: 'world' })", ctx);
    assert.equal(ok, true);
    assert.equal(storage._store.get('myKey'), JSON.stringify({ hello: 'world' }));
  });

  test('writeLocalJson() returns false (never throws) on a quota/security error', () => {
    const ctx = buildSandbox(createMockLocalStorage({}, { throwOnSet: true }));
    assert.doesNotThrow(() => {
      const ok = vm.runInContext("writeLocalJson('myKey', { a: 1 })", ctx);
      assert.equal(ok, false);
    });
  });

  test('writeLocalJson() returns false when window.localStorage itself is unavailable, without throwing', () => {
    const sandbox = { window: {}, JSON };
    const context = vm.createContext(sandbox);
    vm.runInContext(helperSource, context);
    const ok = vm.runInContext("writeLocalJson('myKey', { a: 1 })", context);
    assert.equal(ok, false);
  });
});

/* ============================================================
   18-23/41 A/B/E. loadRemoteContractorCache()/saveRemoteContractorCache()
   -- the "last SUCCESSFULLY-synced Google Sheet dataset" local cache.
============================================================ */
describe('19-23/41 A/B/E. loadRemoteContractorCache()/saveRemoteContractorCache()', () => {
  // Module-level declarations these two functions close over in
  // index.html, extracted verbatim (not hand re-declared) so the sandbox
  // reflects the real constants/state shape exactly.
  const constKeyMatch = indexHtml.match(/const REMOTE_CACHE_KEY = '([^']+)';/);
  const constVersionMatch = indexHtml.match(/const REMOTE_CACHE_VERSION = (\d+);/);
  assert.ok(constKeyMatch && constVersionMatch, 'expected REMOTE_CACHE_KEY/REMOTE_CACHE_VERSION in index.html');

  const helperSource = [
    extractFunctionSource(indexHtml, 'readLocalJson'),
    extractFunctionSource(indexHtml, 'writeLocalJson'),
    `const REMOTE_CACHE_KEY = '${constKeyMatch[1]}';`,
    `const REMOTE_CACHE_VERSION = ${constVersionMatch[1]};`,
    'let liveContractorMap = {};',
    "let liveMapStatus = { loaded:false, count:0, lastSync:null, error:null, fromCache:false };",
    extractFunctionSource(indexHtml, 'loadRemoteContractorCache'),
    extractFunctionSource(indexHtml, 'saveRemoteContractorCache'),
  ].join('\n');

  function buildSandbox(localStorage) {
    const sandbox = { window: { localStorage }, JSON, Date };
    const context = vm.createContext(sandbox);
    vm.runInContext(helperSource, context);
    return context;
  }

  test('A. no cache exists: liveContractorMap/liveMapStatus stay at their defaults ({} / not-yet-loaded, fromCache:false) -- the embedded fallback remains what getEffectiveContractorMap() uses', () => {
    const ctx = buildSandbox(createMockLocalStorage({}));
    vm.runInContext('loadRemoteContractorCache()', ctx);
    assert.deepEqual(pull(ctx, 'liveContractorMap'), {});
    const status = vm.runInContext('liveMapStatus', ctx);
    assert.equal(status.loaded, false);
    assert.equal(status.fromCache, false);
    assert.equal(status.error, null);
  });

  test('B. a valid last-known cache seeds liveContractorMap/liveMapStatus BEFORE any network fetch runs (synchronous, no await)', () => {
    const cache = { version: 1, updatedAt: '2026-08-01T00:00:00.000Z', map: { 'SCM-LIM 733': 'PMS' } };
    const ctx = buildSandbox(createMockLocalStorage({ [constKeyMatch[1]]: JSON.stringify(cache) }));
    vm.runInContext('loadRemoteContractorCache()', ctx);
    assert.deepEqual(pull(ctx, 'liveContractorMap'), { 'SCM-LIM 733': 'PMS' });
    const status = vm.runInContext('liveMapStatus', ctx);
    assert.equal(status.loaded, false, 'not yet CONFIRMED by a live fetch this session');
    assert.equal(status.fromCache, true, 'must be marked as seeded from cache, so the UI can show "local data, syncing" instead of a bare empty state');
    assert.equal(status.count, 1);
    assert.equal(status.lastSync, '2026-08-01T00:00:00.000Z');
  });

  test('E. a corrupted/wrong-version cache does not crash and leaves state at defaults (safe fallback)', () => {
    const ctxCorrupted = buildSandbox(createMockLocalStorage({ [constKeyMatch[1]]: '{not valid json' }));
    assert.doesNotThrow(() => vm.runInContext('loadRemoteContractorCache()', ctxCorrupted));
    assert.deepEqual(pull(ctxCorrupted, 'liveContractorMap'), {});

    const wrongVersion = { version: 99, updatedAt: 'x', map: { a: 'b' } };
    const ctxWrongVersion = buildSandbox(createMockLocalStorage({ [constKeyMatch[1]]: JSON.stringify(wrongVersion) }));
    vm.runInContext('loadRemoteContractorCache()', ctxWrongVersion);
    assert.deepEqual(pull(ctxWrongVersion, 'liveContractorMap'), {}, 'an unrecognized cacheVersion must never be trusted');
  });

  test('saveRemoteContractorCache() persists { version, updatedAt, map } under REMOTE_CACHE_KEY', () => {
    const storage = createMockLocalStorage({});
    const ctx = buildSandbox(storage);
    vm.runInContext("saveRemoteContractorCache({ 'SCM-LIM 733': 'PMS' })", ctx);
    const saved = JSON.parse(storage._store.get(constKeyMatch[1]));
    assert.equal(saved.version, 1);
    assert.ok(typeof saved.updatedAt === 'string' && saved.updatedAt.length > 0);
    assert.deepEqual(saved.map, { 'SCM-LIM 733': 'PMS' });
  });

  test('round-trip: saveRemoteContractorCache() then loadRemoteContractorCache() (a fresh "reload") reproduces the same map', () => {
    const storage = createMockLocalStorage({});
    const writeCtx = buildSandbox(storage);
    vm.runInContext("saveRemoteContractorCache({ 'SCM-HLG 401': 'STM' })", writeCtx);

    // A brand-new sandbox/context sharing only the underlying storage --
    // simulating a full app restart reading back what a PREVIOUS session
    // wrote.
    const reloadCtx = buildSandbox(storage);
    vm.runInContext('loadRemoteContractorCache()', reloadCtx);
    assert.deepEqual(vm.runInContext('liveContractorMap', reloadCtx), { 'SCM-HLG 401': 'STM' });
    assert.equal(vm.runInContext('liveMapStatus.fromCache', reloadCtx), true);
  });
});

/* ============================================================
   27/41 G. loadPendingQueue()/savePendingQueue() -- the SAME
   window.storage repair applied to the offline write queue (unchanged
   queue semantics -- this task's Section 27 explicitly forbids
   redesigning it).
============================================================ */
describe('27/41 G. loadPendingQueue()/savePendingQueue() persistence repair', () => {
  const pendingKeyMatch = indexHtml.match(/const PENDING_QUEUE_KEY = '([^']+)';/);
  assert.ok(pendingKeyMatch, 'expected PENDING_QUEUE_KEY in index.html');

  const helperSource = [
    extractFunctionSource(indexHtml, 'readLocalJson'),
    extractFunctionSource(indexHtml, 'writeLocalJson'),
    `const PENDING_QUEUE_KEY = '${pendingKeyMatch[1]}';`,
    'let pendingQueue = [];',
    'let pendingQueueMemory = null;',
    extractFunctionSource(indexHtml, 'loadPendingQueue'),
    extractFunctionSource(indexHtml, 'savePendingQueue'),
  ].join('\n');

  function buildSandbox(localStorage) {
    const sandbox = { window: { localStorage }, JSON };
    const context = vm.createContext(sandbox);
    vm.runInContext(helperSource, context);
    return context;
  }

  test('loadPendingQueue() defaults to an empty array when nothing is stored', () => {
    const ctx = buildSandbox(createMockLocalStorage({}));
    vm.runInContext('loadPendingQueue()', ctx);
    assert.deepEqual(pull(ctx, 'pendingQueue'), []);
  });

  test('a corrupted stored queue does not crash and falls back to an empty array', () => {
    const ctx = buildSandbox(createMockLocalStorage({ [pendingKeyMatch[1]]: '{not an array' }));
    assert.doesNotThrow(() => vm.runInContext('loadPendingQueue()', ctx));
    assert.deepEqual(pull(ctx, 'pendingQueue'), []);
  });

  test('G. round-trip: savePendingQueue() then loadPendingQueue() in a fresh "reload" reproduces the same queue -- it now actually survives a restart (previously always dead-fell-through window.storage)', () => {
    const storage = createMockLocalStorage({});
    const writeCtx = buildSandbox(storage);
    vm.runInContext("pendingQueue = [{ dtId: 'SCM-LIM 733', contractor: 'PMS', queuedAt: '2026-08-01T00:00:00.000Z' }]", writeCtx);
    vm.runInContext('savePendingQueue()', writeCtx);

    const reloadCtx = buildSandbox(storage);
    vm.runInContext('loadPendingQueue()', reloadCtx);
    assert.deepEqual(vm.runInContext('pendingQueue', reloadCtx), [
      { dtId: 'SCM-LIM 733', contractor: 'PMS', queuedAt: '2026-08-01T00:00:00.000Z' },
    ]);
  });

  test('savePendingQueue() falls back to the in-memory pendingQueueMemory only when localStorage itself is unavailable/full (best-effort, never throws)', () => {
    const ctx = buildSandbox(createMockLocalStorage({}, { throwOnSet: true }));
    vm.runInContext("pendingQueue = [{ dtId: 'X', contractor: 'Y', queuedAt: 'z' }]", ctx);
    assert.doesNotThrow(() => vm.runInContext('savePendingQueue()', ctx));
    assert.deepEqual(pull(ctx, 'pendingQueueMemory'), [{ dtId: 'X', contractor: 'Y', queuedAt: 'z' }]);
  });
});

/* ============================================================
   26/41 F. Manual contractor override (handleContractorFile()) now
   persists via writeLocalJson, not the dead window.storage API -- and
   actually survives a simulated reload.
============================================================ */
describe('26/41 F. Manual contractor override persists across a simulated reload', () => {
  test('handleContractorFile() no longer references window.storage anywhere', () => {
    const fnSource = extractFunctionSource(indexHtml, 'handleContractorFile');
    assert.doesNotMatch(fnSource, /window\.storage/);
    assert.match(fnSource, /writeLocalJson\(STORAGE_KEY, contractorData\)/);
  });

  test('loadContractorData(), loadPendingQueue(), savePendingQueue() no longer reference window.storage anywhere in index.html', () => {
    for (const name of ['loadContractorData', 'loadPendingQueue', 'savePendingQueue']) {
      const fnSource = extractFunctionSource(indexHtml, name);
      assert.doesNotMatch(fnSource, /window\.storage/, `${name}() must not reference window.storage`);
    }
  });

  test('window.storage is never CALLED anywhere in index.html any more (the dead API is fully removed from actual code, not just worked around in some call sites)', () => {
    // Checks the actual invocation patterns (property access / call),
    // not the bare substring -- two comments (the THEME CONTROLLER header
    // this task left untouched, and readLocalJson/writeLocalJson's own
    // new header) legitimately still mention "window.storage" in prose,
    // documenting the historical bug both blocks fix. That is expected
    // and fine, same posture as tests/monitor-contractor-bridge.test.mjs's
    // "prose comments documenting the removal are expected and fine".
    assert.doesNotMatch(indexHtml, /window\.storage\s*[.&)]/);
  });

  test('round-trip: writeLocalJson(STORAGE_KEY, ...) then a fresh loadContractorData()-style read reproduces the manual override, unaffected by the new REMOTE_CACHE_KEY', () => {
    const storageKeyMatch = indexHtml.match(/const STORAGE_KEY = '([^']+)';/);
    assert.ok(storageKeyMatch);
    const helperSource = [
      extractFunctionSource(indexHtml, 'readLocalJson'),
      extractFunctionSource(indexHtml, 'writeLocalJson'),
      `const STORAGE_KEY = '${storageKeyMatch[1]}';`,
    ].join('\n');

    const storage = createMockLocalStorage({});
    const writeContext = vm.createContext({ window: { localStorage: storage }, JSON });
    vm.runInContext(helperSource, writeContext);
    const contractorData = { map: { 'SCM-LIM 733': 'PMS' }, filename: 'List_DT.xlsx', uploadedAt: '2026-08-01T00:00:00.000Z', count: 1, isDefault: false };
    vm.runInContext(`writeLocalJson(STORAGE_KEY, ${JSON.stringify(contractorData)})`, writeContext);

    const reloadContext = vm.createContext({ window: { localStorage: storage }, JSON });
    vm.runInContext(helperSource, reloadContext);
    const reread = vm.runInContext("readLocalJson(STORAGE_KEY, null) || { map: {}, filename: null, uploadedAt: null, count: 0, isDefault: true }", reloadContext);
    assert.deepEqual(reread, contractorData);
  });
});

/* ============================================================
   20/42. SOURCE PRECEDENCE -- locked in as-is, unchanged by this task.
   personal override > live Google Sheet (now possibly seeded from
   REMOTE_CACHE_KEY) > embedded fallback. Extends
   tests/monitor-contractor-bridge.test.mjs's existing precedence
   coverage with the NEW cache-seeding scenario specifically.
============================================================ */
describe('20/42. Contractor source precedence is unchanged: personal override > live Google Sheet > embedded fallback', () => {
  function buildEffectiveMapSandbox({ embedded, live, personal }) {
    const getEffectiveSource = extractFunctionSource(indexHtml, 'getEffectiveContractorMap');
    const sandbox = {
      EMBEDDED_CONTRACTOR_MAP: embedded,
      liveContractorMap: live,
      contractorData: personal ? { map: personal, isDefault: false } : { map: {}, isDefault: true },
    };
    const context = vm.createContext(sandbox);
    vm.runInContext(getEffectiveSource, context);
    return context;
  }

  test('a REMOTE_CACHE_KEY-seeded liveContractorMap participates at exactly the "live Google Sheet" precedence tier -- still beaten by a personal override', () => {
    const context = buildEffectiveMapSandbox({
      embedded: { 'SCM-LIM 733': 'EMBEDDED-STALE' },
      live: { 'SCM-LIM 733': 'PMS-FROM-CACHE' }, // as if seeded by loadRemoteContractorCache()
      personal: { 'SCM-LIM 733': 'PERSONAL-OVERRIDE' },
    });
    const result = vm.runInContext('getEffectiveContractorMap()', context);
    assert.equal(result['SCM-LIM 733'], 'PERSONAL-OVERRIDE');
  });

  test('a REMOTE_CACHE_KEY-seeded liveContractorMap still beats the embedded fallback when there is no personal override', () => {
    const context = buildEffectiveMapSandbox({
      embedded: { 'SCM-LIM 733': 'EMBEDDED-STALE' },
      live: { 'SCM-LIM 733': 'PMS-FROM-CACHE' },
      personal: null,
    });
    const result = vm.runInContext('getEffectiveContractorMap()', context);
    assert.equal(result['SCM-LIM 733'], 'PMS-FROM-CACHE');
  });

  test('D. a failed live fetch (liveMapStatus.error set) does not change getEffectiveContractorMap()\'s precedence -- liveContractorMap (last-known-good, cached or freshly-live) is untouched by fetchSheetContractors()\'s catch branch, so the effective map keeps showing it, never silently reverting to the embedded fallback', () => {
    const fnSource = extractFunctionSource(indexHtml, 'fetchSheetContractors');
    const catchIdx = fnSource.indexOf('}catch(err){');
    assert.ok(catchIdx !== -1);
    const catchBlock = fnSource.slice(catchIdx);
    assert.doesNotMatch(catchBlock, /liveContractorMap\s*=/, 'the failure branch must never reassign liveContractorMap -- only liveMapStatus (error/fromCache bookkeeping)');
  });

  test('C. a successful live fetch marks fromCache:false and persists the new cache -- both in the same statement group, before publishing/rendering', () => {
    const fnSource = extractFunctionSource(indexHtml, 'fetchSheetContractors');
    const mapAssignIdx = fnSource.indexOf('liveContractorMap = map;');
    const statusAssignIdx = fnSource.indexOf('fromCache:false');
    const saveCacheIdx = fnSource.indexOf('saveRemoteContractorCache(map)');
    const publishIdx = fnSource.indexOf("publishMonitorContractorDirectory('monitor-sync')");
    assert.ok([mapAssignIdx, statusAssignIdx, saveCacheIdx, publishIdx].every((i) => i !== -1));
    assert.ok(mapAssignIdx < statusAssignIdx);
    assert.ok(statusAssignIdx < saveCacheIdx);
    assert.ok(saveCacheIdx < publishIdx);
  });

  test('D. the failure branch preserves fromCache instead of resetting it -- a failed sync must never erase or hide previously-good local/cached contractor data', () => {
    const fnSource = extractFunctionSource(indexHtml, 'fetchSheetContractors');
    const catchIdx = fnSource.indexOf('}catch(err){');
    const catchBlock = fnSource.slice(catchIdx);
    assert.match(catchBlock, /fromCache:\s*liveMapStatus\.fromCache/);
  });

  test('the failure branch never calls saveRemoteContractorCache() (only a confirmed-successful sync is ever persisted as "last-known-good")', () => {
    const fnSource = extractFunctionSource(indexHtml, 'fetchSheetContractors');
    const catchIdx = fnSource.indexOf('}catch(err){');
    const catchBlock = fnSource.slice(catchIdx);
    assert.doesNotMatch(catchBlock, /saveRemoteContractorCache/);
  });
});
