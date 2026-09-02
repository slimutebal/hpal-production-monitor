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

function extractCacheName(source) {
  const match = source.match(/const CACHE_NAME = '([^']+)';/);
  assert.ok(match, 'service-worker.js must define a const CACHE_NAME string');
  return match[1];
}

const appShell = extractAppShell(swSource);
const cacheName = extractCacheName(swSource);

describe('V3.0.0. Cache version bumped exactly once for the V3.0 release (Phase 7C release finalization)', () => {
  test('CACHE_NAME reflects the final V3.0.0 release, not V2.4.1, V2.5.0, V2.5.1, V2.5.2, or the interim V2.5.3 Phase 7B identifier', () => {
    assert.notEqual(cacheName, 'hpal-production-monitor-v2.4.1-mobile-input-sticky');
    assert.notEqual(cacheName, 'hpal-production-monitor-v2.5.0-operational-continuity');
    assert.notEqual(cacheName, 'hpal-production-monitor-v2.5.1-offline-first-startup');
    assert.notEqual(cacheName, 'hpal-production-monitor-v2.5.2-report-excel-hotfix');
    assert.notEqual(cacheName, 'hpal-production-monitor-v2.5.3-recommendation-worker');
    assert.match(cacheName, /^hpal-production-monitor-v3\.0\.0/);
  });

  test('CACHE_NAME is declared exactly once (a single version source, not two)', () => {
    const occurrences = [...swSource.matchAll(/const CACHE_NAME = /g)];
    assert.equal(occurrences.length, 1);
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

describe('23/28. Offline shell behavior and cache policy preserved', () => {
  test('install handler still caches the full APP_SHELL and calls skipWaiting()', () => {
    assert.match(swSource, /cache\.addAll\(APP_SHELL\)/);
    assert.match(swSource, /self\.skipWaiting\(\)/);
  });

  test('activate handler still deletes every cache key other than the current CACHE_NAME (old caches cleaned up automatically)', () => {
    const activateBlock = swSource.match(/self\.addEventListener\('activate'[\s\S]*?\}\);/);
    assert.ok(activateBlock);
    assert.match(activateBlock[0], /key\s*!==\s*CACHE_NAME/);
    assert.match(activateBlock[0], /caches\.delete/);
    assert.match(activateBlock[0], /self\.clients\.claim\(\)/);
  });

  test('cross-origin requests are never cached -- fetched directly and returned, regardless of Calculate/PWA changes', () => {
    assert.match(swSource, /requestUrl\.origin\s*!==\s*self\.location\.origin/);
    const crossOriginBlock = swSource.match(/if \(requestUrl\.origin !== self\.location\.origin\) \{[\s\S]*?\}/);
    assert.ok(crossOriginBlock);
    assert.match(crossOriginBlock[0], /fetch\(request\)/);
    assert.doesNotMatch(crossOriginBlock[0], /caches\.open|cache\.put/);
  });

  test('non-GET requests are never intercepted/cached', () => {
    assert.match(swSource, /request\.method\s*!==\s*'GET'/);
  });

  test("V2.5.1: navigation is now LOCAL-FIRST, not network-first (startup audit Root Cause A) -- the cached index.html key/identity is preserved", () => {
    const navBlock = swSource.match(/request\.mode === 'navigate'[\s\S]*?return;\s*\n\s*\}/);
    assert.ok(navBlock);
    // Same cache identity as before (and as APP_SHELL's own install-time
    // entry) -- this task's Section 5: never a second/duplicate key.
    const indexHtmlKeyOccurrences = navBlock[0].match(/'\.\/index\.html'/g) || [];
    assert.ok(indexHtmlKeyOccurrences.length >= 2, 'expected both the cache read and the cache write to use the literal \'./index.html\' key');
    // The cache lookup must happen, and the response must be usable,
    // BEFORE the fetch() promise is awaited/resolved -- i.e. cache-first,
    // not network-first. A `caches.match(...)` that is `await`ed ahead of
    // any `fetch(request)` call in the same block is the source-level
    // signature of that ordering.
    const cacheMatchIdx = navBlock[0].indexOf("caches.match('./index.html')");
    const fetchIdx = navBlock[0].indexOf('fetch(request)');
    assert.ok(cacheMatchIdx !== -1 && fetchIdx !== -1);
    assert.ok(cacheMatchIdx < fetchIdx, 'the cache lookup must be issued before the network fetch, not after (cache-first, not network-first)');
    // The background refresh must be handed to event.waitUntil(), and the
    // cached response must be returned WITHOUT awaiting it.
    assert.match(navBlock[0], /event\.waitUntil\(/);
    const waitUntilIdx = navBlock[0].indexOf('event.waitUntil(');
    const returnCachedIdx = navBlock[0].indexOf('return cachedResponse;');
    assert.ok(waitUntilIdx !== -1 && returnCachedIdx !== -1 && waitUntilIdx < returnCachedIdx);
  });
});

/* ============================================================
   V2.5.1 -- BEHAVIORAL proof of the new local-first navigation contract
   (this task's Section 4/43), not just a source-text pattern match.
   service-worker.js still cannot be `import`ed under Node (it references
   `self`/`caches`/`clients`), so the fetch handler's actual arrow-function
   BODY is extracted verbatim (brace-matching, the same technique
   tests/monitor-contractor-bridge.test.mjs already uses for index.html's
   classic-script functions) and evaluated via Node's vm module against a
   minimal, purpose-built mock of `self`/`caches`/`fetch` -- this actually
   RUNS the real, shipped fetch-handling logic, not a re-implementation of
   it.
============================================================ */
describe('4/43. Local-first navigation -- behavioral proof', () => {
  function extractFetchHandlerBody(source) {
    const marker = "self.addEventListener('fetch', (event) => {";
    const startIdx = source.indexOf(marker);
    assert.ok(startIdx !== -1, "expected self.addEventListener('fetch', (event) => { ... in service-worker.js");
    const bodyStart = startIdx + marker.length;
    let depth = 1;
    let i = bodyStart;
    for (; i < source.length && depth > 0; i++) {
      if (source[i] === '{') depth++;
      else if (source[i] === '}') depth--;
    }
    assert.equal(depth, 0, 'unbalanced braces extracting the fetch handler body');
    return source.slice(bodyStart, i - 1);
  }

  const fetchHandlerBody = extractFetchHandlerBody(swSource);

  // A tiny in-memory Cache/CacheStorage mock -- just enough surface
  // (`match`/`open`→`{put}`) for the real fetch handler body to run
  // against, keyed by the exact string/URL the handler itself passes in.
  function createMockCaches(initialEntries) {
    const store = new Map(Object.entries(initialEntries || {}));
    const putCalls = [];
    const cache = {
      put: async (key, response) => {
        const k = typeof key === 'string' ? key : key.url;
        store.set(k, response);
        putCalls.push({ key: k, response });
      },
    };
    return {
      match: async (key) => store.get(typeof key === 'string' ? key : key.url),
      open: async () => cache,
      _store: store,
      _putCalls: putCalls,
    };
  }

  function createMockResponse(tag, status = 200) {
    const resp = { status, type: 'basic', _tag: tag };
    resp.clone = () => ({ ...resp });
    return resp;
  }

  // Runs the real fetch handler body against a mock request/fetch/caches,
  // resolving once respondWith() has been called, and returns both the
  // eventual respondWith() value and every waitUntil() promise (already
  // settled, failures swallowed) so the test can assert on both the
  // immediate response AND the background work.
  async function runFetchHandler({ request, fetchImpl, cacheEntries }) {
    const mockCaches = createMockCaches(cacheEntries);
    let respondWithValue;
    let respondWithSettled = false;
    const waitUntilPromises = [];
    const event = {
      request,
      respondWith(promiseOrValue) {
        respondWithValue = Promise.resolve(promiseOrValue).then((v) => {
          respondWithSettled = true;
          return v;
        });
      },
      waitUntil(promiseOrValue) {
        waitUntilPromises.push(Promise.resolve(promiseOrValue).catch(() => {}));
      },
    };
    const sandbox = {
      event,
      self: { location: { origin: 'https://example.test' } },
      caches: mockCaches,
      fetch: fetchImpl,
      URL,
      console,
      // CACHE_NAME is a free variable the real handler body closes over
      // from service-worker.js's own module scope (it's declared outside
      // the extracted fetch-handler body) -- reuse the real, extracted
      // value so this sandbox matches actual runtime scoping exactly.
      CACHE_NAME: cacheName,
    };
    const context = vm.createContext(sandbox);
    // Wrapped in an IIFE: the extracted body is a function BODY (it
    // contains top-level `return;` statements from the real handler,
    // e.g. the non-GET/early-return guard), which is only legal syntax
    // inside an actual function, not at vm.runInContext()'s top level.
    vm.runInContext(`(function(){\n${fetchHandlerBody}\n})();`, context);
    const response = await respondWithValue;
    return { response, respondWithSettled, waitUntilPromises, mockCaches };
  }

  function navigateRequest(url = 'https://example.test/') {
    return { method: 'GET', mode: 'navigate', url };
  }

  test('A. cached index exists: the cached response is returned WITHOUT waiting for the network (a hung fetch() never delays it)', async () => {
    const cached = createMockResponse('cached');
    let fetchStarted = false;
    const hungFetch = () => {
      fetchStarted = true;
      return new Promise(() => {}); // never resolves -- simulates a hung/very slow network
    };

    const { response, respondWithSettled } = await runFetchHandler({
      request: navigateRequest(),
      fetchImpl: hungFetch,
      cacheEntries: { './index.html': cached },
    });

    assert.equal(respondWithSettled, true);
    assert.equal(response._tag, 'cached');
    assert.equal(fetchStarted, true, 'the background network refresh must still have been started (independently requested), just never awaited for the response');
  });

  test('B. network refresh runs in the background (event.waitUntil) and updates the SAME cache entry once it resolves', async () => {
    const cached = createMockResponse('cached');
    const fresh = createMockResponse('fresh');
    const fetchImpl = async () => fresh;

    const { waitUntilPromises, mockCaches } = await runFetchHandler({
      request: navigateRequest(),
      fetchImpl,
      cacheEntries: { './index.html': cached },
    });

    assert.equal(waitUntilPromises.length, 1, 'the background refresh must be registered via event.waitUntil()');
    await waitUntilPromises[0];
    assert.equal(mockCaches._putCalls.length, 1);
    assert.equal(mockCaches._putCalls[0].key, './index.html');
    assert.equal(mockCaches._putCalls[0].response._tag, 'fresh');
  });

  test('C. no cached index exists: falls back to the network (first-ever load / cleared cache)', async () => {
    const fresh = createMockResponse('fresh');
    const fetchImpl = async () => fresh;

    const { response } = await runFetchHandler({
      request: navigateRequest(),
      fetchImpl,
      cacheEntries: {},
    });

    assert.equal(response._tag, 'fresh');
  });

  test('D. network failure WITH a cached index: the cached index is still returned, the failure is swallowed (never an uncaught rejection)', async () => {
    const cached = createMockResponse('cached');
    const fetchImpl = async () => { throw new Error('network down'); };

    const { response, waitUntilPromises } = await runFetchHandler({
      request: navigateRequest(),
      fetchImpl,
      cacheEntries: { './index.html': cached },
    });

    assert.equal(response._tag, 'cached');
    // The failed background refresh must not reject -- runFetchHandler's
    // waitUntil tracking already .catch()es it the same way a real SW
    // runtime would need to for an unhandled rejection not to surface;
    // awaiting it here must not throw.
    await assert.doesNotReject(async () => { await waitUntilPromises[0]; });
  });

  test('cross-origin requests still bypass the cache entirely (Google Apps Script contractor sync must never be cached)', async () => {
    const fetchImpl = async () => createMockResponse('cross-origin-response');
    const { response, mockCaches } = await runFetchHandler({
      request: { method: 'GET', mode: 'no-cors', url: 'https://script.google.com/macros/s/xyz/exec' },
      fetchImpl,
      cacheEntries: {},
    });
    assert.equal(response._tag, 'cross-origin-response');
    assert.equal(mockCaches._putCalls.length, 0);
  });

  test('non-navigation same-origin GET requests keep the pre-existing cache-first strategy (static assets unaffected by this task)', async () => {
    const cached = createMockResponse('cached-asset');
    const fetchImpl = async () => createMockResponse('network-asset');
    const { response, mockCaches } = await runFetchHandler({
      request: { method: 'GET', mode: 'cors', url: 'https://example.test/js/app.js' },
      fetchImpl,
      cacheEntries: { 'https://example.test/js/app.js': cached },
    });
    assert.equal(response._tag, 'cached-asset');
    assert.equal(mockCaches._putCalls.length, 0, 'a cache hit must never trigger a redundant network fetch/cache.put for static assets');
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
    assert.match(indexHtml, /navigator\.serviceWorker\.register\('\.\/service-worker\.js'\)/);
    assert.match(indexHtml, /addEventListener\('load'/);
  });

  test('index.html links assets/css/calculate.css', () => {
    assert.match(indexHtml, /<link rel="stylesheet" href="\.\/assets\/css\/calculate\.css">/);
  });
});
