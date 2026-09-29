// Focused tests for the canonical app-version source (js/shared/app-version.js)
// and its Settings page rendering (Settings header, above the ACCESS/License
// section, no card/container, rendered from the single canonical source
// rather than derived from service-worker.js's CACHE_NAME).
//
// settings-page.js is a DOM-orchestration module with no jsdom dependency
// available in this zero-npm-dependency project -- consistent with
// tests/settings-page-ui-refinement.test.mjs's own convention, the
// structural assertions below read the module's SOURCE TEXT rather than
// executing it.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { APP_VERSION, APP_NAME } from '../js/shared/app-version.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SETTINGS_PAGE_SOURCE = readFileSync(path.join(ROOT, 'js/pages/settings/settings-page.js'), 'utf8');
const SERVICE_WORKER_SOURCE = readFileSync(path.join(ROOT, 'service-worker.js'), 'utf8');

describe('app-version.js -- canonical version source', () => {
  test('exports the expected APP_NAME and APP_VERSION literals', () => {
    assert.equal(APP_NAME, 'HPAL Production Monitor');
    assert.equal(APP_VERSION, 'v3.0.1');
  });
});

describe('Settings page renders app name/version above the ACCESS section', () => {
  test('settings-page.js imports APP_NAME/APP_VERSION from the canonical source', () => {
    assert.match(
      SETTINGS_PAGE_SOURCE,
      /import\s*\{\s*APP_NAME,\s*APP_VERSION\s*\}\s*from\s*'\.\.\/\.\.\/shared\/app-version\.js';/,
    );
  });

  test('the header renders APP_NAME and APP_VERSION, not a hardcoded literal', () => {
    assert.match(
      SETTINGS_PAGE_SOURCE,
      /<p class="settings-app-version" id="settings-app-version">\$\{APP_NAME\} · \$\{APP_VERSION\}<\/p>/,
    );
  });

  test('the version line is not wrapped in a settings-card (no card/container)', () => {
    const headerBlock = SETTINGS_PAGE_SOURCE.slice(
      SETTINGS_PAGE_SOURCE.indexOf('<header class="settings-header">'),
      SETTINGS_PAGE_SOURCE.indexOf('</header>'),
    );
    assert.ok(headerBlock.includes('settings-app-version'));
    assert.doesNotMatch(headerBlock, /settings-card/);
  });

  test('the version line sits inside the header, before the ACCESS section label', () => {
    const versionIdx = SETTINGS_PAGE_SOURCE.indexOf('id="settings-app-version"');
    const accessIdx = SETTINGS_PAGE_SOURCE.indexOf('settings.section.access');
    assert.ok(versionIdx >= 0 && accessIdx >= 0);
    assert.ok(versionIdx < accessIdx, 'app version must render above the ACCESS/License section');
  });

  test('version is not derived from service-worker.js CACHE_NAME', () => {
    assert.doesNotMatch(SETTINGS_PAGE_SOURCE, /CACHE_NAME/);
  });
});

describe('app-version.js is precached for offline availability', () => {
  test('APP_SHELL lists js/shared/app-version.js', () => {
    assert.match(SERVICE_WORKER_SOURCE, /['"]\.\/js\/shared\/app-version\.js['"]/);
  });
});
