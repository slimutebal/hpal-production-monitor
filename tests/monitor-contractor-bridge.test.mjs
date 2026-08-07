// Monitor -> Report contractor directory bridge tests (bridge-function
// correction round).
//
// Run with Node's built-in test runner (Node 18+, zero new dependencies):
//
//   node --test tests/monitor-contractor-bridge.test.mjs
//
// Root cause this round fixes: the shared-cache bridge was previously
// attached to contractor-assignment.js's fetchExistingContractors() -- an
// auxiliary workflow (the unmatched-contractor assignment modal's own
// List DT read), NOT the function powering the visible Monitor
// "Sinkron Sekarang" button or its "N unit DT (tersambung ke server
// pusat)" status. The real function is index.html's fetchSheetContractors(),
// wired to #btnSyncNow, called at startup, and on the browser 'online'
// event. This file verifies the bridge now lives on the real path.
//
// index.html is not an ES module and its Monitor script depends on many
// browser-only globals (DOM elements, window.storage, fetch, XLSX) that
// are impractical to fully mock in Node. Two complementary strategies are
// used here instead of a full page harness:
//   1. Source-text assertions confirm the real wiring/removal exists
//      exactly where required (which button calls which function, which
//      function calls the publish helper, which function no longer does).
//   2. The publishMonitorContractorDirectory()/getEffectiveContractorMap()
//      function bodies are extracted VERBATIM from index.html (via brace
//      matching, not re-typed) and evaluated in a minimal sandboxed
//      context via Node's vm module, then exercised with mock
//      dependencies -- this actually runs the real, shipped code, not a
//      re-implementation of it.
//
// contractor-directory-core.js/contractor-directory-service.js
// themselves are UNCHANGED this round (only *which* Monitor function
// calls them changed) -- their own mixed-row validation, shared-cache
// schema, event dispatch, Report reload/reclassify, and per-buyer
// resolution behavior remain fully covered by
// tests/contractor-directory-core.test.mjs,
// tests/contractor-directory-service.test.mjs, and
// tests/report-contractor-sync.test.mjs (still passing, unmodified this
// round for those concerns).
//
// Never calls the live Google Apps Script endpoint.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const indexHtmlPath = path.join(__dirname, '../index.html');
const indexHtml = fs.readFileSync(indexHtmlPath, 'utf8');
const contractorAssignmentPath = path.join(__dirname, '../contractor-assignment.js');
const contractorAssignmentSource = fs.readFileSync(contractorAssignmentPath, 'utf8');

// Extracts a top-level `function NAME(...) { ... }` declaration's exact
// source text by counting braces from the first `{` after the matched
// `function NAME(` -- robust against nested braces inside the function
// body, unlike a naive non-greedy regex.
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
   1. THE VISIBLE btnSyncNow BUTTON CALLS fetchSheetContractors(true)
============================================================ */
describe('1. Monitor\'s visible "Sinkron Sekarang" button wiring', () => {
  test('btnSyncNow.onclick calls fetchSheetContractors(true)', () => {
    assert.match(indexHtml, /document\.getElementById\('btnSyncNow'\)\.onclick\s*=\s*\(\)\s*=>\s*fetchSheetContractors\(true\)/);
  });

  test('fetchSheetContractors is also called unconditionally at startup (loadContractorData) and on the browser "online" event', () => {
    assert.match(indexHtml, /await fetchSheetContractors\(\);\s*\/\/ coba sinkron ke Google Sheet begitu app dibuka/);
    assert.match(indexHtml, /window\.addEventListener\('online',\s*\(\)\s*=>\s*fetchSheetContractors\(\)\)/);
  });
});

