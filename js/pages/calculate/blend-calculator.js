// Pure Blend Calculator math (V2.4 Phase 2 -- Blend Calculator). See
// docs/V2.4_CALCULATE_AND_BLENDING_RECOMMENDATION_ARCHITECTURE.md Sections
// 14-15/36.
//
// PURE MODULE CONTRACT: no DOM access, no router import, no i18n import,
// no localStorage, no network, no side effects. Every function here takes
// already-validated numeric inputs and returns raw numbers/plain objects
// -- calculate-page.js (the DOM layer) is responsible for parsing raw
// string input, running calculate-validation.js first, and formatting the
// result for display (Section 7/25: "Return raw numeric values from pure
// functions. Format in the UI layer.").
//
// This is Blend mode only ("Jumlah Unit" = DT/loads ACTUALLY USED -- a
// fully approved, unambiguous meaning, unlike Recommendation mode's still-
// blocked Gate A semantics, architecture doc Section 13.1). Nothing here
// computes a Hopper Pattern, a Unit/Tonnage Ratio recommendation, or any
// USE/LIMIT/STOP action -- `classes`/`higherGrade` below are informational
// totals only, per Section 18-19 of the architecture doc.
import { classifyOre } from '../../shared/ore-classification.js';

const ORE_CLASS_NAMES = ['HGLO', 'MGLO', 'LGLO'];

export function calculatePileTonnage(units, tonnesPerUnit) {
  return units * tonnesPerUnit;
}

function emptyClassTotals() {
  return { HGLO: { units: 0, tonnage: 0 }, MGLO: { units: 0, tonnage: 0 }, LGLO: { units: 0, tonnage: 0 } };
}

// piles: array of { pileId, ni, units, tonnesPerUnit } with already-numeric
// (not raw string) ni/units/tonnesPerUnit -- calculate-validation.js is
// responsible for rejecting anything that would make this function see
// NaN/Infinity/negative values before it is ever called.
//
// Returns { ok: true, ...result } on success, or { ok: false, error } if
// every pile contributes zero tonnage (never silently returns Ni = 0 or
// NaN -- architecture doc Section 8/29's "total tonnage = 0 must not
// return Ni = 0" requirement enforced here as well as at the validation
// layer, so this function is safe to call directly in tests without going
// through calculate-validation.js first).
export function calculateWeightedBlend(piles) {
  const pileResults = piles.map((pile) => ({
    pileId: pile.pileId,
    ni: pile.ni,
    units: pile.units,
    tonnesPerUnit: pile.tonnesPerUnit,
    tonnage: calculatePileTonnage(pile.units, pile.tonnesPerUnit),
    oreClass: classifyOre(pile.ni),
  }));

  const totalUnits = pileResults.reduce((sum, p) => sum + p.units, 0);
  const totalTonnage = pileResults.reduce((sum, p) => sum + p.tonnage, 0);

  if (!(totalTonnage > 0)) {
    return { ok: false, error: 'ZERO_TOTAL_TONNAGE' };
  }

  // Single accumulation pass, no intermediate rounding anywhere -- the
  // weighted-Ni numerator and totalTonnage above are both full-precision
  // running sums; the division happens exactly once, at the very end.
  const weightedNiNumerator = pileResults.reduce((sum, p) => sum + p.ni * p.tonnage, 0);
  const weightedNi = weightedNiNumerator / totalTonnage;

  const piles_ = pileResults.map((p) => ({ ...p, tonnageShare: p.tonnage / totalTonnage }));

  const classes = emptyClassTotals();
  piles_.forEach((p) => {
    if (p.oreClass && ORE_CLASS_NAMES.includes(p.oreClass)) {
      classes[p.oreClass].units += p.units;
      classes[p.oreClass].tonnage += p.tonnage;
    }
  });

  // Informational totals only (architecture doc Section 18-19) -- Phase 2
  // must not interpret these as a recommended HG/MG : LGLO ratio.
  const higherGrade = {
    units: classes.HGLO.units + classes.MGLO.units,
    tonnage: classes.HGLO.tonnage + classes.MGLO.tonnage,
  };

  return {
    ok: true,
    totalUnits,
    totalTonnage,
    weightedNi,
    piles: piles_,
    classes,
    higherGrade,
  };
}
