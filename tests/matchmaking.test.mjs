import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";

process.env.JWT_SECRET = "matchmaking-tests-only-at-least-thirty-two-bytes";
if (process.env.MATCHMAKING_TEST_DATABASE_URL) process.env.DATABASE_URL = process.env.MATCHMAKING_TEST_DATABASE_URL;
const { buildApp } = await import("../dist/app.js");
const { db } = await import("../dist/db.js");
const { matchmakingService } = await import("../dist/services/matchmaking-service.js");

test("matchmaking requires authentication and rejects identity/rules injection", async () => {
  const app = buildApp();
  await app.ready();
  const original = db.query;
  const originalJoin = matchmakingService.join;
  matchmakingService.join = async (_playerId, requestId) => ({ ticketId: requestId });
  db.query = async () => ({ rows: [{ id: "11111111-1111-4111-8111-111111111111" }] });
  const headers = { authorization: `Bearer ${app.jwt.sign({ sub: "11111111-1111-4111-8111-111111111111" })}` };
  try {
    assert.equal((await app.inject({ method: "POST", url: "/matchmaking/tickets", payload: {} })).statusCode, 401);
    for (const payload of [{}, { requestId: "bad", rulesVersion: "pokabow-v3" },
      { requestId: randomUUID(), rulesVersion: "different" },
      { requestId: randomUUID(), rulesVersion: "pokabow-v1" },
      { requestId: randomUUID(), rulesVersion: "pokabow-v3", userId: randomUUID() }]) {
      assert.equal((await app.inject({ method: "POST", url: "/matchmaking/tickets", headers, payload })).statusCode, 400);
    }
    const validRequestId = randomUUID();
    const valid = await app.inject({ method: "POST", url: "/matchmaking/tickets", headers, payload: { requestId: validRequestId, rulesVersion: "pokabow-v3" } });
    assert.equal(valid.statusCode, 200, valid.body);
    assert.equal(valid.json().ticketId, validRequestId);
    for (const [method, url] of [["DELETE", "/matchmaking/tickets/bad"], ["POST", "/matchmaking/tickets/bad/heartbeat"], ["DELETE", "/matchmaking/requests/bad"]]) {
      assert.equal((await app.inject({ method, url, headers })).statusCode, 400);
    }
  } finally { matchmakingService.join = originalJoin; db.query = original; await app.close(); }
});

