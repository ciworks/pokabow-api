import { validateLine, type PlacementInput } from "./line-validator.js";
import type { Snapshot } from "./state.js";
import type { Tile } from "./tile-source.js";

export type Candidate = { placements: PlacementInput[]; orientation: number; key: string };
type Cell = readonly [number, number];
const cellKey = ([x, y]: Cell) => `${x},${y}`;
const neighbors = ([x, y]: Cell): Cell[] => [[x, y - 1], [x + 1, y], [x, y + 1], [x - 1, y]];

export function legalMoves(snapshot: Snapshot, seat: "human" | "ai", limit = 1024, maxLength = 5): Candidate[] {
  const tileById = new Map(snapshot.tile_source.tiles.map(tile => [tile.tile_id, tile]));
  const deck = snapshot.decks[seat].map(id => tileById.get(id)!).filter(Boolean);
  if (!deck.length) return [];
  const occupied = new Set(snapshot.board.map(entry => cellKey(entry.cell)));
  const frontier = new Set<string>();
  if (!occupied.size) for (const cell of [[5, 5], [6, 5], [5, 6], [6, 6]] as Cell[]) {
    frontier.add(cellKey(cell));
  } else for (const entry of snapshot.board) for (const cell of neighbors(entry.cell)) {
    if (cell[0] >= 0 && cell[0] < 12 && cell[1] >= 0 && cell[1] < 12 &&
      !occupied.has(cellKey(cell))) frontier.add(cellKey(cell));
  }
  const runs: Cell[][][] = [[], []];
  for (const orientation of [0, 1]) for (let fixed = 0; fixed < 12; fixed++) {
    let run: Cell[] = [];
    for (let axis = 0; axis <= 12; axis++) {
      const cell: Cell = orientation === 0 ? [axis, fixed] : [fixed, axis];
      if (axis < 12 && !occupied.has(cellKey(cell))) { run.push(cell); continue; }
      if (run.length) runs[orientation].push(run);
      run = [];
    }
  }
  const candidates: Candidate[] = [];
  const seen = new Set<string>();
  const checkingSnapshot = seat === snapshot.turn.active_player_id ? snapshot :
    { ...snapshot, turn: { ...snapshot.turn, active_player_id: seat } };
  for (let length = 1; length <= Math.min(5, maxLength); length++) {
    for (const orientation of [0, 1]) for (const run of runs[orientation]) {
      for (let start = 0; start + length <= run.length; start++) {
        const window = run.slice(start, start + length);
        if (!window.some(cell => frontier.has(cellKey(cell)))) continue;
        const repeated = [...new Set(deck.map(tile => tile.rank))].filter(rank =>
          deck.filter(tile => tile.rank === rank).length >= 2);
        const assignments: Tile[][] = [];
        if (length === 1) {
          for (const tile of deck) assignments.push([tile]);
        } else {
          for (const rank of repeated) {
            const first = deck.filter(tile => tile.rank === rank).slice(0, 2);
            assignments.push([...first, ...deck.filter(tile => !first.includes(tile))].slice(0, length));
          }
          assignments.push(deck.slice(0, length));
        }
        for (const assignment of assignments) {
          if (assignment.length < length) continue;
          const planar = orientation === 0 ? [0, 2] : [1, 3];
          const profiles = [0, 1, 2, 3].map(rotation => Array(length).fill(rotation));
          profiles.push(Array.from({ length }, (_, index) => planar[index % 2]));
          for (const profile of profiles) {
            const placements = window.map(([x, y], index) => ({
              tileId: assignment[index].tile_id, x, y, rotation: profile[index],
            }));
            const outcomeKey = placements.map((placement, index) => {
              const tile = assignment[index];
              const edges = Array.from({ length: 4 }, (_, edge) =>
                tile.edges[(edge - placement.rotation + 4) % 4]).join(",") + ",";
              return `${placement.x},${placement.y}:${placement.rotation}:${tile.rank}:${edges}`;
            }).join("|");
            if (seen.has(outcomeKey)) continue;
            seen.add(outcomeKey);
            const valid = validateLine(checkingSnapshot, seat, placements);
            if ("error" in valid) continue;
            const ordered = valid.ordered;
            const key = `ai-line:${ordered.map(placement =>
              `${placement.x},${placement.y}:${placement.rotation}:${placement.tileId}`).join("|")}`;
            candidates.push({ placements: ordered, orientation: valid.orientation, key });
            if (candidates.length >= limit) return sortCandidates(candidates);
          }
        }
      }
    }
  }
  return sortCandidates(candidates);
}

function sortCandidates(candidates: Candidate[]) {
  return candidates.sort((a, b) => {
    const first = a.placements[0], second = b.placements[0];
    return (first.y * 12 + first.x) - (second.y * 12 + second.x) ||
      a.orientation - b.orientation || a.placements.length - b.placements.length ||
      (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
  });
}
