// Calculate page shell tests (V2.4 Phase 1 -- Calculate Page Shell,
// Routing, Navigation, and Access Control). See
// docs/V2.4_CALCULATE_AND_BLENDING_RECOMMENDATION_ARCHITECTURE.md.
//
// Run with Node's built-in test runner:
//
//   node --test tests/calculate-page.test.mjs
//
// calculate-page.js's own exported requireFullAccessForCalculateAction()
// is executed for real against the real license-service.js singleton
// (mock localStorage + _buildValidLicenseRecordForTests(), the same
// key-free pattern tests/personnel-directory-license-guard.test.mjs
// already establishes) and a minimal window.location.hash mock for
// router.js's navigateTo() -- no jsdom needed for either.
//
// app.js itself has real top-level side effects (document.addEventListener
// ('DOMContentLoaded', init) at module scope, a full DOM required
// throughout init()) and is therefore never executed directly by any test
// in this suite -- tests/bilingual-coverage.test.mjs already established
// the precedent of asserting on its SOURCE TEXT instead for exactly this
// reason; this file follows the same precedent for the calculate-specific
// wiring app.js owns (route guard registration, the shared
// license-removal redirect, and initCalculatePage() being called).

import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { initCalculatePage, requireFullAccessForCalculateAction } from '../js/pages/calculate/calculate-page.js';
import {
  initializeLicense,
  removeLicense,
  subscribeFullAccessAttention,
  _buildValidLicenseRecordForTests,
} from '../js/services/license-service.js';
import idCatalog from '../js/i18n/locales/id.js';
import enCatalog from '../js/i18n/locales/en.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const LICENSE_KEY = 'hpal.license.v1';

function createMockStorage() {
  const map = new Map();
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => { map.set(key, String(value)); },
    removeItem: (key) => { map.delete(key); },
  };
}

// router.js's navigateTo() only ever touches window.location.hash --
// same minimal mock shape tests/router-license-guard.test.mjs's
// installMockDom() already uses for the same reason.
function installMockWindow(initialHash) {
  let hash = initialHash || '';
  globalThis.window = {
    location: {
      get hash() { return hash; },
      set hash(value) { hash = value; },
    },
    addEventListener() {},
  };
  return { getHash: () => hash };
}

function installMockPage() {
  let html = '';
  return {
    get innerHTML() { return html; },
    set innerHTML(value) { html = value; },
    querySelectorAll: () => [],
  };
}

function goFullAccess() {
  globalThis.localStorage.setItem(LICENSE_KEY, JSON.stringify(_buildValidLicenseRecordForTests()));
  initializeLicense();
}

function goMonitorOnly() {
  removeLicense();
}

beforeEach(() => {
  globalThis.localStorage = createMockStorage();
});

describe('requireFullAccessForCalculateAction() -- action-boundary guard', () => {
  test('FULL_ACCESS: returns true, never navigates, never requests attention', () => {
    goFullAccess();
    const win = installMockWindow('#/calculate');
    let attentionCalls = 0;
    const unsubscribe = subscribeFullAccessAttention(() => { attentionCalls += 1; });

    const result = requireFullAccessForCalculateAction();

    unsubscribe();
    assert.equal(result, true);
    assert.equal(win.getHash(), '#/calculate');
    assert.equal(attentionCalls, 0);
  });

  test('MONITOR_ONLY: returns false, redirects to #/settings, requests attention with the "calculate-action" context', () => {
    goMonitorOnly();
    const win = installMockWindow('#/calculate');
    let receivedContext;
    const unsubscribe = subscribeFullAccessAttention((context) => { receivedContext = context; });

    const result = requireFullAccessForCalculateAction();

    unsubscribe();
    assert.equal(result, false);
    assert.equal(win.getHash(), '#/settings');
    assert.equal(receivedContext, 'calculate-action');
  });
});

