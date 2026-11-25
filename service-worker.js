// HPAL Production Monitor service worker -- offline-first application shell
// with a USER-APPROVED update lifecycle (v3.1.1 in-app update system).
//
// RELEASE IDENTITY. APP_VERSION and ASSET_REVISION below are GENERATED --
// never edit them by hand. Run, before every release:
//
//   node tests/tools/sync-service-worker-release.mjs
//
// APP_VERSION mirrors js/shared/app-version.js (the one canonical version
// source); ASSET_REVISION is a content hash of every APP_SHELL file.
// tests/service-worker.test.mjs fails if either is stale. Because both are
// part of this script's bytes, ANY release that changes a precached asset
// changes this file, which is the only thing browsers compare to detect a
// service-worker update. (v3.1.0 shipped changed Report modules without
// touching this file, so installed PWAs never saw it -- that is the gap
// this closes.) CACHE_NAME is derived from both, so each release precaches
// into its own, complete, never-mixed cache.
//
// LIFECYCLE.
//   install  -- precaches the complete APP_SHELL into this release's cache,
//               bypassing the HTTP cache (cache: 'reload'), then verifies
//               the precached js/shared/app-version.js really is
//               APP_VERSION. A stale/half-propagated deployment therefore
//               FAILS installation instead of being offered as an update.
//               Does NOT skipWaiting() on its own: the new release waits
//               until the user taps "Perbarui Sekarang / Update Now" in
//               Settings (SKIP_WAITING message). One exception -- the
//               one-time migration off a legacy (pre-updater) worker, which
//               has no Update Now button to offer: see
//               activeWorkerSupportsUserApprovedUpdates().
//   activate -- marks this cache as owned by an updater-aware worker,
//               deletes ONLY this app's obsolete application-shell caches
//               (CACHE_PREFIX), never another application's caches, and
//               claims open clients. It never touches localStorage,
//               IndexedDB, or any other persisted user data -- licenses,
//               preferences, contractor/personnel caches and the offline
//               write queue all live in localStorage, outside Cache Storage.
//   message  -- SKIP_WAITING (user approved the update) and GET_VERSION
//               (Settings asks a waiting worker which version it carries).
//               Message types are mirrored from
//               js/services/app-update-service.js's SW_MESSAGE
//               (test-enforced identical).
const APP_VERSION = 'v3.1.1';
const ASSET_REVISION = 'c81f5059824c';
const CACHE_PREFIX = 'hpal-production-monitor-';
const CACHE_NAME = `${CACHE_PREFIX}shell-${APP_VERSION}-${ASSET_REVISION}`;
const SW_MESSAGE_SKIP_WAITING = 'HPAL_SW_SKIP_WAITING';
const SW_MESSAGE_GET_VERSION = 'HPAL_SW_GET_VERSION';
const SW_MESSAGE_VERSION = 'HPAL_SW_VERSION';
// Written into a release's own cache when its worker ACTIVATES. Its
// presence tells a newer worker that the currently active one is
// updater-aware (i.e. its page offers Update Now), so the newer worker
// must wait for the user instead of activating itself.
const UPDATER_MARKER_URL = './__hpal-sw-updater-active__';
const VERSION_MARKER_URL = './js/shared/app-version.js';
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
  './js/services/app-update-service.js',
  './js/i18n/i18n.js',
  './js/i18n/locales/id.js',
  './js/i18n/locales/en.js',
  './js/shared/ore-classification.js',
  './js/shared/app-version.js',
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
  './js/pages/calculate/exact-hardcase-solver.js',
  // V3.0 Phase 7B -- the Recommendation Worker and its main-thread client
  // (this task's Section 10). recommendation-worker.js is referenced only
  // via `new URL(...)` inside recommendation-worker-client.js, never a
  // static `import ... from`, so it is NOT auto-discovered by the
  // import-graph completeness test in tests/service-worker.test.mjs --
  // listed here explicitly instead.
  './js/pages/calculate/recommendation-worker.js',
  './js/pages/calculate/recommendation-worker-client.js',
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

