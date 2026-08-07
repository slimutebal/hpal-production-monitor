// Application-level preferences: locale + appearance (V2.3 Phase 7,
// Language and Localization / Appearance -- see
// docs/V2.3_AUTO_WEEK_AND_PERSONNEL_DIRECTORY_ARCHITECTURE.md sections 12-14).
//
// Owns the one shared storage key (`hpal.preferences.v1`, section 14.1)
// for BOTH locale and appearance -- js/i18n/i18n.js depends on this module
// for locale persistence (one-directional: this module never imports
// i18n.js), and Settings' Appearance card depends on it for theme
// persistence/application. Stateless read-modify-write against storage on
// every call, same posture as js/services/personnel-write-queue.js --
// no long-lived in-memory cache to go stale across the module/non-module
// boundary this file straddles (see below).
//
// CROSS-BOUNDARY NOTE: index.html's own Monitor theme toggle is a classic
// (non-module) inline <script>, so it cannot `import` this file. Both
// sides instead agree on the exact same storage key/shape and the same
// `hpal:preferences-changed` window CustomEvent (dispatched by
// setAppearance()/setLocale()/the system dark-mode listener below, and
// listened for by Monitor's inline script) -- this is what "unify the
// current theme behavior... so all of them read from and respond to the
// same single resolved theme state" (architecture section 13.2) means in
// practice without rewriting Monitor's inline script into a module.
const STORAGE_KEY = 'hpal.preferences.v1';
const SCHEMA_VERSION = 1;

export const DEFAULT_LOCALE = 'id';
export const DEFAULT_APPEARANCE = 'auto';
export const VALID_LOCALES = ['id', 'en'];
export const VALID_APPEARANCES = ['dark', 'light', 'auto'];

// Matches index.html's own --bg-base values (dark: #0a0e1a, light:
// #eef2f7) exactly -- the single source of truth for these two colors is
// now this constant; index.html's inline script reads the resolved value
// this module writes to #metaThemeColor rather than hardcoding them a
// second time (see applyAppearance() below).
const META_THEME_COLOR = { dark: '#0a0e1a', light: '#eef2f7' };

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function getStorage() {
  try {
    return globalThis.localStorage || null;
  } catch (_) {
    return null;
  }
}

function createDefaultPreferences() {
  return { schemaVersion: SCHEMA_VERSION, locale: DEFAULT_LOCALE, appearance: DEFAULT_APPEARANCE };
}

/* ============================================================
   SCHEMA VALIDATION -- pure, DOM-free, network-free
============================================================ */
export function validatePreferencesShape(raw) {
  if (!isPlainObject(raw)) return { ok: false, error: 'preferences is not an object' };
  if (raw.schemaVersion !== SCHEMA_VERSION) return { ok: false, error: 'unsupported schemaVersion' };
  if (!VALID_LOCALES.includes(raw.locale)) return { ok: false, error: 'invalid locale' };
  if (!VALID_APPEARANCES.includes(raw.appearance)) return { ok: false, error: 'invalid appearance' };
  return { ok: true };
}

/* ============================================================
   LOAD / SAVE -- a corrupted/malformed stored value safely resets to
   defaults, never throws, same posture as every other *-service.js cache
   loader in this codebase (e.g. personnel-directory-service.js's
   loadCachedPersonnelDirectory()).
============================================================ */
export function loadPreferences() {
  const storage = getStorage();
  if (!storage) return createDefaultPreferences();

  let raw;
  try {
    raw = storage.getItem(STORAGE_KEY);
  } catch (_) {
    return createDefaultPreferences();
  }
  if (!raw) return createDefaultPreferences();

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (_) {
    return createDefaultPreferences();
  }

  const check = validatePreferencesShape(parsed);
  if (!check.ok) return createDefaultPreferences();

  return { schemaVersion: parsed.schemaVersion, locale: parsed.locale, appearance: parsed.appearance };
}

function savePreferences(prefs) {
  const storage = getStorage();
  if (!storage) return false;
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(prefs));
  } catch (_) {
    return false;
  }
  return true;
}

// Alias kept deliberately separate from loadPreferences() even though it
// does the same thing today -- callers that only ever want to READ
// (Settings rendering, i18n.js's initI18n()) read `getPreferences()`;
// `loadPreferences()` is the name used where the read-modify-write
// mutating functions below re-read current state before patching one field.
export function getPreferences() {
  return loadPreferences();
}

