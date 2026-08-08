// router.js route-guard tests (V2.3 Phase 8, Simple Local License and
// Access Control) -- registerRouteGuard()/applyRoute() denial + redirect
// behavior, independent of any particular license implementation (a
// trivial in-test guard function stands in for licenseService.hasFullAccess()).
//
// Run with Node's built-in test runner:
//
//   node --test tests/router-license-guard.test.mjs
//
// router.js has module-level singleton state (currentRoute, the route
// listener set, the route guard map) -- each test below imports a FRESH
// module instance via a cache-busting query string so state never leaks
// between tests, mirroring the same concern every other *-service.js test
// file in this suite handles via beforeEach() resets (router.js has no
// exported reset function of its own, so a fresh import is the
// equivalent here).
//
// Minimal manual window/document mocks (no jsdom -- this project has zero
// npm dependencies): router.js's only DOM footprint is
// window.location.hash, window.addEventListener('hashchange', ...), and
// document.querySelectorAll('#app-pages > .app-page') returning elements
// with an `id` and a classList.toggle('is-active', bool).

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

let importCounter = 0;

function installMockDom(initialHash) {
  const hashChangeListeners = [];
  let hash = initialHash || '';

  const pageMonitor = { id: 'page-monitor', classList: { active: false, toggle(cls, force) { if (cls === 'is-active') this.active = force; } } };
  const pageReport = { id: 'page-report', classList: { active: false, toggle(cls, force) { if (cls === 'is-active') this.active = force; } } };
  const pageSettings = { id: 'page-settings', classList: { active: false, toggle(cls, force) { if (cls === 'is-active') this.active = force; } } };
  const pages = [pageMonitor, pageReport, pageSettings];

  globalThis.window = {
    location: {
      get hash() {
        return hash;
      },
      set hash(value) {
        const changed = value !== hash;
        hash = value;
        if (changed) hashChangeListeners.forEach((fn) => fn());
      },
    },
    addEventListener(type, fn) {
      if (type === 'hashchange') hashChangeListeners.push(fn);
    },
  };
  globalThis.document = {
    querySelectorAll(selector) {
      return selector === '#app-pages > .app-page' ? pages : [];
    },
  };

  return { pages, pageMonitor, pageReport, pageSettings };
}

async function freshRouter() {
  importCounter += 1;
  return import(`../js/router.js?router-guard-test-${importCounter}`);
}

describe('registerRouteGuard() + applyRoute() denial/redirect', () => {
  test('an unguarded route (monitor) activates normally', async () => {
    const dom = installMockDom('#/monitor');
    const { initRouter, getCurrentRoute } = await freshRouter();
    initRouter();
    assert.equal(getCurrentRoute(), 'monitor');
    assert.equal(dom.pageMonitor.classList.active, true);
  });

  test('a guard returning true allows the route through', async () => {
    const dom = installMockDom('#/report');
    const { initRouter, getCurrentRoute, registerRouteGuard } = await freshRouter();
    registerRouteGuard('report', () => true, () => {
      throw new Error('onDeny must not be called when the guard allows');
    });
    initRouter();
    assert.equal(getCurrentRoute(), 'report');
    assert.equal(dom.pageReport.classList.active, true);
  });

  test('a guard returning false denies the route and never activates its page', async () => {
    const dom = installMockDom('#/report');
    const { initRouter, getCurrentRoute, registerRouteGuard, navigateTo } = await freshRouter();
    let onDenyCalls = 0;
    registerRouteGuard('report', () => false, () => {
      onDenyCalls += 1;
      navigateTo('settings');
    });
    initRouter();

    assert.equal(onDenyCalls, 1);
    assert.equal(dom.pageReport.classList.active, false);
    // The guard's own onDeny redirected to #/settings -- applyRoute()
    // re-entered via the resulting hashchange and activated it normally,
    // since 'settings' itself carries no guard.
    assert.equal(getCurrentRoute(), 'settings');
    assert.equal(dom.pageSettings.classList.active, true);
  });

  test('deny-then-redirect does not loop -- the guard is evaluated exactly once per navigation attempt', async () => {
    const dom = installMockDom('#/monitor');
    const { initRouter, navigateTo, registerRouteGuard } = await freshRouter();
    let guardCalls = 0;
    registerRouteGuard('report', () => {
      guardCalls += 1;
      return false;
    }, () => navigateTo('settings'));
    initRouter();

    navigateTo('report');
    assert.equal(guardCalls, 1);
    assert.equal(dom.pageReport.classList.active, false);
    assert.equal(dom.pageSettings.classList.active, true);
  });

  test('settings and monitor are never guarded, even if a guard is registered for report only', async () => {
    const dom = installMockDom('#/settings');
    const { initRouter, getCurrentRoute, registerRouteGuard } = await freshRouter();
    registerRouteGuard('report', () => false, () => {});
    initRouter();
    assert.equal(getCurrentRoute(), 'settings');
    assert.equal(dom.pageSettings.classList.active, true);
  });

  test('an unknown/empty hash still redirects to the default route (monitor) even with a guard registered elsewhere', async () => {
    installMockDom('');
    const { initRouter, getCurrentRoute, registerRouteGuard } = await freshRouter();
    registerRouteGuard('report', () => false, () => {});
    initRouter();
    assert.equal(getCurrentRoute(), 'monitor');
  });
});
