// V2.0 bottom navigation component. Builds the nav markup once and exposes
// an update function the router notifies on every route change.

// Every icon below uses only <rect>, <line>, <circle>, and <polyline> with
// comma-separated coordinates — no <path> arc/line command strings — so
// there is no dense, hard-to-verify number run in the markup.
const NAV_ITEMS = [
  {
    route: 'monitor',
    label: 'Monitor',
    icon:
      '<svg viewBox="0 0 24 24" aria-hidden="true">' +
      '<polyline points="3,3 3,21 21,21"/>' +
      '<polyline points="6,17 10,11 14,15 19,6"/>' +
      '</svg>',
  },
  {
    route: 'report',
    label: 'Report',
    icon:
      '<svg viewBox="0 0 24 24" aria-hidden="true">' +
      '<rect x="5" y="3" width="14" height="18" rx="2"/>' +
      '<line x1="8" y1="8" x2="16" y2="8"/>' +
      '<line x1="8" y1="12" x2="16" y2="12"/>' +
      '<line x1="8" y1="16" x2="13" y2="16"/>' +
      '</svg>',
  },
  {
    route: 'settings',
    label: 'Settings',
    icon:
      '<svg viewBox="0 0 24 24" aria-hidden="true">' +
      '<line x1="4" y1="6" x2="20" y2="6"/>' +
      '<circle cx="9" cy="6" r="2"/>' +
      '<line x1="4" y1="12" x2="20" y2="12"/>' +
      '<circle cx="15" cy="12" r="2"/>' +
      '<line x1="4" y1="18" x2="20" y2="18"/>' +
      '<circle cx="9" cy="18" r="2"/>' +
      '</svg>',
  },
];

export function mountBottomNavigation() {
  const nav = document.getElementById('bottom-navigation');
  if (!nav) return;

  nav.innerHTML = NAV_ITEMS.map(
    (item) => `
      <a href="#/${item.route}" class="bottom-nav__item" data-route="${item.route}" aria-label="${item.label}">
        <span class="bottom-nav__icon">${item.icon}</span>
        <span class="bottom-nav__label">${item.label}</span>
      </a>
    `
  ).join('');
}

export function updateBottomNavigation(activeRoute) {
  const nav = document.getElementById('bottom-navigation');
  if (!nav) return;

  nav.querySelectorAll('.bottom-nav__item').forEach((item) => {
    const isActive = item.dataset.route === activeRoute;
    item.classList.toggle('is-active', isActive);
    if (isActive) {
      item.setAttribute('aria-current', 'page');
    } else {
      item.removeAttribute('aria-current');
    }
  });
}

/* ============================================================
   AUTO-HIDE ON SCROLL
   Hides the nav while scrolling down past a small threshold, shows it
   again on scroll-up or near the top. Deliberately conservative: a
   hysteresis tolerance avoids flicker on tiny/inertial scroll deltas, and
   focusing any form control suspends hiding entirely so the on-screen
   keyboard opening (which can itself trigger a scroll) never hides the
   nav just because a field was focused.
============================================================ */

// Below this scrollY, the nav always stays visible regardless of direction.
const SCROLL_HIDE_THRESHOLD = 80;
// Scroll deltas smaller than this (px) are ignored so tiny/rubber-band
// scroll jitter cannot repeatedly flip the nav visible/hidden.
const SCROLL_TOLERANCE = 8;

let navEl = null;
let lastScrollY = 0;
let ticking = false;
let suppressHide = false;

function isFormControl(el) {
  return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT');
}

function handleFocusIn(event) {
  if (!isFormControl(event.target)) return;
  suppressHide = true;
  showBottomNavigation();
}

function handleFocusOut(event) {
  if (!isFormControl(event.target)) return;
  suppressHide = false;
}

function handleScroll() {
  if (ticking || !navEl) return;
  ticking = true;
  window.requestAnimationFrame(() => {
    ticking = false;
    if (!navEl) return;

    const currentY = window.scrollY;

    if (suppressHide || currentY <= SCROLL_HIDE_THRESHOLD) {
      navEl.classList.remove('is-hidden');
      lastScrollY = currentY;
      return;
    }

    const delta = currentY - lastScrollY;
    if (Math.abs(delta) < SCROLL_TOLERANCE) return;

    navEl.classList.toggle('is-hidden', delta > 0);
    lastScrollY = currentY;
  });
}

export function showBottomNavigation() {
  if (!navEl) navEl = document.getElementById('bottom-navigation');
  if (!navEl) return;
  navEl.classList.remove('is-hidden');
  lastScrollY = window.scrollY;
}

export function initBottomNavigationAutoHide() {
  navEl = document.getElementById('bottom-navigation');
  if (!navEl) return;

  lastScrollY = window.scrollY;
  window.addEventListener('scroll', handleScroll, { passive: true });
  // Capture phase so this still runs even if a page module later stops
  // propagation on its own focusin handling.
  document.addEventListener('focusin', handleFocusIn, true);
  document.addEventListener('focusout', handleFocusOut, true);
}
