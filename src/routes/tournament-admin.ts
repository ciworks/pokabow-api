import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { authenticateStaff, requireStaffMutation, verifyEmergencyCode } from "../auth/staff.js";
import { TournamentError } from "../services/tournament-core.js";
import { adminDetail, adminFinance, adminList, cancel, createDraft, publish, updateDraft } from "../services/tournament-service.js";
import { startDueTournament } from "../services/tournament-bracket.js";
import { registerTournamentArtworkRoutes } from "./tournament-artwork.js";

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
  app.addHook("onRequest", authenticateStaff);
  app.addHook("onSend", async (_request, reply) => { reply.header("Cache-Control", "no-store"); });
  registerTournamentArtworkRoutes(app, true);
  app.get("/", async (request, reply) => {
    const query = z.object({ status: z.enum(["draft", "open", "live", "completed", "cancelled"]).optional(),
      search: z.string().trim().min(1).max(80).optional(), cursor: z.string().max(300).optional() }).strict().safeParse(request.query);
    if (!query.success) return reply.code(400).send({ error: "INVALID_REQUEST" });
    try { return await adminList(query.data); }
    catch (error) {
      if (error instanceof TournamentError) return reply.code(error.status).send({ error: error.code });
      throw error;
    }
  });
  app.post("/", { preHandler: requireStaffMutation }, async (request, reply) => {
    const parsed = configuration.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "INVALID_REQUEST", details: parsed.error.flatten() });
    try { return reply.code(201).send(await createDraft(request.staff!.id, parsed.data)); }
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
  app.get("/:tournamentId/finance", async (request, reply) => {
    const params = z.object({ tournamentId: id }).safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: "INVALID_REQUEST" });
    try { return await adminFinance(params.data.tournamentId); }
    catch (error) {
      if (error instanceof TournamentError) return reply.code(error.status).send({ error: error.code });
      throw error;
    }
  });
  app.patch("/:tournamentId", { preHandler: requireStaffMutation }, async (request, reply) => {
    const params = z.object({ tournamentId: id }).safeParse(request.params);
    const body = configuration.safeParse(request.body);
    if (!params.success || !body.success) return reply.code(400).send({ error: "INVALID_REQUEST" });
    try { return await updateDraft(request.staff!.id, params.data.tournamentId, body.data); }
    catch (error) {
      if (error instanceof TournamentError) return reply.code(error.status).send({ error: error.code });
      throw error;
    }
  });
  app.post("/:tournamentId/publish", { preHandler: requireStaffMutation }, async (request, reply) => {
    const params = z.object({ tournamentId: id }).safeParse(request.params);
    if (!params.success || request.body != null && !z.object({}).strict().safeParse(request.body).success)
      return reply.code(400).send({ error: "INVALID_REQUEST" });
    try { return await publish(request.staff!.id, params.data.tournamentId); }
    catch (error) {
      if (error instanceof TournamentError) return reply.code(error.status).send({ error: error.code });
      throw error;
    }
  });
  app.post("/:tournamentId/cancel", { preHandler: requireStaffMutation }, async (request, reply) => {
    const params = z.object({ tournamentId: id }).safeParse(request.params);
    const body = z.object({ reason: z.string().trim().min(10).max(500).optional(),
      totp: z.string().regex(/^\d{6}$/).optional() }).strict().safeParse(request.body ?? {});
    if (!params.success || !body.success) return reply.code(400).send({ error: "INVALID_REQUEST" });
    if (body.data.totp && !(await verifyEmergencyCode(request.staff!.id, body.data.totp)))
      return reply.code(403).send({ error: "INVALID_EMERGENCY_CODE" });
    try { return await cancel(request.staff!.id, params.data.tournamentId,
      body.data.totp ? request.staff!.role : request.staff!.role === "emergency_operator" ? "operator" : request.staff!.role,
      body.data.reason); }
    catch (error) {
      if (error instanceof TournamentError) return reply.code(error.status).send({ error: error.code });
      throw error;
    }
  });
  app.post("/:tournamentId/start", { preHandler: requireStaffMutation }, async (request, reply) => {
    const params = z.object({ tournamentId: id }).safeParse(request.params);
    if (!params.success || request.body != null && !z.object({}).strict().safeParse(request.body).success)
      return reply.code(400).send({ error: "INVALID_REQUEST" });
    try {
      await startDueTournament(params.data.tournamentId, true, request.staff!.id);
      return await adminDetail(params.data.tournamentId);
    } catch (error) {
      if (error instanceof TournamentError) return reply.code(error.status).send({ error: error.code });
      throw error;
    }
  });
}
