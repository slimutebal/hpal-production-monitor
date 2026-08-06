// Buyer registry for the Report module. This is a dependency-free leaf
// module (no imports) so shared-report-profile.js can safely import it
// without creating a cycle back through hync-profile.js/slnc-profile.js.
//
// "Buyer identity" here means the SCHY-/SCSL- prefix family only -- the
// digits after the prefix are a per-shipment FPP/batch code, not part of
// buyer identity, and are intentionally never compared (see
// docs/V2.0_ARCHITECTURE_AND_ROADMAP.md's Report HYNC/SLNC section: multiple
// distinct codes for the same buyer in one shift file are normal).

export const BUYER_HYNC = 'HYNC';
export const BUYER_SLNC = 'SLNC';
export const SUPPORTED_BUYERS = [BUYER_HYNC, BUYER_SLNC];

// Source of truth for "which 备注 prefix means which buyer". Each profile
// module (hync-profile.js / slnc-profile.js) also declares its own prefix
// constant for readability at the profile-definition site; if a prefix ever
// changes, update both -- they are intentionally small, stable literals
// duplicated for module-boundary reasons (this file must stay import-free),
// not independently-maintained business logic.
const REMARK_PREFIX_TO_BUYER = {
  SCHY: BUYER_HYNC,
  SCSL: BUYER_SLNC,
};

export function getProfile(buyer) {
  if (!SUPPORTED_BUYERS.includes(buyer)) return null;
  return { buyer, label: buyer };
}

// Classifies one workbook row's raw 备注 cell value. Only the prefix is
// checked (startsWith), never the full code -- SCSL-0000033 and
// SCSL-0000034 must both resolve to { status: 'ok', buyer: 'SLNC' }.
export function buyerFromRemark(rawValue) {
  const value = String(rawValue == null ? '' : rawValue).trim().toUpperCase();
  if (!value) return { status: 'blank' };
  const prefix = Object.keys(REMARK_PREFIX_TO_BUYER).find((p) => value.startsWith(p));
  return prefix ? { status: 'ok', buyer: REMARK_PREFIX_TO_BUYER[prefix] } : { status: 'unknown' };
}

// Classifies the previous-shift report text by looking for the buyer
// token actually present in that text ("FPP HYNC" / "FPP SLNC"), never an
// exact FPP/shipment code -- the previous report text never contains that
// code, only the buyer name.
export function buyerFromPrevText(text) {
  const raw = String(text || '');
  const hasHync = /FPP\s+HYNC/i.test(raw);
  const hasSlnc = /FPP\s+SLNC/i.test(raw);
  if (hasHync && hasSlnc) return { status: 'ambiguous' };
  if (hasHync) return { status: 'ok', buyer: BUYER_HYNC };
  if (hasSlnc) return { status: 'ok', buyer: BUYER_SLNC };
  return { status: 'notFound' };
}
