import "dotenv/config";
import assert from "node:assert/strict";
import { runGodotRules } from "./godot-rules-runner.mjs";
import { runOnlineRules } from "../dist/game/online-rules.js";
import { legalMoves } from "../dist/game/rules/legal-moves.js";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";

if (!process.env.GODOT_BIN || !process.env.ONLINE_RULES_PROJECT) {
  throw new Error("Set GODOT_BIN and ONLINE_RULES_PROJECT for the development reference check");
}

let commands = 0;
const fingerprints = [];
const canonical = value => Array.isArray(value) ? value.map(canonical) :
  value && typeof value === "object" ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const extended = process.argv.includes("--long") || process.argv.includes("--complete");
const seeds = extended ? [1] : [1, 7, 42, 99, 12345];
for (const seed of seeds) {
  const matchId = `00000000-0000-4000-8000-${String(seed).padStart(12, "0")}`;
  const compare = async request => {
    const [actual, expected] = await Promise.all([runOnlineRules(request), runGodotRules(request)]);
    try {
      assert.deepEqual(actual, expected);
    } catch {
      if (request.action === "ai_move") {
        const directory = await mkdtemp(join(tmpdir(), "pokabow-candidates-"));
        try {
          const input = join(directory, "input.json");
          await writeFile(input, JSON.stringify({ snapshot: request.snapshot, seat: request.seat }));
          const helper = fileURLToPath(new URL("./capture-candidates.gd", import.meta.url));
          const { stdout } = await promisify(execFile)(process.env.GODOT_BIN, ["--headless", "--path",
            process.env.ONLINE_RULES_PROJECT, "--script", helper, "--", input], { windowsHide: true });
          const godot = JSON.parse(stdout.split(/\r?\n/).find(line => line.startsWith("CANDIDATES=")).slice(11));
          const typescript = legalMoves(request.snapshot, "ai").map(candidate => candidate.key);
          const first = typescript.findIndex((key, index) => key !== godot[index]);
          console.error("Candidate lists:", { tsCount: typescript.length, godotCount: godot.length,
            first, ts: typescript[first], godot: godot[first] });
        } finally { await rm(directory, { recursive: true, force: true }); }
      }
      const differences = [];
      const walk = (a, b, path) => {
        if (differences.length >= 12) return;
        if (a && b && typeof a === "object" && typeof b === "object") {
          for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) walk(a[key], b[key], `${path}.${key}`);
        } else if (a !== b) differences.push({ path, actual: a, expected: b });
      };
      walk(actual, expected, "result");
      throw new Error(`seed ${seed}, command ${commands}, ${request.action}: ${JSON.stringify(differences)}`);
    }
    fingerprints.push({ seed, action: request.action,
      sha256: createHash("sha256").update(JSON.stringify(canonical(expected))).digest("hex") });
    commands++;
    return actual;
  };
  let state = await compare({ action: "create", matchId, seed });
  for (let turn = 0; turn < (process.argv.includes("--complete") ? 80 : extended ? 30 : 6) &&
    !("error" in state) && state.snapshot.outcome === 0; turn++) {
    const snapshot = state.snapshot;
    const seat = snapshot.turn.active_player_id;
    let request;
    if (seat === "ai") {
      request = { action: "ai_move", snapshot, seat, difficulty: turn % 3 };
    } else {
      const candidates = legalMoves(snapshot, seat, 1);
      request = candidates.length ? { action: "place", snapshot, seat,
        placements: candidates[0].placements } : { action: "swap", snapshot, seat,
        tileIds: snapshot.decks[seat].slice(0, 1) };
    }
    state = await compare(request);
  }
  if (process.argv.includes("--complete")) console.log(`Seed ${seed} outcome: ${state.snapshot?.outcome}, reason: ${state.snapshot?.end_reason}`);
}
console.log(`Matched ${commands} commands across ${seeds.length} seed(s).`);
if (process.argv.includes("--write-fixture")) {
  await writeFile(new URL("../tests/fixtures/online-rules-transitions.json", import.meta.url),
    JSON.stringify(fingerprints, null, 2) + "\n");
}
