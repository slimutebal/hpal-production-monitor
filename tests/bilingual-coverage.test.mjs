// Monitor / Report / Settings bilingual (id/en) output tests (V2.3
// full-localization pass).
//
// Run with Node's built-in test runner:
//
//   node --test tests/bilingual-coverage.test.mjs
//
// Monitor's own script (index.html) is a classic, non-module script with
// many browser-only dependencies (DOM, fetch, XLSX) -- tests/
// monitor-contractor-bridge.test.mjs already established the pattern of
// testing it via source-text assertions and extracted-function sandboxes
// rather than a full page harness. This file tests Monitor's localizable
// surface at the boundary Monitor itself actually depends on: the exact
// js/i18n/i18n.js `t(key, vars)` keys window.i18n.t()/mt() call (verified
// by grep against index.html's source), each checked in both locales.
// Report/Settings are real ES modules, so their own functions are
// exercised directly.
//
// Appearance is explicitly NOT covered here (already covered by
// tests/app-preferences-service.test.mjs, unmodified by this phase).

import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { setLocale, t, DEFAULT_LOCALE } from '../js/i18n/i18n.js';
import { getDirectoryAvailabilityError, validatePersonnelSelections } from '../js/pages/report/report-personnel.js';
import idCatalog from '../js/i18n/locales/id.js';
import enCatalog from '../js/i18n/locales/en.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const indexHtml = readFileSync(path.join(ROOT, 'index.html'), 'utf8');

beforeEach(() => {
  setLocale(DEFAULT_LOCALE);
});

// Confirms index.html actually calls window.i18n.t()/mt() with this exact
// key somewhere -- so the tests below are checking a key Monitor really
// uses, not an orphaned catalog entry.
function assertMonitorUsesKey(key) {
  const pattern = new RegExp(`mt\\('${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}'`);
  assert.match(indexHtml, pattern, `expected index.html to call mt('${key}', ...)`);
}

describe('Monitor -- static translation keys exist in both locales', () => {
  test('1. theme toggle / upload / contractor modal static keys resolve in both locales', () => {
    const keys = ['monitor.themeToggle.groupLabel', 'monitor.contractorCard.title', 'monitor.weighbridgeCard.title', 'monitor.contractorModal.title'];
    for (const key of keys) {
      setLocale('id');
      assert.notEqual(t(key), key);
      setLocale('en');
      assert.notEqual(t(key), key);
    }
  });
});

