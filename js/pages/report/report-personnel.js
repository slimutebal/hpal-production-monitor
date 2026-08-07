// Report personnel selection logic (V2.3 Phase 4 -- controlled personnel
// selection). Pure, DOM-free functions only: every function here takes a
// personnel-directory records array (as produced by
// personnel-directory-service.js's getPersonnelDirectorySnapshot().records)
// and/or the Report `personnel` selection state (report-state.js) as plain
// arguments, and returns a plain value -- no localStorage, no fetch, no
// DOM access, so every function is independently unit-testable
// (tests/report-personnel.test.mjs) without mocking the browser.
//
// report-page.js owns all DOM rendering and event wiring; this module owns
// the buyer-default-sampler rule, PIC-3rd/organization filtering,
// selection validation, and the personnel section of the generated report
// text -- so those rules can be verified without touching the page's
// markup. Manpower <org> and Total Manpower are both manual operational
// numbers entered directly by the user (bug fix: Total Manpower used to be
// auto-calculated from selected SPV/FRM counts here -- that was wrong and
// has been removed; this module now only validates both values, it never
// derives either one).
import { t } from '../../i18n/i18n.js';

// Buyer -> default sampler organization (Owner-approved, not configurable
// at runtime). HYNC and SLNC both default to AWK; ESG (both workbook
// formats) defaults to ATQ. An unrecognized/unsupported buyer has no
// default -- the user must choose a sampler manually.
const BUYER_DEFAULT_SAMPLER_ORG = {
  HYNC: 'AWK',
  SLNC: 'AWK',
  ESG: 'ATQ',
};

export function getDefaultSamplerOrganization(buyerId) {
  return BUYER_DEFAULT_SAMPLER_ORG[buyerId] || null;
}

// Trimmed, whitespace-collapsed, case-folded comparison key -- the same
// normalization discipline personnel-directory-service.js's own
// normalizeCompareKey() already applies, duplicated here (not imported)
// because that function is private to the service module and this
// module must stay independent of the service's internal implementation
// details, only its public snapshot/records shape.
export function normalizeCompareKey(value) {
  return String(value ?? '').trim().replace(/\s+/g, ' ').toLowerCase();
}

function activeRecordsByRole(records, roleType) {
  return (records || []).filter((r) => r && r.role_type === roleType && r.active === true);
}

function findActiveById(records, id, roleType) {
  if (id == null) return null;
  const record = (records || []).find((r) => r && r.id === id);
  if (!record || record.active !== true) return null;
  if (roleType && record.role_type !== roleType) return null;
  return record;
}

// Deterministic sort: organization (case-insensitive) -> name
// (case-insensitive) -> id, matching personnel-directory-service.js's own
// compareRecords() ordering exactly, so Report's selector lists and its
// generated output both use the one documented ordering rule (never
// insertion-order-dependent on Set/Map iteration or manual click order).
export function compareRecords(a, b) {
  const orgCompare = normalizeCompareKey(a.organization).localeCompare(normalizeCompareKey(b.organization));
  if (orgCompare !== 0) return orgCompare;
  const nameCompare = normalizeCompareKey(a.name).localeCompare(normalizeCompareKey(b.name));
  if (nameCompare !== 0) return nameCompare;
  return String(a.id).localeCompare(String(b.id));
}

export function sortRecords(records) {
  return (records || []).slice().sort(compareRecords);
}

// Finds the single active SAMPLER record whose organization matches the
// buyer's default organization. Returns null when the buyer has no default
// organization, or when zero or more than one active SAMPLER record
// matches -- an ambiguous or missing default is never guessed, the user
// chooses manually in that case (task rule: "If exactly one valid match
// exists").
export function deriveDefaultSampler(records, buyerId) {
  const org = getDefaultSamplerOrganization(buyerId);
  if (!org) return null;
  const key = normalizeCompareKey(org);
  const matches = activeRecordsByRole(records, 'SAMPLER').filter((r) => normalizeCompareKey(r.organization) === key);
  return matches.length === 1 ? matches[0] : null;
}

// Clears a picThirdId whenever it no longer belongs to the given sampler's
// organization (including when there is no sampler at all, or the PIC
// itself is missing/inactive). Returns the id unchanged when it remains
// compatible, otherwise null -- used identically after a buyer-driven
// default-sampler change and after a manual user override, so both paths
// share one rule (task's five-step "when Independent Sampler changes"
// behavior, steps 1-2).
export function reconcilePicThirdId(records, samplerId, picThirdId) {
  if (picThirdId == null) return null;
  const sampler = findActiveById(records, samplerId, 'SAMPLER');
  const pic = findActiveById(records, picThirdId, 'PIC_3RD');
  if (!sampler || !pic) return null;
  return normalizeCompareKey(pic.organization) === normalizeCompareKey(sampler.organization) ? picThirdId : null;
}

