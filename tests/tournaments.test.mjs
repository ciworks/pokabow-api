import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createHash } from "node:crypto";

process.env.JWT_SECRET = "tournament-route-tests-only-at-least-thirty-two-bytes";
const { buildApp } = await import("../dist/app.js");
const { db } = await import("../dist/db.js");

test("tournament reads and mutations require bearer authentication", async () => {
  const app = buildApp();
  await app.ready();
  try {
    for (const [method, url] of [
      ["GET", "/tournaments"], ["GET", `/tournaments/${randomUUID()}`],
      ["GET", "/tournaments/matches/current"],
      ["POST", `/tournaments/${randomUUID()}/register`],
      ["POST", `/tournaments/matches/${randomUUID()}/commands`],
      ["GET", "/admin/api/tournaments"],
      ["POST", "/admin/api/tournaments"],
    ]) assert.equal((await app.inject({ method, url })).statusCode, 401, `${method} ${url}`);
  } finally { await app.close(); }
});

test("authenticated tournament routes reject malformed IDs and commands", async () => {
  const app = buildApp();
  await app.ready();
  const original = db.query;
  const account = randomUUID();
  db.query = async () => ({ rows: [{ id: account, email: "player@example.test" }] });
  const headers = { authorization: `Bearer ${app.jwt.sign({ sub: account })}` };
  try {
    for (const [method, url, payload] of [
      ["GET", "/tournaments/not-a-uuid"],
      ["POST", `/tournaments/${randomUUID()}/register`, { requestId: "wrong" }],
      ["POST", `/tournaments/${randomUUID()}/register`, { requestId: randomUUID(), stake: 0 }],
      ["POST", `/tournaments/matches/${randomUUID()}/commands`, { action: "resign", commandId: randomUUID(), expectedVersion: 1, score: 500 }],
      ["POST", `/tournaments/matches/${randomUUID()}/commands`, { action: "place", commandId: randomUUID(), expectedVersion: 1, placements: [{ tileId: "x", x: 12, y: 0, rotation: 0 }] }],
    ]) assert.equal((await app.inject({ method, url, payload, headers })).statusCode, 400, `${method} ${url}`);
    assert.equal((await app.inject({ method: "POST", url: `/tournaments/${randomUUID()}/withdraw`,
      headers, payload: { refund: 999 } })).statusCode, 400);
  } finally { db.query = original; await app.close(); }
});

test("admin tournament lifecycle requires a dedicated staff session", async () => {
  const app = buildApp();
  await app.ready();
  const originalQuery = db.query;
  const account = randomUUID();
  db.query = async sql => sql.includes("FROM staff_sessions")
    ? { rows: [{ id: account, email: "staff@example.test", role: "operator" }] }
    : { rows: [{ id: account, email: "player@example.test" }] };
  const playerHeaders = { authorization: `Bearer ${app.jwt.sign({ sub: account })}` };
  const headers = { cookie: "pokabow_staff=test-session",
    "x-csrf-token": createHash("sha256").update("csrf:test-session").digest("hex") };
  try {
    assert.equal((await app.inject({ url: "/admin/api/tournaments", headers: playerHeaders })).statusCode, 401);
    assert.equal((await app.inject({ method: "POST", url: "/admin/api/tournaments",
      headers, payload: { name: "Incomplete" } })).statusCode, 400);
    assert.equal((await app.inject({ method: "POST", url: `/admin/api/tournaments/${randomUUID()}/publish`,
      headers, payload: { startsAt: "changed" } })).statusCode, 400);
  } finally {
    db.query = originalQuery;
    await app.close();
  }
});
