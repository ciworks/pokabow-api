ALTER TABLE achievements
  ADD COLUMN IF NOT EXISTS metric TEXT,
  ADD COLUMN IF NOT EXISTS target INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS badge_key TEXT,
  ADD COLUMN IF NOT EXISTS enabled BOOLEAN NOT NULL DEFAULT TRUE;

ALTER TABLE achievements
  ADD CONSTRAINT achievements_target_positive CHECK (target > 0);

CREATE TABLE IF NOT EXISTS achievement_progress_events (
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  event_id TEXT NOT NULL,
  metric TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, event_id)
);

CREATE INDEX IF NOT EXISTS achievement_progress_events_metric_idx
  ON achievement_progress_events (user_id, metric, created_at);

INSERT INTO achievements (id, name, description, category, metric, target, badge_key) VALUES
  ('two_pair_10', 'Two Pair Collector', 'Score 10 Two Pair hands across matches.', 'Hands', 'two_pair_scored', 10, 'two_pair_10'),
  ('perfect_match', 'Perfect Match', 'Score a five-tile Full House containing all four suits with all four internal edges matching.', 'Hands', 'perfect_match_scored', 1, 'perfect_match')
ON CONFLICT (id) DO NOTHING;

