// Simple local access-key license gate (V2.3 Phase 8).
//
// This intentionally REPLACES the earlier V2.3 architecture draft's
// asymmetric signed-offline-token design (see
// docs/V2.3_AUTO_WEEK_AND_PERSONNEL_DIRECTORY_ARCHITECTURE.md, updated
// alongside this file) -- an Owner-approved deviation. There is no License
// Generator, no private signing key, and no per-license identifier; there
// is exactly one permanent Owner-held access key, entered once per
// browser/PWA storage lifetime.
//
// SECURITY MODEL: this is a casual-access gate, not DRM. HPAL Production
// Monitor is a public static PWA with no backend -- a technically capable
// person who modifies the shipped JavaScript can bypass any client-side
// control. The goals here are: (1) keep the plaintext access key out of
// source control, (2) prevent casual/unintended access to Report and the
// Personnel Directory, (3) give a clear, testable MONITOR_ONLY/FULL_ACCESS
// signal the rest of the app can gate on at both the route and the action
// boundary. Nothing below claims stronger guarantees than that.
//
// VERIFICATION: PBKDF2-HMAC-SHA-256 (Web Crypto, crypto.subtle) derives a
// fixed-length "verifier" from the entered key, a fixed public salt, and a
// fixed iteration count. Only the derived verifier (not the plaintext key,
// and not anything that can recover it) is committed to source or ever
// written to storage -- see deriveVerifierBits()/PRODUCTION_CONFIG below.
// The entered key is compared byte-for-byte, case-sensitive, untrimmed --
// a single leading/trailing space produces a different derived verifier
// and therefore fails.
//
// TESTABILITY: createLicenseService(config) is a pure factory -- no
// module-level state, no hardcoded storage -- so tests build their own
// instance against a fixture salt/iterations/expected-verifier and an
// in-memory mock storage, fully exercising install/persist/reload/remove
// without ever touching the production constants or plaintext key (see
// tests/license-service.test.mjs). The bound exports below
// (initializeLicense/getAccessTier/... ) are the ONLY production-facing
// surface -- there is no test-only override wired into them, and no
// automatic-FULL_ACCESS path exists anywhere in this file.

export const ACCESS_TIERS = Object.freeze({
  MONITOR_ONLY: 'MONITOR_ONLY',
  FULL_ACCESS: 'FULL_ACCESS',
});

const STORAGE_KEY = 'hpal.license.v1';
const SCHEMA_VERSION = 1;

/* ============================================================
   ENCODING HELPERS -- base64 <-> bytes, working identically under a
   browser (btoa/atob) and Node's test runner (Buffer), since this module
   must be importable from both (see file header on testability).
============================================================ */
function bytesToBase64(bytes) {
  if (typeof Buffer !== 'undefined') return Buffer.from(bytes).toString('base64');
  let binary = '';
  bytes.forEach((b) => {
    binary += String.fromCharCode(b);
  });
  return btoa(binary);
}

