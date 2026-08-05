// Generic formatting/parsing helpers shared by report profiles (only HYNC
// exists in V2.0; ESG/SLNC are future profiles per
// docs/V2.0_ARCHITECTURE_AND_ROADMAP.md section 6.4). Nothing in this file
// is buyer-specific -- buyer rules (header names, ore-class thresholds,
// shift windows, contractor bucketing) belong in a profile module such as
// js/pages/report/profiles/hync-profile.js, not here.

const MONTHS_ID = [
  'Januari', 'Februari', 'Maret', 'April', 'Mei', 'Juni',
  'Juli', 'Agustus', 'September', 'Oktober', 'November', 'Desember',
];

// Indonesian number formatting: "1.234,56" -> 1234.56
export function parseIDNumber(str) {
  if (str === null || str === undefined) return NaN;
  const cleaned = String(str).trim().replace(/\./g, '').replace(',', '.');
  return parseFloat(cleaned);
}

export function fmtTon(num) {
  return num.toLocaleString('id-ID', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export function fmtRit(num) {
  return Math.round(num).toLocaleString('id-ID');
}

export function formatDateID(d) {
  return `${d.getDate()} ${MONTHS_ID[d.getMonth()]} ${d.getFullYear()}`;
}

export function parseDateID(str) {
  const m = str.match(/(\d{1,2})\s+([A-Za-zÀ-ÿ]+)\s+(\d{4})/);
  if (!m) return null;
  const day = parseInt(m[1], 10);
  const monthName = m[2].toLowerCase();
  const monthIdx = MONTHS_ID.findIndex((mo) => mo.toLowerCase() === monthName);
  if (monthIdx === -1) return null;
  const year = parseInt(m[3], 10);
  return new Date(year, monthIdx, day);
}

export function sameDate(a, b) {
  if (!a || !b) return false;
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

// Strips zero-width/BOM characters that sometimes ride along when text is
// pasted from WhatsApp/other apps into the "previous report" textarea.
// Built from character codes (rather than a literal escape sequence in the
// regex) so the zero-width characters themselves never appear in this file.
const ZERO_WIDTH_CHARS = [0x200b, 0x200c, 0x200d, 0x200e, 0x200f, 0xfeff]
  .map((code) => String.fromCharCode(code))
  .join('');
const ZERO_WIDTH_PATTERN = new RegExp(`[${ZERO_WIDTH_CHARS}]`, 'g');

export function cleanInvisible(str) {
  return str.replace(ZERO_WIDTH_PATTERN, '');
}

export function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
