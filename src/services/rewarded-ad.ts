import { createVerify, randomUUID } from "node:crypto";
import { db } from "../db.js";
import { config } from "../config.js";

export const AD_GEMS = 20;
const COOLDOWN_MS = 24 * 60 * 60 * 1000;
const SESSION_MS = 2 * 60 * 60 * 1000;
const KEY_URL = "https://www.gstatic.com/admob/reward/verifier-keys.json";
type Key = { keyId: number; pem: string };
let cachedKeys: Key[] = [];
let keysUntil = 0;

export async function rewardedAdStatus(userId: string) {
  const latest = await db.query<{ confirmed_at: Date }>(
    `SELECT confirmed_at FROM rewarded_ad_sessions WHERE user_id = $1 AND confirmed_at IS NOT NULL
     ORDER BY confirmed_at DESC LIMIT 1`, [userId]);
  const next = latest.rows[0] ? new Date(latest.rows[0].confirmed_at.getTime() + COOLDOWN_MS) : null;
  return { available: config.admobRewardedAdUnits.length > 0 && (!next || next.getTime() <= Date.now()),
    nextAvailableAt: next?.toISOString() ?? null,
    nextAvailableAtUnix: next ? Math.floor(next.getTime() / 1000) : null,
    enabled: config.admobRewardedAdUnits.length > 0,
    reward: AD_GEMS };
}

export async function startRewardedAd(userId: string) {
  const client = await db.connect();
  let committed = false;
  try {
    await client.query("BEGIN");
    const user = await client.query("SELECT id FROM users WHERE id = $1 FOR UPDATE", [userId]);
    if (!user.rowCount) return null;
    const latest = await client.query<{ confirmed_at: Date }>(
      `SELECT confirmed_at FROM rewarded_ad_sessions WHERE user_id = $1 AND confirmed_at IS NOT NULL
       ORDER BY confirmed_at DESC LIMIT 1`, [userId]);
    if (latest.rows[0] && Date.now() < latest.rows[0].confirmed_at.getTime() + COOLDOWN_MS) {
      return { available: false, nextAvailableAt:
        new Date(latest.rows[0].confirmed_at.getTime() + COOLDOWN_MS).toISOString() };
    }
    const pending = await client.query<{ id: string }>(
      `SELECT id FROM rewarded_ad_sessions WHERE user_id = $1 AND confirmed_at IS NULL
       AND created_at > now() - interval '2 hours' ORDER BY created_at DESC LIMIT 1`, [userId]);
    if (pending.rows[0]) {
      await client.query("COMMIT");
      committed = true;
      return { available: true, sessionId: pending.rows[0].id };
    }
    const id = randomUUID();
    await client.query("INSERT INTO rewarded_ad_sessions (id, user_id) VALUES ($1, $2)", [id, userId]);
    await client.query("COMMIT");
    committed = true;
    return { available: true, sessionId: id };
  } finally {
    if (!committed) await client.query("ROLLBACK");
    client.release();
  }
}

async function publicKeys(): Promise<Key[]> {
  if (cachedKeys.length && Date.now() < keysUntil) return cachedKeys;
  const response = await fetch(KEY_URL, { signal: AbortSignal.timeout(5000) });
  if (!response.ok) throw new Error("ADMOB_KEYS_UNAVAILABLE");
  const body = await response.json() as { keys?: Key[] };
  if (!Array.isArray(body.keys) || !body.keys.length) throw new Error("ADMOB_KEYS_INVALID");
  cachedKeys = body.keys;
  keysUntil = Date.now() + 12 * 60 * 60 * 1000;
  return cachedKeys;
}

