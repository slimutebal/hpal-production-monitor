/**
 * HPAL Production Monitor -- report_personnel Google Apps Script Web App
 * ------------------------------------------------------------------------
 * PROPOSED ADDITION -- V2.3 Phase 4, "Personnel Directory Online Write
 * Management". See docs/V2.3_AUTO_WEEK_AND_PERSONNEL_DIRECTORY_ARCHITECTURE.md
 * sections 16-18 for the approved data model and write contract this file
 * implements.
 *
 * THIS FILE IS NOT DEPLOYED FROM THIS REPOSITORY. The actual Google Apps
 * Script project is owned and deployed by the Owner outside of GitHub
 * (architecture doc section 7.4 / section 29 decision #9) -- this repo has
 * no access to it and cannot run `clasp push` or otherwise ship it. This
 * file is a proposed patch: copy the pieces below into the existing
 * Code.gs project bound to the `report_personnel` Google Sheet and merge,
 * do not blindly overwrite -- the existing `doGet`/`listReportPersonnel`
 * read action is inferred here from the client's read contract
 * (js/services/personnel-directory-service.js's `performSync()` and
 * tests/personnel-directory-service.test.mjs's fixtures), not from this
 * file, since this repository has never contained the real read-side
 * source. Reconcile field names/behavior against the real deployed script
 * before merging.
 *
 * WHAT IS ACTUALLY NEW HERE (the deliverable of this phase):
 *   - doPost dispatcher for three write actions: addReportPersonnel,
 *     updateReportPersonnel, setReportPersonnelActive.
 *   - A small, additive extension to the existing read action: an
 *     `includeInactive` request parameter, so Settings can show
 *     deactivated personnel (task requirement) without changing the
 *     default (omitted/false) behavior any other existing caller relies
 *     on.
 *
 * TRANSPORT: doPost only, `Content-Type: text/plain;charset=utf-8` on the
 * client side (see personnel-directory-service.js) -- this is the same
 * "JSON string body inside a text/plain POST" trick contractor-
 * assignment.js's `appendListDt` action already uses in this project, and
 * it is intentional: it keeps the request a CORS "simple request" so the
 * browser never issues a preflight OPTIONS call against this endpoint,
 * which Apps Script Web Apps do not answer usefully. Do not switch this
 * to `application/json` without re-verifying preflight behavior end to
 * end.
 *
 * CONCURRENCY: every write path takes the script lock for the duration of
 * its read-modify-write against the sheet, so two near-simultaneous
 * requests can't both read the same `version` and both "succeed".
 *
 * AUDIT LABEL: `updated_by` is never authenticated identity -- there are
 * no user accounts anywhere in this application (architecture doc section
 * 6, non-goals). The client always sends the fixed literal
 * "OWNER_WEB_APP" so a row's `updated_by` column at least distinguishes
 * "written by this web app" from a manual spreadsheet edit. Do not treat
 * it as proof of who performed the action.
 *
 * WRITE VERIFICATION (added after a live incident): a write is never
 * reported as `ok: true` on the strength of the write call itself. Every
 * write action calls SpreadsheetApp.flush() after mutating the sheet, then
 * re-reads the affected row BY ID (never by a row index captured before
 * the write) and compares every physically-written field against what was
 * intended. A mismatch returns WRITE_VERIFICATION_FAILED instead of a
 * false ok:true -- see verifyRowMatches() and its three call sites in
 * addReportPersonnel/updateReportPersonnel/setReportPersonnelActive below.
 * This is the server-side half of the fix; personnel-directory-service.js
 * independently re-verifies the same mutation client-side against a fresh
 * GET, so a false success cannot occur even if this server-side check is
 * ever bypassed by a future edit.
 *
 * LOGICAL ROW POSITION, NOT sheet.getLastRow() (added after a third live
 * incident): the Owner's real report_personnel sheet has checkbox/data-
 * validation formatting applied down to roughly row 1000 in column E
 * (active). Google Sheets sets a checkbox-validated empty cell's actual
 * value to FALSE as soon as the validation is applied -- not only once a
 * human clicks it -- which makes sheet.getLastRow() (and therefore
 * sheet.appendRow(), which inserts immediately after whatever
 * getLastRow() reports) treat row ~1000 as the last row with content,
 * even though the real personnel data ends at row 18. New records were
 * landing at row ~1001+ instead of row 19, scattering the table instead
 * of growing it contiguously. The fix: every read and every insertion
 * goes through isPersonnelRowBlank_() / getLogicalPersonnelRows_() /
 * findFirstAvailablePersonnelRow_() below, which treat a row whose only
 * non-empty cell is a FALSE checkbox as logically blank -- never
 * sheet.getLastRow() + 1, never sheet.appendRow(). compactPersonnelTable()
 * (OWNER-MANUAL only, never called from doGet/doPost) lets the Owner move
 * existing stranded records back into a contiguous block after auditing
 * them with auditPersonnelTable().
 */

/* ============================================================
   CONSTANTS
============================================================ */

var SHEET_NAME = 'report_personnel';
var API_VERSION = '1.0.0';
var SCHEMA_VERSION = 1;

var ROLE_TYPES = ['SPV_SCM', 'FRM_SCM', 'SAMPLER', 'PIC_3RD'];
var SCM_ONLY_ROLES = ['SPV_SCM', 'FRM_SCM'];

// Column order as already established by the read side (architecture doc
// section 16.3's row model) -- do not reorder without also updating every
// COL_* index below.
var COLUMNS = ['id', 'role_type', 'name', 'organization', 'active', 'created_at', 'updated_at', 'updated_by', 'version'];
var COL_ID = 0, COL_ROLE_TYPE = 1, COL_NAME = 2, COL_ORGANIZATION = 3, COL_ACTIVE = 4,
    COL_CREATED_AT = 5, COL_UPDATED_AT = 6, COL_UPDATED_BY = 7, COL_VERSION = 8;

/* ============================================================
   ENTRY POINTS
============================================================ */

function doGet(e) {
  var action = e && e.parameter ? e.parameter.action : null;
  if (action === 'listReportPersonnel') return listReportPersonnel(e);
  return jsonResponse({ ok: false, error: { code: 'UNKNOWN_ACTION', message: 'Unknown action: ' + action } });
}

function doPost(e) {
  var body;
  try {
    body = JSON.parse(e.postData.contents);
  } catch (err) {
    return jsonResponse({ ok: false, error: { code: 'INVALID_JSON', message: 'Request body was not valid JSON.' } });
  }
  if (!body || typeof body !== 'object') {
    return jsonResponse({ ok: false, error: { code: 'INVALID_JSON', message: 'Request body was not a JSON object.' } });
  }

  var lock = LockService.getScriptLock();
  var gotLock = false;
  try {
    gotLock = lock.tryLock(10000);
  } catch (err) {
    gotLock = false;
  }
  if (!gotLock) {
    return jsonResponse({ ok: false, error: { code: 'LOCK_TIMEOUT', message: 'Server is busy, please try again.' } });
  }

  try {
    switch (body.action) {
      case 'addReportPersonnel': return addReportPersonnel(body);
      case 'updateReportPersonnel': return updateReportPersonnel(body);
      case 'setReportPersonnelActive': return setReportPersonnelActive(body);
      default:
        return jsonResponse({ ok: false, error: { code: 'UNKNOWN_ACTION', message: 'Unknown action: ' + body.action } });
    }
  } finally {
    lock.releaseLock();
  }
}

/* ============================================================
   READ ACTION
   CRITICAL INVARIANT (added after a live incident: a clean localStorage
   + fresh Sync still returned a personnel record -- "Arif Danang" -- that
   did not physically exist anywhere in the report_personnel sheet, while
   writes were independently confirmed to reach the correct sheet, e.g.
   Illofi's version incrementing to 2. That means listReportPersonnel's
   result set must NEVER be built from anything other than the sheet's
   own physical cells at the moment of the request):
     - No CacheService (script/document/user cache).
     - No PropertiesService (script/document/user properties).
     - No merge with any hardcoded/default/seed/fixture array.
     - No second spreadsheet -- getPersonnelSheet() is the ONLY sheet
       resolver in this file, shared by this action and all three write
       actions below, so read and write can never silently diverge.
   readAllRecords() below reads the physical range directly
   (sheet.getRange(2, 1, lastRow-1, COLUMNS.length).getValues()) every
   single call -- there is no memoization, no caching layer, and no
   fallback data source anywhere in this file.
============================================================ */

function listReportPersonnel(e) {
  var includeInactive = !!(e && e.parameter && e.parameter.includeInactive === 'true');
  var sheet = getPersonnelSheet();
  if (!sheet) return jsonResponse(sheetNotFoundError());
  var all = readAllRecords(sheet);

  var records = includeInactive ? all : all.filter(function (r) { return r.active === true; });

  var counts = { returned: records.length, totalActive: 0, totalInactive: 0, byRole: {} };
  all.forEach(function (r) {
    if (r.active) counts.totalActive += 1; else counts.totalInactive += 1;
  });
  records.forEach(function (r) {
    counts.byRole[r.role_type] = (counts.byRole[r.role_type] || 0) + 1;
  });

  // Safe diagnostics only: spreadsheet/tab identity and row counts, never
  // the personnel dataset itself -- lets the Owner compare this against
  // the equivalent log line each write action emits (see
  // logPersonnelSheetAccess_ below) to directly confirm GET and POST are
  // hitting the exact same physical spreadsheet and tab.
  logPersonnelSheetAccess_('listReportPersonnel', sheet, { returned: records.length });

  return jsonResponse({
    ok: true,
    action: 'listReportPersonnel',
    apiVersion: API_VERSION,
    schemaVersion: SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    filters: { role_type: null, organization: null, includeInactive: includeInactive },
    counts: counts,
    records: records,
  });
}

