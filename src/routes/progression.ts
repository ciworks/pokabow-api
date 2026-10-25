import type { FastifyInstance } from "fastify";
import { authenticate } from "../auth/authenticate.js";
import { readProgression } from "../services/player-progression.js";

export async function progressionRoutes(app: FastifyInstance) {
  app.addHook("onRequest", authenticate);
  app.addHook("onSend", async (_request, reply) => { reply.header("Cache-Control", "no-store"); });
  app.get("/me", async (request, reply) => {
    const progression = await readProgression(request.user.sub);
    return progression ?? reply.code(404).send({ error: "USER_NOT_FOUND" });
  });
}
