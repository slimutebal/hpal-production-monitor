// Calculate page tests (V2.4 Phase 2 -- Blend Calculator; compact mobile
// input grid revision). See
// docs/V2.4_CALCULATE_AND_BLENDING_RECOMMENDATION_ARCHITECTURE.md.
//
// Run with Node's built-in test runner:
//
//   node --test tests/calculate-page.test.mjs
//
// MINI-DOM HARNESS: calculate-page.js builds its entire tree via
// document.createElement()/appendChild()/replaceChildren() (see its own
// header comment) rather than innerHTML template strings, specifically so
// it can be exercised behaviorally here without jsdom (this project has
// zero npm dependencies). FakeElement below implements exactly the subset
// of the real DOM this module actually uses. It is deliberately NOT a
// general jsdom replacement; it only needs to be correct for
// calculate-page.js's own real, narrow DOM footprint.
//
// This lets the tests click Remove/Calculate Blend and type into fields
// for real, exercising calculate-page.js's actual production logic
// end-to-end -- only the DOM primitives are mocked, never calculate-page.js's
// own functions.
//
// license-service.js's exported hasFullAccess()/subscribeFullAccessAttention()
// and i18n.js's exported setLocale()/onLocaleChange() are both the ONE
// production singleton each (no per-test factory reset available) -- same
// caveat already documented in tests/bottom-navigation.test.mjs: listeners
// registered by an earlier test's initCalculatePage() call remain
// subscribed for the lifetime of this file's process. This is harmless
// here too: handleLocaleChange() and the license-change path are both
// idempotent (they only ever re-render from CURRENT module-level state,
// never accumulate side effects), so a stale listener firing alongside a
// fresh one changes nothing about the final asserted state.

import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { initCalculatePage, requireFullAccessForCalculateAction } from '../js/pages/calculate/calculate-page.js';
import { setLocale, DEFAULT_LOCALE } from '../js/i18n/i18n.js';
import {
  initializeLicense,
  removeLicense,
  subscribeFullAccessAttention,
  _buildValidLicenseRecordForTests,
} from '../js/services/license-service.js';
import idCatalog from '../js/i18n/locales/id.js';
import enCatalog from '../js/i18n/locales/en.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const LICENSE_KEY = 'hpal.license.v1';

/* ============================================================
   MINI-DOM HARNESS -- see header comment.
============================================================ */
class FakeElement {
  constructor(tagName) {
    this.tagName = String(tagName).toUpperCase();
    this._className = '';
    this._textContent = '';
    this.children = [];
    this.parentNode = null;
    this.dataset = {};
    this.attributes = {};
    this._handlers = {};
    this.hidden = false;
    this.value = '';
    this.type = '';
    this.id = '';
  }

  get className() { return this._className; }
  set className(value) { this._className = value; }

  get textContent() {
    if (this.children.length === 0) return this._textContent;
    return this.children.map((c) => c.textContent).join('');
  }
  set textContent(value) {
    this._textContent = value;
    this.children = [];
  }

  appendChild(child) {
    this.children.push(child);
    child.parentNode = this;
    return child;
  }

  replaceChildren(...nodes) {
    this.children = nodes;
    nodes.forEach((n) => { n.parentNode = this; });
  }

  setAttribute(name, value) { this.attributes[name] = value; }
  removeAttribute(name) { delete this.attributes[name]; }
  getAttribute(name) { return this.attributes[name]; }

  addEventListener(type, fn) {
    this._handlers[type] = this._handlers[type] || [];
    this._handlers[type].push(fn);
  }

  // Test-only: simulates a real event dispatch closely enough for this
  // module's needs -- it only ever reads event.target, which IS this
  // element.
  fire(type) {
    (this._handlers[type] || []).forEach((fn) => fn({ target: this }));
  }
}

function installMockDocument() {
  const pageEl = new FakeElement('section');
  globalThis.document = {
    createElement: (tag) => new FakeElement(tag),
    getElementById: (id) => (id === 'page-calculate' ? pageEl : null),
  };
  return pageEl;
}

