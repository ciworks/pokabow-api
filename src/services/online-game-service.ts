import type { Pool, PoolClient } from "pg";
import { db } from "../db.js";
import { runOnlineRules } from "../game/online-rules.js";
import type { RulesRunner, RulesState } from "../game/rules-contract.js";
import { awardOnlineMatch } from "./player-progression.js";
import { GEM_POLICY_VERSION, onlineGemShares, recordPendingOnlineGems, settleOnlineGems,
  onlineGemEarningsStatus } from "./gem-wallet.js";

export class OnlineError extends Error {
  constructor(public code: string, public status = 409) { super(code); }
}
type MatchRow = {
  id: string; player_a: string | null; player_b: string | null; state: RulesState;
  version: number; status: string; deadline_at: Date | null;
  last_seen_a: Date; last_seen_b: Date; gem_policy_version: string; gem_pair_eligible: boolean;
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
        snapshot, match.gem_policy_version, match.gem_pair_eligible);
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
    const settled = match.status === "completed" ? (await client.query<{ status: string; pot_total: string;
      policy_version: string; pot_a: string | null; pot_b: string | null;
      completion_a: string | null; completion_b: string | null }>(
      `SELECT status, pot_total::text, policy_version, pot_a::text, pot_b::text,
        completion_a::text, completion_b::text FROM online_gem_settlements WHERE match_id = $1`, [match.id])).rows[0] : null;
    const shares = settled?.status === "confirmed" ? onlineGemShares(match.state.snapshot.outcome,
      Number(match.state.snapshot.end_reason ?? 0), Number(settled.pot_total)) : null;
    const limited = settled?.policy_version === GEM_POLICY_VERSION;
    const ownPot = shares ? (limited ? Number(seat === "human" ? settled.pot_a : settled.pot_b) :
      seat === "human" ? shares.humanPot : shares.aiPot) : 0;
    const rivalPot = shares ? (limited ? Number(seat === "human" ? settled.pot_b : settled.pot_a) :
      seat === "human" ? shares.aiPot : shares.humanPot) : 0;
    const ownCompletion = shares ? (limited ? Number(seat === "human" ? settled.completion_a : settled.completion_b) :
      match.player_a && match.player_b ? shares.completion : 0) : 0;
    const rivalCompletion = shares ? (limited ? Number(seat === "human" ? settled.completion_b : settled.completion_a) :
      match.player_a && match.player_b ? shares.completion : 0) : 0;
    const earnings = match.gem_policy_version === GEM_POLICY_VERSION ?
      await onlineGemEarningsStatus(client, playerId, otherId) : null;
    return {
      matchId: match.id, version: match.version, status: match.status,
      serverTime: time.getTime() / 1000, deadline: null,
      opponent: { id: otherId, displayName: user?.display_name ?? "Opponent", connected: Boolean(otherId && time.getTime() - otherSeen.getTime() < 15000) },
      ...match.state.views[seat],
      gemPolicyVersion: match.gem_policy_version,
      gemEarnings: earnings ? { ...earnings, pairEligible: match.gem_pair_eligible,
        eligible: match.gem_pair_eligible && (earnings.dailyRemaining > 0 || ownPot + ownCompletion > 0) } : null,
      gemSettlementStatus: match.status === "completed" ? settled?.status ?? "ineligible" : "none",
      gemSettlement: settled && shares ? {
        policyVersion: settled.policy_version, potTotal: Number(settled.pot_total),
        humanPot: ownPot, rivalPot, humanCompletion: ownCompletion,
        rivalCompletion, humanTotal: ownPot + ownCompletion,
        rivalTotal: rivalPot + rivalCompletion,
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
