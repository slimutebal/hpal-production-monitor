# HPAL Production Monitor

**HPAL Production Monitor** adalah aplikasi web/PWA untuk monitoring hauling Limonite, perhitungan blending, rekomendasi feeding, dan pembuatan laporan produksi harian dari file Excel timbangan.

**Live app:** https://slimutebal.github.io/hpal-production-monitor/  
**Current release:** `v2.4.0 — Calculate & Blending Recommendation`

Aplikasi dapat digunakan langsung dari browser atau dipasang ke Home Screen/Desktop. Perhitungan utama berjalan lokal di perangkat.

---

## Instalasi

Tidak perlu APK atau installer khusus.

### Android

Gunakan **Google Chrome**.

1. Buka https://slimutebal.github.io/hpal-production-monitor/
2. Tap menu `⋮`.
3. Pilih **Install app** atau **Add to Home screen**.
4. Konfirmasi.

### iPhone / iPad

Gunakan **Safari**.

1. Buka https://slimutebal.github.io/hpal-production-monitor/
2. Tap **Share**.
3. Pilih **Add to Home Screen**.
4. Tap **Add**.

### PC / Laptop

Buka aplikasi melalui Chrome, Edge, atau Safari.

Untuk memasang sebagai aplikasi desktop di Chrome/Edge, klik ikon **Install** di address bar atau pilih **Install this site as an app** dari menu browser.

### Jika update belum muncul

- Buka aplikasi saat online lalu reload.
- Chrome/Edge: lakukan hard refresh atau hapus site data `slimutebal.github.io`.
- iPhone/iPad: jika versi lama tetap muncul, hapus aplikasi dari Home Screen lalu pasang kembali dari Safari.

---

## Halaman Aplikasi

| Halaman | Route | Fungsi |
| --- | --- | --- |
| **Monitor** | `#/monitor` | Analisis hauling, tonase, ritase, Ni, ore class, dome, contractor, dan perpindahan DT. |
| **Calculate** | `#/calculate` | Blend Calculator, rekomendasi Target Ni, Hopper Pattern, Fleet Action, Material Action, dan Recovery. |
| **Report** | `#/report` | Daily Production Geology Report untuk all FPP. |
| **Settings** | `#/settings` | Bahasa, tampilan, lisensi, Personnel Directory, sync, dan pending changes. |

Tanpa Full Access, menu yang tersedia adalah **Monitor** dan **Settings**.

---

## Fitur Utama

### Monitor

Digunakan untuk membaca dan menganalisis data hauling dari file Excel timbangan.

- total tonase dan ritase;
- kadar Ni;
- breakdown `HGLO`, `MGLO`, `LGLO`;
- dome dan contractor;
- analisis Ni per jam;
- indikasi perubahan `ΔNI`;
- resume perpindahan contractor;
- perpindahan DT;
- sinkronisasi List DT / contractor.

Ore class:

```text
Ni < 1.20        → LGLO
1.20 ≤ Ni ≤ 1.40 → MGLO
Ni > 1.40        → HGLO
```

### Calculate

Digunakan untuk menghitung blend dan membuat rekomendasi feeding berdasarkan Target Ni.

Input per source:

- Pile ID
- Contractor
- Ni (%)
- Jumlah Unit / DT
- Tonase / Unit

`Jumlah Unit / DT` adalah **fleet fisik yang dapat digunakan berulang**, bukan jumlah rit yang habis sekali pakai.

#### Blend Calculator

Perhitungan berlangsung live dan menampilkan:

- **NI SUMPRODUCT**
- **TOTAL DT**
- **TOTAL TONASE**

Ni dihitung dengan tonnage-weighted average.

#### Recommendation

Masukkan **Target Ni** dan **Tolerance**. Default tolerance adalah `±0.010%` dan dapat diubah dengan step `0.001`.

Output utama:

- **Hopper Pattern**
- **Estimated Final Ni**
- **Fleet Utilization**
- **Fleet Adjustment**
- **Fleet Actions**
- **Material Actions**

Physical fleet ratio tidak selalu sama dengan Hopper Pattern.

```text
Physical active fleet : 5 : 14
Operational Hopper    : 1 : 3
```

