import type { FastifyInstance } from "fastify";
import { listAiRivals } from "../services/ai-rivals.js";

export async function aiRivalRoutes(app: FastifyInstance) {
  app.get("/", async (_request, reply) => {
    reply.header("Cache-Control", "no-store");
    return { rivals: await listAiRivals() };
  });
}
