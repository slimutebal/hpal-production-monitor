// V3.0 Phase 7B -- dedicated ES-module Web Worker entry for Calculate
// Recommendation. See docs/... (this task's Sections 1-3).
//
// PURE EXECUTION BOUNDARY: this file adds NO solver logic of its own. It
// imports the exact same production findBlendRecommendations() that
// calculate-page.js already called synchronously before this phase (this
// task's Section 1/8) -- the hybrid NORMAL_BNB/HARDCASE_MITM dispatcher,
// unchanged. Running it inside a Worker moves the CPU-bound work off the
// browser main thread; it changes nothing about which candidate wins or
// what status/diagnostic fields a result carries.
//
// PROTOCOL (this task's Section 3):
//   main -> worker: { type: 'CALCULATE', requestId, input }
//   worker -> main: { type: 'RESULT', requestId, result }
//                 | { type: 'ERROR', requestId, error }
// `error` is always a plain string (never an Error instance/class/function
// -- structured-clone-safe by construction, this task's Section 3) so a
// genuinely unexpected exception (a bug, not a normal SEARCH_INCOMPLETE/
// TARGET_NOT_ACHIEVABLE status -- those travel inside `result` exactly as
// findBlendRecommendations() already returns them) still reaches the main
// thread as an explicit, distinct ERROR message rather than silently
// killing the Worker with no reply (this task's Section 9).
import { findBlendRecommendations } from './blending-recommendation.js';

self.onmessage = (event) => {
  const data = event.data;
  if (!data || data.type !== 'CALCULATE') return;
  const { requestId, input } = data;
  try {
    const result = findBlendRecommendations(input);
    self.postMessage({ type: 'RESULT', requestId, result });
  } catch (err) {
    self.postMessage({
      type: 'ERROR',
      requestId,
      error: String((err && err.message) || err || 'Unknown worker error'),
    });
  }
};
