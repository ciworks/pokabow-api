import { db } from "../db.js";

export async function findGameForPlayer(id: string, playerId: string) {
  const result = await db.query(
    `
    SELECT
      games.id,
      games.status,
      games.current_player_id,
      games.version,
      games.state,
      games.created_at,
      games.completed_at
    FROM games
    JOIN game_players ON game_players.game_id = games.id
    WHERE games.id = $1 AND game_players.user_id = $2
    `,
    [id, playerId]
  );

  return result.rows[0] ?? null;
}

export async function findTurn(turnId: string) {
  const result = await db.query(
    `
    SELECT *
    FROM game_turns
    WHERE id = $1
    `,
    [turnId]
  );

  return result.rows[0] ?? null;
}
