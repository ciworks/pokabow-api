import { randomInt } from "node:crypto";
import type { PoolClient } from "pg";
import { db } from "../db.js";
import { runOnlineRules } from "../game/online-rules.js";
import type { RulesRunner, RulesState } from "../game/rules-contract.js";
import { awardTournamentMatch } from "./player-progression.js";
import { clock, lockTournament, lockTournamentPlayer, TournamentError, transaction, walletChange,
  type RegistrationRow, type TournamentRow } from "./tournament-core.js";

const JOIN_SECONDS = 300;
export type TournamentCommand = {
  commandId: string; expectedVersion: number; action: "place" | "swap" | "resign";
  placements?: { tileId: string; x: number; y: number; rotation: number }[];
  tileIds?: string[];
};
type MatchRow = {
  id: string; tournament_id: string; round_no: number; match_no: number;
  registration_a: string | null; registration_b: string | null;
  source_a_done: boolean; source_b_done: boolean;
  status: "waiting" | "ready" | "active" | "completed" | "cancelled";
  joined_a: boolean; joined_b: boolean; join_deadline_at: Date | null;
  turn_deadline_at: Date | null; state: RulesState | null; version: number;
  replay_count: number; winner_registration_id: string | null;
  result_kind: string | null; decisive_played: boolean;
};

async function readRegistration(client: PoolClient, id: string): Promise<RegistrationRow> {
  const row = (await client.query<RegistrationRow>(
    "SELECT * FROM tournament_registrations WHERE id=$1", [id])).rows[0];
  if (!row) throw new Error("MISSING_TOURNAMENT_REGISTRATION");
  return row;
}

async function complete(client: PoolClient, tour: TournamentRow, match: MatchRow,
  winnerId: string | null, kind: string, at: Date, played = false,
  state: RulesState | null = match.state): Promise<MatchRow> {
  if (match.status === "completed" || match.status === "cancelled") return match;
  const updated = (await client.query<MatchRow>(`UPDATE tournament_matches SET
    status='completed', winner_registration_id=$2, result_kind=$3,
    decisive_played=$4, state=$5, completed_at=$6, turn_deadline_at=NULL,
    version=version+1 WHERE id=$1 RETURNING *`,
  [match.id, winnerId, kind, played, state ? JSON.stringify(state) : null, at])).rows[0];
  for (const id of [match.registration_a, match.registration_b]) {
    if (id && id !== winnerId) await client.query(`UPDATE tournament_registrations
      SET status='eliminated' WHERE id=$1 AND status='playing'`, [id]);
  }
  const lastRound = Math.log2(tour.capacity);
  if (match.round_no === lastRound) {
    if (winnerId) {
      const champion = await readRegistration(client, winnerId);
      await client.query(`UPDATE tournament_registrations SET status='champion'
        WHERE id=$1 AND status='playing'`, [winnerId]);
      if (champion.user_id) await walletChange(client, champion.user_id,
        `${tour.id}:champion`, "tournament_prize", Number(tour.champion_prize));
    }
    await client.query(`UPDATE tournaments SET status='completed', completed_at=$2,
      champion_registration_id=$3 WHERE id=$1`, [tour.id, at, winnerId]);
    return updated;
  }
  const parentNo = Math.ceil(match.match_no / 2);
  const side = match.match_no % 2 === 1 ? "a" : "b";
  const parent = (await client.query<MatchRow>(`UPDATE tournament_matches SET
    registration_${side}=$4, source_${side}_done=TRUE
    WHERE tournament_id=$1 AND round_no=$2 AND match_no=$3 RETURNING *`,
  [tour.id, match.round_no + 1, parentNo, winnerId])).rows[0];
  if (!parent) throw new Error("MISSING_BRACKET_PARENT");
  if (parent.source_a_done && parent.source_b_done) await resolveReady(client, tour, parent, at);
  return updated;
}

