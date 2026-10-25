import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { authenticate } from "../auth/authenticate.js";
import {
  clientProgressMetrics, listAchievements, recordProgressEvents, unlockAchievements
} from "../services/achievement-service.js";
import { checkIn } from "../services/engagement-service.js";

const unlockSchema = z.object({
  achievementIds: z.array(z.string().min(1).max(64)).min(1).max(5)
});
const progressSchema = z.object({
  events: z.array(z.object({
    eventId: z.string().min(1).max(256),
    metric: z.enum(clientProgressMetrics)
  }).strict()).min(1).max(50)
}).strict();

export async function achievementRoutes(app: FastifyInstance) {
  app.addHook("onRequest", authenticate);

  app.get("/", async request => listAchievements(request.user.sub));

  app.post("/check-in", async request => checkIn(request.user.sub));

  app.post("/unlocks", async (request, reply) => {
    const parsed = unlockSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "INVALID_REQUEST", details: parsed.error.flatten() });
    }
    const result = await unlockAchievements(request.user.sub, parsed.data.achievementIds);
    if ("error" in result) return reply.code(400).send(result);
    return result;
  });

  app.post("/progress", async (request, reply) => {
    const parsed = progressSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "INVALID_REQUEST", details: parsed.error.flatten() });
    }
    const eventIds = parsed.data.events.map(event => event.eventId);
    if (new Set(eventIds).size !== eventIds.length) {
      return reply.code(400).send({ error: "DUPLICATE_EVENT_ID" });
    }
    return recordProgressEvents(request.user.sub, parsed.data.events);
  });
}
