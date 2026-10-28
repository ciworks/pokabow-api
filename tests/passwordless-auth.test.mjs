import { test } from "node:test";
import assert from "node:assert/strict";

process.env.JWT_SECRET = "test-secret-with-at-least-thirty-two-bytes";
const { buildApp } = await import("../dist/app.js");
const { db } = await import("../dist/db.js");

test("provisional session rotates, rejects replay, and blocks its access token", async () => {
  const app = buildApp();
  await app.ready();
  const originalQuery = db.query;
  const originalConnect = db.connect;
  const user = {
    id: "11111111-1111-4111-8111-111111111111",
    email: "player-test@tiletopia.com", display_name: "Player_test", email_verified: false
  };
  let session;
  db.query = async (sql, params = []) => {
    if (sql.includes("INSERT INTO users")) return { rows: [{ ...user, email: params[0], display_name: params[1] }] };
    if (sql.includes("INSERT INTO auth_sessions")) {
      session = { id: params[0], user_id: user.id, refresh_token_hash: params[2], expires_at: new Date(Date.now() + 86400000), revoked_at: null };
      return { rowCount: 1 };
    }
    if (sql.includes("SELECT 1 FROM auth_sessions")) return { rowCount: session?.revoked_at ? 0 : 1 };
    if (sql.includes("UPDATE auth_sessions SET revoked_at")) {
      if (params[0] === session.id) session.revoked_at = new Date();
      return { rowCount: 1 };
    }
    if (sql.includes("FROM users WHERE id")) return { rows: [user] };
    throw new Error(`Unexpected query: ${sql}`);
  };
  db.connect = async () => ({
    query: async (sql, params = []) => {
      if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") return {};
      if (sql.includes("FROM auth_sessions s")) return { rows: [{ ...session, ...user }] };
      if (sql.includes("SET refresh_token_hash")) {
        session.refresh_token_hash = params[1];
        return { rowCount: 1 };
      }
      if (sql.includes("SET revoked_at")) {
        session.revoked_at = new Date();
        return { rowCount: 1 };
      }
      throw new Error(`Unexpected transaction query: ${sql}`);
    },
    release() {}
  });
  try {
    const created = await app.inject({ method: "POST", url: "/auth/provisional" });
    assert.equal(created.statusCode, 201);
    const first = created.json();
    assert.equal(first.user.emailVerified, false);
    assert.match(first.refreshToken, /^[0-9a-f-]{36}\./);

    const refreshed = await app.inject({ method: "POST", url: "/auth/refresh", payload: { refreshToken: first.refreshToken } });
    assert.equal(refreshed.statusCode, 200);
    assert.notEqual(refreshed.json().refreshToken, first.refreshToken);

    const replay = await app.inject({ method: "POST", url: "/auth/refresh", payload: { refreshToken: first.refreshToken } });
    assert.equal(replay.statusCode, 401);
    const protectedRoute = await app.inject({ method: "GET", url: "/auth/me", headers: { Authorization: `Bearer ${first.token}` } });
    assert.equal(protectedRoute.statusCode, 401);

    const second = (await app.inject({ method: "POST", url: "/auth/provisional" })).json();
    const logout = await app.inject({ method: "POST", url: "/auth/logout", payload: { refreshToken: second.refreshToken } });
    assert.equal(logout.statusCode, 204);
    const afterLogout = await app.inject({ method: "GET", url: "/auth/me", headers: { Authorization: `Bearer ${second.token}` } });
    assert.equal(afterLogout.statusCode, 401);
  } finally {
    db.query = originalQuery;
    db.connect = originalConnect;
    await app.close();
  }
});

test("email challenge confirms once and only then changes account email", async () => {
  const { sendChallenge, confirmChallenge } = await import("../dist/auth/email-challenges.js");
  const originalQuery = db.query;
  const originalConnect = db.connect;
  const originalFetch = globalThis.fetch;
  const previousUrl = process.env.AUTH_EMAIL_WEBHOOK_URL;
  const previousKey = process.env.AUTH_EMAIL_WEBHOOK_KEY;
  process.env.AUTH_EMAIL_WEBHOOK_URL = "https://mail.example.test/send";
  process.env.AUTH_EMAIL_WEBHOOK_KEY = "test-key";
  let sent;
  let challenge;
  let userEmail = "generated@tiletopia.com";
  db.query = async (sql, params = []) => {
    if (sql.includes("SELECT 1 FROM auth_email_challenges")) return { rowCount: 0 };
    if (sql.includes("INSERT INTO auth_email_challenges")) {
      challenge = { id: "challenge-id", user_id: params[0], email: params[1], purpose: params[2], token_hash: params[3], consumed_at: null };
      return { rows: [{ id: challenge.id }] };
    }
    throw new Error(`Unexpected query: ${sql}`);
  };
  db.connect = async () => ({
    query: async (sql, params = []) => {
      if (["BEGIN", "COMMIT", "ROLLBACK"].includes(sql)) return {};
      if (sql.includes("FROM auth_email_challenges")) {
        return { rows: challenge?.token_hash === params[2] && !challenge.consumed_at ? [challenge] : [] };
      }
      if (sql.includes("UPDATE users SET email")) {
        userEmail = params[0];
        return { rows: [{ id: challenge.user_id, email: userEmail, display_name: "Player", email_verified: true }] };
      }
      if (sql.includes("SET consumed_at")) {
        challenge.consumed_at = new Date();
        return {};
      }
      throw new Error(`Unexpected transaction query: ${sql}`);
    },
    release() {}
  });
  globalThis.fetch = async (_url, options) => {
    sent = JSON.parse(options.body);
    return { ok: true };
  };
  try {
    await sendChallenge("11111111-1111-4111-8111-111111111111", "real@example.test", "verify");
    assert.equal(userEmail, "generated@tiletopia.com");
    const code = sent.text.match(/[A-Za-z0-9_-]{16}/)[0];
    const confirmed = await confirmChallenge("real@example.test", code, "verify");
    assert.equal(confirmed.email, "real@example.test");
    assert.equal(confirmed.email_verified, true);
    assert.equal(await confirmChallenge("real@example.test", code, "verify"), null);
  } finally {
    db.query = originalQuery;
    db.connect = originalConnect;
    globalThis.fetch = originalFetch;
    if (previousUrl === undefined) delete process.env.AUTH_EMAIL_WEBHOOK_URL;
    else process.env.AUTH_EMAIL_WEBHOOK_URL = previousUrl;
    if (previousKey === undefined) delete process.env.AUTH_EMAIL_WEBHOOK_KEY;
    else process.env.AUTH_EMAIL_WEBHOOK_KEY = previousKey;
  }
});
