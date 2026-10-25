import type { FastifyInstance } from "fastify";
import { authenticate } from "../auth/authenticate.js";
import { readGemWallet } from "../services/gem-wallet.js";
import { config } from "../config.js";
import { rewardedAdStatus, settleRewardedAd, startRewardedAd,
  verifyRewardedAdCallback } from "../services/rewarded-ad.js";

export async function gemRoutes(app: FastifyInstance) {
  app.addHook("onSend", async (_request, reply) => { reply.header("Cache-Control", "no-store"); });
  app.get("/me", { onRequest: authenticate }, async (request, reply) => {
    const wallet = await readGemWallet(request.user.sub);
    return wallet ?? reply.code(404).send({ error: "USER_NOT_FOUND" });
  });
  app.get("/rewarded-ad/status", { onRequest: authenticate }, async request =>
    rewardedAdStatus(request.user.sub));
  app.post("/rewarded-ad/session", { onRequest: authenticate }, async (request, reply) => {
    if (!config.admobRewardedAdUnits.length) return reply.code(503).send({ error: "AD_UNAVAILABLE" });
    const session = await startRewardedAd(request.user.sub);
    if (!session) return reply.code(404).send({ error: "USER_NOT_FOUND" });
    return session.available ? session : reply.code(429).send(session);
  });
  app.get("/rewarded-ad/callback", async (request, reply) => {
    const verified = await verifyRewardedAdCallback(request.raw.url ?? "");
    if (!verified.valid) return reply.code(400).send({ error: "INVALID_AD_CALLBACK" });
    await settleRewardedAd(verified);
    return { ok: true };
  });
}