test("PostgreSQL matchmaking lifecycle and races", { skip: !process.env.MATCHMAKING_TEST_DATABASE_URL }, async t => {
  // This must be an empty, disposable database; never a development/production DB.
  const existing = await db.query("SELECT to_regclass('public.users') AS existing");
  assert.equal(existing.rows[0].existing, null, "integration tests require an empty database");
  for (const file of ["001_initial.sql", "002_user_auth.sql", "004_oauth_accounts.sql", "005_game_crud.sql", "006_achievements.sql", "007_matchmaking.sql", "008_online_play.sql", "012_player_progression.sql"]) {
    await db.query(await readFile(new URL(`../migrations/${file}`, import.meta.url), "utf8"));
  }
  const app = buildApp();
  await app.ready();
  const players = Array.from({ length: 8 }, (_, i) => ({ id: randomUUID(), name: `Player ${i}` }));
  for (const player of players) await db.query("INSERT INTO users (id, display_name, email) VALUES ($1, $2, $3)", [player.id, player.name, `${player.id}@example.test`]);
  const headers = i => ({ authorization: `Bearer ${app.jwt.sign({ sub: players[i].id })}` });
  async function request(i, method, path, payload, expected = 200) {
    const result = await app.inject({ method, url: `/matchmaking${path}`, headers: headers(i), payload });
    assert.equal(result.statusCode, expected, result.body);
    return result.json();
  }
  const join = (i, id = randomUUID()) => request(i, "POST", "/tickets", { requestId: id, rulesVersion: "pokabow-v3" });
  const beat = (i, id) => request(i, "POST", `/tickets/${id}/heartbeat`);
  const cancel = (i, id) => request(i, "DELETE", `/tickets/${id}`);
  const reset = async () => { await db.query("DELETE FROM matchmaking_tickets"); await db.query("DELETE FROM matchmaking_lobbies"); };
  try {
    await t.test("skill distance prevents an unfair pair and prefers a nearby player", async () => {
      await reset();
      for (const [i, rating] of [[0, 1000], [1, 1900], [2, 1020]]) {
        await db.query("INSERT INTO player_skill (user_id, rating) VALUES ($1, $2)", [players[i].id, rating]);
      }
      const first = await join(0);
      assert.equal((await join(1)).status, "searching");
      const third = await join(2);
      assert.equal(third.status, "matched");
      assert.equal(third.lobby.opponent.id, players[0].id);
      assert.equal((await beat(1, (await request(1, "GET", "/tickets/current")).ticket.ticketId)).status, "searching");
      await db.query("DELETE FROM player_skill");
      await reset();
    });
    await t.test("pairs two accounts, recovers retries, exposes only public identity, creates no game", async () => {
      const key = randomUUID();
      const first = await join(0, key);
      assert.equal(first.status, "searching");
      assert.equal((await join(0, key)).ticketId, first.ticketId);
      assert.equal((await join(0)).ticketId, first.ticketId);
      const second = await join(1);
      const found = await beat(0, first.ticketId);
      assert.equal(found.status, "matched");
      assert.equal(found.lobby.id, second.lobby.id);
      assert.deepEqual(found.lobby.opponent, { id: players[1].id, displayName: players[1].name,
        onlineTier: "Provisional" });
      assert.equal(found.lobby.playable, false);
      assert.equal((await request(0, "GET", "/tickets/current")).ticket.ticketId, first.ticketId);
      assert.equal((await db.query("SELECT count(*)::int AS n FROM games")).rows[0].n, 0);
      await request(2, "DELETE", `/tickets/${first.ticketId}`, undefined, 404);
      await request(2, "POST", `/tickets/${first.ticketId}/heartbeat`, undefined, 404);
      await cancel(0, first.ticketId);
      assert.equal((await beat(1, second.ticketId)).status, "opponent_left");
      assert.equal((await cancel(0, first.ticketId)).status, "cancelled");
    });

    await t.test("concurrent and duplicated joins assign every account exactly once", async () => {
      await reset();
      const keys = players.map(() => randomUUID());
      await Promise.all(players.flatMap((_, i) => [join(i, keys[i]), join(i, keys[i])]));
      const tickets = (await db.query("SELECT * FROM matchmaking_tickets WHERE status = 'matched'")).rows;
      assert.equal(tickets.length, 8);
      assert.equal(new Set(tickets.map(row => row.user_id)).size, 8);
      assert.equal(new Set(tickets.map(row => row.lobby_id)).size, 4);
      for (const id of new Set(tickets.map(row => row.lobby_id))) assert.equal(tickets.filter(row => row.lobby_id === id).length, 2);
    });

    await t.test("cancellation racing a pairing cannot leave a ghost matched opponent", async () => {
      await reset();
      const first = await join(0);
      const [second] = await Promise.all([join(1), cancel(0, first.ticketId)]);
      const status = await beat(1, second.ticketId);
      assert.ok(["searching", "opponent_left"].includes(status.status));
      assert.equal(status.lobby, null);
    });

    await t.test("cancel-before-join tombstone defeats delayed join, stale cancel spares a newer search", async () => {
      await reset();
      const key = randomUUID();
      const tombstone = await request(0, "DELETE", `/requests/${key}`);
      assert.equal((await join(0, key)).status, "cancelled");
      const fresh = await join(0);
      await cancel(0, tombstone.ticketId);
      assert.equal((await beat(0, fresh.ticketId)).status, "searching");
    });

    await t.test("expired searches cannot pair or be revived, expired lobbies notify the survivor", async () => {
      await reset();
      const first = await join(0);
      await db.query("UPDATE matchmaking_tickets SET expires_at = clock_timestamp() - interval '1 second' WHERE id = $1", [first.ticketId]);
      const second = await join(1);
      assert.equal(second.status, "searching");
      assert.equal((await beat(0, first.ticketId)).status, "expired");
      const third = await join(2);
      assert.equal(third.status, "matched");
      await db.query("UPDATE matchmaking_tickets SET expires_at = clock_timestamp() - interval '1 second' WHERE id = $1", [third.ticketId]);
      assert.equal((await beat(1, second.ticketId)).status, "opponent_left");
      assert.equal((await db.query("SELECT count(*)::int AS n FROM matchmaking_lobbies")).rows[0].n, 0);
    });

    await t.test("account deletion removes presence and lets the other player search again", async () => {
      await reset();
      const first = await join(0);
      await join(1);
      const deletion = await app.inject({ method: "DELETE", url: "/auth/me", headers: headers(1), payload: { confirm: true } });
      assert.equal(deletion.statusCode, 200, deletion.body);
      assert.equal((await beat(0, first.ticketId)).status, "opponent_left");
      assert.equal((await join(0)).status, "searching");
    });
  } finally { await app.close(); await db.end(); }
});
