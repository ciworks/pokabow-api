import type { RulesRunner } from "./rules-contract.js";
import { chooseAiLine } from "./rules/ai.js";
import { createSnapshot, placeSnapshot, resignSnapshot, stateFromSnapshot,
  settleNoValidMove, swapSnapshot, type Snapshot } from "./rules/state.js";
import { generateTiles } from "./rules/tile-source.js";
import type { PlacementInput } from "./rules/line-validator.js";

export type { RulesState, RulesResult, RulesRunner } from "./rules-contract.js";
export function onlineRulesAvailable() { return true; }

function validSnapshot(value: unknown): value is Snapshot {
  if (!value || typeof value !== "object") return false;
  const s = value as Snapshot;
  if (s.schema_version !== 3 || s.tile_generation_version !== "tile-generation:5" ||
    s.scoring_version !== "scoring:7" || s.deck_rules_version !== "deck:1" ||
    typeof s.match_id !== "string" || !Number.isSafeInteger(s.seed) ||
    !s.tile_source || s.tile_source.rules_version !== "tile-generation:5" ||
    s.tile_source.match_id !== s.match_id || s.tile_source.seed !== s.seed ||
    !Array.isArray(s.tile_source.tiles) || s.tile_source.tiles.length !== 52 ||
    !Number.isInteger(s.tile_source.next_draw_index) || s.tile_source.next_draw_index < 0 ||
    s.tile_source.next_draw_index > 52 || !Array.isArray(s.board) ||
    !Array.isArray(s.decks?.human) || !Array.isArray(s.decks?.ai) ||
    !Array.isArray(s.history) || !Array.isArray(s.ledger?.events) ||
    !Array.isArray(s.scored_hand_ids) || !s.turn ||
    !["human", "ai"].includes(s.turn.active_player_id) ||
    !Number.isInteger(s.turn.turn_number) || s.turn.turn_number < 1 ||
    !Number.isInteger(s.outcome) || !Number.isInteger(s.end_reason)) return false;
  const canonical = new Map(generateTiles(s.match_id, s.seed).map(tile => [tile.tile_id, tile]));
  const ids = new Set<string>();
  for (const tile of s.tile_source.tiles) {
    const reference = canonical.get(tile?.tile_id);
    if (!tile || typeof tile.tile_id !== "string" || ids.has(tile.tile_id) ||
      !reference || tile.schema_version !== reference.schema_version ||
      tile.rank !== reference.rank || tile.face_color !== reference.face_color ||
      tile.suit !== reference.suit || !Array.isArray(tile.edges) ||
      tile.edges.length !== 4 || tile.edges.some((edge, index) => edge !== reference.edges[index])) return false;
    ids.add(tile.tile_id);
  }
  const used = new Set<string>();
  const occupy = (id: string) => {
    if (!ids.has(id) || used.has(id)) return false;
    used.add(id); return true;
  };
  const cells = new Set<string>();
  for (const entry of s.board) {
    if (!entry || !Array.isArray(entry.cell) || entry.cell.length !== 2 ||
      !entry.cell.every((n: number) => Number.isInteger(n) && n >= 0 && n < 12) ||
      !Number.isInteger(entry.rotation) || entry.rotation < 0 || entry.rotation > 3 ||
      !occupy(entry.tile_id)) return false;
    const cell = entry.cell.join(",");
    if (cells.has(cell)) return false;
    cells.add(cell);
  }
  for (const seat of ["human", "ai"] as const) {
    if (s.decks[seat].length > 6) return false;
    for (const id of s.decks[seat]) if (!occupy(id)) return false;
  }
  for (const tile of s.tile_source.tiles.slice(s.tile_source.next_draw_index)) {
    if (!occupy(tile.tile_id)) return false;
  }
  return used.size === 52;
}

function seatOf(value: unknown): "human" | "ai" | null {
  return value === "human" || value === "ai" ? value : null;
}

function placementsOf(value: unknown): PlacementInput[] | null {
  if (!Array.isArray(value)) return null;
  const parsed: PlacementInput[] = [];
  for (const p of value) {
    if (!p || typeof p.tileId !== "string" || !Number.isInteger(p.x) ||
      !Number.isInteger(p.y) || !Number.isInteger(p.rotation)) return null;
    parsed.push({ tileId: p.tileId, x: p.x, y: p.y, rotation: p.rotation });
  }
  return parsed;
}

/** Authoritative rules runner. The API process needs no engine executable. */
export const runOnlineRules: RulesRunner = async request => {
  if (request.action === "create") {
    if (typeof request.matchId !== "string" || !request.matchId ||
      !Number.isSafeInteger(request.seed) || (request.seed as number) < 0) return { error: "RULES_FAILURE" };
    return stateFromSnapshot(settleNoValidMove(createSnapshot(request.matchId, request.seed as number)));
  }
  if (!validSnapshot(request.snapshot)) return { error: "RULES_FAILURE" };
  const snapshot = request.snapshot;
  if (snapshot.outcome !== 0) return { error: "MATCH_FINISHED" };
  const seat = seatOf(request.seat);
  if (request.action === "resign") {
    if (!seat) return { error: "INVALID_PLAYER" };
    return stateFromSnapshot(resignSnapshot(snapshot, seat)!);
  }
  if (request.action === "ai_move") {
    if (seat !== "ai" || snapshot.turn.active_player_id !== "ai") return { error: "NOT_AI_TURN" };
    if (![0, 1, 2].includes(request.difficulty as number)) return { error: "INVALID_DIFFICULTY" };
    const line = chooseAiLine(snapshot, request.difficulty as number);
    if (line) {
      const next = placeSnapshot(snapshot, "ai", line.placements);
      return "error" in next ? { error: "INVALID_AI_LINE" } : stateFromSnapshot(settleNoValidMove(next));
    }
    const supply = 52 - snapshot.tile_source.next_draw_index;
    const offer = snapshot.decks.ai.slice(0, supply);
    const next = offer.length ? swapSnapshot(snapshot, "ai", offer) : null;
    return stateFromSnapshot(settleNoValidMove(next ?? snapshot));
  }
  if (seat !== snapshot.turn.active_player_id) return { error: "NOT_YOUR_TURN" };
  if (request.action === "place") {
    const placements = placementsOf(request.placements);
    if (!placements) return { error: "INVALID_MOVE" };
    const next = placeSnapshot(snapshot, seat!, placements);
    return "error" in next ? next : stateFromSnapshot(settleNoValidMove(next));
  }
  if (request.action === "swap") {
    if (!Array.isArray(request.tileIds) || !request.tileIds.every(id => typeof id === "string"))
      return { error: "INVALID_SWAP" };
    const next = swapSnapshot(snapshot, seat!, request.tileIds as string[]);
    return next ? stateFromSnapshot(settleNoValidMove(next)) : { error: "INVALID_SWAP" };
  }
  return { error: "INVALID_ACTION" };
};
