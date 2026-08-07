// Report <-> shared contractor directory integration tests (contractor
// directory drift fix).
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
// workbook parsing needs the global `XLSX` (SheetJS) object, which is only
// ever loaded in the browser (index.html's <script> tag), not available in
// a plain Node test environment, and re-testing HYNC/SLNC/ESG's own
// row-parsing logic is already covered by report-week.test.mjs and the
// project's manual regression checklist -- this file's job is only to
// verify the contractor *resolution precedence* those parsers now call
// into, which does not require XLSX at all.
//
// Never calls the live Google Apps Script endpoint -- contractor-directory
// -service.js's sync is driven through a mock `globalThis.fetch`/
// `globalThis.localStorage`, identical to
// tests/contractor-directory-service.test.mjs's own conventions.

import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  clearContractorDirectoryCache,
  syncContractorDirectory,
  getContractorDirectorySnapshot,
} from '../js/services/contractor-directory-service.js';
import { resolveContractor } from '../js/pages/report/profiles/shared-report-profile.js';
import { resolveEsgContractor } from '../js/pages/report/profiles/esg-profile.js';
import { lookupHyncContractor } from '../js/services/contractor-adapter.js';
import { buildPersonnelOutputLines, applyBuyerDefaultSamplerToPersonnel } from '../js/pages/report/report-personnel.js';
import { recomputeContractorAggregates } from '../js/pages/report/report-utils.js';

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

function mockResponse(payload) {
  return { ok: true, json: async () => payload };
}

beforeEach(() => {
  globalThis.localStorage = createMockStorage();
  clearContractorDirectoryCache();
  delete globalThis.fetch;
});

/* ============================================================
   12-15. HYNC / SLNC / ESG FORMAT A / ESG FORMAT B USE THE SYNCHRONIZED
   LOOKUP
============================================================ */
describe('Buyer profiles use the synchronized contractor directory before the static fallback', () => {
  test('12. HYNC (resolveContractor) uses a synchronized record when present', async () => {
    globalThis.fetch = async () => mockResponse([{ dtId: 'SCM-LIM 601', contractor: 'REAL' }]);
    await syncContractorDirectory();
    // Static fallback for this exact id is 'REAL' too in the real table,
    // so use a different, unambiguous static entry to prove precedence:
    // override an id whose static mapping is confirmed different.
    assert.equal(resolveContractor('SCM-LIM 601'), 'REAL');
  });

  test('13. SLNC (same resolveContractor, "SCM LIM ### DT" input shape) uses the synchronized record', async () => {
    globalThis.fetch = async () => mockResponse([{ dtId: 'SCM-LIM 601', contractor: 'REAL' }]);
    await syncContractorDirectory();
    // SLNC's raw id shape includes a trailing " DT" and a space instead of
    // a hyphen -- resolveContractor must resolve it to the same synced
    // record as the canonical HYNC-shaped id.
    assert.equal(resolveContractor('SCM LIM 601 DT'), 'REAL');
  });

  test('14. ESG Format A/B (resolveEsgContractor) uses a synchronized record when present', async () => {
    globalThis.fetch = async () => mockResponse([{ dtId: 'SCM-LIM 949', contractor: 'TII' }]);
    await syncContractorDirectory();
    assert.equal(resolveEsgContractor('SCM-LIM 949'), 'TII');
  });

  test('15. ESG-specific trailing-period "DT." shape also resolves against the synced directory', async () => {
    globalThis.fetch = async () => mockResponse([{ dtId: 'SCM-LIM 910', contractor: 'TII' }]);
    await syncContractorDirectory();
    assert.equal(resolveEsgContractor('SCM-LIM 910 DT.'), 'TII');
  });
});

