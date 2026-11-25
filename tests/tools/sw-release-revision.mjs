// Shared, deterministic computation of service-worker.js's release
// identity (v3.1.1 PWA in-app update system):
//
//   APP_VERSION    -- mirrored from js/shared/app-version.js (the ONE
//                     canonical version source; never edited by hand in
//                     service-worker.js).
//   ASSET_REVISION -- first 12 hex chars of a SHA-256 over every APP_SHELL
//                     file's contents (path + bytes, sorted by path).
//
// Embedding both in service-worker.js guarantees that any release which
// changes ANY precached asset also changes the worker script's bytes --
// the only signal browsers use to detect a service-worker update. The v3.1.0
// release shipped changed Report modules without touching
// service-worker.js, so installed PWAs never noticed it; this closes that
// gap mechanically instead of relying on someone remembering to bump a
// CACHE_NAME string.
//
// Text assets are hashed with CRLF normalized to LF: Windows checkouts
// (core.autocrlf) carry CRLF on disk while the repository -- and therefore
// the deployed GitHub Pages site -- carries LF, and both must produce the
// same revision.
//
// Used by:
//   tests/tools/sync-service-worker-release.mjs  (writes the values)
//   tests/service-worker.test.mjs                (fails when they are stale)

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const TEXT_EXTENSIONS = new Set(['.js', '.mjs', '.css', '.html', '.webmanifest', '.json', '.svg', '.txt']);

function stripLineComments(source) {
  return source.split(/\r\n|\n/).map((line) => line.replace(/\/\/.*$/, '')).join('\n');
}

export function extractAppShell(swSource) {
  const match = stripLineComments(swSource).match(/const APP_SHELL = \[([\s\S]*?)\];/);
  if (!match) throw new Error('service-worker.js must define a const APP_SHELL = [...] array');
  return [...match[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
}

export function extractCanonicalAppVersion(appVersionSource) {
  const match = appVersionSource.match(/export const APP_VERSION = '([^']+)';/);
  if (!match) throw new Error("js/shared/app-version.js must declare export const APP_VERSION = '...';");
  return match[1];
}

export function extractServiceWorkerConstant(swSource, name) {
  const match = swSource.match(new RegExp(`const ${name} = '([^']*)';`));
  return match ? match[1] : null;
}

export function readAssetBytes(root, entry) {
  const relPath = entry.replace(/^\.\//, '');
  const buffer = readFileSync(path.join(root, relPath));
  if (!TEXT_EXTENSIONS.has(path.extname(relPath).toLowerCase())) return buffer;
  return Buffer.from(buffer.toString('utf8').replace(/\r\n/g, '\n'), 'utf8');
}

export function computeAssetRevision(root, appShell) {
  // './' is served as index.html (already its own entry), not a file.
  const entries = [...new Set(appShell.filter((entry) => entry !== './'))].sort();
  const hash = createHash('sha256');
  for (const entry of entries) {
    hash.update(entry, 'utf8');
    hash.update('\0');
    hash.update(readAssetBytes(root, entry));
    hash.update('\0');
  }
  return hash.digest('hex').slice(0, 12);
}

export function computeExpectedRelease(root) {
  const swSource = readFileSync(path.join(root, 'service-worker.js'), 'utf8');
  const appVersionSource = readFileSync(path.join(root, 'js', 'shared', 'app-version.js'), 'utf8');
  return {
    swSource,
    appVersion: extractCanonicalAppVersion(appVersionSource),
    assetRevision: computeAssetRevision(root, extractAppShell(swSource)),
  };
}
