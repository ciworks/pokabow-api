/** Tile generator compatible with Pokabow's Godot 4.6 rules version 5. */
export type Tile = {
  schema_version: 4;
  tile_id: string;
  rank: number;
  face_color: number;
  suit: number;
  edges: number[];
};

const MASK_64 = (1n << 64n) - 1n;
const MASK_32 = (1n << 32n) - 1n;
const MULTIPLIER = 6364136223846793005n;
const DEFAULT_INC = 1442695040888963407n;

// Godot 4.6 RandomPCG uses pcg32_srandom_r with a fixed stream and two
// 32-bit draws for each randf(). Keep this isolated: persisted bags contain
// the full generated tiles, so later RNG changes affect new matches only.
export class GodotPcg32 {
  private state = 0n;
  private readonly increment = ((DEFAULT_INC << 1n) | 1n) & MASK_64;

  constructor(seed: number | bigint) {
    this.nextUint32();
    this.state = (this.state + BigInt(seed)) & MASK_64;
    this.nextUint32();
  }

  nextUint32(): number {
    const previous = this.state;
    this.state = (previous * MULTIPLIER + this.increment) & MASK_64;
    const xorshifted = Number((((previous >> 18n) ^ previous) >> 27n) & MASK_32);
    const rotation = Number(previous >> 59n);
    return ((xorshifted >>> rotation) | (xorshifted << ((-rotation) & 31))) >>> 0;
  }

  nextFloat(): number {
    const exponent = this.nextUint32();
    if (exponent === 0) return 0;
    const significand = (this.nextUint32() | 0x80000001) >>> 0;
    return Math.fround(significand * 2 ** (-32 - Math.clz32(exponent)));
  }

  nextBounded(bound: number): number {
    if (!Number.isInteger(bound) || bound <= 0 || bound > 0xffffffff) throw new RangeError("bound");
    const threshold = (0x100000000 - bound) % bound;
    for (;;) {
      const value = this.nextUint32();
      if (value >= threshold) return value % bound;
    }
  }
}

function weightedIndex(rng: GodotPcg32, weights: readonly number[]): number {
  const roll = rng.nextFloat() * weights.reduce((sum, value) => sum + value, 0);
  let cumulative = 0;
  for (const [index, weight] of weights.entries()) {
    cumulative += weight;
    if (roll < cumulative) return index;
  }
  return weights.length - 1;
}

export function generateTiles(matchId: string, seed: number, count = 52): Tile[] {
  const rng = new GodotPcg32(seed);
  const tiles: Tile[] = [];
  for (let index = 0; index < count; index++) {
    const rank = weightedIndex(rng, [1, 1, 1, 1]);
    const face_color = weightedIndex(rng, [1, 1]);
    const firstSuit = face_color === 0 ? 0 : 2;
    const suit = firstSuit + weightedIndex(rng, [1, 1]);
    const edges = Array.from({ length: 4 }, () => weightedIndex(rng, [1, 1, 1, 1]));
    tiles.push({ schema_version: 4, tile_id: `${matchId}:tile:${String(index).padStart(3, "0")}`,
      rank, face_color, suit, edges });
  }
  return tiles;
}
