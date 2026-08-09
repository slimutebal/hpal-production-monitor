// Report Excel Lazy-Load Regression Hotfix tests (V2.5.2 -- this task's
// Sections 17-20).
//
// Run with Node's built-in test runner:
//
//   node --test tests/report-xlsx-lazy-load.test.mjs
//
// Root cause (confirmed production regression): V2.5.1 removed SheetJS's
// blocking inline <script> and made it load on demand via Monitor's own
// loader (index.html), but report-page.js's handleFileChange() never
// awaited that loader -- it went straight from FileReader to `XLSX.read`,
// guarded only by a hardcoded, unlocalized
// `if (typeof XLSX === 'undefined') throw new Error('Library Excel belum
// siap...')`. Report failed on any cold launch where it was the FIRST
// feature to touch a workbook (Monitor's own upload path always worked,
// since it already awaited the loader).
//
// report-page.js is an ES module with heavy DOM/state dependencies
// (`els`, `reportState`, `t`, parser imports) impractical to fully mock
// in Node -- no existing test in this suite imports it directly. Same
// posture as tests/monitor-contractor-bridge.test.mjs for index.html:
// (1) source-position assertions prove the real wiring/ordering exists
// exactly where required, and (2) the small, genuinely DOM-free
// ensureReportXlsxLibrary() bridge function is extracted VERBATIM (brace
// matching) and actually executed via Node's vm module against a mock
// window.HPALVendorLibraries -- this runs the real, shipped bridge code,
// not a re-implementation of it. The shared loader's own Report-first /
// already-loaded / concurrent / retry semantics are proven once, at the
// source, in tests/monitor-vendor-lazy-load.test.mjs -- not duplicated
// here; this file proves Report is wired to that exact loader correctly.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const reportPageSource = fs.readFileSync(path.join(ROOT, 'js', 'pages', 'report', 'report-page.js'), 'utf8');
const indexHtml = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

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
   5/13. ONE SOURCE OF TRUTH -- Report reaches index.html's real
   ensureXlsxLibrary() through the narrow window.HPALVendorLibraries
   bridge, never a duplicate loader, never Chart.js.
