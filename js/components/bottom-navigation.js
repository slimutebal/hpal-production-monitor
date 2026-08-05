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