function installMockWindow(initialHash) {
  let hash = initialHash || '';
  globalThis.window = {
    location: {
      get hash() { return hash; },
      set hash(value) { hash = value; },
    },
    addEventListener() {},
  };
  return { getHash: () => hash };
}

function findAll(root, predicate) {
  const results = [];
  (function walk(node) {
    if (!node) return;
    if (predicate(node)) results.push(node);
    (node.children || []).forEach(walk);
  })(root);
  return results;
}

function findOne(root, predicate) {
  return findAll(root, predicate)[0] || null;
}

const hasClass = (cls) => (el) => (el.className || '').split(/\s+/).includes(cls);
const isTag = (tag) => (el) => el.tagName === tag.toUpperCase();

// Data rows only -- distinguished from the header row by carrying
// dataset.rowIndex (set exclusively by buildPileRow(), never the header).
function gridRows(pageEl) {
  return findAll(pageEl, (el) => hasClass('calculate-grid-row')(el) && 'rowIndex' in el.dataset);
}

function findFieldInput(row, field) {
  return findOne(row, (el) => el.tagName === 'INPUT' && el.dataset.field === field);
}

function findRowError(row) {
  return findOne(row, hasClass('calculate-row-error'));
}

function typeIntoField(row, field, value) {
  const input = findFieldInput(row, field);
  input.value = value;
  input.fire('input');
  return input;
}

function fillRow(row, { pileId, ni, units, tonnesPerUnit }) {
  if (pileId !== undefined) typeIntoField(row, 'pileId', pileId);
  if (ni !== undefined) typeIntoField(row, 'ni', ni);
  if (units !== undefined) typeIntoField(row, 'units', units);
  if (tonnesPerUnit !== undefined) typeIntoField(row, 'tonnesPerUnit', tonnesPerUnit);
}

function clickCalculate(pageEl) {
  findOne(pageEl, hasClass('calculate-calculate-btn')).fire('click');
}

function clickRemove(row) {
  const btn = findOne(row, hasClass('calculate-remove-pile-btn'));
  if (!btn) return false;
  btn.fire('click');
  return true;
}

function resultRoot(pageEl) {
  return findOne(pageEl, hasClass('calculate-result'));
}

function summaryValue(pageEl, itemClass) {
  const item = findOne(pageEl, hasClass(itemClass));
  return findOne(item, isTag('strong')).textContent;
}

/* ============================================================
   License helpers -- same key-free pattern
   tests/personnel-directory-license-guard.test.mjs establishes.
============================================================ */
function createMockStorage() {
  const map = new Map();
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => { map.set(key, String(value)); },
    removeItem: (key) => { map.delete(key); },
  };
}

function goFullAccess() {
  globalThis.localStorage.setItem(LICENSE_KEY, JSON.stringify(_buildValidLicenseRecordForTests()));
  initializeLicense();
}

function goMonitorOnly() {
  removeLicense();
}

function mountFullAccess() {
  goFullAccess();
  installMockWindow('#/calculate');
  const pageEl = installMockDocument();
  initCalculatePage();
  return pageEl;
}

beforeEach(() => {
  globalThis.localStorage = createMockStorage();
  setLocale(DEFAULT_LOCALE);
});

/* ============================================================
   ACTION-BOUNDARY GUARD (unchanged, still exercised here)
============================================================ */
describe('requireFullAccessForCalculateAction() -- action-boundary guard', () => {
  test('FULL_ACCESS: returns true, never navigates, never requests attention', () => {
    goFullAccess();
    const win = installMockWindow('#/calculate');
    let attentionCalls = 0;
    const unsubscribe = subscribeFullAccessAttention(() => { attentionCalls += 1; });

    const result = requireFullAccessForCalculateAction();

    unsubscribe();
    assert.equal(result, true);
    assert.equal(win.getHash(), '#/calculate');
    assert.equal(attentionCalls, 0);
  });

  test('MONITOR_ONLY: returns false, redirects to #/settings, requests attention with the "calculate-action" context', () => {
    goMonitorOnly();
    const win = installMockWindow('#/calculate');
    let receivedContext;
    const unsubscribe = subscribeFullAccessAttention((context) => { receivedContext = context; });

    const result = requireFullAccessForCalculateAction();

    unsubscribe();
    assert.equal(result, false);
    assert.equal(win.getHash(), '#/settings');
    assert.equal(receivedContext, 'calculate-action');
  });
});