export async function verifyRewardedAdCallback(rawUrl: string,
  getKeys: () => Promise<Key[]> = publicKeys) {
  const query = rawUrl.split("?", 2)[1] ?? "";
  const match = /^(.*)&signature=([^&]+)&key_id=(\d+)$/.exec(query);
  if (!match) return { valid: false as const };
  const [, signed, signature, keyId] = match;
  const key = (await getKeys()).find(item => item.keyId === Number(keyId));
  if (!key) return { valid: false as const };
  const verifier = createVerify("SHA256");
  verifier.update(signed, "utf8");
  if (!verifier.verify(key.pem, Buffer.from(signature, "base64url"))) return { valid: false as const };
  const params = new URLSearchParams(signed);
  const sessionId = params.get("custom_data") ?? "";
  const userId = params.get("user_id") ?? "";
  const transactionId = params.get("transaction_id") ?? "";
  const rawTimestamp = Number(params.get("timestamp"));
  const timestamp = rawTimestamp > 1e14 ? Math.floor(rawTimestamp / 1000) : rawTimestamp;
  if (!/^[0-9a-f-]{36}$/i.test(sessionId) || !/^[0-9a-f-]{36}$/i.test(userId) ||
      !/^[0-9a-f]+$/i.test(transactionId) || !Number.isSafeInteger(timestamp) ||
      timestamp > Date.now() + 300000 ||
      !config.admobRewardedAdUnits.some(unit => unit === params.get("ad_unit") ||
        unit.split("/").at(-1) === params.get("ad_unit")) ||
      params.get("reward_amount") !== String(AD_GEMS)) return { valid: false as const };
  return { valid: true as const, sessionId, userId, transactionId, timestamp };
}

export async function settleRewardedAd(verified: { sessionId: string; userId: string;
  transactionId: string; timestamp: number }) {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const user = await client.query("SELECT id FROM users WHERE id = $1 FOR UPDATE", [verified.userId]);
    if (!user.rowCount) { await client.query("ROLLBACK"); return; }
    const session = await client.query<{ created_at: Date; confirmed_at: Date | null; transaction_id: string | null }>(
      `SELECT created_at, confirmed_at, transaction_id FROM rewarded_ad_sessions
       WHERE id = $1 AND user_id = $2 FOR UPDATE`, [verified.sessionId, verified.userId]);
    const row = session.rows[0];
    if (!row || row.confirmed_at || verified.timestamp < row.created_at.getTime() - 300000 ||
        verified.timestamp > row.created_at.getTime() + SESSION_MS ||
        Date.now() > row.created_at.getTime() + SESSION_MS) {
      await client.query("ROLLBACK"); return;
    }
    const latest = await client.query<{ confirmed_at: Date }>(
      `SELECT confirmed_at FROM rewarded_ad_sessions WHERE user_id = $1 AND confirmed_at IS NOT NULL
       ORDER BY confirmed_at DESC LIMIT 1`, [verified.userId]);
    if (latest.rows[0] && Date.now() < latest.rows[0].confirmed_at.getTime() + COOLDOWN_MS) {
      await client.query("ROLLBACK"); return;
    }
    const updated = await client.query(`UPDATE rewarded_ad_sessions SET confirmed_at = clock_timestamp(), transaction_id = $1
      WHERE id = $2 AND confirmed_at IS NULL`, [verified.transactionId, verified.sessionId]);
    if (updated.rowCount !== 1) { await client.query("ROLLBACK"); return; }
    await client.query(`INSERT INTO gem_transactions
      (user_id, source_key, kind, amount, policy_version)
      VALUES ($1, $2, 'rewarded_ad', $3, 'rewarded-ad-v1')`,
      [verified.userId, `admob:${verified.transactionId}`, AD_GEMS]);
    await client.query(`INSERT INTO gem_wallets (user_id, balance) VALUES ($1, $2)
      ON CONFLICT (user_id) DO UPDATE SET balance = gem_wallets.balance + EXCLUDED.balance,
      updated_at = clock_timestamp()`, [verified.userId, AD_GEMS]);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    // Google retries callbacks. A repeated transaction must never grant twice.
    if ((error as { code?: string }).code !== "23505") throw error;
  } finally {
    client.release();
  }
}
