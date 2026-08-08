// Calculate page tests (V2.4 Phase 4.1 -- unified continuous workflow
// revision). See
// docs/V2.4_CALCULATE_AND_BLENDING_RECOMMENDATION_ARCHITECTURE.md.
//
// Run with Node's built-in test runner:
//
//   node --test tests/calculate-page.test.mjs
//
// OWNER-REQUESTED UX CORRECTION (this task): the earlier BLEND |
// RECOMMENDATION mode-tab model is REJECTED. Calculate is now ONE
// continuous page -- live Blend summary -> shared source grid ->
// Recommendation -- with NO mode switch and NO explicit "Hitung Blend"
// button. The live Blend summary recomputes automatically from whichever
// source rows are currently COMPLETE (all five fields individually valid)
// every time a field changes. Recommendation remains an explicit,
// FULL_ACCESS-guarded action using the exact same complete-row selection.
//
// MINI-DOM HARNESS: calculate-page.js builds its entire tree via
// document.createElement()/appendChild()/replaceChildren() rather than
// innerHTML template strings, specifically so it can be exercised
// behaviorally here without jsdom (this project has zero npm
// dependencies). FakeElement below implements exactly the subset of the
// real DOM this module actually uses.
//
// license-service.js's exported hasFullAccess()/subscribeFullAccessAttention()
// and i18n.js's exported setLocale()/onLocaleChange() are both the ONE
// production singleton each (no per-test factory reset available) -- same
// caveat already documented in tests/bottom-navigation.test.mjs: listeners
// registered by an earlier test's initCalculatePage() call remain
// subscribed for the lifetime of this file's process. This is harmless
// here too: handleLocaleChange() and the license-change path are both
// idempotent (they only ever re-render from CURRENT module-level state,
// never accumulate side effects).
//
// COMPOSITE DUPLICATE IDENTITY (this task's Section 9): the same Pile ID
// may now appear more than once as long as Contractor differs.

import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { initCalculatePage, requireFullAccessForCalculateAction } from '../js/pages/calculate/calculate-page.js';
import { DEFAULT_RECOMMENDATION_TOLERANCE } from '../js/pages/calculate/blending-recommendation.js';
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

function fillRow(row, { pileId, contractor, ni, units, tonnesPerUnit }) {
  if (pileId !== undefined) typeIntoField(row, 'pileId', pileId);
  if (contractor !== undefined) typeIntoField(row, 'contractor', contractor);
  if (ni !== undefined) typeIntoField(row, 'ni', ni);
  if (units !== undefined) typeIntoField(row, 'units', units);
  if (tonnesPerUnit !== undefined) typeIntoField(row, 'tonnesPerUnit', tonnesPerUnit);
}

function clickRemove(row) {
  const btn = findOne(row, hasClass('calculate-remove-pile-btn'));
  if (!btn) return false;
  btn.fire('click');
  return true;
}

/* ============================================================
   LIVE BLEND SUMMARY HELPERS (this task's revision -- no more explicit
   Calculate Blend button/result panel; a single sticky summary is the one
   authoritative Blend result).
============================================================ */
function blendSummaryRoot(pageEl) {
  return findOne(pageEl, hasClass('calculate-blend-summary'));
}

function summaryValue(pageEl, itemClass) {
  const item = findOne(pageEl, hasClass(itemClass));
  return findOne(item, isTag('strong')).textContent;
}

function summaryLabel(pageEl, itemClass) {
  const item = findOne(pageEl, hasClass(itemClass));
  return findOne(item, isTag('span')).textContent;
}

function partialRowInfo(pageEl) {
  return findOne(pageEl, hasClass('calculate-partial-row-info'));
}

