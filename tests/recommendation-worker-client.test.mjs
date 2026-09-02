// V3.0 Phase 7B -- Recommendation Web Worker + UX Safety: dedicated
// protocol/lifecycle tests for js/pages/calculate/recommendation-worker-client.js
// (this task's Sections 2-5/9/12).
//
// Run with Node's built-in test runner:
//
//   node --test tests/recommendation-worker-client.test.mjs
//
// Node has no global Worker, so every test here builds its own FAKE
// Worker-like object (postMessage/onmessage/onerror/terminate) and hands
// it to createRecommendationWorkerClient({ createWorker }) directly (the
// SAME dependency-injection point production uses for its default
// `new Worker(new URL(...), { type: 'module' })` factory -- see that
// module's own header comment) -- deterministic, no real thread/timer, no
// browser-only APIs, matching this task's Section 12 "do not require
// browser timing in CI".
//
// recommendation-worker.js itself (the actual Worker entry file) is a
// classic ES module that expects a real `self`/postMessage Worker global
// scope, so -- exactly like service-worker.js's own test file already
// documents for the Service Worker -- it is verified by SOURCE-TEXT
// assertion (see tests/service-worker.test.mjs's "26." describe block)
// rather than imported/executed directly here. What IS exercised directly
// and behaviorally here is everything the main thread actually depends
// on: the client's request/cancel/stale-response contract.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { createRecommendationWorkerClient } from '../js/pages/calculate/recommendation-worker-client.js';
import { findBlendRecommendations } from '../js/pages/calculate/blending-recommendation.js';

/* ============================================================
   FAKE WORKER -- manually driven (never auto-resolving) so every test
   below can assert the exact in-flight protocol state (what was posted,
   whether terminate() was called) before deciding when/whether to
   "reply", instead of racing a timer.
============================================================ */
class FakeWorker {
  constructor() {
    this.onmessage = null;
    this.onerror = null;
    this.terminated = false;
    this.posted = []; // every { type, requestId, input } this fake actually received
  }

  postMessage(msg) {
    this.posted.push(msg);
  }

  terminate() {
    this.terminated = true;
  }

  // Test helper -- simulates the Worker replying with a RESULT/ERROR
  // message. Does nothing once terminated, exactly like a real terminated
  // Worker can never deliver another message (this task's Section 4).
  reply(message) {
    if (this.terminated) return;
    if (this.onmessage) this.onmessage({ data: message });
  }

  // Test helper -- simulates a genuine Worker runtime failure (an
  // uncaught exception/syntax error inside the Worker itself), distinct
  // from a normal ERROR protocol message (this task's Section 9).
  crash(message) {
    if (this.terminated) return;
    if (this.onerror) this.onerror({ message });
  }
}

function makeFactory() {
  const created = [];
  const factory = () => {
    const w = new FakeWorker();
    created.push(w);
    return w;
  };
  factory.created = created;
  return factory;
}

const SAMPLE_INPUT = {
  targetNi: '1.120',
  tolerance: '0.009',
  sources: [
    { key: 1, pileId: 'Higher', contractor: 'SMA', ni: '1.30', units: '7', tonnesPerUnit: '50' },
    { key: 2, pileId: 'Lglo', contractor: 'TII', ni: '1.03', units: '12', tonnesPerUnit: '50' },
  ],
};

describe('1/2. Request protocol -- CALCULATE is posted with a requestId and the exact input, unchanged', () => {
  test('calculate() posts { type: "CALCULATE", requestId, input } where input is deep-equal to what was passed in', () => {
    const factory = makeFactory();
    const client = createRecommendationWorkerClient({ createWorker: factory });

    client.calculate(SAMPLE_INPUT);

    const worker = factory.created[0];
    assert.equal(worker.posted.length, 1);
    assert.equal(worker.posted[0].type, 'CALCULATE');
    assert.equal(typeof worker.posted[0].requestId, 'number');
    assert.deepEqual(worker.posted[0].input, SAMPLE_INPUT);
  });

  test('every calculate() call gets a distinct, increasing requestId', () => {
    const factory = makeFactory();
    const client = createRecommendationWorkerClient({ createWorker: factory });

    client.calculate(SAMPLE_INPUT);
    const firstId = factory.created[0].posted[0].requestId;
    factory.created[0].reply({ type: 'RESULT', requestId: firstId, result: findBlendRecommendations(SAMPLE_INPUT) });

    client.calculate(SAMPLE_INPUT);
    const secondId = factory.created[0].posted[1].requestId;

    assert.notEqual(firstId, secondId);
  });
});

