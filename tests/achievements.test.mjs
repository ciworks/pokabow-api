import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
process.env.JWT_SECRET = "test-secret-with-at-least-thirty-two-bytes";
const { buildApp } = await import("../dist/app.js");
const { db } = await import("../dist/db.js");
const playerId = "11111111-1111-4111-8111-111111111111";

test("progress and admin routes reject unauthenticated, invalid and non-admin requests", async () => {
  const app = buildApp();
  await app.ready();
  const originalQuery = db.query;
  db.query = async sql => {
    if (sql.includes("FROM users WHERE id")) {
      return { rows: [{ id: playerId, email: "player@example.com" }] };
    }
    throw new Error(`Unexpected query: ${sql}`);
  };
  const headers = { authorization: `Bearer ${app.jwt.sign({ sub: playerId })}` };
  try {
    assert.equal((await app.inject({ method: "POST", url: "/achievements/progress", payload: { events: [] } })).statusCode, 401);
    for (const payload of [
      { events: [] },
      { events: [{ eventId: "e1", metric: "made_up_rule" }] },
      { events: [{ eventId: "e2", metric: "active_days" }] },
      { events: [{ eventId: "e1", metric: "two_pair_scored" }, { eventId: "e1", metric: "two_pair_scored" }] }
    ]) {
      assert.equal((await app.inject({ method: "POST", url: "/achievements/progress", headers, payload })).statusCode, 400);
    }
    assert.equal((await app.inject({ method: "GET", url: "/admin/api/achievements", headers })).statusCode, 401);
    assert.equal((await app.inject({ method: "POST", url: "/admin/api/achievements", headers, payload: {
      id: "new_badge", name: "New Badge", description: "Test", category: "Hands",
      badgeKey: "milestone", metric: "two_pair_scored", target: 10, enabled: true
    } })).statusCode, 401);
    assert.equal((await app.inject({ method: "GET", url: "/admin/achievements" })).statusCode, 404);
  } finally {
    db.query = originalQuery;
    await app.close();
  }
});

test("dedicated staff sessions can create and edit only registered catalogue entries", async () => {
  const app = buildApp();
  await app.ready();
  const originalQuery = db.query;
  const writes = [];
  db.query = async (sql, params) => {
    if (sql.includes("FROM staff_sessions")) return { rows: [{ id: playerId, email: "owner@example.com", role: "emergency_operator" }] };
    if (sql.includes("INSERT INTO achievements")) { writes.push({ sql, params }); return { rowCount: 1, rows: [{ id: params[0] }] }; }
    if (sql.includes("UPDATE achievements SET")) { writes.push({ sql, params }); return { rowCount: 1, rows: [{ id: params[0] }] }; }
    if (sql.includes("FROM achievements ORDER BY")) return { rows: [] };
    throw new Error(`Unexpected query: ${sql}`);
  };
  const headers = { cookie: "pokabow_staff=test-session",
    "x-csrf-token": createHash("sha256").update("csrf:test-session").digest("hex") };
  const item = { id: "two_pair_25", name: "Two Pair Master", description: "Score 25 Two Pair hands.", category: "Hands", badgeKey: "two_pair_10", metric: "two_pair_scored", target: 25, enabled: true };
  try {
    assert.equal((await app.inject({ method: "POST", url: "/admin/api/achievements", headers, payload: { ...item, metric: "arbitrary_code" } })).statusCode, 400);
    assert.equal((await app.inject({ method: "POST", url: "/admin/api/achievements", headers, payload: item })).statusCode, 201);
    assert.deepEqual(writes[0].params.slice(0, 6), [item.id, item.name, item.description, item.category, item.metric, item.target]);
    assert.equal((await app.inject({ method: "PATCH", url: `/admin/api/achievements/${item.id}`, headers, payload: {
      name: "Two Pair Veteran", description: item.description, category: item.category, badgeKey: item.badgeKey, enabled: true
    } })).statusCode, 200);
    assert.equal(writes.length, 2);
  } finally {
    db.query = originalQuery;
    await app.close();
  }
});
