const CACHE_NAME = 'hpal-production-monitor-v1.7.0-unmatched-contractor-input';
const ENHANCEMENT_SCRIPT = './contractor-assignment.js';
const APP_SHELL = [
  './',
  './index.html',
  './manifest.webmanifest',
  ENHANCEMENT_SCRIPT,
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

async function injectContractorEnhancement(response) {
  if (!response) return response;

  const contentType = response.headers.get('content-type') || '';
  if (!contentType.includes('text/html')) return response;

  let html = await response.text();
  if (!html.includes('contractor-assignment.js')) {
    const scriptTag = `<script src="${ENHANCEMENT_SCRIPT}" defer></script>`;
    html = html.includes('</body>')
      ? html.replace('</body>', `${scriptTag}</body>`)
      : `${html}${scriptTag}`;
  }

  const headers = new Headers(response.headers);
  headers.delete('content-length');
  headers.delete('content-encoding');
  headers.delete('transfer-encoding');
  headers.delete('etag');

  return new Response(html, {
    status: response.status,
    statusText: response.statusText,
    headers
  });
}

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
        .then(async (response) => {
          const enhanced = await injectContractorEnhancement(response);
          const copy = enhanced.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put('./index.html', copy));
          return enhanced;
        })
        .catch(async () => {
          const cached = await caches.match('./index.html');
          return injectContractorEnhancement(cached);
        })
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