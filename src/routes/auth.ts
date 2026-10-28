import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { authenticate, verifyIdentity } from "../auth/authenticate.js";
import { hashPassword, verifyPassword } from "../auth/password.js";
import { createUser, findUserByEmail, findUserById, updateUserDisplayName, deleteUser } from "../repositories/user-repository.js";
import { googleOAuthRoutes } from "./google-oauth.js";
import { randomBytes } from "node:crypto";
import { db } from "../db.js";
import { issueSession, refreshSession, revokeSession } from "../auth/device-sessions.js";
import { confirmChallenge, sendChallenge } from "../auth/email-challenges.js";

const email = z.email().max(254).transform(value => value.toLowerCase());
const password = z.string().min(12).max(128);
const registerSchema = z.object({
  email,
  password,
  displayName: z.string().trim().min(1).max(50)
});
const loginSchema = z.object({ email, password: z.string() });

export async function authRoutes(app: FastifyInstance) {
  await app.register(googleOAuthRoutes);
  app.post("/provisional", async (_request, reply) => {
    for (let attempt = 0; attempt < 3; attempt++) {
      const suffix = randomBytes(16).toString("hex");
      const placeholder = `player-${suffix}@tiletopia.com`;
      const displayName = `Player_${suffix.slice(0, 9)}`;
      try {
        const result = await db.query<{
          id: string; email: string; display_name: string; email_verified: boolean;
        }>(
          `INSERT INTO users (email, display_name, email_verified)
           VALUES ($1, $2, false)
           RETURNING id, email, display_name, email_verified`,
          [placeholder, displayName]
        );
        return reply.code(201).header("Cache-Control", "no-store")
          .send(await issueSession(app, result.rows[0]));
      } catch (error) {
        if (!isUniqueViolation(error)) throw error;
      }
    }
    return reply.code(503).send({ error: "ACCOUNT_CREATION_UNAVAILABLE" });
  });

  const tokenBody = z.object({ refreshToken: z.string().min(40).max(200) }).strict();
  app.post("/refresh", async (request, reply) => {
    const parsed = tokenBody.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "INVALID_REQUEST" });
    const session = await refreshSession(app, parsed.data.refreshToken);
    if (!session) return reply.code(401).send({ error: "INVALID_SESSION" });
    return reply.header("Cache-Control", "no-store").send(session);
  });

  app.post("/logout", async (request, reply) => {
    const parsed = tokenBody.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "INVALID_REQUEST" });
    await revokeSession(parsed.data.refreshToken);
    return reply.code(204).send();
  });

  const emailBody = z.object({ email }).strict();
  const confirmBody = z.object({ email, code: z.string().min(16).max(16) }).strict();
  app.post("/email/change/request", { onRequest: authenticate }, async (request, reply) => {
    const parsed = emailBody.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "INVALID_REQUEST" });
    if (await findUserByEmail(parsed.data.email)) {
      return reply.code(409).send({ error: "EMAIL_IN_USE" });
    }
    try {
      await sendChallenge(request.user.sub, parsed.data.email, "verify");
    } catch (error) {
      request.log.error(error);
      return reply.code(503).send({ error: "EMAIL_UNAVAILABLE" });
    }
    return reply.code(202).send({ status: "check_email" });
  });

  app.post("/email/change/confirm", async (request, reply) => {
    const parsed = confirmBody.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "INVALID_REQUEST" });
    try {
      const user = await confirmChallenge(parsed.data.email, parsed.data.code, "verify");
      if (!user) return reply.code(400).send({ error: "INVALID_CODE" });
      return { user: { id: user.id, email: user.email, displayName: user.display_name, emailVerified: true } };
    } catch (error) {
      if (isUniqueViolation(error)) return reply.code(409).send({ error: "EMAIL_IN_USE" });
      throw error;
    }
  });

  app.post("/email/sign-in/request", async (request, reply) => {
    const parsed = emailBody.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "INVALID_REQUEST" });
    if (!process.env.AUTH_EMAIL_WEBHOOK_URL || !process.env.AUTH_EMAIL_WEBHOOK_KEY) {
      return reply.code(503).send({ error: "EMAIL_UNAVAILABLE" });
    }
    const user = await findUserByEmail(parsed.data.email);
    if (user?.email_verified) {
      void sendChallenge(user.id, parsed.data.email, "sign_in")
        .catch(error => request.log.error(error));
    }
    return reply.code(202).send({ status: "check_email" });
  });

  app.post("/email/sign-in/confirm", async (request, reply) => {
    const parsed = confirmBody.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "INVALID_REQUEST" });
    const user = await confirmChallenge(parsed.data.email, parsed.data.code, "sign_in");
    if (!user) return reply.code(400).send({ error: "INVALID_CODE" });
    return reply.header("Cache-Control", "no-store").send(await issueSession(app, user));
  });
  app.post("/register", async (request, reply) => {
    const parsed = registerSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "INVALID_REQUEST", details: parsed.error.flatten() });
    }

    const { email, password, displayName } = parsed.data;
    const passwordHash = await hashPassword(password);
    try {
      const user = await createUser(email, displayName, passwordHash);
      const token = app.jwt.sign({ sub: user.id });
      return reply.code(201).send({
        token,
        user: { id: user.id, email: user.email, displayName: user.display_name }
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        return reply.code(409).send({ error: "EMAIL_IN_USE" });
      }
      throw error;
    }
  });

  app.post("/login", async (request, reply) => {
    const parsed = loginSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "INVALID_REQUEST", details: parsed.error.flatten() });
    }

    const user = await findUserByEmail(parsed.data.email);
    if (!user?.password_hash || !(await verifyPassword(parsed.data.password, user.password_hash))) {
      return reply.code(401).send({ error: "INVALID_CREDENTIALS" });
    }

    const token = app.jwt.sign({ sub: user.id });
    return { token, user: { id: user.id, email: user.email, displayName: user.display_name } };
  });

  // Signature verification permits an idempotent retry after a lost success
  // response. All other routes require the account to still exist.
  app.delete("/me", { onRequest: verifyIdentity }, async (request, reply) => {
    if (!z.object({ confirm: z.literal(true) }).strict().safeParse(request.body).success) {
      return reply.code(400).send({ error: "CONFIRMATION_REQUIRED" });
    }
    await deleteUser(request.user.sub);
    return { success: true };
  });

  app.patch("/me", { onRequest: authenticate }, async (request, reply) => {
    const parsed = z.object({ displayName: z.string().trim().min(1).max(50) }).strict().safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "INVALID_REQUEST", details: parsed.error.flatten() });
    }
    const user = await updateUserDisplayName(request.user.sub, parsed.data.displayName);
    if (!user) {
      const account = await findUserById(request.user.sub);
      return account
        ? reply.code(409).send({ error: "USERNAME_TAKEN" })
        : reply.code(401).send({ error: "UNAUTHORIZED" });
    }
    return { id: user.id, email: user.email, displayName: user.display_name, emailVerified: user.email_verified };
  });

  app.get("/me", { onRequest: authenticate }, async (request, reply) => {
    const user = await findUserById(request.user.sub);
    if (!user) {
      return reply.code(401).send({ error: "UNAUTHORIZED" });
    }
    return { id: user.id, email: user.email, displayName: user.display_name, emailVerified: user.email_verified };
  });
}

function isUniqueViolation(error: unknown): error is { code: string } {
  return typeof error === "object" && error !== null && "code" in error && error.code === "23505";
}
