import { findUserById } from "../repositories/user-repository.js";
import type { FastifyReply, FastifyRequest } from "fastify";

export async function verifyIdentity(request: FastifyRequest, reply: FastifyReply) {
  try {
    await request.jwtVerify();
    if (typeof request.user.sub !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(request.user.sub)) {
      return reply.code(401).send({ error: "UNAUTHORIZED" });
    }
  } catch {
    return reply.code(401).send({ error: "UNAUTHORIZED" });
  }
}


export async function authenticate(request: FastifyRequest, reply: FastifyReply) {
  await verifyIdentity(request, reply);
  if (reply.sent) return;
  // A signed token cannot keep a deleted account alive.
  if (!(await findUserById(request.user.sub))) {
    return reply.code(401).send({ error: "UNAUTHORIZED" });
  }
}
