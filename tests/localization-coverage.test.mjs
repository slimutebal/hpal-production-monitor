// Localization coverage / hardcoded-string-leakage guard (V2.3 full
// localization pass).
//
// Run with Node's built-in test runner:
//
//   node --test tests/localization-coverage.test.mjs
//
// This is NOT a general-purpose "every string is translated" prover --
// that would require a real JS/HTML parser and still couldn't judge which
// strings are legitimately business identifiers vs. UI wording (the
// ABSOLUTE BUSINESS-SAFETY RULE requires a human/architectural judgment
// call the earlier localization pass already made file-by-file). Instead
// this file does two narrower, still-valuable things:
//
//   1. Catalog completeness: js/i18n/locales/id.js and en.js must carry
//      the exact same key set (also asserted in tests/i18n.test.mjs;
//      repeated here because this file is the one a future contributor
//      is most likely to run when adding a new localizable string).
//   2. Regression lock: a curated list of Indonesian UI strings that were
//      hardcoded before this pass (across Monitor/Report/Settings) must
//      never reappear as bare literals in the scanned runtime source --
//      only inside a t()/mt() call, a data-i18n* attribute, or a comment.
//      This directly guards the fixes this pass made from silently
//      regressing, without claiming to catch every possible future leak.
//
// Scanned sources: index.html (Monitor, the classic/non-module script),
// and the Report/Settings modules that own the bulk of this app's
// dynamic UI text. js/i18n/locales/*.js are deliberately EXCLUDED from
// the leakage scan -- they are the one place these Indonesian strings are
// SUPPOSED to live.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import idCatalog from '../js/i18n/locales/id.js';
import enCatalog from '../js/i18n/locales/en.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

function readSource(relativePath) {
  return readFileSync(path.join(ROOT, relativePath), 'utf8');
}

// Strips `//` line comments and every single-line t('key', {..}) / mt('key',
// {..}) call's arguments -- both are legitimate carriers of the catalog
// keys (never the literal wording itself) and must not trip the leakage
// scan below. Deliberately line-based (matches this codebase's actual
// style throughout the localization pass: every t()/mt() call site edited
// in this phase is single-line) rather than a full tokenizer.
function stripCommentsAndTranslationCalls(source) {
  return source
    .split('\n')
    .map((line) => {
      const trimmed = line.trim();
      if (trimmed.startsWith('//')) return '';
      return line
        .replace(/\bt\([^)]*\)/g, 't(...)')
        .replace(/\bmt\([^)]*\)/g, 'mt(...)');
    })
    .join('\n');
}

// A line carrying a data-i18n*/data-i18n-placeholder/-title/-aria-label
// attribute is already correctly wired to translatePage() -- its
// fallback text content (shown only before JS runs, in the default `id`
// locale) is expected and safe, not a leak.
function stripDataI18nTaggedLines(source) {
  return source
    .split('\n')
    .filter((line) => !/data-i18n/.test(line))
    .join('\n');
}

const SCANNED_FILES = [
  'index.html',
  'js/pages/report/report-page.js',
  'js/pages/report/report-personnel.js',
  'js/pages/settings/settings-page.js',
  'js/pages/settings/settings-personnel.js',
];

// Curated regression lock: exact Indonesian substrings that were
// hardcoded directly in JS/HTML source before this localization pass.
// Each must now be reachable ONLY through a locale catalog (js/i18n/
// locales/{id,en}.js), never as a bare literal in the files above.
const FORMERLY_HARDCODED_STRINGS = [
  'Gagal sinkron ke server',
  'Gagal membaca file kontraktor',
  'Tidak ada baris valid ditemukan',
  'Chart.js tidak termuat',
  'No DT dan Nama Kontraktor wajib diisi',
  'Tidak terdaftar', // NOT_REGISTERED_CONTRACTOR sentinel is exempt (see ALLOWLIST) -- this checks no OTHER bare copy exists
  '(Tanpa Dome)', // noDomeLabel sentinel is exempt (see ALLOWLIST) -- same reasoning
  'Nama wajib diisi',
  'Organisasi wajib diisi',
  'Pilih Independent Sampler aktif terlebih dahulu',
  'Nonaktifkan Personel',
  'Data sudah berubah di server. Sinkronkan ulang sebelum mencoba lagi',
  'Personel dengan role, nama, dan organisasi yang sama sudah aktif',
  'Teks report sebelumnya belum diisi',
  'File data timbangan belum berhasil diupload',
  'Week tidak dapat dihitung dari tanggal file timbangan',
  'Buyer belum terdeteksi dari teks report sebelumnya maupun file timbangan',
  'Select at least one SPV SCM', // pre-localization English literal, now t()-driven
  'Synchronize Personnel Directory in Settings before creating a Report',
];

// Documented, justified exceptions -- lines legitimately allowed to carry
// these strings verbatim, one entry per (string, file) pair. See each
// reason.
const ALLOWLIST = [
  { text: 'Tidak terdaftar', file: 'index.html', reason: 'NOT_REGISTERED_CONTRACTOR sentinel constant -- a stable internal comparison value (dome-group contractorLabel filter), never itself a UI string; displayContractor() is the one place it is translated, at render time only.' },
  { text: '(Tanpa Dome)', file: 'index.html', reason: 'noDomeLabel is produced via mt(\'monitor.results.noDomeLabel\') at every call site -- the string appears here only inside this file\'s own explanatory comments/allowlist references, never as a bare fallback literal.' },
];

describe('Catalog completeness -- id.js and en.js key parity', () => {
  test('every id.js key exists in en.js', () => {
    const missing = Object.keys(idCatalog).filter((k) => !(k in enCatalog));
    assert.deepEqual(missing, []);
  });

  test('every en.js key exists in id.js', () => {
    const missing = Object.keys(enCatalog).filter((k) => !(k in idCatalog));
    assert.deepEqual(missing, []);
  });

  test('no catalog entry is a blank string', () => {
    for (const [key, value] of Object.entries(idCatalog)) assert.ok(value.length > 0, `id.js "${key}"`);
    for (const [key, value] of Object.entries(enCatalog)) assert.ok(value.length > 0, `en.js "${key}"`);
  });
});

describe('Regression lock -- formerly-hardcoded Indonesian UI strings stay out of runtime source', () => {
  for (const relativePath of SCANNED_FILES) {
    test(`${relativePath} carries none of the formerly-hardcoded strings as a bare literal`, () => {
      const raw = readSource(relativePath);
      const scanned = stripDataI18nTaggedLines(stripCommentsAndTranslationCalls(raw));

      const offenders = [];
      for (const needle of FORMERLY_HARDCODED_STRINGS) {
        if (!scanned.includes(needle)) continue;
        const isAllowed = ALLOWLIST.some((entry) => entry.text === needle && entry.file === relativePath);
        if (!isAllowed) offenders.push(needle);
      }
      assert.deepEqual(offenders, [], `${relativePath} still contains: ${offenders.join(', ')}`);
    });
  }

  test('every ALLOWLIST entry documents a non-empty reason', () => {
    for (const entry of ALLOWLIST) {
      assert.ok(entry.reason && entry.reason.length > 10, `${entry.file}/"${entry.text}" needs a real justification`);
    }
  });
});
