import "dotenv/config";
import { db } from "../dist/db.js";
import { buildApp } from "../dist/app.js";

try {
  const schema = await db.query(`SELECT
    to_regclass('public.player_progression') IS NOT NULL AS progression,
    to_regclass('public.player_skill') IS NOT NULL AS skill,
    to_regclass('public.player_match_awards') IS NOT NULL AS awards`);
  if (!Object.values(schema.rows[0]).every(Boolean)) {
    throw new Error("Apply migrations/012_player_progression.sql before enabling progression");
  }
  const counts = await db.query(`SELECT
    (SELECT count(*)::int FROM player_progression) AS players,
    (SELECT count(*)::int FROM player_match_awards) AS awards`);
  console.log(`Progression schema ready; ${counts.rows[0].players} player records and ${counts.rows[0].awards} match awards.`);
  const account = await db.query("SELECT id FROM users ORDER BY created_at LIMIT 1");
  if (account.rows.length > 0) {
    const app = buildApp();
    await app.ready();
    try {
      const token = app.jwt.sign({ sub: account.rows[0].id });
      const response = await app.inject({ method: "GET", url: "/progression/me",
        headers: { Authorization: `Bearer ${token}` } });
      if (response.statusCode !== 200) throw new Error(`Authenticated endpoint returned HTTP ${response.statusCode}`);
      const body = response.json();
      if (body.level < 1 || body.nextLevelExperience <= body.experience || !body.onlineTier) {
        throw new Error("Authenticated endpoint returned invalid progression");
      }
      console.log(`Authenticated progression endpoint ready; level ${body.level}, tier ${body.onlineTier}.`);
    } finally {
      await app.close();
    }
  } else {
    console.log("No account exists for an authenticated progression read.");
  }
} catch (error) {
  console.error(`Progression check failed: ${error.code ?? error.name}: ${error.message}`);
  process.exitCode = 1;
} finally {
  await db.end();
}
