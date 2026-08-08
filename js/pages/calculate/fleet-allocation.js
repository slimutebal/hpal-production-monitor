// Pure fleet-allocation search primitives (V2.4 Phase 3 -- Recommendation
// engine). See
// docs/V2.4_CALCULATE_AND_BLENDING_RECOMMENDATION_ARCHITECTURE.md Sections
// 12-13, 18-19, and this task's Sections 3-10/12-13/19/21.
//
// PURE MODULE CONTRACT: no DOM, no router, no i18n, no localStorage, no
// network, no window/document, no license-service dependency. Every
// function here takes plain numbers/arrays/objects and returns plain
// numbers/arrays/objects.
//
// PHYSICAL FLEET, NOT CONSUMABLE INVENTORY (this task's Section 6):
// `assignedUnits` is the physical reusable DT/fleet count currently at a
// source; `activeUnits` is how many of those units a candidate selects to
// remain active. The same active units repeat every conceptual cycle --
// nothing in this file ever decrements a "remaining" counter or computes a
// maximum number of cycles from a physical DT count.

// ============================================================
// RATIO MATH (architecture doc Section 12-13, this task's Sections 12-13/21)
// ============================================================

export function gcd(a, b) {
  let x = Math.abs(Math.trunc(a));
  let y = Math.abs(Math.trunc(b));
  while (y !== 0) {
    const remainder = x % y;
    x = y;
    y = remainder;
  }
  return x;
}

// Simplified Higher Grade : LGLO Hopper Pattern. Zero-side rules are
// deterministic (this task's Section 12): 0:N -> 0:1, N:0 -> 1:0. 0:0 is
// not a representable pattern and returns null -- callers must exclude
// such candidates (this cannot occur once totalActiveUnits > 0 is
// enforced, since that guarantees higherUnits + lgloUnits > 0).
export function simplifyUnitRatio(higherUnits, lgloUnits) {
  if (higherUnits === 0 && lgloUnits === 0) return null;
  if (higherUnits === 0) return { rawHigher: 0, rawLglo: lgloUnits, higher: 0, lglo: 1 };
  if (lgloUnits === 0) return { rawHigher: higherUnits, rawLglo: 0, higher: 1, lglo: 0 };
  const divisor = gcd(higherUnits, lgloUnits);
  return {
    rawHigher: higherUnits,
    rawLglo: lgloUnits,
    higher: higherUnits / divisor,
    lglo: lgloUnits / divisor,
  };
}

// Tonnage Ratio is ALWAYS derived from actual tonnage, never inferred from
// the (possibly very different) Unit Ratio -- architecture doc Section
// 19/20.2, this task's Section 13/28.
export function calculateTonnageRatio(higherTonnage, lgloTonnage) {
  const total = higherTonnage + lgloTonnage;
  if (!(total > 0)) return { higher: 0, lglo: 0 };
  return { higher: higherTonnage / total, lglo: lgloTonnage / total };
}

// Deterministic operational-simplicity ordering (this task's Section 21).
// Returns a plain array usable as a lexicographic sort key -- a
// numerically SMALLER key means an operationally SIMPLER pattern.
// [sum, max(higher,lglo), higher, lglo], e.g. 1:2 -> [3,2,1,2],
// 4:7 -> [11,7,4,7], so 1:2 sorts before 4:7 as required. Must be called
// with an ALREADY-SIMPLIFIED ratio (simplifyUnitRatio()'s output) so that
// an unsimplified 4:8 allocation is scored identically to 1:2 (Section 21's
// "4:8 must have the same Hopper Pattern simplicity as 1:2" rule).
export function simplicityKey(unitRatio) {
  const { higher, lglo } = unitRatio;
  return [higher + lglo, Math.max(higher, lglo), higher, lglo];
}

// ============================================================
// SEARCH-SPACE SAFETY BOUNDS (this task's Section 19)
// ============================================================
//
// The search enumerates every integer allocation across a Contractor's
// sources (never a consumable-inventory reduction), so its size grows
// combinatorially with fleet size/source count. These bounds exist ONLY to
// turn a pathological input into an explicit, deterministic
// SEARCH_SPACE_TOO_LARGE result (blending-recommendation.js checks the
// count BEFORE generating anything -- see countContractorAllocations()
// below) instead of hanging or silently truncating. Realistic field
// fleets (single/low-double-digit DT across a handful of sources per
// Contractor) stay far below these bounds -- see the benchmark suite
// (tests/recommendation-performance.test.mjs) for representative sizes.
export const MAX_ALLOCATIONS_PER_CONTRACTOR = 20000;
export const MAX_GLOBAL_CANDIDATES = 200000;

// Number of integer tuples (a_1..a_n), each >= 0, with Sum(a_i) <= fleet --
// i.e. C(fleet + sourceCount, sourceCount) by the standard stars-and-bars
// "at most" identity (an (n+1)-th slack variable absorbs the <= fleet
// remainder). Computed directly (no recursion/enumeration), so a bound
// check never has to materialize the space it is about to reject.
export function countContractorAllocations(fleet, sourceCount) {
  return binomialCoefficient(fleet + sourceCount, sourceCount);
}

