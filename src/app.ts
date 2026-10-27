import Fastify from "fastify";
import cors from "@fastify/cors";
import jwt from "@fastify/jwt";

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
import { config } from "./config.js";

export function buildApp() {
  if (!config.jwtSecret || Buffer.byteLength(config.jwtSecret) < 32) {
    throw new Error("JWT_SECRET must be set to at least 32 bytes");
  }

  const app = Fastify({
    logger: true
  });

  app.register(cors, {
    origin: true
  });

  app.register(jwt, {
    secret: config.jwtSecret,
    sign: { algorithm: "HS256", expiresIn: "1h" },
    verify: { algorithms: ["HS256"] }
  });

  app.get("/health", async () => ({
    status: "ok"
  }));

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
  app.register(onlineGameRoutes, { prefix: "/online-games" });
  app.register(progressionRoutes, { prefix: "/progression" });
  app.register(gemRoutes, { prefix: "/gems" });
  app.register(verifiedAiGameRoutes, { prefix: "/ai-games" });
  app.register(aiRivalRoutes, { prefix: "/ai-rivals" });

  return app;
}