function base64ToBytes(b64) {
  if (typeof Buffer !== 'undefined') return new Uint8Array(Buffer.from(b64, 'base64'));
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

// Constant-time-ish comparison -- always walks the full (equal) length
// before returning, so a mismatch on the first byte does not resolve
// measurably faster than a mismatch on the last one. Length is compared
// first (necessarily non-constant-time, but leaks only a length class,
// never key content) since two different-length Uint8Arrays cannot be
// compared byte-for-byte at all.
function timingSafeEqualBytes(a, b) {
  if (!(a instanceof Uint8Array) || !(b instanceof Uint8Array)) return false;
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a[i] ^ b[i];
  return diff === 0;
}

/* ============================================================
   PBKDF2-HMAC-SHA-256 VERIFIER DERIVATION -- the one pure crypto function
   in this file. Never trims, never lowercases, never normalizes `input` --
   whatever string is passed is encoded exactly as UTF-8 bytes. Exported
   so tests can exercise the algorithm/parameter shape (PBKDF2, SHA-256,
   deterministic, length-correct) against a disposable fixture key,
   without ever needing the production key or the production verifier.
============================================================ */
export async function deriveVerifierBits(input, { saltBytes, iterations, keyLengthBits }) {
  if (typeof input !== 'string' || input.length === 0) {
    throw new TypeError('deriveVerifierBits: input must be a non-empty string');
  }
  if (!(saltBytes instanceof Uint8Array) || saltBytes.length === 0) {
    throw new TypeError('deriveVerifierBits: saltBytes must be a non-empty Uint8Array');
  }
  if (!Number.isInteger(iterations) || iterations <= 0) {
    throw new TypeError('deriveVerifierBits: iterations must be a positive integer');
  }
  if (!Number.isInteger(keyLengthBits) || keyLengthBits <= 0) {
    throw new TypeError('deriveVerifierBits: keyLengthBits must be a positive integer');
  }

  const subtle = globalThis.crypto && globalThis.crypto.subtle;
  if (!subtle) throw new Error('deriveVerifierBits: Web Crypto (crypto.subtle) is not available in this environment');

  const keyMaterial = await subtle.importKey('raw', new TextEncoder().encode(input), 'PBKDF2', false, ['deriveBits']);
  const bits = await subtle.deriveBits(
    { name: 'PBKDF2', salt: saltBytes, iterations, hash: 'SHA-256' },
    keyMaterial,
    keyLengthBits,
  );
  return new Uint8Array(bits);
}

/* ============================================================
   FACTORY -- pure, no module-level mutable state. The production
   singleton below is one instance of this; tests build their own with
   fixture parameters and a mock storage (see tests/license-service.test.mjs).
============================================================ */
export function createLicenseService({
  storageKey = STORAGE_KEY,
  schemaVersion = SCHEMA_VERSION,
  verifierVersion,
  saltBytes,
  iterations,
  keyLengthBits,
  expectedVerifierBytes,
  getStorage = defaultGetStorage,
} = {}) {
  let tier = ACCESS_TIERS.MONITOR_ONLY;
  let installedAt = null;
  let lastVerifiedAt = null;
  const listeners = new Set();

  function isPlainObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
  }

  function nowIso() {
    return new Date().toISOString();
  }

  function getStatus() {
    return { tier, installedAt, lastVerifiedAt };
  }

  function notify() {
    const status = getStatus();
    listeners.forEach((fn) => {
      try {
        fn(status);
      } catch (_) {
        // A misbehaving subscriber must never break license state for
        // every other subscriber (same posture as
        // app-preferences-service.js's notify()).
      }
    });
  }

  // Reads + validates the stored record. Returns null for "no license" AND
  // for "a license-shaped value exists but fails validation" alike -- the
  // caller (initializeLicense) is responsible for distinguishing "nothing
  // stored" from "something stored but invalid" if it needs to (it does,
  // to decide whether to actively clear the corrupted value). A bare
  // `{ isLicensed: true }`-style boolean is never sufficient here: every
  // field below (schemaVersion, verifierVersion, and the proof bytes
  // themselves, compared against expectedVerifierBytes) must independently
  // check out.
  function readStoredRecord() {
    const storage = getStorage();
    if (!storage) return { present: false, valid: null };

    let raw;
    try {
      raw = storage.getItem(storageKey);
    } catch (_) {
      return { present: false, valid: null };
    }
    if (!raw) return { present: false, valid: null };

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (_) {
      return { present: true, valid: null };
    }

    if (!isPlainObject(parsed)) return { present: true, valid: null };
    if (parsed.schemaVersion !== schemaVersion) return { present: true, valid: null };
    if (parsed.verifierVersion !== verifierVersion) return { present: true, valid: null };
    if (typeof parsed.proof !== 'string' || !parsed.proof) return { present: true, valid: null };
    if (typeof parsed.installedAt !== 'string' || !parsed.installedAt) return { present: true, valid: null };
    if (typeof parsed.lastVerifiedAt !== 'string' || !parsed.lastVerifiedAt) return { present: true, valid: null };

    let proofBytes;
    try {
      proofBytes = base64ToBytes(parsed.proof);
    } catch (_) {
      return { present: true, valid: null };
    }

    if (!timingSafeEqualBytes(proofBytes, expectedVerifierBytes)) return { present: true, valid: null };

    return { present: true, valid: parsed };
  }

  function saveRecord(record) {
    const storage = getStorage();
    if (!storage) return false;
    try {
      storage.setItem(storageKey, JSON.stringify(record));
    } catch (_) {
      return false;
    }
    return true;
  }

  function clearStoredRecord() {
    const storage = getStorage();
    if (!storage) return;
    try {
      storage.removeItem(storageKey);
    } catch (_) {
      // Ignored -- best-effort clear only, same posture as every other
      // *-service.js cache clear in this codebase.
    }
  }

  // Called once at bootstrap (see js/app.js). Re-derives the access tier
  // from raw storage every time -- never trusts an in-memory flag left
  // over from a previous call. A present-but-invalid/corrupted record is
  // actively removed so a tampered or stale value never lingers as dead
  // weight; an absent record is simply left absent.
  function initializeLicense() {
    const { present, valid } = readStoredRecord();

    if (valid) {
      tier = ACCESS_TIERS.FULL_ACCESS;
      installedAt = valid.installedAt;
      lastVerifiedAt = valid.lastVerifiedAt;
    } else {
      if (present) clearStoredRecord();
      tier = ACCESS_TIERS.MONITOR_ONLY;
      installedAt = null;
      lastVerifiedAt = null;
    }

    return tier;
  }

  function getAccessTier() {
    return tier;
  }

  function hasFullAccess() {
    return tier === ACCESS_TIERS.FULL_ACCESS;
  }

  // Verifies `input` (the exact, untrimmed string the user typed) against
  // this instance's configured verifier. On success, installs a local
  // proof (the derived verifier bytes themselves, base64-encoded -- a
  // one-way PBKDF2 output, not the plaintext and not anything that can
  // recover it) and flips to FULL_ACCESS immediately, without a reload.
  // Never logs, and never returns the entered string in any form.
  async function verifyAndInstallLicense(input) {
    if (typeof input !== 'string' || input.length === 0) {
      return { ok: false, error: { code: 'INVALID_INPUT' } };
    }

    let derived;
    try {
      derived = await deriveVerifierBits(input, { saltBytes, iterations, keyLengthBits });
    } catch (_) {
      return { ok: false, error: { code: 'VERIFICATION_FAILED' } };
    }

    if (!timingSafeEqualBytes(derived, expectedVerifierBytes)) {
      return { ok: false, error: { code: 'INVALID_LICENSE' } };
    }

    const ts = nowIso();
    const record = {
      schemaVersion,
      verifierVersion,
      proof: bytesToBase64(derived),
      installedAt: ts,
      lastVerifiedAt: ts,
    };
    saveRecord(record);

    tier = ACCESS_TIERS.FULL_ACCESS;
    installedAt = ts;
    lastVerifiedAt = ts;
    notify();

    return { ok: true };
  }

  // Deletes the local proof and returns immediately to MONITOR_ONLY.
  // Deliberately touches only `storageKey` -- language/appearance
  // preferences, the personnel directory cache, and the offline personnel
  // write queue all live under their own separate storage keys and are
  // never cleared here (see settings-page.js's removal handler and
  // personnel-directory-service.js/personnel-write-queue.js's own guards
  // for what stays dormant-but-intact under MONITOR_ONLY).
  function removeLicense() {
    clearStoredRecord();
    tier = ACCESS_TIERS.MONITOR_ONLY;
    installedAt = null;
    lastVerifiedAt = null;
    notify();
  }

  function subscribeAccessChange(callback) {
    listeners.add(callback);
    return () => listeners.delete(callback);
  }

  return {
    initializeLicense,
    getAccessTier,
    hasFullAccess,
    getStatus,
    verifyAndInstallLicense,
    removeLicense,
    subscribeAccessChange,
  };
}

