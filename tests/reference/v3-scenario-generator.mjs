// V3.0 Phase 1 -- directed + randomized small-scenario generator for the
// differential test harness (tests/v3-differential.test.mjs). Produces
// tractable inputs for findBlendRecommendations()/
// findBlendRecommendationsReference() (small enough that the current
// exhaustive V2.x engine finishes comfortably -- this task's Section 18)
// while deliberately cycling through the domain-coverage categories this
// task's Section 19 requires, rather than relying on uniform randomness
// alone.
//
// This file is a test-input generator, not part of the frozen oracle --
// it implements zero Recommendation business rules of its own, so it may
// be extended freely as later phases need more coverage categories.
import { randInt, pick, shuffle } from './seeded-random.mjs';

const LGLO_NI = [0.85, 0.95, 1.0, 1.1, 1.15, 1.19];
const MGLO_NI = [1.2, 1.25, 1.3, 1.35, 1.4];
const HGLO_NI = [1.41, 1.45, 1.55, 1.65, 1.8];
const ALL_NI = [...LGLO_NI, ...MGLO_NI, ...HGLO_NI];
const TONNES_PER_UNIT = [30, 35, 40, 45, 50, 55, 60];
const TOLERANCES = [0, 0.005, 0.01, 0.02];
const CONTRACTOR_LETTERS = ['A', 'B', 'C'];

function makeSource(contractorLetter, sourceIndex, ni, units, tonnesPerUnit) {
  return {
    pileId: `P${contractorLetter}${sourceIndex}`,
    contractor: `CTR-${contractorLetter}`,
    ni: String(ni),
    units: String(units),
    tonnesPerUnit: String(tonnesPerUnit),
  };
}

function buildContractorSources(rng, letter, sourceCount, fleetRange, niPool) {
  const sources = [];
  for (let i = 1; i <= sourceCount; i += 1) {
    const ni = pick(rng, niPool);
    const units = randInt(rng, fleetRange[0], fleetRange[1]);
    const tonnesPerUnit = pick(rng, TONNES_PER_UNIT);
    sources.push(makeSource(letter, i, ni, units, tonnesPerUnit));
  }
  return sources;
}

function weightedAverageNi(sources) {
  let num = 0;
  let den = 0;
  sources.forEach((s) => {
    const tonnage = Number(s.units) * Number(s.tonnesPerUnit);
    num += Number(s.ni) * tonnage;
    den += tonnage;
  });
  return den > 0 ? num / den : ALL_NI[0];
}

const KINDS = [
  'single-contractor-single-source',
  'single-contractor-two-domes',
  'multi-contractor-2',
  'multi-contractor-3',
  'legacy-1-5-dt',
  'boundary-6-dt',
  'mixed-tonnes',
  'target-unachievable',
  'near-tie',
  'lglo-mglo-blend',
  'lglo-hglo-blend',
  'all-higher-grade',
];

