import "dotenv/config";
import { randomUUID } from "node:crypto";
import { db } from "../dist/db.js";
import { runOnlineRules } from "../dist/game/online-rules.js";

try {
  const schema = await db.query(`SELECT
    to_regclass('public.online_matches') IS NOT NULL AS matches,
    to_regclass('public.online_commands') IS NOT NULL AS commands,
    EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public'
      AND table_name = 'matchmaking_tickets' AND column_name = 'ready') AS ready`);
  if (!Object.values(schema.rows[0]).every(Boolean)) throw new Error("Apply migrations/008_online_play.sql before enabling online play");
  const result = await runOnlineRules({ action: "create", matchId: randomUUID(), seed: 42 });
  if ("error" in result) throw new Error(`Rules engine rejected initialization: ${result.error}`);
  console.log("Online play ready: database schema and TypeScript match initialization passed. No match was saved.");
} catch (error) {
  console.error(`Online play check failed: ${error.message}`);
  process.exitCode = 1;
} finally {
  await db.end();
}