/* ============================================================
   WRITE ACTION A -- addReportPersonnel
============================================================ */

function addReportPersonnel(body) {
  var roleType = body.role_type;
  var name = trimString(body.name);
  var organization = trimString(body.organization);
  var updatedBy = trimString(body.updated_by);

  if (body.expected_schema_version !== SCHEMA_VERSION) {
    return jsonResponse(validationError('Unsupported expected_schema_version.'));
  }
  var fieldError = validatePersonnelFields(roleType, name, organization, updatedBy);
  if (fieldError) return jsonResponse(fieldError);

  // SPV_SCM/FRM_SCM organization is fixed regardless of what was sent --
  // this mirrors the client's own fixed-organization UI rule server-side,
  // so a modified/DevTools request can't create an SPV/FRM record with a
  // non-SCM organization.
  if (SCM_ONLY_ROLES.indexOf(roleType) !== -1) organization = 'SCM';

  var sheet = getPersonnelSheet();
  if (!sheet) return jsonResponse(sheetNotFoundError());
  var all = readAllRecords(sheet);

  var duplicate = findActiveDuplicate(all, roleType, name, organization, null);
  if (duplicate) return jsonResponse(duplicatePersonnelError(duplicate));

  var id = generatePersonnelId(roleType, name, all.map(function (r) { return r.id; }));
  var now = new Date().toISOString();
  var record = {
    id: id,
    role_type: roleType,
    name: name,
    organization: organization,
    active: true,
    created_at: now,
    updated_at: now,
    updated_by: updatedBy,
    version: 1,
  };

  // Deliberately NOT the sheet's built-in single-call insertion helper
  // and NOT arithmetic on its reported last-content row -- both are
  // fooled by FALSE-checkbox/data-validation formatting extending far
  // past the real data (see the file header's "LOGICAL ROW POSITION"
  // note). The first logically blank row is found explicitly instead and
  // written to directly (regression-guarded by
  // testAddReportPersonnel_DoesNotUseAppendRow/
  // _DoesNotUseLastRowPlusOne below, which inspect this function's own
  // source -- so this comment must never spell out either literal
  // pattern itself, or it would defeat that guard).
  var targetRow = findFirstAvailablePersonnelRow_(sheet);
  sheet.getRange(targetRow, 1, 1, COLUMNS.length).setValues([buildRowArray(record)]);
  SpreadsheetApp.flush();

  // Physically read the row back BY ID (never trust the write call alone,
  // never assume it landed on targetRow -- re-finding by id is the actual
  // proof) and confirm every field matches what we intended to write.
  // This is the fix for the live incident where a write returned ok:true
  // but the Sheet was never actually mutated.
  var verifyFound = findRowById(sheet, id);
  if (!verifyFound || !verifyRowMatches(verifyFound.record, record)) {
    return jsonResponse(writeVerificationFailedError());
  }

  logPersonnelSheetAccess_('addReportPersonnel', sheet, { writtenId: id, version: record.version, insertedRow: targetRow });

  return jsonResponse({ ok: true, action: 'addReportPersonnel', apiVersion: API_VERSION, schemaVersion: SCHEMA_VERSION, record: record });
}

/* ============================================================
   WRITE ACTION B -- updateReportPersonnel
   role_type and id are immutable; active is unchanged by this action.
============================================================ */

function updateReportPersonnel(body) {
  var id = trimString(body.id);
  var name = trimString(body.name);
  var organization = trimString(body.organization);
  var updatedBy = trimString(body.updated_by);
  var expectedVersion = body.expected_version;

  if (!isNonEmptyString(id)) return jsonResponse(validationError('id is required.'));
  if (!isPositiveInteger(expectedVersion)) return jsonResponse(validationError('expected_version must be a positive integer.'));

  var sheet = getPersonnelSheet();
  if (!sheet) return jsonResponse(sheetNotFoundError());
  var found = findRowById(sheet, id);
  if (!found) return jsonResponse({ ok: false, error: { code: 'NOT_FOUND', message: 'No personnel record with id "' + id + '".' } });

  var existing = found.record;
  var fieldError = validatePersonnelFields(existing.role_type, name, organization, updatedBy);
  if (fieldError) return jsonResponse(fieldError);

  // role_type is immutable -- organization is re-derived from the
  // EXISTING role_type, never from any role_type the client might send.
  if (SCM_ONLY_ROLES.indexOf(existing.role_type) !== -1) organization = 'SCM';

  if (existing.version !== expectedVersion) {
    return jsonResponse(versionConflictError(existing.version));
  }

  var all = readAllRecords(sheet);
  var duplicate = findActiveDuplicate(all, existing.role_type, name, organization, id);
  if (duplicate) return jsonResponse(duplicatePersonnelError(duplicate));

  var now = new Date().toISOString();
  var record = {
    id: existing.id,
    role_type: existing.role_type,
    name: name,
    organization: organization,
    active: existing.active,
    created_at: existing.created_at,
    updated_at: now,
    updated_by: updatedBy,
    version: existing.version + 1,
  };

  writeRecordToRow(sheet, found.rowIndex, record);
  SpreadsheetApp.flush();

  var verifyFound = findRowById(sheet, id);
  if (!verifyFound || !verifyRowMatches(verifyFound.record, record)) {
    return jsonResponse(writeVerificationFailedError());
  }

  logPersonnelSheetAccess_('updateReportPersonnel', sheet, { writtenId: id, version: record.version });

  return jsonResponse({ ok: true, action: 'updateReportPersonnel', apiVersion: API_VERSION, schemaVersion: SCHEMA_VERSION, record: record });
}

/* ============================================================
   WRITE ACTION C -- setReportPersonnelActive
============================================================ */

function setReportPersonnelActive(body) {
  var id = trimString(body.id);
  var active = body.active;
  var updatedBy = trimString(body.updated_by);
  var expectedVersion = body.expected_version;

  if (!isNonEmptyString(id)) return jsonResponse(validationError('id is required.'));
  if (typeof active !== 'boolean') return jsonResponse(validationError('active must be boolean.'));
  if (!isNonEmptyString(updatedBy)) return jsonResponse(validationError('updated_by is required.'));
  if (!isPositiveInteger(expectedVersion)) return jsonResponse(validationError('expected_version must be a positive integer.'));

  var sheet = getPersonnelSheet();
  if (!sheet) return jsonResponse(sheetNotFoundError());
  var found = findRowById(sheet, id);
  if (!found) return jsonResponse({ ok: false, error: { code: 'NOT_FOUND', message: 'No personnel record with id "' + id + '".' } });

  var existing = found.record;
  if (existing.version !== expectedVersion) {
    return jsonResponse(versionConflictError(existing.version));
  }

  // Reactivation (false -> true) can resurrect a logical duplicate of an
  // active record created/renamed while this one was inactive -- checked
  // the same way a new add is checked. Deactivation never needs this
  // check (making a record inactive can never create a duplicate).
  if (active === true) {
    var all = readAllRecords(sheet);
    var duplicate = findActiveDuplicate(all, existing.role_type, existing.name, existing.organization, id);
    if (duplicate) return jsonResponse(duplicatePersonnelError(duplicate));
  }

  var now = new Date().toISOString();
  var record = {
    id: existing.id,
    role_type: existing.role_type,
    name: existing.name,
    organization: existing.organization,
    active: active,
    created_at: existing.created_at,
    updated_at: now,
    updated_by: updatedBy,
    version: existing.version + 1,
  };

  writeRecordToRow(sheet, found.rowIndex, record);
  SpreadsheetApp.flush();

  var verifyFound = findRowById(sheet, id);
  if (!verifyFound || !verifyRowMatches(verifyFound.record, record)) {
    return jsonResponse(writeVerificationFailedError());
  }

  logPersonnelSheetAccess_('setReportPersonnelActive', sheet, { writtenId: id, version: record.version });

  return jsonResponse({ ok: true, action: 'setReportPersonnelActive', apiVersion: API_VERSION, schemaVersion: SCHEMA_VERSION, record: record });
}

/* ============================================================
   VALIDATION HELPERS
============================================================ */

function validatePersonnelFields(roleType, name, organization, updatedBy) {
  if (ROLE_TYPES.indexOf(roleType) === -1) return validationError('Unsupported role_type: ' + roleType);
  if (!isNonEmptyString(name)) return validationError('name is required.');
  if (!isNonEmptyString(organization)) return validationError('organization is required.');
  if (!isNonEmptyString(updatedBy)) return validationError('updated_by is required.');
  if (SCM_ONLY_ROLES.indexOf(roleType) !== -1 && organization !== 'SCM') {
    return validationError(roleType + ' organization must be SCM.');
  }
  return null;
}

function validationError(message) {
  return { ok: false, error: { code: 'VALIDATION_ERROR', message: message } };
}

function versionConflictError(currentVersion) {
  return {
    ok: false,
    error: {
      code: 'VERSION_CONFLICT',
      message: 'Data sudah berubah di server. Sinkronkan ulang sebelum mencoba lagi.',
      currentVersion: currentVersion,
    },
  };
}

function duplicatePersonnelError(duplicateRecord) {
  return {
    ok: false,
    error: {
      code: 'DUPLICATE_PERSONNEL',
      message: 'An active personnel record already exists for this role/name/organization.',
      conflictingId: duplicateRecord.id,
    },
  };
}

