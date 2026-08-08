// V2.4 Phase 8: bumped once for the Calculate feature's runtime assets
// (below) -- evicts every older cache via the existing activate-time
// cleanup (no second version source; this is the ONE place a release's
// cache identity is declared).
const CACHE_NAME = 'hpal-production-monitor-v2.4.0-calculate';
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
  './js/pages/calculate/blending-recommendation.js',
  './js/pages/calculate/fleet-allocation.js',
  './js/pages/calculate/recommendation-ranking.js',
  './js/pages/calculate/recommendation-actions.js',
  './js/pages/calculate/planned-blend-recovery.js',
  './js/pages/calculate/hopper-pattern.js',
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
    event.respondWith(
      fetch(request)
        .then((response) => {
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put('./index.html', copy));
          return response;
        })
        .catch(() => caches.match('./index.html'))
    );
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
