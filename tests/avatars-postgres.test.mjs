import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import sharp from "sharp";

process.env.JWT_SECRET = "test-secret-with-at-least-thirty-two-bytes";

test("PostgreSQL avatar migration, replacement, binary round trip, removal, and account cascade", {
  skip: process.env.AVATAR_DB_TEST !== "1"
}, async () => {
  const { config } = await import("../dist/config.js");
  assert.ok(["localhost", "127.0.0.1", "[::1]"].includes(new URL(config.databaseUrl).hostname), "Use a local test database");
  const { db } = await import("../dist/db.js");
  const { buildApp } = await import("../dist/app.js");
  const app = buildApp();
  const client = await db.connect();
  const originalQuery = db.query;
  try {
    await client.query("BEGIN");
    const schema = `avatar_test_${randomUUID().replaceAll("-", "")}`;
    await client.query(`CREATE SCHEMA "${schema}"`);
    await client.query(`SET LOCAL search_path TO "${schema}"`);
    await client.query(`CREATE TABLE users (
      id UUID PRIMARY KEY, email TEXT, display_name TEXT, password_hash TEXT
    )`);
    await client.query(await readFile(new URL("../migrations/009_user_avatars.sql", import.meta.url), "utf8"));
    db.query = client.query.bind(client);
    const userId = randomUUID();
    await client.query("INSERT INTO users (id, display_name) VALUES ($1, 'Avatar test')", [userId]);
    await app.ready();
    const headers = { authorization: `Bearer ${app.jwt.sign({ sub: userId })}` };
    for (const background of ["red", "blue"]) {
      const png = await sharp({ create: { width: 195, height: 195, channels: 3, background } }).png().toBuffer();
      const response = await app.inject({ method: "PUT", url: "/auth/me/avatar", headers,
        payload: { contentType: "image/png", data: png.toString("base64") } });
      assert.equal(response.statusCode, 200, response.body);
      assert.ok(Date.parse(response.json().avatar.updatedAt));
      const stored = await client.query("SELECT png FROM user_avatars WHERE user_id = $1", [userId]);
      assert.equal(stored.rowCount, 1);
      const downloaded = await app.inject({ method: "GET", url: "/auth/me/avatar", headers });
      assert.equal(downloaded.statusCode, 200);
      assert.deepEqual(downloaded.rawPayload, stored.rows[0].png);
      const stats = await sharp(downloaded.rawPayload).stats();
      assert.equal(stats.channels[background === "red" ? 0 : 2].min, 255);
    }
    assert.equal((await app.inject({ method: "DELETE", url: "/auth/me/avatar", headers })).statusCode, 204);
    assert.equal((await app.inject({ method: "GET", url: "/auth/me/avatar", headers })).statusCode, 404);
    const png = await sharp({ create: { width: 195, height: 195, channels: 3, background: "green" } }).png().toBuffer();
    assert.equal((await app.inject({ method: "PUT", url: "/auth/me/avatar", headers,
      payload: { contentType: "image/png", data: png.toString("base64") } })).statusCode, 200);
    await client.query("DELETE FROM users WHERE id = $1", [userId]);
    assert.equal((await client.query("SELECT * FROM user_avatars")).rowCount, 0);
    assert.equal((await app.inject({ method: "GET", url: "/auth/me/avatar", headers })).statusCode, 401);
  } finally {
    db.query = originalQuery;
    await client.query("ROLLBACK");
    client.release();
    await app.close();
    await db.end();
  }
});
