// V3.0 Phase 6B -- PROTOTYPE ONLY: source-level lazy Branch-and-Bound
// traversal (docs/V3.0_SCALABLE_RECOMMENDATION_ENGINE_ARCHITECTURE.md
// Section 23; this task's SOURCE-LEVEL MODEL/LAZY REQUIREMENT).
//
// NOT WIRED TO PRODUCTION. No production file imports this module. This
// exists to PROVE OR DISPROVE whether pruning at individual dome
// (source) granularity -- instead of only at Contractor-group boundaries,
// which is what blending-recommendation.js's forEachCandidatePruned() does
// today -- can complete Scenario C/D (10 dome / 5-or-3 Contractor / 100 DT,
// currently SEARCH_INCOMPLETE at the unchanged 500,000-node budget) and let
// Scenario E (10 dome / 2 Contractor / 100 DT concentrated, currently
// rejected by the eager 20,000-per-Contractor MAX_ALLOCATIONS_PER_CONTRACTOR
// gate BEFORE any traversal starts) at least begin traversing.
//
// Phase 6A (tests/v3-phase6a-search-order.test.mjs) already proved that
// reordering WHICH Contractor group is decided at which depth cannot fix
// C/D: the chemistry bound cannot discriminate on these symmetric
// high/low-Ni-source shapes regardless of group visitation order. This
// prototype attacks a DIFFERENT axis: granularity. Today one "node" is an
// entire Contractor's allocation tuple, chosen from an EAGERLY
// materialized array (fleet-allocation.js's enumerateOperationalAllocations(),
// gated at 20,000 tuples/Contractor). This prototype instead decides ONE
// SOURCE (one dome) at a time, so a bound can be evaluated -- and a branch
// pruned -- after the first dome of a 5-dome Contractor is decided, without
// ever materializing that Contractor's other 4-dome combinations, let alone
// its full tuple array.
//
// REUSE, NOT REIMPLEMENTATION: every business-rule function this file
// calls is imported from the real production modules --
// buildCandidate()/groupSourceNiExtent()/groupMaxAchievableTonnage()/
// conservativeFinalNiBound()/boundIntersectsTolerance()/
// conservativeRankingBound()/boundCannotBeatIncumbent()/
// incumbentRankingMetrics()/computeContractorSearchOrder()/MAX_SEARCH_NODES
// from blending-recommendation.js, and
// groupSourcesByContractor()/countOperationalAllocations()/
// isOperationalLoadingPointAllocation()/MIN_UNITS_PER_ACTIVE_LOADING_POINT
// from fleet-allocation.js. This file adds exactly ONE new piece of
// domain math -- openBudgetRankContribution() below -- plus the source-level
// traversal loop itself. Ranking rule order/weighting is untouched.
//
// ============================================================
// CLOSED-FORM PARTIAL-GROUP RANK BOUND -- PROOF
// ============================================================
// Production's computeGroupRankProfile() (blending-recommendation.js)
// derives a fully-open group's best-case rule A/B/C/D/E contribution by
// SCANNING every one of that group's already-enumerated allocations. That
// scan is exactly the eager materialization this prototype must not rely
// on. This section proves each of those quantities has an EXACT (not
// merely conservative) closed form computable from just (remainingFleet,
// remaining source list) -- with NO enumeration -- so the identical
// per-rule independent-optimization proof in blending-recommendation.js
// (see its own "PROOF (multi-key lexicographic domination...)" comment)
// still applies unchanged; only how each group's own best-case number is
// COMPUTED changes, never the bound-combination algebra.
//
// Let F = remainingFleet (>=0), and let the still-undecided sources in this
// group be S (|S| = m >= 1, since this is only ever evaluated at a node
// that still has at least one source left to decide in the group).
//
// (1) additionalMaxActiveUnits = max over feasible completions of Sum(v_i)
//     for i in S, each v_i in {0} U [6, F], Sum(v_i) <= F.
//     Claim: this equals F if F==0 or F>=6, else 0.
//     - If F==0: only the all-zero completion is feasible (every v_i<=F=0
//       forces v_i=0), so the sum is 0=F.
//     - If F>=6: placing the ENTIRE remaining budget on any single source
//       in S (v_i=F for one, 0 for the rest) is feasible (F is in [6,F],
//       and Sum=F<=F), and no completion can exceed the shared fleet
//       ceiling F, so F is both achievable and an upper bound: the max is
//       exactly F.
//     - If 1<=F<=5: no v_i can be nonzero (nonzero requires >=6, but
//       v_i<=F<6), so every completion sums to 0, and 0 is a tight upper
//       bound trivially. Matches
//       fleet-allocation.js's own isOperationalLoadingPointAllocation(F)
//       gate shape (0-or->=6), reused verbatim below.
//
// (2) minAdditionalFullyUnusedCount = min over feasible completions of
//     |{ i in S : source_i.assignedUnits > 0 AND v_i == 0 }|.
//     Let p = |{ i in S : source_i.assignedUnits > 0 }| (the "occupied"
//     remaining sources -- fullyUnusedCount only ever counts a source that
//     WAS assigned fleet and ends up idle, per allocationRankMetrics()'s
//     own definition, reused unchanged).
//     Claim: this equals p - min(p, floor(F/6)).
//     - Upper bound on how many occupied sources can be SIMULTANEOUSLY
//       active: each active source consumes >=6 of the shared budget F, so
//       at most floor(F/6) sources (occupied or not) can be active at
//       once -- hence at most min(p, floor(F/6)) OCCUPIED sources can be
//       active, proving p - min(p, floor(F/6)) is a lower bound on the
//       fully-unused count.
//     - Achievability: let k = min(p, floor(F/6)). Assign exactly 6 units
//       to each of k chosen occupied sources (consuming 6k <= F), 0 to
//       every other occupied source, and dump any leftover F-6k either
//       onto one of the k already-active sources (still a valid >=6 value,
//       does not change which sources are active/inactive) or onto a
//       non-occupied source in S if one exists (assignedUnits==0, so it is
//       never counted regardless of its own activeUnits) -- both keep
//       Sum(v_i) <= F and every v_i in {0} U [6,F]. This completion
//       achieves fully-unused count exactly p-k, matching the bound.
//
// Both quantities are therefore EXACT minima/maxima over the group's
// remaining feasible completions, not merely conservative approximations
// -- computing them this way can never prune a branch a full enumeration
// would have kept open. groupMaxAchievableTonnage()/groupSourceNiExtent()
// (imported, unchanged from Phase 4A/4B) already give the analogous exact
// closed forms for tonnage/Ni that this file reuses directly for the
// chemistry-bound side of the same partial-group state.
// ============================================================
import { classifyOre } from '../../shared/ore-classification.js';
import { parseDecimalInput } from './number-input.js';
import { normalizeSourceIdentity } from './calculate-validation.js';
import {
  groupSourcesByContractor,
  countOperationalAllocations,
  isOperationalLoadingPointAllocation,
  MIN_UNITS_PER_ACTIVE_LOADING_POINT,
  simplifyUnitRatio,
  simplicityKey,
} from './fleet-allocation.js';
import {
  validateTargetNi,
  validateTolerance,
  validateRecommendationSources,
  buildCandidate,
  groupSourceNiExtent,
  groupMaxAchievableTonnage,
  conservativeFinalNiBound,
  boundIntersectsTolerance,
  conservativeRankingBound,
  boundCannotBeatIncumbent,
  incumbentRankingMetrics,
  computeContractorSearchOrder,
  isWithinTolerance,
  MAX_SEARCH_NODES,
  DEFAULT_RECOMMENDATION_TOLERANCE,
} from './blending-recommendation.js';
import { compareWithinTolerance, compareBestAttainable } from './recommendation-ranking.js';
import { CRITICAL_STANDBY_RATIO, MINOR_STANDBY_RATIO } from './operational-continuity.js';

// Byte-for-byte copy of blending-recommendation.js's own private
// toNumericSource() -- NOT exported by that module, so this prototype (which
// must not modify production files) duplicates this ~10-line shape
// conversion only. Every actual business rule after this point is imported,
// never duplicated.
function toNumericSource(source) {
  const ni = parseDecimalInput(source.ni);
  return {
    pileId: source.pileId.trim(),
    contractor: source.contractor.trim(),
    ni,
    assignedUnits: Number(source.units),
    tonnesPerUnit: parseDecimalInput(source.tonnesPerUnit),
    oreClass: classifyOre(ni),
  };
}

// See file header PROOF (2)/(1). `remainingFleet` is the still-unspent
// budget for ONE Contractor group; `remainingSources` are that group's own
// not-yet-decided sources (numeric, i.e. toNumericSource() shape).
export function openBudgetRankContribution(remainingFleet, remainingSources) {
  const additionalMaxActiveUnits = isOperationalLoadingPointAllocation(remainingFleet) ? remainingFleet : 0;
  const occupiedCount = remainingSources.reduce((count, s) => count + (s.assignedUnits > 0 ? 1 : 0), 0);
  const activatable = Math.min(occupiedCount, Math.floor(remainingFleet / MIN_UNITS_PER_ACTIVE_LOADING_POINT));
  const minAdditionalFullyUnusedCount = occupiedCount - activatable;
  return { additionalMaxActiveUnits, minAdditionalFullyUnusedCount };
}

// No eager array is ever built for this: NO enumerateOperationalAllocations()
// call anywhere in this module. Every allocation is generated ON DEMAND by
// the recursive descent in runSourceLazySearch() below, one dome at a time.
function prepareSourceLazySearch({ targetNi, tolerance, sources }) {
  const targetError = validateTargetNi(targetNi);
  const toleranceError = validateTolerance(tolerance);
  const { sourceErrors, fleetError, valid: sourcesValid } = validateRecommendationSources(sources);
  if (targetError || toleranceError || !sourcesValid) {
    return { ok: false, result: { ok: false, error: 'INVALID_INPUT', targetError, toleranceError, sourceErrors, fleetError } };
  }

  const targetNiValue = parseDecimalInput(targetNi);
  const toleranceValue = parseDecimalInput(tolerance);
  const numericSources = sources.map(toNumericSource);
  const groups = groupSourcesByContractor(numericSources);
  const groupFleets = groups.map((g) => g.sources.reduce((sum, s) => sum + s.assignedUnits, 0));

  // Exact, closed-form (no enumeration) per-group operational allocation
  // COUNT, reused for two purposes: (a) candidateCount metadata below,
  // preserving the theoretical operational candidateCount semantics this
  // task requires unchanged; (b) a zero-materialization stand-in for
  // computeContractorSearchOrder()'s 'smallest-space-first' metric, which
  // only ever reads `.length` off whatever array-like it is given -- a
  // {length: N} object satisfies that without allocating N tuples.
  const perGroupCounts = groups.map((g, i) => countOperationalAllocations(groupFleets[i], g.sources.length));
  const fakeAllocationLengths = perGroupCounts.map((count) => ({ length: count }));
  const searchOrder = computeContractorSearchOrder(groups, fakeAllocationLengths);

  const candidateCount = perGroupCounts.reduce((product, count) => product * count, 1) - 1;

  return { ok: true, groups, groupFleets, perGroupCounts, searchOrder, targetNiValue, toleranceValue, candidateCount };
}

// Flatten groups (in TRAVERSAL/depth order, i.e. permuted by `searchOrder`)
// into one canonical-within-group-order source list, each entry tagged with
// its DEPTH-POSITION group index (0..travGroups.length-1) -- never the
// canonical group index, so every other array built below (travFleets,
// suffix bounds) can be indexed consistently by depth position alone.
function buildTraversalPlan(groups, groupFleets, searchOrder) {
  const travGroups = searchOrder.map((i) => groups[i]);
  const travFleets = searchOrder.map((i) => groupFleets[i]);

  const flatSources = [];
  // remainingSourcesFrom[flatIdx] = STATIC array of that group's own
  // not-yet-decided sources starting at flatIdx (purely a function of
  // flatIdx, never of runtime path -- see file header) (this task's "same
  // Contractor total allocation must remain <= physical fleet").
  const remainingSourcesFrom = [];
  const groupIndexOf = [];
  travGroups.forEach((group, depthIndex) => {
    group.sources.forEach((_, k) => {
      remainingSourcesFrom.push(group.sources.slice(k));
      groupIndexOf.push(depthIndex);
    });
    flatSources.push(...group.sources);
  });

  // suffixAfterGroup[d] = combined FULLY-OPEN bound of travGroups[d..end) --
  // groups[d] itself, plus everything after it. Consulted as
  // suffixAfterGroup[depthIndex + 1] ("strictly after the CURRENT
  // in-progress group") by the node-level bound check, which combines it
  // with that current group's own PARTIAL (remaining-budget) bound computed
  // fresh at each node. Same recursive-suffix SHAPE as
  // blending-recommendation.js's computeSuffixBounds()/
  // computeSuffixRankBounds(), just fed closed-form (not enumerated)
  // per-group numbers -- see file header proof for why the closed form is
  // exact, not merely conservative, so this is a like-for-like
  // substitution.
  const n = travGroups.length;
  const suffixChemAfterGroup = new Array(n + 1);
  const suffixRankAfterGroup = new Array(n + 1);
  // V3.0 Phase 6D -- PER-GROUP (never pooled) chemistry envelope, one entry
  // per depth-position group, using that group's FULL fleet/sources (static,
  // computed once per search, same cost shape as the suffix arrays above).
  // Consulted by the COUPLED chemistry bound below as
  // groupEnvelopes.slice(depthIndex + 1) -- "every group strictly after the
  // CURRENT in-progress group, each kept as its OWN separate envelope" --
  // never merged into a single pooled (minNi,maxNi,maxOpenTonnage) triple
  // the way suffixChemAfterGroup is (this task's own "keep each Contractor
  // envelope SEPARATE" requirement).
  const groupEnvelopes = new Array(n);
  suffixChemAfterGroup[n] = { minNi: Infinity, maxNi: -Infinity, maxOpenTonnage: 0 };
  suffixRankAfterGroup[n] = { minCriticalCount: 0, maxActiveUnits: 0, minWorstRatio: 0, minMitigationCount: 0, minFullyUnusedCount: 0 };
  for (let d = n - 1; d >= 0; d -= 1) {
    const group = travGroups[d];
    const fleet = travFleets[d];
    const extent = groupSourceNiExtent(group.sources);
    const maxTonnage = groupMaxAchievableTonnage(fleet, group.sources);
    groupEnvelopes[d] = { minNi: extent.minNi, maxNi: extent.maxNi, thiTonnage: maxTonnage };
    const restChem = suffixChemAfterGroup[d + 1];
    suffixChemAfterGroup[d] = {
      minNi: Math.min(extent.minNi, restChem.minNi),
      maxNi: Math.max(extent.maxNi, restChem.maxNi),
      maxOpenTonnage: maxTonnage + restChem.maxOpenTonnage,
    };

    const { additionalMaxActiveUnits, minAdditionalFullyUnusedCount } = openBudgetRankContribution(fleet, group.sources);
    const minStandbyRatio = fleet > 0 ? (fleet - additionalMaxActiveUnits) / fleet : 0;
    const restRank = suffixRankAfterGroup[d + 1];
    suffixRankAfterGroup[d] = {
      minCriticalCount: (minStandbyRatio >= CRITICAL_STANDBY_RATIO ? 1 : 0) + restRank.minCriticalCount,
      maxActiveUnits: additionalMaxActiveUnits + restRank.maxActiveUnits,
      minWorstRatio: Math.max(minStandbyRatio, restRank.minWorstRatio),
      minMitigationCount: (minStandbyRatio > MINOR_STANDBY_RATIO ? 1 : 0) + restRank.minMitigationCount,
      minFullyUnusedCount: minAdditionalFullyUnusedCount + restRank.minFullyUnusedCount,
    };
  }

  // V3.0 Phase 6H -- requiredGroupActive[d] = the EXACT final active-unit
  // sum group d (depth-position d) must reach for this search's proven
  // A/B-optimal prefix (PHASE 6H ANALYSIS below) to be achievable: its own
  // full fleet when that fleet is itself operational (0 or >=6 --
  // isOperationalLoadingPointAllocation(), imported/unchanged, reused
  // verbatim -- the SAME predicate openBudgetRankContribution() above
  // already applies to a PARTIAL remaining budget; here applied ONCE to
  // each group's STATIC, FULL fleet total), else 0 (a fleet stuck at 1-5
  // can never legally activate any unit at all, per this task's own
  // "Do NOT assume globalMaxActive = raw physical fleet blindly... include
  // Contractors whose fleet cannot legally become active" warning).
  // globalMaxActiveUnits is simply their sum -- see PHASE 6H ANALYSIS for
  // the proof this is the TRUE global maximum of candidate.totalActiveUnits
  // over the ENTIRE search space, derived with NO enumeration (a static
  // function of travFleets alone, computed once per search).
  const requiredGroupActive = travFleets.map((fleet) => (isOperationalLoadingPointAllocation(fleet) ? fleet : 0));
  const globalMaxActiveUnits = requiredGroupActive.reduce((sum, v) => sum + v, 0);

  return {
    travGroups, travFleets, flatSources, remainingSourcesFrom, groupIndexOf, suffixChemAfterGroup, suffixRankAfterGroup, groupEnvelopes,
    requiredGroupActive, globalMaxActiveUnits,
  };
}

// ============================================================
// V3.0 Phase 6H -- PROTOTYPE ONLY: exact ranking-prefix constraint
// PROPAGATION (this task's "exploit PROVEN-GLOBALLY-OPTIMAL ranking-prefix
// values to tighten the feasible domains themselves... this is exact
// constraint propagation, not heuristic pruning"). Phase 6G proved C/D need
// far more than 500,000 source-level nodes to COMPLETE EXACTLY; this phase
// does not raise that budget -- it removes, at generation time, source
// value choices that a witnessed incumbent has already PROVEN can never
// produce a winning candidate, so fewer nodes are ever visited at all.
//
// ---- SECTION 1: PROVABLE GLOBAL PREFIX (A + B) ----
// requiredGroupActive[d]/globalMaxActiveUnits above are STATIC upper
// bounds on what group d, and the whole search, can EVER achieve for rule
// B (totalActiveUnits): activeUnits for a group can never exceed its own
// fleet (a hard physical ceiling, same invariant every earlier phase
// relies on), and a fleet stuck at 1-5 can never legally carry ANY active
// unit (0-or->=6 rule, generation-time since V3.0 Phase 2) -- so no real
// completion, from ANY branch anywhere in the search, can ever produce
// totalActiveUnits > globalMaxActiveUnits. The instant a REAL, buildCandidate
// -validated within-tolerance candidate is witnessed with
// criticalContractorCount===0 (rule A already at its own unconditional
// floor -- 0 is the least any non-negative count can ever be) AND
// totalActiveUnits===globalMaxActiveUnits (rule B already at the
// unconditional ceiling proven above), BOTH A and B are PROVEN globally
// optimal for the ENTIRE remaining search, not merely for that one
// candidate's own branch: no future candidate anywhere can ever have
// bestCriticalContractorCount<0 (impossible) or totalActiveUnits>
// globalMaxActiveUnits (proven impossible above), so every future
// candidate either ties this witnessed incumbent on A and B (and must then
// be decided by C onward) or loses outright on A or B. This is exactly
// this task's own "important safe case" -- implemented as pruningGate.
// rankingPrefixLocked below, flipped (once, never reset) the instant
// runStreamingSearchSourceLazy() witnesses such an incumbent.
//
// ---- SECTION 2: DOMAIN PROPAGATION ----
// Once locked, ANY completion of group d that does not sum to EXACTLY
// requiredGroupActive[d] makes the search's OVERALL totalActiveUnits
// strictly less than globalMaxActiveUnits (each group's own contribution is
// independently ceilinged at requiredGroupActive[d], proven above, so the
// only way the GLOBAL sum reaches globalMaxActiveUnits is for EVERY single
// group to simultaneously reach its own ceiling -- falling short in any one
// group can never be compensated by another, since no group can exceed its
// own physical fleet). Such a completion therefore CANNOT tie (let alone
// beat) the locked incumbent on B, so it can never win -- safe to never
// generate it at all, rather than generate-then-prune via the existing
// (unchanged) rank-bound check. canSatisfyExactRemainingTotal() below
// (this task's Section 4 pure helper) answers, with exact integer
// arithmetic and NO enumeration, whether the sources still undecided AFTER
// the CURRENT one can still close the gap to requiredGroupActive[d]; any
// candidate value for the current source that would leave an unclosable
// gap is filtered out of the generator's own value list BEFORE recursion.
//
// ---- SECTION 3: OPTIONAL E PROPAGATION ----
// A useful corollary of Section 2 falls out for free: once a group's own
// final active sum is forced to equal its full fleet (requiredGroupActive
// [d]===travFleets[d], the operational case), that group's own standby
// ratio is forced to EXACTLY (fleet-fleet)/fleet=0 for every surviving
// completion -- meaning rules C (worstContractorStandbyRatio) and D
// (contractorsRequiringMitigationCount) are AUTOMATICALLY pinned at their
// own global floor (0) for every completion the Section 2 filter still
// allows, with no separate machinery needed to prove or lock them
// (verified at runtime, never merely asserted, by
// tests/v3-phase6h-source-prefix-propagation.test.mjs's exactness suite).
// The only rule left that can still distinguish two A/B/C/D-tied
// completions is therefore E (fullyUnusedLoadingPointCount) -- so if the
// SAME witnessed incumbent that locked A/B ALSO already has
// fullyUnusedLoadingPointCount===0 (E's own unconditional floor -- a count
// can never be negative), then ANY future completion that leaves an
// originally-assigned source (source.assignedUnits>0) at 0 has E>=1,
// strictly worse than the incumbent's E=0 while A/B/C/D are all tied at
// their proven optimum -- so it can never win either, and excluding
// value===0 for such a source is equally safe. This can never discard a
// real E=0 candidate: leaving THIS source idle unconditionally adds +1 to
// the FINAL fullyUnusedLoadingPointCount regardless of every other source's
// own choice (a plain per-source additive count, the same "no cross-source
// interaction" shape Phase 6E's G/I bounds already relied on), so no other
// choice can ever compensate for it. The filter below is deliberately the
// LOOSE-but-safe version (checks Section 2's general "leftover achievable
// by SOME combination" rather than a tighter "leftover achievable by
// ALL-REMAINING-FORCED-NONZERO" combination) -- a doomed branch (not enough
// remaining budget to keep every remaining assigned source active) is still
// caught, just one node later, by the SAME two checks re-applied at the
// next source; per this task's own "if not provable, STOP" caution, the
// simpler check is kept instead of proving the tighter one.
//
// ---- SAFETY GATING (identical shape to every earlier phase) ----
// Both locks are gated on prefixPropagationMode==='on' (this prototype
// mode flag) and, transitively, on pruningGate.active (rankingPrefixLocked
// can only ever become true from inside the withinTolerance branch, which
// already implies pruningGate.active===true) -- so TARGET_NOT_ACHIEVABLE
// searches (never any within-tolerance candidate at all) are completely
// unaffected, exactly like chemistry/rank-bound/frontier pruning above.
// ============================================================

