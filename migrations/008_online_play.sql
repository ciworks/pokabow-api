-- Authoritative PvP is intentionally outside the client-owned games table.
CREATE TABLE online_matches (
    id UUID PRIMARY KEY,
    lobby_id UUID NOT NULL UNIQUE,
    player_a UUID REFERENCES users(id) ON DELETE SET NULL,
    player_b UUID REFERENCES users(id) ON DELETE SET NULL,
    state JSONB NOT NULL,
    version INTEGER NOT NULL DEFAULT 1,
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'completed')),
    deadline_at TIMESTAMPTZ,
    last_seen_a TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_seen_b TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    completed_at TIMESTAMPTZ,
    CHECK (player_a IS DISTINCT FROM player_b OR player_a IS NULL)
);
CREATE INDEX online_active_a ON online_matches(player_a) WHERE status = 'active';
CREATE INDEX online_active_b ON online_matches(player_b) WHERE status = 'active';
CREATE TABLE online_commands (
    match_id UUID NOT NULL REFERENCES online_matches(id) ON DELETE CASCADE,
    command_id UUID NOT NULL,
    player_id UUID REFERENCES users(id) ON DELETE SET NULL,
    payload JSONB NOT NULL,
    accepted_version INTEGER NOT NULL,
    PRIMARY KEY (match_id, command_id)
);
ALTER TABLE matchmaking_tickets ADD COLUMN ready BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE matchmaking_tickets DROP CONSTRAINT matchmaking_tickets_status_check;
ALTER TABLE matchmaking_tickets ADD CHECK (status IN
    ('searching', 'matched', 'playing', 'cancelled', 'expired', 'opponent_left'));
DROP INDEX matchmaking_one_active_ticket;
CREATE UNIQUE INDEX matchmaking_one_active_ticket ON matchmaking_tickets(user_id)
    WHERE status IN ('searching', 'matched', 'playing');
