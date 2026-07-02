# HPAL Production Monitor Mobile PWA — ChartFix

Upload/replace only these files in the GitHub repo root:

- `index.html`
- `service-worker.js`

Do not re-upload `.nojekyll`; it already exists in the repository.

## Fix included

This update guards the Chart.js NI-drop highlight plugin against Android/Chrome cases where `chart.chartArea` or bar geometry is not ready during the first draw. Without the guard, Android can throw:

`Cannot read properties of undefined (reading 'top')`

That error happens after the Excel file has already been parsed, when the NI chart rendering starts.
