// Settings "Pembaruan Aplikasi / Application Update" section tests (v3.1.1).
//
// Run with Node's built-in test runner:
//
//   node --test tests/settings-app-update.test.mjs
//
// settings-page.js is a DOM-orchestration module and this project has no
// jsdom dependency -- consistent with tests/settings-page-ui-refinement.test.mjs
// and tests/app-version.test.mjs, the structural assertions here read the
// module's SOURCE TEXT (buildMarkup() composes its output by plain
// top-to-bottom template concatenation, so source order IS render order).
// The update LIFECYCLE itself is exercised behaviorally in
// tests/app-update-service.test.mjs.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import idCatalog from '../js/i18n/locales/id.js';
import enCatalog from '../js/i18n/locales/en.js';
import { UPDATE_STATUS, UPDATE_ERROR } from '../js/services/app-update-service.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = readFileSync(path.join(ROOT, 'js/pages/settings/settings-page.js'), 'utf8');
const CODE_ONLY = SOURCE.split(/\r?\n/).filter((line) => !line.trim().startsWith('//')).join('\n');
const SETTINGS_CSS = readFileSync(path.join(ROOT, 'assets/css/settings.css'), 'utf8');

function sliceBetween(startMarker, endMarker) {
  const start = SOURCE.indexOf(startMarker);
  const end = SOURCE.indexOf(endMarker, start + 1);
  assert.ok(start >= 0 && end > start, `could not slice ${startMarker} .. ${endMarker}`);
  return SOURCE.slice(start, end);
}

describe('Section placement: after Preferences, before Personnel Directory, in BOTH access tiers', () => {
  const buildMarkupBody = sliceBetween('function buildMarkup(', 'function buildLicenseCardMarkup(');

  test('the section label and card follow the Preferences cards and precede the Personnel Directory (buildOperationalMarkup)', () => {
    const preferencesIdx = buildMarkupBody.indexOf('settings.section.preferences');
    const appearanceIdx = buildMarkupBody.indexOf('settings-appearance-filter');
    const updateLabelIdx = buildMarkupBody.indexOf('data-i18n="settings.section.update"');
    const updateCardIdx = buildMarkupBody.indexOf('${buildUpdateCardMarkup()}');
    const operationalIdx = buildMarkupBody.indexOf('buildOperationalMarkup()');
    assert.ok(preferencesIdx >= 0 && appearanceIdx >= 0 && updateLabelIdx >= 0 && updateCardIdx >= 0 && operationalIdx >= 0);
    assert.ok(preferencesIdx < appearanceIdx && appearanceIdx < updateLabelIdx);
    assert.ok(updateLabelIdx < updateCardIdx && updateCardIdx < operationalIdx);
  });

  test('the card is rendered unconditionally (MONITOR_ONLY and FULL_ACCESS), exactly once, never behind the fullAccess ternary', () => {
    const calls = CODE_ONLY.match(/buildUpdateCardMarkup\(\)/g) || [];
    assert.equal(calls.length, 2, 'one declaration + one call');
    assert.match(buildMarkupBody, /\n\s*\$\{buildUpdateCardMarkup\(\)\}\n/);
    assert.doesNotMatch(CODE_ONLY, /fullAccess \? buildUpdateCardMarkup/);
  });

  test('its elements are collected and wired in the tier-independent part of collectElements()/wireEvents()', () => {
    const collectBody = sliceBetween('function collectElements(', 'function wireEvents(');
    const updateIdx = collectBody.indexOf('update: {');
    const gateIdx = collectBody.indexOf('if (!fullAccess) return base;');
    assert.ok(updateIdx >= 0 && gateIdx >= 0 && updateIdx < gateIdx);

    const wireBody = sliceBetween('function wireEvents(', 'function roleDef(');
    const checkIdx = wireBody.indexOf("els.update.checkBtn.addEventListener('click', handleUpdateCheckClick)");
    const applyIdx = wireBody.indexOf("els.update.applyBtn.addEventListener('click', handleUpdateApplyClick)");
    const wireGateIdx = wireBody.indexOf('if (!fullAccess) return;');
    assert.ok(checkIdx >= 0 && applyIdx >= 0 && checkIdx < wireGateIdx && applyIdx < wireGateIdx);
  });
});

