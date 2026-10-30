import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import { verify } from "otplib";
import { db } from "../db.js";
import { verifyPassword } from "./password.js";

export type StaffRole = "viewer" | "operator" | "emergency_operator";
export type StaffIdentity = { id: string; email: string; role: StaffRole };
const COOKIE = "pokabow_staff";
const SESSION_MS = 8 * 60 * 60 * 1000;

function sha(value: string) { return createHash("sha256").update(value).digest("hex"); }
function key() {
  const raw = process.env.STAFF_ENCRYPTION_KEY ?? "";
  if (!/^[0-9a-f]{64}$/i.test(raw)) throw new Error("STAFF_ENCRYPTION_KEY must be 32 random bytes in hex");
  return Buffer.from(raw, "hex");
}
export function encryptSecret(secret: string) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  const encrypted = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
  return [iv, cipher.getAuthTag(), encrypted].map(part => part.toString("base64url")).join(".");
}
function decryptSecret(value: string) {
  const [iv, tag, encrypted] = value.split(".").map(part => Buffer.from(part, "base64url"));
  if (!iv || !tag || !encrypted) throw new Error("INVALID_STAFF_SECRET");
  const decipher = createDecipheriv("aes-256-gcm", key(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf8");
}
function csrf(token: string) { return sha(`csrf:${token}`); }
function same(a: string, b: string) {
  const left = Buffer.from(a); const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}
function cookieOptions() {
  return { path: "/admin/api", httpOnly: true, sameSite: "strict" as const,
    secure: process.env.NODE_ENV === "production", maxAge: SESSION_MS / 1000 };
}

export async function loginStaff(email: string, password: string, totp: string, reply: FastifyReply) {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const row = (await client.query<StaffIdentity & { password_hash: string; totp_secret_encrypted: string; totp_last_step: string | null }>(
      `SELECT id,email,role,password_hash,totp_secret_encrypted,totp_last_step
       FROM staff_accounts WHERE email=$1 AND active FOR UPDATE`, [email.toLowerCase()])).rows[0];
    if (!row || !(await verifyPassword(password, row.password_hash))) {
      await client.query("ROLLBACK"); return null;
    }
    let usedRecoveryCode = false;
    if (/^\d{6}$/.test(totp)) {
      const result = await verify({ secret: decryptSecret(row.totp_secret_encrypted), token: totp,
        afterTimeStep: row.totp_last_step === null ? undefined : Number(row.totp_last_step) });
      if (!result.valid || !("timeStep" in result)) { await client.query("ROLLBACK"); return null; }
      await client.query("UPDATE staff_accounts SET totp_last_step=$2 WHERE id=$1", [row.id, result.timeStep]);
    } else {
      const used = await client.query(`UPDATE staff_recovery_codes SET used_at=clock_timestamp()
        WHERE staff_id=$1 AND code_hash=$2 AND used_at IS NULL RETURNING code_hash`,
      [row.id, sha(totp.toLowerCase())]);
      if (!used.rowCount) { await client.query("ROLLBACK"); return null; }
      usedRecoveryCode = true;
    }
    const token = randomBytes(32).toString("base64url");
    await client.query(`INSERT INTO staff_sessions (token_hash,staff_id,csrf_hash,expires_at)
      VALUES ($1,$2,$3,$4)`, [sha(token), row.id, sha(csrf(token)), new Date(Date.now() + SESSION_MS)]);
    await client.query(`INSERT INTO staff_audit (staff_id,action) VALUES ($1,$2)`,
      [row.id, usedRecoveryCode ? "recovery_login" : "login"]);
    await client.query("COMMIT");
    reply.setCookie(COOKIE, token, cookieOptions());
    return { staff: { id: row.id, email: row.email, role: row.role }, csrfToken: csrf(token), usedRecoveryCode };
  } catch (error) { await client.query("ROLLBACK"); throw error; }
  finally { client.release(); }
}

export async function authenticateStaff(request: FastifyRequest, reply: FastifyReply) {
  if (!staffOriginAllowed(request)) return reply.code(403).send({ error: "STAFF_ORIGIN_REQUIRED" });
  const token = request.cookies?.[COOKIE];
  if (!token || token.length > 100) return reply.code(401).send({ error: "STAFF_UNAUTHORIZED" });
  const row = (await db.query<StaffIdentity>(`SELECT a.id,a.email,a.role FROM staff_sessions s
    JOIN staff_accounts a ON a.id=s.staff_id WHERE s.token_hash=$1 AND s.revoked_at IS NULL
    AND s.expires_at>clock_timestamp() AND a.active`, [sha(token)])).rows[0];
  if (!row) return reply.code(401).send({ error: "STAFF_UNAUTHORIZED" });
  request.staff = row;
  request.staffToken = token;
}

export async function requireStaffCsrf(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (!request.staff || !request.staffToken) { reply.code(401).send({ error: "STAFF_UNAUTHORIZED" }); return; }
  if (!staffOriginAllowed(request)) { reply.code(403).send({ error: "STAFF_ORIGIN_REQUIRED" }); return; }
  const supplied = request.headers["x-csrf-token"];
  if (typeof supplied !== "string" || !same(supplied, csrf(request.staffToken)))
    reply.code(403).send({ error: "CSRF_REQUIRED" });
}
export function staffOriginAllowed(request: FastifyRequest) {
  const origin = request.headers.origin;
  if (!origin) return true;
  const allowed = process.env.STAFF_ORIGIN || "http://127.0.0.1:5173";
  return origin === allowed;
}
export async function requireStaffMutation(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  await requireStaffCsrf(request, reply);
  if (!reply.sent && request.staff?.role === "viewer") reply.code(403).send({ error: "STAFF_FORBIDDEN" });
}

export async function verifyEmergencyCode(staffId: string, token: string) {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const row = (await client.query<{ totp_secret_encrypted: string; totp_last_step: string | null }>(
      "SELECT totp_secret_encrypted,totp_last_step FROM staff_accounts WHERE id=$1 AND active AND role='emergency_operator' FOR UPDATE", [staffId])).rows[0];
    if (!row) { await client.query("ROLLBACK"); return false; }
    const result = await verify({ secret: decryptSecret(row.totp_secret_encrypted), token,
      afterTimeStep: row.totp_last_step === null ? undefined : Number(row.totp_last_step) });
    if (!result.valid || !("timeStep" in result)) { await client.query("ROLLBACK"); return false; }
    await client.query("UPDATE staff_accounts SET totp_last_step=$2 WHERE id=$1", [staffId, result.timeStep]);
    await client.query("COMMIT"); return true;
  } catch (error) { await client.query("ROLLBACK"); throw error; }
  finally { client.release(); }
}

export function staffCsrf(token: string) { return csrf(token); }
export async function logoutStaff(token: string, reply: FastifyReply) {
  await db.query("UPDATE staff_sessions SET revoked_at=clock_timestamp() WHERE token_hash=$1", [sha(token)]);
  reply.clearCookie(COOKIE, { path: "/admin/api" });
}