// True only when an active worker exists AND it is updater-aware (its
// release cache carries UPDATER_MARKER_URL). A legacy pre-updater worker
// (v3.0.1 and earlier -- cache 'hpal-production-monitor-v3.0.1-...', no
// marker) controls pages that have no Update Now button, so waiting for the
// user there would strand the update forever: the new worker activates
// itself once, exactly as every legacy release did, and from then on all
// future releases wait for the user.
async function activeWorkerSupportsUserApprovedUpdates() {
  if (!self.registration || !self.registration.active) return false;
  const keys = await caches.keys();
  for (const key of keys) {
    if (!key.startsWith(CACHE_PREFIX)) continue;
    const cache = await caches.open(key);
    if (await cache.match(UPDATER_MARKER_URL)) return true;
  }
  return false;
}

async function verifyPrecachedVersion(cache) {
  const response = await cache.match(VERSION_MARKER_URL);
  const text = response ? await response.text() : '';
  if (!text.includes(`'${APP_VERSION}'`)) {
    throw new Error(`Precached app-version.js does not declare ${APP_VERSION}; deployment not complete.`);
  }
}

async function handleInstall() {
  const waitForUser = await activeWorkerSupportsUserApprovedUpdates();
  // Same CACHE_NAME already present only when a previous worker had the
  // exact same release identity (worker-script-only change). That cache
  // may be the ACTIVE one, so a failed install must never delete it.
  const cacheExisted = await caches.has(CACHE_NAME);
  const cache = await caches.open(CACHE_NAME);
  try {
    // cache: 'reload' -- never precache a stale copy from the browser's
    // HTTP cache (GitHub Pages serves assets with max-age).
    await cache.addAll(APP_SHELL.map((url) => new Request(url, { cache: 'reload' })));
    await verifyPrecachedVersion(cache);
  } catch (error) {
    if (!cacheExisted) await caches.delete(CACHE_NAME);
    throw error;
  }
  if (!waitForUser) await self.skipWaiting();
}

async function handleActivate() {
  const cache = await caches.open(CACHE_NAME);
  await cache.put(UPDATER_MARKER_URL, new Response(APP_VERSION, { headers: { 'Content-Type': 'text/plain' } }));
  // The replacement is installed and now active -- only at this point are
  // this application's older shell caches removed. Caches outside
  // CACHE_PREFIX (another app on the same origin) are never touched.
  const keys = await caches.keys();
  await Promise.all(keys
    .filter((key) => key.startsWith(CACHE_PREFIX) && key !== CACHE_NAME)
    .map((key) => caches.delete(key)));
  await self.clients.claim();
}

self.addEventListener('install', (event) => {
  event.waitUntil(handleInstall());
});

self.addEventListener('activate', (event) => {
  event.waitUntil(handleActivate());
});

self.addEventListener('message', (event) => {
  const data = event.data || {};
  if (data.type === SW_MESSAGE_SKIP_WAITING) {
    const activation = self.skipWaiting();
    if (typeof event.waitUntil === 'function') event.waitUntil(activation);
    return;
  }
  if (data.type === SW_MESSAGE_GET_VERSION) {
    const port = event.ports && event.ports[0];
    if (port) port.postMessage({ type: SW_MESSAGE_VERSION, version: APP_VERSION, assetRevision: ASSET_REVISION });
  }
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
    // Local-first navigation (V2.5.1 startup audit Root Cause A): the
    // cached index.html -- always under the literal './index.html' key,
    // the same identity APP_SHELL's install-time precache uses -- is
    // served immediately with no network wait. v3.1.1: it is read from
    // THIS release's cache only, and the old background refresh that
    // wrote the freshly deployed index.html into the running release's
    // cache is gone -- it mixed a new index.html with the old release's
    // cached modules. New releases now arrive only as a complete,
    // verified precache via the update lifecycle above. Only when no
    // cached index exists at all (first-ever load) does this wait on the
    // network.
    event.respondWith((async () => {
      const cache = await caches.open(CACHE_NAME);
      const cachedResponse = await cache.match('./index.html');
      if (cachedResponse) return cachedResponse;

      try {
        return await fetch(request);
      } catch (error) {
        const anyCachedIndex = await caches.match('./index.html');
        if (anyCachedIndex) return anyCachedIndex;
        throw error;
      }
    })());
    return;
  }

  // Static assets: cache-first from THIS release's cache (never another
  // release's), falling back to the network for anything not precached.
  event.respondWith(
    caches.open(CACHE_NAME)
      .then((cache) => cache.match(request))
      .then((cached) => cached || fetch(request).then((response) => {
        if (!response || response.status !== 200 || response.type === 'opaque') return response;
        const copy = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
        return response;
      }))
  );
});
