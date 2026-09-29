# HPAL Production Monitor

**HPAL Production Monitor** adalah aplikasi web/PWA untuk monitoring hauling Limonite, perhitungan blending, rekomendasi feeding dan pembuatan laporan produksi harian dari file Excel timbangan.

**Live App:** https://slimutebal.github.io/hpal-production-monitor/  
**Current Release:** `v3.0.1 — DAP/EXW Split YTD Reporting`

Aplikasi dapat digunakan langsung dari browser atau dipasang ke Home Screen/Desktop. Perhitungan utama dilakukan langsung di perangkat.

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

Untuk memasang sebagai aplikasi desktop di Chrome/Edge:

1. Buka aplikasi.
2. Klik ikon **Install** di address bar atau buka menu browser.
3. Pilih **Install this site as an app**.

### Jika update belum muncul

1. Pastikan perangkat terhubung internet.
2. Tutup lalu buka kembali aplikasi.
3. Reload halaman.

Jika versi lama tetap muncul:

- Chrome/Edge: lakukan hard refresh atau hapus site data `slimutebal.github.io`.
- iPhone/iPad: hapus aplikasi dari Home Screen lalu pasang kembali melalui Safari.

---

## Halaman Aplikasi dan Akses

| Halaman | Route | Fungsi | Akses |
| --- | --- | --- | --- |
| **Monitor** | `#/monitor` | Analisis hauling, tonase, ritase, Ni, ore class, dome, contractor dan perpindahan DT. | Semua user |
| **Calculate** | `#/calculate` | Blend Calculator, Target Ni Recommendation, Hopper Pattern, Fleet Action, Material Action dan Recovery. | Full Access |
| **Report** | `#/report` | Membuat Daily Production Geology Report untuk FPP. | Full Access |
| **Settings** | `#/settings` | Bahasa, tampilan, lisensi, Personnel Directory, sync dan pending changes. | Semua user |

### Lisensi dan Akses

Aplikasi memiliki dua tingkat akses:

| Tier | Menu |
| --- | --- |
| `MONITOR_ONLY` | Monitor, Settings |
| `FULL_ACCESS` | Monitor, Calculate, Report, Settings |

Tanpa Full Access, menu yang tersedia adalah **Monitor** dan **Settings**.
Untuk membuka Full Access:

1. Buka **Settings**.
2. Buka bagian **License**.
3. Masukkan kunci akses.
4. Tekan **Unlock**.

Full Access tersimpan di perangkat sampai license dihapus atau site data browser dibersihkan.
Hubungi **Owner** untuk mendapat **Key / Kunci akses**.
---

## 1. Monitor

Monitor digunakan untuk membaca dan menganalisis data hauling dari file Excel timbangan.

### Fitur utama

- Total tonase.
- Total ritase.
- Kadar Ni.
- Ore class.
- Dome dan contractor.
- Grafik Ni per jam.
- Perubahan `ΔNI`.
- Perpindahan contractor.
- Perpindahan DT.
- Sinkronisasi List DT / contractor.

### Ore Class

```text
Ni < 1.20        → LGLO
1.20 ≤ Ni ≤ 1.40 → MGLO
Ni > 1.40        → HGLO
```

### Cara menggunakan

1. Buka **Monitor**.
2. Pilih file Excel timbangan.
3. Tunggu proses selesai.
4. Periksa ringkasan hauling.
5. Gunakan grafik dan breakdown untuk melihat perubahan Ni, tonase, dome dan DT.

---

## 2. Calculate

Calculate digunakan untuk:

- menghitung kondisi blend saat ini.
- menentukan Target Ni.
- mencari Hopper Pattern.
- mengoptimalkan pemakaian fleet.
- menentukan tindakan terhadap loading point/dome.
- mencari range kadar material pengganti jika diperlukan.

Calculate adalah alat bantu keputusan operasional. Hasil tetap perlu disesuaikan dengan kondisi aktual di lapangan.

### Input Source

Setiap source terdiri dari:

- **Pile ID**
- **Contractor**
- **Ni (%)**
- **DT**
- **t/DT**

Contoh:

```text
Pile ID      : L30
Contractor   : TII
Ni           : 1.15
DT           : 20
t/DT         : 45
```

`DT` adalah **unit fisik fleet yang dapat digunakan berulang untuk hauling**, bukan jumlah rit yang habis sekali pakai.

### Input angka di HP

