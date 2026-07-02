# HPAL Production Monitor — PWA Installable

Paket ini adalah versi PWA dari `HPAL Production Monitor`.

## Isi paket

```text
HPALProductionMonitor_PWA/
├─ index.html
├─ manifest.webmanifest
├─ service-worker.js
├─ netlify.toml
├─ .nojekyll
└─ icons/
   ├─ icon-192.png
   ├─ icon-512.png
   ├─ icon-maskable-192.png
   └─ icon-maskable-512.png
```

## Cara paling mudah: Netlify Drop

1. Buka Netlify Drop dari browser PC/laptop.
2. Drag-and-drop seluruh folder `HPALProductionMonitor_PWA`.
3. Netlify akan membuat URL `https://...netlify.app`.
4. Buka URL itu di Chrome Android.
5. Tap menu titik tiga Chrome.
6. Pilih **Add to Home screen** atau **Install app**.
7. Aplikasi akan muncul di home screen Android dengan icon HPAL.

## Alternatif: GitHub Pages

1. Buat repository baru, misalnya `hpal-production-monitor-pwa`.
2. Upload semua isi folder ini ke repository.
3. Buka **Settings > Pages**.
4. Source: `Deploy from a branch`.
5. Branch: `main`, folder: `/root`.
6. Buka URL GitHub Pages dari Chrome Android.
7. Pilih **Add to Home screen** atau **Install app**.

## Catatan penting

- Jangan buka dari file lokal `file://...` kalau ingin fitur PWA penuh. Service Worker dan install prompt butuh HTTPS.
- Setelah pertama kali dibuka dari URL HTTPS, aplikasi bisa berjalan offline karena `index.html`, manifest, service worker, dan icon sudah di-cache.
- Fitur upload Excel tetap memakai file picker dari browser/Android.
- Data lokal disimpan menggunakan `localStorage` lewat compatibility shim `window.storage`.
- Orientasi app diset `any`, jadi bisa portrait maupun landscape.

## Cara update versi

1. Ganti file di hosting dengan versi baru.
2. Ubah `CACHE_NAME` di `service-worker.js`, misalnya dari:

```js
hpal-production-monitor-v1.0.0
```

menjadi:

```js
hpal-production-monitor-v1.0.1
```

3. Buka ulang app di Android. Chrome akan mengambil cache baru.

## Troubleshooting

### Tombol Install tidak muncul

Coba langkah ini:

1. Pastikan URL memakai `https://`.
2. Buka dari Chrome Android, bukan preview file manager.
3. Reload halaman.
4. Menu titik tiga > **Add to Home screen**.
5. Kalau tetap hanya menjadi shortcut, itu masih bisa dipakai; tampilannya tetap membuka app dari home screen.

### Aplikasi belum offline

1. Buka app sekali saat internet aktif.
2. Tunggu halaman selesai loading.
3. Tutup Chrome.
4. Matikan internet.
5. Buka lagi dari icon home screen.

### Upload Excel tidak bereaksi

Pastikan file `.xlsx` dipilih dari storage Android yang bisa diakses Chrome. Hindari file yang masih hanya placeholder cloud dan belum tersimpan offline di HP.
