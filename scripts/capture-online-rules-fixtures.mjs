// Refresh these fixtures only when intentionally changing the reference rules.
// The API test suite reads the recorded JSON without launching Godot.
import "dotenv/config";
import { writeFile, mkdir } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { runGodotRules } from "./godot-rules-runner.mjs";

const matchId = "00000000-0000-4000-8000-000000000042";
const cases = [];
async function capture(name, request) {
  const result = await runGodotRules(request);
  cases.push({ name, request, result });
  if ("error" in result && name === "create") throw new Error(result.error);
  return result;
}

const created = await capture("create", { action: "create", matchId, seed: 42 });
await capture("wrong-seat", { action: "swap", snapshot: created.snapshot, seat: "ai", tileIds: [created.views.ai.hand[0].tile_id] });
await capture("forged-tile", { action: "place", snapshot: created.snapshot, seat: "human", placements: [{ tileId: created.views.ai.hand[0].tile_id, x: 5, y: 5, rotation: 0 }] });
const swapped = await capture("swap", { action: "swap", snapshot: created.snapshot, seat: "human", tileIds: [created.views.human.hand[0].tile_id] });
await capture("resign", { action: "resign", snapshot: swapped.snapshot, seat: "ai" });
const helper = fileURLToPath(new URL("./capture-opening-move.gd", import.meta.url));
const { stdout } = await promisify(execFile)(process.env.GODOT_BIN, ["--headless", "--path",
  process.env.ONLINE_RULES_PROJECT, "--script", helper], { windowsHide: true });
const placementLine = stdout.trim().split(/\r?\n/).find(line => line.startsWith("["));
if (!placementLine) throw new Error("Opening-move helper returned no placement line");
const placements = JSON.parse(placementLine);
const candidateLine = stdout.trim().split(/\r?\n/).find(line => line.startsWith("CANDIDATES="));
if (!candidateLine) throw new Error("Opening-move helper returned no candidate list");
const openingCandidates = JSON.parse(candidateLine.slice("CANDIDATES=".length));
const placed = await capture("place", { action: "place", snapshot: created.snapshot, seat: "human", placements });
if ("error" in placed) throw new Error(`Opening move rejected: ${placed.error}`);
for (const difficulty of [0, 1, 2]) {
  const response = await capture(`ai-move-${difficulty}`, {
    action: "ai_move", snapshot: placed.snapshot, seat: "ai", difficulty,
  });
  if ("error" in response) throw new Error(`AI move failed: ${response.error}`);
}

const path = new URL("../tests/fixtures/online-rules-godot-v3.json", import.meta.url);
await mkdir(new URL("../tests/fixtures/", import.meta.url), { recursive: true });
await writeFile(path, JSON.stringify({ reference: "pokabow/scripts/application/online_rules.gd",
  openingCandidates, cases }, null, 2) + "\n");
console.log(`Captured ${cases.length} reference cases.`);
