// Monitor vendor-library lazy-loading tests (V2.5.1 -- Offline-First Cold
// Startup, startup audit Root Cause B / this task's Sections 9-13/39).
//
// Run with Node's built-in test runner:
//
//   node --test tests/monitor-vendor-lazy-load.test.mjs
//
// SheetJS and Chart.js used to be inlined in index.html's <head> as
// ~700KB of blocking classic <script> tags, parsed/executed on every
// cold start whether or not the user ever opened a workbook -- the
// confirmed root cause of the extended white screen on iOS PWA cold
// start. They now live in assets/vendor/xlsx.min.js and
// assets/vendor/chart.umd.min.js and are loaded on demand by
// ensureMonitorVendorLibraries() (index.html), the first time Monitor
// actually needs them.
//
// index.html is not an ES module and depends on many browser-only
// globals impractical to fully mock in Node (same posture as
// tests/monitor-contractor-bridge.test.mjs). Two complementary
// strategies are used here: (1) source-text assertions confirm the
// libraries are no longer inline/eager and that both file-processing
// entry points await the loader before touching XLSX/Chart, and (2)
// ensureMonitorVendorLibraries()/loadVendorScriptOnce()'s function bodies
// are extracted VERBATIM (brace matching) and evaluated in a minimal
// sandboxed vm context with a mock `document`, then exercised directly --
// this actually runs the real, shipped loader code, not a
// re-implementation of it. Never touches the real DOM or network.

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
const swSource = fs.readFileSync(path.join(ROOT, 'service-worker.js'), 'utf8');

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

