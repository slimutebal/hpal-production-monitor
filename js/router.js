// V2.0 hash router. ES module scope keeps every name below out of the
// global namespace so it cannot collide with Monitor's inline script.

const DEFAULT_ROUTE = 'monitor';
// Exact match only: "#/monitor", "#/report", "#/settings" — nothing else.
// A trailing segment, suffix, or extra characters (e.g. "#/monitor-extra",
// "#/report123", "#/settings/test") must fall through to the default route.
const ROUTE_PATTERN = /^#\/(monitor|report|settings)$/;

let currentRoute = null;
const listeners = new Set();

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