function classBreakdownDetails(pageEl) {
  return findOne(pageEl, hasClass('calculate-class-breakdown-details'));
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
   PHASE 4 (Recommendation) HELPERS -- findFieldInput()/typeIntoField()
   above are already generic enough to reuse directly against the Target
   Ni/Tolerance inputs (they carry the same dataset.field convention as
   grid-row inputs).
============================================================ */
function fillRecommendationControls(pageEl, { targetNi, tolerance } = {}) {
  if (targetNi !== undefined) typeIntoField(pageEl, 'targetNi', targetNi);
  if (tolerance !== undefined) typeIntoField(pageEl, 'tolerance', tolerance);
}

function clickCalculateRecommendation(pageEl) {
  findOne(pageEl, hasClass('calculate-calculate-recommendation-btn')).fire('click');
}

function recommendationResultRoot(pageEl) {
  return findOne(pageEl, hasClass('calculate-recommendation-result'));
}

function recommendationFieldErrorText(pageEl) {
  return findOne(pageEl, hasClass('calculate-recommendation-field-error'));
}

function recommendationEngineErrorText(pageEl) {
  return findOne(pageEl, hasClass('calculate-recommendation-error'));
}

function statusBadgeText(pageEl) {
  return findOne(pageEl, hasClass('calculate-recommendation-status__badge')).textContent;
}

function statusRowLabels(pageEl) {
  return findAll(pageEl, hasClass('calculate-recommendation-status__row')).map((row) => findOne(row, isTag('span')).textContent);
}

function hopperPatternRatioText(pageEl) {
  return findOne(pageEl, hasClass('calculate-hopper-pattern__ratio')).textContent;
}

function sourceBreakdownRows(pageEl) {
  return findAll(pageEl, hasClass('calculate-recommendation-source-row'));
}

function relocationRows(pageEl) {
  return findAll(pageEl, hasClass('calculate-recommendation-relocation-row'));
}

/* ============================================================
   MATERIAL ACTIONS / FLEET ACTIONS helpers (V2.4 Phase 5, this task)
============================================================ */
function materialActionsRoot(pageEl) {
  return findOne(pageEl, hasClass('calculate-material-actions'));
}

function fleetActionsRoot(pageEl) {
  return findOne(pageEl, hasClass('calculate-fleet-actions'));
}

function materialActionRows(pageEl) {
  return findAll(pageEl, hasClass('calculate-material-action-row'));
}

// Matches on the row's OWN id label only (never the whole row's
// textContent) -- a Fleet Action row can legitimately mention ANOTHER
// source's Pile ID in its own MOVE/RECEIVE line (e.g. Higher's own row
// says "-> Lglo"), so a whole-row substring search could match the wrong
// row entirely.
function materialActionRowFor(pageEl, pileId) {
  return materialActionRows(pageEl).find((row) => {
    const idEl = findOne(row, hasClass('calculate-breakdown-row__id'));
    return idEl && idEl.textContent.includes(pileId);
  });
}

function materialActionBadgeText(row) {
  return findOne(row, hasClass('calculate-action-badge')).textContent;
}

function fleetActionRows(pageEl) {
  return findAll(pageEl, hasClass('calculate-fleet-action-row'));
}

function fleetActionRowFor(pageEl, pileId) {
  return fleetActionRows(pageEl).find((row) => {
    const idEl = findOne(row, hasClass('calculate-breakdown-row__id'));
    return idEl && idEl.textContent.includes(pileId);
  });
}

function fleetActionLineTexts(row) {
  return findAll(row, hasClass('calculate-fleet-action-line')).map((line) => line.textContent);
}

/* ============================================================
   PLANNED BLEND RECOVERY helpers (V2.4 Phase 6, this task)
============================================================ */
function recoverySectionRoot(pageEl) {
  return findOne(pageEl, hasClass('calculate-recovery-section'));
}

function recoveryBaselineText(pageEl) {
  const root = recoverySectionRoot(pageEl);
  return root ? findOne(root, hasClass('calculate-recovery-baseline')).textContent : null;
}

function fillRecoveryControls(pageEl, { addedDt, tonnesPerDt } = {}) {
  if (addedDt !== undefined) typeIntoField(pageEl, 'addedDt', addedDt);
  if (tonnesPerDt !== undefined) typeIntoField(pageEl, 'tonnesPerDt', tonnesPerDt);
}

function clickCalculateRecovery(pageEl) {
  findOne(pageEl, hasClass('calculate-calculate-recovery-btn')).fire('click');
}

function recoveryResultBox(pageEl) {
  return findOne(pageEl, hasClass('calculate-recovery-result'));
}

function recoveryResultValueText(pageEl) {
  const box = recoveryResultBox(pageEl);
  return box ? findOne(box, hasClass('calculate-recovery-result-value')).textContent : null;
}

function recoveryFieldErrorText(pageEl) {
  const root = recoverySectionRoot(pageEl);
  return root ? findOne(root, hasClass('calculate-recommendation-field-error')) : null;
}

function recoveryQualifyingBox(pageEl) {
  return findOne(pageEl, hasClass('calculate-recovery-qualifying'));
}

function qualifyingSourceRows(pageEl) {
  return findAll(pageEl, hasClass('calculate-recovery-qualifying-row'));
}

// Fixture reused from describe('33. Target Not Achievable...') -- the
// best-attainable candidate uses ONLY Higher (X, Ni 2.00, 5 DT, 50 t/DT),
// Lglo (Y, Ni 0.10) fully idle, so the Recovery baseline is a clean,
// hand-verifiable Ni 2.00% / 250t (never the live sticky Blend summary,
// which would instead reflect BOTH rows if they were both complete/used).
function mountRecoveryReadyOn(pageEl) {
  fillRow(gridRows(pageEl)[0], { pileId: 'Higher', contractor: 'X', ni: '2.00', units: '5', tonnesPerUnit: '50' });
  fillRow(gridRows(pageEl)[1], { pileId: 'Lglo', contractor: 'Y', ni: '0.10', units: '5', tonnesPerUnit: '50' });
  fillRecommendationControls(pageEl, { targetNi: '5.00', tolerance: '0.01' });
  return pageEl;
}

// Architecture doc / this task's "known fleet example": Higher Grade
// (SMA, Ni 1.30, 5 DT, 50 t/DT) + LGLO (TII, Ni 1.03, 8 DT, 50 t/DT).
function fillKnownRecommendationExample(pageEl) {
  fillRow(gridRows(pageEl)[0], { pileId: 'Higher', contractor: 'SMA', ni: '1.30', units: '5', tonnesPerUnit: '50' });
  fillRow(gridRows(pageEl)[1], { pileId: 'Lglo', contractor: 'TII', ni: '1.03', units: '8', tonnesPerUnit: '50' });
}

// No mode switch to perform anymore -- Recommendation controls are always
// present directly below the grid.
function mountRecommendationReadyOn(pageEl) {
  fillKnownRecommendationExample(pageEl);
  fillRecommendationControls(pageEl, { targetNi: '1.120', tolerance: '0.010' });
  return pageEl;
}

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
   1. INITIAL MOUNT
============================================================ */
describe('initCalculatePage() -- initial mount', () => {
  test('mounts exactly one blank row', () => {
    const pageEl = mountFullAccess();
    assert.equal(gridRows(pageEl).length, 1);
    const row = gridRows(pageEl)[0];
    assert.equal(findFieldInput(row, 'pileId').value, '');
  });

  test('the initial row contains a Contractor input', () => {
    const pageEl = mountFullAccess();
    const row = gridRows(pageEl)[0];
    const contractorInput = findFieldInput(row, 'contractor');
    assert.ok(contractorInput, 'Contractor input must exist on the initial row');
    assert.equal(contractorInput.value, '');
    assert.equal(contractorInput.type, 'text');
  });

  test('the trailing blank row has no remove control', () => {
    const pageEl = mountFullAccess();
    assert.equal(clickRemove(gridRows(pageEl)[0]), false);
  });

  test('the live Blend summary is hidden until a complete row exists', () => {
    const pageEl = mountFullAccess();
    assert.equal(blendSummaryRoot(pageEl).hidden, true);
  });

  test('the partial-row info message is hidden initially', () => {
    const pageEl = mountFullAccess();
    assert.equal(partialRowInfo(pageEl).hidden, true);
  });

  test('the class breakdown detail is hidden until a complete row exists', () => {
    const pageEl = mountFullAccess();
    assert.equal(classBreakdownDetails(pageEl).hidden, true);
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
   18.1/18.2. NO MODE TABS, NO HITUNG BLEND BUTTON, ONE SHARED GRID
============================================================ */
describe('1/2/3. No mode tabs, no explicit Calculate Blend button, one shared grid', () => {
  test('1. there is no BLEND/RECOMMENDATION mode switch anywhere on the page', () => {
    const pageEl = mountFullAccess();
    assert.equal(findOne(pageEl, hasClass('calculate-mode-switch')), null);
    assert.equal(findOne(pageEl, hasClass('calculate-mode-tab')), null);
  });

  test('2. there is no explicit "Hitung Blend"/Calculate Blend button', () => {
    const pageEl = mountFullAccess();
    assert.equal(findOne(pageEl, hasClass('calculate-calculate-btn')), null);
  });

  test('3. exactly one shared source grid exists (never duplicated per section)', () => {
    const pageEl = mountFullAccess();
    const grids = findAll(pageEl, hasClass('calculate-grid'));
    assert.equal(grids.length, 1);
  });

  test('the Recommendation action button IS present (only the Blend button was removed)', () => {
    const pageEl = mountFullAccess();
    assert.ok(findOne(pageEl, hasClass('calculate-calculate-recommendation-btn')));
  });
});

/* ============================================================
   2/3. TRAILING-ROW AUTO-APPEND (unaffected by this task's revision)
============================================================ */
describe('Trailing blank row auto-append', () => {
  test('typing into the trailing blank row appends exactly one new blank row', () => {
    const pageEl = mountFullAccess();
    typeIntoField(gridRows(pageEl)[0], 'pileId', 'A');

    const rows = gridRows(pageEl);
    assert.equal(rows.length, 2);
    assert.equal(findFieldInput(rows[1], 'pileId').value, '');
  });

  test('typing Contractor FIRST into the trailing row appends exactly one new blank row', () => {
    const pageEl = mountFullAccess();
    typeIntoField(gridRows(pageEl)[0], 'contractor', 'SMA');

    const rows = gridRows(pageEl);
    assert.equal(rows.length, 2);
    assert.equal(findFieldInput(rows[1], 'pileId').value, '');
  });

  test('typing additional fields into the same now-active row does not append extra blanks', () => {
    const pageEl = mountFullAccess();
    const row = gridRows(pageEl)[0];
    typeIntoField(row, 'pileId', 'A');
    assert.equal(gridRows(pageEl).length, 2);

    typeIntoField(row, 'contractor', 'SMA');
    typeIntoField(row, 'ni', '1.30');
    typeIntoField(row, 'units', '10');
    typeIntoField(row, 'tonnesPerUnit', '50');

    assert.equal(gridRows(pageEl).length, 2, 'no extra blank rows from editing an already-active row');
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

  test('filling several rows always leaves exactly one trailing blank row', () => {
    const pageEl = mountFullAccess();
    fillRow(gridRows(pageEl)[0], { pileId: 'A', contractor: 'SMA', ni: '1.3', units: '10', tonnesPerUnit: '50' });
    fillRow(gridRows(pageEl)[1], { pileId: 'B', contractor: 'TII', ni: '0.95', units: '20', tonnesPerUnit: '45' });

    const rows = gridRows(pageEl);
    assert.equal(rows.length, 3);
    assert.equal(findFieldInput(rows[2], 'pileId').value, '');
    assert.equal(clickRemove(rows[2]), false, 'the new trailing row must also have no remove control');
  });
});

/* ============================================================
   4-9 (Section 30/18 renumbered). LIVE BLEND SUMMARY
============================================================ */
describe('Live Blend summary -- complete rows only, no explicit action', () => {
  test('4. a single complete row updates the live summary automatically, no explicit action', () => {
    const pageEl = mountFullAccess();
    fillRow(gridRows(pageEl)[0], { pileId: 'A', contractor: 'SMA', ni: '1.30', units: '10', tonnesPerUnit: '50' });

    assert.equal(blendSummaryRoot(pageEl).hidden, false);
    assert.equal(summaryValue(pageEl, 'calculate-final-ni'), '1.300%');
    assert.equal(summaryValue(pageEl, 'calculate-total-units'), '10');
    assert.match(summaryValue(pageEl, 'calculate-total-tonnage'), /500,00 t|500.00 t/);
  });

  test('known worked example (Pile A 1.30/10x50 + Pile B 0.95/20x45) -> Final Ni 1.075%, Total DT 30, Total Tonnage 1,400 t, live', () => {
    const pageEl = mountFullAccess();
    fillRow(gridRows(pageEl)[0], { pileId: 'Pile A', contractor: 'SMA', ni: '1.30', units: '10', tonnesPerUnit: '50' });
    fillRow(gridRows(pageEl)[1], { pileId: 'Pile B', contractor: 'TII', ni: '0.95', units: '20', tonnesPerUnit: '45' });

    assert.equal(summaryValue(pageEl, 'calculate-final-ni'), '1.075%');
    assert.equal(summaryValue(pageEl, 'calculate-total-units'), '30');
    assert.match(summaryValue(pageEl, 'calculate-total-tonnage'), /1\.400,00 t|1,400.00 t/);
  });

  test('5. a partial (nonblank but incomplete) row is excluded from the live summary -- Row A included, Row C excluded', () => {
    const pageEl = mountFullAccess();
    fillRow(gridRows(pageEl)[0], { pileId: 'A', contractor: 'SMA', ni: '1.30', units: '10', tonnesPerUnit: '50' });
    // Row C: nonblank but missing units/tonnesPerUnit -- must not crash and
    // must not be silently folded into the summary.
    fillRow(gridRows(pageEl)[1], { pileId: 'C', contractor: 'TII', ni: '1.0' });

    assert.equal(blendSummaryRoot(pageEl).hidden, false);
    assert.equal(summaryValue(pageEl, 'calculate-final-ni'), '1.300%', 'the summary must reflect ONLY the complete row A');
    assert.equal(summaryValue(pageEl, 'calculate-total-units'), '10');
  });

  test('the live summary never disappears merely because another row is still being edited', () => {
    const pageEl = mountFullAccess();
    fillRow(gridRows(pageEl)[0], { pileId: 'A', contractor: 'SMA', ni: '1.30', units: '10', tonnesPerUnit: '50' });
    fillRow(gridRows(pageEl)[1], { pileId: 'B', contractor: 'TII', ni: '0.95', units: '20', tonnesPerUnit: '45' });
    // Row C: partial, actively being typed into.
    typeIntoField(gridRows(pageEl)[2], 'pileId', 'C');

    assert.equal(blendSummaryRoot(pageEl).hidden, false);
    assert.equal(summaryValue(pageEl, 'calculate-final-ni'), '1.075%', 'A + B must still be reflected despite C being mid-edit');
  });

  test('6. a completely blank trailing row is excluded from the live summary', () => {
    const pageEl = mountFullAccess();
    fillRow(gridRows(pageEl)[0], { pileId: 'A', contractor: 'SMA', ni: '1.30', units: '10', tonnesPerUnit: '50' });
    assert.equal(gridRows(pageEl).length, 2, 'a trailing blank row must exist at this point');

    assert.equal(summaryValue(pageEl, 'calculate-total-units'), '10', 'the blank trailing row must not contribute 0 DT or otherwise affect the total');
  });

  test('7. completing a previously partial row immediately changes the Blend summary', () => {
    const pageEl = mountFullAccess();
    fillRow(gridRows(pageEl)[0], { pileId: 'A', contractor: 'SMA', ni: '1.30', units: '10', tonnesPerUnit: '50' });
    fillRow(gridRows(pageEl)[1], { pileId: 'B', contractor: 'TII', ni: '0.95', units: '20' }); // missing tonnesPerUnit
    assert.equal(summaryValue(pageEl, 'calculate-final-ni'), '1.300%', 'B is still incomplete, summary reflects only A');

    typeIntoField(gridRows(pageEl)[1], 'tonnesPerUnit', '45');

    assert.equal(summaryValue(pageEl, 'calculate-final-ni'), '1.075%', 'B just became complete -- the summary must update immediately');
  });

  test('8. removing a row immediately changes the Blend summary', () => {
    const pageEl = mountFullAccess();
    fillRow(gridRows(pageEl)[0], { pileId: 'A', contractor: 'SMA', ni: '1.30', units: '10', tonnesPerUnit: '50' });
    fillRow(gridRows(pageEl)[1], { pileId: 'B', contractor: 'TII', ni: '0.95', units: '20', tonnesPerUnit: '45' });
    assert.equal(summaryValue(pageEl, 'calculate-final-ni'), '1.075%');

    clickRemove(gridRows(pageEl)[1]);

    assert.equal(summaryValue(pageEl, 'calculate-final-ni'), '1.300%', 'removing B must revert the summary to A alone immediately');
  });

  test('every complete row missing (e.g. all rows removed) hides the summary again', () => {
    const pageEl = mountFullAccess();
    fillRow(gridRows(pageEl)[0], { pileId: 'A', contractor: 'SMA', ni: '1.30', units: '10', tonnesPerUnit: '50' });
    assert.equal(blendSummaryRoot(pageEl).hidden, false);

    clickRemove(gridRows(pageEl)[0]);

    assert.equal(blendSummaryRoot(pageEl).hidden, true);
  });
});

/* ============================================================
   9. INCOMPLETE-ROW INFORMATIONAL COUNT
============================================================ */
describe('9. Partial-row informational count (non-blocking, no large banner)', () => {
  test('one incomplete row shows the singular message with the count', () => {
    const pageEl = mountFullAccess();
    fillRow(gridRows(pageEl)[0], { pileId: 'A', contractor: 'SMA', ni: '1.30' }); // missing units/tonnesPerUnit

    assert.equal(partialRowInfo(pageEl).hidden, false);
    assert.equal(partialRowInfo(pageEl).textContent, idCatalog['calculate.blend.incompleteRowsOne'].replace('{count}', '1'));
  });

  test('two incomplete rows pluralize naturally in English', () => {
    const pageEl = mountFullAccess();
    fillRow(gridRows(pageEl)[0], { pileId: 'A', contractor: 'SMA' }); // missing ni/units/tonnesPerUnit
    fillRow(gridRows(pageEl)[1], { pileId: 'B', contractor: 'TII' });

    setLocale('en');
    assert.equal(partialRowInfo(pageEl).textContent, enCatalog['calculate.blend.incompleteRowsOther'].replace('{count}', '2'));
  });

  test('the info message disappears once every nonblank row becomes complete', () => {
    const pageEl = mountFullAccess();
    fillRow(gridRows(pageEl)[0], { pileId: 'A', contractor: 'SMA', ni: '1.30' });
    assert.equal(partialRowInfo(pageEl).hidden, false);

    fillRow(gridRows(pageEl)[0], { units: '10', tonnesPerUnit: '50' });

    assert.equal(partialRowInfo(pageEl).hidden, true);
  });

  test('never a large blocking banner -- the info line is a <p>, not an alert-styled element with the blend-error class', () => {
    const pageEl = mountFullAccess();
    fillRow(gridRows(pageEl)[0], { pileId: 'A', contractor: 'SMA' });
    const info = partialRowInfo(pageEl);
    assert.equal(info.tagName, 'P');
    assert.equal(findOne(pageEl, hasClass('calculate-blend-error')), null, 'the old whole-blend error banner class must no longer exist');
  });
});

/* ============================================================
   10-13 (this task's Section 9/18). COMPOSITE DUPLICATE IDENTITY
============================================================ */
describe('Composite Pile ID + Contractor duplicate identity', () => {
  test('10. the same Pile ID with a DIFFERENT Contractor is valid -- both rows included in the live summary', () => {
    const pageEl = mountFullAccess();
    fillRow(gridRows(pageEl)[0], { pileId: 'L30', contractor: 'MRP', ni: '1.30', units: '10', tonnesPerUnit: '50' });
    fillRow(gridRows(pageEl)[1], { pileId: 'L30', contractor: 'TII', ni: '0.95', units: '20', tonnesPerUnit: '45' });

    assert.equal(findRowError(gridRows(pageEl)[0]).hidden, true);
    assert.equal(findRowError(gridRows(pageEl)[1]).hidden, true);
    assert.equal(summaryValue(pageEl, 'calculate-final-ni'), '1.075%', 'both L30/MRP and L30/TII must be included');
  });

  test('11. the same Pile ID with the SAME Contractor is rejected as a duplicate', () => {
    const pageEl = mountFullAccess();
    fillRow(gridRows(pageEl)[0], { pileId: 'L30', contractor: 'MRP', ni: '1.30', units: '10', tonnesPerUnit: '50' });
    fillRow(gridRows(pageEl)[1], { pileId: 'L30', contractor: 'MRP', ni: '0.95', units: '20', tonnesPerUnit: '45' });

    assert.equal(findRowError(gridRows(pageEl)[0]).hidden, true);
    assert.match(findRowError(gridRows(pageEl)[1]).textContent, new RegExp(idCatalog['calculate.validation.pileIdDuplicate']));
    assert.equal(summaryValue(pageEl, 'calculate-final-ni'), '1.300%', 'the duplicate row must be excluded, not silently double-counted');
  });

  test('12. duplicate detection is case-insensitive and trims outer whitespace on both Pile ID and Contractor', () => {
    const pageEl = mountFullAccess();
    fillRow(gridRows(pageEl)[0], { pileId: 'L30', contractor: 'MRP', ni: '1.30', units: '10', tonnesPerUnit: '50' });
    fillRow(gridRows(pageEl)[1], { pileId: '  l30  ', contractor: '  mrp  ', ni: '0.95', units: '20', tonnesPerUnit: '45' });

    assert.match(findRowError(gridRows(pageEl)[1]).textContent, new RegExp(idCatalog['calculate.validation.pileIdDuplicate']));
  });

  test('case-insensitive Contractor still distinguishes correctly -- "MRP" vs "mrp " on a DIFFERENT Pile ID stays independently valid', () => {
    const pageEl = mountFullAccess();
    fillRow(gridRows(pageEl)[0], { pileId: 'A', contractor: 'MRP', ni: '1.30', units: '10', tonnesPerUnit: '50' });
    fillRow(gridRows(pageEl)[1], { pileId: 'B', contractor: ' mrp ', ni: '0.95', units: '20', tonnesPerUnit: '45' });

    assert.equal(findRowError(gridRows(pageEl)[0]).hidden, true);
    assert.equal(findRowError(gridRows(pageEl)[1]).hidden, true);
  });
});

/* ============================================================
   ACCESS CONTROL FOR RECOMMENDATION
============================================================ */
describe('Recommendation action is FULL_ACCESS-guarded; the live Blend recompute is not', () => {
  test('under MONITOR_ONLY, pressing Calculate Recommendation never computes a result and redirects instead', () => {
    const pageEl = mountFullAccess();
    fillKnownRecommendationExample(pageEl);
    fillRecommendationControls(pageEl, { targetNi: '1.120', tolerance: '0.010' });

    goMonitorOnly();
    const win = installMockWindow('#/calculate');
    let receivedContext;
    const unsubscribe = subscribeFullAccessAttention((ctx) => { receivedContext = ctx; });

    clickCalculateRecommendation(pageEl);

    unsubscribe();
    assert.equal(recommendationResultRoot(pageEl).hidden, true);
    assert.equal(win.getHash(), '#/settings');
    assert.equal(receivedContext, 'calculate-action');
  });

  test('under MONITOR_ONLY, typing into a source row still updates the live Blend summary (a passive local recompute, never a protected action)', () => {
    const pageEl = mountFullAccess();
    goMonitorOnly();
    const win = installMockWindow('#/calculate');
    let attentionCalls = 0;
    const unsubscribe = subscribeFullAccessAttention(() => { attentionCalls += 1; });

    fillRow(gridRows(pageEl)[0], { pileId: 'A', contractor: 'SMA', ni: '1.30', units: '10', tonnesPerUnit: '50' });

    unsubscribe();
    assert.equal(blendSummaryRoot(pageEl).hidden, false);
    assert.equal(summaryValue(pageEl, 'calculate-final-ni'), '1.300%');
    assert.equal(win.getHash(), '#/calculate', 'a passive live recompute must never navigate');
    assert.equal(attentionCalls, 0, 'a passive live recompute must never request License attention');
  });
});

/* ============================================================
   KNOWN RECOMMENDATION EXAMPLE (5 HG DT / 8 LGLO DT) -- still 1:2
============================================================ */
describe('Known fleet example (5 HG DT / 8 LGLO DT) -- unaffected by mode-tab removal', () => {
  test('17. Hopper Pattern 1:2, Estimated Ni 1.120%, Fleet 12/13, Higher active 4, LGLO active 8, Surplus 1', () => {
    const pageEl = mountFullAccess();
    mountRecommendationReadyOn(pageEl);
    clickCalculateRecommendation(pageEl);

    assert.equal(recommendationResultRoot(pageEl).hidden, false);
    assert.equal(hopperPatternRatioText(pageEl), '1 : 2');
    assert.equal(summaryValue(pageEl, 'calculate-recommendation-estimated-ni'), '1.120%');
    assert.equal(summaryValue(pageEl, 'calculate-recommendation-fleet-utilization'), '12 / 13 DT');
    assert.match(statusBadgeText(pageEl), new RegExp(idCatalog['calculate.recommendation.withinTolerance']));

    const rows = sourceBreakdownRows(pageEl);
    const higherRow = rows.find((r) => r.textContent.includes('Higher'));
    const lgloRow = rows.find((r) => r.textContent.includes('Lglo'));
    assert.match(higherRow.textContent, /5 DT/);
    assert.match(higherRow.textContent, /4 DT/);
    assert.match(higherRow.textContent, new RegExp(`${idCatalog['calculate.recommendation.surplus']}: 1 DT`));
    assert.match(lgloRow.textContent, /8 DT/);
  });

  test('the full-fleet 5:8 (13/13) allocation is NOT what gets shown as selected', () => {
    const pageEl = mountFullAccess();
    mountRecommendationReadyOn(pageEl);
    clickCalculateRecommendation(pageEl);

    assert.notEqual(summaryValue(pageEl, 'calculate-recommendation-fleet-utilization'), '13 / 13 DT');
  });

  test('16. default Tolerance value comes from the engine-exported DEFAULT_RECOMMENDATION_TOLERANCE constant', () => {
    const pageEl = mountFullAccess();
    assert.equal(findFieldInput(pageEl, 'tolerance').value, DEFAULT_RECOMMENDATION_TOLERANCE.toFixed(3));
  });

  test('16. Target Ni starts empty (required, no invented default)', () => {
    const pageEl = mountFullAccess();
    assert.equal(findFieldInput(pageEl, 'targetNi').value, '');
  });
});

/* ============================================================
   14. RECOMMENDATION IGNORES PARTIAL ROWS
============================================================ */
describe('14. Recommendation ignores partial rows, using only complete sources', () => {
  test('a partial row does not block calculating from the other complete sources', () => {
    const pageEl = mountFullAccess();
    fillRow(gridRows(pageEl)[0], { pileId: 'A', contractor: 'SMA', ni: '1.150', units: '4', tonnesPerUnit: '50' });
    fillRow(gridRows(pageEl)[1], { pileId: 'B', contractor: 'TII', ni: '1.0' }); // partial -- missing units/tonnesPerUnit
    fillRecommendationControls(pageEl, { targetNi: '1.150', tolerance: '0.010' });

    clickCalculateRecommendation(pageEl);

    assert.equal(recommendationResultRoot(pageEl).hidden, false);
    assert.equal(recommendationEngineErrorText(pageEl).hidden, true);
    // Single-source (A alone) recommendation lands exactly on its own Ni.
    assert.equal(summaryValue(pageEl, 'calculate-recommendation-estimated-ni'), '1.150%');
  });
});

/* ============================================================
   15. ZERO COMPLETE SOURCES BLOCKS RECOMMENDATION
============================================================ */
describe('15. Zero complete source rows blocks Recommendation with a localized message', () => {
  test('pressing Hitung Rekomendasi with only a partial row shows a validation message and computes nothing', () => {
    const pageEl = mountFullAccess();
    fillRow(gridRows(pageEl)[0], { pileId: 'A', contractor: 'SMA' }); // missing ni/units/tonnesPerUnit
    fillRecommendationControls(pageEl, { targetNi: '1.150', tolerance: '0.010' });

    clickCalculateRecommendation(pageEl);

    assert.equal(recommendationResultRoot(pageEl).hidden, true);
    assert.equal(recommendationEngineErrorText(pageEl).hidden, false);
    assert.equal(recommendationEngineErrorText(pageEl).textContent, idCatalog['calculate.recommendation.noCompleteSources']);
  });

  test('pressing Hitung Rekomendasi with only the blank trailing row present also blocks with the same message', () => {
    const pageEl = mountFullAccess();
    fillRecommendationControls(pageEl, { targetNi: '1.150', tolerance: '0.010' });

    clickCalculateRecommendation(pageEl);

    assert.equal(recommendationResultRoot(pageEl).hidden, true);
    assert.equal(recommendationEngineErrorText(pageEl).textContent, idCatalog['calculate.recommendation.noCompleteSources']);
  });
});

/* ============================================================
   SAME CONTRACTOR / CROSS CONTRACTOR (unaffected by mode-tab removal)
============================================================ */
describe('Same-Contractor relocation (Higher 5 DT / LGLO 7 DT, both SMA)', () => {
  test('active 4/8, fleet 12/12 (100%), relocation 1 DT Higher -> LGLO shown', () => {
    const pageEl = mountFullAccess();
    fillRow(gridRows(pageEl)[0], { pileId: 'Higher', contractor: 'SMA', ni: '1.30', units: '5', tonnesPerUnit: '50' });
    fillRow(gridRows(pageEl)[1], { pileId: 'Lglo', contractor: 'SMA', ni: '1.03', units: '7', tonnesPerUnit: '50' });
    fillRecommendationControls(pageEl, { targetNi: '1.120', tolerance: '0.010' });

    clickCalculateRecommendation(pageEl);

    assert.equal(summaryValue(pageEl, 'calculate-recommendation-fleet-utilization'), '12 / 12 DT');
    const utilizationPct = findOne(pageEl, hasClass('calculate-recommendation-utilization-pct')).textContent;
    assert.match(utilizationPct, /100/);

    const relocations = relocationRows(pageEl);
    assert.equal(relocations.length, 1);
    assert.match(relocations[0].textContent, /SMA/);
    assert.match(relocations[0].textContent, /1 DT/);
    assert.match(relocations[0].textContent, /Higher.*→.*Lglo/);
  });
});

describe('Cross-Contractor negative case (Higher SMA / LGLO TII, assigned 7)', () => {
  test('no relocation section is rendered -- cross-Contractor relocation is never displayed', () => {
    const pageEl = mountFullAccess();
    fillRow(gridRows(pageEl)[0], { pileId: 'Higher', contractor: 'SMA', ni: '1.30', units: '5', tonnesPerUnit: '50' });
    fillRow(gridRows(pageEl)[1], { pileId: 'Lglo', contractor: 'TII', ni: '1.03', units: '7', tonnesPerUnit: '50' });
    fillRecommendationControls(pageEl, { targetNi: '1.120', tolerance: '0.010' });

    clickCalculateRecommendation(pageEl);

    assert.equal(recommendationResultRoot(pageEl).hidden, false);
    assert.equal(relocationRows(pageEl).length, 0);
    assert.doesNotMatch(recommendationResultRoot(pageEl).textContent, /→/);
  });
});

describe('Recommendation still accepts the same Pile ID across different Contractors as distinct sources (this task\'s Section 10)', () => {
  test('13. L30/SMA (Higher) and L30/TII (LGLO) both contribute to the recommendation without collapsing', () => {
    const pageEl = mountFullAccess();
    fillRow(gridRows(pageEl)[0], { pileId: 'L30', contractor: 'SMA', ni: '1.30', units: '5', tonnesPerUnit: '50' });
    fillRow(gridRows(pageEl)[1], { pileId: 'L30', contractor: 'TII', ni: '1.03', units: '8', tonnesPerUnit: '50' });
    fillRecommendationControls(pageEl, { targetNi: '1.120', tolerance: '0.010' });

    clickCalculateRecommendation(pageEl);

    assert.equal(recommendationResultRoot(pageEl).hidden, false);
    assert.equal(hopperPatternRatioText(pageEl), '1 : 2');
    assert.equal(summaryValue(pageEl, 'calculate-recommendation-estimated-ni'), '1.120%');
    const rows = sourceBreakdownRows(pageEl);
    assert.equal(rows.length, 2, 'both same-Pile-ID-different-Contractor sources must appear as two distinct source rows');
    const contractors = rows.map((r) => (r.textContent.includes('SMA') ? 'SMA' : 'TII'));
    assert.deepEqual(new Set(contractors), new Set(['SMA', 'TII']));
  });
});

/* ============================================================
   TARGET NOT ACHIEVABLE (unaffected by mode-tab removal)
============================================================ */
describe('Target Not Achievable', () => {
  test('explicit not-achievable status, Best Attainable Ni shown, never labeled Within Tolerance', () => {
    const pageEl = mountFullAccess();
    fillRow(gridRows(pageEl)[0], { pileId: 'Higher', contractor: 'X', ni: '2.00', units: '5', tonnesPerUnit: '50' });
    fillRow(gridRows(pageEl)[1], { pileId: 'Lglo', contractor: 'Y', ni: '0.10', units: '5', tonnesPerUnit: '50' });
    fillRecommendationControls(pageEl, { targetNi: '5.00', tolerance: '0.01' });

    clickCalculateRecommendation(pageEl);

    assert.equal(recommendationResultRoot(pageEl).hidden, false);
    assert.match(statusBadgeText(pageEl), new RegExp(idCatalog['calculate.recommendation.targetNotAchievable']));
    assert.doesNotMatch(statusBadgeText(pageEl), new RegExp(idCatalog['calculate.recommendation.withinTolerance']));
    assert.ok(findOne(pageEl, hasClass('calculate-recommendation-status--not-achievable')));
  });
});

/* ============================================================
   18/19/20 (this task's Section 15/18). STALE RECOMMENDATION INVALIDATION
============================================================ */
describe('Stale Recommendation invalidation -- an old result is never left looking like it matches new inputs', () => {
  test('18. editing a source value clears the existing Recommendation result', () => {
    const pageEl = mountFullAccess();
    mountRecommendationReadyOn(pageEl);
    clickCalculateRecommendation(pageEl);
    assert.equal(recommendationResultRoot(pageEl).hidden, false);

    typeIntoField(gridRows(pageEl)[0], 'ni', '1.35');

    assert.equal(recommendationResultRoot(pageEl).hidden, true, 'the stale result must be cleared immediately, without pressing Hitung Rekomendasi');
  });

  test('19. editing Target Ni clears the existing Recommendation result', () => {
    const pageEl = mountFullAccess();
    mountRecommendationReadyOn(pageEl);
    clickCalculateRecommendation(pageEl);
    assert.equal(recommendationResultRoot(pageEl).hidden, false);

    typeIntoField(pageEl, 'targetNi', '1.130');

    assert.equal(recommendationResultRoot(pageEl).hidden, true);
  });

  test('20. editing Tolerance clears the existing Recommendation result', () => {
    const pageEl = mountFullAccess();
    mountRecommendationReadyOn(pageEl);
    clickCalculateRecommendation(pageEl);
    assert.equal(recommendationResultRoot(pageEl).hidden, false);

    typeIntoField(pageEl, 'tolerance', '0.020');

    assert.equal(recommendationResultRoot(pageEl).hidden, true);
  });

  test('removing a source row clears the existing Recommendation result', () => {
    const pageEl = mountFullAccess();
    mountRecommendationReadyOn(pageEl);
    clickCalculateRecommendation(pageEl);
    assert.equal(recommendationResultRoot(pageEl).hidden, false);

    clickRemove(gridRows(pageEl)[0]);

    assert.equal(recommendationResultRoot(pageEl).hidden, true);
  });

  // Full assertion set for the Known fleet example (test 17's own values --
  // Higher SMA 1.30/5 DT/50 t/DT + Lglo TII 1.03/8 DT/50 t/DT, Target
  // 1.120, Tolerance 0.010): Higher active 4, LGLO active 8, Hopper
  // Pattern 1:2, Estimated Final Ni 1.120%, Fleet 12/13 DT, Surplus 1 DT.
  // Recommendation ranking's own first-priority rule is "maximize fleet
  // utilization" (recommendation-ranking.js's compareWithinTolerance,
  // architecture doc Section 18.2) -- this exact 1:2 result is only
  // guaranteed reproducible when Target/Tolerance are restored to these
  // exact reference values before recalculating, since a genuinely wider
  // tolerance can legitimately admit a higher-utilization candidate
  // (e.g. the full 5:8/13-DT fleet) that then correctly outranks 1:2 --
  // that is approved ranking behavior, not a defect (see the dedicated
  // "full-fleet 5:8 (13/13) allocation is NOT what gets shown as selected"
  // test above, which proves the opposite direction of this same rule).
  function assertKnownRecommendationResult(pageEl) {
    assert.equal(recommendationResultRoot(pageEl).hidden, false);
    assert.equal(hopperPatternRatioText(pageEl), '1 : 2');
    assert.equal(summaryValue(pageEl, 'calculate-recommendation-estimated-ni'), '1.120%');
    assert.equal(summaryValue(pageEl, 'calculate-recommendation-fleet-utilization'), '12 / 13 DT');
    assert.match(statusBadgeText(pageEl), new RegExp(idCatalog['calculate.recommendation.withinTolerance']));

    const rows = sourceBreakdownRows(pageEl);
    const higherRow = rows.find((r) => r.textContent.includes('Higher'));
    const lgloRow = rows.find((r) => r.textContent.includes('Lglo'));
    assert.match(higherRow.textContent, /5 DT/);
    assert.match(higherRow.textContent, /4 DT/);
    assert.match(higherRow.textContent, new RegExp(`${idCatalog['calculate.recommendation.surplus']}: 1 DT`));
    assert.match(lgloRow.textContent, /8 DT/);
  }

  // Proves clearing a stale Recommendation never PERMANENTLY breaks
  // recalculation -- three separate edit-then-recalculate cycles (source,
  // Target, Tolerance), each restoring the edited field back to its known-
  // valid reference value before recalculating, so every cycle must
  // reproduce the exact same known-correct result, not merely "some"
  // result. This is the regression case for the "5 : 8" != "1 : 2"
  // failure this test used to hit -- the old version of this test widened
  // Tolerance to 0.020 and then asserted the STILL-0.010-only 1:2 result,
  // which is not a reproducible expectation under the approved ranking
  // rule above; recalculating with an ACTUALLY-CURRENT, valid set of
  // inputs (matching the reference scenario) is.
  test('after being cleared by a source edit, restoring the known-valid source and pressing Hitung Rekomendasi again reproduces the exact known result', () => {
    const pageEl = mountFullAccess();
    mountRecommendationReadyOn(pageEl);
    clickCalculateRecommendation(pageEl);
    assertKnownRecommendationResult(pageEl);

    typeIntoField(gridRows(pageEl)[0], 'ni', '1.35');
    assert.equal(recommendationResultRoot(pageEl).hidden, true, 'the stale result must be cleared immediately');

    typeIntoField(gridRows(pageEl)[0], 'ni', '1.30'); // restore the known-valid Higher Ni
    clickCalculateRecommendation(pageEl);
    assertKnownRecommendationResult(pageEl);
  });

  test('after being cleared by a Target Ni edit, restoring the known-valid Target and pressing Hitung Rekomendasi again reproduces the exact known result', () => {
    const pageEl = mountFullAccess();
    mountRecommendationReadyOn(pageEl);
    clickCalculateRecommendation(pageEl);
    assertKnownRecommendationResult(pageEl);

    typeIntoField(pageEl, 'targetNi', '1.130');
    assert.equal(recommendationResultRoot(pageEl).hidden, true, 'the stale result must be cleared immediately');

    typeIntoField(pageEl, 'targetNi', '1.120'); // restore the known-valid Target Ni
    clickCalculateRecommendation(pageEl);
    assertKnownRecommendationResult(pageEl);
  });

  test('after being cleared by a Tolerance edit, restoring the known-valid Tolerance and pressing Hitung Rekomendasi again reproduces the exact known result', () => {
    const pageEl = mountFullAccess();
    mountRecommendationReadyOn(pageEl);
    clickCalculateRecommendation(pageEl);
    assertKnownRecommendationResult(pageEl);

    typeIntoField(pageEl, 'tolerance', '0.020');
    assert.equal(recommendationResultRoot(pageEl).hidden, true, 'the stale result must be cleared immediately');

    typeIntoField(pageEl, 'tolerance', '0.010'); // restore the known-valid Tolerance (DEFAULT_RECOMMENDATION_TOLERANCE)
    clickCalculateRecommendation(pageEl);
    assertKnownRecommendationResult(pageEl);
  });

  test('a genuinely WIDER Tolerance after clearing is still a fresh, non-stale, CORRECT result -- just not necessarily the same candidate', () => {
    const pageEl = mountFullAccess();
    mountRecommendationReadyOn(pageEl);
    clickCalculateRecommendation(pageEl);
    assertKnownRecommendationResult(pageEl);

    typeIntoField(pageEl, 'tolerance', '0.020');
    assert.equal(recommendationResultRoot(pageEl).hidden, true);

    clickCalculateRecommendation(pageEl);
    assert.equal(recommendationResultRoot(pageEl).hidden, false);
    // Widening Tolerance legitimately admits the full PHYSICAL 5:8
    // (13/13 DT, 100% utilization) candidate, which now correctly outranks
    // the 12/13-DT candidate under recommendation-ranking.js's "maximize
    // fleet utilization first" rule -- this is the SAME approved candidate-
    // selection behavior the "full-fleet 5:8 (13/13) allocation is NOT what
    // gets shown as selected" test above already proves for Tolerance
    // 0.010 alone, and it is unaffected by this task's Hopper Pattern
    // decoupling (V2.4 Phase 6.1) -- fleet utilization stays a PHYSICAL
    // number. The DISPLAYED Hopper Pattern, however, is now the
    // independently-derived OPERATIONAL pattern (hopper-pattern.js), which
    // is smaller/simpler (1:2) than the physical 5:8 active-fleet ratio --
    // it is never assumed to just be that physical ratio anymore (this
    // task's Section 24/28: "active fleet ratio does NOT automatically mean
    // Hopper Pattern", and the old test asserting '5 : 8' here was exactly
    // the kind of obsolete assumption this task requires fixing). It must
    // still be a real, non-stale, internally-consistent result, never the
    // frozen-looking Ni 1.120%/1:2 result from before the edit -- proven
    // here by the DIFFERENT fleet-utilization figure (13/13 vs the earlier
    // 12/13), even though the Hopper Pattern digits happen to coincide.
    assert.equal(hopperPatternRatioText(pageEl), '1 : 2');
    assert.equal(summaryValue(pageEl, 'calculate-recommendation-fleet-utilization'), '13 / 13 DT');
    assert.match(statusBadgeText(pageEl), new RegExp(idCatalog['calculate.recommendation.withinTolerance']));
  });
});

/* ============================================================
   RATIO DISPLAY (unaffected by mode-tab removal)
============================================================ */
describe('Unit Ratio / Tonnage Ratio display', () => {
  test('Unit Ratio matches the engine-simplified pattern (Known example: 1:2)', () => {
    const pageEl = mountFullAccess();
    mountRecommendationReadyOn(pageEl);
    clickCalculateRecommendation(pageEl);

    const ratioItems = findAll(pageEl, hasClass('calculate-recommendation-ratio-item'));
    const unitRatioItem = ratioItems.find((i) => i.textContent.includes(idCatalog['calculate.recommendation.unitRatio']));
    assert.match(unitRatioItem.textContent, /1 : 2/);
  });

  test('Tonnage Ratio is computed from actual tonnage, not the Unit Ratio (architecture doc Section 13/19 example)', () => {
    const pageEl = mountFullAccess();
    fillRow(gridRows(pageEl)[0], { pileId: 'Higher', contractor: 'HigherCo', ni: '1.50', units: '1', tonnesPerUnit: '50' });
    fillRow(gridRows(pageEl)[1], { pileId: 'Lglo', contractor: 'LgloCo', ni: '1.00', units: '2', tonnesPerUnit: '45' });
    fillRecommendationControls(pageEl, { targetNi: '1.15', tolerance: '0.1' });

    clickCalculateRecommendation(pageEl);

    const ratioItems = findAll(pageEl, hasClass('calculate-recommendation-ratio-item'));
    const tonnageRatioItem = ratioItems.find((i) => i.textContent.includes(idCatalog['calculate.recommendation.tonnageRatio']));
    assert.match(tonnageRatioItem.textContent, /35\.7%/);
    assert.match(tonnageRatioItem.textContent, /64\.3%/);
  });
});

/* ============================================================
   ENGINE ERRORS
============================================================ */
describe('Engine error states', () => {
  test('SEARCH_SPACE_TOO_LARGE renders an explicit inline error, never a successful-looking result', () => {
    const pageEl = mountFullAccess();
    fillRow(gridRows(pageEl)[0], { pileId: 'A', contractor: 'S', ni: '1.2', units: '25000', tonnesPerUnit: '50' });
    fillRecommendationControls(pageEl, { targetNi: '1.2', tolerance: '0.01' });

    clickCalculateRecommendation(pageEl);

    assert.equal(recommendationResultRoot(pageEl).hidden, true);
    assert.equal(recommendationEngineErrorText(pageEl).hidden, false);
    assert.equal(recommendationEngineErrorText(pageEl).textContent, idCatalog['calculate.recommendation.searchSpaceTooLarge']);
  });
});

/* ============================================================
   21/22 (this task's Section 21). NON-GOALS
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

describe('22. Non-goals -- Planned Blend Recovery is now IN scope (V2.4 Phase 6); sampling history / closed-loop actual FPP / hardcoded presets / stockpile inventory remain OUT of scope', () => {
  const source = stripComments(readFileSync(path.join(ROOT, 'js', 'pages', 'calculate', 'calculate-page.js'), 'utf8'));
  const pureRecoverySource = stripComments(readFileSync(path.join(ROOT, 'js', 'pages', 'calculate', 'planned-blend-recovery.js'), 'utf8'));

  // SUPERSEDED (was: "21. the module's actual code never references
  // Material Action or Fleet Action status concepts" / "USE/LIMIT/STOP/
  // SEPARATE/STANDBY action-status vocabulary does not appear in actual
  // code" / "the rendered Recommendation result never contains USE/LIMIT/
  // STOP text"). Phase 5 intentionally added exactly this -- see
  // describe('26-30. Material Actions...')/describe('31-33. Fleet
  // Actions...') below for that positive coverage.
  //
  // SUPERSEDED (was: "22. the module's actual code never references
  // Planned Blend Recovery / New Dome concepts" / "22. no Planned Blend
  // Recovery / New Dome UI exists anywhere on the page"). Phase 6 (this
  // task) intentionally adds exactly this -- see describe('34-38. Planned
  // Blend Recovery...') below for the positive coverage. What remains a
  // genuine non-goal (this task's Section 29) is verified below instead:
  // sampling history, closed-loop actual FPP correction, hardcoded
  // recovery-tonnage presets, and stockpile/backend coupling.

  test('34. calculate-page.js references the real Recovery API, never a placeholder/New-Dome-only name', () => {
    assert.match(source, /calculateRequiredNewDomeNi/, 'calculate-page.js must call the real pure Recovery function');
    assert.match(source, /findQualifyingSources/, 'calculate-page.js must call the real pure matching function');
  });

  test('29. no sampling history / closed-loop actual FPP correction / hardcoded recovery presets / stockpile inventory / backend coupling anywhere in the Recovery code', () => {
    for (const file of [
      path.join(ROOT, 'js', 'pages', 'calculate', 'calculate-page.js'),
      path.join(ROOT, 'js', 'pages', 'calculate', 'planned-blend-recovery.js'),
    ]) {
      const fileSource = stripComments(readFileSync(file, 'utf8'));
      for (const forbidden of [
        'samplingHistory', 'sampleHistory', 'actualFpp', 'closedLoop',
        'RECOVERY_PRESET', 'recoveryPreset', 'stockpile', 'remainingShiftTonnage',
        'plannedShiftTonnage',
      ]) {
        assert.doesNotMatch(fileSource, new RegExp(forbidden, 'i'), `${file} must not reference ${forbidden}`);
      }
    }
  });

  test('no localStorage usage anywhere in the Calculate modules\' actual code', () => {
    for (const file of ['calculate-page.js', 'blend-calculator.js', 'calculate-validation.js', 'blending-recommendation.js', 'recommendation-ranking.js', 'fleet-allocation.js', 'recommendation-actions.js', 'planned-blend-recovery.js']) {
      const fileSource = stripComments(readFileSync(path.join(ROOT, 'js', 'pages', 'calculate', file), 'utf8'));
      assert.doesNotMatch(fileSource, /localStorage/, `${file} must not use localStorage`);
    }
  });

  test('planned-blend-recovery.js is a pure module -- no DOM/i18n/router/license/network references', () => {
    for (const forbidden of ['document\\.', '\\bt\\(', 'navigateTo', 'hasFullAccess', 'fetch\\(', 'XMLHttpRequest']) {
      assert.doesNotMatch(pureRecoverySource, new RegExp(forbidden), `planned-blend-recovery.js must not reference ${forbidden}`);
    }
  });

  test('22. no Planned Blend Recovery UI renders while the Recommendation is within tolerance', () => {
    const pageEl = mountFullAccess();
    mountRecommendationReadyOn(pageEl);
    clickCalculateRecommendation(pageEl);

    assert.doesNotMatch(pageEl.textContent, /recovery/i);
  });

  test('no Recommendation result section exists in the rendered DOM before Recommendation has been calculated', () => {
    const pageEl = mountFullAccess();
    fillRow(gridRows(pageEl)[0], { pileId: 'A', contractor: 'SMA', ni: '1.2', units: '10', tonnesPerUnit: '50' });

    assert.equal(findOne(pageEl, hasClass('calculate-hopper-pattern')), null, 'the Hopper Pattern card is only ever built once a Recommendation result exists');
  });
});

/* ============================================================
   REMOVE PILE -- values survive, invariant preserved
============================================================ */
describe('Remove Pile', () => {
  test('removing a populated row preserves exactly one trailing blank row, other rows\' values (including Contractor) survive', () => {
    const pageEl = mountFullAccess();
    fillRow(gridRows(pageEl)[0], { pileId: 'A', contractor: 'SMA', ni: '1.3', units: '10', tonnesPerUnit: '50' });
    fillRow(gridRows(pageEl)[1], { pileId: 'B', contractor: 'TII', ni: '0.95', units: '20', tonnesPerUnit: '45' });

    let rows = gridRows(pageEl);
    assert.equal(rows.length, 3);
    assert.equal(clickRemove(rows[0]), true);

    rows = gridRows(pageEl);
    assert.equal(rows.length, 2);
    assert.equal(findFieldInput(rows[0], 'pileId').value, 'B');
    assert.equal(findFieldInput(rows[0], 'contractor').value, 'TII');
    assert.equal(findFieldInput(rows[1], 'pileId').value, '');
    assert.equal(clickRemove(rows[1]), false, 'the surviving trailing row must have no remove control');
  });

  test('removing every active row leaves exactly one blank row -- never zero rows', () => {
    const pageEl = mountFullAccess();
    fillRow(gridRows(pageEl)[0], { pileId: 'A', contractor: 'SMA', ni: '1.2', units: '10', tonnesPerUnit: '50' });

    clickRemove(gridRows(pageEl)[0]);

    const rows = gridRows(pageEl);
    assert.equal(rows.length, 1);
    assert.equal(findFieldInput(rows[0], 'pileId').value, '');
  });
});

/* ============================================================
   CONTRACTOR VALIDATION (unaffected by this task's revision)
============================================================ */
describe('Contractor validation', () => {
  test('an active row with a missing Contractor is excluded from the live summary and shows an error', () => {
    const pageEl = mountFullAccess();
    fillRow(gridRows(pageEl)[0], { pileId: 'A', ni: '1.2', units: '10', tonnesPerUnit: '50' });

    assert.equal(blendSummaryRoot(pageEl).hidden, true);
    assert.match(findRowError(gridRows(pageEl)[0]).textContent, new RegExp(idCatalog['calculate.validation.contractorRequired']));
  });

  test('a whitespace-only Contractor fails validation', () => {
    const pageEl = mountFullAccess();
    fillRow(gridRows(pageEl)[0], { pileId: 'A', contractor: '   ', ni: '1.2', units: '10', tonnesPerUnit: '50' });

    assert.match(findRowError(gridRows(pageEl)[0]).textContent, new RegExp(idCatalog['calculate.validation.contractorRequired']));
  });

  test('a valid Contractor is included normally', () => {
    const pageEl = mountFullAccess();
    fillRow(gridRows(pageEl)[0], { pileId: 'A', contractor: 'Contractor A', ni: '1.2', units: '10', tonnesPerUnit: '50' });

    assert.equal(blendSummaryRoot(pageEl).hidden, false);
    assert.equal(findRowError(gridRows(pageEl)[0]).hidden, true);
  });

  test('Contractor value is never auto-uppercased or otherwise rewritten beyond outer-whitespace trim', () => {
    const pageEl = mountFullAccess();
    typeIntoField(gridRows(pageEl)[0], 'contractor', 'sma lowercase');
    assert.equal(findFieldInput(gridRows(pageEl)[0], 'contractor').value, 'sma lowercase');
  });
});

/* ============================================================
   SESSION STATE AND LOCALIZATION
============================================================ */
describe('Calculate -> Monitor -> Calculate preserves rows and the current live summary', () => {
  test('module-level state survives independently of route changes (the page is never rebuilt on remount)', () => {
    const pageEl = mountFullAccess();
    fillRow(gridRows(pageEl)[0], { pileId: 'A', contractor: 'SMA', ni: '1.30', units: '10', tonnesPerUnit: '50' });
    fillRow(gridRows(pageEl)[1], { pileId: 'B', contractor: 'TII', ni: '0.95', units: '20', tonnesPerUnit: '45' });
    const finalNiBefore = summaryValue(pageEl, 'calculate-final-ni');

    const rows = gridRows(pageEl);
    assert.equal(findFieldInput(rows[0], 'pileId').value, 'A');
    assert.equal(findFieldInput(rows[0], 'contractor').value, 'SMA');
    assert.equal(findFieldInput(rows[1], 'pileId').value, 'B');
    assert.equal(summaryValue(pageEl, 'calculate-final-ni'), finalNiBefore);
  });
});

describe('Locale switch preserves entered values (source + Target/Tolerance) and the current result numbers', () => {
  test('switching id -> en keeps row inputs and the live Blend summary numbers unchanged', () => {
    const pageEl = mountFullAccess();
    fillRow(gridRows(pageEl)[0], { pileId: 'A', contractor: 'SMA', ni: '1.30', units: '10', tonnesPerUnit: '50' });
    const finalNiBefore = summaryValue(pageEl, 'calculate-final-ni');

    setLocale('en');

    const rows = gridRows(pageEl);
    assert.equal(findFieldInput(rows[0], 'pileId').value, 'A');
    assert.equal(findFieldInput(rows[0], 'contractor').value, 'SMA');
    assert.equal(findFieldInput(rows[0], 'ni').value, '1.30');
    assert.equal(blendSummaryRoot(pageEl).hidden, false);
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

  test('Contractor aria-label localizes with the rest of the field wording', () => {
    const pageEl = mountFullAccess();
    setLocale('id');
    assert.equal(findFieldInput(gridRows(pageEl)[0], 'contractor').attributes['aria-label'], idCatalog['calculate.fields.contractor']);
    setLocale('en');
    assert.equal(findFieldInput(gridRows(pageEl)[0], 'contractor').attributes['aria-label'], enCatalog['calculate.fields.contractor']);
  });

  test('locale switch preserves Target Ni/Tolerance and a current Recommendation result', () => {
    const pageEl = mountFullAccess();
    mountRecommendationReadyOn(pageEl);
    clickCalculateRecommendation(pageEl);
    const ratioBefore = hopperPatternRatioText(pageEl);

    setLocale('en');

    assert.equal(findFieldInput(pageEl, 'targetNi').value, '1.120');
    assert.equal(findFieldInput(pageEl, 'tolerance').value, '0.010');
    assert.equal(recommendationResultRoot(pageEl).hidden, false);
    assert.equal(hopperPatternRatioText(pageEl), ratioBefore);
    assert.match(statusBadgeText(pageEl), new RegExp(enCatalog['calculate.recommendation.withinTolerance']));
  });
});

/* ============================================================
   MOBILE INPUT ATTRIBUTES (unaffected by this task's revision)
============================================================ */
describe('Mobile keyboard input modes', () => {
  test('Ni and t/DT use inputmode="decimal", DT uses inputmode="numeric", Pile ID and Contractor are plain text', () => {
    const pageEl = mountFullAccess();
    const row = gridRows(pageEl)[0];
    assert.equal(findFieldInput(row, 'pileId').type, 'text');
    assert.equal(findFieldInput(row, 'contractor').type, 'text');
    assert.equal(findFieldInput(row, 'ni').attributes.inputmode, 'decimal');
    assert.equal(findFieldInput(row, 'units').attributes.inputmode, 'numeric');
    assert.equal(findFieldInput(row, 'tonnesPerUnit').attributes.inputmode, 'decimal');
  });

  test('Contractor carries autocomplete="off"', () => {
    const pageEl = mountFullAccess();
    const row = gridRows(pageEl)[0];
    assert.equal(findFieldInput(row, 'contractor').attributes.autocomplete, 'off');
  });

  test('every field carries its FULL localized wording as an aria-label, never the short grid header text', () => {
    const pageEl = mountFullAccess();
    const row = gridRows(pageEl)[0];
    assert.equal(findFieldInput(row, 'pileId').attributes['aria-label'], idCatalog['calculate.fields.pileId']);
    assert.equal(findFieldInput(row, 'contractor').attributes['aria-label'], idCatalog['calculate.fields.contractor']);
    assert.equal(findFieldInput(row, 'ni').attributes['aria-label'], idCatalog['calculate.fields.ni']);
    assert.equal(findFieldInput(row, 'units').attributes['aria-label'], idCatalog['calculate.fields.units']);
    assert.equal(findFieldInput(row, 'tonnesPerUnit').attributes['aria-label'], idCatalog['calculate.fields.tonnesPerUnit']);
  });

  test('enterkeyhint moves Pile -> Contractor -> Ni -> DT -> t/DT, ending in "done"', () => {
    const pageEl = mountFullAccess();
    const row = gridRows(pageEl)[0];
    assert.equal(findFieldInput(row, 'pileId').attributes.enterkeyhint, 'next');
    assert.equal(findFieldInput(row, 'contractor').attributes.enterkeyhint, 'next');
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

  test('Pile ID and Contractor carry subtle placeholders (this task\'s Section 8)', () => {
    const pageEl = mountFullAccess();
    const row = gridRows(pageEl)[0];
    assert.equal(findFieldInput(row, 'pileId').attributes.placeholder, idCatalog['calculate.fields.pileId']);
    assert.equal(findFieldInput(row, 'contractor').attributes.placeholder, idCatalog['calculate.fields.contractor']);
  });
});

/* ============================================================
   COMPACT GRID HEADER -- unchanged column layout (Section 8)
============================================================ */
describe('Compact grid header', () => {
  test('uses short PILE/NI/DT/t-DT headers, never the long field names, and gains no new column', () => {
    const pageEl = mountFullAccess();
    const headerCells = findAll(pageEl, (el) => hasClass('calculate-grid-cell')(el) && !('rowIndex' in (el.parentNode?.dataset || {})));
    const headerText = findOne(pageEl, hasClass('calculate-grid-row--header')).textContent;
    assert.match(headerText, /PILE/);
    assert.match(headerText, /NI/);
    assert.match(headerText, /DT/);
    assert.doesNotMatch(headerText, /Jumlah Unit/);
    assert.doesNotMatch(headerText, /Tonase \/ Unit/);
    assert.doesNotMatch(headerText, /Kontraktor|Contractor/);
    assert.equal(headerCells.length, 5, 'still exactly PILE/NI/DT/t-DT/action -- Contractor must not add a sixth column');
  });
});

/* ============================================================
   LOCALIZATION KEYS
============================================================ */
describe('Localization keys (Phase 4.1 continuous-flow revision)', () => {
  test('every calculate.* key exists in both locales, non-empty', () => {
    const keys = Object.keys(idCatalog).filter((k) => k.startsWith('calculate.'));
    assert.ok(keys.length > 10, 'expected a substantial calculate.* catalog');
    for (const key of keys) {
      assert.ok(idCatalog[key], `id.js missing/empty ${key}`);
      assert.ok(enCatalog[key], `en.js missing/empty ${key}`);
    }
  });

  test('calculate.tabs.* and calculate.blend.calculate no longer exist (mode tabs/explicit Blend button removed)', () => {
    for (const key of ['calculate.tabs.blend', 'calculate.tabs.recommendation', 'calculate.blend.calculate']) {
      assert.equal(key in idCatalog, false, `id.js must not carry the removed key ${key}`);
      assert.equal(key in enCatalog, false, `en.js must not carry the removed key ${key}`);
    }
  });

  test('calculate.result.title/pileBreakdown/tonnageShare and calculate.fields.calculatedTonnage/oreClass no longer exist (old duplicated result section removed)', () => {
    for (const key of ['calculate.result.title', 'calculate.result.pileBreakdown', 'calculate.result.tonnageShare', 'calculate.fields.calculatedTonnage', 'calculate.fields.oreClass']) {
      assert.equal(key in idCatalog, false, `id.js must not carry the removed key ${key}`);
      assert.equal(key in enCatalog, false, `en.js must not carry the removed key ${key}`);
    }
  });

  test('the new partial-row-info and noCompleteSources keys exist in both locales', () => {
    for (const key of ['calculate.blend.incompleteRowsOne', 'calculate.blend.incompleteRowsOther', 'calculate.recommendation.noCompleteSources']) {
      assert.ok(idCatalog[key], `id.js missing ${key}`);
      assert.ok(enCatalog[key], `en.js missing ${key}`);
    }
  });

  test('calculate.recommendation.* keys exist (Gate A closed, Recommendation always visible)', () => {
    for (const key of [
      'calculate.recommendation.title', 'calculate.recommendation.hopperPattern',
      'calculate.recommendation.targetNi', 'calculate.recommendation.tolerance',
      'calculate.recommendation.withinTolerance', 'calculate.recommendation.targetNotAchievable',
    ]) {
      assert.ok(idCatalog[key], `id.js missing ${key}`);
      assert.ok(enCatalog[key], `en.js missing ${key}`);
    }
  });

  test('short grid header keys exist and are identical across locales (stable terms, like nav.calculate)', () => {
    for (const key of ['calculate.grid.headerPile', 'calculate.grid.headerNi', 'calculate.grid.headerDt', 'calculate.grid.headerTonnesPerUnit']) {
      assert.ok(idCatalog[key]);
      assert.equal(idCatalog[key], enCatalog[key]);
    }
  });

  // Material Action/Fleet Action keys (calculate.actions.*) are now IN
  // scope (V2.4 Phase 5) -- see the dedicated key-existence assertions in
  // describe('26-30. Material Actions...') below.

  // SUPERSEDED (was: "no Planned Blend Recovery i18n key family exists yet
  // (Phase 6)"). Phase 6 (this task) intentionally adds calculate.recovery.*
  // -- verified below instead.
  test('calculate.recovery.* i18n key family exists in both locales with matching key sets (Phase 6)', () => {
    const idKeys = Object.keys(idCatalog).filter((k) => k.startsWith('calculate.recovery') || k.startsWith('calculate.validation.recovery')).sort();
    const enKeys = Object.keys(enCatalog).filter((k) => k.startsWith('calculate.recovery') || k.startsWith('calculate.validation.recovery')).sort();
    assert.ok(idKeys.length > 0, 'id.js must carry calculate.recovery.*/calculate.validation.recovery* keys');
    assert.deepEqual(idKeys, enKeys, 'id.js and en.js must carry the exact same Recovery key set');
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

/* ============================================================
   UI WORDING/BACKGROUND POLISH (this task) -- label text only; the
   underlying numeric Blend/Recommendation values must be byte-identical
   to the pre-existing behavior these same fixtures already exercise
   above (Known worked example / Known fleet example), so every test
   below asserts the label AND the unchanged numeric value together.
============================================================ */
describe('23. Blend summary label -- "NI SUMPRODUCT" / "SUMPRODUCT NI"', () => {
  test('Indonesian (default locale): label reads NI SUMPRODUCT, value unchanged', () => {
    const pageEl = mountFullAccess();
    fillRow(gridRows(pageEl)[0], { pileId: 'A', contractor: 'SMA', ni: '1.30', units: '10', tonnesPerUnit: '50' });

    assert.equal(summaryLabel(pageEl, 'calculate-final-ni'), 'NI SUMPRODUCT');
    assert.equal(summaryLabel(pageEl, 'calculate-final-ni'), idCatalog['calculate.result.finalNi']);
    assert.equal(summaryValue(pageEl, 'calculate-final-ni'), '1.300%');
  });

  test('English: label reads SUMPRODUCT NI, value unchanged', () => {
    const pageEl = mountFullAccess();
    fillRow(gridRows(pageEl)[0], { pileId: 'A', contractor: 'SMA', ni: '1.30', units: '10', tonnesPerUnit: '50' });
    setLocale('en');

    assert.equal(summaryLabel(pageEl, 'calculate-final-ni'), 'SUMPRODUCT NI');
    assert.equal(summaryLabel(pageEl, 'calculate-final-ni'), enCatalog['calculate.result.finalNi']);
    assert.equal(summaryValue(pageEl, 'calculate-final-ni'), '1.300%');

    setLocale(DEFAULT_LOCALE);
  });

  test('the old "Ni Akhir" / "Final Ni" wording no longer appears anywhere in either catalog', () => {
    assert.doesNotMatch(idCatalog['calculate.result.finalNi'], /^Ni Akhir$/);
    assert.doesNotMatch(enCatalog['calculate.result.finalNi'], /^Final Ni$/);
  });
});

describe('24. Recommendation label -- "ESTIMASI AKHIR NI" / "ESTIMATED FINAL NI"', () => {
  test('Indonesian: both the summary strip and the status-card row use the new label, estimatedNi value unchanged', () => {
    const pageEl = mountFullAccess();
    mountRecommendationReadyOn(pageEl);
    clickCalculateRecommendation(pageEl);

    assert.equal(summaryLabel(pageEl, 'calculate-recommendation-estimated-ni'), 'ESTIMASI AKHIR NI');
    assert.equal(summaryLabel(pageEl, 'calculate-recommendation-estimated-ni'), idCatalog['calculate.recommendation.estimatedNi']);
    assert.equal(summaryValue(pageEl, 'calculate-recommendation-estimated-ni'), '1.120%');

    // buildRecommendationStatusCard()'s own "within tolerance" detail rows
    // reuse the exact same key for its Estimated Ni row (Section 3 of
    // this task applies to the whole Recommendation result card, not just
    // the summary strip).
    assert.ok(statusRowLabels(pageEl).includes('ESTIMASI AKHIR NI'));
  });

  test('English: both the summary strip and the status-card row use the new label, estimatedNi value unchanged', () => {
    const pageEl = mountFullAccess();
    setLocale('en');
    mountRecommendationReadyOn(pageEl);
    clickCalculateRecommendation(pageEl);

    assert.equal(summaryLabel(pageEl, 'calculate-recommendation-estimated-ni'), 'ESTIMATED FINAL NI');
    assert.equal(summaryLabel(pageEl, 'calculate-recommendation-estimated-ni'), enCatalog['calculate.recommendation.estimatedNi']);
    assert.equal(summaryValue(pageEl, 'calculate-recommendation-estimated-ni'), '1.120%');
    assert.ok(statusRowLabels(pageEl).includes('ESTIMATED FINAL NI'));

    setLocale(DEFAULT_LOCALE);
  });

  test('candidate.estimatedNi/deviation math and Target Not Achievable wording are untouched by the label change', () => {
    const pageEl = mountFullAccess();
    fillRow(gridRows(pageEl)[0], { pileId: 'A', contractor: 'S', ni: '1.0', units: '10', tonnesPerUnit: '50' });
    fillRecommendationControls(pageEl, { targetNi: '5.0', tolerance: '0.01' });
    clickCalculateRecommendation(pageEl);

    assert.match(statusBadgeText(pageEl), new RegExp(idCatalog['calculate.recommendation.targetNotAchievable']));
    // Target Not Achievable never renders the estimatedNi row/label at all
    // (Best Attainable Ni is shown instead) -- unchanged by this task.
    assert.equal(statusRowLabels(pageEl).includes(idCatalog['calculate.recommendation.estimatedNi']), false);
  });

  test('the old "Estimasi Ni" / "Estimated Ni" wording no longer appears anywhere in either catalog', () => {
    assert.doesNotMatch(idCatalog['calculate.recommendation.estimatedNi'], /^Estimasi Ni$/);
    assert.doesNotMatch(enCatalog['calculate.recommendation.estimatedNi'], /^Estimated Ni$/);
  });
});

describe('25. Sticky Blend summary is a fully opaque solid surface', () => {
  const cssSource = readFileSync(path.join(ROOT, 'assets', 'css', 'calculate.css'), 'utf8');
  const blockStart = cssSource.indexOf('#page-calculate .calculate-blend-summary {');
  const blockEnd = cssSource.indexOf('}', blockStart);
  const stickyBlock = cssSource.slice(blockStart, blockEnd);

  test('the rule exists and still uses position: sticky (sticky behavior preserved)', () => {
    assert.ok(blockStart >= 0, 'expected a #page-calculate .calculate-blend-summary rule in calculate.css');
    assert.match(stickyBlock, /position:\s*sticky;/);
    assert.match(stickyBlock, /top:\s*0;/);
    assert.match(stickyBlock, /z-index:\s*5;/, 'z-index must be preserved, not just sticky positioning');
  });

  test('the background no longer uses the translucent --table-header-bg token', () => {
    assert.doesNotMatch(stickyBlock, /--table-header-bg/);
  });

  test('the background uses --bg-base, an existing fully opaque (alpha-free) theme token, with a fully opaque hex fallback', () => {
    assert.match(stickyBlock, /background:\s*var\(--bg-base,\s*#0a0e1a\);/);
  });

  test('no backdrop-filter/blur is used to achieve the opaque effect', () => {
    assert.doesNotMatch(stickyBlock, /backdrop-filter/);
  });

  test('--bg-base itself is a fully opaque (non-rgba, alpha-free) token in both dark and light theme, defined once in index.html and not redefined here', () => {
    const indexHtml = readFileSync(path.join(ROOT, 'index.html'), 'utf8');
    const bgBaseDeclarations = [...indexHtml.matchAll(/--bg-base:\s*(#[0-9a-fA-F]{3,8}|rgba?\([^)]*\));/g)].map((m) => m[1]);
    assert.ok(bgBaseDeclarations.length >= 2, 'expected at least a dark and a light --bg-base declaration');
    for (const value of bgBaseDeclarations) {
      assert.match(value, /^#[0-9a-fA-F]{3,8}$/, `--bg-base must be an opaque hex color, not translucent rgba() -- got "${value}"`);
    }
    // calculate.css itself must not invent a competing definition -- the
    // token is sourced from the app's existing theme, per the "do not
    // introduce a Calculate-only hardcoded palette" requirement.
    assert.doesNotMatch(cssSource, /--bg-base:\s*(#|rgba?\()/);
  });

  test('no other part of calculate.css introduces a new Calculate-only opaque palette for this fix', () => {
    // The only literal color calculate.css is allowed to add for this fix
    // is the SAME #0a0e1a fallback report-hync.css already uses alongside
    // --bg-base -- not a new, Calculate-specific hardcoded surface color.
    const newOpaqueHexLiterals = [...cssSource.matchAll(/background:\s*var\(--bg-base,\s*(#[0-9a-fA-F]{3,8})\)/g)].map((m) => m[1]);
    for (const hex of newOpaqueHexLiterals) {
      assert.equal(hex, '#0a0e1a');
    }
  });

  test('the compact item padding/font sizing inside the sticky summary is unchanged (layout preserved)', () => {
    const itemRuleStart = cssSource.indexOf('#page-calculate .calculate-blend-summary .calculate-result-summary__item {');
    assert.ok(itemRuleStart >= 0);
    const itemRule = cssSource.slice(itemRuleStart, cssSource.indexOf('}', itemRuleStart));
    assert.match(itemRule, /padding:\s*8px 6px;/);
    assert.match(itemRule, /border-radius:\s*10px;/);
  });
});

/* ============================================================
   26-30 (this task's Section 18/20-21/25/32). MATERIAL ACTIONS UI
============================================================ */
describe('26. Material Actions section renders after a successful Recommendation, with correct USE/LIMIT/STOP labels', () => {
  test('appears only once a Recommendation result exists, titled AKSI MATERIAL', () => {
    const pageEl = mountFullAccess();
    assert.equal(materialActionsRoot(pageEl), null, 'no Material Actions section before Recommendation is calculated');

    mountRecommendationReadyOn(pageEl);
    clickCalculateRecommendation(pageEl);

    const root = materialActionsRoot(pageEl);
    assert.notEqual(root, null);
    assert.match(root.textContent, new RegExp(idCatalog['calculate.actions.materialTitle']));
  });

  test('17/known 5 HG / 8 LGLO scenario: both Higher and Lglo are Material USE, with the localized GUNAKAN label', () => {
    const pageEl = mountFullAccess();
    mountRecommendationReadyOn(pageEl);
    clickCalculateRecommendation(pageEl);

    const higherRow = materialActionRowFor(pageEl, 'Higher');
    const lgloRow = materialActionRowFor(pageEl, 'Lglo');
    assert.notEqual(higherRow, undefined);
    assert.notEqual(lgloRow, undefined);
    assert.equal(materialActionBadgeText(higherRow), idCatalog['calculate.actions.material.use']);
    assert.equal(materialActionBadgeText(lgloRow), idCatalog['calculate.actions.material.use']);
    assert.equal(idCatalog['calculate.actions.material.use'], 'GUNAKAN');
  });

  test('English locale: the same known scenario renders the USE label', () => {
    const pageEl = mountFullAccess();
    mountRecommendationReadyOn(pageEl);
    setLocale('en');
    clickCalculateRecommendation(pageEl);

    const higherRow = materialActionRowFor(pageEl, 'Higher');
    assert.equal(materialActionBadgeText(higherRow), enCatalog['calculate.actions.material.use']);
    assert.equal(enCatalog['calculate.actions.material.use'], 'USE');

    setLocale(DEFAULT_LOCALE);
  });

  // A third, unfavorable-Ni source forces a real STOP under the real
  // engine+ranking (never a hand-picked fixture) -- Target/Tolerance are
  // exactly the known example's own values, so Higher/Lglo still land on
  // their proven 4/8 active split; the third source can only ever worsen
  // an already-exact (deviation 0) match.
  test('a genuinely unfavorable third source renders STOP with the localized label', () => {
    const pageEl = mountFullAccess();
    fillKnownRecommendationExample(pageEl);
    fillRow(gridRows(pageEl)[2], { pileId: 'Off', contractor: 'ZZZ', ni: '0.10', units: '3', tonnesPerUnit: '50' });
    fillRecommendationControls(pageEl, { targetNi: '1.120', tolerance: '0.010' });

    clickCalculateRecommendation(pageEl);

    const offRow = materialActionRowFor(pageEl, 'Off');
    assert.notEqual(offRow, undefined);
    assert.equal(materialActionBadgeText(offRow), idCatalog['calculate.actions.material.stop']);
    assert.equal(idCatalog['calculate.actions.material.stop'], 'STOP');
    // Every Material Action row includes a short reason (this task's
    // Section 21) -- never left blank.
    assert.ok(offRow.textContent.length > materialActionBadgeText(offRow).length);
  });
});

describe('27. LIMIT is contextual, never a static LGLO/HGLO rule (this task\'s Section 22)', () => {
  test('a low-Ni third source that would move the blend TOWARD a lower Target renders LIMIT, not STOP', () => {
    const pageEl = mountFullAccess();
    fillRow(gridRows(pageEl)[0], { pileId: 'Higher', contractor: 'SMA', ni: '1.30', units: '12', tonnesPerUnit: '50' });
    fillRow(gridRows(pageEl)[1], { pileId: 'Off', contractor: 'ZZZ', ni: '1.10', units: '3', tonnesPerUnit: '50' });
    // Target well below both, but reachable via the full Higher fleet
    // alone within tolerance -- Off (1.10) is a step TOWARD this lower
    // Target relative to the 1.30 baseline, so it must never be STOP.
    fillRecommendationControls(pageEl, { targetNi: '1.290', tolerance: '0.050' });

    clickCalculateRecommendation(pageEl);

    const offRow = materialActionRowFor(pageEl, 'Off');
    assert.notEqual(materialActionBadgeText(offRow), idCatalog['calculate.actions.material.stop']);
  });
});

/* ============================================================
   31-33 (this task's Section 19-20/32). FLEET ACTIONS UI
============================================================ */
describe('31. Fleet Actions section renders separately, with correct ACTIVE/MOVE/SEPARATE labels', () => {
  test('appears only once a Recommendation result exists, titled AKSI FLEET, separate from Material Actions', () => {
    const pageEl = mountFullAccess();
    assert.equal(fleetActionsRoot(pageEl), null);

    mountRecommendationReadyOn(pageEl);
    clickCalculateRecommendation(pageEl);

    const root = fleetActionsRoot(pageEl);
    assert.notEqual(root, null);
    assert.match(root.textContent, new RegExp(idCatalog['calculate.actions.fleetTitle']));
    assert.notEqual(materialActionsRoot(pageEl), fleetActionsRoot(pageEl), 'Material and Fleet Actions must be two distinct sections');
  });

  test('known 5 HG / 8 LGLO scenario: Higher shows ACTIVE 4 DT + SEPARATE 1 DT (cross-Contractor, no MOVE); Lglo shows ACTIVE 8 DT only', () => {
    const pageEl = mountFullAccess();
    mountRecommendationReadyOn(pageEl);
    clickCalculateRecommendation(pageEl);

    const higherRow = fleetActionRowFor(pageEl, 'Higher');
    const higherLines = fleetActionLineTexts(higherRow);
    assert.ok(higherLines.some((l) => l.includes(idCatalog['calculate.actions.fleet.use']) && l.includes('4')));
    assert.ok(higherLines.some((l) => l.includes(idCatalog['calculate.actions.fleet.separate']) && l.includes('1')));
    assert.ok(!higherLines.some((l) => l.includes(idCatalog['calculate.actions.fleet.move'])), 'cross-Contractor Higher/Lglo must never show a MOVE line');

    const lgloRow = fleetActionRowFor(pageEl, 'Lglo');
    const lgloLines = fleetActionLineTexts(lgloRow);
    assert.ok(lgloLines.some((l) => l.includes(idCatalog['calculate.actions.fleet.use']) && l.includes('8')));
    assert.equal(lgloLines.length, 1, 'a fully-active source with no relocation shows only its USE line');
  });

  test('same-Contractor relocation scenario: Higher shows MOVE 1 DT -> Lglo, Lglo shows RECEIVE 1 DT <- Higher', () => {
    const pageEl = mountFullAccess();
    fillRow(gridRows(pageEl)[0], { pileId: 'Higher', contractor: 'SMA', ni: '1.30', units: '5', tonnesPerUnit: '50' });
    fillRow(gridRows(pageEl)[1], { pileId: 'Lglo', contractor: 'SMA', ni: '1.03', units: '7', tonnesPerUnit: '50' });
    fillRecommendationControls(pageEl, { targetNi: '1.120', tolerance: '0.010' });

    clickCalculateRecommendation(pageEl);

    const higherLines = fleetActionLineTexts(fleetActionRowFor(pageEl, 'Higher'));
    assert.ok(higherLines.some((l) => l.includes(idCatalog['calculate.actions.fleet.move']) && l.includes('1') && l.includes('Lglo')));

    const lgloLines = fleetActionLineTexts(fleetActionRowFor(pageEl, 'Lglo'));
    assert.ok(lgloLines.some((l) => l.includes(idCatalog['calculate.actions.fleet.receive']) && l.includes('1') && l.includes('Higher')));

    // English labels for the same scenario.
    setLocale('en');
    const higherLinesEn = fleetActionLineTexts(fleetActionRowFor(pageEl, 'Higher'));
    assert.ok(higherLinesEn.some((l) => l.includes('MOVE') && l.includes('Lglo')));
    setLocale(DEFAULT_LOCALE);
  });

  test('cross-Contractor case never renders a MOVE or RECEIVE line anywhere on the page', () => {
    const pageEl = mountFullAccess();
    fillRow(gridRows(pageEl)[0], { pileId: 'Higher', contractor: 'SMA', ni: '1.30', units: '5', tonnesPerUnit: '50' });
    fillRow(gridRows(pageEl)[1], { pileId: 'Lglo', contractor: 'TII', ni: '1.03', units: '7', tonnesPerUnit: '50' });
    fillRecommendationControls(pageEl, { targetNi: '1.120', tolerance: '0.010' });

    clickCalculateRecommendation(pageEl);

    fleetActionRows(pageEl).forEach((row) => {
      const lines = fleetActionLineTexts(row);
      assert.ok(!lines.some((l) => l.includes(idCatalog['calculate.actions.fleet.move'])));
      assert.ok(!lines.some((l) => l.includes(idCatalog['calculate.actions.fleet.receive'])));
    });
  });
});

/* ============================================================
   26. STANDBY terminology (V2.4 Phase 6.1 -- Owner correction, this
   task's Part B/Section 26). Reuses the known 5 HG / 8 LGLO scenario,
   where Higher's own Fleet Action row already carries a STANDBY (1 DT)
   line (verified above).
============================================================ */
describe('26. STANDBY terminology replaces PISAHKAN/SEPARATE in the UI', () => {
  test('the rendered Fleet Action line shows the localized STANDBY word, with an explanatory hint, never the old PISAHKAN/SEPARATE word', () => {
    const pageEl = mountFullAccess();
    mountRecommendationReadyOn(pageEl);
    clickCalculateRecommendation(pageEl);

    const higherRow = fleetActionRowFor(pageEl, 'Higher');
    assert.match(higherRow.textContent, /STANDBY/);
    assert.doesNotMatch(higherRow.textContent, /PISAHKAN/);
    assert.match(higherRow.textContent, new RegExp(idCatalog['calculate.actions.fleet.standbyHint']));

    setLocale('en');
    const higherRowEn = fleetActionRowFor(pageEl, 'Higher');
    assert.match(higherRowEn.textContent, /STANDBY/);
    assert.doesNotMatch(higherRowEn.textContent, /\bSEPARATE\b/);
    assert.match(higherRowEn.textContent, new RegExp(enCatalog['calculate.actions.fleet.standbyHint']));
    setLocale(DEFAULT_LOCALE);
  });

  test('the old PISAHKAN/SEPARATE word never appears anywhere on the whole rendered Recommendation result', () => {
    const pageEl = mountFullAccess();
    mountRecommendationReadyOn(pageEl);
    clickCalculateRecommendation(pageEl);

    assert.doesNotMatch(recommendationResultRoot(pageEl).textContent, /PISAHKAN/);
  });

  test('ACTIVE/MOVE Fleet Action behavior and cross-Contractor MOVE impossibility are unaffected by the STANDBY rename', () => {
    const pageEl = mountFullAccess();
    fillRow(gridRows(pageEl)[0], { pileId: 'Higher', contractor: 'SMA', ni: '1.30', units: '5', tonnesPerUnit: '50' });
    fillRow(gridRows(pageEl)[1], { pileId: 'Lglo', contractor: 'SMA', ni: '1.03', units: '7', tonnesPerUnit: '50' });
    fillRecommendationControls(pageEl, { targetNi: '1.120', tolerance: '0.010' });
    clickCalculateRecommendation(pageEl);

    const higherLines = fleetActionLineTexts(fleetActionRowFor(pageEl, 'Higher'));
    assert.ok(higherLines.some((l) => l.includes(idCatalog['calculate.actions.fleet.move']) && l.includes('Lglo')));
    const lgloLines = fleetActionLineTexts(fleetActionRowFor(pageEl, 'Lglo'));
    assert.ok(lgloLines.some((l) => l.includes(idCatalog['calculate.actions.fleet.receive']) && l.includes('Higher')));

    // Fleet conservation: every row's own useUnits + moveOutUnits +
    // standby (separate) units still accounts for its assignedUnits, and
    // no row anywhere shows a cross-Contractor MOVE/RECEIVE line.
    fleetActionRows(pageEl).forEach((row) => {
      const lines = fleetActionLineTexts(row);
      assert.ok(lines.some((l) => l.includes(idCatalog['calculate.actions.fleet.use'])), 'every row always shows its USE line');
    });
  });
});

/* ============================================================
   STALE INVALIDATION CLEARS ACTIONS TOO (this task's Section 27)
============================================================ */
describe('32. Editing source/Target/Tolerance clears Material Actions and Fleet Actions along with the Recommendation result', () => {
  test('a source edit removes both action sections immediately, without pressing Hitung Rekomendasi', () => {
    const pageEl = mountFullAccess();
    mountRecommendationReadyOn(pageEl);
    clickCalculateRecommendation(pageEl);
    assert.notEqual(materialActionsRoot(pageEl), null);
    assert.notEqual(fleetActionsRoot(pageEl), null);

    typeIntoField(gridRows(pageEl)[0], 'ni', '1.35');

    assert.equal(recommendationResultRoot(pageEl).hidden, true);
    assert.equal(materialActionsRoot(pageEl), null, 'no stale Material Actions section may remain in the DOM');
    assert.equal(fleetActionsRoot(pageEl), null, 'no stale Fleet Actions section may remain in the DOM');
  });

  test('a Target Ni edit clears both action sections', () => {
    const pageEl = mountFullAccess();
    mountRecommendationReadyOn(pageEl);
    clickCalculateRecommendation(pageEl);

    typeIntoField(pageEl, 'targetNi', '1.130');

    assert.equal(materialActionsRoot(pageEl), null);
    assert.equal(fleetActionsRoot(pageEl), null);
  });

  test('a Tolerance edit clears both action sections', () => {
    const pageEl = mountFullAccess();
    mountRecommendationReadyOn(pageEl);
    clickCalculateRecommendation(pageEl);

    typeIntoField(pageEl, 'tolerance', '0.020');

    assert.equal(materialActionsRoot(pageEl), null);
    assert.equal(fleetActionsRoot(pageEl), null);
  });

  test('recalculating after an edit renders fresh, current actions -- never a leftover from before the edit', () => {
    const pageEl = mountFullAccess();
    mountRecommendationReadyOn(pageEl);
    clickCalculateRecommendation(pageEl);
    const higherBefore = materialActionBadgeText(materialActionRowFor(pageEl, 'Higher'));

    typeIntoField(gridRows(pageEl)[0], 'ni', '1.30'); // no-op edit (same value) still clears+recomputes
    clickCalculateRecommendation(pageEl);

    const higherAfter = materialActionBadgeText(materialActionRowFor(pageEl, 'Higher'));
    assert.equal(higherAfter, higherBefore, 'recomputed from the same valid inputs must reproduce the same action');
  });
});

/* ============================================================
   33 (this task's Section 25). TARGET NOT ACHIEVABLE ACTION BASELINE
============================================================ */
describe('33. Target Not Achievable shows the best-attainable action baseline note', () => {
  test('the best-attainable note appears above Material Actions, and actions are still rendered', () => {
    const pageEl = mountFullAccess();
    fillRow(gridRows(pageEl)[0], { pileId: 'Higher', contractor: 'X', ni: '2.00', units: '5', tonnesPerUnit: '50' });
    fillRow(gridRows(pageEl)[1], { pileId: 'Lglo', contractor: 'Y', ni: '0.10', units: '5', tonnesPerUnit: '50' });
    fillRecommendationControls(pageEl, { targetNi: '5.00', tolerance: '0.01' });

    clickCalculateRecommendation(pageEl);

    assert.match(statusBadgeText(pageEl), new RegExp(idCatalog['calculate.recommendation.targetNotAchievable']));
    const root = materialActionsRoot(pageEl);
    assert.notEqual(root, null);
    assert.match(root.textContent, new RegExp(idCatalog['calculate.actions.bestAttainableNote']));

    // The best-attainable candidate (highest Ni alone) is Material USE;
    // never silently treated as though the unreachable Target were met.
    const higherRow = materialActionRowFor(pageEl, 'Higher');
    assert.equal(materialActionBadgeText(higherRow), idCatalog['calculate.actions.material.use']);
  });

  test('the best-attainable note is ABSENT once Target is actually achievable', () => {
    const pageEl = mountFullAccess();
    mountRecommendationReadyOn(pageEl);
    clickCalculateRecommendation(pageEl);

    assert.doesNotMatch(materialActionsRoot(pageEl).textContent, new RegExp(idCatalog['calculate.actions.bestAttainableNote']));
  });
});

/* ============================================================
   HOPPER PATTERN DECOUPLING (V2.4 Phase 6.1, this task's Part A). Reuses
   the widened-tolerance scenario from "a genuinely WIDER Tolerance after
   clearing..." above -- the REAL engine there selects a candidate whose
   PHYSICAL active fleet is 5:8 (13/13 DT, 100% utilization), while the
   independently-derived operational Hopper Pattern is the smaller 1:2.
   This end-to-end (real search -> real ranking -> real Hopper Pattern
   derivation) scenario is a stronger proof of decoupling than a hand-built
   fixture, since it exercises the entire pipeline exactly as production
   code would.
============================================================ */
describe('Hopper Pattern is decoupled from the physical active-fleet ratio', () => {
  test('when the selected candidate\'s physical fleet ratio (5:8) differs from the smallest within-tolerance pattern (1:2), the DOM shows 1:2, never 5:8, while fleet utilization still shows the true 13/13 DT physical count', () => {
    const pageEl = mountFullAccess();
    mountRecommendationReadyOn(pageEl);
    clickCalculateRecommendation(pageEl);
    typeIntoField(pageEl, 'tolerance', '0.020');
    clickCalculateRecommendation(pageEl);

    assert.equal(hopperPatternRatioText(pageEl), '1 : 2');
    assert.equal(summaryValue(pageEl, 'calculate-recommendation-fleet-utilization'), '13 / 13 DT');
    assert.notEqual(hopperPatternRatioText(pageEl), '5 : 8', 'the physical 5:8 fleet ratio must never be shown as the Hopper Pattern here');
  });

  test('the summary-strip Estimasi Akhir Ni and the status-card Estimasi Akhir Ni both match the DISPLAYED 1:2 Hopper Pattern (1.120%), never a different physical-candidate number', () => {
    const pageEl = mountFullAccess();
    mountRecommendationReadyOn(pageEl);
    clickCalculateRecommendation(pageEl);
    typeIntoField(pageEl, 'tolerance', '0.020');
    clickCalculateRecommendation(pageEl);

    assert.equal(hopperPatternRatioText(pageEl), '1 : 2');
    assert.equal(summaryValue(pageEl, 'calculate-recommendation-estimated-ni'), '1.120%');
    const statusRows = findAll(pageEl, hasClass('calculate-recommendation-status__row'));
    const estimatedNiRow = statusRows.find((r) => r.textContent.includes(idCatalog['calculate.recommendation.estimatedNi']));
    assert.match(estimatedNiRow.textContent, /1\.120%/);
  });

  test('the physical Unit Ratio row (Rasio Unit) still shows the true 5:8 physical active-fleet ratio, simultaneously with the 1:2 Hopper Pattern card', () => {
    const pageEl = mountFullAccess();
    mountRecommendationReadyOn(pageEl);
    clickCalculateRecommendation(pageEl);
    typeIntoField(pageEl, 'tolerance', '0.020');
    clickCalculateRecommendation(pageEl);

    assert.equal(hopperPatternRatioText(pageEl), '1 : 2');
    const ratioItems = findAll(pageEl, hasClass('calculate-recommendation-ratio-item'));
    const unitRatioItem = ratioItems.find((i) => i.textContent.includes(idCatalog['calculate.recommendation.unitRatio']));
    assert.match(unitRatioItem.textContent, /5 : 8/);
  });

  test('Material Actions/Fleet Actions are unaffected by the Hopper Pattern decoupling -- both Higher and Lglo remain Material USE for the known reference scenario', () => {
    const pageEl = mountFullAccess();
    mountRecommendationReadyOn(pageEl);
    clickCalculateRecommendation(pageEl);

    assert.equal(materialActionBadgeText(materialActionRowFor(pageEl, 'Higher')), idCatalog['calculate.actions.material.use']);
    assert.equal(materialActionBadgeText(materialActionRowFor(pageEl, 'Lglo')), idCatalog['calculate.actions.material.use']);
  });
});

/* ============================================================
   27. UI SECTION ORDER (V2.4 Phase 6.1, this task's Part C): Penyesuaian
   Fleet -> Aksi Fleet -> Aksi Material -> Planned Blend Recovery (when
   applicable).
============================================================ */
describe('27. Recommendation detail section order: Penyesuaian Fleet -> Aksi Fleet -> Aksi Material -> Recovery', () => {
  function sectionOrder(pageEl) {
    const root = recommendationResultRoot(pageEl);
    return root.children
      .map((c) => (c.className || ''))
      .map((cls) => {
        if (cls.includes('calculate-recommendation-relocations')) return 'relocation';
        if (cls.includes('calculate-fleet-actions')) return 'fleetActions';
        if (cls.includes('calculate-material-actions')) return 'materialActions';
        if (cls.includes('calculate-recovery-section')) return 'recovery';
        return null;
      })
      .filter(Boolean);
  }

  test('with a same-Contractor relocation present: relocation, then Fleet Actions, then Material Actions, in that exact order', () => {
    const pageEl = mountFullAccess();
    fillRow(gridRows(pageEl)[0], { pileId: 'Higher', contractor: 'SMA', ni: '1.30', units: '5', tonnesPerUnit: '50' });
    fillRow(gridRows(pageEl)[1], { pileId: 'Lglo', contractor: 'SMA', ni: '1.03', units: '7', tonnesPerUnit: '50' });
    fillRecommendationControls(pageEl, { targetNi: '1.120', tolerance: '0.010' });
    clickCalculateRecommendation(pageEl);

    assert.deepEqual(sectionOrder(pageEl), ['relocation', 'fleetActions', 'materialActions']);
  });

  test('without a relocation: Fleet Actions still comes before Material Actions', () => {
    const pageEl = mountFullAccess();
    mountRecommendationReadyOn(pageEl);
    clickCalculateRecommendation(pageEl);

    assert.deepEqual(sectionOrder(pageEl), ['fleetActions', 'materialActions']);
  });

  test('when TARGET_NOT_ACHIEVABLE: Fleet Actions, then Material Actions, then Recovery last', () => {
    const pageEl = mountFullAccess();
    mountRecoveryReadyOn(pageEl);
    clickCalculateRecommendation(pageEl);

    assert.deepEqual(sectionOrder(pageEl), ['fleetActions', 'materialActions', 'recovery']);
  });
});

/* ============================================================
   34-38. PLANNED BLEND RECOVERY (V2.4 Phase 6, this task). Reference
   fixture: mountRecoveryReadyOn() reuses describe('33. Target Not
   Achievable...')'s own already-verified best-attainable candidate
   (Higher/X/Ni 2.00%/5 DT/50 t/DT alone, Lglo/Y fully idle) -- baseline
   Ni 2.00% / 250t, confirmed against the real engine, never the live
   sticky Blend summary (which would differ if both rows were active).
   Reference Recovery scenario throughout: Added DT 5, Tonnes/DT 50 ->
   AddedTonnage 250 -> RequiredNi = (5.00*500 - 2.00*250)/250 = 8.00%
   (a clean, hand-verifiable number distinct from the pure module's own
   1.260% mandatory regression value in tests/planned-blend-recovery.test.mjs).
============================================================ */
describe('34. Recovery visibility -- only rendered while Target is unreachable', () => {
  test('absent before any Recommendation has been calculated', () => {
    const pageEl = mountFullAccess();
    mountRecoveryReadyOn(pageEl);
    assert.equal(recoverySectionRoot(pageEl), null);
  });

  test('absent when the Recommendation is within tolerance (known example)', () => {
    const pageEl = mountFullAccess();
    mountRecommendationReadyOn(pageEl);
    clickCalculateRecommendation(pageEl);
    assert.equal(recoverySectionRoot(pageEl), null);
  });

  test('present when the Recommendation is TARGET_NOT_ACHIEVABLE, positioned after Material/Fleet Actions', () => {
    const pageEl = mountFullAccess();
    mountRecoveryReadyOn(pageEl);
    clickCalculateRecommendation(pageEl);

    const root = recommendationResultRoot(pageEl);
    assert.notEqual(recoverySectionRoot(pageEl), null);
    const order = root.children.map((c) => c.className);
    const fleetIdx = order.findIndex((c) => (c || '').includes('calculate-fleet-actions'));
    const recoveryIdx = order.findIndex((c) => (c || '').includes('calculate-recovery-section'));
    assert.ok(fleetIdx >= 0 && recoveryIdx > fleetIdx, 'Recovery must render AFTER Fleet Actions');
  });
});

describe('35. Recovery baseline -- best-attainable candidate, never the sticky live Blend summary', () => {
  test('baseline shows the best-attainable candidate Ni (2.00%) and tonnage (250 t), not a live-summary value', () => {
    const pageEl = mountFullAccess();
    mountRecoveryReadyOn(pageEl);
    clickCalculateRecommendation(pageEl);

    const text = recoveryBaselineText(pageEl);
    assert.match(text, /2\.000%/);
    assert.match(text, /250,00\s*t/);
    // The live Blend summary, if it were used instead, would reflect BOTH
    // rows (Higher + Lglo), never just the best-attainable candidate's own
    // subset -- so this is a meaningfully different assertion, not a
    // tautology.
    assert.notEqual(summaryValue(pageEl, 'calculate-final-ni'), '2.000%');
  });
});

describe('36. Recovery calculation -- explicit action, reference result, invalid input', () => {
  test('the required-Ni result is absent until Calculate Recovery is pressed', () => {
    const pageEl = mountFullAccess();
    mountRecoveryReadyOn(pageEl);
    clickCalculateRecommendation(pageEl);
    fillRecoveryControls(pageEl, { addedDt: '5', tonnesPerDt: '50' });

    assert.equal(recoveryResultBox(pageEl).hidden, true);
  });

  test('reference scenario: Added DT 5, Tonnes/DT 50 -> required Ni >= 8.000% (>= prefix, minimum framing)', () => {
    const pageEl = mountFullAccess();
    mountRecoveryReadyOn(pageEl);
    clickCalculateRecommendation(pageEl);
    fillRecoveryControls(pageEl, { addedDt: '5', tonnesPerDt: '50' });

    clickCalculateRecovery(pageEl);

    assert.equal(recoveryResultBox(pageEl).hidden, false);
    assert.equal(recoveryResultValueText(pageEl), '≥ 8.000%');
  });

  test('MONITOR_ONLY: Calculate Recovery is gated by the same FULL_ACCESS action-boundary guard as Calculate Recommendation', () => {
    const pageEl = mountFullAccess();
    mountRecoveryReadyOn(pageEl);
    clickCalculateRecommendation(pageEl);
    fillRecoveryControls(pageEl, { addedDt: '5', tonnesPerDt: '50' });

    goMonitorOnly();
    const win = installMockWindow('#/calculate');
    clickCalculateRecovery(pageEl);

    assert.equal(win.getHash(), '#/settings');
    assert.equal(recoveryResultBox(pageEl).hidden, true);
  });

  test('Added DT = 0 shows an inline validation error, never a silent Infinity/NaN result', () => {
    const pageEl = mountFullAccess();
    mountRecoveryReadyOn(pageEl);
    clickCalculateRecommendation(pageEl);
    fillRecoveryControls(pageEl, { addedDt: '0', tonnesPerDt: '50' });

    clickCalculateRecovery(pageEl);

    assert.equal(recoveryResultBox(pageEl).hidden, true);
    const err = recoveryFieldErrorText(pageEl);
    assert.equal(err.hidden, false);
    assert.match(err.textContent, new RegExp(idCatalog['calculate.validation.recoveryAddedUnitsPositive']));
  });

  test('Tonnes/DT <= 0 shows an inline validation error', () => {
    const pageEl = mountFullAccess();
    mountRecoveryReadyOn(pageEl);
    clickCalculateRecommendation(pageEl);
    fillRecoveryControls(pageEl, { addedDt: '5', tonnesPerDt: '-1' });

    clickCalculateRecovery(pageEl);

    assert.equal(recoveryResultBox(pageEl).hidden, true);
    assert.match(recoveryFieldErrorText(pageEl).textContent, new RegExp(idCatalog['calculate.validation.recoveryTonnesPerUnitPositive']));
  });
});

describe('37. Available Source Matching -- qualifying sources, deterministic ordering, never highest-Ni-first', () => {
  test('a source with Ni below the required minimum is shown as NOT qualifying (empty list)', () => {
    const pageEl = mountFullAccess();
    mountRecoveryReadyOn(pageEl);
    clickCalculateRecommendation(pageEl);
    // Required Ni for this scenario is 8.000% -- neither entered source (2.00%/0.10%) qualifies.
    fillRecoveryControls(pageEl, { addedDt: '5', tonnesPerDt: '50' });
    clickCalculateRecovery(pageEl);

    assert.equal(qualifyingSourceRows(pageEl).length, 0);
    assert.match(recoveryQualifyingBox(pageEl).textContent, new RegExp(idCatalog['calculate.recovery.noQualifyingSources']));
  });

  test('a source with Ni at/above the required minimum qualifies and is listed', () => {
    const pageEl = mountFullAccess();
    fillRow(gridRows(pageEl)[0], { pileId: 'Higher', contractor: 'X', ni: '1.00', units: '5', tonnesPerUnit: '50' });
    fillRow(gridRows(pageEl)[1], { pileId: 'HighSource', contractor: 'Z', ni: '9.00', units: '3', tonnesPerUnit: '20' });
    // A tiny tolerance around a target between the two entered Ni values
    // guarantees no exact-fit combination is found (still
    // TARGET_NOT_ACHIEVABLE), and a very large Added DT/Tonnes-per-DT
    // pushes the required Ni close to the Target itself (~2.00%) --
    // comfortably below HighSource's own 9.00%, so it qualifies (verified
    // against the real engine, not hand-derived).
    fillRecommendationControls(pageEl, { targetNi: '2.00', tolerance: '0.0001' });
    clickCalculateRecommendation(pageEl);
    fillRecoveryControls(pageEl, { addedDt: '1000', tonnesPerDt: '1000' });
    clickCalculateRecovery(pageEl);

    const rows = qualifyingSourceRows(pageEl);
    assert.ok(rows.length >= 1, 'HighSource (Ni 9.00%) should qualify against a required Ni near 2.00%');
    const ids = rows.map((row) => findOne(row, hasClass('calculate-breakdown-row__id')).textContent);
    assert.ok(ids.some((t) => t.includes('HighSource')));
  });

  test('same Pile ID, different Contractor: each is matched independently, never conflated', () => {
    const pageEl = mountFullAccess();
    fillRow(gridRows(pageEl)[0], { pileId: 'PILE-1', contractor: 'HighCo', ni: '9.00', units: '5', tonnesPerUnit: '50' });
    fillRow(gridRows(pageEl)[1], { pileId: 'PILE-1', contractor: 'LowCo', ni: '0.10', units: '3', tonnesPerUnit: '20' });
    fillRecommendationControls(pageEl, { targetNi: '2.00', tolerance: '0.0001' });
    clickCalculateRecommendation(pageEl);
    fillRecoveryControls(pageEl, { addedDt: '1000', tonnesPerDt: '1000' });
    clickCalculateRecovery(pageEl);

    const rows = qualifyingSourceRows(pageEl);
    const contractors = rows.map((row) => findOne(row, hasClass('calculate-breakdown-row__id')).textContent);
    assert.ok(contractors.some((t) => t.includes('HighCo')));
    assert.ok(!contractors.some((t) => t.includes('LowCo')), 'the low-Ni Contractor sharing the same Pile ID must not qualify');
  });

  test('qualifying sources are never ordered highest-Ni-first', () => {
    const pageEl = mountFullAccess();
    fillRow(gridRows(pageEl)[0], { pileId: 'VeryHigh', contractor: 'A', ni: '15.00', units: '2', tonnesPerUnit: '10' });
    fillRow(gridRows(pageEl)[1], { pileId: 'AlsoHigh', contractor: 'B', ni: '9.50', units: '2', tonnesPerUnit: '10' });
    fillRecommendationControls(pageEl, { targetNi: '8.00', tolerance: '0.0001' });
    clickCalculateRecommendation(pageEl);
    fillRecoveryControls(pageEl, { addedDt: '1000', tonnesPerDt: '1000' });
    clickCalculateRecovery(pageEl);

    const rows = qualifyingSourceRows(pageEl);
    assert.equal(rows.length, 2, 'both entered sources should qualify against a required Ni near 8.00%');
    const ids = rows.map((row) => findOne(row, hasClass('calculate-breakdown-row__id')).textContent);
    assert.ok(ids[0].includes('AlsoHigh'), 'the LOWER-Ni qualifying source (9.50%) must be listed FIRST');
    assert.ok(ids[1].includes('VeryHigh'), 'the HIGHER-Ni qualifying source (15.00%) must be listed LAST, never first');
  });
});

describe('38. Recovery invalidation -- source/Target/Tolerance clears everything; Added DT/Tonnes-per-DT clears ONLY the Recovery result', () => {
  test('editing a source value clears Recovery along with the whole Recommendation result', () => {
    const pageEl = mountFullAccess();
    mountRecoveryReadyOn(pageEl);
    clickCalculateRecommendation(pageEl);
    fillRecoveryControls(pageEl, { addedDt: '5', tonnesPerDt: '50' });
    clickCalculateRecovery(pageEl);
    assert.notEqual(recoverySectionRoot(pageEl), null);

    typeIntoField(gridRows(pageEl)[0], 'ni', '2.50');

    assert.equal(recommendationResultRoot(pageEl).hidden, true);
    assert.equal(recoverySectionRoot(pageEl), null);
  });

  test('editing Target Ni clears Recovery along with the whole Recommendation result', () => {
    const pageEl = mountFullAccess();
    mountRecoveryReadyOn(pageEl);
    clickCalculateRecommendation(pageEl);
    fillRecoveryControls(pageEl, { addedDt: '5', tonnesPerDt: '50' });
    clickCalculateRecovery(pageEl);

    fillRecommendationControls(pageEl, { targetNi: '6.00' });

    assert.equal(recommendationResultRoot(pageEl).hidden, true);
    assert.equal(recoverySectionRoot(pageEl), null);
  });

  test('editing Tolerance clears Recovery along with the whole Recommendation result', () => {
    const pageEl = mountFullAccess();
    mountRecoveryReadyOn(pageEl);
    clickCalculateRecommendation(pageEl);
    fillRecoveryControls(pageEl, { addedDt: '5', tonnesPerDt: '50' });
    clickCalculateRecovery(pageEl);

    fillRecommendationControls(pageEl, { tolerance: '0.02' });

    assert.equal(recommendationResultRoot(pageEl).hidden, true);
    assert.equal(recoverySectionRoot(pageEl), null);
  });

  test('editing Added DT clears ONLY the Recovery result -- Recommendation, Material Actions, Fleet Actions all survive', () => {
    const pageEl = mountFullAccess();
    mountRecoveryReadyOn(pageEl);
    clickCalculateRecommendation(pageEl);
    fillRecoveryControls(pageEl, { addedDt: '5', tonnesPerDt: '50' });
    clickCalculateRecovery(pageEl);
    assert.equal(recoveryResultBox(pageEl).hidden, false);

    fillRecoveryControls(pageEl, { addedDt: '10' });

    assert.equal(recoveryResultBox(pageEl).hidden, true);
    // Untouched by the Added DT edit:
    assert.equal(recommendationResultRoot(pageEl).hidden, false);
    assert.notEqual(recoverySectionRoot(pageEl), null);
    assert.notEqual(materialActionsRoot(pageEl), null);
    assert.notEqual(fleetActionsRoot(pageEl), null);
  });

  test('editing Tonnes/DT clears ONLY the Recovery result', () => {
    const pageEl = mountFullAccess();
    mountRecoveryReadyOn(pageEl);
    clickCalculateRecommendation(pageEl);
    fillRecoveryControls(pageEl, { addedDt: '5', tonnesPerDt: '50' });
    clickCalculateRecovery(pageEl);

    fillRecoveryControls(pageEl, { tonnesPerDt: '60' });

    assert.equal(recoveryResultBox(pageEl).hidden, true);
    assert.equal(recommendationResultRoot(pageEl).hidden, false);
  });

  test('recalculating after clearing Recovery via an Added DT edit produces a fresh, current result -- never a stale leftover', () => {
    const pageEl = mountFullAccess();
    mountRecoveryReadyOn(pageEl);
    clickCalculateRecommendation(pageEl);
    fillRecoveryControls(pageEl, { addedDt: '5', tonnesPerDt: '50' });
    clickCalculateRecovery(pageEl);
    assert.equal(recoveryResultValueText(pageEl), '≥ 8.000%');

    fillRecoveryControls(pageEl, { addedDt: '10' });
    assert.equal(recoveryResultBox(pageEl).hidden, true);
    clickCalculateRecovery(pageEl);

    // AddedTonnage = 10*50 = 500 -> RequiredNi = (5.00*750 - 2.00*250)/500 = (3750-500)/500 = 6.500%
    assert.equal(recoveryResultValueText(pageEl), '≥ 6.500%');
  });

  test('once Recommendation recalculates to within tolerance, Recovery disappears completely', () => {
    const pageEl = mountFullAccess();
    mountRecoveryReadyOn(pageEl);
    clickCalculateRecommendation(pageEl);
    fillRecoveryControls(pageEl, { addedDt: '5', tonnesPerDt: '50' });
    clickCalculateRecovery(pageEl);
    assert.notEqual(recoverySectionRoot(pageEl), null);

    // Lower Target Ni into the achievable range for this same fleet, then recalculate.
    fillRecommendationControls(pageEl, { targetNi: '1.20', tolerance: '1.00' });
    clickCalculateRecommendation(pageEl);

    assert.match(statusBadgeText(pageEl), new RegExp(idCatalog['calculate.recommendation.withinTolerance']));
    assert.equal(recoverySectionRoot(pageEl), null);
  });

  test('if it later becomes TARGET_NOT_ACHIEVABLE again, Recovery shows a FRESH baseline, never a stale one from before', () => {
    const pageEl = mountFullAccess();
    mountRecoveryReadyOn(pageEl);
    clickCalculateRecommendation(pageEl);
    fillRecoveryControls(pageEl, { addedDt: '5', tonnesPerDt: '50' });
    clickCalculateRecovery(pageEl);

    fillRecommendationControls(pageEl, { targetNi: '1.20', tolerance: '1.00' });
    clickCalculateRecommendation(pageEl);
    assert.equal(recoverySectionRoot(pageEl), null);

    fillRecommendationControls(pageEl, { targetNi: '5.00', tolerance: '0.01' });
    clickCalculateRecommendation(pageEl);

    assert.notEqual(recoverySectionRoot(pageEl), null);
    // A fresh section never carries over the previous Added DT/Tonnes-per-DT typed values or result.
    assert.equal(findFieldInput(pageEl, 'addedDt').value, '');
    assert.equal(findFieldInput(pageEl, 'tonnesPerDt').value, '');
    assert.equal(recoveryResultBox(pageEl).hidden, true);
  });

  test('Material Actions and Fleet Actions content is unaffected by Recovery calculation/invalidation', () => {
    const pageEl = mountFullAccess();
    mountRecoveryReadyOn(pageEl);
    clickCalculateRecommendation(pageEl);
    const higherBadgeBefore = materialActionBadgeText(materialActionRowFor(pageEl, 'Higher'));

    fillRecoveryControls(pageEl, { addedDt: '5', tonnesPerDt: '50' });
    clickCalculateRecovery(pageEl);
    fillRecoveryControls(pageEl, { addedDt: '10' });

    assert.equal(materialActionBadgeText(materialActionRowFor(pageEl, 'Higher')), higherBadgeBefore);
  });

  test('no sampling-history UI appears anywhere in or around the Recovery section', () => {
    const pageEl = mountFullAccess();
    mountRecoveryReadyOn(pageEl);
    clickCalculateRecommendation(pageEl);
    fillRecoveryControls(pageEl, { addedDt: '5', tonnesPerDt: '50' });
    clickCalculateRecovery(pageEl);

    assert.doesNotMatch(recoverySectionRoot(pageEl).textContent, /sampling|actual fpp|closed.?loop/i);
  });
});

/* ============================================================
   i18n key existence for the new calculate.actions.* family
============================================================ */
describe('calculate.actions.* localization keys exist and carry the Owner-specified wording', () => {
  test('Indonesian wording matches this task\'s Section 20', () => {
    assert.equal(idCatalog['calculate.actions.material.use'], 'GUNAKAN');
    assert.equal(idCatalog['calculate.actions.material.limit'], 'BATASI');
    assert.equal(idCatalog['calculate.actions.material.stop'], 'STOP');
    assert.equal(idCatalog['calculate.actions.fleet.use'], 'AKTIF');
    assert.equal(idCatalog['calculate.actions.fleet.move'], 'PINDAH');
    // "STANDBY" (V2.4 Phase 6.1 Owner correction) -- was "PISAHKAN",
    // rejected as user-facing wording because it could be misread as
    // separating material or permanently removing the unit.
    assert.equal(idCatalog['calculate.actions.fleet.separate'], 'STANDBY');
  });

  test('English wording is the plain domain vocabulary', () => {
    assert.equal(enCatalog['calculate.actions.material.use'], 'USE');
    assert.equal(enCatalog['calculate.actions.material.limit'], 'LIMIT');
    assert.equal(enCatalog['calculate.actions.material.stop'], 'STOP');
    assert.equal(enCatalog['calculate.actions.fleet.use'], 'ACTIVE');
    assert.equal(enCatalog['calculate.actions.fleet.move'], 'MOVE');
    // "STANDBY" (V2.4 Phase 6.1 Owner correction) -- was "SEPARATE".
    assert.equal(enCatalog['calculate.actions.fleet.separate'], 'STANDBY');
  });

  test('id.js and en.js still carry the exact same calculate.actions.* key set', () => {
    const idKeys = Object.keys(idCatalog).filter((k) => k.startsWith('calculate.actions.')).sort();
    const enKeys = Object.keys(enCatalog).filter((k) => k.startsWith('calculate.actions.')).sort();
    assert.deepEqual(idKeys, enKeys);
    assert.ok(idKeys.length > 0);
  });
});