Hopper Pattern adalah pola muatan berulang yang lebih praktis dan tetap harus berada dalam Target Ni ± Tolerance.

**Fleet Actions**

- `ACTIVE` — DT digunakan.
- `MOVE` — DT dipindahkan ke source lain dengan contractor yang sama.
- `STANDBY` — DT tidak diperlukan pada alokasi feeding saat ini.

**Material Actions**

- `USE`
- `LIMIT`
- `STOP`

Aksi material mengikuti kondisi Recommendation saat itu. LGLO tidak otomatis STOP dan HGLO tidak otomatis USE.

#### Planned Blend Recovery

Jika Target tidak dapat dicapai dari source yang tersedia, Recovery menghitung **minimum Ni sumber tambahan** berdasarkan Added DT dan Tonnes/DT.

Recovery menggunakan best-attainable planned blend. Fitur ini bukan cumulative actual FPP dan bukan stockpile inventory.

#### Jika assay berubah

Update nilai Ni source lalu tekan **Hitung Rekomendasi** kembali. Blend live akan berubah dan Recommendation lama otomatis dibersihkan.

### Report

Satu halaman Report digunakan untuk:

- **FPP 1**
- **FPP 2**
- **FPP 3**

Alur:

```text
1. Input
2. Area Muat
3. Hasil
```

Fitur utama:

- buyer/format file terdeteksi otomatis;
- Week ISO otomatis;
- Shift Day/Night dari seluruh jam timbang valid;
- SPV SCM dan FRM SCM dari Personnel Directory;
- Independent Sampler dan PIC 3rd;
- area `BR1`, `BR23E`, `BR23W`, `DS`;
- Daily, WTD, MTD, YTD period-aware;
- preview dan **Copy Laporan**.

Teks report sebelumnya wajib untuk HYNC/SLNC. Untuk EIEB dapat dikosongkan saat memulai periode akumulasi baru.

### Settings

Settings menyediakan:

- Bahasa Indonesia / English;
- Dark / Light / Auto;
- License;
- Personnel Directory;
- Sync Status;
- Pending Changes saat offline.

Personnel Directory mencakup SPV SCM, FRM SCM, Independent Sampler, dan PIC 3rd.

---

## Cara Pakai Singkat

### Monitor

1. Buka **Monitor**.
2. Pilih file Excel timbangan.
3. Tunggu proses selesai.
4. Baca ringkasan, grafik, ore class, dan perpindahan DT.

### Calculate

1. Buka **Calculate**.
2. Isi source/pile.
3. Periksa NI SUMPRODUCT.
4. Isi Target Ni dan Tolerance.
5. Tekan **Hitung Rekomendasi**.
6. Ikuti Hopper Pattern, Fleet Action, dan Material Action.
7. Gunakan Recovery jika Target Not Achievable.

### Report

1. Pastikan Personnel Directory sudah tersinkron.
2. Buka **Report**.
3. Isi Step 1 dan upload file timbangan.
4. Pilih area setiap dome pada Step 2.
5. Periksa hasil pada Step 3.
6. Tekan **Copy Laporan**.

### Settings

Gunakan Settings untuk Bahasa, Tampilan, License, sync Personnel Directory, dan pengelolaan personel.

---

## Offline / PWA

Service worker V2.4 menyimpan app-shell dan modul Calculate ke cache.

Setelah aplikasi pernah dibuka online, fitur lokal berikut dapat digunakan dari cache:

- Blend Calculator;
- Recommendation;
- Hopper Pattern;
- Fleet Actions;
- Material Actions;
- Planned Blend Recovery;
- halaman aplikasi yang sudah tercache.

Sinkronisasi contractor dan Personnel Directory tetap membutuhkan internet.

File Excel diproses lokal di browser dan tidak dikirim ke backend aplikasi.

---

## Bahasa dan Tampilan

Aplikasi mendukung:

- Bahasa Indonesia / English;
- Dark;
- Light;
- Auto/System.

Preferensi disimpan lokal dan digunakan oleh seluruh aplikasi.

---

## Data dan Privasi

