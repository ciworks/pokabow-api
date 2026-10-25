-- Server-owned Gems. A pot is match state; only settlement changes a wallet.
CREATE TABLE gem_wallets (
    user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    balance BIGINT NOT NULL DEFAULT 0 CHECK (balance >= 0),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE gem_transactions (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    source_key TEXT NOT NULL,
    match_id UUID,
    kind TEXT NOT NULL CHECK (kind IN ('online_pot', 'online_completion')),
    amount BIGINT NOT NULL CHECK (amount > 0),
    policy_version TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (user_id, source_key)
);
CREATE INDEX gem_transactions_history ON gem_transactions(user_id, id DESC);

CREATE TABLE online_gem_settlements (
    match_id UUID PRIMARY KEY REFERENCES online_matches(id) ON DELETE RESTRICT,
    policy_version TEXT NOT NULL,
    pot_total BIGINT NOT NULL CHECK (pot_total >= 0),
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'confirmed')),
    confirmed_at TIMESTAMPTZ
);

-- The policy is fixed when the online match row is created.
ALTER TABLE online_matches
    ADD COLUMN gem_policy_version TEXT NOT NULL DEFAULT 'gem-pot-v1';
