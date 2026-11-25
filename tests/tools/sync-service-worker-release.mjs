// Writes service-worker.js's APP_VERSION / ASSET_REVISION constants from
// the canonical sources (see tests/tools/sw-release-revision.mjs).
//
// Run after changing js/shared/app-version.js or ANY file listed in
// service-worker.js's APP_SHELL, before releasing:
//
//   node tests/tools/sync-service-worker-release.mjs          (rewrite)
//   node tests/tools/sync-service-worker-release.mjs --check  (exit 1 if stale)
//
// tests/service-worker.test.mjs fails whenever these values are stale, so
// a release can never ship changed assets behind an unchanged worker.

import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { computeExpectedRelease, extractServiceWorkerConstant } from './sw-release-revision.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const checkOnly = process.argv.includes('--check');

const { swSource, appVersion, assetRevision } = computeExpectedRelease(ROOT);
const currentVersion = extractServiceWorkerConstant(swSource, 'APP_VERSION');
const currentRevision = extractServiceWorkerConstant(swSource, 'ASSET_REVISION');

if (currentVersion === null || currentRevision === null) {
  console.error('service-worker.js must declare const APP_VERSION = \'...\'; and const ASSET_REVISION = \'...\';');
  process.exit(1);
}

const upToDate = currentVersion === appVersion && currentRevision === assetRevision;

if (checkOnly) {
  if (upToDate) {
    console.log(`service-worker.js is in sync: ${appVersion} / ${assetRevision}`);
    process.exit(0);
  }
  console.error(`service-worker.js is stale: has ${currentVersion} / ${currentRevision}, expected ${appVersion} / ${assetRevision}`);
  process.exit(1);
}

if (upToDate) {
  console.log(`service-worker.js already in sync: ${appVersion} / ${assetRevision}`);
} else {
  const updated = swSource
    .replace(/const APP_VERSION = '[^']*';/, `const APP_VERSION = '${appVersion}';`)
    .replace(/const ASSET_REVISION = '[^']*';/, `const ASSET_REVISION = '${assetRevision}';`);
  writeFileSync(path.join(ROOT, 'service-worker.js'), updated);
  console.log(`service-worker.js updated: ${currentVersion} / ${currentRevision} -> ${appVersion} / ${assetRevision}`);
}
