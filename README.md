# HPAL Production Monitor

**HPAL Production Monitor** adalah aplikasi web/PWA ringan untuk membantu monitoring hauling **Limonite** berbasis file Excel timbangan. Aplikasi berjalan langsung di browser, dapat dipasang ke home screen seperti aplikasi, dan mendukung penggunaan offline setelah pertama kali dibuka.

**Live app:** [https://slimutebal.github.io/hpal-production-monitor/](https://slimutebal.github.io/hpal-production-monitor/)

---

## Ringkasan

Aplikasi ini membaca file Excel timbangan lalu menampilkan ringkasan hauling, ritase, tonase, ore class, kadar Ni, ID dome, kontraktor, analisis NI per jam, serta indikasi perpindahan DT.

Fokus utama:

- Monitoring hauling Limonite dari file Excel timbangan.
- Membaca ritase, tonase, ore class, dome, dan kadar Ni.
- Menampilkan visualisasi kadar Ni dan tonase per jam.
- Menganalisis penyumbang naik/turun `ΔNI` terhadap base NI.
- Mendeteksi perpindahan DT antar kontraktor/dome/class.
- Menampilkan resume perpindahan per kontraktor.
- Menyediakan tampilan mobile-friendly untuk Android, iOS, dan PC.
- Mendukung PWA/offline cache via GitHub Pages.

---

## Status rilis terbaru

**Current release:** `v1.6.x — Contractor Sync + NI Indikasi Fix + iOS Tooltip/Icon Fix`

Update terbaru mencakup:

### 1. Data kontraktor bersama via Google Sheet

Data kontraktor tidak lagi hanya bergantung pada data lokal masing-masing device.

- Data kontraktor disinkron dari Google Sheet melalui Google Apps Script Web App.
- Semua user bisa menerima data kontraktor terbaru yang sama ketika online.
- Tombol **➕ Update Kontraktor** untuk input No DT + Nama Kontraktor.
- Tombol **🔄 Sinkron Sekarang** untuk fetch ulang manual.
- Fitur **📄 Update via File Excel** tetap tersedia sebagai override lokal per-device.

Prioritas sumber data kontraktor:

```text
Upload Excel manual device ini → Google Sheet bersama → data bawaan aplikasi
```

### 2. Dukungan offline untuk update kontraktor

- Jika device online saat submit, data langsung terkirim ke Google Sheet.
- Jika device offline, data tetap berlaku di device itu dan masuk antrean lokal.
- Saat device online kembali, antrean lokal akan dikirim ke Google Sheet.

### 3. Logika INDIKASI NI per jam diperbaiki

Kolom **INDIKASI** pada tabel `Analisis NI per Jam` menggunakan kontribusi terhadap base NI, bukan sekadar perubahan mix antar jam.

Aturan label:

```text
abs(ΔNI) < 0.009          → —
0.009 <= abs(ΔNI) < 0.015 → Mix sedikit berubah
abs(ΔNI) >= 0.015         → penyumbang utama + faktor penahan opsional
```

Contoh label:

```text
↓ LGLO -0.030 DOME-12; ↑ HGLO +0.008 DOME-03
```

Makna label:

- `↓ LGLO -0.030 DOME-12` = penyumbang utama yang menarik NI turun.
- `↑ HGLO +0.008 DOME-03` = faktor penahan yang membantu menahan penurunan NI.

### 4. Fix tooltip grafik di iOS PWA

- Memperbaiki tooltip/popup grafik `Analisis NI per Jam` yang bisa tertahan saat app dibuka dari **Add to Home Screen** di iOS.
- Tap/click di luar chart akan memaksa tooltip Chart.js hilang.
- Event yang ditangani: `pointerdown`, `touchstart`, `click`, `scroll`, dan `visibilitychange`.

### 5. Fix PWA/Home Screen icon

- Menambahkan kembali link `manifest.webmanifest` di `index.html`.
- Menambahkan favicon PNG multi-size.
- Menambahkan `apple-touch-icon` untuk iOS.
- Menambahkan metadata Apple/mobile web app.

### 6. Theme dan tampilan

- Dark mode.
- Light mode.
- Auto mode mengikuti preferensi sistem/browser.
- Sub-baris dome collapsible untuk `HGLO`, `MGLO`, dan `LGLO`.
- Header dan isi cell kolom `ΔNI` rata tengah.
- `📋 Resume Perpindahan per Kontraktor` tampil sebelum `🔁 Perpindahan DT`.

### 7. Service worker dan cache

- Cache version dinaikkan ke `v1.6.0-contractor-sync`.
- Request lintas-origin seperti Google Apps Script tidak ikut di-cache.
- Ini mencegah data kontraktor dari Google Sheet menjadi basi karena tertahan cache lama.

---

## Cara pakai

### 1. Buka aplikasi

Buka:

[https://slimutebal.github.io/hpal-production-monitor/](https://slimutebal.github.io/hpal-production-monitor/)

### 2. Upload file Excel timbangan

Klik **Pilih File Excel**, lalu pilih file `.xlsx`.

Format yang ditargetkan:

- File Excel `.xlsx`.
- Sheet utama: `过磅明细`.
- Format data FPP atau format lain yang sudah didukung parser aplikasi.

### 3. Baca hasil monitoring

Aplikasi akan menampilkan:

- Ringkasan hauling/produksi.
- Tonase dan ritase.
- Breakdown ore class.
- Visualisasi kadar Ni.
- Analisis NI per jam.
- Indikasi penyumbang `ΔNI`.
- Resume perpindahan per kontraktor.
- Perpindahan DT.
- Sub-baris dome per ore class.

---

## Panduan instalasi

### Android

Gunakan Chrome Android.

1. Buka link aplikasi:

   [https://slimutebal.github.io/hpal-production-monitor/](https://slimutebal.github.io/hpal-production-monitor/)

2. Tunggu halaman terbuka sempurna.
3. Tap menu titik tiga di kanan atas Chrome.
4. Pilih **Add to Home screen** atau **Install app**.
5. Konfirmasi nama aplikasi.
6. Aplikasi akan muncul di Home Screen.

Catatan Android:

- Setelah pernah dibuka online, aplikasi bisa dibuka kembali dari cache saat offline.
- Jika update belum muncul, hapus site data/cache untuk `slimutebal.github.io`, lalu buka ulang.
- Jika icon masih lama, hapus shortcut/app dari Home Screen lalu install ulang.

### iPhone / iPad

Gunakan Safari. Untuk iOS, instalasi PWA sebaiknya dilakukan dari Safari, bukan dari Chrome.

1. Buka Safari.
2. Buka link aplikasi:

   [https://slimutebal.github.io/hpal-production-monitor/](https://slimutebal.github.io/hpal-production-monitor/)

3. Tunggu halaman terbuka sempurna.
4. Tap tombol **Share**.
5. Pilih **Add to Home Screen**.
6. Tap **Add**.
7. Aplikasi akan muncul di Home Screen.

Catatan iOS:

- Jika aplikasi yang sudah dipasang masih menampilkan versi lama, hapus app dari Home Screen lalu tambahkan ulang dari Safari.
- iOS PWA sering menahan cache dan icon lebih lama dibanding browser biasa.
- Jika icon tidak berubah setelah update, remove dari Home Screen lalu Add to Home Screen ulang.
- Tooltip grafik iOS sudah diperbaiki, tetapi chart-related changes tetap perlu dites di mode Safari biasa dan mode Home Screen.

### PC / Laptop

Bisa digunakan langsung dari browser modern.

Rekomendasi browser:

- Google Chrome.
- Microsoft Edge.
- Safari macOS.

Cara menggunakan di PC:

1. Buka link aplikasi:

   [https://slimutebal.github.io/hpal-production-monitor/](https://slimutebal.github.io/hpal-production-monitor/)

2. Upload file Excel timbangan.
3. Gunakan langsung di browser.

Install sebagai aplikasi desktop:

#### Chrome / Edge

1. Buka link aplikasi.
2. Klik icon install di address bar jika muncul.
3. Atau buka menu titik tiga.
4. Pilih **Install HPAL Production Monitor** / **Apps → Install this site as an app**.
5. Aplikasi akan terbuka seperti aplikasi desktop.

Catatan PC:

- Jika update belum muncul, lakukan hard refresh atau hapus site data/cache.
- Untuk Chrome/Edge, bisa cek di `Settings → Privacy and security → Site settings → View permissions and data stored across sites`, lalu hapus data untuk `slimutebal.github.io`.

---

## Fitur utama

| Fitur | Keterangan |
|---|---|
| Upload Excel | Membaca file `.xlsx` timbangan dari perangkat pengguna. |
| Analisis NI per jam | Menampilkan tonase per ore class dan line kadar NI per jam. |
| Indikasi ΔNI | Menjelaskan penyumbang utama naik/turun NI dari base. |
| Sync kontraktor | Mengambil dan mengirim data kontraktor melalui Google Sheet. |
| Offline queue | Update kontraktor saat offline disimpan lokal lalu dikirim saat online. |
| Resume kontraktor | Merangkum perpindahan DT per kontraktor. |
| Perpindahan DT | Menampilkan indikasi perpindahan DT antar dome/class/kontraktor. |
| Collapsible dome rows | Baris dome per `HGLO`, `MGLO`, dan `LGLO` dapat dibuka/tutup. |
| Theme mode | Mendukung dark, light, dan auto mode. |
| PWA/offline | Bisa dipasang ke Home Screen/desktop dan digunakan kembali dari cache. |

---

## Offline mode

Aplikasi mendukung offline mode melalui service worker.

```text
Pertama kali:
Online → buka GitHub Pages → file aplikasi tersimpan di cache browser

Setelah itu:
Bisa dibuka dari Home Screen/browser tanpa internet
```

Catatan:

- Offline mode bergantung pada cache browser.
- Jika browser menghapus site data/cache, aplikasi perlu dibuka online lagi.
- Update aplikasi dari GitHub memerlukan koneksi internet.
- Untuk update besar, terutama di iOS PWA, kadang perlu remove/add ulang dari Home Screen.
- Data kontraktor dari Google Sheet membutuhkan koneksi internet untuk sinkronisasi.
- Update kontraktor saat offline akan disimpan lokal terlebih dahulu.

---

## Data dan privasi

Aplikasi ini berjalan di sisi browser.

- File Excel dipilih dari perangkat pengguna.
- Parsing dan perhitungan file Excel dilakukan lokal di browser.
- Tidak ada backend khusus untuk menerima file Excel.
- Data kontraktor bawaan tersimpan di file aplikasi.
- Data kontraktor bersama disinkron melalui Google Sheet / Google Apps Script.
- Data lokal tambahan menggunakan `localStorage` browser.

Catatan: repository ini public untuk kebutuhan deployment. Jangan menyimpan credential, token API, data rahasia perusahaan, atau data sensitif langsung di repository.

---

## Struktur file utama

```text
hpal-production-monitor/
├─ index.html              # Aplikasi utama, termasuk CSS/JS/library inline
├─ manifest.webmanifest    # Konfigurasi PWA dan icon Android/desktop
├─ service-worker.js       # Offline cache dan cache routing
├─ .nojekyll               # Mencegah GitHub Pages memproses file sebagai Jekyll
└─ icons/                  # Icon PWA/Home Screen
```

---

## Catatan maintenance

Untuk update manual via GitHub:

1. Siapkan `index.html` versi terbaru.
2. Jika cache PWA perlu dipaksa refresh, update juga `service-worker.js` dan naikkan nama cache.
3. Upload/replace file yang berubah saja.
4. Jangan upload ulang `.nojekyll` jika sudah ada.
5. Commit ke branch `main`.
6. Tunggu GitHub Pages deployment selesai.
7. Jika perangkat masih menampilkan versi lama, hapus site data/cache untuk `slimutebal.github.io`.
8. Untuk iOS Add to Home Screen, remove app dari Home Screen lalu add ulang jika cache/icon masih tertahan.

File yang biasanya berubah saat update aplikasi:

```text
index.html
service-worker.js
```

File yang biasanya tidak perlu diubah:

```text
.nojekyll
icons/
manifest.webmanifest
```

---

## Changelog

### v1.6.x — Contractor Sync + Icon Fix

- Added shared contractor data sync through Google Sheet / Google Apps Script.
- Added contractor update popup.
- Added manual sync button.
- Added offline queue for contractor updates.
- Fixed service worker cache behavior so cross-origin Google Apps Script requests are not cached.
- Restored PWA manifest/icon links in `index.html`.
- Restored `apple-touch-icon` and mobile web app metadata.

### NI Indikasi Fix

- Improved `INDIKASI` logic in `Analisis NI per Jam`.
- Replaced simple mix-change indication with contribution-based explanation against base NI.
- Added threshold logic:
  - `abs(ΔNI) < 0.009` → `—`
  - `0.009 <= abs(ΔNI) < 0.015` → `Mix sedikit berubah`
  - `abs(ΔNI) >= 0.015` → contributor analysis
- Added compact contributor label format:

```text
↓ LGLO -0.030 DOME-12; ↑ HGLO +0.008 DOME-03
```

- Added optional holding-factor display when the counter-contribution is meaningful.

### iOS PWA Tooltip Fix

- Fixed sticky Chart.js tooltip/popup on iOS when the app is launched from **Add to Home Screen**.
- Added outside-tap handling to clear active chart elements.
- Added support for `pointerdown`, `touchstart`, `click`, `scroll`, and `visibilitychange` events.
- Preserved browser behavior where tooltip disappears when tapping outside the chart.

### Dark / Light / Auto UI Update

- Added dark, light, and auto theme modes.
- Updated embedded contractor data to 705 entries.
- Added collapsible dome sub-rows for `HGLO`, `MGLO`, and `LGLO`.
- Center-aligned `ΔNI` column header and cells.
- Moved `Resume Perpindahan per Kontraktor` above `Perpindahan DT`.
- Preserved Android chart rendering fix.
- Preserved PWA/offline support.

### Mobile PWA ChartFix

- Fixed Android Chrome/WebView chart rendering issue.
- Added guard against missing Chart.js geometry/chart area during first draw.
- Prevented error: `Cannot read properties of undefined (reading 'top')`.

### Initial PWA Release

- Published app through GitHub Pages.
- Added PWA manifest.
- Added service worker offline cache.
- Added mobile install support via Chrome/Safari.

---

## Known notes

- iOS PWA cache and icon can be persistent. If a deployed update does not appear, remove the Home Screen app and add it again.
- Android/Chrome usually receives service worker updates faster, but site data/cache may still need to be cleared after major updates.
- Tooltip behavior differs between normal browser tabs and standalone PWA mode, so both modes should be tested after chart-related changes.
- GitHub Pages deployment dapat sesekali stuck/queued. Jika live app masih berjalan, deployment terakhir yang sukses tetap aktif.

---

## Limitasi

- Aplikasi bergantung pada struktur Excel yang dikenali parser.
- File Excel dengan format kolom/sheet yang berubah jauh bisa gagal dibaca.
- Offline mode bergantung pada cache browser.
- Sinkronisasi data kontraktor membutuhkan koneksi internet.
- Repository public berarti source aplikasi bisa dilihat publik.

---

## License

This project is proprietary and not open source.

Copyright © 2026 Illofiajie. All rights reserved.

Public visibility on GitHub is provided only for deployment and maintenance purposes.  
Use, copying, modification, redistribution, rebranding, resale, or ownership claims are prohibited without prior written permission.

Authorized use is limited to the approved internal company/work environment only.