function binomialCoefficient(n, k) {
  if (k < 0 || k > n) return 0;
  const kk = Math.min(k, n - k);
  let result = 1;
  for (let i = 0; i < kk; i += 1) {
    result = (result * (n - i)) / (i + 1);
  }
  return Math.round(result);
}

// All integer tuples (length = sourceCount) with each value >= 0 and
// Sum(values) <= fleet, in a deterministic (lexicographic, first-source-
// major) order. Callers (blending-recommendation.js) are responsible for
// checking countContractorAllocations() against
// MAX_ALLOCATIONS_PER_CONTRACTOR BEFORE calling this, so this function
// itself never needs to guess when to bail out mid-generation.
export function enumerateAllocations(fleet, sourceCount) {
  const results = [];
  const current = new Array(sourceCount).fill(0);

  function place(index, remaining) {
    if (index === sourceCount) {
      results.push(current.slice());
      return;
    }
    for (let v = 0; v <= remaining; v += 1) {
      current[index] = v;
      place(index + 1, remaining - v);
    }
  }

  place(0, fleet);
  return results;
}

// ============================================================
// CONTRACTOR GROUPING (this task's Section 7/19) -- deterministic
// regardless of the caller's input source order (Section 32).
// ============================================================
function normalizeKey(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

// sources: array of { pileId, contractor, ... } (any extra fields are
// carried through untouched). Returns groups ordered by normalized
// Contractor, each group's sources ordered by normalized Pile ID -- this
// canonical order is what makes candidate construction and the final
// deterministic tie-break (recommendation-ranking.js) independent of the
// order sources were originally supplied in.
export function groupSourcesByContractor(sources) {
  const byContractor = new Map();
  sources.forEach((source) => {
    const key = normalizeKey(source.contractor);
    if (!byContractor.has(key)) byContractor.set(key, []);
    byContractor.get(key).push(source);
  });

  const orderedKeys = [...byContractor.keys()].sort();
  return orderedKeys.map((key) => ({
    contractorKey: key,
    sources: byContractor.get(key)
      .slice()
      .sort((a, b) => {
        const pa = normalizeKey(a.pileId);
        const pb = normalizeKey(b.pileId);
        return pa < pb ? -1 : pa > pb ? 1 : 0;
      }),
  }));
}

// ============================================================
// SAME-CONTRACTOR RELOCATION DERIVATION (this task's Section 7/10)
// ============================================================
//
// contractorGroup: array of { pileId, contractor, assignedUnits,
// activeUnits } belonging to ONE Contractor, already in deterministic
// (normalized Pile ID) order -- this function does not re-sort, so callers
// control determinism explicitly (groupSourcesByContractor() above already
// produces groups in that order).
//
// Donors (activeUnits < assignedUnits) hand off their deficit to receivers
// (activeUnits > assignedUnits) in that deterministic order; any donor
// capacity left over once every receiver's need is satisfied is genuinely
// idle fleet at that source ("unused negative remainder... becomes
// surplus/standby quantity", this task's Section 10). Feasibility
// (Section 7's `Sum(activeUnits) <= totalPhysicalFleet` per Contractor)
// guarantees total donor capacity is always >= total receiver need, so
// every receiver's need is always fully satisfied here.
export function planContractorRelocations(contractorGroup) {
  const donors = [];
  const receivers = [];
  const perSource = new Map();

  contractorGroup.forEach((source) => {
    perSource.set(source.pileId, { moveInUnits: 0, moveOutUnits: 0, standbyUnits: 0 });
    const delta = source.activeUnits - source.assignedUnits;
    if (delta < 0) donors.push({ pileId: source.pileId, capacity: -delta });
    else if (delta > 0) receivers.push({ pileId: source.pileId, need: delta });
  });

  const relocations = [];
  const contractor = contractorGroup.length > 0 ? contractorGroup[0].contractor : '';
  let donorIndex = 0;
  let receiverIndex = 0;
  while (donorIndex < donors.length && receiverIndex < receivers.length) {
    const donor = donors[donorIndex];
    const receiver = receivers[receiverIndex];
    const moved = Math.min(donor.capacity, receiver.need);
    if (moved > 0) {
      relocations.push({ contractor, fromPileId: donor.pileId, toPileId: receiver.pileId, units: moved });
      donor.capacity -= moved;
      receiver.need -= moved;
      perSource.get(donor.pileId).moveOutUnits += moved;
      perSource.get(receiver.pileId).moveInUnits += moved;
    }
    if (donor.capacity === 0) donorIndex += 1;
    if (receiver.need === 0) receiverIndex += 1;
  }

  donors.forEach((donor) => {
    if (donor.capacity > 0) {
      perSource.get(donor.pileId).standbyUnits += donor.capacity;
    }
  });

  return { relocations, perSource };
}
