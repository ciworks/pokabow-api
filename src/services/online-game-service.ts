import type { Pool, PoolClient } from "pg";
import { db } from "../db.js";
import { runOnlineRules } from "../game/online-rules.js";
import type { RulesRunner, RulesState } from "../game/rules-contract.js";
import { awardOnlineMatch } from "./player-progression.js";
import { onlineGemShares, recordPendingOnlineGems, settleOnlineGems } from "./gem-wallet.js";

export class OnlineError extends Error {
  constructor(public code: string, public status = 409) { super(code); }
}
type MatchRow = {
  id: string; player_a: string | null; player_b: string | null; state: RulesState;
  version: number; status: string; deadline_at: Date | null;
  last_seen_a: Date; last_seen_b: Date; gem_policy_version: string;
};
export type OnlineCommand = {
  commandId: string; expectedVersion: number; action: "place" | "swap" | "resign";
  placements?: { tileId: string; x: number; y: number; rotation: number }[];
  tileIds?: string[];
};

export function createOnlineGameService(pool: Pick<Pool, "connect"> = db, rules: RulesRunner = runOnlineRules) {
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
  async function persist(client: PoolClient, match: MatchRow, next: RulesState) {
    const completed = next.snapshot.outcome !== 0;
    const updated = await client.query<MatchRow>(`UPDATE online_matches
      SET state = $2, version = version + 1, status = $3, deadline_at = $4,
          completed_at = CASE WHEN $3 = 'completed' THEN clock_timestamp() ELSE NULL END
      WHERE id = $1 RETURNING *`,
    [match.id, JSON.stringify(next), completed ? "completed" : "active", null]);
    if (completed && match.status === "active") {
      await attemptGemSettlement(client, match, next.snapshot);
      await awardOnlineMatch(client, match.id, match.player_a, match.player_b, next.snapshot.outcome);
    }
    return updated.rows[0];
  }
  async function attemptGemSettlement(client: PoolClient, match: MatchRow, snapshot: RulesState["snapshot"]) {
    await client.query("SAVEPOINT gem_wallet_credit");
    try {
      await settleOnlineGems(client, match.id, match.player_a, match.player_b,
        snapshot, match.gem_policy_version);
    } catch {
      await client.query("ROLLBACK TO SAVEPOINT gem_wallet_credit");
      await recordPendingOnlineGems(client, match.id, snapshot, match.gem_policy_version);
    }
    await client.query("RELEASE SAVEPOINT gem_wallet_credit");
  }
  async function advance(client: PoolClient, match: MatchRow) {
    if (match.status !== "active") return match;
    if (!match.player_a || !match.player_b) {
      const result = await rules({ action: "resign", snapshot: match.state.snapshot, seat: !match.player_a ? "human" : "ai" });
      if ("error" in result) throw new Error(result.error);
      return persist(client, match, result);
    }
    return match;
  }
  async function now(client: PoolClient): Promise<Date> {
    return (await client.query<{ now: Date }>("SELECT clock_timestamp() AS now")).rows[0].now;
  }
  async function response(client: PoolClient, match: MatchRow, playerId: string, time: Date) {
    const seat = match.player_a === playerId ? "human" : "ai";
    const otherId = seat === "human" ? match.player_b : match.player_a;
    const otherSeen = seat === "human" ? match.last_seen_b : match.last_seen_a;
    const user = otherId ? (await client.query("SELECT display_name FROM users WHERE id = $1", [otherId])).rows[0] : null;
    const settled = match.status === "completed" ? (await client.query<{ status: string; pot_total: string; policy_version: string }>(
      "SELECT status, pot_total::text, policy_version FROM online_gem_settlements WHERE match_id = $1", [match.id])).rows[0] : null;
    const shares = settled?.status === "confirmed" ? onlineGemShares(match.state.snapshot.outcome,
      Number(match.state.snapshot.end_reason ?? 0), Number(settled.pot_total)) : null;
    const ownPot = shares ? (seat === "human" ? shares.humanPot : shares.aiPot) : 0;
    const rivalPot = shares ? (seat === "human" ? shares.aiPot : shares.humanPot) : 0;
    return {
      matchId: match.id, version: match.version, status: match.status,
      serverTime: time.getTime() / 1000, deadline: null,
      opponent: { id: otherId, displayName: user?.display_name ?? "Opponent", connected: Boolean(otherId && time.getTime() - otherSeen.getTime() < 15000) },
      ...match.state.views[seat],
      gemSettlementStatus: match.status === "completed" ? settled?.status ?? "ineligible" : "none",
      gemSettlement: settled && shares ? {
        policyVersion: settled.policy_version, potTotal: Number(settled.pot_total),
        humanPot: ownPot, rivalPot, humanCompletion: match.player_a && match.player_b ? shares.completion : 0,
        rivalCompletion: match.player_a && match.player_b ? shares.completion : 0,
        humanTotal: ownPot + (match.player_a && match.player_b ? shares.completion : 0),
        rivalTotal: rivalPot + (match.player_a && match.player_b ? shares.completion : 0),
      } : null,
    };
  }
  async function access(playerId: string, id: string | null, command?: OnlineCommand) {
    return transaction(async client => {
      const found = await client.query<MatchRow>(`SELECT * FROM online_matches
        WHERE (player_a = $1 OR player_b = $1)
          AND ($2::uuid IS NULL AND status = 'active' OR id = $2)
        ORDER BY created_at DESC LIMIT 1 FOR UPDATE`, [playerId, id]);
      let match = found.rows[0];
      if (!match) {
        if (!id) return null;
        throw new OnlineError("MATCH_NOT_FOUND", 404);
      }
      const time = await now(client);
      match = await advance(client, match);
      if (match.status === "completed") await attemptGemSettlement(client, match, match.state.snapshot);
      const presenceColumn = match.player_a === playerId ? "last_seen_a" : "last_seen_b";
      await client.query(`UPDATE online_matches SET ${presenceColumn} = $2 WHERE id = $1`, [match.id, time]);
      let error: string | undefined;
      if (command) {
        const previous = (await client.query("SELECT player_id, payload FROM online_commands WHERE match_id = $1 AND command_id = $2", [match.id, command.commandId])).rows[0];
        if (previous) {
          // JSONB equality avoids JSON key-order assumptions.
          const same = await client.query("SELECT payload = $3::jsonb AS same FROM online_commands WHERE match_id = $1 AND command_id = $2",
            [match.id, command.commandId, JSON.stringify(command)]);
          if (previous.player_id !== playerId || !same.rows[0].same) error = "COMMAND_ID_REUSED";
        } else if (match.status !== "active") error = "MATCH_FINISHED";
        else if (command.expectedVersion !== match.version) error = "VERSION_CONFLICT";
        else {
          const result = await rules({
            action: command.action, snapshot: match.state.snapshot,
            seat: match.player_a === playerId ? "human" : "ai",
            placements: command.placements, tileIds: command.tileIds,
          });
          if ("error" in result) error = result.error;
          else {
            match = await persist(client, match, result);
            await client.query("INSERT INTO online_commands (match_id, command_id, player_id, payload, accepted_version) VALUES ($1, $2, $3, $4, $5)",
              [match.id, command.commandId, playerId, JSON.stringify(command), match.version]);
          }
        }
      }
      // Return conflicts after committing presence updates.
      return { ...(await response(client, match, playerId, await now(client))), ...(error ? { error } : {}) };
    });
  }
  return {
    current: (playerId: string) => access(playerId, null),
    get: (playerId: string, id: string) => access(playerId, id),
    command: (playerId: string, id: string, command: OnlineCommand) => access(playerId, id, command),
  };
}
export const onlineGameService = createOnlineGameService();
