import "dotenv/config";
import { generateSecret, generateURI } from "otplib";
import { createHash, randomBytes } from "node:crypto";
import { db } from "../dist/db.js";
import { encryptSecret } from "../dist/auth/staff.js";
import { verifyPassword } from "../dist/auth/password.js";

const email = process.env.STAFF_MANAGE_EMAIL?.trim().toLowerCase();
const password = process.env.STAFF_MANAGE_PASSWORD;
const action = process.env.STAFF_MANAGE_ACTION;
if (!email || !password || !["revoke", "reset-totp", "disable"].includes(action))
  throw new Error("Set STAFF_MANAGE_EMAIL, STAFF_MANAGE_PASSWORD and STAFF_MANAGE_ACTION (revoke, reset-totp or disable)");

const client = await db.connect();
try {
  await client.query("BEGIN");
  const staff = (await client.query("SELECT id,password_hash FROM staff_accounts WHERE email=$1 FOR UPDATE", [email])).rows[0];
  if (!staff || !(await verifyPassword(password, staff.password_hash))) throw new Error("Invalid staff credentials");
  let uri;
  let recoveryCodes = [];
  if (action === "reset-totp") {
    const secret = generateSecret();
    uri = generateURI({ issuer: "Pokabow Admin", label: email, secret });
    await client.query("UPDATE staff_accounts SET totp_secret_encrypted=$2,totp_last_step=NULL WHERE id=$1",
      [staff.id, encryptSecret(secret)]);
    await client.query("DELETE FROM staff_recovery_codes WHERE staff_id=$1", [staff.id]);
    recoveryCodes = Array.from({ length: 10 }, () => randomBytes(8).toString("hex"));
    for (const code of recoveryCodes) await client.query(`INSERT INTO staff_recovery_codes (staff_id,code_hash)
      VALUES ($1,$2)`, [staff.id, createHash("sha256").update(code).digest("hex")]);
  }
  if (action === "disable") await client.query("UPDATE staff_accounts SET active=FALSE WHERE id=$1", [staff.id]);
  await client.query("UPDATE staff_sessions SET revoked_at=clock_timestamp() WHERE staff_id=$1 AND revoked_at IS NULL", [staff.id]);
  await client.query("INSERT INTO staff_audit (staff_id,action) VALUES ($1,$2)", [staff.id, `cli_${action}`]);
  await client.query("COMMIT");
  console.log(`Staff action completed: ${action}`);
  if (uri) {
    console.log("Add this new secret to your authenticator app:"); console.log(uri);
    console.log("Save these new one-use recovery codes privately:");
    for (const code of recoveryCodes) console.log(code);
  }
} catch (error) { await client.query("ROLLBACK"); throw error; }
finally { client.release(); await db.end(); }
