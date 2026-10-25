import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { authenticate } from "../auth/authenticate.js";
import { matchmakingService, MATCHMAKING_RULES_VERSION, TicketNotFoundError, LobbyNotReadyError } from "../services/matchmaking-service.js";

const joinSchema = z.object({
  requestId: z.string().uuid(),
  rulesVersion: z.literal(MATCHMAKING_RULES_VERSION),
}).strict();
const paramsSchema = z.object({ ticketId: z.string().uuid() });

export async function matchmakingRoutes(app: FastifyInstance) {
  app.addHook("onRequest", authenticate);
  app.addHook("onSend", async (_request, reply) => { reply.header("Cache-Control", "no-store"); });

  app.post("/tickets", async (request, reply) => {
    const body = joinSchema.safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: "INVALID_REQUEST" });
    return matchmakingService.join(request.user.sub, body.data.requestId);
  });

  app.get("/tickets/current", async request => ({
    ticket: await matchmakingService.current(request.user.sub),
  }));

  app.post("/tickets/:ticketId/ready", async (request, reply) => {
    const params = paramsSchema.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: "INVALID_REQUEST" });
    try {
      return await matchmakingService.ready(request.user.sub, params.data.ticketId);
    } catch (error) {
      if (error instanceof TicketNotFoundError) return reply.code(404).send({ error: "TICKET_NOT_FOUND" });
      if (error instanceof LobbyNotReadyError) return reply.code(409).send({ error: "LOBBY_NOT_READY" });
      throw error;
    }
  });

  app.delete("/requests/:requestId", async (request, reply) => {
    const params = z.object({ requestId: z.string().uuid() }).safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: "INVALID_REQUEST" });
    return matchmakingService.cancelRequest(request.user.sub, params.data.requestId);
  });

  for (const method of ["POST", "DELETE"] as const) {
    app.route({
      method, url: method === "POST" ? "/tickets/:ticketId/heartbeat" : "/tickets/:ticketId",
      handler: async (request, reply) => {
        const params = paramsSchema.safeParse(request.params);
        if (!params.success) return reply.code(400).send({ error: "INVALID_REQUEST" });
        try {
          return method === "POST"
            ? await matchmakingService.heartbeat(request.user.sub, params.data.ticketId)
            : await matchmakingService.cancel(request.user.sub, params.data.ticketId);
        } catch (error) {
          if (error instanceof TicketNotFoundError) return reply.code(404).send({ error: "TICKET_NOT_FOUND" });
          throw error;
        }
      },
    });
  }
}