// Section 16.3's per-role uniqueness key, checked against ACTIVE records
// only (task's "SERVER VALIDATION" section: "same active role_type +
// normalized name + normalized organization"), excluding `excludeId` (the
// record being updated/reactivated itself, so it never conflicts with its
// own prior row).
function findActiveDuplicate(allRecords, roleType, name, organization, excludeId) {
  var nameKey = normalizeCompareKey(name);
  var orgKey = normalizeCompareKey(organization);

  return allRecords.filter(function (r) {
    if (r.id === excludeId) return false;
    if (r.active !== true) return false;
    if (r.role_type !== roleType) return false;

    if (roleType === 'SAMPLER') return normalizeCompareKey(r.organization) === orgKey;
    if (roleType === 'PIC_3RD') return normalizeCompareKey(r.name) === nameKey && normalizeCompareKey(r.organization) === orgKey;
    // SPV_SCM / FRM_SCM
    return normalizeCompareKey(r.name) === nameKey;
  })[0] || null;
}

/* ============================================================
   ID GENERATION -- role slug + normalized name, with a numeric collision
   suffix. Deterministic-safe (same input -> same first-choice id) but
   guaranteed unique against every id (active or inactive) already in the
   sheet, so a reactivated/renamed record can never collide with a
   generated id from this rule either.
============================================================ */

var ROLE_SLUG = { SPV_SCM: 'spv-scm', FRM_SCM: 'frm-scm', SAMPLER: 'sampler', PIC_3RD: 'pic-3rd' };

function generatePersonnelId(roleType, name, existingIds) {
  var slug = ROLE_SLUG[roleType] || roleType.toLowerCase();
  var nameSlug = String(name)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'unnamed';

  var base = slug + '-' + nameSlug;
  var existing = {};
  existingIds.forEach(function (id) { existing[id] = true; });

  if (!existing[base]) return base;
  var suffix = 2;
  while (existing[base + '-' + suffix]) suffix += 1;
  return base + '-' + suffix;
}

/* ============================================================
   SHEET ACCESS
============================================================ */

// Resolves the bound spreadsheet's `report_personnel` tab explicitly --
// never falls back to creating a new sheet, and never guesses a different
// tab. Returns null (never throws) so every call site can return a
// structured SHEET_NOT_FOUND JSON error instead of Apps Script's generic
// unhandled-exception response, which the frontend cannot parse as a
// structured { ok:false, error } shape.
//
// If this project is later switched to SpreadsheetApp.openById(id) instead
// of getActiveSpreadsheet() (e.g. the Web App is deployed from a script
// that is not itself bound to the Sheet), verify `id` resolves to the
// actual "HPAL Production Monitor - Personnel Directory" spreadsheet --
// never log or expose that id anywhere the UI can read it (jsonResponse()
// below never includes it, and it must stay that way).
function getPersonnelSheet() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  if (!ss) return null;
  return ss.getSheetByName(SHEET_NAME) || null;
}

function sheetNotFoundError() {
  return { ok: false, error: { code: 'SHEET_NOT_FOUND', message: 'Sheet tab "' + SHEET_NAME + '" was not found in the bound spreadsheet.' } };
}

// Parses one raw sheet row (COLUMNS order) into a plain record object.
function parseRow(row) {
  return {
    id: String(row[COL_ID]),
    role_type: String(row[COL_ROLE_TYPE]),
    name: String(row[COL_NAME]),
    organization: String(row[COL_ORGANIZATION]),
    active: row[COL_ACTIVE] === true || row[COL_ACTIVE] === 'true' || row[COL_ACTIVE] === 'TRUE',
    created_at: toIsoString(row[COL_CREATED_AT]),
    updated_at: toIsoString(row[COL_UPDATED_AT]),
    updated_by: String(row[COL_UPDATED_BY]),
    version: Number(row[COL_VERSION]),
  };
}

/* ============================================================
   LOGICAL ROW POSITION -- see the file header's "LOGICAL ROW POSITION"
   note. sheet.getLastRow() alone cannot be trusted to mean "the row after
   the real data" on a sheet with checkbox/data-validation formatting
   applied past the real rows (Google Sheets sets those cells' value to
   FALSE the moment the validation is applied, which getLastRow() counts
   as content). Every read and every insertion goes through the three
   functions below -- there is no other code path in this file that
   decides what counts as a real personnel row or where a new one goes.
============================================================ */

// Canonical definition of "this row has no real personnel data" -- a row
// is blank only if EVERY cell is '', null, undefined, or the boolean
// false (a FALSE checkbox with nothing else ever entered). A row with a
// real id/name/etc. is never blank regardless of its active value (a
// genuine inactive record is fully populated, just deactivated) -- and a
// row whose ONLY non-empty cell is active=true is deliberately NOT
// treated as blank either (see testIsPersonnelRowBlank_TrueCheckboxOnly),
// since that combination should never occur from this file's own write
// paths and is worth surfacing via auditPersonnelTable() rather than
// silently discarding.
function isPersonnelRowBlank_(row) {
  return row.every(function (cell) {
    return (
      cell === '' ||
      cell === null ||
      typeof cell === 'undefined' ||
      cell === false
    );
  });
}

// Reads the sheet's physical A:I range (row 2 through getLastRow()) and
// returns only the rows that are NOT blank per isPersonnelRowBlank_() --
// i.e. every genuine personnel row, wherever it physically sits,
// including one stranded far past a checkbox-padding gap. Returns
// `[{ rowNumber, values }]`; `rowNumber` is the real 1-based sheet row.
// This is the single function every read and write path below goes
// through to decide "what personnel data actually exists" -- no other
// function in this file re-reads the sheet independently.
function getLogicalPersonnelRows_(sheet) {
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];

  var values = sheet.getRange(2, 1, lastRow - 1, COLUMNS.length).getValues();
  var logicalRows = [];
  for (var i = 0; i < values.length; i += 1) {
    if (isPersonnelRowBlank_(values[i])) continue;
    logicalRows.push({ rowNumber: i + 2, values: values[i] });
  }
  return logicalRows;
}

// Scans from row 2 downward and returns the physical row number of the
// FIRST logically blank row -- this is where a new personnel record must
// be written. Never sheet.appendRow(), never sheet.getLastRow() + 1: both
// are fooled by FALSE-checkbox padding and would insert far past the real
// data (the exact live incident this function fixes). If every row
// through getLastRow() is logically populated (no gap at all -- an
// unusual but valid state), the next row immediately after getLastRow()
// is used, since there is no padding to reclaim.
function findFirstAvailablePersonnelRow_(sheet) {
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return 2;

  var values = sheet.getRange(2, 1, lastRow - 1, COLUMNS.length).getValues();
  for (var i = 0; i < values.length; i += 1) {
    if (isPersonnelRowBlank_(values[i])) return i + 2;
  }
  return lastRow + 1;
}

// Returns every logical personnel row as a plain record object -- no
// row-index metadata, since every write path re-resolves the target row
// by id via findRowById() at the moment it actually writes, rather than
// trusting an index captured earlier in the same request.
//
// PHYSICAL READ ONLY (task requirement, post-incident): built entirely on
// getLogicalPersonnelRows_() above -- no CacheService, no
// PropertiesService, no merge with any other array, no memoization. This
// is the only function in this file that produces personnel records from
// the sheet for consumers other than findRowById() below (built the same
// way).
function readAllRecords(sheet) {
  return getLogicalPersonnelRows_(sheet).map(function (logicalRow) {
    return parseRow(logicalRow.values);
  });
}

// Returns { rowIndex, record } for the row matching `id`, or null if no
// row matches. Built on getLogicalPersonnelRows_() -- deliberately does
// NOT assume records are contiguous, so it finds a record whether it
// lives at row 2 or is stranded far past a checkbox-padding gap (e.g. the
// live incident's row 1008).
function findRowById(sheet, id) {
  var logicalRows = getLogicalPersonnelRows_(sheet);
  for (var i = 0; i < logicalRows.length; i += 1) {
    if (String(logicalRows[i].values[COL_ID]) === id) {
      return { rowIndex: logicalRows[i].rowNumber, record: parseRow(logicalRows[i].values) };
    }
  }
  return null;
}

// Safe diagnostic logging only: spreadsheet/tab identity and row counts --
// NEVER the personnel dataset itself. Every read and write action calls
// this with its own action label immediately before returning success, so
// the Apps Script Executions log lets the Owner directly compare, side by
// side, exactly which physical spreadsheet/tab each action touched. If
// GET and POST ever show a different spreadsheetName/sheetName here,
// that alone identifies a read/write divergence without needing to
// inspect any personnel data.
function logPersonnelSheetAccess_(action, sheet, extra) {
  var payload = {
    action: action,
    spreadsheetName: sheet.getParent().getName(),
    sheetName: sheet.getName(),
    lastRow: sheet.getLastRow(),
  };
  if (extra) {
    for (var key in extra) {
      if (Object.prototype.hasOwnProperty.call(extra, key)) payload[key] = extra[key];
    }
  }
  Logger.log(JSON.stringify(payload));
}

function writeRecordToRow(sheet, rowIndex, record) {
  sheet.getRange(rowIndex, 1, 1, COLUMNS.length).setValues([buildRowArray(record)]);
}

