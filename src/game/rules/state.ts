import { generateTiles, type Tile } from "./tile-source.js";
import { validateLine, type PlacementInput } from "./line-validator.js";
import { scoreLine } from "./score-line.js";
import { legalMoves } from "./legal-moves.js";

type Seat = "human" | "ai";
type Placement = { tile_id: string; cell: [number, number]; rotation: number };
export type ScoreEvent = { player_id: string; category: number; points: number; [key: string]: unknown };
export type Snapshot = {
  schema_version: 3; match_id: string; seed: number;
  tile_generation_version: "tile-generation:5"; scoring_version: "scoring:7";
  deck_rules_version: "deck:1";
  tile_source: { schema_version: 1; rules_version: "tile-generation:5";
    match_id: string; seed: number; next_draw_index: number; tiles: Tile[] };
  board: Placement[]; decks: Record<Seat, string[]>;
  turn: { active_player_id: Seat; deadline_unix_seconds: number; phase: number;
    remaining_seconds: number; turn_number: number };
  history: Record<string, unknown>[];
  ledger: { events: ScoreEvent[] }; scored_hand_ids: string[];
  outcome: number; end_reason: number;
};

const OUTCOME_NAMES = ["IN_PROGRESS", "HUMAN_WIN", "AI_WIN", "DRAW", "INCOMPLETE"];
const END_REASON_NAMES = ["NONE", "BOARD_FULL", "TILE_SOURCE_EXHAUSTED", "RULES_FAILURE", "NO_LEGAL_MOVES", "RESIGNATION"];
const other = (seat: Seat): Seat => seat === "human" ? "ai" : "human";

export function createSnapshot(matchId: string, seed: number): Snapshot {
  const tiles = generateTiles(matchId, seed);
  const snapshot: Snapshot = {
    schema_version: 3, match_id: matchId, seed,
    tile_generation_version: "tile-generation:5", scoring_version: "scoring:7", deck_rules_version: "deck:1",
    tile_source: { schema_version: 1, rules_version: "tile-generation:5", match_id: matchId,
      seed, next_draw_index: 12, tiles },
    board: [], decks: { human: tiles.slice(0, 6).map(tile => tile.tile_id),
      ai: tiles.slice(6, 12).map(tile => tile.tile_id) },
    turn: { active_player_id: "human", deadline_unix_seconds: 0, phase: 2,
      remaining_seconds: 0, turn_number: 1 },
    history: [], ledger: { events: [] }, scored_hand_ids: [], outcome: 0, end_reason: 0,
  };
  finishIfNeeded(snapshot);
  return snapshot;
}

function scoreFor(snapshot: Snapshot, seat: Seat) {
  return snapshot.ledger.events.filter(event => event.player_id === seat)
    .reduce((sum, event) => sum + event.points, 0);
}

function finishIfNeeded(snapshot: Snapshot) {
  let reason = 0;
  if (snapshot.board.length >= 144) reason = 1;
  else if (!snapshot.decks.human.length && !snapshot.decks.ai.length &&
    snapshot.tile_source.next_draw_index >= snapshot.tile_source.tiles.length) reason = 2;
  else if (!legalMoves(snapshot, "human", 1).length && !legalMoves(snapshot, "ai", 1).length) reason = 4;
  if (!reason) return false;
  const human = scoreFor(snapshot, "human"), ai = scoreFor(snapshot, "ai");
  snapshot.outcome = human > ai ? 1 : ai > human ? 2 : 3;
  snapshot.end_reason = reason;
  snapshot.turn.phase = 5;
  return true;
}

function completeTurn(snapshot: Snapshot, seat: Seat) {
  if (finishIfNeeded(snapshot)) return;
  snapshot.turn.active_player_id = other(seat);
  snapshot.turn.turn_number++;
  for (let handover = 0; handover < 2; handover++) {
    if (finishIfNeeded(snapshot)) return;
    while (snapshot.decks[snapshot.turn.active_player_id].length < 6 &&
      snapshot.tile_source.next_draw_index < snapshot.tile_source.tiles.length) {
      snapshot.decks[snapshot.turn.active_player_id].push(
        snapshot.tile_source.tiles[snapshot.tile_source.next_draw_index++].tile_id);
    }
    if (snapshot.decks[snapshot.turn.active_player_id].length) return;
    snapshot.turn.active_player_id = other(snapshot.turn.active_player_id);
    snapshot.turn.turn_number++;
  }
  finishIfNeeded(snapshot);
}

/** Applies the reference worker's post-command impossible-turn check. */
export function settleNoValidMove(snapshot: Snapshot): Snapshot {
  if (snapshot.outcome !== 0) return snapshot;
  const seat = snapshot.turn.active_player_id;
  if (legalMoves(snapshot, seat, 1).length ||
    snapshot.tile_source.tiles.length - snapshot.tile_source.next_draw_index >=
      snapshot.decks[seat].length) return snapshot;
  const next = structuredClone(snapshot);
  completeTurn(next, seat);
  return next;
}

/** Returns a new snapshot; invalid swaps leave the supplied snapshot untouched. */
export function swapSnapshot(snapshot: Snapshot, seat: Seat, tileIds: string[]): Snapshot | null {
  if (snapshot.outcome !== 0 || snapshot.turn.active_player_id !== seat) return null;
  const unique = [...new Set(tileIds)];
  if (!unique.length || unique.some(id => !snapshot.decks[seat].includes(id))) return null;
  if (snapshot.tile_source.tiles.length - snapshot.tile_source.next_draw_index < unique.length) return null;
  const next = structuredClone(snapshot);
  next.decks[seat] = next.decks[seat].filter(id => !unique.includes(id));
  for (let index = 0; index < unique.length; index++) {
    next.decks[seat].push(next.tile_source.tiles[next.tile_source.next_draw_index++].tile_id);
  }
  for (const id of unique) {
    const index = next.tile_source.tiles.findIndex(tile => tile.tile_id === id);
    next.tile_source.tiles.push(...next.tile_source.tiles.splice(index, 1));
    next.tile_source.next_draw_index--;
  }
  completeTurn(next, seat);
  return next;
}

