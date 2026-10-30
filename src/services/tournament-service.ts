import type { PoolClient } from "pg";
import { db } from "../db.js";
import { clock, eligibility, lockTournament, lockTournamentPlayer, publicTournament, registrationRow,
  TournamentError, transaction, walletChange, type RegistrationRow, type TournamentRow } from "./tournament-core.js";
import { bracket, forfeitRegistration } from "./tournament-bracket.js";
import type { StaffRole } from "../auth/staff.js";

function adminTournament(tour: TournamentRow, filled: number) {
  return publicTournament(tour, filled, null, true);
}

export type TournamentConfig = {
  name: string; registrationOpensAt: string; startsAt: string; capacity: 4 | 8 | 16;
  entryStake: number; championPrize: number; minTableLevel: number;
  minOnlineWins: number; minGemBalance: number; turnLimitSeconds: 60 | 120 | 300;
};

async function audit(client: PoolClient, tournamentId: string, actorId: string,
  action: string, details: Record<string, unknown> = {}) {
  await client.query(`INSERT INTO tournament_admin_audit (tournament_id, staff_actor_id, action, details)
    VALUES ($1, $2, $3, $4)`, [tournamentId, actorId, action, JSON.stringify(details)]);
}

function columns(config: TournamentConfig) {
  return [config.name, config.registrationOpensAt, config.startsAt, config.capacity,
    config.entryStake, config.championPrize, config.minTableLevel, config.minOnlineWins,
    config.minGemBalance, config.turnLimitSeconds];
}