============================================================ */
describe('5. Report reaches the loader through window.HPALVendorLibraries, never a duplicate loader', () => {
  test('index.html exposes window.HPALVendorLibraries with exactly ensureXlsx/ensureChart/ensureMonitor, wired to the real functions', () => {
    assert.match(indexHtml, /window\.HPALVendorLibraries = \{\s*ensureXlsx: ensureXlsxLibrary,\s*ensureChart: ensureChartLibrary,\s*ensureMonitor: ensureMonitorVendorLibraries,\s*\};/);
  });

  test('ensureReportXlsxLibrary() calls window.HPALVendorLibraries.ensureXlsx() and nothing else on the bridge', () => {
    const fnSource = extractFunctionSource(reportPageSource, 'ensureReportXlsxLibrary');
    assert.match(fnSource, /window\.HPALVendorLibraries\.ensureXlsx\(\)/);
    assert.doesNotMatch(fnSource, /\.ensureChart\(/);
    assert.doesNotMatch(fnSource, /\.ensureMonitor\(/);
  });

  test('report-page.js never appends its own <script> tag or duplicates loadVendorScriptOnce()-style logic', () => {
    assert.doesNotMatch(reportPageSource, /createElement\(['"]script['"]\)/);
    assert.doesNotMatch(reportPageSource, /appendChild/);
  });
});

/* ============================================================
   6/13/14. UPLOAD FLOW ORDERING -- source-position proof (the same File
   object flows through unchanged; the loader is awaited before XLSX is
   ever touched; existing parsing is untouched).
============================================================ */
describe('6/13/14. handleFileChange() awaits the loader before touching XLSX, preserves the same File, error path never leaks a raw ReferenceError', () => {
  const fnSource = extractFunctionSource(reportPageSource, 'handleFileChange');

  test('handleFileChange() is declared async', () => {
    assert.match(reportPageSource, /async function handleFileChange\(event\) \{/);
  });

  test('the File is captured BEFORE the loader is awaited (never lost/re-read from the <input> after the await)', () => {
    const fileCaptureIdx = fnSource.indexOf('const file = event.target.files[0];');
    const awaitIdx = fnSource.indexOf('await ensureReportXlsxLibrary();');
    assert.ok(fileCaptureIdx !== -1 && awaitIdx !== -1);
    assert.ok(fileCaptureIdx < awaitIdx);
  });

  test('ensureReportXlsxLibrary() is awaited BEFORE the FileReader/XLSX.read path', () => {
    const awaitIdx = fnSource.indexOf('await ensureReportXlsxLibrary();');
    const readerIdx = fnSource.indexOf('new FileReader()');
    const xlsxReadIdx = fnSource.indexOf('XLSX.read(');
    assert.ok(awaitIdx !== -1 && readerIdx !== -1 && xlsxReadIdx !== -1);
    assert.ok(awaitIdx < readerIdx);
    assert.ok(readerIdx < xlsxReadIdx);
  });

  test('the SAME captured `file` variable is what FileReader eventually reads (readAsArrayBuffer(file))', () => {
    assert.match(fnSource, /reader\.readAsArrayBuffer\(file\);/);
  });

  test('a loader failure shows the new localized error and returns BEFORE touching FileReader/XLSX at all', () => {
    const catchIdx = fnSource.indexOf('} catch (err) {\n    renderFileStatus(false, t(\'report.file.libraryLoadError\'));\n    return;\n  }');
    assert.ok(catchIdx !== -1, 'expected the loader-failure catch block with the new localized key');
    const readerIdx = fnSource.indexOf('new FileReader()');
    assert.ok(catchIdx < readerIdx, 'the failure branch (with its own `return`) must be positioned before any FileReader/XLSX code');
  });

  test('the residual typeof XLSX guard (belt-and-suspenders) uses the SAME new localized key, never the old hardcoded Indonesian-only string', () => {
    assert.doesNotMatch(reportPageSource, /Library Excel belum siap\. Muat ulang aplikasi lalu coba lagi\./);
    assert.match(fnSource, /if \(typeof XLSX === 'undefined'\) \{\s*throw new Error\(t\('report\.file\.libraryLoadError'\)\);\s*\}/);
  });

  test('existing parsing call (parseUploadedWorkbook) and downstream Report state updates are completely unchanged (this task\'s Section 14)', () => {
    assert.match(fnSource, /const parsed = parseUploadedWorkbook\(workbook\);/);
    assert.match(fnSource, /reportState\.parsed = parsed;/);
    assert.match(fnSource, /applyWeekFromParsed\(parsed\);/);
    assert.match(fnSource, /recomputeBuyerResolution\(\{ openPopupOnNewMismatch: true \}\);/);
  });
});

/* ============================================================
   7/18. REPORT NEVER LOADS Chart.js.
============================================================ */
describe('7/18. Report never loads Chart.js merely to parse a workbook', () => {
  // Checks actual invocation syntax (call parens), not the bare
  // substring -- both functions' own header comments legitimately
  // mention "Chart.js"/"ensureChart"/"ensureMonitor" in PROSE, explaining
  // why they are deliberately NOT called. That is expected and fine, same
  // posture as tests/monitor-contractor-bridge.test.mjs's "prose comments
  // documenting the removal are expected and fine".
  test('neither ensureReportXlsxLibrary() nor handleFileChange() ever CALLS ensureChart()/ensureMonitor()', () => {
    const bridgeSource = extractFunctionSource(reportPageSource, 'ensureReportXlsxLibrary');
    const handlerSource = extractFunctionSource(reportPageSource, 'handleFileChange');
    for (const src of [bridgeSource, handlerSource]) {
      assert.doesNotMatch(src, /ensureChart\(/);
      assert.doesNotMatch(src, /ensureMonitor\(/);
    }
  });

  test('report-page.js as a whole never CALLS window.HPALVendorLibraries.ensureChart()/.ensureMonitor()', () => {
    assert.doesNotMatch(reportPageSource, /HPALVendorLibraries\.ensureChart\(/);
    assert.doesNotMatch(reportPageSource, /HPALVendorLibraries\.ensureMonitor\(/);
  });
});

/* ============================================================
   17-20. ensureReportXlsxLibrary() BRIDGE -- behavioral proof against a
   mocked window.HPALVendorLibraries (the real, extracted bridge function,
   run via vm).
============================================================ */
describe('17-20. ensureReportXlsxLibrary() -- behavioral proof of the bridge itself', () => {
  const bridgeSource = extractFunctionSource(reportPageSource, 'ensureReportXlsxLibrary');

  function buildSandbox(HPALVendorLibraries) {
    const sandbox = { window: HPALVendorLibraries ? { HPALVendorLibraries } : {} };
    const context = vm.createContext(sandbox);
    vm.runInContext(bridgeSource, context);
    return context;
  }

  test('17. Report-first: calls window.HPALVendorLibraries.ensureXlsx() exactly once and awaits it before resolving', async () => {
    let calls = 0;
    let resolveEnsureXlsx;
    const ensureXlsx = () => { calls += 1; return new Promise((r) => { resolveEnsureXlsx = r; }); };
    const ctx = buildSandbox({ ensureXlsx, ensureChart: () => { throw new Error('must not be called'); } });

    let settled = false;
    const p = vm.runInContext('ensureReportXlsxLibrary()', ctx).then(() => { settled = true; });
    assert.equal(calls, 1);
    await new Promise((r) => setTimeout(r, 5));
    assert.equal(settled, false, 'must still be pending until ensureXlsx() itself resolves');
    resolveEnsureXlsx();
    await p;
    assert.equal(settled, true);
  });

  test('18. already-loaded: the bridge is a pure pass-through -- if ensureXlsx() itself resolves immediately (XLSX already present), so does the bridge, with no extra work', async () => {
    let calls = 0;
    const ensureXlsx = () => { calls += 1; return Promise.resolve(); };
    const ctx = buildSandbox({ ensureXlsx });
    await vm.runInContext('ensureReportXlsxLibrary()', ctx);
    assert.equal(calls, 1);
  });

  test('19. concurrent callers: each call to ensureReportXlsxLibrary() forwards to ensureXlsx() -- the SHARED in-flight Promise/dedup guarantee lives in ensureXlsx() itself (proven in tests/monitor-vendor-lazy-load.test.mjs); here we confirm the bridge adds no second layer of state that could diverge from it', async () => {
    let calls = 0;
    const sharedPromise = Promise.resolve();
    const ensureXlsx = () => { calls += 1; return sharedPromise; };
    const ctx = buildSandbox({ ensureXlsx });
    const [r1, r2] = await Promise.all([
      vm.runInContext('ensureReportXlsxLibrary()', ctx),
      vm.runInContext('ensureReportXlsxLibrary()', ctx),
    ]);
    assert.equal(calls, 2, 'the bridge itself holds no cache -- each call forwards to ensureXlsx(), which is where dedup actually lives');
    assert.equal(r1, r2);
  });

  test('20. load failure: a rejected ensureXlsx() propagates as a rejected ensureReportXlsxLibrary() (so handleFileChange()\'s try/catch can show the localized error)', async () => {
    const ensureXlsx = () => Promise.reject(new Error('Failed to load ./assets/vendor/xlsx.min.js'));
    const ctx = buildSandbox({ ensureXlsx });
    await assert.rejects(vm.runInContext('ensureReportXlsxLibrary()', ctx));
  });

  test('missing bridge (e.g. index.html\'s classic script never ran) resolves immediately rather than throwing -- the residual typeof XLSX guard in handleFileChange is what protects the user in that case', async () => {
    const ctx = buildSandbox(null);
    await assert.doesNotReject(vm.runInContext('ensureReportXlsxLibrary()', ctx));
  });
});

/* ============================================================
   13. LOCALIZED LOADER-FAILURE MESSAGE -- id/en parity, matches the
   exact required wording.
============================================================ */
describe('13. report.file.libraryLoadError -- localized, matches required wording exactly', () => {
  const idJs = fs.readFileSync(path.join(ROOT, 'js', 'i18n', 'locales', 'id.js'), 'utf8');
  const enJs = fs.readFileSync(path.join(ROOT, 'js', 'i18n', 'locales', 'en.js'), 'utf8');

  test('id.js has the exact required Indonesian text', () => {
    assert.match(idJs, /'report\.file\.libraryLoadError': 'Library Excel tidak dapat dimuat\. Coba lagi\.'/);
  });

  test('en.js has the exact required English text', () => {
    assert.match(enJs, /'report\.file\.libraryLoadError': 'Excel library could not be loaded\. Please try again\.'/);
  });
});
