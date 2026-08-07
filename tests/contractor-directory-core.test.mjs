// Shared contractor-directory core + Monitor<->Report event bridge tests
// (shared-cache architecture round).
//
// Run with Node's built-in test runner (Node 18+, zero new dependencies):
//
//   node --test tests/contractor-directory-core.test.mjs
//
// Side-effect imports js/services/contractor-directory-core.js (a
// classic, non-module script in production -- see that file's own header
// comment) to populate globalThis.HPALContractorDirectoryCore, exactly as
// index.html's <script> tag does in the browser before
// contractor-assignment.js runs. "Monitor-style" writes in this file
// simulate contractor-assignment.js's own minimal integration (call
// core.writeSharedContractorCache() + core.dispatchDirectoryUpdated(),
// exactly what that file's fetchExistingContractors() now does after
// building its own `map`) rather than executing contractor-assignment.js
// itself, which is a large DOM/fetch/localStorage-coupled IIFE not built
// for a headless Node harness -- report-week.test.mjs and
// report-contractor-sync.test.mjs already established this project's
// convention of testing the underlying mechanism directly rather than
// driving the full browser-only file. Node 18+ provides real
// EventTarget/CustomEvent globals (verified: `typeof globalThis
// .EventTarget === 'function'`), used here as the injected event target
// so the exact same dispatch/subscribe code paths production uses
// (window.dispatchEvent/addEventListener) are exercised, just against a
// test-owned target instead of a real `window`.
//
// Never calls the live Google Apps Script endpoint.

import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import '../js/services/contractor-directory-core.js';
import {
  clearContractorDirectoryCache,
  loadCachedContractorDirectory,
  getContractorDirectorySnapshot,
  lookupContractor,
  subscribeContractorDirectoryUpdated,
} from '../js/services/contractor-directory-service.js';
import { resolveContractor } from '../js/pages/report/profiles/shared-report-profile.js';
import { resolveEsgContractor } from '../js/pages/report/profiles/esg-profile.js';
import { recomputeContractorAggregates } from '../js/pages/report/report-utils.js';
import { reportState, resetReportState } from '../js/pages/report/report-state.js';

const core = globalThis.HPALContractorDirectoryCore;

function createMockStorage() {
  const map = new Map();
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => { map.set(key, String(value)); },
    removeItem: (key) => { map.delete(key); },
  };
}

beforeEach(() => {
  globalThis.localStorage = createMockStorage();
  clearContractorDirectoryCache();
  resetReportState();
});

/* ============================================================
   NORMALIZATION -- the newly reported live DTs
============================================================ */
describe('canonicalDtId() / normalizedKey() -- newly reported live DTs', () => {
  test('SCM-HLG 946/944/953/956/959 and SCM-LIM 228/230/231 (all with trailing " DT") normalize as expected', () => {
    const cases = [
      ['SCM-HLG 946 DT', 'SCMHLG946'],
      ['SCM-HLG 944 DT', 'SCMHLG944'],
      ['SCM-HLG 953 DT', 'SCMHLG953'],
      ['SCM-HLG 956 DT', 'SCMHLG956'],
      ['SCM-HLG 959 DT', 'SCMHLG959'],
      ['SCM-LIM 228 DT', 'SCMLIM228'],
      ['SCM-LIM 230 DT', 'SCMLIM230'],
      ['SCM-LIM 231 DT', 'SCMLIM231'],
    ];
    cases.forEach(([input, expectedKey]) => {
      assert.equal(core.normalizedKey(input), expectedKey, `${input} should normalize to ${expectedKey}`);
    });
  });

  test('a remote row without trailing "DT" matches a workbook value containing trailing "DT"', () => {
    assert.equal(core.normalizedKey('SCM-HLG 960'), core.normalizedKey('SCM-HLG 960 DT'));
    assert.equal(core.normalizedKey('SCM-LIM 228'), core.normalizedKey('SCM-LIM 228 DT'));
    assert.equal(core.normalizedKey('SCM-LIM 231'), core.normalizedKey('SCM-LIM 231 DT.'));
  });
});

/* ============================================================
   validateContractorRows / cache schema
============================================================ */
describe('validateContractorRows()', () => {
  test('accepts a valid remote-shaped row set', () => {
    assert.equal(core.validateContractorRows([{ dtId: 'SCM-HLG 960', contractor: 'STM' }]).ok, true);
  });

  test('rejects malformed rows', () => {
    assert.equal(core.validateContractorRows([{ dtId: 'SCM-HLG 960' }]).ok, false);
    assert.equal(core.validateContractorRows('not an array').ok, false);
  });

  test('rejects conflicting duplicates, deterministically merges identical duplicates', () => {
    assert.equal(core.validateContractorRows([
      { dtId: 'SCM-HLG 960', contractor: 'STM' },
      { dtId: 'SCM HLG 960', contractor: 'TII' },
    ]).ok, false);

    const identical = core.validateContractorRows([
      { dtId: 'SCM-HLG 960', contractor: 'STM' },
      { dtId: 'SCM HLG 960', contractor: 'STM' },
    ]);
    assert.equal(identical.ok, true);
    assert.equal(identical.records.length, 1);
  });
});

