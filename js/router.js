// V2.0 hash router. ES module scope keeps every name below out of the
// global namespace so it cannot collide with Monitor's inline script.

const DEFAULT_ROUTE = 'monitor';
// Exact match only: "#/monitor", "#/report", "#/settings" — nothing else.
// A trailing segment, suffix, or extra characters (e.g. "#/monitor-extra",
// "#/report123", "#/settings/test") must fall through to the default route.
const ROUTE_PATTERN = /^#\/(monitor|report|settings)$/;

let currentRoute = null;
const listeners = new Set();

// V2.3 Phase 8 (Simple Local License and Access Control) -- route guards.
// One guard function per gated route, registered by app.js at bootstrap
// (registerRouteGuard('report', ...)). guardFn(route) returns true (allow)
// or false (deny); on deny, applyRoute() calls the guard's own onDeny(route)
// instead of activating the page, and never falls through to render it.
// This is a route-level guard only -- callers invoking a licensed page's
// functions directly (bypassing the router) are still independently
// blocked at the action boundary (see report-page.js/personnel-directory-
// service.js's own hasFullAccess() checks), per the "guard both layers"
// requirement.
const routeGuards = new Map();

export function registerRouteGuard(route, guardFn, onDeny) {
  routeGuards.set(route, { guardFn, onDeny });
}

function parseRoute(hash) {
  const match = ROUTE_PATTERN.exec(hash || '');
  return match ? match[1] : DEFAULT_ROUTE;
}

function applyRoute() {
  const resolved = parseRoute(window.location.hash);
  const normalizedHash = `#/${resolved}`;

  if (window.location.hash !== normalizedHash) {
    // Empty or unknown hash: redirect to the resolved route. This triggers
    // another hashchange, which re-enters applyRoute with a matching hash.
    window.location.hash = normalizedHash;
    return;
  }

  const guard = routeGuards.get(resolved);
  if (guard && !guard.guardFn(resolved)) {
    // The guard itself decides (and performs) the deny behavior -- e.g.
    // redirecting to #/settings and focusing the License card -- rather
    // than this module assuming any particular fallback route. It must
    // never redirect back to the same denied route, which would loop.
    guard.onDeny(resolved);
    return;
  }

  if (resolved === currentRoute) return;
  currentRoute = resolved;

  document.querySelectorAll('#app-pages > .app-page').forEach((page) => {
    page.classList.toggle('is-active', page.id === `page-${resolved}`);
  });

  listeners.forEach((fn) => fn(resolved));
}

export function onRouteChange(fn) {
  listeners.add(fn);
}

export function getCurrentRoute() {
  return currentRoute;
}

export function navigateTo(route) {
  window.location.hash = `#/${route}`;
}

export function initRouter() {
  window.addEventListener('hashchange', applyRoute);
  applyRoute();
}
