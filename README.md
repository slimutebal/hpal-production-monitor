# HPAL Production Monitor — Icon Fix

Fix ini hanya menambahkan kembali link PWA/icon di `<head>` `index.html`.

Upload/replace ke root repo:

- `index.html`

Tidak perlu upload ulang:

- `service-worker.js`
- `manifest.webmanifest`
- folder `icons/`
- `.nojekyll`

## Yang diperbaiki

`index.html` sebelumnya tidak memanggil `manifest.webmanifest`, favicon, dan `apple-touch-icon`, sehingga icon PWA/Home Screen bisa gagal dipakai terutama di iOS.

Fix ini menambahkan:

- `link rel="manifest"`
- favicon PNG multi-size
- `apple-touch-icon` 180x180
- metadata Apple/mobile web app

Tidak ada perubahan pada logika aplikasi, parser Excel, chart, Google Sheet sync, service worker, atau data kontraktor.

## Setelah deploy

Jika icon di iOS masih belum berubah, hapus app dari Home Screen lalu add ulang dari Safari. iOS biasanya menyimpan icon Home Screen lama.
