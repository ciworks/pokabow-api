import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { config } from "../config.js";
import { findOrCreateGoogleUser } from "../repositories/user-repository.js";

const cookieName = "tiletopia_google_oauth";
const cookiePath = "/auth/google/callback";

export async function googleOAuthRoutes(app: FastifyInstance) {
  app.get("/google", async (_request, reply) => {
    if (!googleConfigured()) return reply.code(503).send({ error: "OAUTH_NOT_CONFIGURED" });

    const state = randomBytes(32).toString("base64url");
    const verifier = randomBytes(32).toString("base64url");
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    reply.header("cache-control", "no-store");
    reply.header("set-cookie", `${cookieName}=${state}.${verifier}; Path=${cookiePath}; HttpOnly; SameSite=Lax; Max-Age=600${secureCookie() ? "; Secure" : ""}`);
    const authorization = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    authorization.search = new URLSearchParams({
      client_id: config.googleClientId!,
      redirect_uri: config.googleRedirectUri!,
      response_type: "code",
      scope: "openid email profile",
      state,
      code_challenge: challenge,
      code_challenge_method: "S256",
      prompt: "select_account"
    }).toString();
    return reply.redirect(authorization.toString());
  });

  app.get<{ Querystring: { code?: string; state?: string; error?: string } }>("/google/callback", async (request, reply) => {
    const cookie = readCookie(request.headers.cookie, cookieName);
    reply.header("set-cookie", `${cookieName}=; Path=${cookiePath}; HttpOnly; SameSite=Lax; Max-Age=0${secureCookie() ? "; Secure" : ""}`);
    reply.header("cache-control", "no-store");
    if (!googleConfigured()) return reply.code(503).send({ error: "OAUTH_NOT_CONFIGURED" });
    if (request.query.error) return reply.code(401).send({ error: "OAUTH_DENIED" });
    if (!request.query.code || !request.query.state || !cookie) {
      return reply.code(400).send({ error: "INVALID_OAUTH_CALLBACK" });
    }

    const [expectedState, verifier] = cookie.split(".");
    if (!expectedState || !verifier || !constantTimeEqual(expectedState, request.query.state)) {
      return reply.code(400).send({ error: "INVALID_OAUTH_STATE" });
    }

    try {
      const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          code: request.query.code,
          client_id: config.googleClientId!,
          client_secret: config.googleClientSecret!,
          redirect_uri: config.googleRedirectUri!,
          grant_type: "authorization_code",
          code_verifier: verifier
        }),
        signal: AbortSignal.timeout(10_000)
      });
      if (!tokenResponse.ok) return reply.code(401).send({ error: "OAUTH_EXCHANGE_FAILED" });
      const tokens = await tokenResponse.json() as { access_token?: string; token_type?: string };
      if (!tokens.access_token || tokens.token_type?.toLowerCase() !== "bearer") {
        return reply.code(401).send({ error: "OAUTH_EXCHANGE_FAILED" });
      }

      const profileResponse = await fetch("https://openidconnect.googleapis.com/v1/userinfo", {
        headers: { authorization: `Bearer ${tokens.access_token}` },
        signal: AbortSignal.timeout(10_000)
      });
      if (!profileResponse.ok) return reply.code(401).send({ error: "OAUTH_PROFILE_FAILED" });
      const profile = await profileResponse.json() as {
        sub?: string; email?: string; email_verified?: boolean; name?: string;
      };
      if (!profile.sub || !profile.email || profile.email_verified !== true) {
        return reply.code(401).send({ error: "OAUTH_EMAIL_NOT_VERIFIED" });
      }

      const result = await findOrCreateGoogleUser(profile.sub, profile.email.toLowerCase(), profile.name?.trim() || profile.email);
      if (result.emailInUse || !result.user) return reply.code(409).send({ error: "EMAIL_IN_USE" });
      const user = result.user;
      return {
        token: app.jwt.sign({ sub: user.id }),
        user: { id: user.id, email: user.email, displayName: user.display_name }
      };
    } catch (error) {
      request.log.error({ err: error }, "Google OAuth callback failed");
      return reply.code(502).send({ error: "OAUTH_PROVIDER_UNAVAILABLE" });
    }
  });
}

function googleConfigured() {
  return Boolean(config.googleClientId && config.googleClientSecret && config.googleRedirectUri);
}

function secureCookie() {
  return config.googleRedirectUri?.startsWith("https://") ?? false;
}

function readCookie(header: string | undefined, name: string) {
  const entry = header?.split(";").map(part => part.trim()).find(part => part.startsWith(`${name}=`));
  return entry ? entry.slice(name.length + 1) : undefined;
}

function constantTimeEqual(left: string, right: string) {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}
