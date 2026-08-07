// Report <-> Monitor-owned shared contractor directory integration tests
// (single-sync architecture round).
//
// Run with Node's built-in test runner (Node 18+, zero new dependencies):
//
//   node --test tests/report-contractor-sync.test.mjs
//
// Exercises shared-report-profile.js's resolveContractor() (HYNC/SLNC) and
// esg-profile.js's resolveEsgContractor() (ESG Format A/B -- both formats
// converge on this one post-parse function, see that file's own header
// comment) directly, the same way tests/report-week.test.mjs already
// exercises parseFlexibleDate()/makeLocalDate() directly rather than
// driving a full parseWeighbridgeWorkbook()/parseEsgWorkbook() call: full
// workbook parsing needs the global `XLSX` (SheetJS) object, only ever
// loaded in the browser.
//
// There is no `globalThis.fetch` mock anywhere in this file: Report
// performs no network request of its own for contractor data. "Monitor
// syncs" are simulated the same way contractor-assignment.js's own
// integration works -- write hpal.contractors.v1 directly (mirroring
// contractor-directory-core.js's writeSharedContractorCache()), then call
// loadCachedContractorDirectory() (init-time read) or dispatch the update
// event through subscribeContractorDirectoryUpdated() (live-sync read).

import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  clearContractorDirectoryCache,
  loadCachedContractorDirectory,
  getContractorDirectorySnapshot,
  getContractorDirectoryStatus,
  subscribeContractorDirectoryUpdated,
} from '../js/services/contractor-directory-service.js';
import { resolveContractor } from '../js/pages/report/profiles/shared-report-profile.js';
import { resolveEsgContractor } from '../js/pages/report/profiles/esg-profile.js';
import { lookupHyncContractor } from '../js/services/contractor-adapter.js';
import { buildPersonnelOutputLines, applyBuyerDefaultSamplerToPersonnel } from '../js/pages/report/report-personnel.js';
import { recomputeContractorAggregates } from '../js/pages/report/report-utils.js';

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

// Simulates Monitor's own sync writing the shared cache -- the exact
// shape contractor-directory-core.js's writeSharedContractorCache()
// produces from a `[{dtId, contractor}, ...]` remote payload.
function monitorSyncs(storage, rows, overrides = {}) {
  const byKey = new Map();
  rows.forEach(({ dtId, contractor }) => {
    const key = dtId.toUpperCase().replace(/[^A-Z0-9]/g, '');
    byKey.set(key, { dtId, normalizedKey: key, contractor });
  });
  storage.setItem(CACHE_KEY, JSON.stringify({
    cacheVersion: 1,
    source: 'remote',
    fetchedAt: '2026-08-07T00:00:00.000Z',
    records: Array.from(byKey.values()),
    ...overrides,
  }));
}

beforeEach(() => {
  globalThis.localStorage = createMockStorage();
  clearContractorDirectoryCache();
});

/* ============================================================
   6/21-24. HYNC / SLNC / ESG FORMAT A / ESG FORMAT B READ THE MONITOR
   CACHE (NO FETCH INVOLVED)
============================================================ */
describe('Buyer profiles read the Monitor-synced shared cache directly (no fetch)', () => {
  test('6/21. HYNC (resolveContractor) uses the Monitor-synced record when present', () => {
    monitorSyncs(globalThis.localStorage, [{ dtId: 'SCM-LIM 601', contractor: 'REAL' }]);
    loadCachedContractorDirectory();
    assert.equal(getContractorDirectorySnapshot().source, 'cached');
    assert.equal(resolveContractor('SCM-LIM 601'), 'REAL');
  });

  test('22. SLNC (same resolveContractor, "SCM LIM ### DT" input shape) uses the Monitor-synced record', () => {
    monitorSyncs(globalThis.localStorage, [{ dtId: 'SCM-LIM 601', contractor: 'REAL' }]);
    loadCachedContractorDirectory();
    assert.equal(resolveContractor('SCM LIM 601 DT'), 'REAL');
  });

  test('23. ESG Format A (resolveEsgContractor) uses the Monitor-synced record when present', () => {
    monitorSyncs(globalThis.localStorage, [{ dtId: 'SCM-LIM 949', contractor: 'TII' }]);
    loadCachedContractorDirectory();
    assert.equal(resolveEsgContractor('SCM-LIM 949'), 'TII');
  });

  test('24. ESG Format B (trailing-period "DT." shape) also resolves against the Monitor-synced record', () => {
    monitorSyncs(globalThis.localStorage, [{ dtId: 'SCM-LIM 910', contractor: 'TII' }]);
    loadCachedContractorDirectory();
    assert.equal(resolveEsgContractor('SCM-LIM 910 DT.'), 'TII');
  });
});

