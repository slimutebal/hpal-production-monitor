// Indonesian (id) translation catalog -- the canonical, always-complete
// locale (V2.3 Phase 7, Language and Localization). i18n.js falls back to
// this map whenever a key is missing from another locale, so every key
// the application actually uses MUST exist here first.
//
// Flat dot-path keys (e.g. "settings.language.title"), matching the
// architecture doc's representative key list
// (docs/V2.3_AUTO_WEEK_AND_PERSONNEL_DIRECTORY_ARCHITECTURE.md section 12.2).
// Values are plain strings; "{name}"-style placeholders are substituted by
// i18n.js's t(key, vars) -- never string-concatenated ad hoc at the call
// site.
//
// Scope (section 12.3, expanded in the full-localization pass): app
// shell, bottom navigation, Monitor (static markup + dynamic
// sync/upload/contractor messages, via the window.i18n bridge --
// js/app.js -- since index.html's Monitor script is a classic,
// non-module script and cannot import this file directly), Report
// (static shell + dynamic validation/status messages), and Settings
// (static shell + dynamic sync/queue/personnel messages, including
// server-error-code -> presentation-message mapping under `errors.*`).
// Never localized, by design: HYNC/SLNC/EIEB/AWK/ATQ/SCM and every other
// stable business identifier (role_type values, API action names,
// localStorage keys, event names, contractor codes), and the generated
// WhatsApp report text itself (buildReportText() never calls t()).
//
// A small number of remaining Monitor/Report/Settings strings are
// intentionally still untranslated -- see README's "Language and
// Appearance" section for that explicit, documented staging decision
// (mirroring how section 12.4 already allows Monitor's legacy strings to
// be staged rather than translated all at once). Generated report OUTPUT
// text (buildReportText()) is never looked up from this file at all --
// section 12.3 requires it to stay independent of UI locale.
export default {
  'nav.monitor': 'Monitor',
  // V2.4 Phase 1: kept identical in id/en, matching nav.monitor/
  // nav.report/nav.settings's existing convention of NOT translating
  // top-level section names (they are stable product feature names, not
  // generic words) -- see calculate.title below for the same reasoning.
  'nav.calculate': 'Calculate',
  'nav.report': 'Report',
  'nav.settings': 'Settings',

  'common.sync': 'Sync',
  'common.add': 'Tambah',
  'common.edit': 'Edit',
  'common.deactivate': 'Nonaktifkan',
  'common.reactivate': 'Aktifkan',
  'common.cancel': 'Batal',
  'common.save': 'Simpan',
  'common.close': 'Tutup',
  'common.retry': 'Coba Lagi',
  'common.remove': 'Hapus',
  'common.review': 'Tinjau',
  'common.back': '← Kembali',
  'common.next': 'Lanjut →',
  'common.reset': '↺ Reset',
  'common.ok': 'OK',
  'common.search': 'Cari nama...',
  'common.filterActive': 'Aktif',
  'common.filterInactive': 'Nonaktif',
  'common.filterAll': 'Semua',
  'common.show': 'Tampilkan',
  'common.hide': 'Sembunyikan',

  // Calculate. 'calculate.title' is kept identical to en.js, matching
  // nav.calculate/nav.monitor/nav.report/nav.settings's convention of not
  // translating stable top-level section names. V2.4 Phase 1's
  // 'calculate.subtitle' ("coming in a later phase") is removed here --
  // Phase 2 replaces that placeholder with the real Blend Calculator
  // below, so the "not yet available" text would now be actively wrong.
  // Recommendation-mode strings (Target Ni, Tolerance, Hopper Pattern,
  // USE/LIMIT/STOP, Recovery, ...) are deliberately NOT added yet --
  // Gate A (architecture doc Section 40) is still closed.
  'calculate.title': 'Calculate',

  'calculate.blend.subtitle': 'Blending Operasional',
  'calculate.blend.title': 'Kalkulator Blend',
  'calculate.blend.calculate': 'Hitung Blend',

  // Compact grid short headers (this task's mobile input-grid revision --
  // "PILE"/"NI"/"DT"/"t/DT", never the long field names below, inside the
  // table header). Kept identical in both locales like DT/Ni elsewhere --
  // these are the exact short forms the Owner specified, not generic UI
  // words to translate. The full wording (calculate.fields.*) is still
  // used for each input's accessible aria-label.
  'calculate.grid.headerPile': 'PILE',
  'calculate.grid.headerNi': 'NI',
  'calculate.grid.headerDt': 'DT',
  'calculate.grid.headerTonnesPerUnit': 't/DT',

  // Full wording -- used as each input's aria-label and in the (now
  // collapsed-by-default) Pile Breakdown detail, never as compact grid
  // header text (see calculate.grid.* above).
  'calculate.fields.pileId': 'Pile ID',
  'calculate.fields.contractor': 'Kontraktor',
  'calculate.fields.ni': 'Ni (%)',
  'calculate.fields.units': 'Jumlah Unit',
  'calculate.fields.tonnesPerUnit': 'Tonase / Unit',
  'calculate.fields.calculatedTonnage': 'Tonase Terhitung',
  'calculate.fields.oreClass': 'Kelas Ore',

  'calculate.result.title': 'Hasil Blend',
  'calculate.result.finalNi': 'Ni Akhir',
  'calculate.result.totalUnits': 'Total DT',
  'calculate.result.totalTonnage': 'Total Tonase',
  'calculate.result.pileBreakdown': 'Rincian Pile',
  'calculate.result.classBreakdown': 'Rincian Kelas',
  // Kept in English in both locales, matching the architecture doc's own
  // consistent English usage of this grouping term (HGLO + MGLO) -- an
  // informational total only in Phase 2, never a recommended ratio.
  'calculate.result.higherGrade': 'Higher Grade',
  'calculate.result.tonnageShare': '% dari Total Tonase',
  'calculate.result.tonnageLabel': 'Tonase',

  // Remove Pile reuses common.remove ('Hapus') rather than a dedicated
  // calculate.actions.remove key -- same generic remove action already
  // used by Settings' personnel/queue rows.
  'calculate.validation.pileIdRequired': 'Pile ID wajib diisi.',
  'calculate.validation.pileIdDuplicate': 'Pile ID sudah digunakan.',
  'calculate.validation.contractorRequired': 'Kontraktor wajib diisi.',
  'calculate.validation.niRequired': 'Ni wajib diisi.',
  'calculate.validation.niInvalid': 'Ni harus berupa angka yang valid.',
  'calculate.validation.niPositive': 'Ni harus lebih besar dari 0.',
  'calculate.validation.unitsRequired': 'Jumlah Unit wajib diisi.',
  'calculate.validation.unitsInvalid': 'Jumlah Unit harus berupa angka yang valid.',
  'calculate.validation.unitsInteger': 'Jumlah Unit harus berupa bilangan bulat.',
  'calculate.validation.unitsNonNegative': 'Jumlah Unit tidak boleh negatif.',
  'calculate.validation.tonnesPerUnitRequired': 'Tonase / Unit wajib diisi.',
  'calculate.validation.tonnesPerUnitInvalid': 'Tonase / Unit harus berupa angka yang valid.',
  'calculate.validation.tonnesPerUnitPositive': 'Tonase / Unit harus lebih besar dari 0.',
  'calculate.validation.noPositiveTonnage': 'Minimal satu pile harus memiliki tonase lebih besar dari 0.',

  'settings.pageTitle': 'Pengaturan',
  'settings.title': 'Personnel Directory',
  'settings.subtitle': 'Direktori SPV SCM, FRM SCM, Independent Sampler, dan PIC 3rd -- disinkron dari Google Sheet. Tekan Kelola pada tiap role untuk menambah, edit, nonaktifkan, atau aktifkan kembali personel.',
  'settings.section.access': 'Access',
  'settings.section.preferences': 'Preferences',
  'settings.section.operational': 'Operational Data',

  'settings.license.title': 'License',
  'settings.license.status.monitorOnly': 'Status: Akses Monitor',
  'settings.license.status.fullAccess': 'Status: Akses Penuh',
  'settings.license.input': 'Kunci lisensi',
  'settings.license.inputPlaceholder': 'Masukkan kunci lisensi',
  'settings.license.unlock': 'Buka',
  'settings.license.remove': 'Hapus Lisensi',
  'settings.license.verifiedLocally': 'Terverifikasi secara lokal',
  'settings.license.installedAt': 'Terpasang',
  'settings.license.invalid': 'Kunci lisensi tidak valid.',
  'settings.license.unlockedMessage': 'Akses Penuh terbuka.',
  'settings.license.removedMessage': 'Lisensi dihapus. Perangkat ini kembali ke Akses Monitor.',

  'license.fullAccessRequired': 'Fitur ini memerlukan Lisensi Akses Penuh.',
  'license.removeConfirm': 'Hapus lisensi dari perangkat ini?',

  'settings.language.groupLabel': 'Pilih bahasa',
  'settings.appearance.groupLabel': 'Pilih tampilan',
  'settings.language.title': 'Bahasa',
  'settings.language.subtitle': 'Pilih bahasa tampilan aplikasi. Tidak memengaruhi teks laporan yang dihasilkan.',
  'settings.language.id': 'Bahasa Indonesia',
  'settings.language.en': 'English',

  'settings.appearance.title': 'Tampilan',
  'settings.appearance.subtitle': 'Pilih tema tampilan aplikasi.',
  'settings.appearance.dark': 'Gelap',
  'settings.appearance.light': 'Terang',
  'settings.appearance.auto': 'Otomatis',

  'settings.sync.title': 'Status Sinkronisasi',
  'settings.sync.statusLabel': 'Status',
  'settings.sync.sourceLabel': 'Sumber',
  'settings.sync.lastSyncLabel': 'Terakhir sinkron',
  'settings.sync.totalLabel': 'Total personel',
  'settings.sync.defaultMessage': 'Tekan Sync untuk memuat direktori personel.',

  'settings.queue.pendingLabel': 'Perubahan Tertunda',
  'settings.queue.reviewButton': 'Tinjau',
  'settings.queue.modalTitle': 'Antrean Offline',
  'settings.queue.emptyMessage': 'Tidak ada perubahan offline yang tertunda.',
  'settings.queue.offlineSavedMessage': 'Perubahan disimpan sebagai antrean offline dan akan dikirim saat koneksi kembali.',
  'settings.queue.versionConflictReviewMessage': 'Data sudah berubah di server. Sinkronkan ulang dan tinjau perubahan offline.',
  'settings.queue.countPendingOnly': '{total} pending',
  'settings.queue.countPendingBlocked': '{pending} pending · {blocked} blocked',
  'settings.queue.statusPending': 'Tertunda',
  'settings.queue.statusBlocked': 'Blocked: {reason}',
  'settings.queue.reasonVersionConflict': 'version conflict',
  'settings.queue.reasonDuplicate': 'sudah ada personel dengan role/nama/organisasi yang sama',
  'settings.queue.reasonUnknown': 'kesalahan tidak diketahui',
  'settings.offlineIndicator': 'Offline — perubahan akan diantrikan.',

  'settings.role.searchPlaceholder': 'Cari nama...',
  'settings.role.manageButton': 'Kelola',
  'settings.role.addButton': '+ Tambah Personel',
  'settings.role.summaryActiveOnly': '{active} aktif',
  'settings.role.summaryActiveInactive': '{active} aktif · {inactive} nonaktif',

  'settings.modal.confirm': 'Simpan',
  'settings.modal.cancel': 'Batal',

  'report.title': 'Daily Production Geology Report',
  'report.stepper.step1': '1 · Input',
  'report.stepper.step2': '2 · Area Muat',
  'report.stepper.step3': '3 · Hasil',
  'report.prevText.title': 'Teks Report Sebelumnya',
  'report.prevText.label': 'Teks report sebelumnya',
  'report.prevText.placeholder': 'Paste teks report shift sebelumnya di sini...',
  'report.workbook.title': 'Data Timbangan',
  'report.workbook.gotoMonitor': 'Buka Monitor',
  'report.workbook.dropDefaultText': 'Klik untuk upload file timbangan (.xlsx/.xls)',
  'report.manpower.title': 'Man Power & Support',
  'report.week.label': 'Week',
  'report.personnel.gotoSettings': 'Buka Settings',
  'report.personnel.spvLabel': 'SPV SCM',
  'report.personnel.frmLabel': 'FRM SCM',
  'report.personnel.samplerLabel': 'Independent Sampler',
  'report.personnel.picDefaultLabel': 'PIC Independent Sampler',
  'report.personnel.manpowerDefaultLabel': 'Manpower Independent Sampler',
  'report.personnel.totalManpowerDefaultLabel': 'Total Manpower Independent Sampler',
  'report.problem.title': 'Problem & Tindakan',
  'report.problem.label': 'Problem',
  'report.problem.optionalHint': '(boleh kosong)',
  'report.problem.placeholder': 'Tulis problem jika ada...',
  'report.action.label': 'Preventive Action',
  'report.action.placeholder': 'Tulis preventive action jika ada...',
  'report.step2.title': 'Pilih Area Tiap Dome',
  'report.step2.hint': 'Dome diambil dari data timbangan yang diupload. Pilih salah satu area (BR1 / BR23E / BR23W / DS) untuk tiap dome.',
  'report.step2.missingAreaError': 'Pilih area untuk semua dome dulu ({count} belum dipilih, ditandai merah).',
  'report.personnelModal.titleSpv': 'Pilih SPV SCM',
  'report.personnelModal.titleFrm': 'Pilih FRM SCM',
  'report.copy.success': '✓ Tersalin ke clipboard',
  'report.copy.failure': '✗ Gagal menyalin otomatis, silakan copy manual dari kotak di atas',
  'report.step3.title': 'Teks Laporan',
  'report.buttons.generate': 'Generate Laporan →',
  'report.buttons.copy': '📋 Copy Laporan',
  'report.buttons.backToArea': '← Kembali Pilih Area',
  'report.buyerModal.title': 'Buyer tidak sesuai',
  'report.personnelModal.searchPlaceholder': 'Cari nama...',

  // Report dynamic validation/status messages (full-localization pass).
  'report.validation.prevTextRequired': 'Teks report sebelumnya belum diisi.',
  'report.validation.fileNotParsed': 'File data timbangan belum berhasil diupload/dibaca.',
  'report.validation.weekUncalculable': 'Week tidak dapat dihitung dari tanggal file timbangan — periksa kembali file yang diupload.',
  'report.validation.shiftTie': 'Shift tidak dapat ditentukan — distribusi jam Day Shift dan Night Shift pada file timbangan sama besar ({count} baris masing-masing).',
  'report.validation.shiftNoValidHours': 'Shift tidak dapat ditentukan — tidak ada jam timbang yang valid pada file timbangan.',
  'report.warning.shiftFallback': 'Tidak ada jam timbang valid terbaca — shift otomatis di-set "Day Shift", mohon cek manual.',
  'report.warning.dateMismatch': 'Ada lebih dari 1 tanggal berbeda di dalam file timbangan ini — dipakai tanggal dari baris pertama.',
  'report.warning.unmatchedTrucks': '{count} no. truck tidak ditemukan di List_DT (dianggap "TIDAK DIKENALI"): {trucks}',
  'report.warning.weekMismatch': 'Week pada teks report sebelumnya ({displayedWeek}) tidak sesuai dengan ISO week dari tanggalnya ({calculatedWeek}) — tanggal report sebelumnya tetap dipakai sebagai acuan periode WTD, bukan angka Week yang tertulis.',
  'report.week.uncalculable': 'Tidak dapat dihitung — tanggal pada file timbangan tidak ditemukan atau tidak valid.',
  'report.week.pendingUpload': 'Dihitung otomatis dari tanggal file timbangan setelah upload.',
  'report.personnel.staleHint': '{count} tidak aktif, periksa kembali.',
  'report.personnel.blockedMessage': 'Personnel Directory belum tersedia di perangkat ini. Sinkronkan Personnel Directory di Settings terlebih dahulu sebelum membuat Report.',
  'report.personnel.notSelected': 'Belum dipilih',
  'report.personnel.pickSamplerFirst': 'Pilih Independent Sampler terlebih dahulu.',
  'report.personnel.noActivePicThird': 'Tidak ada PIC 3rd aktif untuk {organization}.',
  'report.personnel.picThirdStale': 'PIC 3rd yang sebelumnya dipilih sudah tidak sesuai/tidak aktif -- pilih ulang.',
  'report.personnel.samplerStale': 'Sampler yang sebelumnya dipilih sudah tidak aktif -- pilih ulang.',
  'report.personnel.noActiveSamplers': 'Tidak ada Independent Sampler aktif.',
  'report.personnel.directoryUnavailable': 'Sinkronkan Personnel Directory di Settings sebelum membuat Report.',
  'report.personnel.selectSpvRequired': 'Pilih minimal satu SPV SCM.',
  'report.personnel.selectFrmRequired': 'Pilih minimal satu FRM SCM.',
  'report.personnel.selectSamplerRequired': 'Pilih Independent Sampler.',
  'report.personnel.selectPicForOrg': 'Pilih PIC 3rd untuk {organization}.',
  'report.personnel.selectPicRequired': 'Pilih PIC 3rd.',
  'report.personnel.picMismatchOrg': 'PIC 3rd terpilih bukan bagian dari {organization} -- pilih PIC 3rd yang sesuai.',
  'report.personnel.selectSamplerBeforePic': 'Pilih Independent Sampler sebelum memilih PIC 3rd.',
  'report.personnel.enterValidManpower': 'Masukkan Manpower {organization} yang valid.',
  'report.personnel.enterValidTotalManpower': 'Masukkan Total Manpower yang valid.',
  'report.personnel.staleSelectionWarning': 'Ada personel yang sebelumnya dipilih sudah tidak aktif. Periksa kembali pilihan personel.',

  'report.neutralLabels.subtitle': 'Generator laporan shift dari data timbangan buyer',
  'report.neutralLabels.workbookHint': 'Upload file timbangan dan pastikan buyer sesuai dengan teks report sebelumnya.',
  'report.buyerLabels.subtitle': 'Generator laporan shift dari data timbangan {buyer}',
  'report.buyerLabels.workbookTitle': 'Data Timbangan (khusus {buyer})',
  'report.buyerLabels.workbookHint': 'Upload file timbangan (.xlsx/.xls) sheet 过磅明细 — pastikan ini data milik buyer {buyer}, bukan buyer lain.',
  'report.buyerStatus.pendingWorkbook': 'Buyer terdeteksi: {buyer} (dari teks report) — menunggu file timbangan.',
  'report.buyerStatus.pendingPrevReport': 'Buyer terdeteksi: {buyer} (dari file timbangan) — menunggu teks report sebelumnya.',
  'report.buyerStatus.confirmed': 'Buyer terkonfirmasi: {buyer}.',
  'report.buyerStatus.mismatch': '⚠ Buyer tidak sesuai — lihat detail.',
  'report.buyerStatus.invalidWorkbook': '⚠ Data buyer file timbangan tidak valid — lihat detail.',
  'report.buyerStatus.ambiguousPrevReport': '⚠ Teks report sebelumnya menyebutkan lebih dari satu buyer — lihat detail.',
  'report.buyerStatus.unknown': 'Buyer belum terdeteksi',
  'report.prevText.hintOptional': 'Paste teks "DAILY PRODUCTION GEOLOGY REPORT" dari WA Group (shift sebelumnya), atau kosongkan jika ini laporan pertama / mulai periode akumulasi baru. Dipakai untuk ambil tanggal & angka WTD/MTD/YTD/Daily lama, dan untuk mendeteksi buyer (FPP HYNC / FPP SLNC / FPP EIEB).',
  'report.prevText.hintRequired': 'Paste teks "DAILY PRODUCTION GEOLOGY REPORT" dari WA Group (shift sebelumnya). Dipakai untuk ambil tanggal & angka WTD/MTD/YTD/Daily lama, dan untuk mendeteksi buyer (FPP HYNC / FPP SLNC / FPP EIEB).',
  'report.buyerGate.unknown': 'Buyer belum terdeteksi dari teks report sebelumnya maupun file timbangan.',
  'report.buyerGate.pendingWorkbook': 'Buyer baru terdeteksi dari teks report sebelumnya — upload file timbangan untuk konfirmasi.',
  'report.buyerGate.pendingPrevReport': 'Buyer baru terdeteksi dari file timbangan — lengkapi teks report sebelumnya untuk konfirmasi.',
  'report.buyerGate.mismatch': 'Buyer teks report sebelumnya dan file timbangan tidak sesuai — lihat detail di popup.',
  'report.buyerGate.invalidWorkbook': 'Data buyer pada file timbangan tidak valid — lihat detail di popup.',
  'report.buyerGate.ambiguousPrevReport': 'Teks report sebelumnya menyebutkan lebih dari satu buyer — lihat detail di popup.',
  'report.buyerGate.unconfirmed': 'Buyer belum terkonfirmasi.',

  // Server error CODE -> localized presentation message (never the raw
  // code itself, which stays a stable machine identifier everywhere else
  // -- personnel-directory-service.js/personnel-write-queue.js never call
  // t(), only settings-page.js's describeWriteError() maps code -> text
  // for display, per the "map error codes to localized presentation
  // messages" requirement).
  'errors.personnel.default': 'Terjadi kesalahan. Coba lagi.',
  'errors.personnel.VERSION_CONFLICT': 'Data sudah berubah di server. Sinkronkan ulang sebelum mencoba lagi.',
  'errors.personnel.DUPLICATE_PERSONNEL': 'Personel dengan role, nama, dan organisasi yang sama sudah aktif di direktori.',
  'errors.personnel.NOT_FOUND': 'Data tidak ditemukan di server. Sinkronkan ulang direktori.',
  'errors.personnel.VALIDATION_ERROR': 'Data tidak valid.',
  'errors.personnel.NETWORK': 'Tidak ada koneksi jaringan. Coba lagi saat online.',
  'errors.personnel.WRITE_NOT_VISIBLE_AFTER_SYNC': 'Server menerima permintaan, tetapi perubahan belum dapat diverifikasi dari Personnel Directory. Sinkronkan ulang dan periksa Google Sheet.',
  'errors.personnel.genericFallback': 'Terjadi kesalahan saat menyimpan.',

  'settings.sync.successMessage': 'Direktori personel berhasil disinkronkan.',
  'settings.sync.cacheFallbackMessage': 'Sinkronisasi gagal. Menampilkan direktori personel tersimpan terakhir.',
  'settings.sync.noCacheMessage': 'Direktori personel tidak dapat dimuat. Periksa koneksi dan coba lagi.',
  'settings.role.emptyNoMatch': 'Tidak ada {title} yang cocok dengan pencarian.',
  'settings.role.emptyNoActive': 'Tidak ada {title} aktif.',
  'settings.role.emptyNoInactive': 'Tidak ada {title} nonaktif.',
  'settings.role.emptyNone': 'Belum ada {title}.',
  'settings.role.noDirectoryYet': 'Belum ada data. Sinkronkan direktori terlebih dahulu.',
  'settings.role.inactiveBadge': 'Nonaktif',
  'settings.modal.deactivateConfirm': 'Nonaktifkan {name} dari Personnel Directory?',
  'settings.role.addedMessage': '{name} ditambahkan.',
  'settings.role.updatedMessage': '{name} diperbarui.',
  'settings.role.deactivatedMessage': '{name} dinonaktifkan.',
  'settings.role.reactivatingMessage': 'Mengaktifkan kembali {name}...',
  'settings.role.reactivatedMessage': '{name} diaktifkan kembali.',
  'settings.modal.addTitle': 'Tambah {title}',
  'settings.modal.editTitle': 'Edit {title}',
  'settings.modal.deactivateTitle': 'Nonaktifkan Personel',
  'settings.form.organizationLabel': 'Organisasi',
  'settings.form.organizationSamplerLabel': 'Organisasi (Sampler)',
  'settings.form.versionLabel': 'Versi',
  'settings.form.nameLabel': 'Nama',
  'settings.form.nameRequired': 'Nama wajib diisi.',
  'settings.form.organizationRequired': 'Organisasi wajib diisi.',
  'settings.form.pickActiveSamplerFirst': 'Pilih Independent Sampler aktif terlebih dahulu.',
  'settings.form.pickSamplerPlaceholder': 'Pilih Sampler',
  'settings.form.noActiveSamplerPlaceholder': 'Tidak ada Sampler aktif',
  'settings.form.inactiveOrgSuffix': '{organization} (tidak aktif)',
  'report.personnelModal.selectedCount': '{count} dipilih',
  'report.personnelModal.emptyResult': 'Tidak ada personel yang cocok.',
  'report.personnelModal.titleFor': 'Pilih {role}',
  'report.contractor.notAvailable': 'List DT Monitor: Not available',
  'report.contractor.notSynced': 'List DT belum disinkronkan dari Monitor.',
  'report.contractor.status': 'List DT Monitor: {label} — {count} records',
  'report.contractor.lastSync': 'Last sync: {timestamp}',
  'report.contractor.stepBlockedMessage': 'List DT belum disinkronkan dari Monitor. Buka halaman Monitor dan jalankan sinkronisasi List DT sebelum membuat laporan.',
  'report.file.readingFile': '⏳ Membaca {filename}...',
  'report.file.readSuccess': '✓ {filename}',
  'report.file.readError': 'Gagal membaca file: {message}',
  'report.file.noValidRows': 'Tidak ada baris valid ditemukan pada file yang diupload.',

  // Monitor (index.html) -- static markup (data-i18n) and dynamic
  // messages threaded through window.i18n.t() (js/app.js's classic-script
  // bridge, since Monitor's own <script> is not an ES module). Never
  // touches "Day Shift"/"Night Shift" (compared/parsed as stable values
  // by Report's own shift logic and matched from previous-report text --
  // see js/pages/report/report-utils.js), ore-class codes (HGLO/MGLO/LGLO),
  // "Buyer"/"Shift"/"NI"/"Ore Class"/"Status"/"Contractor"/"Serial"/
  // "Selling Code"/"TOTAL"/"Grade"/"detail" (already identical in both
  // languages), or any 中文 column-header identifier (流水号, 车号, 净重,
  // 毛重时间, 日期, 备注, 规格, 过磅明细) -- those are literal required
  // Excel column/sheet names, not UI wording.
  'monitor.themeToggle.groupLabel': 'Pilih tema tampilan',
  'monitor.themeToggle.auto': 'Ikuti sistem',
  'monitor.themeToggle.light': 'Mode terang',
  'monitor.themeToggle.dark': 'Mode gelap',
  'monitor.header.subtitle': 'Upload data timbangan untuk lihat ritase per dome, kontraktor & deteksi perpindahan DT',
  'monitor.contractorCard.title': '👷 Data Kontraktor (List DT)',
  'monitor.contractorUpload.tapText': 'Tap untuk upload List_DT.xlsx',
  'monitor.contractorUpload.hint': 'Kolom: DT ID & Contractor — disimpan otomatis, tidak perlu upload ulang',
  'monitor.upload.selectFileButton': '📂 Pilih File Excel',
  'monitor.weighbridgeCard.title': '📦 Data Timbangan',
  'monitor.weighbridgeUpload.tapText': 'Tap untuk pilih file',
  'monitor.weighbridgeUpload.dragDropSuffix': 'atau drag & drop',
  'monitor.weighbridgeUpload.formatHint': 'Format .xlsx — sheet pertama: 过磅明细',
  'monitor.contractorModal.title': '➕ Update Kontraktor',
  'monitor.contractorModal.dtLabel': 'No DT',
  'monitor.contractorModal.dtPlaceholder': 'Contoh: SCM-LIM 982',
  'monitor.contractorModal.contractorLabel': 'Nama Kontraktor',
  'monitor.contractorModal.contractorPlaceholder': 'Contoh: MRP',
  'monitor.contractorModal.saveButton': '💾 Simpan',
  'monitor.contractorModal.doneButton': 'Selesai',
  'monitor.contractorModal.closeAriaLabel': 'Tutup',
  'monitor.contractorModal.infoText': 'Data langsung berlaku di HP ini. Kalau ada koneksi internet, otomatis tersinkron ke server pusat dan berlaku untuk semua pengguna.',
  'monitor.contractorModal.requiredFieldsError': 'No DT dan Nama Kontraktor wajib diisi.',
  'monitor.contractorModal.serverRejectedError': 'Server menolak data',
  'monitor.contractorModal.pendingStatus': 'menunggu koneksi',
  'monitor.contractorModal.syncedStatus': 'tersinkron ke server',
  'monitor.status.readingFile': '⏳ Membaca {filename}...',
  'monitor.status.fileReadSuccess': '✅ {filename} — {formatLabel} — sheet "{sheetName}" — {rowCount} baris',
  'monitor.status.fileReadError': 'Gagal membaca file: {message}',
  'monitor.status.contractorFileReadError': 'Gagal membaca file kontraktor: {message}',
  'monitor.upload.noValidRowsError': 'Tidak ada baris valid ditemukan. Cek nama kolom di file (流水号, 车号, 净重, 毛重时间, 日期, 备注, 规格).',
  'monitor.upload.emptyFileError': 'File kosong',
  'monitor.upload.xlsxNotLoadedError': 'Library XLSX tidak termuat di halaman ini — parsing dibatalkan',
  'monitor.chart.notLoadedError': 'Chart.js tidak termuat',
  'monitor.contractorStatus.syncedBadge': '✅ {count} unit DT (tersambung ke server pusat)',
  'monitor.contractorStatus.offlineBadge': '⚠ {count} unit DT (offline — pakai data tersimpan)',
  'monitor.contractorStatus.syncingBadge': '{count} unit DT (menyinkron...)',
  'monitor.contractorStatus.localOverrideBadge': '📄 override lokal: {filename}',
  'monitor.contractorStatus.pendingBadge': '⏳ {count} entri belum sinkron',
  'monitor.contractorStatus.addButton': '➕ Update Kontraktor',
  'monitor.contractorStatus.syncNowButton': '🔄 Sinkron Sekarang',
  'monitor.contractorStatus.updateFileButton': '📄 Update via File Excel',
  'monitor.contractorStatus.syncError': 'Gagal sinkron ke server: {message}. Memakai data tersimpan.',
  'monitor.contractor.notRegistered': 'Tidak terdaftar',
  'monitor.results.oreBadge': 'Data Timbangan Ore',
  'monitor.results.dateLabel': 'Tanggal',
  'monitor.results.totalRitaseLabel': 'Total Ritase',
  'monitor.results.domeCountLabel': 'Jumlah Dome',
  'monitor.results.dtUnitLabel': 'Unit DT',
  'monitor.results.totalTonaseLabel': 'Total Tonase (Ton)',
  'monitor.results.niGradeLabel': 'Kadar NI',
  'monitor.results.invalidSpecWarning': '⚠ {count} baris format 规格 tidak standar (dipecah secara fallback)',
  'monitor.results.niAnalysisTitle': '📈 Analisis NI per Jam',
  'monitor.results.hourHeader': 'Jam',
  'monitor.results.indicationHeader': 'Indikasi',
  'monitor.results.mixChangedSmall': 'Mix berubah kecil',
  'monitor.results.dtCompositionTitle': '⛏ Komposisi DT per Ore Class',
  'monitor.results.tonaseGradeRecapCaption': 'Rekap Tonase & Grade per Jam',
  'monitor.results.tonaseRowLabel': 'TONASE',
  'monitor.results.contractorMoveResumeTitle': '📋 Resume Perpindahan per Kontraktor',
  'monitor.results.noDtMovedMessage': '✓ Tidak ada DT yang pindah dome pada data ini',
  'monitor.results.dtMovedHeader': 'DT Pindah',
  'monitor.results.movementHeader': 'Perpindahan',
  'monitor.results.ritaseAtLabel': 'Ritase ke-{n}, pukul {time}',
  'monitor.results.dtMovementTitle': '🔁 Perpindahan DT',
  'monitor.results.dtNumberHeader': 'No DT',
  'monitor.results.startDomeHeader': 'Dome Awal',
  'monitor.results.movedToDomeHeader': 'Pindah Dome',
  'monitor.results.notesHeader': 'Keterangan',
  'monitor.results.domeDetailTitle': '📦 Detail per Kelompok Dome',
  'monitor.results.dtRitaseBadge': '{dtCount} DT · {ritaseCount} ritase',
  'monitor.results.movedTag': '🔁 PINDAH',
  'monitor.results.viewRawRowsSummary': '🧾 Lihat Semua Baris Mentah ({count})',
  'monitor.results.nettoHeader': 'Netto',
  'monitor.results.fillTimeHeader': 'Waktu Isi',
  'monitor.results.noDomeLabel': '(Tanpa Dome)',
  'monitor.results.tonaseAxisLabel': 'Tonase (T)',
};
