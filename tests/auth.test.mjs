import { test } from "node:test";
import assert from "node:assert/strict";

process.env.JWT_SECRET = "test-secret-with-at-least-thirty-two-bytes";
const { buildApp } = await import("../dist/app.js");
const { db } = await import("../dist/db.js");

const playerId = "11111111-1111-4111-8111-111111111111";
const otherId = "22222222-2222-4222-8222-222222222222";
const gameId = "33333333-3333-4333-8333-333333333333";
const app = buildApp();
await app.ready();

test("registration, login, and game authorization", async () => {
  let user;
  const originalQuery = db.query;
  const originalConnect = db.connect;

  db.query = async (sql, params) => {
    if (sql.includes("INSERT INTO users")) {
      user = { id: playerId, email: params[0], display_name: params[1], password_hash: params[2] };
      return { rows: [user] };
    }
    if (sql.includes("UPDATE users SET display_name")) {
      if (!user || params[1] !== playerId) return { rows: [] };
      assert.match(sql, /lower\(btrim\(other\.display_name\)\) = lower\(btrim\(\$1\)\)/);
      if (params[0].toLowerCase() === "taken name") return { rows: [] };
      user.display_name = params[0];
      return { rows: [{ id: user.id, email: user.email, display_name: user.display_name }] };
    }
    if (sql.includes("FROM users WHERE email")) return { rows: user ? [user] : [] };
    if (sql.includes("FROM users WHERE id")) return { rows: params[0] === playerId ? [user] : [{ id: otherId }] };
    if (sql.includes("JOIN game_players")) {
      return { rows: params[1] === playerId ? [{ id: gameId, version: 1 }] : [] };
    }
    throw new Error(`Unexpected query: ${sql}`);
  };

  db.connect = async () => ({
    query: async (sql) => {
      if (sql.includes("FROM games")) return { rows: [{ id: gameId, version: 1, current_player_id: playerId }] };
      if (sql.includes("FROM game_players")) return { rowCount: 0 };
      return { rows: [], rowCount: 0 };
    },
    release() {}
  });

  try {
    const register = await app.inject({
      method: "POST", url: "/auth/register",
      payload: { email: "Player@Example.com", password: "a-long-test-password", displayName: "Player" }
    });
    assert.equal(register.statusCode, 201);
    assert.equal(register.json().user.email, "player@example.com");
    const token = register.json().token;

    const noProfileUpdateToken = await app.inject({
      method: "PATCH", url: "/auth/me", payload: { displayName: "Updated" }
    });
    assert.equal(noProfileUpdateToken.statusCode, 401);

    const invalidProfileUpdate = await app.inject({
      method: "PATCH", url: "/auth/me",
      headers: { authorization: `Bearer ${token}` },
      payload: { displayName: "  " }
    });
    assert.equal(invalidProfileUpdate.statusCode, 400);

    const updatedProfile = await app.inject({
      method: "PATCH", url: "/auth/me",
      headers: { authorization: `Bearer ${token}` },
      payload: { displayName: "  New Name  " }
    });
    assert.equal(updatedProfile.statusCode, 200);
    assert.equal(updatedProfile.json().displayName, "New Name");
    assert.equal("password_hash" in updatedProfile.json(), false);

    const takenProfile = await app.inject({
      method: "PATCH", url: "/auth/me",
      headers: { authorization: `Bearer ${token}` },
      payload: { displayName: "  TAKEN NAME  " }
    });
    assert.equal(takenProfile.statusCode, 409);
    assert.equal(takenProfile.json().error, "USERNAME_TAKEN");

    const refreshedProfile = await app.inject({
      method: "GET", url: "/auth/me", headers: { authorization: `Bearer ${token}` }
    });
    assert.equal(refreshedProfile.json().displayName, "New Name");

    const login = await app.inject({
      method: "POST", url: "/auth/login",
      payload: { email: "player@example.com", password: "a-long-test-password" }
    });
    assert.equal(login.statusCode, 200);
    assert.ok(login.json().token);

    const badLogin = await app.inject({
      method: "POST", url: "/auth/login",
      payload: { email: "player@example.com", password: "wrong" }
    });
    assert.equal(badLogin.statusCode, 401);

    const noToken = await app.inject({ method: "GET", url: `/games/${gameId}` });
    assert.equal(noToken.statusCode, 401);
    const invalidToken = await app.inject({
      method: "GET", url: `/games/${gameId}`, headers: { authorization: "Bearer invalid" }
    });
    assert.equal(invalidToken.statusCode, 401);

    const mine = await app.inject({
      method: "GET", url: `/games/${gameId}`, headers: { authorization: `Bearer ${token}` }
    });
    assert.equal(mine.statusCode, 200);
    const otherToken = app.jwt.sign({ sub: otherId });
    const notMine = await app.inject({
      method: "GET", url: `/games/${gameId}`, headers: { authorization: `Bearer ${otherToken}` }
    });
    assert.equal(notMine.statusCode, 404);

    const turn = await app.inject({
      method: "POST", url: `/games/${gameId}/turns`,
      headers: { authorization: `Bearer ${otherToken}` },
      payload: {
        turnId: "44444444-4444-4444-8444-444444444444",
        expectedVersion: 1,
        playerId,
        placements: [{ tileId: "tile-1", x: 0, y: 0 }]
      }
    });
    assert.equal(turn.statusCode, 403);
  } finally {
    db.query = originalQuery;
    db.connect = originalConnect;
    await app.close();
  }
});