/* ============================================================
   2-4/12. fetchSheetContractors() PUBLISHES THE SHARED CACHE AFTER ITS
   OWN STATE UPDATE SUCCEEDS, WITHOUT CHANGING ITS OWN VISIBLE BEHAVIOR
============================================================ */
describe('2-4/12. fetchSheetContractors() publishes the shared cache after success, Monitor\'s own state unchanged', () => {
  const fnSource = extractFunctionSource(indexHtml, 'fetchSheetContractors');

  test('publishMonitorContractorDirectory() is called strictly after liveContractorMap/liveMapStatus are updated on success', () => {
    const mapAssignIdx = fnSource.indexOf('liveContractorMap = map;');
    const statusAssignIdx = fnSource.indexOf('liveMapStatus = { loaded:true');
    const publishIdx = fnSource.indexOf("publishMonitorContractorDirectory('monitor-sync')");
    assert.ok(mapAssignIdx !== -1 && statusAssignIdx !== -1 && publishIdx !== -1, 'expected all three statements to be present');
    assert.ok(mapAssignIdx < publishIdx, 'liveContractorMap must be assigned before publishing');
    assert.ok(statusAssignIdx < publishIdx, 'liveMapStatus must be marked loaded:true before publishing');
  });

  test('the failure branch never publishes (no stale/partial data is ever shared on a failed sync)', () => {
    const catchIdx = fnSource.indexOf('}catch(err){');
    assert.ok(catchIdx !== -1);
    const catchBlock = fnSource.slice(catchIdx);
    assert.doesNotMatch(catchBlock, /publishMonitorContractorDirectory/);
  });

  test('12. the fetch request, endpoint, liveContractorMap building, and error-box status wording are all unchanged from the original implementation', () => {
    assert.match(fnSource, /await fetch\(GOOGLE_SHEET_API_URL, \{ method:'GET' \}\)/);
    assert.match(fnSource, /const map = \{\};/);
    assert.match(fnSource, /liveMapStatus = \{ loaded:false, count: Object\.keys\(liveContractorMap\)\.length/);
    assert.match(fnSource, /Gagal sinkron ke server/);
  });
});

/* ============================================================
   5. THE PUBLISHED MAPPING COMES FROM MONITOR'S EFFECTIVE MAP -- runs the
   REAL, extracted function bodies (not a re-implementation).
============================================================ */
describe('5. publishMonitorContractorDirectory() publishes getEffectiveContractorMap(), not a different interpretation', () => {
  function buildSandbox({ embedded, live, personal }) {
    const getEffectiveSource = extractFunctionSource(indexHtml, 'getEffectiveContractorMap');
    const publishSource = extractFunctionSource(indexHtml, 'publishMonitorContractorDirectory');

    const writeCalls = [];
    const dispatchCalls = [];
    const sandbox = {
      EMBEDDED_CONTRACTOR_MAP: embedded,
      liveContractorMap: live,
      contractorData: personal ? { map: personal, isDefault: false } : { map: {}, isDefault: true },
      window: {
        HPALContractorDirectoryCore: {
          writeSharedContractorCache: (records, options) => {
            writeCalls.push({ records, options });
            // Mirrors the real core's own behaviour closely enough for
            // this test: only SCM-shaped-looking ids "accepted"; empty
            // input rejected.
            const accepted = records.filter((r) => /^SCM[\s-]/i.test(r.dtId || ''));
            if (accepted.length === 0) return null;
            return { cacheVersion: 1, source: options.source, fetchedAt: '2026-08-08T00:00:00.000Z', records: accepted };
          },
          dispatchDirectoryUpdated: (cache, target) => {
            dispatchCalls.push({ cache, target });
            return true;
          },
        },
      },
    };
    const context = vm.createContext(sandbox);
    vm.runInContext(`${getEffectiveSource}\n${publishSource}`, context);
    return { context, writeCalls, dispatchCalls };
  }

  test('publishes exactly getEffectiveContractorMap()\'s own result (embedded -> live -> personal precedence)', () => {
    const { context, writeCalls } = buildSandbox({
      embedded: { 'SCM-LIM 601': 'STALE-STATIC' },
      live: { 'SCM-LIM 601': 'REAL', 'SCM-HLG 960': 'STM' },
      personal: null,
    });
    const result = vm.runInContext('publishMonitorContractorDirectory("monitor-sync")', context);
    assert.ok(result);
    assert.equal(writeCalls.length, 1);
    const publishedIds = new Map(writeCalls[0].records.map((r) => [r.dtId, r.contractor]));
    // Live overrides embedded, matching getEffectiveContractorMap()'s own
    // spread precedence -- confirms the published value is Monitor's real
    // effective value, not the stale embedded one.
    assert.equal(publishedIds.get('SCM-LIM 601'), 'REAL');
    assert.equal(publishedIds.get('SCM-HLG 960'), 'STM');
  });

  test('a personal/local override wins over both embedded and live, exactly as Monitor itself resolves it', () => {
    const { context, writeCalls } = buildSandbox({
      embedded: { 'SCM-LIM 601': 'EMBEDDED-VALUE' },
      live: { 'SCM-LIM 601': 'LIVE-VALUE' },
      personal: { 'SCM-LIM 601': 'PERSONAL-OVERRIDE' },
    });
    vm.runInContext('publishMonitorContractorDirectory("monitor-sync")', context);
    const publishedIds = new Map(writeCalls[0].records.map((r) => [r.dtId, r.contractor]));
    assert.equal(publishedIds.get('SCM-LIM 601'), 'PERSONAL-OVERRIDE');
  });

  test('dispatches the update event only when the write actually succeeded', () => {
    const { context, dispatchCalls } = buildSandbox({ embedded: {}, live: { 'SCM-LIM 601': 'REAL' }, personal: null });
    vm.runInContext('publishMonitorContractorDirectory("monitor-sync")', context);
    assert.equal(dispatchCalls.length, 1);
  });

  test('never throws and returns null if the shared core global is absent (Monitor behavior must be identical either way)', () => {
    const getEffectiveSource = extractFunctionSource(indexHtml, 'getEffectiveContractorMap');
    const publishSource = extractFunctionSource(indexHtml, 'publishMonitorContractorDirectory');
    const context = vm.createContext({
      EMBEDDED_CONTRACTOR_MAP: {},
      liveContractorMap: { 'SCM-LIM 601': 'REAL' },
      contractorData: { map: {}, isDefault: true },
      window: {},
    });
    vm.runInContext(`${getEffectiveSource}\n${publishSource}`, context);
    const result = vm.runInContext('publishMonitorContractorDirectory("monitor-sync")', context);
    assert.equal(result, null);
  });
});

/* ============================================================
   11. contractor-assignment.js NO LONGER PUBLISHES THE SHARED CACHE
============================================================ */
describe('11. contractor-assignment.js is no longer the shared-cache publisher', () => {
  test('fetchExistingContractors() no longer calls writeSharedContractorCache/dispatchDirectoryUpdated', () => {
    const fnSource = extractFunctionSource(contractorAssignmentSource, 'fetchExistingContractors');
    assert.doesNotMatch(fnSource, /writeSharedContractorCache/);
    assert.doesNotMatch(fnSource, /dispatchDirectoryUpdated/);
    assert.doesNotMatch(fnSource, /HPALContractorDirectoryCore/);
  });

  test('fetchExistingContractors() still builds and returns its own state.existing map, unchanged', () => {
    const fnSource = extractFunctionSource(contractorAssignmentSource, 'fetchExistingContractors');
    assert.match(fnSource, /state\.existing = map;/);
    assert.match(fnSource, /return map;/);
  });

  test('the module no longer writes to or dispatches on the shared cache in actual code (prose comments documenting the removal are expected and fine)', () => {
    const codeOnly = contractorAssignmentSource
      .split('\n')
      .filter((line) => !line.trim().startsWith('//'))
      .join('\n');
    assert.doesNotMatch(codeOnly, /writeSharedContractorCache/);
    assert.doesNotMatch(codeOnly, /dispatchDirectoryUpdated/);
    assert.doesNotMatch(codeOnly, /HPALContractorDirectoryCore/);
  });
});

/* ============================================================
   OTHER APPROVED MONITOR OPERATIONS THAT CHANGE THE EFFECTIVE MAP ALSO
   REPUBLISH (manual Excel upload, manual single entry, pending-queue
   flush) -- each is a one-line addition, verified by source inspection.
============================================================ */
describe('Republish on every approved Monitor operation that changes the effective map', () => {
  test('handleContractorFile() (manual Excel upload / local override) republishes after contractorData is set', () => {
    const fnSource = extractFunctionSource(indexHtml, 'handleContractorFile');
    const dataAssignIdx = fnSource.indexOf('contractorData = { map, filename: file.name');
    const publishIdx = fnSource.indexOf("publishMonitorContractorDirectory('monitor-local-override')");
    assert.ok(dataAssignIdx !== -1 && publishIdx !== -1);
    assert.ok(dataAssignIdx < publishIdx);
  });

  test('submitContractorEntry() (manual single-entry update) republishes after the optimistic local update', () => {
    const fnSource = extractFunctionSource(indexHtml, 'submitContractorEntry');
    const mapAssignIdx = fnSource.indexOf('liveContractorMap[dtId] = contractor;');
    const publishIdx = fnSource.indexOf("publishMonitorContractorDirectory('monitor-manual-entry')");
    assert.ok(mapAssignIdx !== -1 && publishIdx !== -1);
    assert.ok(mapAssignIdx < publishIdx);
  });

  test('flushPendingQueue() republishes only when at least one queued entry actually succeeded', () => {
    const fnSource = extractFunctionSource(indexHtml, 'flushPendingQueue');
    assert.match(fnSource, /anySucceeded\s*=\s*true;/);
    assert.match(fnSource, /if\(anySucceeded\)\s*publishMonitorContractorDirectory\('monitor-pending-queue-flush'\);/);
  });
});

/* ============================================================
   NO NEW ENDPOINT CALL WAS INTRODUCED
============================================================ */
describe('No new endpoint call introduced', () => {
  test('publishMonitorContractorDirectory() never calls fetch()', () => {
    const publishSource = extractFunctionSource(indexHtml, 'publishMonitorContractorDirectory');
    assert.doesNotMatch(publishSource, /\bfetch\(/);
  });
});