function defaultGetStorage() {
  try {
    return globalThis.localStorage || null;
  } catch (_) {
    return null;
  }
}

/* ============================================================
   PRODUCTION CONFIGURATION -- salt, iteration count, and expected verifier
   for the one Owner-held V2.3 access key. Generated once, offline, from
   the plaintext key (never itself present here or anywhere else in this
   repository -- see the architecture doc's "Owner-held V2.3 access key"
   section for how/where this was produced). PBKDF2-HMAC-SHA-256, 210,000
   iterations, 256-bit derived output -- a reasonable browser-safe
   baseline, comfortably above common floors (e.g. OWASP's 2023 PBKDF2-
   HMAC-SHA256 minimum of 600,000 is for *password hashing at rest on a
   server*; this is a client-side, single-verification, no-account gate,
   so 210,000 keeps unlock interactive on low-end mobile while still being
   far beyond a trivial brute-force budget for a human-chosen passphrase
   of this length/complexity).
============================================================ */
const PRODUCTION_VERIFIER_VERSION = 1;
const PRODUCTION_ITERATIONS = 210000;
const PRODUCTION_KEY_LENGTH_BITS = 256;
// Fixed public salt (base64) -- public by design (Web Crypto/PBKDF2 salts
// are not secrets; they only need to be fixed and unique to this
// verifier), generated once via a CSPRNG, never derived from the key.
const PRODUCTION_SALT_B64 = '3yvjCkkkYhR7ECeYAmvyOQ==';
// Expected verifier (base64) -- PBKDF2-HMAC-SHA-256 output for the
// Owner-held access key under the salt/iterations above. This is a
// one-way derived value: it cannot be used to recover the plaintext key,
// per Web Crypto's PBKDF2 guarantees.
const PRODUCTION_EXPECTED_VERIFIER_B64 = 'bNdcc3pYwd5s1X300L3sjTTbD6T6USck0BiepE8XgVk=';

