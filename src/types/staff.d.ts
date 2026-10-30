import "fastify";
import type { StaffIdentity } from "../auth/staff.js";

declare module "fastify" {
  interface FastifyRequest {
    staff?: StaffIdentity;
    staffToken?: string;
  }
}