// V3.0 Phase 6H Section 4 -- pure, exact-integer feasibility helper (this
// task's "no approximation"): can `remainingSourceCount` still-undecided
// sources, each constrained to the SAME feasible set every phase since 6B
// has used (0, or >=MIN_UNITS_PER_ACTIVE_LOADING_POINT, with no OTHER
// per-source cap besides the shared group budget itself), sum to EXACTLY
// `requiredTotal`? Since a single remaining source can always carry the
// ENTIRE requirement alone (0 on every other), the answer never depends on
// HOW MANY sources remain, only on whether at least one remains: a nonzero
// requiredTotal is feasible iff it is itself operational (>=6 -- putting it
// all on one source) and >=1 source remains to carry it; a requiredTotal
// strictly between 1 and 5 is UNCONDITIONALLY infeasible, since every
// nonzero term drawn from the feasible set already exceeds 5, so no
// combination of any number of such terms can ever land in that gap.
export function canSatisfyExactRemainingTotal(remainingSourceCount, requiredTotal) {
  if (requiredTotal === 0) return true;
  if (remainingSourceCount <= 0) return false;
  return requiredTotal >= MIN_UNITS_PER_ACTIVE_LOADING_POINT;
}

// ============================================================
// V3.0 Phase 6C -- PROTOTYPE ONLY: source (variable) and value ordering
// strategies (this task's "test whether deterministic search ordering can
// make the existing exact bounds useful much earlier"). SEARCH ORDER ONLY:
// no branch is ever removed BECAUSE of a strategy choice here -- every
// strategy below only changes WHICH already-valid branch is visited first,
// never whether it is visited. Phase 6B's existing exact bounds
// (conservativeFinalNiBound/conservativeRankingBound/boundCannotBeatIncumbent,
// all imported/untouched) are not modified in any way by this section.
//
// Contractor (group) visitation order is held FIXED at Phase 6B's own
// computeContractorSearchOrder() choice ('smallest-space-first', Phase 6A's
// own selected strategy) for every strategy benchmarked here -- this
// section deliberately isolates the effect of (a) WITHIN-group source
// order and (b) PER-source value order, rather than re-litigating Phase
// 6A's already-settled cross-Contractor group-order question. Reordering a
// group's OWN sources never changes which Contractor they belong to or its
// fleet total, so "keep Contractor fleet constraints exact" (this task's
// own requirement) holds trivially; and buildCandidate() is always called
// with the ORIGINAL canonical `groups` (see
// findBlendRecommendationsSourceLazyOrdered() below), never a reordered
// copy, so allocationSignature/candidate construction stay canonical
// regardless of the strategy chosen (this task's own requirement).
// ============================================================

// VARIABLE ORDERING (this task's Section 2) -- reorders ONE Contractor
// group's own sources; never adds/removes a source. `sources` here are
// already the group's canonical (pileId-sorted) numeric sources.
export function computeSourceOrderForStrategy(sources, targetNiValue, strategy) {
  const withIndex = sources.map((s, i) => ({ s, i }));
  const byCanonical = (a, b) => a.i - b.i;

  switch (strategy) {
    case 'canonical':
      return sources;
    case 'tonnage-influence-first':
      return withIndex
        .sort((a, b) => (b.s.tonnesPerUnit - a.s.tonnesPerUnit) || byCanonical(a, b))
        .map((x) => x.s);
    case 'ni-distance-first':
      return withIndex
        .sort((a, b) => (Math.abs(b.s.ni - targetNiValue) - Math.abs(a.s.ni - targetNiValue)) || byCanonical(a, b))
        .map((x) => x.s);
    case 'chemistry-leverage-first':
      return withIndex
        .sort((a, b) => {
          const leverageA = a.s.tonnesPerUnit * Math.abs(a.s.ni - targetNiValue);
          const leverageB = b.s.tonnesPerUnit * Math.abs(b.s.ni - targetNiValue);
          return (leverageB - leverageA) || byCanonical(a, b);
        })
        .map((x) => x.s);
    case 'most-constrained-first':
      // Smallest ORIGINAL assignedUnits first -- this task's "most
      // constrained source first": a source with little original fleet has
      // the fewest ways to become a large active allocation, so deciding it
      // early narrows the group's own achievable-tonnage range soonest.
      return withIndex
        .sort((a, b) => (a.s.assignedUnits - b.s.assignedUnits) || byCanonical(a, b))
        .map((x) => x.s);
    case 'hybrid':
      // Deterministic hybrid (this task's own naming): largest |Ni-target|
      // first (primary -- which source's chemistry pull matters most),
      // largest tonnesPerUnit next (secondary -- how much weight it can
      // carry), canonical Pile ID as the final tie-break.
      return withIndex
        .sort((a, b) => {
          const da = Math.abs(a.s.ni - targetNiValue);
          const db = Math.abs(b.s.ni - targetNiValue);
          return (db - da) || (b.s.tonnesPerUnit - a.s.tonnesPerUnit) || byCanonical(a, b);
        })
        .map((x) => x.s);
    default:
      throw new Error(`unknown V3.0 Phase 6C source order strategy: ${strategy}`);
  }
}

// VALUE ORDERING (this task's Section 1) -- always the exact SAME feasible
// set {0} U [6, remainingFleet] (this task's "do NOT change feasible
// values"), only reordered. 'chem-directed' is the only strategy needing
// RUNTIME state (fixedNumerator/fixedTonnage -- every already-decided
// source's contribution so far, in the CURRENT traversal order) since it
// ranks by how close the RESULTING partial running-average Ni would land to
// target if this particular value were chosen; computed fresh at each node
// (never cached), since it depends on the exact path taken so far.
export function computeValueOrder(remainingFleet, source, fixedNumerator, fixedTonnage, targetNiValue, strategy) {
  const values = [0];
  for (let v = MIN_UNITS_PER_ACTIVE_LOADING_POINT; v <= remainingFleet; v += 1) values.push(v);

  switch (strategy) {
    case 'descending':
      return values.slice().sort((a, b) => b - a);
    case 'ascending':
      return values.slice().sort((a, b) => a - b);
    case 'chem-directed': {
      const withDistance = values.map((v) => {
        const tonnage = v * source.tonnesPerUnit;
        const totalTonnage = fixedTonnage + tonnage;
        const distance = totalTonnage > 0
          ? Math.abs((fixedNumerator + source.ni * tonnage) / totalTonnage - targetNiValue)
          : Infinity;
        return { v, distance };
      });
      // Ascending distance (closest-to-target first); deterministic
      // descending-value tie-break (matches 'descending''s own utilization
      // preference whenever two values happen to land equidistant).
      return withDistance.sort((a, b) => (a.distance - b.distance) || (b.v - a.v)).map((x) => x.v);
    }
    default:
      throw new Error(`unknown V3.0 Phase 6C value order strategy: ${strategy}`);
  }
}

// ============================================================
// V3.0 Phase 6D -- PROTOTYPE ONLY: coupled (per-Contractor, never pooled)
// chemistry bound (this task's "materially tighter EXACT/CONSERVATIVE
// chemistry bound that preserves each remaining Contractor group's own
// remaining fleet capacity, tonnesPerUnit, remaining-source Ni min/max").
//
// Phase 4B/6B/6C's conservativeFinalNiBound() (imported, still used
// unchanged in 'pooled' mode below) POOLS every still-open group into ONE
// aggregate (minNi, maxNi, maxOpenTonnage) triple -- an over-relaxation
// that lets a low-Ni extreme from one Contractor "borrow" tonnage capacity
// that actually belongs to a completely different, unrelated Contractor.
// This section computes the TRUE (not merely conservative -- see PROOF
// below) extremum over the ACTUAL per-group-separated feasible region.
//
// ---- PROOF ----
// Each still-open group i offers, independently of every other group, a
// choice of (T_i, w_i) -- T_i = tonnage it contributes, w_i = Ni-weighted
// numerator it contributes -- from the set
//   { (0,0) } U { (T,w) : T in [Tlo_i,Thi_i], w in [T*minNi_i, T*maxNi_i] }
// (Tlo_i = 6*maxTonnesPerUnit_i, Thi_i = remainingFleet_i*maxTonnesPerUnit_i
// -- groupMaxAchievableTonnage()'s own ceiling, imported/unchanged, reused
// here as EACH group's own separate Thi_i rather than summed into one
// pooled ceiling).
//
// finalNi = (fixedNumerator + Sum w_i) / (fixedTonnage + Sum T_i) depends
// ONLY on the two AGGREGATE scalars W=Sum w_i, S=Sum T_i -- a Mobius
// (linear-fractional) function of (W,S), a textbook-known type of function
// that attains its max/min over ANY polytope domain at one of the
// polytope's VERTICES (its level sets are hyperplanes, so it is
// simultaneously quasiconvex and quasiconcave on a convex domain --
// Bauer's maximum principle then puts BOTH extrema at extreme points).
// Domain: the feasible (S,W) region is the union, over which SUBSET of
// groups is "active" (T_i>0) vs "at zero", of a MINKOWSKI SUM of per-group
// convex pieces -- each subset choice gives a genuine polytope (product/sum
// of convex sets is convex), so the theorem applies within each subset
// choice; a standard fact about products/sums of polytopes is that their
// own extreme points are built from EACH FACTOR's own extreme points
// independently. Combining both facts: the GLOBAL extremum over the WHOLE
// union is attained by choosing, for EACH group INDEPENDENTLY, one of at
// most two "shapes" -- excluded (0,0), or active at one of its own trapezoid
// corners (Tlo or Thi, times minNi_i or maxNi_i).
//
// A direct 1-D argument (fixing every OTHER group, varying only group i)
// narrows this further: for FIXED T, finalNi is monotonic (linear) in w
// (since the shared denominator is unaffected by w), so the best w for a
// GIVEN T is always at T*minNi_i (favors the min search) or T*maxNi_i
// (favors the max search) -- never an interior value. Then, for that FIXED
// Ni value "a" (=minNi_i or maxNi_i), finalNi(T)=(F0+aT)/(D0+T) is a Mobius
// function of T ALONE whose derivative sign is sign(a*D0-F0) -- CONSTANT
// across the whole T range, so it is monotonic in T, meaning its own best
// value over T in [Tlo_i,Thi_i] is always at Thi_i (never Tlo_i) whenever
// including this group at all is favorable (a below/above the CURRENT
// running average, for min/max respectively) -- and whenever it is NOT
// favorable, T=0 (excluding the group) strictly beats every T>0 at that
// same "a" (since any nonzero T at an unfavorable a only pushes the average
// further in the wrong direction). Tlo_i therefore NEVER wins for a pure
// extremum -- collapsing each group's real choice to a clean BINARY
// (include fully at Thi_i/extremeNi_i, or exclude entirely at (0,0)).
//
// This binary, per-group choice has the textbook "weighted-average
// threshold" structure (adding a whole slice at value `a` always pulls the
// running average toward `a`; whether that helps depends only on which
// side of the CURRENT running average `a` sits on). The standard
// EXCHANGE-ARGUMENT solution: sort groups by their own extreme Ni value
// (ascending for the min search, descending for the max search) and
// greedily include each one, IN THAT ORDER, exactly as long as its own
// extreme value is still favorable relative to the RUNNING average built
// from every group already included (never the original fixed-only
// average) -- stopping at the first unfavorable group is safe because sort
// order guarantees every later group's own extreme is at least as
// unfavorable too (the running average never moves in the wrong direction
// as favorable groups are added). extremeFinalNi() below implements exactly
// this O(k log k) greedy pass (k = number of still-open groups, <= ~7 for
// every scenario in this task's scope) -- proven EXACT (the walked-to
// result is itself a REALIZABLE integer allocation: put a group's entire
// remaining fleet on the single specific source that actually achieves its
// own minNi/maxNi, and 0 on the rest), not merely conservative, and
// re-verified exhaustively (against brute-force real-allocation
// enumeration, never a re-derivation of this same formula) by
// tests/v3-phase6d-coupled-chemistry-bound.test.mjs's mandatory
// conservativeness proof.
//
// FLOAT_EPSILON_COUPLED biases the "favorable" comparison toward INCLUDING
// a candidate on a near-tie (mirrors production's own FLOAT_EPSILON
// pattern for tolerance-boundary comparisons) -- stopping one candidate
// TOO EARLY due to floating-point noise would make the reported bound
// LESS extreme (closer to fixedNi) than the true continuous-relaxation
// optimum, which is the UNSAFE direction (a lower-bound that is too HIGH,
// or an upper-bound that is too LOW, can wrongly exclude an achievable
// actualNi). Biasing toward inclusion on a near-tie only ever makes the
// reported bound MORE extreme (safe), never less.
// ============================================================
const FLOAT_EPSILON_COUPLED = 1e-9;

// `envelopes`: array of { minNi, maxNi, thiTonnage } -- one entry per
// still-open Contractor group, EACH KEPT SEPARATE (this task's own "do not
// let a low/high Ni extreme from one Contractor implicitly consume another
// Contractor's fleet capacity" requirement -- never pooled/merged before
// this function runs). `mode`: 'min' or 'max'.
function extremeFinalNi(fixedNumerator, fixedTonnage, envelopes, mode) {
  const candidates = envelopes
    .filter((e) => e.thiTonnage > 0)
    .map((e) => ({ value: mode === 'min' ? e.minNi : e.maxNi, thiTonnage: e.thiTonnage }))
    .sort((a, b) => (mode === 'min' ? a.value - b.value : b.value - a.value));

  let numerator = fixedNumerator;
  let tonnage = fixedTonnage;
  for (const candidate of candidates) {
    if (tonnage > 0) {
      const currentAvg = numerator / tonnage;
      const favorable = mode === 'min'
        ? candidate.value < currentAvg + FLOAT_EPSILON_COUPLED
        : candidate.value > currentAvg - FLOAT_EPSILON_COUPLED;
      if (!favorable) break; // sorted order: no later candidate can help either
    }
    numerator += candidate.value * candidate.thiTonnage;
    tonnage += candidate.thiTonnage;
  }

  if (tonnage > 0) return numerator / tonnage;
  // No fixed contribution AND no open group can ever go active (every
  // remaining fleet < 6 everywhere) -- this branch can never produce a real
  // (nonzero) candidate at all, matching production's own
  // conservativeFinalNiBound() "maxOpenTonnage<=0 with fixedTonnage<=0"
  // edge (mirrored via boundIntersectsTolerance() correctly reporting no
  // intersection for an empty [Infinity,-Infinity] interval -- safe, since
  // a branch that can never build any candidate loses nothing by being
  // pruned here).
  return mode === 'min' ? Infinity : -Infinity;
}

// Exported so the mandatory conservativeness-proof test (this task's
// Section 3) exercises the EXACT SAME function production/benchmark code
// calls, never a re-implemented copy.
export function conservativeFinalNiBoundCoupled(fixedNumerator, fixedTonnage, envelopes) {
  return {
    minNi: extremeFinalNi(fixedNumerator, fixedTonnage, envelopes, 'min'),
    maxNi: extremeFinalNi(fixedNumerator, fixedTonnage, envelopes, 'max'),
  };
}

// ============================================================
// V3.0 Phase 6E -- PROTOTYPE ONLY: investigation of ranking bounds for the
// rules AFTER E in recommendation-ranking.js's compareWithinTolerance chain
// (this task's "PRIORITY BOUNDS TO INVESTIGATE"). Phase 6D proved tighter
// chemistry intervals alone do not reduce C/D search; this phase asks
// whether bounding LATER ranking rules (never chemistry, never a NEW
// business rule) can prune branches that currently tie through A-E.
//
// The chain past E (recommendation-ranking.js, UNCHANGED) is:
//   F. compareSimplicity             -- Hopper Pattern (simplifyUnitRatio)
//   G. totalMovedUnits   (ascending) -- same-Contractor relocation
//   H. absoluteDeviation (ascending) -- Ni deviation from target
//   I. activeSourceCount (ascending) -- source-switching complexity
//
// ---- G: PROVEN SAFE, EXACT, TIGHT ----
// fleet-allocation.js's planContractorRelocations() always fully satisfies
// every receiver within a Contractor group (that function's own comment:
// "total donor capacity is always >= total receiver need... every
// receiver's need is always fully satisfied"; guaranteed by the group-
// level feasibility invariant Sum(activeUnits) <= Sum(assignedUnits)).
// That means Sum(moved) == Sum(receiver need) for a fully-decided group --
// i.e. candidate.totalMovedUnits == Sum over EVERY source (any group) of
// max(0, activeUnits - assignedUnits). This is a plain per-source additive
// accumulator with NO cross-source interaction to reason about at all
// (unlike A/B/C/D/E, this needs no per-group independent-optimization
// argument -- see this task's Section 3 "movement already incurred by a
// partial state cannot be undone"). Each term is >=0 and, once a source is
// DECIDED, is fixed forever -- so the running total over every already-
// decided source (both fully-decided groups and the current in-progress
// group's own already-decided sources) can only grow as more sources are
// decided, never shrink. minPossibleFinalRelocation() is therefore an
// EXACT, TIGHT lower bound: achieved by setting every still-undecided
// source's activeUnits to 0, which is ALWAYS in that source's own feasible
// {0} U [6,F] set regardless of the shared group budget or any sibling
// source's own choice.
export function minPossibleFinalRelocation(alreadyIncurredRelocation) {
  return alreadyIncurredRelocation;
}

// ---- I: PROVEN SAFE, EXACT, TIGHT ----
// candidate.activeSourceCount counts sources with activeUnits>0 -- again a
// plain per-source additive accumulator (this task's Section 3 "a source
// already assigned >0 cannot become inactive later"). Once a source is
// decided ACTIVE (activeUnits>0), the running count can only grow as later
// sources are decided, by the identical "never revisited" argument as G.
// Exact and tight for the same reason: setting every remaining source to 0
// achieves this bound precisely (0 never counts toward activeSourceCount).
export function minPossibleFinalActiveSourceCount(alreadyDecidedActiveSourceCount) {
  return alreadyDecidedActiveSourceCount;
}

