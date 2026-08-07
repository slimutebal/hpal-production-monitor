// Centralized i18n layer (V2.3 Phase 7, Language and Localization -- see
// docs/V2.3_AUTO_WEEK_AND_PERSONNEL_DIRECTORY_ARCHITECTURE.md section 12).
//
// Owns: current-locale state, t(key, vars) lookup with fallback, a
// data-i18n DOM-attribute walker so already-rendered static markup can be
// re-translated in place on a locale change (no reload, no full page
// rebuild), and a small pub/sub so page modules can react to a locale
// change without polling.
//
// Deliberately DOM-free at its core (t()/getLocale()/setLocale()/
// onLocaleChange() never touch `document`), so this module is testable
// under Node exactly like every other service in this codebase --
// translatePage() is the one DOM-touching export, and it no-ops safely
// outside a browser (see its own guard below).
//
// Locale persistence itself is NOT owned here -- app-preferences-service.js
// owns `hpal.preferences.v1` (the one shared storage key for locale AND
// appearance, per architecture section 14.1). This module depends on that
// service one-directionally (imports it, is never imported back), so
// there is exactly one place that reads/writes the storage key.
import { getPreferences, setLocale as persistLocale, onPreferencesChange } from '../services/app-preferences-service.js';
import idCatalog from './locales/id.js';
import enCatalog from './locales/en.js';

export const SUPPORTED_LOCALES = ['id', 'en'];
export const DEFAULT_LOCALE = 'id';

const CATALOGS = { id: idCatalog, en: enCatalog };

let currentLocale = DEFAULT_LOCALE;
const listeners = new Set();

function isSupportedLocale(value) {
  return SUPPORTED_LOCALES.includes(value);
}

// Reads the persisted preference (app-preferences-service.js already
// defaults/validates it) and sets this module's own runtime state to
// match -- called once at bootstrap (js/app.js), before any page mounts,
// so the very first render already uses the correct locale rather than
// flashing Indonesian-then-switching.
export function initI18n() {
  const prefs = getPreferences();
  currentLocale = isSupportedLocale(prefs.locale) ? prefs.locale : DEFAULT_LOCALE;
  return currentLocale;
}

export function getLocale() {
  return currentLocale;
}

// Persists via app-preferences-service.js (the single storage writer),
// updates this module's runtime state, re-translates the whole document
// in place, and notifies every subscriber -- in that order, so a
// subscriber that itself calls translatePage(someOtherRoot) always sees
// getLocale() already reflecting the new value.
export function setLocale(locale) {
  if (!isSupportedLocale(locale)) return currentLocale;
  if (locale === currentLocale) return currentLocale;

  currentLocale = locale;
  persistLocale(locale);
  translatePage();
  listeners.forEach((fn) => fn(currentLocale));
  return currentLocale;
}

export function onLocaleChange(callback) {
  listeners.add(callback);
  return () => listeners.delete(callback);
}

function substituteVars(template, vars) {
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (match, name) => (Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : match));
}

// Humanizes a dot-path key ("settings.language.title" -> "language
// title") as the last-resort fallback ONLY -- reached solely if a key
// exists in neither the current locale nor the Indonesian fallback, which
// should never happen for a key actually used by the app (both catalogs
// are kept in lockstep -- see tests/i18n.test.mjs). Required because the
// architecture doc explicitly forbids ever rendering an empty string or a
// raw key name to the user (section 12.2).
function humanizeMissingKey(key) {
  const lastSegment = key.split('.').pop() || key;
  const spaced = lastSegment.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

// Lookup order: current locale -> Indonesian fallback -> humanized key.
// Optionally logs a development-only console warning on fallback/miss
// (best-effort, never throws, never blocks the returned string).
export function t(key, vars) {
  const currentCatalog = CATALOGS[currentLocale] || CATALOGS[DEFAULT_LOCALE];
  if (Object.prototype.hasOwnProperty.call(currentCatalog, key)) {
    return substituteVars(currentCatalog[key], vars);
  }

  warnMissingKey(key, currentLocale);

  const fallbackCatalog = CATALOGS[DEFAULT_LOCALE];
  if (Object.prototype.hasOwnProperty.call(fallbackCatalog, key)) {
    return substituteVars(fallbackCatalog[key], vars);
  }

  warnMissingKey(key, DEFAULT_LOCALE);
  return humanizeMissingKey(key);
}

function warnMissingKey(key, locale) {
  try {
    if (typeof console !== 'undefined' && typeof console.warn === 'function') {
      console.warn(`[i18n] missing key "${key}" for locale "${locale}"`);
    }
  } catch (_) {
    // Ignored -- a console-less environment must never break translation.
  }
}

/* ============================================================
   DOM ATTRIBUTE WALKER -- the only DOM-touching export. Re-applies
   translations to already-rendered static markup tagged with data-i18n*
   attributes, so page modules that build their shell markup once (see
   settings-page.js/report-page.js's own header comments on this) can
   re-translate that shell in place on a locale change without rebuilding
   it (which would lose live dynamic content/modal state).
============================================================ */
export function translatePage(root) {
  const scope = root || (typeof document !== 'undefined' ? document : null);
  if (!scope || typeof scope.querySelectorAll !== 'function') return;

  scope.querySelectorAll('[data-i18n]').forEach((el) => {
    el.textContent = t(el.getAttribute('data-i18n'));
  });
  scope.querySelectorAll('[data-i18n-placeholder]').forEach((el) => {
    el.setAttribute('placeholder', t(el.getAttribute('data-i18n-placeholder')));
  });
  scope.querySelectorAll('[data-i18n-aria-label]').forEach((el) => {
    el.setAttribute('aria-label', t(el.getAttribute('data-i18n-aria-label')));
  });
  scope.querySelectorAll('[data-i18n-title]').forEach((el) => {
    el.setAttribute('title', t(el.getAttribute('data-i18n-title')));
  });
}

// Keeps this module's runtime locale in sync even if the locale is ever
// changed by a path that calls app-preferences-service.js directly rather
// than this module's own setLocale() -- defensive, since Settings is the
// only current caller of setLocale() today, but this closes that gap
// cheaply rather than assuming it can never happen.
onPreferencesChange((prefs) => {
  if (isSupportedLocale(prefs.locale) && prefs.locale !== currentLocale) {
    currentLocale = prefs.locale;
    translatePage();
    listeners.forEach((fn) => fn(currentLocale));
  }
});
