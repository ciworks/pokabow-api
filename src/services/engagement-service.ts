import { db } from "../db.js";

export type ActiveDayProgress = { totalDays: number; consecutiveDays: number };

/** A streak remains current through the next UTC day, until that day is missed. */
export function calculateActiveDayProgress(days: readonly string[], today: string): ActiveDayProgress {
  const unique = [...new Set(days)].sort().reverse();
  const dayNumber = (day: string) => Date.parse(`${day}T00:00:00Z`) / 86_400_000;
  const todayNumber = dayNumber(today);
  const latest = unique.length > 0 ? dayNumber(unique[0]) : Number.NaN;
  if (!Number.isFinite(latest) || latest < todayNumber - 1 || latest > todayNumber) {
    return { totalDays: unique.length, consecutiveDays: 0 };
  }
  let consecutiveDays = 0;
  for (const day of unique) {
    if (dayNumber(day) !== latest - consecutiveDays) break;
    consecutiveDays += 1;
  }
  return { totalDays: unique.length, consecutiveDays };
}

export async function getActiveDayProgress(userId: string): Promise<ActiveDayProgress> {
  const result = await db.query<{ day: string }>(
    "SELECT active_day::text AS day FROM account_active_days WHERE user_id = $1 ORDER BY active_day DESC",
    [userId]
  );
  return calculateActiveDayProgress(result.rows.map(row => row.day), new Date().toISOString().slice(0, 10));
}

/** The database clock owns the UTC date; the account row serializes concurrent devices. */
export async function checkIn(userId: string) {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT id FROM users WHERE id = $1 FOR UPDATE", [userId]);
    const today = await client.query<{ day: string }>(
      "SELECT ((NOW() AT TIME ZONE 'UTC')::date)::text AS day"
    );
    const day = today.rows[0].day;
    await client.query(
      "INSERT INTO account_active_days (user_id, active_day) VALUES ($1, $2::date) ON CONFLICT DO NOTHING",
      [userId, day]
    );
    const dates = await client.query<{ day: string }>(
      "SELECT active_day::text AS day FROM account_active_days WHERE user_id = $1 ORDER BY active_day DESC",
      [userId]
    );
    const progress = calculateActiveDayProgress(dates.rows.map(row => row.day), day);
    const reached = await client.query<{ achievement_id: string }>(
      `INSERT INTO user_achievements (user_id, achievement_id)
       SELECT $1, id FROM achievements
       WHERE enabled AND (
         (metric = 'active_days' AND target <= $2)
         OR (metric = 'login_streak' AND target <= $3)
       )
       ON CONFLICT (user_id, achievement_id) DO NOTHING
       RETURNING achievement_id`,
      [userId, progress.totalDays, progress.consecutiveDays]
    );
    const unlocked = reached.rows.map(row => row.achievement_id);
    const details = await client.query(
      `SELECT id, name, description, badge_key AS "badgeKey"
       FROM achievements WHERE id = ANY($1::text[])`,
      [unlocked]
    );
    await client.query("COMMIT");
    return { day, ...progress, unlocked, unlockedDetails: details.rows };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
