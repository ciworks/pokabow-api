import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { authenticate } from "../auth/authenticate.js";
import { db } from "../db.js";
import { findAvatar } from "../repositories/avatar-repository.js";
import { bracket, commandTournamentMatch, currentTournamentMatch, getTournamentMatch,
  joinTournamentMatch, leaderboard } from "../services/tournament-bracket.js";
import { TournamentError } from "../services/tournament-core.js";
import { detailForPlayer, listForPlayer, register, withdraw } from "../services/tournament-service.js";
import { registerTournamentArtworkRoutes } from "./tournament-artwork.js";

const id = z.string().uuid();
const placement = z.object({ tileId: z.string().min(1).max(200), x: z.number().int().min(0).max(11),
  y: z.number().int().min(0).max(11), rotation: z.number().int().min(0).max(3) }).strict();
const common = { commandId: id, expectedVersion: z.number().int().min(1) };
const command = z.discriminatedUnion("action", [
  z.object({ ...common, action: z.literal("place"), placements: z.array(placement).min(1).max(10) }).strict(),
  z.object({ ...common, action: z.literal("swap"), tileIds: z.array(z.string().min(1).max(200)).min(1).max(10) }).strict(),
  z.object({ ...common, action: z.literal("resign") }).strict(),
]);

async function send<T>(reply: { code: (status: number) => { send: (value: unknown) => unknown } },
  run: () => Promise<T>): Promise<T | unknown> {
  try { return await run(); }
  catch (error) {
    if (error instanceof TournamentError) return reply.code(error.status).send({ error: error.code });
    if ((error as { code?: string })?.code === "23505") return reply.code(409).send({ error: "ALREADY_ENTERED" });
    throw error;
  }
}

export async function tournamentRoutes(app: FastifyInstance) {
  app.addHook("onRequest", authenticate);
  app.addHook("onSend", async (_request, reply) => { reply.header("Cache-Control", "no-store"); });
  registerTournamentArtworkRoutes(app, false);
  app.get("/", async request => listForPlayer(request.user.sub));
  app.get("/matches/current", async request => ({ match: await currentTournamentMatch(request.user.sub) }));
  app.get("/matches/:matchId", async (request, reply) => {
    const params = z.object({ matchId: id }).safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: "INVALID_REQUEST" });
    return send(reply, () => getTournamentMatch(request.user.sub, params.data.matchId));
  });
  app.post("/matches/:matchId/join", async (request, reply) => {
    const params = z.object({ matchId: id }).safeParse(request.params);
    if (!params.success || request.body != null && !z.object({}).strict().safeParse(request.body).success)
      return reply.code(400).send({ error: "INVALID_REQUEST" });
    return send(reply, () => joinTournamentMatch(request.user.sub, params.data.matchId));
  });
  app.post("/matches/:matchId/commands", async (request, reply) => {
    const params = z.object({ matchId: id }).safeParse(request.params);
    const parsed = command.safeParse(request.body);
    if (!params.success || !parsed.success) return reply.code(400).send({ error: "INVALID_REQUEST" });
    return send(reply, () => commandTournamentMatch(request.user.sub, params.data.matchId, parsed.data));
  });
  app.get("/:tournamentId", async (request, reply) => {
    const params = z.object({ tournamentId: id }).safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: "INVALID_REQUEST" });
    return send(reply, () => detailForPlayer(request.user.sub, params.data.tournamentId));
  });
  app.get("/:tournamentId/eligibility", async (request, reply) => {
    const params = z.object({ tournamentId: id }).safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: "INVALID_REQUEST" });
    return send(reply, async () => {
      const detail = await detailForPlayer(request.user.sub, params.data.tournamentId);
      return { tournamentId: params.data.tournamentId, serverTime: detail.serverTime,
        eligibility: detail.eligibility };
    });
  });
  app.post("/:tournamentId/register", async (request, reply) => {
    const params = z.object({ tournamentId: id }).safeParse(request.params);
    const body = z.object({ requestId: id }).strict().safeParse(request.body);
    if (!params.success || !body.success) return reply.code(400).send({ error: "INVALID_REQUEST" });
    return send(reply, () => register(request.user.sub, params.data.tournamentId, body.data.requestId));
  });
  app.post("/:tournamentId/withdraw", async (request, reply) => {
    const params = z.object({ tournamentId: id }).safeParse(request.params);
    if (!params.success || request.body != null && !z.object({}).strict().safeParse(request.body).success)
      return reply.code(400).send({ error: "INVALID_REQUEST" });
    return send(reply, () => withdraw(request.user.sub, params.data.tournamentId));
  });
  app.get("/:tournamentId/bracket", async (request, reply) => {
    const params = z.object({ tournamentId: id }).safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: "INVALID_REQUEST" });
    return send(reply, () => bracket(params.data.tournamentId));
  });
  app.get("/:tournamentId/leaderboard", async (request, reply) => {
    const params = z.object({ tournamentId: id }).safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: "INVALID_REQUEST" });
    return send(reply, () => leaderboard(params.data.tournamentId));
  });
  app.get("/:tournamentId/entrants/:registrationId/avatar", async (request, reply) => {
    const params = z.object({ tournamentId: id, registrationId: id }).safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: "INVALID_REQUEST" });
    const entrant = (await db.query<{ user_id: string }>(`SELECT r.user_id
      FROM tournament_registrations r JOIN tournaments t ON t.id=r.tournament_id
      WHERE t.id=$1 AND r.id=$2 AND r.slot IS NOT NULL AND r.user_id IS NOT NULL`,
    [params.data.tournamentId, params.data.registrationId])).rows[0];
    if (!entrant) return reply.code(404).send({ error: "AVATAR_NOT_FOUND" });
    const avatar = await findAvatar(entrant.user_id);
    if (!avatar) return reply.code(404).send({ error: "AVATAR_NOT_FOUND" });
    return reply.type("image/png").header("X-Content-Type-Options", "nosniff").send(avatar.png);
  });
}