// ---- H: PROVEN SAFE (NOT claimed tight) ----
// Reuses whichever chemistry bound [minNi,maxNi] the node already computed
// (pooled or coupled, imported/unchanged -- this task's own formula, no NEW
// chemistry bound). Safe because: (a) when targetNi falls INSIDE
// [minNi,maxNi], claiming 0 is always a valid (if loose) lower bound on a
// non-negative quantity, regardless of whether any real integer allocation
// hits exactly 0; (b) when targetNi falls OUTSIDE [minNi,maxNi], every real
// achievable Ni for this branch is provably inside [minNi,maxNi] (the
// chemistry bound's own soundness, unchanged), so the TRUE minimum
// |Ni-target| over the branch's actual (finite, discrete) achievable set
// can never be LESS than the distance from target to the nearest edge of
// that enclosing interval -- min(|minNi-target|,|maxNi-target|) is exactly
// that nearest-edge distance for a contiguous interval, hence a valid
// (if not necessarily achieved) lower bound. Not claimed tight, only safe
// -- which is all a "cannot beat incumbent" prune check ever requires.
export function minPossibleAbsoluteDeviation(chemBound, targetNiValue) {
  const { minNi, maxNi } = chemBound;
  if (targetNiValue >= minNi && targetNiValue <= maxNi) return 0;
  return Math.min(Math.abs(minNi - targetNiValue), Math.abs(maxNi - targetNiValue));
}

// ---- F: PROVEN **NOT SAFELY BOUNDABLE** WITHOUT ENUMERATION ----
// compareSimplicity's key is simplicityKey(simplifyUnitRatio(higherUnits,
// lgloUnits)) -- a GCD-REDUCED ratio of two GLOBAL totals (summed across
// EVERY Contractor group, not per-group). A single-unit change to either
// total can move the reduced key in either direction by an arbitrary,
// discontinuous amount (e.g. 12:4 reduces to 3:1 [sum 4] while 11:4 does
// not reduce at all [sum 15] -- one unit apart, more than 3x apart in
// simplicity). No monotone envelope on the RAW totals bounds the REDUCED
// key: the true best-achievable key over an open branch depends on which
// specific (H,L) lattice point in the achievable region happens to share a
// large common factor, which is a number-theoretic property of the exact
// achievable SET, not of its min/max corners. Concretely (verified
// exhaustively by tests/v3-phase6e-simplicity-counterexample.test.mjs):
// fixedHigher=4, fixedLglo=4 (both already locked in from earlier decided
// groups -- a valid 1:1 ratio), one still-open group with one Higher-class
// and one LGLO-class source sharing remainingFleet=10 (MIN_UNITS_PER_
// ACTIVE_LOADING_POINT=6, so at most ONE of the two sources can go active
// at all). Every achievable (finalHigher,finalLglo) pair's simplicityKey
// was enumerated by hand/by test: the GLOBAL BEST key ([2,1,1,1], ratio
// 1:1) is achieved ONLY by leaving the open group's budget entirely UNUSED
// (deltaHigher=deltaLglo=0) -- preserving the already-fixed 1:1 ratio --
// while EVERY SINGLE alternative use of the open budget (routing the 10
// units to either source) produces a strictly WORSE (more complex) key,
// including the two "extreme/corner" choices (deltaHigher=10 -> 14:4 -> key
// [9,7,7,2]; deltaLglo=10 -> 4:14 -> key [9,7,2,7]). A closed-form bound
// that only inspects the achievable RANGE's corners (the same "independent
// per-group optimum" shape A-E's bound uses) would therefore either (a)
// need to already special-case "leave everything at zero" as a candidate
// -- which stops generalizing the moment a THIRD open group or a larger
// shared budget lets some OTHER interior lattice point retie or beat 1:1,
// a case with no closed form short of checking every reachable pair -- or
// (b) risk claiming a better (smaller) key than any real completion can
// achieve, which would be an UNSAFE overestimate (silently pruning away
// the actual best candidate). Per this task's own instruction ("if not
// provable, STOP comparison at that ranking rule"), F is therefore left
// UNBOUNDED here, exactly as it already is in production's own
// boundCannotBeatIncumbent() (A-E only).
//
// ---- WHY THIS MEANS G/H/I CANNOT BE USED FOR PRUNING ----
// compareWithinTolerance's rule order is 0,A,B,C,D,E,F,G,H,I,J
// (recommendation-ranking.js, UNCHANGED). This task's own mandatory safety
// rule -- "never skip an earlier unbounded ranking rule to use a later
// one... if an earlier criterion is unbounded: do not reason past it" --
// means: since F sits strictly between E (already bounded in production)
// and G/H/I (individually proven safe above), and F itself cannot be
// soundly bounded without full enumeration (exactly what this whole V3.0
// lazy-search line of work exists to avoid), the lexicographic walk must
// STOP, unresolved, at F -- EXACTLY where boundCannotBeatIncumbent() (A-E
// only, blending-recommendation.js, imported/unchanged) already stops
// today. boundCannotBeatIncumbentExtended() below is therefore -- as a
// necessary consequence of the proof above, not by omission -- behaviorally
// IDENTICAL to boundCannotBeatIncumbent(). It is exported and wired into
// findBlendRecommendationsSourceLazyExtendedRanking() below (via
// rankBoundMode: 'extended' in forEachCandidateSourceLazy() above) only so
// this claim is verified AT RUNTIME -- diagnostics.prunedByRankingExtended
// must read exactly 0 across every benchmark scenario (this task's Section
// 7) -- never merely asserted in a comment. minPossibleFinalRelocation()/
// minPossibleFinalActiveSourceCount()/minPossibleAbsoluteDeviation() above
// are kept as separate named exports (rather than deleted) so a FUTURE
// phase that finds a real, closed-form Hopper-simplicity bound has the
// three already-proven bounds ready to wire in alongside it.
export function boundCannotBeatIncumbentExtended(rankBound, incumbent) {
  return boundCannotBeatIncumbent(rankBound, incumbent);
}
// ============================================================

// ============================================================
// V3.0 Phase 6F -- PROTOTYPE ONLY: exact partial-state DOMINANCE FRONTIER
// (docs/V3.0_SCALABLE_RECOMMENDATION_ENGINE_ARCHITECTURE.md Section 20/23;
// this task's "instead, test an EXACT state-dominance frontier"). Phase 6E
// proved branch-LOCAL ranking bounds cannot progress past rule F. This is a
// DIFFERENT mechanism: comparing two SIBLING branches directly against each
// other (never against chemistry, never past rule E) whenever they reach
// the exact same future search problem.
//
// ---- 1. FRONTIER LOCATION ----
// Applied ONLY at Contractor boundaries -- i.e. only when combine() below
// is called with `groupState === null` (about to start a fresh Contractor
// group; see that parameter's own comment for why this is exactly the set
// of "boundary" calls) and `flatIdx < total` (excludes the terminal/
// completed-candidate call, which is a different thing entirely).
//
// ---- 2. FUTURE-EQUIVALENT KEY ----
// Two boundary states share a frontier bucket ONLY when ALL of:
//   - same `flatIdx` (equivalently `groupIndexOf[flatIdx]`, the depth-
//     position of the NEXT undecided Contractor group) -- this alone
//     already guarantees the identical undecided SUFFIX (remainingSourcesFrom/
//     travFleets/suffixChemAfterGroup/suffixRankAfterGroup/groupEnvelopes are
//     ALL static, path-independent arrays computed once by
//     buildTraversalPlan() -- see that function's own header comment -- so
//     "same flatIdx" trivially also means "same remaining fleet state
//     relevant to the future": there is no OTHER path-dependent quantity
//     that could differ at the same flatIdx).
//   - EXACT (===, no epsilon) `fixedNumerator`
//   - EXACT (===, no epsilon) `fixedTonnage`
// Per this task's own instruction, this is intentionally STRICT: floating
// noise that prevents two truly-equivalent states from matching only costs
// a MISSED optimization (safe), never a false/unsafe merge. Because
// fixedNumerator/fixedTonnage are bit-identical, every common future
// completion produces a BIT-IDENTICAL final numerator/tonnage/estimatedNi
// for both states -- this is what makes the dominance rule below sound
// without needing to reason about chemistry at all.
//
// ---- 3. DOMINANCE RULE (A-E ONLY) ----
// `completedFixed` at a boundary is exactly recommendation-ranking.js's own
// A-E prefix accumulator shape (criticalCount, activeUnits, worstRatio,
// mitigationCount, fullyUnusedCount) -- the SAME object conservativeRankingBound()
// above already threads through combine(). For a COMMON future completion X
// (same source-level decisions applied to the still-open suffix, which is
// IDENTICAL for both states per the key above), each rule's FINAL value is:
//   A criticalCount   = prefix + futureCriticalCount(X)      (pure sum)
//   B activeUnits      = prefix + futureActiveUnits(X)        (pure sum)
//   D mitigationCount  = prefix + futureMitigationCount(X)    (pure sum)
//   E fullyUnusedCount = prefix + futureFullyUnusedCount(X)   (pure sum)
//   C worstRatio       = max(prefix, futureWorst(X))          (NOT a sum)
// A/B/D/E: since futureX(...) is the IDENTICAL term added to both states'
// own prefix for ANY given X, a STRICT prefix difference at the FIRST rule
// where two states differ is preserved as a STRICT final difference for
// EVERY X (adding an equal constant to two unequal numbers can never make
// them equal) -- so if that first-differing rule is A, B, D, or E, the
// state with the better prefix value dominates UNCONDITIONALLY, full stop.
//
// C is different: max(a,x) is monotonic non-decreasing in `a` for ANY fixed
// x, so a strict prefix advantage (prefixWorstA < prefixWorstB) guarantees
// finalWorstA(X) <= finalWorstB(X) for EVERY X (never reverses -- A's
// advantage can never become a disadvantage) but CAN collapse to an EXACT
// tie whenever futureWorst(X) >= prefixWorstB (this task's own warning:
// "a strict prefix advantage may later collapse to a tie... do not assume a
// strict C advantage always remains strict"). When that collapse happens
// for some real X, the OVERALL compareWithinTolerance(A+X, B+X) result for
// THAT X falls through to D, then E (both pure sums, so THEIR prefix
// relationship alone -- independent of X -- decides, if either differs).
// Only if BOTH D and E are themselves prefix-tied does a collapsing X leave
// A-E fully tied, at which point the real outcome depends on F onward --
// UNKNOWN (Phase 6E's own finding: F cannot be bounded). Since this
// prototype prunes the ENTIRE losing branch (never revisits it), letting
// such an X exist and get pruned anyway would be a genuinely UNSAFE
// pruning (that branch's own candidate could be the true best whenever F
// decides in its favor). comparePrefixChain()/dominatesPrefix() below
// therefore ONLY certify a C-based dominance when the D/E "collapse
// fallback" is proven to ALSO resolve (or continue tying) in the SAME
// favored direction all the way through -- if the fallback ties out
// completely (D and E both prefix-tied) or disagrees with C's own favored
// direction, the verdict is 'unknown' (this task's "if not provable, do
// not dominate" -- exhaustively verified by
// tests/v3-phase6f-dominance-proof.test.mjs's directed C-collapse cases).
//
// A/B/D/E-only differences never need this extra guard (proven above: no
// collapse risk exists for a pure sum), so they are certified immediately
// once the first difference is found, without inspecting later rules.
//
// ---- 4. HOPPER F SAFETY ----
// F (Hopper simplicity) is NEVER bounded or consulted here, by construction
// -- comparePrefixChain() only ever inspects A/B/C/D/E fields. Dominance is
// safe PRECISELY BECAUSE, in every case it certifies, some A-E rule is
// GUARANTEED to already strictly decide the real compareWithinTolerance
// comparison for every common X (see the proof above) -- meaning F is
// never actually reached for that comparison, so its own unboundedness
// (Phase 6E) is irrelevant here, not merely ignored.
//
// ---- TARGET_NOT_ACHIEVABLE SAFETY ----
// Gated on `pruningGate.active` (identical guard to the existing chemistry/
// A-E ranking-bound checks above) for the SAME reason: `pruningGate.active`
// is true only once a within-tolerance incumbent already exists, at which
// point the search's eventual status can never be TARGET_NOT_ACHIEVABLE
// (buildResultFromSearch() only ever falls back to bestAttainable when
// bestWithinTolerance is null) -- so discarding a dominated branch's own
// contribution to bestAttainable tracking cannot change the final result.
// Before that point (still hunting for the first incumbent, or genuinely
// TARGET_NOT_ACHIEVABLE), the frontier is not consulted at all, exactly
// like chemistry/rank-bound pruning above.
const FLOAT_EPSILON_DOMINANCE = 1e-9;

// Pure-sum tail (D then E) -- used both as the ordinary A/B-tied tie-break
// and as the "collapse fallback" consulted when C differs. Returns 'A' if
// `x` is provably no-worse-and-somewhere-strictly-better than `y` for every
// common future completion, 'B' for the symmetric case, or 'tie' if D and E
// are BOTH exactly equal (no information -- F onward unknown).
function compareAdditiveTail(x, y) {
  if (x.mitigationCount !== y.mitigationCount) return x.mitigationCount < y.mitigationCount ? 'A' : 'B';
  if (x.fullyUnusedCount !== y.fullyUnusedCount) return x.fullyUnusedCount < y.fullyUnusedCount ? 'A' : 'B';
  return 'tie';
}

// Exported so the mandatory exhaustive proof test exercises the EXACT SAME
// function the live frontier uses. Returns 'A' if `x` provably dominates
// `y` (x always ranks at least as well as y, strictly better for at least
// one real completion, under compareWithinTolerance's own A-E rule order,
// for EVERY common future completion), 'B' for the symmetric case, or
// 'unknown' if neither can be certified (keep both -- see file header
// PROOF above for exactly which cases fall into 'unknown').
export function comparePrefixChain(x, y) {
  if (x.criticalCount !== y.criticalCount) return x.criticalCount < y.criticalCount ? 'A' : 'B'; // A, pure sum
  if (x.activeUnits !== y.activeUnits) return x.activeUnits > y.activeUnits ? 'A' : 'B'; // B, pure sum (higher better)

  const worstEqual = Math.abs(x.worstRatio - y.worstRatio) <= FLOAT_EPSILON_DOMINANCE;
  if (!worstEqual) {
    // C differs at the prefix level -- only conditionally safe (see file
    // header PROOF): must also confirm the D/E "collapse fallback" agrees.
    const favored = x.worstRatio < y.worstRatio ? 'A' : 'B';
    const fallback = compareAdditiveTail(x, y);
    return fallback === favored ? favored : 'unknown';
  }
  // C ties for every X (equal inputs to max() stay equal regardless of X) --
  // ordinary pure-sum tie-break, no collapse risk of its own.
  return compareAdditiveTail(x, y);
}

// `x` dominates `y` -- pruning `y`'s ENTIRE subtree is safe.
export function dominatesPrefix(x, y) {
  return comparePrefixChain(x, y) === 'A';
}
// ============================================================

