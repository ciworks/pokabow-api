import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { generate, generateSecret } from "otplib";
import sharp from "sharp";

process.env.JWT_SECRET = "tournament-postgres-tests-only-at-least-thirty-two-bytes";
process.env.STAFF_ENCRYPTION_KEY = "a".repeat(64);
if (process.env.TOURNAMENT_TEST_DATABASE_URL)
  process.env.DATABASE_URL = process.env.TOURNAMENT_TEST_DATABASE_URL;
const { buildApp } = await import("../dist/app.js");
const { db } = await import("../dist/db.js");
const { tickTournaments, commandTournamentMatch } = await import("../dist/services/tournament-bracket.js");
const { hashPassword } = await import("../dist/auth/password.js");
const { encryptSecret } = await import("../dist/auth/staff.js");

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
    "021_tournaments.sql", "022_passwordless_sessions.sql", "023_staff_admin.sql", "024_tournament_artwork.sql"]) {
    await db.query(await readFile(new URL(`../migrations/${file}`, import.meta.url), "utf8"));
  }
  const app = buildApp();
  await app.ready();
  const admin = randomUUID();
  const players = Array.from({ length: 5 }, () => randomUUID());
  for (const [id, name, email] of [[admin, "Admin", "tournament-admin@example.test"],
    ...players.map((id, i) => [id, `Player ${i}`, `${id}@example.test`])]) {
    await db.query("INSERT INTO users (id,display_name,email) VALUES ($1,$2,$3)", [id, name, email]);
  }
  for (const id of players) await db.query("INSERT INTO gem_wallets (user_id,balance) VALUES ($1,100)", [id]);
  const staffSecret = generateSecret();
  await db.query(`INSERT INTO staff_accounts (id,email,password_hash,totp_secret_encrypted,role)
    VALUES ($1,'staff@example.test',$2,$3,'emergency_operator')`,
  [admin, await hashPassword("staff-test-password-123"), encryptSecret(staffSecret)]);
  const loginCode = await generate({ secret: staffSecret });
  const login = await app.inject({ method: "POST", url: "/admin/api/auth/login",
    payload: { email: "staff@example.test", password: "staff-test-password-123",
      totp: loginCode } });
  assert.equal(login.statusCode, 200, login.body);
  const staffCookie = login.headers["set-cookie"].split(";")[0];
  const staffCsrf = login.json().csrfToken;
  const recoveryCode = "abc12345def67890";
  await db.query("INSERT INTO staff_recovery_codes (staff_id,code_hash) VALUES ($1,$2)",
    [admin, createHash("sha256").update(recoveryCode).digest("hex")]);
  const recoveryLogin = () => app.inject({ method: "POST", url: "/admin/api/auth/login",
    payload: { email: "staff@example.test", password: "staff-test-password-123", totp: recoveryCode } });
  assert.equal((await recoveryLogin()).statusCode, 200);
  assert.equal((await recoveryLogin()).statusCode, 401, "a recovery code is single use");
  const token = new Map([admin, ...players].map(id => [id, app.jwt.sign({ sub: id })]));
  assert.equal((await app.inject({ method: "GET", url: "/admin/api/players" })).statusCode, 401);
  assert.equal((await app.inject({ method: "GET", url: "/admin/api/games" })).statusCode, 401);
  const staffHeaders = { cookie: staffCookie };
  const foundPlayers = await app.inject({ method: "GET", url: "/admin/api/players?search=Player%200", headers: staffHeaders });
  assert.equal(foundPlayers.statusCode, 200, foundPlayers.body);
  assert.equal(foundPlayers.json().players[0].id, players[0]);
  assert.equal(foundPlayers.headers["cache-control"], "no-store");
  const playerDetail = await app.inject({ method: "GET", url: `/admin/api/players/${players[0]}`, headers: staffHeaders });
  assert.equal(playerDetail.statusCode, 200, playerDetail.body);
  assert.equal(playerDetail.json().player.gemBalance, "100");
  assert.equal("password_hash" in playerDetail.json().player, false);
  const emptyGames = await app.inject({ method: "GET", url: `/admin/api/games?playerId=${players[0]}`, headers: staffHeaders });
  assert.equal(emptyGames.statusCode, 200, emptyGames.body);
  assert.deepEqual(emptyGames.json().games, []);
  assert.equal((await app.inject({ method: "GET", url: "/admin/api/games?kind=invalid", headers: staffHeaders })).statusCode, 400);
  const request = async (id, method, url, payload, status = 200) => {
    const response = await app.inject({ method, url,
      headers: url.startsWith("/admin/api/") ? { cookie: staffCookie,
        "x-csrf-token": staffCsrf }
        : { authorization: `Bearer ${token.get(id)}` }, payload });
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
    const listed = await request(admin, "GET", "/admin/api/tournaments?status=draft&search=Test%20Four");
    assert.equal(listed.tournaments.some(t => t.id === id), true);
    assert.equal((await request(admin, "GET", "/admin/api/tournaments?cursor=bad", undefined, 400)).error,
      "INVALID_CURSOR");
    assert.deepEqual(created.tournament.artwork,
      { fallback: "trophy-confetti", badge: null, background: null });
    const artworkPng = await sharp({ create: { width: 512, height: 256, channels: 4,
      background: { r: 40, g: 150, b: 150, alpha: 0.5 } } }).png().toBuffer();
    const artworkPayload = { contentType: "image/png", data: artworkPng.toString("base64") };
    const artPath = `/admin/api/tournaments/${id}/artwork`;
    const badgeUpload = await request(admin, "PUT", `${artPath}/badge`, artworkPayload);
    assert.equal(badgeUpload.artwork.badge.width, 512);
    await request(admin, "PUT", `${artPath}/background`, artworkPayload);
    const preview = await app.inject({ url: badgeUpload.artwork.badge.url, headers: staffHeaders });
    assert.equal(preview.statusCode, 200, preview.body);
    assert.deepEqual(preview.rawPayload, artworkPng);
    await request(players[0], "GET", `/tournaments/${id}/artwork/badge`, undefined, 404);
    assert.ok((await request(admin, "GET", `/admin/api/tournaments/${id}`)).tournament.artwork.background);
    assert.ok((await request(admin, "GET", "/admin/api/tournaments")).tournaments.find(t => t.id === id).artwork.badge);
    const removed = await request(admin, "DELETE", `${artPath}/background`);
    assert.equal(removed.artwork.background, null);
    assert.ok(removed.artwork.badge);
    await request(admin, "PUT", `${artPath}/background`, artworkPayload);
    const draftUpdate = await request(admin, "PATCH", `/admin/api/tournaments/${id}`, config);
    assert.ok(draftUpdate.tournament.artwork.badge, "ordinary config updates preserve uploaded art");
    await request(admin, "POST", `/admin/api/tournaments/${id}/publish`);
    const publicDetail = await request(players[0], "GET", `/tournaments/${id}`);
    const publicList = await request(players[0], "GET", "/tournaments");
    assert.deepEqual(publicList.tournaments.find(t => t.id === id).artwork, publicDetail.tournament.artwork);
    const publishedImage = await app.inject({ url: publicDetail.tournament.artwork.badge.url,
      headers: { authorization: `Bearer ${token.get(players[0])}` } });
    assert.equal(publishedImage.statusCode, 200);
    assert.deepEqual(publishedImage.rawPayload, artworkPng);
    await request(admin, "DELETE", `${artPath}/badge`, undefined, 409);
    await request(admin, "PUT", `${artPath}/background`, artworkPayload, 409);
    assert.ok((await request(admin, "GET", `/admin/api/tournaments/${id}`)).audit.some(a => a.action === "upload_artwork"));

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
    const finance = await request(admin, "GET", `/admin/api/tournaments/${id}/finance`);
    assert.equal(finance.reconciled, true);
    assert.deepEqual([finance.entries.amount, finance.refunds.amount, finance.prize.amount], [50, 10, 50]);
    assert.equal((await db.query("SELECT count(*)::int AS n FROM gem_transactions WHERE kind IN ('online_pot','online_completion')")).rows[0].n, 0);
    await tickTournaments();
    assert.equal((await db.query("SELECT count(*)::int AS n FROM gem_transactions WHERE kind='tournament_prize'")).rows[0].n, 1);
    assert.equal((await request(admin, "POST", `/admin/api/tournaments/${id}/cancel`, {}, 409)).error,
      "COMPLETED_TOURNAMENT_LOCKED");
    assert.equal((await db.query("SELECT balance::int AS balance FROM gem_wallets WHERE user_id=$1", [final.user_b])).rows[0].balance, 140,
      "a completed tournament cannot refund a confirmed prize winner");
    assert.equal((await db.query("SELECT count(*)::int AS n FROM gem_transactions WHERE kind='tournament_refund'")).rows[0].n, 1);

    const underfilled = (await request(admin, "POST", "/admin/api/tournaments",
      { ...config, name: "Underfilled" }, 201)).tournament.id;
    await request(admin, "POST", `/admin/api/tournaments/${underfilled}/publish`);
    await request(players[0], "POST", `/tournaments/${underfilled}/register`, { requestId: randomUUID() });
    await db.query("UPDATE tournaments SET starts_at=clock_timestamp()-interval '1 second' WHERE id=$1", [underfilled]);
    await tickTournaments();
    assert.equal((await db.query("SELECT status FROM tournaments WHERE id=$1", [underfilled])).rows[0].status, "cancelled");
    assert.equal((await db.query("SELECT balance::int AS balance FROM gem_wallets WHERE user_id=$1", [players[0]])).rows[0].balance, 100,
      "underfilled brackets refund the full stake");

    const emergency = (await request(admin, "POST", "/admin/api/tournaments",
      { ...config, name: "Emergency cancellation" }, 201)).tournament.id;
    await request(admin, "POST", `/admin/api/tournaments/${emergency}/publish`);
    for (const player of players.slice(0, 4)) await request(player, "POST",
      `/tournaments/${emergency}/register`, { requestId: randomUUID() });
    await db.query("UPDATE tournaments SET starts_at=clock_timestamp()-interval '1 second' WHERE id=$1", [emergency]);
    await tickTournaments();
    assert.equal((await db.query("SELECT status FROM tournaments WHERE id=$1", [emergency])).rows[0].status, "live");
    assert.equal((await request(admin, "POST", `/admin/api/tournaments/${emergency}/cancel`,
      { reason: "Emergency test cancellation", totp: loginCode }, 403)).error, "INVALID_EMERGENCY_CODE",
    "the login code cannot be reused for an emergency action");
    await db.query("UPDATE staff_accounts SET totp_last_step=NULL WHERE id=$1", [admin]);
    await request(admin, "POST", `/admin/api/tournaments/${emergency}/cancel`,
      { reason: "Emergency test cancellation", totp: loginCode });
    assert.equal((await db.query("SELECT status FROM tournaments WHERE id=$1", [emergency])).rows[0].status, "cancelled");
    assert.equal((await request(admin, "GET", `/admin/api/tournaments/${emergency}/finance`)).reconciled, true);

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
  }
});