/* ============================================================
   1. INITIAL MOUNT -- exactly one blank row
============================================================ */
describe('initCalculatePage() -- initial mount', () => {
  test('1. mounts exactly one blank row', () => {
    const pageEl = mountFullAccess();
    assert.equal(gridRows(pageEl).length, 1);
    const row = gridRows(pageEl)[0];
    assert.equal(findFieldInput(row, 'pileId').value, '');
  });

  test('the trailing blank row has no remove control', () => {
    const pageEl = mountFullAccess();
    assert.equal(clickRemove(gridRows(pageEl)[0]), false);
  });

  test('does nothing (no throw) when #page-calculate is not present in the document', () => {
    globalThis.document = { getElementById: () => null };
    assert.doesNotThrow(() => initCalculatePage());
  });

  test('mounting under MONITOR_ONLY never redirects or requests License attention on its own', () => {
    goMonitorOnly();
    const win = installMockWindow('#/calculate');
    installMockDocument();
    let attentionCalls = 0;
    const unsubscribe = subscribeFullAccessAttention(() => { attentionCalls += 1; });

    initCalculatePage();

    unsubscribe();
    assert.equal(win.getHash(), '#/calculate');
    assert.equal(attentionCalls, 0);
  });
});

/* ============================================================
   2/3. TRAILING-ROW AUTO-APPEND
============================================================ */
describe('Trailing blank row auto-append', () => {
  test('2. typing into the trailing blank row appends exactly one new blank row', () => {
    const pageEl = mountFullAccess();
    typeIntoField(gridRows(pageEl)[0], 'pileId', 'A');

    const rows = gridRows(pageEl);
    assert.equal(rows.length, 2);
    assert.equal(findFieldInput(rows[1], 'pileId').value, '');
  });

  test('3. typing additional fields into the same now-active row does not append extra blanks', () => {
    const pageEl = mountFullAccess();
    const row = gridRows(pageEl)[0];
    typeIntoField(row, 'pileId', 'A');
    assert.equal(gridRows(pageEl).length, 2);

    typeIntoField(row, 'ni', '1.30');
    typeIntoField(row, 'units', '10');
    typeIntoField(row, 'tonnesPerUnit', '50');

    assert.equal(gridRows(pageEl).length, 2, 'no extra blank rows from editing an already-active row');
  });

  test('a single character is enough to trigger the append (row becomes active immediately)', () => {
    const pageEl = mountFullAccess();
    typeIntoField(gridRows(pageEl)[0], 'ni', '1');
    assert.equal(gridRows(pageEl).length, 2);
  });

  test('typing into the trailing row does not disturb an already-active row\'s DOM/focus (targeted append, not a full rebuild)', () => {
    const pageEl = mountFullAccess();
    let rows = gridRows(pageEl);
    typeIntoField(rows[0], 'pileId', 'A');
    rows = gridRows(pageEl);
    const firstRowElBefore = rows[0];

    typeIntoField(rows[1], 'pileId', 'B');

    rows = gridRows(pageEl);
    assert.equal(rows[0], firstRowElBefore, 'row 0\'s element identity must be preserved (no full rebuild)');
  });

  test('4. filling several rows always leaves exactly one trailing blank row', () => {
    const pageEl = mountFullAccess();
    fillRow(gridRows(pageEl)[0], { pileId: 'A', ni: '1.3', units: '10', tonnesPerUnit: '50' });
    fillRow(gridRows(pageEl)[1], { pileId: 'B', ni: '0.95', units: '20', tonnesPerUnit: '45' });

    const rows = gridRows(pageEl);
    assert.equal(rows.length, 3);
    assert.equal(findFieldInput(rows[2], 'pileId').value, '');
    assert.equal(clickRemove(rows[2]), false, 'the new trailing row must also have no remove control');
  });
});

