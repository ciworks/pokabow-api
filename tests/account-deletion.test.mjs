import { test } from "node:test";
import assert from "node:assert/strict";
process.env.JWT_SECRET = "test-secret-with-at-least-thirty-two-bytes";
const { buildApp } = await import("../dist/app.js");
const { db } = await import("../dist/db.js");
const id = "11111111-1111-4111-8111-111111111111";
const gameId = "33333333-3333-4333-8333-333333333333";

test("account deletion requires identity and confirmation, commits before success, and revokes access", async () => {
  const app = buildApp();
  await app.ready();
  const originalConnect = db.connect;
  const originalQuery = db.query;
  const queries = [];
  let deleted = false;
  let fail = false;
  let released = 0;
  db.query = async (sql, params) => {
    assert.ok(sql.includes("FROM users WHERE id"));
    assert.deepEqual(params, [id]);
    return { rows: deleted ? [] : [{ id }] };
  };
  db.connect = async () => ({
    async query(sql, params) {
      queries.push({ sql, params });
      if (sql.includes("SELECT id FROM games")) return { rows: [{ id: gameId }] };
      if (sql.includes("DELETE FROM users")) {
        if (fail) throw new Error("Simulated database failure");
      }
      if (sql === "COMMIT") deleted = true;
      return { rows: [], rowCount: 1 };
    },
    release() { released++; }
  });
  const headers = { authorization: `Bearer ${app.jwt.sign({ sub: id })}` };
  try {
    for (const authorization of [undefined, "Bearer invalid"]) {
      const response = await app.inject({ method: "DELETE", url: "/auth/me", headers: authorization ? { authorization } : {}, payload: { confirm: true } });
      assert.equal(response.statusCode, 401);
    }
    for (const payload of [{}, { confirm: false }, { confirm: true, userId: gameId }]) {
      const response = await app.inject({ method: "DELETE", url: "/auth/me", headers, payload });
      assert.equal(response.statusCode, 400);
    }
    assert.equal(queries.length, 0, "unconfirmed requests never access a transaction");
    fail = true;
    const failed = await app.inject({ method: "DELETE", url: "/auth/me", headers, payload: { confirm: true } });
    assert.equal(failed.statusCode, 500);
    assert.equal(queries.at(-1).sql, "ROLLBACK");
    assert.equal(deleted, false);
    assert.equal(released, 1);
    queries.length = 0;
    fail = false;
    const response = await app.inject({ method: "DELETE", url: "/auth/me", headers, payload: { confirm: true } });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), { success: true });
    assert.equal(queries[0].sql, "BEGIN");
    assert.deepEqual(queries.find(q => q.sql.includes("SELECT id FROM users WHERE id = $1 FOR UPDATE"))?.params,
      [id], "target comes only from the signed subject");
    assert.deepEqual(queries.filter(q => q.sql.startsWith("DELETE FROM game_") ||
      q.sql.startsWith("DELETE FROM games ")).map(q => q.params),
    [[[gameId]], [[gameId]], [[gameId]]]);
    assert.deepEqual(queries.at(-2).params, [id]);
    assert.equal(queries.at(-1).sql, "COMMIT");
    assert.equal(released, 2);
    assert.equal((await app.inject({ method: "GET", url: "/auth/me", headers })).statusCode, 401);
    assert.equal((await app.inject({ method: "GET", url: "/games", headers })).statusCode, 401);
    const retry = await app.inject({ method: "DELETE", url: "/auth/me", headers, payload: { confirm: true } });
    assert.equal(retry.statusCode, 200, "a lost success response can be retried");
  } finally {
    db.connect = originalConnect;
    db.query = originalQuery;
    await app.close();
  }
});
