import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { authenticateStaff } from "../auth/staff.js";
import { db } from "../db.js";

const uuid = z.string().uuid();
const paging = z.object({ search: z.string().trim().max(100).optional(), page: z.coerce.number().int().min(1).max(100).default(1) }).strict();
const gamePaging = z.object({ kind: z.enum(["client", "online", "ai", "tournament"]).optional(),
  playerId: uuid.optional(), page: z.coerce.number().int().min(1).max(100).default(1) }).strict();
const LIMIT = 25;

const gamesSql = `
  SELECT 'client' AS kind, g.id, g.status, g.created_at, g.completed_at, g.version,
    ARRAY(SELECT gp.user_id FROM game_players gp WHERE gp.game_id=g.id ORDER BY gp.user_id) AS player_ids,
    NULL::uuid AS tournament_id, NULL::text AS opponent, NULL::text AS result
  FROM games g
  UNION ALL
  SELECT 'online', m.id, m.status, m.created_at, m.completed_at, m.version,
    array_remove(ARRAY[m.player_a,m.player_b], NULL), NULL::uuid, NULL::text, NULL::text
  FROM online_matches m
  UNION ALL
  SELECT 'ai', m.id, m.status, m.created_at, m.completed_at, m.version,
    ARRAY[m.user_id], NULL::uuid, m.rival_name, NULL::text
  FROM verified_ai_matches m
  UNION ALL
  SELECT 'tournament', m.id, m.status, COALESCE(m.ready_at,t.starts_at), m.completed_at, m.version,
    ARRAY(SELECT r.user_id FROM tournament_registrations r
      WHERE r.id IN (m.registration_a,m.registration_b) AND r.user_id IS NOT NULL ORDER BY r.user_id),
    m.tournament_id, NULL::text, m.result_kind
  FROM tournament_matches m JOIN tournaments t ON t.id=m.tournament_id`;

export async function supportAdminRoutes(app: FastifyInstance) {
  app.addHook("onRequest", authenticateStaff);
  app.addHook("onSend", async (_request, reply) => { reply.header("Cache-Control", "no-store"); });

  app.get("/players", async (request, reply) => {
    const parsed = paging.safeParse(request.query);
    if (!parsed.success) return reply.code(400).send({ error: "INVALID_REQUEST" });
    const { search, page } = parsed.data;
    const result = await db.query(`SELECT u.id, u.display_name AS "displayName", u.email,
      u.email_verified AS "emailVerified", u.created_at AS "createdAt",
      (a.user_id IS NOT NULL) AS "hasAvatar"
      FROM users u LEFT JOIN user_avatars a ON a.user_id=u.id
      WHERE $1::text IS NULL OR u.id::text=$1 OR u.display_name ILIKE '%' || $1 || '%'
        OR u.email ILIKE '%' || $1 || '%'
      ORDER BY u.created_at DESC, u.id DESC LIMIT $2 OFFSET $3`,
      [search || null, LIMIT + 1, (page - 1) * LIMIT]);
    return { players: result.rows.slice(0, LIMIT), page, hasMore: result.rows.length > LIMIT };
  });

  app.get("/players/:playerId", async (request, reply) => {
    const params = z.object({ playerId: uuid }).safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: "INVALID_REQUEST" });
    const id = params.data.playerId;
    const player = (await db.query(`SELECT u.id, u.display_name AS "displayName", u.email,
      u.email_verified AS "emailVerified", u.created_at AS "createdAt",
      (a.user_id IS NOT NULL) AS "hasAvatar", COALESCE(w.balance,0) AS "gemBalance",
      COALESCE(p.experience,0) AS experience, s.rating, s.deviation,
      COALESCE(s.rated_matches,0) AS "ratedMatches"
      FROM users u LEFT JOIN user_avatars a ON a.user_id=u.id
      LEFT JOIN gem_wallets w ON w.user_id=u.id
      LEFT JOIN player_progression p ON p.user_id=u.id
      LEFT JOIN player_skill s ON s.user_id=u.id WHERE u.id=$1`, [id])).rows[0];
    if (!player) return reply.code(404).send({ error: "PLAYER_NOT_FOUND" });
    const [achievements, tournaments, sessions, gems] = await Promise.all([
      db.query(`SELECT a.id, a.name, ua.unlocked_at AS "unlockedAt" FROM user_achievements ua
        JOIN achievements a ON a.id=ua.achievement_id WHERE ua.user_id=$1
        ORDER BY ua.unlocked_at DESC LIMIT 30`, [id]),
      db.query(`SELECT r.id AS "registrationId", r.status, r.registered_at AS "registeredAt",
        t.id AS "tournamentId", t.name AS "tournamentName", t.status AS "tournamentStatus"
        FROM tournament_registrations r JOIN tournaments t ON t.id=r.tournament_id
        WHERE r.user_id=$1 ORDER BY r.registered_at DESC, r.id DESC LIMIT 30`, [id]),
      db.query(`SELECT COUNT(*)::int AS count FROM auth_sessions
        WHERE user_id=$1 AND revoked_at IS NULL AND expires_at>clock_timestamp()`, [id]),
      db.query(`SELECT id,kind,amount,created_at AS "createdAt",source_key AS "sourceKey"
        FROM gem_transactions WHERE user_id=$1 ORDER BY id DESC LIMIT 30`, [id])
    ]);
    return { player, achievements: achievements.rows, tournaments: tournaments.rows,
      activeSessions: sessions.rows[0]?.count ?? 0, gemTransactions: gems.rows };
  });

  app.get("/games", async (request, reply) => {
    const parsed = gamePaging.safeParse(request.query);
    if (!parsed.success) return reply.code(400).send({ error: "INVALID_REQUEST" });
    const { kind, playerId, page } = parsed.data;
    const result = await db.query(`SELECT * FROM (${gamesSql}) g
      WHERE ($1::text IS NULL OR g.kind=$1) AND ($2::uuid IS NULL OR $2=ANY(g.player_ids))
      ORDER BY g.created_at DESC, g.id DESC, g.kind LIMIT $3 OFFSET $4`,
      [kind || null, playerId || null, LIMIT + 1, (page - 1) * LIMIT]);
    return { games: result.rows.slice(0, LIMIT).map(row => ({ kind: row.kind, id: row.id, status: row.status,
      createdAt: row.created_at, completedAt: row.completed_at, version: row.version,
      playerIds: row.player_ids, tournamentId: row.tournament_id, opponent: row.opponent,
      result: row.result })),
      page, hasMore: result.rows.length > LIMIT };
  });

  app.get("/games/:kind/:gameId", async (request, reply) => {
    const params = z.object({ kind: z.enum(["client", "online", "ai", "tournament"]), gameId: uuid }).safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: "INVALID_REQUEST" });
    const { kind, gameId } = params.data;
    const result = await db.query(`SELECT * FROM (${gamesSql}) g WHERE g.kind=$1 AND g.id=$2`, [kind, gameId]);
    const game = result.rows[0];
    if (!game) return reply.code(404).send({ error: "GAME_NOT_FOUND" });
    const players = await db.query(`SELECT id,display_name AS "displayName" FROM users WHERE id=ANY($1::uuid[])`, [game.player_ids]);
    return { game: { kind: game.kind, id: game.id, status: game.status, createdAt: game.created_at,
      completedAt: game.completed_at, version: game.version, tournamentId: game.tournament_id,
      opponent: game.opponent, result: game.result }, players: players.rows };
  });
}
