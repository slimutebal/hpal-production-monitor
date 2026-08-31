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
// SEARCH-SPACE SAFETY BOUNDS (this task's Section 19; V3.0 Phase 4D
// redesign, docs/V3.0_SCALABLE_RECOMMENDATION_ENGINE_ARCHITECTURE.md
// "Replace Legacy Theoretical Candidate Gate").
//
// MAX_ALLOCATIONS_PER_CONTRACTOR remains a hard GENERATION-TIME pre-gate:
// enumerateOperationalAllocations() (below) eagerly MATERIALIZES an array
// of this many tuples for a single Contractor group before Branch-and-
// Bound ever runs -- Phase 4C's chemistry/ranking-prefix pruning only
// operates BETWEEN Contractor groups (blending-recommendation.js's
// suffixBounds/suffixRankBounds), never inside one group's own leaf
// enumeration, so a single oversized group gets ZERO pruning benefit and
// blending-recommendation.js's node budget (which only bounds TRAVERSAL,
// not this prior array-allocation step) cannot protect against it either.
// This is why Phase 4D keeps this exact pre-gate unchanged rather than
// replacing it: it protects a cost the node budget structurally cannot
// see. Realistic field fleets (single/low-double-digit DT across a
// handful of sources per Contractor) stay far below this bound -- see the
// benchmark suite (tests/recommendation-performance.test.mjs) for
// representative sizes.
//
// The former MAX_GLOBAL_CANDIDATES (200,000) -- a pre-search gate on the
// full cross-Contractor product -- is REMOVED as of Phase 4D. It bounded
// the THEORETICAL search space, not actual Branch-and-Bound traversal
// work, and Phase 4C's pruning routinely completes spaces many times
// larger than 200,000 while visiting only a few thousand actual nodes
// (e.g. the 6-dome/3-Contractor/60-DT case: candidateCount 438,975,
// ~6,900 nodes actually visited -- see
// tests/v3-phase4d-node-budget.test.mjs). blending-recommendation.js's
// MAX_SEARCH_NODES now bounds the search by ACTUAL traversal work
// (visitedNodes) instead, which the removed gate could never measure.
export const MAX_ALLOCATIONS_PER_CONTRACTOR = 20000;

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
// GENERATION-TIME OPERATIONAL FEASIBILITY (V3.0 Phase 2, Owner-approved
// domain decision -- this task's Section 0/4/5). An ACTIVE loading point
// is operationally feasible ONLY when it carries 0 DT (closed/idle) or
// >= MIN_UNITS_PER_ACTIVE_LOADING_POINT DT -- 1-5 DT is no longer a
// candidate allocation at all, not merely a ranking-penalized one. This is
// the SINGLE source of truth for that constant/predicate across
// production (operational-continuity.js re-exports both from here rather
// than defining its own copy -- this task's Section 4). Prior to Phase 2
// this lived only in operational-continuity.js as
// MIN_UNITS_PER_SPLIT_LOADING_POINT/isOperationalLoadingPointAllocation
// and was consulted only by ranking (recommendation-ranking.js); it now
// belongs here because fleet-allocation.js's own generation primitives
// (enumerateOperationalAllocations()/countOperationalAllocations() below)
// are the first place that needs it.
//
// This value is also what bounds each side of operational-continuity.js's
// findSplitLoadingPlan() -- a hypothetical SPLIT dome is itself an active
// loading point, so the identical minimum applies there by construction,
// not by coincidence.
export const MIN_UNITS_PER_ACTIVE_LOADING_POINT = 6;

export function isOperationalLoadingPointAllocation(activeUnits) {
  return activeUnits === 0 || activeUnits >= MIN_UNITS_PER_ACTIVE_LOADING_POINT;
}

// Exact count of n-tuples (a_1..a_n) where EACH a_i is either 0 or in
// [M, F], with Sum(a_i) <= F (M = MIN_UNITS_PER_ACTIVE_LOADING_POINT) --
// the operationally-feasible subset of what countContractorAllocations()
// counts. Derivation (this task's Section 8, independently re-verified
// against exhaustive enumeration by
// tests/v3-operational-allocation.test.mjs's counting matrix before this
// was trusted as a safety-bound gate):
//
//   For exactly k of the n sources active (0 <= k <= min(n, floor(F/M))):
//     - choose WHICH k sources are active: C(n, k)
//     - each active source contributes x_i = M + y_i, y_i >= 0, with
//       Sum(y_i) <= F - kM -- this is exactly the SAME "at most" stars-
//       and-bars shape countContractorAllocations() already computes, just
//       over a smaller budget (F - kM) and k slots instead of n:
//       countContractorAllocations(F - kM, k) = C((F-kM)+k, k)
//   Total = Sum over k of C(n,k) * countContractorAllocations(F-kM, k)
//
// Includes the all-zero tuple (k=0 contributes exactly 1), matching
// countContractorAllocations()'s own inclusion of the all-zero tuple --
// blending-recommendation.js's buildCandidate() is what excludes
// totalActiveUnits === 0 from actual candidates, not this counter (this
// task's Section 9) -- so this counter's role/shape relative to the
// search-space safety gate is unchanged from before Phase 2.
export function countOperationalAllocations(fleet, sourceCount) {
  const minUnits = MIN_UNITS_PER_ACTIVE_LOADING_POINT;
  const maxActiveSources = Math.min(sourceCount, Math.floor(fleet / minUnits));
  let total = 0;
  for (let k = 0; k <= maxActiveSources; k += 1) {
    total += binomialCoefficient(sourceCount, k) * countContractorAllocations(fleet - k * minUnits, k);
  }
  return total;
}

// All integer tuples (length = sourceCount) where EACH value is 0 or in
// [MIN_UNITS_PER_ACTIVE_LOADING_POINT, remaining], Sum(values) <= fleet,
// in deterministic ascending order per source (0 before 6, 6 before 7,
// ...) -- this task's Section 6. Same-Contractor relocation compatibility
// is preserved unchanged (this task's Section 5/23): a source's active
// allocation is bounded only by the Contractor GROUP's total fleet, never
// by that individual source's own original assignedUnits, exactly like
// enumerateAllocations() above.
export function enumerateOperationalAllocations(fleet, sourceCount) {
  const minUnits = MIN_UNITS_PER_ACTIVE_LOADING_POINT;
  const results = [];
  const current = new Array(sourceCount).fill(0);

  function place(index, remaining) {
    if (index === sourceCount) {
      results.push(current.slice());
      return;
    }
    current[index] = 0;
    place(index + 1, remaining);
    for (let v = minUnits; v <= remaining; v += 1) {
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