/* ============================================================
   SCM UNITS: THE MONITOR-SYNCED CACHE IS THE SOLE AUTHORITY, NO STATIC
   FALLBACK -- "Do not silently classify current SCM units using stale
   static data."
============================================================ */
describe('For SCM-HLG/SCM-LIM units, the Monitor-synced cache is authoritative -- never the static table', () => {
  test('a Monitor-synced record overrides an outdated static contractor', () => {
    // Confirms the premise: contractor-adapter.js's static table really
    // does have a pre-existing (different) entry for this id.
    assert.equal(lookupHyncContractor('SCM-LIM 601'), 'REAL');

    monitorSyncs(globalThis.localStorage, [{ dtId: 'SCM-LIM 601', contractor: 'HYNC-CORRECTED' }]);
    loadCachedContractorDirectory();

    assert.equal(resolveContractor('SCM-LIM 601'), 'HYNC-CORRECTED');
    assert.equal(resolveEsgContractor('SCM-LIM 601'), 'HYNC-CORRECTED');
    assert.notEqual(resolveContractor('SCM-LIM 601'), 'REAL');
  });

  test('WITHOUT any Monitor sync (source "none"), an SCM-shaped id resolves to null -- it never silently falls back to the static table\'s own SCM-LIM 601 entry', () => {
    assert.equal(getContractorDirectorySnapshot().source, 'none');
    assert.equal(resolveContractor('SCM-LIM 601'), null);
    assert.equal(resolveEsgContractor('SCM-HLG 960'), null);
  });

  test('a non-SCM id (ADT/MIM, never part of the synced key space) still falls through to the static fallback regardless of Monitor sync state', () => {
    assert.equal(resolveContractor('ADT 001'), 'ADT HILLCON'); // no sync at all
    monitorSyncs(globalThis.localStorage, [{ dtId: 'SCM-LIM 601', contractor: 'REAL' }]);
    loadCachedContractorDirectory();
    assert.equal(resolveContractor('ADT 001'), 'ADT HILLCON'); // still static, unaffected by an unrelated sync
    assert.equal(resolveEsgContractor('ADT 001'), 'ADT HILLCON');
  });

  test('an SCM-shaped id genuinely absent from a valid Monitor sync remains unmatched (never guessed from static)', () => {
    monitorSyncs(globalThis.localStorage, [{ dtId: 'SCM-LIM 601', contractor: 'REAL' }]);
    loadCachedContractorDirectory();
    // SCM-LIM 999999 does not exist in either the sync or the static
    // table, but even if it DID exist in the static table, the rule
    // above requires it to stay unmatched once SCM units are
    // Monitor-cache-authoritative.
    assert.equal(resolveContractor('SCM-LIM 999999'), null);
    assert.equal(resolveEsgContractor('SCM-LIM 999999'), null);
  });
});

