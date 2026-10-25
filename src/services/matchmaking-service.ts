import type { Pool, PoolClient } from "pg";
import { db } from "../db.js";
import { randomInt } from "node:crypto";
import { onlineRulesAvailable, runOnlineRules } from "../game/online-rules.js";
import type { RulesRunner } from "../game/rules-contract.js";
import { INITIAL_SKILL, tierForSkill } from "./player-progression.js";

export const MATCHMAKING_RULES_VERSION = "pokabow-v3";
export const MATCHMAKING_LEASE_SECONDS = 30;
const QUEUE_LOCK = 70652601;
export class TicketNotFoundError extends Error {}
export class LobbyNotReadyError extends Error {}

type Ticket = {
  id: string; user_id: string; request_id: string; rules_version: string;
  status: string; lobby_id: string | null; created_at: Date; expires_at: Date; ready: boolean;
};

type RatedTicket = Ticket & { rating: number; deviation: number };

function searchWidth(deviation: number, waitingSeconds: number): number {
  return Math.min(500, Math.max(200, deviation) + 50 * Math.floor(Math.max(0, waitingSeconds) / 15));
}

/** A database lock coordinates every queue mutation across API processes.
 * Ready-up holds the lock through bounded local rules initialization so that
 * concurrent ready requests create exactly one game.
 */