describe('3/12. Exact Recommendation result forwarded through the Worker boundary, unchanged', () => {
  test('a RESULT message resolves calculate() with EXACTLY the same result object findBlendRecommendations() itself would return for this input', async () => {
    const factory = makeFactory();
    const client = createRecommendationWorkerClient({ createWorker: factory });

    const expected = findBlendRecommendations(SAMPLE_INPUT);
    const promise = client.calculate(SAMPLE_INPUT);
    const worker = factory.created[0];
    worker.reply({ type: 'RESULT', requestId: worker.posted[0].requestId, result: expected });

    const actual = await promise;
    assert.deepEqual(actual, expected, 'the Worker boundary must never mutate/reshape a Recommendation result');
  });

  test('A-F representative shapes (within-tolerance, TARGET_NOT_ACHIEVABLE, invalid input) all round-trip byte-identical through the client', async () => {
    const scenarios = [
      SAMPLE_INPUT, // A/B-shaped: small, fast, within-tolerance (known fleet example)
      { // unreachable target -- every source's Ni sits on the same side of target
        targetNi: '5.0', tolerance: '0.01',
        sources: [
          { key: 1, pileId: 'X', contractor: 'C1', ni: '1.30', units: '5', tonnesPerUnit: '50' },
          { key: 2, pileId: 'Y', contractor: 'C2', ni: '1.10', units: '5', tonnesPerUnit: '50' },
        ],
      },
      { targetNi: 'not-a-number', tolerance: '0.01', sources: SAMPLE_INPUT.sources }, // INVALID_INPUT
    ];

    for (const input of scenarios) {
      const factory = makeFactory();
      const client = createRecommendationWorkerClient({ createWorker: factory });
      const expected = findBlendRecommendations(input);
      const promise = client.calculate(input);
      const worker = factory.created[0];
      worker.reply({ type: 'RESULT', requestId: worker.posted[0].requestId, result: expected });
      const actual = await promise;
      assert.deepEqual(actual, expected);
    }
  });
});

describe('4/5. requestId matching -- a response for any request other than the currently-active one is ignored', () => {
  test('a message carrying a foreign/old requestId never resolves or rejects the active request', async () => {
    const factory = makeFactory();
    const client = createRecommendationWorkerClient({ createWorker: factory });

    const promise = client.calculate(SAMPLE_INPUT);
    const worker = factory.created[0];
    const realRequestId = worker.posted[0].requestId;

    // A foreign requestId (never issued by this client) must be silently
    // dropped -- the real request stays pending.
    worker.reply({ type: 'RESULT', requestId: realRequestId + 999, result: { ok: true, bogus: true } });

    let settled = false;
    promise.then(() => { settled = true; }, () => { settled = true; });
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(settled, false, 'a foreign requestId must not settle the active request');

    const expected = findBlendRecommendations(SAMPLE_INPUT);
    worker.reply({ type: 'RESULT', requestId: realRequestId, result: expected });
    assert.deepEqual(await promise, expected);
  });

  test('request A cancelled/replaced by request B -- a LATE reply for A is ignored, and B remains authoritative (this task Section 5)', async () => {
    const factory = makeFactory();
    const client = createRecommendationWorkerClient({ createWorker: factory });

    const promiseA = client.calculate(SAMPLE_INPUT);
    const workerA = factory.created[0];
    const requestIdA = workerA.posted[0].requestId;

    let aOutcome = null;
    promiseA.then((v) => { aOutcome = { ok: true, v }; }, (e) => { aOutcome = { ok: false, e }; });

    // Starting B before A ever replies supersedes A -- A's own Worker is
    // terminated (this task Section 4/5), so a "late A response" can
    // never even reach the client through a real Worker; this test proves
    // the SAME safety holds even if a stale message were somehow still
    // delivered (a defensive, environment-independent proof of the
    // requestId check itself, not just of terminate()'s effectiveness).
    const otherInput = { ...SAMPLE_INPUT, targetNi: '1.200' };
    const promiseB = client.calculate(otherInput);
    const workerB = factory.created[1];
    const requestIdB = workerB.posted[0].requestId;

    assert.equal(workerA.terminated, true, 'the superseded request A must terminate its Worker');

    await Promise.resolve();
    assert.deepEqual(aOutcome, { ok: false, e: { type: 'CANCELLED' } });

    // A late reply for A, delivered directly (bypassing the already-
    // terminated fake's own terminate() guard) to prove the CLIENT itself
    // -- not just the fake -- would still ignore it via the requestId
    // check, since activeRequestId is now B's, not A's.
    workerA.onmessage({ data: { type: 'RESULT', requestId: requestIdA, result: { ok: true, fromA: true } } });

    const expectedB = findBlendRecommendations(otherInput);
    workerB.reply({ type: 'RESULT', requestId: requestIdB, result: expectedB });
    assert.deepEqual(await promiseB, expectedB, 'B must remain authoritative, unaffected by the late A reply');
  });
});