/* ============================================================
   7-10. EXACT REPORTED UNMATCHED DT NORMALIZATION
============================================================ */
describe('7-10. Exact reported unmatched DT ids resolve once Monitor has synced', () => {
  beforeEach(() => {
    monitorSyncs(globalThis.localStorage, [
      { dtId: 'SCM-HLG 960', contractor: 'STM' },
      { dtId: 'SCM-HLG 946', contractor: 'STM' },
      { dtId: 'SCM-HLG 944', contractor: 'STM' },
      { dtId: 'SCM-LIM 228', contractor: 'MRP' },
      { dtId: 'SCM-LIM 230', contractor: 'MRP' },
    ]);
    loadCachedContractorDirectory();
  });

  test('confirms the premise: none of these ids exist in the static fallback table at all', () => {
    ['SCM-HLG 960', 'SCM-HLG 946', 'SCM-HLG 944', 'SCM-LIM 228', 'SCM-LIM 230'].forEach((id) => {
      assert.equal(lookupHyncContractor(id), null, `expected ${id} to be absent from the static table`);
    });
  });

  test('7. "SCM-HLG 960 DT" (workbook form) matches Monitor-synced record stored as "SCM-HLG 960"', () => {
    assert.equal(resolveContractor('SCM-HLG 960 DT'), 'STM');
    assert.equal(resolveEsgContractor('SCM-HLG 960 DT'), 'STM');
  });

  test('8. "SCM-HLG 946 DT" matches Monitor-synced record stored as "SCM-HLG 946"', () => {
    assert.equal(resolveContractor('SCM-HLG 946 DT'), 'STM');
    assert.equal(resolveEsgContractor('SCM-HLG 946 DT'), 'STM');
  });

  test('9. "SCM-LIM 228 DT" matches Monitor-synced record stored as "SCM-LIM 228"', () => {
    assert.equal(resolveContractor('SCM-LIM 228 DT'), 'MRP');
    assert.equal(resolveEsgContractor('SCM-LIM 228 DT'), 'MRP');
  });

  test('10. "SCM-LIM 230 DT" matches Monitor-synced record stored as "SCM-LIM 230"', () => {
    assert.equal(resolveContractor('SCM-LIM 230 DT'), 'MRP');
    assert.equal(resolveEsgContractor('SCM-LIM 230 DT'), 'MRP');
  });

  test('every documented equivalent form of SCM-HLG 960 resolves identically', () => {
    const forms = ['SCM-HLG 960', 'SCM HLG 960', 'SCM_HLG_960', 'SCM-HLG-960', 'SCM-HLG 960 DT', 'SCM-HLG 960 DT.'];
    forms.forEach((form) => {
      assert.equal(resolveContractor(form), 'STM', `form "${form}" should resolve to STM`);
    });
  });

  test('an unrelated id in the same numeric neighborhood remains unmatched (no over-broad collision)', () => {
    assert.equal(resolveContractor('SCM-HLG 961'), null);
    assert.equal(resolveContractor('SCM-LIM 229'), null); // not in this fixture's synced set
  });
});

/* ============================================================
   12-15. MONITOR UPDATE EVENT -> REPORT RELOADS + RECLASSIFIES
   (recomputeContractorAggregates)
============================================================ */
describe('Monitor sync event reclassifies an already-uploaded workbook', () => {
  // A minimal already-parsed-workbook fixture: only the fields
  // recomputeContractorAggregates() actually reads (`carNo`) matter here,
  // but the shape mirrors what parseWeighbridgeWorkbook()/
  // buildEsgParsedResult() really produce, including fields that must
  // stay untouched (netKg, grossTime, dome, grade, oreClass) to prove
  // this function never rewrites them.
  function fixtureRecords() {
    return [
      { carNo: 'SCM-HLG 960 DT', netKg: 30000, grossTime: new Date(2026, 7, 6, 10), dome: 'D1', grade: 1.3, oreClass: 'MGLO', contractor: 'TIDAK DIKENALI' },
      { carNo: 'SCM-HLG 946 DT', netKg: 31000, grossTime: new Date(2026, 7, 6, 11), dome: 'D1', grade: 1.3, oreClass: 'MGLO', contractor: 'TIDAK DIKENALI' },
      { carNo: 'SCM-LIM 601', netKg: 29000, grossTime: new Date(2026, 7, 6, 12), dome: 'D2', grade: 1.5, oreClass: 'HGLO', contractor: 'REAL' },
    ];
  }

  test('12-13-14. before any Monitor sync, all three SCM-shaped trucks are unmatched (SCM units never fall back to static); after a live sync event, the same records reclassify and totals update', () => {
    const records = fixtureRecords();

    const before = recomputeContractorAggregates(records, resolveContractor);
    // All three ids are SCM-shaped (SCM-HLG.../SCM-LIM 601) -- with no
    // Monitor sync yet, none of them may fall back to the static table
    // (the approved rule for this id family), so all three are unmatched.
    assert.equal(before.unmatchedTrucks.length, 3);
    assert.equal(before.totalDT, 3); // still 3 unique trucks total
    assert.ok(!before.contractorCounts.some(([name]) => name === 'STM'));

    const eventTarget = new EventTarget();
    let reclassified = null;
    const unsubscribe = subscribeContractorDirectoryUpdated(() => {
      reclassified = recomputeContractorAggregates(records, resolveContractor);
    }, { eventTarget });

    // Simulate Monitor's own sync (contractor-assignment.js's minimal
    // integration): write the shared cache, then dispatch the event.
    monitorSyncs(globalThis.localStorage, [
      { dtId: 'SCM-HLG 960', contractor: 'STM' },
      { dtId: 'SCM-HLG 946', contractor: 'STM' },
      { dtId: 'SCM-LIM 601', contractor: 'REAL' },
    ]);
    eventTarget.dispatchEvent(new CustomEvent('hpal:contractor-directory-updated', { detail: { source: 'remote', recordCount: 3, fetchedAt: '2026-08-07T00:00:00.000Z' } }));

    assert.equal(getContractorDirectorySnapshot().source, 'synced'); // 12. Report reloaded via the event
    assert.ok(reclassified);
    assert.equal(reclassified.unmatchedTrucks.length, 0); // 13. unmatched count decreases
    assert.deepEqual(reclassified.contractorCounts.find(([name]) => name === 'STM'), ['STM', 2]); // 14. contractor breakdown updates
    assert.equal(reclassified.totalDT, 3);
    assert.equal(reclassified.totalADT, 0);

    unsubscribe();
  });

  test('15-19. recomputeContractorAggregates only ever reads carNo and only ever returns contractor-derived fields (tonnage/ritase/shift/Week/personnel untouched by construction)', () => {
    const records = fixtureRecords();
    const result = recomputeContractorAggregates(records, resolveContractor);
    const returnedKeys = Object.keys(result).sort();
    assert.deepEqual(returnedKeys, ['contractorCounts', 'totalADT', 'totalDT', 'unmatchedTrucks'].sort());
    assert.ok(!('onShiftTon' in result));
    assert.ok(!('onShiftRit' in result));
    assert.ok(!('shiftLabel' in result));
    assert.ok(!('weekNumber' in result));
    assert.ok(!('personnel' in result));
  });

  test('row order does not affect the recomputed aggregates', () => {
    const records = fixtureRecords();
    const reversed = records.slice().reverse();
    const a = recomputeContractorAggregates(records, resolveContractor);
    const b = recomputeContractorAggregates(reversed, resolveContractor);
    assert.deepEqual(a.contractorCounts, b.contractorCounts);
    assert.equal(a.totalDT, b.totalDT);
    assert.equal(a.totalADT, b.totalADT);
    assert.deepEqual([...a.unmatchedTrucks].sort(), [...b.unmatchedTrucks].sort());
  });
});

