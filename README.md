# HPAL Production Monitor

**HPAL Production Monitor** adalah aplikasi web/PWA ringan untuk membantu monitoring produksi HPAL berbasis file Excel timbangan. Aplikasi ini berjalan langsung di browser, mendukung mode offline setelah pertama kali dibuka, dan bisa dipasang ke home screen Android/iOS seperti aplikasi.

**Live app:** [https://slimutebal.github.io/hpal-production-monitor/](https://slimutebal.github.io/hpal-production-monitor/)

---

## Ringkasan

Aplikasi ini dibuat untuk membaca data timbangan dari file Excel, lalu menampilkan ringkasan produksi, ritase, tonase, ore class, kadar Ni, data dome, kontraktor, dan indikasi perpindahan DT.

Fokus utama aplikasi:

- Monitoring produksi HPAL dari data Excel timbangan.
- Membaca data ritase, tonase, ore class, dome, dan kadar Ni.
- Mendeteksi perpindahan DT antar kontraktor/dome/class.
- Menampilkan resume perpindahan per kontraktor.
- Menyediakan tampilan mobile-friendly untuk penggunaan di HP.
- Mendukung PWA/offline cache via GitHub Pages.
- Mendukung instalasi ke home screen Android dan iOS.

---

## Status terbaru

**Current release:** `iOS PWA Tooltip Fix + Dark / Light / Auto UI`

Update terbaru mencakup:

1. **Fix tooltip grafik di iOS PWA**
   - Memperbaiki bug tooltip/popup pada grafik `Analisis NI per Jam` yang tidak bisa hilang ketika aplikasi dibuka dari **Add to Home Screen** di iOS.
   - Menambahkan handler untuk tap/click di luar chart agar tooltip Chart.js dipaksa clear.
   - Mendukung event `pointerdown`, `touchstart`, `click`, `scroll`, dan `visibilitychange`.

2. **Theme UI baru**
   - Dark mode.
   - Light mode.
   - Auto mode mengikuti preferensi sistem/browser.

3. **Data kontraktor permanen diperbarui**
   - Embedded contractor database diperbarui menjadi **705 entri** dari `List_DT.xlsx` terbaru.
   - Data tertanam langsung di aplikasi, sehingga tetap tersedia tanpa upload ulang.

4. **Sub-baris dome collapsible**
   - Baris `HGLO`, `MGLO`, dan `LGLO` sekarang bisa diklik.
   - Ada indikator panah `▸` dan jumlah dome di sampingnya.
   - Sub-baris default tersembunyi.
   - Toggle per class independen: membuka `HGLO` tidak memengaruhi `MGLO` atau `LGLO`.

5. **Kolom ΔNI dirapikan**
   - Header dan isi cell kolom `ΔNI` dibuat rata tengah.

6. **Urutan section diperbaiki**
   - `📋 Resume Perpindahan per Kontraktor` tampil lebih dulu.
   - `🔁 Perpindahan DT` tampil setelahnya.

7. **Perbaikan mobile/PWA sebelumnya tetap dipertahankan**
   - Guard untuk error Android Chrome/WebView pada Chart.js: `Cannot read properties of undefined (reading 'top')`.
   - Local storage compatibility untuk penyimpanan data lokal.
   - Service worker cache untuk penggunaan offline setelah site pertama kali dibuka.

---

## Cara pakai

### 1. Buka aplikasi

Buka link berikut di browser:

[https://slimutebal.github.io/hpal-production-monitor/](https://slimutebal.github.io/hpal-production-monitor/)

### 2. Upload file Excel timbangan

Klik tombol **Pilih File Excel**, lalu pilih file data timbangan.

Format yang ditargetkan:

- File Excel `.xlsx`.
- Sheet utama: `过磅明细`.
- Format data HYNC/SLNC atau format yang sudah didukung oleh parser aplikasi.

### 3. Baca hasil monitoring

Setelah file terbaca, aplikasi akan menampilkan:

- Ringkasan produksi.
- Tonase dan ritase.
- Breakdown ore class.
- Visualisasi kadar Ni.
- Resume perpindahan per kontraktor.
- Perpindahan DT.
- Sub-baris dome per ore class.

---

## Install ke Android

Di Chrome Android:

1. Buka link aplikasi.
2. Tap menu titik tiga.
3. Pilih **Add to Home screen** atau **Install app**.
4. Aplikasi akan muncul di home screen.

Setelah pernah dibuka online, aplikasi dapat digunakan kembali secara offline selama cache browser belum dihapus.

---

## Install ke iPhone/iPad

Di Safari iOS/iPadOS:

1. Buka link aplikasi.
2. Tap tombol **Share**.
3. Pilih **Add to Home Screen**.
4. Tap **Add**.

Catatan iOS:

- Jika aplikasi yang sudah dipasang masih menampilkan versi lama, hapus aplikasi dari home screen lalu tambahkan ulang.
- iOS PWA dapat menahan cache lebih agresif dibanding browser biasa.
- Update terbaru sudah memperbaiki tooltip grafik yang sebelumnya bisa tertahan/sticky saat app dijalankan dari home screen.

---

## Offline mode

Aplikasi mendukung offline mode melalui service worker.

Alur kerja:

```text
Pertama kali:
Online → buka GitHub Pages → file aplikasi tersimpan di cache browser

Setelah itu:
Bisa dibuka dari home screen/browser tanpa internet
```

Catatan:

- Offline mode bergantung pada cache browser.
- Jika browser menghapus site data/cache, aplikasi perlu dibuka online lagi.
- Update aplikasi dari GitHub memerlukan koneksi internet.
- Untuk update besar, terutama di iOS PWA, kadang perlu remove/add ulang dari home screen.

---

## Data dan privasi

Aplikasi ini berjalan di sisi browser.

- File Excel dipilih dari perangkat pengguna.
- Parsing dan perhitungan dilakukan lokal di browser.
- Tidak ada backend/server khusus untuk menerima file Excel.
- Data kontraktor embedded tersimpan di file aplikasi.
- Data lokal tambahan menggunakan `localStorage` browser.

Catatan: karena repository ini public, jangan menyimpan credential, token API, data rahasia perusahaan, atau data sensitif langsung di repository.

---

## Struktur file utama

```text
hpal-production-monitor/
├─ index.html              # Aplikasi utama, termasuk CSS/JS/library inline
├─ manifest.webmanifest    # Konfigurasi PWA
├─ service-worker.js       # Offline cache
├─ .nojekyll               # Mencegah GitHub Pages memproses file sebagai Jekyll
└─ icons/                  # Icon PWA
```

---

## Cara update aplikasi

Untuk update manual via GitHub:

1. Siapkan `index.html` versi terbaru.
2. Jika cache PWA perlu dipaksa refresh, update juga `service-worker.js` dan naikkan nama cache.
3. Upload/replace file di root repo:

```text
index.html
service-worker.js
```

4. Jangan upload ulang `.nojekyll` jika sudah ada.
5. Commit ke branch `main`.
6. Tunggu GitHub Pages deployment selesai.
7. Jika perangkat masih menampilkan versi lama, hapus site data/cache untuk `slimutebal.github.io`.
8. Untuk iOS Add to Home Screen, remove app dari home screen lalu add ulang jika cache masih tertahan.

---

## Changelog

### iOS PWA Tooltip Fix

- Fixed sticky Chart.js tooltip/popup on iOS when the app is launched from **Add to Home Screen**.
- Added outside-tap handling to clear active chart elements.
- Added support for `pointerdown`, `touchstart`, `click`, `scroll`, and `visibilitychange` events.
- Preserved browser behavior where tooltip disappears when tapping outside the chart.
- Bumped PWA cache version to force update delivery.

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

- iOS PWA cache can be persistent. If a deployed update does not appear, remove the home-screen app and add it again.
- Android/Chrome usually receives service worker updates faster, but site data/cache may still need to be cleared after major updates.
- Tooltip behavior differs between normal browser tabs and standalone PWA mode, so both modes should be tested after chart-related changes.

---

## Limitasi

- Aplikasi bergantung pada struktur Excel yang dikenali parser.
- File Excel dengan format kolom/sheet yang berubah jauh bisa gagal dibaca.
- Offline mode bergantung pada cache browser.
- Repository public berarti source aplikasi bisa dilihat publik.

---

## License

No license has been added to this repository. All rights are reserved by default unless a license is added later.
