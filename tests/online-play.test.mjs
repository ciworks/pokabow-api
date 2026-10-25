import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";

process.env.JWT_SECRET = "online-tests-only-at-least-thirty-two-bytes";
if (process.env.ONLINE_TEST_DATABASE_URL) process.env.DATABASE_URL = process.env.ONLINE_TEST_DATABASE_URL;
const { buildApp } = await import("../dist/app.js");
const { db } = await import("../dist/db.js");
const { createVerifiedAiGameService } = await import("../dist/services/verified-ai-game-service.js");
const { runOnlineRules } = await import("../dist/game/online-rules.js");

test("online routes require authentication and validate commands strictly", async () => {
  const app = buildApp();
  await app.ready();
  const original = db.query;
  const id = randomUUID();
  db.query = async () => ({ rows: [{ id }] });
  const headers = { authorization: `Bearer ${app.jwt.sign({ sub: id })}` };
  try {
    for (const url of ["/online-games/current", `/online-games/${randomUUID()}`]) {
      assert.equal((await app.inject({ url })).statusCode, 401);
    }
    for (const payload of [
      {}, { action: "place", commandId: randomUUID(), expectedVersion: 1, placements: [] },
      { action: "resign", commandId: randomUUID(), expectedVersion: 1, playerId: id },
      { action: "place", commandId: randomUUID(), expectedVersion: 1, placements: [{ tileId: "x", x: 12, y: 1, rotation: 0 }] },
      { action: "place", commandId: randomUUID(), expectedVersion: 1, placements: [{ tileId: "x", x: 1, y: 1, rotation: 4 }] },
      { action: "resign", commandId: randomUUID(), expectedVersion: 1, score: 999 },
    ]) assert.equal((await app.inject({ method: "POST", url: `/online-games/${randomUUID()}/commands`, headers, payload })).statusCode, 400);
  } finally { db.query = original; await app.close(); }
});

