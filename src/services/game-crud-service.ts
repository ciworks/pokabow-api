import { db } from "../db.js";

export class CrudGameNotFoundError extends Error {}
export class CrudGameForbiddenError extends Error {}
export class CrudGameVersionError extends Error {}

const gameSelect = `id, status, current_player_id, created_by, version, state, created_at, completed_at`;

export async function createGame(playerId: string, state: Record<string, unknown>) {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const result = await client.query(
      `INSERT INTO games (status, current_player_id, created_by, state)
       VALUES ('active', $1, $1, $2)
       RETURNING ${gameSelect}`,
      [playerId, JSON.stringify(state)]
    );
    const game = result.rows[0];
    await client.query(
      "INSERT INTO game_players (game_id, user_id) VALUES ($1, $2)",
      [game.id, playerId]
    );
    await client.query("COMMIT");
    return game;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function listGamesForPlayer(playerId: string) {
  const result = await db.query(
    `SELECT ${gameSelect} FROM games
     JOIN game_players ON game_players.game_id = games.id
     WHERE game_players.user_id = $1
     ORDER BY games.created_at DESC`,
    [playerId]
  );
  return result.rows;
}

export async function updateGame(
  gameId: string,
  playerId: string,
  expectedVersion: number,
  changes: { state?: Record<string, unknown>; status?: "active" | "completed" }
) {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const found = await client.query(
      `SELECT ${gameSelect} FROM games WHERE id = $1 FOR UPDATE`,
      [gameId]
    );
    const game = found.rows[0];
    if (!game) throw new CrudGameNotFoundError();
    if (game.created_by !== playerId) throw new CrudGameForbiddenError();
    if (game.version !== expectedVersion) throw new CrudGameVersionError();

    const state = changes.state === undefined ? game.state : JSON.stringify(changes.state);
    const status = changes.status ?? game.status;
    const updated = await client.query(
      `UPDATE games
       SET state = $1, status = $2::varchar, version = version + 1,
           completed_at = CASE WHEN $2::varchar = 'completed' THEN COALESCE(completed_at, NOW()) ELSE NULL END
       WHERE id = $3
       RETURNING ${gameSelect}`,
      [state, status, gameId]
    );
    await client.query("COMMIT");
    return updated.rows[0];
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function deleteGame(gameId: string, playerId: string) {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const found = await client.query(
      "SELECT created_by FROM games WHERE id = $1 FOR UPDATE",
      [gameId]
    );
    if (!found.rows[0]) throw new CrudGameNotFoundError();
    if (found.rows[0].created_by !== playerId) throw new CrudGameForbiddenError();

    await client.query("DELETE FROM game_turns WHERE game_id = $1", [gameId]);
    await client.query("DELETE FROM game_players WHERE game_id = $1", [gameId]);
    await client.query("DELETE FROM games WHERE id = $1", [gameId]);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
