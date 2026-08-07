// Settings personnel pure-helper tests (UI refinement -- summary-first
// main view + management modal).
//
// Run with Node's built-in test runner:
//
//   node --test tests/settings-personnel.test.mjs
//
// Pure and DOM-free by design (settings-personnel.js never touches the
// DOM/localStorage/fetch) -- rendering (summary cards, the management
// modal's markup, Edit/Deactivate/Reactivate wiring) is deliberately left
// to the manual regression checklist, same as report-page.js's own
// rendering exclusion in tests/report-personnel.test.mjs.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildRoleSummaryText,
  filterPersonnelBySearch,
  buildOfflineIndicatorText,
  buildQueueCountText,
  buildQueueItemViewModel,
  OFFLINE_INDICATOR_MESSAGE,
  QUEUE_OFFLINE_SAVED_MESSAGE,
} from '../js/pages/settings/settings-personnel.js';

describe('buildRoleSummaryText() -- role summary card text (task items 2-3)', () => {
  test('2. active count only, no inactive records', () => {
    assert.equal(buildRoleSummaryText(3, 0), '3 aktif');
  });

  test('3. inactive count appears once at least one exists', () => {
    assert.equal(buildRoleSummaryText(10, 2), '10 aktif · 2 nonaktif');
  });

  test('zero active and zero inactive still renders cleanly', () => {
    assert.equal(buildRoleSummaryText(0, 0), '0 aktif');
  });

  test('never shows "0 nonaktif"', () => {
    assert.equal(buildRoleSummaryText(5, 0), '5 aktif');
    assert.doesNotMatch(buildRoleSummaryText(5, 0), /nonaktif/);
  });
});

describe('filterPersonnelBySearch() -- management modal search rule (task item 10)', () => {
  const records = [
    { id: 'frm-1', name: 'Adi Guna', organization: 'SCM' },
    { id: 'frm-2', name: 'Akmal', organization: 'SCM' },
    { id: 'pic-1', name: 'La Ode Osardi', organization: 'AWK' },
    { id: 'pic-2', name: 'Khalifa Akbar', organization: 'ATQ' },
  ];

  test('case-insensitive, trimmed, matches by name substring', () => {
    assert.deepEqual(filterPersonnelBySearch(records, '  ak  ').map((r) => r.id).sort(), ['frm-2', 'pic-2']);
  });

  test('matches by organization when matchOrganization is not disabled', () => {
    assert.deepEqual(filterPersonnelBySearch(records, 'awk').map((r) => r.id), ['pic-1']);
  });

  test('organization matching can be disabled (Report-style name-only search)', () => {
    assert.deepEqual(filterPersonnelBySearch(records, 'awk', { matchOrganization: false }), []);
  });

  test('blank/whitespace-only query returns every record unfiltered', () => {
    assert.equal(filterPersonnelBySearch(records, '').length, 4);
    assert.equal(filterPersonnelBySearch(records, '   ').length, 4);
  });

  test('no match returns an empty array, never throws', () => {
    assert.deepEqual(filterPersonnelBySearch(records, 'zzz-nomatch'), []);
  });

  test('search never mutates or reorders the input array', () => {
    const before = records.slice();
    filterPersonnelBySearch(records, 'ak');
    assert.deepEqual(records, before);
  });
});

/* ============================================================
   OFFLINE WRITE QUEUE display helpers (V2.3 Phase 5) -- pure/DOM-free,
   same testing posture as the rest of this file.
============================================================ */
describe('buildOfflineIndicatorText() -- compact offline indicator', () => {
  test('online: no indicator text', () => {
    assert.equal(buildOfflineIndicatorText(true), null);
  });

  test('offline: returns the exact required literal', () => {
    assert.equal(buildOfflineIndicatorText(false), OFFLINE_INDICATOR_MESSAGE);
    assert.equal(buildOfflineIndicatorText(false), 'Offline — perubahan akan diantrikan.');
  });
});

describe('QUEUE_OFFLINE_SAVED_MESSAGE -- exact required literal', () => {
  test('matches the required Indonesian text exactly', () => {
    assert.equal(QUEUE_OFFLINE_SAVED_MESSAGE, 'Perubahan disimpan sebagai antrean offline dan akan dikirim saat koneksi kembali.');
  });
});

