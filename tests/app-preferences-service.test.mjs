// app-preferences-service.js tests (V2.3 Phase 7, Language and
// Localization / Appearance).
//
// Run with Node's built-in test runner:
//
//   node --test tests/app-preferences-service.test.mjs
//
// Node has no localStorage/document/matchMedia/CustomEvent, so every test
// installs minimal mocks for whichever of those the function under test
// actually touches -- mirroring the mock-storage convention already used
// throughout tests/personnel-directory-service.test.mjs and
// tests/personnel-write-queue.test.mjs.

import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  validatePreferencesShape,
  loadPreferences,
  getPreferences,
  setLocale,
  setAppearance,
  resolveAppearance,
  applyAppearance,
  onPreferencesChange,
  initAppPreferences,
  DEFAULT_LOCALE,
  DEFAULT_APPEARANCE,
} from '../js/services/app-preferences-service.js';

const STORAGE_KEY = 'hpal.preferences.v1';

function createMockStorage() {
  const map = new Map();
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => {
      map.set(key, String(value));
    },
    removeItem: (key) => {
      map.delete(key);
    },
  };
}

beforeEach(() => {
  globalThis.localStorage = createMockStorage();
  delete globalThis.document;
  delete globalThis.window;
  delete globalThis.CustomEvent;
  delete globalThis.matchMedia;
});

describe('Schema validation and defaults', () => {
  test('loadPreferences() with nothing stored returns safe defaults', () => {
    const prefs = loadPreferences();
    assert.equal(prefs.locale, DEFAULT_LOCALE);
    assert.equal(prefs.appearance, DEFAULT_APPEARANCE);
  });

  test('a valid stored preference persists across load calls', () => {
    setLocale('en');
    const reloaded = loadPreferences();
    assert.equal(reloaded.locale, 'en');
  });

  test('malformed JSON is rejected safely, never throws, resets to defaults', () => {
    globalThis.localStorage.setItem(STORAGE_KEY, '{not valid json');
    assert.doesNotThrow(() => {
      const prefs = loadPreferences();
      assert.equal(prefs.locale, DEFAULT_LOCALE);
    });
  });

  test('an invalid locale/appearance value in storage is rejected, resets to defaults', () => {
    globalThis.localStorage.setItem(STORAGE_KEY, JSON.stringify({ schemaVersion: 1, locale: 'fr', appearance: 'auto' }));
    assert.equal(loadPreferences().locale, DEFAULT_LOCALE);
  });

  test('validatePreferencesShape() rejects a wrong schemaVersion', () => {
    assert.equal(validatePreferencesShape({ schemaVersion: 99, locale: 'id', appearance: 'auto' }).ok, false);
  });

  test('validatePreferencesShape() accepts a well-formed object', () => {
    assert.equal(validatePreferencesShape({ schemaVersion: 1, locale: 'id', appearance: 'dark' }).ok, true);
  });
});

describe('setLocale() / setAppearance()', () => {
  test('setLocale() persists and returns the updated preferences', () => {
    const result = setLocale('en');
    assert.equal(result.locale, 'en');
    assert.equal(getPreferences().locale, 'en');
  });

  test('setLocale() with an unsupported value is a no-op', () => {
    setLocale('id');
    const before = getPreferences();
    const result = setLocale('fr');
    assert.deepEqual(result, before);
  });

  test('setAppearance() persists and returns the updated preferences', () => {
    const result = setAppearance('dark');
    assert.equal(result.appearance, 'dark');
    assert.equal(getPreferences().appearance, 'dark');
  });

  test('setAppearance() with an unsupported value is a no-op', () => {
    setAppearance('light');
    const before = getPreferences();
    const result = setAppearance('neon');
    assert.deepEqual(result, before);
  });

  test('setLocale() never changes appearance and vice versa (independent fields)', () => {
    setAppearance('dark');
    setLocale('en');
    const prefs = getPreferences();
    assert.equal(prefs.appearance, 'dark');
    assert.equal(prefs.locale, 'en');
  });
});

