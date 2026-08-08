// Settings page UI refinement tests (small follow-up to V2.3 Phase 8 --
// Simple Local License and Access Control): page title hierarchy, the
// Personnel Directory intro moving below Preferences/above Operational
// Data, and removal of the in-card license disclaimer text.
//
// Run with Node's built-in test runner:
//
//   node --test tests/settings-page-ui-refinement.test.mjs
//
// settings-page.js is a DOM-orchestration module (page.innerHTML,
// document.getElementById, ...) with no jsdom dependency available in
// this zero-npm-dependency project -- consistent with this codebase's
// existing convention (see tests/localization-coverage.test.mjs), the
// structural assertions below read the module's SOURCE TEXT rather than
// executing it. This is a valid proxy here specifically because
// buildMarkup()/buildOperationalMarkup() compose their output via plain
// top-to-bottom template-literal string concatenation with no runtime
// reordering -- source order IS render order for these functions.
// License/access BEHAVIOR itself (verification, tiers, guards) is
// untouched by this refinement and is covered by its own dedicated
// suites (tests/license-service.test.mjs,
// tests/router-license-guard.test.mjs,
// tests/personnel-directory-license-guard.test.mjs,
// tests/personnel-write-queue-license-guard.test.mjs), unchanged here.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import idCatalog from '../js/i18n/locales/id.js';
import enCatalog from '../js/i18n/locales/en.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SETTINGS_PAGE_SOURCE = readFileSync(path.join(ROOT, 'js/pages/settings/settings-page.js'), 'utf8');

describe('1. Settings large page title', () => {
  test('the header renders a single title wired to settings.pageTitle', () => {
    assert.match(SETTINGS_PAGE_SOURCE, /<h1 class="settings-title" data-i18n="settings\.pageTitle">/);
  });

  test('settings.pageTitle exists and is localized id/en', () => {
    assert.equal(idCatalog['settings.pageTitle'], 'Pengaturan');
    assert.equal(enCatalog['settings.pageTitle'], 'Settings');
  });

  test('the header no longer renders a separate "SETTINGS" eyebrow or a tier-dependent subtitle', () => {
    assert.doesNotMatch(SETTINGS_PAGE_SOURCE, /settings-eyebrow/);
    assert.doesNotMatch(SETTINGS_PAGE_SOURCE, /settings\.titleRestricted/);
    assert.doesNotMatch(SETTINGS_PAGE_SOURCE, /settings\.subtitleRestricted/);
  });
});

describe('2. FULL_ACCESS section order: Access -> Preferences -> Personnel Directory intro -> Operational Data', () => {
  // buildMarkup()'s own top-to-bottom composition order.
  const buildMarkupBody = SETTINGS_PAGE_SOURCE.slice(
    SETTINGS_PAGE_SOURCE.indexOf('function buildMarkup('),
    SETTINGS_PAGE_SOURCE.indexOf('function buildLicenseCardMarkup('),
  );
  // buildOperationalMarkup()'s own top-to-bottom composition order (only
  // ever invoked from inside buildMarkup()'s fullAccess-gated branch).
  const buildOperationalBody = SETTINGS_PAGE_SOURCE.slice(
    SETTINGS_PAGE_SOURCE.indexOf('function buildOperationalMarkup('),
    SETTINGS_PAGE_SOURCE.indexOf('function buildRoleManagementModalMarkup('),
  );

  test('Access precedes Preferences in buildMarkup()', () => {
    const accessIdx = buildMarkupBody.indexOf('settings.section.access');
    const preferencesIdx = buildMarkupBody.indexOf('settings.section.preferences');
    assert.ok(accessIdx >= 0 && preferencesIdx >= 0);
    assert.ok(accessIdx < preferencesIdx);
  });

  test('the Personnel Directory intro (settings.title/settings.subtitle) precedes the Operational Data label inside buildOperationalMarkup()', () => {
    const introHeadingIdx = buildOperationalBody.indexOf('data-i18n="settings.title"');
    const introDescriptionIdx = buildOperationalBody.indexOf('data-i18n="settings.subtitle"');
    const operationalLabelIdx = buildOperationalBody.indexOf('settings.section.operational');
    assert.ok(introHeadingIdx >= 0 && introDescriptionIdx >= 0 && operationalLabelIdx >= 0);
    assert.ok(introHeadingIdx < operationalLabelIdx);
    assert.ok(introDescriptionIdx < operationalLabelIdx);
  });

  test('Preferences (in buildMarkup) precedes the Personnel Directory intro/Operational Data (buildOperationalMarkup, invoked last)', () => {
    const preferencesIdx = buildMarkupBody.indexOf('settings.section.preferences');
    const operationalCallIdx = buildMarkupBody.indexOf('buildOperationalMarkup()');
    assert.ok(preferencesIdx >= 0 && operationalCallIdx >= 0);
    assert.ok(preferencesIdx < operationalCallIdx);
  });
});

