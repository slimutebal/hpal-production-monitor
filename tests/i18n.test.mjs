// js/i18n/i18n.js tests (V2.3 Phase 7, Language and Localization).
//
// Run with Node's built-in test runner:
//
//   node --test tests/i18n.test.mjs
//
// i18n.js depends one-directionally on app-preferences-service.js for
// locale persistence, so every test installs a mock localStorage first
// (same convention as tests/app-preferences-service.test.mjs). Node has
// no `document`, so translatePage() is tested with a minimal mock DOM
// tree rather than a real one.

import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  SUPPORTED_LOCALES,
  DEFAULT_LOCALE,
  initI18n,
  getLocale,
  setLocale,
  t,
  onLocaleChange,
  translatePage,
} from '../js/i18n/i18n.js';
import idCatalog from '../js/i18n/locales/id.js';
import enCatalog from '../js/i18n/locales/en.js';

function createMockStorage() {
  const map = new Map();
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => { map.set(key, String(value)); },
    removeItem: (key) => { map.delete(key); },
  };
}

beforeEach(() => {
  globalThis.localStorage = createMockStorage();
  delete globalThis.document;
  delete globalThis.window;
  delete globalThis.CustomEvent;
  setLocale(DEFAULT_LOCALE);
});

describe('Catalog integrity -- id.js and en.js must stay in lockstep', () => {
  test('every key in id.js also exists in en.js (no silent English gaps)', () => {
    const missing = Object.keys(idCatalog).filter((key) => !Object.prototype.hasOwnProperty.call(enCatalog, key));
    assert.deepEqual(missing, []);
  });

  test('every key in en.js also exists in id.js (en.js never introduces an orphan key)', () => {
    const missing = Object.keys(enCatalog).filter((key) => !Object.prototype.hasOwnProperty.call(idCatalog, key));
    assert.deepEqual(missing, []);
  });

  test('no catalog value is an empty string', () => {
    for (const [key, value] of Object.entries(idCatalog)) {
      assert.ok(value.trim().length > 0, `id.js key "${key}" is empty`);
    }
    for (const [key, value] of Object.entries(enCatalog)) {
      assert.ok(value.trim().length > 0, `en.js key "${key}" is empty`);
    }
  });
});

describe('initI18n() / getLocale() / setLocale()', () => {
  test('initI18n() reads the persisted locale (defaults to Indonesian)', () => {
    assert.equal(initI18n(), DEFAULT_LOCALE);
    assert.equal(getLocale(), DEFAULT_LOCALE);
  });

  test('initI18n() picks up a previously persisted English preference', () => {
    setLocale('en');
    assert.equal(initI18n(), 'en');
  });

  test('setLocale() switches the active locale', () => {
    setLocale('en');
    assert.equal(getLocale(), 'en');
    setLocale('id');
    assert.equal(getLocale(), 'id');
  });

  test('setLocale() rejects an unsupported locale, current locale unchanged', () => {
    setLocale('id');
    setLocale('fr');
    assert.equal(getLocale(), 'id');
  });

  test('SUPPORTED_LOCALES is exactly id/en', () => {
    assert.deepEqual(SUPPORTED_LOCALES, ['id', 'en']);
  });
});

describe('t(key, vars) -- translation lookup', () => {
  test('returns the Indonesian string by default', () => {
    assert.equal(t('common.save'), 'Simpan');
  });

  test('returns the English string once the locale is switched', () => {
    setLocale('en');
    assert.equal(t('common.save'), 'Save');
  });

  test('falls back to Indonesian for a key present only there (defensive; catalogs are kept in lockstep today)', () => {
    idCatalog['__test.fallbackOnly'] = 'Nilai Fallback';
    setLocale('en');
    assert.equal(t('__test.fallbackOnly'), 'Nilai Fallback');
    delete idCatalog['__test.fallbackOnly'];
  });

  test('never renders a raw key name for a completely missing key -- humanizes instead', () => {
    const result = t('totally.madeUp.key');
    assert.notEqual(result, 'totally.madeUp.key');
    assert.ok(result.length > 0);
  });

  test('substitutes {var} placeholders', () => {
    idCatalog['__test.greeting'] = 'Halo, {name}!';
    enCatalog['__test.greeting'] = 'Hello, {name}!';
    assert.equal(t('__test.greeting', { name: 'Budi' }), 'Halo, {name}!'.replace('{name}', 'Budi'));
    delete idCatalog['__test.greeting'];
    delete enCatalog['__test.greeting'];
  });

  test('a missing var leaves the placeholder literal rather than throwing or blanking it', () => {
    idCatalog['__test.partial'] = 'Value: {missing}';
    enCatalog['__test.partial'] = 'Value: {missing}';
    assert.doesNotThrow(() => {
      const result = t('__test.partial', {});
      assert.equal(result, 'Value: {missing}');
    });
    delete idCatalog['__test.partial'];
    delete enCatalog['__test.partial'];
  });
});

describe('onLocaleChange() -- pub/sub', () => {
  test('subscribers are notified with the new locale on setLocale()', () => {
    let received = null;
    onLocaleChange((locale) => { received = locale; });
    setLocale('en');
    assert.equal(received, 'en');
  });

  test('unsubscribe stops further notifications', () => {
    let count = 0;
    const unsubscribe = onLocaleChange(() => { count += 1; });
    setLocale('en');
    unsubscribe();
    setLocale('id');
    assert.equal(count, 1);
  });

  test('setLocale() to the already-active locale does not notify subscribers', () => {
    setLocale('id');
    let count = 0;
    onLocaleChange(() => { count += 1; });
    setLocale('id');
    assert.equal(count, 0);
  });
});

describe('translatePage() -- DOM attribute walker', () => {
  function makeMockElement(attrs = {}) {
    const el = { _attrs: { ...attrs }, textContent: '' };
    el.getAttribute = (name) => el._attrs[name];
    el.setAttribute = (name, value) => { el._attrs[name] = value; };
    return el;
  }

  test('outside a browser (no document), translatePage() never throws', () => {
    assert.doesNotThrow(() => translatePage());
  });

  test('translates [data-i18n] textContent', () => {
    const el = makeMockElement({ 'data-i18n': 'common.save' });
    const root = { querySelectorAll: (sel) => (sel === '[data-i18n]' ? [el] : []) };

    translatePage(root);
    assert.equal(el.textContent, 'Simpan');
  });

  test('translates [data-i18n-placeholder]', () => {
    const el = makeMockElement({ 'data-i18n-placeholder': 'common.search' });
    const root = { querySelectorAll: (sel) => (sel === '[data-i18n-placeholder]' ? [el] : []) };

    translatePage(root);
    assert.equal(el.getAttribute('placeholder'), 'Cari nama...');
  });

  test('translates [data-i18n-aria-label]', () => {
    const el = makeMockElement({ 'data-i18n-aria-label': 'common.close' });
    const root = { querySelectorAll: (sel) => (sel === '[data-i18n-aria-label]' ? [el] : []) };

    translatePage(root);
    assert.equal(el.getAttribute('aria-label'), 'Tutup');
  });

  test('re-translating after a locale switch updates the same elements', () => {
    const el = makeMockElement({ 'data-i18n': 'common.save' });
    const root = { querySelectorAll: (sel) => (sel === '[data-i18n]' ? [el] : []) };

    translatePage(root);
    assert.equal(el.textContent, 'Simpan');

    setLocale('en');
    translatePage(root);
    assert.equal(el.textContent, 'Save');
  });
});