// Explicit source-level Branch-and-Bound traversal -- this task's SOURCE-
// LEVEL MODEL/LAZY REQUIREMENT. `pruningGate`/`visit` have the identical
// contract to blending-recommendation.js's forEachCandidatePruned(); only
// the unit of recursion (one DOME, not one Contractor's full tuple) and how
// each node's bound is computed (closed-form partial-group state, not a
// precomputed-once-per-Contractor suffix) differ.
//
// `valueStrategy` (V3.0 Phase 6C, default 'descending') -- SEARCH ORDER
// ONLY (this task's own instruction): selects which of the SAME feasible
// {0} U [6, remainingFleet] values is tried FIRST for each source, via
// computeValueOrder() below. Defaulting to 'descending' reproduces Phase
// 6B's own original hardcoded loop EXACTLY (descending remainingFleet down
// to 6, then 0 last) -- see computeValueOrder('descending')'s own
// definition -- so findBlendRecommendationsSourceLazy() (Phase 6B, unchanged
// call site below) is behaviorally IDENTICAL to before this edit, verified
// by tests/v3-phase6b-source-lazy.test.mjs still passing unmodified.
//
// `chemistryBoundMode` (V3.0 Phase 6D, default 'pooled') -- 'pooled'
// reproduces the EXACT Phase 4B/6B/6C chemistry bound (imported
// conservativeFinalNiBound(), never modified); 'coupled' switches to the
// new per-group-separated bound (conservativeFinalNiBoundCoupled() above).
// This is the ONLY thing 'coupled' mode changes -- ranking-prefix pruning,
// the node budget, candidate construction, and every other rule stay
// byte-identical between modes (this task's own "do NOT add other pruning
// rules" instruction).
//
// `frontierMode` (V3.0 Phase 6F, default 'off') -- see the PHASE 6F
// ANALYSIS section immediately above this function for the full safety
// proof. 'on' additionally checks/updates a Contractor-boundary dominance
// frontier at every node where `groupState === null` (i.e. about to start
// a fresh Contractor group) while `pruningGate.active` is true. This is
// the ONLY thing 'on' adds -- chemistry pruning, A-E ranking-bound pruning,
// candidate construction, and every other rule stay byte-identical.
//
// `nodeBudget` (V3.0 Phase 6G, default MAX_SEARCH_NODES -- the SAME imported
// production constant every earlier phase used as a hardcoded literal here)
// -- TEST-ONLY override so the benchmark suite can measure how many source-
// level nodes C/D actually need to COMPLETE, without touching production's
// own MAX_SEARCH_NODES (this task's "measurement only, do not change
// production budget"). Every call site that omits this argument is
// byte-identical to every earlier phase's behavior.
// V3.0 Phase 6I -- `stopAtLock` (default false, additive/non-breaking -- every
// existing call site below that omits it is byte-identical to before this
// change) lets the CALLER cut the unrestricted traversal short the instant
// the Phase 6H A+B prefix lock fires, instead of continuing to walk the
// (now merely domain-filtered, not eliminated) unrestricted tree. See PHASE
// 6I ANALYSIS below findBlendRecommendationsSourceLazyPrefixPropagatedBudgeted()
// for why this is safe: once locked, every surviving branch of THIS SAME
// tree already belongs to the full-utilization subspace (Section 2's own
// filter), so stopping here and re-deriving that identical subspace via a
// dedicated GROUP-granularity generator (forEachFullUtilizationCandidate()
// below) cannot skip any candidate the unrestricted continuation could have
// found -- it is a different traversal STRATEGY over the exact same
// remaining search space, not a narrower one.
function forEachCandidateSourceLazy(canonicalGroups, plan, targetNiValue, toleranceValue, pruningGate, visit, valueStrategy = 'descending', chemistryBoundMode = 'pooled', rankBoundMode = 'ae', frontierMode = 'off', prefixPropagationMode = 'off', nodeBudget = MAX_SEARCH_NODES, stopAtLock = false) {
  const { flatSources, remainingSourcesFrom, groupIndexOf, travFleets, suffixChemAfterGroup, suffixRankAfterGroup, groupEnvelopes, requiredGroupActive } = plan;
  const total = flatSources.length;
  const diagnostics = {
    visitedNodes: 0, prunedByChemistry: 0, prunedByRanking: 0, completedCandidates: 0, incomplete: false,
    // V3.0 Phase 6E diagnostic addition ONLY (this task's "report
    // separately: prunedByRankingAE, prunedByRankingExtended") -- populated
    // only when rankBoundMode === 'extended' (see PHASE 6E section above
    // findBlendRecommendationsSourceLazyExtendedRanking()); 0/0 in every
    // other mode, exactly like `prunedByRanking` itself would be for a node
    // that never reaches the ranking-bound check.
    prunedByRankingAE: 0,
    prunedByRankingExtended: 0,
    // V3.0 Phase 6F diagnostic additions ONLY (this task's "track:
    // prunedByDominance, frontierEntries, peakFrontierEntries,
    // frontierHits") -- populated only when frontierMode === 'on' (see
    // PHASE 6F ANALYSIS above and findBlendRecommendationsSourceLazyFrontier()
    // below); 0 in every other mode.
    prunedByDominance: 0,
    frontierEntries: 0,
    peakFrontierEntries: 0,
    frontierHits: 0,
    // V3.0 Phase 6C diagnostic addition ONLY (this task's "first-incumbent
    // timing/node if easy to expose") -- purely observational, never
    // consulted by any pruning/branching decision, so it cannot affect
    // Phase 6B's own exactness proof.
    firstIncumbentNode: null,
    // V3.0 Phase 6H diagnostic additions ONLY (this task's "report
    // eliminated-domain count" / "nodeAtPrefixLock" / "what was proven") --
    // populated only when prefixPropagationMode === 'on'; 0/null in every
    // other mode. eliminatedByPrefixPropagation counts source VALUE CHOICES
    // (never full nodes -- these are never visited/counted at all) removed
    // by Section 2; eliminatedByEPropagation counts choices additionally
    // removed by Section 3, once active.
    eliminatedByPrefixPropagation: 0,
    eliminatedByEPropagation: 0,
    nodeAtPrefixLock: null,
    prefixLockProof: null,
    nodeAtELock: null,
    eLockProof: null,
    // V3.0 Phase 6I -- true once `stopAtLock` requested an early cutoff AND
    // the visit() callback below actually witnessed the A+B lock firing.
    // Deliberately a SEPARATE flag from `incomplete` (SEARCH_INCOMPLETE):
    // this is a DELIBERATE, PROVEN-SAFE handoff to the decomposition solver,
    // never a budget failure -- buildResultFromSearch() must never see this
    // as an error state (the Phase 6I orchestrator below never passes this
    // diagnostics object to that function).
    stoppedAtLock: false,
    // Purely informational (this task's own diagnostic reporting
    // requirement) -- the STATIC, closed-form target Section 1's lock
    // condition checks totalActiveUnits against; exposed so tests can
    // assert the derivation directly rather than re-deriving it by hand.
    globalMaxActiveUnits: plan.globalMaxActiveUnits,
  };

  // V3.0 Phase 6F -- the dominance frontier itself: Map<string, Array<
  // completedFixed>>, keyed by "${flatIdx}|${fixedNumerator}|${fixedTonnage}"
  // (see PHASE 6F ANALYSIS's "FUTURE-EQUIVALENT KEY" section for why this
  // exact triple, with STRICT equality, is sufficient and safe). One Map for
  // the WHOLE search (never reset mid-traversal) -- a boundary reached from
  // ANY earlier sibling branch remains comparable against one reached much
  // later via a completely different prefix, which is the entire point.
  const frontier = frontierMode === 'on' ? new Map() : null;

  // groupState: null (about to start a fresh group) or
  // { depthIndex, alreadyActive, remainingFleet, fullyUnusedSoFar } for the
  // CURRENTLY in-progress group. completedFixed: exact accumulators folded
  // in ONLY once a group is fully decided (never for the in-progress one) --
  // identical role to forEachCandidatePruned()'s fixedActiveUnits/
  // fixedCriticalCount/fixedWorstRatio/fixedMitigationCount/
  // fixedFullyUnusedCount.
  function combine(flatIdx, activeBySourceKey, fixedNumerator, fixedTonnage, completedFixed, groupState) {
    if (diagnostics.incomplete || diagnostics.stoppedAtLock) return;
    if (diagnostics.visitedNodes >= nodeBudget) {
      diagnostics.incomplete = true;
      return;
    }
    diagnostics.visitedNodes += 1;

    if (flatIdx === total) {
      const candidate = buildCandidate(canonicalGroups, activeBySourceKey, targetNiValue, toleranceValue);
      if (candidate) {
        diagnostics.completedCandidates += 1;
        visit(candidate, diagnostics);
      }
      return;
    }

    // V3.0 Phase 6F -- Contractor-boundary dominance frontier (see PHASE 6F
    // ANALYSIS above). `groupState === null` here means flatIdx is exactly
    // the first source of a not-yet-started Contractor group (see that
    // parameter's own comment) -- the ONLY point this phase applies
    // dominance. Gated on pruningGate.active for the identical
    // TARGET_NOT_ACHIEVABLE-safety reason chemistry/rank-bound pruning
    // above is gated on.
    if (frontier !== null && groupState === null && pruningGate.active) {
      const key = `${flatIdx}|${fixedNumerator}|${fixedTonnage}`;
      let bucket = frontier.get(key);
      if (bucket === undefined) {
        bucket = [];
        frontier.set(key, bucket);
      } else {
        diagnostics.frontierHits += 1;
        for (let i = 0; i < bucket.length; i += 1) {
          if (dominatesPrefix(bucket[i], completedFixed)) {
            diagnostics.prunedByDominance += 1;
            return;
          }
        }
        for (let i = bucket.length - 1; i >= 0; i -= 1) {
          if (dominatesPrefix(completedFixed, bucket[i])) {
            bucket.splice(i, 1);
            diagnostics.frontierEntries -= 1;
          }
        }
      }
      bucket.push(completedFixed);
      diagnostics.frontierEntries += 1;
      if (diagnostics.frontierEntries > diagnostics.peakFrontierEntries) diagnostics.peakFrontierEntries = diagnostics.frontierEntries;
    }

    const depthIndex = groupIndexOf[flatIdx];
    const gs = (groupState && groupState.depthIndex === depthIndex)
      ? groupState
      : { depthIndex, alreadyActive: 0, remainingFleet: travFleets[depthIndex], fullyUnusedSoFar: 0 };

    if (pruningGate.active) {
      const remainingSources = remainingSourcesFrom[flatIdx];
      const partialExtent = groupSourceNiExtent(remainingSources);
      const partialMaxTonnage = groupMaxAchievableTonnage(gs.remainingFleet, remainingSources);

      // V3.0 Phase 6D -- 'coupled' mode keeps the CURRENT partial group's
      // own envelope SEPARATE from every group strictly after it (never
      // pooled into one shared minNi/maxNi/maxOpenTonnage triple, unlike
      // 'pooled' mode below) -- see conservativeFinalNiBoundCoupled()'s own
      // proof above for why this is still EXACT, not merely conservative.
      const chemBound = chemistryBoundMode === 'coupled'
        ? conservativeFinalNiBoundCoupled(fixedNumerator, fixedTonnage, [
          { minNi: partialExtent.minNi, maxNi: partialExtent.maxNi, thiTonnage: partialMaxTonnage },
          ...groupEnvelopes.slice(depthIndex + 1),
        ])
        : conservativeFinalNiBound(fixedNumerator, fixedTonnage, {
          minNi: Math.min(partialExtent.minNi, suffixChemAfterGroup[depthIndex + 1].minNi),
          maxNi: Math.max(partialExtent.maxNi, suffixChemAfterGroup[depthIndex + 1].maxNi),
          maxOpenTonnage: partialMaxTonnage + suffixChemAfterGroup[depthIndex + 1].maxOpenTonnage,
        });
      if (!boundIntersectsTolerance(chemBound, targetNiValue, toleranceValue)) {
        diagnostics.prunedByChemistry += 1;
        return;
      }

      const totalGroupFleet = travFleets[depthIndex];
      const { additionalMaxActiveUnits, minAdditionalFullyUnusedCount } = openBudgetRankContribution(gs.remainingFleet, remainingSources);
      const bestFinalActiveInGroup = gs.alreadyActive + additionalMaxActiveUnits;
      const minStandbyRatioGroup = totalGroupFleet > 0 ? (totalGroupFleet - bestFinalActiveInGroup) / totalGroupFleet : 0;
      const afterRank = suffixRankAfterGroup[depthIndex + 1];
      const rankBound = conservativeRankingBound(
        {
          criticalCount: completedFixed.criticalCount,
          activeUnits: completedFixed.activeUnits + gs.alreadyActive,
          worstRatio: completedFixed.worstRatio,
          mitigationCount: completedFixed.mitigationCount,
          fullyUnusedCount: completedFixed.fullyUnusedCount,
        },
        {
          minCriticalCount: (minStandbyRatioGroup >= CRITICAL_STANDBY_RATIO ? 1 : 0) + afterRank.minCriticalCount,
          maxActiveUnits: additionalMaxActiveUnits + afterRank.maxActiveUnits,
          minWorstRatio: Math.max(minStandbyRatioGroup, afterRank.minWorstRatio),
          minMitigationCount: (minStandbyRatioGroup > MINOR_STANDBY_RATIO ? 1 : 0) + afterRank.minMitigationCount,
          minFullyUnusedCount: (gs.fullyUnusedSoFar + minAdditionalFullyUnusedCount) + afterRank.minFullyUnusedCount,
        },
      );
      if (boundCannotBeatIncumbent(rankBound, pruningGate.rankMetrics)) {
        diagnostics.prunedByRanking += 1;
        if (rankBoundMode === 'extended') diagnostics.prunedByRankingAE += 1;
        return;
      }
      // V3.0 Phase 6E -- see PHASE 6E ANALYSIS above
      // boundCannotBeatIncumbentExtended()'s own definition: this call can
      // NEVER prune anything the check above didn't already catch (proven,
      // not assumed -- boundCannotBeatIncumbentExtended() is a byte-
      // identical wrapper around boundCannotBeatIncumbent(), since rule F
      // blocks any use of the G/H/I bounds this phase proved individually
      // safe). Wired in ONLY under rankBoundMode==='extended' so
      // prunedByRankingExtended is an ACTUAL runtime count (must read 0
      // across every benchmark scenario), never a comment-only claim.
      if (rankBoundMode === 'extended' && boundCannotBeatIncumbentExtended(rankBound, pruningGate.rankMetrics)) {
        diagnostics.prunedByRankingExtended += 1;
        return;
      }
    }

    const source = flatSources[flatIdx];
    const identity = normalizeSourceIdentity(source.pileId, source.contractor);
    const isLastInGroup = (flatIdx + 1 === total) || (groupIndexOf[flatIdx + 1] !== depthIndex);

    // V3.0 Phase 6C VALUE ORDERING (this task's Section 1) -- SEARCH ORDER
    // ONLY, never a correctness requirement (file header: exactness is
    // proven independent of visitation order). computeValueOrder() always
    // returns the SAME feasible {0} U [6, remainingFleet] set, only
    // reordered; 'descending' (the default) reproduces Phase 6B's original
    // hardcoded loop exactly.
    const orderedValues = computeValueOrder(gs.remainingFleet, source, fixedNumerator, fixedTonnage, targetNiValue, valueStrategy);

    // V3.0 Phase 6H -- SECTION 2/3 domain propagation (see PHASE 6H
    // ANALYSIS above buildTraversalPlan()). Only ever REMOVES already-valid
    // choices this same node would otherwise have generated -- never adds
    // one, never changes canonical candidate construction below.
    let candidateValues = orderedValues;
    if (prefixPropagationMode === 'on' && pruningGate.rankingPrefixLocked) {
      const afterCount = remainingSourcesFrom[flatIdx].length - 1;
      const neededFromHere = requiredGroupActive[depthIndex] - gs.alreadyActive;
      const beforeExact = candidateValues.length;
      candidateValues = candidateValues.filter((value) => canSatisfyExactRemainingTotal(afterCount, neededFromHere - value));
      diagnostics.eliminatedByPrefixPropagation += beforeExact - candidateValues.length;

      if (pruningGate.eZeroLocked && source.assignedUnits > 0) {
        const beforeE = candidateValues.length;
        candidateValues = candidateValues.filter((value) => value !== 0);
        diagnostics.eliminatedByEPropagation += beforeE - candidateValues.length;
      }
    }

    for (const value of candidateValues) {
      if (diagnostics.incomplete || diagnostics.stoppedAtLock) break;

      const next = new Map(activeBySourceKey);
      next.set(identity, value);
      const tonnage = value * source.tonnesPerUnit;
      const numerator = source.ni * tonnage;

      const nextGs = {
        depthIndex,
        alreadyActive: gs.alreadyActive + value,
        remainingFleet: gs.remainingFleet - value,
        fullyUnusedSoFar: gs.fullyUnusedSoFar + ((source.assignedUnits > 0 && value === 0) ? 1 : 0),
      };

      let nextCompletedFixed = completedFixed;
      let carryGroupState = nextGs;
      if (isLastInGroup) {
        const totalGroupFleet = travFleets[depthIndex];
        const finalStandbyRatio = totalGroupFleet > 0 ? (totalGroupFleet - nextGs.alreadyActive) / totalGroupFleet : 0;
        nextCompletedFixed = {
          activeUnits: completedFixed.activeUnits + nextGs.alreadyActive,
          criticalCount: completedFixed.criticalCount + (finalStandbyRatio >= CRITICAL_STANDBY_RATIO ? 1 : 0),
          worstRatio: Math.max(completedFixed.worstRatio, finalStandbyRatio),
          mitigationCount: completedFixed.mitigationCount + (finalStandbyRatio > MINOR_STANDBY_RATIO ? 1 : 0),
          fullyUnusedCount: completedFixed.fullyUnusedCount + nextGs.fullyUnusedSoFar,
        };
        carryGroupState = null;
      }

      combine(flatIdx + 1, next, fixedNumerator + numerator, fixedTonnage + tonnage, nextCompletedFixed, carryGroupState);
    }
  }

  combine(0, new Map(), 0, 0, { activeUnits: 0, criticalCount: 0, worstRatio: 0, mitigationCount: 0, fullyUnusedCount: 0 }, null);
  return diagnostics;
}

function runStreamingSearchSourceLazy(canonicalGroups, plan, targetNiValue, toleranceValue, valueStrategy = 'descending', chemistryBoundMode = 'pooled', rankBoundMode = 'ae', frontierMode = 'off', prefixPropagationMode = 'off', nodeBudget = MAX_SEARCH_NODES, stopAtLock = false) {
  let bestWithinTolerance = null;
  let bestAttainable = null;
  const sourcesInAnyWithinToleranceCandidate = new Set();
  // rankingPrefixLocked/eZeroLocked: V3.0 Phase 6H locks (see PHASE 6H
  // ANALYSIS above buildTraversalPlan()) -- both start false, each flips to
  // true at most ONCE (never reset), the instant a witnessed within-
  // tolerance incumbent proves the corresponding global-optimality
  // condition.
  const pruningGate = { active: false, rankMetrics: null, rankingPrefixLocked: false, eZeroLocked: false };

  const diagnostics = forEachCandidateSourceLazy(canonicalGroups, plan, targetNiValue, toleranceValue, pruningGate, (candidate, liveDiagnostics) => {
    if (bestAttainable === null || compareBestAttainable(candidate, bestAttainable) < 0) {
      bestAttainable = candidate;
    }
    if (candidate.withinTolerance) {
      // V3.0 Phase 6C diagnostic addition ONLY -- records the visitedNodes
      // count at the moment the FIRST within-tolerance incumbent is found,
      // i.e. exactly when pruningGate.active is about to flip true for the
      // first time (this task's "first-incumbent timing/node"). Purely
      // observational: read-only, never consulted by any branching/pruning
      // decision below. `liveDiagnostics` is the SAME object combine()
      // mutates in place -- passed explicitly since this callback runs
      // DURING forEachCandidateSourceLazy(), before its own `diagnostics`
      // local (below) is assigned from that call's return value.
      if (!pruningGate.active && liveDiagnostics.firstIncumbentNode === null) {
        liveDiagnostics.firstIncumbentNode = liveDiagnostics.visitedNodes;
      }
      candidate.sources.forEach((source) => {
        if (source.activeUnits > 0) {
          sourcesInAnyWithinToleranceCandidate.add(normalizeSourceIdentity(source.pileId, source.contractor));
        }
      });
      if (bestWithinTolerance === null || compareWithinTolerance(candidate, bestWithinTolerance) < 0) {
        bestWithinTolerance = candidate;
        pruningGate.rankMetrics = incumbentRankingMetrics(candidate);
      }
      pruningGate.active = true;

      // V3.0 Phase 6H SECTION 1 -- lock A+B the instant ANY witnessed
      // within-tolerance incumbent's OWN rankMetrics prove the global-
      // optimality condition (checked against the CURRENT incumbent's own
      // metrics, never a re-derivation -- see PHASE 6H ANALYSIS). Once
      // true, never reset: a later, worse-on-A/B candidate cannot un-prove
      // an already-witnessed global optimum.
      if (prefixPropagationMode === 'on' && !pruningGate.rankingPrefixLocked
          && pruningGate.rankMetrics.criticalContractorCount === 0
          && pruningGate.rankMetrics.totalActiveUnits === plan.globalMaxActiveUnits) {
        pruningGate.rankingPrefixLocked = true;
        liveDiagnostics.nodeAtPrefixLock = liveDiagnostics.visitedNodes;
        liveDiagnostics.prefixLockProof = 'A+B';
        // V3.0 Phase 6I -- see forEachCandidateSourceLazy()'s own `stopAtLock`
        // comment: cut the unrestricted traversal short right here, the
        // instant the lock this diagnostic just recorded actually fires.
        if (stopAtLock) liveDiagnostics.stoppedAtLock = true;
      }
      // V3.0 Phase 6H SECTION 3 (optional) -- E lock, only meaningful (and
      // only ever checked) once A+B are already locked.
      if (prefixPropagationMode === 'on' && pruningGate.rankingPrefixLocked && !pruningGate.eZeroLocked
          && pruningGate.rankMetrics.fullyUnusedLoadingPointCount === 0) {
        pruningGate.eZeroLocked = true;
        liveDiagnostics.nodeAtELock = liveDiagnostics.visitedNodes;
        liveDiagnostics.eLockProof = 'A-E';
      }
    }
  }, valueStrategy, chemistryBoundMode, rankBoundMode, frontierMode, prefixPropagationMode, nodeBudget, stopAtLock);

  return { bestWithinTolerance, bestAttainable, sourcesInAnyWithinToleranceCandidate, diagnostics };
}

// Same result SHAPE/semantics as blending-recommendation.js's
// buildResultFromSearch() -- duplicated (not imported, since production's
// version is a private, unexported function) rather than reimplemented
// from scratch: field names/branches copied verbatim so a differential test
// comparing this prototype's result object to production's is a plain
// structural equality check, never a "similar but not identical" shape.
function buildResultFromSearch(search, targetNiValue, toleranceValue, candidateCount) {
  if (candidateCount === 0) {
    return { ok: false, error: 'NO_FEASIBLE_CANDIDATE' };
  }

  if (search.diagnostics.incomplete) {
    return {
      ok: false,
      error: 'SEARCH_INCOMPLETE',
      targetNi: targetNiValue,
      tolerance: toleranceValue,
      candidateCount,
      diagnostics: {
        visitedNodes: search.diagnostics.visitedNodes,
        completedCandidates: search.diagnostics.completedCandidates,
        prunedByChemistry: search.diagnostics.prunedByChemistry,
        prunedByRanking: search.diagnostics.prunedByRanking,
      },
    };
  }

  if (search.bestWithinTolerance) {
    return {
      ok: true,
      status: 'OK',
      candidate: search.bestWithinTolerance,
      targetNi: targetNiValue,
      tolerance: toleranceValue,
      candidateCount,
      sourcesInAnyWithinToleranceCandidate: search.sourcesInAnyWithinToleranceCandidate,
    };
  }

  return {
    ok: true,
    status: 'TARGET_NOT_ACHIEVABLE',
    candidate: search.bestAttainable,
    targetNi: targetNiValue,
    tolerance: toleranceValue,
    bestAttainableNi: search.bestAttainable.estimatedNi,
    gap: search.bestAttainable.deviation,
    candidateCount,
    sourcesInAnyWithinToleranceCandidate: new Set(),
  };
}

// PROTOTYPE ENTRY POINT -- mirrors
// findBlendRecommendationsWithDiagnostics()'s return shape
// ({ result, diagnostics }) exactly, so the test suite's existing
// canonicalization/diff helper (a sibling of the frozen V2 oracle under the
// test tree) works on this prototype's output unmodified. NEVER call from
// production code --
// this module is test/benchmark-only by design (this task's PROTOTYPE /
// PROOF FIRST instruction).
export function findBlendRecommendationsSourceLazy({ targetNi, tolerance = DEFAULT_RECOMMENDATION_TOLERANCE, sources }) {
  const prepared = prepareSourceLazySearch({ targetNi, tolerance, sources });
  if (!prepared.ok) return { result: prepared.result, diagnostics: null };
  const { groups, groupFleets, searchOrder, targetNiValue, toleranceValue, candidateCount } = prepared;

  // Per-Contractor 20,000-tuple MAX_ALLOCATIONS_PER_CONTRACTOR gate is
  // DELIBERATELY NOT applied here (this task's "20k gate becomes
  // unnecessary architecturally" phase-gate question) -- there is no eager
  // array for it to protect, since generation is fully lazy/source-level.
  // MAX_SEARCH_NODES (imported, unchanged at 500,000) remains the only
  // safety bound, exactly as production's own Phase 4D design intends for
  // the traversal itself.
  const plan = buildTraversalPlan(groups, groupFleets, searchOrder);
  const search = runStreamingSearchSourceLazy(groups, plan, targetNiValue, toleranceValue);
  return { result: buildResultFromSearch(search, targetNiValue, toleranceValue, candidateCount), diagnostics: search.diagnostics };
}