const productionService = createLicenseService({
  verifierVersion: PRODUCTION_VERIFIER_VERSION,
  saltBytes: base64ToBytes(PRODUCTION_SALT_B64),
  iterations: PRODUCTION_ITERATIONS,
  keyLengthBits: PRODUCTION_KEY_LENGTH_BITS,
  expectedVerifierBytes: base64ToBytes(PRODUCTION_EXPECTED_VERIFIER_B64),
});

export function initializeLicense() {
  return productionService.initializeLicense();
}

export function getAccessTier() {
  return productionService.getAccessTier();
}

export function hasFullAccess() {
  return productionService.hasFullAccess();
}

export function getLicenseStatus() {
  return productionService.getStatus();
}

export function verifyAndInstallLicense(input) {
  return productionService.verifyAndInstallLicense(input);
}

export function removeLicense() {
  return productionService.removeLicense();
}

export function subscribeAccessChange(callback) {
  return productionService.subscribeAccessChange(callback);
}

// Test-only helper: builds a storage record that verifies as valid against
// the PRODUCTION verifier/version, WITHOUT ever needing the real plaintext
// key. This is safe to export because the expected verifier is a one-way
// PBKDF2 output, not a secret -- it is already present, in the clear, in
// this very module's PRODUCTION_EXPECTED_VERIFIER_B64 constant above (and
// therefore already readable by anyone who fetches the shipped JS bundle,
// with or without this export). It lets other test files (e.g. router/
// personnel action-guard tests exercising "what happens once FULL_ACCESS
// is installed") set up that end state directly via
// globalThis.localStorage, the same way a real successful unlock would
// leave storage, without importing or reconstructing the actual key.
// Never imported by any production (non-test) module.
export function _buildValidLicenseRecordForTests(installedAt = new Date().toISOString()) {
  return {
    schemaVersion: SCHEMA_VERSION,
    verifierVersion: PRODUCTION_VERIFIER_VERSION,
    proof: PRODUCTION_EXPECTED_VERIFIER_B64,
    installedAt,
    lastVerifiedAt: installedAt,
  };
}

/* ============================================================
   FULL-ACCESS ATTENTION SIGNAL -- a small, separate pub/sub (not license
   state) so any module that independently discovers a denied FULL_ACCESS
   attempt (router.js's route guard in app.js, report-page.js's own
   action-boundary guards) can ask Settings to open/focus its License card
   and show the "requires Full Access" message, without report-page.js or
   app.js needing to import settings-page.js directly -- both already
   depend on this module, so this keeps the dependency graph one-directional
   (pages -> services, never page -> page). Settings-page.js is the sole
   subscriber; the emitted `context` string is only used for an optional
   analytics-free log-free distinction and is never required.
============================================================ */
const attentionListeners = new Set();

export function requestFullAccessAttention(context) {
  attentionListeners.forEach((fn) => {
    try {
      fn(context);
    } catch (_) {
      // A misbehaving subscriber must never break navigation/redirection.
    }
  });
}

export function subscribeFullAccessAttention(callback) {
  attentionListeners.add(callback);
  return () => attentionListeners.delete(callback);
}
