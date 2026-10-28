import type { Pool, PoolClient } from "pg";
import { db } from "../db.js";
import { levelFromExperience } from "./player-progression.js";

export const TOURNAMENT_POLICY = "tournament-v1";
export class TournamentError extends Error {
  constructor(public code: string, public status = 409) { super(code); }
}
export type TournamentRow = {
  id: string; name: string; status: "draft" | "open" | "live" | "completed" | "cancelled";
  registration_opens_at: Date; starts_at: Date; capacity: number;
  entry_stake: string; champion_prize: string; min_table_level: number;
  min_online_wins: number; min_gem_balance: string; turn_seconds: number;
  rules_version: number; published_rules: unknown; published_at: Date | null;
  champion_registration_id: string | null; completed_at: Date | null;
};
export type RegistrationRow = {
  id: string; tournament_id: string; user_id: string | null; request_id: string;
  public_name: string; status: string; paid_stake: string; slot: number | null;
  registered_at: Date; refunded_at: Date | null;
};

export async function transaction<T>(run: (client: PoolClient) => Promise<T>,
  pool: Pick<Pool, "connect"> = db): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await run(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally { client.release(); }
}

export async function clock(client: PoolClient): Promise<Date> {
  return (await client.query<{ time: Date }>("SELECT clock_timestamp() AS time")).rows[0].time;
}

export async function lockTournament(client: PoolClient, id: string): Promise<TournamentRow> {
  const row = (await client.query<TournamentRow>("SELECT * FROM tournaments WHERE id = $1 FOR UPDATE", [id])).rows[0];
  if (!row) throw new TournamentError("TOURNAMENT_NOT_FOUND", 404);
  return row;
}

/** Serialize entry and deletion for one account without holding a users row lock. */
export async function lockTournamentPlayer(client: PoolClient, userId: string): Promise<void> {
  await client.query("SELECT pg_advisory_xact_lock($1, hashtext($2))", [70652603, userId]);
}

export async function walletBalance(client: PoolClient, userId: string, lock = false): Promise<number> {
  if (lock) await client.query("INSERT INTO gem_wallets (user_id, balance) VALUES ($1, 0) ON CONFLICT DO NOTHING", [userId]);
  const row = (await client.query<{ balance: string }>(
    `SELECT balance::text FROM gem_wallets WHERE user_id = $1${lock ? " FOR UPDATE" : ""}`, [userId])).rows[0];
  return row ? Number(row.balance) : 0;
}

/** Signed transactions and the wallet balance change in the caller's transaction. */
export async function walletChange(client: PoolClient, userId: string, sourceKey: string,
  kind: "tournament_entry" | "tournament_refund" | "tournament_prize", amount: number): Promise<void> {
  if (amount === 0) return;
  if (!Number.isSafeInteger(amount)) throw new Error("INVALID_TOURNAMENT_GEM_AMOUNT");
  const balance = await walletBalance(client, userId, true);
  if (balance + amount < 0) throw new TournamentError("INSUFFICIENT_GEMS");
  const inserted = await client.query(`INSERT INTO gem_transactions
    (user_id, source_key, kind, amount, policy_version)
    VALUES ($1, $2, $3, $4, $5) ON CONFLICT (user_id, source_key) DO NOTHING RETURNING id`,
  [userId, sourceKey, kind, amount, TOURNAMENT_POLICY]);
  if (inserted.rowCount !== 1) return;
  await client.query(`UPDATE gem_wallets SET balance = balance + $2, updated_at = clock_timestamp()
    WHERE user_id = $1`, [userId, amount]);
}

export async function eligibility(client: PoolClient, tour: TournamentRow, userId: string) {
  const profile = (await client.query<{ experience: string; online_wins: string; tournament_wins: string }>(`
    SELECT COALESCE(p.experience, 0)::text AS experience,
      (SELECT count(*)::text FROM online_matches m WHERE m.status = 'completed' AND
        ((m.player_a = $1 AND (m.state->'snapshot'->>'outcome')::int = 1) OR
         (m.player_b = $1 AND (m.state->'snapshot'->>'outcome')::int = 2))) AS online_wins,
      (SELECT count(*)::text FROM tournament_matches m
         JOIN tournament_registrations r ON r.id = m.winner_registration_id
         WHERE r.user_id = $1 AND m.decisive_played) AS tournament_wins
    FROM users u LEFT JOIN player_progression p ON p.user_id = u.id WHERE u.id = $1`, [userId])).rows[0];
  if (!profile) throw new TournamentError("USER_NOT_FOUND", 404);
  const balance = await walletBalance(client, userId);
  const level = levelFromExperience(Number(profile.experience));
  const wins = Number(profile.online_wins) + Number(profile.tournament_wins);
  const requirements = {
    tableLevel: { required: tour.min_table_level, current: level, met: level >= tour.min_table_level },
    onlineWins: { required: tour.min_online_wins, current: wins, met: wins >= tour.min_online_wins },
    gemBalance: { required: Number(tour.min_gem_balance), current: balance,
      met: balance >= Number(tour.min_gem_balance) },
    entryStake: { required: Number(tour.entry_stake), current: balance,
      met: balance >= Number(tour.entry_stake) },
  };
  return { eligible: Object.values(requirements).every(value => value.met), requirements };
}

export function publicTournament(tour: TournamentRow, filled: number, own?: RegistrationRow | null) {
  return {
    id: tour.id, name: tour.name, status: tour.status,
    registrationOpensAt: tour.registration_opens_at, startsAt: tour.starts_at,
    registrationClosesAt: tour.starts_at, capacity: tour.capacity, filledPlaces: filled,
    entryStake: Number(tour.entry_stake), championPrize: Number(tour.champion_prize),
    requirements: { tableLevel: tour.min_table_level, onlineWins: tour.min_online_wins,
      gemBalance: Number(tour.min_gem_balance) },
    turnLimitSeconds: tour.turn_seconds, rulesVersion: tour.rules_version,
    myEntry: own ? { id: own.id, status: own.status, registeredAt: own.registered_at,
      refundedAt: own.refunded_at } : null,
  };
}

export function registrationRow(reg: RegistrationRow) {
  return { id: reg.id, tournamentId: reg.tournament_id, status: reg.status,
    paidStake: Number(reg.paid_stake), slot: reg.slot,
    registeredAt: reg.registered_at, refundedAt: reg.refunded_at };
}
