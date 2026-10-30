import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { authenticateStaff, loginStaff, logoutStaff, requireStaffCsrf, staffCsrf, staffOriginAllowed } from "../auth/staff.js";
import { db } from "../db.js";

const login = z.object({ email: z.email().max(254), password: z.string().min(1).max(128),
  totp: z.string().regex(/^(\d{6}|[a-fA-F0-9]{16})$/) }).strict();

export async function staffAuthRoutes(app: FastifyInstance) {
  app.addHook("onSend", async (_request, reply) => { reply.header("Cache-Control", "no-store"); });
  app.post("/login", { config: { rateLimit: { max: 5, timeWindow: "1 minute" } } }, async (request, reply) => {
    if (!staffOriginAllowed(request)) return reply.code(403).send({ error: "STAFF_ORIGIN_REQUIRED" });
    const parsed = login.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "INVALID_REQUEST" });
    const session = await loginStaff(parsed.data.email, parsed.data.password, parsed.data.totp, reply);
    if (!session) {
      await db.query(`INSERT INTO staff_audit (action,target_type,target_id)
        VALUES ('login_failed','staff_email',$1)`, [parsed.data.email.toLowerCase()]);
      return reply.code(401).send({ error: "INVALID_CREDENTIALS" });
    }
    return session;
  });
  app.get("/me", { onRequest: authenticateStaff }, async request => ({
    staff: request.staff, csrfToken: staffCsrf(request.staffToken!)
  }));
  app.post("/logout", { onRequest: authenticateStaff, preHandler: requireStaffCsrf }, async (request, reply) => {
    await logoutStaff(request.staffToken!, reply);
    return reply.code(204).send();
  });
}
