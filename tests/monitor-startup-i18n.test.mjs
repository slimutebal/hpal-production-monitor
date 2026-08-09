// Regression tests for the V2.5.1 raw-translation-key startup bug
// (startup audit Root Cause C -- this task's Sections 14-16/40).
//
// Run with Node's built-in test runner:
//
//   node --test tests/monitor-startup-i18n.test.mjs
//
// Root cause (proven in the startup audit): Monitor's classic inline
// <script> runs during HTML parsing, strictly BEFORE js/app.js's ES
// module script (module scripts always execute after parsing completes,
// per the HTML spec, right before DOMContentLoaded fires). The bug was
// that loadContractorData() -- which ends up calling
// renderContractorStatus(), which calls mt(), which falls back to
// returning the RAW key string when window.i18n does not exist yet --
// used to be invoked unconditionally at the very bottom of that
// synchronous script, before window.i18n could possibly exist.
//
// The fix (this file's whole point to protect) is architectural, not a
// setTimeout/polling workaround: loadContractorData() is now called from
// inside Monitor's own `document.addEventListener('DOMContentLoaded', ...)`
// listener, which is GUARANTEED (by the same HTML spec module-script
// ordering rule) to run only after js/app.js has already installed
// window.i18n. index.html cannot be executed as a real browser page under
// Node (classic-script/module-script parse-order semantics do not exist
// in Node's module system), so this is proven via SOURCE-POSITION
// assertions -- the same "prove the architecture, not a re-implementation
// of it" convention tests/monitor-contractor-bridge.test.mjs already
// uses for this exact file.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const indexHtml = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const appJs = fs.readFileSync(path.join(ROOT, 'js', 'app.js'), 'utf8');

// Finds a `document.addEventListener('DOMContentLoaded', () => { ... });`
// block's exact source span via brace-matching (robust against nested
// braces inside the callback), not a naive non-greedy regex.
function extractDOMContentLoadedBlock(source) {
  const marker = "document.addEventListener('DOMContentLoaded', () => {";
  const startIdx = source.indexOf(marker);
  assert.ok(startIdx !== -1, "expected document.addEventListener('DOMContentLoaded', () => { ... in index.html");
  const bodyStart = startIdx + marker.length;
  let depth = 1;
  let i = bodyStart;
  for (; i < source.length && depth > 0; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') depth--;
  }
  assert.equal(depth, 0, 'unbalanced braces extracting the DOMContentLoaded listener');
  return { start: startIdx, end: i, body: source.slice(bodyStart, i - 1) };
}

describe('14. loadContractorData() is started from the DOMContentLoaded listener, never eagerly at script-parse time', () => {
  test('loadContractorData() is CALLED exactly once in index.html (excluding its own declaration)', () => {
    const callOccurrences = [...indexHtml.matchAll(/(?<!function )loadContractorData\(\);/g)];
    assert.equal(callOccurrences.length, 1, 'expected exactly one call site for loadContractorData()');
  });

  test('that one call site is INSIDE the Monitor DOMContentLoaded listener block', () => {
    const { start, end, body } = extractDOMContentLoadedBlock(indexHtml);
    const callIdxInFile = indexHtml.indexOf('loadContractorData();');
    assert.ok(callIdxInFile > start && callIdxInFile < end, 'loadContractorData(); must be called from within the DOMContentLoaded listener');
    assert.match(body, /^\s*loadContractorData\(\);/, 'loadContractorData() should be the first statement in the listener, run before the onLocaleChange subscription is registered');
  });

  test('the OLD bug pattern -- a bare top-level loadContractorData(); call sitting just before the closing </script> tag -- is gone', () => {
    const scriptEndIdx = indexHtml.lastIndexOf('</script>');
    assert.ok(scriptEndIdx !== -1);
    const tail = indexHtml.slice(Math.max(0, scriptEndIdx - 200), scriptEndIdx);
    assert.doesNotMatch(tail, /\nloadContractorData\(\);\n/, 'loadContractorData() must not be called unconditionally at the very end of Monitor\'s synchronous script execution');
  });

  test('the onLocaleChange subscription (the pre-existing, already-correct pattern this fix now matches) is registered in the SAME listener, after loadContractorData()', () => {
    const { body } = extractDOMContentLoadedBlock(indexHtml);
    const loadIdx = body.indexOf('loadContractorData();');
    const onLocaleIdx = body.indexOf('window.i18n.onLocaleChange(');
    assert.ok(loadIdx !== -1 && onLocaleIdx !== -1);
    assert.ok(loadIdx < onLocaleIdx);
  });
});