// Builds the physical row EXPLICITLY, column by column (A-I), rather than
// relying on any object's own property enumeration order -- required
// literally by the task spec ("Do not rely on object property order. Use
// an explicit array."). If a column is ever added/reordered, this
// function (and the matching COL_* indices above) is the one place that
// must change together.
function buildRowArray(record) {
  return [
    record.id,           // A id
    record.role_type,    // B role_type
    record.name,         // C name
    record.organization, // D organization
    record.active,       // E active
    record.created_at,   // F created_at
    record.updated_at,   // G updated_at
    record.updated_by,   // H updated_by
    record.version,      // I version
  ];
}

// Compares a freshly re-read row (via findRowById(), i.e. the ACTUAL
// physical sheet contents after SpreadsheetApp.flush()) against the record
// this handler intended to write. Every field that a write action can
// change is checked -- an exact match is required, not a loose/partial
// one, since a silent partial write is exactly the failure mode this
// verification exists to catch.
function verifyRowMatches(actualRecord, intendedRecord) {
  if (!actualRecord) return false;
  return actualRecord.id === intendedRecord.id
    && actualRecord.role_type === intendedRecord.role_type
    && actualRecord.name === intendedRecord.name
    && actualRecord.organization === intendedRecord.organization
    && actualRecord.active === intendedRecord.active
    && actualRecord.updated_by === intendedRecord.updated_by
    && actualRecord.version === intendedRecord.version;
}

function writeVerificationFailedError() {
  return { ok: false, error: { code: 'WRITE_VERIFICATION_FAILED', message: 'Personnel write could not be verified.' } };
}

