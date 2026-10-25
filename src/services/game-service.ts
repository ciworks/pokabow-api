import { db } from "../db.js";
import type { SubmitTurnRequest } from "../types/game.js";

export class GameNotFoundError extends Error {}
export class InvalidTurnError extends Error {}
export class StaleGameError extends Error {}
export class ForbiddenGameError extends Error {}

export async function submitTurn(
  gameId: string,
  input: SubmitTurnRequest,
  playerId: string
) {
  const client = await db.connect();

  try {
    await client.query("BEGIN");

    // Lock the game while processing this turn.
    const gameResult = await client.query(
      `
      SELECT *
      FROM games
      WHERE id = $1
      FOR UPDATE
      `,
      [gameId]
    );

    const game = gameResult.rows[0];

    if (!game) {
      throw new GameNotFoundError();
    }

    const membership = await client.query(
      `SELECT 1 FROM game_players WHERE game_id = $1 AND user_id = $2`,
      [gameId, playerId]
    );
    if (!membership.rowCount) {
      throw new ForbiddenGameError();
    }

    /*
     * Idempotency check.
     *
     * Mobile client may have successfully submitted the
     * turn but lost its connection before receiving the
     * response.
     */
    const existingTurn = await client.query(
      `
      SELECT *
      FROM game_turns
      WHERE id = $1 AND game_id = $2 AND player_id = $3
      `,
      [input.turnId, gameId, playerId]
    );

    if (existingTurn.rowCount) {
      await client.query("COMMIT");

      return {
        accepted: true,
        duplicate: true,
        score: existingTurn.rows[0].score,
        gameVersion: game.version
      };
    }

    if (game.version !== input.expectedVersion) {
      throw new StaleGameError(
        `Expected version ${input.expectedVersion}, current version ${game.version}`
      );
    }

    if (game.current_player_id !== playerId) {
      throw new InvalidTurnError("It is not this player's turn");
    }

    /*
     * THIS is where your actual game engine eventually goes.
     *
     * validateMove(game.state, input.placements)
     * calculateScore(...)
     * drawReplacementTiles(...)
     * determineNextPlayer(...)
     */

    const score = calculateTemporaryScore(input);

    const turnNumberResult = await client.query(
      `
      SELECT COUNT(*)::integer AS count
      FROM game_turns
      WHERE game_id = $1
      `,
      [gameId]
    );

    const turnNumber =
      turnNumberResult.rows[0].count + 1;

    await client.query(
      `
      INSERT INTO game_turns (
        id,
        game_id,
        player_id,
        turn_number,
        score,
        move
      )
      VALUES ($1, $2, $3, $4, $5, $6)
      `,
      [
        input.turnId,
        gameId,
        playerId,
        turnNumber,
        score,
        JSON.stringify({
          placements: input.placements
        })
      ]
    );

    await client.query(
      `
      UPDATE game_players
      SET score = score + $1
      WHERE game_id = $2
        AND user_id = $3
      `,
      [
        score,
        gameId,
        playerId
      ]
    );

    const newVersion = game.version + 1;

    await client.query(
      `
      UPDATE games
      SET version = $1
      WHERE id = $2
      `,
      [newVersion, gameId]
    );

    await client.query("COMMIT");

    return {
      accepted: true,
      duplicate: false,
      score,
      gameVersion: newVersion
    };

  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function passTurn(gameId: string, turnId: string, expectedVersion: number, playerId: string) {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const gameResult = await client.query(
      "SELECT * FROM games WHERE id = $1 FOR UPDATE",
      [gameId]
    );
    const game = gameResult.rows[0];
    if (!game) throw new GameNotFoundError();

    const membership = await client.query(
      "SELECT 1 FROM game_players WHERE game_id = $1 AND user_id = $2",
      [gameId, playerId]
    );
    if (!membership.rowCount) throw new ForbiddenGameError();

    const existingTurn = await client.query(
      "SELECT * FROM game_turns WHERE id = $1 AND game_id = $2 AND player_id = $3",
      [turnId, gameId, playerId]
    );
    if (existingTurn.rowCount) {
      await client.query("COMMIT");
      return {
        accepted: true,
        duplicate: true,
        passed: true,
        notification: "No valid move available, now opponents turn",
        gameVersion: game.version
      };
    }

    if (game.version !== expectedVersion) {
      throw new StaleGameError(`Expected version ${expectedVersion}, current version ${game.version}`);
    }
    if (game.current_player_id !== playerId) {
      throw new InvalidTurnError("It is not this player's turn");
    }

    const opponents = await client.query(
      "SELECT user_id FROM game_players WHERE game_id = $1 AND user_id <> $2",
      [gameId, playerId]
    );
    if (opponents.rowCount !== 1) {
      throw new InvalidTurnError("A pass turn requires exactly two players");
    }

    const turnNumberResult = await client.query(
      "SELECT COUNT(*)::integer AS count FROM game_turns WHERE game_id = $1",
      [gameId]
    );
    const turnNumber = turnNumberResult.rows[0].count + 1;
    await client.query(
      `INSERT INTO game_turns (id, game_id, player_id, turn_number, score, move)
       VALUES ($1, $2, $3, $4, 0, $5)`,
      [turnId, gameId, playerId, turnNumber, JSON.stringify({ pass: true })]
    );

    const newVersion = game.version + 1;
    const nextPlayerId = opponents.rows[0].user_id;
    await client.query(
      "UPDATE games SET current_player_id = $1, version = $2 WHERE id = $3",
      [nextPlayerId, newVersion, gameId]
    );
    await client.query("COMMIT");

    return {
      accepted: true,
      duplicate: false,
      passed: true,
      notification: "No valid move available, now opponents turn",
      currentPlayerId: nextPlayerId,
      gameVersion: newVersion
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

function calculateTemporaryScore(
  input: SubmitTurnRequest
): number {
  // Placeholder until your scoring engine exists.
  return input.placements.length * 5;
}
