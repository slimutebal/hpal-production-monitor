// js/shared/ore-classification.js tests (V2.4 Phase 2 -- Blend
// Calculator, classification consolidation). See
// docs/V2.4_CALCULATE_AND_BLENDING_RECOMMENDATION_ARCHITECTURE.md Section
// 11, and this task's own Section 10-11.
//
// Run with Node's built-in test runner:
//
//   node --test tests/ore-classification.test.mjs
//
// Boundary values below are reconfirmed against the CURRENT production
// thresholds (Ni > 1.4 -> HGLO, Ni < 1.2 -> LGLO, else MGLO) as found in
// index.html's classifyOre(), js/pages/report/profiles/adapters/
// esg-adapter-utils.js's classifyEsgOreClass(), and (pre-refactor)
// js/pages/report/profiles/shared-report-profile.js's classifyOreClass()
// -- not assumed from the architecture document alone.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { classifyOre } from '../js/shared/ore-classification.js';
import { classifyOreClass } from '../js/pages/report/profiles/shared-report-profile.js';
import { classifyEsgOreClass } from '../js/pages/report/profiles/adapters/esg-adapter-utils.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

describe('classifyOre() -- boundary behavior (this task Section 11)', () => {
  test('1.199999... (just under 1.20) -> LGLO', () => {
    assert.equal(classifyOre(1.199999), 'LGLO');
  });

  test('1.20 exactly -> MGLO', () => {
    assert.equal(classifyOre(1.2), 'MGLO');
  });

  test('1.40 exactly -> MGLO', () => {
    assert.equal(classifyOre(1.4), 'MGLO');
  });

  test('1.400001... (just over 1.40) -> HGLO', () => {
    assert.equal(classifyOre(1.400001), 'HGLO');
  });

  test('well below range (0.5) -> LGLO', () => {
    assert.equal(classifyOre(0.5), 'LGLO');
  });

  test('well above range (2.0) -> HGLO', () => {
    assert.equal(classifyOre(2.0), 'HGLO');
  });

  test('mid-range (1.30) -> MGLO', () => {
    assert.equal(classifyOre(1.3), 'MGLO');
  });

  test('null/undefined/NaN -> null (never a fabricated class)', () => {
    assert.equal(classifyOre(null), null);
    assert.equal(classifyOre(undefined), null);
    assert.equal(classifyOre(NaN), null);
  });

  test('a numeric string is coerced the same way isNaN()-based comparisons always have been (no behavior change from the pre-extraction inline versions)', () => {
    assert.equal(classifyOre('1.30'), 'MGLO');
    assert.equal(classifyOre('1.50'), 'HGLO');
  });
});

describe('Regression: shared-report-profile.js classifyOreClass() delegates without changing external behavior', () => {
  test('valid grades still return the bare class code (HGLO/MGLO/LGLO), exactly as before the refactor', () => {
    assert.equal(classifyOreClass(1.5), 'HGLO');
    assert.equal(classifyOreClass(1.3), 'MGLO');
    assert.equal(classifyOreClass(0.9), 'LGLO');
  });

  test('boundary values still match classifyOre() exactly', () => {
    for (const grade of [1.199999, 1.2, 1.4, 1.400001]) {
      assert.equal(classifyOreClass(grade), classifyOre(grade));
    }
  });

  test('invalid input still returns the long-standing "-" sentinel, NOT null -- this is the one place classifyOreClass()\'s external contract intentionally differs from classifyOre()\'s own null', () => {
    assert.equal(classifyOreClass(null), '-');
    assert.equal(classifyOreClass(undefined), '-');
    assert.equal(classifyOreClass(NaN), '-');
  });
});

describe('esg-adapter-utils.js classifyEsgOreClass() is untouched by this consolidation (deliberately, see its own header comment)', () => {
  test('still matches classifyOre() for every boundary value -- the two independent implementations still agree, they are just no longer the same file', () => {
    for (const grade of [1.199999, 1.2, 1.4, 1.400001, 0.5, 2.0]) {
      assert.equal(classifyEsgOreClass(grade), classifyOre(grade));
    }
  });

  test('esg-adapter-utils.js does not import the new shared module -- its documented ESG/HYNC-SLNC isolation boundary was not touched by this task', () => {
    const source = readFileSync(path.join(ROOT, 'js', 'pages', 'report', 'profiles', 'adapters', 'esg-adapter-utils.js'), 'utf8');
    assert.doesNotMatch(source, /from ['"].*ore-classification/, 'esg-adapter-utils.js must remain import-free from the shared classification module, per its own documented isolation requirement');
    assert.doesNotMatch(source, /from ['"].*shared-report-profile/, 'esg-adapter-utils.js must remain import-free from the HYNC/SLNC module graph');
  });
});

describe('Monitor (index.html) inline classifyOre() is untouched by this consolidation (deliberately, see js/shared/ore-classification.js\'s own header comment)', () => {
  const indexHtml = readFileSync(path.join(ROOT, 'index.html'), 'utf8');

  test('index.html still defines its own inline classifyOre() -- not converted to an ES module import in this task', () => {
    assert.match(indexHtml, /function classifyOre\(grade\)\{/);
  });

  test('the inline thresholds still match the shared module exactly (still only 3 independent implementations exist, never a 4th -- see this task\'s architectural report)', () => {
    assert.match(indexHtml, /if\(grade > 1\.4\) return 'HGLO';/);
    assert.match(indexHtml, /if\(grade < 1\.2\) return 'LGLO';/);
  });
});

describe('js/shared/ore-classification.js is a pure module', () => {
  const source = readFileSync(path.join(ROOT, 'js', 'shared', 'ore-classification.js'), 'utf8');

  test('imports nothing -- no DOM, router, i18n, or localStorage dependency', () => {
    assert.doesNotMatch(source, /^import /m);
  });
});
