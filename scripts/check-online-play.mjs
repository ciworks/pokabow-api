import "dotenv/config";
import { access } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { randomUUID } from "node:crypto";
import { db } from "../dist/db.js";
import { runOnlineRules } from "../dist/game/online-rules.js";

try {
  for (const key of ["GODOT_BIN", "ONLINE_RULES_PROJECT"]) {
    const value = process.env[key];
    if (!value || !isAbsolute(value)) throw new Error(`${key} must be an absolute path; see docs/ONLINE_PLAY.md`);
    await access(value);
  }
  await access(join(process.env.ONLINE_RULES_PROJECT, "tools", "online_rules_worker.gd"));
  const schema = await db.query(`SELECT
    to_regclass('public.online_matches') IS NOT NULL AS matches,
    to_regclass('public.online_commands') IS NOT NULL AS commands,
    EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public'
      AND table_name = 'matchmaking_tickets' AND column_name = 'ready') AS ready`);
  if (!Object.values(schema.rows[0]).every(Boolean)) throw new Error("Apply migrations/008_online_play.sql before enabling online play");
  const result = await runOnlineRules({ action: "create", matchId: randomUUID(), seed: 42 });
  if ("error" in result) throw new Error(`Rules engine rejected initialization: ${result.error}`);
  console.log("Online play ready: database schema and Godot match initialization passed. No match was saved.");
} catch (error) {
  console.error(`Online play check failed: ${error.message}`);
  process.exitCode = 1;
} finally {
  await db.end();
}
