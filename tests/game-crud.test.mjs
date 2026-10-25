import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import pg from "pg";

process.env.JWT_SECRET = "crud-tests-only-at-least-thirty-two-bytes";
const { buildApp } = await import("../dist/app.js");
const { db } = await import("../dist/db.js");

test("PATCH games handles PostgreSQL status types, versions and ownership", {
  skip: !process.env.GAME_CRUD_TEST_DATABASE_URL
}, async () => {
  const client = new pg.Client({ connectionString: process.env.GAME_CRUD_TEST_DATABASE_URL });
  const app = buildApp();
  const originalConnect = db.connect;
  const originalQuery = db.query;
  await client.connect();
  try {
    // Only session-local tables are visible. No application tables or rows are
    // changed, and closing this connection removes the complete fixture.
    await client.query("SET search_path TO pg_temp");
    const initial = await readFile(new URL("../migrations/001_initial.sql", import.meta.url), "utf8");
    await client.query(initial.replace(/CREATE EXTENSION[^;]+;/, "").replaceAll("CREATE TABLE ", "CREATE TEMP TABLE "));
    for (const migration of ["002_user_auth.sql", "005_game_crud.sql"]) {
      await client.query(await readFile(new URL(`../migrations/${migration}`, import.meta.url), "utf8"));
    }
    const owner = randomUUID();
    const other = randomUUID();
    await client.query("INSERT INTO users (id, display_name) VALUES ($1, 'Owner'), ($2, 'Other')", [owner, other]);
    // Both the route's authentication query and service transaction use this
    // dedicated connection, so every request sees only the temporary schema.
    db.query = (...args) => client.query(...args);
    db.connect = async () => ({ query: (...args) => client.query(...args), release() {} });
    await app.ready();
    const headers = { authorization: `Bearer ${app.jwt.sign({ sub: owner })}` };
    const created = await app.inject({ method: "POST", url: "/games", headers, payload: { state: { initial: true } } });
    assert.equal(created.statusCode, 201, created.body);
    const gameId = created.json().id;
    async function patch(payload, expected = 200, requestHeaders = headers, id = gameId) {
      const response = await app.inject({ method: "PATCH", url: `/games/${id}`, headers: requestHeaders, payload });
      assert.equal(response.statusCode, expected, response.body);
      return response.json();
    }

    const state = { localState: { board: [{ tile_id: "tile-one", rotation: 2 }] }, syncRevision: 1 };
    let updated = await patch({ expectedVersion: 1, state });
    assert.equal(updated.version, 2);
    assert.equal(updated.status, "active");
    assert.equal(updated.completed_at, null);
    assert.deepEqual(updated.state, state);

    updated = await patch({ expectedVersion: 2, status: "completed" });
    assert.equal(updated.version, 3);
    assert.equal(updated.status, "completed");
    assert.ok(updated.completed_at);
    assert.deepEqual(updated.state, state, "status-only updates preserve the JSON snapshot");
    const completedAt = updated.completed_at;

    updated = await patch({ expectedVersion: 3, state: { ...state, syncRevision: 2 }, status: "completed" });
    assert.equal(updated.version, 4);
    assert.equal(updated.completed_at, completedAt, "repeated completion keeps its original timestamp");
    assert.equal(updated.state.syncRevision, 2);

    updated = await patch({ expectedVersion: 4, status: "active" });
    assert.equal(updated.version, 5);
    assert.equal(updated.completed_at, null, "reopening clears completion time");
    assert.equal(updated.state.syncRevision, 2);

    assert.equal((await patch({ expectedVersion: 4, status: "completed" }, 409)).error, "STALE_GAME_STATE");
    const otherHeaders = { authorization: `Bearer ${app.jwt.sign({ sub: other })}` };
    assert.equal((await patch({ expectedVersion: 5, status: "completed" }, 403, otherHeaders)).error, "FORBIDDEN");
    assert.equal((await patch({ expectedVersion: 5, status: "completed" }, 404, headers, randomUUID())).error, "GAME_NOT_FOUND");
    const persisted = (await client.query("SELECT version, status FROM games WHERE id = $1", [gameId])).rows[0];
    assert.deepEqual(persisted, { version: 5, status: "active" }, "rejected requests leave the game unchanged");
  } finally {
    db.connect = originalConnect;
    db.query = originalQuery;
    await app.close();
    await client.end();
  }
});
