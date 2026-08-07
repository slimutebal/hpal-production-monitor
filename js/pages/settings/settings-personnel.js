// Settings personnel-directory pure/DOM-free helpers (UI refinement --
// summary-first main view + per-role management modal). Mirrors
// js/pages/report/report-personnel.js's pattern: no DOM, no localStorage,
// no fetch, so this is independently unit-testable
// (tests/settings-personnel.test.mjs) without mocking the browser.
// settings-page.js owns all DOM rendering/event wiring; this module owns
// the summary-text formatting and the search-filter rule for the
// management modal's personnel list.
//
// Deliberately NOT imported by report-page.js/report-personnel.js and
// vice versa -- each page directory owns its own small pure-logic module
// rather than the two pages depending on each other, matching this
// project's existing modularity (report-personnel.js's own
// normalizeCompareKey() is duplicated there rather than imported from a
// shared location, for the identical reason).

// "10 aktif" when there are no inactive records for this role, or
// "10 aktif · 2 nonaktif" once at least one exists -- never shows
// "0 nonaktif". Pure formatting only; `activeCount`/`inactiveCount` are
// whatever the caller already counted (e.g. via
// personnel-directory-service.js's getPersonnelByRole()).
export function buildRoleSummaryText(activeCount, inactiveCount) {
  return inactiveCount > 0 ? `${activeCount} aktif · ${inactiveCount} nonaktif` : `${activeCount} aktif`;
}

function normalizeSearchKey(value) {
  return String(value ?? '').trim().toLowerCase();
}

// Case-insensitive, trimmed substring match against name and (unless
// disabled) organization -- the management modal's PIC 3rd list benefits
// from matching organization too (e.g. searching "awk" to jump to that
// group), unlike Report's SPV/FRM-only modal search where organization is
// always the fixed 'SCM' constant and would never usefully discriminate.
// A blank/whitespace-only query returns every record unfiltered. Never
// touches active/inactive filtering or any write state -- purely a
// display-visibility filter over whatever records array the caller
// already filtered by role/status.
export function filterPersonnelBySearch(records, query, options = {}) {
  const key = normalizeSearchKey(query);
  if (!key) return (records || []).slice();
  const matchOrganization = options.matchOrganization !== false;
  return (records || []).filter((r) => {
    if (normalizeSearchKey(r.name).includes(key)) return true;
    if (matchOrganization && normalizeSearchKey(r.organization).includes(key)) return true;
    return false;
  });
}
