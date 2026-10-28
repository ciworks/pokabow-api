import { db } from "../db.js";
import { handleTournamentAccountDeletion } from "../services/tournament-bracket.js";

export interface UserRecord {
  id: string;
  email: string | null;
  display_name: string;
  password_hash: string | null;
  email_verified: boolean;
}

export async function createUser(email: string, displayName: string, passwordHash: string) {
  const result = await db.query<UserRecord>(
    `INSERT INTO users (email, display_name, password_hash)
     VALUES ($1, $2, $3)
     RETURNING id, email, display_name, password_hash`,
    [email, displayName, passwordHash]
  );
  return result.rows[0];
}

export async function findUserByEmail(email: string) {
  const result = await db.query<UserRecord>(
    `SELECT id, email, display_name, password_hash, email_verified FROM users WHERE email = $1`,
    [email]
  );
  return result.rows[0] ?? null;
}

export async function findUserById(id: string) {
  const result = await db.query<UserRecord>(
    `SELECT id, email, display_name, password_hash, email_verified FROM users WHERE id = $1`,
    [id]
  );
  return result.rows[0] ?? null;
}

export async function updateUserDisplayName(id: string, displayName: string) {
  const result = await db.query<Pick<UserRecord, "id" | "email" | "display_name" | "email_verified">>(
    `UPDATE users SET display_name = $1
     WHERE id = $2 AND (
       lower(btrim(display_name)) = lower(btrim($1))
       OR NOT EXISTS (
         SELECT 1 FROM users AS other
         WHERE other.id <> $2 AND lower(btrim(other.display_name)) = lower(btrim($1))
       )
     )
     RETURNING id, email, display_name, email_verified`,
    [displayName, id]
  );
  return result.rows[0] ?? null;
}

export async function findOrCreateGoogleUser(subject: string, email: string, displayName: string) {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const existing = await client.query<UserRecord>(
      `SELECT u.id, u.email, u.display_name, u.password_hash
       FROM oauth_accounts a JOIN users u ON u.id = a.user_id
       WHERE a.provider = 'google' AND a.provider_subject = $1 FOR UPDATE OF u`,
      [subject]
    );
    if (existing.rows[0]) {
      await client.query("COMMIT");
      return { user: existing.rows[0], emailInUse: false };
    }

    const matchingEmail = await client.query("SELECT id FROM users WHERE email = $1", [email]);
    if (matchingEmail.rows[0]) {
      await client.query("ROLLBACK");
      return { user: null, emailInUse: true };
    }

    const inserted = await client.query<UserRecord>(
      `INSERT INTO users (email, display_name)
       VALUES ($1, $2)
       RETURNING id, email, display_name, password_hash`,
      [email, displayName.slice(0, 50)]
    );
    await client.query(
      `INSERT INTO oauth_accounts (user_id, provider, provider_subject)
       VALUES ($1, 'google', $2)`,
      [inserted.rows[0].id, subject]
    );
    await client.query("COMMIT");
    return { user: inserted.rows[0], emailInUse: false };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}


/** Permanently removes this account and its games, including embedded game state. */
export async function deleteUser(id: string) {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    await handleTournamentAccountDeletion(client, id);
    await client.query("SELECT id FROM users WHERE id = $1 FOR UPDATE", [id]);
    const games = await client.query<{ id: string }>(
      `SELECT id FROM games WHERE created_by = $1 OR current_player_id = $1
       OR id IN (SELECT game_id FROM game_players WHERE user_id = $1)
       OR id IN (SELECT game_id FROM game_turns WHERE player_id = $1)
       ORDER BY id FOR UPDATE`, [id]
    );
    const gameIds = games.rows.map(game => game.id);
    await client.query("DELETE FROM game_turns WHERE game_id = ANY($1::uuid[])", [gameIds]);
    await client.query("DELETE FROM game_players WHERE game_id = ANY($1::uuid[])", [gameIds]);
    await client.query("DELETE FROM games WHERE id = ANY($1::uuid[])", [gameIds]);
    // OAuth identities and achievement unlocks use ON DELETE CASCADE.
    await client.query("DELETE FROM users WHERE id = $1", [id]);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