// V3.0 Phase 6C PROTOTYPE ENTRY POINT -- identical contract/return shape to
// findBlendRecommendationsSourceLazy() above (Phase 6B, left completely
// unchanged), plus an `orderStrategies` option selecting the VARIABLE
// (`sourceStrategy`) and VALUE (`valueStrategy`) ordering this task
// benchmarks. Defaults ('canonical'/'descending') reproduce Phase 6B's own
// behavior exactly -- calling this with no second argument is behaviorally
// identical to findBlendRecommendationsSourceLazy() (both go through the
// SAME prepareSourceLazySearch()/buildTraversalPlan()/
// runStreamingSearchSourceLazy()/buildResultFromSearch(), never a
// reimplemented copy). Group (Contractor) visitation order is always Phase
// 6B's own computeContractorSearchOrder() choice -- this function only ever
// reorders WITHIN that fixed group order (this task's own scope: Section 2
// is benchmarked as within-group source order + value order, holding the
// already-settled Phase 6A cross-Contractor order fixed -- see this
// section's own header comment above computeSourceOrderForStrategy()).
export function findBlendRecommendationsSourceLazyOrdered(
  { targetNi, tolerance = DEFAULT_RECOMMENDATION_TOLERANCE, sources },
  { sourceStrategy = 'canonical', valueStrategy = 'descending' } = {},
) {
  const prepared = prepareSourceLazySearch({ targetNi, tolerance, sources });
  if (!prepared.ok) return { result: prepared.result, diagnostics: null };
  const { groups, groupFleets, searchOrder, targetNiValue, toleranceValue, candidateCount } = prepared;

  // Reorders each group's OWN sources only -- `groups` (canonical, passed
  // to runStreamingSearchSourceLazy() below for buildCandidate()'s use)
  // stays untouched, so allocationSignature/candidate identity remain
  // canonical regardless of `sourceStrategy` (this task's own requirement).
  const reorderedGroups = groups.map((group) => ({
    ...group,
    sources: computeSourceOrderForStrategy(group.sources, targetNiValue, sourceStrategy),
  }));

  const plan = buildTraversalPlan(reorderedGroups, groupFleets, searchOrder);
  const search = runStreamingSearchSourceLazy(groups, plan, targetNiValue, toleranceValue, valueStrategy);
  return { result: buildResultFromSearch(search, targetNiValue, toleranceValue, candidateCount), diagnostics: search.diagnostics };
}

// V3.0 Phase 6D PROTOTYPE ENTRY POINT -- identical contract/return shape to
// the Phase 6B/6C entry points above (both left completely unchanged),
// fixing the traversal order at Phase 6C's own default ('canonical' source
// order / 'descending' value order -- this task's own "use the best/fastest
// safe Phase 6C ordering only as a fixed traversal choice; do not benchmark
// ordering again") and switching ONLY the chemistry bound to the new
// COUPLED (per-Contractor-separated) formula via chemistryBoundMode:
// 'coupled' -- see conservativeFinalNiBoundCoupled()'s own proof above.
// Ranking-prefix pruning, the node budget, candidate construction, and
// every other rule are byte-identical to Phase 6B/6C (this task's own "do
// NOT add other pruning rules").
export function findBlendRecommendationsSourceLazyCoupled({ targetNi, tolerance = DEFAULT_RECOMMENDATION_TOLERANCE, sources }) {
  const prepared = prepareSourceLazySearch({ targetNi, tolerance, sources });
  if (!prepared.ok) return { result: prepared.result, diagnostics: null };
  const { groups, groupFleets, searchOrder, targetNiValue, toleranceValue, candidateCount } = prepared;

  const plan = buildTraversalPlan(groups, groupFleets, searchOrder);
  const search = runStreamingSearchSourceLazy(groups, plan, targetNiValue, toleranceValue, 'descending', 'coupled');
  return { result: buildResultFromSearch(search, targetNiValue, toleranceValue, candidateCount), diagnostics: search.diagnostics };
}

// V3.0 Phase 6G PROTOTYPE ENTRY POINT -- TEST-ONLY. Byte-identical to
// findBlendRecommendationsSourceLazyCoupled() above (same fixed traversal
// choice: canonical source order / descending value order / COUPLED
// chemistry bound -- this task's own "use the best proven exact lazy
// configuration from previous phases... do not benchmark ordering again";
// the Phase 6E extended-ranking bound and Phase 6F dominance frontier are
// both DELIBERATELY excluded here, since neither reduced C/D's node count
// -- see those phases' own benchmark files -- so neither belongs in "the
// best proven exact lazy configuration"), except the node budget is an
// explicit `nodeBudget` argument instead of the hardcoded, imported
// MAX_SEARCH_NODES. Calling this with the default (no third argument)
// reproduces findBlendRecommendationsSourceLazyCoupled() exactly --
// production's own MAX_SEARCH_NODES is never modified, only read as this
// function's own default. NEVER call from production code -- this is a
// measurement tool for tests/v3-phase6g-budget-sweep.test.mjs only (this
// task's "measurement only, do not change production budget").
export function findBlendRecommendationsSourceLazyCoupledBudgeted({ targetNi, tolerance = DEFAULT_RECOMMENDATION_TOLERANCE, sources }, nodeBudget = MAX_SEARCH_NODES) {
  const prepared = prepareSourceLazySearch({ targetNi, tolerance, sources });
  if (!prepared.ok) return { result: prepared.result, diagnostics: null };
  const { groups, groupFleets, searchOrder, targetNiValue, toleranceValue, candidateCount } = prepared;

  const plan = buildTraversalPlan(groups, groupFleets, searchOrder);
  // NOTE: explicit 'off' for the V3.0 Phase 6H prefixPropagationMode
  // parameter (inserted AFTER frontierMode, BEFORE nodeBudget) -- omitting
  // it here would silently shift `nodeBudget` into that new parameter slot
  // and let nodeBudget itself fall back to its MAX_SEARCH_NODES default,
  // breaking tests/v3-phase6g-budget-sweep.test.mjs's whole budget sweep.
  const search = runStreamingSearchSourceLazy(groups, plan, targetNiValue, toleranceValue, 'descending', 'coupled', 'ae', 'off', 'off', nodeBudget);
  return { result: buildResultFromSearch(search, targetNiValue, toleranceValue, candidateCount), diagnostics: search.diagnostics };
}

// V3.0 Phase 6E PROTOTYPE ENTRY POINT -- identical contract/return shape to
// the Phase 6B/6C/6D entry points above (all left completely unchanged),
// fixed at Phase 6D's own traversal choice (canonical source order /
// descending value order / COUPLED chemistry bound) and switching ONLY the
// ranking-bound check from boundCannotBeatIncumbent() to
// boundCannotBeatIncumbentExtended() via rankBoundMode: 'extended' -- see
// the PHASE 6E ANALYSIS section above for why that function is proven
// (not assumed) to behave identically to the A-E-only check. This entry
// point exists SOLELY so the benchmark/proof tests can empirically confirm
// diagnostics.prunedByRankingExtended reads 0 and visitedNodes is
// byte-identical to findBlendRecommendationsSourceLazyCoupled() across
// every scenario (this task's Section 7/10) -- it is not expected, and not
// claimed, to reduce C/D's node count at all.
export function findBlendRecommendationsSourceLazyExtendedRanking({ targetNi, tolerance = DEFAULT_RECOMMENDATION_TOLERANCE, sources }) {
  const prepared = prepareSourceLazySearch({ targetNi, tolerance, sources });
  if (!prepared.ok) return { result: prepared.result, diagnostics: null };
  const { groups, groupFleets, searchOrder, targetNiValue, toleranceValue, candidateCount } = prepared;

  const plan = buildTraversalPlan(groups, groupFleets, searchOrder);
  const search = runStreamingSearchSourceLazy(groups, plan, targetNiValue, toleranceValue, 'descending', 'coupled', 'extended');
  return { result: buildResultFromSearch(search, targetNiValue, toleranceValue, candidateCount), diagnostics: search.diagnostics };
}

// V3.0 Phase 6F PROTOTYPE ENTRY POINT -- identical contract/return shape to
// the Phase 6B/6C/6D/6E entry points above (all left completely unchanged),
// fixed at Phase 6D's own traversal choice (canonical source order /
// descending value order / COUPLED chemistry bound, per this task's own
// "use one fixed, already-proven source/value order -- do NOT benchmark
// ordering again") and ADDITIONALLY switching on the Contractor-boundary
// dominance frontier via frontierMode: 'on' -- see the PHASE 6F ANALYSIS
// section above for the full safety proof (strict future-equivalent key,
// A-E-only dominance, TARGET_NOT_ACHIEVABLE-safe gating). rankBoundMode is
// left at its 'ae' default here (Phase 6F investigates a DIFFERENT,
// independent mechanism from Phase 6E's extended ranking bound; this task's
// own "do not add another optimization in this phase" -- the two are not
// combined in one prototype run).
export function findBlendRecommendationsSourceLazyFrontier({ targetNi, tolerance = DEFAULT_RECOMMENDATION_TOLERANCE, sources }) {
  const prepared = prepareSourceLazySearch({ targetNi, tolerance, sources });
  if (!prepared.ok) return { result: prepared.result, diagnostics: null };
  const { groups, groupFleets, searchOrder, targetNiValue, toleranceValue, candidateCount } = prepared;

  const plan = buildTraversalPlan(groups, groupFleets, searchOrder);
  const search = runStreamingSearchSourceLazy(groups, plan, targetNiValue, toleranceValue, 'descending', 'coupled', 'ae', 'on');
  return { result: buildResultFromSearch(search, targetNiValue, toleranceValue, candidateCount), diagnostics: search.diagnostics };
}

// V3.0 Phase 6H PROTOTYPE ENTRY POINT -- identical contract/return shape to
// every entry point above, fixed at Phase 6D/6G's own "best proven exact
// lazy configuration" traversal choice (canonical source order / descending
// value order / COUPLED chemistry bound / 'ae' rank bound / dominance
// frontier OFF -- this task's own "DO NOT CHANGE OTHER ALGORITHMS... use
// one fixed previously-proven traversal order"), plus
// prefixPropagationMode: 'on' -- see the PHASE 6H ANALYSIS section above
// buildTraversalPlan() for the full safety proof (provable global A+B
// prefix, exact domain propagation, optional E propagation). This is the
// ONLY thing 'on' adds; every other rule (chemistry pruning, A-E ranking-
// bound pruning, candidate construction, node budget semantics) stays
// byte-identical to findBlendRecommendationsSourceLazyCoupled().
export function findBlendRecommendationsSourceLazyPrefixPropagated({ targetNi, tolerance = DEFAULT_RECOMMENDATION_TOLERANCE, sources }) {
  const prepared = prepareSourceLazySearch({ targetNi, tolerance, sources });
  if (!prepared.ok) return { result: prepared.result, diagnostics: null };
  const { groups, groupFleets, searchOrder, targetNiValue, toleranceValue, candidateCount } = prepared;

  const plan = buildTraversalPlan(groups, groupFleets, searchOrder);
  const search = runStreamingSearchSourceLazy(groups, plan, targetNiValue, toleranceValue, 'descending', 'coupled', 'ae', 'off', 'on');
  return { result: buildResultFromSearch(search, targetNiValue, toleranceValue, candidateCount), diagnostics: search.diagnostics };
}

// V3.0 Phase 6H PROTOTYPE ENTRY POINT -- TEST-ONLY. Byte-identical to
// findBlendRecommendationsSourceLazyPrefixPropagated() above, except the
// node budget is an explicit `nodeBudget` argument instead of the
// hardcoded, imported MAX_SEARCH_NODES -- mirrors Phase 6G's own
// findBlendRecommendationsSourceLazyCoupledBudgeted() (this task's "measure
// against the SAME primary benchmark budget, 500,000"). Calling this with
// the default (no third argument) reproduces
// findBlendRecommendationsSourceLazyPrefixPropagated() exactly --
// production's own MAX_SEARCH_NODES is never modified, only read as this
// function's own default. NEVER call from production code -- this is a
// measurement tool for tests/v3-phase6h-*.test.mjs only.
export function findBlendRecommendationsSourceLazyPrefixPropagatedBudgeted({ targetNi, tolerance = DEFAULT_RECOMMENDATION_TOLERANCE, sources }, nodeBudget = MAX_SEARCH_NODES) {
  const prepared = prepareSourceLazySearch({ targetNi, tolerance, sources });
  if (!prepared.ok) return { result: prepared.result, diagnostics: null };
  const { groups, groupFleets, searchOrder, targetNiValue, toleranceValue, candidateCount } = prepared;

  const plan = buildTraversalPlan(groups, groupFleets, searchOrder);
  const search = runStreamingSearchSourceLazy(groups, plan, targetNiValue, toleranceValue, 'descending', 'coupled', 'ae', 'off', 'on', nodeBudget);
  return { result: buildResultFromSearch(search, targetNiValue, toleranceValue, candidateCount), diagnostics: search.diagnostics };
}

// ============================================================
// V3.0 Phase 6I -- PROTOTYPE ONLY: exact full-utilization DECOMPOSITION
// (this task's own spec). Phase 6H proved that once a witnessed incumbent's
// own rankMetrics satisfy criticalContractorCount===0 AND
// totalActiveUnits===globalMaxActiveUnits, BOTH A and B are PROVEN globally
// optimal for the ENTIRE remaining search -- and Section 2's domain
// propagation already narrows every subsequent source-value choice to
// EXACTLY the full-utilization subspace (every group's final active sum
// forced to its own requiredGroupActive[d]). D's own measured behavior
// (lock fires at node ~14,555, yet the unrestricted continuation still
// exhausts 500,000 nodes) shows that filtering-in-place is not enough by
// itself: D's full-utilization subspace, walked one DOME at a time with a
// fresh per-node bound recomputation, is still too many source-level nodes.
//
// ---- SWITCH THEOREM ----
// Claim: once the Section 1 lock fires, abandoning the unrestricted
// source-level traversal entirely and re-solving ONLY the full-utilization
// subspace from the canonical root cannot change the eventual winner.
// Proof: (1) every candidate the unrestricted search could EVER still find,
// from this point forward, already belongs to the full-utilization subspace
// -- this is exactly Phase 6H Section 2's own filter, proven there, not
// re-derived here: a completion that does not hit every group's
// requiredGroupActive[d] exactly has totalActiveUnits<globalMaxActiveUnits
// and therefore LOSES to the current incumbent on rule B outright, so it can
// never become the eventual winner regardless of how the search visits it.
// (2) The full-utilization subspace itself does not depend on WHICH branch
// of the unrestricted tree happened to witness the lock -- requiredGroupActive
// and globalMaxActiveUnits are STATIC, closed-form functions of travFleets
// alone (buildTraversalPlan(), computed once per search, before any
// traversal begins) -- so "the full-utilization subspace" means the exact
// same set of candidates whether reached by continuing the in-progress
// unrestricted branch or by restarting a dedicated solver from the
// canonical root. (3) The incumbent witnessed so far (proven, real,
// buildCandidate-backed) is carried forward as the decomposition solver's
// own starting incumbent -- never discarded -- so the decomposition
// solver's own compareWithinTolerance()-driven search over the SAME
// candidate set, seeded with the SAME best-so-far, must converge to the
// SAME eventual winner as continuing the unrestricted tree would have,
// since both are exhaustive (subject to the same exact, sound pruning
// bounds) searches of the identical remaining candidate set. Restarting
// therefore trades TRAVERSAL STRATEGY (source-granularity vs
// group-granularity nodes) for zero change in which candidate wins --
// this is decomposition, not a narrower or heuristic search.
//
// ---- EXACT FULL-UTILIZATION COUNT FORMULA ----
// For one operational Contractor (fleet F>=MIN, n sources): choose k active
// sources (k from 1 to min(n, floor(F/MIN))), times the number of
// compositions of F into k parts each >=MIN. Stars-and-bars substitution
// x_i=v_i-MIN>=0 (sum x_i = F-MIN*k) gives C(F-MIN*k+k-1, k-1) compositions
// per k-subset, so:
//   count(F,n) = Sum_{k=1}^{min(n,floor(F/MIN))} C(n,k) * C(F-(MIN-1)*k-1, k-1)
// exactFullUtilizationCount() below implements this exactly; verified
// against brute-force enumeration for small F/n by
// tests/v3-phase6i-decomposition.test.mjs.
// ============================================================

// Exact integer binomial coefficient. n,k stay small (<=~40) for every
// scenario in this task's scope, so plain multiplicative accumulation
// (never factorial, which would overflow long before n=40) stays well
// within Number.MAX_SAFE_INTEGER; Math.round() only ever corrects float
// noise on an already-integer result (the multiplicative recurrence is
// exact in real-number arithmetic).
export function binomialCoefficient(n, k) {
  if (k < 0 || k > n || n < 0) return 0;
  const kk = Math.min(k, n - k);
  let result = 1;
  for (let i = 0; i < kk; i += 1) {
    result = (result * (n - i)) / (i + 1);
  }
  return Math.round(result);
}

// See file header PROOF above -- exact closed-form COUNT of full-utilization
// allocations for one Contractor group. Only meaningful for fleet>=MIN
// (an operational Contractor); callers treat fleet<MIN (dead/empty) as the
// separate single trivial all-zero state, matching requiredGroupActive's
// own 0-for-dead-Contractors derivation in buildTraversalPlan().
export function exactFullUtilizationCount(fleet, sourceCount) {
  const MIN = MIN_UNITS_PER_ACTIVE_LOADING_POINT;
  if (fleet < MIN) return 0;
  const maxK = Math.min(sourceCount, Math.floor(fleet / MIN));
  let total = 0;
  for (let k = 1; k <= maxK; k += 1) {
    total += binomialCoefficient(sourceCount, k) * binomialCoefficient(fleet - (MIN - 1) * k - 1, k - 1);
  }
  return total;
}

// Lazy (generator, never eagerly materialized) ascending k-subset index
// enumerator -- canonical, deterministic order.
function* enumerateCombinationIndices(n, k, start = 0, prefix = []) {
  if (prefix.length === k) { yield prefix; return; }
  const remainingNeeded = k - prefix.length;
  for (let i = start; i <= n - remainingNeeded; i += 1) {
    yield* enumerateCombinationIndices(n, k, i + 1, [...prefix, i]);
  }
}

// Lazy (generator) composition enumerator: every ordered k-tuple of integers
// >= `min` summing to exactly `total`. Descending-first-part order is SEARCH
// ORDER ONLY (mirrors this file's own 'descending' value-ordering convention
// -- Phase 6C's own file header: never removes a branch, only reorders which
// valid one is visited first).
function* enumerateCompositions(total, parts, min) {
  if (parts === 1) {
    if (total >= min) yield [total];
    return;
  }
  const maxFirst = total - min * (parts - 1);
  for (let first = maxFirst; first >= min; first -= 1) {
    for (const rest of enumerateCompositions(total - first, parts - 1, min)) {
      yield [first, ...rest];
    }
  }
}

// Lazy full-utilization allocation enumerator for ONE Contractor group --
// this task's own LAZY GENERATION requirement: no eager array, no 20k
// materialization gate. Yields every value array (length sourceCount,
// parallel to that group's canonical source order) with values in
// {0}U[MIN,fleet] summing to EXACTLY fleet -- Same-Contractor relocation
// remains fully allowed (a source's ORIGINAL assignedUnits is never
// consulted here, only the shared fleet ceiling), and no source is capped
// by its own originally-assigned fleet.
export function* enumerateFullUtilizationAllocations(fleet, sourceCount) {
  const MIN = MIN_UNITS_PER_ACTIVE_LOADING_POINT;
  if (fleet < MIN) return;
  const maxK = Math.min(sourceCount, Math.floor(fleet / MIN));
  for (let k = 1; k <= maxK; k += 1) {
    for (const indices of enumerateCombinationIndices(sourceCount, k)) {
      for (const composition of enumerateCompositions(fleet, k, MIN)) {
        const values = new Array(sourceCount).fill(0);
        indices.forEach((sourceIdx, j) => { values[sourceIdx] = composition[j]; });
        yield values;
      }
    }
  }
}