function toIsoString(value) {
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

/* ============================================================
   SMALL UTILITIES
============================================================ */

function trimString(value) {
  return String(value == null ? '' : value).trim();
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function isPositiveInteger(value) {
  return typeof value === 'number' && isFinite(value) && Math.floor(value) === value && value > 0;
}

function normalizeCompareKey(value) {
  return String(value == null ? '' : value).trim().replace(/\s+/g, ' ').toLowerCase();
}

function jsonResponse(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

/* ============================================================
   OWNER-MANUAL MAINTENANCE TOOLS -- auditPersonnelTable(),
   compactPersonnelTable(), and deactivatePersonnelByIds_MANUAL() below
   are run ONLY by the Owner directly from the Apps Script editor's
   "Select function" dropdown. NONE of them are wired into doGet()/doPost()
   -- the Web App can never trigger them, by construction (there is no
   `action` string anywhere in doGet/doPost's switch statements that maps
   to any of these three names). This exists because the live sheet
   currently has real personnel records stranded far past a large
   checkbox-padding gap (see the file header) -- these tools let the Owner
   review that data (audit), decide what to keep, and then compact the
   table back into a contiguous block, without ever auto-deleting
   anything.
============================================================ */

// Read-only. Logs every logical personnel record (physical row, id,
// role_type, name, organization, active, version) plus duplicate-id and
// duplicate-logical-identity detection, and flags records whose name
// matches a common test-record pattern -- as information only. Never
// modifies the sheet, never decides which records are "real" -- the Owner
// reviews the log and decides.
function auditPersonnelTable() {
  var sheet = getPersonnelSheet();
  assertWriteTest_(!!sheet, 'report_personnel sheet not found');

  var logicalRows = getLogicalPersonnelRows_(sheet);
  var entries = logicalRows.map(function (lr) {
    return { rowNumber: lr.rowNumber, record: parseRow(lr.values) };
  });

  var idCounts = {};
  var identityCounts = {};
  entries.forEach(function (entry) {
    var r = entry.record;
    idCounts[r.id] = (idCounts[r.id] || 0) + 1;
    var identityKey = normalizeCompareKey(r.role_type) + '|' + normalizeCompareKey(r.name) + '|' + normalizeCompareKey(r.organization);
    identityCounts[identityKey] = (identityCounts[identityKey] || 0) + 1;
  });

  var duplicateIds = Object.keys(idCounts).filter(function (id) { return idCounts[id] > 1; });
  var duplicateIdentities = Object.keys(identityCounts).filter(function (key) { return identityCounts[key] > 1; });

  // Heuristic only, for the Owner's attention -- never used to decide
  // anything automatically. Matches "ZZTEST..." (this file's own manual
  // write-through tests), "TEST INSERT/WRITE ...", or a bare leading
  // "test" word.
  var suspectPattern = /zztest|test insert|test write|^test\b/i;
  var suspectEntries = entries.filter(function (entry) { return suspectPattern.test(entry.record.name); });
  var suspectActiveIds = suspectEntries.filter(function (e) { return e.record.active === true; }).map(function (e) { return e.record.id; });
  var suspectInactiveIds = suspectEntries.filter(function (e) { return e.record.active === false; }).map(function (e) { return e.record.id; });

  Logger.log('=== auditPersonnelTable: ' + entries.length + ' logical records (spreadsheetName=' + sheet.getParent().getName() + ', sheetName=' + sheet.getName() + ') ===');
  entries.forEach(function (entry) {
    var r = entry.record;
    Logger.log('row=' + entry.rowNumber + ' id=' + r.id + ' role_type=' + r.role_type + ' name="' + r.name + '" organization=' + r.organization
      + ' active=' + r.active + ' version=' + r.version);
  });

  Logger.log(duplicateIds.length ? ('DUPLICATE IDS: ' + JSON.stringify(duplicateIds)) : 'No duplicate IDs.');
  Logger.log(duplicateIdentities.length
    ? ('DUPLICATE LOGICAL IDENTITIES (role_type|name|organization, normalized): ' + JSON.stringify(duplicateIdentities))
    : 'No duplicate logical identities.');
  Logger.log('Suspected test/accidental records, ACTIVE: ' + (suspectActiveIds.length ? suspectActiveIds.join(', ') : '(none)'));
  Logger.log('Suspected test/accidental records, INACTIVE: ' + (suspectInactiveIds.length ? suspectInactiveIds.join(', ') : '(none)'));
  Logger.log('=== auditPersonnelTable complete -- nothing was modified. Review the log above and decide manually. ===');

  return {
    totalRecords: entries.length,
    duplicateIds: duplicateIds,
    duplicateIdentities: duplicateIdentities,
    suspectActiveIds: suspectActiveIds,
    suspectInactiveIds: suspectInactiveIds,
  };
}

// OWNER-MANUAL cleanup helper -- run directly from the Apps Script editor
// with an explicit array of ids to deactivate, e.g.:
//   deactivatePersonnelByIds_MANUAL(['spv-scm-arif-danang', 'spv-scm-danang']);
// Never deletes rows -- only sets active=false, through the SAME verified
// write path setReportPersonnelActive() itself uses (findRowById + write +
// flush + read-back), so it can never silently no-op. The Owner decides
// which ids to pass in after reviewing auditPersonnelTable()'s output --
// this function makes no decision of its own about which records are
// "test" records. This is a Script-Editor-only tool, never a Web App
// action -- there is no hard-delete feature anywhere in this file.
function deactivatePersonnelByIds_MANUAL(ids) {
  if (!Array.isArray(ids) || ids.length === 0) {
    Logger.log('deactivatePersonnelByIds_MANUAL: no ids supplied -- nothing to do.');
    return;
  }

  var sheet = getPersonnelSheet();
  if (!sheet) {
    Logger.log('deactivatePersonnelByIds_MANUAL ABORTED -- report_personnel sheet not found.');
    return;
  }

  ids.forEach(function (id) {
    var found = findRowById(sheet, id);
    if (!found) {
      Logger.log('deactivatePersonnelByIds_MANUAL: id "' + id + '" not found -- skipped.');
      return;
    }
    if (found.record.active === false) {
      Logger.log('deactivatePersonnelByIds_MANUAL: id "' + id + '" is already inactive (row ' + found.rowIndex + ') -- skipped.');
      return;
    }

    var response = parseHandlerResponse_(setReportPersonnelActive({
      id: id,
      active: false,
      expected_version: found.record.version,
      updated_by: 'OWNER_WEB_APP',
    }));

    if (response.ok === true) {
      Logger.log('deactivatePersonnelByIds_MANUAL: id "' + id + '" deactivated (row ' + found.rowIndex + ', version ' + found.record.version + ' -> ' + response.record.version + ').');
    } else {
      Logger.log('deactivatePersonnelByIds_MANUAL: id "' + id + '" FAILED to deactivate -- ' + JSON.stringify(response.error));
    }
  });
}

// Pure computation, no sheet access: given the logical rows read BEFORE
// compaction (each { rowNumber, values }), either rejects (duplicate ids
// present -- nothing may be touched) or returns a plan assigning every
// record a new contiguous row number starting at row 2, in the same
// relative order the records were found in. Kept separate from
// compactPersonnelTable() below specifically so this planning logic can
// be unit-tested against fixtures without touching any real or fake
// Range/Sheet object.
function computeCompactionPlan_(logicalRows) {
  var entries = logicalRows.map(function (lr) { return { record: parseRow(lr.values), oldRow: lr.rowNumber }; });

  var idCounts = {};
  entries.forEach(function (entry) { idCounts[entry.record.id] = (idCounts[entry.record.id] || 0) + 1; });
  var duplicateIds = Object.keys(idCounts).filter(function (id) { return idCounts[id] > 1; });
  if (duplicateIds.length) {
    return { ok: false, duplicateIds: duplicateIds };
  }

  var plan = entries.map(function (entry, index) {
    return { record: entry.record, oldRow: entry.oldRow, newRow: index + 2 };
  });
  return { ok: true, plan: plan };
}

// Moves every logical personnel record into a contiguous block starting
// at row 2. NEVER called from doGet/doPost -- Owner-triggered only, from
// the Apps Script editor. Algorithm:
//   1. acquire the script lock;
//   2. read all logical personnel rows (preserving each full A:I record
//      exactly, via computeCompactionPlan_ -- no field is recomputed);
//   3. abort if any duplicate id is found, before anything is touched;
//   4. clear CONTENT ONLY (clearContent(), never clear()) from A:I across
//      the full physical range -- this never touches formatting, data
//      validation, or checkbox formatting, only cell values;
//   5. write every preserved record back, contiguously, starting at row 2;
//   6. flush, read back, and verify record count / ids / no duplicates /
//      every relevant field, throwing loudly on any mismatch;
//   7. log every old row -> new row mapping.
// Never deletes a row. Never destroys dropdowns/checkbox formatting.
function compactPersonnelTable() {
  var lock = LockService.getScriptLock();
  var gotLock = false;
  try {
    gotLock = lock.tryLock(30000);
  } catch (err) {
    gotLock = false;
  }
  if (!gotLock) {
    Logger.log('compactPersonnelTable ABORTED -- could not acquire script lock. Try again.');
    return;
  }

  try {
    var sheet = getPersonnelSheet();
    if (!sheet) {
      Logger.log('compactPersonnelTable ABORTED -- report_personnel sheet not found.');
      return;
    }

    var logicalRowsBefore = getLogicalPersonnelRows_(sheet);
    if (logicalRowsBefore.length === 0) {
      Logger.log('compactPersonnelTable: no logical personnel records found -- nothing to compact.');
      return;
    }

    var planResult = computeCompactionPlan_(logicalRowsBefore);
    if (!planResult.ok) {
      Logger.log('compactPersonnelTable ABORTED -- duplicate IDs detected, nothing was changed: ' + JSON.stringify(planResult.duplicateIds)
        + '. Run auditPersonnelTable() and resolve duplicates manually (e.g. deactivate the wrong one) before compacting.');
      return;
    }

    var plan = planResult.plan;
    var physicalLastRow = sheet.getLastRow();

    Logger.log('compactPersonnelTable: ' + plan.length + ' logical records found across physical rows '
      + plan.map(function (p) { return p.oldRow; }).join(', ') + ' (physical getLastRow()=' + physicalLastRow + ', spreadsheetName='
      + sheet.getParent().getName() + ', sheetName=' + sheet.getName() + ').');

    // CONTENT ONLY -- never clear(), never touch formatting/data
    // validation/checkbox formatting. Only cell VALUES are removed; the
    // checkbox formatting the Owner's sheet already has stays intact.
    sheet.getRange(2, 1, physicalLastRow - 1, COLUMNS.length).clearContent();

    plan.forEach(function (entry) {
      sheet.getRange(entry.newRow, 1, 1, COLUMNS.length).setValues([buildRowArray(entry.record)]);
    });

    SpreadsheetApp.flush();

    var logicalRowsAfter = getLogicalPersonnelRows_(sheet);
    var recordsAfter = logicalRowsAfter.map(function (lr) { return parseRow(lr.values); });

    assertWriteTest_(recordsAfter.length === plan.length,
      'compactPersonnelTable VERIFICATION FAILED -- record count changed: before=' + plan.length + ', after=' + recordsAfter.length);

    var afterById = {};
    recordsAfter.forEach(function (r) {
      assertWriteTest_(!afterById[r.id], 'compactPersonnelTable VERIFICATION FAILED -- duplicate id after compaction: ' + r.id);
      afterById[r.id] = r;
    });

    plan.forEach(function (entry) {
      var before = entry.record;
      var after = afterById[before.id];
      assertWriteTest_(!!after, 'compactPersonnelTable VERIFICATION FAILED -- id missing after compaction: ' + before.id);
      assertWriteTest_(after.role_type === before.role_type, 'compactPersonnelTable VERIFICATION FAILED -- role_type changed for ' + before.id);
      assertWriteTest_(after.name === before.name, 'compactPersonnelTable VERIFICATION FAILED -- name changed for ' + before.id);
      assertWriteTest_(after.organization === before.organization, 'compactPersonnelTable VERIFICATION FAILED -- organization changed for ' + before.id);
      assertWriteTest_(after.active === before.active, 'compactPersonnelTable VERIFICATION FAILED -- active changed for ' + before.id);
      assertWriteTest_(after.version === before.version, 'compactPersonnelTable VERIFICATION FAILED -- version changed for ' + before.id);
    });

    Logger.log('compactPersonnelTable SUCCESS -- ' + plan.length + ' records compacted to contiguous rows 2-' + (plan.length + 1) + '.');
    plan.forEach(function (entry) {
      Logger.log('  id=' + entry.record.id + ': row ' + entry.oldRow + ' -> row ' + entry.newRow);
    });
  } finally {
    lock.releaseLock();
  }
}

/* ============================================================
   MANUAL APPS SCRIPT TESTS -- run individually from the Apps Script
   editor ("Select function" dropdown -> Run), NOT part of the Node test
   suite (tests/*.test.mjs). These call the real handler functions
   in-process (no HTTP round trip) and then assert against the ACTUAL
   PHYSICAL SHEET CELLS via findRowById() -- never against a function's
   returned object alone -- because a returned object alone is exactly
   what let the live "Arif Danang" incident look like success while the
   Sheet was untouched. Each test creates one clearly-labeled ZZTEST
   record and deactivates it afterward (never hard-deleted, matching the
   app's own never-delete-personnel rule) so report_personnel stays clean.

   If a previous run failed before reaching its own cleanup step, it may
   leave a stray ACTIVE "ZZTEST..." row behind -- find it in
   report_personnel and deactivate it manually before re-running, or the
   next run's own add may hit a duplicate-active rejection instead of the
   scenario under test.
============================================================ */

function assertWriteTest_(condition, message) {
  if (!condition) throw new Error('ASSERTION FAILED: ' + message);
}

function parseHandlerResponse_(textOutput) {
  return JSON.parse(textOutput.getContent());
}

// 1. addReportPersonnel must physically create the row it claims to --
// re-read by id, not assumed from the handler's return value.
function testAddReportPersonnelWriteThrough() {
  var response = parseHandlerResponse_(addReportPersonnel({
    role_type: 'SPV_SCM',
    name: 'ZZTEST WRITE VERIFICATION ADD',
    organization: 'SCM',
    updated_by: 'OWNER_WEB_APP',
    expected_schema_version: SCHEMA_VERSION,
  }));
  assertWriteTest_(response.ok === true, 'addReportPersonnel did not return ok:true: ' + JSON.stringify(response));
  var id = response.record.id;

  var sheet = getPersonnelSheet();
  assertWriteTest_(!!sheet, 'report_personnel sheet not found');
  var found = findRowById(sheet, id);
  assertWriteTest_(!!found, 'row for id "' + id + '" was not physically found in the sheet after the write');
  assertWriteTest_(found.record.name === 'ZZTEST WRITE VERIFICATION ADD', 'physical row name mismatch: ' + found.record.name);
  assertWriteTest_(found.record.role_type === 'SPV_SCM', 'physical row role_type mismatch: ' + found.record.role_type);
  assertWriteTest_(found.record.organization === 'SCM', 'physical row organization mismatch: ' + found.record.organization);
  assertWriteTest_(found.record.active === true, 'physical row active mismatch: ' + found.record.active);
  assertWriteTest_(found.record.version === 1, 'physical row version mismatch: ' + found.record.version);
  Logger.log('testAddReportPersonnelWriteThrough PASSED -- row ' + found.rowIndex + ', id=' + id + ', version=' + found.record.version);

  var cleanup = parseHandlerResponse_(setReportPersonnelActive({ id: id, active: false, expected_version: 1, updated_by: 'OWNER_WEB_APP' }));
  assertWriteTest_(cleanup.ok === true, 'cleanup deactivate failed: ' + JSON.stringify(cleanup));
  Logger.log('testAddReportPersonnelWriteThrough cleanup: deactivated id=' + id);
}

// 2. updateReportPersonnel must physically change name/organization AND
// increment version -- verified against the sheet, not the return value.
function testUpdateReportPersonnelWriteThrough() {
  var addResponse = parseHandlerResponse_(addReportPersonnel({
    role_type: 'FRM_SCM',
    name: 'ZZTEST WRITE VERIFICATION UPDATE',
    organization: 'SCM',
    updated_by: 'OWNER_WEB_APP',
    expected_schema_version: SCHEMA_VERSION,
  }));
  assertWriteTest_(addResponse.ok === true, 'setup add failed: ' + JSON.stringify(addResponse));
  var id = addResponse.record.id;

  var updatedName = 'ZZTEST WRITE VERIFICATION UPDATE (renamed)';
  var updateResponse = parseHandlerResponse_(updateReportPersonnel({
    id: id,
    name: updatedName,
    organization: 'SCM',
    expected_version: 1,
    updated_by: 'OWNER_WEB_APP',
  }));
  assertWriteTest_(updateResponse.ok === true, 'updateReportPersonnel did not return ok:true: ' + JSON.stringify(updateResponse));

  var sheet = getPersonnelSheet();
  var found = findRowById(sheet, id);
  assertWriteTest_(!!found, 'row for id "' + id + '" not found after update');
  assertWriteTest_(found.record.name === updatedName, 'physical row name was not updated: ' + found.record.name);
  assertWriteTest_(found.record.version === 2, 'physical row version did not increment: ' + found.record.version);
  Logger.log('testUpdateReportPersonnelWriteThrough PASSED -- row ' + found.rowIndex + ', id=' + id + ', version=' + found.record.version);

  var cleanup = parseHandlerResponse_(setReportPersonnelActive({ id: id, active: false, expected_version: 2, updated_by: 'OWNER_WEB_APP' }));
  assertWriteTest_(cleanup.ok === true, 'cleanup deactivate failed: ' + JSON.stringify(cleanup));
  Logger.log('testUpdateReportPersonnelWriteThrough cleanup: deactivated id=' + id);
}

// 3. setReportPersonnelActive(active:false) must physically flip the
// sheet's active cell to FALSE -- this IS the cleanup state, so there is
// nothing further to undo afterward.
function testDeactivatePersonnelWriteThrough() {
  var addResponse = parseHandlerResponse_(addReportPersonnel({
    role_type: 'SAMPLER',
    name: 'ZZTEST-DEACTIVATE',
    organization: 'ZZTEST-DEACTIVATE',
    updated_by: 'OWNER_WEB_APP',
    expected_schema_version: SCHEMA_VERSION,
  }));
  assertWriteTest_(addResponse.ok === true, 'setup add failed: ' + JSON.stringify(addResponse));
  var id = addResponse.record.id;

  var deactivateResponse = parseHandlerResponse_(setReportPersonnelActive({
    id: id,
    active: false,
    expected_version: 1,
    updated_by: 'OWNER_WEB_APP',
  }));
  assertWriteTest_(deactivateResponse.ok === true, 'setReportPersonnelActive(false) did not return ok:true: ' + JSON.stringify(deactivateResponse));

  var sheet = getPersonnelSheet();
  var found = findRowById(sheet, id);
  assertWriteTest_(!!found, 'row for id "' + id + '" not found after deactivate');
  assertWriteTest_(found.record.active === false, 'physical row active was not set to FALSE: ' + found.record.active);
  assertWriteTest_(found.record.version === 2, 'physical row version did not increment: ' + found.record.version);
  Logger.log('testDeactivatePersonnelWriteThrough PASSED -- row ' + found.rowIndex + ', id=' + id + ', version=' + found.record.version + ', active=' + found.record.active);
}

// 4. setReportPersonnelActive(active:true) must physically flip the
// sheet's active cell back to TRUE, then cleanup deactivates it again.
function testReactivatePersonnelWriteThrough() {
  var addResponse = parseHandlerResponse_(addReportPersonnel({
    role_type: 'PIC_3RD',
    name: 'ZZTEST-REACTIVATE PIC',
    organization: 'ZZTEST-REACTIVATE',
    updated_by: 'OWNER_WEB_APP',
    expected_schema_version: SCHEMA_VERSION,
  }));
  assertWriteTest_(addResponse.ok === true, 'setup add failed: ' + JSON.stringify(addResponse));
  var id = addResponse.record.id;

  var deactivateResponse = parseHandlerResponse_(setReportPersonnelActive({ id: id, active: false, expected_version: 1, updated_by: 'OWNER_WEB_APP' }));
  assertWriteTest_(deactivateResponse.ok === true, 'setup deactivate failed: ' + JSON.stringify(deactivateResponse));

  var reactivateResponse = parseHandlerResponse_(setReportPersonnelActive({
    id: id,
    active: true,
    expected_version: 2,
    updated_by: 'OWNER_WEB_APP',
  }));
  assertWriteTest_(reactivateResponse.ok === true, 'setReportPersonnelActive(true) did not return ok:true: ' + JSON.stringify(reactivateResponse));

  var sheet = getPersonnelSheet();
  var found = findRowById(sheet, id);
  assertWriteTest_(!!found, 'row for id "' + id + '" not found after reactivate');
  assertWriteTest_(found.record.active === true, 'physical row active was not set to TRUE: ' + found.record.active);
  assertWriteTest_(found.record.version === 3, 'physical row version did not increment: ' + found.record.version);
  Logger.log('testReactivatePersonnelWriteThrough PASSED -- row ' + found.rowIndex + ', id=' + id + ', version=' + found.record.version + ', active=' + found.record.active);

  var cleanup = parseHandlerResponse_(setReportPersonnelActive({ id: id, active: false, expected_version: 3, updated_by: 'OWNER_WEB_APP' }));
  assertWriteTest_(cleanup.ok === true, 'final cleanup deactivate failed: ' + JSON.stringify(cleanup));
  Logger.log('testReactivatePersonnelWriteThrough cleanup: deactivated id=' + id);
}

/* ============================================================
   PHYSICAL-SOURCE VERIFICATION TESTS -- added after a second live
   incident: a fully cleared localStorage + fresh Sync still returned a
   personnel record ("Arif Danang") that did not physically exist
   anywhere in report_personnel, while writes were independently confirmed
   reaching the correct sheet (Illofi's version incremented to 2). These
   tests exist specifically to make that class of bug fail loudly here,
   in the Apps Script editor, before it ever reaches the deployed Web App
   again -- every id listReportPersonnel returns must be traceable to a
   physical row, with no exception.
============================================================ */

// 5. listReportPersonnel must return ONLY ids that are physically present
// in report_personnel, and it must return ALL of them (no undercount
// either) -- run with includeInactive=true so this compares the full
// physical row set one-to-one against the full API result set.
function testListReportPersonnelPhysicalSource() {
  var sheet = getPersonnelSheet();
  assertWriteTest_(!!sheet, 'report_personnel sheet not found');

  var physicalRecords = readAllRecords(sheet);
  var physicalIds = {};
  physicalRecords.forEach(function (r) { physicalIds[r.id] = true; });

  var response = parseHandlerResponse_(listReportPersonnel({ parameter: { includeInactive: 'true' } }));
  assertWriteTest_(response.ok === true, 'listReportPersonnel did not return ok:true: ' + JSON.stringify(response));

  response.records.forEach(function (r) {
    assertWriteTest_(
      physicalIds[r.id] === true,
      'PHANTOM RECORD: listReportPersonnel returned id "' + r.id + '" ("' + r.name + '") which is NOT physically present in report_personnel.'
    );
  });

  assertWriteTest_(
    response.records.length === physicalRecords.length,
    'listReportPersonnel returned ' + response.records.length + ' records but the physical sheet has ' + physicalRecords.length + ' data rows -- counts must match exactly with includeInactive=true.'
  );

  Logger.log('testListReportPersonnelPhysicalSource PASSED -- physical=' + physicalRecords.length + ', returned=' + response.records.length
    + ', spreadsheetName=' + sheet.getParent().getName() + ', sheetName=' + sheet.getName());
}

// 6. Stricter subset check, exercised against BOTH request shapes
// (default active-only, and includeInactive=true) -- a phantom record
// could in principle only surface on one of the two code paths, so both
// must be checked independently. "returned IDs subset-of physical sheet
// IDs" must hold with no exception, regardless of the includeInactive
// filter applied.
function testNoPhantomPersonnelRecords() {
  var sheet = getPersonnelSheet();
  assertWriteTest_(!!sheet, 'report_personnel sheet not found');

  var physicalIds = {};
  readAllRecords(sheet).forEach(function (r) { physicalIds[r.id] = true; });

  var requestShapes = [
    { parameter: {} },
    { parameter: { includeInactive: 'true' } },
  ];

  requestShapes.forEach(function (fakeEvent) {
    var response = parseHandlerResponse_(listReportPersonnel(fakeEvent));
    assertWriteTest_(response.ok === true, 'listReportPersonnel did not return ok:true: ' + JSON.stringify(response));

    response.records.forEach(function (r) {
      assertWriteTest_(
        physicalIds[r.id] === true,
        'PHANTOM RECORD (includeInactive=' + (fakeEvent.parameter.includeInactive || 'false') + '): id "' + r.id + '" ("' + r.name + '") does not exist physically in report_personnel.'
      );
    });
  });

  Logger.log('testNoPhantomPersonnelRecords PASSED -- every returned id (both request shapes) is a subset of the '
    + Object.keys(physicalIds).length + ' physical ids in report_personnel.');
}

// TEMPORARY DIAGNOSTIC -- not a production rule. Delete this function once
// the Owner has confirmed, against the real deployed Web App, that "Arif
// Danang" no longer appears from listReportPersonnel after deploying this
// file as a new version of the same deployment. It exists only to
// directly settle, for this one specific name from the live incident
// report, whether the physical sheet and the API response agree.
function testArifDanangPhantomDiagnostic_TEMPORARY() {
  var sheet = getPersonnelSheet();
  assertWriteTest_(!!sheet, 'report_personnel sheet not found');

  var normalizedTarget = 'arif danang';
  var physicalMatch = readAllRecords(sheet).some(function (r) {
    return normalizeCompareKey(r.name) === normalizedTarget;
  });

  var response = parseHandlerResponse_(listReportPersonnel({ parameter: { includeInactive: 'true' } }));
  assertWriteTest_(response.ok === true, 'listReportPersonnel did not return ok:true: ' + JSON.stringify(response));
  var apiMatch = response.records.some(function (r) {
    return normalizeCompareKey(r.name) === normalizedTarget;
  });

  Logger.log('testArifDanangPhantomDiagnostic_TEMPORARY -- physical sheet has "Arif Danang": ' + physicalMatch
    + ', listReportPersonnel returns "Arif Danang": ' + apiMatch
    + ', spreadsheetName=' + sheet.getParent().getName() + ', sheetName=' + sheet.getName());

  assertWriteTest_(
    physicalMatch === apiMatch,
    'MISMATCH: physical sheet says "Arif Danang" exists=' + physicalMatch + ' but listReportPersonnel says exists=' + apiMatch
      + ' -- the read path is still not authoritative.'
  );
}

/* ============================================================
   LOGICAL-ROW / CHECKBOX-BLANK REGRESSION TESTS -- added after a third
   live incident: checkbox/data-validation formatting applied down to
   roughly row 1000 in column E (active) sets those cells' value to FALSE
   even though nobody ever "entered" anything there, which fooled
   sheet.getLastRow() (and therefore sheet.appendRow()) into treating row
   ~1000 as the end of the table instead of row 18 -- new records were
   landing at row ~1001+ instead of row 19. These tests exercise
   isPersonnelRowBlank_() / getLogicalPersonnelRows_() /
   findFirstAvailablePersonnelRow_() / computeCompactionPlan_() against a
   small in-memory fake sheet (createFakePersonnelSheet_() below) so they
   are fully deterministic and independent of whatever the live
   report_personnel sheet currently contains -- none of them touch the
   real bound spreadsheet.
============================================================ */

// Minimal in-memory fake implementing just the Range/Sheet surface
// isPersonnelRowBlank_/getLogicalPersonnelRows_/
// findFirstAvailablePersonnelRow_/readAllRecords/findRowById actually
// call (getLastRow(), getRange(row, col, numRows, numCols).getValues()/
// .setValues()/.clearContent()), so the checkbox/blank-row logic can be
// tested without touching the real bound spreadsheet. `rows` is an array
// of 9-cell arrays starting at physical row 2 (rows[0] === row 2,
// rows[1] === row 3, ...).
function createFakePersonnelSheet_(rows) {
  var data = rows.map(function (row) { return row.slice(); });

  return {
    getLastRow: function () {
      return data.length + 1; // +1 for the header row
    },
    getRange: function (row, col, numRows, numCols) {
      var startIndex = row - 2; // row 2 -> data[0]
      var slice = data.slice(startIndex, startIndex + numRows);
      return {
        getValues: function () {
          return slice.map(function (r) { return r.slice(0, numCols); });
        },
        setValues: function (values) {
          for (var i = 0; i < values.length; i += 1) {
            data[startIndex + i] = values[i].slice();
          }
        },
        clearContent: function () {
          for (var i = 0; i < slice.length; i += 1) {
            data[startIndex + i] = new Array(numCols).fill('');
          }
        },
      };
    },
    getName: function () { return 'report_personnel (fake)'; },
    getParent: function () { return { getName: function () { return 'Fake Spreadsheet'; } }; },
  };
}

function assertEqualsTest_(actual, expected, message) {
  assertWriteTest_(actual === expected, message + ' (expected ' + JSON.stringify(expected) + ', got ' + JSON.stringify(actual) + ')');
}

// 1. completely empty row is blank.
function testIsPersonnelRowBlank_EmptyRow() {
  var row = ['', '', '', '', '', '', '', '', ''];
  assertWriteTest_(isPersonnelRowBlank_(row) === true, 'a completely empty row must be blank');
  Logger.log('testIsPersonnelRowBlank_EmptyRow PASSED');
}

// 2. FALSE-only checkbox row is blank.
function testIsPersonnelRowBlank_FalseCheckboxOnly() {
  var row = ['', '', '', '', false, '', '', '', ''];
  assertWriteTest_(isPersonnelRowBlank_(row) === true, 'a row whose only non-empty cell is active=false must be blank');
  Logger.log('testIsPersonnelRowBlank_FalseCheckboxOnly PASSED');
}

// 3. TRUE-only checkbox row behavior is explicitly defined: active=true
// with every other column empty is NOT blank, by the literal definition
// of isPersonnelRowBlank_ (only '', null, undefined, and false count as
// blank -- true does not). Deliberate, documented: such a row would
// surface via getLogicalPersonnelRows_() as a logical row (producing a
// degenerate record with an empty id/role_type when parsed) -- a sign of
// manual sheet tampering worth investigating via auditPersonnelTable(),
// not something this layer should silently discard.
function testIsPersonnelRowBlank_TrueCheckboxOnly() {
  var row = ['', '', '', '', true, '', '', '', ''];
  assertWriteTest_(isPersonnelRowBlank_(row) === false, 'a row with active=true and everything else empty must NOT be blank (documented edge case)');
  Logger.log('testIsPersonnelRowBlank_TrueCheckboxOnly PASSED -- documented: active=true alone makes a row non-blank');
}

// 4. inactive populated personnel row is NOT blank (id/name/etc. are
// populated -- only active is false).
function testIsPersonnelRowBlank_InactiveRecord() {
  var row = ['spv-scm-arif', 'SPV_SCM', 'Arif', 'SCM', false, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', 'OWNER_WEB_APP', 2];
  assertWriteTest_(isPersonnelRowBlank_(row) === false, 'a genuine inactive personnel record must NOT be blank');
  Logger.log('testIsPersonnelRowBlank_InactiveRecord PASSED');
}

// 5. logical rows skip FALSE-only padding.
function testGetLogicalPersonnelRows_SkipsPadding() {
  var rows = [];
  rows.push(['spv-1', 'SPV_SCM', 'Illofi', 'SCM', true, 'x', 'x', 'OWNER_WEB_APP', 1]); // row 2
  for (var i = 0; i < 10; i += 1) rows.push(['', '', '', '', false, '', '', '', '']);    // rows 3-12: padding
  rows.push(['spv-2', 'SPV_SCM', 'Yoshita', 'SCM', true, 'x', 'x', 'OWNER_WEB_APP', 1]); // row 13

  var sheet = createFakePersonnelSheet_(rows);
  var logical = getLogicalPersonnelRows_(sheet);

  assertEqualsTest_(logical.length, 2, 'padding rows must be excluded from logical rows');
  assertEqualsTest_(logical[0].rowNumber, 2, 'first logical record must be row 2');
  assertEqualsTest_(logical[1].rowNumber, 13, 'second logical record must be row 13, skipping the FALSE-only padding');
  Logger.log('testGetLogicalPersonnelRows_SkipsPadding PASSED');
}

// 6. first logical blank after rows 2-18 (17 records) is row 19.
function testFindFirstAvailablePersonnelRow_AfterContiguousRecords() {
  var rows = [];
  for (var i = 0; i < 17; i += 1) {
    rows.push(['id-' + i, 'SPV_SCM', 'Person ' + i, 'SCM', true, 'x', 'x', 'OWNER_WEB_APP', 1]);
  }
  rows.push(['', '', '', '', false, '', '', '', '']); // row 19
  rows.push(['', '', '', '', false, '', '', '', '']); // row 20

  var sheet = createFakePersonnelSheet_(rows);
  var targetRow = findFirstAvailablePersonnelRow_(sheet);

  assertEqualsTest_(targetRow, 19, 'the first logically blank row after 17 records in rows 2-18 must be row 19');
  Logger.log('testFindFirstAvailablePersonnelRow_AfterContiguousRecords PASSED -- targetRow=' + targetRow);
}

// 7. Mirrors the live incident directly: rows 2-18 hold real records,
// rows 19-30 are FALSE-only checkbox padding (a smaller stand-in for the
// live sheet's rows 19-1000 -- the algorithm is scale-independent, so
// this proves the same thing a 1000-row fixture would prove, without the
// wasted execution time/log volume of actually constructing one) -- a new
// record must land at row 19, never appended past the padding.
function testFindFirstAvailablePersonnelRow_LargeFalsePadding() {
  var rows = [];
  for (var i = 0; i < 17; i += 1) {
    rows.push(['id-' + i, 'SPV_SCM', 'Person ' + i, 'SCM', true, 'x', 'x', 'OWNER_WEB_APP', 1]);
  }
  for (var p = 0; p < 12; p += 1) {
    rows.push(['', '', '', '', false, '', '', '', '']); // rows 19-30: FALSE checkbox padding
  }

  var sheet = createFakePersonnelSheet_(rows);
  var targetRow = findFirstAvailablePersonnelRow_(sheet);

  assertEqualsTest_(targetRow, 19, 'a new record must be inserted at row 19, not appended after the FALSE-checkbox padding');
  Logger.log('testFindFirstAvailablePersonnelRow_LargeFalsePadding PASSED -- targetRow=' + targetRow);
}

// 8. addReportPersonnel's source must never call the old broken
// appendRow()-based insertion again -- a direct regression guard against
// the exact bug this fix addresses.
function testAddReportPersonnel_DoesNotUseAppendRow() {
  var source = addReportPersonnel.toString();
  assertWriteTest_(source.indexOf('appendRow') === -1, 'addReportPersonnel must not call sheet.appendRow() -- it is fooled by checkbox/data-validation formatting past the real data');
  Logger.log('testAddReportPersonnel_DoesNotUseAppendRow PASSED');
}

// 9. Same regression guard for the other broken pattern
// (getLastRow() + 1), in case a future edit reintroduces it in a
// different shape than appendRow().
function testAddReportPersonnel_DoesNotUseLastRowPlusOne() {
  var source = addReportPersonnel.toString().replace(/\s+/g, ' ');
  assertWriteTest_(!/getLastRow\(\s*\)\s*\+\s*1/.test(source), 'addReportPersonnel must not compute an insertion row as getLastRow() + 1 -- same failure mode as appendRow()');
  Logger.log('testAddReportPersonnel_DoesNotUseLastRowPlusOne PASSED');
}

// 10. findRowById must find a record far past the real table (e.g. row
// 1008 in the live incident) without assuming contiguity.
function testFindRowById_FindsNonContiguousRow() {
  var rows = [];
  rows.push(['spv-1', 'SPV_SCM', 'Illofi', 'SCM', true, 'x', 'x', 'OWNER_WEB_APP', 1]); // row 2
  for (var i = 0; i < 20; i += 1) rows.push(['', '', '', '', false, '', '', '', '']);    // rows 3-22: padding
  rows.push(['spv-stray', 'SPV_SCM', 'Stray Person', 'SCM', true, 'x', 'x', 'OWNER_WEB_APP', 1]); // row 23, standing in for the live incident's row 1008

  var sheet = createFakePersonnelSheet_(rows);
  var found = findRowById(sheet, 'spv-stray');

  assertWriteTest_(!!found, 'findRowById must find a record located far past the contiguous real data');
  assertEqualsTest_(found.rowIndex, 23, 'must report the correct physical row number');
  Logger.log('testFindRowById_FindsNonContiguousRow PASSED -- row=' + found.rowIndex);
}

// 11. listReportPersonnel's underlying read (readAllRecords) must read
// records both in the contiguous block (rows 2-18-equivalent) and past a
// large padding gap (rows 1001-1008-equivalent), matching the exact live
// incident shape at a representative smaller scale.
function testReadAllRecords_ReadsBothContiguousAndStrandedBlocks() {
  var rows = [];
  for (var i = 0; i < 5; i += 1) {
    rows.push(['id-' + i, 'SPV_SCM', 'Person ' + i, 'SCM', true, 'x', 'x', 'OWNER_WEB_APP', 1]); // rows 2-6
  }
  for (var p = 0; p < 15; p += 1) rows.push(['', '', '', '', false, '', '', '', '']); // rows 7-21: padding
  rows.push(['stray-1', 'SPV_SCM', 'Stray One', 'SCM', true, 'x', 'x', 'OWNER_WEB_APP', 1]);   // row 22
  rows.push(['stray-2', 'SPV_SCM', 'Stray Two', 'SCM', false, 'x', 'x', 'OWNER_WEB_APP', 1]);  // row 23

  var sheet = createFakePersonnelSheet_(rows);
  var records = readAllRecords(sheet);

  assertEqualsTest_(records.length, 7, 'must read all 5 contiguous records plus both stranded records past the padding gap');
  var ids = records.map(function (r) { return r.id; });
  ['id-0', 'id-1', 'id-2', 'id-3', 'id-4', 'stray-1', 'stray-2'].forEach(function (expectedId) {
    assertWriteTest_(ids.indexOf(expectedId) !== -1, 'missing expected id "' + expectedId + '" in readAllRecords() result');
  });
  Logger.log('testReadAllRecords_ReadsBothContiguousAndStrandedBlocks PASSED -- ' + records.length + ' records read');
}

// 12. list ignores padding rows -- no padding row ever produces a
// (bogus, empty-id) record.
function testGetLogicalPersonnelRows_NeverIncludesPaddingAsARecord() {
  var rows = [];
  rows.push(['spv-1', 'SPV_SCM', 'Illofi', 'SCM', true, 'x', 'x', 'OWNER_WEB_APP', 1]);
  for (var i = 0; i < 30; i += 1) rows.push(['', '', '', '', false, '', '', '', '']);

  var sheet = createFakePersonnelSheet_(rows);
  var logical = getLogicalPersonnelRows_(sheet);

  assertEqualsTest_(logical.length, 1, 'only the one real record must be logical -- 30 FALSE-checkbox padding rows must all be excluded');
  Logger.log('testGetLogicalPersonnelRows_NeverIncludesPaddingAsARecord PASSED');
}

// 13-16. compaction preserves ids/active states/versions and produces
// contiguous records starting at row 2 -- exercised against
// computeCompactionPlan_(), the pure planning function
// compactPersonnelTable() itself uses, so this is deterministic and never
// touches the real bound sheet.
function testComputeCompactionPlan_PreservesIdsActiveVersionsAndIsContiguous() {
  var logicalRows = [
    { rowNumber: 2, values: ['id-a', 'SPV_SCM', 'Alpha', 'SCM', true, 'x', 'x', 'OWNER_WEB_APP', 1] },
    { rowNumber: 25, values: ['id-b', 'FRM_SCM', 'Beta', 'SCM', false, 'x', 'x', 'OWNER_WEB_APP', 3] },
    { rowNumber: 1001, values: ['id-c', 'SAMPLER', 'Gamma', 'AWK', true, 'x', 'x', 'OWNER_WEB_APP', 2] },
  ];

  var result = computeCompactionPlan_(logicalRows);

  assertWriteTest_(result.ok === true, 'a duplicate-free logical row set must produce a valid compaction plan');
  assertEqualsTest_(result.plan.length, 3, 'plan must contain every logical record');

  var byId = {};
  result.plan.forEach(function (entry) { byId[entry.record.id] = entry; });

  ['id-a', 'id-b', 'id-c'].forEach(function (id) {
    assertWriteTest_(!!byId[id], 'compaction plan is missing id "' + id + '"'); // 13. preserves ids
  });
  assertEqualsTest_(byId['id-a'].record.active, true, 'active state must be preserved for id-a');   // 14. preserves active states
  assertEqualsTest_(byId['id-b'].record.active, false, 'active state must be preserved for id-b');  // 14
  assertEqualsTest_(byId['id-a'].record.version, 1, 'version must be preserved for id-a');           // 15. preserves versions
  assertEqualsTest_(byId['id-b'].record.version, 3, 'version must be preserved for id-b');           // 15
  assertEqualsTest_(byId['id-c'].record.version, 2, 'version must be preserved for id-c');           // 15

  var newRows = result.plan.map(function (entry) { return entry.newRow; }).sort(function (a, b) { return a - b; });
  assertWriteTest_(JSON.stringify(newRows) === JSON.stringify([2, 3, 4]),
    'compacted records must occupy contiguous rows starting at row 2 -- got ' + JSON.stringify(newRows)); // 16. contiguous from row 2

  Logger.log('testComputeCompactionPlan_PreservesIdsActiveVersionsAndIsContiguous PASSED');
}

// 17. compaction must use clearContent(), never clear() -- the only way
// to remove stray record VALUES without destroying the checkbox/dropdown
// formatting the live sheet already has across rows 19-1000.
function testCompactPersonnelTable_UsesClearContentNotClear() {
  var source = compactPersonnelTable.toString();
  assertWriteTest_(source.indexOf('clearContent') !== -1, 'compactPersonnelTable must call clearContent() to remove stray record values');
  assertWriteTest_(!/\.clear\(/.test(source), 'compactPersonnelTable must never call the destructive .clear() -- only .clearContent()');
  Logger.log('testCompactPersonnelTable_UsesClearContentNotClear PASSED');
}

// 18. duplicate IDs abort compaction safely -- no plan is produced, and
// (by extension, since compactPersonnelTable() checks planResult.ok
// before touching the sheet at all) nothing about the sheet would be
// modified.
function testComputeCompactionPlan_AbortsOnDuplicateIds() {
  var logicalRows = [
    { rowNumber: 2, values: ['dup-id', 'SPV_SCM', 'Alpha', 'SCM', true, 'x', 'x', 'OWNER_WEB_APP', 1] },
    { rowNumber: 5, values: ['dup-id', 'SPV_SCM', 'Alpha Copy', 'SCM', true, 'x', 'x', 'OWNER_WEB_APP', 1] },
  ];

  var result = computeCompactionPlan_(logicalRows);

  assertWriteTest_(result.ok === false, 'a logical row set containing a duplicate id must be rejected, not silently compacted');
  assertWriteTest_(result.duplicateIds.indexOf('dup-id') !== -1, 'the specific duplicate id must be reported');
  Logger.log('testComputeCompactionPlan_AbortsOnDuplicateIds PASSED -- duplicateIds=' + JSON.stringify(result.duplicateIds));
}

/* ============================================================
   STEP-D MANUAL VERIFICATION HELPERS -- small, read-only diagnostics
   named to match the Owner manual procedure (docs/apps-script/Code.gs's
   companion instructions): run these against the REAL bound sheet after
   compactPersonnelTable() to sanity-check the result by eye.
============================================================ */

function testPersonnelSpreadsheetIdentity() {
  var sheet = getPersonnelSheet();
  assertWriteTest_(!!sheet, 'report_personnel sheet not found');
  Logger.log('testPersonnelSpreadsheetIdentity -- spreadsheetName=' + sheet.getParent().getName()
    + ', sheetName=' + sheet.getName() + ', lastRow=' + sheet.getLastRow());
}

function testPhysicalPersonnelNames() {
  var sheet = getPersonnelSheet();
  assertWriteTest_(!!sheet, 'report_personnel sheet not found');
  var records = readAllRecords(sheet);
  Logger.log('testPhysicalPersonnelNames -- ' + records.length + ' logical records:');
  records.forEach(function (r) { Logger.log('  ' + r.name); });
}

function testPhysicalPersonnelIds() {
  var sheet = getPersonnelSheet();
  assertWriteTest_(!!sheet, 'report_personnel sheet not found');
  var records = readAllRecords(sheet);
  var seen = {};
  var duplicates = [];
  records.forEach(function (r) {
    if (seen[r.id]) duplicates.push(r.id);
    seen[r.id] = true;
  });
  Logger.log('testPhysicalPersonnelIds -- ' + records.length + ' logical records, ids: ' + records.map(function (r) { return r.id; }).join(', '));
  assertWriteTest_(duplicates.length === 0, 'duplicate ids found in physical data: ' + JSON.stringify(duplicates));
}
