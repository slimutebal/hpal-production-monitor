# HPAL Production Monitor

**HPAL Production Monitor** adalah aplikasi web/PWA untuk membantu monitoring hauling **Limonite** dan pembuatan laporan produksi harian berbasis file Excel timbangan. Aplikasi berjalan langsung di browser, dapat dipasang ke home screen seperti aplikasi, dan mendukung penggunaan offline setelah pertama kali dibuka.

**Live app:** [https://slimutebal.github.io/hpal-production-monitor/](https://slimutebal.github.io/hpal-production-monitor/)

---

## Ringkasan

Mulai V2.0, aplikasi ini menjadi aplikasi tiga halaman dengan navigasi bawah (bottom navigation) seperti aplikasi mobile:

| Halaman | Route | Fungsi |
| --- | --- | --- |
| **Monitor** | `#/monitor` | Analisis hauling dari file Excel timbangan — fungsi utama yang sudah ada sebelumnya, tidak berubah. |
| **Report** | `#/report` | Generator laporan produksi harian. Mendukung buyer **HYNC** dan **SLNC**, terdeteksi otomatis dari teks report sebelumnya dan file timbangan. |
| **Settings** | `#/settings` | Placeholder untuk pengaturan personel, kontraktor, dan lisensi di versi berikutnya. |

Fokus utama:

- Monitoring hauling Limonite dari file Excel timbangan (halaman Monitor).
- Membaca ritase, tonase, ore class, dome, dan kadar Ni.
- Menampilkan visualisasi kadar Ni dan tonase per jam.
- Menganalisis penyumbang naik/turun `ΔNI` terhadap base NI.
- Mendeteksi perpindahan DT antar kontraktor/dome/class.
- Membuat **Daily Production Geology Report** untuk buyer HYNC dan SLNC, dengan buyer terdeteksi otomatis (halaman Report).
- Menyediakan tampilan mobile-friendly untuk Android, iOS, dan PC.
- Mendukung PWA/offline cache via GitHub Pages.

Catatan lingkup V2.0:

- Monitor mempertahankan seluruh fungsi yang sudah ada — tidak ada perubahan rumus, parser, atau grafik selama integrasi ke struktur tiga halaman.
- Report mendukung **HYNC** dan **SLNC** melalui satu halaman/UI yang sama — buyer terdeteksi otomatis dari teks report sebelumnya (token `FPP HYNC` / `FPP SLNC`) dan dari kolom `备注` di file timbangan (prefix `SCHY` / `SCSL`). Report untuk buyer lain (ESG) masih direncanakan untuk versi berikutnya dan **belum tersedia**.
- Settings masih berupa placeholder — belum ada pengaturan yang bisa diubah pengguna di V2.0.

---

## Status rilis terbaru

**Current release:** `v2.1.0 — HYNC + SLNC Report`

V2.1 menambahkan:

1. Dukungan buyer **SLNC** di halaman Report, memakai satu UI/route yang sama dengan HYNC (`#/report`) — tidak ada route atau halaman Report terpisah per buyer.
2. Deteksi buyer otomatis dari teks report sebelumnya (token `FPP HYNC` / `FPP SLNC`) dan dari kolom `备注` file timbangan (prefix `SCHY` → HYNC, `SCSL` → SLNC).
3. Popup informasi saat teks report sebelumnya dan file timbangan terdeteksi berasal dari buyer yang berbeda, atau saat kolom `备注` pada file timbangan tidak konsisten/tidak bisa dikenali — progres ke Step 2 diblokir sampai keduanya sesuai.
4. Beberapa kode FPP berbeda milik buyer yang sama dalam satu file timbangan (mis. beberapa `SCSL-xxxxxxx` berbeda) tetap diterima tanpa peringatan — yang dibandingkan hanya identitas buyer, bukan kode FPP lengkap.
5. Parser dan builder laporan HYNC/SLNC kini berbagi satu modul inti (`js/pages/report/profiles/shared-report-profile.js`), dipilih lewat `profile-registry.js`; label buyer pada UI dan teks laporan menyesuaikan otomatis.

Rilis sebelumnya (`v2.0.0 — Three-Page App Shell + HYNC Production Report`) menambahkan app shell tiga halaman, routing berbasis hash, bottom navigation, dan generator Report HYNC pertama kali — lihat [Changelog](#changelog) untuk detail lengkap.

Detail lengkap fitur Monitor yang dipertahankan ada di bagian [Monitor](#monitor) di bawah, dan detail Report HYNC/SLNC ada di bagian [Report HYNC dan SLNC](#report-hync-dan-slnc).

---

## Cara pakai

Navigasi antar halaman menggunakan **bottom navigation** (Monitor / Report / Settings) yang selalu terlihat di bagian bawah layar, baik di HP maupun desktop. Berpindah halaman tidak melakukan reload — data yang sudah diisi di satu halaman tetap ada saat kembali dari halaman lain.

### Menggunakan Monitor

1. Buka halaman **Monitor** (default saat aplikasi pertama dibuka).
2. Klik **Pilih File Excel** pada kartu **Data Timbangan**, lalu pilih file `.xlsx` timbangan (sheet pertama: `过磅明细`).
3. Aplikasi menampilkan ringkasan hauling/produksi, tonase dan ritase, breakdown ore class, visualisasi kadar Ni, analisis NI per jam, indikasi penyumbang `ΔNI`, resume perpindahan per kontraktor, perpindahan DT, dan sub-baris dome per ore class.

### Menggunakan Report

1. Buka halaman **Report**.
2. Di **Step 1 — Input**: paste teks report shift sebelumnya, upload file timbangan (`.xlsx`/`.xls`, buyer HYNC atau SLNC terdeteksi otomatis), lalu isi Week, PIC SCM, PIC AWK, Manpower AWK, Total Manpower, Problem, dan Preventive Action.
3. Di **Step 2 — Area Muat**: pilih area (BR1 / BR23E / BR23W / DS) untuk setiap dome yang terdeteksi dari file.
4. Di **Step 3 — Hasil**: cek preview laporan, lalu tekan **Copy Laporan** untuk menyalin ke clipboard (siap ditempel ke WA Group).

Upload file di Report terpisah dari upload file di Monitor — keduanya membaca file masing-masing secara independen.

### Menggunakan Settings

Halaman Settings saat ini hanya berupa placeholder. Belum ada pengaturan yang bisa diubah pengguna di V2.0 — pengaturan personel, kontraktor, dan lisensi direncanakan untuk versi berikutnya.

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
- Validasi final bottom navigation dan safe-area di perangkat iOS asli masih perlu dilakukan (lihat [Limitasi](#limitasi)).

### PC / Laptop

Bisa digunakan langsung dari browser modern.

Rekomendasi browser:

- Google Chrome.
- Microsoft Edge.
- Safari macOS.

Cara menggunakan di PC:

1. Buka link aplikasi:

   [https://slimutebal.github.io/hpal-production-monitor/](https://slimutebal.github.io/hpal-production-monitor/)

2. Gunakan navigasi bawah untuk berpindah antara Monitor, Report, dan Settings.
3. Upload file Excel sesuai halaman yang digunakan.

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

## Monitor

Monitor adalah halaman analisis hauling yang sudah tersedia sejak sebelum V2.0. **Perilaku Monitor dipertahankan penuh selama integrasi ke struktur app shell V2.0** — tidak ada perubahan rumus, parser Excel, grafik, atau contractor sync. Monitor hanya dipindahkan ke dalam page container dan sistem navigasi baru.

### Data kontraktor bersama via Google Sheet

Data kontraktor tidak hanya bergantung pada data lokal masing-masing device.

- Data kontraktor disinkron dari Google Sheet melalui Google Apps Script Web App.
- Semua user bisa menerima data kontraktor terbaru yang sama ketika online.
- Tombol **➕ Update Kontraktor** untuk input No DT + Nama Kontraktor.
- Tombol **🔄 Sinkron Sekarang** untuk fetch ulang manual.
- Fitur **📄 Update via File Excel** tetap tersedia sebagai override lokal per-device.

Prioritas sumber data kontraktor:

```text
Upload Excel manual device ini → Google Sheet bersama → data bawaan aplikasi
```

### Dukungan offline untuk update kontraktor

- Jika device online saat submit, data langsung terkirim ke Google Sheet.
- Jika device offline, data tetap berlaku di device itu dan masuk antrean lokal.
- Saat device online kembali, antrean lokal akan dikirim ke Google Sheet.

### Logika INDIKASI NI per jam

Kolom **INDIKASI** pada tabel `Analisis NI per Jam` menggunakan kontribusi terhadap base NI, bukan sekadar perubahan mix antar jam.

Aturan label:

```text
abs(ΔNI) < 0.009          → —
0.009 <= abs(ΔNI) < 0.015 → Mix sedikit berubah
abs(ΔNI) >= 0.015         → penyumbang utama + faktor penahan opsional
```

Contoh label (ilustrasi, bukan data operasional):

```text
↓ LGLO -0.030 DOME-12; ↑ HGLO +0.008 DOME-03
```

Makna label:

- `↓ LGLO -0.030 DOME-12` = penyumbang utama yang menarik NI turun.
- `↑ HGLO +0.008 DOME-03` = faktor penahan yang membantu menahan penurunan NI.

### Tooltip grafik di iOS PWA

- Tooltip/popup grafik `Analisis NI per Jam` tidak tertahan saat app dibuka dari **Add to Home Screen** di iOS.
- Tap/click di luar chart akan memaksa tooltip Chart.js hilang.
- Event yang ditangani: `pointerdown`, `touchstart`, `click`, `scroll`, dan `visibilitychange`.

### Theme dan tampilan

- Dark mode.
- Light mode.
- Auto mode mengikuti preferensi sistem/browser.
- Sub-baris dome collapsible untuk `HGLO`, `MGLO`, dan `LGLO`.
- Header dan isi cell kolom `ΔNI` rata tengah.
- `📋 Resume Perpindahan per Kontraktor` tampil sebelum `🔁 Perpindahan DT`.

---

## Report HYNC dan SLNC

Halaman **Report** (`#/report`) adalah satu UI yang sama untuk buyer **HYNC** maupun **SLNC** — tidak ada route atau halaman terpisah per buyer. Buyer terdeteksi otomatis, lalu label di UI dan teks laporan yang dihasilkan menyesuaikan:

```text
DAILY PRODUCTION GEOLOGY REPORT
HPAL Ore Selling SCM — FPP HYNC
```

atau

```text
DAILY PRODUCTION GEOLOGY REPORT
HPAL Ore Selling SCM — FPP SLNC
```

Seluruh parsing dan perhitungan Report dilakukan **lokal di browser**, sama seperti Monitor. Report ESG masih direncanakan untuk versi berikutnya dan belum diimplementasikan (lihat [Limitasi](#limitasi)).

### Deteksi buyer otomatis

Buyer dideteksi dari dua sumber, dan progres ke Step 2 baru diizinkan setelah keduanya cocok:

1. **Teks report sebelumnya** — dicari token `FPP HYNC` atau `FPP SLNC` (case-insensitive, toleran multi-spasi). Bila teks menyebut keduanya sekaligus, dianggap ambigu dan diblokir. Bila tidak ada token yang ditemukan, buyer dianggap belum terdeteksi dan diblokir (tidak pernah default diam-diam ke HYNC).
2. **File timbangan** — dibaca dari kolom **备注** (header, bukan asumsi posisi kolom tetap): nilai yang diawali `SCHY` berarti HYNC, diawali `SCSL` berarti SLNC. Hanya prefix yang dibandingkan, bukan kode lengkap — beberapa kode berbeda milik buyer yang sama (mis. `SCSL-0000033` dan `SCSL-0000034` dalam satu file) **valid** dan tidak memicu peringatan. File diblokir jika: ada baris data valid dengan `备注` kosong atau berisi nilai yang tidak dikenali, atau file berisi campuran `SCHY` dan `SCSL` sekaligus.

Jika kedua sumber terdeteksi tapi buyer-nya berbeda (atau salah satu sumber tidak valid), aplikasi menampilkan popup informasi yang menjelaskan buyer yang terdeteksi dari masing-masing sumber dan memblokir lanjut ke Step 2 sampai diperbaiki. Sebelum kedua sumber lengkap, label UI diperbarui secara sementara (provisional) dari sumber yang sudah ada.

### Alur tiga langkah

#### 1. Input

- Teks report shift sebelumnya (wajib — dipakai untuk ambil tanggal & angka Daily/WTD/MTD/YTD lama, dan untuk deteksi buyer).
- File Excel timbangan (wajib; buyer HYNC atau SLNC, terdeteksi otomatis).
- Week.
- PIC SCM.
- PIC AWK.
- Manpower AWK.
- Total Manpower.
- Problem (boleh kosong, tampil sebagai `-` di laporan).
- Preventive Action (boleh kosong, tampil sebagai `-` di laporan).

Format file yang didukung (sama untuk HYNC dan SLNC):

- `.xlsx` atau `.xls`.
- Sheet yang diutamakan: `过磅明细`.
- Header kolom yang wajib ada:
  - `流水号`
  - `车号`
  - `净重`
  - `毛重时间`
  - `日期`
  - `规格`
- Kolom `备注` dibaca untuk deteksi buyer (lihat di atas).

Jika sheet atau header yang dibutuhkan tidak ditemukan, aplikasi menampilkan pesan error yang jelas dan tidak melanjutkan ke langkah berikutnya.

#### 2. Area Muat

- Semua dome unik yang terdeteksi dari file ditampilkan.
- Setiap dome menampilkan nama dome dan ore class.
- Setiap dome wajib diberi salah satu area: **BR1**, **BR23E**, **BR23W**, atau **DS** sebelum bisa lanjut ke Step 3.

#### 3. Hasil

Menampilkan:

- Tanggal dan shift terdeteksi.
- On Shift tonnage dan ritase.
- Jumlah DT dan ADT.
- Breakdown jumlah truck per kontraktor.
- Loading point per area (DS / BR1 / BR23E / BR23W).
- Daily, WTD, MTD, YTD.
- Problem dan Preventive Action.
- Preview teks laporan lengkap, dengan tombol **Copy Laporan** untuk menyalin ke clipboard.

### Penyimpanan state Report

Input dan hasil laporan yang sudah dibuat tetap tersimpan selama pengguna berpindah ke Monitor atau Settings lalu kembali ke Report, karena halaman Report tidak dibangun ulang saat berpindah rute. State Report bersifat in-memory (sesi berjalan) — akan hilang saat refresh, tab ditutup, atau tombol Reset ditekan. Report **tidak** menyediakan riwayat laporan permanen di V2.0.

### Ringkasan perhitungan

#### On Shift tonnage

```text
On Shift tonnage = jumlah seluruh net weight valid / 1000
```

#### On Shift ritase

```text
On Shift ritase = jumlah record valid
```

#### Daily

```text
Day Shift                                        → Daily = On Shift
Night Shift, tanggal report sebelumnya sama       → Daily = Previous Daily + On Shift
Night Shift, tanggal report sebelumnya berbeda     → Daily = On Shift
```

#### Akumulasi

```text
WTD = Previous WTD + On Shift
MTD = Previous MTD + On Shift
YTD = Previous YTD + On Shift
```

#### Ore class

```text
Ni > 1.4   → HGLO
Ni < 1.2   → LGLO
lainnya    → MGLO
```

---

## Fitur utama

| Fitur | Keterangan |
| --- | --- |
| Three-page navigation | Monitor, Report, dan Settings melalui bottom navigation ala aplikasi mobile. |
| Upload Excel | Membaca file `.xlsx` timbangan dari perangkat pengguna (Monitor). |
| Analisis NI per jam | Menampilkan tonase per ore class dan line kadar NI per jam. |
| Indikasi ΔNI | Menjelaskan penyumbang utama naik/turun NI dari base. |
| Sync kontraktor | Mengambil dan mengirim data kontraktor melalui Google Sheet. |
| Offline queue | Update kontraktor saat offline disimpan lokal lalu dikirim saat online. |
| Resume kontraktor | Merangkum perpindahan DT per kontraktor. |
| Perpindahan DT | Menampilkan indikasi perpindahan DT antar dome/class/kontraktor. |
| Collapsible dome rows | Baris dome per `HGLO`, `MGLO`, dan `LGLO` dapat dibuka/tutup. |
| Theme mode | Mendukung dark, light, dan auto mode. |
| Report HYNC & SLNC | Membuat Daily Production Geology Report untuk buyer HYNC atau SLNC (terdeteksi otomatis) dari file timbangan terpisah. |
| Report state preservation | Input dan laporan yang sudah dibuat tetap ada saat berpindah halaman dalam satu sesi. |
| Settings placeholder | Reserved untuk pengaturan personel, kontraktor, dan lisensi di versi berikutnya. |
| PWA/offline | Bisa dipasang ke Home Screen/desktop dan digunakan kembali dari cache. |

---

## Offline mode

Aplikasi mendukung offline mode melalui service worker. Cache app-shell V2.0 mencakup:

- `index.html`, `manifest.webmanifest`, `contractor-assignment.js`.
- CSS app shell, bottom navigation, Report, dan Settings (`assets/css/*.css`).
- JavaScript app shell dan router (`js/app.js`, `js/router.js`, `js/components/bottom-navigation.js`).
- JavaScript Report (profil HYNC dan SLNC berbagi satu modul inti) dan adapter kontraktor (`js/pages/report/**`, `js/services/contractor-adapter.js`).
- JavaScript halaman Settings placeholder.
- Icon PWA dan manifest.

```text
Pertama kali:
Online → buka GitHub Pages → file aplikasi tersimpan di cache browser

Setelah itu:
Bisa dibuka dari Home Screen/browser tanpa internet
```

Catatan penting:

- Yang dicache adalah **file aplikasi** (HTML/CSS/JS/icon) — file Excel operasional (timbangan Monitor maupun Report HYNC/SLNC) **tidak** diupload atau disimpan oleh service worker; file tetap diproses lokal di browser saat dipilih pengguna.
- Sinkronisasi kontraktor via Google Sheet tetap membutuhkan koneksi internet.
- Perilaku copy ke clipboard bergantung pada izin/permission browser yang sedang digunakan.
- Load pertama setelah setiap deployment baru tetap membutuhkan koneksi internet.
- Jika browser menghapus site data/cache, aplikasi perlu dibuka online lagi.
- Untuk update besar, terutama di iOS PWA, kadang perlu remove/add ulang dari Home Screen.
- Validasi final perilaku offline/PWA di perangkat Android dan iOS asli masih perlu dilakukan — lihat [Limitasi](#limitasi).

---

## Data dan privasi

Aplikasi ini berjalan di sisi browser.

- File Excel dipilih dari perangkat pengguna.
- Parsing dan perhitungan file Excel Monitor dilakukan lokal di browser.
- Parsing Excel timbangan Report (HYNC maupun SLNC) juga dilakukan lokal di browser.
- Teks report sebelumnya yang di-paste di halaman Report hanya tersimpan di state halaman/sesi saat ini.
- Teks laporan hasil Report hanya disalin ke clipboard saat pengguna menekan tombol Copy.
- Tidak ada backend khusus untuk menerima file Excel Monitor maupun file Excel Report.
- Halaman Report tidak menyediakan riwayat laporan permanen di V2.0.
- Data kontraktor bawaan tersimpan di file aplikasi.
- Data kontraktor bersama (Monitor) disinkron melalui Google Sheet / Google Apps Script.
- Data lokal tambahan menggunakan `localStorage` browser.

Catatan: repository ini public hanya untuk kebutuhan deployment.

---

## Struktur file utama

```text
hpal-production-monitor/
├── index.html
├── manifest.webmanifest
├── service-worker.js
├── contractor-assignment.js
├── assets/
│   └── css/
│       ├── app-shell.css
│       ├── bottom-navigation.css
│       ├── report-hync.css
│       └── settings.css
├── js/
│   ├── app.js
│   ├── router.js
│   ├── components/
│   │   └── bottom-navigation.js
│   ├── services/
│   │   └── contractor-adapter.js
│   └── pages/
│       ├── report/
│       │   ├── report-page.js
│       │   ├── report-state.js
│       │   ├── report-utils.js
│       │   └── profiles/
│       │       ├── profile-registry.js
│       │       ├── shared-report-profile.js
│       │       ├── hync-profile.js
│       │       └── slnc-profile.js
│       └── settings/
│           └── settings-page.js
├── docs/
│   ├── V2.0_ARCHITECTURE_AND_ROADMAP.md
│   ├── V2.1_HYNC_SLNC_REPORT_ARCHITECTURE.md
│   └── references/
└── icons/
```

Catatan:

- `docs/references/` berisi referensi implementasi (mis. generator HYNC sumber) yang dipakai sebagai acuan perilaku Report — bukan bagian dari app shell produksi, dan tidak dicache oleh service worker.
- Report ESG **belum diimplementasikan**. Report HYNC dan SLNC sudah tersedia sejak v2.1.0.
- Arsitektur as-built Report HYNC dan SLNC (profile registry, engine bersama, deteksi buyer, popup mismatch) didokumentasikan lengkap di [V2.1 HYNC and SLNC Report Architecture](docs/V2.1_HYNC_SLNC_REPORT_ARCHITECTURE.md).

---

## Changelog

### v2.1.0 — HYNC + SLNC Report

- Added SLNC as a second Report buyer profile, sharing the same Report UI/route as HYNC (`#/report`) — no separate route or duplicated page per buyer.
- Added automatic buyer detection from the previous-report text (`FPP HYNC` / `FPP SLNC` token, case-insensitive) and from the workbook's `备注` column (`SCHY` → HYNC, `SCSL` → SLNC prefix match).
- Added a buyer-resolution state machine (`unknown` / `pendingWorkbook` / `pendingPreviousReport` / `confirmed` / `mismatch` / `invalidWorkbook` / `ambiguousPreviousReport`) gating progression to Step 2.
- Added an accessible, Report-scoped mismatch/invalid-workbook popup (role="dialog", Escape support, focus management) shown when the previous-report buyer and workbook buyer disagree, or when the workbook's `备注` column is mixed, blank, or unrecognized on a valid row.
- Confirmed multiple distinct FPP codes for the same buyer in one workbook (e.g. several different `SCSL-xxxxxxx` values) are normal and do not trigger a warning — only buyer identity (the prefix) is validated, never the full code.
- Extracted the shared parsing/calculation/report-text engine into `js/pages/report/profiles/shared-report-profile.js`, with buyer identity/config in `hync-profile.js` and the new `slnc-profile.js`, selected via `profile-registry.js`. HYNC's output and calculations are unchanged.
- Extended the 规格 (spec) parser to accept both `DOME ( NI:1.25 )` and `DOME (1.25)` without changing ore-class thresholds or any previously-valid HYNC result.
- Dynamic, buyer-aware UI labels (eyebrow, subtitle, workbook card title/hint, footnote, generated report header and "Ore Delivered to FPP …" line) with neutral text before a buyer is detected.
- Reused Monitor's existing DT-normalization logic (`index.html`) so SLNC truck ids resolve against the existing approved contractor mapping instead of a second table.
- Updated PWA app-shell cache for the new profile modules.

### v2.0.0 — Three-Page App Shell + HYNC Production Report

- Added Monitor, Report, and Settings routes (`#/monitor`, `#/report`, `#/settings`).
- Added fixed bottom navigation for mobile and desktop.
- Preserved existing Monitor behavior during the app-shell integration.
- Added modular HYNC report generator (Input → Area Muat → Hasil).
- Added HYNC weighbridge Excel validation (sheet + required headers).
- Added previous-report text parsing (date, Daily, WTD, MTD, YTD).
- Added dome area assignment (BR / BR 23 / DS).
- Added Daily/WTD/MTD/YTD calculations for the HYNC report.
- Added report preview and clipboard copy with fallback.
- Preserved Report state (step, input, generated report) across route changes within a session.
- Added scoped Report CSS (`#page-report`) and isolated ES modules (no global variable/function collisions with Monitor).
- Updated PWA app-shell cache for the new V2.0 files.
- Settings remains a placeholder in V2.0 — no CRUD, no license logic.
- ESG and SLNC report profiles are planned for V2.1.

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

## Catatan Penting

- Cache dan ikon PWA di iOS bersifat persisten. Jika pembaruan yang di-deploy tidak muncul, hapus aplikasi dari Home Screen lalu tambahkan kembali.
- Android/Chrome biasanya menerima pembaruan service worker lebih cepat, tetapi data situs/cache mungkin tetap perlu dibersihkan setelah pembaruan besar.
- Perilaku tooltip berbeda antara tab browser biasa dan mode PWA standalone, sehingga kedua mode tersebut harus diuji setelah ada perubahan terkait grafik (chart).
- Deployment GitHub Pages dapat sesekali mengalami stuck atau queued. Jika aplikasi live masih berjalan, deployment terakhir yang sukses akan tetap aktif.

---

## Limitasi

- Report mendukung buyer **HYNC** dan **SLNC**. Report ESG belum diimplementasikan.
- Deteksi buyer dari teks report sebelumnya hanya mengenali token `FPP HYNC` / `FPP SLNC` — bukan kode FPP lengkap (teks report sebelumnya tidak memuat kode tersebut).
- Deteksi buyer dari file timbangan hanya membandingkan prefix kolom `备注` (`SCHY`/`SCSL`), bukan kode lengkap; beberapa kode berbeda milik buyer yang sama dalam satu file dianggap valid.
- Settings masih berupa placeholder — belum ada pengaturan yang bisa diubah.
- Parsing Report bergantung pada header workbook yang sesuai format yang diharapkan (sama untuk HYNC dan SLNC).
- Teks report sebelumnya wajib diisi agar Daily/WTD/MTD/YTD bisa dihitung secara akumulatif.
- State Report bersifat sesi/in-memory saja — tidak disimpan permanen.
- Riwayat laporan tidak disimpan secara permanen.
- Mapping kontraktor untuk Report (HYNC dan SLNC) saat ini memakai mapping statis dari referensi Report yang sudah disetujui, terpisah dari direktori kontraktor live milik Monitor. SLNC truck id dinormalisasi ke format yang sama sebelum dicocokkan (lihat `normalizeDT` di Monitor).
- Aplikasi bergantung pada struktur Excel yang dikenali parser (Monitor maupun Report).
- File Excel dengan format kolom/sheet yang berubah jauh bisa gagal dibaca.
- Offline mode bergantung pada cache browser.
- Sinkronisasi data kontraktor Monitor membutuhkan koneksi internet.
- Validasi akhir PWA di perangkat Android/iOS asli mungkin masih diperlukan.

---

## License

This project is proprietary and not open source.

Copyright © 2026 Illofiajie. All rights reserved.

Public visibility on GitHub is provided only for deployment and maintenance purposes.  
Use, copying, modification, redistribution, rebranding, resale, or ownership claims are prohibited without prior written permission.

Authorized use is limited to the approved internal company/work environment only.
