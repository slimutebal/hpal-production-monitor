// service-worker.js / manifest.webmanifest tests (V2.4 Phase 8 -- PWA
// integration; V2.5.1 -- Offline-First Cold Startup local-first
// navigation, see this task's Sections 4-8/36/43).
//
// Run with Node's built-in test runner:
//
//   node --test tests/service-worker.test.mjs
//
// service-worker.js is a classic (non-module) worker script that expects
// `self`/`caches`/`clients` globals unavailable under Node, so it can
// never be `import`ed directly. Most assertions below inspect its SOURCE
// TEXT (extracted array contents, presence/absence of specific handler
// logic) -- the same convention already used elsewhere in this suite
// (e.g. tests/calculate-page.test.mjs's CSS-source assertions). The
// "4/43. Local-first navigation" describe block goes further: it extracts
// the real fetch handler's function BODY (brace-matching, the same
// technique tests/monitor-contractor-bridge.test.mjs already uses for
// index.html) and actually RUNS it via Node's vm module against a minimal
// mock of self/caches/fetch -- real behavioral proof of the new
// cache-first-with-background-refresh navigation contract, not just a
// pattern match against the source text.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import vm from 'node:vm';

import { APP_VERSION } from '../js/shared/app-version.js';
import { SW_MESSAGE } from '../js/services/app-update-service.js';
import { computeAssetRevision, extractServiceWorkerConstant, readAssetBytes } from './tools/sw-release-revision.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const swSource = readFileSync(path.join(ROOT, 'service-worker.js'), 'utf8');
const indexHtml = readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const manifest = JSON.parse(readFileSync(path.join(ROOT, 'manifest.webmanifest'), 'utf8'));

// `//` line comments are stripped first so an apostrophe inside a comment
// (e.g. a possessive "file's") can never be misread as a string-literal
// delimiter by the extraction regex below. Splits on /\r\n|\n/ (not a bare
// '\n') so a CRLF-checked-out working tree (this repo's convention -- see
// .gitattributes-less core.autocrlf) never leaves a trailing '\r' on each
// line: `.` in a JS regex excludes line terminators (CR included), so an
// un-stripped trailing '\r' would silently make `/\/\/.*$/` fail to match
// at all on that line, leaving the "stripped" comment fully intact.
function stripLineComments(source) {
  return source.split(/\r\n|\n/).map((line) => line.replace(/\/\/.*$/, '')).join('\n');
}

