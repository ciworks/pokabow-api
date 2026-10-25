/** Persisted authoritative state and the player-filtered views returned by a rules runner. */
export type RulesState = {
  snapshot: { outcome: number; turn: { active_player_id: string; turn_number: number }; [key: string]: unknown };
  views: Record<string, Record<string, unknown>>;
};
export type RulesResult = RulesState | { error: string };
export type RulesRunner = (request: Record<string, unknown>) => Promise<RulesResult>;
