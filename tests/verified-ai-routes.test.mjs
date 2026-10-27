import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

process.env.JWT_SECRET = "verified-ai-test-secret-at-least-thirty-two-bytes";
const { buildApp } = await import("../dist/app.js");
const { db } = await import("../dist/db.js");
const { verifiedAiGameService } = await import("../dist/services/verified-ai-game-service.js");

test("verified AI routes require an account and reject malformed commands", async () => {
  const app = buildApp();
  await app.ready();
  const original = db.query;
  const userId = randomUUID();
  db.query = async () => ({ rows: [{ id: userId }] });
  const headers = { authorization: `Bearer ${app.jwt.sign({ sub: userId })}` };
  try {
    assert.equal((await app.inject({ method: "POST", url: "/ai-games/", payload: { requestId: randomUUID(), difficulty: 0 } })).statusCode, 401);
    assert.equal((await app.inject({ method: "POST", url: "/ai-games/", headers,
      payload: { requestId: randomUUID(), difficulty: 3 } })).statusCode, 400);
    assert.equal((await app.inject({ method: "POST", url: `/ai-games/${randomUUID()}/commands`, headers,
      payload: { commandId: randomUUID(), expectedVersion: 1, action: "resign", outcome: 1 } })).statusCode, 400);
    assert.equal((await app.inject({ method: "POST", url: `/ai-games/${randomUUID()}/commands`, headers,
      payload: { commandId: randomUUID(), expectedVersion: 1, action: "difficulty", difficulty: -1 } })).statusCode, 400);
  } finally { db.query = original; await app.close(); }
});

test("AI rival catalogue exposes database identities and tiers", async () => {
  const app = buildApp();
  await app.ready();
  const original = db.query;
  db.query = async sql => {
    assert.match(sql, /FROM ai_rivals/);
    return { rows: [{ id: "rival_01", display_name: "Pippa",
      avatar_key: "rival_01", difficulty: 0 }] };
  };
  try {
    const response = await app.inject({ method: "GET", url: "/ai-rivals/" });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), { rivals: [{ id: "rival_01", displayName: "Pippa",
      avatarKey: "rival_01", difficulty: 0 }] });
  } finally { db.query = original; await app.close(); }
});

test("match creation accepts the game's named rival payload", async () => {
  const app = buildApp();
  await app.ready();
  const originalQuery = db.query;
  const originalCreate = verifiedAiGameService.create;
  const userId = randomUUID();
  const requestId = randomUUID();
  db.query = async () => ({ rows: [{ id: userId }] });
  verifiedAiGameService.create = async (...args) => {
    assert.deepEqual(args, [userId, requestId, 1, "rival_07"]);
    return { matchId: requestId, version: 1 };
  };
  try {
    const response = await app.inject({ method: "POST", url: "/ai-games/",
      headers: { authorization: `Bearer ${app.jwt.sign({ sub: userId })}` },
      payload: { requestId, difficulty: 1, rivalId: "rival_07" } });
    assert.equal(response.statusCode, 200);
  } finally {
    db.query = originalQuery;
    verifiedAiGameService.create = originalCreate;
    await app.close();
  }
});

test("active AI endpoint returns every resumable match", async () => {
  const app = buildApp();
  await app.ready();
  const originalQuery = db.query;
  const originalActive = verifiedAiGameService.active;
  const userId = randomUUID();
  db.query = async () => ({ rows: [{ id: userId }] });
  verifiedAiGameService.active = async requestedUser => {
    assert.equal(requestedUser, userId);
    return [{ matchId: "nia" }, { matchId: "new" }];
  };
  try {
    const response = await app.inject({ method: "GET", url: "/ai-games/active",
      headers: { authorization: `Bearer ${app.jwt.sign({ sub: userId })}` } });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), { matches: [{ matchId: "nia" }, { matchId: "new" }] });
  } finally {
    db.query = originalQuery;
    verifiedAiGameService.active = originalActive;
    await app.close();
  }
});