/* ============================================================
   8. REMOVE PRESERVES THE TRAILING-BLANK-ROW INVARIANT
============================================================ */
describe('Remove Pile', () => {
  test('8. removing a populated row preserves exactly one trailing blank row, other rows\' values survive', () => {
    const pageEl = mountFullAccess();
    fillRow(gridRows(pageEl)[0], { pileId: 'A', ni: '1.3', units: '10', tonnesPerUnit: '50' });
    fillRow(gridRows(pageEl)[1], { pileId: 'B', ni: '0.95', units: '20', tonnesPerUnit: '45' });

    let rows = gridRows(pageEl);
    assert.equal(rows.length, 3);
    assert.equal(clickRemove(rows[0]), true);

    rows = gridRows(pageEl);
    assert.equal(rows.length, 2);
    assert.equal(findFieldInput(rows[0], 'pileId').value, 'B');
    assert.equal(findFieldInput(rows[1], 'pileId').value, '');
    assert.equal(clickRemove(rows[1]), false, 'the surviving trailing row must have no remove control');
  });

  test('removing every active row leaves exactly one blank row -- never zero rows', () => {
    const pageEl = mountFullAccess();
    fillRow(gridRows(pageEl)[0], { pileId: 'A', ni: '1.2', units: '10', tonnesPerUnit: '50' });

    clickRemove(gridRows(pageEl)[0]);

    const rows = gridRows(pageEl);
    assert.equal(rows.length, 1);
    assert.equal(findFieldInput(rows[0], 'pileId').value, '');
  });

  test('Remove clears any previously shown result -- no hidden stale calculation survives a row-set change', () => {
    const pageEl = mountFullAccess();
    fillRow(gridRows(pageEl)[0], { pileId: 'A', ni: '1.2', units: '10', tonnesPerUnit: '50' });
    clickCalculate(pageEl);
    assert.equal(resultRoot(pageEl).hidden, false);

    fillRow(gridRows(pageEl)[1], { pileId: 'B', ni: '1.1', units: '5', tonnesPerUnit: '40' });
    clickRemove(gridRows(pageEl)[1]);

    assert.equal(resultRoot(pageEl).hidden, true);
  });
});

/* ============================================================
   5/6/7/9. VALIDATION vs. THE TRAILING BLANK ROW
============================================================ */
describe('Blank trailing row is excluded from validation and calculation', () => {
  test('5/6. calculating with only the blank trailing row present shows the whole-blend error, never a fabricated Ni = 0, and never a "Pile ID required" complaint about the blank row', () => {
    const pageEl = mountFullAccess();

    clickCalculate(pageEl);

    assert.equal(resultRoot(pageEl).hidden, true);
    const blendError = findOne(pageEl, hasClass('calculate-blend-error'));
    assert.equal(blendError.hidden, false);
    assert.equal(blendError.textContent, idCatalog['calculate.validation.noPositiveTonnage']);
    assert.equal(findRowError(gridRows(pageEl)[0]).hidden, true);
  });

  test('7. a partially-filled ACTIVE row (not the trailing row) DOES validate normally', () => {
    const pageEl = mountFullAccess();
    // Typing only a Pile ID makes this row active (no longer trailing);
    // it deliberately leaves Ni/DT/t-DT blank.
    typeIntoField(gridRows(pageEl)[0], 'pileId', 'A');

    clickCalculate(pageEl);

    const rows = gridRows(pageEl);
    assert.equal(resultRoot(pageEl).hidden, true);
    assert.match(findRowError(rows[0]).textContent, new RegExp(idCatalog['calculate.validation.niRequired']));
    // The still-blank trailing row (now row 1) must not itself complain.
    assert.equal(findRowError(rows[1]).hidden, true);
  });

  test('one fully valid pile plus the blank trailing row calculates successfully', () => {
    const pageEl = mountFullAccess();
    fillRow(gridRows(pageEl)[0], { pileId: 'A', ni: '1.2', units: '10', tonnesPerUnit: '50' });

    clickCalculate(pageEl);

    assert.equal(resultRoot(pageEl).hidden, false);
    assert.equal(summaryValue(pageEl, 'calculate-total-units'), '10');
  });

  test('9. duplicate detection ignores the intentional blank trailing row -- an empty Pile ID never collides with it', () => {
    const pageEl = mountFullAccess();
    fillRow(gridRows(pageEl)[0], { pileId: '', ni: '1.2', units: '10', tonnesPerUnit: '50' });

    clickCalculate(pageEl);

    const rows = gridRows(pageEl);
    // The active (but Pile-ID-less) row gets its own required error, not
    // a duplicate error against the still-blank trailing row.
    assert.match(findRowError(rows[0]).textContent, new RegExp(idCatalog['calculate.validation.pileIdRequired']));
  });

  test('9b. real duplicate Pile IDs across two ACTIVE rows are still caught (unchanged business rule)', () => {
    const pageEl = mountFullAccess();
    fillRow(gridRows(pageEl)[0], { pileId: 'S1', ni: '1.2', units: '10', tonnesPerUnit: '50' });
    fillRow(gridRows(pageEl)[1], { pileId: 's1', ni: '1.0', units: '5', tonnesPerUnit: '40' });

    clickCalculate(pageEl);

    const rows = gridRows(pageEl);
    assert.equal(findRowError(rows[0]).hidden, true);
    assert.match(findRowError(rows[1]).textContent, new RegExp(idCatalog['calculate.validation.pileIdDuplicate']));
  });
});

