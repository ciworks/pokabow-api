import { db } from "../db.js";

interface AvatarRecord {
  png: Buffer;
  updated_at: Date;
}

export async function saveAvatar(userId: string, png: Buffer) {
  // Lock the account until the upsert completes, including during account deletion.
  const result = await db.query<{ updated_at: Date }>(
    `WITH account AS (SELECT id FROM users WHERE id = $1 FOR KEY SHARE)
     INSERT INTO user_avatars (user_id, png)
     SELECT id, $2 FROM account
     ON CONFLICT (user_id) DO UPDATE SET png = EXCLUDED.png, updated_at = NOW()
     RETURNING updated_at`,
    [userId, png]
  );
  return result.rows[0] ?? null;
}

export async function findAvatar(userId: string) {
  const result = await db.query<AvatarRecord>(
    "SELECT png, updated_at FROM user_avatars WHERE user_id = $1", [userId]
  );
  return result.rows[0] ?? null;
}

export async function deleteAvatar(userId: string) {
  await db.query("DELETE FROM user_avatars WHERE user_id = $1", [userId]);
}