async function resolveReady(client: PoolClient, tour: TournamentRow, match: MatchRow, at: Date): Promise<void> {
  if (!match.source_a_done || !match.source_b_done || match.status === "completed") return;
  const a = match.registration_a ? await readRegistration(client, match.registration_a) : null;
  const b = match.registration_b ? await readRegistration(client, match.registration_b) : null;
  const aCanPlay = Boolean(a && a.status !== "forfeited");
  const bCanPlay = Boolean(b && b.status !== "forfeited");
  if (!aCanPlay || !bCanPlay) {
    await complete(client, tour, match, aCanPlay ? a!.id : bCanPlay ? b!.id : null,
      a && b ? (aCanPlay || bCanPlay ? "forfeit" : "double_forfeit") :
        (aCanPlay || bCanPlay ? "bye" : "double_forfeit"), at);
    return;
  }
  await client.query(`UPDATE tournament_matches SET status='ready', ready_at=$2,
    join_deadline_at=$2::timestamptz + $3 * interval '1 second', version=version+1
    WHERE id=$1 AND status='waiting'`, [match.id, at, JOIN_SECONDS]);
}

function shuffle<T>(items: T[]): T[] {
  const result = [...items];
  for (let i = result.length - 1; i > 0; i -= 1) {
    const j = randomInt(i + 1);
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

export async function startDueTournament(id: string, strict = false, actorId: string | null = null) {
  return transaction(async client => {
    const tour = await lockTournament(client, id);
    const now = await clock(client);
    if (tour.status !== "open" || tour.starts_at > now) {
      if (strict) throw new TournamentError("TOURNAMENT_NOT_DUE");
      return;
    }
    const entries = (await client.query<RegistrationRow>(`SELECT * FROM tournament_registrations
      WHERE tournament_id=$1 AND status IN ('registered','forfeited') ORDER BY id FOR UPDATE`, [id])).rows;
    if (entries.length !== tour.capacity) {
      for (const reg of entries) {
        if (reg.user_id && !reg.refunded_at && Number(reg.paid_stake) > 0) {
          await walletChange(client, reg.user_id, `${reg.id}:refund`, "tournament_refund", Number(reg.paid_stake));
          await client.query("UPDATE tournament_registrations SET refunded_at=$2 WHERE id=$1", [reg.id, now]);
        }
      }
      await client.query(`UPDATE tournament_registrations SET status='eliminated'
        WHERE tournament_id=$1 AND status='registered'`, [id]);
      await client.query(`UPDATE tournaments SET status='cancelled', cancelled_at=$2 WHERE id=$1`, [id, now]);
      await client.query(`INSERT INTO tournament_admin_audit (tournament_id, action, details)
        VALUES ($1, 'underfilled_cancel', $2)`, [id, JSON.stringify({ filledPlaces: entries.length })]);
      return;
    }
    const drawn = shuffle(entries);
    for (const [index, reg] of drawn.entries()) await client.query(`UPDATE tournament_registrations
      SET slot=$2, status=CASE WHEN status='registered' THEN 'playing' ELSE status END
      WHERE id=$1`, [reg.id, index + 1]);
    await client.query("UPDATE tournaments SET status='live' WHERE id=$1", [id]);
    await client.query(`INSERT INTO tournament_admin_audit
      (tournament_id, staff_actor_id, action, details) VALUES ($1,$2,$3,$4)`,
    [id, actorId, actorId ? "start" : "automatic_start", JSON.stringify({ entrants: drawn.length })]);
    const rounds = Math.log2(tour.capacity);
    const first: MatchRow[] = [];
    for (let round = 1; round <= rounds; round += 1) {
      for (let number = 1; number <= tour.capacity / 2 ** round; number += 1) {
        const a = round === 1 ? drawn[(number - 1) * 2].id : null;
        const b = round === 1 ? drawn[(number - 1) * 2 + 1].id : null;
        const row = (await client.query<MatchRow>(`INSERT INTO tournament_matches
          (tournament_id, round_no, match_no, registration_a, registration_b,
           source_a_done, source_b_done, status, ready_at, join_deadline_at)
          VALUES ($1,$2,$3,$4,$5,$6,$6,$7,
            CASE WHEN $6 THEN $8::timestamptz ELSE NULL END,
            CASE WHEN $6 THEN $8::timestamptz + $9 * interval '1 second' ELSE NULL END)
          RETURNING *`, [id, round, number, a, b, round === 1,
          round === 1 ? "ready" : "waiting", now, JOIN_SECONDS])).rows[0];
        if (round === 1) first.push(row);
      }
    }
    for (const match of first) {
      const a = drawn[(match.match_no - 1) * 2];
      const b = drawn[(match.match_no - 1) * 2 + 1];
      if (a.status === "forfeited" || b.status === "forfeited")
        await resolveReady(client, tour, match, now);
    }
  });
}

async function timeout(client: PoolClient, tour: TournamentRow, match: MatchRow, now: Date,
  rules: RulesRunner): Promise<MatchRow> {
  if (match.status === "ready" && match.join_deadline_at && match.join_deadline_at <= now) {
    return complete(client, tour, match,
      match.joined_a ? match.registration_a : match.joined_b ? match.registration_b : null,
      match.joined_a || match.joined_b ? "no_show" : "double_no_show", now);
  }
  if (match.status === "active" && match.turn_deadline_at && match.turn_deadline_at <= now && match.state) {
    const seat = match.state.snapshot.turn.active_player_id;
    const result = await rules({ action: "resign", snapshot: match.state.snapshot, seat });
    if ("error" in result) throw new Error(result.error);
    const outcome = result.snapshot.outcome;
    const a = await readRegistration(client, match.registration_a!);
    const b = await readRegistration(client, match.registration_b!);
    await awardTournamentMatch(client, match.id, a.user_id, b.user_id, outcome);
    return complete(client, tour, match, outcome === 1 ? a.id : b.id, "timeout", now, true, result);
  }
  return match;
}

/** Staff and account deletion use the same authoritative bracket advancement. */
export async function forfeitRegistration(client: PoolClient, tour: TournamentRow,
  reg: RegistrationRow, now: Date, rules: RulesRunner = runOnlineRules): Promise<void> {
  if (tour.status !== "live") return;
  const match = (await client.query<MatchRow>(`SELECT * FROM tournament_matches
    WHERE tournament_id=$1 AND status IN ('ready','active')
      AND (registration_a=$2 OR registration_b=$2) FOR UPDATE`, [tour.id, reg.id])).rows[0];
  if (!match) return;
  const other = match.registration_a === reg.id ? match.registration_b : match.registration_a;
  if (match.status === "active" && match.state) {
    const seat = match.registration_a === reg.id ? "human" : "ai";
    const result = await rules({ action: "resign", snapshot: match.state.snapshot, seat });
    if ("error" in result) throw new Error(result.error);
    const a = await readRegistration(client, match.registration_a!);
    const b = await readRegistration(client, match.registration_b!);
    await awardTournamentMatch(client, match.id, a.user_id, b.user_id, result.snapshot.outcome);
    await complete(client, tour, match, other, "resign", now, true, result);
  } else await complete(client, tour, match, other, "forfeit", now);
}

/** Call inside the account-deletion transaction before deleting the users row. */
export async function handleTournamentAccountDeletion(client: PoolClient, userId: string,
  rules: RulesRunner = runOnlineRules): Promise<void> {
  await lockTournamentPlayer(client, userId);
  const pending = (await client.query<{ tournament_id: string }>(`SELECT tournament_id
    FROM tournament_registrations WHERE user_id=$1 AND status IN ('registered','playing')
    ORDER BY tournament_id`, [userId])).rows;
  for (const item of pending) {
    const tour = await lockTournament(client, item.tournament_id);
    const reg = (await client.query<RegistrationRow>(`SELECT * FROM tournament_registrations
      WHERE tournament_id=$1 AND user_id=$2 AND status IN ('registered','playing') FOR UPDATE`,
    [tour.id, userId])).rows[0];
    if (!reg) continue;
    const now = await clock(client);
    if (tour.status === "open" && now < tour.starts_at) {
      await walletChange(client, userId, `${reg.id}:refund`, "tournament_refund", Number(reg.paid_stake));
      await client.query(`UPDATE tournament_registrations SET status='withdrawn',
        refunded_at=$2 WHERE id=$1`, [reg.id, now]);
    } else {
      await client.query("UPDATE tournament_registrations SET status='forfeited' WHERE id=$1", [reg.id]);
      if (tour.status === "live") await forfeitRegistration(client, tour, reg, now, rules);
    }
  }
  await client.query(`UPDATE tournament_registrations SET public_name='Deleted player'
    WHERE user_id=$1`, [userId]);
}

export async function tickTournaments(rules: RulesRunner = runOnlineRules): Promise<void> {
  const due = (await db.query<{ id: string }>(`SELECT id FROM tournaments WHERE status='open'
    AND starts_at <= clock_timestamp() ORDER BY starts_at LIMIT 32`)).rows;
  for (const row of due) await startDueTournament(row.id);
  const matches = (await db.query<{ id: string; tournament_id: string }>(`
    SELECT id, tournament_id FROM tournament_matches WHERE
      (status='ready' AND join_deadline_at <= clock_timestamp()) OR
      (status='active' AND turn_deadline_at <= clock_timestamp())
    ORDER BY COALESCE(turn_deadline_at, join_deadline_at) LIMIT 64`)).rows;
  for (const dueMatch of matches) await transaction(async client => {
    const tour = await lockTournament(client, dueMatch.tournament_id);
    if (tour.status !== "live") return;
    const match = (await client.query<MatchRow>(
      "SELECT * FROM tournament_matches WHERE id=$1 FOR UPDATE", [dueMatch.id])).rows[0];
    if (match) await timeout(client, tour, match, await clock(client), rules);
  });
}

async function access<T>(userId: string, matchId: string,
  run: (client: PoolClient, tour: TournamentRow, match: MatchRow,
    reg: RegistrationRow, now: Date) => Promise<T>): Promise<T> {
  return transaction(async client => {
    const identity = (await client.query<{ tournament_id: string }>(
      "SELECT tournament_id FROM tournament_matches WHERE id=$1", [matchId])).rows[0];
    if (!identity) throw new TournamentError("MATCH_NOT_FOUND", 404);
    const tour = await lockTournament(client, identity.tournament_id);
    const match = (await client.query<MatchRow>(
      "SELECT * FROM tournament_matches WHERE id=$1 FOR UPDATE", [matchId])).rows[0];
    const regId = (await client.query<{ id: string }>(`SELECT id FROM tournament_registrations
      WHERE user_id=$1 AND id IN ($2::uuid,$3::uuid)`,
    [userId, match.registration_a, match.registration_b])).rows[0]?.id;
    if (!regId) throw new TournamentError("MATCH_NOT_FOUND", 404);
    const reg = await readRegistration(client, regId);
    return run(client, tour, match, reg, await clock(client));
  });
}

async function response(client: PoolClient, tour: TournamentRow, match: MatchRow,
  reg: RegistrationRow, now: Date) {
  const seat = match.registration_a === reg.id ? "human" : "ai";
  const opponentId = seat === "human" ? match.registration_b : match.registration_a;
  const opponent = opponentId ? await readRegistration(client, opponentId) : null;
  return {
    matchId: match.id, tournamentId: tour.id, round: match.round_no,
    bracketPosition: match.match_no, status: match.status, version: match.version,
    replayCount: match.replay_count, serverTime: now.getTime() / 1000,
    joinDeadline: match.join_deadline_at?.getTime() ? match.join_deadline_at.getTime() / 1000 : null,
    deadline: match.turn_deadline_at?.getTime() ? match.turn_deadline_at.getTime() / 1000 : null,
    turnLimitSeconds: tour.turn_seconds,
    joined: seat === "human" ? match.joined_a : match.joined_b,
    opponentJoined: seat === "human" ? match.joined_b : match.joined_a,
    opponent: opponent ? { id: opponent.user_id, displayName: opponent.public_name } : null,
    winnerRegistrationId: match.winner_registration_id, resultKind: match.result_kind,
    ...(match.state ? match.state.views[seat] : {}),
  };
}

export async function currentTournamentMatch(userId: string) {
  const row = (await db.query<{ id: string }>(`SELECT m.id FROM tournament_matches m
    JOIN tournaments t ON t.id=m.tournament_id
    JOIN tournament_registrations r ON r.id IN (m.registration_a,m.registration_b)
    WHERE r.user_id=$1 AND t.status='live' AND m.status IN ('ready','active')
    ORDER BY m.round_no DESC LIMIT 1`, [userId])).rows[0];
  return row ? getTournamentMatch(userId, row.id) : null;
}

export async function getTournamentMatch(userId: string, matchId: string) {
  return access(userId, matchId, async (client, tour, match, reg, now) => {
    if (tour.status === "live") match = await timeout(client, tour, match, now, runOnlineRules);
    return response(client, tour, match, reg, now);
  });
}

export async function joinTournamentMatch(userId: string, matchId: string,
  rules: RulesRunner = runOnlineRules) {
  return access(userId, matchId, async (client, tour, match, reg, now) => {
    if (tour.status !== "live") throw new TournamentError("TOURNAMENT_NOT_LIVE");
    match = await timeout(client, tour, match, now, rules);
    if (match.status !== "ready") return response(client, tour, match, reg, now);
    const side = match.registration_a === reg.id ? "a" : "b";
    match = (await client.query<MatchRow>(`UPDATE tournament_matches SET joined_${side}=TRUE
      WHERE id=$1 RETURNING *`, [match.id])).rows[0];
    if (match.joined_a && match.joined_b) {
      const state = await rules({ action: "create", matchId: match.id, seed: randomInt(1, 2147483647) });
      if ("error" in state) throw new Error(state.error);
      match = (await client.query<MatchRow>(`UPDATE tournament_matches SET status='active',
        state=$2, turn_deadline_at=$3::timestamptz + $4 * interval '1 second', version=version+1
        WHERE id=$1 RETURNING *`, [match.id, JSON.stringify(state), now, tour.turn_seconds])).rows[0];
    }
    return response(client, tour, match, reg, now);
  });
}

export async function commandTournamentMatch(userId: string, matchId: string,
  command: TournamentCommand, rules: RulesRunner = runOnlineRules) {
  return access(userId, matchId, async (client, tour, match, reg, now) => {
    if (tour.status !== "live") throw new TournamentError("TOURNAMENT_NOT_LIVE");
    const previous = (await client.query<{ user_id: string; payload: TournamentCommand }>(`
      SELECT user_id,payload FROM tournament_commands WHERE match_id=$1 AND command_id=$2`,
    [match.id, command.commandId])).rows[0];
    if (previous) {
      const same = (await client.query<{ same: boolean }>(`SELECT payload = $3::jsonb AS same
        FROM tournament_commands WHERE match_id=$1 AND command_id=$2`,
      [match.id, command.commandId, JSON.stringify(command)])).rows[0]?.same;
      if (previous.user_id !== userId || !same)
        throw new TournamentError("COMMAND_ID_REUSED");
      return response(client, tour, match, reg, now);
    }
    match = await timeout(client, tour, match, now, rules);
    if (match.status !== "active" || !match.state) throw new TournamentError("MATCH_NOT_ACTIVE");
    if (command.expectedVersion !== match.version) throw new TournamentError("VERSION_CONFLICT");
    const seat = match.registration_a === reg.id ? "human" : "ai";
    const result = await rules({ action: command.action, snapshot: match.state.snapshot,
      seat, placements: command.placements, tileIds: command.tileIds });
    if ("error" in result) throw new TournamentError(result.error);
    const outcome = result.snapshot.outcome;
    if (outcome === 3) {
      match = (await client.query<MatchRow>(`UPDATE tournament_matches SET status='ready',
        state=NULL, joined_a=FALSE, joined_b=FALSE, ready_at=$2,
        join_deadline_at=$2::timestamptz + $3 * interval '1 second', turn_deadline_at=NULL,
        replay_count=replay_count+1, version=version+1 WHERE id=$1 RETURNING *`,
      [match.id, now, JOIN_SECONDS])).rows[0];
    } else if (outcome === 1 || outcome === 2) {
      const a = await readRegistration(client, match.registration_a!);
      const b = await readRegistration(client, match.registration_b!);
      await awardTournamentMatch(client, match.id, a.user_id, b.user_id, outcome);
      match = await complete(client, tour, match, outcome === 1 ? a.id : b.id,
        command.action === "resign" ? "resign" : "played", now, true, result);
    } else {
      match = (await client.query<MatchRow>(`UPDATE tournament_matches SET state=$2,
        version=version+1, turn_deadline_at=$3::timestamptz + $4 * interval '1 second'
        WHERE id=$1 RETURNING *`, [match.id, JSON.stringify(result), now, tour.turn_seconds])).rows[0];
    }
    await client.query(`INSERT INTO tournament_commands
      (match_id, command_id, user_id, payload, accepted_version)
      VALUES ($1,$2,$3,$4,$5)`, [match.id, command.commandId, userId, JSON.stringify(command), match.version]);
    return response(client, tour, match, reg, now);
  });
}

export async function bracket(id: string) {
  const tour = (await db.query<TournamentRow>(
    "SELECT * FROM tournaments WHERE id=$1 AND status <> 'draft'", [id])).rows[0];
  if (!tour) throw new TournamentError("TOURNAMENT_NOT_FOUND", 404);
  if (tour.status === "open")
    return { tournamentId: id, status: tour.status, filledPlaces: Number((await db.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM tournament_registrations WHERE tournament_id=$1 AND status <> 'withdrawn'",
      [id])).rows[0].count), matches: [] };
  const matches = (await db.query<MatchRow & { name_a: string | null; name_b: string | null;
    user_a: string | null; user_b: string | null }>(`
    SELECT m.*, a.public_name AS name_a, b.public_name AS name_b,
      a.user_id AS user_a, b.user_id AS user_b
    FROM tournament_matches m
    LEFT JOIN tournament_registrations a ON a.id=m.registration_a
    LEFT JOIN tournament_registrations b ON b.id=m.registration_b
    WHERE m.tournament_id=$1 ORDER BY m.round_no,m.match_no`, [id])).rows;
  return { tournamentId: id, status: tour.status, matches: matches.map(m => ({
    id: m.id, round: m.round_no, position: m.match_no, status: m.status,
    playerA: m.registration_a ? { registrationId: m.registration_a, displayName: m.name_a,
      avatarUrl: m.user_a ? `/tournaments/${id}/entrants/${m.registration_a}/avatar` : null } : null,
    playerB: m.registration_b ? { registrationId: m.registration_b, displayName: m.name_b,
      avatarUrl: m.user_b ? `/tournaments/${id}/entrants/${m.registration_b}/avatar` : null } : null,
    winnerRegistrationId: m.winner_registration_id, resultKind: m.result_kind,
    replayCount: m.replay_count, joinDeadline: m.join_deadline_at, turnDeadline: m.turn_deadline_at,
  })) };
}

export async function leaderboard(id: string) {
  const tour = (await db.query<TournamentRow>(
    "SELECT * FROM tournaments WHERE id=$1 AND status <> 'draft'", [id])).rows[0];
  if (!tour) throw new TournamentError("TOURNAMENT_NOT_FOUND", 404);
  if (tour.status === "open") return { tournamentId: id, status: tour.status, placements: [] };
  const regs = (await db.query<RegistrationRow & { last_round: number | null }>(`
    SELECT r.*, (SELECT max(m.round_no) FROM tournament_matches m
      WHERE m.tournament_id=r.tournament_id AND m.status='completed'
        AND (m.registration_a=r.id OR m.registration_b=r.id)) AS last_round
    FROM tournament_registrations r WHERE r.tournament_id=$1 AND r.slot IS NOT NULL
    ORDER BY r.slot`, [id])).rows;
  return { tournamentId: id, status: tour.status,
    placements: regs.map(reg => ({ registrationId: reg.id, displayName: reg.public_name,
      status: reg.status, place: tour.champion_registration_id === reg.id ? 1 :
        reg.last_round ? tour.capacity / 2 ** reg.last_round + 1 : null })) };
}
