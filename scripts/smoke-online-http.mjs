import { randomUUID } from "node:crypto";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const testDatabase = new URL(process.env.ONLINE_TEST_DATABASE_URL ?? "postgres://invalid");
if (!["127.0.0.1", "localhost", "[::1]"].includes(testDatabase.hostname)
  || !/^\/codex_online_[a-zA-Z0-9_]+$/.test(testDatabase.pathname)) {
  throw new Error("Use a local disposable codex_online_ test database");
}
process.env.DATABASE_URL = process.env.ONLINE_TEST_DATABASE_URL;
process.env.JWT_SECRET = "online-http-smoke-only-at-least-thirty-two-bytes";
const { buildApp } = await import("../dist/app.js");
const { db } = await import("../dist/db.js");
const app = buildApp();
const directory = await mkdtemp(join(tmpdir(), "pokabow-http-smoke-"));
const players = [];
try {
  // The regression suite leaves a searching survivor in this disposable DB.
  await db.query("DELETE FROM matchmaking_tickets");
  await db.query("DELETE FROM matchmaking_lobbies");
  const endpoint = await app.listen({ host: "127.0.0.1", port: 0 });
  for (let i = 0; i < 2; i++) {
    const id = randomUUID();
    await db.query("INSERT INTO users (id, display_name, email) VALUES ($1,$2,$3)", [id, `Online player ${i + 1}`, `${id}@example.test`]);
    players.push({ id, token: app.jwt.sign({ sub: id }) });
  }
  const input = join(directory, "clients.json");
  await writeFile(input, JSON.stringify({ endpoint, players, capture: Boolean(process.env.ONLINE_CAPTURE_PATH), capturePath: process.env.ONLINE_CAPTURE_PATH }), { mode: 0o600 });
  const { stdout, stderr } = await promisify(execFile)(process.env.GODOT_BIN, [
    ...(process.env.ONLINE_CAPTURE_PATH ? ["--rendering-method", "gl_compatibility"] : ["--headless"]),
    "--path", process.env.ONLINE_RULES_PROJECT, "--script", "res://tools/smoke_online_http.gd", "--", input,
  ], { timeout: 90000, windowsHide: true, maxBuffer: 2 * 1024 * 1024 });
  process.stdout.write(stdout);
  process.stderr.write(stderr);
  if (/SCRIPT ERROR|ERROR:/.test(stderr + stdout)) throw new Error("Godot reported errors during HTTP smoke");
} finally {
  for (const player of players) await db.query("DELETE FROM users WHERE id = $1", [player.id]);
  await app.close();
  await db.end();
  await rm(directory, { recursive: true, force: true });
}
