(() => {
  "use strict";

  const ENDPOINT = "https://script.google.com/macros/s/AKfycbwoakor1_LBN52GYBACijgorUEE5cPqjrnR_ncmCBzJH2YKf6Yl42Ys2m3VpSVoSuFs/exec";
  const QUEUE_KEY = "hpal-unmatched-contractor-queue-v1";
  const STYLE_ID = "hpal-unmatched-contractor-style";
  const OVERLAY_ID = "hpal-unmatched-contractor-overlay";

  const state = {
    detectedUnits: new Set(),
    existing: new Map(),
    analyzing: false,
    syncing: false,
    lastTrigger: null,
  };

  function canonicalDtId(value) {
    let text = String(value ?? "")
      .replace(/[\u00A0\uFEFF\u200B]/g, " ")
      .trim()
      .toUpperCase();

    text = text.replace(/_/g, " ");
    text = text.replace(/[\s.-]*\bDT\.?\s*$/, "").trim();
    text = text.replace(/[.\-\s]+$/, "").trim();
    text = text.replace(/\s+/g, " ");

    const match = text.match(/^SCM[\s-]+([A-Z]+)[\s-]+(\d+[A-Z]*)$/);
    return match ? `SCM-${match[1]} ${match[2]}` : "";
  }

  function normalizedKey(value) {
    return canonicalDtId(value).replace(/[^A-Z0-9]/g, "");
  }

  function readQueue() {
    try {
      const parsed = JSON.parse(localStorage.getItem(QUEUE_KEY) || "[]");
      if (!Array.isArray(parsed)) return [];
      return parsed
        .map((entry) => ({
          dt_id: canonicalDtId(entry && (entry.dt_id || entry.dtId)),
          contractor: String(entry && entry.contractor || "").trim(),
          saved_at: String(entry && entry.saved_at || ""),
        }))
        .filter((entry) => entry.dt_id && entry.contractor);
    } catch (_) {
      return [];
    }
  }

  function writeQueue(entries) {
    const deduped = new Map();
    entries.forEach((entry) => {
      const dtId = canonicalDtId(entry.dt_id || entry.dtId);
      const contractor = String(entry.contractor || "").trim();
      const key = normalizedKey(dtId);
      if (!key || !contractor) return;
      deduped.set(key, {
        dt_id: dtId,
        contractor,
        saved_at: entry.saved_at || new Date().toISOString(),
      });
    });
    localStorage.setItem(QUEUE_KEY, JSON.stringify([...deduped.values()]));
  }

  function upsertQueue(entries) {
    const combined = [...readQueue(), ...entries];
    writeQueue(combined);
    return readQueue();
  }

  function removeQueueKeys(keys) {
    const remove = new Set(keys);
    writeQueue(readQueue().filter((entry) => !remove.has(normalizedKey(entry.dt_id))));
  }

  function extractUnitsFromText(text) {
    const units = new Set();
    const pattern = /SCM[\s_-]+[A-Z]+[\s_-]+\d+[A-Z]*(?:[\s.-]*DT\.?)?/gi;
    String(text || "").match(pattern)?.forEach((value) => {
      const canonical = canonicalDtId(value);
      if (canonical) units.add(canonical);
    });
    return units;
  }

  function collectRenderedUnits() {
    const overlay = document.getElementById(OVERLAY_ID);
    const previousDisplay = overlay && overlay.style.display;
    if (overlay) overlay.style.display = "none";
    const units = extractUnitsFromText(document.body ? document.body.innerText : "");
    if (overlay) overlay.style.display = previousDisplay;
    return units;
  }

  async function extractUnitsFromWorkbook(file) {
    if (!window.XLSX || typeof window.XLSX.read !== "function") {
      throw new Error("Library Excel belum siap. Muat ulang aplikasi lalu coba lagi.");
    }

    const buffer = await file.arrayBuffer();
    const workbook = window.XLSX.read(buffer, { type: "array", cellDates: false });
    const result = new Set();

    workbook.SheetNames.forEach((sheetName) => {
      const sheet = workbook.Sheets[sheetName];
      if (!sheet || !sheet["!ref"]) return;

      let range;
      try {
        range = window.XLSX.utils.decode_range(sheet["!ref"]);
      } catch (_) {
        return;
      }

      const columnCount = range.e.c - range.s.c + 1;
      const isWeighingSheet = sheetName.includes("过磅明细") || columnCount >= 6;
      if (!isWeighingSheet) return;

      Object.keys(sheet).forEach((address) => {
        if (address.startsWith("!")) return;
        const cell = sheet[address];
        if (!cell) return;
        const candidate = canonicalDtId(cell.w ?? cell.v);
        if (candidate) result.add(candidate);
      });
    });

    return result;
  }

  async function analyzeFiles(files) {
    const excelFiles = [...files].filter((file) => /\.(xlsx?|xlsm)$/i.test(file.name || ""));
    if (!excelFiles.length) return;

    state.analyzing = true;
    const detected = new Set();

    try {
      for (const file of excelFiles) {
        const units = await extractUnitsFromWorkbook(file);
        units.forEach((unit) => detected.add(unit));
      }
      if (detected.size) state.detectedUnits = detected;
    } catch (error) {
      console.warn("[HPAL contractor assignment] File analysis failed:", error);
    } finally {
      state.analyzing = false;
      refreshOpenModal();
    }
  }

  async function fetchExistingContractors() {
    const response = await fetch(`${ENDPOINT}?t=${Date.now()}`, {
      method: "GET",
      cache: "no-store",
      redirect: "follow",
    });

    if (!response.ok) throw new Error(`Server List DT merespons HTTP ${response.status}`);
    const rows = await response.json();
    if (!Array.isArray(rows)) throw new Error("Format respons List DT tidak valid");

    const map = new Map();
    rows.forEach((row) => {
      const dtId = canonicalDtId(row && (row.dtId || row.dt_id || row["DT ID"]));
      const key = normalizedKey(dtId);
      if (!key) return;
      map.set(key, {
        dtId,
        contractor: String(row && (row.contractor || row.Contractor) || "").trim(),
      });
    });

    state.existing = map;
    return map;
  }

  function getUnknownUnits() {
    const combined = new Set(state.detectedUnits);
    collectRenderedUnits().forEach((unit) => combined.add(unit));
    return [...combined]
      .filter((unit) => !state.existing.has(normalizedKey(unit)))
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  }

  function ensureStyles() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = `
      #${OVERLAY_ID} { position: fixed; inset: 0; z-index: 2147483000; display: grid; place-items: center; padding: 18px; background: rgba(0,0,0,.66); backdrop-filter: blur(5px); }
      #${OVERLAY_ID}[hidden] { display: none !important; }
      .hpal-uc-dialog { width: min(760px, 100%); max-height: min(82vh, 820px); display: flex; flex-direction: column; overflow: hidden; border: 1px solid rgba(148,163,184,.23); border-radius: 20px; background: #151a25; color: #eef2ff; box-shadow: 0 24px 70px rgba(0,0,0,.52); font: 14px/1.4 system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; }
      .hpal-uc-head { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 18px 20px; border-bottom: 1px solid rgba(148,163,184,.18); }
      .hpal-uc-title { margin: 0; font-size: 18px; font-weight: 800; }
      .hpal-uc-close { width: 42px; height: 42px; border: 1px solid rgba(148,163,184,.3); border-radius: 12px; background: rgba(255,255,255,.04); color: inherit; font-size: 24px; cursor: pointer; }
      .hpal-uc-summary { padding: 14px 20px; color: #a9b7cf; border-bottom: 1px solid rgba(148,163,184,.12); }
      .hpal-uc-summary strong { color: #f8fafc; }
      .hpal-uc-list { overflow: auto; padding: 8px 20px 4px; }
      .hpal-uc-row { display: grid; grid-template-columns: minmax(150px, .72fr) minmax(190px, 1.25fr); gap: 10px 14px; align-items: center; padding: 12px 0; border-bottom: 1px solid rgba(148,163,184,.12); }
      .hpal-uc-unit { font-weight: 800; letter-spacing: .01em; }
      .hpal-uc-input { width: 100%; box-sizing: border-box; border: 1px solid rgba(148,163,184,.35); border-radius: 10px; padding: 11px 12px; background: rgba(255,255,255,.05); color: #f8fafc; outline: none; }
      .hpal-uc-input:focus { border-color: #38bdf8; box-shadow: 0 0 0 3px rgba(56,189,248,.15); }
      .hpal-uc-status { grid-column: 2; min-height: 18px; color: #93a4bd; font-size: 12px; }
      .hpal-uc-status.ok { color: #4ade80; }
      .hpal-uc-status.error { color: #fb7185; }
      .hpal-uc-empty { padding: 28px 4px; color: #a9b7cf; text-align: center; }
      .hpal-uc-actions { display: flex; flex-wrap: wrap; gap: 10px; padding: 16px 20px 20px; border-top: 1px solid rgba(148,163,184,.15); }
      .hpal-uc-btn { border: 1px solid rgba(148,163,184,.27); border-radius: 11px; padding: 11px 16px; background: rgba(255,255,255,.04); color: #eef2ff; font-weight: 750; cursor: pointer; }
      .hpal-uc-btn.primary { border-color: transparent; background: #38bdf8; color: #07111c; }
      .hpal-uc-btn:disabled { opacity: .45; cursor: not-allowed; }
      .hpal-uc-global { flex: 1 1 100%; min-height: 18px; color: #93a4bd; font-size: 12px; }
      .hpal-uc-global.ok { color: #4ade80; }
      .hpal-uc-global.error { color: #fb7185; }
      @media (max-width: 600px) {
        #${OVERLAY_ID} { padding: 10px; align-items: end; }
        .hpal-uc-dialog { max-height: 92vh; border-radius: 18px 18px 12px 12px; }
        .hpal-uc-row { grid-template-columns: 1fr; }
        .hpal-uc-status { grid-column: 1; }
        .hpal-uc-actions .hpal-uc-btn { flex: 1 1 auto; }
      }
      @media (prefers-color-scheme: light) {
        .hpal-uc-dialog { background: #ffffff; color: #172033; }
        .hpal-uc-summary, .hpal-uc-empty { color: #58657a; }
        .hpal-uc-summary strong { color: #172033; }
        .hpal-uc-input { background: #f7f9fc; color: #172033; }
        .hpal-uc-btn { background: #f7f9fc; color: #172033; }
      }
    `;
    document.head.appendChild(style);
  }

  function buildOverlay() {
    let overlay = document.getElementById(OVERLAY_ID);
    if (overlay) return overlay;

    ensureStyles();
    overlay = document.createElement("div");
    overlay.id = OVERLAY_ID;
    overlay.hidden = true;
    overlay.innerHTML = `
      <section class="hpal-uc-dialog" role="dialog" aria-modal="true" aria-labelledby="hpal-uc-title">
        <header class="hpal-uc-head">
          <h2 class="hpal-uc-title" id="hpal-uc-title">Unit Belum Terdaftar</h2>
          <button type="button" class="hpal-uc-close" aria-label="Tutup">×</button>
        </header>
        <div class="hpal-uc-summary">Membaca data unit…</div>
        <div class="hpal-uc-list"></div>
        <footer class="hpal-uc-actions">
          <div class="hpal-uc-global" aria-live="polite"></div>
          <button type="button" class="hpal-uc-btn hpal-uc-save">Simpan</button>
          <button type="button" class="hpal-uc-btn primary hpal-uc-sync">Simpan & Sinkron</button>
          <button type="button" class="hpal-uc-btn hpal-uc-cancel">Tutup</button>
        </footer>
      </section>`;

    document.body.appendChild(overlay);

    const close = () => {
      overlay.hidden = true;
      if (state.lastTrigger && typeof state.lastTrigger.focus === "function") state.lastTrigger.focus();
    };

    overlay.querySelector(".hpal-uc-close").addEventListener("click", close);
    overlay.querySelector(".hpal-uc-cancel").addEventListener("click", close);
    overlay.addEventListener("click", (event) => {
      if (event.target === overlay) close();
    });
    overlay.querySelector(".hpal-uc-save").addEventListener("click", () => saveVisibleEntries(false));
    overlay.querySelector(".hpal-uc-sync").addEventListener("click", () => saveVisibleEntries(true));

    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && !overlay.hidden) close();
    });

    return overlay;
  }

  function setGlobalStatus(message, type = "") {
    const overlay = document.getElementById(OVERLAY_ID);
    if (!overlay) return;
    const node = overlay.querySelector(".hpal-uc-global");
    node.textContent = message || "";
    node.className = `hpal-uc-global${type ? ` ${type}` : ""}`;
  }

  function renderUnknownRows() {
    const overlay = buildOverlay();
    const summary = overlay.querySelector(".hpal-uc-summary");
    const list = overlay.querySelector(".hpal-uc-list");
    const queueByKey = new Map(readQueue().map((entry) => [normalizedKey(entry.dt_id), entry]));
    const unknown = getUnknownUnits();
    const detectedCount = new Set([...state.detectedUnits, ...collectRenderedUnits()]).size;

    summary.innerHTML = detectedCount
      ? `<strong>${unknown.length}</strong> unit belum terdaftar dari <strong>${detectedCount}</strong> unit yang terdeteksi.`
      : "Upload file timbangan terlebih dahulu. Unit yang belum terdaftar akan muncul otomatis di sini.";

    list.replaceChildren();
    if (!unknown.length) {
      const empty = document.createElement("div");
      empty.className = "hpal-uc-empty";
      empty.textContent = detectedCount
        ? "Semua unit pada data timbangan sudah terdaftar."
        : "Belum ada unit yang dapat diperiksa.";
      list.appendChild(empty);
      return;
    }

    unknown.forEach((unit) => {
      const row = document.createElement("div");
      row.className = "hpal-uc-row";
      row.dataset.dtId = unit;

      const unitNode = document.createElement("div");
      unitNode.className = "hpal-uc-unit";
      unitNode.textContent = unit;

      const input = document.createElement("input");
      input.className = "hpal-uc-input";
      input.type = "text";
      input.autocomplete = "off";
      input.placeholder = "Nama kontraktor";
      input.setAttribute("aria-label", `Nama kontraktor untuk ${unit}`);
      input.value = queueByKey.get(normalizedKey(unit))?.contractor || "";

      const status = document.createElement("div");
      status.className = "hpal-uc-status";
      if (input.value) status.textContent = "Tersimpan lokal, menunggu sinkron.";

      row.append(unitNode, input, status);
      list.appendChild(row);
    });
  }

  async function openModal(trigger) {
    state.lastTrigger = trigger || null;
    const overlay = buildOverlay();
    overlay.hidden = false;
    setGlobalStatus("Mengambil List DT terbaru…");

    try {
      await fetchExistingContractors();
      renderUnknownRows();
      setGlobalStatus(navigator.onLine ? "List DT terbaru berhasil dimuat." : "Mode offline: menampilkan data yang tersedia.", "ok");
    } catch (error) {
      renderUnknownRows();
      setGlobalStatus(`Gagal memuat List DT: ${error.message}`, "error");
    }

    overlay.querySelector(".hpal-uc-input")?.focus();
  }

  function visibleEntries() {
    const overlay = document.getElementById(OVERLAY_ID);
    if (!overlay) return [];
    return [...overlay.querySelectorAll(".hpal-uc-row")]
      .map((row) => ({
        dt_id: canonicalDtId(row.dataset.dtId),
        contractor: String(row.querySelector(".hpal-uc-input")?.value || "").trim(),
        row,
      }))
      .filter((entry) => entry.dt_id && entry.contractor);
  }

  function markRow(dtId, message, type = "") {
    const overlay = document.getElementById(OVERLAY_ID);
    if (!overlay) return;
    const key = normalizedKey(dtId);
    const row = [...overlay.querySelectorAll(".hpal-uc-row")]
      .find((candidate) => normalizedKey(candidate.dataset.dtId) === key);
    if (!row) return;
    const status = row.querySelector(".hpal-uc-status");
    status.textContent = message;
    status.className = `hpal-uc-status${type ? ` ${type}` : ""}`;
  }

  async function saveVisibleEntries(syncNow) {
    const entries = visibleEntries();
    if (!entries.length) {
      setGlobalStatus("Isi nama kontraktor minimal untuk satu unit.", "error");
      return;
    }

    upsertQueue(entries.map(({ dt_id, contractor }) => ({ dt_id, contractor })));
    entries.forEach(({ dt_id }) => markRow(dt_id, "Tersimpan lokal, menunggu sinkron.", "ok"));
    setGlobalStatus(`${entries.length} data tersimpan di perangkat.`, "ok");

    if (syncNow) await syncPending(false);
  }

  function successfulKeysFromResult(result) {
    const keys = new Set();
    ["appended", "updated_blank", "duplicate_skipped"].forEach((field) => {
      const rows = Array.isArray(result && result[field]) ? result[field] : [];
      rows.forEach((row) => {
        const key = normalizedKey(row && (row.dt_id || row.dtId));
        if (key) keys.add(key);
      });
    });
    return keys;
  }

  async function syncPending(silent = false) {
    if (state.syncing) return;
    const pending = readQueue();
    if (!pending.length) {
      if (!silent) setGlobalStatus("Tidak ada data yang menunggu sinkron.", "ok");
      return;
    }
    if (!navigator.onLine) {
      if (!silent) setGlobalStatus("Perangkat offline. Data tetap tersimpan dan akan disinkron saat online.", "error");
      return;
    }

    state.syncing = true;
    if (!silent) setGlobalStatus(`Menyinkronkan ${pending.length} unit…`);

    try {
      const response = await fetch(ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "text/plain;charset=utf-8" },
        body: JSON.stringify({
          action: "appendListDt",
          data: pending.map(({ dt_id, contractor }) => ({ dt_id, contractor })),
        }),
        redirect: "follow",
      });

      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const result = await response.json();
      if (!result || result.ok !== true) throw new Error(result && result.error || "Respons sinkron tidak valid");

      const successful = successfulKeysFromResult(result);
      removeQueueKeys(successful);

      successful.forEach((key) => {
        const entry = pending.find((item) => normalizedKey(item.dt_id) === key);
        if (entry) markRow(entry.dt_id, "Tersinkron ke Google Sheet.", "ok");
      });

      (result.conflicts || []).forEach((row) => {
        const message = row.existing_contractor
          ? `Konflik: sudah terdaftar sebagai ${row.existing_contractor}.`
          : "Konflik data kontraktor.";
        markRow(row.dt_id, message, "error");
      });

      (result.errors || []).forEach((row) => markRow(row.dt_id, row.error || "Gagal disinkron.", "error"));

      if (!silent) {
        const remaining = readQueue().length;
        setGlobalStatus(
          remaining
            ? `${successful.size} unit tersinkron; ${remaining} masih menunggu pemeriksaan.`
            : `${successful.size} unit berhasil disinkron.`,
          remaining ? "error" : "ok"
        );
      }

      await fetchExistingContractors().catch(() => undefined);
      triggerExistingSyncButton();
      window.setTimeout(refreshOpenModal, 700);
    } catch (error) {
      if (!silent) setGlobalStatus(`Sinkron gagal: ${error.message}. Data tetap tersimpan lokal.`, "error");
    } finally {
      state.syncing = false;
    }
  }

  function triggerExistingSyncButton() {
    const button = [...document.querySelectorAll("button")].find((candidate) => {
      const text = candidate.textContent.replace(/\s+/g, " ").trim().toLowerCase();
      return text.includes("sinkron sekarang") && !candidate.closest(`#${OVERLAY_ID}`);
    });
    if (button && !button.disabled) button.click();
  }

  function refreshOpenModal() {
    const overlay = document.getElementById(OVERLAY_ID);
    if (!overlay || overlay.hidden) return;
    renderUnknownRows();
  }

  function isUpdateContractorButton(target) {
    const button = target && target.closest ? target.closest("button") : null;
    if (!button || button.closest(`#${OVERLAY_ID}`)) return null;
    const text = button.textContent.replace(/\s+/g, " ").trim().toLowerCase();
    return text.includes("update kontraktor") ? button : null;
  }

  document.addEventListener("click", (event) => {
    const button = isUpdateContractorButton(event.target);
    if (!button) return;
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
    openModal(button);
  }, true);

  document.addEventListener("change", (event) => {
    const input = event.target;
    if (!(input instanceof HTMLInputElement) || input.type !== "file" || !input.files?.length) return;
    analyzeFiles(input.files);
  }, true);

  document.addEventListener("drop", (event) => {
    if (event.dataTransfer?.files?.length) analyzeFiles(event.dataTransfer.files);
  }, true);

  window.addEventListener("online", () => syncPending(true));

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => {
      buildOverlay();
      if (navigator.onLine && readQueue().length) syncPending(true);
    }, { once: true });
  } else {
    buildOverlay();
    if (navigator.onLine && readQueue().length) syncPending(true);
  }
})();