/* ============================================================
   THEME RESOLUTION + APPLICATION
============================================================ */
function systemPrefersDark() {
  try {
    if (typeof globalThis.matchMedia !== 'function') return true;
    return globalThis.matchMedia('(prefers-color-scheme: dark)').matches;
  } catch (_) {
    return true;
  }
}

// 'auto' resolves via the OS/browser preference (falls back to dark if
// matchMedia is unavailable, matching index.html's own existing
// resolveTheme() fallback) -- 'dark'/'light' always resolve to themselves
// regardless of the system setting.
export function resolveAppearance(appearance) {
  if (appearance === 'light') return 'light';
  if (appearance === 'dark') return 'dark';
  return systemPrefersDark() ? 'dark' : 'light';
}

// The one DOM-touching export in this module (besides the matchMedia
// listener below) -- sets `data-theme` on <html> (the exact attribute
// index.html's own CSS already keys `:root, html[data-theme="dark"]` /
// `html[data-theme="light"]` off of, so this needs no new CSS anywhere)
// and updates the PWA theme-color meta tag. No-ops safely outside a
// browser (Node tests).
export function applyAppearance(appearance) {
  const resolved = resolveAppearance(appearance);
  if (typeof document !== 'undefined' && document.documentElement) {
    document.documentElement.setAttribute('data-theme', resolved);
    const metaColor = typeof document.getElementById === 'function' ? document.getElementById('metaThemeColor') : null;
    if (metaColor) metaColor.setAttribute('content', META_THEME_COLOR[resolved]);
  }
  return resolved;
}

/* ============================================================
   PUB/SUB + CROSS-BOUNDARY EVENT BRIDGE
============================================================ */
const listeners = new Set();

export function onPreferencesChange(callback) {
  listeners.add(callback);
  return () => listeners.delete(callback);
}

function dispatchGlobalEvent(prefs) {
  try {
    if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function' && typeof CustomEvent !== 'undefined') {
      window.dispatchEvent(new CustomEvent('hpal:preferences-changed', { detail: prefs }));
    }
  } catch (_) {
    // Ignored -- notifying other tabs/scripts is best-effort, never
    // allowed to break the preference change itself.
  }
}

function notify(prefs) {
  listeners.forEach((fn) => {
    try {
      fn(prefs);
    } catch (_) {
      // A misbehaving subscriber must never break preference persistence
      // for every other subscriber.
    }
  });
  dispatchGlobalEvent(prefs);
}

/* ============================================================
   WRITE API
============================================================ */
export function setLocale(locale) {
  if (!VALID_LOCALES.includes(locale)) return getPreferences();
  const next = { ...loadPreferences(), locale };
  savePreferences(next);
  notify(next);
  return next;
}

export function setAppearance(appearance) {
  if (!VALID_APPEARANCES.includes(appearance)) return getPreferences();
  const next = { ...loadPreferences(), appearance };
  savePreferences(next);
  applyAppearance(next.appearance);
  notify(next);
  return next;
}

/* ============================================================
   BOOTSTRAP -- called once from js/app.js, before pages mount, to
   minimize an incorrect-theme flash (architecture section 14.1). Applies
   the persisted (or default) appearance immediately and wires the live
   system-theme listener for 'auto' (section 13.3) exactly once.
============================================================ */
let systemThemeListenerAttached = false;

function attachSystemThemeListener() {
  if (systemThemeListenerAttached) return;
  try {
    if (typeof globalThis.matchMedia !== 'function') return;
    const mediaQuery = globalThis.matchMedia('(prefers-color-scheme: dark)');
    const handler = () => {
      const prefs = loadPreferences();
      if (prefs.appearance !== 'auto') return;
      applyAppearance('auto');
      notify(prefs);
    };
    if (typeof mediaQuery.addEventListener === 'function') mediaQuery.addEventListener('change', handler);
    else if (typeof mediaQuery.addListener === 'function') mediaQuery.addListener(handler); // older Safari fallback
    systemThemeListenerAttached = true;
  } catch (_) {
    // Ignored -- a live system-theme listener is an enhancement; its
    // absence must never block startup or leave the wrong theme applied.
  }
}

export function initAppPreferences() {
  const prefs = loadPreferences();
  applyAppearance(prefs.appearance);
  attachSystemThemeListener();
  return prefs;
}
