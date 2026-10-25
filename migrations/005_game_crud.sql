ALTER TABLE games
  ADD COLUMN created_by UUID REFERENCES users(id) ON DELETE SET NULL;

-- For pre-existing games, use the current player as the best available owner.
UPDATE games
SET created_by = current_player_id
WHERE created_by IS NULL AND current_player_id IS NOT NULL;

CREATE INDEX idx_games_created_by ON games(created_by);
