-- Server-owned human-vs-AI play. Client snapshots cannot create a Gem entitlement.
CREATE TABLE verified_ai_matches (
    id UUID PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    state JSONB NOT NULL,
    version INTEGER NOT NULL DEFAULT 1,
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'completed')),
    difficulty INTEGER NOT NULL CHECK (difficulty BETWEEN 0 AND 2),
    reward_difficulty INTEGER NOT NULL CHECK (reward_difficulty BETWEEN 0 AND 2),
    deadline_at TIMESTAMPTZ,
    gem_policy_version TEXT NOT NULL DEFAULT 'ai-gem-pot-v1',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    completed_at TIMESTAMPTZ
);
CREATE INDEX verified_ai_active ON verified_ai_matches(user_id) WHERE status = 'active';
CREATE UNIQUE INDEX verified_ai_one_active ON verified_ai_matches(user_id) WHERE status = 'active';

CREATE TABLE verified_ai_commands (
    match_id UUID NOT NULL REFERENCES verified_ai_matches(id) ON DELETE CASCADE,
    command_id UUID NOT NULL,
    payload JSONB NOT NULL,
    accepted_version INTEGER NOT NULL,
    PRIMARY KEY (match_id, command_id)
);