Nilai desimal dapat menggunakan titik atau koma.

```text
1.15
```

atau:

```text
1,15
```

Aplikasi mengikuti keyboard desimal perangkat dan menerima keduanya.

---

### Live Blend Calculator

Setelah source lengkap, Calculate langsung menampilkan:

- **NI SUMPRODUCT**
- **TOTAL DT**
- **TOTAL TONASE**

Ni dihitung menggunakan:
```
Pile Tonnage_i  = Unit_i × TonnesPerUnit_i
Total Tonnage   = Σ Pile Tonnage_i

Weighted Ni     = Σ (Ni_i × Pile Tonnage_i)
                  ───────────────────────────
                          Total Tonnage
```

Summary tetap terlihat saat halaman di-scroll sehingga kondisi blend saat ini selalu dapat dibandingkan dengan Recommendation.

---

### Target Ni dan Tolerance

Masukkan:

- **Target Ni**
- **Tolerance**

Default tolerance:

```text
±0.010%
```

Contoh:

```text
Target Ni   : 1.120
Tolerance   : ±0.010
```

Range yang diterima:

```text
1.110% – 1.130%
```

Tekan **Hitung Rekomendasi** untuk menghitung konfigurasi.

Target Ni, Tolerance dan tombol **Hitung Rekomendasi** tetap tersedia saat halaman di-scroll.

Operator dapat mencoba beberapa Target tanpa harus kembali ke bagian atas.

Contoh:

```text
Target 1.120
→ Hitung
→ Periksa hasil

Target 1.130
→ Hitung
→ Bandingkan hasil

Target 1.110
→ Hitung
→ Bandingkan hasil
```

Jika Target atau Tolerance diubah, hasil sebelumnya tetap terlihat sebagai referensi tetapi ditandai bahwa Recommendation perlu dihitung ulang.

---

### Recommendation

Recommendation menampilkan:

- Status Target.
- Operational Hopper Pattern.
- Estimated Final Ni.
- Fleet Utilization.
- Physical Fleet Ratio.
- Fleet Adjustment.
- Fleet Actions.
- Material Actions.
- Operational Continuity Plan jika diperlukan.

Rekomendasi dihitung dengan mesin exact (bukan heuristik/approksimasi):
skenario umum diselesaikan oleh solver exact biasa, sementara skenario padat
(dome/fleet terkonsentrasi pada sedikit contractor) otomatis dialihkan ke
solver exact lanjutan agar tetap dapat diselesaikan tanpa mengorbankan
ketepatan hasil. Perhitungan berjalan di background (Web Worker) sehingga
tampilan Calculate tetap responsif dan dapat dibatalkan (**Cancel**) selama
proses berlangsung.

---

### Hopper Pattern

**Physical Fleet Ratio tidak selalu sama dengan Operational Hopper Pattern.**

Contoh:

```text
Physical Fleet Ratio : 5 : 14
Hopper Pattern       : 1 : 3
```

Physical Fleet Ratio menunjukkan konfigurasi fleet.

Hopper Pattern menunjukkan pola kedatangan muatan ke hopper.

Contoh:

```text
1 : 3

1 muatan Higher Grade
3 muatan LGLO

ULANGI
```

Hopper Pattern dipilih selama hasil Ni masih berada dalam Target Ni ± Tolerance.

---

### Fleet Utilization

Calculate berusaha memaksimalkan DT yang sudah tersedia.

Prinsip utama:

```text
Material boleh berubah.
Dome boleh diganti atau ditutup.
Fleet contractor sebisa mungkin tetap produktif.
```

Perpindahan DT otomatis hanya dilakukan dalam **contractor yang sama**.

DT tidak dipindahkan otomatis antar contractor.

---

### Minimum Fleet per Loading Point

Loading point yang tetap aktif harus memiliki:

```text
0 DT
atau
≥ 6 DT
```

Artinya:

```text
0 DT
→ loading point dapat ditutup

1–5 DT
→ tidak direkomendasikan untuk tetap beroperasi

≥ 6 DT
→ loading point dapat tetap aktif
```

Tujuannya agar excavator/loading point tidak tetap beroperasi hanya untuk melayani jumlah DT yang terlalu sedikit.

---

### Fleet Actions

Fleet Actions menunjukkan kondisi awal, perubahan dan hasil akhir fleet.

#### AKTIF

Tidak ada perubahan.

