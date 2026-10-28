import { createHash, randomBytes } from "node:crypto";
import { db } from "../db.js";

type Purpose = "verify" | "sign_in";
const digest = (value: string) => createHash("sha256").update(value).digest("hex");

export async function sendChallenge(userId: string, email: string, purpose: Purpose): Promise<void> {
  const endpoint = process.env.AUTH_EMAIL_WEBHOOK_URL;
  const key = process.env.AUTH_EMAIL_WEBHOOK_KEY;
  if (!endpoint || !key) throw new Error("AUTH_EMAIL_NOT_CONFIGURED");
  const mailUrl = new URL(endpoint);
  if (mailUrl.protocol !== "https:" && mailUrl.hostname !== "localhost" && mailUrl.hostname !== "127.0.0.1") {
    throw new Error("AUTH_EMAIL_REQUIRES_HTTPS");
  }
  const recent = await db.query(
    `SELECT 1 FROM auth_email_challenges WHERE email = $1 AND purpose = $2
     AND created_at > now() - interval '60 seconds'`, [email, purpose]
  );
  if (recent.rowCount) return;
  const code = randomBytes(12).toString("base64url");
  const result = await db.query<{ id: string }>(
    `INSERT INTO auth_email_challenges (user_id, email, purpose, token_hash, expires_at)
     VALUES ($1, $2, $3, $4, now() + interval '10 minutes') RETURNING id`,
    [userId, email, purpose, digest(code)]
  );
  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        to: email,
        subject: purpose === "verify" ? "Verify your Pokabow email" : "Sign in to Pokabow",
        text: `Your Pokabow code is ${code}. It expires in 10 minutes. If you did not request it, ignore this message.`
      }),
      signal: AbortSignal.timeout(10_000)
    });
    if (!response.ok) throw new Error("AUTH_EMAIL_DELIVERY_FAILED");
  } catch (error) {
    await db.query("DELETE FROM auth_email_challenges WHERE id = $1", [result.rows[0].id]);
    throw error;
  }
}

export async function confirmChallenge(email: string, code: string, purpose: Purpose) {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const result = await client.query<{ id: string; user_id: string }>(
      `SELECT id, user_id FROM auth_email_challenges
       WHERE email = $1 AND purpose = $2 AND token_hash = $3
         AND consumed_at IS NULL AND expires_at > now()
       FOR UPDATE`, [email, purpose, digest(code)]
    );
    const challenge = result.rows[0];
    if (!challenge) {
      await client.query("ROLLBACK");
      return null;
    }
    const userResult = purpose === "verify"
      ? await client.query<{ id: string; email: string; display_name: string; email_verified: boolean }>(
          `UPDATE users SET email = $1, email_verified = true WHERE id = $2
           RETURNING id, email, display_name, email_verified`, [email, challenge.user_id]
        )
      : await client.query<{ id: string; email: string; display_name: string; email_verified: boolean }>(
          `SELECT id, email, display_name, email_verified FROM users
           WHERE id = $1 AND email = $2 AND email_verified = true`, [challenge.user_id, email]
        );
    if (!userResult.rows[0]) {
      await client.query("ROLLBACK");
      return null;
    }
    await client.query(
      "UPDATE auth_email_challenges SET consumed_at = now() WHERE id = $1", [challenge.id]
    );
    await client.query("COMMIT");
    return userResult.rows[0];
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