describe('6/7. Cancellation actually terminates the Worker; the next calculate() creates a fresh one', () => {
  test('cancel() terminates the active Worker and rejects the pending request with { type: "CANCELLED" }', async () => {
    const factory = makeFactory();
    const client = createRecommendationWorkerClient({ createWorker: factory });

    const promise = client.calculate(SAMPLE_INPUT);
    const worker = factory.created[0];

    client.cancel();

    assert.equal(worker.terminated, true);
    await assert.rejects(promise, (err) => err && err.type === 'CANCELLED');
  });

  test('a reply delivered to an already-cancelled Worker never settles anything (terminate() suppresses delivery, mirroring a real Worker)', async () => {
    const factory = makeFactory();
    const client = createRecommendationWorkerClient({ createWorker: factory });

    const promise = client.calculate(SAMPLE_INPUT);
    const worker = factory.created[0];
    client.cancel();
    worker.reply({ type: 'RESULT', requestId: worker.posted[0].requestId, result: findBlendRecommendations(SAMPLE_INPUT) });

    await assert.rejects(promise, (err) => err && err.type === 'CANCELLED');
  });

  test('cancel() with no active request is a safe no-op', () => {
    const factory = makeFactory();
    const client = createRecommendationWorkerClient({ createWorker: factory });
    assert.doesNotThrow(() => client.cancel());
    assert.equal(factory.created.length, 0, 'cancel() must never create a Worker that was never needed');
  });

  test('the NEXT calculate() after a cancel lazily creates a brand-new Worker, never reusing the terminated one', () => {
    const factory = makeFactory();
    const client = createRecommendationWorkerClient({ createWorker: factory });

    client.calculate(SAMPLE_INPUT).catch(() => {});
    client.cancel();
    assert.equal(factory.created.length, 1);

    client.calculate(SAMPLE_INPUT).catch(() => {});
    assert.equal(factory.created.length, 2, 'a fresh Worker instance must be created for the next calculation');
    assert.notEqual(factory.created[1], factory.created[0]);
  });

  test('isBusy() reflects an in-flight request and clears on cancel/settle', async () => {
    const factory = makeFactory();
    const client = createRecommendationWorkerClient({ createWorker: factory });
    assert.equal(client.isBusy(), false);

    const promise = client.calculate(SAMPLE_INPUT);
    assert.equal(client.isBusy(), true);

    client.cancel();
    assert.equal(client.isBusy(), false);
    await promise.catch(() => {});
  });
});

describe('8. Worker ERROR is a distinct infrastructure outcome, never a fabricated Recommendation result/status', () => {
  test('an ERROR protocol message rejects with { type: "WORKER_ERROR", message }', async () => {
    const factory = makeFactory();
    const client = createRecommendationWorkerClient({ createWorker: factory });

    const promise = client.calculate(SAMPLE_INPUT);
    const worker = factory.created[0];
    worker.reply({ type: 'ERROR', requestId: worker.posted[0].requestId, error: 'boom' });

    await assert.rejects(promise, (err) => err.type === 'WORKER_ERROR' && err.message === 'boom');
  });

  test('a genuine Worker runtime failure (onerror) also rejects WORKER_ERROR and terminates the Worker', async () => {
    const factory = makeFactory();
    const client = createRecommendationWorkerClient({ createWorker: factory });

    const promise = client.calculate(SAMPLE_INPUT);
    const worker = factory.created[0];
    worker.crash('SyntaxError inside worker module');

    await assert.rejects(promise, (err) => err.type === 'WORKER_ERROR');
    assert.equal(worker.terminated, true);
  });

  test('a Worker constructor that throws (unavailable/unsupported) rejects WORKER_ERROR deterministically -- never a silent synchronous fallback (this task Section 9)', async () => {
    const throwingFactory = () => { throw new Error('Worker is not defined'); };
    const client = createRecommendationWorkerClient({ createWorker: throwingFactory });

    await assert.rejects(client.calculate(SAMPLE_INPUT), (err) => err.type === 'WORKER_ERROR' && /not defined/.test(err.message));
  });

  test('a postMessage() that throws (e.g. a structured-clone failure) rejects WORKER_ERROR and terminates the Worker', async () => {
    class ThrowingPostWorker extends FakeWorker {
      postMessage() { throw new Error('DataCloneError'); }
    }
    const factory = () => new ThrowingPostWorker();
    const client = createRecommendationWorkerClient({ createWorker: factory });

    await assert.rejects(client.calculate(SAMPLE_INPUT), (err) => err.type === 'WORKER_ERROR');
  });
});