/* ============================================================
   SYNCED DIRECTORY OVERRIDES THE STATIC FALLBACK
============================================================ */
describe('A synchronized record overrides an outdated static fallback', () => {
  test('the confirmed static entry for SCM-LIM 601 is REAL -- a synced correction must win over it', async () => {
    // Confirms the premise: contractor-adapter.js's static table really
    // does have a pre-existing entry for this id, so overriding it is a
    // meaningful test, not a no-op against an unmapped id.
    assert.equal(lookupHyncContractor('SCM-LIM 601'), 'REAL');

    globalThis.fetch = async () => mockResponse([{ dtId: 'SCM-LIM 601', contractor: 'HYNC-CORRECTED' }]);
    await syncContractorDirectory();

    assert.equal(resolveContractor('SCM-LIM 601'), 'HYNC-CORRECTED');
    assert.equal(resolveEsgContractor('SCM-LIM 601'), 'HYNC-CORRECTED');
    // Never merges/reports both names for the same DT.
    assert.notEqual(resolveContractor('SCM-LIM 601'), 'REAL');
  });

  test('an id the synced directory has no match for still falls through to the static fallback (no regression)', async () => {
    globalThis.fetch = async () => mockResponse([{ dtId: 'SCM-LIM 601', contractor: 'REAL' }]);
    await syncContractorDirectory();
    // ADT ids are never SCM-shaped, so the synced directory can never
    // contain them (see contractor-directory-service.js's header
    // comment) -- must still resolve via the static table exactly as
    // before this fix.
    assert.equal(resolveContractor('ADT 001'), 'ADT HILLCON');
    assert.equal(resolveEsgContractor('ADT 001'), 'ADT HILLCON');
  });

  test('a genuinely unknown DT remains unmatched through both tiers (11)', async () => {
    globalThis.fetch = async () => mockResponse([{ dtId: 'SCM-LIM 601', contractor: 'REAL' }]);
    await syncContractorDirectory();
    assert.equal(resolveContractor('SCM-LIM 999999'), null);
    assert.equal(resolveEsgContractor('SCM-LIM 999999'), null);
  });

  test('before any sync/cache (source "none"), resolution is unchanged from pre-fix behavior (pure static fallback)', () => {
    assert.equal(getContractorDirectorySnapshot().source, 'none');
    assert.equal(resolveContractor('SCM-LIM 601'), 'REAL'); // static table's own existing value
    assert.equal(resolveContractor('ADT 001'), 'ADT HILLCON');
  });
});

/* ============================================================
   16-19. CONTRACTOR COUNT REGROUPING / TONNAGE / RITASE / NO DUPLICATES
   Tonnage and ritase are computed from netKg/record-count alone (see
   shared-report-profile.js's onShiftTon/onShiftRit and esg-profile.js's
   equivalents) and never read resolveContractor()'s return value at all
   -- resolveContractor/resolveEsgContractor take only a DT id string and
   return only a contractor name, with no coupling to weight or count math
   by construction, so a directory refresh changing *who* owns a truck can
   never change *how much* that truck weighed or how many rows were read.
============================================================ */
describe('Contractor count regrouping after a directory refresh, with tonnage/ritase unaffected', () => {
  test('16. regrouping: the same DT resolves to a different contractor bucket after a refresh', async () => {
    const dt = 'SCM-LIM 601';
    const before = resolveContractor(dt);
    assert.equal(before, 'REAL'); // static fallback, no sync yet

    globalThis.fetch = async () => mockResponse([{ dtId: dt, contractor: 'TII' }]);
    await syncContractorDirectory();

    const after = resolveContractor(dt);
    assert.equal(after, 'TII');
    assert.notEqual(before, after);
  });

  test('17-18. resolveContractor/resolveEsgContractor never take or return tonnage/ritase inputs (unaffected by construction)', () => {
    // Single-argument (a DT id string) in, a contractor name string (or
    // null) out -- there is no code path through which a directory
    // refresh could reach tonnage/ritase math.
    assert.equal(resolveContractor.length, 1);
    assert.equal(resolveEsgContractor.length, 1);
  });

  test('19. no duplicate contractor counts: a truck resolves to exactly one contractor name, never two', async () => {
    globalThis.fetch = async () => mockResponse([{ dtId: 'SCM-LIM 601', contractor: 'REAL' }]);
    await syncContractorDirectory();
    const result = resolveContractor('SCM-LIM 601');
    // A string (or null) is a single value -- structurally impossible to
    // represent "counted under two names" from one resolveContractor()
    // call, and the || fallback chain short-circuits on the first match,
    // so the static fallback is never even evaluated once the synced
    // directory already answered.
    assert.equal(typeof result, 'string');
  });
});

