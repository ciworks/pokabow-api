import type { Pool, PoolClient } from "pg";
import { db } from "../db.js";

export const EXPERIENCE_PER_ONLINE_MATCH = 100;
const SCALE = 173.7178;
const TAU = 0.5;
const EPSILON = 0.000001;

export type Skill = { rating: number; deviation: number; volatility: number; ratedMatches: number };
export const INITIAL_SKILL: Skill = { rating: 1500, deviation: 350, volatility: 0.06, ratedMatches: 0 };

export function levelFromExperience(experience: number): number {
  return Math.floor((1 + Math.sqrt(1 + 8 * experience / EXPERIENCE_PER_ONLINE_MATCH)) / 2);
}

export function experienceForLevel(level: number): number {
  return EXPERIENCE_PER_ONLINE_MATCH * level * (level - 1) / 2;
}

export function tierForSkill(skill: Skill): string {
  if (skill.ratedMatches < 10) return "Provisional";
  if (skill.rating < 1350) return "Novice";
  if (skill.rating < 1650) return "Contender";
  if (skill.rating < 1900) return "Expert";
  return "Master";
}

/** Glicko-2, one completed online match per rating period; both updates use pre-match ratings. */
export function rateMatch(player: Skill, opponent: Skill, score: 0 | 0.5 | 1): Skill {
  const mu = (player.rating - 1500) / SCALE;
  const phi = player.deviation / SCALE;
  const opponentMu = (opponent.rating - 1500) / SCALE;
  const opponentPhi = opponent.deviation / SCALE;
  const g = 1 / Math.sqrt(1 + 3 * opponentPhi ** 2 / Math.PI ** 2);
  const expected = 1 / (1 + Math.exp(-g * (mu - opponentMu)));
  const variance = 1 / (g ** 2 * expected * (1 - expected));
  const delta = variance * g * (score - expected);
  const a = Math.log(player.volatility ** 2);
  const f = (x: number) => {
    const exp = Math.exp(x);
    const sum = phi ** 2 + variance + exp;
    return exp * (delta ** 2 - phi ** 2 - variance - exp) / (2 * sum ** 2) - (x - a) / TAU ** 2;
  };
  let A = a;
  let B: number;
  if (delta ** 2 > phi ** 2 + variance) B = Math.log(delta ** 2 - phi ** 2 - variance);
  else {
    let k = 1;
    while (f(a - k * TAU) < 0) k += 1;
    B = a - k * TAU;
  }
  let fA = f(A);
  let fB = f(B);
  for (let iteration = 0; Math.abs(B - A) > EPSILON && iteration < 100; iteration += 1) {
    const C = A + (A - B) * fA / (fB - fA);
    const fC = f(C);
    if (fC * fB <= 0) { A = B; fA = fB; }
    else fA /= 2;
    B = C;
    fB = fC;
  }
  const volatility = Math.exp(A / 2);
  const phiStar = Math.sqrt(phi ** 2 + volatility ** 2);
  const nextPhi = 1 / Math.sqrt(1 / phiStar ** 2 + 1 / variance);
  const nextMu = mu + nextPhi ** 2 * g * (score - expected);
  return {
    rating: 1500 + SCALE * nextMu,
    deviation: SCALE * nextPhi,
    volatility,
    ratedMatches: player.ratedMatches + 1,
  };
}

export async function awardOnlineMatch(
  client: PoolClient, matchId: string, playerA: string | null, playerB: string | null, outcome: number,
): Promise<void> {
  // INCOMPLETE and deleted-account matches have no trusted two-player result.
  if (!playerA || !playerB || ![1, 2, 3].includes(outcome)) return;
  for (const userId of [playerA, playerB]) {
    await client.query("INSERT INTO player_progression (user_id) VALUES ($1) ON CONFLICT DO NOTHING", [userId]);
    await client.query("INSERT INTO player_skill (user_id) VALUES ($1) ON CONFLICT DO NOTHING", [userId]);
  }
  const inserted = await client.query<{ user_id: string }>(`INSERT INTO player_match_awards
    (match_id, user_id, experience_awarded) VALUES ($1, $2, $4), ($1, $3, $4)
    ON CONFLICT DO NOTHING RETURNING user_id`, [matchId, playerA, playerB, EXPERIENCE_PER_ONLINE_MATCH]);
  if (inserted.rows.length === 0) return;
  if (inserted.rows.length !== 2) throw new Error("Partial online progression award");
  const ratings = await client.query<{ user_id: string; rating: number; deviation: number; volatility: number; rated_matches: number }>(
    "SELECT * FROM player_skill WHERE user_id = ANY($1::uuid[]) ORDER BY user_id FOR UPDATE", [[playerA, playerB]]);
  const pre = new Map(ratings.rows.map(row => [row.user_id, {
    rating: row.rating, deviation: row.deviation, volatility: row.volatility, ratedMatches: row.rated_matches,
  }]));
  const a = pre.get(playerA)!;
  const b = pre.get(playerB)!;
  const nextA = rateMatch(a, b, outcome === 3 ? 0.5 : outcome === 1 ? 1 : 0);
  const nextB = rateMatch(b, a, outcome === 3 ? 0.5 : outcome === 2 ? 1 : 0);
  for (const [userId, next] of [[playerA, nextA], [playerB, nextB]] as const) {
    await client.query(`UPDATE player_skill SET rating = $2, deviation = $3, volatility = $4,
      rated_matches = $5, updated_at = clock_timestamp() WHERE user_id = $1`,
    [userId, next.rating, next.deviation, next.volatility, next.ratedMatches]);
    await client.query(`UPDATE player_progression SET experience = experience + $2,
      updated_at = clock_timestamp() WHERE user_id = $1`, [userId, EXPERIENCE_PER_ONLINE_MATCH]);
  }
}

export async function readProgression(userId: string, pool: Pick<Pool, "query"> = db) {
  const result = await pool.query<{ experience: string | number; rating: number | null; deviation: number | null;
    volatility: number | null; rated_matches: number | null }>(`SELECT COALESCE(p.experience, 0) AS experience,
      s.rating, s.deviation, s.volatility, s.rated_matches FROM users u
      LEFT JOIN player_progression p ON p.user_id = u.id
      LEFT JOIN player_skill s ON s.user_id = u.id WHERE u.id = $1`, [userId]);
  const row = result.rows[0];
  if (!row) return null;
  const experience = Number(row.experience);
  const level = levelFromExperience(experience);
  const skill: Skill = row.rating == null ? INITIAL_SKILL : {
    rating: row.rating, deviation: row.deviation!, volatility: row.volatility!, ratedMatches: row.rated_matches!,
  };
  return { experience, level, levelStartExperience: experienceForLevel(level),
    nextLevelExperience: experienceForLevel(level + 1),
    onlineTier: tierForSkill(skill), ratedMatches: skill.ratedMatches };
}