```text
MRP · L30                     AKTIF

AKTIF                         15 DT
```

#### TERIMA

Loading point menerima DT dari loading point lain milik contractor yang sama.

```text
TII · L20                     TERIMA

AWAL                          15 DT
TERIMA                        14 DT ← L40
AKHIR                         29 DT
```

#### PINDAH

Sebagian DT dipindahkan ke loading point lain milik contractor yang sama.

```text
TII · L40                     PINDAH

AWAL                          20 DT
PINDAH                        14 DT → L20
AKHIR                          6 DT
```

#### TUTUP DOME

Jika seluruh fleet pada satu dome lebih baik dipindahkan:

```text
TII · L40                     TUTUP DOME

AWAL                          20 DT
PINDAH                        20 DT → L20
AKHIR                          0 DT
```

Dome berhenti digunakan, tetapi fleet contractor tetap bekerja pada loading point lain.

#### KURANGI

Pengurangan kecil fleet dapat direkomendasikan jika masih dalam batas operasional.

Pengurangan besar akan dicari alternatif terlebih dahulu melalui:

- relokasi fleet;
- pembagian loading point;
- penggantian dome;
- atau konfigurasi yang lebih efisien.

---

### Contractor Continuity

Calculate mempertimbangkan kontinuitas contractor, bukan hanya kualitas Ni.

Secara umum:

```text
Pengurangan ≤ 5%
→ masih dapat dianggap pengurangan kecil.

Pengurangan > 5%
→ sistem akan mencari alternatif operasional.

Pengurangan ≥ 50%
→ dianggap kondisi kritis dan tidak direkomendasikan sebagai operasi normal.
```

Alternatif yang dicari:

1. Memaksimalkan dome existing.
2. Memindahkan DT dalam contractor yang sama.
3. Membagi fleet ke dua loading point.
4. Menutup dome dan memindahkan fleet.
5. Mengganti dome dengan kadar yang lebih sesuai.

---

### Split Loading Point

Jika contractor hanya memiliki satu loading point tetapi sebagian fleet tidak dapat digunakan secara optimal, Calculate dapat menyarankan pembagian loading point.

Contoh:

```text
TII
20 DT

Existing dome   : 14 DT
Dome tambahan   :  6 DT
```

Setiap loading point aktif harus memiliki minimal:

```text
6 DT
```

Calculate kemudian memberikan range kadar untuk dome tambahan.

Contoh:

```text
Dome tambahan
Ni 1.230% – 1.270%
```

Karena aplikasi tidak mengetahui ketersediaan excavator, rekomendasi diberikan secara kondisional:

> Jika excavator mendukung, buka loading point kedua.

Jika excavator tidak mendukung, Calculate dapat memberikan alternatif **Ganti Dome**.

---

### Material Actions

Material Action membantu menentukan perlakuan terhadap dome.

#### GUNAKAN

Material sesuai dengan Recommendation.

#### BATASI

Material masih dapat digunakan tetapi penggunaannya perlu dibatasi.

#### GANTI DOME

Jika material existing tidak sesuai dengan Target dan penggunaannya mengganggu kontinuitas fleet, sistem dapat menyarankan penggantian dome.

Contoh:

```text
Ganti L12 dengan dome berkadar:

Ni 0.979% – 1.132%
```

Range dihitung berdasarkan Target Ni, Tolerance, fleet dan tonase.

Calculate tidak mengarang nama dome baru. Operator mencari source aktual yang berada dalam range kadar tersebut.

---

### Range Ni Pengganti

Untuk Split Loading atau Replace Dome, Calculate memberikan:

```text
Minimum Ni – Maximum Ni
```

Contoh:

```text
Ni 1.205% – 1.245%
```

Range menunjukkan kadar material yang dapat menjaga final blend tetap berada dalam:

```text
Target Ni ± Tolerance
```

---

### Planned Blend Recovery

Jika Target tetap tidak dapat dicapai dari source yang tersedia, Calculate menyediakan **Planned Blend Recovery**.

Masukkan:

- Added DT.
- Tonnes / DT.

Calculate kemudian menghitung:

**Minimum New Source Ni**

Contoh:

```text
Minimum New Source Ni
≥ 1.260%
```

Recovery menjawab:

> Berapa minimum Ni material tambahan yang dibutuhkan agar planned blend dapat mencapai Target?

Recovery bukan:

- cumulative actual FPP.
- stockpile inventory.
- sampling history.
- production control otomatis.

