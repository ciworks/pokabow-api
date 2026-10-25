-- A completed, verified AdMob reward grants 20 Gems at most once per 24 hours.
ALTER TABLE gem_transactions DROP CONSTRAINT gem_transactions_kind_check;
ALTER TABLE gem_transactions ADD CONSTRAINT gem_transactions_kind_check
    CHECK (kind IN ('online_pot', 'online_completion', 'verified_ai_pot', 'rewarded_ad'));

CREATE TABLE rewarded_ad_sessions (
    id UUID PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    confirmed_at TIMESTAMPTZ,
    transaction_id TEXT UNIQUE
);
CREATE INDEX rewarded_ad_sessions_recent ON rewarded_ad_sessions(user_id, confirmed_at DESC)
    WHERE confirmed_at IS NOT NULL;
