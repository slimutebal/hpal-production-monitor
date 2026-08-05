// V2.0 Report placeholder page. No HYNC parsing/generation yet, no ESG or
// SLNC controls — see docs/V2.0_ARCHITECTURE_AND_ROADMAP.md section 2.2.

export function initReportPage() {
  const page = document.getElementById('page-report');
  if (!page) return;

  page.innerHTML = `
    <div class="report-placeholder page-placeholder">
      <h1 class="page-placeholder__title">Daily Production Geology Report</h1>
      <p class="page-placeholder__subtitle">FPP HYNC</p>
      <p class="page-placeholder__note">Available in the next implementation phase.</p>
    </div>
  `;
}
