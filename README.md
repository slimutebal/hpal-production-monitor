# HPAL Production Monitor Mobile PWA Fixed Update

This package fixes the broken raw-JavaScript display issue.

Root cause: the previous update injected the service-worker registration before the wrong `</body>` occurrence inside the bundled SheetJS JavaScript string. That prematurely closed the script block and caused the remaining JavaScript to render as page text.

Upload these files to the repository root and replace existing files:

- `index.html`
- `service-worker.js`
- `.nojekyll`

Commit message suggestion:

```text
Fix mobile PWA HTML script injection
```

After GitHub Pages deploys, clear site data or open in Incognito if the old broken page persists due to PWA cache.