// V3.0 Phase 6I -- group-granularity (never source-granularity) exact
// Branch-and-Bound over ONLY the full-utilization subspace. Structurally
// mirrors production's ORIGINAL Contractor-group model
// (forEachCandidatePruned, blending-recommendation.js) -- one recursion
// level per Contractor group, never per dome -- except the per-group
// allocation source is enumerateFullUtilizationAllocations() above (lazy,
// restricted) instead of enumerateOperationalAllocations() (eager, the full
// operational space, gated at 20,000/Contractor). Every bound this reuses
// (suffixChemAfterGroup/suffixRankAfterGroup) is the SAME static plan state
// buildTraversalPlan() already computed for the source-lazy search --
// reused verbatim, never recomputed -- this task's own "use existing exact
// business logic". `incumbentRankMetricsRef` is a `{ current }` box (not a
// plain value) so a NEW, better incumbent found mid-decomposition
// immediately tightens pruning for every subsequent node, exactly like
// pruningGate.rankMetrics does in the source-lazy search above.
function forEachFullUtilizationCandidate(canonicalGroups, plan, targetNiValue, toleranceValue, incumbentRankMetricsRef, visit, nodeBudget) {
  const { travGroups, travFleets, flatSources, suffixChemAfterGroup, suffixRankAfterGroup } = plan;
  const n = travGroups.length;
  // Performance note (this task's own "keep memory bounded", and a fair
  // like-for-like runtime comparison against the source-lazy phases above):
  // a Map clone per node (this file's OTHER combine() loops all do this,
  // fine at SOURCE granularity where each node adds exactly one entry) would
  // be an O(totalSources) copy at EVERY one of potentially millions of
  // GROUP-granularity nodes here. Instead, `flatActiveValues` is ONE shared,
  // in-place-mutated array (parallel to `flatSources`, itself already in
  // travGroups/depth order per buildTraversalPlan()) that each group's own
  // emit() overwrites for exactly its own contiguous slice -- safe because
  // every full-utilization composition assigns EVERY position in that slice
  // (active value or 0), so no stale value from a sibling composition can
  // ever leak through, and identical sibling compositions at the SAME
  // group never execute concurrently (this is a plain synchronous
  // recursion). The real (identity-keyed) Map buildCandidate() needs is
  // built exactly ONCE per LEAF, from this flat array -- never per
  // intermediate node.
  const flatActiveValues = new Array(flatSources.length).fill(0);
  const groupOffsets = new Array(n);
  {
    let offset = 0;
    for (let d = 0; d < n; d += 1) {
      groupOffsets[d] = offset;
      offset += travGroups[d].sources.length;
    }
  }
  // Per-depth MEMOIZATION of enumerateFullUtilizationAllocations()'s own
  // output -- computed at most ONCE per depthIndex (the group AT that depth
  // is a static function of the plan alone, never of the path taken to
  // reach it), the first time this depth is actually visited (never
  // upfront, and never for a depth the search happens to prune away
  // before ever reaching it -- still "generated lazily", just not
  // RE-generated). Without this, every one of a group's own
  // exactFullUtilizationCount(fleet,n) allocations would be recomputed via
  // the recursive generator chain from EVERY distinct ancestor-branch
  // combination that reaches this depth -- for D's own 151x151x2251 shape
  // that is 22,801 redundant re-derivations of the SAME 2,251-element
  // enumeration. Bounded memory (this task's own "keep memory bounded"):
  // total cache size is the SUM of each depth's own exact, closed-form
  // count (verified by exactFullUtilizationCount() above) -- never a
  // cross-Contractor PRODUCT, which is the actual danger the old eager
  // enumerateOperationalAllocations() 20,000-gate existed to guard against.
  const perDepthAllocationCache = new Array(n).fill(null);
  function allocationsForDepth(depthIndex, fleet, sourceCount) {
    let cached = perDepthAllocationCache[depthIndex];
    if (cached === null) {
      cached = Array.from(enumerateFullUtilizationAllocations(fleet, sourceCount));
      perDepthAllocationCache[depthIndex] = cached;
    }
    return cached;
  }
  const diagnostics = {
    decompositionVisitedNodes: 0,
    fullUtilizationStatesGenerated: 0,
    perGroupStateCounts: travFleets.map((fleet, i) => (
      isOperationalLoadingPointAllocation(fleet) && fleet > 0
        ? exactFullUtilizationCount(fleet, travGroups[i].sources.length)
        : 1
    )),
    completedCandidates: 0,
    prunedByChemistry: 0,
    prunedByRanking: 0,
    incomplete: false,
  };

  function combine(depthIndex, fixedNumerator, fixedTonnage, completedFixed) {
    if (diagnostics.incomplete) return;
    if (diagnostics.decompositionVisitedNodes >= nodeBudget) {
      diagnostics.incomplete = true;
      return;
    }
    diagnostics.decompositionVisitedNodes += 1;

    if (depthIndex === n) {
      // V3.0 Phase 6I -- cheap EXACT (not a bound -- every group is fully
      // decided at a leaf) pre-check before paying for buildCandidate()'s
      // own real cost (relocation planning across every Contractor group,
      // ranking-flag derivation, etc.). Safe to skip buildCandidate()
      // entirely for a leaf that misses tolerance: decomposition only ever
      // runs once Phase A has ALREADY witnessed a real within-tolerance
      // incumbent (runDecomposedSearch() below never calls this function
      // otherwise), so the search's eventual status is unconditionally OK
      // regardless of what decomposition itself finds -- bestAttainable
      // tracking (the only reason a NOT-within-tolerance candidate would
      // ever matter) is therefore irrelevant from this point forward, and
      // reusing the SAME isWithinTolerance() production predicate
      // (imported, unchanged) here means this can never disagree with what
      // buildCandidate()'s own internal tolerance check would have decided.
      if (fixedTonnage > 0) {
        const finalNi = fixedNumerator / fixedTonnage;
        if (!isWithinTolerance(finalNi, targetNiValue, toleranceValue)) return;
      }
      const activeBySourceKey = new Map();
      for (let i = 0; i < flatSources.length; i += 1) {
        const s = flatSources[i];
        activeBySourceKey.set(normalizeSourceIdentity(s.pileId, s.contractor), flatActiveValues[i]);
      }
      const candidate = buildCandidate(canonicalGroups, activeBySourceKey, targetNiValue, toleranceValue);
      if (candidate) {
        diagnostics.completedCandidates += 1;
        visit(candidate);
      }
      return;
    }

    // Chemistry bound using the general (operational, imported/unchanged)
    // suffix envelope for groups [depthIndex..end) -- a SAFE, if not
    // maximally tight, over-approximation of the full-utilization-only
    // achievable range (this task's own "chemistry bounds where
    // applicable... no new chemistry mathematics"): the full-utilization
    // subspace is a SUBSET of the general operational space this bound was
    // already proven exact/conservative for, so every bound that safely
    // contains the general space's achievable Ni range also safely
    // contains this narrower subspace's own range.
    const chemBound = conservativeFinalNiBound(fixedNumerator, fixedTonnage, suffixChemAfterGroup[depthIndex]);
    if (!boundIntersectsTolerance(chemBound, targetNiValue, toleranceValue)) {
      diagnostics.prunedByChemistry += 1;
      return;
    }
    if (incumbentRankMetricsRef.current) {
      const rankBound = conservativeRankingBound(
        {
          criticalCount: completedFixed.criticalCount,
          activeUnits: completedFixed.activeUnits,
          worstRatio: completedFixed.worstRatio,
          mitigationCount: completedFixed.mitigationCount,
          fullyUnusedCount: completedFixed.fullyUnusedCount,
        },
        suffixRankAfterGroup[depthIndex],
      );
      if (boundCannotBeatIncumbent(rankBound, incumbentRankMetricsRef.current)) {
        diagnostics.prunedByRanking += 1;
        return;
      }
    }

    const group = travGroups[depthIndex];
    const fleet = travFleets[depthIndex];
    const sources = group.sources;
    const offset = groupOffsets[depthIndex];

    function emit(values) {
      diagnostics.fullUtilizationStatesGenerated += 1;
      let tonnage = 0;
      let numerator = 0;
      let activeSum = 0;
      let fullyUnusedSoFar = 0;
      for (let idx = 0; idx < sources.length; idx += 1) {
        const s = sources[idx];
        const v = values[idx];
        flatActiveValues[offset + idx] = v;
        const t = v * s.tonnesPerUnit;
        tonnage += t;
        numerator += s.ni * t;
        activeSum += v;
        if (s.assignedUnits > 0 && v === 0) fullyUnusedSoFar += 1;
      }
      const finalStandbyRatio = fleet > 0 ? (fleet - activeSum) / fleet : 0;
      const nextCompletedFixed = {
        activeUnits: completedFixed.activeUnits + activeSum,
        criticalCount: completedFixed.criticalCount + (finalStandbyRatio >= CRITICAL_STANDBY_RATIO ? 1 : 0),
        worstRatio: Math.max(completedFixed.worstRatio, finalStandbyRatio),
        mitigationCount: completedFixed.mitigationCount + (finalStandbyRatio > MINOR_STANDBY_RATIO ? 1 : 0),
        fullyUnusedCount: completedFixed.fullyUnusedCount + fullyUnusedSoFar,
      };
      combine(depthIndex + 1, fixedNumerator + numerator, fixedTonnage + tonnage, nextCompletedFixed);
    }

    if (fleet === 0 || !isOperationalLoadingPointAllocation(fleet)) {
      // Dead (1..5) or empty Contractor: exactly ONE full-utilization state
      // -- all-zero (requiredGroupActive[d]===0 for this group, per
      // buildTraversalPlan()'s own derivation).
      emit(new Array(sources.length).fill(0));
      return;
    }

    const allocations = allocationsForDepth(depthIndex, fleet, sources.length);
    for (let i = 0; i < allocations.length; i += 1) {
      if (diagnostics.incomplete) break;
      emit(allocations[i]);
    }
  }

  combine(0, 0, 0, { activeUnits: 0, criticalCount: 0, worstRatio: 0, mitigationCount: 0, fullyUnusedCount: 0 });
  return diagnostics;
}

// V3.0 Phase 6I -- orchestrator: Phase A is the UNCHANGED Phase 6H
// prefix-propagated source-lazy search, stopped (stopAtLock: true) the
// instant it proves the A+B lock; Phase B is the group-granularity
// full-utilization decomposition above, seeded with Phase A's own witnessed
// incumbent (never discarded -- see SWITCH THEOREM above). If the lock never
// fires (TARGET_NOT_ACHIEVABLE, a small scenario that finishes on its own,
// or genuine budget exhaustion before any global-optimality witness),
// Phase A's own result already IS the final answer -- decomposition is a
// deliberate no-op in that case, never a silent second search.
function runDecomposedSearch(canonicalGroups, plan, targetNiValue, toleranceValue, nodeBudget, decompositionNodeBudget) {
  const phaseA = runStreamingSearchSourceLazy(
    canonicalGroups, plan, targetNiValue, toleranceValue,
    'descending', 'coupled', 'ae', 'off', 'on', nodeBudget, true,
  );

  const diagnostics = {
    switchedToDecomposition: phaseA.diagnostics.stoppedAtLock,
    phaseA: phaseA.diagnostics,
    decompositionVisitedNodes: 0,
    fullUtilizationStatesGenerated: 0,
    perGroupStateCounts: null,
    completedCandidates: phaseA.diagnostics.completedCandidates,
    prunedByChemistry: phaseA.diagnostics.prunedByChemistry,
    prunedByRanking: phaseA.diagnostics.prunedByRanking,
    visitedNodes: phaseA.diagnostics.visitedNodes,
    nodeAtPrefixLock: phaseA.diagnostics.nodeAtPrefixLock,
    globalMaxActiveUnits: phaseA.diagnostics.globalMaxActiveUnits,
    incomplete: phaseA.diagnostics.incomplete,
  };

  if (!phaseA.diagnostics.stoppedAtLock) {
    return {
      bestWithinTolerance: phaseA.bestWithinTolerance,
      bestAttainable: phaseA.bestAttainable,
      sourcesInAnyWithinToleranceCandidate: phaseA.sourcesInAnyWithinToleranceCandidate,
      diagnostics,
    };
  }

  let bestWithinTolerance = phaseA.bestWithinTolerance;
  const sourcesInAnyWithinToleranceCandidate = phaseA.sourcesInAnyWithinToleranceCandidate;
  const incumbentRankMetricsRef = { current: incumbentRankingMetrics(bestWithinTolerance) };

  const decomposition = forEachFullUtilizationCandidate(
    canonicalGroups, plan, targetNiValue, toleranceValue, incumbentRankMetricsRef,
    (candidate) => {
      if (candidate.withinTolerance) {
        candidate.sources.forEach((source) => {
          if (source.activeUnits > 0) {
            sourcesInAnyWithinToleranceCandidate.add(normalizeSourceIdentity(source.pileId, source.contractor));
          }
        });
        if (compareWithinTolerance(candidate, bestWithinTolerance) < 0) {
          bestWithinTolerance = candidate;
          incumbentRankMetricsRef.current = incumbentRankingMetrics(candidate);
        }
      }
    },
    decompositionNodeBudget,
  );

  diagnostics.decompositionVisitedNodes = decomposition.decompositionVisitedNodes;
  diagnostics.fullUtilizationStatesGenerated = decomposition.fullUtilizationStatesGenerated;
  diagnostics.perGroupStateCounts = decomposition.perGroupStateCounts;
  diagnostics.completedCandidates += decomposition.completedCandidates;
  diagnostics.prunedByChemistry += decomposition.prunedByChemistry;
  diagnostics.prunedByRanking += decomposition.prunedByRanking;
  diagnostics.incomplete = decomposition.incomplete;

  return { bestWithinTolerance, bestAttainable: phaseA.bestAttainable, sourcesInAnyWithinToleranceCandidate, diagnostics };
}

// V3.0 Phase 6I PROTOTYPE ENTRY POINT -- production's own MAX_SEARCH_NODES
// used, unmodified, for BOTH phases (this task's "do not raise production
// MAX_SEARCH_NODES"). NEVER call from production code.
export function findBlendRecommendationsSourceLazyDecomposed({ targetNi, tolerance = DEFAULT_RECOMMENDATION_TOLERANCE, sources }) {
  const prepared = prepareSourceLazySearch({ targetNi, tolerance, sources });
  if (!prepared.ok) return { result: prepared.result, diagnostics: null };
  const { groups, groupFleets, searchOrder, targetNiValue, toleranceValue, candidateCount } = prepared;

  const plan = buildTraversalPlan(groups, groupFleets, searchOrder);
  const search = runDecomposedSearch(groups, plan, targetNiValue, toleranceValue, MAX_SEARCH_NODES, MAX_SEARCH_NODES);
  return { result: buildResultFromSearch(search, targetNiValue, toleranceValue, candidateCount), diagnostics: search.diagnostics };
}

// V3.0 Phase 6I PROTOTYPE ENTRY POINT -- TEST-ONLY. Independent budgets for
// Phase A (source-level nodes) and Phase B (decomposition/group-level
// nodes) -- this task's own "decomposition nodes differ from source-level
// nodes, report the work units separately". NEVER call from production
// code.
export function findBlendRecommendationsSourceLazyDecomposedBudgeted(
  { targetNi, tolerance = DEFAULT_RECOMMENDATION_TOLERANCE, sources },
  nodeBudget = MAX_SEARCH_NODES,
  decompositionNodeBudget = MAX_SEARCH_NODES,
) {
  const prepared = prepareSourceLazySearch({ targetNi, tolerance, sources });
  if (!prepared.ok) return { result: prepared.result, diagnostics: null };
  const { groups, groupFleets, searchOrder, targetNiValue, toleranceValue, candidateCount } = prepared;

  const plan = buildTraversalPlan(groups, groupFleets, searchOrder);
  const search = runDecomposedSearch(groups, plan, targetNiValue, toleranceValue, nodeBudget, decompositionNodeBudget);
  return { result: buildResultFromSearch(search, targetNiValue, toleranceValue, candidateCount), diagnostics: search.diagnostics };
}

// ============================================================
// V3.0 Phase 6J -- EXACT MEET-IN-THE-MIDDLE CHEMISTRY + RANKING-E FEASIBILITY
// PROTOTYPE (this task's own spec). Phase 6I proved the A+B full-utilization
// decomposition is exact but D still has 51,325,051 full-utilization
// Cartesian combinations -- too many to traverse directly even at
// group granularity. This section does NOT traverse that Cartesian product.
// It reuses Phase 6I's own per-group full-utilization STATE generator
// (enumerateFullUtilizationAllocations()/exactFullUtilizationCount() above,
// unchanged) and adds an exact offline 2D range-count join on top: split
// Contractor groups into two halves, build each half's own aggregate
// full-utilization state list (Cartesian product WITHIN that half only,
// never across halves), then COUNT (and, for ranking rule E, locate the
// minimum feasible E) how many LEFT x RIGHT combinations land within
// chemistry tolerance -- without ever looping over every LEFT x RIGHT pair.
//
// ---- EXACT CHEMISTRY JOIN CONDITION -- PROOF ----
// A full-utilization combination's final Ni is finalNi = N / T (N = summed
// weighted-Ni numerator, T = summed tonnage, both additive across every
// Contractor group's own chosen state -- buildCandidate()'s own
// estimatedNi formula, reused unchanged). It is within [L, U] = [target -
// tolerance, target + tolerance] (T > 0, since at least one full-utilization
// group is always operational whenever this function is ever invoked --
// runDecomposedSearch() above only ever reaches decomposition once Phase A
// has ALREADY witnessed a real within-tolerance incumbent, so achievability
// is not in question here) iff:
//   L <= N/T <= U
//   <=> L*T <= N <= U*T                          (T > 0, inequality direction preserved)
//   <=> N - L*T >= 0  AND  N - U*T <= 0
// Splitting N = leftN + rightN, T = leftT + rightT (both additive across
// the two disjoint group halves):
//   (leftN - L*leftT) + (rightN - L*rightT) >= 0
//   (leftN - U*leftT) + (rightN - U*rightT) <= 0
// i.e., defining lowScore = N - L*T and highScore = N - U*T PER HALF (exactly
// as this task's own Section 3 specifies), the join condition is precisely
// left.lowScore + right.lowScore >= 0 AND left.highScore + right.highScore
// <= 0 -- an exact reformulation, not an approximation: no rounding, no Ni
// bucketing, no epsilon (this task's own Section 11 "EXACTNESS/SAFETY"
// requirement) is introduced anywhere in this derivation.
// ============================================================

// Per-group full-utilization STATE list (numerator/tonnage/fullyUnusedCount
// only -- not a full buildCandidate() candidate, which is only ever built
// lazily at reconstruction time, see reconstructCandidateFromChoices()
// below). Reuses enumerateFullUtilizationAllocations()/
// exactFullUtilizationCount() verbatim (Phase 6I, unchanged) -- for a
// dead/empty Contractor (fleet<MIN or fleet===0) this is the SAME single
// trivial all-zero state forEachFullUtilizationCandidate()'s own dead-group
// branch emits, computed identically (own assignedUnits>0-and-v===0 count).
// Byte-for-byte copy of recommendation-ranking.js's/blending-recommendation.js's
// own HIGHER_GRADE_CLASSES partition (HGLO+MGLO vs LGLO) -- same duplication
// precedent as this file's own toNumericSource() above: this prototype must
// not modify production files, so it reproduces the ~1-line constant rather
// than importing a private module-local. classifyOre() only ever returns
// 'HGLO'/'MGLO'/'LGLO', so `higherUnits + lgloUnits === total active units`
// always holds -- the same exhaustive partition buildCandidate() uses to
// compute candidate.higherGradeUnits/lgloUnits (blending-recommendation.js
// lines ~224-227) before calling simplifyUnitRatio().
const HOPPER_HIGHER_GRADE_CLASSES = new Set(['HGLO', 'MGLO']);

export function buildGroupFullUtilizationStates(group, fleet) {
  const sources = group.sources;
  const states = [];
  function emit(values) {
    let tonnage = 0;
    let numerator = 0;
    let fullyUnusedCount = 0;
    // V3.0 Phase 6K -- the exact, additive Hopper rule-F primitive (see this
    // file's "PHASE 6K ANALYSIS" section below): the RAW (never gcd-reduced
    // here) per-group active-unit totals for the Higher-Grade and LGLO
    // partitions. Raw, because simplifyUnitRatio()'s own contract requires
    // being called on the TRUE COMBINED total (this task's Section 2 "no GCD
    // shortcut unless it reproduces production exactly") -- reducing per
    // group first would silently diverge from production the moment two
    // groups' individually-reduced ratios don't recombine losslessly (e.g.
    // group A's 2:4 reduces to 1:2 in isolation, discarding the factor of 2
    // that a sibling group's own units still needed added on top).
    let higherUnits = 0;
    let lgloUnits = 0;
    // V3.0 Phase 6L -- the exact, additive G (totalMovedUnits) and I
    // (activeSourceCount) primitives, same "plain per-source additive
    // accumulator, no cross-source interaction" shape already proven for
    // fullyUnusedCount/higherUnits/lgloUnits above (see this file's own
    // Phase 6E minPossibleFinalRelocation()/minPossibleFinalActiveSourceCount()
    // comments for the underlying proofs -- G's own formula
    // Sum(max(0, activeUnits-assignedUnits)) is verified again in this
    // file's PHASE 6L ANALYSIS below against fleet-allocation.js's real
    // planContractorRelocations()).
    let movedUnits = 0;
    let activeSourceCount = 0;
    for (let i = 0; i < sources.length; i += 1) {
      const s = sources[i];
      const v = values[i];
      const t = v * s.tonnesPerUnit;
      tonnage += t;
      numerator += s.ni * t;
      if (s.assignedUnits > 0 && v === 0) fullyUnusedCount += 1;
      if (HOPPER_HIGHER_GRADE_CLASSES.has(s.oreClass)) higherUnits += v; else lgloUnits += v;
      if (v > s.assignedUnits) movedUnits += v - s.assignedUnits;
      if (v > 0) activeSourceCount += 1;
    }
    states.push({ values, numerator, tonnage, fullyUnusedCount, higherUnits, lgloUnits, movedUnits, activeSourceCount });
  }
  if (fleet === 0 || !isOperationalLoadingPointAllocation(fleet)) {
    emit(new Array(sources.length).fill(0));
  } else {
    for (const values of enumerateFullUtilizationAllocations(fleet, sources.length)) {
      emit(values);
    }
  }
  return states;
}

