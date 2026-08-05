// V2.0 Settings placeholder page. No CRUD, no license logic — see
// docs/V2.0_ARCHITECTURE_AND_ROADMAP.md section 2.3.

export function initSettingsPage() {
  const page = document.getElementById('page-settings');
  if (!page) return;

  page.innerHTML = `
    <div class="settings-placeholder page-placeholder">
      <p class="settings-placeholder__icon" aria-hidden="true">⚙️</p>
      <h1 class="page-placeholder__title">Settings</h1>
      <p class="page-placeholder__note">
        Personnel, contractor, and license settings<br>
        will be available in a later version.
      </p>
    </div>
  `;
}
