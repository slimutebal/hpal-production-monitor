// Canonical application identity/version source. Deliberately independent
// of service-worker.js's own CACHE_NAME (a cache-busting identifier, not a
// user-facing version) -- this is the only place the Settings page's
// version metadata is read from.
export const APP_VERSION = 'v3.0.0';
export const APP_NAME = 'HPAL Production Monitor';