describe('15. Access-tier rebuild keeps the update card consistent', () => {
  test('renderForAccessTier() re-renders the update card after every rebuild (state lives in the service, not the DOM)', () => {
    const body = sliceBetween('function renderForAccessTier(', 'function buildMarkup(');
    assert.match(body, /renderUpdateCard\(\);/);
    assert.ok(body.indexOf('wireEvents(fullAccess)') < body.indexOf('renderUpdateCard()'));
  });

  test('the controller subscription is registered once in initSettingsPage(), not per rebuild', () => {
    const initBody = sliceBetween('export function initSettingsPage(', 'function renderForAccessTier(');
    assert.equal((initBody.match(/appUpdate\.subscribe\(/g) || []).length, 1);
    const renderBody = sliceBetween('function renderForAccessTier(', 'function buildMarkup(');
    assert.doesNotMatch(renderBody, /appUpdate\.subscribe\(/);
  });

  test('a locale change re-renders the dynamic update text', () => {
    const initBody = sliceBetween('export function initSettingsPage(', 'function renderForAccessTier(');
    const localeBlock = initBody.slice(initBody.indexOf('onLocaleChange('), initBody.indexOf("window.addEventListener('online'"));
    assert.match(localeBlock, /renderUpdateCard\(\)/);
  });
});

describe('1. Installed version display', () => {
  test('the card renders APP_VERSION (canonical source) as the installed version', () => {
    assert.match(SOURCE, /<dd id="settings-update-installed">\$\{APP_VERSION\}<\/dd>/);
    assert.match(SOURCE, /u\.installed\.textContent = state\.installedVersion;/);
  });

  test('the latest-version row is hidden until the version is reliably known', () => {
    assert.match(SOURCE, /id="settings-update-latest-row" hidden/);
    assert.match(SOURCE, /u\.latestRow\.hidden = !state\.latestVersion;/);
  });
});

describe('Update Now -- Owner rule: one explicit click, no extra dialog, never automatic', () => {
  test('applyUpdate() has exactly one call site, inside handleUpdateApplyClick()', () => {
    const calls = CODE_ONLY.match(/appUpdate\.applyUpdate\(\)/g) || [];
    assert.equal(calls.length, 1);
    const handler = sliceBetween('function handleUpdateApplyClick(', 'function handleUpdateNetworkOnline(');
    assert.match(handler, /appUpdate\.applyUpdate\(\);/);
  });

  test('handleUpdateApplyClick is bound only to the Update Now button\'s click', () => {
    const refs = CODE_ONLY.match(/handleUpdateApplyClick/g) || [];
    assert.equal(refs.length, 2, 'declaration + the single applyBtn click binding');
  });

  test('no confirmation dialog is shown for the update (Owner clarification)', () => {
    const handler = sliceBetween('function handleUpdateApplyClick(', 'function handleUpdateNetworkOnline(');
    assert.doesNotMatch(handler, /confirm\(|showModal\(|modalConfirmHandler/);
  });

  test('Settings itself never reloads the page', () => {
    assert.doesNotMatch(CODE_ONLY, /location\.reload/);
  });

  test('the Update Now button is shown only when an update is READY (or being applied)', () => {
    assert.match(SOURCE, /id="settings-update-apply-btn" hidden/);
    assert.match(SOURCE, /const showApply = state\.status === UPDATE_STATUS\.READY \|\| state\.status === UPDATE_STATUS\.APPLYING;/);
  });

  test('opening Settings triggers the throttled automatic check', () => {
    const initBody = sliceBetween('export function initSettingsPage(', 'function renderForAccessTier(');
    const routeBlock = initBody.slice(initBody.indexOf('onRouteChange('));
    assert.match(routeBlock, /appUpdate\.autoCheck\(\);/);
  });

  test('the post-update confirmation is read once at startup', () => {
    const initBody = sliceBetween('export function initSettingsPage(', 'function renderForAccessTier(');
    assert.equal((initBody.match(/consumePostUpdateResult\(\)/g) || []).length, 1);
  });
});

describe('Localization -- required state labels (id) and English equivalents', () => {
  const REQUIRED_ID = {
    idle: 'Periksa Pembaruan',
    checking: 'Memeriksa pembaruan...',
    current: 'Aplikasi sudah versi terbaru',
    available: 'Pembaruan tersedia',
    downloading: 'Mengunduh pembaruan...',
    ready: 'Pembaruan siap dipasang',
    applying: 'Memasang pembaruan...',
    offline: 'Tidak ada koneksi internet',
    error: 'Pemeriksaan pembaruan gagal',
  };

  test('every required Indonesian state label is exactly as specified', () => {
    for (const [state, label] of Object.entries(REQUIRED_ID)) {
      assert.equal(idCatalog[`settings.update.state.${state}`], label, state);
    }
    assert.equal(idCatalog['settings.section.update'], 'Pembaruan Aplikasi');
    assert.equal(idCatalog['settings.update.applyButton'], 'Perbarui Sekarang');
  });

  test('English equivalents exist and differ from the Indonesian text', () => {
    assert.equal(enCatalog['settings.section.update'], 'Application Update');
    assert.equal(enCatalog['settings.update.applyButton'], 'Update Now');
    assert.equal(enCatalog['settings.update.state.idle'], 'Check for Updates');
    for (const state of Object.keys(REQUIRED_ID)) {
      const key = `settings.update.state.${state}`;
      assert.ok(enCatalog[key], key);
      assert.notEqual(enCatalog[key], idCatalog[key], key);
    }
  });

  test('every controller status and error code has a label/message in both locales', () => {
    for (const status of Object.values(UPDATE_STATUS)) {
      assert.ok(idCatalog[`settings.update.state.${status}`], `id state.${status}`);
      assert.ok(enCatalog[`settings.update.state.${status}`], `en state.${status}`);
    }
    const errorKeys = {
      [UPDATE_ERROR.NETWORK]: 'settings.update.error.network',
      [UPDATE_ERROR.INSTALL_FAILED]: 'settings.update.error.installFailed',
      [UPDATE_ERROR.APPLY_FAILED]: 'settings.update.error.applyFailed',
      [UPDATE_ERROR.NO_REGISTRATION]: 'settings.update.error.noRegistration',
    };
    for (const [code, key] of Object.entries(errorKeys)) {
      assert.ok(idCatalog[key] && enCatalog[key], key);
      assert.match(SOURCE, new RegExp(`\\[UPDATE_ERROR\\.\\w+\\]: '${key.replace(/\./g, '\\.')}'`), code);
    }
  });

  test('the notice templates carry their {version}/{target} placeholders in both locales', () => {
    for (const catalog of [idCatalog, enCatalog]) {
      assert.match(catalog['settings.update.notice.updated'], /\{version\}/);
      assert.match(catalog['settings.update.notice.notApplied'], /\{target\}/);
      assert.match(catalog['settings.update.notice.reloaded'], /\{version\}/);
    }
  });
});

describe('Styling reuses the existing Settings design system', () => {
  test('the card reuses settings-card / settings-sync-meta / settings-btn classes and the new CSS stays scoped to the update card', () => {
    const card = sliceBetween('function buildUpdateCardMarkup(', '// FULL_ACCESS-only markup');
    assert.match(card, /class="settings-card settings-update-card"/);
    assert.match(card, /class="settings-sync-meta"/);
    assert.match(card, /settings-btn settings-btn-secondary/);
    assert.match(card, /settings-btn settings-btn-primary/);
    const commentStart = SETTINGS_CSS.indexOf('Application Update card');
    const newRules = SETTINGS_CSS.slice(SETTINGS_CSS.indexOf('*/', commentStart) + 2);
    const selectors = newRules.match(/^[^\s/*}][^{}]*\{/gm) || [];
    assert.ok(selectors.length > 0);
    selectors.forEach((selector) => assert.match(selector, /^#page-settings \.settings-update-card/));
  });
});
