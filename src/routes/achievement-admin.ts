import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { authenticateStaff, requireStaffMutation } from "../auth/staff.js";
import {
  achievementMetrics, createAchievement, listAdminAchievements, updateAchievementDetails
} from "../services/achievement-service.js";

const id = z.string().regex(/^[a-z][a-z0-9_]{2,63}$/);
const details = z.object({
  name: z.string().trim().min(1).max(80),
  description: z.string().trim().min(1).max(300),
  category: z.string().trim().min(1).max(50),
  badgeKey: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/),
  enabled: z.boolean()
}).strict();
const create = details.extend({
  id,
  metric: z.enum(achievementMetrics),
  target: z.number().int().min(1).max(100000)
});

export async function achievementAdminRoutes(app: FastifyInstance) {
  app.addHook("onRequest", authenticateStaff);
  app.addHook("onSend", async (_request, reply) => { reply.header("Cache-Control", "no-store"); });
  app.get("/api/achievements", async () => listAdminAchievements());
  app.post("/api/achievements", { preHandler: requireStaffMutation }, async (request, reply) => {
    const parsed = create.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "INVALID_REQUEST", details: parsed.error.flatten() });
    if (!(await createAchievement(parsed.data))) return reply.code(409).send({ error: "ID_ALREADY_EXISTS" });
    return reply.code(201).send({ id: parsed.data.id });
  });
  app.patch("/api/achievements/:id", { preHandler: requireStaffMutation }, async (request, reply) => {
    const path = z.object({ id }).safeParse(request.params);
    const parsed = details.safeParse(request.body);
    if (!path.success || !parsed.success) return reply.code(400).send({ error: "INVALID_REQUEST" });
    if (!(await updateAchievementDetails(path.data.id, parsed.data))) return reply.code(404).send({ error: "NOT_FOUND" });
    return { id: path.data.id };
  });
}
