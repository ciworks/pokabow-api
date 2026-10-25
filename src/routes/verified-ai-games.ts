import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { authenticate } from "../auth/authenticate.js";
import { VerifiedAiError, verifiedAiGameService } from "../services/verified-ai-game-service.js";

const id = z.string().uuid();
const placement = z.object({ tileId: z.string().min(1).max(200), x: z.number().int().min(0).max(11),
  y: z.number().int().min(0).max(11), rotation: z.number().int().min(0).max(3) }).strict();
const common = { commandId: id, expectedVersion: z.number().int().min(1) };
const command = z.discriminatedUnion("action", [
  z.object({ ...common, action: z.literal("place"), placements: z.array(placement).min(1).max(10) }).strict(),
  z.object({ ...common, action: z.literal("swap"), tileIds: z.array(z.string().min(1).max(200)).min(1).max(10) }).strict(),
  z.object({ ...common, action: z.literal("resign") }).strict(),
  z.object({ ...common, action: z.literal("difficulty"), difficulty: z.number().int().min(0).max(2) }).strict(),
]);

export async function verifiedAiGameRoutes(app: FastifyInstance) {
  app.addHook("onRequest", authenticate);
  app.addHook("onSend", async (_request, reply) => { reply.header("Cache-Control", "no-store"); });
  app.get("/current", async request => ({ match: await verifiedAiGameService.current(request.user.sub) }));
  app.post("/", async (request, reply) => {
    const parsed = z.object({ requestId: id, difficulty: z.number().int().min(0).max(2) }).strict().safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "INVALID_REQUEST" });
    return verifiedAiGameService.create(request.user.sub, parsed.data.requestId, parsed.data.difficulty);
  });
  app.get("/:matchId", async (request, reply) => {
    const parsed = z.object({ matchId: id }).safeParse(request.params);
    if (!parsed.success) return reply.code(400).send({ error: "INVALID_REQUEST" });
    try { return await verifiedAiGameService.get(request.user.sub, parsed.data.matchId); }
    catch (error) {
      if (error instanceof VerifiedAiError) return reply.code(error.status).send({ error: error.code });
      throw error;
    }
  });
  app.post("/:matchId/commands", async (request, reply) => {
    const params = z.object({ matchId: id }).safeParse(request.params);
    const parsed = command.safeParse(request.body);
    if (!params.success || !parsed.success) return reply.code(400).send({ error: "INVALID_REQUEST" });
    try {
      const result = await verifiedAiGameService.command(request.user.sub, params.data.matchId, parsed.data);
      if (result && "error" in result) reply.code(409);
      return result;
    } catch (error) {
      if (error instanceof VerifiedAiError) return reply.code(error.status).send({ error: error.code });
      throw error;
    }
  });
}