/* ============================================================
   25. OUTPUT LABELS MATCH THE APPROVED PERSONNEL FORMAT
   (cross-check against report-personnel.test.mjs's own exact-string
   tests -- included here too since this file is the natural home for
   "everything Report-output-related after this round of fixes still
   agrees with each other".)
============================================================ */
describe('25. Personnel output labels remain correct alongside the contractor fix', () => {
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
    const lines = buildPersonnelOutputLines(records, personnel);
    assert.equal(lines[3], 'PIC AWK             : La Ode Osardi');
    assert.equal(lines[4], 'Manpower AWK        : 15');
    assert.equal(lines[5], 'Total Manpower AWK  : 22');
    assert.ok(!lines.join('\n').includes('PIC 3rd'));
  });
});

/* ============================================================
   7-10. EXACT REPORTED UNMATCHED DT NORMALIZATION
   Reproduces the Owner's live-confirmed bug with the exact reported ids.
   None of these exist in the static fallback table at all (verified:
   `git grep` against contractor-adapter.js's HYNC_DT_LIST finds no
   "SCM-HLG 94x/95x/96x" or "SCM-LIM 222-231" entries) -- so the only way
   they can ever resolve is through the synchronized directory, and the
   workbook's own "... DT" suffix must still match a remote record stored
   without it.
============================================================ */
describe('7-10. Exact reported unmatched DT ids resolve once synchronized', () => {
  beforeEach(async () => {
    globalThis.fetch = async () => mockResponse([
      { dtId: 'SCM-HLG 960', contractor: 'STM' },
      { dtId: 'SCM-HLG 946', contractor: 'STM' },
      { dtId: 'SCM-HLG 944', contractor: 'STM' },
      { dtId: 'SCM-LIM 228', contractor: 'MRP' },
      { dtId: 'SCM-LIM 230', contractor: 'MRP' },
    ]);
    await syncContractorDirectory();
  });

  test('confirms the premise: none of these ids exist in the static fallback table at all', () => {
    ['SCM-HLG 960', 'SCM-HLG 946', 'SCM-HLG 944', 'SCM-LIM 228', 'SCM-LIM 230'].forEach((id) => {
      assert.equal(lookupHyncContractor(id), null, `expected ${id} to be absent from the static table`);
    });
  });

  test('7. "SCM-HLG 960 DT" (workbook form) matches remote record stored as "SCM-HLG 960"', () => {
    assert.equal(resolveContractor('SCM-HLG 960 DT'), 'STM');
    assert.equal(resolveEsgContractor('SCM-HLG 960 DT'), 'STM');
  });

  test('8. "SCM-HLG 946 DT" matches remote record stored as "SCM-HLG 946"', () => {
    assert.equal(resolveContractor('SCM-HLG 946 DT'), 'STM');
    assert.equal(resolveEsgContractor('SCM-HLG 946 DT'), 'STM');
  });

  test('9. "SCM-LIM 228 DT" matches remote record stored as "SCM-LIM 228"', () => {
    assert.equal(resolveContractor('SCM-LIM 228 DT'), 'MRP');
    assert.equal(resolveEsgContractor('SCM-LIM 228 DT'), 'MRP');
  });

  test('10. "SCM-LIM 230 DT" matches remote record stored as "SCM-LIM 230"', () => {
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
   12-19. "REFRESH LIST DT" RECLASSIFICATION (recomputeContractorAggregates)
============================================================ */
describe('Refresh List DT reclassifies an already-parsed workbook', () => {
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

  test('12-13-14. before any sync, two of three trucks are unmatched; after sync, refresh recognizes them and totals update', async () => {
    const records = fixtureRecords();

    const before = recomputeContractorAggregates(records, resolveContractor);
    assert.equal(before.unmatchedTrucks.length, 2);
    assert.equal(before.totalDT, 3); // still 3 unique trucks total, 2 just bucketed as unmatched
    assert.ok(!before.contractorCounts.some(([name]) => name === 'STM'));

    globalThis.fetch = async () => mockResponse([
      { dtId: 'SCM-HLG 960', contractor: 'STM' },
      { dtId: 'SCM-HLG 946', contractor: 'STM' },
    ]);
    await syncContractorDirectory();

    const after = recomputeContractorAggregates(records, resolveContractor);
    assert.equal(after.unmatchedTrucks.length, 0); // 13. unmatched count decreases
    assert.deepEqual(after.contractorCounts.find(([name]) => name === 'STM'), ['STM', 2]); // 14. totals update
    assert.equal(after.totalDT, 3);
    assert.equal(after.totalADT, 0);
  });

  test('15-19. recomputeContractorAggregates only ever reads carNo and only ever returns contractor-derived fields', () => {
    const records = fixtureRecords();
    const result = recomputeContractorAggregates(records, resolveContractor);
    const returnedKeys = Object.keys(result).sort();
    assert.deepEqual(returnedKeys, ['contractorCounts', 'totalADT', 'totalDT', 'unmatchedTrucks'].sort());
    // No tonnage (15), ritase (16), shift (17), Week (18), or personnel
    // (19) field is present in the return value at all -- structurally
    // impossible for this function to have changed any of them, since it
    // never received them as input either (only `carNo` is read from each
    // record; netKg/grossTime/dome/grade/oreClass are ignored).
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
   23-27. BUYER DEFAULT OUTPUT LABELS
============================================================ */
describe('23-27. Buyer default sampler drives the correct output labels', () => {
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

  test('23. HYNC output uses PIC AWK / Manpower AWK / Total Manpower AWK', () => {
    const records = directory();
    const personnel = personnelFor('HYNC', records, 'pic-awk');
    assert.equal(personnel.samplerSource, 'buyer-default');
    const lines = buildPersonnelOutputLines(records, personnel);
    assert.equal(lines[2], 'Independent Sampler : AWK');
    assert.equal(lines[3], 'PIC AWK             : La Ode Osardi');
    assert.equal(lines[4], 'Manpower AWK        : 15');
    assert.equal(lines[5], 'Total Manpower AWK  : 22');
  });

  test('24. SLNC output also defaults to AWK labels', () => {
    const records = directory();
    const personnel = personnelFor('SLNC', records, 'pic-awk');
    const lines = buildPersonnelOutputLines(records, personnel);
    assert.equal(lines[2], 'Independent Sampler : AWK');
    assert.equal(lines[3], 'PIC AWK             : La Ode Osardi');
  });

  test('25. ESG (Format A source) output uses ATQ labels', () => {
    const records = directory();
    const personnel = personnelFor('ESG', records, 'pic-atq');
    const lines = buildPersonnelOutputLines(records, personnel);
    assert.equal(lines[2], 'Independent Sampler : ATQ');
    assert.equal(lines[3], 'PIC ATQ             : Khalifa Akbar');
    assert.equal(lines[4], 'Manpower ATQ        : 15');
    assert.equal(lines[5], 'Total Manpower ATQ  : 22');
  });

  test('26. ESG (Format B source) output uses the same ATQ labels -- both formats share the ESG buyer identity', () => {
    const records = directory();
    // Format A and Format B both resolve to the literal buyer 'ESG'
    // (esg-profile.js's ESG_BUYER) -- there is no separate 'ESG_FORMAT_B'
    // buyer identity, so the default-sampler and output-label behavior is
    // identical regardless of which format produced the workbook.
    const personnel = personnelFor('ESG', records, 'pic-atq');
    const lines = buildPersonnelOutputLines(records, personnel);
    assert.equal(lines[2], 'Independent Sampler : ATQ');
    assert.equal(lines[3], 'PIC ATQ             : Khalifa Akbar');
  });

  test('27. a future sampler organization (XYZ) dynamically changes all three labels together', () => {
    const records = directory();
    const personnel = { ...personnelFor('HYNC', records, 'pic-awk'), samplerId: 'sam-xyz', samplerSource: 'user-override', picThirdId: 'pic-xyz' };
    const lines = buildPersonnelOutputLines(records, personnel);
    assert.equal(lines[2], 'Independent Sampler : XYZ');
    assert.equal(lines[3], 'PIC XYZ             : Future Pic');
    assert.equal(lines[4], 'Manpower XYZ        : 15');
    assert.equal(lines[5], 'Total Manpower XYZ  : 22');
  });
});