---

### Jika Assay Berubah

Jika hasil assay baru tersedia:

1. Update nilai Ni pada source.
2. NI SUMPRODUCT akan berubah otomatis.
3. Tekan **Hitung Rekomendasi**.
4. Recommendation baru menggunakan nilai Ni terbaru.

Tidak diperlukan menu sampling khusus.

Nilai Ni terakhir yang dimasukkan digunakan sebagai nilai terbaru untuk perhitungan.

---

## 3. Report

Report digunakan untuk membuat **Daily Production Geology Report**.

Mendukung:

- FPP 1.
- FPP 2.
- FPP 3.

Alur utama:

```text
1. Input
2. Area Muat
3. Hasil
```

### Fitur utama

- Deteksi format workbook otomatis.
- Deteksi buyer otomatis.
- Deteksi delivery term DAP / EXW otomatis.
- Week ISO otomatis.
- Deteksi Day/Night Shift dari data timbang.
- Personnel Directory.
- SPV.
- FRM.
- 3rd Sampler.
- PIC 3rd.
- Loading Point / Area.
- Daily.
- WTD.
- MTD.
- YTD DAP.
- YTD EXW.
- Preview laporan.
- Copy Laporan.

Report secara otomatis mengidentifikasi delivery term dari kode selling pada workbook:

- Kode selling mengandung `EX` → EXW.
- Kode selling tanpa `EX` → DAP.

Daily, WTD, dan MTD tetap berupa total produksi gabungan. Akumulasi tahunan (YTD) dipisah menjadi YTD DAP dan YTD EXW. Arsitektur ini berlaku untuk seluruh FPP (HYNC, SLNC, EIEB), meskipun EXW saat ini secara operasional baru muncul pada data EIEB.

### Cara menggunakan

1. Pastikan Personnel Directory sudah tersinkron.
2. Buka **Report**.
3. Isi Step 1 dan upload file timbangan.
4. Pilih area muat pada Step 2.
5. Periksa hasil pada Step 3.
6. Tekan **Copy Laporan**.

---

## 4. Settings

Settings digunakan untuk mengatur aplikasi dan data operasional.

### Preferences

- Bahasa Indonesia / English.
- Dark.
- Light.
- Auto/System.

### License

Digunakan untuk membuka Full Access.

### Personnel Directory

Mencakup:

- SPV.
- FRM.
- 3rd Sampler.
- PIC 3rd.

Personel dapat:

- ditambah;
- diedit;
- dinonaktifkan;
- diaktifkan kembali.

### Sync Status

Menampilkan kondisi sinkronisasi Personnel Directory.

### Pending Changes

Jika perubahan personel dilakukan saat offline, perubahan dapat masuk ke antrean dan dikirim kembali saat koneksi tersedia.

---

## Offline / PWA

Aplikasi menggunakan Service Worker dan dapat menjalankan banyak fungsi secara lokal setelah asset aplikasi sudah tercache.

Calculate dapat digunakan secara offline untuk:

- Blend Calculator.
- Recommendation.
- Hopper Pattern.
- Fleet Allocation.
- Contractor Continuity.
- Fleet Actions.
- Material Actions.
- Split/Replace calculation.
- Planned Blend Recovery.

Sinkronisasi contractor dan Personnel Directory tetap membutuhkan internet.

---

## Bahasa dan Tampilan

Aplikasi mendukung:

- Bahasa Indonesia.
- English.
- Dark.
- Light.
- Auto/System.

Preferensi disimpan di perangkat dan digunakan oleh seluruh aplikasi.

---

## Data dan Privasi

- File Excel diproses langsung di browser.
- File Monitor dan Report tidak dikirim ke backend aplikasi.
- Calculate berjalan client-side.
- Report tidak menyimpan riwayat permanen di server aplikasi.
- Data contractor dan Personnel Directory dapat disinkron melalui Google Sheet / Google Apps Script.
- Preferensi, cache, license proof dan antrean offline tertentu disimpan di perangkat/browser.

---

## Limitasi

- Parser bergantung pada struktur workbook yang dikenali.
- Perubahan besar pada header/sheet dapat menyebabkan file tidak terbaca.
- State Report bersifat sesi dan dapat hilang setelah refresh/reset.
- Calculate tidak mengetahui stockpile inventory aktual.
- Calculate tidak mengetahui ketersediaan excavator.
- Calculate tidak menyimpan sampling history.
- Calculate memberikan rekomendasi berdasarkan data yang dimasukkan, bukan kondisi lapangan yang tidak tersedia di aplikasi.
- Sinkronisasi Google Sheet membutuhkan internet.
- Offline mode bergantung pada cache browser yang masih tersedia.

