const CACHE_NAME = 'hpal-production-monitor-v2.3.0-full-localization-appearance';
const APP_SHELL = [
  './',
  './index.html',
  './manifest.webmanifest',
  './contractor-assignment.js',
  './assets/css/app-shell.css',
  './assets/css/bottom-navigation.css',
  './assets/css/report-hync.css',
  './assets/css/settings.css',
  './js/app.js',
  './js/router.js',
  './js/components/bottom-navigation.js',
  './js/services/contractor-adapter.js',
  './js/services/contractor-directory-core.js',
  './js/services/contractor-directory-service.js',
  './js/services/personnel-directory-service.js',
  './js/services/personnel-write-queue.js',
  './js/services/app-preferences-service.js',
  './js/i18n/i18n.js',
  './js/i18n/locales/id.js',
  './js/i18n/locales/en.js',
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
