-- Only AI matches created after this migration may mint spendable Gems.
ALTER TABLE verified_ai_matches
    ADD COLUMN gem_eligible BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE gem_transactions DROP CONSTRAINT gem_transactions_kind_check;
ALTER TABLE gem_transactions ADD CONSTRAINT gem_transactions_kind_check
    CHECK (kind IN ('online_pot', 'online_completion', 'verified_ai_pot'));

CREATE TABLE verified_ai_gem_settlements (
    match_id UUID PRIMARY KEY REFERENCES verified_ai_matches(id) ON DELETE RESTRICT,
    policy_version TEXT NOT NULL,
    pot_total BIGINT NOT NULL CHECK (pot_total >= 0),
    amount BIGINT NOT NULL CHECK (amount >= 0),
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'confirmed')),
    confirmed_at TIMESTAMPTZ
);
