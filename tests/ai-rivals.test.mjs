import { test } from "node:test";
import assert from "node:assert/strict";

const { createVerifiedAiGameService, VerifiedAiError } =
  await import("../dist/services/verified-ai-game-service.js");

test("verified match snapshots the requested database rival", async () => {
  const queries = [];
  const rival = { id: "rival_07", display_name: "Hugo", avatar_key: "rival_07" };
  const client = {
    release() {},
    async query(sql, params) {
      queries.push({ sql, params });
      if (sql.includes("FROM ai_rivals")) return { rows: [rival] };
      if (sql.includes("FROM verified_ai_matches")) return { rows: [] };
      if (sql.includes("INSERT INTO verified_ai_matches")) return { rows: [{
        id: params[0], user_id: params[1], state: { views: { human: {} } },
        version: 1, status: "active", difficulty: 1, reward_difficulty: 1,
        gem_eligible: false, rival_id: params[4], rival_name: params[5],
        rival_avatar_key: params[6],
      }] };
      return { rows: [] };
    },
  };
  const rules = async () => ({ snapshot: { outcome: 0 }, views: { human: {} } });
  const service = createVerifiedAiGameService({ connect: async () => client }, rules);
  const match = await service.create("user", "match", 1, "rival_07");
  assert.deepEqual(match.opponent, { id: "rival_07", displayName: "Hugo",
    avatarKey: "rival_07", connected: true });
  assert.deepEqual(queries.find(item => item.sql.includes("FROM ai_rivals")).params,
    [1, "rival_07"]);
});

test("a rival outside the requested tier is unavailable", async () => {
  const client = { release() {}, async query(sql) {
    if (sql.includes("FROM ai_rivals") || sql.includes("FROM verified_ai_matches"))
      return { rows: [] };
    return { rows: [] };
  } };
  const service = createVerifiedAiGameService({ connect: async () => client },
    async () => { throw new Error("Rules must not run"); });
  await assert.rejects(service.create("user", "match", 2, "rival_01"), error =>
    error instanceof VerifiedAiError && error.code === "RIVAL_UNAVAILABLE");
});

test("new request creates a distinct match even when another AI match is active", async () => {
  const queries = [];
  const client = { release() {}, async query(sql, params) {
    queries.push({ sql, params });
    if (sql.includes("FROM verified_ai_matches")) return { rows: [] };
    if (sql.includes("FROM ai_rivals")) return { rows: [{ id: "rival_07", display_name: "Hugo", avatar_key: "rival_07" }] };
    if (sql.includes("INSERT INTO verified_ai_matches")) return { rows: [{
      id: params[0], state: { views: { human: {} } }, version: 1, status: "active",
      difficulty: 1, reward_difficulty: 1, gem_eligible: false,
      rival_id: params[4], rival_name: params[5], rival_avatar_key: params[6],
    }] };
    return { rows: [] };
  } };
  const service = createVerifiedAiGameService({ connect: async () => client },
    async () => ({ snapshot: { outcome: 0 }, views: { human: {} } }));
  const created = await service.create("user", "new-match", 1, "rival_07");
  assert.equal(created.matchId, "new-match");
  const lookup = queries.find(item => item.sql.includes("FROM verified_ai_matches"));
  assert.match(lookup.sql, /user_id = \$1 AND id = \$2/);
  assert.doesNotMatch(lookup.sql, /status = 'active'/);
});
