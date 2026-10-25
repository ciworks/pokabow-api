-- New online matches use a capped pot and server-owned earning limits.
ALTER TABLE online_matches
    ALTER COLUMN gem_policy_version SET DEFAULT 'gem-pot-v2',
    ADD COLUMN gem_pair_eligible BOOLEAN NOT NULL DEFAULT TRUE;

ALTER TABLE online_gem_settlements
    ADD COLUMN pot_a BIGINT CHECK (pot_a >= 0),
    ADD COLUMN pot_b BIGINT CHECK (pot_b >= 0),
    ADD COLUMN completion_a BIGINT CHECK (completion_a >= 0),
    ADD COLUMN completion_b BIGINT CHECK (completion_b >= 0);

CREATE INDEX online_matches_pair_history ON online_matches (completed_at DESC)
    WHERE status = 'completed';
CREATE INDEX gem_transactions_online_daily ON gem_transactions (user_id, created_at DESC)
    WHERE kind IN ('online_pot', 'online_completion');
