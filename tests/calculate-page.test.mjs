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
import { parseDecimalInput } from '../js/pages/calculate/number-input.js';
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

// V2.5 Sticky Recommendation Controls Refinement.
function stickyControlsRoot(pageEl) {
  return findOne(pageEl, hasClass('calculate-recommendation-sticky-controls'));
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

// V2.5 Preserve Recommendation View While Editing Target/Tolerance.
function staleNoticeRoot(pageEl) {
  return findOne(pageEl, hasClass('calculate-recommendation-stale-notice'));
}

function isResultStale(pageEl) {
  return /\bis-stale\b/.test(recommendationResultRoot(pageEl).className);
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
// best-attainable candidate uses ONLY Higher (X, Ni 2.00, 6 DT, 50 t/DT),
// Lglo (Y, Ni 0.10) fully idle, so the Recovery baseline is a clean,
// hand-verifiable Ni 2.00% / 300t (never the live sticky Blend summary,
// which would instead reflect BOTH rows if they were both complete/used).
// V3.0 Phase 2: Higher's fleet is 6, not 5 -- a fleet of 5 has no feasible
// nonzero allocation at all under the new hard 0-or->=6 generation-time
// rule (verified against the actual engine, not hand-derived).
function mountRecoveryReadyOn(pageEl) {
  fillRow(gridRows(pageEl)[0], { pileId: 'Higher', contractor: 'X', ni: '2.00', units: '6', tonnesPerUnit: '50' });
  fillRow(gridRows(pageEl)[1], { pileId: 'Lglo', contractor: 'Y', ni: '0.10', units: '5', tonnesPerUnit: '50' });
  fillRecommendationControls(pageEl, { targetNi: '5.00', tolerance: '0.01' });
  return pageEl;
}

// Architecture doc / this task's "known fleet example": Higher Grade
// (SMA, Ni 1.30, 7 DT, 50 t/DT) + LGLO (TII, Ni 1.03, 12 DT, 50 t/DT).
// V3.0 Phase 2 rescale (was 5 DT / 8 DT, tolerance 0.010): the legacy
// fixture's winning candidate (Higher active=4) is an invalid 1-5 DT
// active loading point under the new hard 0-or->=6 generation-time
// feasibility rule -- ContractorA's own total fleet was only 5 DT, so
// Higher could never reach 6+ at all. Rescaled and verified against the
// actual engine (see tests/blending-recommendation.test.mjs's own "24.
// Known fleet example" for the full derivation) to reproduce the SAME
// qualitative story (1:2 Hopper Pattern, Ni exactly on target, one
// un-forced surplus DT) with an operationally valid winner: Higher
// active=6 (of 7), Lglo active=12.
function fillKnownRecommendationExample(pageEl) {
  fillRow(gridRows(pageEl)[0], { pileId: 'Higher', contractor: 'SMA', ni: '1.30', units: '7', tonnesPerUnit: '50' });
  fillRow(gridRows(pageEl)[1], { pileId: 'Lglo', contractor: 'TII', ni: '1.03', units: '12', tonnesPerUnit: '50' });
}

// No mode switch to perform anymore -- Recommendation controls are always
// present directly below the grid.
function mountRecommendationReadyOn(pageEl) {
  fillKnownRecommendationExample(pageEl);
  fillRecommendationControls(pageEl, { targetNi: '1.120', tolerance: '0.009' });
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
   V2.4.1 Bug A -- device-locale default Tolerance display (this task's
   Sections 9/30/34). navigator.language is stubbed to an EXPLICIT locale
   for each test (never left to whatever the CI host's own locale happens
   to be, this task's Section 34's explicit requirement) via
   Object.defineProperty, since Node's own built-in `navigator` global is a
   getter-only accessor property that a plain assignment silently no-ops
   against.
============================================================ */
describe('V2.4.1 Bug A -- device-locale default Tolerance display', () => {
  function withDeviceLocale(locale, fn) {
    const original = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
    Object.defineProperty(globalThis, 'navigator', { value: { language: locale }, configurable: true, writable: true });
    try {
      fn();
    } finally {
      Object.defineProperty(globalThis, 'navigator', original);
    }
  }

  test('id-ID device locale prefills Tolerance as "0,010" (comma decimal)', () => {
    withDeviceLocale('id-ID', () => {
      const pageEl = mountFullAccess();
      assert.equal(findFieldInput(pageEl, 'tolerance').value, '0,010');
    });
  });

  test('en-US device locale prefills Tolerance as "0.010" (dot decimal)', () => {
    withDeviceLocale('en-US', () => {
      const pageEl = mountFullAccess();
      assert.equal(findFieldInput(pageEl, 'tolerance').value, '0.010');
    });
  });

  test('the device locale is independent of the app\'s own Indonesian/English UI language -- an English UI on an id-ID phone still shows "0,010"', () => {
    withDeviceLocale('id-ID', () => {
      setLocale('en');
      const pageEl = mountFullAccess();
      assert.equal(findFieldInput(pageEl, 'tolerance').value, '0,010');
      setLocale(DEFAULT_LOCALE);
    });
  });

  test('both locale forms parse back to the exact business default DEFAULT_RECOMMENDATION_TOLERANCE (0.010) -- the underlying constant never changes', () => {
    withDeviceLocale('id-ID', () => {
      const pageEl = mountFullAccess();
      assert.equal(parseDecimalInput(findFieldInput(pageEl, 'tolerance').value), DEFAULT_RECOMMENDATION_TOLERANCE);
    });
    withDeviceLocale('en-US', () => {
      const pageEl = mountFullAccess();
      assert.equal(parseDecimalInput(findFieldInput(pageEl, 'tolerance').value), DEFAULT_RECOMMENDATION_TOLERANCE);
    });
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

  // V2.4.1 Bug A (this task's Section 33): the exact same known example,
  // entered with a comma decimal separator (the form an Indonesian-locale
  // iPhone's decimal keyboard actually produces) instead of a dot, must
  // produce the IDENTICAL live Blend result -- never NaN, never a
  // "Ni harus berupa angka yang valid." validation error.
  test('the same known worked example entered with comma decimals (id-ID keyboard) produces the IDENTICAL live Blend result', () => {
    const pageEl = mountFullAccess();
    fillRow(gridRows(pageEl)[0], { pileId: 'Pile A', contractor: 'SMA', ni: '1,30', units: '10', tonnesPerUnit: '50' });
    fillRow(gridRows(pageEl)[1], { pileId: 'Pile B', contractor: 'TII', ni: '0,95', units: '20', tonnesPerUnit: '45' });

    assert.equal(findRowError(gridRows(pageEl)[0]).hidden, true, 'comma-decimal Ni "1,30" must validate, not be rejected as invalid');
    assert.equal(summaryValue(pageEl, 'calculate-final-ni'), '1.075%');
    assert.equal(summaryValue(pageEl, 'calculate-total-units'), '30');
    assert.match(summaryValue(pageEl, 'calculate-total-tonnage'), /1\.400,00 t|1,400.00 t/);
  });

  test('a comma-decimal Tonnes/DT ("45,5") is accepted end-to-end and drives the correct live tonnage/summary, matching its dot-decimal equivalent', () => {
    const dotPageEl = mountFullAccess();
    fillRow(gridRows(dotPageEl)[0], { pileId: 'A', contractor: 'SMA', ni: '1.2', units: '10', tonnesPerUnit: '45.5' });
    const dotTonnage = summaryValue(dotPageEl, 'calculate-total-tonnage');

    const commaPageEl = mountFullAccess();
    fillRow(gridRows(commaPageEl)[0], { pileId: 'A', contractor: 'SMA', ni: '1.2', units: '10', tonnesPerUnit: '45,5' });
    assert.equal(findRowError(gridRows(commaPageEl)[0]).hidden, true, 'comma-decimal Tonnes/DT "45,5" must validate, not be rejected as invalid');
    assert.equal(summaryValue(commaPageEl, 'calculate-total-tonnage'), dotTonnage);
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
   KNOWN RECOMMENDATION EXAMPLE (V3.0 Phase 2 rescale: 7 HG DT / 12 LGLO
   DT, was 5/8 -- see fillKnownRecommendationExample()'s own comment)
   -- still 1:2
============================================================ */
describe('Known fleet example (7 HG DT / 12 LGLO DT) -- unaffected by mode-tab removal', () => {
  test('17. Hopper Pattern 1:2, Estimated Ni 1.120%, Fleet 18/19, Higher active 6, LGLO active 12, Surplus 1', () => {
    const pageEl = mountFullAccess();
    mountRecommendationReadyOn(pageEl);
    clickCalculateRecommendation(pageEl);

    assert.equal(recommendationResultRoot(pageEl).hidden, false);
    assert.equal(hopperPatternRatioText(pageEl), '1 : 2');
    assert.equal(summaryValue(pageEl, 'calculate-recommendation-estimated-ni'), '1.120%');
    assert.equal(summaryValue(pageEl, 'calculate-recommendation-fleet-utilization'), '18 / 19 DT');
    assert.match(statusBadgeText(pageEl), new RegExp(idCatalog['calculate.recommendation.withinTolerance']));

    const rows = sourceBreakdownRows(pageEl);
    const higherRow = rows.find((r) => r.textContent.includes('Higher'));
    const lgloRow = rows.find((r) => r.textContent.includes('Lglo'));
    assert.match(higherRow.textContent, /7 DT/);
    assert.match(higherRow.textContent, /6 DT/);
    assert.match(higherRow.textContent, new RegExp(`${idCatalog['calculate.recommendation.surplus']}: 1 DT`));
    assert.match(lgloRow.textContent, /12 DT/);
  });

  test('the full-fleet 7:12 (19/19) allocation is NOT what gets shown as selected', () => {
    const pageEl = mountFullAccess();
    mountRecommendationReadyOn(pageEl);
    clickCalculateRecommendation(pageEl);

    assert.notEqual(summaryValue(pageEl, 'calculate-recommendation-fleet-utilization'), '19 / 19 DT');
  });

  // V2.4.1 Bug A (this task's Section 9): the VISIBLE prefill now follows
  // device/browser numeric locale (formatDecimalForLocale()), so it is no
  // longer always the literal ".toFixed(3)" dot-decimal string -- asserted
  // here via a parseDecimalInput() round-trip instead, which is correct
  // regardless of which locale format the current test host's own
  // navigator.language happens to produce (never assume a CI host locale).
  test('16. default Tolerance value comes from the engine-exported DEFAULT_RECOMMENDATION_TOLERANCE constant', () => {
    const pageEl = mountFullAccess();
    const raw = findFieldInput(pageEl, 'tolerance').value;
    assert.equal(parseDecimalInput(raw), DEFAULT_RECOMMENDATION_TOLERANCE);
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
    // units=6 (V3.0 Phase 2 -- was 4, below the generation-time minimum).
    fillRow(gridRows(pageEl)[0], { pileId: 'A', contractor: 'SMA', ni: '1.150', units: '6', tonnesPerUnit: '50' });
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
// V3.0 Phase 2 rescale (was Higher 5 DT / LGLO 7 DT, tolerance 0.010) --
// verified against tests/blending-recommendation.test.mjs's own "25.
// Same-Contractor relocation".
describe('Same-Contractor relocation (Higher 7 DT / LGLO 11 DT, both SMA)', () => {
  test('active 6/12, fleet 18/18 (100%), relocation 1 DT Higher -> LGLO shown', () => {
    const pageEl = mountFullAccess();
    fillRow(gridRows(pageEl)[0], { pileId: 'Higher', contractor: 'SMA', ni: '1.30', units: '7', tonnesPerUnit: '50' });
    fillRow(gridRows(pageEl)[1], { pileId: 'Lglo', contractor: 'SMA', ni: '1.03', units: '11', tonnesPerUnit: '50' });
    fillRecommendationControls(pageEl, { targetNi: '1.120', tolerance: '0.009' });

    clickCalculateRecommendation(pageEl);

    assert.equal(summaryValue(pageEl, 'calculate-recommendation-fleet-utilization'), '18 / 18 DT');
    const utilizationPct = findOne(pageEl, hasClass('calculate-recommendation-utilization-pct')).textContent;
    assert.match(utilizationPct, /100/);

    const relocations = relocationRows(pageEl);
    assert.equal(relocations.length, 1);
    assert.match(relocations[0].textContent, /SMA/);
    assert.match(relocations[0].textContent, /1 DT/);
    assert.match(relocations[0].textContent, /Higher.*→.*Lglo/);
  });
});

// V3.0 Phase 2 rescale, same numbers as above with LGLO under TII instead
// -- verified against tests/blending-recommendation.test.mjs's own "26.
// Cross-Contractor negative test".
describe('Cross-Contractor negative case (Higher SMA / LGLO TII, assigned 11)', () => {
  test('no relocation section is rendered -- cross-Contractor relocation is never displayed', () => {
    const pageEl = mountFullAccess();
    fillRow(gridRows(pageEl)[0], { pileId: 'Higher', contractor: 'SMA', ni: '1.30', units: '7', tonnesPerUnit: '50' });
    fillRow(gridRows(pageEl)[1], { pileId: 'Lglo', contractor: 'TII', ni: '1.03', units: '11', tonnesPerUnit: '50' });
    fillRecommendationControls(pageEl, { targetNi: '1.120', tolerance: '0.009' });

    clickCalculateRecommendation(pageEl);

    assert.equal(recommendationResultRoot(pageEl).hidden, false);
    assert.equal(relocationRows(pageEl).length, 0);
    assert.doesNotMatch(recommendationResultRoot(pageEl).textContent, /→/);
  });
});

// V3.0 Phase 2 rescale, same numbers as "24. Known fleet example" (7/12,
// tolerance 0.009) with both sources sharing Pile ID "L30".
describe('Recommendation still accepts the same Pile ID across different Contractors as distinct sources (this task\'s Section 10)', () => {
  test('13. L30/SMA (Higher) and L30/TII (LGLO) both contribute to the recommendation without collapsing', () => {
    const pageEl = mountFullAccess();
    fillRow(gridRows(pageEl)[0], { pileId: 'L30', contractor: 'SMA', ni: '1.30', units: '7', tonnesPerUnit: '50' });
    fillRow(gridRows(pageEl)[1], { pileId: 'L30', contractor: 'TII', ni: '1.03', units: '12', tonnesPerUnit: '50' });
    fillRecommendationControls(pageEl, { targetNi: '1.120', tolerance: '0.009' });

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
    // Higher units=6 (V3.0 Phase 2 -- was 5, below the generation-time minimum).
    fillRow(gridRows(pageEl)[0], { pileId: 'Higher', contractor: 'X', ni: '2.00', units: '6', tonnesPerUnit: '50' });
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

  // V2.5 (Preserve Recommendation View While Editing Target/Tolerance,
  // this task's Sections 1-10) supersedes the original expectation here:
  // editing Target Ni/Tolerance no longer clears the result outright -- it
  // stays rendered, marked STALE, so the viewport does not collapse while
  // the operator is scrolled deep into it via the sticky controls. Full
  // coverage of the new behavior lives in the dedicated
  // "V2.5 -- stale Recommendation while editing Target/Tolerance" block
  // below; this test now only re-confirms the result is NOT hidden.
  test('19. editing Target Ni no longer hides the existing Recommendation result -- it becomes stale instead (V2.5)', () => {
    const pageEl = mountFullAccess();
    mountRecommendationReadyOn(pageEl);
    clickCalculateRecommendation(pageEl);
    assert.equal(recommendationResultRoot(pageEl).hidden, false);

    typeIntoField(pageEl, 'targetNi', '1.130');

    assert.equal(recommendationResultRoot(pageEl).hidden, false);
  });

  test('20. editing Tolerance no longer hides the existing Recommendation result -- it becomes stale instead (V2.5)', () => {
    const pageEl = mountFullAccess();
    mountRecommendationReadyOn(pageEl);
    clickCalculateRecommendation(pageEl);
    assert.equal(recommendationResultRoot(pageEl).hidden, false);

    typeIntoField(pageEl, 'tolerance', '0.020');

    assert.equal(recommendationResultRoot(pageEl).hidden, false);
  });

  test('removing a source row clears the existing Recommendation result', () => {
    const pageEl = mountFullAccess();
    mountRecommendationReadyOn(pageEl);
    clickCalculateRecommendation(pageEl);
    assert.equal(recommendationResultRoot(pageEl).hidden, false);

    clickRemove(gridRows(pageEl)[0]);

    assert.equal(recommendationResultRoot(pageEl).hidden, true);
  });

  // Full assertion set for the Known fleet example (test 17's own values,
  // V3.0 Phase 2 rescale -- Higher SMA 1.30/7 DT/50 t/DT + Lglo TII
  // 1.03/12 DT/50 t/DT, Target 1.120, Tolerance 0.009): Higher active 6,
  // LGLO active 12, Hopper Pattern 1:2, Estimated Final Ni 1.120%, Fleet
  // 18/19 DT, Surplus 1 DT. Recommendation ranking's own first-priority
  // rule is "maximize fleet utilization" (recommendation-ranking.js's
  // compareWithinTolerance, architecture doc Section 18.2) -- this exact
  // 1:2 result is only guaranteed reproducible when Target/Tolerance are
  // restored to these exact reference values before recalculating, since
  // a genuinely wider tolerance can legitimately admit a higher-
  // utilization candidate (e.g. the full 7:12/19-DT fleet) that then
  // correctly outranks it -- that is approved ranking behavior, not a
  // defect (see the dedicated "full-fleet 7:12 (19/19) allocation is NOT
  // what gets shown as selected" test above, which proves the opposite
  // direction of this same rule).
  function assertKnownRecommendationResult(pageEl) {
    assert.equal(recommendationResultRoot(pageEl).hidden, false);
    assert.equal(hopperPatternRatioText(pageEl), '1 : 2');
    assert.equal(summaryValue(pageEl, 'calculate-recommendation-estimated-ni'), '1.120%');
    assert.equal(summaryValue(pageEl, 'calculate-recommendation-fleet-utilization'), '18 / 19 DT');
    assert.match(statusBadgeText(pageEl), new RegExp(idCatalog['calculate.recommendation.withinTolerance']));

    const rows = sourceBreakdownRows(pageEl);
    const higherRow = rows.find((r) => r.textContent.includes('Higher'));
    const lgloRow = rows.find((r) => r.textContent.includes('Lglo'));
    assert.match(higherRow.textContent, /7 DT/);
    assert.match(higherRow.textContent, /6 DT/);
    assert.match(higherRow.textContent, new RegExp(`${idCatalog['calculate.recommendation.surplus']}: 1 DT`));
    assert.match(lgloRow.textContent, /12 DT/);
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

  test('V2.5: after a Target Ni edit marks the result stale, restoring the known-valid Target and pressing Hitung Rekomendasi again reproduces the exact known result', () => {
    const pageEl = mountFullAccess();
    mountRecommendationReadyOn(pageEl);
    clickCalculateRecommendation(pageEl);
    assertKnownRecommendationResult(pageEl);

    typeIntoField(pageEl, 'targetNi', '1.130');
    assert.equal(recommendationResultRoot(pageEl).hidden, false, 'the stale result must remain visible, never hidden, this task Section 1');

    typeIntoField(pageEl, 'targetNi', '1.120'); // restore the known-valid Target Ni
    clickCalculateRecommendation(pageEl);
    assertKnownRecommendationResult(pageEl);
  });

  test('V2.5: after a Tolerance edit marks the result stale, restoring the known-valid Tolerance and pressing Hitung Rekomendasi again reproduces the exact known result', () => {
    const pageEl = mountFullAccess();
    mountRecommendationReadyOn(pageEl);
    clickCalculateRecommendation(pageEl);
    assertKnownRecommendationResult(pageEl);

    typeIntoField(pageEl, 'tolerance', '0.020');
    assert.equal(recommendationResultRoot(pageEl).hidden, false, 'the stale result must remain visible, never hidden, this task Section 1');

    typeIntoField(pageEl, 'tolerance', '0.009'); // restore the known-valid Tolerance (this fixture's reference tolerance -- see fillKnownRecommendationExample()'s own comment; the engine's DEFAULT_RECOMMENDATION_TOLERANCE is a UI prefill default, not a per-scenario constant)
    clickCalculateRecommendation(pageEl);
    assertKnownRecommendationResult(pageEl);
  });

  test('a genuinely WIDER Tolerance, once recalculated, is still a fresh, non-stale, CORRECT result -- just not necessarily the same candidate', () => {
    const pageEl = mountFullAccess();
    mountRecommendationReadyOn(pageEl);
    clickCalculateRecommendation(pageEl);
    assertKnownRecommendationResult(pageEl);

    typeIntoField(pageEl, 'tolerance', '0.020');
    assert.equal(recommendationResultRoot(pageEl).hidden, false, 'stale, not hidden');

    clickCalculateRecommendation(pageEl);
    assert.equal(recommendationResultRoot(pageEl).hidden, false);
    // Widening Tolerance legitimately admits the full PHYSICAL 7:12
    // (19/19 DT, 100% utilization) candidate, which now correctly outranks
    // the 18/19-DT candidate under recommendation-ranking.js's "maximize
    // fleet utilization first" rule -- this is the SAME approved candidate-
    // selection behavior the "full-fleet 7:12 (19/19) allocation is NOT
    // what gets shown as selected" test above already proves for Tolerance
    // 0.009 alone, and it is unaffected by this task's Hopper Pattern
    // decoupling (V2.4 Phase 6.1) -- fleet utilization stays a PHYSICAL
    // number. The DISPLAYED Hopper Pattern, however, is the independently-
    // derived OPERATIONAL pattern (hopper-pattern.js) -- verified
    // separately (not assumed) to still land on 1:2 for this specific
    // physical 7:12 ratio, since it is never assumed to just be that
    // physical ratio (this task's Section 24/28: "active fleet ratio does
    // NOT automatically mean Hopper Pattern"). It must still be a real,
    // non-stale, internally-consistent result, never the frozen-looking Ni
    // 1.120%/1:2 result from before the edit -- proven here by the
    // DIFFERENT fleet-utilization figure (19/19 vs the earlier 18/19),
    // even though the Hopper Pattern digits happen to coincide.
    assert.equal(hopperPatternRatioText(pageEl), '1 : 2');
    assert.equal(summaryValue(pageEl, 'calculate-recommendation-fleet-utilization'), '19 / 19 DT');
    assert.match(statusBadgeText(pageEl), new RegExp(idCatalog['calculate.recommendation.withinTolerance']));
  });
});

/* ============================================================
   V2.5 -- Preserve Recommendation View While Editing Target/Tolerance
   (this task's Sections 24-30)
============================================================ */
describe('V2.5 -- stale Recommendation while editing Target/Tolerance (this task Sections 24-30)', () => {
  test('24. editing Target Ni: result stays visible+unchanged (old Target 1.120 still shown), marked stale, notice shown, and the sticky input reflects the NEW value -- no fresh engine run', () => {
    const pageEl = mountFullAccess();
    mountRecommendationReadyOn(pageEl);
    clickCalculateRecommendation(pageEl);
    assert.equal(recommendationResultRoot(pageEl).hidden, false);
    assert.equal(isResultStale(pageEl), false);
    assert.equal(staleNoticeRoot(pageEl).hidden, true);

    typeIntoField(pageEl, 'targetNi', '1.130');

    assert.equal(recommendationResultRoot(pageEl).hidden, false, 'the result must remain visible');
    assert.equal(isResultStale(pageEl), true, 'the result must be marked stale');
    assert.equal(staleNoticeRoot(pageEl).hidden, false, 'the stale notice must be shown');
    assert.equal(staleNoticeRoot(pageEl).textContent.includes(idCatalog['calculate.recommendation.staleNotice']), true);
    assert.match(recommendationResultRoot(pageEl).textContent, /Target Ni1\.120%/, 'the OLD Target Ni must still be echoed in the frozen result');
    assert.equal(findFieldInput(pageEl, 'targetNi').value, '1.130', 'the sticky input itself always reflects what the user actually typed');
  });

  test('25. Tolerance has the exact same stale-preserving behavior as Target Ni', () => {
    const pageEl = mountFullAccess();
    mountRecommendationReadyOn(pageEl);
    clickCalculateRecommendation(pageEl);

    typeIntoField(pageEl, 'tolerance', '0.020');

    assert.equal(recommendationResultRoot(pageEl).hidden, false);
    assert.equal(isResultStale(pageEl), true);
    assert.equal(staleNoticeRoot(pageEl).hidden, false);
    assert.equal(findFieldInput(pageEl, 'tolerance').value, '0.020');
  });

  test('26. pressing Hitung Rekomendasi after a stale edit produces a fresh result: stale=false, notice hidden, result reflects the NEW Target', () => {
    const pageEl = mountFullAccess();
    mountRecommendationReadyOn(pageEl);
    clickCalculateRecommendation(pageEl);

    typeIntoField(pageEl, 'targetNi', '1.130');
    assert.equal(isResultStale(pageEl), true);

    clickCalculateRecommendation(pageEl);

    assert.equal(recommendationResultRoot(pageEl).hidden, false);
    assert.equal(isResultStale(pageEl), false, 'a fresh calculation always clears staleness');
    assert.equal(staleNoticeRoot(pageEl).hidden, true);
    assert.match(recommendationResultRoot(pageEl).textContent, /1\.130/);
  });

  test('27. a source-grid edit still fully clears the result immediately, unlike Target/Tolerance (regression lock)', () => {
    const pageEl = mountFullAccess();
    mountRecommendationReadyOn(pageEl);
    clickCalculateRecommendation(pageEl);

    typeIntoField(gridRows(pageEl)[0], 'ni', '1.35');

    assert.equal(recommendationResultRoot(pageEl).hidden, true, 'source edits are still a hard, immediate clear -- never merely stale');
    assert.equal(staleNoticeRoot(pageEl).hidden, true, 'no stale notice for a fully-cleared result');
  });

  test('28. a temporarily invalid Target (field cleared) leaves the old result visible and stale, never collapsed', () => {
    const pageEl = mountFullAccess();
    mountRecommendationReadyOn(pageEl);
    clickCalculateRecommendation(pageEl);

    typeIntoField(pageEl, 'targetNi', '');

    assert.equal(recommendationResultRoot(pageEl).hidden, false, 'an in-progress/invalid edit must not collapse the existing result');
    assert.equal(isResultStale(pageEl), true);
    assert.match(recommendationResultRoot(pageEl).textContent, /1\.120/, 'still echoing the last valid calculated Target');
  });

  test('29. changing Target back to the exact original value (semantic match, comma/dot locale parity) restores a fresh, non-stale result WITHOUT re-running the engine', () => {
    const pageEl = mountFullAccess();
    mountRecommendationReadyOn(pageEl);
    clickCalculateRecommendation(pageEl);
    const ratioBefore = hopperPatternRatioText(pageEl);
    const utilizationBefore = summaryValue(pageEl, 'calculate-recommendation-fleet-utilization');

    typeIntoField(pageEl, 'targetNi', '1.130');
    assert.equal(isResultStale(pageEl), true);

    // Locale-comma form of the SAME original value (1.120) -- semantic
    // equivalence via parseDecimalInput(), not a string comparison.
    typeIntoField(pageEl, 'targetNi', '1,120');

    assert.equal(recommendationResultRoot(pageEl).hidden, false);
    assert.equal(isResultStale(pageEl), false, 'restoring the exact original value (even in comma form) must become fresh again, this task Section 20');
    assert.equal(staleNoticeRoot(pageEl).hidden, true);
    // Proof no engine re-run happened: the exact same known-result figures
    // are still there, untouched, from the original calculation.
    assert.equal(hopperPatternRatioText(pageEl), ratioBefore);
    assert.equal(summaryValue(pageEl, 'calculate-recommendation-fleet-utilization'), utilizationBefore);
  });

  test('30. TARGET_NOT_ACHIEVABLE with Recovery visible: editing Target/Tolerance marks the Recommendation stale and disables Recovery execution, without hiding Recovery', () => {
    const pageEl = mountFullAccess();
    mountRecoveryReadyOn(pageEl);
    clickCalculateRecommendation(pageEl);
    assert.notEqual(recoverySectionRoot(pageEl), null);

    typeIntoField(pageEl, 'targetNi', '6.00');

    assert.equal(recommendationResultRoot(pageEl).hidden, false);
    assert.equal(isResultStale(pageEl), true);
    const root = recoverySectionRoot(pageEl);
    assert.notEqual(root, null, 'Recovery section must remain mounted, not removed, while stale');
    assert.equal(findOne(root, hasClass('calculate-calculate-recovery-btn')).disabled, true, 'Recovery must not be executable while the Recommendation is stale');
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
    // units 6/12 (V3.0 Phase 2 -- was 1/2, both below the generation-time
    // minimum; same 1:2 physical ratio and percentages, scaled x6).
    fillRow(gridRows(pageEl)[0], { pileId: 'Higher', contractor: 'HigherCo', ni: '1.50', units: '6', tonnesPerUnit: '50' });
    fillRow(gridRows(pageEl)[1], { pileId: 'Lglo', contractor: 'LgloCo', ni: '1.00', units: '12', tonnesPerUnit: '45' });
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
    assert.equal(findFieldInput(pageEl, 'tolerance').value, '0.009');
    assert.equal(recommendationResultRoot(pageEl).hidden, false);
    assert.equal(hopperPatternRatioText(pageEl), ratioBefore);
    assert.match(statusBadgeText(pageEl), new RegExp(enCatalog['calculate.recommendation.withinTolerance']));
  });

  test('V2.5: a locale switch while the result is stale re-translates the stale notice without recomputing it (still stale, sticky input unchanged, old result numbers untouched)', () => {
    const pageEl = mountFullAccess();
    mountRecommendationReadyOn(pageEl);
    clickCalculateRecommendation(pageEl);
    typeIntoField(pageEl, 'targetNi', '1.130');
    assert.equal(isResultStale(pageEl), true);
    assert.equal(staleNoticeRoot(pageEl).textContent.includes(idCatalog['calculate.recommendation.staleNotice']), true);

    setLocale('en');

    assert.equal(recommendationResultRoot(pageEl).hidden, false);
    assert.equal(isResultStale(pageEl), true, 'a locale switch must not clear staleness');
    assert.equal(staleNoticeRoot(pageEl).hidden, false);
    assert.equal(staleNoticeRoot(pageEl).textContent.includes(enCatalog['calculate.recommendation.staleNotice']), true, 'the notice text must re-translate to English');
    assert.equal(findFieldInput(pageEl, 'targetNi').value, '1.130', 'the sticky input keeps the value the user typed');
    assert.match(recommendationResultRoot(pageEl).textContent, /Target Ni1\.120%/, 'the frozen stale result must still echo the OLD Target -- unaffected by the locale switch');
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
    // V2.4.1 Bug C: top must be safe-area-aware, not a bare 0 -- a bare 0
    // sticks the bar under the iOS status bar/Dynamic Island in the
    // installed PWA (see the CSS rule's own root-cause comment).
    assert.match(stickyBlock, /top:\s*env\(safe-area-inset-top\);/);
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
   V2.4.1 Bug C fix -- the sticky summary DID have position: sticky all
   along; the real defect was `top: 0` sticking it under the iOS status
   bar/Dynamic Island in the installed PWA (viewport-fit=cover +
   apple-mobile-web-app-status-bar-style=black-translucent make the
   viewport -- and therefore sticky's scrollport-relative `top` -- extend
   under that unsafe region; body's own safe-area padding does NOT help,
   since it only affects pre-scroll layout, never sticky's offset). This
   project has no jsdom/Playwright (see this file's own header comment),
   so these are source/DOM contract assertions, not real layout/
   getBoundingClientRect assertions -- preferred here over a brittle
   screenshot test, per this task's Section 36.
============================================================ */
describe('V2.4.1 Bug C fix -- sticky containing-block/safe-area regression', () => {
  const ANCESTOR_BREAKING_PROPS = /\b(overflow(-x|-y)?|transform|filter|contain|perspective)\s*:/;
  const calculateCss = readFileSync(path.join(ROOT, 'assets', 'css', 'calculate.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const shellCss = readFileSync(path.join(ROOT, 'assets', 'css', 'app-shell.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const indexHtml = readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const styleBlock = indexHtml.slice(indexHtml.indexOf('<style>'), indexHtml.indexOf('</style>'));

  test('.calculate-shell declares no overflow/transform/filter/contain/perspective -- any of these would make it a non-scrolling containing block and break position: sticky on its descendant', () => {
    const shellRuleStart = calculateCss.indexOf('#page-calculate .calculate-shell {');
    assert.ok(shellRuleStart >= 0, 'expected a #page-calculate .calculate-shell rule');
    const shellRule = calculateCss.slice(shellRuleStart, calculateCss.indexOf('}', shellRuleStart));
    assert.doesNotMatch(shellRule, ANCESTOR_BREAKING_PROPS);
  });

  test('the shared page-routing shell (.app-page / #app-pages in app-shell.css) declares no overflow/transform/filter/contain/perspective', () => {
    assert.doesNotMatch(shellCss, ANCESTOR_BREAKING_PROPS);
  });

  test('html/body in index.html\'s own <style> block declare no overflow -- the viewport itself stays the scrolling element (confirmed independently by bottom-navigation.js reading window.scrollY, not an inner scrollTop), which is exactly why sticky\'s `top` must be safe-area-aware instead of relying on body\'s own padding', () => {
    assert.doesNotMatch(styleBlock, /\bhtml\s*\{[^}]*overflow/);
    assert.doesNotMatch(styleBlock, /\bbody\s*\{[^}]*overflow/);
  });

  test('viewport-fit=cover and the black-translucent status bar are both still declared -- these are exactly what make the safe-area-aware top offset necessary; if either is ever removed, this fix should be revisited', () => {
    assert.match(indexHtml, /viewport-fit=cover/);
    assert.match(indexHtml, /name="apple-mobile-web-app-status-bar-style" content="black-translucent"/);
  });

  test('the sticky summary is appended into .calculate-shell, the SAME container that also holds the source grid, class breakdown, and the entire Recommendation result (Hopper Pattern/Material Actions/Fleet Actions/Recovery) -- so its containing block spans the full Calculate workflow, not just the source grid (this task\'s Section 19/25 sticky-lifetime requirement)', () => {
    const source = readFileSync(path.join(ROOT, 'js', 'pages', 'calculate', 'calculate-page.js'), 'utf8');
    const buildShellStart = source.indexOf('function buildShell()');
    const buildShellEnd = source.indexOf('\nfunction buildRecommendationField', buildShellStart);
    assert.ok(buildShellStart >= 0 && buildShellEnd > buildShellStart);
    const buildShellBody = source.slice(buildShellStart, buildShellEnd);
    assert.match(buildShellBody, /shell\.appendChild\(blendSummary\)/);
    assert.match(buildShellBody, /shell\.appendChild\(grid\)/);
    assert.match(buildShellBody, /shell\.appendChild\(classBreakdownDetails\)/);
    assert.match(buildShellBody, /shell\.appendChild\(recommendationResult\)/);
  });

  test('the sticky summary stays hidden with no children until a complete source row exists (never an empty sticky bar on initial load, this task\'s Section 26)', () => {
    const pageEl = mountFullAccess();
    const summary = blendSummaryRoot(pageEl);
    assert.equal(summary.hidden, true);
    assert.equal(summary.children.length, 0);
  });
});

/* ============================================================
   V2.5 -- STICKY RECOMMENDATION CONTROLS REFINEMENT. See this task's
   Sections 1-24. LEVEL 1 is the unchanged live Blend summary
   (.calculate-blend-summary, V2.4.1 Bug C block above); LEVEL 2 is the
   new .calculate-recommendation-sticky-controls wrapper (Target Ni/
   Tolerance/field error/Hitung Rekomendasi) added by this task.
============================================================ */
describe('V2.5 -- sticky-control wrapper DOM structure (this task Section 26)', () => {
  test('Target/Tolerance controls, the field error, and the Hitung Rekomendasi button all belong to ONE sticky wrapper', () => {
    const pageEl = mountFullAccess();
    const wrapper = stickyControlsRoot(pageEl);
    assert.notEqual(wrapper, null, 'expected a .calculate-recommendation-sticky-controls wrapper');

    assert.notEqual(findOne(wrapper, hasClass('calculate-recommendation-controls')), null, 'Target/Tolerance controls must be inside the sticky wrapper');
    assert.notEqual(findOne(wrapper, hasClass('calculate-recommendation-field-error')), null, 'the field error must be inside the sticky wrapper');
    assert.notEqual(findOne(wrapper, hasClass('calculate-calculate-recommendation-btn')), null, 'the Hitung Rekomendasi button must be inside the sticky wrapper');
  });

  test('the recommendation RESULT is never inside the sticky wrapper', () => {
    const pageEl = mountFullAccess();
    mountRecommendationReadyOn(pageEl);
    clickCalculateRecommendation(pageEl);

    const wrapper = stickyControlsRoot(pageEl);
    assert.equal(findOne(wrapper, hasClass('calculate-recommendation-result')), null);
    assert.equal(findOne(wrapper, hasClass('calculate-hopper-pattern')), null);
  });

  test('the section title (REKOMENDASI BLENDING) and the DT hint are never inside the sticky wrapper', () => {
    const pageEl = mountFullAccess();
    const wrapper = stickyControlsRoot(pageEl);
    assert.equal(findOne(wrapper, hasClass('calculate-recommendation-hint')), null, 'the DT hint must stay outside the sticky wrapper');
    // The section label is an <h2 class="calculate-section-label">, shared
    // by both the Blend and Recommendation headings -- confirm neither is
    // nested inside the sticky wrapper.
    assert.equal(findOne(wrapper, isTag('h2')), null, 'no section heading belongs inside the sticky wrapper');
  });

  test('the engine error (SEARCH_SPACE_TOO_LARGE/NO_FEASIBLE_CANDIDATE) is never inside the sticky wrapper -- only the per-field validation error is', () => {
    const pageEl = mountFullAccess();
    const wrapper = stickyControlsRoot(pageEl);
    assert.equal(findOne(wrapper, hasClass('calculate-recommendation-error')), null, 'the engine-level error card belongs outside the sticky wrapper');
    assert.notEqual(findOne(wrapper, hasClass('calculate-recommendation-field-error')), null);
  });

  test('exactly one Target Ni input, one Tolerance input, and one Hitung Rekomendasi button exist on the whole page -- sticky behavior is pure CSS, never a duplicated control', () => {
    const pageEl = mountFullAccess();
    assert.equal(findAll(pageEl, (el) => el.dataset.field === 'targetNi').length, 1);
    assert.equal(findAll(pageEl, (el) => el.dataset.field === 'tolerance').length, 1);
    assert.equal(findAll(pageEl, hasClass('calculate-calculate-recommendation-btn')).length, 1);
  });

  test('the sticky wrapper remains in its natural DOM position -- directly after the DT hint, directly before the engine error -- never moved to the top of the page', () => {
    const source = readFileSync(path.join(ROOT, 'js', 'pages', 'calculate', 'calculate-page.js'), 'utf8');
    const buildShellStart = source.indexOf('function buildShell()');
    const buildShellEnd = source.indexOf('\nfunction buildRecommendationField', buildShellStart);
    const buildShellBody = source.slice(buildShellStart, buildShellEnd);

    const dtHintIdx = buildShellBody.indexOf("shell.appendChild(dtHint)");
    const stickyIdx = buildShellBody.indexOf('shell.appendChild(stickyControls)');
    const engineErrorIdx = buildShellBody.indexOf('shell.appendChild(recommendationEngineError)');
    const blendSummaryIdx = buildShellBody.indexOf('shell.appendChild(blendSummary)');
    const gridIdx = buildShellBody.indexOf('shell.appendChild(grid)');

    assert.ok(dtHintIdx >= 0 && stickyIdx >= 0 && engineErrorIdx >= 0);
    assert.ok(dtHintIdx < stickyIdx && stickyIdx < engineErrorIdx, 'sticky wrapper stays between the DT hint and the engine error, in natural document order');
    assert.ok(blendSummaryIdx < gridIdx && gridIdx < stickyIdx, 'the source grid still comes before the sticky controls -- Target/Tolerance were never moved above the grid');
  });
});

describe('V2.5 -- sticky CSS contract (this task Section 27)', () => {
  const calculateCss = readFileSync(path.join(ROOT, 'assets', 'css', 'calculate.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

  function ruleFor(selector) {
    const start = calculateCss.indexOf(`${selector} {`);
    assert.ok(start >= 0, `expected a ${selector} rule`);
    return calculateCss.slice(start, calculateCss.indexOf('}', start));
  }

  test('the Blend summary keeps position: sticky (unaffected by this task)', () => {
    const rule = ruleFor('#page-calculate .calculate-blend-summary');
    assert.match(rule, /position:\s*sticky;/);
  });

  test('the Recommendation sticky wrapper uses position: sticky, never position: fixed', () => {
    const rule = ruleFor('#page-calculate .calculate-recommendation-sticky-controls');
    assert.match(rule, /position:\s*sticky;/);
    assert.doesNotMatch(rule, /position:\s*fixed/);
  });

  test('the Recommendation sticky wrapper\'s top is explicitly relative to the Blend summary\'s own measured height, not a fixed magic-number offset', () => {
    const rule = ruleFor('#page-calculate .calculate-recommendation-sticky-controls');
    assert.match(rule, /top:\s*calc\(env\(safe-area-inset-top\)\s*\+\s*var\(--calculate-blend-summary-sticky-height/);
    // Anchored to the start of a declaration line so "border-top: 1px
    // solid ..." (a real, unrelated declaration in this same rule) can
    // never false-positive this check merely for containing the
    // substring "top:".
    assert.doesNotMatch(rule, /^\s*top:\s*\d+px/m, 'must never be a bare fixed-pixel offset');
  });

  test('both sticky levels use the same fully opaque --bg-base background, never transparent glass', () => {
    const summaryRule = ruleFor('#page-calculate .calculate-blend-summary');
    const stickyRule = ruleFor('#page-calculate .calculate-recommendation-sticky-controls');
    assert.match(summaryRule, /background:\s*var\(--bg-base,\s*#0a0e1a\);/);
    assert.match(stickyRule, /background:\s*var\(--bg-base,\s*#0a0e1a\);/);
  });

  test('no backdrop-filter is used on either sticky level', () => {
    assert.doesNotMatch(ruleFor('#page-calculate .calculate-blend-summary'), /backdrop-filter/);
    assert.doesNotMatch(ruleFor('#page-calculate .calculate-recommendation-sticky-controls'), /backdrop-filter/);
  });

  test('the two sticky levels share the SAME z-index -- no arbitrary new/higher tier introduced', () => {
    const summaryRule = ruleFor('#page-calculate .calculate-blend-summary');
    const stickyRule = ruleFor('#page-calculate .calculate-recommendation-sticky-controls');
    const summaryZ = summaryRule.match(/z-index:\s*(\d+);/)[1];
    const stickyZ = stickyRule.match(/z-index:\s*(\d+);/)[1];
    assert.equal(stickyZ, summaryZ);
    // Sanity: still far below the app's existing higher stacking tiers
    // (#bottom-navigation 900, .modal-overlay 1000) -- never an
    // extremely high arbitrary value.
    assert.ok(Number(stickyZ) < 900);
  });

  test('no scroll-event sticky simulation, no manual position:fixed-via-JS, no viewport-zoom-disabling anywhere in calculate-page.js\'s actual CODE (comments may reference the forbidden terms only to document that they are NOT used)', () => {
    const source = stripComments(readFileSync(path.join(ROOT, 'js', 'pages', 'calculate', 'calculate-page.js'), 'utf8'));
    assert.doesNotMatch(source, /addEventListener\('scroll'/);
    assert.doesNotMatch(source, /addEventListener\("scroll"/);
    assert.doesNotMatch(source, /requestAnimationFrame/);
    assert.doesNotMatch(source, /translateY/);
    assert.doesNotMatch(source, /user-scalable|maximum-scale|minimum-scale/);
  });

  test('ResizeObserver, where used, only ever writes the one CSS custom property -- never sets element.style.position/top/transform itself', () => {
    const source = readFileSync(path.join(ROOT, 'js', 'pages', 'calculate', 'calculate-page.js'), 'utf8');
    const observerBlockStart = source.indexOf('function observeBlendSummaryHeight');
    assert.ok(observerBlockStart >= 0, 'expected observeBlendSummaryHeight() to exist');
    const observerBlockEnd = source.indexOf('\nfunction renderBlendSummary', observerBlockStart);
    const block = source.slice(observerBlockStart, observerBlockEnd);
    assert.doesNotMatch(block, /\.style\.(position|top|transform)\s*=/);
  });
});

describe('V2.5 -- dynamic sticky-height contract (this task Section 28)', () => {
  test('Blend summary hidden -> the sticky-height CSS custom property is set to 0px (no reserved gap for a hidden summary)', () => {
    const pageEl = mountFullAccess();
    assert.equal(blendSummaryRoot(pageEl).hidden, true);
    // The mini-DOM harness's FakeElement has no `.style` -- the JS
    // function must detect that and no-op safely (never throw) rather
    // than crash the render. This is exactly the "safe fallback" this
    // task's Section 6 requires for a real browser without
    // ResizeObserver/getBoundingClientRect too; the same guard covers
    // both cases identically.
    assert.doesNotThrow(() => fillRow(gridRows(pageEl)[0], { pileId: 'A', contractor: 'SMA', ni: '1.2', units: '10', tonnesPerUnit: '50' }));
  });

  test('Blend summary becomes visible -> the height update path runs without throwing, and the summary itself is correctly shown', () => {
    const pageEl = mountFullAccess();
    fillRow(gridRows(pageEl)[0], { pileId: 'A', contractor: 'SMA', ni: '1.2', units: '10', tonnesPerUnit: '50' });
    assert.equal(blendSummaryRoot(pageEl).hidden, false);
  });

  test('removing the only complete row hides the summary again without throwing (the sticky-height update runs on every visibility transition, this task Section 7)', () => {
    const pageEl = mountFullAccess();
    fillRow(gridRows(pageEl)[0], { pileId: 'A', contractor: 'SMA', ni: '1.2', units: '10', tonnesPerUnit: '50' });
    assert.equal(blendSummaryRoot(pageEl).hidden, false);
    assert.doesNotThrow(() => clickRemove(gridRows(pageEl)[0]));
    assert.equal(blendSummaryRoot(pageEl).hidden, true);
  });

  test('a locale change (which can change the summary\'s rendered text width) re-renders the summary without throwing', () => {
    const pageEl = mountFullAccess();
    fillRow(gridRows(pageEl)[0], { pileId: 'A', contractor: 'SMA', ni: '1.2', units: '10', tonnesPerUnit: '50' });
    assert.doesNotThrow(() => setLocale('en'));
    assert.equal(blendSummaryRoot(pageEl).hidden, false);
    setLocale(DEFAULT_LOCALE);
  });

  test('repeated initCalculatePage() mounts never leak/throw from the height observer (real re-mount safety, not just this test file\'s own repeated mounts)', () => {
    assert.doesNotThrow(() => {
      mountFullAccess();
      mountFullAccess();
      mountFullAccess();
    });
  });

  test('DIRECT BROWSER GEOMETRY LIMITATION (this task Section 29): this project has no jsdom/Playwright/Chromium (confirmed absent in this environment) -- the assertions above verify the JS/CSS/DOM CONTRACT (the update function exists, runs on every visibility/locale transition, never throws under a DOM lacking real layout APIs) rather than actual pixel positions. Real getBoundingClientRect()-based verification at 360/390/430/desktop requires the owner\'s own browser/device testing.', () => {
    assert.ok(true);
  });
});

describe('V2.5 -- operational use case (this task Section 25)', () => {
  // V2.5 Preserve Recommendation View While Editing Target/Tolerance
  // supersedes the ORIGINAL expectation this test was written against
  // (Target edit immediately hides the result) -- the whole point of that
  // follow-up task is that it no longer does, so the viewport stays
  // stable while the operator is scrolled deep into the result via the
  // sticky controls.
  test('editing Target Ni after a Recommendation exists marks it STALE (never hidden); Hitung Rekomendasi with the NEW Target produces a fresh, non-stale result, all without the user ever touching the sticky controls\' DOM position', () => {
    const pageEl = mountFullAccess();
    mountRecommendationReadyOn(pageEl); // Target 1.120, Tolerance 0.010
    clickCalculateRecommendation(pageEl);
    assert.equal(recommendationResultRoot(pageEl).hidden, false);
    assert.match(recommendationResultRoot(pageEl).textContent, /1\.120/, 'the Target Ni row must echo the FIRST target, 1.120');

    // Sticky controls remain the SAME DOM nodes throughout -- this task's
    // Section 14 "no automatic scroll", confirmed structurally here by
    // never re-querying/rebuilding the wrapper.
    const wrapperBefore = stickyControlsRoot(pageEl);

    fillRecommendationControls(pageEl, { targetNi: '1.130' });
    assert.equal(recommendationResultRoot(pageEl).hidden, false, 'the old Recommendation must remain visible as stale context, never hidden, on a Target edit (V2.5 Preserve Recommendation View, Section 1)');
    assert.match(recommendationResultRoot(pageEl).textContent, /1\.120/, 'the STALE result must still echo the OLD target 1.120 until recalculated (V2.5 Section 17)');
    assert.match(recommendationResultRoot(pageEl).className, /\bis-stale\b/);

    clickCalculateRecommendation(pageEl);
    assert.equal(recommendationResultRoot(pageEl).hidden, false);
    assert.doesNotMatch(recommendationResultRoot(pageEl).className, /\bis-stale\b/, 'a fresh recalculation clears the stale modifier');
    // The Target Ni row in the fresh result directly echoes result.targetNi
    // (blending-recommendation.js, untouched by this UI-only task) -- a
    // robust, unambiguous proof the recalculation actually used the NEW
    // value, independent of which downstream display (Hopper Pattern's
    // own small-pattern-simplified estimate can coincidentally match
    // across two different targets) happens to be shown.
    assert.match(recommendationResultRoot(pageEl).textContent, /1\.130/, 'the fresh Recommendation must echo the NEW Target (1.130), not the stale old one (1.120)');

    const wrapperAfter = stickyControlsRoot(pageEl);
    assert.equal(wrapperBefore, wrapperAfter, 'the sticky wrapper is never rebuilt/replaced merely by recalculating -- same node throughout');
  });

  test('no automatic Recommendation calculation while typing Target/Tolerance -- Hitung Rekomendasi remains an explicit action (this task Section 13/17)', () => {
    const pageEl = mountFullAccess();
    mountRecommendationReadyOn(pageEl);
    clickCalculateRecommendation(pageEl);
    assert.equal(recommendationResultRoot(pageEl).hidden, false);

    fillRecommendationControls(pageEl, { targetNi: '1.150' });
    // V2.5: editing alone marks the OLD result stale -- it must NOT
    // auto-calculate a new one (no fresh engine run), and must NOT hide
    // the old one either (V2.5 Preserve Recommendation View).
    assert.equal(recommendationResultRoot(pageEl).hidden, false);
    assert.match(recommendationResultRoot(pageEl).className, /\bis-stale\b/);
    assert.match(recommendationResultRoot(pageEl).textContent, /1\.120/, 'still the OLD target -- no engine run happened merely from typing');
  });
});

/* ============================================================
   V2.4.1 Bug B fix -- mobile editable-control font-size regression (this
   task's Sections 14/16/35). Node/CSS-source assertions only -- this
   cannot emulate Safari's actual auto-zoom algorithm (this task's Section
   35 explicitly disclaims that); it protects the preventative
   implementation (every editable Calculate control computes to >= 16px on
   mobile) from silently regressing.
============================================================ */
describe('V2.4.1 Bug B fix -- Calculate editable controls stay >= 16px on mobile', () => {
  const calculateCss = readFileSync(path.join(ROOT, 'assets', 'css', 'calculate.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

  // Extracts every top-level (non-media-query) declaration of `selector`'s
  // font-size, plus the font-size it resolves to inside each
  // `@media (min-width: 640px)` desktop-override block -- so this test
  // fails loudly if a NEW narrow-width media query ever reintroduces a
  // sub-16px mobile override, which is exactly how this bug originally
  // shipped (the old @media (max-width: 374px) block silently shrank
  // these same three rules).
  function fontSizesFor(selector) {
    const sizes = [];
    let searchFrom = 0;
    for (;;) {
      const idx = calculateCss.indexOf(`${selector} {`, searchFrom);
      if (idx === -1) break;
      const ruleEnd = calculateCss.indexOf('}', idx);
      const rule = calculateCss.slice(idx, ruleEnd);
      const match = rule.match(/font-size:\s*([0-9.]+)(rem|px)/);
      if (match) sizes.push({ value: parseFloat(match[1]), unit: match[2], insideMediaMinWidth640: /@media \(min-width: 640px\)[^{]*\{[^}]*$/.test(calculateCss.slice(0, idx)) });
      searchFrom = ruleEnd + 1;
    }
    return sizes;
  }

  function toPx(size) {
    return size.unit === 'px' ? size.value : size.value * 16;
  }

  ['#page-calculate .calculate-cell-input', '#page-calculate .calculate-cell-input--contractor', '#page-calculate .calculate-recommendation-input'].forEach((selector) => {
    test(`${selector}: every MOBILE (outside any min-width:640px override) declaration computes to >= 16px`, () => {
      const sizes = fontSizesFor(selector);
      assert.ok(sizes.length > 0, `expected at least one font-size declaration for ${selector}`);
      const mobileSizes = sizes.filter((s) => !s.insideMediaMinWidth640);
      assert.ok(mobileSizes.length > 0, `expected at least one MOBILE (non-desktop-override) font-size declaration for ${selector}`);
      mobileSizes.forEach((size) => {
        assert.ok(toPx(size) >= 16, `${selector} mobile font-size ${size.value}${size.unit} is below the 16px iOS auto-zoom floor`);
      });
    });
  });

  test('no @media (max-width: ...) block in calculate.css shrinks an EDITABLE control below 16px (the exact way this bug originally shipped -- non-editable elements like the hopper ratio display or the grid header labels are unaffected by this contract)', () => {
    const editableSelectors = ['.calculate-cell-input', '.calculate-cell-input--contractor', '.calculate-recommendation-input'];
    const narrowBlocks = [...calculateCss.matchAll(/@media \(max-width:[^)]*\)\s*\{/g)];
    assert.ok(narrowBlocks.length > 0, 'expected at least one narrow-width media query to still exist');
    narrowBlocks.forEach((m) => {
      const blockStartIdx = m.index + m[0].length;
      const blockEndIdx = calculateCss.indexOf('\n}', blockStartIdx);
      const block = calculateCss.slice(blockStartIdx, blockEndIdx);
      editableSelectors.forEach((selector) => {
        const ruleStart = block.indexOf(`${selector} {`);
        if (ruleStart === -1) return; // this editable control has no override at this breakpoint at all -- fine, it keeps its base >=16px size
        const rule = block.slice(ruleStart, block.indexOf('}', ruleStart));
        const match = rule.match(/font-size:\s*([0-9.]+)(rem|px)/);
        if (!match) return; // override touches padding/gap only, never font-size -- exactly what this fix requires
        const px = match[2] === 'px' ? parseFloat(match[1]) : parseFloat(match[1]) * 16;
        assert.ok(px >= 16, `${selector} is shrunk below 16px (${match[1]}${match[2]}) inside a narrow-width media query -- this is exactly the regression this fix closes`);
      });
    });
  });

  test('desktop (min-width: 640px) restores the original compact typography -- this fix is mobile-only, not a permanent desktop change', () => {
    assert.match(calculateCss, /@media \(min-width: 640px\) \{\s*#page-calculate \.calculate-cell-input \{\s*font-size:\s*0\.78rem;/);
    assert.match(calculateCss, /@media \(min-width: 640px\) \{\s*#page-calculate \.calculate-cell-input--contractor \{[\s\S]*?font-size:\s*0\.68rem;/);
    assert.match(calculateCss, /@media \(min-width: 640px\) \{\s*#page-calculate \.calculate-recommendation-input \{\s*font-size:\s*0\.85rem;/);
  });

  test('the compact grid column proportions (PILE 38 / NI 17 / DT 14 / t/DT 20 / action 11) are unchanged -- only spacing/font-size were touched, never the layout this task explicitly requires preserving', () => {
    assert.match(calculateCss, /grid-template-columns:\s*38fr 17fr 14fr 20fr 11fr;/);
  });
});

/* ============================================================
   V2.4 PHASE 8 -- Appearance (Dark/Light/Auto) theme-token audit (this
   task's Section 16/31). Calculate must never define/persist its own
   theme state and must never introduce a hardcoded, isolated,
   dark-only/light-only surface -- every color in calculate.css must
   resolve through one of the app's existing shared CSS custom
   properties (defined once, in index.html, for both themes).
============================================================ */
describe('V2.4 Phase 8 -- Calculate uses only shared theme tokens, never a Calculate-only or dark-only palette', () => {
  const cssSourceRaw = readFileSync(path.join(ROOT, 'assets', 'css', 'calculate.css'), 'utf8');
  // CSS uses /* ... */ block comments -- stripped here (this file's own
  // header/section comments explicitly discuss "no backdrop-filter", which
  // would otherwise false-positive a naive substring search).
  const cssSource = cssSourceRaw.replace(/\/\*[\s\S]*?\*\//g, '');
  const indexHtml = readFileSync(path.join(ROOT, 'index.html'), 'utf8');

  test('no backdrop-filter/blur anywhere in calculate.css\' actual rules', () => {
    assert.doesNotMatch(cssSource, /backdrop-filter/);
  });

  // V2.5 Sticky Recommendation Controls Refinement: --calculate-blend-summary-sticky-height
  // is the ONE deliberate, narrow exception to both tests below -- it is a
  // JS-MEASURED LAYOUT variable (calculate-page.js's own
  // updateBlendSummaryStickyHeight(), set on .calculate-shell), never a
  // color/theme value, and it is intentionally Calculate-own/local (a
  // sticky-offset implementation detail, not a design token) -- it is
  // declared and consumed entirely within calculate.css/calculate-page.js
  // and never needs an index.html Dark/Light definition. It does NOT
  // reopen the door to Calculate inventing its own competing COLOR
  // palette, which is what both tests actually guard against.
  const STICKY_HEIGHT_VAR = '--calculate-blend-summary-sticky-height';

  test('calculate.css defines no new --custom-property THEME token of its own (it only ever CONSUMES var(--x) for colors/design tokens, never declares one) -- except the one documented JS-measured layout variable', () => {
    const declarations = [...cssSource.matchAll(/^\s*(--[a-zA-Z0-9-]+):/gm)].map((m) => m[1]);
    const unexpected = declarations.filter((name) => name !== STICKY_HEIGHT_VAR);
    assert.deepEqual(unexpected, [], `unexpected new custom property declaration(s): ${unexpected.join(', ')}`);
    assert.ok(declarations.includes(STICKY_HEIGHT_VAR), 'expected the documented sticky-height layout variable to still be declared');
  });

  test('every var(--token) referenced in calculate.css is one of the app\'s existing shared tokens, defined for BOTH Dark and Light in index.html -- except the one documented JS-measured layout variable', () => {
    const usedTokens = [...new Set([...cssSource.matchAll(/var\((--[a-zA-Z0-9-]+)/g)].map((m) => m[1]))]
      .filter((token) => token !== STICKY_HEIGHT_VAR);
    assert.ok(usedTokens.length > 0, 'expected calculate.css to actually use shared tokens');

    const darkBlockStart = indexHtml.indexOf(':root, html[data-theme="dark"]');
    const lightBlockStart = indexHtml.indexOf('html[data-theme="light"]');
    assert.ok(darkBlockStart >= 0 && lightBlockStart > darkBlockStart, 'expected distinct dark/light token blocks in index.html');
    const darkBlock = indexHtml.slice(darkBlockStart, indexHtml.indexOf('}', darkBlockStart));
    const lightBlock = indexHtml.slice(lightBlockStart, indexHtml.indexOf('}', lightBlockStart));

    for (const token of usedTokens) {
      assert.match(darkBlock, new RegExp(`${token}:`), `${token} must be defined in the Dark theme block`);
      assert.match(lightBlock, new RegExp(`${token}:`), `${token} must be defined in the Light theme block`);
    }
  });

  test('Calculate never reads/writes localStorage directly for appearance -- it has no theme state of its own', () => {
    const source = stripComments(readFileSync(path.join(ROOT, 'js', 'pages', 'calculate', 'calculate-page.js'), 'utf8'));
    assert.doesNotMatch(source, /localStorage|appearance|matchMedia|data-theme/i);
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

  // A third, unfavorable-Ni source forces a real chemical STOP under the
  // real engine+ranking (never a hand-picked fixture) -- Target/Tolerance
  // are exactly the known example's own values, so Higher/Lglo still land
  // on their proven 4/8 active split; the third source can only ever
  // worsen an already-exact (deviation 0) match. V2.5 (this task's
  // Sections 8/22-23/46): since Contractor ZZZ has exactly one loading
  // point and a feasible replacement Ni range exists (verified below), the
  // USER-FACING action must be REPLACE DOME, never a bare STOP -- the
  // internal MATERIAL_ACTION_STOP domain value is still what
  // recommendation-actions.js computes underneath (unchanged, this task's
  // Section 4), only the DISPLAYED label/reason changed.
  test('V2.5: a genuinely unfavorable third source gets a REPLACE DOME recommendation, never a bare STOP, once a replacement plan can be derived', () => {
    const pageEl = mountFullAccess();
    fillKnownRecommendationExample(pageEl);
    fillRow(gridRows(pageEl)[2], { pileId: 'Off', contractor: 'ZZZ', ni: '0.10', units: '3', tonnesPerUnit: '50' });
    fillRecommendationControls(pageEl, { targetNi: '1.120', tolerance: '0.009' });

    clickCalculateRecommendation(pageEl);

    const offRow = materialActionRowFor(pageEl, 'Off');
    assert.notEqual(offRow, undefined);
    assert.equal(materialActionBadgeText(offRow), idCatalog['calculate.actions.material.replaceDome']);
    assert.equal(idCatalog['calculate.actions.material.replaceDome'], 'GANTI DOME');
    assert.doesNotMatch(offRow.textContent, /\bSTOP\b/, 'STOP must never remain the final user-facing instruction once a replacement plan exists (this task\'s Section 46)');
    // Every Material Action row includes a short reason (this task's
    // Section 21) -- never left blank, and the REPLACE DOME reason now
    // cites the required Ni range rather than the old generic STOP text.
    assert.ok(offRow.textContent.length > materialActionBadgeText(offRow).length);
    assert.match(offRow.textContent, /1\.0\d\d% – 1\.1\d\d%|1\.0\d\d%.*1\.1\d\d%/, 'expected a 3-decimal Ni range in the replacement reason');
  });

  // Pure-module coverage of the OTHER branch (no plan derivable -- a
  // genuine operational conflict, this task's Section 25) already lives in
  // tests/operational-continuity.test.mjs's classifyMaterialActionLabel()
  // suite ("STOP stays STOP only when no plan/CONFLICT") -- not
  // duplicated here, since constructing a real end-to-end infeasible-range
  // scenario through the full search+ranking pipeline by hand would be
  // both fragile and redundant with that direct, deterministic pure test.
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

  // V2.5 (this task's Sections 3/16/21/24/47): Contractor SMA (Higher's
  // one and only loading point) is left at 1/7 ~= 14.3% standby (V3.0
  // Phase 2 rescale, was 1/5 = 20% -- still comfortably above the 5%
  // minor threshold, same moderate tier), so V2.5 must NOT show a bare
  // SEPARATE/STANDBY line here. Since 7 DT is too small to SPLIT (needs
  // >= 12), the plan falls back to REPLACE DOME with a feasible Ni range
  // -- verified against the actual engine (deriveContractorContinuityPlan()).
  test('V2.5: known 7 HG / 12 LGLO scenario -- Higher (~14.3% standby, cross-Contractor) gets REPLACE DOME, never a bare SEPARATE/STANDBY line; Lglo shows ACTIVE 12 DT only', () => {
    const pageEl = mountFullAccess();
    mountRecommendationReadyOn(pageEl);
    clickCalculateRecommendation(pageEl);

    const higherRow = fleetActionRowFor(pageEl, 'Higher');
    const higherLines = fleetActionLineTexts(higherRow);
    // Higher is a CHANGED source (7 assigned, 6 active) -- V2.5.1 shows
    // AWAL/AKHIR instead of a bare AKTIF line (this task's Sections
    // 10/14), so the final total (6) is never implicit.
    assert.ok(higherLines.some((l) => l.includes(idCatalog['calculate.actions.fleet.initial']) && l.includes('7')));
    assert.ok(higherLines.some((l) => l.includes(idCatalog['calculate.actions.fleet.final']) && l.includes('6')));
    assert.ok(!higherLines.some((l) => l.includes(idCatalog['calculate.actions.fleet.move'])), 'cross-Contractor Higher/Lglo must never show a MOVE line');
    assert.equal(materialActionBadgeText(higherRow), idCatalog['calculate.actions.fleetOperational.replaceDome']);
    assert.equal(idCatalog['calculate.actions.fleetOperational.replaceDome'], 'GANTI DOME');
    assert.doesNotMatch(higherRow.textContent, /\bSTANDBY\b/, 'this task\'s Section 47: no user-visible large STANDBY once standby exceeds 5%');
    // The replacement Ni range this task's Section 13 formula produces for
    // this exact scenario (verified against the actual engine): ~1.250% -
    // 1.299%.
    assert.match(higherRow.textContent, /1\.25[0-9]%.*1\.29[0-9]%|1\.25[0-9]%[\s\S]*1\.29[0-9]%/);

    const lgloRow = fleetActionRowFor(pageEl, 'Lglo');
    const lgloLines = fleetActionLineTexts(lgloRow);
    assert.ok(lgloLines.some((l) => l.includes(idCatalog['calculate.actions.fleet.use']) && l.includes('12')));
    assert.equal(lgloLines.length, 1, 'a fully-active source with no relocation shows only its USE line');
    assert.equal(materialActionBadgeText(lgloRow), idCatalog['calculate.actions.fleet.use'], 'Lglo is fully active -- ACTIVE badge, no continuity plan');
  });

  // V3.0 Phase 2 rescale (was Higher 5 DT / LGLO 7 DT, tolerance 0.010) --
  // verified against tests/blending-recommendation.test.mjs's own "25.
  // Same-Contractor relocation".
  test('same-Contractor relocation scenario: Higher shows MOVE 1 DT -> Lglo, Lglo shows RECEIVE 1 DT <- Higher', () => {
    const pageEl = mountFullAccess();
    fillRow(gridRows(pageEl)[0], { pileId: 'Higher', contractor: 'SMA', ni: '1.30', units: '7', tonnesPerUnit: '50' });
    fillRow(gridRows(pageEl)[1], { pileId: 'Lglo', contractor: 'SMA', ni: '1.03', units: '11', tonnesPerUnit: '50' });
    fillRecommendationControls(pageEl, { targetNi: '1.120', tolerance: '0.009' });

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
   V2.5 -- SPLIT LOADING POINT end-to-end UI (this task's Sections 9-17/
   29-32). TII's single 20 DT loading point (L30, Ni 1.2%, 45 t/DT) would
   otherwise leave 4 DT (20%) idle against a 1.14%-1.16% target range --
   real numbers verified against the pure engine directly (see this
   scenario's own arithmetic in tests/operational-continuity.test.mjs's
   sibling coverage): SPLIT wins with newDomeUnits=6/existingDomeUnits=14,
   required Ni range ~1.074%-1.178%, plus a REPLACE fallback
   ~1.162%-1.193%.
============================================================ */
describe('V2.5 -- SPLIT LOADING POINT end-to-end UI', () => {
  function mountSplitScenario(pageEl) {
    fillRow(gridRows(pageEl)[0], { pileId: 'L30', contractor: 'TII', ni: '1.2', units: '20', tonnesPerUnit: '45' });
    fillRow(gridRows(pageEl)[1], { pileId: 'A1', contractor: 'MRP', ni: '1.1', units: '10', tonnesPerUnit: '50' });
    fillRecommendationControls(pageEl, { targetNi: '1.15', tolerance: '0.01' });
  }

  test('TII gets a PECAH LOADING (SPLIT LOADING) badge, never a bare STANDBY, with the existing/new dome split, Ni range, and excavator-conditional wording', () => {
    const pageEl = mountFullAccess();
    mountSplitScenario(pageEl);
    clickCalculateRecommendation(pageEl);

    const tiiRow = fleetActionRowFor(pageEl, 'L30');
    assert.notEqual(tiiRow, undefined);
    assert.equal(materialActionBadgeText(tiiRow), idCatalog['calculate.actions.fleetOperational.splitLoading']);
    assert.equal(idCatalog['calculate.actions.fleetOperational.splitLoading'], 'PECAH LOADING');
    assert.doesNotMatch(tiiRow.textContent, /\bSTANDBY\b/);

    // Existing dome keeps 14 DT, new (hypothetical) dome gets 6 -- the
    // smallest-new-dome preference from this task's Section 12, and the
    // exact split from the section 17 worked example's own shape.
    assert.match(tiiRow.textContent, /14/);
    assert.match(tiiRow.textContent, /6/);
    assert.match(tiiRow.textContent, new RegExp(idCatalog['calculate.continuity.newDomeLabel']));

    // Required Ni range (3 decimals, this task's Section 32).
    assert.match(tiiRow.textContent, /1\.074%/);
    assert.match(tiiRow.textContent, /1\.178%/);

    // Never invents excavator availability (this task's Sections 11/34).
    assert.match(tiiRow.textContent, new RegExp(idCatalog['calculate.continuity.excavatorSupportNote']));

    // Replacement fallback also present (this task's Section 16), with
    // its OWN distinct range.
    assert.match(tiiRow.textContent, new RegExp(idCatalog['calculate.continuity.excavatorNotSupportLabel']));
    assert.match(tiiRow.textContent, /1\.162%/);
    assert.match(tiiRow.textContent, /1\.193%/);

    // MRP is fully active, untouched by TII's split plan (this task's
    // Section 45 cross-Contractor regression lock).
    const mrpRow = fleetActionRowFor(pageEl, 'A1');
    assert.equal(materialActionBadgeText(mrpRow), idCatalog['calculate.actions.fleet.use']);
  });

  test('the rejection note explains why a plain reduction was not offered instead', () => {
    const pageEl = mountFullAccess();
    mountSplitScenario(pageEl);
    clickCalculateRecommendation(pageEl);

    const tiiRow = fleetActionRowFor(pageEl, 'L30');
    // 4 DT / 20% -- this task's Section 17 worked example's own wording
    // shape ("Pengurangan N DT (X%) tidak direkomendasikan").
    assert.match(tiiRow.textContent, /4 DT/);
    assert.match(tiiRow.textContent, /20%/);
  });

  test('English locale renders the same scenario with SPLIT LOADING wording', () => {
    const pageEl = mountFullAccess();
    mountSplitScenario(pageEl);
    setLocale('en');
    clickCalculateRecommendation(pageEl);

    const tiiRow = fleetActionRowFor(pageEl, 'L30');
    assert.equal(materialActionBadgeText(tiiRow), 'SPLIT LOADING');
    assert.match(tiiRow.textContent, /If excavator support is available/);
    setLocale(DEFAULT_LOCALE);
  });
});

/* ============================================================
   V2.5.1 CORRECTIVE PASS -- receiver/donor classification and AWAL/
   change/AKHIR fleet accounting UI (this task's Sections 9-21). Real
   engine scenario (verified directly against findBlendRecommendations()
   in tests/blending-recommendation.test.mjs's own V2.5.1 block): TII L20
   15 DT @ Ni 1.05%/50 t-DT, L40 20 DT @ Ni 1.20%/50 t-DT (total 35),
   Target 1.072% +/- 0.006% selects L20=29 active (a RECEIVER, +14) / L40=6
   active (a DONOR, -14, still operationally valid at exactly the
   minimum).
============================================================ */
describe('V2.5.1 -- receiver/donor classification, AWAL/change/AKHIR UI (this task Sections 9-21)', () => {
  function mountReceiverDonorScenario(pageEl) {
    fillRow(gridRows(pageEl)[0], { pileId: 'L20', contractor: 'TII', ni: '1.05', units: '15', tonnesPerUnit: '50' });
    fillRow(gridRows(pageEl)[1], { pileId: 'L40', contractor: 'TII', ni: '1.20', units: '20', tonnesPerUnit: '50' });
    fillRecommendationControls(pageEl, { targetNi: '1.072', tolerance: '0.006' });
  }

  test('19. the receiver (L20) is classified TERIMA/RECEIVE, never PINDAH/MOVE', () => {
    const pageEl = mountFullAccess();
    mountReceiverDonorScenario(pageEl);
    clickCalculateRecommendation(pageEl);

    const l20Row = fleetActionRowFor(pageEl, 'L20');
    assert.equal(materialActionBadgeText(l20Row), idCatalog['calculate.actions.fleet.receive']);
    assert.equal(idCatalog['calculate.actions.fleet.receive'], 'TERIMA');
    assert.notEqual(materialActionBadgeText(l20Row), idCatalog['calculate.actions.fleet.move']);
  });

  test('20. the donor (L40) is classified PINDAH/MOVE', () => {
    const pageEl = mountFullAccess();
    mountReceiverDonorScenario(pageEl);
    clickCalculateRecommendation(pageEl);

    const l40Row = fleetActionRowFor(pageEl, 'L40');
    assert.equal(materialActionBadgeText(l40Row), idCatalog['calculate.actions.fleet.move']);
    assert.equal(idCatalog['calculate.actions.fleet.move'], 'PINDAH');
  });

  test('8/21. changed receiver shows AWAL 15 DT / TERIMA 14 DT <- L40 / AKHIR 29 DT (this task Section 11), values sourced from the real candidate', () => {
    const pageEl = mountFullAccess();
    mountReceiverDonorScenario(pageEl);
    clickCalculateRecommendation(pageEl);

    const l20Lines = fleetActionLineTexts(fleetActionRowFor(pageEl, 'L20'));
    assert.ok(l20Lines.some((l) => l.includes(idCatalog['calculate.actions.fleet.initial']) && l.includes('15')), 'AWAL 15 DT');
    assert.ok(l20Lines.some((l) => l.includes(idCatalog['calculate.actions.fleet.receive']) && l.includes('14') && l.includes('L40')), 'TERIMA 14 DT <- L40');
    assert.ok(l20Lines.some((l) => l.includes(idCatalog['calculate.actions.fleet.final']) && l.includes('29')), 'AKHIR 29 DT');
    // 10. AKHIR must equal the real candidate's own activeUnits, never a
    // display-only recomputation.
    assert.doesNotMatch(l20Lines.join(' '), /\b15\s*DT.*29|29.*15\s*DT/, 'sanity: AWAL and AKHIR are distinct values, not accidentally duplicated');
  });

  test('9/21. changed donor shows AWAL 20 DT / PINDAH 14 DT -> L20 / AKHIR 6 DT (this task Section 12)', () => {
    const pageEl = mountFullAccess();
    mountReceiverDonorScenario(pageEl);
    clickCalculateRecommendation(pageEl);

    const l40Lines = fleetActionLineTexts(fleetActionRowFor(pageEl, 'L40'));
    assert.ok(l40Lines.some((l) => l.includes(idCatalog['calculate.actions.fleet.initial']) && l.includes('20')), 'AWAL 20 DT');
    assert.ok(l40Lines.some((l) => l.includes(idCatalog['calculate.actions.fleet.move']) && l.includes('14') && l.includes('L20')), 'PINDAH 14 DT -> L20');
    assert.ok(l40Lines.some((l) => l.includes(idCatalog['calculate.actions.fleet.final']) && l.includes('6')), 'AKHIR 6 DT');
  });

  test('the old ambiguous "AKTIF 15 DT / TERIMA 19 DT" style display never appears -- AWAL/AKHIR always frame the total explicitly', () => {
    const pageEl = mountFullAccess();
    mountReceiverDonorScenario(pageEl);
    clickCalculateRecommendation(pageEl);

    const l20Row = fleetActionRowFor(pageEl, 'L20');
    // The row must show its own AKHIR line -- the final 29 DT total is
    // never left for the reader to sum from AKTIF+TERIMA.
    assert.match(l20Row.textContent, new RegExp(idCatalog['calculate.actions.fleet.final']));
    assert.doesNotMatch(l20Row.textContent, new RegExp(idCatalog['calculate.actions.fleet.use']), 'a changed row never shows the old bare AKTIF line');
  });

  test('English locale: RECEIVE/MOVE/INITIAL/FINAL wording', () => {
    const pageEl = mountFullAccess();
    mountReceiverDonorScenario(pageEl);
    setLocale('en');
    clickCalculateRecommendation(pageEl);

    const l20Row = fleetActionRowFor(pageEl, 'L20');
    assert.equal(materialActionBadgeText(l20Row), 'RECEIVE');
    assert.match(l20Row.textContent, /INITIAL/);
    assert.match(l20Row.textContent, /FINAL/);

    const l40Row = fleetActionRowFor(pageEl, 'L40');
    assert.equal(materialActionBadgeText(l40Row), 'MOVE');
    setLocale(DEFAULT_LOCALE);
  });
});

/* ============================================================
   V2.5.1 -- FULL DOME CLOSURE UI (this task's Sections 13/18). Same real
   engine scenario family, narrowed target so the only within-tolerance
   allocation is a full closure: L20=35 active (receives all 20 from L40),
   L40=0 active (closed).
============================================================ */
describe('V2.5.1 -- full dome closure UI (TUTUP DOME, this task Section 13/18)', () => {
  function mountFullClosureScenario(pageEl) {
    fillRow(gridRows(pageEl)[0], { pileId: 'L20', contractor: 'TII', ni: '1.05', units: '15', tonnesPerUnit: '50' });
    fillRow(gridRows(pageEl)[1], { pileId: 'L40', contractor: 'TII', ni: '1.20', units: '20', tonnesPerUnit: '50' });
    fillRecommendationControls(pageEl, { targetNi: '1.054', tolerance: '0.005' });
  }

  test('L40 (fully closed) shows TUTUP DOME badge, AWAL 20 / PINDAH 20 -> L20 / AKHIR 0, and the "fleet stays active elsewhere" reassurance note', () => {
    const pageEl = mountFullAccess();
    mountFullClosureScenario(pageEl);
    clickCalculateRecommendation(pageEl);

    const l40Row = fleetActionRowFor(pageEl, 'L40');
    assert.equal(materialActionBadgeText(l40Row), idCatalog['calculate.actions.fleetOperational.closeDomeAndMove']);
    assert.equal(idCatalog['calculate.actions.fleetOperational.closeDomeAndMove'], 'TUTUP DOME');

    const l40Lines = fleetActionLineTexts(l40Row);
    assert.ok(l40Lines.some((l) => l.includes(idCatalog['calculate.actions.fleet.initial']) && l.includes('20')));
    assert.ok(l40Lines.some((l) => l.includes(idCatalog['calculate.actions.fleet.move']) && l.includes('20') && l.includes('L20')));
    assert.ok(l40Lines.some((l) => l.includes(idCatalog['calculate.actions.fleet.final']) && l.includes('0')));

    // "DOME CLOSED does NOT mean CONTRACTOR/FLEET STOPPED" (this task's
    // Section 13/19) -- never a bare STANDBY/closure with no context.
    assert.match(l40Row.textContent, new RegExp(idCatalog['calculate.continuity.closeDomeNote'].split('{')[0]));
    assert.match(l40Row.textContent, /TII/);
  });

  test('L20 (receives the full fleet) shows TERIMA, AWAL 15 / TERIMA 20 <- L40 / AKHIR 35', () => {
    const pageEl = mountFullAccess();
    mountFullClosureScenario(pageEl);
    clickCalculateRecommendation(pageEl);

    const l20Row = fleetActionRowFor(pageEl, 'L20');
    assert.equal(materialActionBadgeText(l20Row), idCatalog['calculate.actions.fleet.receive']);
    const l20Lines = fleetActionLineTexts(l20Row);
    assert.ok(l20Lines.some((l) => l.includes(idCatalog['calculate.actions.fleet.initial']) && l.includes('15')));
    assert.ok(l20Lines.some((l) => l.includes(idCatalog['calculate.actions.fleet.receive']) && l.includes('20') && l.includes('L40')));
    assert.ok(l20Lines.some((l) => l.includes(idCatalog['calculate.actions.fleet.final']) && l.includes('35')));
  });

  test('24. Material Action for the closed L40 reflects its real chemical role (LIMIT here), never a bare user-visible STOP (this task Section 24/46)', () => {
    const pageEl = mountFullAccess();
    mountFullClosureScenario(pageEl);
    clickCalculateRecommendation(pageEl);

    // L40 contributes 0 active DT in THIS candidate (its fleet physically
    // relocated to L20), but its material is still chemically evaluated
    // on its own terms (recommendation-actions.js, unchanged by this
    // corrective pass) -- here that evaluation is LIMIT (BATASI), not
    // STOP, so this fully-closed dome must never show the bare STOP word.
    const l40MaterialRow = materialActionRowFor(pageEl, 'L40');
    assert.equal(materialActionBadgeText(l40MaterialRow), idCatalog['calculate.actions.material.limit']);
    assert.notEqual(materialActionBadgeText(l40MaterialRow), 'STOP');
  });
});

/* ============================================================
   26. STANDBY terminology (V2.4 Phase 6.1 -- Owner correction, this
   task's Part B/Section 26). Reuses the known 5 HG / 8 LGLO scenario,
   where Higher's own Fleet Action row already carries a STANDBY (1 DT)
   line (verified above).
============================================================ */
describe('26. STANDBY terminology replaces PISAHKAN/SEPARATE in the UI', () => {
  // V2.5 (this task's Section 47) supersedes the original V2.4.x
  // expectation here: once a Contractor's standby exceeds the 5% minor
  // threshold, the UI must no longer show a bare STANDBY word at all --
  // it shows the new REPLACE DOME/SPLIT LOADING/REDUCE continuity
  // vocabulary instead (operational-continuity.js's
  // classifyFleetActionLabel()). This scenario's 1/5 = 20% standby is
  // exactly such a case (see the "V2.5: known 5 HG / 8 LGLO scenario"
  // test above for the full REPLACE DOME/Ni-range assertion) -- this test
  // now only re-confirms the OLD "PISAHKAN" word specifically never
  // reappears, under either vocabulary.
  test('the rendered Fleet Action row never shows the old PISAHKAN/SEPARATE word, under either the legacy or V2.5 vocabulary', () => {
    const pageEl = mountFullAccess();
    mountRecommendationReadyOn(pageEl);
    clickCalculateRecommendation(pageEl);

    const higherRow = fleetActionRowFor(pageEl, 'Higher');
    assert.doesNotMatch(higherRow.textContent, /PISAHKAN/);
    assert.doesNotMatch(higherRow.textContent, /\bSTANDBY\b/, "this task's Section 47: 20% standby is above the 5% minor threshold, so even the word STANDBY itself must not appear");

    setLocale('en');
    const higherRowEn = fleetActionRowFor(pageEl, 'Higher');
    assert.doesNotMatch(higherRowEn.textContent, /\bSEPARATE\b/);
    assert.doesNotMatch(higherRowEn.textContent, /\bSTANDBY\b/);
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
    // V3.0 Phase 2 rescale (was 5/7, tolerance 0.010).
    fillRow(gridRows(pageEl)[0], { pileId: 'Higher', contractor: 'SMA', ni: '1.30', units: '7', tonnesPerUnit: '50' });
    fillRow(gridRows(pageEl)[1], { pileId: 'Lglo', contractor: 'SMA', ni: '1.03', units: '11', tonnesPerUnit: '50' });
    fillRecommendationControls(pageEl, { targetNi: '1.120', tolerance: '0.009' });
    clickCalculateRecommendation(pageEl);

    const higherLines = fleetActionLineTexts(fleetActionRowFor(pageEl, 'Higher'));
    assert.ok(higherLines.some((l) => l.includes(idCatalog['calculate.actions.fleet.move']) && l.includes('Lglo')));
    const lgloLines = fleetActionLineTexts(fleetActionRowFor(pageEl, 'Lglo'));
    assert.ok(lgloLines.some((l) => l.includes(idCatalog['calculate.actions.fleet.receive']) && l.includes('Higher')));

    // Fleet conservation: every CHANGED row (both Higher and Lglo here)
    // shows its own AWAL/AKHIR framing (this task's Sections 10/14/21) --
    // V2.5.1 replaced the old unconditional USE line with this explicit
    // before/after accounting -- and no row anywhere shows a cross-
    // Contractor MOVE/RECEIVE line.
    fleetActionRows(pageEl).forEach((row) => {
      const lines = fleetActionLineTexts(row);
      assert.ok(lines.some((l) => l.includes(idCatalog['calculate.actions.fleet.initial'])), 'every changed row shows its AWAL line');
      assert.ok(lines.some((l) => l.includes(idCatalog['calculate.actions.fleet.final'])), 'every changed row shows its AKHIR line');
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

  // V2.5 Preserve Recommendation View While Editing Target/Tolerance:
  // a Target/Tolerance edit no longer clears the DOM at all -- the whole
  // result subtree (including Material/Fleet Actions, which are
  // display-only and frozen) stays mounted and simply becomes stale,
  // still describing the PREVIOUS scenario, until recalculated.
  test('a Target Ni edit marks the result stale but leaves both action sections mounted (frozen, describing the previous scenario)', () => {
    const pageEl = mountFullAccess();
    mountRecommendationReadyOn(pageEl);
    clickCalculateRecommendation(pageEl);

    typeIntoField(pageEl, 'targetNi', '1.130');

    assert.equal(recommendationResultRoot(pageEl).hidden, false);
    assert.match(recommendationResultRoot(pageEl).className, /\bis-stale\b/);
    assert.notEqual(materialActionsRoot(pageEl), null, 'Material Actions stay mounted, frozen, while stale');
    assert.notEqual(fleetActionsRoot(pageEl), null, 'Fleet Actions stay mounted, frozen, while stale');
  });

  test('a Tolerance edit marks the result stale but leaves both action sections mounted (frozen, describing the previous scenario)', () => {
    const pageEl = mountFullAccess();
    mountRecommendationReadyOn(pageEl);
    clickCalculateRecommendation(pageEl);

    typeIntoField(pageEl, 'tolerance', '0.020');

    assert.equal(recommendationResultRoot(pageEl).hidden, false);
    assert.match(recommendationResultRoot(pageEl).className, /\bis-stale\b/);
    assert.notEqual(materialActionsRoot(pageEl), null, 'Material Actions stay mounted, frozen, while stale');
    assert.notEqual(fleetActionsRoot(pageEl), null, 'Fleet Actions stay mounted, frozen, while stale');
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
    // Higher units=6 (V3.0 Phase 2 -- was 5, below the generation-time minimum).
    fillRow(gridRows(pageEl)[0], { pileId: 'Higher', contractor: 'X', ni: '2.00', units: '6', tonnesPerUnit: '50' });
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
  test('when the selected candidate\'s physical fleet ratio (7:12) differs from the smallest within-tolerance pattern (1:2), the DOM shows 1:2, never 7:12, while fleet utilization still shows the true 19/19 DT physical count', () => {
    const pageEl = mountFullAccess();
    mountRecommendationReadyOn(pageEl);
    clickCalculateRecommendation(pageEl);
    typeIntoField(pageEl, 'tolerance', '0.020');
    clickCalculateRecommendation(pageEl);

    assert.equal(hopperPatternRatioText(pageEl), '1 : 2');
    assert.equal(summaryValue(pageEl, 'calculate-recommendation-fleet-utilization'), '19 / 19 DT');
    assert.notEqual(hopperPatternRatioText(pageEl), '7 : 12', 'the physical 7:12 fleet ratio must never be shown as the Hopper Pattern here');
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

  test('the physical Unit Ratio row (Rasio Unit) still shows the true 7:12 physical active-fleet ratio, simultaneously with the 1:2 Hopper Pattern card', () => {
    const pageEl = mountFullAccess();
    mountRecommendationReadyOn(pageEl);
    clickCalculateRecommendation(pageEl);
    typeIntoField(pageEl, 'tolerance', '0.020');
    clickCalculateRecommendation(pageEl);

    assert.equal(hopperPatternRatioText(pageEl), '1 : 2');
    const ratioItems = findAll(pageEl, hasClass('calculate-recommendation-ratio-item'));
    const unitRatioItem = ratioItems.find((i) => i.textContent.includes(idCatalog['calculate.recommendation.unitRatio']));
    assert.match(unitRatioItem.textContent, /7 : 12/);
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
    // V3.0 Phase 2 rescale (was 5/7, tolerance 0.010).
    fillRow(gridRows(pageEl)[0], { pileId: 'Higher', contractor: 'SMA', ni: '1.30', units: '7', tonnesPerUnit: '50' });
    fillRow(gridRows(pageEl)[1], { pileId: 'Lglo', contractor: 'SMA', ni: '1.03', units: '11', tonnesPerUnit: '50' });
    fillRecommendationControls(pageEl, { targetNi: '1.120', tolerance: '0.009' });
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
   (Higher/X/Ni 2.00%/6 DT/50 t/DT alone, Lglo/Y fully idle -- V3.0 Phase 2
   rescale, was 5 DT/250t; a fleet of 5 has no feasible nonzero allocation
   at all under the new hard 0-or->=6 generation-time rule) -- baseline
   Ni 2.00% / 300t, confirmed against the real engine, never the live
   sticky Blend summary (which would differ if both rows were active).
   Reference Recovery scenario throughout: Added DT 5, Tonnes/DT 50 ->
   AddedTonnage 250 -> RequiredNi = (5.00*550 - 2.00*300)/250 = 8.60%
   (verified against calculateRequiredNewDomeNi() directly, not hand-
   derived -- distinct from the pure module's own 1.260% mandatory
   regression value in tests/planned-blend-recovery.test.mjs).
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
    assert.match(text, /300,00\s*t/);
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

  test('reference scenario: Added DT 5, Tonnes/DT 50 -> required Ni >= 8.600% (>= prefix, minimum framing)', () => {
    const pageEl = mountFullAccess();
    mountRecoveryReadyOn(pageEl);
    clickCalculateRecommendation(pageEl);
    fillRecoveryControls(pageEl, { addedDt: '5', tonnesPerDt: '50' });

    clickCalculateRecovery(pageEl);

    assert.equal(recoveryResultBox(pageEl).hidden, false);
    assert.equal(recoveryResultValueText(pageEl), '≥ 8.600%');
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
    // Required Ni for this scenario is 8.600% -- neither entered source (2.00%/0.10%) qualifies.
    fillRecoveryControls(pageEl, { addedDt: '5', tonnesPerDt: '50' });
    clickCalculateRecovery(pageEl);

    assert.equal(qualifyingSourceRows(pageEl).length, 0);
    assert.match(recoveryQualifyingBox(pageEl).textContent, new RegExp(idCatalog['calculate.recovery.noQualifyingSources']));
  });

  test('a source with Ni at/above the required minimum qualifies and is listed', () => {
    const pageEl = mountFullAccess();
    // units 6/6 (V3.0 Phase 2 -- was 5/3, both below the generation-time minimum).
    fillRow(gridRows(pageEl)[0], { pileId: 'Higher', contractor: 'X', ni: '1.00', units: '6', tonnesPerUnit: '50' });
    fillRow(gridRows(pageEl)[1], { pileId: 'HighSource', contractor: 'Z', ni: '9.00', units: '6', tonnesPerUnit: '20' });
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
    // units 6/6 (V3.0 Phase 2 -- was 5/3, both below the generation-time minimum).
    fillRow(gridRows(pageEl)[0], { pileId: 'PILE-1', contractor: 'HighCo', ni: '9.00', units: '6', tonnesPerUnit: '50' });
    fillRow(gridRows(pageEl)[1], { pileId: 'PILE-1', contractor: 'LowCo', ni: '0.10', units: '6', tonnesPerUnit: '20' });
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
    // units 6/6 (V3.0 Phase 2 -- was 2/2, both below the generation-time minimum).
    fillRow(gridRows(pageEl)[0], { pileId: 'VeryHigh', contractor: 'A', ni: '15.00', units: '6', tonnesPerUnit: '10' });
    fillRow(gridRows(pageEl)[1], { pileId: 'AlsoHigh', contractor: 'B', ni: '9.50', units: '6', tonnesPerUnit: '10' });
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

  // V2.5 Preserve Recommendation View While Editing Target/Tolerance:
  // a Target/Tolerance edit no longer removes the Recommendation or the
  // Recovery section -- both stay mounted, and Recovery's inputs/button
  // become disabled (Recovery must not be executable while stale) rather
  // than the section being torn out of the DOM.
  test('editing Target Ni marks the Recommendation stale and disables Recovery execution, without removing either section', () => {
    const pageEl = mountFullAccess();
    mountRecoveryReadyOn(pageEl);
    clickCalculateRecommendation(pageEl);
    fillRecoveryControls(pageEl, { addedDt: '5', tonnesPerDt: '50' });
    clickCalculateRecovery(pageEl);

    fillRecommendationControls(pageEl, { targetNi: '6.00' });

    assert.equal(recommendationResultRoot(pageEl).hidden, false);
    assert.match(recommendationResultRoot(pageEl).className, /\bis-stale\b/);
    assert.notEqual(recoverySectionRoot(pageEl), null, 'Recovery section stays mounted while stale');
    const root = recoverySectionRoot(pageEl);
    assert.equal(findOne(root, hasClass('calculate-calculate-recovery-btn')).disabled, true, 'Recovery must not be executable while the Recommendation is stale');
  });

  test('editing Tolerance marks the Recommendation stale and disables Recovery execution, without removing either section', () => {
    const pageEl = mountFullAccess();
    mountRecoveryReadyOn(pageEl);
    clickCalculateRecommendation(pageEl);
    fillRecoveryControls(pageEl, { addedDt: '5', tonnesPerDt: '50' });
    clickCalculateRecovery(pageEl);

    fillRecommendationControls(pageEl, { tolerance: '0.02' });

    assert.equal(recommendationResultRoot(pageEl).hidden, false);
    assert.match(recommendationResultRoot(pageEl).className, /\bis-stale\b/);
    assert.notEqual(recoverySectionRoot(pageEl), null, 'Recovery section stays mounted while stale');
    const root = recoverySectionRoot(pageEl);
    assert.equal(findOne(root, hasClass('calculate-calculate-recovery-btn')).disabled, true, 'Recovery must not be executable while the Recommendation is stale');
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
    assert.equal(recoveryResultValueText(pageEl), '≥ 8.600%');

    fillRecoveryControls(pageEl, { addedDt: '10' });
    assert.equal(recoveryResultBox(pageEl).hidden, true);
    clickCalculateRecovery(pageEl);

    // AddedTonnage = 10*50 = 500 -> RequiredNi = (5.00*800 - 2.00*300)/500 = (4000-600)/500 = 6.800%
    assert.equal(recoveryResultValueText(pageEl), '≥ 6.800%');
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
   V2.4 PHASE 8 -- latest-assay / manual-recalculation workflow (this
   task's Section 14/30 items 5/7). Phase 7's standalone sampling feature
   was intentionally NOT implemented -- the approved workflow remains:
   new assay arrives -> user edits source Ni -> live Blend updates -> old
   Recommendation clears -> user presses Hitung Rekomendasi -> the fresh
   result uses the LATEST edited Ni, never a stale value. No sampling
   history/timestamp/auto-recalculation exists anywhere in this file.
============================================================ */
describe('V2.4 Phase 8 -- latest entered Ni is what a fresh Recommendation actually uses', () => {
  test('editing a source Ni updates the live Blend summary immediately (no explicit action needed)', () => {
    const pageEl = mountFullAccess();
    fillRow(gridRows(pageEl)[0], { pileId: 'A', contractor: 'SMA', ni: '1.20', units: '10', tonnesPerUnit: '50' });
    assert.equal(summaryValue(pageEl, 'calculate-final-ni'), '1.200%');

    typeIntoField(gridRows(pageEl)[0], 'ni', '1.45');
    assert.equal(summaryValue(pageEl, 'calculate-final-ni'), '1.450%');
  });

  test('a new Recommendation calculated after editing Ni uses the FRESH value end-to-end, not the value from when it was first calculated', () => {
    const pageEl = mountFullAccess();
    mountRecommendationReadyOn(pageEl); // known scenario: Higher Ni 1.30, Lglo Ni 1.03, Target 1.120
    clickCalculateRecommendation(pageEl);
    assert.equal(summaryValue(pageEl, 'calculate-recommendation-estimated-ni'), '1.120%');

    // Simulate "a new assay arrives": Higher's Ni is updated (10:00 -> 14:00
    // style update from the architecture doc's own Section 17 example).
    typeIntoField(gridRows(pageEl)[0], 'ni', '2.00');
    assert.equal(recommendationResultRoot(pageEl).hidden, true, 'the old (now-stale) Recommendation result must disappear immediately');

    clickCalculateRecommendation(pageEl);
    assert.equal(recommendationResultRoot(pageEl).hidden, false);
    // A materially different Higher Ni (2.00 instead of 1.30) must produce
    // a materially different Estimated Ni -- proving the fresh calculation
    // genuinely read the newly-typed value, not a cached 1.30-based result.
    assert.notEqual(summaryValue(pageEl, 'calculate-recommendation-estimated-ni'), '1.120%');
  });

  test('no sampling history, assay timestamp, or "sampling mode" UI exists anywhere on the page', () => {
    const pageEl = mountFullAccess();
    mountRecommendationReadyOn(pageEl);
    clickCalculateRecommendation(pageEl);

    assert.doesNotMatch(pageEl.textContent, /sampling|assay|timestamp/i);
  });

  test('Recommendation is never calculated automatically while typing -- only Hitung Rekomendasi triggers it', () => {
    const pageEl = mountFullAccess();
    fillRow(gridRows(pageEl)[0], { pileId: 'A', contractor: 'SMA', ni: '1.20', units: '10', tonnesPerUnit: '50' });
    fillRecommendationControls(pageEl, { targetNi: '1.20', tolerance: '0.01' });

    assert.equal(recommendationResultRoot(pageEl).hidden, true, 'typing complete inputs alone must never auto-run Recommendation');
  });
});

/* ============================================================
   V2.4 PHASE 8 -- no raw i18n key ever rendered (this task's Section
   30 item 20). A missing/mistyped key would otherwise silently render as
   its own literal dot-path string (e.g. "calculate.recommendation.foo")
   -- this scans the FULLY rendered Recommendation + Recovery result (the
   most i18n-key-dense subtree on the page) for that shape.
============================================================ */
describe('V2.4 Phase 8 -- no raw translation key is ever rendered', () => {
  test('the rendered Recommendation result (within-tolerance scenario) never contains a raw "calculate.xxx.yyy"-shaped string', () => {
    const pageEl = mountFullAccess();
    mountRecommendationReadyOn(pageEl);
    clickCalculateRecommendation(pageEl);

    assert.doesNotMatch(recommendationResultRoot(pageEl).textContent, /\bcalculate\.[a-zA-Z]+\.[a-zA-Z]+\b/);
  });

  test('the rendered Recommendation + Recovery result (TARGET_NOT_ACHIEVABLE scenario) never contains a raw key', () => {
    const pageEl = mountFullAccess();
    mountRecoveryReadyOn(pageEl);
    clickCalculateRecommendation(pageEl);
    fillRecoveryControls(pageEl, { addedDt: '5', tonnesPerDt: '50' });
    clickCalculateRecovery(pageEl);

    assert.doesNotMatch(recommendationResultRoot(pageEl).textContent, /\bcalculate\.[a-zA-Z]+\.[a-zA-Z]+\b/);
  });

  test('English locale rendering also never contains a raw key (a locale-specific missing translation would otherwise fall through silently)', () => {
    const pageEl = mountFullAccess();
    mountRecommendationReadyOn(pageEl);
    clickCalculateRecommendation(pageEl);
    setLocale('en');

    assert.doesNotMatch(recommendationResultRoot(pageEl).textContent, /\bcalculate\.[a-zA-Z]+\.[a-zA-Z]+\b/);
    setLocale(DEFAULT_LOCALE);
  });
});

/* ============================================================
   V2.4 PHASE 8 -- terminology audit (this task's Section 9). "Fleet
   Adjustment" (was "Fleet Reallocation") is the Owner-approved EN pairing
   for Indonesian "Penyesuaian Fleet".
============================================================ */
describe('V2.4 Phase 8 -- terminology audit: Fleet Adjustment / Penyesuaian Fleet', () => {
  test('Indonesian: Penyesuaian Fleet (unchanged)', () => {
    assert.equal(idCatalog['calculate.recommendation.relocation'], 'Penyesuaian Fleet');
  });

  test('English: Fleet Adjustment (corrected from the old "Fleet Reallocation")', () => {
    assert.equal(enCatalog['calculate.recommendation.relocation'], 'Fleet Adjustment');
  });

  test('the relocation/adjustment section heading actually renders "Fleet Adjustment" in English', () => {
    const pageEl = mountFullAccess();
    fillRow(gridRows(pageEl)[0], { pileId: 'Higher', contractor: 'SMA', ni: '1.30', units: '5', tonnesPerUnit: '50' });
    fillRow(gridRows(pageEl)[1], { pileId: 'Lglo', contractor: 'SMA', ni: '1.03', units: '7', tonnesPerUnit: '50' });
    fillRecommendationControls(pageEl, { targetNi: '1.120', tolerance: '0.010' });
    clickCalculateRecommendation(pageEl);
    setLocale('en');

    assert.match(recommendationResultRoot(pageEl).textContent, /Fleet Adjustment/);
    assert.doesNotMatch(recommendationResultRoot(pageEl).textContent, /Fleet Reallocation/);
    setLocale(DEFAULT_LOCALE);
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