// Applies the resolved buyer's default sampler to a personnel selection
// object, per the approved "simple behavior": every successful buyer
// change reapplies that buyer's default sampler unconditionally
// (samplerSource becomes 'buyer-default', even overriding an earlier user
// override -- the user can override again afterward), an incompatible PIC
// 3rd is cleared, and every other field (SPV/FRM ids, manpowerThirdParty)
// is preserved unchanged. Returns a new personnel object; never mutates
// its `personnel` argument.
export function applyBuyerDefaultSamplerToPersonnel(records, buyerId, personnel) {
  const defaultRecord = deriveDefaultSampler(records, buyerId);
  const samplerId = defaultRecord ? defaultRecord.id : null;
  const samplerSource = defaultRecord ? 'buyer-default' : null;
  return {
    ...personnel,
    samplerId,
    samplerSource,
    picThirdId: reconcilePicThirdId(records, samplerId, personnel.picThirdId),
  };
}

// Applies a manual user sampler selection to a personnel selection object
// -- samplerSource becomes 'user-override', and the same PIC-compatibility
// rule as the buyer-default path clears an incompatible PIC 3rd. Returns a
// new personnel object; never mutates its `personnel` argument.
export function overrideSampler(records, samplerId, personnel) {
  return {
    ...personnel,
    samplerId,
    samplerSource: 'user-override',
    picThirdId: reconcilePicThirdId(records, samplerId, personnel.picThirdId),
  };
}

// Resolves the Report `personnel` selection state's stored ids against a
// directory snapshot's records. An id that no longer resolves to an active
// record of the expected role is simply omitted (array fields) or comes
// back null (singular fields) -- this function never guesses a
// replacement; callers (validatePersonnelSelections, rendering) decide how
// to surface a stale id.
export function resolveSelectedPersonnel(records, personnel) {
  const spvScm = (personnel.spvScmIds || [])
    .map((id) => findActiveById(records, id, 'SPV_SCM'))
    .filter(Boolean);
  const frmScm = (personnel.frmScmIds || [])
    .map((id) => findActiveById(records, id, 'FRM_SCM'))
    .filter(Boolean);
  const sampler = findActiveById(records, personnel.samplerId, 'SAMPLER');
  const picThird = findActiveById(records, personnel.picThirdId, 'PIC_3RD');

  return { spvScm, frmScm, sampler, picThird };
}

// No valid Personnel Directory snapshot exists at all -- the one condition
// that blocks Report before any per-field selection check even applies.
// `source` is a personnel-directory-service.js snapshot's `source` field
// ('none' | 'cached' | 'remote').
export function getDirectoryAvailabilityError(source) {
  return source === 'none' ? t('report.personnel.directoryUnavailable') : null;
}

