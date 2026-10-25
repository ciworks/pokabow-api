CREATE TABLE achievements (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  category TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE user_achievements (
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  achievement_id TEXT NOT NULL REFERENCES achievements(id) ON DELETE CASCADE,
  unlocked_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, achievement_id)
);

INSERT INTO achievements (id, name, description, category) VALUES
  ('first_hand', 'First Deal', 'Score your first poker hand.', 'scoring'),
  ('straight', 'Straight Shooter', 'Score a 3-straight or 4-straight.', 'scoring'),
  ('full_house', 'Full House', 'Score a Full House.', 'scoring'),
  ('edge_cluster', 'Colour Connection', 'Earn an edge-cluster bonus.', 'board'),
  ('ai_victory', 'Table Champion', 'Win a match against the AI.', 'match')
ON CONFLICT (id) DO UPDATE SET
  name = EXCLUDED.name,
  description = EXCLUDED.description,
  category = EXCLUDED.category;
