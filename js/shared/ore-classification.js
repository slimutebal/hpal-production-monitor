// Shared ore-classification threshold rule (V2.4 Phase 2 consolidation).
// Single source of truth for: Ni > 1.4 -> HGLO, Ni < 1.2 -> LGLO, else MGLO.
//
// Before this file existed, the exact same threshold logic was
// independently implemented three times:
//   1. index.html's own inline classifyOre() (Monitor).
//   2. js/pages/report/profiles/shared-report-profile.js's classifyOreClass().
//   3. js/pages/report/profiles/adapters/esg-adapter-utils.js's
//      classifyEsgOreClass().
//
// This module is now the authoritative implementation.
// shared-report-profile.js's classifyOreClass() (used by HYNC/SLNC) has
// been updated to delegate here instead of duplicating the thresholds --
// see that function's own comment. js/pages/calculate/blend-calculator.js
// (V2.4 Phase 2) imports this module directly, so Calculate never defines
// its own independent copy either.
//
// Deliberately NOT touched by this consolidation:
//   - esg-adapter-utils.js's classifyEsgOreClass() -- its own header
//     comment states the duplication there is intentional: "this file
//     must stay import-free from the active HYNC/SLNC module graph so the
//     ESG layer remains fully isolated per this task's scope" (a
//     deliberate prior architectural decision from the V2.2 ESG task, not
//     an oversight). Importing this shared module into esg-adapter-utils.js
//     would violate that explicit isolation boundary, so it is left as-is.
//   - index.html (Monitor)'s inline classifyOre() -- a classic,
//     non-module <script> with no import statement of its own (see
//     js/app.js's window.i18n bridge for how this codebase already
//     solves "classic script needs shared module logic" when it has
//     chosen to). Retrofitting that bridge for classification as well is
//     a reasonable future step, but is more Monitor-script surface area
//     than this Phase 2 (Blend Calculator) task should touch -- Monitor's
//     own output must not change, and this codebase's own convention
//     throughout V2.0-V2.4 is to leave Monitor's inline script alone
//     unless a task is specifically about it. Left untouched; still only
//     3 total independent implementations exist after this change (down
//     from 3, unchanged in count but Calculate adds zero net new ones),
//     never 4.
//
// Pure, DOM-free, side-effect-free -- safe for any module (page or
// service) to import, including calculate-page.js's pure calculation
// layer (js/pages/calculate/blend-calculator.js), which must not import
// DOM, router, i18n, or localStorage.
export function classifyOre(grade) {
  if (grade === null || grade === undefined || isNaN(grade)) return null;
  if (grade > 1.4) return 'HGLO';
  if (grade < 1.2) return 'LGLO';
  return 'MGLO';
}
