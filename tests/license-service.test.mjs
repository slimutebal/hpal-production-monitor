// license-service.js tests (V2.3 Phase 8, Simple Local License and Access
// Control).
//
// Run with Node's built-in test runner:
//
//   node --test tests/license-service.test.mjs
//
// CRITICAL: this file must NEVER contain the real production access key,
// its salt, or its expected-verifier constant. Every test below builds
// its OWN createLicenseService() instance against a disposable FIXTURE
// key ('unit-test-fixture-key-Do-Not-Use!') and a fixture salt/verifier
// derived from it at test time -- never the production singleton's
// module-level constants. This exercises the exact same code path
// (PBKDF2-HMAC-SHA-256 via crypto.subtle, storage schema, tier
// derivation, pub/sub) the production instance uses, without the test
// suite ever needing to know the real key. A separate, manual,
// repository-wide grep (not this file) is what actually proves the real
// key is absent from tracked source.
//
// Node's built-in `crypto.subtle` (global since Node 19, stable since
// Node 20) is used as-is -- no mocked Web Crypto implementation.

import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { createLicenseService, deriveVerifierBits, ACCESS_TIERS } from '../js/services/license-service.js';

const FIXTURE_KEY = 'unit-test-fixture-key-Do-Not-Use!';
const FIXTURE_SALT = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);
const FIXTURE_ITERATIONS = 1000; // low on purpose -- fast tests, never used for real security
const FIXTURE_KEY_LENGTH_BITS = 256;
const FIXTURE_VERIFIER_VERSION = 1;

function createMockStorage() {
  const map = new Map();
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => {
      map.set(key, String(value));
    },
    removeItem: (key) => {
      map.delete(key);
    },
    _dump: () => Object.fromEntries(map),
  };
}

let fixtureExpectedVerifierBytes;

async function makeService(overrides = {}) {
  const storage = overrides.storage || createMockStorage();
  const service = createLicenseService({
    verifierVersion: FIXTURE_VERIFIER_VERSION,
    saltBytes: FIXTURE_SALT,
    iterations: FIXTURE_ITERATIONS,
    keyLengthBits: FIXTURE_KEY_LENGTH_BITS,
    expectedVerifierBytes: fixtureExpectedVerifierBytes,
    getStorage: () => storage,
    ...overrides,
  });
  return { service, storage };
}

// Computed once, before any test runs, from the FIXTURE key -- this is the
// only place FIXTURE_KEY's derived bytes are produced; every test below
// treats the result as an opaque "expected verifier" constant, exactly
// like license-service.js's own production module does with its (real,
// never-present-here) constant.
test.before(async () => {
  fixtureExpectedVerifierBytes = await deriveVerifierBits(FIXTURE_KEY, {
    saltBytes: FIXTURE_SALT,
    iterations: FIXTURE_ITERATIONS,
    keyLengthBits: FIXTURE_KEY_LENGTH_BITS,
  });
});

