// Buyer registry for the Report module. This is a dependency-free leaf
// module (no imports) so shared-report-profile.js can safely import it
// without creating a cycle back through hync-profile.js/slnc-profile.js.
// esg-profile.js and its Phase 1 dependencies are intentionally NOT
// imported here either -- ESG's workbook buyer/format is resolved by
// report-workbook-dispatcher.js before report-page.js ever reaches the
// buyer-resolution step this module drives, so this file only needs to
// know ESG's previous-report token and its display/output configuration.
//
// "Buyer identity" for HYNC/SLNC means the SCHY-/SCSL- prefix family only
// -- the digits after the prefix are a per-shipment FPP/batch code, not
// part of buyer identity, and are intentionally never compared (see
// docs/V2.0_ARCHITECTURE_AND_ROADMAP.md's Report HYNC/SLNC section: multiple
// distinct codes for the same buyer in one shift file are normal). ESG has
// no equivalent row-level prefix (confirmed during ESG analysis -- its
// per-row codes vary per shipment/pile, not per buyer), so ESG's workbook
// buyer is resolved structurally by the ESG detector/adapters instead, not
// by this module's buyerFromRemark().

export const BUYER_HYNC = 'HYNC';
export const BUYER_SLNC = 'SLNC';
export const BUYER_ESG = 'ESG';
export const SUPPORTED_BUYERS = [BUYER_HYNC, BUYER_SLNC, BUYER_ESG];

// User-visible display label for a buyer id. Internal identity (BUYER_ESG,
// workbookBuyer/resolvedBuyer values, ESG_FORMAT_A/B, esg-profile.js) stays
// 'ESG' everywhere -- this mapping is the one seam where the Report UI and
// generated report text show the Owner-approved "EIEB" naming instead,
// matching Monitor's own existing buyer label for the same workbook shape
// (index.html's detectBuyer() already returns 'EIEB', not 'ESG').
const BUYER_DISPLAY_LABEL = {
  [BUYER_ESG]: 'EIEB',
};

export function getBuyerDisplayLabel(buyer) {
  return BUYER_DISPLAY_LABEL[buyer] || buyer;
}

// Source of truth for "which 备注 prefix means which buyer". Each profile
// module (hync-profile.js / slnc-profile.js) also declares its own prefix
// constant for readability at the profile-definition site; if a prefix ever
// changes, update both -- they are intentionally small, stable literals
// duplicated for module-boundary reasons (this file must stay import-free),
// not independently-maintained business logic. ESG is deliberately absent
// from this map -- see the header comment above.
const REMARK_PREFIX_TO_BUYER = {
  SCHY: BUYER_HYNC,
  SCSL: BUYER_SLNC,
};

// Per-buyer Report-page configuration. previousReportOptional/partnerLabel
// are read by report-page.js instead of hardcoding per-buyer branches
// there; nothing here is buyer-secret business logic, just presentation
// configuration, so it is safe to derive display strings from `buyer`
// directly (label/outputLabel always equal the buyer code for all three
// buyers today -- kept as separate fields rather than collapsed, in case a
// future buyer's display name and code-token ever diverge).
const PROFILE_CONFIG = {
  [BUYER_HYNC]: { partnerLabel: 'AWK', previousReportOptional: false },
  [BUYER_SLNC]: { partnerLabel: 'AWK', previousReportOptional: false },
  [BUYER_ESG]: { partnerLabel: 'ATQ', previousReportOptional: true },
};

export function getProfile(buyer) {
  if (!SUPPORTED_BUYERS.includes(buyer)) return null;
  const config = PROFILE_CONFIG[buyer];
  return { buyer, label: buyer, displayName: buyer, outputLabel: buyer, ...config };
}

// Classifies one workbook row's raw 备注 cell value. Only the prefix is
// checked (startsWith), never the full code -- SCSL-0000033 and
// SCSL-0000034 must both resolve to { status: 'ok', buyer: 'SLNC' }. Never
// resolves to ESG -- ESG workbook buyer resolution is structural (see
// esg-workbook-detector.js / esg-profile.js), not remark-prefix-based.
export function buyerFromRemark(rawValue) {
  const value = String(rawValue == null ? '' : rawValue).trim().toUpperCase();
  if (!value) return { status: 'blank' };
  const prefix = Object.keys(REMARK_PREFIX_TO_BUYER).find((p) => value.startsWith(p));
  return prefix ? { status: 'ok', buyer: REMARK_PREFIX_TO_BUYER[prefix] } : { status: 'unknown' };
}

// Classifies the previous-shift report text by looking for the buyer
// token actually present in that text ("FPP HYNC" / "FPP SLNC" /
// "FPP ESG" or "FPP EIEB"), never an exact FPP/shipment code -- the
// previous report text never contains that code, only the buyer name. Any
// two (or more) tokens present at once is ambiguous and blocks, same as
// the original HYNC/SLNC rule; never silently defaults to any buyer.
// Both "FPP ESG" and "FPP EIEB" resolve to the one internal BUYER_ESG
// identity: this Report module now only ever *generates* "FPP EIEB" (the
// approved user-visible naming, see getBuyerDisplayLabel), but a pasted
// previous report may still be one generated before this wording change
// and legitimately say "FPP ESG" -- both must keep resolving correctly.
export function buyerFromPrevText(text) {
  const raw = String(text || '');
  const hasHync = /FPP\s+HYNC/i.test(raw);
  const hasSlnc = /FPP\s+SLNC/i.test(raw);
  const hasEsg = /FPP\s+(ESG|EIEB)/i.test(raw);
  const matchCount = [hasHync, hasSlnc, hasEsg].filter(Boolean).length;
  if (matchCount > 1) return { status: 'ambiguous' };
  if (hasHync) return { status: 'ok', buyer: BUYER_HYNC };
  if (hasSlnc) return { status: 'ok', buyer: BUYER_SLNC };
  if (hasEsg) return { status: 'ok', buyer: BUYER_ESG };
  return { status: 'notFound' };
}
