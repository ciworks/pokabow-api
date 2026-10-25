CREATE TABLE IF NOT EXISTS account_active_days (
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  active_day DATE NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, active_day)
);

INSERT INTO achievements (id, name, description, category, metric, target, badge_key) VALUES
  ('first_login', 'First Login', 'Visit Pokabow with your account for the first time.', 'Engagement', 'active_days', 1, 'milestone'),
  ('streak_starter', 'Streak Starter', 'Visit Pokabow on 7 consecutive UTC days.', 'Engagement', 'login_streak', 7, 'milestone'),
  ('loyal_user', 'Loyal User', 'Visit Pokabow on 100 different UTC days.', 'Engagement', 'active_days', 100, 'milestone')
ON CONFLICT (id) DO NOTHING;