export function createMatchmakingService(
  pool: Pick<Pool, "connect"> = db,
  rules: RulesRunner = runOnlineRules,
  rulesAvailable: () => boolean = onlineRulesAvailable,
) {
  async function transaction<T>(run: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock($1)", [QUEUE_LOCK]);
      await expire(client);
      const result = await run(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async function expire(client: PoolClient) {
    await client.query(`UPDATE matchmaking_tickets t SET status = 'cancelled'
      WHERE status = 'playing' AND NOT EXISTS (
        SELECT 1 FROM online_matches m WHERE (m.player_a = t.user_id OR m.player_b = t.user_id) AND m.status = 'active'
      )`);
    // clock_timestamp() measures after any lock wait, unlike transaction NOW().
    await client.query(`UPDATE matchmaking_tickets SET status = 'expired'
      WHERE status IN ('searching', 'matched') AND expires_at <= clock_timestamp()`);
    await client.query(`UPDATE matchmaking_tickets t SET status = 'opponent_left'
      WHERE t.status = 'matched' AND (t.lobby_id IS NULL OR NOT EXISTS (
        SELECT 1 FROM matchmaking_tickets other WHERE other.lobby_id = t.lobby_id
          AND other.user_id <> t.user_id AND other.status = 'matched'
      ))`);
    // Includes orphaned lobbies after account deletion; tickets retain history.
    await client.query(`DELETE FROM matchmaking_lobbies l WHERE NOT EXISTS (
      SELECT 1 FROM matchmaking_tickets t WHERE t.lobby_id = l.id AND t.status IN ('matched', 'playing')
    )`);
  }

  async function read(client: PoolClient, playerId: string, id: string): Promise<Ticket> {
    const result = await client.query<Ticket>(
      "SELECT * FROM matchmaking_tickets WHERE id = $1 AND user_id = $2", [id, playerId]);
    if (!result.rows[0]) throw new TicketNotFoundError();
    return result.rows[0];
  }

  async function renew(client: PoolClient, ticket: Ticket) {
    if (!["searching", "matched"].includes(ticket.status)) return;
    await client.query(`UPDATE matchmaking_tickets
      SET expires_at = clock_timestamp() + $2 * interval '1 second' WHERE id = $1`,
    [ticket.id, MATCHMAKING_LEASE_SECONDS]);
  }

  async function pair(client: PoolClient, ticket: Ticket) {
    if (ticket.status !== "searching") return;
    const ownSkill = await client.query<{ rating: number; deviation: number }>(
      "SELECT rating, deviation FROM player_skill WHERE user_id = $1", [ticket.user_id]);
    const rating = ownSkill.rows[0]?.rating ?? 1500;
    const deviation = ownSkill.rows[0]?.deviation ?? 350;
    const found = await client.query<RatedTicket>(`SELECT t.*, COALESCE(s.rating, 1500) AS rating,
      COALESCE(s.deviation, 350) AS deviation FROM matchmaking_tickets t
      LEFT JOIN player_skill s ON s.user_id = t.user_id
      WHERE t.status = 'searching' AND t.user_id <> $1 AND t.rules_version = $2
        AND t.expires_at > clock_timestamp()
      ORDER BY t.created_at, t.id LIMIT 100 FOR UPDATE OF t`, [ticket.user_id, ticket.rules_version]);
    const now = Date.now();
    const ownWidth = searchWidth(deviation, (now - ticket.created_at.getTime()) / 1000);
    const opponent = found.rows.filter(candidate => {
      const width = searchWidth(candidate.deviation, (now - candidate.created_at.getTime()) / 1000);
      return Math.abs(candidate.rating - rating) <= Math.min(ownWidth, width);
    }).sort((a, b) => Math.abs(a.rating - rating) - Math.abs(b.rating - rating)
      || a.created_at.getTime() - b.created_at.getTime())[0];
    if (!opponent) return;
    const lobby = await client.query<{ id: string }>(`INSERT INTO matchmaking_lobbies (player_a, player_b)
      VALUES ($1, $2) RETURNING id`, [opponent.user_id, ticket.user_id]);
    await client.query(`UPDATE matchmaking_tickets SET status = 'matched', lobby_id = $1
      WHERE id = ANY($2::uuid[])`, [lobby.rows[0].id, [ticket.id, opponent.id]]);
  }

  async function response(client: PoolClient, ticket: Ticket) {
    let lobby = null;
    if (["matched", "playing"].includes(ticket.status) && ticket.lobby_id) {
      const result = await client.query<{ id: string; display_name: string; ready: boolean;
        rating: number | null; deviation: number | null; volatility: number | null; rated_matches: number | null }>(
        `SELECT u.id, u.display_name, t.ready, s.rating, s.deviation, s.volatility, s.rated_matches
         FROM matchmaking_tickets t
         JOIN users u ON u.id = t.user_id
         LEFT JOIN player_skill s ON s.user_id = t.user_id
         WHERE t.lobby_id = $1 AND t.user_id <> $2 AND t.status IN ('matched', 'playing')`,
        [ticket.lobby_id, ticket.user_id]);
      const opponent = result.rows[0];
      if (opponent) lobby = {
        id: ticket.lobby_id,
        opponent: { id: opponent.id, displayName: opponent.display_name,
          onlineTier: tierForSkill(opponent.rating == null ? INITIAL_SKILL : {
            rating: opponent.rating, deviation: opponent.deviation!,
            volatility: opponent.volatility!, ratedMatches: opponent.rated_matches!,
          }) },
        playable: ticket.status === "playing",
        canReady: rulesAvailable(),
        ready: ticket.ready, opponentReady: opponent.ready,
        matchId: ticket.status === "playing" ? ticket.lobby_id : null,
      };
    }
    return {
      ticketId: ticket.id, status: ticket.status, rulesVersion: ticket.rules_version,
      expiresAt: ticket.expires_at, pollAfterMs: 2000, lobby,
    };
  }

  return {
    ready(playerId: string, id: string) {
      return transaction(async client => {
        const ticket = await read(client, playerId, id);
        if (ticket.status === "playing") return response(client, ticket);
        if (ticket.status !== "matched" || !ticket.lobby_id) throw new LobbyNotReadyError();
        if (!rulesAvailable()) throw new LobbyNotReadyError();
        await renew(client, ticket);
        await client.query("UPDATE matchmaking_tickets SET ready = TRUE WHERE id = $1", [id]);
        const tickets = await client.query<Ticket>("SELECT * FROM matchmaking_tickets WHERE lobby_id = $1 AND status = 'matched'", [ticket.lobby_id]);
        if (tickets.rows.length === 2 && tickets.rows.every(t => t.ready)) {
          // The same queue lock serializes readiness against departure/expiry.
          const lobby = (await client.query("SELECT * FROM matchmaking_lobbies WHERE id = $1", [ticket.lobby_id])).rows[0];
          const state = await rules({ action: "create", matchId: ticket.lobby_id, seed: randomInt(1, 2147483647) });
          if ("error" in state) throw new Error(state.error);
          await client.query(`INSERT INTO online_matches (id, lobby_id, player_a, player_b, state)
            VALUES ($1, $1, $2, $3, $4)`,
          [ticket.lobby_id, lobby.player_a, lobby.player_b, JSON.stringify(state)]);
          await client.query("UPDATE matchmaking_tickets SET status = 'playing' WHERE lobby_id = $1", [ticket.lobby_id]);
        }
        return response(client, await read(client, playerId, id));
      });
    },
    join(playerId: string, requestId: string) {
      return transaction(async client => {
        // Replaying an old request never resurrects a cancelled/expired search.
        const previous = await client.query<Ticket>(`SELECT * FROM matchmaking_tickets
          WHERE user_id = $1 AND request_id = $2`, [playerId, requestId]);
        let ticket = previous.rows[0];
        if (!ticket) {
          const active = await client.query<Ticket>(`SELECT * FROM matchmaking_tickets
            WHERE user_id = $1 AND status IN ('searching', 'matched', 'playing')`, [playerId]);
          ticket = active.rows[0];
        }
        if (!ticket) {
          const inserted = await client.query<Ticket>(`INSERT INTO matchmaking_tickets
            (user_id, request_id, rules_version, status, expires_at)
            VALUES ($1, $2, $3, 'searching', clock_timestamp() + $4 * interval '1 second') RETURNING *`,
          [playerId, requestId, MATCHMAKING_RULES_VERSION, MATCHMAKING_LEASE_SECONDS]);
          ticket = inserted.rows[0];
        }
        await renew(client, ticket);
        await pair(client, ticket);
        return response(client, await read(client, playerId, ticket.id));
      });
    },

    cancelRequest(playerId: string, requestId: string) {
      return transaction(async client => {
        // A cancellation tombstone prevents a delayed POST from reviving a
        // search whose successful response never reached the phone.
        const result = await client.query<Ticket>(`INSERT INTO matchmaking_tickets
          (user_id, request_id, rules_version, status, expires_at)
          VALUES ($1, $2, $3, 'cancelled', clock_timestamp())
          ON CONFLICT (user_id, request_id) DO UPDATE SET status =
            CASE WHEN matchmaking_tickets.status = 'playing' THEN 'playing' ELSE 'cancelled' END
          RETURNING *`, [playerId, requestId, MATCHMAKING_RULES_VERSION]);
        await expire(client);
        return response(client, await read(client, playerId, result.rows[0].id));
      });
    },

    current(playerId: string) {
      return transaction(async client => {
        const result = await client.query<Ticket>(`SELECT * FROM matchmaking_tickets
          WHERE user_id = $1 AND status IN ('searching', 'matched', 'playing') LIMIT 1`, [playerId]);
        return result.rows[0] ? response(client, result.rows[0]) : null;
      });
    },

    heartbeat(playerId: string, id: string) {
      return transaction(async client => {
        const ticket = await read(client, playerId, id);
        await renew(client, ticket);
        await pair(client, ticket);
        return response(client, await read(client, playerId, id));
      });
    },

    cancel(playerId: string, id: string) {
      return transaction(async client => {
        const ticket = await read(client, playerId, id);
        if (["searching", "matched"].includes(ticket.status)) {
          await client.query("UPDATE matchmaking_tickets SET status = 'cancelled' WHERE id = $1", [id]);
          await expire(client);
        }
        return response(client, await read(client, playerId, id));
      });
    },
  };
}

export const matchmakingService = createMatchmakingService();
