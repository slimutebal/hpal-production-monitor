// V3.0 Phase 7B -- main-thread Worker coordinator/client for Calculate
// Recommendation (this task's Section 2). calculate-page.js talks to this
// module only -- it never touches `new Worker(...)`/postMessage/terminate
// directly, so Worker lifecycle/protocol details stay in ONE place.
//
// SUBPATH-SAFE URL RESOLUTION (this task's Section 2): the Worker script
// is resolved via `new URL('./recommendation-worker.js', import.meta.url)`
// -- relative to THIS module's own URL, not `location.href` or a
// hand-built absolute path -- so it keeps working under a GitHub Pages
// project subpath (e.g. '/hpal-production-monitor/'), exactly like every
// other same-directory import in js/pages/calculate/ already does.
//
// PROTOCOL / STALE-RESPONSE SAFETY (this task's Sections 3-5): every
// calculate() call gets a fresh, monotonically increasing requestId. A
// message whose requestId does not match the CURRENTLY active request is
// discarded outright -- it can never resolve/reject the wrong Promise or
// touch UI state. Starting a new calculate() while one is already active
// terminates the old Worker FIRST (this task's Section 5) rather than
// merely ignoring its eventual reply, because the solver is CPU-bound and
// a terminated Worker is the only way to actually stop that work (this
// task's Section 4) -- letting it keep running in the background would
// waste CPU and could still race a later postMessage against a torn-down
// listener.
//
// TEST INJECTION (this task's Section 12): `createRecommendationWorkerClient()`
// accepts a `createWorker` factory so tests can supply a fake Worker-like
// object (postMessage/onmessage/onerror/terminate) instead of a real
// browser Worker -- Node has no global Worker, and even in a browser this
// keeps unit tests free of real thread/timing nondeterminism.
// `_setWorkerFactoryForTests()` overrides the factory used by the default
// singleton the rest of this module (and therefore calculate-page.js)
// talks to.

const DEFAULT_CREATE_WORKER = () => new Worker(
  new URL('./recommendation-worker.js', import.meta.url),
  { type: 'module' },
);

function describeError(err) {
  if (err && typeof err.message === 'string') return err.message;
  return String(err || 'Unknown worker error');
}

// A rejection of this shape ({ type: 'WORKER_ERROR' | 'CANCELLED' }) is an
// INFRASTRUCTURE outcome -- never a Recommendation status. A successful
// calculate() always resolves with findBlendRecommendations()'s own exact
// result object, `ok: true` or `ok: false`, untouched (this task's
// Section 9).
export function createRecommendationWorkerClient({ createWorker = DEFAULT_CREATE_WORKER } = {}) {
  let worker = null;
  let activeRequestId = null;
  let activeResolve = null;
  let activeReject = null;
  let nextRequestId = 1;

  function handleMessage(event) {
    const data = event && event.data;
    if (!data || data.requestId !== activeRequestId) return; // stale/foreign -- ignored (Section 3/5)
    const resolve = activeResolve;
    const reject = activeReject;
    activeRequestId = null;
    activeResolve = null;
    activeReject = null;
    if (data.type === 'RESULT') resolve(data.result);
    else reject({ type: 'WORKER_ERROR', message: data.error || 'Unknown worker error' });
  }

  function handleWorkerRuntimeError(event) {
    if (activeRequestId === null) return;
    settle({ type: 'WORKER_ERROR', message: (event && event.message) || 'Worker runtime error' });
  }

  // Terminates the Worker (this task's Section 4 -- the only reliable way
  // to actually stop CPU-bound synchronous work) and rejects whichever
  // request was active, if any, with `reason`. `worker = null` afterwards
  // means the NEXT calculate() lazily creates a fresh Worker (Section 4) --
  // a terminated Worker is never reused.
  function settle(reason) {
    const reject = activeReject;
    if (worker) {
      worker.terminate();
      worker = null;
    }
    activeRequestId = null;
    activeResolve = null;
    activeReject = null;
    if (reject) reject(reason);
  }

  function ensureWorker() {
    if (worker) return worker;
    worker = createWorker();
    worker.onmessage = handleMessage;
    worker.onerror = handleWorkerRuntimeError;
    return worker;
  }

  function calculate(input) {
    if (activeRequestId !== null) settle({ type: 'CANCELLED' }); // Section 5: newest request wins
    const requestId = nextRequestId;
    nextRequestId += 1;

    return new Promise((resolve, reject) => {
      let w;
      try {
        w = ensureWorker();
      } catch (err) {
        // Worker unavailable/unsupported (this task's Section 9) --
        // deterministic infrastructure failure, never a silent
        // synchronous re-run of the solver.
        reject({ type: 'WORKER_ERROR', message: describeError(err) });
        return;
      }
      activeRequestId = requestId;
      activeResolve = resolve;
      activeReject = reject;
      try {
        w.postMessage({ type: 'CALCULATE', requestId, input });
      } catch (err) {
        settle({ type: 'WORKER_ERROR', message: describeError(err) });
      }
    });
  }

  // No-op when nothing is active -- Cancel is only ever exposed by the UI
  // while a calculation is genuinely in flight (this task's Section 6).
  function cancel() {
    if (activeRequestId === null) return;
    settle({ type: 'CANCELLED' });
  }

  function isBusy() {
    return activeRequestId !== null;
  }

  return { calculate, cancel, isBusy };
}

let singletonClient = null;
let workerFactoryOverride = null;

function getSingletonClient() {
  if (!singletonClient) {
    singletonClient = createRecommendationWorkerClient(
      workerFactoryOverride ? { createWorker: workerFactoryOverride } : {},
    );
  }
  return singletonClient;
}

// The one client instance calculate-page.js's Calculate UI actually talks
// to (this task's Section 8's "separate client API" -- findBlendRecommendations()
// itself stays untouched and fully synchronous for existing callers/tests).
export function calculateRecommendationAsync(input) {
  return getSingletonClient().calculate(input);
}

export function cancelRecommendationCalculation() {
  return getSingletonClient().cancel();
}

export function isRecommendationCalculationActive() {
  return getSingletonClient().isBusy();
}

// Test-only (this task's Section 12): install a fake Worker factory for
// every future calculate() call made through the default singleton, and
// drop the current singleton (terminating/rejecting any request it still
// had active) so the override takes effect immediately rather than on
// some later lazy re-creation.
export function _setWorkerFactoryForTests(factory) {
  if (singletonClient) singletonClient.cancel();
  workerFactoryOverride = factory;
  singletonClient = null;
}
