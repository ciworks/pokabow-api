import type { Pool, PoolClient } from "pg";
import { db } from "../db.js";

export const GEM_POLICY_VERSION = "gem-pot-v1";
export const AI_GEM_POLICY_VERSION = "ai-gem-pot-v1";
const COMPLETION_GEMS = 10;
const HAND_GEMS: Record<string, number> = {
  PAIR: 2, TWO_PAIR: 4, STRAIGHT_3: 6, THREE_OF_A_KIND: 8,
  STRAIGHT_4: 10, FULL_HOUSE: 12, FOUR_OF_A_KIND: 14,
};
type Snapshot = { outcome: number; end_reason?: number; ledger?: { events?: unknown[] } };
type ScoreEvent = { event_id?: unknown; category?: unknown; evidence?: { category?: unknown } };

/** Call only with the snapshot returned by the authoritative rules worker. */
export function onlineGemPot(snapshot: Snapshot): number {
  const seen = new Set<string>();
  let total = 0;
  for (const raw of snapshot.ledger?.events ?? []) {
    if (!raw || typeof raw !== "object") continue;
    const event = raw as ScoreEvent;
    if (typeof event.event_id !== "string" || !event.event_id || seen.has(event.event_id)) continue;
    seen.add(event.event_id);
    if (event.category === 0 && typeof event.evidence?.category === "string") {
      total += HAND_GEMS[event.evidence.category] ?? 0;
    }
  }
  return total;
}

export function onlineGemShares(outcome: number, endReason: number, pot: number) {
  if (![1, 2, 3].includes(outcome) || !Number.isSafeInteger(pot) || pot < 0 || pot % 2 !== 0) {
    throw new Error("INVALID_GEM_SETTLEMENT");
  }
  return {
    humanPot: outcome === 1 ? pot : outcome === 3 ? pot / 2 : 0,
    aiPot: outcome === 2 ? pot : outcome === 3 ? pot / 2 : 0,
    completion: endReason === 5 ? 0 : COMPLETION_GEMS,
  };
}

export function verifiedAiGemPayout(snapshot: Snapshot, rewardDifficulty: number) {
  const cap = [20, 40, 80][rewardDifficulty];
  if (cap === undefined || ![1, 2, 3].includes(snapshot.outcome)) throw new Error("INVALID_AI_GEM_SETTLEMENT");
  const pot = Math.min(onlineGemPot(snapshot), cap);
  return { pot, amount: snapshot.end_reason === 5 ? 0 :
    snapshot.outcome === 1 ? pot : snapshot.outcome === 3 ? pot / 2 : 0 };
}

async function grant(client: PoolClient, userId: string, matchId: string,
  kind: "online_pot" | "online_completion" | "verified_ai_pot", amount: number, policy: string) {
  if (amount <= 0) return;
  const sourceKey = `${matchId}:${kind}`;
  const inserted = await client.query(`INSERT INTO gem_transactions
    (user_id, source_key, match_id, kind, amount, policy_version)
    VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (user_id, source_key) DO NOTHING RETURNING id`,
  [userId, sourceKey, matchId, kind, amount, policy]);
  if (inserted.rowCount !== 1) return;
  await client.query(`INSERT INTO gem_wallets (user_id, balance) VALUES ($1, $2)
    ON CONFLICT (user_id) DO UPDATE SET balance = gem_wallets.balance + EXCLUDED.balance,
    updated_at = clock_timestamp()`, [userId, amount]);
}


