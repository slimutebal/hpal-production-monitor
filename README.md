# HPAL Production Monitor — v1.6.0 (Contractor Sync + iOS Tooltip Fix)

Upload/replace file berikut di root repo:

- `index.html`
- `service-worker.js`
- `VERSION.txt`
- `README_v1.6.0_CONTRACTOR_SYNC.md` (file ini)

Jangan re-upload `.nojekyll` — sudah ada di repo.

## Yang baru di versi ini

### 1. Data Kontraktor Bersama (Google Sheet)
Sebelumnya, update data kontraktor (List DT) hanya tersimpan lokal di device masing-masing user — tidak ada cara berbagi update antar user.

Sekarang:
- Data kontraktor disinkron dari **Google Sheet** (sumber bersama) via Google Apps Script Web App, jadi semua user yang buka app dapat data terbaru yang sama.
- Tombol **➕ Update Kontraktor** — popup input No DT + Nama Kontraktor, bisa isi berturut-turut tanpa tutup popup.
- Tombol **🔄 Sinkron Sekarang** — fetch ulang manual dari Google Sheet.
- Fitur lama **📄 Update via File Excel** tetap ada sebagai override lokal per-device.

**Prioritas sumber data kontraktor:** Upload file Excel manual (device ini) → Google Sheet (server bersama) → Data bawaan (fallback offline pertama kali).

### 2. Dukungan Offline untuk Update Kontraktor
- Kalau device **online** saat submit popup: data langsung terkirim ke Google Sheet, langsung berlaku untuk semua user.
- Kalau device **offline** saat submit: data tetap langsung berlaku di device itu (supaya kerja tidak terhambat), masuk antrian tersimpan lokal, lalu **otomatis terkirim** ke Google Sheet begitu device kembali online (tanpa perlu aksi manual).

### 3. Fix Tooltip Chart.js "Nyangkut" di iOS PWA (dilanjutkan dari v1.5.0)
Fix dari rilis sebelumnya (tooltip grafik NI tidak mau hilang setelah tap, khusus mode PWA standalone di iOS) tetap dipertahankan di rilis ini — ditambahkan ulang ke `index.html` supaya tidak regresi.

### 4. Fix `service-worker.js`: request Google Sheet tidak lagi ikut ke-cache
**Penting** — bug di versi sebelumnya: semua request GET (termasuk ke Google Apps Script) ikut disimpan di cache, sehingga user selalu dapat data kontraktor basi walau internet lancar. Sekarang request ke domain lain (cross-origin) selalu langsung ke jaringan, tidak pernah disentuh cache.

Cache version dinaikkan ke `v1.6.0-contractor-sync` supaya device yang sudah install PWA ini dapat update terbaru.

## Setelah upload

Kalau device yang sudah install PWA masih menampilkan versi lama:
- **Android/Desktop**: hapus site data/cache untuk domain GitHub Pages ini, lalu buka ulang.
- **iOS**: hapus dulu app dari Home Screen, lalu buka Safari → Share → **Add to Home Screen** lagi.

## Setup Google Apps Script (referensi, sudah dilakukan)

Endpoint yang dipakai `index.html` untuk sync kontraktor:
```
https://script.google.com/macros/s/AKfycbwoakor1_LBN52GYBACijgorUEE5cPqjrnR_ncmCBzJH2YKf6Yl42Ys2m3VpSVoSuFs/exec
```
Kalau perlu ganti endpoint (misal bikin Google Sheet baru), cari konstanta `GOOGLE_SHEET_API_URL` di dalam `index.html` dan ganti nilainya, lalu build ulang.
