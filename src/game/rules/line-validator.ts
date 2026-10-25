import { classifyRanks, type HandCategory } from "./hands.js";
import type { Snapshot } from "./state.js";

export type PlacementInput = { tileId: string; x: number; y: number; rotation: number };
type Cell = readonly [number, number];
type AcceptedLine = { ordered: PlacementInput[]; merged: Cell[]; category: HandCategory; orientation: number };
export type LineValidation = AcceptedLine | { error: string };
const key = (x: number, y: number) => `${x},${y}`;
const inBounds = (x: number, y: number) => x >= 0 && x < 12 && y >= 0 && y < 12;
const neighbors = (x: number, y: number): Cell[] => [[x, y - 1], [x + 1, y], [x, y + 1], [x - 1, y]];

export function validateLine(snapshot: Snapshot, seat: "human" | "ai", placements: PlacementInput[]): LineValidation {
  if (snapshot.outcome !== 0) return { error: "MATCH_FINISHED" };
  if (snapshot.turn.active_player_id !== seat) return { error: "NOT_YOUR_TURN" };
  if (!placements.length || (placements.length === 1 && !snapshot.board.length)) return { error: "LONE_TILE" };
  if (placements.length > 5) return { error: "HAND_TOO_LONG" };
  const owned = new Set(snapshot.decks[seat]);
  if (placements.some(placement => !owned.has(placement.tileId))) return { error: "TILE_NOT_AVAILABLE" };
  const board = new Map(snapshot.board.map(entry => [key(...entry.cell), entry.tile_id]));
  const staged = new Map<string, string>();
  for (const placement of placements) {
    if (!inBounds(placement.x, placement.y)) return { error: "OUT_OF_BOUNDS" };
    const cellKey = key(placement.x, placement.y);
    if (board.has(cellKey) || staged.has(cellKey)) return { error: "CELL_OCCUPIED" };
    staged.set(cellKey, placement.tileId);
  }
  const horizontal = placements.every(placement => placement.y === placements[0].y);
  const vertical = placements.every(placement => placement.x === placements[0].x);
  if (!horizontal && !vertical) return { error: "MIXED_ORIENTATION" };
  const orientations = placements.length === 1 ? [true, false] : [horizontal];
  const byId = new Map(snapshot.tile_source.tiles.map(tile => [tile.tile_id, tile]));
  const filled = (x: number, y: number) => staged.has(key(x, y)) || board.has(key(x, y));
  const rankAt = (x: number, y: number) => byId.get(staged.get(key(x, y)) ?? board.get(key(x, y)) ?? "")?.rank;
  const mergedFor = (isHorizontal: boolean): Cell[] => {
    const fixed = isHorizontal ? placements[0].y : placements[0].x;
    const axes = placements.map(placement => isHorizontal ? placement.x : placement.y);
    let low = Math.min(...axes), high = Math.max(...axes);
    const cellAt = (axis: number): Cell => isHorizontal ? [axis, fixed] : [fixed, axis];
    while (low > 0 && board.has(key(...cellAt(low - 1)))) low--;
    while (high < 11 && board.has(key(...cellAt(high + 1)))) high++;
    const merged: Cell[] = [];
    for (let axis = low; axis <= high; axis++) {
      const cell = cellAt(axis);
      if (!filled(...cell)) return [];
      merged.push(cell);
    }
    return merged;
  };
  let chosen = orientations[0];
  if (placements.length === 1) {
    chosen = orientations.find(isHorizontal => {
      const ranks = mergedFor(isHorizontal).map(cell => rankAt(...cell));
      return ranks.every(rank => rank !== undefined) &&
        classifyRanks(ranks as number[]) !== null;
    }) ?? true;
  }
  const opening = snapshot.board.length === 0;
  if (opening && !placements.some(({ x, y }) => x >= 5 && x <= 6 && y >= 5 && y <= 6)) {
    return { error: "OPENING_CELL_REQUIRED" };
  }
  if (!opening && !placements.some(({ x, y }) => neighbors(x, y).some(cell => board.has(key(...cell))))) {
    return { error: "NOT_CONNECTED" };
  }
  const merged = mergedFor(chosen);
  if (!merged.length) return { error: "LINE_GAP" };
  if (merged.length > 5) return { error: "HAND_TOO_LONG" };
  for (const { x, y } of placements) {
    for (const isHorizontal of [true, false]) {
      const step: Cell = isHorizontal ? [1, 0] : [0, 1];
      const run: Cell[] = [[x, y]];
      for (const direction of [-1, 1]) {
        let cursorX = x + step[0] * direction;
        let cursorY = y + step[1] * direction;
        while (inBounds(cursorX, cursorY) && filled(cursorX, cursorY)) {
          run.push([cursorX, cursorY]);
          cursorX += step[0] * direction;
          cursorY += step[1] * direction;
        }
      }
      if (run.length > 5) return { error: "HAND_TOO_LONG" };
    }
  }
  const ranks = merged.map(cell => rankAt(...cell));
  if (ranks.some(rank => rank === undefined)) return { error: "LINE_GAP" };
  const category = classifyRanks(ranks as number[]);
  if (!category) return { error: "NO_REPEATED_RANK" };
  for (const { x, y } of placements) {
    for (const isHorizontal of [true, false]) {
      const step: Cell = isHorizontal ? [1, 0] : [0, 1];
      let startX = x, startY = y;
      while (inBounds(startX - step[0], startY - step[1]) &&
        filled(startX - step[0], startY - step[1])) {
        startX -= step[0]; startY -= step[1];
      }
      const run: number[] = [];
      for (let nextX = startX, nextY = startY;
        inBounds(nextX, nextY) && filled(nextX, nextY);
        nextX += step[0], nextY += step[1]) {
        run.push(rankAt(nextX, nextY)!);
      }
      if (run.length >= 2 && !classifyRanks(run)) return { error: "NO_REPEATED_RANK" };
    }
  }
  const ordered = [...placements].sort((a, b) => chosen ? a.x - b.x : a.y - b.y);
  return { ordered, merged, category, orientation: chosen ? 0 : 1 };
}