// Deterministic (never hardcoded, this task's own Section 2 requirement)
// balanced LEFT/RIGHT split of Contractor GROUPS (never a single Contractor
// split internally -- each groupIndex goes entirely to one side). Balances
// the SUM OF LOG(count) across the two sides (equivalent to balancing the
// PRODUCT of per-group counts, i.e. each side's own aggregate state count --
// the actual quantity that matters for MITM, not the raw group count) via a
// standard greedy largest-first bin assignment: sort groups by their own
// state count descending, then assign each to whichever side currently has
// the smaller running log-sum. Ties broken by groupIndex for determinism.
export function balanceContractorGroupsForMitm(perGroupStateCounts) {
  const order = perGroupStateCounts
    .map((count, index) => ({ index, count, logCount: count > 0 ? Math.log(count) : 0 }))
    .sort((a, b) => (b.count - a.count) || (a.index - b.index));
  const leftIndices = [];
  const rightIndices = [];
  let leftLog = 0;
  let rightLog = 0;
  order.forEach(({ index, logCount }) => {
    if (leftLog <= rightLog) {
      leftIndices.push(index);
      leftLog += logCount;
    } else {
      rightIndices.push(index);
      rightLog += logCount;
    }
  });
  leftIndices.sort((a, b) => a - b);
  rightIndices.sort((a, b) => a - b);
  return { leftIndices, rightIndices };
}

// Aggregate half-state list: Cartesian product of the per-group state lists
// belonging to ONE half only (never across halves -- that full cross product
// is exactly what this whole phase exists to avoid ever materializing).
// `choices` retains enough to RECONSTRUCT the real per-source allocation
// later (this task's own Section 1 "must retain enough information for
// later reconstruction"): one {groupIndex, stateIndex} pair per group in
// this half.
export function buildAggregateHalfStates(groupIndices, groupStatesList) {
  let aggregates = [{
    numerator: 0, tonnage: 0, fullyUnusedCount: 0, higherUnits: 0, lgloUnits: 0, movedUnits: 0, activeSourceCount: 0, choices: [],
  }];
  groupIndices.forEach((groupIndex) => {
    const states = groupStatesList[groupIndex];
    const next = [];
    aggregates.forEach((agg) => {
      states.forEach((state, stateIndex) => {
        next.push({
          numerator: agg.numerator + state.numerator,
          tonnage: agg.tonnage + state.tonnage,
          fullyUnusedCount: agg.fullyUnusedCount + state.fullyUnusedCount,
          // V3.0 Phase 6K/6L -- plain addition, same as every other field
          // here: this IS the composability claim under test (P(full) =
          // combine(P(left), P(right)) = simple sum), never re-derived from
          // `values` at this level.
          higherUnits: agg.higherUnits + state.higherUnits,
          lgloUnits: agg.lgloUnits + state.lgloUnits,
          // V3.0 Phase 6L -- G/I primitives, same additive composition.
          movedUnits: agg.movedUnits + state.movedUnits,
          activeSourceCount: agg.activeSourceCount + state.activeSourceCount,
          choices: [...agg.choices, { groupIndex, stateIndex }],
        });
      });
    });
    aggregates = next;
  });
  return aggregates;
}

// Attach lowScore/highScore (this task's own Section 3 formulas, L = target
// - tolerance, U = target + tolerance) to every aggregate half-state. Plain
// JS Number arithmetic throughout -- same full-precision semantics as the
// rest of this engine; no epsilon widening (this task's own Section 11 "no
// epsilon" -- unlike production's isWithinTolerance()/boundIntersectsTolerance(),
// which deliberately widen by FLOAT_EPSILON for floating-point safety, this
// prototype's join uses the EXACT target-derived thresholds the task
// specifies, and is cross-checked bit-for-bit against a same-predicate
// brute-force Cartesian enumeration below, never against the
// epsilon-widened production predicate).
export function withChemistryScores(states, targetNiValue, toleranceValue) {
  const low = targetNiValue - toleranceValue;
  const high = targetNiValue + toleranceValue;
  return states.map((state) => ({
    ...state,
    lowScore: state.numerator - low * state.tonnage,
    highScore: state.numerator - high * state.tonnage,
  }));
}

// Minimal exact Fenwick tree (Binary Indexed Tree) over 1-indexed ranks --
// the "exact counting structure" this task's own Section 4 calls for.
class FenwickTree {
  constructor(size) {
    this.size = size;
    this.tree = new Array(size + 1).fill(0);
  }

  add(i, delta) {
    for (let x = i; x <= this.size; x += x & (-x)) this.tree[x] += delta;
  }

  prefixSum(i) {
    let sum = 0;
    for (let x = i; x > 0; x -= x & (-x)) sum += this.tree[x];
    return sum;
  }
}

// Exact COUNT of (left,right) pairs satisfying the Section 3 join condition
// -- this task's own Section 4 "do NOT loop over every LEFT x RIGHT pair".
// Method: sort RIGHT by lowScore descending; sort LEFT queries by lowScore
// ascending (equivalently, by threshold -left.lowScore descending); sweep
// LEFT queries in that order, incrementally inserting RIGHT points whose own
// lowScore already clears the current threshold into a Fenwick tree keyed
// by a coordinate-compressed rank of RIGHT's own highScore values (exact
// Number values, never discretized/rounded -- only their SORT ORDER is used
// to assign ranks); each query then asks the Fenwick tree for a prefix count
// of already-inserted points with highScore <= that query's own threshold.
// O((L+R) log R) total, never O(L*R).
export function countWithinToleranceMITM(leftStates, rightStates) {
  if (leftStates.length === 0 || rightStates.length === 0) return 0;

  const sortedHigh = Array.from(new Set(rightStates.map((r) => r.highScore))).sort((a, b) => a - b);

  function upperBoundRank(value) {
    // 0-based index of the RIGHTMOST element of sortedHigh that is <= value;
    // -1 if none qualify.
    let lo = 0;
    let hi = sortedHigh.length - 1;
    let ans = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (sortedHigh[mid] <= value) { ans = mid; lo = mid + 1; } else { hi = mid - 1; }
    }
    return ans;
  }

  function exactRank(value) {
    // 0-based index of `value` itself within sortedHigh (value is always a
    // MEMBER of sortedHigh here -- it was built FROM rightStates).
    let lo = 0;
    let hi = sortedHigh.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (sortedHigh[mid] < value) lo = mid + 1; else hi = mid;
    }
    return lo;
  }

  const rightSorted = [...rightStates].sort((a, b) => b.lowScore - a.lowScore);
  const leftSorted = [...leftStates].sort((a, b) => a.lowScore - b.lowScore);

  const fenwick = new FenwickTree(sortedHigh.length);
  let rp = 0;
  let total = 0;
  leftSorted.forEach((left) => {
    const lowThreshold = -left.lowScore;
    const highThreshold = -left.highScore;
    while (rp < rightSorted.length && rightSorted[rp].lowScore >= lowThreshold) {
      fenwick.add(exactRank(rightSorted[rp].highScore) + 1, 1);
      rp += 1;
    }
    const upTo = upperBoundRank(highThreshold);
    if (upTo >= 0) total += fenwick.prefixSum(upTo + 1);
  });
  return total;
}

// Buckets a half's own aggregate states by their own fullyUnusedCount (this
// task's own Section 6 "partition/index half-states by their integer E
// contribution").
function bucketByFullyUnusedCount(states) {
  const buckets = new Map();
  states.forEach((state) => {
    const e = state.fullyUnusedCount;
    if (!buckets.has(e)) buckets.set(e, []);
    buckets.get(e).push(state);
  });
  return buckets;
}

// Finds the EXACT minimum feasible E (this task's own Section 6) by
// searching E totals from the smallest mathematically possible (0) upward,
// re-using countWithinToleranceMITM() per (leftE, rightE) split-of-E-total
// bucket pair -- never enumerating past the first feasible E, and never
// reasoning past E (rule F/Hopper untouched, per this task's own "do NOT use
// Hopper F yet").
export function findMinimumFeasibleE(leftStates, rightStates) {
  const leftBuckets = bucketByFullyUnusedCount(leftStates);
  const rightBuckets = bucketByFullyUnusedCount(rightStates);
  const leftEs = [...leftBuckets.keys()].sort((a, b) => a - b);
  const rightEs = [...rightBuckets.keys()];
  if (leftEs.length === 0 || rightEs.length === 0) return { minimumE: null, count: 0 };
  const maxETotal = Math.max(...leftEs) + Math.max(...rightEs);

  for (let eTotal = 0; eTotal <= maxETotal; eTotal += 1) {
    let count = 0;
    leftEs.forEach((eLeft) => {
      const eRight = eTotal - eLeft;
      if (rightBuckets.has(eRight)) {
        count += countWithinToleranceMITM(leftBuckets.get(eLeft), rightBuckets.get(eRight));
      }
    });
    if (count > 0) return { minimumE: eTotal, count };
  }
  return { minimumE: null, count: 0 };
}

// Reconstructs the REAL per-source active-unit Map for one matched
// (leftChoice, rightChoice) pair (this task's own Section 9 "reconstruct
// real candidates" -- small scenarios only). `choices` are the
// {groupIndex, stateIndex} pairs both aggregate half-states carry.
export function buildActiveMapFromChoices(groups, groupStatesList, choices) {
  const activeBySourceKey = new Map();
  choices.forEach(({ groupIndex, stateIndex }) => {
    const group = groups[groupIndex];
    const { values } = groupStatesList[groupIndex][stateIndex];
    group.sources.forEach((s, i) => {
      activeBySourceKey.set(normalizeSourceIdentity(s.pileId, s.contractor), values[i]);
    });
  });
  return activeBySourceKey;
}

// Brute-force full-utilization Cartesian enumeration using the EXACT SAME
// join predicate as the MITM path above (this task's own Section 5
// "exhaustive proof... require exact integer equality") -- small scenarios
// ONLY (this is the O(product of all group counts) traversal Phase 6J
// exists to avoid at scale). Also tracks the minimum fullyUnusedCount (E)
// among within-tolerance combinations and how many attain it, as an
// independent oracle for findMinimumFeasibleE() above.
export function bruteForceFullUtilizationChemistryCount(groupStatesList, targetNiValue, toleranceValue) {
  const low = targetNiValue - toleranceValue;
  const high = targetNiValue + toleranceValue;
  let count = 0;
  let minimumE = null;
  let withinToleranceAtMinimumE = 0;

  function rec(idx, numerator, tonnage, fullyUnusedCount) {
    if (idx === groupStatesList.length) {
      if (numerator - low * tonnage >= 0 && numerator - high * tonnage <= 0) {
        count += 1;
        if (minimumE === null || fullyUnusedCount < minimumE) {
          minimumE = fullyUnusedCount;
          withinToleranceAtMinimumE = 1;
        } else if (fullyUnusedCount === minimumE) {
          withinToleranceAtMinimumE += 1;
        }
      }
      return;
    }
    groupStatesList[idx].forEach((state) => {
      rec(idx + 1, numerator + state.numerator, tonnage + state.tonnage, fullyUnusedCount + state.fullyUnusedCount);
    });
  }

  rec(0, 0, 0, 0);
  return { count, minimumE, withinToleranceAtMinimumE };
}

// V3.0 Phase 6K -- brute-force oracle for minimumE -> minimumF -> exact
// survivor count, extending bruteForceFullUtilizationChemistryCount() above
// with the REAL production simplifyUnitRatio()/simplicityKey()
// (fleet-allocation.js, called via exactSimplicityKeyForCombinedPrimitive()/
// compareHopperSimplicityKeys() below -- themselves thin wrappers, never a
// reimplementation) applied to the exact accumulated higherUnits/lgloUnits
// totals. Small/medium scenarios ONLY (this is the same
// O(product of all group counts) traversal Phase 6K's own signature
// aggregation exists to avoid at D/E scale) -- safe up to C's 161,051-leaf
// full Cartesian traversal, never attempted at D's 51,325,051 or E's
// ~1.22B.
export function bruteForceFullUtilizationHopperFCount(groupStatesList, targetNiValue, toleranceValue) {
  const low = targetNiValue - toleranceValue;
  const high = targetNiValue + toleranceValue;
  let minimumE = null;
  let minimumF = null;
  let countAtMinimumEAndF = 0;

  function rec(idx, numerator, tonnage, fullyUnusedCount, higherUnits, lgloUnits) {
    if (idx === groupStatesList.length) {
      if (numerator - low * tonnage >= 0 && numerator - high * tonnage <= 0) {
        if (minimumE === null || fullyUnusedCount < minimumE) {
          minimumE = fullyUnusedCount;
          minimumF = null;
          countAtMinimumEAndF = 0;
        }
        if (fullyUnusedCount === minimumE) {
          const key = exactSimplicityKeyForCombinedPrimitive(higherUnits, lgloUnits);
          if (minimumF === null || compareHopperSimplicityKeys(key, minimumF) < 0) {
            minimumF = key;
            countAtMinimumEAndF = 1;
          } else if (compareHopperSimplicityKeys(key, minimumF) === 0) {
            countAtMinimumEAndF += 1;
          }
        }
      }
      return;
    }
    groupStatesList[idx].forEach((state) => {
      rec(idx + 1, numerator + state.numerator, tonnage + state.tonnage, fullyUnusedCount + state.fullyUnusedCount, higherUnits + state.higherUnits, lgloUnits + state.lgloUnits);
    });
  }

  rec(0, 0, 0, 0, 0, 0);
  return { minimumE, minimumF, countAtMinimumEAndF };
}

// V3.0 Phase 6J PROTOTYPE ENTRY POINT -- builds the full MITM chemistry+E
// feasibility report for one scenario, WITHOUT ever traversing the full
// Cartesian product (this task's own primary deliverable). NEVER call from
// production code.
export function computeMitmChemistryFeasibility({ targetNi, tolerance = DEFAULT_RECOMMENDATION_TOLERANCE, sources }) {
  const prepared = prepareSourceLazySearch({ targetNi, tolerance, sources });
  if (!prepared.ok) return { ok: false, result: prepared.result };
  const { groups, groupFleets, targetNiValue, toleranceValue } = prepared;

  const t0 = process.hrtime.bigint();
  const memBefore = process.memoryUsage().heapUsed;

  const groupStatesList = groups.map((g, i) => buildGroupFullUtilizationStates(g, groupFleets[i]));
  const perGroupStateCounts = groupStatesList.map((s) => s.length);
  const totalCartesianCombinations = perGroupStateCounts.reduce((a, b) => a * b, 1);

  const { leftIndices, rightIndices } = balanceContractorGroupsForMitm(perGroupStateCounts);
  const leftStates = withChemistryScores(buildAggregateHalfStates(leftIndices, groupStatesList), targetNiValue, toleranceValue);
  const rightStates = withChemistryScores(buildAggregateHalfStates(rightIndices, groupStatesList), targetNiValue, toleranceValue);

  const withinToleranceCount = countWithinToleranceMITM(leftStates, rightStates);
  const { minimumE: minimumFeasibleE, count: withinToleranceAtMinimumE } = findMinimumFeasibleE(leftStates, rightStates);

  const t1 = process.hrtime.bigint();
  const memAfter = process.memoryUsage().heapUsed;

  return {
    ok: true,
    groups,
    groupFleets,
    groupStatesList,
    leftIndices,
    rightIndices,
    leftStates,
    rightStates,
    targetNiValue,
    toleranceValue,
    metrics: {
      totalCartesianCombinations,
      perGroupStateCounts,
      leftStateCount: leftStates.length,
      rightStateCount: rightStates.length,
      withinToleranceCount,
      minimumFeasibleE,
      withinToleranceAtMinimumE,
      chemistryReductionPct: totalCartesianCombinations > 0
        ? 100 * (1 - withinToleranceCount / totalCartesianCombinations)
        : null,
      eReductionPct: withinToleranceCount > 0
        ? 100 * (1 - withinToleranceAtMinimumE / withinToleranceCount)
        : null,
      runtimeMs: Number(t1 - t0) / 1e6,
      heapDeltaBytes: memAfter - memBefore,
    },
  };
}

// ============================================================
// V3.0 Phase 6K -- EXACT HOPPER-F SIGNATURE AGGREGATION (this task's own
// spec). Phase 6J proved the chemistry+E join is exact and sub-Cartesian but
// left D's E-optimal survivor set at 6,858,982 -- still far too large for
// candidate reconstruction. This section proves ranking rule F
// (recommendation-ranking.js's compareSimplicity(), which scores
// simplicityKey(simplifyUnitRatio(higherGradeUnits, lgloUnits)) --
// fleet-allocation.js's own GLOBAL, gcd-reduced-ONLY-ONCE-at-the-end
// active-unit ratio; see blending-recommendation.js's buildCandidate() lines
// ~224-231, which build higherGradeUnits/lgloUnits as plain sums over EVERY
// active source regardless of Contractor/group) is EXACTLY composable from
// the same additive per-half primitive Phase 6J already carries for E
// (fullyUnusedCount):
//   simplicityKey(fullCandidate)
//     = simplicityKey(simplifyUnitRatio(
//         left.higherUnits + right.higherUnits,
//         left.lgloUnits + right.lgloUnits))
// exactly -- NEVER an approximation, and NEVER gcd-reduced per half (see
// buildGroupFullUtilizationStates()'s own comment above for why that would
// silently diverge from production). PROOF:
// tests/v3-phase6k-hopper-signature-aggregation.test.mjs cross-checks this
// against real buildCandidate()+compareSimplicity() production output on
// many small scenarios, including a reproduction of the Phase 6E
// non-monotonic "best key is an interior choice, not a corner" counterexample
// (tests/v3-phase6e-extended-bounds-proof.test.mjs Part 2).
// ============================================================

// Compact composable signature: the RAW (never per-half-reduced) additive
// primitive pair itself. Two aggregate half-states sharing a signature are,
// for rule-F purposes ONLY, fully interchangeable substitutes for whichever
// OTHER half they get joined against -- their combined simplicityKey will
// always be identical regardless of their (possibly very different)
// chemistry numerator/tonnage.
export function hopperSignatureKeyOf(state) {
  return `${state.higherUnits}:${state.lgloUnits}`;
}

// Exact production rule-F key for one already-COMBINED primitive --
// byte-for-byte the same two calls compareSimplicity() itself makes
// (recommendation-ranking.js), just fed the MITM-composed totals instead of
// one candidate's own unitRatio. Returns null only in the defensive
// higherUnits===lgloUnits===0 case (cannot occur for a real within-tolerance
// full-utilization candidate, since totalActiveUnits>0 is guaranteed).
export function exactSimplicityKeyForCombinedPrimitive(higherUnits, lgloUnits) {
  const ratio = simplifyUnitRatio(higherUnits, lgloUnits);
  return ratio ? simplicityKey(ratio) : null;
}

// Same ordering compareSimplicity() itself uses (recommendation-ranking.js
// lines 55-62), applied directly to two already-computed keys -- a
// numerically smaller key is simpler/better; 0 means a true tie.
export function compareHopperSimplicityKeys(ka, kb) {
  for (let i = 0; i < ka.length; i += 1) {
    if (ka[i] !== kb[i]) return ka[i] - kb[i];
  }
  return 0;
}

// Groups a list of aggregate half-states by their Hopper signature (this
// task's own Section 4 "group LEFT/RIGHT states by their Hopper primitive
// signature"). Purely a state-space reduction -- this task's own Section 7
// warns distinct signatures may still reduce to the SAME final key, so this
// grouping is never assumed to already be the final F partition.
export function groupStatesByHopperSignature(states) {
  const map = new Map();
  states.forEach((state) => {
    const key = hopperSignatureKeyOf(state);
    if (!map.has(key)) map.set(key, { higherUnits: state.higherUnits, lgloUnits: state.lgloUnits, states: [] });
    map.get(key).states.push(state);
  });
  return map;
}

// Every (eLeft, eRight) split whose two E-buckets are BOTH non-empty and sum
// to `eTotal` -- the exact same set findMinimumFeasibleE() already sums
// counts over (bucketByFullyUnusedCount is this same module's own
// unexported helper, reused verbatim here, never reimplemented).
function statesAtExactETotal(leftStates, rightStates, eTotal) {
  const leftBuckets = bucketByFullyUnusedCount(leftStates);
  const rightBuckets = bucketByFullyUnusedCount(rightStates);
  const splits = [];
  [...leftBuckets.keys()].forEach((eLeft) => {
    const eRight = eTotal - eLeft;
    if (rightBuckets.has(eRight)) splits.push({ eLeft, eRight, left: leftBuckets.get(eLeft), right: rightBuckets.get(eRight) });
  });
  return splits;
}