describe('initCalculatePage() -- shell mount', () => {
  test('populates #page-calculate with the placeholder title/subtitle, using the shared .page-placeholder classes', () => {
    goFullAccess();
    installMockWindow('#/calculate');
    const page = installMockPage();
    globalThis.document = { getElementById: (id) => (id === 'page-calculate' ? page : null) };

    initCalculatePage();

    assert.match(page.innerHTML, /class="page-placeholder"/);
    assert.match(page.innerHTML, /class="page-placeholder__title"[^>]*data-i18n="calculate\.title"/);
    assert.match(page.innerHTML, /class="page-placeholder__subtitle"[^>]*data-i18n="calculate\.subtitle"/);
  });

  test('does nothing (no throw) when #page-calculate is not present in the document', () => {
    globalThis.document = { getElementById: () => null };
    assert.doesNotThrow(() => initCalculatePage());
  });

  test('mounting under MONITOR_ONLY never redirects or requests License attention on its own -- initialization is not itself a licensed action', () => {
    goMonitorOnly();
    const win = installMockWindow('#/calculate');
    const page = installMockPage();
    globalThis.document = { getElementById: (id) => (id === 'page-calculate' ? page : null) };
    let attentionCalls = 0;
    const unsubscribe = subscribeFullAccessAttention(() => { attentionCalls += 1; });

    initCalculatePage();

    unsubscribe();
    assert.equal(win.getHash(), '#/calculate', 'mounting must never change the current route on its own');
    assert.equal(attentionCalls, 0);
    // The shell still renders even though the ROUTE guard (app.js) is what
    // actually prevents a MONITOR_ONLY user from ever reaching this route
    // in the real app -- this module's own markup is tier-agnostic by
    // design (see its header comment).
    assert.match(page.innerHTML, /page-placeholder/);
  });
});

describe('Phase 1 non-goals -- shell contains no interactive controls or future-phase business logic', () => {
  const source = readFileSync(path.join(ROOT, 'js', 'pages', 'calculate', 'calculate-page.js'), 'utf8');

  test('buildMarkup() renders no form controls (no pile inputs, no fake Blend/Recommendation UI)', () => {
    const buildMarkupBody = source.slice(source.indexOf('function buildMarkup('), source.indexOf('// Action-boundary guard'));
    for (const tag of ['<input', '<button', '<select', '<textarea', '<form']) {
      assert.doesNotMatch(buildMarkupBody, new RegExp(tag), `buildMarkup() must not contain ${tag}`);
    }
  });

  test('the module performs no calculation and defines no Blend/Recommendation state', () => {
    for (const forbidden of ['classifyOre', 'calculateWeightedNi', 'findBlendRecommendations', 'localStorage', 'hopperPattern', 'targetNi']) {
      assert.doesNotMatch(source, new RegExp(forbidden, 'i'), `calculate-page.js must not yet reference ${forbidden}`);
    }
  });
});

describe('Localization keys (V2.4 Phase 1 minimum set)', () => {
  test('nav.calculate exists in both locales and is non-empty', () => {
    assert.ok(idCatalog['nav.calculate']);
    assert.ok(enCatalog['nav.calculate']);
  });

  test('calculate.title and calculate.subtitle exist in both locales and are non-empty', () => {
    for (const key of ['calculate.title', 'calculate.subtitle']) {
      assert.ok(idCatalog[key], `id.js missing ${key}`);
      assert.ok(enCatalog[key], `en.js missing ${key}`);
    }
  });

  test('calculate.subtitle text differs between id and en (a real translation, not a copy-paste placeholder)', () => {
    assert.notEqual(idCatalog['calculate.subtitle'], enCatalog['calculate.subtitle']);
  });
});

describe('app.js wiring (source-text -- app.js has top-level DOM side effects and is never executed directly, see header comment)', () => {
  const appJs = readFileSync(path.join(ROOT, 'js', 'app.js'), 'utf8');

  test('imports and calls initCalculatePage()', () => {
    assert.match(appJs, /import\s*\{\s*initCalculatePage\s*\}\s*from\s*'\.\/pages\/calculate\/calculate-page\.js'/);
    assert.match(appJs, /initCalculatePage\(\);/);
  });

  test('registers a FULL_ACCESS-only route guard for "calculate" using hasFullAccess()', () => {
    assert.match(appJs, /registerRouteGuard\(\s*\n?\s*'calculate',\s*\n?\s*\(\)\s*=>\s*hasFullAccess\(\)/);
  });

  test('the calculate route guard denies to #/settings and requests attention with context "route-calculate"', () => {
    const guardBlock = appJs.slice(appJs.indexOf("registerRouteGuard(\n    'calculate'"));
    assert.match(guardBlock, /navigateTo\('settings'\)/);
    assert.match(guardBlock, /requestFullAccessAttention\('route-calculate'\)/);
  });

  test('license removal while on Calculate is handled by the SAME shared subscription used for Report, not a duplicate one', () => {
    const subscribeCalls = appJs.match(/subscribeAccessChange\(/g) || [];
    assert.equal(subscribeCalls.length, 1, 'expected exactly one subscribeAccessChange() registration in app.js');
    const subscribeBlock = appJs.slice(appJs.indexOf('subscribeAccessChange('));
    assert.match(subscribeBlock, /route === 'report'/);
    assert.match(subscribeBlock, /route === 'calculate'/);
  });
});
