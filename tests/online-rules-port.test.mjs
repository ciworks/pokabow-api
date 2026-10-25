import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { createSnapshot, swapSnapshot, resignSnapshot, placeSnapshot, stateFromSnapshot } from "../dist/game/rules/state.js";
import { classifyRanks } from "../dist/game/rules/hands.js";
import { validateLine } from "../dist/game/rules/line-validator.js";
import { scoreLine } from "../dist/game/rules/score-line.js";
import { legalMoves } from "../dist/game/rules/legal-moves.js";
import { chooseAiLine } from "../dist/game/rules/ai.js";
import { runOnlineRules } from "../dist/game/online-rules.js";

const reference = JSON.parse(await readFile(new URL("./fixtures/online-rules-godot-v3.json", import.meta.url), "utf8"));
const cases = Object.fromEntries(reference.cases.map(entry => [entry.name, entry]));

test("TypeScript initialization matches Godot's complete match state and private views", () => {
  const { matchId, seed } = cases.create.request;
  assert.deepEqual(stateFromSnapshot(createSnapshot(matchId, seed)), cases.create.result);
});

test("TypeScript swap and resignation preserve Godot's snapshot and views", () => {
  const created = createSnapshot(cases.create.request.matchId, cases.create.request.seed);
  const swapped = swapSnapshot(created, "human", cases.swap.request.tileIds);
  assert.ok(swapped);
  assert.deepEqual(stateFromSnapshot(swapped), cases.swap.result);
  assert.deepEqual(stateFromSnapshot(resignSnapshot(swapped, "ai")), cases.resign.result);
});

test("a refused swap leaves its input untouched", () => {
  const created = createSnapshot(cases.create.request.matchId, cases.create.request.seed);
  const before = structuredClone(created);
  assert.equal(swapSnapshot(created, "ai", created.decks.ai.slice(0, 1)), null);
  assert.equal(swapSnapshot(created, "human", [created.decks.ai[0]]), null);
  assert.deepEqual(created, before);
});

test("ranked hands follow the reference game's closed list and order", () => {
  for (const [ranks, category] of [
    [[0, 0], "PAIR"], [[1, 1, 1], "THREE_OF_A_KIND"],
    [[2, 2, 2, 2], "FOUR_OF_A_KIND"], [[0, 0, 1, 1], "TWO_PAIR"],
    [[0, 0, 1, 1, 1], "FULL_HOUSE"], [[3, 2, 1], "STRAIGHT_3"],
    [[0, 1, 2, 3], "STRAIGHT_4"],
  ]) assert.equal(classifyRanks(ranks), category);
  for (const ranks of [[0, 1], [0, 0, 1], [0, 1, 0, 1], [0, 0, 0, 1],
    [0, 1, 2, 0], [0, 0, 1, 1, 0], [0, 0, 0, 0, 0]]) {
    assert.equal(classifyRanks(ranks), null);
  }
});

test("opening placement and rejection cases match reference legality", () => {
  const created = createSnapshot(cases.create.request.matchId, cases.create.request.seed);
  const accepted = validateLine(created, "human", cases.place.request.placements);
  assert.ok(!("error" in accepted));
  assert.deepEqual(accepted.merged, [[4, 5], [5, 5]]);
  assert.equal(accepted.category, "PAIR");
  assert.equal(accepted.orientation, 0);
  assert.deepEqual(validateLine(created, "ai", cases.place.request.placements),
    { error: "NOT_YOUR_TURN" });
  // The command adapter checks tile ownership before calling the pure line validator.
  assert.deepEqual(validateLine(created, "human", cases["forged-tile"].request.placements),
    { error: "LONE_TILE" });
});

test("private view projection matches scored reference states", () => {
  for (const name of ["place", "ai-move-0", "ai-move-1", "ai-move-2"]) {
    assert.deepEqual(stateFromSnapshot(cases[name].result.snapshot), cases[name].result, name);
  }
});

test("placement scoring matches the recorded Godot moves", () => {
  const first = scoreLine(cases.create.result.snapshot, "human", cases.place.request.placements);
  assert.deepEqual(first.events, cases.place.result.snapshot.ledger.events);
  assert.deepEqual(first.scoredHandIds, cases.place.result.snapshot.scored_hand_ids);
  for (const name of ["ai-move-0", "ai-move-1", "ai-move-2"]) {
    const before = cases.place.result.snapshot;
    const after = cases[name].result.snapshot;
    const priorIds = new Set(before.board.map(tile => tile.tile_id));
    const placements = after.board.filter(tile => !priorIds.has(tile.tile_id)).map(tile =>
      ({ tileId: tile.tile_id, x: tile.cell[0], y: tile.cell[1], rotation: tile.rotation }));
    const expected = after.ledger.events.slice(before.ledger.events.length);
    assert.deepEqual(scoreLine(before, "ai", placements).events, expected, name);
  }
});