describe('3-5. MONITOR_ONLY renders neither the Personnel Directory intro nor Operational Data', () => {
  test('buildOperationalMarkup() -- which owns the Personnel Directory heading, description, and the Operational Data label -- is declared once and called exactly once, from the fullAccess-gated ternary', () => {
    // Strips `//` line comments first (same convention as
    // tests/localization-coverage.test.mjs's stripCommentsAndTranslationCalls())
    // so an explanatory comment mentioning the function's name by name
    // does not get miscounted as a real reference.
    const codeOnly = SETTINGS_PAGE_SOURCE
      .split('\n')
      .filter((line) => !line.trim().startsWith('//'))
      .join('\n');

    const declarationMatches = [...codeOnly.matchAll(/function buildOperationalMarkup\(\)/g)];
    assert.equal(declarationMatches.length, 1, 'expected exactly one buildOperationalMarkup() declaration');

    const exactGatedCallSite = "${fullAccess ? buildOperationalMarkup() : ''}";
    const gatedCallOccurrences = codeOnly.split(exactGatedCallSite).length - 1;
    assert.equal(gatedCallOccurrences, 1, 'buildOperationalMarkup() must be invoked exactly once, directly inside the fullAccess ternary');

    // Total occurrences of "buildOperationalMarkup()" in actual code
    // (comments excluded) must be exactly declaration (1) + gated call
    // site (1) = 2 -- i.e. there is no OTHER, unconditional call anywhere
    // else in the module.
    const allOccurrences = (codeOnly.match(/buildOperationalMarkup\(\)/g) || []).length;
    assert.equal(allOccurrences, 2, 'buildOperationalMarkup() must never be called from anywhere other than the fullAccess ternary');
  });

  test('the Personnel Directory heading/description keys are not referenced anywhere in buildMarkup() outside of buildOperationalMarkup()', () => {
    const buildMarkupBody = SETTINGS_PAGE_SOURCE.slice(
      SETTINGS_PAGE_SOURCE.indexOf('function buildMarkup('),
      SETTINGS_PAGE_SOURCE.indexOf('function buildLicenseCardMarkup('),
    );
    // buildMarkup() itself must only ever reference the Personnel
    // Directory intro indirectly, via the gated buildOperationalMarkup()
    // call -- never inline its own copy of the heading/description.
    assert.doesNotMatch(buildMarkupBody, /data-i18n="settings\.title"/);
    assert.doesNotMatch(buildMarkupBody, /data-i18n="settings\.subtitle"/);
  });
});

describe('6-7. License disclaimer text is gone', () => {
  test('6. Indonesian catalog no longer has a license disclaimer key/text', () => {
    assert.equal('settings.license.limitationNote' in idCatalog, false);
    const hasDisclaimerText = Object.values(idCatalog).some((v) => v.includes('bukan proteksi anti-modifikasi'));
    assert.equal(hasDisclaimerText, false);
  });

  test('7. English catalog no longer has a license disclaimer key/text', () => {
    assert.equal('settings.license.limitationNote' in enCatalog, false);
    const hasDisclaimerText = Object.values(enCatalog).some((v) => v.includes('not strong tamper-proof protection'));
    assert.equal(hasDisclaimerText, false);
  });

  test('the License card markup no longer renders any disclaimer paragraph', () => {
    assert.doesNotMatch(SETTINGS_PAGE_SOURCE, /settings-license-limitation/);
    assert.doesNotMatch(SETTINGS_PAGE_SOURCE, /limitationNote/);
  });

  test('actual license status/error messages remain intact (not accidentally removed)', () => {
    assert.match(SETTINGS_PAGE_SOURCE, /settings-license-message/);
    assert.match(SETTINGS_PAGE_SOURCE, /settings\.license\.invalid/);
    assert.match(SETTINGS_PAGE_SOURCE, /settings\.license\.unlockedMessage/);
  });
});

describe('Dictionary parity is preserved', () => {
  test('id.js and en.js still carry the exact same key set', () => {
    const idKeys = Object.keys(idCatalog).sort();
    const enKeys = Object.keys(enCatalog).sort();
    assert.deepEqual(idKeys, enKeys);
  });
});
