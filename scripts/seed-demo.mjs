import "dotenv/config";
import pg from "pg";
import { hashPassword, verifyPassword } from "../dist/auth/password.js";

const connectionString = process.env.DATABASE_URL ?? "postgres://postgres:example@localhost:5432/tilegame";
const target = new URL(connectionString);
if (process.env.NODE_ENV === "production" || !["localhost", "127.0.0.1", "[::1]"].includes(target.hostname)) {
  throw new Error("Demo data is restricted to a local development database.");
}

const password = "TiletopiaDemo2026!";
const gameId = "d39c3622-f70c-4bf6-915e-2b4a0ad36819";
const accounts = [
  { id: "c264781a-ad51-456c-a74c-014eaa809e24", email: "demo.player@example.com", name: "Demo Player", achievements: ["first_hand", "straight"] },
  { id: "b9f51d12-41a5-4ec3-9541-15d1e23da40a", email: "demo.rival@example.com", name: "Demo Rival", achievements: ["first_hand"] }
];

const db = new pg.Client({ connectionString, connectionTimeoutMillis:5000 });
try {
  await db.connect();
  await db.query("BEGIN");
  // Serialize repeated seed runs and preserve any subsequent demo gameplay.
  await db.query("SELECT pg_advisory_xact_lock(78432291)");
  for (const account of accounts) {
    await db.query(
      `INSERT INTO users (id, email, display_name, password_hash)
       VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`,
      [account.id, account.email, account.name, await hashPassword(password)]
    );
    const existing = await db.query("SELECT id, email, password_hash FROM users WHERE id = $1", [account.id]);
    const user = existing.rows[0];
    if (!user || user.email !== account.email || !user.password_hash || !await verifyPassword(password, user.password_hash)) {
      throw new Error(`Demo account conflicts with an existing account: ${account.email}`);
    }
  }

  const [player, rival] = accounts;
  const state = {
    demo: true,
    board: [],
    tileBag: ["demo-tile-7", "demo-tile-8", "demo-tile-9"],
    playerRacks: {
      [player.id]: ["demo-tile-1", "demo-tile-2", "demo-tile-3"],
      [rival.id]: ["demo-tile-4", "demo-tile-5", "demo-tile-6"]
    }
  };
  const inserted = await db.query(
    `INSERT INTO games (id, status, current_player_id, created_by, version, state)
     VALUES ($1, 'active', $2, $2, 1, $3) ON CONFLICT (id) DO NOTHING RETURNING id`,
    [gameId, player.id, JSON.stringify(state)]
  );
  if (inserted.rowCount) {
    for (const account of accounts) {
      await db.query("INSERT INTO game_players (game_id, user_id, score) VALUES ($1, $2, 0)", [gameId, account.id]);
    }
  } else {
    const existing = await db.query("SELECT created_by, state FROM games WHERE id = $1", [gameId]);
    const members = await db.query("SELECT user_id FROM game_players WHERE game_id = $1", [gameId]);
    if (existing.rows[0]?.created_by !== player.id || existing.rows[0]?.state?.demo !== true ||
        members.rowCount !== 2 || !accounts.every(account => members.rows.some(row => row.user_id === account.id))) {
      throw new Error("Existing demo game has conflicting ownership, state, or membership.");
    }
  }

  for (const account of accounts) {
    for (const achievementId of account.achievements) {
      await db.query(
        `INSERT INTO user_achievements (user_id, achievement_id) VALUES ($1, $2)
         ON CONFLICT (user_id, achievement_id) DO NOTHING`,
        [account.id, achievementId]
      );
    }
  }
  await db.query("COMMIT");
  console.log(JSON.stringify({ database: target.pathname.slice(1), gameId, accounts, password }, null, 2));
} catch (error) {
  await db.query("ROLLBACK").catch(() => {});
  console.error(error.message);
  process.exitCode = 1;
} finally {
  await db.end();
}
