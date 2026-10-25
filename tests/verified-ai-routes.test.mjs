import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

process.env.JWT_SECRET = "verified-ai-test-secret-at-least-thirty-two-bytes";
const { buildApp } = await import("../dist/app.js");
const { db } = await import("../dist/db.js");

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
