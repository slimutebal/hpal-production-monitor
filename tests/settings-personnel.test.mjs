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

import { buildRoleSummaryText, filterPersonnelBySearch } from '../js/pages/settings/settings-personnel.js';

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
