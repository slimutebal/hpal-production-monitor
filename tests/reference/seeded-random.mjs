// V3.0 Phase 1 -- tiny deterministic seeded PRNG for the differential test
// harness (tests/v3-differential.test.mjs). No external dependency, no
// Math.random() anywhere. Same seed -> same scenario stream, forever,
// across machines/Node versions (pure integer arithmetic only).
//
// mulberry32 (public-domain algorithm, commonly attributed to Tommy
// Ettinger) -- chosen for being a single small function with well-known,
// widely-verified statistical behavior, not for any project-specific
// reason. Swapping algorithms would still satisfy this module's contract
// as long as the seed->stream mapping stays fixed once chosen; do not
// change it casually since any change reshuffles which scenarios every
// named seed (see NAMED_SEEDS below) actually produces.
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a |= 0;
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Integer in [min, max], inclusive on both ends.
export function randInt(rng, min, max) {
  return Math.floor(rng() * (max - min + 1)) + min;
}

export function pick(rng, array) {
  return array[randInt(rng, 0, array.length - 1)];
}

// Fisher-Yates using the supplied deterministic rng -- never Math.random().
export function shuffle(rng, array) {
  const copy = array.slice();
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = randInt(rng, 0, i);
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

// Named fixed seeds (this task's Section 21) -- preferred over one huge
// random stream so a failure is reproducible by name, not just by a raw
// 32-bit number. Valid uint32 hex literals (hex digits only -- the
// prompt's illustrative "0xV3000001" is not valid hex, since 'V' is not a
// hex digit; these are).
export const NAMED_SEEDS = {
  V3_SEED_A1: 0xA3000001,
  V3_SEED_A2: 0xA3000002,
  V3_SEED_A3: 0xA3000003,
  V3_SEED_A4: 0xA3000004,
  V3_SEED_A5: 0xA3000005,
};