// V3.0 Phase 6K SECTION 4 -- opportunity measurement, BEFORE any candidate
// reconstruction: raw state counts vs distinct Hopper-signature counts,
// restricted to E=minimumFeasibleE only (this task's own Section 4 scope).
// Every (eLeft,eRight) split's own bucket is disjoint from every other
// split's (eLeft uniquely determines eRight=minE-eLeft, and
// bucketByFullyUnusedCount partitions each side by its OWN fixed E value),
// so simple concatenation across splits never double-counts a state.
export function computeHopperSignatureOpportunity(report) {
  const { leftStates, rightStates, metrics } = report;
  const minimumFeasibleE = metrics.minimumFeasibleE;
  if (minimumFeasibleE === null) return { ok: false, reason: 'NO_FEASIBLE_E' };

  const splits = statesAtExactETotal(leftStates, rightStates, minimumFeasibleE);

  const leftStatesAtMinE = splits.flatMap((s) => s.left);
  const rightStatesAtMinE = splits.flatMap((s) => s.right);

  const leftSignatureMap = groupStatesByHopperSignature(leftStatesAtMinE);
  const rightSignatureMap = groupStatesByHopperSignature(rightStatesAtMinE);

  return {
    ok: true,
    minimumFeasibleE,
    splits,
    leftStatesAtMinE,
    rightStatesAtMinE,
    leftSignatureMap,
    rightSignatureMap,
    metrics: {
      rawLeftStates: leftStatesAtMinE.length,
      rawRightStates: rightStatesAtMinE.length,
      distinctLeftSignatures: leftSignatureMap.size,
      distinctRightSignatures: rightSignatureMap.size,
      theoreticalSignaturePairCount: leftSignatureMap.size * rightSignatureMap.size,
    },
  };
}

// V3.0 Phase 6K SECTIONS 5-7 -- exact Hopper-aware chemistry join: for every
// signature pair that is ACTUALLY chemistry-feasible at E=minimumFeasibleE
// (checked with the existing exact Phase 6J countWithinToleranceMITM(),
// never a Cartesian left x right scan), derive the exact combined rule-F key
// and its exact within-tolerance pair count, then reduce to the global
// minimum F and its exact survivor count. Iterates per (eLeft,eRight) split
// x per signature pair within that split -- both dimensions are already
// reduced far below the raw state count; no individual combination is ever
// visited, only its SIGNATURE-BUCKET is.
export function computeHopperAwareMinimumF(report) {
  const opportunity = computeHopperSignatureOpportunity(report);
  if (!opportunity.ok) return opportunity;

  // One entry per (eLeft, sigLeft, sigRight) triple that is actually
  // chemistry-feasible -- pairwise DISJOINT by construction (eLeft
  // partitions left states by E; sigLeft/sigRight further partition within
  // that split), so summing `pairCount` across entries never double-counts a
  // state pair (this task's own Section 7 "avoid double counting state
  // pairs").
  const feasibleEntries = [];

  opportunity.splits.forEach(({ eLeft, left, right }) => {
    const leftSig = groupStatesByHopperSignature(left);
    const rightSig = groupStatesByHopperSignature(right);
    leftSig.forEach((bucketL, sigKeyL) => {
      rightSig.forEach((bucketR, sigKeyR) => {
        const pairCount = countWithinToleranceMITM(bucketL.states, bucketR.states);
        if (pairCount === 0) return;
        const key = exactSimplicityKeyForCombinedPrimitive(
          bucketL.higherUnits + bucketR.higherUnits,
          bucketL.lgloUnits + bucketR.lgloUnits,
        );
        // V3.0 Phase 6L -- `leftStates`/`rightStates` (the actual raw
        // full-utilization state arrays behind this signature bucket, NOT
        // just their count) are retained here so a later stage (G/H/I/J)
        // can keep narrowing WITHOUT re-deriving this same E+F-feasible
        // partition from scratch. Cheap: these are array REFERENCES into
        // bucketL.states/bucketR.states (Phase 6K, unchanged), never a
        // copy, and only entries with pairCount>0 are ever pushed here --
        // already far below the raw E-optimal survivor count.
        feasibleEntries.push({
          eLeft, sigKeyL, sigKeyR, key, pairCount, leftStates: bucketL.states, rightStates: bucketR.states,
        });
      });
    });
  });

  if (feasibleEntries.length === 0) return { ok: false, reason: 'NO_FEASIBLE_SIGNATURE_PAIR' };

  const minimumFeasibleSimplicityKey = feasibleEntries.reduce(
    (best, entry) => (compareHopperSimplicityKeys(entry.key, best) < 0 ? entry.key : best),
    feasibleEntries[0].key,
  );

  const winningEntries = feasibleEntries.filter(
    (entry) => compareHopperSimplicityKeys(entry.key, minimumFeasibleSimplicityKey) === 0,
  );

  const withinToleranceAtMinimumEAndF = winningEntries.reduce((sum, entry) => sum + entry.pairCount, 0);

  return {
    ok: true,
    minimumFeasibleE: opportunity.minimumFeasibleE,
    minimumFeasibleSimplicityKey,
    withinToleranceAtMinimumE: report.metrics.withinToleranceAtMinimumE,
    withinToleranceAtMinimumEAndF,
    feasibleSignaturePairCount: feasibleEntries.length,
    // V3.0 Phase 6L -- entries tied for the minimum F key ONLY (never the
    // full `feasibleEntries` list), each still carrying its own
    // leftStates/rightStates for Stage G below.
    winningEntries,
    opportunity: opportunity.metrics,
  };
}

// ============================================================
// V3.0 Phase 6L -- EXACT FINAL MITM RANKING SOLVER (this task's own spec).
// Phase 6K narrowed D's E-optimal 6,858,982 survivors to
// withinToleranceAtMinimumEAndF (also E+F optimal) using ONLY additive
// per-half primitives (fullyUnusedCount, higherUnits/lgloUnits) plus the
// exact chemistry join -- never a Cartesian reconstruction. This section
// carries that SAME technique through the remaining production ranking
// chain (recommendation-ranking.js's compareWithinTolerance, UNCHANGED,
// rules G/H/I/J):
//   G. totalMovedUnits    (ascending, additive  -- Phase 6E's own proof)
//   H. absoluteDeviation  (ascending, NOT additive -- a ratio of two sums)
//   I. activeSourceCount  (ascending, additive  -- Phase 6E's own proof)
//   J. allocationSignature (deterministic tie-break -- production's own
//      compareTieBreak(), never reimplemented)
//
// ---- G: ADDITIVE, REUSES THE E-STAGE PATTERN ----
// movedUnits (added to each per-group full-utilization state above) is a
// plain per-source additive accumulator with the identical "no cross-source
// interaction, once decided it only grows" shape as fullyUnusedCount --
// Phase 6E's minPossibleFinalRelocation() already proves this exact/tight;
// this file's own PHASE 6L state-augmentation comment above additionally
// re-derives WHY the per-GROUP sum Sum(max(0,v-assignedUnits)) exactly
// equals that group's own planContractorRelocations() total for every
// FULL-UTILIZATION state specifically (Sum(v)===Sum(assignedUnits) whenever
// the group is operational, so donor capacity and receiver need are exactly
// equal, not merely donor>=receiver -- fleet-allocation.js's own comment).
// findMinimumFeasibleAdditiveTotal() below is the exact SAME
// bucket-by-integer / ascending-total-scan / MITM-count-per-split algorithm
// findMinimumFeasibleE() (Phase 6J, unchanged) already uses for E --
// generalized to any additive per-state integer primitive so it is reused,
// not reimplemented, for both G and I.
//
// ---- H: NOT ADDITIVE -- DIRECT ENUMERATION OF THE (BY NOW TINY) SURVIVOR SET ----
// estimatedNi = N/T is a ratio, not a sum, so no additive-total scan
// applies. This task's own Section 3 offers an "exact nearest-target MITM
// query... if the survivor space is still large" as an alternative --
// findMinimumAbsoluteDeviationAmongPairs() below instead takes the
// task's own explicit fallback ("STOP" -- i.e. do not build an unproven
// clever structure -- if a simpler safe approach already suffices) and
// directly scans every surviving pair once E, F, AND G are ALL already
// fixed at their global optimum, which is a genuinely SMALL set by this
// point (measured, not assumed -- diagnostics.hPairsScanned, reported
// honestly by findExactFinalRankingWinner() below for every scenario, C/D/E
// included). Each scanned pair is re-checked against the exact Section 3
// chemistry join (lowScore/highScore, unchanged) before its Ni is trusted --
// a G-optimal bucket pair having countWithinToleranceMITM()>0 only proves
// SOME pair in it is within tolerance, never that EVERY pair in it is.
//
// ---- I: ADDITIVE, SAME PATTERN AS G ----
// activeSourceCount (added to each state above) is Phase 6E's own
// minPossibleFinalActiveSourceCount()-proven additive accumulator; selected
// by a plain min-scan over the (already H-optimal, hence tiny) tied pair
// set -- no MITM machinery needed at this size.
//
// ---- J: REAL PRODUCTION COMPARATOR, NEVER REIMPLEMENTED ----
// findExactFinalRankingWinner() reconstructs a REAL buildCandidate() for
// ONLY the I-optimal tied pairs (this task's own "reconstruct ONLY the
// final winner, or a tiny tied set if mathematically necessary"), then
// sorts that tiny set with the imported, unchanged compareWithinTolerance()
// -- since A-I are already proven tied across this set, that sort's only
// remaining job is rule J (compareTieBreak's allocationSignature ordering),
// but running the REAL comparator end-to-end (rather than hand-reimplementing
// just rule J) is simultaneously this task's own Section 12 "final
// verification boundary": if any earlier stage's own reasoning were wrong,
// the real comparator would expose it here rather than silently agreeing.
// ============================================================

// Generic reusable version of findMinimumFeasibleE()'s own bucket-by-integer
// / ascending-total-scan / per-split MITM-count pattern (Phase 6J,
// unchanged there), parameterized by an arbitrary non-negative-integer
// additive per-state primitive `keyFn`. Reused for G (movedUnits) and I is
// NOT run through this (I's own tied set is already tiny by the time it is
// reached -- see PHASE 6L ANALYSIS above), so this is currently used for G
// only, but kept generic/exported so a future phase never needs a second
// copy of this scan for another additive rule.
export function bucketByIntegerKey(states, keyFn) {
  const buckets = new Map();
  states.forEach((state) => {
    const k = keyFn(state);
    if (!buckets.has(k)) buckets.set(k, []);
    buckets.get(k).push(state);
  });
  return buckets;
}

export function findMinimumFeasibleAdditiveTotal(leftStates, rightStates, keyFn) {
  const leftBuckets = bucketByIntegerKey(leftStates, keyFn);
  const rightBuckets = bucketByIntegerKey(rightStates, keyFn);
  const leftKeys = [...leftBuckets.keys()].sort((a, b) => a - b);
  const rightKeys = [...rightBuckets.keys()];
  if (leftKeys.length === 0 || rightKeys.length === 0) return { minimumTotal: null, splits: [] };
  const maxTotal = Math.max(...leftKeys) + Math.max(...rightKeys);

  for (let total = 0; total <= maxTotal; total += 1) {
    const splits = [];
    leftKeys.forEach((kLeft) => {
      const kRight = total - kLeft;
      if (!rightBuckets.has(kRight)) return;
      const left = leftBuckets.get(kLeft);
      const right = rightBuckets.get(kRight);
      const count = countWithinToleranceMITM(left, right);
      if (count > 0) splits.push({
        kLeft, kRight, left, right, count,
      });
    });
    if (splits.length > 0) return { minimumTotal: total, splits };
  }
  return { minimumTotal: null, splits: [] };
}

// V3.0 Phase 6L STAGE G -- global minimum totalMovedUnits across EVERY
// E+F-optimal entry (hopperF.winningEntries, Phase 6K, unchanged), each
// searched independently (an entry's own leftStates/rightStates are only
// ever paired with EACH OTHER, never with a sibling entry's -- each entry
// is its own distinct (eLeft,sigKeyL,sigKeyR) triple) then combined by a
// plain min-across-entries reduction, since the entries themselves are
// already pairwise disjoint (Phase 6K's own "no double counting" proof).
export function computeMinimumFeasibleG(winningEntries) {
  let minimumG = null;
  let splits = [];
  winningEntries.forEach((entry) => {
    const g = findMinimumFeasibleAdditiveTotal(entry.leftStates, entry.rightStates, (s) => s.movedUnits);
    if (g.minimumTotal === null) return;
    if (minimumG === null || g.minimumTotal < minimumG) {
      minimumG = g.minimumTotal;
      splits = g.splits;
    } else if (g.minimumTotal === minimumG) {
      splits = splits.concat(g.splits);
    }
  });
  return { minimumG, splits };
}

// V3.0 Phase 6L STAGE H -- see PHASE 6L ANALYSIS above for why this is a
// direct (never MITM-structured) scan: Ni is not additive, and the
// survivor set here (G-optimal splits' own left/right state arrays) is
// empirically small by this point. Every pair is re-validated against the
// exact Section 3 join before its Ni is trusted (a bucket pair's own
// countWithinToleranceMITM()>0 only certifies SOME pair qualifies, not
// every pair in it).
export function findMinimumAbsoluteDeviationAmongPairs(splits, targetNiValue) {
  let minimumDeviation = null;
  let winners = [];
  let pairsScanned = 0;
  splits.forEach(({ left, right }) => {
    left.forEach((l) => {
      right.forEach((r) => {
        pairsScanned += 1;
        if (l.lowScore + r.lowScore < 0 || l.highScore + r.highScore > 0) return;
        const tonnage = l.tonnage + r.tonnage;
        const ni = (l.numerator + r.numerator) / tonnage;
        const deviation = Math.abs(ni - targetNiValue);
        if (minimumDeviation === null || deviation < minimumDeviation) {
          minimumDeviation = deviation;
          winners = [{ left: l, right: r }];
        } else if (deviation === minimumDeviation) {
          winners.push({ left: l, right: r });
        }
      });
    });
  });
  return { minimumDeviation, winners, pairsScanned };
}

// V3.0 Phase 6L STAGE I -- plain additive min-scan over the (already
// H-optimal, hence tiny) tied pair set. No MITM structure needed at this
// size (this task's own "no other optimization needed once the survivor
// set is already this small").
export function selectMinimumActiveSourceCountPairs(pairs) {
  let minimumI = null;
  let winners = [];
  pairs.forEach((pair) => {
    const i = pair.left.activeSourceCount + pair.right.activeSourceCount;
    if (minimumI === null || i < minimumI) {
      minimumI = i;
      winners = [pair];
    } else if (i === minimumI) {
      winners.push(pair);
    }
  });
  return { minimumI, winners };
}

// V3.0 Phase 6L PROTOTYPE ENTRY POINT -- the full E->F->G->H->I->J exact
// solver, WITHOUT ever reconstructing the full Cartesian survivor set
// (this task's own primary deliverable/success condition 1). Only the
// FINAL I-optimal tied pairs (expected to be a tiny set) are ever turned
// into real buildCandidate() objects. NEVER call from production code.
export function findExactFinalRankingWinner({ targetNi, tolerance = DEFAULT_RECOMMENDATION_TOLERANCE, sources }) {
  const prepared = prepareSourceLazySearch({ targetNi, tolerance, sources });
  if (!prepared.ok) return { ok: false, result: prepared.result };
  const { groups, groupFleets, targetNiValue, toleranceValue } = prepared;

  const t0 = process.hrtime.bigint();
  const memBefore = process.memoryUsage().heapUsed;

  const groupStatesList = groups.map((g, i) => buildGroupFullUtilizationStates(g, groupFleets[i]));
  const perGroupStateCounts = groupStatesList.map((s) => s.length);
  const totalCartesianCombinations = perGroupStateCounts.reduce((a, b) => a * b, 1);

  const { leftIndices, rightIndices } = balanceContractorGroupsForMitm(perGroupStateCounts);
  const leftStates = withChemistryScores(buildAggregateHalfStates(leftIndices, groupStatesList), targetNiValue, toleranceValue);
  const rightStates = withChemistryScores(buildAggregateHalfStates(rightIndices, groupStatesList), targetNiValue, toleranceValue);

  const withinToleranceCount = countWithinToleranceMITM(leftStates, rightStates);
  if (withinToleranceCount === 0) {
    return {
      ok: true,
      status: 'NO_WITHIN_TOLERANCE_CANDIDATE',
      candidate: null,
      funnel: { totalCartesianCombinations, withinToleranceCount },
    };
  }

  const eResult = findMinimumFeasibleE(leftStates, rightStates);
  const hopperF = computeHopperAwareMinimumF({
    leftStates,
    rightStates,
    metrics: { minimumFeasibleE: eResult.minimumE, withinToleranceAtMinimumE: eResult.count },
  });
  if (!hopperF.ok) {
    return {
      ok: true, status: 'NO_FEASIBLE_F', candidate: null, funnel: { totalCartesianCombinations, withinToleranceCount, eResult },
    };
  }

  const gResult = computeMinimumFeasibleG(hopperF.winningEntries);
  if (gResult.minimumG === null) {
    return {
      ok: true, status: 'NO_FEASIBLE_G', candidate: null, funnel: { totalCartesianCombinations, withinToleranceCount, eResult, hopperF },
    };
  }

  const hResult = findMinimumAbsoluteDeviationAmongPairs(gResult.splits, targetNiValue);
  if (hResult.minimumDeviation === null) {
    return {
      ok: true, status: 'NO_FEASIBLE_H', candidate: null, funnel: { totalCartesianCombinations, withinToleranceCount, eResult, hopperF, gResult },
    };
  }

  const iResult = selectMinimumActiveSourceCountPairs(hResult.winners);

  const finalCandidates = iResult.winners
    .map((pair) => {
      const activeMap = buildActiveMapFromChoices(groups, groupStatesList, [...pair.left.choices, ...pair.right.choices]);
      return buildCandidate(groups, activeMap, targetNiValue, toleranceValue);
    })
    .filter(Boolean);
  finalCandidates.sort(compareWithinTolerance);
  const candidate = finalCandidates[0] ?? null;

  const t1 = process.hrtime.bigint();
  const memAfter = process.memoryUsage().heapUsed;

  return {
    ok: true,
    status: candidate ? 'OK' : 'NO_FEASIBLE_CANDIDATE',
    candidate,
    funnel: {
      totalCartesianCombinations,
      withinToleranceCount,
      minimumFeasibleE: eResult.minimumE,
      withinToleranceAtMinimumE: eResult.count,
      minimumFeasibleSimplicityKey: hopperF.minimumFeasibleSimplicityKey,
      withinToleranceAtMinimumEAndF: hopperF.withinToleranceAtMinimumEAndF,
      minimumFeasibleG: gResult.minimumG,
      hPairsScanned: hResult.pairsScanned,
      minimumFeasibleH: hResult.minimumDeviation,
      hTieCount: hResult.winners.length,
      minimumFeasibleI: iResult.minimumI,
      iTieCount: iResult.winners.length,
      finalReconstructedCount: finalCandidates.length,
    },
    metrics: {
      runtimeMs: Number(t1 - t0) / 1e6,
      heapDeltaBytes: memAfter - memBefore,
    },
  };
}

// V3.0 Phase 6L -- brute-force full-utilization Cartesian oracle: for SMALL
// scenarios only, reconstructs EVERY full-utilization combination into a
// REAL buildCandidate() and picks the winner with the REAL, unchanged
// compareWithinTolerance() -- the independent ground truth
// findExactFinalRankingWinner() above is differentially proven against
// (this task's mandatory Section 8 brute-force proof). O(product of all
// group state counts) -- never used above small/C scale.
export function bruteForceFullUtilizationFinalWinner(groups, groupStatesList, targetNiValue, toleranceValue) {
  let best = null;
  function rec(idx, choices) {
    if (idx === groupStatesList.length) {
      const activeMap = buildActiveMapFromChoices(groups, groupStatesList, choices);
      const candidate = buildCandidate(groups, activeMap, targetNiValue, toleranceValue);
      if (candidate && candidate.withinTolerance && (best === null || compareWithinTolerance(candidate, best) < 0)) {
        best = candidate;
      }
      return;
    }
    groupStatesList[idx].forEach((_, stateIndex) => {
      rec(idx + 1, [...choices, { groupIndex: idx, stateIndex }]);
    });
  }
  rec(0, []);
  return best;
}
