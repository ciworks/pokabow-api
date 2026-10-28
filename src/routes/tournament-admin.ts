import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { authorizeAdmin } from "./achievement-admin.js";
import { TournamentError } from "../services/tournament-core.js";
import { adminDetail, adminList, cancel, createDraft, publish, updateDraft } from "../services/tournament-service.js";
import { startDueTournament } from "../services/tournament-bracket.js";

const id = z.string().uuid();
const configuration = z.object({
  name: z.string().trim().min(1).max(80),
  registrationOpensAt: z.iso.datetime({ offset: true }),
  startsAt: z.iso.datetime({ offset: true }),
  capacity: z.union([z.literal(4), z.literal(8), z.literal(16)]),
  entryStake: z.number().int().min(0).max(1_000_000_000),
  championPrize: z.number().int().min(0).max(1_000_000_000),
  minTableLevel: z.number().int().min(1).max(100_000),
  minOnlineWins: z.number().int().min(0).max(1_000_000),
  minGemBalance: z.number().int().min(0).max(1_000_000_000),
  turnLimitSeconds: z.union([z.literal(60), z.literal(120), z.literal(300)]),
}).strict();

export async function tournamentAdminRoutes(app: FastifyInstance) {
  app.addHook("onRequest", authorizeAdmin);
  app.addHook("onSend", async (_request, reply) => { reply.header("Cache-Control", "no-store"); });
  app.get("/", async () => adminList());
  app.post("/", async (request, reply) => {
    const parsed = configuration.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "INVALID_REQUEST", details: parsed.error.flatten() });
    try { return reply.code(201).send(await createDraft(request.user.sub, parsed.data)); }
    catch (error) {
      if (error instanceof TournamentError) return reply.code(error.status).send({ error: error.code });
      throw error;
    }
  });
  app.get("/:tournamentId", async (request, reply) => {
    const params = z.object({ tournamentId: id }).safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: "INVALID_REQUEST" });
    try { return await adminDetail(params.data.tournamentId); }
    catch (error) {
      if (error instanceof TournamentError) return reply.code(error.status).send({ error: error.code });
      throw error;
    }
  });
  app.patch("/:tournamentId", async (request, reply) => {
    const params = z.object({ tournamentId: id }).safeParse(request.params);
    const body = configuration.safeParse(request.body);
    if (!params.success || !body.success) return reply.code(400).send({ error: "INVALID_REQUEST" });
    try { return await updateDraft(request.user.sub, params.data.tournamentId, body.data); }
    catch (error) {
      if (error instanceof TournamentError) return reply.code(error.status).send({ error: error.code });
      throw error;
    }
  });
  for (const action of ["publish", "cancel"] as const) {
    app.post(`/:tournamentId/${action}`, async (request, reply) => {
      const params = z.object({ tournamentId: id }).safeParse(request.params);
      if (!params.success || request.body != null && !z.object({}).strict().safeParse(request.body).success)
        return reply.code(400).send({ error: "INVALID_REQUEST" });
      try { return await (action === "publish" ? publish : cancel)(request.user.sub, params.data.tournamentId); }
      catch (error) {
        if (error instanceof TournamentError) return reply.code(error.status).send({ error: error.code });
        throw error;
      }
    });
  }
  app.post("/:tournamentId/start", async (request, reply) => {
    const params = z.object({ tournamentId: id }).safeParse(request.params);
    if (!params.success || request.body != null && !z.object({}).strict().safeParse(request.body).success)
      return reply.code(400).send({ error: "INVALID_REQUEST" });
    try {
      await startDueTournament(params.data.tournamentId, true, request.user.sub);
      return await adminDetail(params.data.tournamentId);
    } catch (error) {
      if (error instanceof TournamentError) return reply.code(error.status).send({ error: error.code });
      throw error;
    }
  });
}