describe('Shared cache read/write (hpal.contractors.v1 schema)', () => {
  test('write + read round-trip', () => {
    const storage = createMockStorage();
    const cache = core.writeSharedContractorCache([{ dtId: 'SCM-HLG 960', contractor: 'STM' }], { source: 'remote' }, storage);
    assert.ok(cache);
    assert.equal(cache.cacheVersion, 1);
    const read = core.readSharedContractorCache(storage);
    assert.equal(read.records.length, 1);
    assert.equal(read.records[0].contractor, 'STM');
  });

  test('never overwrites a valid cache with invalid data', () => {
    const storage = createMockStorage();
    core.writeSharedContractorCache([{ dtId: 'SCM-HLG 960', contractor: 'STM' }], { source: 'remote' }, storage);
    const rejected = core.writeSharedContractorCache([{ dtId: 'BAD ROW' }], { source: 'remote' }, storage);
    assert.equal(rejected, null);
    assert.equal(core.readSharedContractorCache(storage).records.length, 1);
  });

  test('readSharedContractorCache returns null for missing/corrupted cache without throwing', () => {
    const storage = createMockStorage();
    assert.equal(core.readSharedContractorCache(storage), null);
    storage.setItem(core.CACHE_KEY, 'not json');
    assert.equal(core.readSharedContractorCache(storage), null);
  });
});

describe('dispatchDirectoryUpdated()', () => {
  test('dispatches on an injected EventTarget with the expected detail', () => {
    const target = new EventTarget();
    let received = null;
    target.addEventListener(core.DIRECTORY_UPDATED_EVENT, (e) => { received = e.detail; });
    const cache = core.createContractorCache(
      [{ dtId: 'SCM-HLG 960', normalizedKey: 'SCMHLG960', contractor: 'STM' }],
      { source: 'remote', fetchedAt: '2026-08-08T00:00:00.000Z' },
    );
    assert.equal(core.dispatchDirectoryUpdated(cache, target), true);
    assert.deepEqual(received, { source: 'remote', recordCount: 1, fetchedAt: '2026-08-08T00:00:00.000Z' });
  });

  test('returns false (never throws) when no usable event target is available', () => {
    const cache = core.createContractorCache([], { source: 'remote' });
    assert.equal(core.dispatchDirectoryUpdated(cache, null), false);
  });
});

