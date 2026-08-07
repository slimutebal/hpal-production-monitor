// V2.0 app shell bootstrap. Wires the router to the bottom navigation and
// the Settings placeholder. Monitor itself is untouched — it keeps running
// its own inline script exactly as before.
import { initRouter, onRouteChange } from './router.js';
import { initAppPreferences } from './services/app-preferences-service.js';
import { initI18n, t, getLocale, onLocaleChange, translatePage } from './i18n/i18n.js';
import {
  mountBottomNavigation,
  updateBottomNavigation,
  initBottomNavigationAutoHide,
  showBottomNavigation,
} from './components/bottom-navigation.js';
import { initReportPage } from './pages/report/report-page.js';
import { initSettingsPage } from './pages/settings/settings-page.js';

function init() {
  // V2.3 Phase 7 (Language/Appearance): both run before anything mounts,
  // so the very first paint of every page already has the persisted theme
  // applied and the persisted locale active -- minimizing the
  // incorrect-theme/incorrect-locale flash the architecture doc requires
  // (section 14.1). Monitor's own inline theme script in index.html runs
  // even earlier (it is a classic, non-deferred <script> that executes
  // during HTML parsing, before this module script), so it does not
  // depend on this call either -- see index.html's own theme block for
  // why both converge on the same `hpal.preferences.v1` storage key.
  initAppPreferences();
  initI18n();

  // Monitor's own <script> in index.html is a classic (non-module) script
  // -- it cannot `import` js/i18n/i18n.js directly (V2.3 full-localization
  // pass, "one small stable bridge, not a second dictionary"). This is
  // the ONE bridge: window.i18n exposes exactly the read-only lookup
  // surface Monitor needs (t/getLocale/onLocaleChange), never a copy of
  // either locale catalog. translatePage() (no argument -> the whole
  // document) is called once here and again on every locale change so
  // Monitor's own data-i18n-tagged static markup is translated through
  // the exact same walker Settings/Report already use -- Monitor's own
  // dynamic re-render (index.html's onLocaleChange subscription) only
  // needs to handle content translatePage() cannot reach (data-driven
  // template-literal HTML), not static tags.
  window.i18n = { t, getLocale, onLocaleChange, translatePage };
  translatePage();
  onLocaleChange(() => translatePage());

  mountBottomNavigation();
  initBottomNavigationAutoHide();
  initReportPage();
  initSettingsPage();

  onRouteChange((route) => {
    updateBottomNavigation(route);
    // A route change always brings the nav back, regardless of scroll
    // direction/position on the page being left.
    showBottomNavigation();

    // Monitor's chart canvas sits in a page that may have been display:none
    // while another tab was active. Chart.js keeps its instance alive but
    // needs a resize pass to recompute dimensions once visible again.
    // Monitor already listens for the native 'resize' event (see index.html),
    // so this reuses that existing handler instead of touching Monitor code.
    if (route === 'monitor') {
      window.dispatchEvent(new Event('resize'));
    }
  });

  initRouter();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