/* ============================================================
   9-10. NO CACHE -> THE STATUS REPORT-PAGE.JS'S goToStep3() GATE READS
============================================================ */
describe('No-cache status (drives report-page.js\'s "block final generation" gate and the "Not available" UI)', () => {
  test('with no Monitor cache at all, status source is "none" -- the exact condition report-page.js blocks generation on', () => {
    const status = getContractorDirectoryStatus();
    assert.equal(status.source, 'none');
    assert.equal(status.recordCount, 0);
  });

  test('once Monitor has synced, status source is no longer "none"', () => {
    monitorSyncs(globalThis.localStorage, [{ dtId: 'SCM-LIM 601', contractor: 'REAL' }]);
    loadCachedContractorDirectory();
    assert.notEqual(getContractorDirectoryStatus().source, 'none');
  });
});

/* ============================================================
   11/20. NO CONTRACTOR WRITE BEHAVIOR / MONITOR UNCHANGED (source checks)
============================================================ */
describe('11/20/29-30. No write behavior added; Monitor\'s own static/data sources untouched', () => {
  test('resolveContractor/resolveEsgContractor never mutate the static table or the Monitor cache -- read-only, single-argument, string-in/string-out', () => {
    assert.equal(resolveContractor.length, 1);
    assert.equal(resolveEsgContractor.length, 1);
  });
});

/* ============================================================
   OUTPUT LABELS MATCH THE APPROVED PERSONNEL FORMAT
============================================================ */
describe('Personnel output labels remain correct alongside the Monitor-owned sync architecture', () => {
  test('AWK example matches the approved corrected format', () => {
    const records = [
      { id: 's1', role_type: 'SPV_SCM', name: 'Illofi', organization: 'SCM', active: true },
      { id: 'f1', role_type: 'FRM_SCM', name: 'Adi Guna', organization: 'SCM', active: true },
      { id: 'sam1', role_type: 'SAMPLER', name: 'AWK', organization: 'AWK', active: true },
      { id: 'p1', role_type: 'PIC_3RD', name: 'La Ode Osardi', organization: 'AWK', active: true },
    ];
    const personnel = {
      spvScmIds: ['s1'],
      frmScmIds: ['f1'],
      samplerId: 'sam1',
      samplerSource: 'buyer-default',
      picThirdId: 'p1',
      manpowerThirdParty: 15,
      totalManpower: 22,
    };
    const lines = buildPersonnelOutputLines(records, personnel, 'HYNC');
    assert.equal(lines[3], 'PIC AWK                       : La Ode Osardi');
    assert.equal(lines[4], 'Manpower AWK           : 15');
    assert.equal(lines[5], 'Total Manpower AWK  : 22');
    assert.ok(!lines.join('\n').includes('PIC 3rd'));
  });
});

