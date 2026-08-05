// V2.0 app shell bootstrap. Wires the router to the bottom navigation and
// the Settings placeholder. Monitor itself is untouched — it keeps running
// its own inline script exactly as before.
import { initRouter, onRouteChange } from './router.js';
import {
  mountBottomNavigation,
  updateBottomNavigation,
  initBottomNavigationAutoHide,
  showBottomNavigation,
} from './components/bottom-navigation.js';
import { initReportPage } from './pages/report/report-page.js';
import { initSettingsPage } from './pages/settings/settings-page.js';

function init() {
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