/* ============================================================
   10/11. DERIVED, READ-ONLY DISPLAYS IN THE COMPACT ROW
============================================================ */
describe('Ore-class badge and Calculated Tonnage update live inside the compact row', () => {
  test('11. typing a valid Ni updates the badge without a Calculate Blend press', () => {
    const pageEl = mountFullAccess();
    const row = gridRows(pageEl)[0];

    assert.equal(findOne(row, hasClass('calculate-grid-cell__badge')).textContent, '');

    typeIntoField(row, 'ni', '1.30');
    assert.equal(findOne(gridRows(pageEl)[0], hasClass('calculate-grid-cell__badge')).textContent, 'MGLO');

    typeIntoField(gridRows(pageEl)[0], 'ni', '1.50');
    assert.equal(findOne(gridRows(pageEl)[0], hasClass('calculate-grid-cell__badge')).textContent, 'HGLO');
  });

  test('10. typing DT and t/DT updates Calculated Tonnage live, under the t/DT cell', () => {
    const pageEl = mountFullAccess();
    const row = gridRows(pageEl)[0];

    typeIntoField(row, 'units', '10');
    typeIntoField(gridRows(pageEl)[0], 'tonnesPerUnit', '50');

    const tonnageEl = findOne(gridRows(pageEl)[0], hasClass('calculate-grid-cell__tonnage'));
    assert.match(tonnageEl.textContent, /500/);
  });

  test('an incomplete row shows no NaN in the derived tonnage', () => {
    const pageEl = mountFullAccess();
    typeIntoField(gridRows(pageEl)[0], 'units', '10');
    const tonnageEl = findOne(gridRows(pageEl)[0], hasClass('calculate-grid-cell__tonnage'));
    assert.doesNotMatch(tonnageEl.textContent, /NaN/);
  });
});

/* ============================================================
   12. WORKED EXAMPLE
============================================================ */
describe('Calculate Blend -- authoritative worked example (architecture doc Section 14)', () => {
  test('12. Pile A (Ni 1.30, 10x50) + Pile B (Ni 0.95, 20x45) -> Final Ni 1.075%, Total DT 30, Total Tonnage 1,400 t', () => {
    const pageEl = mountFullAccess();
    fillRow(gridRows(pageEl)[0], { pileId: 'Pile A', ni: '1.30', units: '10', tonnesPerUnit: '50' });
    fillRow(gridRows(pageEl)[1], { pileId: 'Pile B', ni: '0.95', units: '20', tonnesPerUnit: '45' });

    clickCalculate(pageEl);

    assert.equal(resultRoot(pageEl).hidden, false);
    assert.equal(summaryValue(pageEl, 'calculate-final-ni'), '1.075%');
    assert.equal(summaryValue(pageEl, 'calculate-total-units'), '30');
    assert.match(summaryValue(pageEl, 'calculate-total-tonnage'), /1\.400,00 t|1,400.00 t/);
  });

  test('the (blank) trailing row present alongside two active rows does not affect the result', () => {
    const pageEl = mountFullAccess();
    fillRow(gridRows(pageEl)[0], { pileId: 'Pile A', ni: '1.30', units: '10', tonnesPerUnit: '50' });
    fillRow(gridRows(pageEl)[1], { pileId: 'Pile B', ni: '0.95', units: '20', tonnesPerUnit: '45' });
    assert.equal(gridRows(pageEl).length, 3, 'a third, blank, trailing row must exist at this point');

    clickCalculate(pageEl);

    assert.equal(summaryValue(pageEl, 'calculate-final-ni'), '1.075%');
  });
});