/* ============================================================
   1. THE LIBRARIES ARE NO LONGER INLINE/BLOCKING IN <head>
============================================================ */
describe('9. SheetJS/Chart.js are no longer inline/blocking in <head>', () => {
  test('index.html no longer contains the SheetJS source itself (only a relocation comment + the on-demand loader may reference it)', () => {
    // DO_NOT_EXPORT_ is a distinctive top-of-file identifier from the
    // SheetJS build that only appears in the actual library source, never
    // in prose referring to it.
    assert.doesNotMatch(indexHtml, /DO_NOT_EXPORT_/);
  });

  test('index.html no longer contains the Chart.js source itself', () => {
    assert.doesNotMatch(indexHtml, /Chart\.js v4\.5\.1/);
    // The minified UMD wrapper's own distinctive export line.
    assert.doesNotMatch(indexHtml, /window\.Chart=Tn/);
  });

  test('there is no eager <script src="...xlsx..."> or <script src="...chart...">  tag anywhere in index.html -- the only references to the vendor paths are inside the loader\'s own string literals', () => {
    assert.doesNotMatch(indexHtml, /<script[^>]*\bsrc\s*=\s*["'][^"']*xlsx[^"']*["'][^>]*>/i);
    assert.doesNotMatch(indexHtml, /<script[^>]*\bsrc\s*=\s*["'][^"']*chart\.umd[^"']*["'][^>]*>/i);
  });

  test('the vendor library files exist locally, are non-trivial in size (the real libraries, not stubs), and are also referenced by the SW APP_SHELL (offline availability, this task\'s Section 11)', () => {
    const xlsxPath = path.join(ROOT, 'assets', 'vendor', 'xlsx.min.js');
    const chartPath = path.join(ROOT, 'assets', 'vendor', 'chart.umd.min.js');
    assert.ok(fs.existsSync(xlsxPath), 'assets/vendor/xlsx.min.js must exist');
    assert.ok(fs.existsSync(chartPath), 'assets/vendor/chart.umd.min.js must exist');
    assert.ok(fs.statSync(xlsxPath).size > 100000, 'xlsx.min.js should be the real library, not a stub');
    assert.ok(fs.statSync(chartPath).size > 100000, 'chart.umd.min.js should be the real library, not a stub');
    assert.match(swSource, /'\.\/assets\/vendor\/xlsx\.min\.js'/);
    assert.match(swSource, /'\.\/assets\/vendor\/chart\.umd\.min\.js'/);
  });

  test('no CDN/third-party network reference was introduced (this task\'s Section 13)', () => {
    assert.doesNotMatch(indexHtml, /cdn\.|jsdelivr|unpkg|cdnjs|googleapis\.com\/ajax/i);
  });
});

/* ============================================================
   2. FILE-PROCESSING ENTRY POINTS AWAIT THE LOADER BEFORE TOUCHING
      XLSX/Chart (this task's Section 10/12) -- source-position proof.
============================================================ */
describe('10/12. handleFile()/handleContractorFile() await the vendor loader before needing XLSX/Chart', () => {
  test('handleFile() awaits ensureMonitorVendorLibraries() before calling readExcelFile()', () => {
    const fnSource = extractFunctionSource(indexHtml, 'handleFile');
    const ensureIdx = fnSource.indexOf('await ensureMonitorVendorLibraries()');
    const readExcelIdx = fnSource.indexOf('readExcelFile(file');
    assert.ok(ensureIdx !== -1, 'handleFile() must await ensureMonitorVendorLibraries()');
    assert.ok(readExcelIdx !== -1);
    assert.ok(ensureIdx < readExcelIdx, 'the vendor loader must be awaited BEFORE readExcelFile() can need XLSX');
  });

  test('handleFile() is declared async (so the await above is valid) and shows the existing localized error, never an uncaught exception, if loading fails', () => {
    assert.match(indexHtml, /async function handleFile\(file\)\{/);
    const fnSource = extractFunctionSource(indexHtml, 'handleFile');
    assert.match(fnSource, /catch\(err\)\{\s*fileStatus\.innerHTML = `<div class="error-box">\$\{mt\('monitor\.upload\.xlsxNotLoadedError'\)\}<\/div>`;\s*return;\s*\}/);
  });

  test('handleContractorFile() awaits ensureMonitorVendorLibraries() before calling readExcelFile()', () => {
    const fnSource = extractFunctionSource(indexHtml, 'handleContractorFile');
    const ensureIdx = fnSource.indexOf('await ensureMonitorVendorLibraries()');
    const readExcelIdx = fnSource.indexOf('readExcelFile(file');
    assert.ok(ensureIdx !== -1, 'handleContractorFile() must await ensureMonitorVendorLibraries()');
    assert.ok(readExcelIdx !== -1);
    assert.ok(ensureIdx < readExcelIdx, 'the vendor loader must be awaited BEFORE readExcelFile() can need XLSX');
  });

  test('handleContractorFile() is declared async and shows the existing localized error on load failure, without ever reaching XLSX-dependent code', () => {
    assert.match(indexHtml, /async function handleContractorFile\(file\)\{/);
    const fnSource = extractFunctionSource(indexHtml, 'handleContractorFile');
    assert.match(fnSource, /catch\(err\)\{\s*contractorStatus\.innerHTML = `<div class="error-box">\$\{mt\('monitor\.upload\.xlsxNotLoadedError'\)\}<\/div>`;\s*return;\s*\}/);
  });

  test('readExcelFile() itself still guards against XLSX being undefined (belt-and-suspenders -- this is what turns any residual gap into the existing localized message rather than a raw ReferenceError)', () => {
    const fnSource = extractFunctionSource(indexHtml, 'readExcelFile');
    assert.match(fnSource, /typeof XLSX === 'undefined'/);
    assert.match(fnSource, /mt\('monitor\.upload\.xlsxNotLoadedError'\)/);
  });

  test('renderNIChart() still guards against Chart being undefined the same way', () => {
    const fnSource = extractFunctionSource(indexHtml, 'renderNIChart');
    assert.match(fnSource, /typeof Chart === 'undefined'/);
    assert.match(fnSource, /mt\('monitor\.chart\.notLoadedError'\)/);
  });
});

/* ============================================================
   3. ensureMonitorVendorLibraries() ARCHITECTURE -- behavioral proof via
      the real, extracted loader source run in a sandboxed vm context.
============================================================ */
describe('10. ensureMonitorVendorLibraries() -- behavioral proof (idempotent, Promise-returning, retry-on-failure)', () => {
  // The loader's own module-level cache variable, declared just above
  // both functions in index.html -- extracted verbatim (not re-declared
  // by hand) so the sandbox reflects the exact real closure state.
  const promiseVarMatch = indexHtml.match(/let monitorVendorLibrariesPromise = null;/);
  assert.ok(promiseVarMatch, 'expected `let monitorVendorLibrariesPromise = null;` in index.html');
  const loaderSource = `${promiseVarMatch[0]}\n${extractFunctionSource(indexHtml, 'loadVendorScriptOnce')}\n${extractFunctionSource(indexHtml, 'ensureMonitorVendorLibraries')}`;

  function createMockDocument() {
    const created = [];
    const headChildren = [];
    return {
      createElement: () => {
        const el = { dataset: {}, _listeners: {} };
        el.addEventListener = (evt, fn) => { el._listeners[evt] = fn; };
        el.remove = () => {
          const idx = headChildren.indexOf(el);
          if (idx !== -1) headChildren.splice(idx, 1);
        };
        Object.defineProperty(el, 'onload', { set(fn) { el._onload = fn; }, get() { return el._onload; } });
        Object.defineProperty(el, 'onerror', { set(fn) { el._onerror = fn; }, get() { return el._onerror; } });
        created.push(el);
        return el;
      },
      querySelector: (sel) => {
        const m = sel.match(/data-monitor-vendor="([^"]+)"/);
        if (!m) return null;
        return headChildren.find((s) => s.dataset.monitorVendor === m[1]) || null;
      },
      head: { appendChild: (el) => { headChildren.push(el); } },
      _created: created,
      _headChildren: headChildren,
    };
  }

  function buildSandbox(extraGlobals) {
    const doc = createMockDocument();
    const sandbox = { document: doc, Promise, ...extraGlobals };
    const context = vm.createContext(sandbox);
    vm.runInContext(loaderSource, context);
    return { context, doc };
  }

  test('returns a Promise', () => {
    const { context } = buildSandbox({});
    const result = vm.runInContext('ensureMonitorVendorLibraries()', context);
    assert.ok(result instanceof Promise || typeof result.then === 'function');
    result.catch(() => {}); // never resolves in this test (no onload fired) -- silence the unhandled-rejection-on-teardown warning
  });

  test('appends exactly one <script> per library, and resolves once both fire onload', async () => {
    const { context, doc } = buildSandbox({});
    const p = vm.runInContext('ensureMonitorVendorLibraries()', context);
    assert.equal(doc._created.length, 2, 'expected exactly one <script> for XLSX and one for Chart.js');
    const srcs = doc._created.map((el) => el.src).sort();
    assert.deepEqual(srcs, ['./assets/vendor/chart.umd.min.js', './assets/vendor/xlsx.min.js']);
    doc._created.forEach((el) => { el.dataset.loaded = 'true'; el._onload(); });
    await assert.doesNotReject(p);
  });

  test('skips loading a library that is already present (typeof check) -- only Chart.js is fetched if XLSX already exists', async () => {
    const { context, doc } = buildSandbox({ XLSX: { read: () => {} } });
    const p = vm.runInContext('ensureMonitorVendorLibraries()', context);
    assert.equal(doc._created.length, 1, 'XLSX is already defined -- only Chart.js should be requested');
    assert.equal(doc._created[0].src, './assets/vendor/chart.umd.min.js');
    doc._created.forEach((el) => { el.dataset.loaded = 'true'; el._onload(); });
    await assert.doesNotReject(p);
  });

  test('idempotent: two calls before the first resolves share the same in-flight Promise -- a script tag is never appended twice', async () => {
    const { context, doc } = buildSandbox({});
    const p1 = vm.runInContext('ensureMonitorVendorLibraries()', context);
    const p2 = vm.runInContext('ensureMonitorVendorLibraries()', context);
    assert.equal(doc._created.length, 2, 'still only one <script> per library across both calls');
    doc._created.forEach((el) => { el.dataset.loaded = 'true'; el._onload(); });
    await Promise.all([p1, p2]);
  });

  test('on failure, the shared promise resets so a LATER retry can succeed (this task\'s Section 12: the user selecting the file again must not be permanently stuck)', async () => {
    const { context, doc } = buildSandbox({});
    const p1 = vm.runInContext('ensureMonitorVendorLibraries()', context);
    // Simulate ONE of the two script loads failing, the other succeeding.
    doc._created[0]._onerror();
    doc._created[1].dataset.loaded = 'true';
    doc._created[1]._onload();
    await assert.rejects(p1);

    // A second call after the failure must retry ONLY the library that
    // actually failed -- the one that already succeeded must not be
    // re-fetched (loadVendorScriptOnce()'s own `existing.dataset.loaded
    // === 'true'` short-circuit still applies to it).
    const p2 = vm.runInContext('ensureMonitorVendorLibraries()', context);
    assert.equal(doc._created.length, 3, 'only the previously-FAILED library should be retried with a fresh <script> element; the already-succeeded one must not be re-fetched');
    doc._created.slice(2).forEach((el) => { el.dataset.loaded = 'true'; el._onload(); });
    await assert.doesNotReject(p2);
  });

  test('file processing waits for library readiness, never proceeds while the loader Promise is still pending', async () => {
    // This is the contract handleFile()/handleContractorFile() rely on
    // (proven by source position above) -- here we prove the Promise
    // itself genuinely stays pending until onload fires, i.e. an `await`
    // on it really does block until the library is ready.
    const { context, doc } = buildSandbox({});
    let resolved = false;
    const p = vm.runInContext('ensureMonitorVendorLibraries()', context).then(() => { resolved = true; });
    await new Promise((r) => setTimeout(r, 5));
    assert.equal(resolved, false, 'must still be pending before onload fires');
    doc._created.forEach((el) => { el.dataset.loaded = 'true'; el._onload(); });
    await p;
    assert.equal(resolved, true);
  });
});