describe('deriveVerifierBits() -- pure PBKDF2-HMAC-SHA-256 mechanics', () => {
  test('produces keyLengthBits/8 bytes', async () => {
    const bits = await deriveVerifierBits('any-input', { saltBytes: FIXTURE_SALT, iterations: 1000, keyLengthBits: 256 });
    assert.equal(bits.length, 32);
    const bits128 = await deriveVerifierBits('any-input', { saltBytes: FIXTURE_SALT, iterations: 1000, keyLengthBits: 128 });
    assert.equal(bits128.length, 16);
  });

  test('deterministic -- same input/salt/iterations always derive the same bytes', async () => {
    const a = await deriveVerifierBits('same-input', { saltBytes: FIXTURE_SALT, iterations: 1000, keyLengthBits: 256 });
    const b = await deriveVerifierBits('same-input', { saltBytes: FIXTURE_SALT, iterations: 1000, keyLengthBits: 256 });
    assert.deepEqual([...a], [...b]);
  });

  test('a different input derives different bytes', async () => {
    const a = await deriveVerifierBits('input-one', { saltBytes: FIXTURE_SALT, iterations: 1000, keyLengthBits: 256 });
    const b = await deriveVerifierBits('input-two', { saltBytes: FIXTURE_SALT, iterations: 1000, keyLengthBits: 256 });
    assert.notDeepEqual([...a], [...b]);
  });

  test('a different salt derives different bytes for the same input', async () => {
    const otherSalt = new Uint8Array([16, 15, 14, 13, 12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1]);
    const a = await deriveVerifierBits('same-input', { saltBytes: FIXTURE_SALT, iterations: 1000, keyLengthBits: 256 });
    const b = await deriveVerifierBits('same-input', { saltBytes: otherSalt, iterations: 1000, keyLengthBits: 256 });
    assert.notDeepEqual([...a], [...b]);
  });

  test('a single leading or trailing space changes the derived bytes (no implicit trim)', async () => {
    const exact = await deriveVerifierBits('MyKey123!', { saltBytes: FIXTURE_SALT, iterations: 1000, keyLengthBits: 256 });
    const leading = await deriveVerifierBits(' MyKey123!', { saltBytes: FIXTURE_SALT, iterations: 1000, keyLengthBits: 256 });
    const trailing = await deriveVerifierBits('MyKey123! ', { saltBytes: FIXTURE_SALT, iterations: 1000, keyLengthBits: 256 });
    assert.notDeepEqual([...exact], [...leading]);
    assert.notDeepEqual([...exact], [...trailing]);
  });

  test('case-sensitive -- a different case derives different bytes', async () => {
    const lower = await deriveVerifierBits('mykey123!', { saltBytes: FIXTURE_SALT, iterations: 1000, keyLengthBits: 256 });
    const mixed = await deriveVerifierBits('MyKey123!', { saltBytes: FIXTURE_SALT, iterations: 1000, keyLengthBits: 256 });
    assert.notDeepEqual([...lower], [...mixed]);
  });

  test('uses PBKDF2 + SHA-256 via crypto.subtle (parameter/format assertion, not the real key)', async () => {
    const originalDeriveBits = globalThis.crypto.subtle.deriveBits.bind(globalThis.crypto.subtle);
    let capturedAlgorithm = null;
    globalThis.crypto.subtle.deriveBits = async (algorithm, key, length) => {
      capturedAlgorithm = algorithm;
      return originalDeriveBits(algorithm, key, length);
    };
    try {
      await deriveVerifierBits('probe', { saltBytes: FIXTURE_SALT, iterations: 1000, keyLengthBits: 256 });
    } finally {
      globalThis.crypto.subtle.deriveBits = originalDeriveBits;
    }
    assert.equal(capturedAlgorithm.name, 'PBKDF2');
    assert.equal(capturedAlgorithm.hash, 'SHA-256');
    assert.equal(capturedAlgorithm.iterations, 1000);
  });

  test('rejects an empty input string', async () => {
    await assert.rejects(() => deriveVerifierBits('', { saltBytes: FIXTURE_SALT, iterations: 1000, keyLengthBits: 256 }));
  });
});

describe('createLicenseService() -- default state', () => {
  test('1. default access tier is MONITOR_ONLY with nothing stored', async () => {
    const { service } = await makeService();
    assert.equal(service.initializeLicense(), ACCESS_TIERS.MONITOR_ONLY);
    assert.equal(service.getAccessTier(), ACCESS_TIERS.MONITOR_ONLY);
    assert.equal(service.hasFullAccess(), false);
  });
});

