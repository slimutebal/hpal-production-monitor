// Shared contractor (DT -> contractor) directory core: normalization +
// shared-cache schema, the ONE canonical implementation both Monitor
// (contractor-assignment.js) and Report (contractor-directory-service.js)
// consume, so DT normalization is never independently reimplemented in a
// third place. Root cause this fixes (shared-cache architecture round):
// contractor-assignment.js's own synced List DT lived only in a private
// in-memory closure (`state.existing`), never in localStorage, so Report
// had no real way to see what Monitor had just synced -- a Report-only
// background sync raced against uploads and could silently classify a
// workbook against stale/empty data. This file is the shared persistence
// bridge: it owns `hpal.contractors.v1`'s schema/validation and the
// `hpal:contractor-directory-updated` event contract, and nothing else.
//
// Deliberately NOT an ES module: contractor-assignment.js is a classic,
// non-module <script defer> (see index.html) and cannot use `import`.
// This file is loaded as a classic <script> BEFORE contractor-assignment.js
// (index.html) so `window.HPALContractorDirectoryCore` exists
// synchronously by the time contractor-assignment.js runs. It attaches to
// `globalThis` (not `window` specifically) so the exact same file also
// works when side-effect-imported from a plain Node ES module (`import
// '.../contractor-directory-core.js'`) for tests -- Node's `globalThis`
// exists natively, just without a browser DOM/EventTarget attached to it,
// which this file never assumes.
//
// Responsibilities ONLY: normalize DT ids, validate row/cache shapes,
// read/write the shared localStorage cache, and dispatch/describe the
// update event. It never fetches, never accesses Monitor or Report DOM,
// never writes to the Google Sheet, and never renders UI -- those stay
// owned by contractor-assignment.js and contractor-directory-service.js
// respectively.
(function (root) {
  'use strict';

  var CACHE_KEY = 'hpal.contractors.v1';
  var CACHE_VERSION = 1;
  var DIRECTORY_UPDATED_EVENT = 'hpal:contractor-directory-updated';

  /* ============================================================
     NORMALIZATION -- byte-for-byte reproduction of
     contractor-assignment.js's own canonicalDtId()/normalizedKey() (that
     file's copy is intentionally left untouched -- see its own header
     comment -- this is the new, going-forward canonical copy every other
     module now consumes instead of maintaining its own). Handles:
     "SCM-LIM 949", "SCM LIM 949", "SCM_LIM_949", "SCM-LIM-949",
     "SCM-LIM 949 DT", "SCM-LIM 949 DT." -- all resolve to "SCM-LIM 949" /
     key "SCMLIM949". Ids outside the "SCM <letters> <digits>" shape
     (ADT/MIM/STM/DT-prefixed units in contractor-adapter.js's static
     table) canonicalize to "" here, exactly as in Monitor, and are never
     part of the synced/shared key space -- callers fall through to the
     static fallback lookup for those.
  ============================================================ */
  function canonicalDtId(value) {
    var text = String(value === null || value === undefined ? '' : value)
      .replace(/[\u00A0\uFEFF\u200B]/g, ' ')
      .trim()
      .toUpperCase();

    text = text.replace(/_/g, ' ');
    text = text.replace(/[\s.-]*\bDT\.?\s*$/, '').trim();
    text = text.replace(/[.\-\s]+$/, '').trim();
    text = text.replace(/\s+/g, ' ');

    var match = text.match(/^SCM[\s-]+([A-Z]+)[\s-]+(\d+[A-Z]*)$/);
    return match ? ('SCM-' + match[1] + ' ' + match[2]) : '';
  }

  function normalizedKey(value) {
    return canonicalDtId(value).replace(/[^A-Z0-9]/g, '');
  }

  function isPlainObject(value) {
    return value !== null && typeof value === 'object' && Object.prototype.toString.call(value) === '[object Object]';
  }

  /* ============================================================
     VALIDATION -- pure, DOM-free, network-free, write-free
  ============================================================ */
  function validateAndNormalizeRow(row) {
    if (!isPlainObject(row)) return null;
    var rawId = row.dtId != null ? row.dtId : (row.dt_id != null ? row.dt_id : row['DT ID']);
    var rawContractor = row.contractor != null ? row.contractor : row.Contractor;
    var dtId = canonicalDtId(rawId);
    var key = normalizedKey(rawId);
    var contractor = String(rawContractor === null || rawContractor === undefined ? '' : rawContractor).trim();
    if (!dtId || !key || !contractor) return null;
    return { dtId: dtId, normalizedKey: key, contractor: contractor };
  }

  // Validates a raw row array -- either a remote payload's rows
  // (`{dtId|dt_id|"DT ID", contractor|Contractor}`) or an
  // already-canonical cache's `records` (which round-trip through the
  // same validator unchanged, since `dtId`/`normalizedKey` survive
  // re-canonicalization identically).
  //
  // The real List DT response is a mixed spreadsheet export: supported
  // SCM-HLG/SCM-LIM rows sit alongside ADT/MIM/legacy-DT-prefixed rows
  // (never SCM-shaped, so canonicalDtId() returns "" for them -- they are
  // not part of this shared cache's concern at all, see
  // validateAndNormalizeRow()'s SCM-only shape check) and occasional
  // blank spreadsheet rows. A single unsupported or blank row must never
  // reject the *entire* response -- that would make the shared cache
  // effectively impossible to populate from a real sheet. Unsupported/
  // blank/malformed rows are silently skipped; only two conditions still
  // reject the whole update:
  //   1. two accepted (SCM-shaped) rows whose normalized ids collide with
  //      *different* contractor names -- a genuine data-integrity
  //      conflict, never silently resolved by picking one;
  //   2. zero rows were accepted at all -- an entirely blank/unsupported
  //      response must never silently replace a previously good cache
  //      with an empty one.
  // Two rows colliding with the *same* contractor name are a harmless,
  // deterministic duplicate and are merged into one record.
  function validateContractorRows(rawRows) {
    if (!Array.isArray(rawRows)) return { ok: false, error: 'records is not an array' };

    var byKey = {};
    var order = [];
    for (var i = 0; i < rawRows.length; i++) {
      var row = validateAndNormalizeRow(rawRows[i]);
      if (!row) continue; // unsupported/blank/malformed row -- skipped, not fatal
      var existing = byKey[row.normalizedKey];
      if (existing && existing.contractor !== row.contractor) {
        return { ok: false, error: 'conflicting contractor for ' + row.normalizedKey };
      }
      if (!existing) order.push(row.normalizedKey);
      byKey[row.normalizedKey] = row;
    }

    if (order.length === 0) return { ok: false, error: 'no valid SCM records found' };

    return { ok: true, records: order.map(function (key) { return byKey[key]; }) };
  }

  /* ============================================================
     SHARED CACHE SCHEMA (hpal.contractors.v1)
  ============================================================ */
  function createContractorCache(records, options) {
    var opts = options || {};
    return {
      cacheVersion: CACHE_VERSION,
      source: typeof opts.source === 'string' ? opts.source : 'remote',
      fetchedAt: opts.fetchedAt || new Date().toISOString(),
      records: records,
    };
  }

  // Validates an already-parsed cache object (e.g. JSON.parse'd
  // localStorage content) -- checks cacheVersion and re-validates every
  // record through the same row validator remote payloads go through.
  function validateContractorCache(parsed) {
    if (!isPlainObject(parsed)) return { ok: false, error: 'cache is not an object' };
    if (parsed.cacheVersion !== CACHE_VERSION) return { ok: false, error: 'unsupported cacheVersion' };
    var check = validateContractorRows(parsed.records);
    if (!check.ok) return check;
    return {
      ok: true,
      cache: {
        cacheVersion: CACHE_VERSION,
        source: typeof parsed.source === 'string' ? parsed.source : 'remote',
        fetchedAt: typeof parsed.fetchedAt === 'string' && parsed.fetchedAt ? parsed.fetchedAt : null,
        records: check.records,
      },
    };
  }

  function getStorage(storageOverride) {
    if (storageOverride) return storageOverride;
    try {
      return root.localStorage || null;
    } catch (e) {
      return null;
    }
  }

  // Read-only: parses+validates the shared cache from localStorage.
  // Returns null (never throws) on missing/corrupted/invalid data --
  // never partially applies a bad cache.
  function readSharedContractorCache(storageOverride) {
    var storage = getStorage(storageOverride);
    if (!storage) return null;

    var raw;
    try {
      raw = storage.getItem(CACHE_KEY);
    } catch (e) {
      return null;
    }
    if (!raw) return null;

    var parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      return null;
    }

    var check = validateContractorCache(parsed);
    return check.ok ? check.cache : null;
  }

  // Validates `rawRows` (raw remote rows or already-canonical records --
  // both accepted) and writes the resulting cache to localStorage. Never
  // overwrites the existing cache with an invalid result: returns null
  // (touching nothing) if `rawRows` fails validation or storage is
  // unavailable/full.
  function writeSharedContractorCache(rawRows, options, storageOverride) {
    var storage = getStorage(storageOverride);
    if (!storage) return null;

    var check = validateContractorRows(rawRows);
    if (!check.ok) return null;

    var cache = createContractorCache(check.records, options);
    try {
      storage.setItem(CACHE_KEY, JSON.stringify(cache));
    } catch (e) {
      return null;
    }
    return cache;
  }

  /* ============================================================
     UPDATE EVENT -- dispatched by whichever side (Monitor or Report)
     just wrote a fresh cache, so the other side can reload and react.
     Never assumes a browser EventTarget exists (Node's plain `globalThis`
     has none) -- callers pass their own target explicitly; production
     code passes `window`, tests may pass a `new EventTarget()`.
  ============================================================ */
  function dispatchDirectoryUpdated(cache, eventTarget) {
    var target = eventTarget || (typeof root.dispatchEvent === 'function' ? root : null);
    if (!target || typeof target.dispatchEvent !== 'function') return false;
    var CustomEventCtor = (typeof root.CustomEvent === 'function') ? root.CustomEvent : null;
    if (!CustomEventCtor) return false;
    target.dispatchEvent(new CustomEventCtor(DIRECTORY_UPDATED_EVENT, {
      detail: {
        source: cache ? cache.source : null,
        recordCount: cache ? cache.records.length : 0,
        fetchedAt: cache ? cache.fetchedAt : null,
      },
    }));
    return true;
  }

  var core = {
    CACHE_KEY: CACHE_KEY,
    CACHE_VERSION: CACHE_VERSION,
    DIRECTORY_UPDATED_EVENT: DIRECTORY_UPDATED_EVENT,
    canonicalDtId: canonicalDtId,
    normalizedKey: normalizedKey,
    validateContractorRows: validateContractorRows,
    createContractorCache: createContractorCache,
    validateContractorCache: validateContractorCache,
    readSharedContractorCache: readSharedContractorCache,
    writeSharedContractorCache: writeSharedContractorCache,
    dispatchDirectoryUpdated: dispatchDirectoryUpdated,
  };

  root.HPALContractorDirectoryCore = core;
})(typeof globalThis !== 'undefined' ? globalThis : this);
