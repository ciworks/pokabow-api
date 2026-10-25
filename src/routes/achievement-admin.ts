import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { readFile } from "node:fs/promises";
import { z } from "zod";
import { authenticate } from "../auth/authenticate.js";
import { findUserById } from "../repositories/user-repository.js";
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

async function authorizeAdmin(request: FastifyRequest, reply: FastifyReply) {
  await authenticate(request, reply);
  if (reply.sent) return;
  const allowed = (process.env.ADMIN_EMAILS ?? "").split(",")
    .map(value => value.trim().toLowerCase()).filter(Boolean);
  const user = await findUserById(request.user.sub);
  if (!user?.email || !allowed.includes(user.email.toLowerCase())) {
    return reply.code(403).send({ error: "ADMIN_REQUIRED" });
  }
}

export async function achievementAdminRoutes(app: FastifyInstance) {
  // The document is public; every catalogue read and write below requires an
  // authenticated account in ADMIN_EMAILS. The page never connects to Postgres.
  app.get("/achievements", async (_request, reply) => {
    const html = await readFile(new URL("../../admin/achievements.html", import.meta.url), "utf8");
    return reply.type("text/html; charset=utf-8").send(html);
  });
  app.get("/fredoka.ttf", async (_request, reply) => {
    const font = await readFile(new URL("../../admin/Fredoka-Variable.ttf", import.meta.url));
    return reply.type("font/ttf").send(font);
  });
  app.get("/api/achievements", { onRequest: authorizeAdmin }, async () => listAdminAchievements());
  app.post("/api/achievements", { onRequest: authorizeAdmin }, async (request, reply) => {
    const parsed = create.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "INVALID_REQUEST", details: parsed.error.flatten() });
    if (!(await createAchievement(parsed.data))) return reply.code(409).send({ error: "ID_ALREADY_EXISTS" });
    return reply.code(201).send({ id: parsed.data.id });
  });
  app.patch("/api/achievements/:id", { onRequest: authorizeAdmin }, async (request, reply) => {
    const path = z.object({ id }).safeParse(request.params);
    const parsed = details.safeParse(request.body);
    if (!path.success || !parsed.success) return reply.code(400).send({ error: "INVALID_REQUEST" });
    if (!(await updateAchievementDetails(path.data.id, parsed.data))) return reply.code(404).send({ error: "NOT_FOUND" });
    return { id: path.data.id };
  });
}