describe('verifyAndInstallLicense() -- verification', () => {
  test('2. the exact fixture key verifies -> FULL_ACCESS', async () => {
    const { service } = await makeService();
    service.initializeLicense();
    const result = await service.verifyAndInstallLicense(FIXTURE_KEY);
    assert.equal(result.ok, true);
    assert.equal(service.getAccessTier(), ACCESS_TIERS.FULL_ACCESS);
    assert.equal(service.hasFullAccess(), true);
  });

  test('3. an invalid key stays MONITOR_ONLY', async () => {
    const { service } = await makeService();
    service.initializeLicense();
    const result = await service.verifyAndInstallLicense('definitely-the-wrong-key');
    assert.equal(result.ok, false);
    assert.equal(service.getAccessTier(), ACCESS_TIERS.MONITOR_ONLY);
  });

  test('4. verification is exact/case-sensitive -- a case-differing key is rejected', async () => {
    const { service } = await makeService();
    service.initializeLicense();
    const wrongCase = FIXTURE_KEY.toUpperCase() === FIXTURE_KEY ? FIXTURE_KEY.toLowerCase() : FIXTURE_KEY.toUpperCase();
    const result = await service.verifyAndInstallLicense(wrongCase);
    assert.equal(result.ok, false);
    assert.equal(service.getAccessTier(), ACCESS_TIERS.MONITOR_ONLY);
  });

  test('5. leading whitespace is rejected (never silently trimmed)', async () => {
    const { service } = await makeService();
    service.initializeLicense();
    const result = await service.verifyAndInstallLicense(` ${FIXTURE_KEY}`);
    assert.equal(result.ok, false);
    assert.equal(service.getAccessTier(), ACCESS_TIERS.MONITOR_ONLY);
  });

  test('6. trailing whitespace is rejected (never silently trimmed)', async () => {
    const { service } = await makeService();
    service.initializeLicense();
    const result = await service.verifyAndInstallLicense(`${FIXTURE_KEY} `);
    assert.equal(result.ok, false);
    assert.equal(service.getAccessTier(), ACCESS_TIERS.MONITOR_ONLY);
  });

  test('7. the plaintext key is never present in what gets stored', async () => {
    const { service, storage } = await makeService();
    service.initializeLicense();
    await service.verifyAndInstallLicense(FIXTURE_KEY);
    const raw = storage.getItem('hpal.license.v1');
    assert.ok(raw, 'expected a stored license record');
    assert.ok(!raw.includes(FIXTURE_KEY), 'stored record must never contain the plaintext key');
    const parsed = JSON.parse(raw);
    assert.notEqual(parsed.proof, FIXTURE_KEY);
  });

  test('19. the stored schema carries only schemaVersion/verifierVersion/proof/installedAt/lastVerifiedAt -- no plaintext field', async () => {
    const { service, storage } = await makeService();
    service.initializeLicense();
    await service.verifyAndInstallLicense(FIXTURE_KEY);
    const parsed = JSON.parse(storage.getItem('hpal.license.v1'));
    assert.deepEqual(Object.keys(parsed).sort(), ['installedAt', 'lastVerifiedAt', 'proof', 'schemaVersion', 'verifierVersion'].sort());
  });

  test('18. verifyAndInstallLicense()\'s resolved value never echoes the entered plaintext back', async () => {
    const { service } = await makeService();
    service.initializeLicense();
    const result = await service.verifyAndInstallLicense(FIXTURE_KEY);
    assert.equal(JSON.stringify(result).includes(FIXTURE_KEY), false);
  });
});

describe('Storage roundtrip / persistence', () => {
  test('8. proof survives a storage roundtrip -- a fresh instance sharing the same storage restores FULL_ACCESS', async () => {
    const storage = createMockStorage();
    const { service: first } = await makeService({ storage });
    first.initializeLicense();
    await first.verifyAndInstallLicense(FIXTURE_KEY);

    const { service: second } = await makeService({ storage });
    assert.equal(second.initializeLicense(), ACCESS_TIERS.FULL_ACCESS);
  });

  test('9. a directly-written valid proof restores FULL_ACCESS on initializeLicense()', async () => {
    const storage = createMockStorage();
    const validRecord = {
      schemaVersion: 1,
      verifierVersion: FIXTURE_VERIFIER_VERSION,
      proof: Buffer.from(fixtureExpectedVerifierBytes).toString('base64'),
      installedAt: '2026-01-01T00:00:00.000Z',
      lastVerifiedAt: '2026-01-01T00:00:00.000Z',
    };
    storage.setItem('hpal.license.v1', JSON.stringify(validRecord));

    const { service } = await makeService({ storage });
    assert.equal(service.initializeLicense(), ACCESS_TIERS.FULL_ACCESS);
  });

  test('10. a corrupted/mismatched proof resets to MONITOR_ONLY and clears storage', async () => {
    const storage = createMockStorage();
    storage.setItem('hpal.license.v1', JSON.stringify({
      schemaVersion: 1,
      verifierVersion: FIXTURE_VERIFIER_VERSION,
      proof: 'not-the-real-verifier-bytes-at-all',
      installedAt: '2026-01-01T00:00:00.000Z',
      lastVerifiedAt: '2026-01-01T00:00:00.000Z',
    }));

    const { service } = await makeService({ storage });
    assert.equal(service.initializeLicense(), ACCESS_TIERS.MONITOR_ONLY);
    assert.equal(storage.getItem('hpal.license.v1'), null, 'corrupted record must be actively removed');
  });

  test('11. a wrong verifierVersion resets to MONITOR_ONLY', async () => {
    const storage = createMockStorage();
    storage.setItem('hpal.license.v1', JSON.stringify({
      schemaVersion: 1,
      verifierVersion: FIXTURE_VERIFIER_VERSION + 1,
      proof: Buffer.from(fixtureExpectedVerifierBytes).toString('base64'),
      installedAt: '2026-01-01T00:00:00.000Z',
      lastVerifiedAt: '2026-01-01T00:00:00.000Z',
    }));

    const { service } = await makeService({ storage });
    assert.equal(service.initializeLicense(), ACCESS_TIERS.MONITOR_ONLY);
  });

  test('20. a bare {isLicensed:true}-shaped record is never trusted as proof', async () => {
    const storage = createMockStorage();
    storage.setItem('hpal.license.v1', JSON.stringify({ isLicensed: true }));

    const { service } = await makeService({ storage });
    assert.equal(service.initializeLicense(), ACCESS_TIERS.MONITOR_ONLY);
  });

  test('malformed JSON in storage never throws, resets to MONITOR_ONLY', async () => {
    const storage = createMockStorage();
    storage.setItem('hpal.license.v1', '{not valid json');

    const { service } = await makeService({ storage });
    assert.doesNotThrow(() => {
      assert.equal(service.initializeLicense(), ACCESS_TIERS.MONITOR_ONLY);
    });
  });
});

