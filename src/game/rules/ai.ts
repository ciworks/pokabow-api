import { createHash } from "node:crypto";
import { legalMoves, type Candidate } from "./legal-moves.js";
import { scoreLine } from "./score-line.js";
import { GodotPcg32 } from "./tile-source.js";
import type { Snapshot } from "./state.js";
import type { Tile } from "./tile-source.js";

function decisionSeed(snapshot: Snapshot, difficulty: number): bigint {
  const slug = ["easy", "medium", "hard"][difficulty];
  const digest = createHash("sha256")
    .update(`${snapshot.seed}|${snapshot.turn.turn_number}|ai|${slug}`).digest();
  return digest.readBigUInt64BE(0) & 0x7fffffffffffffffn;
}

function tieBreak(seed: bigint, candidate: Candidate): number {
  return createHash("sha256").update(`${seed}|${candidate.key}`).digest().readUInt32BE(0);
}

function score(snapshot: Snapshot, candidate: Candidate) {
  const events = scoreLine(snapshot, "ai", candidate.placements).events;
  const category = (value: number) => events.filter(event => event.category === value)
    .reduce((sum, event) => sum + event.points, 0);
  return [category(0) + category(1) + category(2), category(0), category(2), category(1), events.length];
}

function compareRank(a: number[], b: number[]) {
  for (let index = 0; index < Math.min(a.length, b.length); index++) {
    if (a[index] !== b[index]) return a[index] - b[index];
  }
  return 0;
}
const compareKey = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;

const cellKey = (x: number, y: number) => `${x},${y}`;

function completionCells(board: Snapshot["board"]): Set<string> {
  const occupied = new Set(board.map(tile => cellKey(...tile.cell)));
  const frontier = new Set<string>();
  for (const tile of board) for (const [dx, dy] of [[0, -1], [1, 0], [0, 1], [-1, 0]]) {
    const x = tile.cell[0] + dx, y = tile.cell[1] + dy;
    if (x >= 0 && x < 12 && y >= 0 && y < 12 && !occupied.has(cellKey(x, y))) frontier.add(cellKey(x, y));
  }
  const result = new Set<string>();
  for (const key of frontier) {
    const [x, y] = key.split(",").map(Number);
    for (const [dx, dy] of [[1, 0], [0, 1]]) for (let offset = -4; offset <= 0; offset++) {
      let count = 0, valid = true;
      for (let index = 0; index < 5; index++) {
        const px = x + (offset + index) * dx, py = y + (offset + index) * dy;
        if (px < 0 || px >= 12 || py < 0 || py >= 12) { valid = false; break; }
        if (occupied.has(cellKey(px, py))) count++;
      }
      if (valid && count === 4) result.add(key);
    }
  }
  return result;
}

function sampleTile(index: number): Tile {
  const rotation = index % 4;
  const pattern = [0, 1, 2, 3].map(edge => (Math.floor(index / 4) + edge) % 4);
  return { schema_version: 4, tile_id: `ai-sample:${String(index).padStart(2, "0")}`,
    rank: Math.floor(index / 4), suit: rotation, face_color: rotation < 2 ? 0 : 1,
    edges: pattern.map((_, edge) => pattern[(edge - rotation + 4) % 4]) };
}

function hardChoice(snapshot: Snapshot, candidates: Candidate[], seed: bigint): Candidate {
  const scored = candidates.map(candidate => ({ candidate, rank: score(snapshot, candidate),
    tie: tieBreak(seed, candidate), utility: -Infinity }));
  scored.sort((a, b) => compareRank(b.rank, a.rank) || b.tie - a.tie ||
    compareKey(a.candidate.key, b.candidate.key));
  const before = completionCells(snapshot.board);
  for (const [index, entry] of scored.entries()) {
    const afterBoard = [...snapshot.board, ...entry.candidate.placements.map(placement => ({
      tile_id: placement.tileId, cell: [placement.x, placement.y] as [number, number],
      rotation: placement.rotation,
    }))];
    const after = completionCells(afterBoard);
    const opportunity = Math.max(0, after.size - before.size);
    const threat = [...before].filter(key => after.has(key)).length;
    const edges = scoreLine(snapshot, "ai", entry.candidate.placements).events
      .filter(event => event.category === 1).length;
    let reply = 0;
    if (index < 24) {
      const held = snapshot.decks.human;
      const hands = [held, ...[0, 1, 2].map(sample => [...held, sampleTile(sample).tile_id])];
      for (const [handIndex, hand] of hands.entries()) {
        if (!hand.length) continue;
        const preview: Snapshot = { ...snapshot, board: afterBoard,
          turn: { ...snapshot.turn, active_player_id: "human" },
          decks: { ...snapshot.decks, human: hand },
          scored_hand_ids: [],
          tile_source: { ...snapshot.tile_source,
            tiles: handIndex ? [...snapshot.tile_source.tiles, sampleTile(handIndex - 1)] : snapshot.tile_source.tiles } };
        let bestReply = 0;
        for (const candidate of legalMoves(preview, "human", 8, 3)) {
          const points = score(preview, candidate)[0];
          if (points > bestReply) bestReply = points;
        }
        reply += bestReply;
      }
      reply /= hands.length;
    }
    entry.utility = Math.floor(100 * entry.rank[0] - 70 * reply + 8 * opportunity -
      10 * threat + 2 * edges);
  }
  scored.sort((a, b) => b.utility - a.utility || b.tie - a.tie ||
    compareKey(a.candidate.key, b.candidate.key));
  return scored[0].candidate;
}

/** Returns the AI's proposed line, or null when its deck needs a swap. */
export function chooseAiLine(snapshot: Snapshot, difficulty: number): Candidate | null {
  if (![0, 1, 2].includes(difficulty)) throw new RangeError("difficulty");
  const candidates = legalMoves(snapshot, "ai");
  if (!candidates.length) return null;
  const seed = decisionSeed(snapshot, difficulty);
  if (difficulty === 0) {
    return candidates[new GodotPcg32(seed).nextBounded(candidates.length)];
  }
  if (difficulty === 2) return hardChoice(snapshot, candidates, seed);
  let best = candidates[0], bestRank = score(snapshot, best);
  let bestTie = tieBreak(seed, best);
  for (const candidate of candidates.slice(1)) {
    const rank = score(snapshot, candidate);
    const tie = tieBreak(seed, candidate);
    const comparison = compareRank(rank, bestRank);
    if (comparison > 0 || comparison === 0 &&
      (tie > bestTie || tie === bestTie && candidate.key < best.key)) {
      best = candidate; bestRank = rank; bestTie = tie;
    }
  }
  return best;
}