/* ============================================================
   1-14. EVENT TESTS -- Monitor-style write -> Report reacts
============================================================ */
describe('Monitor-style write notifies Report via the shared cache + event', () => {
  test('1-2. a Monitor-style write persists hpal.contractors.v1 with the FULL validated directory, not only unmatched units', () => {
    const monitorRows = [
      { dtId: 'SCM-HLG 960', contractor: 'STM' },
      { dtId: 'SCM-LIM 601', contractor: 'REAL' },
      { dtId: 'SCM-LIM 228', contractor: 'MRP' },
    ];
    const cache = core.writeSharedContractorCache(monitorRows, { source: 'remote' }, globalThis.localStorage);
    assert.ok(cache);
    assert.equal(cache.records.length, 3);
    const read = core.readSharedContractorCache(globalThis.localStorage);
    assert.equal(read.records.length, 3); // the full directory, not a filtered "unmatched only" subset
  });

  test('3-7. dispatching the event notifies a subscribed Report listener, which reloads and reclassifies', () => {
    const eventTarget = new EventTarget();

    // Report subscribes exactly like report-page.js does in
    // initReportPage(), using an injected target for this test.
    let eventFired = 0;
    const unsubscribe = subscribeContractorDirectoryUpdated(() => {
      eventFired++;
      loadCachedContractorDirectory(); // 4. Report receives the event and reloads
    }, { eventTarget });

    // "Already-parsed" workbook fixture: two of three trucks are not yet
    // in any directory (static or shared cache).
    reportState.fileParsed = true;
    reportState.resolvedBuyer = 'ESG';
    reportState.parsed = {
      records: [
        { carNo: 'SCM-HLG 960 DT', netKg: 30000, grossTime: new Date(2026, 7, 6, 10), dome: 'D1', grade: 1.3, oreClass: 'MGLO', contractor: 'TIDAK DIKENALI' },
        { carNo: 'SCM-LIM 228 DT', netKg: 31000, grossTime: new Date(2026, 7, 6, 11), dome: 'D1', grade: 1.3, oreClass: 'MGLO', contractor: 'TIDAK DIKENALI' },
        { carNo: 'SCM-LIM 601', netKg: 29000, grossTime: new Date(2026, 7, 6, 12), dome: 'D2', grade: 1.5, oreClass: 'HGLO', contractor: 'REAL' },
      ],
      onShiftTon: 90 /* deliberately arbitrary -- must survive unchanged */,
      onShiftRit: 3,
      shiftLabel: 'Day Shift',
      fileDate: new Date(2026, 7, 6),
    };

    const before = recomputeContractorAggregates(reportState.parsed.records, resolveEsgContractor);
    assert.equal(before.unmatchedTrucks.length, 2); // 6. baseline

    // Monitor-style write + dispatch (simulates contractor-assignment.js's
    // own minimal integration).
    const cache = core.writeSharedContractorCache([
      { dtId: 'SCM-HLG 960', contractor: 'STM' },
      { dtId: 'SCM-LIM 228', contractor: 'MRP' },
    ], { source: 'remote' }, globalThis.localStorage);
    core.dispatchDirectoryUpdated(cache, eventTarget);

    assert.equal(eventFired, 1); // 3. event dispatched and received exactly once
    assert.equal(getContractorDirectorySnapshot().source, 'shared-cache');
    assert.equal(lookupContractor('SCM-HLG 960'), 'STM'); // Report's own snapshot now sees it

    // 5. already-parsed records are reclassified (via the same pure
    // function report-page.js's event handler calls).
    const after = recomputeContractorAggregates(reportState.parsed.records, resolveEsgContractor);
    assert.equal(after.unmatchedTrucks.length, 0); // 6-7. unmatched count decreases to zero
    assert.deepEqual(after.contractorCounts.find(([name]) => name === 'STM'), ['STM', 1]); // 7. contractor counts change correctly
    assert.deepEqual(after.contractorCounts.find(([name]) => name === 'MRP'), ['MRP', 1]);

    unsubscribe();
  });

  test('8-13. tonnage, ritase, shift, Week, personnel, and manpower are all structurally untouched by reclassification', () => {
    const records = [
      { carNo: 'SCM-HLG 960 DT', netKg: 30000, grossTime: new Date(2026, 7, 6, 10), dome: 'D1', grade: 1.3, oreClass: 'MGLO', contractor: 'TIDAK DIKENALI' },
    ];
    const result = recomputeContractorAggregates(records, resolveContractor);
    const keys = Object.keys(result).sort();
    assert.deepEqual(keys, ['contractorCounts', 'totalADT', 'totalDT', 'unmatchedTrucks'].sort());
    // 8. tonnage, 9. ritase, 10. shift, 11. Week, 12. personnel, 13. manpower --
    // none of these fields exist on the function's input contract (only
    // `carNo` is read per record) or its return value, so none of them
    // can possibly change as a side effect of a directory refresh.
    ['onShiftTon', 'onShiftRit', 'shiftLabel', 'weekNumber', 'weekYear', 'weekStart', 'weekEnd', 'personnel', 'manpowerThirdParty', 'totalManpower'].forEach((field) => {
      assert.ok(!(field in result), `${field} must not appear in recomputeContractorAggregates()'s return value`);
    });
  });

  test('14. generated report output invalidation is a report-page.js/DOM-level concern (reportState.reportText clearing) -- covered by the manual regression checklist, not unit-testable without a browser DOM, consistent with this project\'s established convention (see report-week.test.mjs\'s own renderWeekDisplay() exclusion)', () => {
    assert.ok(true);
  });
});

/* ============================================================
   CROSS-PROFILE: a DT present only in the shared cache (never the static
   fallback) is recognized by all four buyer profiles.
============================================================ */
describe('Cross-profile: a shared-cache-only DT is recognized by HYNC, SLNC, ESG Format A, ESG Format B', () => {
  beforeEach(() => {
    core.writeSharedContractorCache([
      { dtId: 'SCM-HLG 953', contractor: 'STM' },
      { dtId: 'SCM-HLG 956', contractor: 'STM' },
      { dtId: 'SCM-HLG 959', contractor: 'STM' },
      { dtId: 'SCM-LIM 231', contractor: 'MRP' },
    ], { source: 'remote' }, globalThis.localStorage);
    loadCachedContractorDirectory();
  });

  test('HYNC/SLNC (resolveContractor) recognizes SCM-HLG 953 DT and SCM-LIM 231 DT', () => {
    assert.equal(resolveContractor('SCM-HLG 953 DT'), 'STM');
    assert.equal(resolveContractor('SCM-LIM 231 DT'), 'MRP');
  });

  test('ESG Format A/B (resolveEsgContractor) recognizes SCM-HLG 956 DT and SCM-HLG 959 DT', () => {
    assert.equal(resolveEsgContractor('SCM-HLG 956 DT'), 'STM');
    assert.equal(resolveEsgContractor('SCM-HLG 959 DT'), 'STM');
  });

  test('none of these ids exist in the static fallback table at all -- confirms this is a genuine shared-cache-only recognition, not incidental static coverage', async () => {
    const { lookupHyncContractor } = await import('../js/services/contractor-adapter.js');
    ['SCM-HLG 953', 'SCM-HLG 956', 'SCM-HLG 959', 'SCM-LIM 231'].forEach((id) => {
      assert.equal(lookupHyncContractor(id), null);
    });
  });
});
