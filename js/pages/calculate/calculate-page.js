// Calculate page shell (V2.4 Phase 1 -- Calculate Page Shell, Routing,
// Navigation, and Access Control). See
// docs/V2.4_CALCULATE_AND_BLENDING_RECOMMENDATION_ARCHITECTURE.md.
//
// Phase 1 is deliberately a placeholder ONLY: no pile inputs, no Ni/Jumlah
// Unit/Tonase fields, no Blend or Recommendation tabs, no calculation of
// any kind -- those are gated behind Gate A (architecture doc Section 40)
// and later phases. This module's only job is to prove the route, the
// nav entry, the FULL_ACCESS route guard (app.js) plus this module's own
// action-boundary guard, theme compatibility, and localization
// compatibility.
//
// Reuses the SHARED .page-placeholder/.page-placeholder__title/
// .page-placeholder__subtitle classes already declared in
// assets/css/app-shell.css -- those were originally written for Report/
// Settings before both grew past their own placeholders, and have been
// unused (dead CSS) ever since. Calculate is the first page to actually
// use them again, so no new Calculate-specific stylesheet is needed for
// this phase.
//
// Built once into #page-calculate and never rebuilt on route change,
// mirroring report-page.js/settings-page.js's "build markup once"
// convention (see report-page.js's own header comment for that rule).
// Unlike Settings, this page's own markup never branches on
// hasFullAccess() -- the ROUTE guard (app.js) is what keeps a
// MONITOR_ONLY user from ever reaching #/calculate at all, so there is no
// tier-dependent shape for this shell to render.
import { translatePage, onLocaleChange } from '../../i18n/i18n.js';
import { navigateTo } from '../../router.js';
import { hasFullAccess, requestFullAccessAttention } from '../../services/license-service.js';

let page = null;

export function initCalculatePage() {
  page = document.getElementById('page-calculate');
  if (!page) return;

  page.innerHTML = buildMarkup();
  translatePage(page);
  onLocaleChange(() => translatePage(page));
}

function buildMarkup() {
  return `
    <div class="page-placeholder" id="calculate-shell">
      <h1 class="page-placeholder__title" data-i18n="calculate.title">Calculate</h1>
      <p class="page-placeholder__subtitle" data-i18n="calculate.subtitle"></p>
    </div>
  `;
}

// Action-boundary guard for future Calculate actions (architecture doc
// Section 10) -- mirrors report-page.js's own private
// requireFullAccessForReportAction() byte-for-byte in structure and
// behavior. Exported here (unlike Report's private version) because
// Phase 1 intentionally ships no real protected action yet to exercise it
// through -- tests call it directly instead. Once a real Blend/
// Recommendation action exists (post-Gate A), that action calls this same
// guard as its own boundary check, exactly the way Report's goToStep2()/
// goToStep3() call theirs. Bootstrap (initCalculatePage() above) never
// calls this -- opening the app under MONITOR_ONLY must not itself
// redirect to Settings; only an actual gated action or the route guard
// may do that.
export function requireFullAccessForCalculateAction() {
  if (hasFullAccess()) return true;
  navigateTo('settings');
  requestFullAccessAttention('calculate-action');
  return false;
}
