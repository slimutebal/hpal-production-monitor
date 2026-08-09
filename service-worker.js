// V2.5.1: bumped once for the WHOLE Offline-First Cold Startup and
// Background Contractor Sync patch (startup audit -- local-first
// navigation below, plus the two vendor library files this release adds
// to APP_SHELL) -- evicts every older cache via the existing
// activate-time cleanup (no second version source; this is the ONE place
// a release's cache identity is declared).
const CACHE_NAME = 'hpal-production-monitor-v2.5.1-offline-first-startup';
const APP_SHELL = [
  './',
  './index.html',
  './manifest.webmanifest',
  './contractor-assignment.js',
  './assets/css/app-shell.css',
  './assets/css/bottom-navigation.css',
  './assets/css/report-hync.css',
  './assets/css/settings.css',
  './assets/css/calculate.css',
  // V2.5.1 -- SheetJS/Chart.js, relocated out of index.html's <head> (they
  // used to be ~700KB of blocking inline classic <script>s parsed/
  // executed on every cold start; see this task's Section 9). Precached
  // here so Monitor's lazy loader (ensureMonitorVendorLibraries() in
  // index.html) can still resolve them from cache during an offline
  // workbook operation, exactly as if they were still inline.
  './assets/vendor/xlsx.min.js',
  './assets/vendor/chart.umd.min.js',
  './js/app.js',
  './js/router.js',
  './js/components/bottom-navigation.js',
  './js/services/contractor-adapter.js',
  './js/services/contractor-directory-core.js',
  './js/services/contractor-directory-service.js',
  './js/services/personnel-directory-service.js',
  './js/services/personnel-write-queue.js',
  './js/services/app-preferences-service.js',
  './js/services/license-service.js',
  './js/i18n/i18n.js',
  './js/i18n/locales/id.js',
  './js/i18n/locales/en.js',
  './js/shared/ore-classification.js',
  './js/pages/report/report-page.js',
  './js/pages/report/report-state.js',
  './js/pages/report/report-utils.js',
  './js/pages/report/report-personnel.js',
  './js/pages/report/profiles/profile-registry.js',
  './js/pages/report/profiles/shared-report-profile.js',
  './js/pages/report/profiles/hync-profile.js',
  './js/pages/report/profiles/slnc-profile.js',
  './js/pages/report/profiles/report-workbook-dispatcher.js',
  './js/pages/report/profiles/esg-profile.js',
  './js/pages/report/profiles/esg-workbook-detector.js',
  './js/pages/report/profiles/adapters/esg-adapter-utils.js',
  './js/pages/report/profiles/adapters/esg-format-a-adapter.js',
  './js/pages/report/profiles/adapters/esg-format-b-adapter.js',
  './js/pages/settings/settings-page.js',
  './js/pages/settings/settings-personnel.js',
  // V2.4 Calculate -- calculate-page.js and its full transitive import
  // graph (verified against every "import" statement in
  // js/pages/calculate/*.js), so the feature ES modules resolve from
  // cache offline exactly as they do online. js/shared/ore-classification.js
  // above is shared with the Report shared-report-profile.js module.
  './js/pages/calculate/calculate-page.js',
  './js/pages/calculate/blend-calculator.js',
  './js/pages/calculate/calculate-validation.js',
  './js/pages/calculate/number-input.js',
  './js/pages/calculate/blending-recommendation.js',
  './js/pages/calculate/fleet-allocation.js',
  './js/pages/calculate/recommendation-ranking.js',
  './js/pages/calculate/recommendation-actions.js',
  './js/pages/calculate/planned-blend-recovery.js',
  './js/pages/calculate/hopper-pattern.js',
  './js/pages/calculate/operational-continuity.js',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-192.png',
  './icons/icon-maskable-512.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys
        .filter((key) => key !== CACHE_NAME)
        .map((key) => caches.delete(key))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;

  if (request.method !== 'GET') return;

  // Request lintas-origin (mis. Google Apps Script untuk sync data kontraktor) TIDAK PERNAH
  // di-cache dan selalu diteruskan langsung ke jaringan. Tanpa pengecualian ini, respons dari
  // Sheet akan ke-cache selamanya dan user berikutnya selalu dapat data kontraktor basi,
  // meski koneksi internet lancar.
  const requestUrl = new URL(request.url);
  if (requestUrl.origin !== self.location.origin) {
    event.respondWith(fetch(request));
    return;
  }

  if (request.mode === 'navigate') {
    // V2.5.1 -- local-first navigation (startup audit Root Cause A). The
    // previous strategy was network-first: it awaited a real network
    // round-trip on EVERY cold start before any HTML could be parsed,
    // even though a complete, valid cached index.html already existed --
    // only a network FAILURE fell back to cache; a network that was
    // merely slow (a re-establishing connection on a just-relaunched iOS
    // PWA, a degraded signal) was awaited in full, extending the white
    // screen for as long as that took.
    //
    // This is now cache-first with background revalidation: a cached
    // index.html (always read/written under the literal './index.html'
    // key -- the same identity APP_SHELL's own install-time precache
    // uses, so there is exactly one cached copy, never several under
    // different keys, per this task's Section 5) is served immediately
    // with no network wait at all. A network request is still always
    // issued independently, in the background via event.waitUntil(), to
    // refresh that same cache entry for the NEXT launch; its failure is
    // swallowed -- the user already has a working page, so a slow/absent
    // network must never be surfaced as an error here. Only when no
    // cached index exists at all (first-ever load, or a cleared cache)
    // does this fall back to actually waiting on the network, exactly
    // like the old behavior.
    event.respondWith((async () => {
      const cachedResponse = await caches.match('./index.html');

      const networkRefresh = fetch(request).then((response) => {
        if (response && response.status === 200) {
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put('./index.html', copy));
        }
        return response;
      });

      if (cachedResponse) {
        // Never make the navigation wait on this -- it exists purely to
        // keep the cache warm for the next cold start.
        event.waitUntil(networkRefresh.catch(() => {}));
        return cachedResponse;
      }

      // No cached index at all -- the only path left is to actually wait
      // for the network; if even that fails outright, try the cache one
      // more time (a concurrent install may have just populated it).
      return networkRefresh.catch(() => caches.match('./index.html'));
    })());
    return;
  }

  event.respondWith(
    caches.match(request)
      .then((cached) => cached || fetch(request).then((response) => {
        if (!response || response.status !== 200 || response.type === 'opaque') return response;
        const copy = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
        return response;
      }))
  );
});
