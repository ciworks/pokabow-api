import { randomInt } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { db } from "../db.js";
import { runOnlineRules, type RulesRunner, type RulesState } from "../game/online-rules.js";
import { recordPendingVerifiedAiGems, settleVerifiedAiGems } from "./gem-wallet.js";

type MatchRow = { id: string; user_id: string; state: RulesState; version: number; status: string;
  difficulty: number; reward_difficulty: number; deadline_at: Date | null;
  gem_eligible: boolean; gem_policy_version: string };
export type AiCommand = { commandId: string; expectedVersion: number; action: "place" | "swap" | "resign" | "difficulty";
  placements?: { tileId: string; x: number; y: number; rotation: number }[]; tileIds?: string[]; difficulty?: number };

export class VerifiedAiError extends Error {
  constructor(public code: string, public status = 409) { super(code); }
}

export function createVerifiedAiGameService(pool: Pick<Pool, "connect"> = db, rules: RulesRunner = runOnlineRules) {
  async function transaction<T>(run: (client: PoolClient) => Promise<T>) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const result = await run(client);
      await client.query("COMMIT");
      return result;
    } catch (error) { await client.query("ROLLBACK"); throw error; }
    finally { client.release(); }
  }
  async function response(client: PoolClient, match: MatchRow, error?: string) {
    const settlement = match.gem_eligible && match.status === "completed" ?
      (await client.query<{ status: string; policy_version: string; pot_total: string; amount: string }>(
        `SELECT status, policy_version, pot_total::text, amount::text FROM verified_ai_gem_settlements
          WHERE match_id = $1`, [match.id])).rows[0] : null;
    return {
      matchId: match.id, version: match.version, status: match.status,
      serverTime: Date.now() / 1000, deadline: null,
      opponent: { id: "ai", displayName: "AI Rival", connected: true },
      difficulty: match.difficulty, rewardDifficulty: match.reward_difficulty,
      ...match.state.views.human,
      gemSettlementStatus: match.status === "completed" ?
        (match.gem_eligible ? settlement?.status ?? "pending" : "ineligible") : "none",
      gemSettlement: settlement?.status === "confirmed" ? {
        policyVersion: settlement.policy_version, potTotal: Number(settlement.pot_total),
        humanPot: Number(settlement.amount), rivalPot: 0,
        humanCompletion: 0, rivalCompletion: 0,
        humanTotal: Number(settlement.amount), rivalTotal: 0,
      } : null,
      ...(error ? { error } : {}),
    };
  }
  async function resolveAi(state: RulesState, difficulty: number) {
    for (let i = 0; i < 16 && state.snapshot.outcome === 0 && state.snapshot.turn.active_player_id === "ai"; i++) {
      const ai = await rules({ action: "ai_move", snapshot: state.snapshot, seat: "ai", difficulty });
      if ("error" in ai) throw new Error(ai.error);
      state = ai;
    }
    if (state.snapshot.outcome === 0 && state.snapshot.turn.active_player_id === "ai") throw new Error("AI_TURN_DID_NOT_RESOLVE");
    return state;
  }
  async function save(client: PoolClient, match: MatchRow, state: RulesState) {
    const wasActive = match.status === "active";
    match.state = state;
    match.version += 1;
    match.status = state.snapshot.outcome === 0 ? "active" : "completed";
    match.deadline_at = null;
    await client.query(`UPDATE verified_ai_matches SET state = $2, version = $3, status = $4,
      difficulty = $5, reward_difficulty = $6, deadline_at = $7,
      completed_at = CASE WHEN $4 = 'completed' THEN clock_timestamp() ELSE NULL END
      WHERE id = $1`, [match.id, JSON.stringify(state), match.version, match.status,
      match.difficulty, match.reward_difficulty, match.deadline_at]);
    if (wasActive && match.status === "completed") await attemptGemSettlement(client, match);
  }
  async function attemptGemSettlement(client: PoolClient, match: MatchRow) {
    if (!match.gem_eligible || match.status !== "completed") return;
    await client.query("SAVEPOINT verified_ai_gem_credit");
    try {
      await settleVerifiedAiGems(client, match.id, match.user_id, match.state.snapshot,
        match.reward_difficulty, match.gem_policy_version);
    } catch {
      await client.query("ROLLBACK TO SAVEPOINT verified_ai_gem_credit");
      await recordPendingVerifiedAiGems(client, match.id, match.state.snapshot,
        match.reward_difficulty, match.gem_policy_version);
    }
    await client.query("RELEASE SAVEPOINT verified_ai_gem_credit");
  }
  async function create(userId: string, requestId: string, difficulty: number) {
    return transaction(async client => {
      await client.query("SELECT id FROM users WHERE id = $1 FOR UPDATE", [userId]);
      const existing = (await client.query<MatchRow>(`SELECT * FROM verified_ai_matches
        WHERE user_id = $1 AND (id = $2 OR status = 'active') ORDER BY created_at DESC LIMIT 1 FOR UPDATE`,
      [userId, requestId])).rows[0];
      if (existing) {
        await attemptGemSettlement(client, existing);
        return response(client, existing);
      }
      const created = await rules({ action: "create", matchId: requestId, seed: randomInt(1, 2147483647) });
      if ("error" in created) throw new Error(created.error);
      const inserted = await client.query<MatchRow>(`INSERT INTO verified_ai_matches
        (id, user_id, state, difficulty, reward_difficulty, gem_eligible)
        VALUES ($1,$2,$3,$4,$4,TRUE) RETURNING *`,
      [requestId, userId, JSON.stringify(created), difficulty]);
      return response(client, inserted.rows[0]);
    });
  }
  async function access(userId: string, id: string | null, command?: AiCommand) {
    return transaction(async client => {
      const match = (await client.query<MatchRow>(`SELECT * FROM verified_ai_matches
        WHERE user_id = $1 AND ($2::uuid IS NULL AND status = 'active' OR id = $2)
        ORDER BY created_at DESC LIMIT 1 FOR UPDATE`, [userId, id])).rows[0];
      if (!match) {
        if (!id) return null;
        throw new VerifiedAiError("MATCH_NOT_FOUND", 404);
      }
      await attemptGemSettlement(client, match);
      if (!command) return response(client, match);
      const previous = (await client.query<{ payload: AiCommand }>(`SELECT payload FROM verified_ai_commands
        WHERE match_id = $1 AND command_id = $2`, [match.id, command.commandId])).rows[0];
      if (previous) {
        const same = (await client.query<{ same: boolean }>(`SELECT payload = $3::jsonb AS same
          FROM verified_ai_commands WHERE match_id = $1 AND command_id = $2`,
        [match.id, command.commandId, JSON.stringify(command)])).rows[0].same;
        return response(client, match, same ? undefined : "COMMAND_ID_REUSED");
      }
      if (match.status !== "active") return response(client, match, "MATCH_FINISHED");
      if (command.expectedVersion !== match.version) return response(client, match, "VERSION_CONFLICT");
      let state = match.state;
      if (command.action === "difficulty") {
        match.difficulty = command.difficulty!;
        match.reward_difficulty = Math.min(match.reward_difficulty, match.difficulty);
      } else {
        const result = await rules({ action: command.action, snapshot: state.snapshot, seat: "human",
          placements: command.placements, tileIds: command.tileIds });
        if ("error" in result) return response(client, match, result.error);
        state = result;
        state = await resolveAi(state, match.difficulty);
      }
      await save(client, match, state);
      await client.query(`INSERT INTO verified_ai_commands (match_id, command_id, payload, accepted_version)
        VALUES ($1,$2,$3,$4)`, [match.id, command.commandId, JSON.stringify(command), match.version]);
      return response(client, match);
    });
  }
  return { create, current: (userId: string) => access(userId, null),
    get: (userId: string, id: string) => access(userId, id),
    command: (userId: string, id: string, command: AiCommand) => access(userId, id, command) };
}
export const verifiedAiGameService = createVerifiedAiGameService();