- File Excel diproses di browser.
- File Monitor dan Report tidak diupload ke server aplikasi.
- Report tidak menyimpan riwayat permanen di server.
- Data contractor dan Personnel Directory dapat disinkron melalui Google Sheet / Google Apps Script.
- Preferensi, cache, license proof, dan antrean offline tertentu disimpan lokal di perangkat/browser.

Repository bersifat public untuk deployment dan maintenance.

---

## Limitasi

- Parser bergantung pada struktur workbook yang dikenali.
- Perubahan besar pada header/sheet dapat membuat file gagal dibaca.
- State Report bersifat sesi dan hilang setelah refresh/reset.
- Calculate tidak menyimpan sampling history.
- Planned Blend Recovery tidak mengetahui stockpile inventory aktual.
- Sinkronisasi Google Sheet membutuhkan internet.
- Offline mode bergantung pada cache browser yang masih tersedia.

---

## Lisensi dan Akses

| Tier | Menu |
| --- | --- |
| `MONITOR_ONLY` | Monitor, Settings |
| `FULL_ACCESS` | Monitor, Calculate, Report, Settings |

Untuk membuka Full Access:

1. Buka **Settings**.
2. Buka kartu **License**.
3. Masukkan kunci akses dari Owner.
4. Tekan **Unlock**.

Full Access tersimpan lokal sampai license dihapus atau site data dibersihkan.

License adalah access gate lokal pada PWA statis, bukan autentikasi server atau DRM. Jangan simpan access key di repository, dokumentasi, issue, atau screenshot publik.

---

## Arsitektur

Teknologi utama:

- HTML
- CSS
- Vanilla JavaScript / ES Modules
- Hash routing
- Service Worker / PWA
- localStorage
- Google Apps Script untuk sync data tertentu

Struktur ringkas:

```text
hpal-production-monitor/
├── index.html
├── manifest.webmanifest
├── service-worker.js
├── assets/css/
├── js/
│   ├── components/
│   ├── services/
│   ├── i18n/
│   ├── shared/
│   └── pages/
│       ├── calculate/
│       ├── report/
│       └── settings/
├── docs/
└── icons/
```

Dokumen lengkap ada di folder `docs/`, termasuk arsitektur V2.0 sampai V2.4.

---

## Changelog

### v2.4.0 — Calculate & Blending Recommendation

- Calculate route dan live Blend Calculator.
- Recommendation Engine berbasis Target Ni dan Tolerance.
- Operational Hopper Pattern terpisah dari physical fleet ratio.
- Fleet Adjustment dan ACTIVE / MOVE / STANDBY.
- Material USE / LIMIT / STOP.
- Planned Blend Recovery.
- Calculate ID/EN, Dark/Light/Auto, dan offline PWA cache.

### v2.3.0

- Automatic ISO Week.
- Personnel Directory dan controlled Report selectors.
- Online/offline personnel changes.
- Full-data Shift detection.
- Period-aware Daily/WTD/MTD/YTD.
- Localization dan Appearance settings.
- `MONITOR_ONLY` / `FULL_ACCESS`.

### v2.2.0

- FPP 3 Report.
- Dua format workbook ESG.
- Automatic workbook dispatch.

### v2.1.0

- FPP 2 Report.
- Buyer detection dan mismatch protection.
- Shared Report profile engine.

### v2.0.0

- App shell, routing, bottom navigation.
- FPP 1 Report.
- PWA integration.

### v1.x

- Initial Monitor/PWA.
- Contractor sync.
- NI indication improvements.
- Mobile/PWA chart fixes.

---

## Development Notes

- Production branch: `main`
- Deployment: GitHub Pages
- V2.4 verified test baseline: `985 / 985 PASS`
- Calculate berjalan client-side tanpa backend.

Detail keputusan domain dan implementasi tersedia di dokumen arsitektur dalam folder `docs/`.

---

## Legal License

This project is proprietary and not open source.

Copyright © 2026 Illofiajie. All rights reserved.

Public visibility on GitHub is provided only for deployment and maintenance purposes.

Use, copying, modification, redistribution, rebranding, resale, or ownership claims are prohibited without prior written permission.

Authorized use is limited to the approved internal company/work environment only.