export function resignSnapshot(snapshot: Snapshot, seat: Seat): Snapshot | null {
  if (snapshot.outcome !== 0) return null;
  const next = structuredClone(snapshot);
  next.outcome = seat === "human" ? 2 : 1;
  next.end_reason = 5;
  next.turn.phase = 5;
  next.turn.remaining_seconds = 0;
  next.turn.deadline_unix_seconds = 0;
  return next;
}

/** Commits one line and its score ledger as one new snapshot. */
export function placeSnapshot(snapshot: Snapshot, seat: Seat, placements: PlacementInput[]): Snapshot | { error: string } {
  if (snapshot.outcome !== 0) return { error: "MATCH_FINISHED" };
  if (snapshot.turn.active_player_id !== seat) return { error: "NOT_YOUR_TURN" };
  if (placements.some(placement => !snapshot.decks[seat].includes(placement.tileId)) ||
    new Set(placements.map(placement => placement.tileId)).size !== placements.length) {
    return { error: "TILE_NOT_AVAILABLE" };
  }
  const validation = validateLine(snapshot, seat, placements);
  if ("error" in validation) return validation;
  const next = structuredClone(snapshot);
  const wasOpeningMove = next.board.length === 0;
  const moveId = `move:${next.match_id}:${next.turn.turn_number}:1`;
  const scores = scoreLine(snapshot, seat, validation.ordered);
  for (const placement of validation.ordered) {
    next.board.push({ tile_id: placement.tileId, cell: [placement.x, placement.y],
      rotation: placement.rotation });
  }
  next.board.sort((a, b) => a.cell[1] - b.cell[1] || a.cell[0] - b.cell[0]);
  next.ledger.events.push(...scores.events);
  next.scored_hand_ids.push(...scores.scoredHandIds);
  next.scored_hand_ids.sort();
  next.history.push({ move_id: moveId, move_number: next.turn.turn_number,
    player_id: seat, is_opening_move: wasOpeningMove,
    placements: validation.ordered.map(placement => ({ tile_id: placement.tileId,
      cell: [placement.x, placement.y], rotation: placement.rotation })) });
  const used = new Set(validation.ordered.map(placement => placement.tileId));
  next.decks[seat] = next.decks[seat].filter(id => !used.has(id));
  while (next.decks[seat].length < 6 &&
    next.tile_source.next_draw_index < next.tile_source.tiles.length) {
    next.decks[seat].push(next.tile_source.tiles[next.tile_source.next_draw_index++].tile_id);
  }
  completeTurn(next, seat);
  return next;
}

function scoreTerms(snapshot: Snapshot) {
  const terms = { human: { poker: 0, edge: 0, cluster: 0, total: 0 },
    ai: { poker: 0, edge: 0, cluster: 0, total: 0 } };
  for (const event of snapshot.ledger.events) {
    if (event.player_id !== "human" && event.player_id !== "ai") continue;
    const entry = terms[event.player_id];
    if (event.category === 0) entry.poker += event.points;
    else if (event.category === 1) entry.edge += event.points;
    else if (event.category === 2) entry.cluster += event.points;
    entry.total += event.points;
  }
  return terms;
}

function visiblePot(snapshot: Snapshot) {
  const { tiles, next_draw_index } = snapshot.tile_source;
  const faces = tiles.slice(next_draw_index).map(({ rank, face_color, suit, edges }) =>
    ({ rank, face_color, suit, edges }));
  const key = (face: typeof faces[number]) =>
    [face.rank, face.suit, face.face_color, ...face.edges].join("-");
  return faces.sort((left, right) => key(left).localeCompare(key(right), "en", { sensitivity: "variant" }));
}

export function stateFromSnapshot(snapshot: Snapshot) {
  const byId = new Map(snapshot.tile_source.tiles.map(tile => [tile.tile_id, tile]));
  const terms = scoreTerms(snapshot);
  const result = {
    outcome: snapshot.outcome, outcome_name: OUTCOME_NAMES[snapshot.outcome],
    end_reason: snapshot.end_reason, end_reason_name: END_REASON_NAMES[snapshot.end_reason],
    winner: snapshot.outcome === 1 ? "human" : snapshot.outcome === 2 ? "ai" : "",
    human_score: terms.human.total, ai_score: terms.ai.total,
    move_count: snapshot.history.length, board_occupied: snapshot.board.length,
    tiles_remaining: snapshot.tile_source.tiles.length - snapshot.tile_source.next_draw_index,
    terms,
  };
  const board = snapshot.board.map(({ tile_id, cell, rotation }) =>
    ({ tile: byId.get(tile_id), cell, rotation }));
  const potTiles = visiblePot(snapshot);
  const view = (seat: Seat) => ({
    board, hand: snapshot.decks[seat].map(id => byId.get(id)), seat,
    opponentTileCount: snapshot.decks[other(seat)].length,
    remainingTiles: result.tiles_remaining, potTiles,
    turn: snapshot.turn, ledger: snapshot.ledger, scoredHandIds: snapshot.scored_hand_ids,
    outcome: snapshot.outcome, endReason: snapshot.end_reason,
    history: snapshot.history, result,
  });
  return { snapshot, views: { human: view("human"), ai: view("ai") } };
}
