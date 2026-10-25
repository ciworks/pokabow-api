import { db } from "../db.js";
import { getActiveDayProgress } from "./engagement-service.js";

export const clientProgressMetrics = ["two_pair_scored", "perfect_match_scored"] as const;
export const achievementMetrics = [...clientProgressMetrics, "active_days", "login_streak"] as const;
export type AchievementMetric = typeof achievementMetrics[number];
export type ProgressEvent = { eventId: string; metric: typeof clientProgressMetrics[number] };

export async function listAchievements(userId: string) {
  const result = await db.query(
    `SELECT a.id, a.name, a.description, a.category, a.metric, a.target,
            a.badge_key AS "badgeKey", ua.unlocked_at IS NOT NULL AS unlocked,
            ua.unlocked_at, COALESCE(p.count, 0)::integer AS progress
     FROM achievements a
     LEFT JOIN user_achievements ua
       ON ua.achievement_id = a.id AND ua.user_id = $1
     LEFT JOIN LATERAL (
       SELECT count(*) AS count FROM achievement_progress_events pe
       WHERE pe.user_id = $1 AND pe.metric = a.metric AND pe.created_at >= a.created_at
     ) p ON true
     WHERE a.enabled
     ORDER BY a.category, a.id`,
    [userId]
  );
  if (!result.rows.some(row => row.metric === "active_days" || row.metric === "login_streak")) {
    return result.rows;
  }
  const activity = await getActiveDayProgress(userId);
  return result.rows.map(row => {
    if (row.metric === "active_days") return { ...row, progress: activity.totalDays };
    if (row.metric === "login_streak") return { ...row, progress: activity.consecutiveDays };
    return row;
  });
}

export async function unlockAchievements(userId: string, achievementIds: string[]) {
  if (achievementIds.length === 0) return { unlocked: [], alreadyUnlocked: [] };
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const known = await client.query(
      "SELECT id FROM achievements WHERE enabled AND metric IS NULL AND id = ANY($1::text[]) ORDER BY id",
      [achievementIds]
    );
    const knownIds = known.rows.map(row => String(row.id));
    const unknown = achievementIds.filter(id => !knownIds.includes(id));
    if (unknown.length > 0) {
      await client.query("ROLLBACK");
      return { error: "UNKNOWN_ACHIEVEMENT", unknown };
    }
    const inserted = await client.query(
      `INSERT INTO user_achievements (user_id, achievement_id)
       SELECT $1, ids.achievement_id
       FROM unnest($2::text[]) AS ids(achievement_id)
       ON CONFLICT (user_id, achievement_id) DO NOTHING
       RETURNING achievement_id`,
      [userId, [...new Set(achievementIds)]]
    );
    const unlocked = inserted.rows.map(row => String(row.achievement_id));
    const alreadyUnlocked = [...new Set(achievementIds)].filter(id => !unlocked.includes(id));
    await client.query("COMMIT");
    return { unlocked, alreadyUnlocked };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

// The client reports committed events. This endpoint is retry-safe, but does not
// independently replay match rules or prove that a submitted event occurred.
export async function recordProgressEvents(userId: string, events: ProgressEvent[]) {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    // Serialize one account's progress and threshold crossing across devices.
    await client.query("SELECT id FROM users WHERE id = $1 FOR UPDATE", [userId]);
    const accepted: string[] = [];
    for (const event of events) {
      const result = await client.query(
        `INSERT INTO achievement_progress_events (user_id, event_id, metric)
         VALUES ($1, $2, $3) ON CONFLICT (user_id, event_id) DO NOTHING
         RETURNING event_id`,
        [userId, event.eventId, event.metric]
      );
      if (result.rowCount) accepted.push(event.eventId);
    }
    const reached = await client.query(
      `INSERT INTO user_achievements (user_id, achievement_id)
       SELECT $1, a.id FROM achievements a
       CROSS JOIN LATERAL (
         SELECT count(*)::integer AS progress
         FROM achievement_progress_events pe
         WHERE pe.user_id = $1 AND pe.metric = a.metric AND pe.created_at >= a.created_at
       ) p
       WHERE a.enabled AND a.metric IS NOT NULL AND p.progress >= a.target
       ON CONFLICT (user_id, achievement_id) DO NOTHING
       RETURNING achievement_id`,
      [userId]
    );
    const unlockedIds = reached.rows.map(row => String(row.achievement_id));
    const details = await client.query(
      `SELECT id, name, description, badge_key AS "badgeKey" FROM achievements WHERE id = ANY($1::text[])`,
      [unlockedIds]
    );
    const counts = await client.query(
      `SELECT metric, count(*)::integer AS progress FROM achievement_progress_events
       WHERE user_id = $1 GROUP BY metric`,
      [userId]
    );
    await client.query("COMMIT");
    return {
      accepted,
      unlocked: unlockedIds,
      unlockedDetails: details.rows,
      counts: Object.fromEntries(counts.rows.map(row => [String(row.metric), Number(row.progress)]))
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function listAdminAchievements() {
  const result = await db.query(
    `SELECT id, name, description, category, metric, target,
            badge_key AS "badgeKey", enabled, created_at
     FROM achievements ORDER BY created_at, id`
  );
  return result.rows;
}

export async function createAchievement(input: {
  id: string; name: string; description: string; category: string;
  metric: AchievementMetric; target: number; badgeKey: string; enabled: boolean;
}) {
  const result = await db.query(
    `INSERT INTO achievements (id, name, description, category, metric, target, badge_key, enabled)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (id) DO NOTHING RETURNING id`,
    [input.id, input.name, input.description, input.category, input.metric,
      input.target, input.badgeKey, input.enabled]
  );
  return result.rowCount === 1;
}

export async function updateAchievementDetails(id: string, input: {
  name: string; description: string; category: string; badgeKey: string; enabled: boolean;
}) {
  const result = await db.query(
    `UPDATE achievements SET name = $2, description = $3, category = $4,
       badge_key = $5, enabled = $6 WHERE id = $1 RETURNING id`,
    [id, input.name, input.description, input.category, input.badgeKey, input.enabled]
  );
  return result.rowCount === 1;
}