describe('removeLicense()', () => {
  test('12. removeLicense() returns to MONITOR_ONLY and deletes the stored record', async () => {
    const { service, storage } = await makeService();
    service.initializeLicense();
    await service.verifyAndInstallLicense(FIXTURE_KEY);
    assert.equal(service.hasFullAccess(), true);

    service.removeLicense();
    assert.equal(service.getAccessTier(), ACCESS_TIERS.MONITOR_ONLY);
    assert.equal(storage.getItem('hpal.license.v1'), null);
  });

  test('13. removal only ever touches its own storage key, never unrelated keys', async () => {
    const storage = createMockStorage();
    storage.setItem('hpal.preferences.v1', JSON.stringify({ schemaVersion: 1, locale: 'en', appearance: 'dark' }));

    const { service } = await makeService({ storage });
    service.initializeLicense();
    await service.verifyAndInstallLicense(FIXTURE_KEY);
    service.removeLicense();

    assert.equal(storage.getItem('hpal.preferences.v1'), JSON.stringify({ schemaVersion: 1, locale: 'en', appearance: 'dark' }));
  });
});

describe('subscribeAccessChange()', () => {
  test('14. a subscriber fires on install and on removal', async () => {
    const { service } = await makeService();
    service.initializeLicense();

    const seen = [];
    service.subscribeAccessChange((status) => seen.push(status.tier));

    await service.verifyAndInstallLicense(FIXTURE_KEY);
    service.removeLicense();

    assert.deepEqual(seen, [ACCESS_TIERS.FULL_ACCESS, ACCESS_TIERS.MONITOR_ONLY]);
  });

  test('15. the returned unsubscribe function stops further notifications', async () => {
    const { service } = await makeService();
    service.initializeLicense();

    const seen = [];
    const unsubscribe = service.subscribeAccessChange((status) => seen.push(status.tier));
    unsubscribe();

    await service.verifyAndInstallLicense(FIXTURE_KEY);
    assert.deepEqual(seen, []);
  });

  test('a failed verification does not notify subscribers', async () => {
    const { service } = await makeService();
    service.initializeLicense();

    const seen = [];
    service.subscribeAccessChange((status) => seen.push(status.tier));
    await service.verifyAndInstallLicense('wrong-key');

    assert.deepEqual(seen, []);
  });
});

describe('Environment/behavior guarantees', () => {
  test('16. no network call is made anywhere in this module (no fetch usage)', async () => {
    const originalFetch = globalThis.fetch;
    let fetchCalled = false;
    globalThis.fetch = async (...args) => {
      fetchCalled = true;
      throw new Error('fetch should never be called by license-service.js');
    };
    try {
      const { service } = await makeService();
      service.initializeLicense();
      await service.verifyAndInstallLicense(FIXTURE_KEY);
      service.removeLicense();
    } finally {
      globalThis.fetch = originalFetch;
    }
    assert.equal(fetchCalled, false);
  });

  test('getStatus() exposes only tier/installedAt/lastVerifiedAt -- no token/plaintext field', async () => {
    const { service } = await makeService();
    service.initializeLicense();
    await service.verifyAndInstallLicense(FIXTURE_KEY);
    const status = service.getStatus();
    assert.deepEqual(Object.keys(status).sort(), ['installedAt', 'lastVerifiedAt', 'tier']);
  });
});
