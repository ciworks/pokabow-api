-- Matchmaking is separate from playable games until authoritative PvP exists.
CREATE TABLE matchmaking_lobbies (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    player_a UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    player_b UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CHECK (player_a <> player_b)
);

CREATE TABLE matchmaking_tickets (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    request_id UUID NOT NULL,
    rules_version TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('searching', 'matched', 'cancelled', 'expired', 'opponent_left')),
    lobby_id UUID REFERENCES matchmaking_lobbies(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMPTZ NOT NULL,
    UNIQUE (user_id, request_id)
);

CREATE UNIQUE INDEX matchmaking_one_active_ticket ON matchmaking_tickets(user_id)
    WHERE status IN ('searching', 'matched');
CREATE INDEX matchmaking_waiting ON matchmaking_tickets(rules_version, created_at, id)
    WHERE status = 'searching';
CREATE INDEX matchmaking_lobby_tickets ON matchmaking_tickets(lobby_id);