/** In the transaction that commits a terminal match, so a failed grant rolls back the result. */
export async function settleOnlineGems(client: PoolClient, matchId: string, playerA: string | null,
  playerB: string | null, snapshot: Snapshot, policy: string): Promise<void> {
  if (![1, 2, 3].includes(snapshot.outcome)) return;
  if (policy !== GEM_POLICY_VERSION) throw new Error("UNKNOWN_GEM_POLICY");
  const pot = onlineGemPot(snapshot);
  await client.query(`INSERT INTO online_gem_settlements (match_id, policy_version, pot_total)
    VALUES ($1, $2, $3) ON CONFLICT (match_id) DO NOTHING`, [matchId, policy, pot]);
  const settlement = (await client.query<{ status: string; policy_version: string; pot_total: string }>(
    "SELECT status, policy_version, pot_total::text FROM online_gem_settlements WHERE match_id = $1 FOR UPDATE", [matchId])).rows[0];
  if (settlement.policy_version !== policy || Number(settlement.pot_total) !== pot) throw new Error("GEM_SETTLEMENT_MISMATCH");
  if (settlement.status === "confirmed") return;
  const shares = onlineGemShares(snapshot.outcome, snapshot.end_reason ?? 0, pot);
  if (playerA) {
    await grant(client, playerA, matchId, "online_pot", shares.humanPot, policy);
    if (playerB) await grant(client, playerA, matchId, "online_completion", shares.completion, policy);
  }
  if (playerB) {
    await grant(client, playerB, matchId, "online_pot", shares.aiPot, policy);
    if (playerA) await grant(client, playerB, matchId, "online_completion", shares.completion, policy);
  }
  await client.query(`UPDATE online_gem_settlements SET status = 'confirmed',
    confirmed_at = clock_timestamp() WHERE match_id = $1`, [matchId]);
}

export async function recordPendingOnlineGems(client: PoolClient, matchId: string, snapshot: Snapshot, policy: string) {
  const pot = onlineGemPot(snapshot);
  await client.query(`INSERT INTO online_gem_settlements (match_id, policy_version, pot_total)
    VALUES ($1, $2, $3) ON CONFLICT (match_id) DO NOTHING`, [matchId, policy, pot]);
}

export async function settleVerifiedAiGems(client: PoolClient, matchId: string, userId: string,
  snapshot: Snapshot, rewardDifficulty: number, policy: string) {
  if (policy !== AI_GEM_POLICY_VERSION) throw new Error("UNKNOWN_AI_GEM_POLICY");
  const { pot, amount } = verifiedAiGemPayout(snapshot, rewardDifficulty);
  await client.query(`INSERT INTO verified_ai_gem_settlements (match_id, policy_version, pot_total, amount)
    VALUES ($1, $2, $3, $4) ON CONFLICT (match_id) DO NOTHING`, [matchId, policy, pot, amount]);
  const settlement = (await client.query<{ status: string; policy_version: string; pot_total: string; amount: string }>(
    `SELECT status, policy_version, pot_total::text, amount::text FROM verified_ai_gem_settlements
      WHERE match_id = $1 FOR UPDATE`, [matchId])).rows[0];
  if (settlement.policy_version !== policy || Number(settlement.pot_total) !== pot ||
      Number(settlement.amount) !== amount) throw new Error("AI_GEM_SETTLEMENT_MISMATCH");
  if (settlement.status === "confirmed") return;
  await grant(client, userId, matchId, "verified_ai_pot", amount, policy);
  await client.query(`UPDATE verified_ai_gem_settlements SET status = 'confirmed',
    confirmed_at = clock_timestamp() WHERE match_id = $1`, [matchId]);
}

export async function recordPendingVerifiedAiGems(client: PoolClient, matchId: string,
  snapshot: Snapshot, rewardDifficulty: number, policy: string) {
  const { pot, amount } = verifiedAiGemPayout(snapshot, rewardDifficulty);
  await client.query(`INSERT INTO verified_ai_gem_settlements (match_id, policy_version, pot_total, amount)
    VALUES ($1, $2, $3, $4) ON CONFLICT (match_id) DO NOTHING`, [matchId, policy, pot, amount]);
}

/** Confirmed account currency only; match pot projections never enter this read model. */
export async function readGemWallet(userId: string, pool: Pick<Pool, "query"> = db) {
  const balance = await pool.query<{ balance: string }>(`SELECT COALESCE(w.balance, 0)::text AS balance
    FROM users u LEFT JOIN gem_wallets w ON w.user_id = u.id WHERE u.id = $1`, [userId]);
  if (!balance.rows[0]) return null;
  const history = await pool.query<{ id: string; match_id: string | null; kind: string;
    amount: string; policy_version: string; created_at: Date }>(`SELECT id::text, match_id, kind,
    amount::text, policy_version, created_at FROM gem_transactions
    WHERE user_id = $1 ORDER BY id DESC LIMIT 50`, [userId]);
  return { balance: Number(balance.rows[0].balance), transactions: history.rows.map(row => ({
    id: row.id, matchId: row.match_id, kind: row.kind, amount: Number(row.amount),
    policyVersion: row.policy_version, createdAt: row.created_at,
  })) };
}
