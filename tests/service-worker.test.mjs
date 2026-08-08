// service-worker.js / manifest.webmanifest tests (V2.4 Phase 8 -- PWA
// integration). See this task's Sections 21-26.
//
// Run with Node's built-in test runner:
//
//   node --test tests/service-worker.test.mjs
//
// service-worker.js is a classic (non-module) worker script that expects
// `self`/`caches`/`clients` globals unavailable under Node -- these tests
// therefore never `import`/execute it, only inspect its SOURCE TEXT
// (semantic assertions: extracted array contents, presence/absence of
// specific handler logic), the same "source-level assertion, not a full-
// file string snapshot" convention already used elsewhere in this suite
// (e.g. tests/calculate-page.test.mjs's CSS-source assertions).

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const swSource = readFileSync(path.join(ROOT, 'service-worker.js'), 'utf8');
const indexHtml = readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const manifest = JSON.parse(readFileSync(path.join(ROOT, 'manifest.webmanifest'), 'utf8'));

// `//` line comments are stripped first so an apostrophe inside a comment
// (e.g. a possessive "file's") can never be misread as a string-literal
// delimiter by the extraction regex below.
function stripLineComments(source) {
  return source.split('\n').map((line) => line.replace(/\/\/.*$/, '')).join('\n');
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

describe('22. Cache version bumped exactly once (V2.4 Phase 8)', () => {
  test('CACHE_NAME reflects the V2.4 release, not the old V2.3 simple-license name', () => {
    assert.notEqual(cacheName, 'hpal-production-monitor-v2.3.0-simple-license');
    assert.match(cacheName, /^hpal-production-monitor-v2\.4\.0/);
  });

  test('CACHE_NAME is declared exactly once (a single version source, not two)', () => {
    const occurrences = [...swSource.matchAll(/const CACHE_NAME = /g)];
    assert.equal(occurrences.length, 1);
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
      './js/pages/calculate/fleet-allocation.js',
      './js/pages/calculate/recommendation-ranking.js',
      './js/pages/calculate/recommendation-actions.js',
      './js/pages/calculate/planned-blend-recovery.js',
      './js/pages/calculate/hopper-pattern.js',
    ];
    for (const file of expected) {
      assert.ok(appShell.includes(file), `APP_SHELL is missing ${file}`);
    }
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

  test('navigation requests stay network-first with an index.html fallback (unchanged offline-shell strategy)', () => {
    const navBlock = swSource.match(/request\.mode === 'navigate'[\s\S]*?return;\s*\}/);
    assert.ok(navBlock);
    assert.match(navBlock[0], /caches\.match\('\.\/index\.html'\)/);
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