describe('resolveAppearance() -- theme resolution', () => {
  test("'dark' always resolves to 'dark' regardless of system preference", () => {
    globalThis.matchMedia = () => ({ matches: false });
    assert.equal(resolveAppearance('dark'), 'dark');
  });

  test("'light' always resolves to 'light' regardless of system preference", () => {
    globalThis.matchMedia = () => ({ matches: true });
    assert.equal(resolveAppearance('light'), 'light');
  });

  test("'auto' resolves to 'dark' when the system prefers dark", () => {
    globalThis.matchMedia = () => ({ matches: true });
    assert.equal(resolveAppearance('auto'), 'dark');
  });

  test("'auto' resolves to 'light' when the system prefers light", () => {
    globalThis.matchMedia = () => ({ matches: false });
    assert.equal(resolveAppearance('auto'), 'light');
  });

  test("'auto' falls back to 'dark' when matchMedia is unavailable (matches index.html's own existing fallback)", () => {
    assert.equal(typeof globalThis.matchMedia, 'undefined');
    assert.equal(resolveAppearance('auto'), 'dark');
  });
});

describe('applyAppearance() -- DOM application, safe outside a browser', () => {
  test('outside a browser (no document), applyAppearance() never throws', () => {
    assert.doesNotThrow(() => applyAppearance('dark'));
  });

  test('sets data-theme on the document element and updates the theme-color meta tag', () => {
    const attrs = {};
    const metaEl = { setAttribute: (name, value) => { attrs.metaContent = value; } };
    globalThis.document = {
      documentElement: { setAttribute: (name, value) => { attrs[name] = value; } },
      getElementById: (id) => (id === 'metaThemeColor' ? metaEl : null),
    };

    const resolved = applyAppearance('light');
    assert.equal(resolved, 'light');
    assert.equal(attrs['data-theme'], 'light');
    assert.equal(attrs.metaContent, '#eef2f7');
  });

  test('dark resolves to the dark meta color', () => {
    const attrs = {};
    globalThis.document = {
      documentElement: { setAttribute: (name, value) => { attrs[name] = value; } },
      getElementById: () => null,
    };
    applyAppearance('dark');
    assert.equal(attrs['data-theme'], 'dark');
  });
});

describe('Pub/sub + cross-boundary event bridge', () => {
  test('onPreferencesChange() subscribers are notified on setLocale()', () => {
    let received = null;
    onPreferencesChange((prefs) => { received = prefs; });
    setLocale('en');
    assert.equal(received.locale, 'en');
  });

  test('onPreferencesChange() subscribers are notified on setAppearance()', () => {
    let received = null;
    onPreferencesChange((prefs) => { received = prefs; });
    setAppearance('dark');
    assert.equal(received.appearance, 'dark');
  });

  test('unsubscribe stops further notifications', () => {
    let callCount = 0;
    const unsubscribe = onPreferencesChange(() => { callCount += 1; });
    setLocale('en');
    unsubscribe();
    setLocale('id');
    assert.equal(callCount, 1);
  });

  test('a preference change dispatches a global hpal:preferences-changed CustomEvent when window/CustomEvent exist', () => {
    const dispatched = [];
    globalThis.CustomEvent = class { constructor(name, init) { this.type = name; this.detail = init && init.detail; } };
    globalThis.window = { dispatchEvent: (event) => dispatched.push(event) };

    setAppearance('light');

    assert.equal(dispatched.length, 1);
    assert.equal(dispatched[0].type, 'hpal:preferences-changed');
    assert.equal(dispatched[0].detail.appearance, 'light');
  });

  test('a misbehaving subscriber never breaks notification for other subscribers', () => {
    let secondCalled = false;
    onPreferencesChange(() => { throw new Error('boom'); });
    onPreferencesChange(() => { secondCalled = true; });
    assert.doesNotThrow(() => setLocale('en'));
    assert.equal(secondCalled, true);
  });
});

describe('initAppPreferences() -- bootstrap', () => {
  test('applies the persisted appearance immediately and returns the preferences', () => {
    setAppearance('dark');
    const attrs = {};
    globalThis.document = {
      documentElement: { setAttribute: (name, value) => { attrs[name] = value; } },
      getElementById: () => null,
    };

    const prefs = initAppPreferences();
    assert.equal(prefs.appearance, 'dark');
    assert.equal(attrs['data-theme'], 'dark');
  });

  test('never throws when matchMedia/document are unavailable', () => {
    assert.doesNotThrow(() => initAppPreferences());
  });
});
