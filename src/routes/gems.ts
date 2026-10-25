import type { FastifyInstance } from "fastify";
import { authenticate } from "../auth/authenticate.js";
import { readGemWallet } from "../services/gem-wallet.js";

export async function gemRoutes(app: FastifyInstance) {
  app.addHook("onRequest", authenticate);
  app.addHook("onSend", async (_request, reply) => { reply.header("Cache-Control", "no-store"); });
  app.get("/me", async (request, reply) => {
    const wallet = await readGemWallet(request.user.sub);
    return wallet ?? reply.code(404).send({ error: "USER_NOT_FOUND" });
  });
}