describe('buildQueueCountText() -- Pending Changes summary text', () => {
  test('zero pending and zero blocked', () => {
    assert.equal(buildQueueCountText(0, 0), '0 pending');
  });

  test('pending only, never mentions blocked when there are none', () => {
    assert.equal(buildQueueCountText(3, 0), '3 pending');
    assert.doesNotMatch(buildQueueCountText(3, 0), /blocked/);
  });

  test('pending and blocked mixed', () => {
    assert.equal(buildQueueCountText(2, 1), '2 pending · 1 blocked');
  });

  test('blocked only (nothing left pending)', () => {
    assert.equal(buildQueueCountText(0, 1), '0 pending · 1 blocked');
  });
});

describe('buildQueueItemViewModel() -- queue review modal row data', () => {
  function makeQueueItem(overrides = {}) {
    return {
      queueId: 'q-1',
      action: 'addReportPersonnel',
      payload: {},
      createdAt: '2026-08-07T01:00:00.000Z',
      attemptCount: 0,
      lastAttemptAt: null,
      lastError: null,
      lastErrorCode: null,
      status: 'pending',
      ...overrides,
    };
  }

  test('addReportPersonnel: action label "Tambah", name/organization/role from payload', () => {
    const item = makeQueueItem({ payload: { role_type: 'SPV_SCM', name: 'Budi', organization: 'SCM' } });
    const vm = buildQueueItemViewModel(item);
    assert.equal(vm.actionLabel, 'Tambah');
    assert.equal(vm.name, 'Budi');
    assert.equal(vm.organization, 'SCM');
    assert.equal(vm.roleType, 'SPV_SCM');
    assert.equal(vm.statusText, 'Pending');
    assert.equal(vm.canRetry, false);
  });

  test('updateReportPersonnel: action label "Edit", name/organization from payload (new values)', () => {
    const item = makeQueueItem({
      action: 'updateReportPersonnel',
      payload: { id: 'frm-1', name: 'Novelesto', organization: 'SCM', expected_version: 3 },
    });
    const vm = buildQueueItemViewModel(item);
    assert.equal(vm.actionLabel, 'Edit');
    assert.equal(vm.name, 'Novelesto');
  });

  test('setReportPersonnelActive(active:false): action label "Nonaktifkan", name resolved from current directory records', () => {
    const item = makeQueueItem({
      action: 'setReportPersonnelActive',
      payload: { id: 'frm-1', active: false, expected_version: 3 },
    });
    const records = [{ id: 'frm-1', name: 'Fandy', organization: 'SCM', role_type: 'FRM_SCM' }];
    const vm = buildQueueItemViewModel(item, records);
    assert.equal(vm.actionLabel, 'Nonaktifkan');
    assert.equal(vm.name, 'Fandy');
    assert.equal(vm.organization, 'SCM');
  });

  test('setReportPersonnelActive(active:true): action label "Aktifkan"', () => {
    const item = makeQueueItem({
      action: 'setReportPersonnelActive',
      payload: { id: 'frm-1', active: true, expected_version: 3 },
    });
    assert.equal(buildQueueItemViewModel(item, []).actionLabel, 'Aktifkan');
  });

  test('setReportPersonnelActive with no matching directory record still degrades safely (shows the raw id, never throws)', () => {
    const item = makeQueueItem({
      action: 'setReportPersonnelActive',
      payload: { id: 'unknown-id', active: false, expected_version: 3 },
    });
    assert.doesNotThrow(() => {
      const vm = buildQueueItemViewModel(item, []);
      assert.equal(vm.name, 'unknown-id');
    });
  });

  test('blocked VERSION_CONFLICT item: status text matches the QUEUE DISPLAY EXAMPLES wording', () => {
    const item = makeQueueItem({
      action: 'setReportPersonnelActive',
      payload: { id: 'frm-1', active: false, expected_version: 3 },
      status: 'blocked',
      lastErrorCode: 'VERSION_CONFLICT',
      lastError: 'stale',
    });
    const vm = buildQueueItemViewModel(item, [{ id: 'frm-1', name: 'Fandy', organization: 'SCM', role_type: 'FRM_SCM' }]);
    assert.equal(vm.statusText, 'Blocked: version conflict');
    assert.equal(vm.canRetry, true);
  });

  test('blocked DUPLICATE_PERSONNEL item: distinct status text from VERSION_CONFLICT', () => {
    const item = makeQueueItem({ status: 'blocked', lastErrorCode: 'DUPLICATE_PERSONNEL', lastError: 'exists' });
    const vm = buildQueueItemViewModel(item, []);
    assert.notEqual(vm.statusText, 'Blocked: version conflict');
    assert.match(vm.statusText, /^Blocked:/);
  });

  test('a pending item never claims retry is available', () => {
    const item = makeQueueItem({ status: 'pending' });
    assert.equal(buildQueueItemViewModel(item, []).canRetry, false);
  });
});