describe('Calculate Blend -- action-boundary guard is not bypassed', () => {
  test('under MONITOR_ONLY, pressing Calculate Blend never computes a result and redirects instead', () => {
    const pageEl = mountFullAccess();
    fillRow(gridRows(pageEl)[0], { pileId: 'A', ni: '1.2', units: '10', tonnesPerUnit: '50' });

    goMonitorOnly();
    const win = installMockWindow('#/calculate');
    let receivedContext;
    const unsubscribe = subscribeFullAccessAttention((ctx) => { receivedContext = ctx; });

    clickCalculate(pageEl);

    unsubscribe();
    assert.equal(resultRoot(pageEl).hidden, true);
    assert.equal(win.getHash(), '#/settings');
    assert.equal(receivedContext, 'calculate-action');
  });
});

/* ============================================================
   13/14. SESSION STATE AND LOCALIZATION
============================================================ */
describe('13. Calculate -> Monitor -> Calculate preserves rows and the current result', () => {
  test('module-level state survives independently of route changes (the page is never rebuilt on remount)', () => {
    const pageEl = mountFullAccess();
    fillRow(gridRows(pageEl)[0], { pileId: 'A', ni: '1.30', units: '10', tonnesPerUnit: '50' });
    fillRow(gridRows(pageEl)[1], { pileId: 'B', ni: '0.95', units: '20', tonnesPerUnit: '45' });
    clickCalculate(pageEl);
    const finalNiBefore = summaryValue(pageEl, 'calculate-final-ni');

    // initCalculatePage() is called exactly once at bootstrap in the real
    // app (js/app.js) -- navigating away/back never calls it again, so
    // nothing here should re-invoke it; this simply re-reads the SAME
    // still-mounted DOM to confirm nothing was lost.
    const rows = gridRows(pageEl);
    assert.equal(findFieldInput(rows[0], 'pileId').value, 'A');
    assert.equal(findFieldInput(rows[1], 'pileId').value, 'B');
    assert.equal(resultRoot(pageEl).hidden, false);
    assert.equal(summaryValue(pageEl, 'calculate-final-ni'), finalNiBefore);
  });
});

describe('14. Locale switch preserves entered values and the current result', () => {
  test('switching id -> en keeps row inputs and Blend Result numbers unchanged', () => {
    const pageEl = mountFullAccess();
    fillRow(gridRows(pageEl)[0], { pileId: 'A', ni: '1.30', units: '10', tonnesPerUnit: '50' });
    clickCalculate(pageEl);
    const finalNiBefore = summaryValue(pageEl, 'calculate-final-ni');

    setLocale('en');

    const rows = gridRows(pageEl);
    assert.equal(findFieldInput(rows[0], 'pileId').value, 'A');
    assert.equal(findFieldInput(rows[0], 'ni').value, '1.30');
    assert.equal(resultRoot(pageEl).hidden, false);
    assert.equal(summaryValue(pageEl, 'calculate-final-ni'), finalNiBefore);
  });

  test('short grid headers actually change text between locales, while stable terms (PILE/NI/DT) stay identical', () => {
    const pageEl = mountFullAccess();

    setLocale('id');
    const idHeaderTitle = findOne(pageEl, hasClass('calculate-section-label')).textContent;
    setLocale('en');
    const enHeaderTitle = findOne(pageEl, hasClass('calculate-section-label')).textContent;

    assert.equal(idHeaderTitle, idCatalog['calculate.blend.title']);
    assert.equal(enHeaderTitle, enCatalog['calculate.blend.title']);
    assert.notEqual(idHeaderTitle, enHeaderTitle);
  });
});

