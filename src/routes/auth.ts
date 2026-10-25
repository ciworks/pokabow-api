import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { authenticate, verifyIdentity } from "../auth/authenticate.js";
import { hashPassword, verifyPassword } from "../auth/password.js";
import { createUser, findUserByEmail, findUserById, updateUserDisplayName, deleteUser } from "../repositories/user-repository.js";
import { googleOAuthRoutes } from "./google-oauth.js";

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
    return { id: user.id, email: user.email, displayName: user.display_name };
  });

  app.get("/me", { onRequest: authenticate }, async (request, reply) => {
    const user = await findUserById(request.user.sub);
    if (!user) {
      return reply.code(401).send({ error: "UNAUTHORIZED" });
    }
    return { id: user.id, email: user.email, displayName: user.display_name };
  });
}

function isUniqueViolation(error: unknown): error is { code: string } {
  return typeof error === "object" && error !== null && "code" in error && error.code === "23505";
}