test("the complete opening placement transition matches Godot", () => {
  const created = createSnapshot(cases.create.request.matchId, cases.create.request.seed);
  const placed = placeSnapshot(created, "human", cases.place.request.placements);
  assert.ok(!("error" in placed));
  assert.deepEqual(stateFromSnapshot(placed), cases.place.result);
});

test("complete follow-up placement transitions match all captured AI moves", () => {
  const before = cases.place.result.snapshot;
  for (const name of ["ai-move-0", "ai-move-1", "ai-move-2"]) {
    const after = cases[name].result.snapshot;
    const priorIds = new Set(before.board.map(tile => tile.tile_id));
    const placements = after.board.filter(tile => !priorIds.has(tile.tile_id)).map(tile =>
      ({ tileId: tile.tile_id, x: tile.cell[0], y: tile.cell[1], rotation: tile.rotation }));
    const actual = placeSnapshot(before, "ai", placements);
    assert.ok(!("error" in actual), name);
    assert.deepEqual(stateFromSnapshot(actual), cases[name].result, name);
  }
});

test("legal move generation offers the reference opening", () => {
  const created = createSnapshot(cases.create.request.matchId, cases.create.request.seed);
  const candidates = legalMoves(created, "human", 1);
  assert.ok(candidates.length > 0);
  assert.deepEqual(candidates[0].placements, cases.place.request.placements);
  assert.deepEqual(legalMoves(created, "human").map(candidate => candidate.key),
    reference.openingCandidates);
});

test("easy and medium AI select the reference moves", () => {
  const before = cases.place.result.snapshot;
  const priorIds = new Set(before.board.map(tile => tile.tile_id));
  for (const difficulty of [0, 1]) {
    const candidate = chooseAiLine(before, difficulty);
    const after = cases[`ai-move-${difficulty}`].result.snapshot;
    const expected = after.board.filter(tile => !priorIds.has(tile.tile_id)).map(tile =>
      ({ tileId: tile.tile_id, x: tile.cell[0], y: tile.cell[1], rotation: tile.rotation }));
    assert.deepEqual(candidate?.placements, expected, `difficulty ${difficulty}`);
  }
});

test("live TypeScript runner matches every captured Godot command", async () => {
  for (const entry of reference.cases) {
    const actual = await runOnlineRules(entry.request);
    assert.deepEqual(actual, entry.result, entry.name);
  }
});

test("live runner rejects malformed persisted state", async () => {
  const snapshot = structuredClone(cases.create.result.snapshot);
  snapshot.tile_source.tiles[0].rank = (snapshot.tile_source.tiles[0].rank + 1) % 4;
  assert.deepEqual(await runOnlineRules({ action: "resign", snapshot, seat: "human" }),
    { error: "RULES_FAILURE" });
});

test("multi-turn transitions match 35 Godot reference fingerprints", async () => {
  const fingerprints = JSON.parse(await readFile(new URL("./fixtures/online-rules-transitions.json", import.meta.url)));
  const canonical = value => Array.isArray(value) ? value.map(canonical) :
    value && typeof value === "object" ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
  let index = 0;
  const compare = async (seed, request) => {
    const result = await runOnlineRules(request);
    const expected = fingerprints[index++];
    assert.equal(expected.seed, seed);
    assert.equal(expected.action, request.action);
    assert.equal(createHash("sha256").update(JSON.stringify(canonical(result))).digest("hex"),
      expected.sha256, `seed ${seed}, ${request.action}, command ${index}`);
    return result;
  };
  for (const seed of [1, 7, 42, 99, 12345]) {
    const matchId = `00000000-0000-4000-8000-${String(seed).padStart(12, "0")}`;
    let state = await compare(seed, { action: "create", matchId, seed });
    for (let turn = 0; turn < 6 && state.snapshot.outcome === 0; turn++) {
      const snapshot = state.snapshot, seat = snapshot.turn.active_player_id;
      const candidates = seat === "human" ? legalMoves(snapshot, seat, 1) : [];
      const command = seat === "ai" ? { action: "ai_move", snapshot, seat, difficulty: turn % 3 } :
        candidates.length ? { action: "place", snapshot, seat, placements: candidates[0].placements } :
          { action: "swap", snapshot, seat, tileIds: snapshot.decks[seat].slice(0, 1) };
      state = await compare(seed, command);
    }
  }
  assert.equal(index, fingerprints.length);
});