export async function createDraft(actorId: string, config: TournamentConfig) {
  return transaction(async client => {
    const now = await clock(client);
    if (new Date(config.startsAt) <= now || new Date(config.registrationOpensAt) >= new Date(config.startsAt))
      throw new TournamentError("INVALID_SCHEDULE", 400);
    const row = (await client.query<TournamentRow>(`INSERT INTO tournaments
      (name, registration_opens_at, starts_at, capacity, entry_stake, champion_prize,
       min_table_level, min_online_wins, min_gem_balance, turn_seconds, created_by_staff)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
    [...columns(config), actorId])).rows[0];
    await audit(client, row.id, actorId, "create", { rulesVersion: row.rules_version, configuration: config });
    return { tournament: adminTournament(row, 0) };
  });
}

export async function updateDraft(actorId: string, id: string, config: TournamentConfig) {
  return transaction(async client => {
    const tour = await lockTournament(client, id);
    if (tour.status !== "draft") throw new TournamentError("PUBLISHED_RULES_LOCKED");
    const now = await clock(client);
    if (new Date(config.startsAt) <= now || new Date(config.registrationOpensAt) >= new Date(config.startsAt))
      throw new TournamentError("INVALID_SCHEDULE", 400);
    const row = (await client.query<TournamentRow>(`UPDATE tournaments SET
      name=$2, registration_opens_at=$3, starts_at=$4, capacity=$5,
      entry_stake=$6, champion_prize=$7, min_table_level=$8, min_online_wins=$9,
      min_gem_balance=$10, turn_seconds=$11, rules_version=rules_version+1
      WHERE id=$1 RETURNING *`, [id, ...columns(config)])).rows[0];
    await audit(client, id, actorId, "update_draft", { rulesVersion: row.rules_version,
      before: adminTournament(tour, 0), after: config });
    return { tournament: adminTournament(row, 0) };
  });
}

export async function publish(actorId: string, id: string) {
  return transaction(async client => {
    const tour = await lockTournament(client, id);
    if (tour.status !== "draft") throw new TournamentError("PUBLISHED_RULES_LOCKED");
    if (tour.starts_at <= await clock(client)) throw new TournamentError("START_TIME_PASSED");
    const rules = { name: tour.name, registrationOpensAt: tour.registration_opens_at,
      startsAt: tour.starts_at, capacity: tour.capacity, entryStake: Number(tour.entry_stake),
      championPrize: Number(tour.champion_prize), minTableLevel: tour.min_table_level,
      minOnlineWins: tour.min_online_wins, minGemBalance: Number(tour.min_gem_balance),
      turnLimitSeconds: tour.turn_seconds, rulesVersion: tour.rules_version };
    const row = (await client.query<TournamentRow>(`UPDATE tournaments SET status='open',
      published_at=clock_timestamp(), published_rules=$2 WHERE id=$1 RETURNING *`,
    [id, JSON.stringify(rules)])).rows[0];
    await audit(client, id, actorId, "publish", { rulesVersion: row.rules_version, publishedRules: rules });
    return { tournament: adminTournament(row, 0) };
  });
}

export async function cancel(actorId: string, id: string, role: StaffRole, reason?: string) {
  return transaction(async client => {
    const tour = await lockTournament(client, id);
    if (tour.status === "cancelled") return { tournament: adminTournament(tour, 0) };
    if (tour.status === "completed") throw new TournamentError("COMPLETED_TOURNAMENT_LOCKED");
    if (role === "viewer") throw new TournamentError("STAFF_FORBIDDEN", 403);
    if (tour.status === "live" && (role !== "emergency_operator" || !reason?.trim()))
      throw new TournamentError("EMERGENCY_AUTH_REQUIRED", 403);
    const registrations = (await client.query<RegistrationRow>(
      "SELECT * FROM tournament_registrations WHERE tournament_id=$1 ORDER BY id FOR UPDATE", [id])).rows;
    const refundable = registrations.filter(reg => reg.user_id && !reg.refunded_at && Number(reg.paid_stake) > 0);
    for (const reg of registrations) {
      if (reg.user_id && !reg.refunded_at && Number(reg.paid_stake) > 0) {
        await walletChange(client, reg.user_id, `${reg.id}:refund`, "tournament_refund", Number(reg.paid_stake));
        await client.query("UPDATE tournament_registrations SET refunded_at=clock_timestamp() WHERE id=$1", [reg.id]);
      }
    }
    await client.query(`UPDATE tournament_registrations SET status='eliminated'
      WHERE tournament_id=$1 AND status IN ('registered','playing')`, [id]);
    await client.query(`UPDATE tournament_matches SET status='cancelled', turn_deadline_at=NULL
      WHERE tournament_id=$1 AND status IN ('waiting','ready','active')`, [id]);
    const row = (await client.query<TournamentRow>(`UPDATE tournaments SET status='cancelled',
      cancelled_at=clock_timestamp() WHERE id=$1 RETURNING *`, [id])).rows[0];
    await client.query(`INSERT INTO tournament_admin_audit
      (tournament_id,staff_actor_id,action,details,reason) VALUES ($1,$2,$3,$4,$5)`,
    [id, actorId, tour.status === "live" ? "emergency_cancel" : "cancel",
      JSON.stringify({ statusBefore: tour.status, refundedEntries: refundable.length,
        refundedGems: refundable.reduce((total, reg) => total + Number(reg.paid_stake), 0) }), reason ?? null]);
    return { tournament: adminTournament(row, registrations.filter(r => r.status !== "withdrawn").length) };
  });
}

export async function adminList(filters: { status?: string; search?: string; cursor?: string } = {}) {
  let cursor: { startsAt: string; id: string } | null = null;
  if (filters.cursor) {
    try {
      const value = JSON.parse(Buffer.from(filters.cursor, "base64url").toString("utf8"));
      if (typeof value.startsAt !== "string" || Number.isNaN(Date.parse(value.startsAt)) ||
          typeof value.id !== "string" || !/^[0-9a-f-]{36}$/i.test(value.id)) throw new Error();
      cursor = value;
    } catch { throw new TournamentError("INVALID_CURSOR", 400); }
  }
  const found = await db.query<TournamentRow & { filled: string }>(`SELECT t.*,
    (SELECT count(*)::text FROM tournament_registrations r WHERE r.tournament_id=t.id
      AND r.status <> 'withdrawn') AS filled FROM tournaments t
    WHERE ($1::text IS NULL OR t.status=$1)
      AND ($2::text IS NULL OR t.name ILIKE '%' || $2 || '%')
      AND ($3::timestamptz IS NULL OR (t.starts_at,t.id)<($3::timestamptz,$4::uuid))
    ORDER BY t.starts_at DESC,t.id DESC LIMIT 51`,
  [filters.status ?? null, filters.search ?? null, cursor?.startsAt ?? null, cursor?.id ?? null]);
  const rows = found.rows.slice(0, 50);
  const last = rows.at(-1);
  return { tournaments: rows.map(row => adminTournament(row, Number(row.filled))),
    nextCursor: found.rows.length > 50 && last ? Buffer.from(JSON.stringify({ startsAt: last.starts_at,
      id: last.id })).toString("base64url") : null };
}

export async function adminDetail(id: string) {
  const tour = (await db.query<TournamentRow>("SELECT * FROM tournaments WHERE id=$1", [id])).rows[0];
  if (!tour) throw new TournamentError("TOURNAMENT_NOT_FOUND", 404);
  const registrations = (await db.query<RegistrationRow>(
    "SELECT * FROM tournament_registrations WHERE tournament_id=$1 ORDER BY registered_at", [id])).rows;
  const auditRows = (await db.query(`SELECT action, details, actor_id, staff_actor_id, reason, created_at
    FROM tournament_admin_audit WHERE tournament_id=$1 ORDER BY id DESC LIMIT 100`, [id])).rows;
  return { tournament: adminTournament(tour, registrations.filter(r => r.status !== "withdrawn").length),
    publishedRules: tour.published_rules,
    registrations: registrations.map(reg => ({ ...registrationRow(reg), userId: reg.user_id,
      displayName: reg.public_name })),
    bracket: tour.status === "draft" ? null : await bracket(id), audit: auditRows };
}

export async function adminFinance(id: string) {
  const tour = (await db.query<{ id: string; status: string; champion_prize: string; champion_registration_id: string | null }>(
    "SELECT id,status,champion_prize,champion_registration_id FROM tournaments WHERE id=$1", [id])).rows[0];
  if (!tour) throw new TournamentError("TOURNAMENT_NOT_FOUND", 404);
  const registrations = (await db.query<RegistrationRow>(
    "SELECT * FROM tournament_registrations WHERE tournament_id=$1", [id])).rows;
  const rows = (await db.query<{ source_key: string; kind: string; amount: string }>(`
    SELECT tx.source_key,tx.kind, tx.amount::text FROM gem_transactions tx
    WHERE tx.source_key = $1::uuid::text || ':champion'
       OR EXISTS (SELECT 1 FROM tournament_registrations r WHERE r.tournament_id=$1
         AND tx.source_key IN (r.id::text || ':entry', r.id::text || ':refund'))`, [id])).rows;
  const sum = (kind: string) => rows.filter(row => row.kind === kind)
    .reduce((total, row) => total + Number(row.amount), 0);
  const issues: string[] = [];
  for (const reg of registrations) {
    if (!reg.user_id || Number(reg.paid_stake) === 0) continue;
    const entry = rows.find(row => row.source_key === `${reg.id}:entry` && row.kind === "tournament_entry");
    const refund = rows.find(row => row.source_key === `${reg.id}:refund` && row.kind === "tournament_refund");
    if (!entry || Number(entry.amount) !== -Number(reg.paid_stake)) issues.push(`ENTRY_MISMATCH:${reg.id}`);
    if (reg.refunded_at && (!refund || Number(refund.amount) !== Number(reg.paid_stake)))
      issues.push(`REFUND_MISMATCH:${reg.id}`);
    if (!reg.refunded_at && refund) issues.push(`UNEXPECTED_REFUND:${reg.id}`);
  }
  const champion = registrations.find(reg => reg.id === tour.champion_registration_id);
  const prize = rows.find(row => row.source_key === `${id}:champion` && row.kind === "tournament_prize");
  if (tour.status === "completed" && champion?.user_id && Number(tour.champion_prize) > 0 &&
      (!prize || Number(prize.amount) !== Number(tour.champion_prize))) issues.push("PRIZE_MISMATCH");
  if (tour.status !== "completed" && prize) issues.push("UNEXPECTED_PRIZE");
  return { tournamentId: id, reconciled: issues.length === 0, issues,
    entries: { count: rows.filter(row => row.kind === "tournament_entry").length, amount: -sum("tournament_entry") },
    refunds: { count: rows.filter(row => row.kind === "tournament_refund").length, amount: sum("tournament_refund") },
    prize: { count: rows.filter(row => row.kind === "tournament_prize").length, amount: sum("tournament_prize") } };
}

export async function listForPlayer(userId: string) {
  const found = await db.query<TournamentRow & { filled: string; my_id: string | null; my_status: string | null }>(`
    SELECT t.*, (SELECT count(*)::text FROM tournament_registrations r
      WHERE r.tournament_id=t.id AND r.status <> 'withdrawn') AS filled,
      mine.id AS my_id, mine.status AS my_status FROM tournaments t
    LEFT JOIN LATERAL (SELECT id, status FROM tournament_registrations r
      WHERE r.tournament_id=t.id AND r.user_id=$1 ORDER BY registered_at DESC LIMIT 1) mine ON TRUE
    WHERE t.status <> 'draft' ORDER BY t.starts_at DESC LIMIT 100`, [userId]);
  return { tournaments: found.rows.map(row => ({ ...publicTournament(row, Number(row.filled)),
    myEntry: row.my_id ? { id: row.my_id, status: row.my_status } : null })) };
}

export async function detailForPlayer(userId: string, id: string) {
  return transaction(async client => {
    const tour = (await client.query<TournamentRow>("SELECT * FROM tournaments WHERE id=$1 AND status <> 'draft'", [id])).rows[0];
    if (!tour) throw new TournamentError("TOURNAMENT_NOT_FOUND", 404);
    const filled = Number((await client.query<{ count: string }>(`SELECT count(*)::text AS count
      FROM tournament_registrations WHERE tournament_id=$1 AND status <> 'withdrawn'`, [id])).rows[0].count);
    const own = (await client.query<RegistrationRow>(`SELECT * FROM tournament_registrations
      WHERE tournament_id=$1 AND user_id=$2 ORDER BY registered_at DESC LIMIT 1`, [id, userId])).rows[0];
    const now = await clock(client);
    const qualification = await eligibility(client, tour, userId);
    const hasEntry = Boolean(own && ["registered", "playing"].includes(own.status));
    const activeElsewhere = Boolean((await client.query(`SELECT 1 FROM tournament_registrations
      WHERE user_id=$1 AND tournament_id<>$2 AND status IN ('registered','playing') LIMIT 1`,
    [userId, id])).rows[0]);
    const canRegister = tour.status === "open" && now >= tour.registration_opens_at &&
      now < tour.starts_at && filled < tour.capacity && qualification.eligible && !hasEntry && !activeElsewhere;
    return { tournament: publicTournament(tour, filled, own),
      eligibility: { ...qualification, canRegister,
        reason: tour.status !== "open" || now >= tour.starts_at ? "REGISTRATION_CLOSED" :
          now < tour.registration_opens_at ? "REGISTRATION_NOT_OPEN" :
          filled >= tour.capacity ? "TOURNAMENT_FULL" : hasEntry || activeElsewhere ? "ALREADY_ENTERED" :
          qualification.eligible ? null : "INELIGIBLE" }, serverTime: now };
  });
}

export async function register(userId: string, id: string, requestId: string) {
  return transaction(async client => {
    await lockTournamentPlayer(client, userId);
    const tour = await lockTournament(client, id);
    const prior = (await client.query<RegistrationRow>(
      "SELECT * FROM tournament_registrations WHERE user_id=$1 AND request_id=$2", [userId, requestId])).rows[0];
    if (prior) {
      if (prior.tournament_id !== id) throw new TournamentError("REQUEST_ID_REUSED");
      return { entry: registrationRow(prior), idempotent: true };
    }
    const now = await clock(client);
    if (tour.status !== "open" || now < tour.registration_opens_at || now >= tour.starts_at)
      throw new TournamentError("REGISTRATION_CLOSED");
    const active = (await client.query(`SELECT id FROM tournament_registrations WHERE user_id=$1
      AND status IN ('registered','playing') LIMIT 1`, [userId])).rows[0];
    if (active) throw new TournamentError("ALREADY_ENTERED");
    const count = Number((await client.query<{ count: string }>(`SELECT count(*)::text AS count
      FROM tournament_registrations WHERE tournament_id=$1 AND status <> 'withdrawn'`, [id])).rows[0].count);
    if (count >= tour.capacity) throw new TournamentError("TOURNAMENT_FULL");
    const qualification = await eligibility(client, tour, userId);
    if (!qualification.eligible) throw new TournamentError("INELIGIBLE");
    const person = (await client.query<{ display_name: string }>("SELECT display_name FROM users WHERE id=$1", [userId])).rows[0];
    if (!person) throw new TournamentError("USER_NOT_FOUND", 404);
    const reg = (await client.query<RegistrationRow>(`INSERT INTO tournament_registrations
      (tournament_id,user_id,request_id,public_name,paid_stake)
      VALUES ($1,$2,$3,$4,$5) RETURNING *`,
    [id, userId, requestId, person.display_name, tour.entry_stake])).rows[0];
    await walletChange(client, userId, `${reg.id}:entry`, "tournament_entry", -Number(tour.entry_stake));
    return { entry: registrationRow(reg), balanceAfter: qualification.requirements.entryStake.current - Number(tour.entry_stake) };
  });
}

export async function withdraw(userId: string, id: string) {
  return transaction(async client => {
    await lockTournamentPlayer(client, userId);
    const tour = await lockTournament(client, id);
    const reg = (await client.query<RegistrationRow>(`SELECT * FROM tournament_registrations
      WHERE tournament_id=$1 AND user_id=$2 AND status IN ('registered','playing') FOR UPDATE`, [id, userId])).rows[0];
    if (!reg) throw new TournamentError("ACTIVE_ENTRY_NOT_FOUND", 404);
    const now = await clock(client);
    if (tour.status === "open" && now < tour.starts_at) {
      await walletChange(client, userId, `${reg.id}:refund`, "tournament_refund", Number(reg.paid_stake));
      const row = (await client.query<RegistrationRow>(`UPDATE tournament_registrations
        SET status='withdrawn', refunded_at=clock_timestamp() WHERE id=$1 RETURNING *`, [reg.id])).rows[0];
      return { entry: registrationRow(row), refunded: Number(reg.paid_stake) };
    }
    const row = (await client.query<RegistrationRow>(`UPDATE tournament_registrations
      SET status='forfeited' WHERE id=$1 RETURNING *`, [reg.id])).rows[0];
    if (tour.status === "live") await forfeitRegistration(client, tour, row, now);
    return { entry: registrationRow(row), refunded: 0 };
  });
}