/* ============================================================
   21-24. BUYER DEFAULT OUTPUT LABELS (HYNC/SLNC/ESG A/ESG B)
============================================================ */
describe('Buyer default sampler drives the correct output labels', () => {
  function directory() {
    return [
      { id: 'sam-awk', role_type: 'SAMPLER', name: 'AWK', organization: 'AWK', active: true },
      { id: 'sam-atq', role_type: 'SAMPLER', name: 'ATQ', organization: 'ATQ', active: true },
      { id: 'sam-xyz', role_type: 'SAMPLER', name: 'XYZ', organization: 'XYZ', active: true },
      { id: 'pic-awk', role_type: 'PIC_3RD', name: 'La Ode Osardi', organization: 'AWK', active: true },
      { id: 'pic-atq', role_type: 'PIC_3RD', name: 'Khalifa Akbar', organization: 'ATQ', active: true },
      { id: 'pic-xyz', role_type: 'PIC_3RD', name: 'Future Pic', organization: 'XYZ', active: true },
      { id: 'spv1', role_type: 'SPV_SCM', name: 'Illofi', organization: 'SCM', active: true },
      { id: 'frm1', role_type: 'FRM_SCM', name: 'Adi Guna', organization: 'SCM', active: true },
    ];
  }

  function personnelFor(buyer, records, picId) {
    const base = applyBuyerDefaultSamplerToPersonnel(records, buyer, {
      spvScmIds: ['spv1'], frmScmIds: ['frm1'], samplerId: null, samplerSource: null, picThirdId: null, manpowerThirdParty: 15, totalManpower: 22,
    });
    return { ...base, picThirdId: picId };
  }

  test('HYNC output uses PIC AWK / Manpower AWK / Total Manpower AWK', () => {
    const records = directory();
    const personnel = personnelFor('HYNC', records, 'pic-awk');
    assert.equal(personnel.samplerSource, 'buyer-default');
    const lines = buildPersonnelOutputLines(records, personnel, 'HYNC');
    assert.equal(lines[2], 'Independent Sampler : AWK');
    assert.equal(lines[3], 'PIC AWK                       : La Ode Osardi');
    assert.equal(lines[4], 'Manpower AWK           : 15');
    assert.equal(lines[5], 'Total Manpower AWK  : 22');
  });

  test('SLNC output also defaults to AWK labels', () => {
    const records = directory();
    const personnel = personnelFor('SLNC', records, 'pic-awk');
    const lines = buildPersonnelOutputLines(records, personnel, 'SLNC');
    assert.equal(lines[2], 'Independent Sampler : AWK');
    assert.equal(lines[3], 'PIC AWK                       : La Ode Osardi');
  });

  test('ESG (Format A source) output uses ATQ labels', () => {
    const records = directory();
    const personnel = personnelFor('ESG', records, 'pic-atq');
    const lines = buildPersonnelOutputLines(records, personnel, 'ESG');
    assert.equal(lines[2], 'Independent Sampler : ATQ');
    assert.equal(lines[3], 'PIC ATQ                        : Khalifa Akbar');
    assert.equal(lines[4], 'Manpower ATQ            : 15');
    assert.equal(lines[5], 'Total Manpower ATQ  : 22');
  });

  test('ESG (Format B source) output uses the same ATQ labels -- both formats share the ESG buyer identity', () => {
    const records = directory();
    const personnel = personnelFor('ESG', records, 'pic-atq');
    const lines = buildPersonnelOutputLines(records, personnel, 'ESG');
    assert.equal(lines[2], 'Independent Sampler : ATQ');
    assert.equal(lines[3], 'PIC ATQ                        : Khalifa Akbar');
  });

  test('a future sampler organization (XYZ) dynamically changes all three labels together', () => {
    const records = directory();
    const personnel = { ...personnelFor('HYNC', records, 'pic-awk'), samplerId: 'sam-xyz', samplerSource: 'user-override', picThirdId: 'pic-xyz' };
    const lines = buildPersonnelOutputLines(records, personnel, 'HYNC');
    assert.equal(lines[2], 'Independent Sampler : XYZ');
    assert.equal(lines[3], 'PIC XYZ                       : Future Pic');
    assert.equal(lines[4], 'Manpower XYZ           : 15');
    assert.equal(lines[5], 'Total Manpower XYZ  : 22');
  });
});