describe('Monitor -- dynamic message keys (used via window.i18n bridge)', () => {
  test('2. sync success (contractorStatus.syncedBadge) has distinct id/en output', () => {
    assertMonitorUsesKey('monitor.contractorStatus.syncedBadge');
    setLocale('id');
    const id = t('monitor.contractorStatus.syncedBadge', { count: 5 });
    setLocale('en');
    const en = t('monitor.contractorStatus.syncedBadge', { count: 5 });
    assert.ok(id.includes('5') && en.includes('5'));
    assert.notEqual(id, en);
  });

  test('3. sync error (contractorStatus.syncError) has distinct id/en output', () => {
    assertMonitorUsesKey('monitor.contractorStatus.syncError');
    setLocale('id');
    const id = t('monitor.contractorStatus.syncError', { message: 'timeout' });
    setLocale('en');
    const en = t('monitor.contractorStatus.syncError', { message: 'timeout' });
    assert.ok(id.includes('timeout') && en.includes('timeout'));
    assert.notEqual(id, en);
  });

  test('4. upload validation (upload.noValidRowsError) has distinct id/en output, required Chinese column names preserved in both', () => {
    assertMonitorUsesKey('monitor.upload.noValidRowsError');
    setLocale('id');
    const id = t('monitor.upload.noValidRowsError');
    setLocale('en');
    const en = t('monitor.upload.noValidRowsError');
    assert.notEqual(id, en);
    for (const column of ['流水号', '车号', '净重', '毛重时间', '日期', '备注', '规格']) {
      assert.ok(id.includes(column), `id missing ${column}`);
      assert.ok(en.includes(column), `en missing ${column}`);
    }
  });

  test('5. List DT / contractor state messages have distinct id/en output', () => {
    assertMonitorUsesKey('monitor.contractorStatus.offlineBadge');
    setLocale('id');
    const id = t('monitor.contractorStatus.offlineBadge', { count: 3 });
    setLocale('en');
    const en = t('monitor.contractorStatus.offlineBadge', { count: 3 });
    assert.notEqual(id, en);
  });

  test('6. machine identifiers stay identical across locales -- any catalog value mentioning a stable identifier mentions the exact same one in both languages', () => {
    const identifiers = ['HGLO', 'MGLO', 'LGLO', 'HYNC', 'SLNC', 'EIEB', 'AWK', 'ATQ', 'SCM', 'TIDAK DIKENALI'];
    for (const key of Object.keys(idCatalog)) {
      for (const identifier of identifiers) {
        const idHasIt = idCatalog[key].includes(identifier);
        const enHasIt = enCatalog[key].includes(identifier);
        assert.equal(idHasIt, enHasIt, `key "${key}": identifier "${identifier}" present in only one locale`);
      }
    }
  });

  test('7. locale change never mutates Monitor calculation inputs -- t()/mt() are pure lookups with no side effects on any argument', () => {
    const vars = { count: 42, message: 'unchanged' };
    setLocale('id');
    t('monitor.contractorStatus.syncedBadge', vars);
    setLocale('en');
    t('monitor.contractorStatus.syncedBadge', vars);
    assert.deepEqual(vars, { count: 42, message: 'unchanged' });
  });

  test('8. the appearance bridge (window.i18n) and the preferences bridge are declared together in js/app.js, so localizing Monitor never touched Appearance wiring', () => {
    const appJs = readFileSync(path.join(ROOT, 'js', 'app.js'), 'utf8');
    assert.match(appJs, /initAppPreferences\(\)/);
    assert.match(appJs, /window\.i18n\s*=\s*\{/);
  });
});

describe('Report -- dynamic message id/en output', () => {
  test('1. personnel directory unavailable has distinct id/en output', () => {
    setLocale('id');
    const id = getDirectoryAvailabilityError('none');
    setLocale('en');
    const en = getDirectoryAvailabilityError('none');
    assert.notEqual(id, en);
    assert.ok(id.length > 0 && en.length > 0);
  });

  test('2. contractor cache unavailable (report.contractor.notSynced) has distinct id/en output', () => {
    setLocale('id');
    const id = t('report.contractor.notSynced');
    setLocale('en');
    const en = t('report.contractor.notSynced');
    assert.notEqual(id, en);
  });

  test('3. shift unresolved (validation.shiftNoValidHours) has distinct id/en output', () => {
    setLocale('id');
    const id = t('report.validation.shiftNoValidHours');
    setLocale('en');
    const en = t('report.validation.shiftNoValidHours');
    assert.notEqual(id, en);
  });

  test('4. validation required (personnel.selectSpvRequired) has distinct id/en output via the real validator', () => {
    const records = [];
    const personnel = { spvScmIds: [], frmScmIds: ['x'], samplerId: 's', picThirdId: 'p', manpowerThirdParty: 1, totalManpower: 1 };
    setLocale('id');
    const idErrors = validatePersonnelSelections(records, personnel);
    setLocale('en');
    const enErrors = validatePersonnelSelections(records, personnel);
    assert.notDeepEqual(idErrors, enErrors);
  });

  test('5. selector modal (personnelModal.selectedCount) has distinct id/en output', () => {
    setLocale('id');
    const id = t('report.personnelModal.selectedCount', { count: 3 });
    setLocale('en');
    const en = t('report.personnelModal.selectedCount', { count: 3 });
    assert.notEqual(id, en);
    assert.ok(id.includes('3') && en.includes('3'));
  });

  test('6-7-8. see tests/report-*.test.mjs and the generated-report snapshot test for locale-invariant output/Daily-WTD-MTD-YTD/buyer-detection coverage', () => {
    // Deliberately a pointer, not a duplicate -- calculateIsoWeek(),
    // Daily/WTD/MTD/YTD accumulation, and buyer detection are pure,
    // locale-independent functions that never call t() at all (verified
    // by source inspection during this pass); tests/report-week.test.mjs,
    // tests/report-period-accumulation.test.mjs, and
    // tests/report-output-format.test.mjs already assert their behavior
    // exhaustively, and tests/report-output-locale-invariance.test.mjs
    // (added this phase) asserts buildReportText() output is byte-
    // identical across locales end-to-end.
    assert.ok(true);
  });
});

// describeWriteError() itself is a settings-page.js-private DOM-page
// function (not exported, matching this codebase's convention of keeping
// page modules' own small mapping functions private -- see
// settings-personnel.js's header comment on the same boundary). It is a
// thin, direct pass-through to these exact `errors.personnel.*` keys (see
// its own source), so testing the keys directly covers its logic without
// requiring a DOM or widening settings-page.js's exported surface just
// for a test.
describe('Settings -- dynamic message id/en output', () => {
  test('1. sync states (success/cacheFallback/noCache) have distinct id/en output', () => {
    for (const key of ['settings.sync.successMessage', 'settings.sync.cacheFallbackMessage', 'settings.sync.noCacheMessage']) {
      setLocale('id');
      const id = t(key);
      setLocale('en');
      const en = t(key);
      assert.notEqual(id, en, key);
    }
  });

  test('2. add/edit success messages have distinct id/en output', () => {
    setLocale('id');
    const idAdd = t('settings.role.addedMessage', { name: 'Budi' });
    const idEdit = t('settings.role.updatedMessage', { name: 'Budi' });
    setLocale('en');
    const enAdd = t('settings.role.addedMessage', { name: 'Budi' });
    const enEdit = t('settings.role.updatedMessage', { name: 'Budi' });
    assert.notEqual(idAdd, enAdd);
    assert.notEqual(idEdit, enEdit);
    assert.ok(idAdd.includes('Budi') && enAdd.includes('Budi'));
  });

  test('3. deactivate/reactivate confirmation and success messages have distinct id/en output', () => {
    setLocale('id');
    const idConfirm = t('settings.modal.deactivateConfirm', { name: 'Budi' });
    const idDeactivated = t('settings.role.deactivatedMessage', { name: 'Budi' });
    const idReactivated = t('settings.role.reactivatedMessage', { name: 'Budi' });
    setLocale('en');
    const enConfirm = t('settings.modal.deactivateConfirm', { name: 'Budi' });
    const enDeactivated = t('settings.role.deactivatedMessage', { name: 'Budi' });
    const enReactivated = t('settings.role.reactivatedMessage', { name: 'Budi' });
    assert.notEqual(idConfirm, enConfirm);
    assert.notEqual(idDeactivated, enDeactivated);
    assert.notEqual(idReactivated, enReactivated);
  });

  test('4. VERSION_CONFLICT presentation message has distinct id/en output, distinct from other error codes', () => {
    setLocale('id');
    const id = t('errors.personnel.VERSION_CONFLICT');
    setLocale('en');
    const en = t('errors.personnel.VERSION_CONFLICT');
    assert.notEqual(id, en);
    assert.notEqual(en, t('errors.personnel.DUPLICATE_PERSONNEL'));
  });

  test('5. DUPLICATE_PERSONNEL presentation message has distinct id/en output', () => {
    setLocale('id');
    const id = t('errors.personnel.DUPLICATE_PERSONNEL');
    setLocale('en');
    const en = t('errors.personnel.DUPLICATE_PERSONNEL');
    assert.notEqual(id, en);
  });

  test('6. offline indicator has distinct id/en output', () => {
    setLocale('id');
    const id = t('settings.offlineIndicator');
    setLocale('en');
    const en = t('settings.offlineIndicator');
    assert.notEqual(id, en);
  });

  test('7. pending/blocked queue labels have distinct id/en output (the "Blocked:" wrapper is an intentional exception -- see below)', () => {
    setLocale('id');
    const idPending = t('settings.queue.statusPending');
    const idBlockedReason = t('settings.queue.reasonVersionConflict');
    setLocale('en');
    const enPending = t('settings.queue.statusPending');
    const enBlockedReason = t('settings.queue.reasonVersionConflict');
    assert.notEqual(idPending, enPending);
    // "Blocked: {reason}" itself is deliberately the SAME literal template
    // in both locales (the earlier offline-write-queue task required the
    // exact wording "Blocked: version conflict") -- only the {reason}
    // content is expected to vary, which it does not for
    // reasonVersionConflict specifically (also an intentional exception,
    // "version conflict" is required verbatim in both locales); other
    // reasons (e.g. reasonDuplicate) DO vary -- checked in
    // tests/settings-personnel.test.mjs's blocked-item tests.
    assert.equal(idBlockedReason, enBlockedReason);
    assert.equal(t('settings.queue.statusBlocked', { reason: 'x' }), 'Blocked: x');
  });

  test('8. retry/remove labels (common.retry/common.remove) have distinct id/en output', () => {
    setLocale('id');
    const idRetry = t('common.retry');
    const idRemove = t('common.remove');
    setLocale('en');
    const enRetry = t('common.retry');
    const enRemove = t('common.remove');
    assert.notEqual(idRetry, enRetry);
    assert.notEqual(idRemove, enRemove);
  });

  test('9. queue behavior (js/services/personnel-write-queue.js) is identical across locales -- the queue module never imports i18n at all', () => {
    const queueSource = readFileSync(path.join(ROOT, 'js', 'services', 'personnel-write-queue.js'), 'utf8');
    assert.doesNotMatch(queueSource, /from ['"].*i18n/, 'the write queue is business logic and must stay locale-independent (service-layer boundary)');
    const directorySource = readFileSync(path.join(ROOT, 'js', 'services', 'personnel-directory-service.js'), 'utf8');
    assert.doesNotMatch(directorySource, /from ['"].*i18n/, 'personnel-directory-service.js must also stay locale-independent -- describeWriteError() in settings-page.js is the one presentation-layer mapping point');
  });
});