---

## Arsitektur

HPAL Production Monitor menggunakan:

- HTML.
- CSS.
- Vanilla JavaScript / ES Modules.
- Hash routing.
- Service Worker / PWA.
- localStorage.
- Google Apps Script untuk sinkronisasi data tertentu.

Struktur utama:

```text
hpal-production-monitor/
├── index.html
├── manifest.webmanifest
├── service-worker.js
├── assets/
│   └── css/
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

Dokumen keputusan teknis dan domain tersedia di folder `docs/`.

---

## Changelog

### v3.0.1

- Report kini mendeteksi DAP / EXW secara otomatis dari kode selling pada workbook yang diunggah.
- Akumulasi Report tahunan dipisah menjadi `YTD DAP` dan `YTD EXW`.
- Daily, WTD, dan MTD tetap berupa total produksi gabungan.
- Output produksi WhatsApp kini hanya menampilkan nilai tonase, tanpa ritase kumulatif.
- Workbook dengan campuran DAP/EXW diblokir agar report tidak ambigu.
- Report YTD tunggal (format lama) gagal secara aman (fail closed) dan tidak menebak alokasi historis DAP/EXW.
- Arsitektur DAP/EXW berlaku bersama untuk HYNC, SLNC, dan EIEB.
- Cache PWA diperbarui agar perangkat yang sudah terpasang menerima modul Report terbaru.

### v3.0.0

- Scalable exact Recommendation engine: skenario umum tetap diselesaikan
  solver exact biasa, skenario padat (dome/fleet terkonsentrasi pada sedikit
  contractor) otomatis dialihkan ke solver exact lanjutan -- hasil tetap
  exact pada kedua jalur, tidak ada heuristik/approksimasi.
- Recommendation kini dihitung di Web Worker (background thread) sehingga
  Calculate tetap responsif selama perhitungan berjalan, dengan **Cancel**
  dan retry.
- Minimum 6 DT per active loading point (operational baseline, diteruskan
  dari v2.5.0).
- Offline/PWA: seluruh alur Recommendation, termasuk Worker-nya, tetap dapat
  dijalankan tanpa koneksi setelah aplikasi ter-cache.

### v2.5.0

- Contractor Continuity optimization.
- Minimum 6 DT per active loading point.
- Same-contractor fleet reallocation.
- Split Loading dan Replace Dome recommendation.
- Replacement Ni range.
- Fleet Actions `AWAL → PERUBAHAN → AKHIR`.
- Sticky Target/Tolerance controls untuk simulasi cepat.
- Previous Recommendation tetap terlihat sebagai referensi saat Target/Tolerance diubah.

### v2.4.1

- Dukungan input desimal `,` dan `.`.
- Perbaikan mobile input zoom.
- Perbaikan sticky Blend Summary.

### v2.4.0

- Calculate dan Blend Calculator.
- Recommendation Engine.
- Operational Hopper Pattern.
- Fleet dan Material Actions.
- Planned Blend Recovery.
- Offline Calculate.

### v2.3.0

- ISO Week otomatis.
- Personnel Directory.
- Period-aware Report.
- ID/EN dan Dark/Light/Auto.
- `MONITOR_ONLY` / `FULL_ACCESS`.

### v2.0 – v2.2

- App shell dan routing.
- Multi-FPP Report.
- Workbook detection.
- PWA integration.

### v1.x

- Initial Monitor.
- Contractor sync.
- Ni monitoring.
- Mobile/PWA improvements.

---

## Development Notes

- Production branch: `main`.
- Deployment: GitHub Pages.
- Calculate berjalan client-side.
- Source utama aplikasi tidak memerlukan backend untuk perhitungan.
- Detail keputusan domain dan engineering tersedia di folder `docs/`.

---

## Legal License

This project is proprietary and not open source.

Copyright © 2026 Illofiajie. All rights reserved.

Public visibility on GitHub is provided only for deployment and maintenance purposes.

Use, copying, modification, redistribution, rebranding, resale, or ownership claims are prohibited without prior written permission.

Authorized use is limited to the approved internal company/work environment only.