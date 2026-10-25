import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { authenticate } from "../auth/authenticate.js";
import { onlineGameService, OnlineError } from "../services/online-game-service.js";

const placement = z.object({
  tileId: z.string().min(1).max(200), x: z.number().int().min(0).max(11),
  y: z.number().int().min(0).max(11), rotation: z.number().int().min(0).max(3),
}).strict();
const common = { commandId: z.string().uuid(), expectedVersion: z.number().int().min(1) };
const commandSchema = z.discriminatedUnion("action", [
  z.object({ ...common, action: z.literal("place"), placements: z.array(placement).min(1).max(10) }).strict(),
  z.object({ ...common, action: z.literal("swap"), tileIds: z.array(z.string().min(1).max(200)).min(1).max(10) }).strict(),
  z.object({ ...common, action: z.literal("resign") }).strict(),
]);
export async function onlineGameRoutes(app: FastifyInstance) {
  app.addHook("onRequest", authenticate);
  app.addHook("onSend", async (_request, reply) => { reply.header("Cache-Control", "no-store"); });
  app.get("/current", async request => ({ match: await onlineGameService.current(request.user.sub) }));
  for (const method of ["GET", "POST"] as const) {
    app.route({ method, url: method === "GET" ? "/:matchId" : "/:matchId/commands",
      handler: async (request, reply) => {
        const params = z.object({ matchId: z.string().uuid() }).safeParse(request.params);
        if (!params.success) return reply.code(400).send({ error: "INVALID_REQUEST" });
        const command = method === "POST" ? commandSchema.safeParse(request.body) : null;
        if (command && !command.success) return reply.code(400).send({ error: "INVALID_REQUEST" });
        try {
          const result = command?.success
            ? await onlineGameService.command(request.user.sub, params.data.matchId, command.data)
            : await onlineGameService.get(request.user.sub, params.data.matchId);
          if (result && "error" in result) reply.code(409);
          return result;
        } catch (error) {
          if (error instanceof OnlineError) return reply.code(error.status).send({ error: error.code });
          throw error;
        }
      },
    });
  }
}
