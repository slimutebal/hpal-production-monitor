// In-app PWA update lifecycle tests (v3.1.1 -- js/services/app-update-service.js).
//
// Run with Node's built-in test runner:
//
//   node --test tests/app-update-service.test.mjs
//
// The controller is written against an injectable environment, so the full
// browser lifecycle -- getRegistration(), registration.update(),
// updatefound, installing/waiting workers, statechange, controllerchange,
// SKIP_WAITING, the GET_VERSION handshake, and location.reload() -- is
// driven here through small in-memory fakes, with manual timers. No real
// browser or service worker is involved: these prove the controller's
// decisions, not any particular browser's behavior (see the manual
// acceptance checklist in the release notes for on-device verification).

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import {
  createAppUpdateController,
  compareVersions,
  parseVersion,
  UPDATE_STATUS,
  UPDATE_ERROR,
  SW_MESSAGE,
  PENDING_UPDATE_STORAGE_KEY,
} from '../js/services/app-update-service.js';
import { APP_VERSION } from '../js/shared/app-version.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

/* ============================================================
   FAKES
============================================================ */
class FakeEventTarget {
  constructor() {
    this.listeners = new Map();
  }
  addEventListener(type, fn) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(fn);
  }
  removeEventListener(type, fn) {
    if (this.listeners.has(type)) this.listeners.get(type).delete(fn);
  }
  dispatch(type, event = {}) {
    [...(this.listeners.get(type) || [])].forEach((fn) => fn(event));
  }
  listenerCount(type) {
    return this.listeners.has(type) ? this.listeners.get(type).size : 0;
  }
}

class FakeWorker extends FakeEventTarget {
  constructor({ state = 'installing', version = null, respondToVersion = true } = {}) {
    super();
    this.state = state;
    this.version = version;
    this.respondToVersion = respondToVersion;
    this.messages = [];
  }
  postMessage(message, transfer) {
    this.messages.push(message);
    if (message.type === SW_MESSAGE.GET_VERSION && this.respondToVersion && transfer && transfer[0]) {
      const port = transfer[0];
      queueMicrotask(() => port.postMessage({ type: SW_MESSAGE.VERSION, version: this.version }));
    }
  }
  setState(state) {
    this.state = state;
    this.dispatch('statechange');
  }
}

class FakeMessageChannel {
  constructor() {
    const port1 = { onmessage: null, closed: false, close() { this.closed = true; } };
    const port2 = {
      postMessage(data) {
        if (!port1.closed && typeof port1.onmessage === 'function') port1.onmessage({ data });
      },
    };
    this.port1 = port1;
    this.port2 = port2;
  }
}

class FakeRegistration extends FakeEventTarget {
  constructor({ active = new FakeWorker({ state: 'activated', version: APP_VERSION }) } = {}) {
    super();
    this.active = active;
    this.installing = null;
    this.waiting = null;
    this.updateCalls = 0;
    this.updateImpl = async () => {};
  }
  async update() {
    this.updateCalls += 1;
    return this.updateImpl(this);
  }
  // Simulates the browser finding a byte-different service-worker.js.
  startInstall(worker) {
    this.installing = worker;
    this.dispatch('updatefound');
  }
  finishInstall() {
    const worker = this.installing;
    this.installing = null;
    if (this.active) this.waiting = worker;
    worker.setState('installed');
  }
}

class FakeContainer extends FakeEventTarget {
  constructor(registration) {
    super();
    this.registration = registration;
    this.controller = registration ? registration.active : null;
    this.getRegistrationCalls = 0;
    this.ready = registration ? Promise.resolve(registration) : new Promise(() => {});
  }
  async getRegistration() {
    this.getRegistrationCalls += 1;
    return this.registration || undefined;
  }
  // The browser activating a waiting worker after SKIP_WAITING.
  takeOver(worker) {
    this.registration.active = worker;
    this.registration.waiting = null;
    worker.setState('activated');
    this.controller = worker;
    this.dispatch('controllerchange');
  }
}

function createFakeTimers() {
  let nextId = 1;
  const pending = new Map();
  return {
    setTimeout: (fn, ms) => {
      const id = nextId++;
      pending.set(id, { fn, ms });
      return id;
    },
    clearTimeout: (id) => pending.delete(id),
    runAll() {
      const entries = [...pending.entries()];
      pending.clear();
      entries.forEach(([, entry]) => entry.fn());
    },
    get count() {
      return pending.size;
    },
  };
}

function createMemoryStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
    clear: () => { throw new Error('clear() must never be called by the updater'); },
    _map: map,
  };
}

function setup({ registration = new FakeRegistration(), online = true, swSupported = true, installedVersion = 'v3.1.1', storage = createMemoryStorage(), now } = {}) {
  const container = swSupported ? new FakeContainer(registration) : null;
  const navigatorRef = swSupported ? { onLine: online, serviceWorker: container } : { onLine: online };
  const timers = createFakeTimers();
  const reloads = [];
  let clock = now ?? 1_000_000;
  const states = [];
  const controller = createAppUpdateController({
    navigator: navigatorRef,
    installedVersion,
    reload: () => reloads.push(Date.now()),
    sessionStorage: storage,
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
    now: () => clock,
    MessageChannel: FakeMessageChannel,
  });
  controller.subscribe((s) => states.push(s.status));
  return {
    controller,
    container,
    registration,
    navigatorRef,
    timers,
    reloads,
    storage,
    states,
    advance(ms) { clock += ms; },
  };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

async function reachReady(env, version = 'v3.2.0') {
  const worker = new FakeWorker({ version });
  env.registration.updateImpl = async (reg) => reg.startInstall(worker);
  await env.controller.checkForUpdates();
  env.registration.finishInstall();
  await flush();
  return worker;
}

/* ============================================================
   SEMVER
============================================================ */
describe('compareVersions() -- semantic version precedence', () => {
  test('orders major/minor/patch numerically, not lexically', () => {
    assert.equal(compareVersions('v3.1.1', 'v3.1.0'), 1);
    assert.equal(compareVersions('v3.1.0', 'v3.1.1'), -1);
    assert.equal(compareVersions('v3.10.0', 'v3.9.9'), 1);
    assert.equal(compareVersions('v10.0.0', 'v9.99.99'), 1);
    assert.equal(compareVersions('v3.1.1', '3.1.1'), 0);
  });

  test('prerelease sorts below its release; identifiers follow SemVer 2.0.0 rules', () => {
    assert.equal(compareVersions('v3.2.0-rc.1', 'v3.2.0'), -1);
    assert.equal(compareVersions('v3.2.0-rc.2', 'v3.2.0-rc.10'), -1);
    assert.equal(compareVersions('v3.2.0-alpha', 'v3.2.0-alpha.1'), -1);
    assert.equal(compareVersions('v3.2.0-1', 'v3.2.0-alpha'), -1);
    assert.equal(compareVersions('v3.2.0+build.5', 'v3.2.0'), 0);
  });

  test('invalid input never compares as equal', () => {
    assert.ok(Number.isNaN(compareVersions('latest', 'v3.1.1')));
    assert.ok(Number.isNaN(compareVersions('v3.1', 'v3.1.0')));
    assert.ok(Number.isNaN(compareVersions(undefined, 'v3.1.0')));
    assert.equal(parseVersion('v03.1.0'), null);
  });

  test('the canonical APP_VERSION is itself a valid semantic version', () => {
    assert.ok(parseVersion(APP_VERSION));
  });
});

/* ============================================================
   1. INSTALLED VERSION
============================================================ */
describe('1. Installed version display', () => {
  test('the controller reports the canonical APP_VERSION by default', () => {
    const controller = createAppUpdateController({ navigator: { onLine: true }, sessionStorage: null });
    assert.equal(controller.getState().installedVersion, APP_VERSION);
    assert.equal(controller.getState().status, UPDATE_STATUS.IDLE);
    assert.equal(controller.getState().latestVersion, null);
  });
});

/* ============================================================
   2-4. DETECTION
============================================================ */
describe('2-4. Update detection', () => {
  test('3. no update: update() is called and finds nothing -> CURRENT, latest == installed', async () => {
    const env = setup();
    const state = await env.controller.checkForUpdates();
    assert.equal(env.registration.updateCalls, 1);
    assert.equal(state.status, UPDATE_STATUS.CURRENT);
    assert.equal(state.latestVersion, 'v3.1.1');
    assert.equal(env.states[0], UPDATE_STATUS.CHECKING);
    assert.equal(env.states.at(-1), UPDATE_STATUS.CURRENT);
    assert.ok(!env.states.includes(UPDATE_STATUS.READY));
    assert.equal(typeof state.lastCheckedAt, 'number');
  });

  test('4. update available: AVAILABLE -> DOWNLOADING while installing, READY only once installed', async () => {
    const env = setup();
    const worker = new FakeWorker({ version: 'v3.2.0' });
    env.registration.updateImpl = async (reg) => reg.startInstall(worker);

    const state = await env.controller.checkForUpdates();
    assert.equal(state.status, UPDATE_STATUS.DOWNLOADING);
    assert.ok(env.states.includes(UPDATE_STATUS.AVAILABLE));
    assert.ok(env.states.indexOf(UPDATE_STATUS.AVAILABLE) < env.states.indexOf(UPDATE_STATUS.DOWNLOADING));
    assert.equal(env.controller.getState().latestVersion, null, 'latest version is not claimed before installation completes');

    env.registration.finishInstall();
    await flush();
    assert.equal(env.controller.getState().status, UPDATE_STATUS.READY);
  });

  test('2. latest version is read from the installed waiting worker (GET_VERSION handshake)', async () => {
    const env = setup();
    const worker = await reachReady(env, 'v3.2.0');
    assert.deepEqual(worker.messages.map((m) => m.type), [SW_MESSAGE.GET_VERSION]);
    assert.equal(env.controller.getState().latestVersion, 'v3.2.0');
  });

  test('latest version stays unknown (never guessed) when the waiting worker does not answer', async () => {
    const env = setup();
    const worker = new FakeWorker({ version: 'v3.2.0', respondToVersion: false });
    env.registration.updateImpl = async (reg) => reg.startInstall(worker);
    await env.controller.checkForUpdates();
    env.registration.finishInstall();
    await flush();
    env.timers.runAll(); // version handshake timeout
    await flush();
    assert.equal(env.controller.getState().status, UPDATE_STATUS.READY);
    assert.equal(env.controller.getState().latestVersion, null);
  });

  test('an update the browser already downloaded in the background is READY immediately, without another network check', async () => {
    const registration = new FakeRegistration();
    registration.waiting = new FakeWorker({ state: 'installed', version: 'v3.2.0' });
    const env = setup({ registration, online: false });
    await env.controller.checkForUpdates();
    await flush();
    assert.equal(env.registration.updateCalls, 0);
    assert.equal(env.controller.getState().status, UPDATE_STATUS.READY);
    assert.equal(env.controller.getState().latestVersion, 'v3.2.0');
  });

  test('a background updatefound while Settings is open is reflected without a manual check', async () => {
    const env = setup();
    await env.controller.checkForUpdates();
    assert.equal(env.controller.getState().status, UPDATE_STATUS.CURRENT);
    env.registration.startInstall(new FakeWorker({ version: 'v3.2.0' }));
    assert.equal(env.controller.getState().status, UPDATE_STATUS.DOWNLOADING);
  });

  test('first-ever install (no previous worker) settles on CURRENT, never READY', async () => {
    const registration = new FakeRegistration({ active: null });
    const env = setup({ registration });
    registration.installing = new FakeWorker();
    await env.controller.checkForUpdates();
    assert.equal(env.controller.getState().status, UPDATE_STATUS.DOWNLOADING);
    registration.finishInstall();
    assert.equal(env.controller.getState().status, UPDATE_STATUS.CURRENT);
  });

  test('concurrent checks share one in-flight update() call', async () => {
    const env = setup();
    await Promise.all([env.controller.checkForUpdates(), env.controller.checkForUpdates()]);
    assert.equal(env.registration.updateCalls, 1);
  });

  test('autoCheck() is throttled after a successful check but retries after offline/error', async () => {
    const env = setup();
    await env.controller.autoCheck();
    await env.controller.autoCheck();
    assert.equal(env.registration.updateCalls, 1);
    env.advance(5 * 60 * 1000 + 1);
    await env.controller.autoCheck();
    assert.equal(env.registration.updateCalls, 2);

    const offlineEnv = setup({ online: false });
    await offlineEnv.controller.autoCheck();
    assert.equal(offlineEnv.controller.getState().status, UPDATE_STATUS.OFFLINE);
    offlineEnv.navigatorRef.onLine = true;
    await offlineEnv.controller.autoCheck();
    assert.equal(offlineEnv.controller.getState().status, UPDATE_STATUS.CURRENT);
  });
});

/* ============================================================
   5-7. OFFLINE / NETWORK FAILURE / NO SERVICE WORKER
============================================================ */
describe('5-7. Offline, network failure, unsupported', () => {
  test('5. offline: no network check is attempted and the result is OFFLINE, never CURRENT', async () => {
    const env = setup({ online: false });
    const state = await env.controller.checkForUpdates();
    assert.equal(env.registration.updateCalls, 0);
    assert.equal(state.status, UPDATE_STATUS.OFFLINE);
    assert.notEqual(state.latestVersion, 'v3.1.1');
  });

  test('5b. connection dropping during the check -> OFFLINE', async () => {
    const env = setup();
    env.registration.updateImpl = async () => {
      env.navigatorRef.onLine = false;
      throw new TypeError('Failed to fetch');
    };
    const state = await env.controller.checkForUpdates();
    assert.equal(state.status, UPDATE_STATUS.OFFLINE);
  });

  test('6. network failure while online -> ERROR(network), never CURRENT', async () => {
    const env = setup();
    env.registration.updateImpl = async () => { throw new TypeError('An unknown error occurred when fetching the script.'); };
    const state = await env.controller.checkForUpdates();
    assert.equal(state.status, UPDATE_STATUS.ERROR);
    assert.equal(state.error, UPDATE_ERROR.NETWORK);
    assert.equal(state.latestVersion, null);
  });

  test('7. service workers unavailable -> UNSUPPORTED, no exception', async () => {
    const env = setup({ swSupported: false });
    const state = await env.controller.checkForUpdates();
    assert.equal(state.status, UPDATE_STATUS.UNSUPPORTED);
    assert.equal(env.controller.applyUpdate(), false);
    assert.equal(env.reloads.length, 0);
  });

  test('7b. no registration yet -> waits for navigator.serviceWorker.ready, then ERROR(no-registration) on timeout', async () => {
    const env = setup({ registration: null });
    const pendingCheck = env.controller.checkForUpdates();
    await flush();
    env.timers.runAll();
    const state = await pendingCheck;
    assert.equal(state.status, UPDATE_STATUS.ERROR);
    assert.equal(state.error, UPDATE_ERROR.NO_REGISTRATION);
  });
});

/* ============================================================
   8-9. WAITING STATE / INSTALL FAILURE
============================================================ */
describe('8-9. Waiting worker and install failure', () => {
  test('8. a waiting worker is NOT activated by checking -- only reported as READY', async () => {
    const env = setup();
    const worker = await reachReady(env);
    assert.equal(env.controller.getState().status, UPDATE_STATUS.READY);
    assert.ok(!worker.messages.some((m) => m.type === SW_MESSAGE.SKIP_WAITING));
    assert.equal(env.reloads.length, 0);
  });

  test('9. download/install failure (worker becomes redundant) -> ERROR(install-failed), not READY', async () => {
    const env = setup();
    const worker = new FakeWorker({ version: 'v3.2.0' });
    env.registration.updateImpl = async (reg) => reg.startInstall(worker);
    await env.controller.checkForUpdates();
    env.registration.installing = null;
    worker.setState('redundant');
    assert.equal(env.controller.getState().status, UPDATE_STATUS.ERROR);
    assert.equal(env.controller.getState().error, UPDATE_ERROR.INSTALL_FAILED);
    assert.equal(env.controller.applyUpdate(), false);
  });

  test('9b. a failed install superseded by a newer installing worker keeps tracking the newer one', async () => {
    const env = setup();
    const first = new FakeWorker({ version: 'v3.2.0' });
    const second = new FakeWorker({ version: 'v3.2.1' });
    env.registration.updateImpl = async (reg) => reg.startInstall(first);
    await env.controller.checkForUpdates();
    env.registration.installing = second;
    first.setState('redundant');
    assert.equal(env.controller.getState().status, UPDATE_STATUS.DOWNLOADING);
    env.registration.finishInstall();
    await flush();
    assert.equal(env.controller.getState().latestVersion, 'v3.2.1');
  });
});

/* ============================================================
   10-12. USER APPROVAL AND RELOAD
============================================================ */
describe('10-12. User approval and reload', () => {
  test('10. user does not press Update Now: nothing is activated and nothing reloads, however long it waits', async () => {
    const env = setup();
    const worker = await reachReady(env);
    env.timers.runAll();
    env.container.dispatch('controllerchange'); // e.g. another tab activated it
    await flush();
    assert.equal(env.reloads.length, 0);
    assert.ok(!worker.messages.some((m) => m.type === SW_MESSAGE.SKIP_WAITING));
    assert.equal(env.controller.getState().status, UPDATE_STATUS.READY);
  });

  test('11. user presses Update Now: SKIP_WAITING is sent, and the page reloads only after controllerchange', async () => {
    const env = setup();
    const worker = await reachReady(env, 'v3.2.0');
    assert.equal(env.controller.applyUpdate(), true);
    assert.equal(env.controller.getState().status, UPDATE_STATUS.APPLYING);
    assert.deepEqual(worker.messages.at(-1), { type: SW_MESSAGE.SKIP_WAITING });
    assert.equal(env.reloads.length, 0, 'must not reload before the new worker takes control');

    env.container.takeOver(worker);
    assert.equal(env.reloads.length, 1);
    const pending = JSON.parse(env.storage.getItem(PENDING_UPDATE_STORAGE_KEY));
    assert.equal(pending.target, 'v3.2.0');
    assert.equal(pending.from, 'v3.1.1');
  });

  test('12. reload happens exactly once, even with repeated controllerchange / timeout / repeated clicks', async () => {
    const env = setup();
    const worker = await reachReady(env);
    env.controller.applyUpdate();
    assert.equal(env.controller.applyUpdate(), false, 'second click is ignored while applying');
    env.container.takeOver(worker);
    env.container.dispatch('controllerchange');
    env.container.dispatch('controllerchange');
    env.timers.runAll();
    assert.equal(env.reloads.length, 1);
    assert.equal(env.container.listenerCount('controllerchange'), 0, 'listener removed after the single reload');
  });

  test('12b. the new worker activates but controllerchange never arrives -> one reload via the timeout fallback', async () => {
    const env = setup();
    const worker = await reachReady(env);
    env.controller.applyUpdate();
    worker.setState('activated');
    env.timers.runAll();
    assert.equal(env.reloads.length, 1);
  });

  test('12c. activation never happens -> ERROR(apply-failed), no reload, pending note cleared', async () => {
    const env = setup();
    await reachReady(env);
    env.controller.applyUpdate();
    env.timers.runAll();
    assert.equal(env.reloads.length, 0);
    assert.equal(env.controller.getState().status, UPDATE_STATUS.ERROR);
    assert.equal(env.controller.getState().error, UPDATE_ERROR.APPLY_FAILED);
    assert.equal(env.storage.getItem(PENDING_UPDATE_STORAGE_KEY), null);
  });

  test('12d. the waiting worker turning redundant during apply -> ERROR(apply-failed), no reload', async () => {
    const env = setup();
    const worker = await reachReady(env);
    env.controller.applyUpdate();
    worker.setState('redundant');
    assert.equal(env.reloads.length, 0);
    assert.equal(env.controller.getState().error, UPDATE_ERROR.APPLY_FAILED);
  });

  test('applyUpdate() is refused unless an update is READY (no activation from any other state)', async () => {
    const env = setup();
    assert.equal(env.controller.applyUpdate(), false);
    await env.controller.checkForUpdates();
    assert.equal(env.controller.applyUpdate(), false);
    assert.equal(env.reloads.length, 0);
  });
});

/* ============================================================
   POST-RELOAD CONFIRMATION -- success is reported only once the new
   version is the one actually running.
============================================================ */
describe('Post-reload confirmation', () => {
  function pendingStorage(record) {
    return createMemoryStorage({ [PENDING_UPDATE_STORAGE_KEY]: JSON.stringify(record) });
  }

  test('running version == requested target -> ok:true (and the note is consumed once)', () => {
    const storage = pendingStorage({ from: 'v3.1.1', target: 'v3.2.0', requestedAt: 1_000_000 });
    const env = setup({ installedVersion: 'v3.2.0', storage, now: 1_000_500 });
    assert.deepEqual(env.controller.consumePostUpdateResult(), { ok: true, version: 'v3.2.0' });
    assert.equal(env.controller.consumePostUpdateResult(), null);
  });

  test('running version != requested target -> ok:false, never reported as success', () => {
    const storage = pendingStorage({ from: 'v3.1.1', target: 'v3.2.0', requestedAt: 1_000_000 });
    const env = setup({ installedVersion: 'v3.1.1', storage, now: 1_000_500 });
    assert.deepEqual(env.controller.consumePostUpdateResult(), { ok: false, version: 'v3.1.1', target: 'v3.2.0' });
  });

  test('unknown target -> ok:null (neutral notice), stale notes are ignored', () => {
    const env = setup({ storage: pendingStorage({ from: 'v3.1.1', target: null, requestedAt: 1_000_000 }), now: 1_000_500 });
    assert.deepEqual(env.controller.consumePostUpdateResult(), { ok: null, version: 'v3.1.1' });
    const stale = setup({ storage: pendingStorage({ from: 'v3.1.1', target: 'v3.2.0', requestedAt: 0 }), now: 60 * 60 * 1000 });
    assert.equal(stale.controller.consumePostUpdateResult(), null);
  });

  test('no note -> null; unavailable sessionStorage never throws', () => {
    assert.equal(setup().controller.consumePostUpdateResult(), null);
    const throwing = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); }, removeItem() { throw new Error('denied'); } };
    const env = setup({ storage: throwing });
    assert.equal(env.controller.consumePostUpdateResult(), null);
  });
});

