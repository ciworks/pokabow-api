import Fastify from "fastify";
import cors from "@fastify/cors";
import jwt from "@fastify/jwt";
import cookie from "@fastify/cookie";
import rateLimit from "@fastify/rate-limit";

import { gameRoutes } from "./routes/games.js";
import { authRoutes } from "./routes/auth.js";
import { avatarRoutes } from "./routes/avatars.js";
import { achievementRoutes } from "./routes/achievements.js";
import { achievementAdminRoutes } from "./routes/achievement-admin.js";
import { matchmakingRoutes } from "./routes/matchmaking.js";
import { onlineGameRoutes } from "./routes/online-games.js";
import { progressionRoutes } from "./routes/progression.js";
import { gemRoutes } from "./routes/gems.js";
import { verifiedAiGameRoutes } from "./routes/verified-ai-games.js";
import { aiRivalRoutes } from "./routes/ai-rivals.js";
import { tournamentRoutes } from "./routes/tournaments.js";
import { tournamentAdminRoutes } from "./routes/tournament-admin.js";
import { staffAuthRoutes } from "./routes/staff-auth.js";
import { supportAdminRoutes } from "./routes/support-admin.js";
import { config } from "./config.js";
import { db } from "./db.js";

export function buildApp() {
  if (!config.jwtSecret || Buffer.byteLength(config.jwtSecret) < 32) {
    throw new Error("JWT_SECRET must be set to at least 32 bytes");
  }
  if (process.env.NODE_ENV === "production" &&
      (!/^https:\/\//.test(process.env.STAFF_ORIGIN ?? "") ||
       !/^[0-9a-f]{64}$/i.test(process.env.STAFF_ENCRYPTION_KEY ?? ""))) {
    throw new Error("Production staff administration requires HTTPS STAFF_ORIGIN and a 32-byte STAFF_ENCRYPTION_KEY");
  }

  const app = Fastify({
    logger: true
  });

  app.register(cors, {
    origin: true
  });
  app.register(cookie);
  app.register(rateLimit, { global: false });

  app.register(jwt, {
    secret: config.jwtSecret,
    sign: { algorithm: "HS256", expiresIn: "1h" },
    verify: { algorithms: ["HS256"] }
  });

  app.get("/health", async () => ({
    status: "ok"
  }));
  app.get("/health/ready", async (_request, reply) => {
    try {
      await db.query("SELECT 1");
      return reply.header("Cache-Control", "no-store").send({ status: "ok" });
    } catch {
      return reply.code(503).header("Cache-Control", "no-store")
        .send({ status: "unavailable" });
    }
  });

  app.register(gameRoutes, {
    prefix: "/games"
  });

  app.register(authRoutes, {
    prefix: "/auth"
  });
  app.register(avatarRoutes, { prefix: "/auth" });

  app.register(achievementAdminRoutes, { prefix: "/admin" });

  app.register(achievementRoutes, {
    prefix: "/achievements"
  });

  app.register(matchmakingRoutes, { prefix: "/matchmaking" });
  app.register(onlineGameRoutes, { prefix: "/online-games" });
  app.register(progressionRoutes, { prefix: "/progression" });
  app.register(gemRoutes, { prefix: "/gems" });
  app.register(verifiedAiGameRoutes, { prefix: "/ai-games" });
  app.register(aiRivalRoutes, { prefix: "/ai-rivals" });
  app.register(tournamentRoutes, { prefix: "/tournaments" });
  app.register(staffAuthRoutes, { prefix: "/admin/api/auth" });
  app.register(tournamentAdminRoutes, { prefix: "/admin/api/tournaments" });
  app.register(supportAdminRoutes, { prefix: "/admin/api" });

  return app;
}

