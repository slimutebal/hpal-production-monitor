// V3.0 Phase 1 -- reference-independence guard (this task's Section 25/30).
//
// Two directions of protection, both automated so a future accidental
// import cannot creep in silently:
//
//   1. Nothing under tests/reference/v2-exhaustive/ (the frozen oracle)
//      may import a PRODUCTION search module (fleet-allocation.js,
//      blending-recommendation.js, recommendation-ranking.js,
//      operational-continuity.js, calculate-validation.js) -- doing so
//      would make the "reference" a thin wrapper around production that
//      silently mutates alongside it, defeating the entire point of
//      having an independent oracle (this task's Section 3/30). The two
//      explicitly-approved shared imports (js/shared/ore-classification.js,
//      js/pages/calculate/number-input.js -- see blending-recommendation-
//      reference.mjs's own header comment for why those two are safe) are
//      the only production imports allowed anywhere under
//      tests/reference/v2-exhaustive/.
//
//   2. Nothing under js/, index.html, or service-worker.js may import
//      anything under tests/reference/ -- the reference engine must never
//      ship in the PWA (this task's Section 25).
//
// Run with Node's built-in test runner:
//
//   node --test tests/v3-reference-guard.test.mjs
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const REFERENCE_DIR = path.join(ROOT, 'tests', 'reference', 'v2-exhaustive');

const FORBIDDEN_PRODUCTION_SEARCH_MODULES = [
  'fleet-allocation.js',
  'blending-recommendation.js',
  'recommendation-ranking.js',
  'operational-continuity.js',
  'calculate-validation.js',
];

const ALLOWED_SHARED_PRODUCTION_IMPORTS = [
  'js/shared/ore-classification.js',
  'js/pages/calculate/number-input.js',
];

function listFilesRecursive(dir) {
  return readdirSync(dir).flatMap((entry) => {
    const fullPath = path.join(dir, entry);
    if (statSync(fullPath).isDirectory()) return listFilesRecursive(fullPath);
    return [fullPath];
  });
}

function extractImportSpecifiers(source) {
  const specifiers = [];
  const importRegex = /import\s+(?:[^'"]*?from\s+)?['"]([^'"]+)['"]/g;
  let match = importRegex.exec(source);
  while (match) {
    specifiers.push(match[1]);
    match = importRegex.exec(source);
  }
  return specifiers;
}

describe('V3.0 Phase 1 oracle independence guard (this task\'s Section 30)', () => {
  const referenceFiles = listFilesRecursive(REFERENCE_DIR).filter((f) => f.endsWith('.mjs'));

  test('at least the expected frozen-reference files are present (guard is not accidentally scanning an empty directory)', () => {
    assert.ok(referenceFiles.length >= 5, `expected >= 5 reference files, found ${referenceFiles.length}`);
  });

  referenceFiles.forEach((file) => {
    const relativePath = path.relative(ROOT, file).split(path.sep).join('/');
    test(`${relativePath} does not import any production Recommendation search module`, () => {
      const source = readFileSync(file, 'utf8');
      const specifiers = extractImportSpecifiers(source);
      specifiers.forEach((specifier) => {
        if (!specifier.startsWith('.')) return; // bare/external specifiers are not production files
        const resolved = path.normalize(path.join(path.dirname(file), specifier)).split(path.sep).join('/');
        const resolvedRelativeToRoot = path.relative(ROOT, path.join(path.dirname(file), specifier)).split(path.sep).join('/');

        const isForbiddenSearchModule = FORBIDDEN_PRODUCTION_SEARCH_MODULES.some((name) => resolved.endsWith(`/js/pages/calculate/${name}`));
        assert.equal(isForbiddenSearchModule, false, `${relativePath} imports forbidden production search module via "${specifier}" (resolved: ${resolvedRelativeToRoot})`);

        const importsProductionAtAll = resolvedRelativeToRoot.startsWith('js/');
        if (importsProductionAtAll) {
          const isExplicitlyAllowed = ALLOWED_SHARED_PRODUCTION_IMPORTS.some((allowed) => resolvedRelativeToRoot === allowed);
          assert.ok(isExplicitlyAllowed, `${relativePath} imports production file "${resolvedRelativeToRoot}" which is not in the explicitly-approved shared-utility allowlist (${ALLOWED_SHARED_PRODUCTION_IMPORTS.join(', ')})`);
        }
      });
    });
  });
});

describe('V3.0 Phase 1 reference-never-ships guard (this task\'s Section 25)', () => {
  const productionFiles = [
    ...listFilesRecursive(path.join(ROOT, 'js')).filter((f) => f.endsWith('.js')),
    path.join(ROOT, 'index.html'),
    path.join(ROOT, 'service-worker.js'),
  ];

  test('at least the expected production files are present (guard is not accidentally scanning nothing)', () => {
    assert.ok(productionFiles.length >= 5, `expected >= 5 production files, found ${productionFiles.length}`);
  });

  productionFiles.forEach((file) => {
    const relativePath = path.relative(ROOT, file).split(path.sep).join('/');
    test(`${relativePath} never references tests/reference/`, () => {
      const source = readFileSync(file, 'utf8');
      assert.equal(source.includes('tests/reference'), false, `${relativePath} must never import/reference the test-only reference oracle`);
    });
  });
});