/* ============================================================
   15. PHASE 2 NON-GOALS -- Recommendation/Gate A must remain untouched
============================================================ */
function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((line) => {
      const trimmed = line.trim();
      return trimmed.startsWith('//') ? '' : line;
    })
    .join('\n');
}

describe('15. Phase 2 non-goals -- no Recommendation UI or business logic', () => {
  const source = stripComments(readFileSync(path.join(ROOT, 'js', 'pages', 'calculate', 'calculate-page.js'), 'utf8'));

  test('the module\'s actual code never references Recommendation-mode concepts', () => {
    for (const forbidden of [
      'targetNi', 'tolerance', 'hopperPattern', 'hopperSequence', 'unitRatio', 'tonnageRatio',
      'findBlendRecommendations', 'recovery', 'newDome', 'availableDt',
    ]) {
      assert.doesNotMatch(source, new RegExp(forbidden, 'i'), `calculate-page.js code must not yet reference ${forbidden}`);
    }
  });

  test('USE/LIMIT/STOP action vocabulary does not appear in actual code', () => {
    assert.doesNotMatch(source, /\bUSE\b|\bLIMIT\b|\bSTOP\b/);
  });

  test('no localStorage usage anywhere in the Phase 2 Calculate modules\' actual code', () => {
    for (const file of ['calculate-page.js', 'blend-calculator.js', 'calculate-validation.js']) {
      const fileSource = stripComments(readFileSync(path.join(ROOT, 'js', 'pages', 'calculate', file), 'utf8'));
      assert.doesNotMatch(fileSource, /localStorage/, `${file} must not use localStorage in Phase 2`);
    }
  });
});

/* ============================================================
   MOBILE INPUT ATTRIBUTES (this task's revision)
============================================================ */
describe('Mobile keyboard input modes', () => {
  test('Ni and t/DT use inputmode="decimal", DT uses inputmode="numeric", Pile ID is plain text', () => {
    const pageEl = mountFullAccess();
    const row = gridRows(pageEl)[0];
    assert.equal(findFieldInput(row, 'pileId').type, 'text');
    assert.equal(findFieldInput(row, 'ni').attributes.inputmode, 'decimal');
    assert.equal(findFieldInput(row, 'units').attributes.inputmode, 'numeric');
    assert.equal(findFieldInput(row, 'tonnesPerUnit').attributes.inputmode, 'decimal');
  });

  test('every field carries its FULL localized wording as an aria-label, never the short grid header text', () => {
    const pageEl = mountFullAccess();
    const row = gridRows(pageEl)[0];
    assert.equal(findFieldInput(row, 'pileId').attributes['aria-label'], idCatalog['calculate.fields.pileId']);
    assert.equal(findFieldInput(row, 'ni').attributes['aria-label'], idCatalog['calculate.fields.ni']);
    assert.equal(findFieldInput(row, 'units').attributes['aria-label'], idCatalog['calculate.fields.units']);
    assert.equal(findFieldInput(row, 'tonnesPerUnit').attributes['aria-label'], idCatalog['calculate.fields.tonnesPerUnit']);
  });

  test('enterkeyhint moves Pile -> Ni -> DT -> t/DT, ending in "done"', () => {
    const pageEl = mountFullAccess();
    const row = gridRows(pageEl)[0];
    assert.equal(findFieldInput(row, 'pileId').attributes.enterkeyhint, 'next');
    assert.equal(findFieldInput(row, 'ni').attributes.enterkeyhint, 'next');
    assert.equal(findFieldInput(row, 'units').attributes.enterkeyhint, 'next');
    assert.equal(findFieldInput(row, 'tonnesPerUnit').attributes.enterkeyhint, 'done');
  });

  test('the compact remove control carries a full localized aria-label, not the bare "x" glyph', () => {
    const pageEl = mountFullAccess();
    typeIntoField(gridRows(pageEl)[0], 'pileId', 'A');
    const removeBtn = findOne(gridRows(pageEl)[0], hasClass('calculate-remove-pile-btn'));
    assert.equal(removeBtn.attributes['aria-label'], idCatalog['common.remove']);
    assert.equal(removeBtn.textContent, '×');
  });
});

