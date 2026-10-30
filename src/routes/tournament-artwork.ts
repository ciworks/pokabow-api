import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireStaffMutation } from "../auth/staff.js";
import { TournamentError } from "../services/tournament-core.js";
import { findTournamentArtwork, MAX_ARTWORK_BASE64_LENGTH, normalizeTournamentArtwork,
  saveTournamentArtwork } from "../services/tournament-artwork.js";

const paramsSchema = z.object({ tournamentId: z.string().uuid(), kind: z.enum(["badge", "background"]) });
const uploadSchema = z.object({ contentType: z.enum(["image/png", "image/jpeg"]), data: z.string().min(1) }).strict();

/** Called inside the existing player/staff plugins, inheriting their auth and cache hooks. */
export function registerTournamentArtworkRoutes(app: FastifyInstance, admin: boolean) {
  const path = "/:tournamentId/artwork/:kind";
  app.get(path, async (request, reply) => {
    const params = paramsSchema.safeParse(request.params);
    const query = z.object({ v: z.string().regex(/^[a-f0-9]{64}$/).optional() }).strict().safeParse(request.query);
    if (!params.success || !query.success) return reply.code(400).send({ error: "INVALID_REQUEST" });
    try {
      const png = await findTournamentArtwork(params.data.tournamentId, params.data.kind, admin, query.data.v);
      return reply.type("image/png").header("X-Content-Type-Options", "nosniff").send(png);
    } catch (error) {
      if (error instanceof TournamentError) return reply.code(error.status).send({ error: error.code });
      throw error;
    }
  });
  if (!admin) return;
  app.put(path, { preHandler: requireStaffMutation, bodyLimit: MAX_ARTWORK_BASE64_LENGTH + 1024 },
    async (request, reply) => {
      const params = paramsSchema.safeParse(request.params);
      const body = uploadSchema.safeParse(request.body);
      if (!params.success || !body.success) return reply.code(400).send({ error: "INVALID_REQUEST" });
      try {
        const image = await normalizeTournamentArtwork(body.data.data, body.data.contentType, params.data.kind);
        return await saveTournamentArtwork(request.staff!.id, params.data.tournamentId, params.data.kind, image);
      } catch (error) {
        if (error instanceof TournamentError) return reply.code(error.status).send({ error: error.code });
        throw error;
      }
    });
  app.delete(path, { preHandler: requireStaffMutation }, async (request, reply) => {
    const params = paramsSchema.safeParse(request.params);
    if (!params.success || request.body != null && !z.object({}).strict().safeParse(request.body).success)
      return reply.code(400).send({ error: "INVALID_REQUEST" });
    try { return await saveTournamentArtwork(request.staff!.id, params.data.tournamentId, params.data.kind, null); }
    catch (error) {
      if (error instanceof TournamentError) return reply.code(error.status).send({ error: error.code });
      throw error;
    }
  });
}
