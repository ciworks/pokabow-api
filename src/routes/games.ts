import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { authenticate } from "../auth/authenticate.js";

import {
  submitTurn,
  passTurn,
  GameNotFoundError,
  InvalidTurnError,
  StaleGameError,
  ForbiddenGameError
} from "../services/game-service.js";

import { findGameForPlayer } from "../repositories/game-repository.js";
import {
  createGame,
  deleteGame,
  listGamesForPlayer,
  updateGame,
  CrudGameNotFoundError,
  CrudGameForbiddenError,
  CrudGameVersionError
} from "../services/game-crud-service.js";

const createGameSchema = z.object({
  state: z.record(z.string(), z.unknown()).optional().default({})
});

const updateGameSchema = z.object({
  expectedVersion: z.number().int().positive(),
  state: z.record(z.string(), z.unknown()).optional(),
  status: z.enum(["active", "completed"]).optional()
}).refine(value => value.state !== undefined || value.status !== undefined, {
  message: "At least one of state or status must be provided"
});

const submitTurnSchema = z.object({
  turnId: z.string().uuid(),
  expectedVersion: z.number().int().positive(),

  placements: z.array(
    z.object({
      tileId: z.string(),
      x: z.number().int(),
      y: z.number().int()
    })
  ).min(1)
});

const passTurnSchema = z.object({
  turnId: z.string().uuid(),
  expectedVersion: z.number().int().positive()
});

export async function gameRoutes(
  app: FastifyInstance
) {

  app.addHook("onRequest", authenticate);

  app.post("/", async (request, reply) => {
    const parsed = createGameSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: "INVALID_REQUEST", details: parsed.error.flatten() });
    }
    const game = await createGame(request.user.sub, parsed.data.state);
    return reply.code(201).send(game);
  });

  app.get("/", async request => listGamesForPlayer(request.user.sub));

  app.patch("/:gameId", async (request, reply) => {
    const { gameId } = request.params as { gameId: string };
    const parsed = updateGameSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "INVALID_REQUEST", details: parsed.error.flatten() });
    }
    try {
      return await updateGame(gameId, request.user.sub, parsed.data.expectedVersion, {
        state: parsed.data.state,
        status: parsed.data.status
      });
    } catch (error) {
      if (error instanceof CrudGameNotFoundError) return reply.code(404).send({ error: "GAME_NOT_FOUND" });
      if (error instanceof CrudGameForbiddenError) return reply.code(403).send({ error: "FORBIDDEN" });
      if (error instanceof CrudGameVersionError) return reply.code(409).send({ error: "STALE_GAME_STATE" });
      throw error;
    }
  });

  app.delete("/:gameId", async (request, reply) => {
    const { gameId } = request.params as { gameId: string };
    try {
      await deleteGame(gameId, request.user.sub);
      return reply.code(204).send();
    } catch (error) {
      if (error instanceof CrudGameNotFoundError) return reply.code(404).send({ error: "GAME_NOT_FOUND" });
      if (error instanceof CrudGameForbiddenError) return reply.code(403).send({ error: "FORBIDDEN" });
      throw error;
    }
  });

  app.get("/:gameId", async (request, reply) => {
    const { gameId } = request.params as {
      gameId: string;
    };

    const game = await findGameForPlayer(gameId, request.user.sub);

    if (!game) {
      return reply.code(404).send({
        error: "GAME_NOT_FOUND"
      });
    }

    return game;
  });

  app.post("/:gameId/turns", async (request, reply) => {
    const { gameId } = request.params as {
      gameId: string;
    };

    const parsed = submitTurnSchema.safeParse(
      request.body
    );

    if (!parsed.success) {
      return reply.code(400).send({
        error: "INVALID_REQUEST",
        details: parsed.error.flatten()
      });
    }

    try {
      return await submitTurn(
        gameId,
        parsed.data,
        request.user.sub
      );

    } catch (error) {

      if (error instanceof GameNotFoundError) {
        return reply.code(404).send({
          error: "GAME_NOT_FOUND"
        });
      }

      if (error instanceof StaleGameError) {
        return reply.code(409).send({
          error: "STALE_GAME_STATE"
        });
      }

      if (error instanceof ForbiddenGameError) {
        return reply.code(403).send({ error: "FORBIDDEN" });
      }

      if (error instanceof InvalidTurnError) {
        return reply.code(400).send({
          error: "INVALID_TURN"
        });
      }

      throw error;
    }
  });

  app.post("/:gameId/pass", async (request, reply) => {
    const { gameId } = request.params as { gameId: string };
    const parsed = passTurnSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: "INVALID_REQUEST",
        details: parsed.error.flatten()
      });
    }

    try {
      return await passTurn(gameId, parsed.data.turnId, parsed.data.expectedVersion, request.user.sub);
    } catch (error) {
      if (error instanceof GameNotFoundError) return reply.code(404).send({ error: "GAME_NOT_FOUND" });
      if (error instanceof StaleGameError) return reply.code(409).send({ error: "STALE_GAME_STATE" });
      if (error instanceof ForbiddenGameError) return reply.code(403).send({ error: "FORBIDDEN" });
      if (error instanceof InvalidTurnError) return reply.code(400).send({ error: "INVALID_TURN" });
      throw error;
    }
  });
}
