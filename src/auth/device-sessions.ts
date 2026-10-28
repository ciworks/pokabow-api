import { createHash, randomBytes, randomUUID } from "node:crypto";
import { db } from "../db.js";
import type { FastifyInstance } from "fastify";

const SESSION_DAYS = 30;
const hash = (value: string) => createHash("sha256").update(value).digest("hex");

export async function issueSession(app: FastifyInstance, user: { id: string; email: string | null; display_name: string; email_verified: boolean }) {
  const sessionId = randomUUID();
  const refreshToken = `${sessionId}.${randomBytes(32).toString("base64url")}`;
  await db.query(
    `INSERT INTO auth_sessions (id, user_id, refresh_token_hash, expires_at)
     VALUES ($1, $2, $3, now() + $4::interval)`,
    [sessionId, user.id, hash(refreshToken), `${SESSION_DAYS} days`]
  );
  return response(app, user, sessionId, refreshToken);
}

function response(app: FastifyInstance, user: { id: string; email: string | null; display_name: string; email_verified: boolean }, sessionId: string, refreshToken: string) {
  return {
    token: app.jwt.sign({ sub: user.id, sid: sessionId }),
    refreshToken,
    user: { id: user.id, email: user.email, displayName: user.display_name, emailVerified: user.email_verified }
  };
}

export async function refreshSession(app: FastifyInstance, refreshToken: string) {
  const sessionId = refreshToken.split(".")[0];
  if (!/^[0-9a-f-]{36}$/i.test(sessionId)) return null;
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const result = await client.query<{
      refresh_token_hash: string; expires_at: Date; revoked_at: Date | null;
      id: string; email: string | null; display_name: string; email_verified: boolean;
    }>(
      `SELECT s.refresh_token_hash, s.expires_at, s.revoked_at,
              u.id, u.email, u.display_name, u.email_verified
       FROM auth_sessions s JOIN users u ON u.id = s.user_id
       WHERE s.id = $1 FOR UPDATE OF s`, [sessionId]
    );
    const row = result.rows[0];
    if (!row || row.revoked_at || row.expires_at <= new Date()) {
      await client.query("ROLLBACK");
      return null;
    }
    if (row.refresh_token_hash !== hash(refreshToken)) {
      await client.query("UPDATE auth_sessions SET revoked_at = now() WHERE id = $1", [sessionId]);
      await client.query("COMMIT");
      return null;
    }
    const nextToken = `${sessionId}.${randomBytes(32).toString("base64url")}`;
    await client.query(
      `UPDATE auth_sessions SET refresh_token_hash = $2,
       expires_at = now() + $3::interval WHERE id = $1`,
      [sessionId, hash(nextToken), `${SESSION_DAYS} days`]
    );
    await client.query("COMMIT");
    return response(app, row, sessionId, nextToken);
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function revokeSession(refreshToken: string): Promise<void> {
  const sessionId = refreshToken.split(".")[0];
  if (!/^[0-9a-f-]{36}$/i.test(sessionId)) return;
  await db.query(
    `UPDATE auth_sessions SET revoked_at = now()
     WHERE id = $1 AND refresh_token_hash = $2 AND revoked_at IS NULL`,
    [sessionId, hash(refreshToken)]
  );
}

export async function sessionIsActive(sessionId: string): Promise<boolean> {
  const result = await db.query(
    `SELECT 1 FROM auth_sessions WHERE id = $1
     AND revoked_at IS NULL AND expires_at > now()`, [sessionId]
  );
  return result.rowCount === 1;
}