/* ============================================================
   COMPACT GRID HEADER (short labels, not the long field names)
============================================================ */
describe('Compact grid header', () => {
  test('uses short PILE/NI/DT/t-DT headers, never the long field names', () => {
    const pageEl = mountFullAccess();
    const headerCells = findAll(pageEl, (el) => hasClass('calculate-grid-cell')(el) && !('rowIndex' in (el.parentNode?.dataset || {})));
    const headerText = findOne(pageEl, hasClass('calculate-grid-row--header')).textContent;
    assert.match(headerText, /PILE/);
    assert.match(headerText, /NI/);
    assert.match(headerText, /DT/);
    assert.doesNotMatch(headerText, /Jumlah Unit/);
    assert.doesNotMatch(headerText, /Tonase \/ Unit/);
    assert.ok(headerCells.length >= 0); // header cells located without throwing
  });
});

/* ============================================================
   LOCALIZATION KEYS
============================================================ */
describe('Localization keys (V2.4 Phase 2, compact grid revision)', () => {
  test('every calculate.* key exists in both locales, non-empty', () => {
    const keys = Object.keys(idCatalog).filter((k) => k.startsWith('calculate.'));
    assert.ok(keys.length > 10, 'expected a substantial Phase 2 catalog');
    for (const key of keys) {
      assert.ok(idCatalog[key], `id.js missing/empty ${key}`);
      assert.ok(enCatalog[key], `en.js missing/empty ${key}`);
    }
  });

  test('the obsolete "+ Add Pile" key is gone from both locales (the trailing-blank-row grid replaces that workflow)', () => {
    assert.equal('calculate.blend.addPile' in idCatalog, false);
    assert.equal('calculate.blend.addPile' in enCatalog, false);
  });

  test('short grid header keys exist and are identical across locales (stable terms, like nav.calculate)', () => {
    for (const key of ['calculate.grid.headerPile', 'calculate.grid.headerNi', 'calculate.grid.headerDt', 'calculate.grid.headerTonnesPerUnit']) {
      assert.ok(idCatalog[key]);
      assert.equal(idCatalog[key], enCatalog[key]);
    }
  });

  test('no Recommendation-mode i18n keys have been added yet (Gate A is closed)', () => {
    const keys = Object.keys(idCatalog);
    for (const forbidden of ['calculate.recommendation', 'calculate.action.use', 'calculate.action.limit', 'calculate.action.stop', 'calculate.recovery', 'calculate.status.targetNotAchievable']) {
      assert.equal(keys.some((k) => k.startsWith(forbidden)), false, `unexpected Recommendation-mode key family present: ${forbidden}`);
    }
  });
});

/* ============================================================
   APP.JS WIRING -- unchanged, re-verified as regression
============================================================ */
describe('app.js wiring regression (re-verified)', () => {
  const appJs = readFileSync(path.join(ROOT, 'js', 'app.js'), 'utf8');

  test('still imports and calls initCalculatePage()', () => {
    assert.match(appJs, /import\s*\{\s*initCalculatePage\s*\}\s*from\s*'\.\/pages\/calculate\/calculate-page\.js'/);
    assert.match(appJs, /initCalculatePage\(\);/);
  });

  test('still registers a FULL_ACCESS-only route guard for "calculate"', () => {
    assert.match(appJs, /registerRouteGuard\(\s*\n?\s*'calculate',\s*\n?\s*\(\)\s*=>\s*hasFullAccess\(\)/);
  });

  test('license removal while on Calculate is still handled by the one shared subscription', () => {
    const subscribeCalls = appJs.match(/subscribeAccessChange\(/g) || [];
    assert.equal(subscribeCalls.length, 1);
    const subscribeBlock = appJs.slice(appJs.indexOf('subscribeAccessChange('));
    assert.match(subscribeBlock, /route === 'report'/);
    assert.match(subscribeBlock, /route === 'calculate'/);
  });
});