test("authoritative online lifecycle against PostgreSQL and TypeScript rules", {
  skip: !process.env.ONLINE_TEST_DATABASE_URL,
}, async t => {
  assert.equal((await db.query("SELECT to_regclass('public.users') AS existing")).rows[0].existing, null, "requires an empty disposable database");
  for (const file of ["001_initial.sql", "002_user_auth.sql", "004_oauth_accounts.sql", "005_game_crud.sql", "006_achievements.sql", "007_matchmaking.sql", "008_online_play.sql", "012_player_progression.sql", "013_gem_wallet.sql", "014_verified_ai_matches.sql", "015_verified_ai_gems.sql", "016_remove_turn_deadlines.sql"]) {
    await db.query(await readFile(new URL(`../migrations/${file}`, import.meta.url), "utf8"));
  }
  const app = buildApp();
  await app.ready();
  const players = Array.from({ length: 3 }, () => randomUUID());
  for (const [i, id] of players.entries()) await db.query("INSERT INTO users (id, display_name, email) VALUES ($1,$2,$3)", [id, `Online ${i}`, `${id}@example.test`]);
  const headers = i => ({ authorization: `Bearer ${app.jwt.sign({ sub: players[i] })}` });
  async function request(i, method, url, payload, status = 200) {
    const result = await app.inject({ method, url, headers: headers(i), payload });
    assert.equal(result.statusCode, status, result.body);
    assert.equal(result.headers["cache-control"], "no-store");
    return result.json();
  }
  let matchId, first, second, a, b;
  try {
    await t.test("concurrent ready retries create exactly one shared game", async () => {
      first = await request(0, "POST", "/matchmaking/tickets", { requestId: randomUUID(), rulesVersion: "pokabow-v3" });
      second = await request(1, "POST", "/matchmaking/tickets", { requestId: randomUUID(), rulesVersion: "pokabow-v3" });
      await request(2, "POST", `/matchmaking/tickets/${first.ticketId}/ready`, undefined, 404);
      await Promise.all([0, 1, 0, 1].map(i => request(i, "POST", `/matchmaking/tickets/${i === 0 ? first.ticketId : second.ticketId}/ready`)));
      assert.equal((await db.query("SELECT count(*)::int n FROM online_matches")).rows[0].n, 1);
      assert.equal((await db.query("SELECT count(*)::int n FROM games")).rows[0].n, 0);
      const lobby = await request(0, "POST", `/matchmaking/tickets/${first.ticketId}/heartbeat`);
      assert.equal(lobby.status, "playing");
      matchId = lobby.lobby.matchId;
    });
    await t.test("views hide the other hand and bag; only participants may read", async () => {
      a = await request(0, "GET", `/online-games/${matchId}`);
      b = await request(1, "GET", `/online-games/${matchId}`);
      assert.equal(a.seat, "human");
      assert.equal(b.seat, "ai");
      for (const tile of b.hand) assert.ok(!JSON.stringify(a).includes(tile.tile_id));
      for (const key of ["snapshot", "seed", "decks", "tile_source", "views"]) assert.ok(!(key in a));
      await request(2, "GET", `/online-games/${matchId}`, undefined, 404);
      assert.equal((await request(0, "GET", "/online-games/current")).match.matchId, matchId);
    });
    await t.test("out-of-turn and forged-tile commands change nothing", async () => {
      const bad = await request(1, "POST", `/online-games/${matchId}/commands`,
        { commandId: randomUUID(), expectedVersion: a.version, action: "swap", tileIds: [b.hand[0].tile_id] }, 409);
      assert.equal(bad.error, "NOT_YOUR_TURN");
      const forged = await request(0, "POST", `/online-games/${matchId}/commands`,
        { commandId: randomUUID(), expectedVersion: a.version, action: "place", placements: [{ tileId: b.hand[0].tile_id, x: 5, y: 5, rotation: 0 }] }, 409);
      assert.equal(forged.error, "TILE_NOT_AVAILABLE");
      assert.equal(forged.version, a.version);
      assert.deepEqual(forged.hand, a.hand);
    });
    await t.test("simultaneous retries spend one turn; reused IDs and stale versions fail", async () => {
      const command = { commandId: randomUUID(), expectedVersion: a.version, action: "swap", tileIds: [a.hand[0].tile_id] };
      const replies = await Promise.all([request(0, "POST", `/online-games/${matchId}/commands`, command), request(0, "POST", `/online-games/${matchId}/commands`, command)]);
      assert.equal(replies[0].version, a.version + 1);
      assert.equal(replies[1].version, replies[0].version);
      assert.equal((await db.query("SELECT count(*)::int n FROM online_commands")).rows[0].n, 1);
      const reused = await request(0, "POST", `/online-games/${matchId}/commands`, { ...command, tileIds: [a.hand[1].tile_id] }, 409);
      assert.equal(reused.error, "COMMAND_ID_REUSED");
      const stale = await request(1, "POST", `/online-games/${matchId}/commands`, { ...command, commandId: randomUUID(), tileIds: [b.hand[0].tile_id] }, 409);
      assert.equal(stale.error, "VERSION_CONFLICT");
      b = await request(1, "GET", `/online-games/${matchId}`);
    });
    await t.test("a stale stored deadline cannot consume a turn or block a command", async () => {
      await db.query("UPDATE online_matches SET deadline_at = clock_timestamp() - interval '1 second', last_seen_a = clock_timestamp() - interval '20 seconds' WHERE id = $1", [matchId]);
      const unchanged = await request(1, "GET", `/online-games/${matchId}`);
      assert.equal(unchanged.version, b.version);
      assert.equal(unchanged.deadline, null);
      const played = await request(1, "POST", `/online-games/${matchId}/commands`,
        { commandId: randomUUID(), expectedVersion: b.version, action: "swap", tileIds: [b.hand[0].tile_id] });
      assert.equal(played.version, b.version + 1);
      assert.equal(played.turn.active_player_id, "human");
      assert.equal(played.opponent.connected, false);
      const persisted = await request(0, "GET", `/online-games/${matchId}`);
      assert.equal(persisted.version, played.version);
      assert.equal(persisted.deadline, null);
      a = persisted;
    });
    await t.test("resignation ends both views and retries cannot restart a game", async () => {
      const command = { commandId: randomUUID(), expectedVersion: a.version, action: "resign" };
      const end = await request(1, "POST", `/online-games/${matchId}/commands`, command);
      assert.equal(end.status, "completed");
      assert.equal(end.outcome, 1);
      assert.equal(end.deadline, null);
      assert.equal((await request(1, "POST", `/online-games/${matchId}/commands`, command)).version, end.version);
      assert.equal((await request(0, "GET", "/online-games/current")).match, null);
      assert.equal((await request(0, "GET", `/online-games/${matchId}`)).status, "completed");
      const awards = await db.query("SELECT user_id, experience_awarded FROM player_match_awards WHERE match_id = $1", [matchId]);
      assert.equal(awards.rows.length, 2);
      assert.ok(awards.rows.every(row => row.experience_awarded === 100));
      const progression = await request(0, "GET", "/progression/me");
      assert.equal(progression.experience, 100);
      assert.equal(progression.level, 2);
      assert.equal(progression.onlineTier, "Provisional");
      assert.equal(progression.ratedMatches, 1);
      const walletA = await request(0, "GET", "/gems/me");
      const walletB = await request(1, "GET", "/gems/me");
      assert.equal(walletA.balance, end.gemSettlement.potTotal);
      assert.equal(walletB.balance, 0);
      assert.equal(walletA.transactions.length, end.gemSettlement.potTotal > 0 ? 1 : 0);
      assert.equal((await request(0, "GET", `/online-games/${matchId}`)).gemSettlement.humanTotal,
        end.gemSettlement.potTotal);
      assert.equal((await db.query("SELECT count(*)::int n FROM online_gem_settlements WHERE match_id = $1", [matchId])).rows[0].n, 1);
    });
    await t.test("verified AI owns play and resignation grants no Gems", async () => {
      const requestId = randomUUID();
      const started = await request(0, "POST", "/ai-games/", { requestId, difficulty: 0 });
      assert.equal(started.status, "active");
      assert.equal(started.deadline, null);
      assert.equal(started.rewardDifficulty, 0);
      assert.ok(!("snapshot" in started));
      assert.equal((await request(0, "GET", "/ai-games/current")).match.matchId, requestId);
      await request(2, "GET", `/ai-games/${requestId}`, undefined, 404);
      await db.query("UPDATE verified_ai_matches SET deadline_at = clock_timestamp() - interval '1 day' WHERE id = $1", [requestId]);
      const turn = await request(0, "POST", `/ai-games/${requestId}/commands`, {
        commandId: randomUUID(), expectedVersion: started.version, action: "swap",
        tileIds: [started.hand[0].tile_id],
      });
      assert.equal(turn.version, started.version + 1);
      assert.equal(turn.deadline, null);
      assert.equal(turn.turn.active_player_id, "human");
      const endCommand = { commandId: randomUUID(), expectedVersion: turn.version, action: "resign" };
      const ended = await request(0, "POST", `/ai-games/${requestId}/commands`, endCommand);
      assert.equal(ended.status, "completed");
      assert.equal(ended.gemSettlementStatus, "confirmed");
      assert.equal(ended.gemSettlement.humanTotal, 0);
      assert.equal((await request(0, "POST", `/ai-games/${requestId}/commands`, endCommand)).version, ended.version);
      assert.equal((await db.query("SELECT count(*)::int n FROM gem_transactions WHERE match_id = $1", [requestId])).rows[0].n, 0);
      assert.equal((await db.query("SELECT status, amount FROM verified_ai_gem_settlements WHERE match_id = $1", [requestId])).rows[0].status, "confirmed");
    });
    await t.test("verified AI credits one capped win after difficulty changes, with no backfill", async () => {
      let createdState;
      const rules = async command => {
        if (command.action === "create") {
          createdState = await runOnlineRules(command);
          return createdState;
        }
        const snapshot = structuredClone(command.snapshot);
        snapshot.outcome = 1;
        snapshot.end_reason = 1;
        snapshot.ledger.events = [
          { event_id: "one", category: 0, evidence: { category: "FOUR_OF_A_KIND" } },
          { event_id: "two", category: 0, evidence: { category: "FOUR_OF_A_KIND" } },
        ];
        return { snapshot, views: createdState.views };
      };
      const service = createVerifiedAiGameService(db, rules);
      const before = (await request(0, "GET", "/gems/me")).balance;
      const id = randomUUID();
      let game = await service.create(players[0], id, 2);
      game = await service.command(players[0], id, { commandId: randomUUID(), expectedVersion: game.version,
        action: "difficulty", difficulty: 0 });
      game = await service.command(players[0], id, { commandId: randomUUID(), expectedVersion: game.version,
        action: "difficulty", difficulty: 2 });
      assert.equal(game.rewardDifficulty, 0);
      game = await service.command(players[0], id, { commandId: randomUUID(), expectedVersion: game.version,
        action: "swap", tileIds: [] });
      assert.equal(game.status, "completed");
      assert.equal(game.gemSettlementStatus, "confirmed");
      assert.equal(game.gemSettlement.potTotal, 20);
      assert.equal(game.gemSettlement.humanTotal, 20);
      await Promise.all(Array.from({ length: 4 }, () => service.get(players[0], id)));
      assert.equal((await request(0, "GET", "/gems/me")).balance, before + 20);
      assert.equal((await db.query("SELECT count(*)::int n FROM gem_transactions WHERE match_id = $1", [id])).rows[0].n, 1);

      const oldId = randomUUID();
      let old = await service.create(players[0], oldId, 2);
      await db.query("UPDATE verified_ai_matches SET gem_eligible = FALSE WHERE id = $1", [oldId]);
      old = await service.command(players[0], oldId, { commandId: randomUUID(), expectedVersion: old.version,
        action: "swap", tileIds: [] });
      assert.equal(old.gemSettlement, null);
      assert.equal(old.gemSettlementStatus, "ineligible");
      assert.equal((await db.query("SELECT count(*)::int n FROM gem_transactions WHERE match_id = $1", [oldId])).rows[0].n, 0);

      const retryId = randomUUID();
      let retry = await service.create(players[0], retryId, 0);
      await db.query(`CREATE FUNCTION reject_ai_gem_confirmation() RETURNS trigger AS $$
        BEGIN RAISE EXCEPTION 'temporary AI wallet outage'; END $$ LANGUAGE plpgsql`);
      await db.query(`CREATE TRIGGER reject_ai_gem_confirmation BEFORE UPDATE ON verified_ai_gem_settlements
        FOR EACH ROW EXECUTE FUNCTION reject_ai_gem_confirmation()`);
      retry = await service.command(players[0], retryId, { commandId: randomUUID(), expectedVersion: retry.version,
        action: "swap", tileIds: [] });
      assert.equal(retry.status, "completed");
      assert.equal(retry.gemSettlementStatus, "pending");
      assert.equal(retry.gemSettlement, null);
      assert.equal((await db.query("SELECT status FROM verified_ai_gem_settlements WHERE match_id = $1", [retryId])).rows[0].status, "pending");
      await db.query("DROP TRIGGER reject_ai_gem_confirmation ON verified_ai_gem_settlements");
      await db.query("DROP FUNCTION reject_ai_gem_confirmation()");
      retry = await service.get(players[0], retryId);
      assert.equal(retry.gemSettlementStatus, "confirmed");
      assert.equal(retry.gemSettlement.humanTotal, 20);
      assert.equal((await db.query("SELECT count(*)::int n FROM gem_transactions WHERE match_id = $1", [retryId])).rows[0].n, 1);
    });
    await t.test("wallet failure leaves a terminal result pending and retry confirms it", async () => {
      await db.query("UPDATE player_skill SET rating = 1500, deviation = 350, volatility = 0.06, rated_matches = 0");
      const one = await request(0, "POST", "/matchmaking/tickets", { requestId: randomUUID(), rulesVersion: "pokabow-v3" });
      const two = await request(1, "POST", "/matchmaking/tickets", { requestId: randomUUID(), rulesVersion: "pokabow-v3" });
      await request(0, "POST", `/matchmaking/tickets/${one.ticketId}/ready`);
      const ready = await request(1, "POST", `/matchmaking/tickets/${two.ticketId}/ready`);
      const pendingId = ready.lobby.matchId;
      const active = await request(1, "GET", `/online-games/${pendingId}`);
      await db.query(`CREATE FUNCTION reject_gem_confirmation() RETURNS trigger AS $$
        BEGIN RAISE EXCEPTION 'temporary wallet outage'; END $$ LANGUAGE plpgsql`);
      await db.query(`CREATE TRIGGER reject_gem_confirmation BEFORE UPDATE ON online_gem_settlements
        FOR EACH ROW EXECUTE FUNCTION reject_gem_confirmation()`);
      const ended = await request(1, "POST", `/online-games/${pendingId}/commands`, {
        commandId: randomUUID(), expectedVersion: active.version, action: "resign",
      });
      assert.equal(ended.status, "completed");
      assert.equal(ended.gemSettlementStatus, "pending");
      assert.equal(ended.gemSettlement, null);
      assert.equal((await db.query("SELECT status FROM online_gem_settlements WHERE match_id = $1", [pendingId])).rows[0].status, "pending");
      await db.query("DROP TRIGGER reject_gem_confirmation ON online_gem_settlements");
      await db.query("DROP FUNCTION reject_gem_confirmation()");
      const recovered = await request(0, "GET", `/online-games/${pendingId}`);
      assert.equal(recovered.status, "completed");
      assert.equal(recovered.gemSettlementStatus, "confirmed");
      assert.equal(recovered.gemSettlement.potTotal, 0);
      assert.equal((await db.query("SELECT status FROM online_gem_settlements WHERE match_id = $1", [pendingId])).rows[0].status, "confirmed");
    });
    await t.test("leaving a lobby prevents late readiness from starting a game", async () => {
      // This scenario tests lobby departure, not a rematch between players whose
      // skill ratings diverged after the preceding verified match.
      await db.query("UPDATE player_skill SET rating = 1500, deviation = 350, volatility = 0.06, rated_matches = 0");
      first = await request(0, "POST", "/matchmaking/tickets", { requestId: randomUUID(), rulesVersion: "pokabow-v3" });
      second = await request(1, "POST", "/matchmaking/tickets", { requestId: randomUUID(), rulesVersion: "pokabow-v3" });
      await request(0, "POST", `/matchmaking/tickets/${first.ticketId}/ready`);
      await request(1, "DELETE", `/matchmaking/tickets/${second.ticketId}`);
      await request(1, "POST", `/matchmaking/tickets/${second.ticketId}/ready`, undefined, 409);
      assert.equal((await db.query("SELECT count(*)::int n FROM online_matches")).rows[0].n, 2);
    });
    await t.test("account deletion ends a live game and releases the survivor's queue ticket", async () => {
      first = await request(0, "POST", "/matchmaking/tickets", { requestId: randomUUID(), rulesVersion: "pokabow-v3" });
      second = await request(1, "POST", "/matchmaking/tickets", { requestId: randomUUID(), rulesVersion: "pokabow-v3" });
      await request(0, "POST", `/matchmaking/tickets/${first.ticketId}/ready`);
      const started = await request(1, "POST", `/matchmaking/tickets/${second.ticketId}/ready`);
      await db.query("DELETE FROM users WHERE id = $1", [players[1]]);
      const ended = await request(0, "GET", `/online-games/${started.lobby.matchId}`);
      assert.equal(ended.status, "completed");
      assert.equal(ended.outcome, 1);
      const fresh = await request(0, "POST", "/matchmaking/tickets", { requestId: randomUUID(), rulesVersion: "pokabow-v3" });
      assert.equal(fresh.status, "searching");
    });
  } finally { await app.close(); await db.end(); }
});
