import { db } from "../db.js";

export type AiRival = { id: string; displayName: string; avatarKey: string; difficulty: number };

export async function listAiRivals(): Promise<AiRival[]> {
  const result = await db.query<{ id: string; display_name: string; avatar_key: string; difficulty: number }>(
    `SELECT id, display_name, avatar_key, difficulty FROM ai_rivals
      WHERE enabled = TRUE ORDER BY sort_order, id`);
  return result.rows.map(row => ({ id: row.id, displayName: row.display_name,
    avatarKey: row.avatar_key, difficulty: row.difficulty }));
}
