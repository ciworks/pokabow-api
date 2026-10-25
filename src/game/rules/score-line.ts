import { classifyRanks } from "./hands.js";
import type { PlacementInput } from "./line-validator.js";
import type { Snapshot, ScoreEvent } from "./state.js";
import type { Tile } from "./tile-source.js";

type Cell = readonly [number, number];
type BoardTile = { cell: Cell; rotation: number; tile: Tile };
const cellKey = ([x, y]: Cell) => `${x},${y}`;
const sortedCells = (cells: Cell[]) => [...cells].sort((a, b) => a[1] - b[1] || a[0] - b[0]);
const label = (cells: Cell[]) => sortedCells(cells).map(cellKey).join("|");
const colors = ["BLUE", "RED", "GREEN", "YELLOW"];
const categoryPoints: Record<string, number> = {
  PAIR: 2, TWO_PAIR: 4, STRAIGHT_3: 5, THREE_OF_A_KIND: 6,
  STRAIGHT_4: 9, FULL_HOUSE: 10, FOUR_OF_A_KIND: 12,
};
const adjacent = (cell: Cell): Cell[] => [[cell[0], cell[1] - 1],
  [cell[0] + 1, cell[1]], [cell[0], cell[1] + 1], [cell[0] - 1, cell[1]]];

function boardMap(snapshot: Snapshot): Map<string, BoardTile> {
  const tiles = new Map(snapshot.tile_source.tiles.map(tile => [tile.tile_id, tile]));
  return new Map(snapshot.board.map(placed => [cellKey(placed.cell), {
    cell: placed.cell, rotation: placed.rotation, tile: tiles.get(placed.tile_id)!,
  }]));
}

function edgeAt(entry: BoardTile, direction: number) {
  return entry.tile.edges[(direction - entry.rotation + 4) % 4];
}

function matchingColor(board: Map<string, BoardTile>, a: Cell, b: Cell): number {
  const first = board.get(cellKey(a)), second = board.get(cellKey(b));
  if (!first || !second) return -1;
  const direction = adjacent(a).findIndex(cell => cellKey(cell) === cellKey(b));
  if (direction < 0) return -1;
  const color = edgeAt(first, direction);
  return color === edgeAt(second, (direction + 2) % 4) ? color : -1;
}

function boundaryId(a: Cell, b: Cell): string {
  const [first, second] = sortedCells([a, b]);
  return `edge:${cellKey(first)}-${cellKey(second)}`;
}

function runThrough(board: Map<string, BoardTile>, cell: Cell, horizontal: boolean): Cell[] {
  const dx = horizontal ? 1 : 0, dy = horizontal ? 0 : 1;
  let x = cell[0], y = cell[1];
  while (board.has(`${x - dx},${y - dy}`)) { x -= dx; y -= dy; }
  const run: Cell[] = [];
  while (board.has(`${x},${y}`)) { run.push([x, y]); x += dx; y += dy; }
  return run;
}

function handId(cells: Cell[]): string {
  const first = cells[0], horizontal = cells[0][1] === cells[1][1];
  const base = horizontal ? `hand:H:${first[1]}:${first[0]}` : `hand:V:${first[0]}:${first[1]}`;
  return cells.length === 5 ? base : `${base}:${cells.length}`;
}

function component(board: Map<string, BoardTile>, start: Cell, color: number): Cell[] {
  if (!board.has(cellKey(start))) return [];
  const seen = new Set<string>([cellKey(start)]);
  const pending: Cell[] = [start];
  const result: Cell[] = [];
  while (pending.length) {
    const cell = pending.shift()!;
    result.push(cell);
    for (const neighbor of adjacent(cell)) {
      const id = cellKey(neighbor);
      if (!seen.has(id) && matchingColor(board, cell, neighbor) === color) {
        seen.add(id); pending.push(neighbor);
      }
    }
  }
  return sortedCells(result);
}

function event(moveId: string, player: string, turnNumber: number, category: number,
  discriminator: string, points: number, cells: Cell[], evidence: Record<string, unknown>): ScoreEvent {
  const slug = ["poker", "edge", "cluster"][category];
  return { schema_version: 1, event_id: `score:${moveId}:${slug}:${discriminator}`,
    move_id: moveId, player_id: player, category, points, turn_number: turnNumber,
    cells, evidence, rules_version: "scoring:7" };
}