// Deterministic: same (seed, index) -> same scenario, forever.
export function generateScenario(rng, index) {
  const kind = KINDS[index % KINDS.length];
  let sources;

  switch (kind) {
    case 'single-contractor-single-source': {
      sources = buildContractorSources(rng, 'A', 1, [6, 8], ALL_NI);
      break;
    }
    case 'single-contractor-two-domes': {
      sources = buildContractorSources(rng, 'A', 2, [2, 6], ALL_NI);
      break;
    }
    case 'multi-contractor-2': {
      sources = [
        ...buildContractorSources(rng, 'A', randInt(rng, 1, 2), [2, 5], ALL_NI),
        ...buildContractorSources(rng, 'B', randInt(rng, 1, 2), [2, 5], ALL_NI),
      ];
      break;
    }
    case 'multi-contractor-3': {
      sources = CONTRACTOR_LETTERS.flatMap((letter) => buildContractorSources(rng, letter, 1, [2, 4], ALL_NI));
      break;
    }
    case 'legacy-1-5-dt': {
      // Fleet deliberately capped at 5 so activeUnits can never reach the
      // 6-DT operational threshold -- exercises the current legacy edge
      // case (this task's Section 9/22): a 1-5 DT active loading point can
      // still WIN when it is the only within-tolerance option.
      sources = buildContractorSources(rng, 'A', randInt(rng, 1, 2), [1, 5], ALL_NI);
      break;
    }
    case 'boundary-6-dt': {
      // Fleet straddling the 5/6 boundary so both an invalid (<=5) and a
      // valid (>=6) active allocation are reachable in the same search.
      sources = buildContractorSources(rng, 'A', 1, [6, 7], ALL_NI);
      break;
    }
    case 'mixed-tonnes': {
      const s1 = makeSource('A', 1, pick(rng, ALL_NI), randInt(rng, 2, 5), pick(rng, TONNES_PER_UNIT));
      const s2 = makeSource('A', 2, pick(rng, ALL_NI), randInt(rng, 2, 5), pick(rng, TONNES_PER_UNIT));
      sources = [s1, s2];
      break;
    }
    case 'target-unachievable': {
      sources = buildContractorSources(rng, 'A', randInt(rng, 1, 2), [2, 6], MGLO_NI);
      break;
    }
    case 'near-tie': {
      // Two same-Contractor sources sharing identical Ni/Tonnes-per-DT --
      // only Pile ID differs, which drives the deterministic tie-break.
      const ni = pick(rng, ALL_NI);
      const tpu = pick(rng, TONNES_PER_UNIT);
      const units = randInt(rng, 3, 6);
      sources = [makeSource('A', 1, ni, units, tpu), makeSource('A', 2, ni, units, tpu)];
      break;
    }
    case 'lglo-mglo-blend': {
      sources = [
        buildContractorSources(rng, 'A', 1, [3, 6], LGLO_NI)[0],
        buildContractorSources(rng, 'B', 1, [3, 6], MGLO_NI)[0],
      ];
      break;
    }
    case 'lglo-hglo-blend': {
      sources = [
        buildContractorSources(rng, 'A', 1, [3, 6], LGLO_NI)[0],
        buildContractorSources(rng, 'B', 1, [3, 6], HGLO_NI)[0],
      ];
      break;
    }
    case 'all-higher-grade': {
      sources = buildContractorSources(rng, 'A', randInt(rng, 1, 2), [2, 6], [...MGLO_NI, ...HGLO_NI]);
      break;
    }
    default:
      throw new Error(`unreachable scenario kind: ${kind}`);
  }

  const tolerance = pick(rng, TOLERANCES);
  let targetNi;
  if (kind === 'target-unachievable') {
    // Deliberately far outside anything the chosen (MGLO-only) source pool
    // can reach.
    targetNi = pick(rng, [0.3, 0.4, 2.6, 2.8]);
  } else {
    const avg = weightedAverageNi(sources);
    // Small deterministic jitter around the achievable weighted average so
    // both "exactly reached" and "near boundary" targets occur.
    const jitter = (randInt(rng, -20, 20) / 1000);
    targetNi = Math.max(0.01, Number((avg + jitter).toFixed(3)));
  }

  return {
    name: `${kind}#${index}`,
    kind,
    input: { targetNi: String(targetNi), tolerance: String(tolerance), sources },
  };
}

// A deterministic reordering of a scenario's sources (this task's Section
// 22 -- source-order independence). Reverses array order and also swaps
// each pair's field-population order is unnecessary (objects, not
// arrays); reversing is sufficient to prove candidate construction does
// not depend on input order, since groupSourcesByContractor() is
// responsible for re-establishing canonical order regardless.
export function permuteScenarioSources(scenario, rng) {
  return {
    ...scenario,
    name: `${scenario.name}+permuted`,
    input: { ...scenario.input, sources: shuffle(rng, scenario.input.sources) },
  };
}
