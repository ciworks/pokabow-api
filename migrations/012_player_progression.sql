-- Account progression and uncertainty-aware online skill are separate records.
CREATE TABLE player_progression (
    user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    experience BIGINT NOT NULL DEFAULT 0 CHECK (experience >= 0),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE player_skill (
    user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    rating DOUBLE PRECISION NOT NULL DEFAULT 1500,
    deviation DOUBLE PRECISION NOT NULL DEFAULT 350,
    volatility DOUBLE PRECISION NOT NULL DEFAULT 0.06,
    rated_matches INTEGER NOT NULL DEFAULT 0 CHECK (rated_matches >= 0),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Match IDs make awards idempotent across retries, polls, and reconnects.
CREATE TABLE player_match_awards (
    match_id UUID NOT NULL REFERENCES online_matches(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    experience_awarded INTEGER NOT NULL CHECK (experience_awarded >= 0),
    awarded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (match_id, user_id)
);
