import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";

process.env.JWT_SECRET = "tournament-postgres-tests-only-at-least-thirty-two-bytes";
if (process.env.TOURNAMENT_TEST_DATABASE_URL)
  process.env.DATABASE_URL = process.env.TOURNAMENT_TEST_DATABASE_URL;
const { buildApp } = await import("../dist/app.js");
const { db } = await import("../dist/db.js");
const { tickTournaments, commandTournamentMatch } = await import("../dist/services/tournament-bracket.js");

test("tournament entries, live bracket, prize and cancellation use one authoritative ledger", {
  skip: !process.env.TOURNAMENT_TEST_DATABASE_URL,
}, async () => {
  assert.equal((await db.query("SELECT to_regclass('public.users') AS existing")).rows[0].existing,
    null, "requires an empty disposable database");
  for (const file of ["001_initial.sql", "002_user_auth.sql", "004_oauth_accounts.sql",
    "005_game_crud.sql", "006_achievements.sql", "007_matchmaking.sql", "008_online_play.sql",
    "009_user_avatars.sql",
    "012_player_progression.sql", "013_gem_wallet.sql", "014_verified_ai_matches.sql",
    "015_verified_ai_gems.sql", "016_remove_turn_deadlines.sql", "017_rewarded_ad_gems.sql",
    "018_online_gem_limits.sql", "019_ai_rivals.sql", "020_multiple_verified_ai_matches.sql",
    "021_tournaments.sql"]) {
    await db.query(await readFile(new URL(`../migrations/${file}`, import.meta.url), "utf8"));
  }
  const app = buildApp();
  await app.ready();
  const admin = randomUUID();
  const players = Array.from({ length: 5 }, () => randomUUID());
  process.env.ADMIN_EMAILS = "tournament-admin@example.test";
  for (const [id, name, email] of [[admin, "Admin", "tournament-admin@example.test"],
    ...players.map((id, i) => [id, `Player ${i}`, `${id}@example.test`])]) {
    await db.query("INSERT INTO users (id,display_name,email) VALUES ($1,$2,$3)", [id, name, email]);
  }
  for (const id of players) await db.query("INSERT INTO gem_wallets (user_id,balance) VALUES ($1,100)", [id]);
  const token = new Map([admin, ...players].map(id => [id, app.jwt.sign({ sub: id })]));
  const request = async (id, method, url, payload, status = 200) => {
    const response = await app.inject({ method, url,
      headers: { authorization: `Bearer ${token.get(id)}` }, payload });
    assert.equal(response.statusCode, status, response.body);
    if (url.startsWith("/tournaments") || url.startsWith("/admin/api/tournaments"))
      assert.equal(response.headers["cache-control"], "no-store");
    return response.json();
  };
  const config = {
    name: "Test Four", registrationOpensAt: new Date(Date.now() - 60_000).toISOString(),
    startsAt: new Date(Date.now() + 3_600_000).toISOString(), capacity: 4,
    entryStake: 10, championPrize: 50, minTableLevel: 1,
    minOnlineWins: 0, minGemBalance: 20, turnLimitSeconds: 60,
  };
  try {
    const created = await request(admin, "POST", "/admin/api/tournaments", config, 201);
    const id = created.tournament.id;
    await request(admin, "POST", `/admin/api/tournaments/${id}/publish`);
    assert.equal((await request(players[0], "GET", `/tournaments/${id}/bracket`)).matches.length, 0,
      "no entrant identity appears before the draw");
    assert.equal((await request(players[0], "GET", `/tournaments/${id}/eligibility`)).eligibility.canRegister, true);
    const firstRequest = randomUUID();
    const retries = await Promise.all([0, 0].map(() => request(players[0], "POST", `/tournaments/${id}/register`,
      { requestId: firstRequest })));
    assert.equal(retries[0].entry.id, retries[1].entry.id, "retry reserves one seat");
    assert.equal((await app.inject({ method: "GET",
      url: `/tournaments/${id}/entrants/${retries[0].entry.id}/avatar`,
      headers: { authorization: `Bearer ${token.get(players[0])}` } })).statusCode, 404,
    "pre-draw entrant identities and avatars remain private");
    await Promise.all([1, 2].map(i => request(players[i], "POST", `/tournaments/${id}/register`,
      { requestId: randomUUID() })));
    const lastSeat = await Promise.all([3, 4].map(i => app.inject({ method: "POST",
      url: `/tournaments/${id}/register`,
      headers: { authorization: `Bearer ${token.get(players[i])}` },
      payload: { requestId: randomUUID() } })));
    assert.deepEqual(lastSeat.map(result => result.statusCode).sort(), [200, 409],
      "two concurrent entrants cannot take the last place");
    assert.equal((await db.query("SELECT count(*)::int AS n FROM tournament_registrations WHERE tournament_id=$1", [id])).rows[0].n, 4);
    assert.equal((await db.query("SELECT count(*)::int AS n FROM gem_transactions WHERE kind='tournament_entry'")).rows[0].n, 4);
    assert.equal((await request(admin, "PATCH", `/admin/api/tournaments/${id}`,
      { ...config, entryStake: 1 }, 409)).error, "PUBLISHED_RULES_LOCKED");
    assert.equal((await request(admin, "POST", `/admin/api/tournaments/${id}/start`, undefined, 409)).error,
      "TOURNAMENT_NOT_DUE", "staff cannot start before the published time");
    const withdrawn = await request(players[0], "POST", `/tournaments/${id}/withdraw`);
    assert.equal(withdrawn.refunded, 10);
    assert.equal((await db.query("SELECT balance::int AS balance FROM gem_wallets WHERE user_id=$1", [players[0]])).rows[0].balance, 100);
    const loser = lastSeat[0].statusCode === 409 ? 3 : 4;
    await request(players[loser], "POST", `/tournaments/${id}/register`, { requestId: randomUUID() });
    assert.equal((await db.query(`SELECT count(*)::int AS n FROM tournament_registrations
      WHERE tournament_id=$1 AND status='registered'`, [id])).rows[0].n, 4);

    // Test-only clock advance inside an empty disposable database.
    await db.query("UPDATE tournaments SET starts_at=clock_timestamp()-interval '1 second' WHERE id=$1", [id]);
    await request(admin, "POST", `/admin/api/tournaments/${id}/start`);
    assert.equal((await db.query("SELECT status FROM tournaments WHERE id=$1", [id])).rows[0].status, "live");
    const rounds = (await db.query(`SELECT m.id, m.round_no, m.registration_a, m.registration_b,
      a.user_id AS user_a, b.user_id AS user_b FROM tournament_matches m
      LEFT JOIN tournament_registrations a ON a.id=m.registration_a
      LEFT JOIN tournament_registrations b ON b.id=m.registration_b
      WHERE m.tournament_id=$1 ORDER BY m.round_no,m.match_no`, [id])).rows;
    assert.equal(rounds.length, 3);
    assert.ok(rounds[0].user_a && rounds[0].user_b);
    const drawnAvatar = Buffer.from("89504e470d0a1a0a", "hex");
    await db.query("INSERT INTO user_avatars (user_id,png) VALUES ($1,$2)",
      [rounds[0].user_a, drawnAvatar]);
    const publicAvatar = await app.inject({ method: "GET",
      url: `/tournaments/${id}/entrants/${rounds[0].registration_a}/avatar`,
      headers: { authorization: `Bearer ${token.get(players[1])}` } });
    assert.equal(publicAvatar.statusCode, 200);
    assert.equal(publicAvatar.headers["content-type"], "image/png");
    assert.deepEqual(publicAvatar.rawPayload, drawnAvatar);
    const finalists = [];
    for (const match of rounds.slice(0, 2)) {
      await request(match.user_a, "POST", `/tournaments/matches/${match.id}/join`);
      const active = await request(match.user_b, "POST", `/tournaments/matches/${match.id}/join`);
      assert.equal(active.status, "active");
      await request(match.user_a, "POST", `/tournaments/matches/${match.id}/commands`,
        { action: "resign", commandId: randomUUID(), expectedVersion: active.version });
      finalists.push(match.user_b);
    }
    const final = (await db.query(`SELECT m.id, a.user_id AS user_a, b.user_id AS user_b
      FROM tournament_matches m JOIN tournament_registrations a ON a.id=m.registration_a
      JOIN tournament_registrations b ON b.id=m.registration_b
      WHERE m.tournament_id=$1 AND m.round_no=2`, [id])).rows[0];
    assert.deepEqual([final.user_a, final.user_b].sort(), finalists.sort());
    await request(final.user_a, "POST", `/tournaments/matches/${final.id}/join`);
    const activeFinal = await request(final.user_b, "POST", `/tournaments/matches/${final.id}/join`);
    await request(final.user_a, "POST", `/tournaments/matches/${final.id}/commands`,
      { action: "resign", commandId: randomUUID(), expectedVersion: activeFinal.version });
    assert.equal((await db.query("SELECT status FROM tournaments WHERE id=$1", [id])).rows[0].status, "completed");
    assert.equal((await request(players[1], "GET", `/tournaments/${id}/leaderboard`)).placements.filter(p => p.place === 1).length, 1);
    assert.equal((await db.query("SELECT balance::int AS balance FROM gem_wallets WHERE user_id=$1", [final.user_b])).rows[0].balance, 140);
    assert.equal((await db.query("SELECT count(*)::int AS n FROM gem_transactions WHERE kind='tournament_prize'")).rows[0].n, 1);
    assert.equal((await db.query("SELECT count(*)::int AS n FROM gem_transactions WHERE kind IN ('online_pot','online_completion')")).rows[0].n, 0);
    await tickTournaments();
    assert.equal((await db.query("SELECT count(*)::int AS n FROM gem_transactions WHERE kind='tournament_prize'")).rows[0].n, 1);
    await request(admin, "POST", `/admin/api/tournaments/${id}/cancel`);
    await request(admin, "POST", `/admin/api/tournaments/${id}/cancel`);
    assert.equal((await db.query("SELECT balance::int AS balance FROM gem_wallets WHERE user_id=$1", [final.user_b])).rows[0].balance, 150,
      "cancellation refunds the stake without reversing a confirmed prize");
    assert.equal((await db.query("SELECT count(*)::int AS n FROM gem_transactions WHERE kind='tournament_refund'")).rows[0].n, 5);

    const underfilled = (await request(admin, "POST", "/admin/api/tournaments",
      { ...config, name: "Underfilled" }, 201)).tournament.id;
    await request(admin, "POST", `/admin/api/tournaments/${underfilled}/publish`);
    await request(players[0], "POST", `/tournaments/${underfilled}/register`, { requestId: randomUUID() });
    await db.query("UPDATE tournaments SET starts_at=clock_timestamp()-interval '1 second' WHERE id=$1", [underfilled]);
    await tickTournaments();
    assert.equal((await db.query("SELECT status FROM tournaments WHERE id=$1", [underfilled])).rows[0].status, "cancelled");
    assert.equal((await db.query("SELECT balance::int AS balance FROM gem_wallets WHERE user_id=$1", [players[0]])).rows[0].balance, 100,
      "underfilled brackets refund the full stake");

    const noShows = (await request(admin, "POST", "/admin/api/tournaments",
      { ...config, name: "No shows" }, 201)).tournament.id;
    await request(admin, "POST", `/admin/api/tournaments/${noShows}/publish`);
    for (const player of players.slice(0, 4)) await request(player, "POST",
      `/tournaments/${noShows}/register`, { requestId: randomUUID() });
    await db.query("UPDATE tournaments SET starts_at=clock_timestamp()-interval '1 second' WHERE id=$1", [noShows]);
    await tickTournaments();
    await db.query(`UPDATE tournament_matches SET join_deadline_at=clock_timestamp()-interval '1 second'
      WHERE tournament_id=$1 AND status='ready'`, [noShows]);
    await tickTournaments();
    assert.equal((await db.query("SELECT status,champion_registration_id FROM tournaments WHERE id=$1", [noShows])).rows[0].status, "completed");
    assert.equal((await db.query("SELECT champion_registration_id FROM tournaments WHERE id=$1", [noShows])).rows[0].champion_registration_id, null,
      "two absent finalists do not produce a champion");
    assert.equal((await db.query("SELECT count(*)::int AS n FROM gem_transactions WHERE kind='tournament_prize'")).rows[0].n, 1,
      "a no-show-only bracket grants no prize");

    const deletionBeforeStart = (await request(admin, "POST", "/admin/api/tournaments",
      { ...config, name: "Delete before start" }, 201)).tournament.id;
    await request(admin, "POST", `/admin/api/tournaments/${deletionBeforeStart}/publish`);
    await request(players[4], "POST", `/tournaments/${deletionBeforeStart}/register`, { requestId: randomUUID() });
    await request(players[4], "DELETE", "/auth/me", { confirm: true });
    const deletedEntry = (await db.query(`SELECT user_id,status,public_name,refunded_at
      FROM tournament_registrations WHERE tournament_id=$1`, [deletionBeforeStart])).rows[0];
    assert.equal(deletedEntry.user_id, null);
    assert.equal(deletedEntry.status, "withdrawn");
    assert.equal(deletedEntry.public_name, "Deleted player");
    assert.ok(deletedEntry.refunded_at);

    const deletionInMatch = (await request(admin, "POST", "/admin/api/tournaments",
      { ...config, name: "Delete during match" }, 201)).tournament.id;
    await request(admin, "POST", `/admin/api/tournaments/${deletionInMatch}/publish`);
    for (const player of players.slice(0, 4)) await request(player, "POST",
      `/tournaments/${deletionInMatch}/register`, { requestId: randomUUID() });
    await db.query("UPDATE tournaments SET starts_at=clock_timestamp()-interval '1 second' WHERE id=$1", [deletionInMatch]);
    await tickTournaments();
    const live = (await db.query(`SELECT m.id, a.user_id AS user_a, b.user_id AS user_b
      FROM tournament_matches m JOIN tournament_registrations a ON a.id=m.registration_a
      JOIN tournament_registrations b ON b.id=m.registration_b
      WHERE m.tournament_id=$1 AND m.round_no=1 ORDER BY m.match_no LIMIT 1`, [deletionInMatch])).rows[0];
    await request(live.user_a, "POST", `/tournaments/matches/${live.id}/join`);
    const firstStart = await request(live.user_b, "POST", `/tournaments/matches/${live.id}/join`);
    const drawCommand = { action: "resign", commandId: randomUUID(), expectedVersion: firstStart.version };
    const drawRules = async input => ({ snapshot: { ...input.snapshot, outcome: 3 },
      views: { human: {}, ai: {} } });
    const replay = await commandTournamentMatch(live.user_a, live.id, drawCommand, drawRules);
    assert.equal(replay.status, "ready");
    assert.equal(replay.replayCount, 1);
    assert.equal((await commandTournamentMatch(live.user_a, live.id, drawCommand, drawRules)).replayCount, 1,
      "a retry does not create another replay");
    assert.equal((await db.query("SELECT count(*)::int AS n FROM tournament_match_awards WHERE match_id=$1", [live.id])).rows[0].n, 0,
      "a drawn pairing does not award XP or rating");
    await request(live.user_a, "POST", `/tournaments/matches/${live.id}/join`);
    await request(live.user_b, "POST", `/tournaments/matches/${live.id}/join`);
    await request(live.user_a, "DELETE", "/auth/me", { confirm: true });
    const afterDeletion = (await db.query("SELECT status,result_kind,winner_registration_id FROM tournament_matches WHERE id=$1", [live.id])).rows[0];
    assert.equal(afterDeletion.status, "completed");
    assert.equal(afterDeletion.result_kind, "resign");
    assert.ok(afterDeletion.winner_registration_id);
    assert.ok(Number((await db.query("SELECT experience FROM player_progression WHERE user_id=$1", [live.user_b])).rows[0].experience) >= 100,
      "a started match awards the surviving opponent ordinary XP");
    const otherSemi = (await db.query(`SELECT m.id, a.user_id AS user_a, b.user_id AS user_b
      FROM tournament_matches m JOIN tournament_registrations a ON a.id=m.registration_a
      JOIN tournament_registrations b ON b.id=m.registration_b
      WHERE m.tournament_id=$1 AND m.round_no=1 AND m.id<>$2`, [deletionInMatch, live.id])).rows[0];
    await request(otherSemi.user_a, "POST", `/tournaments/matches/${otherSemi.id}/join`);
    await request(otherSemi.user_b, "POST", `/tournaments/matches/${otherSemi.id}/join`);
    await db.query(`UPDATE tournament_matches SET turn_deadline_at=clock_timestamp()-interval '1 second'
      WHERE id=$1`, [otherSemi.id]);
    await tickTournaments();
    const timedOut = (await db.query(`SELECT status,result_kind,winner_registration_id
      FROM tournament_matches WHERE id=$1`, [otherSemi.id])).rows[0];
    assert.equal(timedOut.status, "completed");
    assert.equal(timedOut.result_kind, "timeout");
    assert.ok(timedOut.winner_registration_id);
    assert.equal((await db.query("SELECT count(*)::int AS n FROM tournament_match_awards WHERE match_id=$1", [otherSemi.id])).rows[0].n, 2,
      "a started match timeout grants exactly one deciding XP/rating award per player");
  } finally {
    await app.close();
    await db.end();
    delete process.env.ADMIN_EMAILS;
  }
});