// Extracts the APP_SHELL array's string literals without executing the
// worker script (which references `self`/`caches`, unavailable here).
function extractAppShell(source) {
  const clean = stripLineComments(source);
  const match = clean.match(/const APP_SHELL = \[([\s\S]*?)\];/);
  assert.ok(match, 'service-worker.js must define a const APP_SHELL = [...] array');
  return [...match[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
}

const appShell = extractAppShell(swSource);
const swAppVersion = extractServiceWorkerConstant(swSource, 'APP_VERSION');
const swAssetRevision = extractServiceWorkerConstant(swSource, 'ASSET_REVISION');
const swCachePrefix = extractServiceWorkerConstant(swSource, 'CACHE_PREFIX');
const cacheName = `${swCachePrefix}shell-${swAppVersion}-${swAssetRevision}`;

// v3.1.1 -- replaces the old hand-bumped CACHE_NAME string literal (which
// v3.1.0 forgot to bump, so installed PWAs never noticed that release).
describe('v3.1.1. Release identity: generated, canonical, and tied to every precached asset', () => {
  test('service-worker.js APP_VERSION mirrors the canonical js/shared/app-version.js APP_VERSION', () => {
    assert.equal(swAppVersion, APP_VERSION);
  });

  test('ASSET_REVISION matches the current content of every APP_SHELL file (run tests/tools/sync-service-worker-release.mjs if this fails)', () => {
    const expected = computeAssetRevision(ROOT, appShell);
    assert.equal(
      swAssetRevision,
      expected,
      `service-worker.js ASSET_REVISION is stale (${swAssetRevision} != ${expected}). A precached asset changed without the worker changing, so installed PWAs would never detect this release. Run: node tests/tools/sync-service-worker-release.mjs`,
    );
  });

  test('the asset revision is sensitive to asset content and insensitive to CRLF/LF checkout differences', () => {
    const base = computeAssetRevision(ROOT, ['./js/shared/app-version.js']);
    assert.match(base, /^[0-9a-f]{12}$/);
    assert.notEqual(base, computeAssetRevision(ROOT, ['./js/shared/ore-classification.js']));
    const lf = readAssetBytes(ROOT, './js/shared/app-version.js');
    assert.equal(lf.includes(0x0d), false, 'text assets are hashed with LF line endings');
  });

  test('CACHE_NAME is declared exactly once and derived from CACHE_PREFIX + APP_VERSION + ASSET_REVISION (no second hand-maintained version)', () => {
    const occurrences = [...swSource.matchAll(/const CACHE_NAME = /g)];
    assert.equal(occurrences.length, 1);
    assert.match(swSource, /const CACHE_NAME = `\$\{CACHE_PREFIX\}shell-\$\{APP_VERSION\}-\$\{ASSET_REVISION\}`;/);
    assert.equal(swCachePrefix, 'hpal-production-monitor-');
    assert.notEqual(cacheName, 'hpal-production-monitor-v3.0.1-report-dap-exw-ytd');
  });

  test('message types are identical to js/services/app-update-service.js SW_MESSAGE', () => {
    assert.equal(extractServiceWorkerConstant(swSource, 'SW_MESSAGE_SKIP_WAITING'), SW_MESSAGE.SKIP_WAITING);
    assert.equal(extractServiceWorkerConstant(swSource, 'SW_MESSAGE_GET_VERSION'), SW_MESSAGE.GET_VERSION);
    assert.equal(extractServiceWorkerConstant(swSource, 'SW_MESSAGE_VERSION'), SW_MESSAGE.VERSION);
  });

  test('the update service module (imported by Settings) is precached for offline startup', () => {
    assert.ok(appShell.includes('./js/services/app-update-service.js'));
    const settingsSource = readFileSync(path.join(ROOT, 'js', 'pages', 'settings', 'settings-page.js'), 'utf8');
    assert.match(settingsSource, /from '\.\.\/\.\.\/services\/app-update-service\.js'/);
  });
});

describe('9/11/36. Vendor library files (SheetJS/Chart.js) are precached and actually exist on disk', () => {
  test('assets/vendor/xlsx.min.js and assets/vendor/chart.umd.min.js are both listed in APP_SHELL', () => {
    assert.ok(appShell.includes('./assets/vendor/xlsx.min.js'));
    assert.ok(appShell.includes('./assets/vendor/chart.umd.min.js'));
  });

  test('every APP_SHELL entry resolves to a real file on disk (cache.addAll() must never fail on install due to a wrong path)', () => {
    const missing = [];
    for (const entry of appShell) {
      if (entry === './') continue; // resolves to index.html at the server level, not a distinct file
      const relPath = entry.replace(/^\.\//, '');
      const absPath = path.join(ROOT, relPath);
      if (!existsSync(absPath)) missing.push(entry);
    }
    assert.deepEqual(missing, [], `APP_SHELL entries with no file on disk: ${missing.join(', ')}`);
  });

  test('the relocated vendor files preserve their original library license banners (this task\'s Section 9: relocation only, never a version change)', () => {
    const xlsxSource = readFileSync(path.join(ROOT, 'assets', 'vendor', 'xlsx.min.js'), 'utf8');
    const chartSource = readFileSync(path.join(ROOT, 'assets', 'vendor', 'chart.umd.min.js'), 'utf8');
    assert.match(xlsxSource, /SheetJS/);
    assert.match(chartSource, /Chart\.js v4\.5\.1/);
    assert.match(chartSource, /Released under the MIT License/);
  });

  test('neither vendor file contains a leftover <script> wrapper tag from the extraction', () => {
    const xlsxSource = readFileSync(path.join(ROOT, 'assets', 'vendor', 'xlsx.min.js'), 'utf8');
    const chartSource = readFileSync(path.join(ROOT, 'assets', 'vendor', 'chart.umd.min.js'), 'utf8');
    assert.doesNotMatch(xlsxSource, /<\/?script>/);
    assert.doesNotMatch(chartSource, /<\/?script>/);
  });
});

describe('21. Calculate runtime assets are present in APP_SHELL', () => {
  test('assets/css/calculate.css is precached', () => {
    assert.ok(appShell.includes('./assets/css/calculate.css'));
  });

  test('js/shared/ore-classification.js is precached (shared with Report, required transitively by Calculate)', () => {
    assert.ok(appShell.includes('./js/shared/ore-classification.js'));
  });

  test('every Calculate page module is precached: calculate-page.js and its full local import graph', () => {
    const expected = [
      './js/pages/calculate/calculate-page.js',
      './js/pages/calculate/blend-calculator.js',
      './js/pages/calculate/calculate-validation.js',
      './js/pages/calculate/blending-recommendation.js',
      // V3.0 Phase 7B -- Recommendation Worker + main-thread client (this
      // task's Section 10). See the dedicated "Recommendation Worker"
      // describe block below for the Worker-specific offline assertions.
      './js/pages/calculate/recommendation-worker.js',
      './js/pages/calculate/recommendation-worker-client.js',
      './js/pages/calculate/fleet-allocation.js',
      './js/pages/calculate/recommendation-ranking.js',
      './js/pages/calculate/recommendation-actions.js',
      './js/pages/calculate/planned-blend-recovery.js',
      './js/pages/calculate/hopper-pattern.js',
      // V2.4.1 Bug A -- the shared locale-aware decimal-parsing module.
      './js/pages/calculate/number-input.js',
      // V2.5 -- the new Contractor Continuity / Operational Fleet
      // Optimization module (this task's Section 41).
      './js/pages/calculate/operational-continuity.js',
    ];
    for (const file of expected) {
      assert.ok(appShell.includes(file), `APP_SHELL is missing ${file}`);
    }
  });

  test('assets/css/settings.css (Bug B mobile font-size fix) remains precached', () => {
    assert.ok(appShell.includes('./assets/css/settings.css'));
  });
});

// This is the "new modules cannot be accidentally omitted" regression
// requirement (this task's Section 25) implemented WITHOUT a second
// hand-maintained file list: it parses every actual `import ... from
// './x.js'` statement (single- or multi-line) inside js/pages/calculate/
// and js/shared/ore-classification.js's own dependents, and fails if any
// resolved local file is missing from APP_SHELL -- so a FUTURE new
// calculate/*.js file that gets imported but never added to the service
// worker will break this test automatically, without anyone having to
// remember to update a duplicate list here.
describe('25. Completeness: no Calculate-reachable local module can be silently omitted', () => {
  test('every local (same-directory or shared) import reachable from calculate-page.js resolves to a file already listed in APP_SHELL', () => {
    const calculateDir = path.join(ROOT, 'js', 'pages', 'calculate');
    const visited = new Set();
    const toVisit = ['calculate-page.js'];
    const missing = [];

    while (toVisit.length > 0) {
      const relFile = toVisit.pop();
      if (visited.has(relFile)) continue;
      visited.add(relFile);

      const absFile = path.join(calculateDir, relFile);
      const source = stripLineComments(readFileSync(absFile, 'utf8'));
      // Matches `from '...'` regardless of single-line or multi-line
      // `import { a, b, c } from '...'` statements. Comments are stripped
      // first (see stripLineComments()) so a comment phrase like "derived
      // from 'X'" can never be misread as a real import path.
      const importPaths = [...source.matchAll(/from\s+'([^']+)'/g)].map((m) => m[1]);

      for (const importPath of importPaths) {
        if (importPath.startsWith('./')) {
          const localName = importPath.slice(2);
          const shellPath = `./js/pages/calculate/${localName}`;
          if (!appShell.includes(shellPath)) missing.push(shellPath);
          toVisit.push(localName);
        } else if (importPath.includes('shared/ore-classification.js')) {
          if (!appShell.includes('./js/shared/ore-classification.js')) missing.push('./js/shared/ore-classification.js');
        }
        // Imports outside js/pages/calculate/ and outside
        // shared/ore-classification.js (i18n.js, router.js,
        // license-service.js, report-utils.js) are already covered by the
        // pre-existing V2.3 APP_SHELL entries -- unchanged by this task,
        // not re-verified here to avoid duplicating that regression.
      }
    }

    assert.deepEqual(missing, [], `APP_SHELL is missing files reachable from calculate-page.js: ${missing.join(', ')}`);
  });
});

// V3.0 Phase 7B (this task's Sections 2/10) -- static-source proof (no
// jsdom/real Worker available under Node, same limitation this file's own
// header comment already documents for service-worker.js itself) that the
// Worker/client pair is both offline-cacheable AND wired the way this
// phase requires: no second solver implementation, and subpath-safe
// (GitHub Pages) URL resolution rather than a hand-built absolute path.
describe('V3.0 Phase 7B -- Recommendation Worker + client are offline-available and correctly wired', () => {
  const workerSource = readFileSync(path.join(ROOT, 'js', 'pages', 'calculate', 'recommendation-worker.js'), 'utf8');
  const clientSource = readFileSync(path.join(ROOT, 'js', 'pages', 'calculate', 'recommendation-worker-client.js'), 'utf8');

  test('recommendation-worker.js and recommendation-worker-client.js are both precached in APP_SHELL', () => {
    assert.ok(appShell.includes('./js/pages/calculate/recommendation-worker.js'));
    assert.ok(appShell.includes('./js/pages/calculate/recommendation-worker-client.js'));
  });

  test('the Worker imports the production findBlendRecommendations() rather than defining a second solver implementation (this task\'s Section 1)', () => {
    assert.match(workerSource, /import\s*\{\s*findBlendRecommendations\s*\}\s*from\s*'\.\/blending-recommendation\.js'/);
    assert.doesNotMatch(workerSource, /function\s+findBlendRecommendations/);
  });

  test('the client resolves the Worker script via new URL(..., import.meta.url) with { type: \'module\' } -- subpath/GitHub-Pages-safe rather than a hand-built absolute path (this task\'s Section 2)', () => {
    assert.match(clientSource, /new URL\('\.\/recommendation-worker\.js',\s*import\.meta\.url\)/);
    assert.match(clientSource, /\{\s*type:\s*'module'\s*\}/);
  });
});

// V3.0 Phase 7C (release Section 3) -- walks the Worker's OWN transitive
// import graph starting at recommendation-worker.js itself, independent of
// whatever calculate-page.js happens to import. Test 25 above already walks
// from calculate-page.js and today reaches this same graph transitively
// (calculate-page.js still imports DEFAULT_RECOMMENDATION_TOLERANCE from
// blending-recommendation.js directly), but that coverage is incidental: if
// that one constant import were ever removed in favor of a fully
// Worker-encapsulated Recommendation call, test 25 would stop walking into
// blending-recommendation.js/exact-hardcase-solver.js and silently lose
// this coverage. This block makes the Worker's own offline-completeness
// requirement a first-class, independently-anchored invariant: a cold
// offline installed PWA must be able to load recommendation-worker.js and
// every module it imports (directly or transitively) with zero network
// dependency, for as long as the Worker file exists at all.
describe('V3.0 Phase 7C -- Worker module graph is fully offline-cacheable, walked from recommendation-worker.js itself', () => {
  test('every local import reachable from recommendation-worker.js resolves to a file already listed in APP_SHELL', () => {
    const calculateDir = path.join(ROOT, 'js', 'pages', 'calculate');
    const visited = new Set();
    const toVisit = ['recommendation-worker.js'];
    const missing = [];
    const graph = [];

    while (toVisit.length > 0) {
      const relFile = toVisit.pop();
      if (visited.has(relFile)) continue;
      visited.add(relFile);
      graph.push(relFile);

      const absFile = path.join(calculateDir, relFile);
      const source = stripLineComments(readFileSync(absFile, 'utf8'));
      const importPaths = [...source.matchAll(/from\s+'([^']+)'/g)].map((m) => m[1]);

      for (const importPath of importPaths) {
        if (importPath.startsWith('./')) {
          const localName = importPath.slice(2);
          const shellPath = `./js/pages/calculate/${localName}`;
          if (!appShell.includes(shellPath)) missing.push(shellPath);
          toVisit.push(localName);
        } else if (importPath.includes('shared/ore-classification.js')) {
          if (!appShell.includes('./js/shared/ore-classification.js')) missing.push('./js/shared/ore-classification.js');
        }
      }
    }

    assert.deepEqual(missing, [], `APP_SHELL is missing files reachable from recommendation-worker.js: ${missing.join(', ')}`);
    // Sanity check on the walk itself -- if this ever comes back empty/tiny,
    // the regex-based import walker silently broke (e.g. a syntax change
    // it can no longer parse), which would make the assertion above above a
    // false pass rather than a real one.
    for (const required of ['blending-recommendation.js', 'exact-hardcase-solver.js', 'fleet-allocation.js', 'recommendation-ranking.js', 'operational-continuity.js', 'calculate-validation.js', 'number-input.js']) {
      assert.ok(graph.includes(required), `expected the Worker's own import walk to reach ${required}, got: ${graph.join(', ')}`);
    }
  });
});

describe('23/28. Offline shell behavior and cache policy', () => {
  test('install precaches the full APP_SHELL, and skipWaiting() is called only conditionally (migration) or on the user\'s SKIP_WAITING message', () => {
    assert.match(swSource, /cache\.addAll\(APP_SHELL\.map\(\(url\) => new Request\(url, \{ cache: 'reload' \}\)\)\)/);
    const codeOnly = stripLineComments(swSource);
    const skipWaitingCalls = codeOnly.match(/self\.skipWaiting\(\)/g) || [];
    assert.equal(skipWaitingCalls.length, 2, 'exactly two call sites: the legacy-migration branch of install, and the SKIP_WAITING message');
    assert.match(codeOnly, /if \(!waitForUser\) await self\.skipWaiting\(\);/);
    assert.doesNotMatch(codeOnly, /\.then\(\(\) => self\.skipWaiting\(\)\)/, 'install must no longer activate unconditionally');
  });

  test('activate deletes only this app\'s other shell caches (CACHE_PREFIX), then claims clients', () => {
    const activateBody = swSource.slice(swSource.indexOf('async function handleActivate()'), swSource.indexOf("self.addEventListener('install'"));
    assert.match(activateBody, /key\.startsWith\(CACHE_PREFIX\) && key !== CACHE_NAME/);
    assert.match(activateBody, /caches\.delete/);
    assert.match(activateBody, /self\.clients\.claim\(\)/);
  });

  test('cross-origin requests are never cached -- fetched directly and returned', () => {
    assert.match(swSource, /requestUrl\.origin\s*!==\s*self\.location\.origin/);
    const crossOriginBlock = swSource.match(/if \(requestUrl\.origin !== self\.location\.origin\) \{[\s\S]*?\}/);
    assert.ok(crossOriginBlock);
    assert.match(crossOriginBlock[0], /fetch\(request\)/);
    assert.doesNotMatch(crossOriginBlock[0], /caches\.open|cache\.put/);
  });

  test('non-GET requests are never intercepted/cached', () => {
    assert.match(swSource, /request\.method\s*!==\s*'GET'/);
  });

  test('13. the worker never touches persisted user data: no localStorage, IndexedDB, clear(), unregister(), or blanket cache deletion', () => {
    const codeOnly = stripLineComments(swSource);
    assert.doesNotMatch(codeOnly, /localStorage/);
    assert.doesNotMatch(codeOnly, /indexedDB/i);
    assert.doesNotMatch(codeOnly, /\.clear\(\)/);
    assert.doesNotMatch(codeOnly, /unregister/);
    // Every caches.delete() is scoped: either this install's own new cache
    // on failure, or a CACHE_PREFIX-filtered key on activate.
    const deletes = codeOnly.match(/caches\.delete\([^)]*\)/g) || [];
    assert.deepEqual(deletes.sort(), ['caches.delete(CACHE_NAME)', 'caches.delete(key)'].sort());
  });
});

/* ============================================================
   BEHAVIORAL proof of the worker lifecycle (install / activate / message /
   fetch). service-worker.js is a classic worker script that cannot be
   `import`ed under Node, so the WHOLE real script is evaluated in a vm
   context against a small in-memory mock of self / Cache Storage / fetch /
   Request / Response -- this runs the shipped handlers themselves, not a
   re-implementation of them.
============================================================ */
const ORIGIN = 'https://example.test';
const SW_URL = `${ORIGIN}/service-worker.js`;
const LEGACY_CACHE = 'hpal-production-monitor-v3.0.1-report-dap-exw-ytd';

function toUrl(key) {
  return new URL(typeof key === 'string' ? key : key.url, SW_URL).href;
}

class MockResponse {
  constructor(body = '', init = {}) {
    this._body = body;
    this.status = init.status ?? 200;
    this.type = init.type ?? 'basic';
  }
  get ok() { return this.status >= 200 && this.status < 300; }
  async text() { return String(this._body); }
  clone() { return new MockResponse(this._body, { status: this.status, type: this.type }); }
  static error() { return new MockResponse('', { status: 0, type: 'error' }); }
}

class MockRequest {
  constructor(url, init = {}) {
    this.url = toUrl(url);
    this.cache = init.cache ?? 'default';
    this.method = init.method ?? 'GET';
    this.mode = init.mode ?? 'cors';
  }
}

function createCacheStorage(initial = {}) {
  const caches = new Map();
  const makeCache = () => {
    const store = new Map();
    return {
      store,
      async match(key) { return store.get(toUrl(key)); },
      async put(key, response) { store.set(toUrl(key), response); },
      async addAll(requests) {
        const responses = [];
        for (const request of requests) {
          const response = await sandboxFetch(request);
          if (!response || !response.ok) throw new TypeError(`addAll: bad response for ${request.url}`);
          responses.push([request, response]);
        }
        responses.forEach(([request, response]) => store.set(toUrl(request), response));
      },
    };
  };
  let sandboxFetch = null;
  for (const [name, entries] of Object.entries(initial)) {
    const cache = makeCache();
    for (const [key, value] of Object.entries(entries)) cache.store.set(toUrl(key), value);
    caches.set(name, cache);
  }
  return {
    _caches: caches,
    _setFetch(fn) { sandboxFetch = fn; },
    async open(name) {
      if (!caches.has(name)) caches.set(name, makeCache());
      return caches.get(name);
    },
    async has(name) { return caches.has(name); },
    async keys() { return [...caches.keys()]; },
    async delete(name) { return caches.delete(name); },
    async match(key) {
      for (const cache of caches.values()) {
        const hit = await cache.match(key);
        if (hit) return hit;
      }
      return undefined;
    },
  };
}

// Simulates the deployed site: app-version.js carries `appVersionText`
// (defaults to the real file), every other asset a tagged body.
function deployedSite({ appVersionText = readFileSync(path.join(ROOT, 'js', 'shared', 'app-version.js'), 'utf8'), failPath = null } = {}) {
  const requests = [];
  const fetchImpl = async (request) => {
    requests.push(request);
    const { pathname } = new URL(request.url);
    if (failPath && pathname === failPath) throw new TypeError('Failed to fetch');
    if (pathname === '/js/shared/app-version.js') return new MockResponse(appVersionText);
    return new MockResponse(`network:${pathname}`);
  };
  return { fetchImpl, requests };
}

function loadServiceWorker({ cacheEntries = {}, activeWorker = null, fetchImpl = deployedSite().fetchImpl } = {}) {
  const handlers = {};
  const calls = { skipWaiting: 0, claim: 0 };
  const caches = createCacheStorage(cacheEntries);
  caches._setFetch((request) => sandbox.fetch(request));
  const sandbox = {
    self: {
      location: { origin: ORIGIN, href: SW_URL },
      registration: { active: activeWorker },
      addEventListener: (type, fn) => { handlers[type] = fn; },
      skipWaiting: async () => { calls.skipWaiting += 1; },
      clients: { claim: async () => { calls.claim += 1; } },
    },
    caches,
    fetch: fetchImpl,
    Request: MockRequest,
    Response: MockResponse,
    URL,
    console,
  };
  vm.runInContext(swSource, vm.createContext(sandbox));

  async function dispatchExtendable(type, extra = {}) {
    const promises = [];
    handlers[type]({ ...extra, waitUntil: (p) => promises.push(Promise.resolve(p)) });
    return Promise.all(promises);
  }

  async function dispatchFetch(request) {
    let responsePromise = null;
    const waitUntil = [];
    handlers.fetch({
      request,
      respondWith: (p) => { responsePromise = Promise.resolve(p); },
      waitUntil: (p) => waitUntil.push(Promise.resolve(p).catch(() => {})),
    });
    const response = responsePromise ? await responsePromise : undefined;
    await Promise.all(waitUntil);
    await new Promise((resolve) => setImmediate(resolve));
    return { response, respondedWith: responsePromise !== null };
  }

  return {
    handlers,
    calls,
    caches,
    sandbox,
    install: () => dispatchExtendable('install'),
    activate: () => dispatchExtendable('activate'),
    message: (data, ports = []) => dispatchExtendable('message', { data, ports }),
    fetch: dispatchFetch,
  };
}

const ACTIVE_WORKER = { state: 'activated', scriptURL: SW_URL };
const UPDATER_MARKER = './__hpal-sw-updater-active__';
const PREVIOUS_UPDATER_CACHE = 'hpal-production-monitor-shell-v3.1.0-aaaaaaaaaaaa';

describe('14. Install: complete, fresh, verified precache', () => {
  test('first install precaches every APP_SHELL entry into this release\'s cache, bypassing the HTTP cache', async () => {
    const site = deployedSite();
    const sw = loadServiceWorker({ fetchImpl: site.fetchImpl });
    await sw.install();
    const cache = sw.caches._caches.get(cacheName);
    assert.ok(cache, `expected cache ${cacheName}`);
    for (const entry of appShell) {
      assert.ok(cache.store.has(toUrl(entry)), `missing precached ${entry}`);
    }
    assert.equal(site.requests.length, appShell.length);
    assert.ok(site.requests.every((r) => r.cache === 'reload'), 'every precache request must use cache: reload');
  });

  test('9. stale/half-propagated deployment: precached app-version.js does not match APP_VERSION -> install fails, its new cache is removed, the active release is untouched', async () => {
    const site = deployedSite({ appVersionText: "export const APP_VERSION = 'v3.0.1';" });
    const activeCache = { './index.html': new MockResponse('old-index'), [UPDATER_MARKER]: new MockResponse('v3.1.0') };
    const sw = loadServiceWorker({ fetchImpl: site.fetchImpl, activeWorker: ACTIVE_WORKER, cacheEntries: { [PREVIOUS_UPDATER_CACHE]: activeCache } });
    await assert.rejects(sw.install(), /does not declare/);
    assert.equal(sw.caches._caches.has(cacheName), false);
    assert.equal(sw.caches._caches.has(PREVIOUS_UPDATER_CACHE), true);
    assert.equal(sw.calls.skipWaiting, 0);
  });

  test('9b. a network failure during precache fails the install without partial writes or touching other caches', async () => {
    const site = deployedSite({ failPath: '/js/pages/report/report-utils.js' });
    const sw = loadServiceWorker({ fetchImpl: site.fetchImpl, activeWorker: ACTIVE_WORKER, cacheEntries: { [PREVIOUS_UPDATER_CACHE]: { [UPDATER_MARKER]: new MockResponse('v3.1.0') } } });
    await assert.rejects(sw.install());
    assert.equal(sw.caches._caches.has(cacheName), false);
    assert.equal(sw.caches._caches.has(PREVIOUS_UPDATER_CACHE), true);
  });

  test('a failed install never deletes a pre-existing cache with the same release identity (it may be the active one)', async () => {
    const site = deployedSite({ failPath: '/index.html' });
    const sw = loadServiceWorker({ fetchImpl: site.fetchImpl, activeWorker: ACTIVE_WORKER, cacheEntries: { [cacheName]: { './index.html': new MockResponse('active-index'), [UPDATER_MARKER]: new MockResponse(APP_VERSION) } } });
    await assert.rejects(sw.install());
    assert.equal(sw.caches._caches.has(cacheName), true);
  });
});

describe('8/10. Waiting for the user -- no unexpected activation', () => {
  test('8. an updater-aware worker is active: the new release installs and WAITS (no skipWaiting)', async () => {
    const sw = loadServiceWorker({
      activeWorker: ACTIVE_WORKER,
      cacheEntries: { [PREVIOUS_UPDATER_CACHE]: { './index.html': new MockResponse('old'), [UPDATER_MARKER]: new MockResponse('v3.1.0') } },
    });
    await sw.install();
    assert.equal(sw.calls.skipWaiting, 0);
  });

  test('migration: the active worker is a legacy pre-updater release (no marker) -> one-time self-activation, since its page has no Update Now button', async () => {
    const sw = loadServiceWorker({
      activeWorker: ACTIVE_WORKER,
      cacheEntries: { [LEGACY_CACHE]: { './index.html': new MockResponse('legacy-index') } },
    });
    await sw.install();
    assert.equal(sw.calls.skipWaiting, 1);
  });

  test('first-ever install (no active worker) activates immediately as before', async () => {
    const sw = loadServiceWorker();
    await sw.install();
    assert.equal(sw.calls.skipWaiting, 1);
  });

  test('11. SKIP_WAITING message (sent only by Settings\' Update Now) activates the waiting worker; unknown messages do nothing', async () => {
    const sw = loadServiceWorker();
    await sw.message({ type: 'SOMETHING_ELSE' });
    assert.equal(sw.calls.skipWaiting, 0);
    await sw.message({ type: SW_MESSAGE.SKIP_WAITING });
    assert.equal(sw.calls.skipWaiting, 1);
  });

  test('2. GET_VERSION answers with this worker\'s APP_VERSION over the supplied port', async () => {
    const sw = loadServiceWorker();
    const received = [];
    await sw.message({ type: SW_MESSAGE.GET_VERSION }, [{ postMessage: (m) => received.push(m) }]);
    // JSON round-trip: the object was created inside the vm realm.
    assert.deepEqual(JSON.parse(JSON.stringify(received)), [{ type: SW_MESSAGE.VERSION, version: APP_VERSION, assetRevision: swAssetRevision }]);
  });
});

describe('13. Activate: replaces obsolete shell caches only, never user or foreign data', () => {
  test('deletes this app\'s legacy and previous-release shell caches, keeps foreign caches, marks itself updater-aware, claims clients', async () => {
    const sw = loadServiceWorker({
      cacheEntries: {
        [LEGACY_CACHE]: { './index.html': new MockResponse('legacy') },
        [PREVIOUS_UPDATER_CACHE]: { './index.html': new MockResponse('prev') },
        'another-app-runtime-cache': { '/data.json': new MockResponse('{}') },
      },
    });
    await sw.install();
    await sw.activate();
    assert.deepEqual([...sw.caches._caches.keys()].sort(), [cacheName, 'another-app-runtime-cache'].sort());
    const marker = await sw.caches._caches.get(cacheName).match(UPDATER_MARKER);
    assert.equal(await marker.text(), APP_VERSION);
    assert.equal(sw.calls.claim, 1);
  });

  test('after activation, the NEXT release sees the marker and waits for the user', async () => {
    const first = loadServiceWorker();
    await first.install();
    await first.activate();
    const carriedOver = Object.fromEntries([...first.caches._caches.entries()].map(([name, cache]) => [name, Object.fromEntries(cache.store)]));
    const next = loadServiceWorker({ activeWorker: ACTIVE_WORKER, cacheEntries: carriedOver });
    await next.install();
    assert.equal(next.calls.skipWaiting, 0);
  });
});

describe('4/43. Local-first navigation and cache-first assets -- behavioral proof', () => {
  function navigateRequest(url = `${ORIGIN}/`) {
    return { method: 'GET', mode: 'navigate', url };
  }

  test('A. cached index exists in this release\'s cache: served immediately, the network is not awaited (a hung fetch never delays it)', async () => {
    let fetchCalls = 0;
    const sw = loadServiceWorker({
      fetchImpl: () => { fetchCalls += 1; return new Promise(() => {}); },
      cacheEntries: { [cacheName]: { './index.html': new MockResponse('cached-index') } },
    });
    const { response } = await sw.fetch(navigateRequest());
    assert.equal(await response.text(), 'cached-index');
    assert.equal(fetchCalls, 0);
  });

  test('B. navigation never writes a freshly deployed index.html into the running release\'s cache (no mixed-version shell)', async () => {
    const sw = loadServiceWorker({
      fetchImpl: async () => new MockResponse('NEW-index'),
      cacheEntries: { [cacheName]: { './index.html': new MockResponse('cached-index') } },
    });
    await sw.fetch(navigateRequest());
    const stored = await sw.caches._caches.get(cacheName).match('./index.html');
    assert.equal(await stored.text(), 'cached-index');
  });

  test('C. no cached index at all: falls back to the network (first-ever load)', async () => {
    const sw = loadServiceWorker({ fetchImpl: async () => new MockResponse('network-index') });
    const { response } = await sw.fetch(navigateRequest());
    assert.equal(await response.text(), 'network-index');
  });

  test('D. offline with no index in this release\'s cache: any cached index is still served rather than an error', async () => {
    const sw = loadServiceWorker({
      fetchImpl: async () => { throw new TypeError('offline'); },
      cacheEntries: { [LEGACY_CACHE]: { './index.html': new MockResponse('legacy-index') } },
    });
    const { response } = await sw.fetch(navigateRequest());
    assert.equal(await response.text(), 'legacy-index');
  });

  test('cross-origin requests still bypass the cache entirely (Google Apps Script contractor sync must never be cached)', async () => {
    const sw = loadServiceWorker({ fetchImpl: async () => new MockResponse('cross-origin-response') });
    const { response } = await sw.fetch({ method: 'GET', mode: 'no-cors', url: 'https://script.google.com/macros/s/xyz/exec' });
    assert.equal(await response.text(), 'cross-origin-response');
    assert.equal(sw.caches._caches.size, 0);
  });

  test('non-GET requests are not intercepted', async () => {
    const sw = loadServiceWorker();
    const { respondedWith } = await sw.fetch({ method: 'POST', mode: 'cors', url: `${ORIGIN}/x` });
    assert.equal(respondedWith, false);
  });

  test('14. static assets: cache hit in this release\'s cache is served with no network fetch', async () => {
    let fetchCalls = 0;
    const sw = loadServiceWorker({
      fetchImpl: async () => { fetchCalls += 1; return new MockResponse('network-asset'); },
      cacheEntries: { [cacheName]: { './js/app.js': new MockResponse('cached-asset') } },
    });
    const { response } = await sw.fetch({ method: 'GET', mode: 'cors', url: `${ORIGIN}/js/app.js` });
    assert.equal(await response.text(), 'cached-asset');
    assert.equal(fetchCalls, 0);
  });

  test('static assets are never served from ANOTHER release\'s cache (no old-module/new-shell mixing)', async () => {
    const sw = loadServiceWorker({
      fetchImpl: async () => new MockResponse('network-asset'),
      cacheEntries: { [LEGACY_CACHE]: { './js/app.js': new MockResponse('legacy-asset') } },
    });
    const { response } = await sw.fetch({ method: 'GET', mode: 'cors', url: `${ORIGIN}/js/app.js` });
    assert.equal(await response.text(), 'network-asset');
  });

  test('14b. offline after install: every precached APP_SHELL file is served from cache with zero network access', async () => {
    const online = loadServiceWorker();
    await online.install();
    await online.activate();
    const precached = Object.fromEntries([...online.caches._caches.entries()].map(([name, cache]) => [name, Object.fromEntries(cache.store)]));
    const offline = loadServiceWorker({ fetchImpl: async () => { throw new TypeError('offline'); }, cacheEntries: precached });
    for (const entry of appShell.filter((e) => e !== './')) {
      const { response } = await offline.fetch({ method: 'GET', mode: 'cors', url: toUrl(entry) });
      assert.ok(response, `no offline response for ${entry}`);
    }
    const { response: nav } = await offline.fetch(navigateRequest());
    assert.ok(nav, 'navigation must work offline');
  });
});

describe('26. Manifest / installability unchanged and still valid', () => {
  test('start_url, display, and icon set remain valid', () => {
    assert.equal(manifest.start_url, './index.html');
    assert.equal(manifest.display, 'standalone');
    assert.ok(Array.isArray(manifest.icons) && manifest.icons.length >= 4);
    manifest.icons.forEach((icon) => {
      assert.ok(icon.src && icon.sizes && icon.type);
    });
  });

  test('theme_color/background_color remain defined (not removed by this task)', () => {
    assert.ok(manifest.theme_color);
    assert.ok(manifest.background_color);
  });
});

describe('PWA registration (V2.4 Phase 8 -- previously missing)', () => {
  test('index.html registers the service worker, feature-detected and deferred to window load', () => {
    assert.match(indexHtml, /'serviceWorker' in navigator/);
    assert.match(indexHtml, /navigator\.serviceWorker\.register\('\.\/service-worker\.js'/);
    assert.match(indexHtml, /addEventListener\('load'/);
  });

  test('v3.1.1: registered with updateViaCache: \'none\' so update checks always fetch the deployed worker fresh', () => {
    assert.match(indexHtml, /navigator\.serviceWorker\.register\('\.\/service-worker\.js', \{ updateViaCache: 'none' \}\)/);
  });

  test('v3.1.1: index.html never reloads on a worker change by itself (no controllerchange auto-reload)', () => {
    assert.doesNotMatch(indexHtml, /controllerchange/);
    assert.doesNotMatch(indexHtml, /location\.reload\(/);
  });

  test('index.html links assets/css/calculate.css', () => {
    assert.match(indexHtml, /<link rel="stylesheet" href="\.\/assets\/css\/calculate\.css">/);
  });
});
