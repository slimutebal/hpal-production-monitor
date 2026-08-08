// Bottom navigation tests (V2.4 Phase 1 -- Calculate Page Shell, Routing,
// Navigation, and Access Control). No dedicated test file existed for
// js/components/bottom-navigation.js before this phase; this fills that
// gap for the two things Phase 1 changes: nav item order/visibility per
// access tier now that a SECOND fullAccessOnly item (Calculate) exists
// alongside Report, and live access-tier reactivity.
//
// Run with Node's built-in test runner:
//
//   node --test tests/bottom-navigation.test.mjs
//
// bottom-navigation.js touches document.getElementById()/.innerHTML --
// no jsdom in this zero-npm-dependency project (see
// tests/localization-coverage.test.mjs's header comment for the existing
// precedent). Rather than parsing the assigned innerHTML into real
// elements, this file captures the raw HTML STRING bottom-navigation.js
// assigns and asserts directly on it (data-route="..." substring order/
// presence) -- valid here because renderNavMarkup() builds that string via
// a single top-to-bottom NAV_ITEMS.filter().map().join(''), so string
// order IS render order (same reasoning tests/settings-page-ui-refinement.
// test.mjs's header comment already documents for buildMarkup()).
//
// license-service.js's exported hasFullAccess()/subscribeAccessChange()
// are the ONE production singleton -- unlike tests/license-service.
// test.mjs's own createLicenseService() tests, there is no per-test fresh
// instance available here because bottom-navigation.js imports the
// production singleton's bound exports directly (by design -- it must
// reflect the app's real access tier, not a test double). A
// subscribeAccessChange() listener registered by an earlier test's
// mountBottomNavigation() call therefore remains subscribed for the
// lifetime of this file's process and WILL fire again on a later test's
// removeLicense() call. This is harmless: every such stale listener
// recomputes and rewrites the exact same deterministic markup into
// whatever document.getElementById('bottom-navigation') resolves to AT
// CALL TIME (a global, not captured at subscribe time) -- i.e. THIS
// test's own mock nav element -- so the final asserted state is
// unaffected by however many stale listeners also fire alongside the
// fresh one this test just mounted.
//
// Only removeLicense() is used to exercise the LIVE-reactivity direction
// below (real, no key required, calls notify() unconditionally).
// verifyAndInstallLicense() cannot be exercised the same way without the
// real Owner-held plaintext key (by design -- see license-service.js's
// own header comment), so the "unlock live-reveals Calculate" direction
// is proven structurally instead (subscribeAccessChange(renderNavMarkup)
// is unconditional, so ANY tier notification -- up or down -- re-runs the
// exact same render function the FULL_ACCESS/MONITOR_ONLY tests below
// already prove is correct for either tier); reaching FULL_ACCESS itself
// is done cold, via _buildValidLicenseRecordForTests() + initializeLicense()
// (the same key-free pattern tests/personnel-directory-license-guard.
// test.mjs already establishes), not through a live notify().

import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { initializeLicense, removeLicense, _buildValidLicenseRecordForTests } from '../js/services/license-service.js';

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

// Minimal nav element: captures whatever renderNavMarkup() assigns to
// .innerHTML as a plain string, and answers the one querySelector() call
// renderNavMarkup() makes (for the currently-active item) with null --
// no test here depends on preserving active-route state across a rebuild.
function installMockNav() {
  let html = '';
  const nav = {
    get innerHTML() { return html; },
    set innerHTML(value) { html = value; },
    querySelector: () => null,
    querySelectorAll: () => [],
  };
  globalThis.document = { getElementById: (id) => (id === 'bottom-navigation' ? nav : null) };
  return nav;
}

let importCounter = 0;
async function freshBottomNav() {
  importCounter += 1;
  return import(`../js/components/bottom-navigation.js?bottom-nav-test-${importCounter}`);
}

function routesInOrder(html) {
  return [...html.matchAll(/data-route="([a-z]+)"/g)].map((m) => m[1]);
}

beforeEach(() => {
  globalThis.localStorage = createMockStorage();
});

describe('FULL_ACCESS nav order (V2.4 Phase 1 acceptance requirement)', () => {
  test('renders exactly Monitor, Calculate, Report, Settings in that order', async () => {
    globalThis.localStorage.setItem(LICENSE_KEY, JSON.stringify(_buildValidLicenseRecordForTests()));
    initializeLicense();

    const nav = installMockNav();
    const { mountBottomNavigation } = await freshBottomNav();
    mountBottomNavigation();

    assert.deepEqual(routesInOrder(nav.innerHTML), ['monitor', 'calculate', 'report', 'settings']);
  });
});

describe('MONITOR_ONLY nav visibility', () => {
  test('renders exactly Monitor, Settings -- Calculate and Report both fully absent, not merely disabled', async () => {
    removeLicense();

    const nav = installMockNav();
    const { mountBottomNavigation } = await freshBottomNav();
    mountBottomNavigation();

    assert.deepEqual(routesInOrder(nav.innerHTML), ['monitor', 'settings']);
    assert.doesNotMatch(nav.innerHTML, /data-route="calculate"/);
    assert.doesNotMatch(nav.innerHTML, /data-route="report"/);
  });
});

describe('Live license-removal reactivity (no reload)', () => {
  test('removing the license while mounted under FULL_ACCESS hides Calculate (and Report) immediately, without remounting', async () => {
    globalThis.localStorage.setItem(LICENSE_KEY, JSON.stringify(_buildValidLicenseRecordForTests()));
    initializeLicense();

    const nav = installMockNav();
    const { mountBottomNavigation } = await freshBottomNav();
    mountBottomNavigation();
    assert.deepEqual(routesInOrder(nav.innerHTML), ['monitor', 'calculate', 'report', 'settings']);

    removeLicense();
    assert.deepEqual(routesInOrder(nav.innerHTML), ['monitor', 'settings']);
  });
});

describe('Structural check -- one unconditional subscription drives both directions', () => {
  test('mountBottomNavigation() subscribes renderNavMarkup itself to every access-tier change (up or down), not just removal', () => {
    const source = readFileSync(path.join(ROOT, 'js', 'components', 'bottom-navigation.js'), 'utf8');
    assert.match(source, /subscribeAccessChange\(renderNavMarkup\)/);
  });
});

describe('Calculate nav item definition', () => {
  const source = readFileSync(path.join(ROOT, 'js', 'components', 'bottom-navigation.js'), 'utf8');

  test('Calculate is flagged fullAccessOnly, same mechanism as Report', () => {
    const calculateBlock = source.slice(source.indexOf("route: 'calculate'"), source.indexOf("route: 'report'"));
    assert.match(calculateBlock, /fullAccessOnly:\s*true/);
  });

  test('Calculate icon uses only rect/line/circle/polyline primitives -- no <path> arc data', () => {
    const calculateBlock = source.slice(source.indexOf("route: 'calculate'"), source.indexOf("route: 'report'"));
    assert.doesNotMatch(calculateBlock, /<path/);
  });
});
