import "dotenv/config";
import { generateSecret, generateURI } from "otplib";
import { createHash, randomBytes } from "node:crypto";
import { db } from "../dist/db.js";
import { hashPassword } from "../dist/auth/password.js";
import { encryptSecret } from "../dist/auth/staff.js";

const email = process.env.STAFF_BOOTSTRAP_EMAIL?.trim().toLowerCase();
const password = process.env.STAFF_BOOTSTRAP_PASSWORD;
if (!email || !password || password.length < 16) {
  throw new Error("Set STAFF_BOOTSTRAP_EMAIL and STAFF_BOOTSTRAP_PASSWORD (16+ characters)");
}

const client = await db.connect();
try {
  await client.query("BEGIN");
  const found = await client.query("SELECT count(*)::int AS count FROM staff_accounts");
  if (found.rows[0].count !== 0) throw new Error("Staff account already exists; bootstrap is disabled");
  const secret = generateSecret();
  const uri = generateURI({ issuer: "Pokabow Admin", label: email, secret });
  const staff = (await client.query(`INSERT INTO staff_accounts (email,password_hash,totp_secret_encrypted,role)
    VALUES ($1,$2,$3,'emergency_operator') RETURNING id`,
  [email, await hashPassword(password), encryptSecret(secret)])).rows[0];
  const recoveryCodes = Array.from({ length: 10 }, () => randomBytes(8).toString("hex"));
  for (const code of recoveryCodes) await client.query(`INSERT INTO staff_recovery_codes (staff_id,code_hash)
    VALUES ($1,$2)`, [staff.id, createHash("sha256").update(code).digest("hex")]);
  await client.query("COMMIT");
  console.log("Add this account to your authenticator app:");
  console.log(uri);
  console.log("Save these one-use recovery codes in a private place:");
  for (const code of recoveryCodes) console.log(code);
  console.log("Keep the authenticator secret and recovery codes private. Remove bootstrap credentials from the environment after setup.");
} catch (error) {
  await client.query("ROLLBACK");
  throw error;
} finally {
  client.release();
  await db.end();
}