describe('js/app.js installs window.i18n synchronously, with zero awaits beforehand -- the guarantee this fix relies on', () => {
  test('js/app.js is loaded as an ES module (module scripts execute after parsing completes, before DOMContentLoaded, per the HTML spec)', () => {
    assert.match(indexHtml, /<script type="module" src="\.\/js\/app\.js"><\/script>/);
  });

  test('init() sets window.i18n with no `await` between function start and that assignment', () => {
    const startMatch = appJs.match(/function init\(\)\s*\{/);
    assert.ok(startMatch);
    const windowI18nIdx = appJs.indexOf('window.i18n = { t, getLocale, onLocaleChange, translatePage };');
    assert.ok(windowI18nIdx !== -1, 'expected the window.i18n bridge assignment in js/app.js');
    const between = appJs.slice(startMatch.index, windowI18nIdx);
    assert.doesNotMatch(between, /\bawait\b/, 'nothing before window.i18n is installed may be awaited -- it must be synchronous within init()');
  });

  test('init() runs synchronously on DOMContentLoaded (or immediately if parsing has already finished) -- not deferred behind any other async gate', () => {
    assert.match(appJs, /if \(document\.readyState === 'loading'\) \{\s*document\.addEventListener\('DOMContentLoaded', init\);\s*\} else \{\s*init\(\);\s*\}/);
  });
});

describe('15/40. Raw translation keys are never directly rendered -- every contractor-status string always goes through mt()', () => {
  const RAW_KEYS = [
    'monitor.contractorStatus.syncingBadge',
    'monitor.contractorStatus.addButton',
    'monitor.contractorStatus.syncNowButton',
    'monitor.contractorStatus.updateFileButton',
  ];

  test('each of the exact keys the Owner reported appears in index.html ONLY as an mt(\'...\') call argument, never as bare/unwrapped text', () => {
    for (const key of RAW_KEYS) {
      const occurrences = [...indexHtml.matchAll(new RegExp(key.replace(/\./g, '\\.'), 'g'))];
      assert.ok(occurrences.length >= 1, `expected to find ${key} referenced in index.html`);
      for (const m of occurrences) {
        const before = indexHtml.slice(Math.max(0, m.index - 4), m.index);
        assert.match(before, /mt\('$/, `${key} at index ${m.index} must be immediately preceded by mt(' -- found: ${JSON.stringify(before)}`);
      }
    }
  });

  test('mt() itself is unchanged in behavior (still a safe, never-throwing fallback) -- this fix is about WHEN it is first called, not about removing its defensive branch', () => {
    assert.match(indexHtml, /function mt\(key, vars\)\{\s*return \(window\.i18n && typeof window\.i18n\.t === 'function'\) \? window\.i18n\.t\(key, vars\) : key;\s*\}/);
  });

  test('the 4 keys the Owner saw are defined in BOTH locale catalogs (a timing bug, never a missing-translation bug -- see startup audit)', () => {
    const idJs = fs.readFileSync(path.join(ROOT, 'js', 'i18n', 'locales', 'id.js'), 'utf8');
    const enJs = fs.readFileSync(path.join(ROOT, 'js', 'i18n', 'locales', 'en.js'), 'utf8');
    for (const key of RAW_KEYS) {
      assert.match(idJs, new RegExp(`'${key.replace(/\./g, '\\.')}':`));
      assert.match(enJs, new RegExp(`'${key.replace(/\./g, '\\.')}':`));
    }
  });
});