export function scoreLine(snapshot: Snapshot, seat: "human" | "ai", ordered: PlacementInput[]) {
  const pre = boardMap(snapshot);
  const post = new Map(pre);
  const tiles = new Map(snapshot.tile_source.tiles.map(tile => [tile.tile_id, tile]));
  const staged: Cell[] = ordered.map(({ x, y }) => [x, y]);
  const stagedKeys = new Set(staged.map(cellKey));
  for (const placed of ordered) post.set(`${placed.x},${placed.y}`, {
    cell: [placed.x, placed.y], rotation: placed.rotation, tile: tiles.get(placed.tileId)!,
  });
  const moveId = `move:${snapshot.match_id}:${snapshot.turn.turn_number}:1`;
  const events: ScoreEvent[] = [];
  const scoredHandIds: string[] = [];
  const hands = new Map<string, Cell[]>();
  for (const cell of staged) for (const horizontal of [true, false]) {
    const run = runThrough(post, cell, horizontal);
    if (run.length < 2) continue;
    const windows = run.length <= 5 ? [run] :
      Array.from({ length: run.length - 4 }, (_, index) => run.slice(index, index + 5));
    for (const window of windows) {
      if (window.some(member => cellKey(member) === cellKey(cell))) hands.set(handId(window), window);
    }
  }
  for (const [id, cells] of [...hands].sort(([a], [b]) => a.localeCompare(b))) {
    if (snapshot.scored_hand_ids.includes(id)) continue;
    const entries = cells.map(cell => post.get(cellKey(cell))!);
    const category = classifyRanks(entries.map(entry => entry.tile.rank));
    if (!category) continue;
    const first = entries[0].tile;
    const sameColor = entries.every(entry => entry.tile.face_color === first.face_color);
    const sameSuit = entries.every(entry => entry.tile.suit === first.suit);
    const sameRank = entries.every(entry => entry.tile.rank === first.rank);
    const cardMultiplier = sameSuit && sameRank ? 4 : sameSuit ? 3 : sameColor ? 2 : 1;
    const cardPoints = entries.reduce((sum, entry) => sum + 4 - entry.tile.rank, 0);
    const newHandBoundaries: string[] = [];
    for (let index = 0; index < cells.length - 1; index++) {
      if (!stagedKeys.has(cellKey(cells[index])) && !stagedKeys.has(cellKey(cells[index + 1]))) continue;
      if (matchingColor(post, cells[index], cells[index + 1]) >= 0) {
        newHandBoundaries.push(boundaryId(cells[index], cells[index + 1]));
      }
    }
    const edgeMultiplier = 1 + newHandBoundaries.length;
    const points = (categoryPoints[category] + cardPoints) * cardMultiplier * edgeMultiplier;
    events.push(event(moveId, seat, snapshot.turn.turn_number, 0, id, points, cells, {
      hand_id: id, category, cells: label(cells), category_points: categoryPoints[category],
      card_points: cardPoints, card_multiplier: cardMultiplier,
      edge_multiplier: edgeMultiplier, new_hand_boundaries: newHandBoundaries,
    }));
    scoredHandIds.push(id);
  }
  const boundaries = new Map<string, { a: Cell; b: Cell; color: number }>();
  for (const cell of staged) for (const neighbor of adjacent(cell)) {
    const color = matchingColor(post, cell, neighbor);
    if (color >= 0) boundaries.set(boundaryId(cell, neighbor), { a: cell, b: neighbor, color });
  }
  for (const [id, { a, b, color }] of [...boundaries].sort(([x], [y]) => x.localeCompare(y))) {
    events.push(event(moveId, seat, snapshot.turn.turn_number, 1, id, 1,
      sortedCells([a, b]), { boundary_id: id, color: colors[color] }));
  }
  const touched = new Map<number, Cell[]>();
  for (const { a, b, color } of boundaries.values()) {
    const partners = touched.get(color) ?? [];
    if (!stagedKeys.has(cellKey(a))) partners.push(a);
    if (!stagedKeys.has(cellKey(b))) partners.push(b);
    touched.set(color, partners);
  }
  for (const color of [...touched.keys()].sort((a, b) => a - b)) {
    const prior = new Map<string, Cell[]>();
    for (const neighbor of touched.get(color)!) {
      const region = component(pre, neighbor, color);
      prior.set(label(region), region);
    }
    const after = new Map<string, Cell[]>();
    for (const cell of staged) {
      if (!adjacent(cell).some(neighbor => matchingColor(post, cell, neighbor) === color)) continue;
      const region = component(post, cell, color);
      after.set(label(region), region);
    }
    const entitlement = (regions: Map<string, Cell[]>) =>
      [...regions.values()].reduce((sum, region) => sum + 3 * Math.floor(region.length / 4), 0);
    const previous = entitlement(prior), current = entitlement(after);
    if (current <= previous) continue;
    const cells = sortedCells([...new Map([...after.values()].flat().map(cell => [cellKey(cell), cell])).values()]);
    const colorName = colors[color];
    const componentKey = `${colorName.toLowerCase()}:${label(cells)}`;
    events.push(event(moveId, seat, snapshot.turn.turn_number, 2,
      `${colorName.toLowerCase()}:1`, current - previous, cells,
      { color: colorName, component_key: componentKey,
        previous_entitlement: previous, current_entitlement: current, delta: current - previous }));
  }
  return { events, scoredHandIds };
}
