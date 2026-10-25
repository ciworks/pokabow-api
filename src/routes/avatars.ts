import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { authenticate } from "../auth/authenticate.js";
import { db } from "../db.js";
import { deleteAvatar, findAvatar, saveAvatar } from "../repositories/avatar-repository.js";
import { AVATAR_SIZE, AvatarValidationError, MAX_AVATAR_BASE64_LENGTH, normalizeAvatar } from "../services/avatar-service.js";

const uploadSchema = z.object({
  contentType: z.enum(["image/png", "image/jpeg"]),
  data: z.string().min(1)
}).strict();

export async function avatarRoutes(app: FastifyInstance) {
  app.addHook("onRequest", authenticate);
  app.addHook("onRequest", async (_request, reply) => {
    reply.header("Cache-Control", "private, no-store");
  });

  app.put("/me/avatar", { bodyLimit: MAX_AVATAR_BASE64_LENGTH + 1024 }, async (request, reply) => {
    const parsed = uploadSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "INVALID_REQUEST" });

    let png: Buffer;
    try {
      png = await normalizeAvatar(parsed.data.data, parsed.data.contentType);
    } catch (error) {
      if (error instanceof AvatarValidationError) {
        return reply.code(error.statusCode).send({ error: error.code });
      }
      throw error;
    }
    const saved = await saveAvatar(request.user.sub, png);
    if (!saved) return reply.code(401).send({ error: "UNAUTHORIZED" });
    return {
      avatar: { url: "/auth/me/avatar", contentType: "image/png", width: AVATAR_SIZE,
        height: AVATAR_SIZE, updatedAt: saved.updated_at.toISOString() }
    };
  });

  app.get("/me/avatar", async (request, reply) => {
    const avatar = await findAvatar(request.user.sub);
    if (!avatar) return reply.code(404).send({ error: "AVATAR_NOT_FOUND" });
    return reply.type("image/png").header("X-Content-Type-Options", "nosniff").send(avatar.png);
  });

  app.get("/opponents/:userId/avatar", async (request, reply) => {
    const params = z.object({ userId: z.string().uuid() }).safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: "INVALID_REQUEST" });
    const opponentId = params.data.userId;
    const allowed = await db.query(`SELECT 1 FROM matchmaking_tickets mine
      JOIN matchmaking_tickets theirs ON theirs.lobby_id = mine.lobby_id
      WHERE mine.user_id = $1 AND theirs.user_id = $2
        AND mine.user_id <> theirs.user_id
        AND mine.status = 'matched' AND theirs.status = 'matched'
        AND mine.expires_at > clock_timestamp() AND theirs.expires_at > clock_timestamp()
      UNION ALL
      SELECT 1 FROM online_matches m WHERE m.status = 'active'
        AND ((m.player_a = $1 AND m.player_b = $2) OR (m.player_b = $1 AND m.player_a = $2))
      LIMIT 1`, [request.user.sub, opponentId]);
    if (allowed.rows.length === 0) return reply.code(404).send({ error: "AVATAR_NOT_FOUND" });
    const avatar = await findAvatar(opponentId);
    if (!avatar) return reply.code(404).send({ error: "AVATAR_NOT_FOUND" });
    return reply.type("image/png").header("X-Content-Type-Options", "nosniff").send(avatar.png);
  });

  app.delete("/me/avatar", async (request, reply) => {
    await deleteAvatar(request.user.sub);
    return reply.code(204).send();
  });
}