function isValidManpower(value) {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

// Selection-level validation, run only once a valid directory snapshot is
// confirmed present (see getDirectoryAvailabilityError). Trusts the
// records array as already validated by personnel-directory-service.js
// (Section boundary: Report never re-derives shape/uniqueness rules the
// service already owns) -- this only checks that the *selections* are
// complete, active, correctly-roled, and mutually consistent.
export function validatePersonnelSelections(records, personnel) {
  const errors = [];
  const resolved = resolveSelectedPersonnel(records, personnel);

  const spvIds = personnel.spvScmIds || [];
  const frmIds = personnel.frmScmIds || [];
  const staleSpv = spvIds.some((id) => !resolved.spvScm.some((r) => r.id === id));
  const staleFrm = frmIds.some((id) => !resolved.frmScm.some((r) => r.id === id));
  const staleSampler = personnel.samplerId != null && !resolved.sampler;
  const stalePic = personnel.picThirdId != null && !resolved.picThird;

  if (resolved.spvScm.length === 0) errors.push(t('report.personnel.selectSpvRequired'));
  if (resolved.frmScm.length === 0) errors.push(t('report.personnel.selectFrmRequired'));
  if (!resolved.sampler) errors.push(t('report.personnel.selectSamplerRequired'));

  const samplerOrg = resolved.sampler ? resolved.sampler.organization : null;

  if (!resolved.picThird) {
    errors.push(samplerOrg ? t('report.personnel.selectPicForOrg', { organization: samplerOrg }) : t('report.personnel.selectPicRequired'));
  } else if (normalizeCompareKey(resolved.picThird.organization) !== normalizeCompareKey(samplerOrg || '')) {
    // Covers both a genuine organization mismatch and a PIC selected while
    // no sampler is selected at all (samplerOrg null never matches any
    // real organization) -- either way the PIC selection cannot be
    // trusted as compatible yet.
    errors.push(samplerOrg
      ? t('report.personnel.picMismatchOrg', { organization: samplerOrg })
      : t('report.personnel.selectSamplerBeforePic'));
  }

  // Manpower <org> and Total Manpower are both manual, independent
  // operational records (bug fix: Total Manpower was previously derived
  // from selected SPV/FRM counts, which was wrong -- SPV/FRM selections
  // identify names only). Each is validated on its own; no relation
  // (e.g. totalManpower >= manpowerThirdParty) is enforced between them
  // unless separately approved.
  const manpowerOrgLabel = samplerOrg || 'Independent Sampler';
  if (!isValidManpower(personnel.manpowerThirdParty)) {
    errors.push(t('report.personnel.enterValidManpower', { organization: manpowerOrgLabel }));
  }
  if (!isValidManpower(personnel.totalManpower)) {
    errors.push(t('report.personnel.enterValidTotalManpower'));
  }

  if (staleSpv || staleFrm || staleSampler || stalePic) {
    errors.push(t('report.personnel.staleSelectionWarning'));
  }

  return errors;
}

// Exact literal column widths (label padded to this many characters before
// ": "), confirmed against the Owner-approved WhatsApp output examples.
// SPV SCM / FRM SCM / Independent Sampler are identical for every buyer;
// PIC/Manpower/Total Manpower <ORG> widths are wider for the EIEB (ATQ)
// template than the HYNC/SLNC (AWK) one -- these are literal, hand-tuned
// spacing values (not a single generic padEnd formula), so each width is
// spelled out explicitly rather than derived. Do not collapse these into
// one shared constant -- that would silently change the approved spacing.
const FIXED_LINE_WIDTH = {
  spvScm: 29,
  frmScm: 28,
  independentSampler: 20,
};

// Buyer -> {PIC <ORG>, Manpower <ORG>, Total Manpower <ORG>} column widths.
// HYNC and SLNC share one template; the internal ESG buyer (displayed as
// EIEB) uses its own wider PIC/Manpower columns. An unrecognized buyer
// falls back to the HYNC/SLNC widths -- report-page.js never calls this
// before a buyer is confirmed, so this is a defensive default only, never
// an expected path.
const ORG_LINE_WIDTH = {
  HYNC: { pic: 30, manpower: 23, totalManpower: 20 },
  SLNC: { pic: 30, manpower: 23, totalManpower: 20 },
  ESG: { pic: 31, manpower: 24, totalManpower: 20 },
};
const DEFAULT_ORG_LINE_WIDTH = ORG_LINE_WIDTH.HYNC;

function formatOutputLine(label, value, width) {
  return `${label.padEnd(width, ' ')}: ${value}`;
}

// Builds the approved personnel section output lines (Section "OUTPUT
// FORMAT" / "CORRECTED PERSONNEL OUTPUT LABELS"), resolving names live
// from the current directory snapshot -- never from cached plain strings
// in reportState. Multiple selected names are comma-separated in the
// deterministic sort order (organization, name, id -- same rule as the
// selector UI).
//
// Label fix: PIC / Manpower / Total Manpower labels all dynamically
// follow the selected Independent Sampler record's own `organization`
// field (never the buyer name, never hardcoded to only AWK/ATQ, never
// the literal "PIC 3rd" / "Manpower 3rd" / bare "Total Manpower", and
// never with explanatory parenthetical text) -- "PIC <ORG>",
// "Manpower <ORG>", "Total Manpower <ORG>". "Independent Sampler" itself
// is the one label that never changes.
// `buyer` ('HYNC' | 'SLNC' | 'ESG') selects which literal column-width
// template applies to the PIC/Manpower/Total Manpower lines (see
// ORG_LINE_WIDTH above) -- it never changes which names/values are
// resolved, only the fixed spacing of the generated lines.
export function buildPersonnelOutputLines(records, personnel, buyer) {
  const resolved = resolveSelectedPersonnel(records, personnel);
  const spvNames = sortRecords(resolved.spvScm).map((r) => r.name).join(', ');
  const frmNames = sortRecords(resolved.frmScm).map((r) => r.name).join(', ');
  const samplerOrg = resolved.sampler ? resolved.sampler.organization : '';
  const picName = resolved.picThird ? resolved.picThird.name : '';
  const manpowerThird = personnel.manpowerThirdParty != null ? personnel.manpowerThirdParty : '';
  // Total Manpower is the user's own manually entered value -- never
  // derived from spvScmIds/frmScmIds counts (earlier bug fix, unrelated
  // to this label fix).
  const total = personnel.totalManpower != null ? personnel.totalManpower : '';
  const orgWidths = ORG_LINE_WIDTH[buyer] || DEFAULT_ORG_LINE_WIDTH;

  return [
    formatOutputLine('SPV SCM', spvNames, FIXED_LINE_WIDTH.spvScm),
    formatOutputLine('FRM SCM', frmNames, FIXED_LINE_WIDTH.frmScm),
    formatOutputLine('Independent Sampler', samplerOrg, FIXED_LINE_WIDTH.independentSampler),
    formatOutputLine(`PIC ${samplerOrg}`.trim(), picName, orgWidths.pic),
    formatOutputLine(`Manpower ${samplerOrg}`.trim(), manpowerThird, orgWidths.manpower),
    formatOutputLine(`Total Manpower ${samplerOrg}`.trim(), total, orgWidths.totalManpower),
  ];
}

/* ============================================================
   COMPACT MULTI-SELECT SELECTOR (UI refinement -- SPV SCM / FRM SCM).
   Pure, DOM-free: report-page.js's modal wiring calls these to format the
   compact field summary and manage a "temporary selection" draft that
   only ever reaches reportState if/when the user presses OK. Independent
   Sampler and PIC 3rd are unaffected -- they keep their existing small
   radio-list UI, never routed through any of this.
============================================================ */

// Compact-field summary text for a SPV/FRM multi-select, given the
// selected records' display names in the same deterministic order the
// modal list itself renders (sortRecords). 0 -> a neutral placeholder;
// 1 -> the single name; 2 -> both names (the field's own CSS truncates
// with an ellipsis if they don't fit -- this function never measures
// pixel width); 3+ -> a compact count, which can never overflow.
//
// UI-DISPLAY ONLY -- unlike buildPersonnelOutputLines() below (the actual
// generated-report-text builder), this is never part of the WhatsApp
// report output, so it is safe to route through t() (V2.3
// full-localization pass). names themselves (personnel display names)
// are never translated, only the surrounding "Belum dipilih"/"{n}
// dipilih" wording.
export function buildPersonnelSelectionSummary(names) {
  if (!names || names.length === 0) return t('report.personnel.notSelected');
  if (names.length === 1) return names[0];
  if (names.length === 2) return names.join(', ');
  return t('report.personnelModal.selectedCount', { count: names.length });
}

// Case-insensitive, trimmed substring match against name only (Report's
// SPV/FRM modal search is deliberately name-focused -- organization is
// always the fixed 'SCM' constant for these two roles, so matching it
// would never usefully discriminate results). A blank/whitespace-only
// query returns every record unfiltered. Never touches active/selected
// state -- purely a display-visibility filter over the records array.
export function filterPersonnelByNameSearch(records, query) {
  const key = normalizeCompareKey(query);
  if (!key) return (records || []).slice();
  return (records || []).filter((r) => normalizeCompareKey(r.name).includes(key));
}

// Starts a multi-select "draft" from the ids currently stored in
// reportState -- a plain Set copy, never a reference to the original
// array, so mutating the draft can never affect reportState until
// commitMultiSelectDraft() is explicitly called with it.
export function createMultiSelectDraft(currentIds) {
  return { selectedIds: new Set(currentIds || []) };
}

// Returns a NEW draft with `id` present (checked) or absent (unchecked)
// -- never mutates the draft passed in, so a caller (or test) can compare
// before/after directly. Set-backed, so toggling the same id "checked"
// twice can never produce a duplicate.
export function toggleMultiSelectDraft(draft, id, checked) {
  const next = new Set(draft.selectedIds);
  if (checked) next.add(id);
  else next.delete(id);
  return { selectedIds: next };
}

// The ONLY function that turns a draft into a plain id array suitable for
// reportState.personnel.spvScmIds/frmScmIds -- called exclusively from
// the modal's OK handler. A draft that is discarded (Cancel, Escape,
// backdrop click) is simply never passed here, so reportState is
// mathematically guaranteed to stay untouched by anything that happened
// inside the modal unless OK was pressed.
export function commitMultiSelectDraft(draft) {
  return Array.from(draft.selectedIds);
}