/* ============================================================
   13. DATA PRESERVATION
============================================================ */
describe('13. The update flow never deletes persisted application data', () => {
  test('a full check -> download -> apply -> reload cycle leaves every localStorage record untouched', async () => {
    const persisted = {
      'hpal.license.v1': '{"key":"…"}',
      'hpal.preferences.v1': '{"locale":"en","appearance":"dark"}',
      'hpal.contractors.v1': '{"records":[1,2,3]}',
      'hpal.personnel.v1': '{"records":[4]}',
      'hpal.personnel.writeQueue.v1': '{"items":[{"id":"q1"}]}',
    };
    // Installed as the real globals for the duration of the cycle; any
    // mutation (or a Cache Storage deletion) by the updater is recorded.
    const mutations = [];
    const localStorage = createMemoryStorage(persisted);
    const watchedLocalStorage = {
      ...localStorage,
      setItem: (k, v) => { mutations.push(`localStorage.setItem(${k})`); localStorage.setItem(k, v); },
      removeItem: (k) => { mutations.push(`localStorage.removeItem(${k})`); localStorage.removeItem(k); },
      clear: () => { mutations.push('localStorage.clear()'); },
    };
    const watchedCaches = {
      delete: async (k) => { mutations.push(`caches.delete(${k})`); return true; },
      keys: async () => [],
    };
    const saved = { localStorage: globalThis.localStorage, caches: globalThis.caches, indexedDB: globalThis.indexedDB };
    globalThis.localStorage = watchedLocalStorage;
    globalThis.caches = watchedCaches;
    globalThis.indexedDB = { deleteDatabase: (n) => mutations.push(`indexedDB.deleteDatabase(${n})`) };
    try {
      const env = setup();
      const worker = await reachReady(env);
      env.controller.applyUpdate();
      env.container.takeOver(worker);
      assert.equal(env.reloads.length, 1);
      // A worker-script update leaves the registration itself in place.
      assert.equal(env.container.registration, env.registration);
    } finally {
      globalThis.localStorage = saved.localStorage;
      globalThis.caches = saved.caches;
      globalThis.indexedDB = saved.indexedDB;
    }
    assert.deepEqual(mutations, []);
    assert.deepEqual(Object.fromEntries(localStorage._map), persisted);
  });

  test('the update service source never clears storage, deletes caches, or unregisters the worker', () => {
    const source = readFileSync(path.join(ROOT, 'js/services/app-update-service.js'), 'utf8')
      .split(/\r?\n/).filter((line) => !line.trim().startsWith('//')).join('\n');
    assert.doesNotMatch(source, /localStorage/);
    assert.doesNotMatch(source, /indexedDB/i);
    assert.doesNotMatch(source, /\.clear\(\)/);
    assert.doesNotMatch(source, /caches\./);
    assert.doesNotMatch(source, /unregister/);
  });

  test('the only reload path is applyUpdate() -> triggerReload(), gated on the user\'s request', () => {
    const source = readFileSync(path.join(ROOT, 'js/services/app-update-service.js'), 'utf8')
      .split(/\r?\n/).filter((line) => !line.trim().startsWith('//')).join('\n');
    const reloadCalls = source.match(/\breload\(\)/g) || [];
    // One in the default reload implementation, one inside triggerReload().
    assert.equal(reloadCalls.length, 2);
    assert.match(source, /function triggerReload\(\) \{\s*if \(!applyRequested \|\| reloadTriggered\) return;/);
  });
});
