-- Published tournament terms are immutable. All money and bracket mutations run
-- in the API's database transactions against these server-owned records.
ALTER TABLE gem_transactions DROP CONSTRAINT gem_transactions_kind_check;
ALTER TABLE gem_transactions ADD CONSTRAINT gem_transactions_kind_check
    CHECK (kind IN ('online_pot', 'online_completion', 'verified_ai_pot',
                   'rewarded_ad', 'tournament_entry', 'tournament_refund',
                   'tournament_prize'));
ALTER TABLE gem_transactions DROP CONSTRAINT gem_transactions_amount_check;
ALTER TABLE gem_transactions ADD CONSTRAINT gem_transactions_amount_check CHECK (amount <> 0);

CREATE TABLE tournaments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(80) NOT NULL,
    status TEXT NOT NULL DEFAULT 'draft'
        CHECK (status IN ('draft', 'open', 'live', 'completed', 'cancelled')),
    registration_opens_at TIMESTAMPTZ NOT NULL,
    starts_at TIMESTAMPTZ NOT NULL,
    capacity INTEGER NOT NULL CHECK (capacity IN (4, 8, 16)),
    entry_stake BIGINT NOT NULL CHECK (entry_stake >= 0),
    champion_prize BIGINT NOT NULL CHECK (champion_prize >= 0),
    min_table_level INTEGER NOT NULL DEFAULT 1 CHECK (min_table_level >= 1),
    min_online_wins INTEGER NOT NULL DEFAULT 0 CHECK (min_online_wins >= 0),
    min_gem_balance BIGINT NOT NULL DEFAULT 0 CHECK (min_gem_balance >= 0),
    turn_seconds INTEGER NOT NULL CHECK (turn_seconds IN (60, 120, 300)),
    rules_version INTEGER NOT NULL DEFAULT 1,
    published_rules JSONB,
    published_at TIMESTAMPTZ,
    cancelled_at TIMESTAMPTZ,
    completed_at TIMESTAMPTZ,
    champion_registration_id UUID,
    created_by UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    CHECK (registration_opens_at < starts_at)
);
CREATE INDEX tournaments_public_schedule ON tournaments(starts_at, status);

CREATE TABLE tournament_registrations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tournament_id UUID NOT NULL REFERENCES tournaments(id) ON DELETE RESTRICT,
    user_id UUID REFERENCES users(id) ON DELETE SET NULL,
    request_id UUID NOT NULL,
    public_name VARCHAR(50) NOT NULL,
    status TEXT NOT NULL DEFAULT 'registered'
        CHECK (status IN ('registered', 'playing', 'withdrawn', 'forfeited',
                         'eliminated', 'champion')),
    paid_stake BIGINT NOT NULL CHECK (paid_stake >= 0),
    slot INTEGER,
    registered_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    refunded_at TIMESTAMPTZ,
    UNIQUE (user_id, request_id),
    UNIQUE (tournament_id, slot)
);
CREATE UNIQUE INDEX tournament_one_active_entry ON tournament_registrations(user_id)
    WHERE user_id IS NOT NULL AND status IN ('registered', 'playing');
CREATE INDEX tournament_registrations_event ON tournament_registrations(tournament_id, status);

CREATE TABLE tournament_matches (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tournament_id UUID NOT NULL REFERENCES tournaments(id) ON DELETE RESTRICT,
    round_no INTEGER NOT NULL CHECK (round_no >= 1),
    match_no INTEGER NOT NULL CHECK (match_no >= 1),
    registration_a UUID REFERENCES tournament_registrations(id) ON DELETE RESTRICT,
    registration_b UUID REFERENCES tournament_registrations(id) ON DELETE RESTRICT,
    source_a_done BOOLEAN NOT NULL DEFAULT FALSE,
    source_b_done BOOLEAN NOT NULL DEFAULT FALSE,
    status TEXT NOT NULL DEFAULT 'waiting'
        CHECK (status IN ('waiting', 'ready', 'active', 'completed', 'cancelled')),
    ready_at TIMESTAMPTZ,
    join_deadline_at TIMESTAMPTZ,
    joined_a BOOLEAN NOT NULL DEFAULT FALSE,
    joined_b BOOLEAN NOT NULL DEFAULT FALSE,
    turn_deadline_at TIMESTAMPTZ,
    state JSONB,
    version INTEGER NOT NULL DEFAULT 1,
    replay_count INTEGER NOT NULL DEFAULT 0,
    winner_registration_id UUID REFERENCES tournament_registrations(id) ON DELETE RESTRICT,
    result_kind TEXT,
    decisive_played BOOLEAN NOT NULL DEFAULT FALSE,
    completed_at TIMESTAMPTZ,
    UNIQUE (tournament_id, round_no, match_no)
);
ALTER TABLE tournaments ADD CONSTRAINT tournament_champion_registration_fk
    FOREIGN KEY (champion_registration_id) REFERENCES tournament_registrations(id)
    ON DELETE RESTRICT;
CREATE INDEX tournament_matches_due_join ON tournament_matches(join_deadline_at)
    WHERE status = 'ready';
CREATE INDEX tournament_matches_due_turn ON tournament_matches(turn_deadline_at)
    WHERE status = 'active';

CREATE TABLE tournament_commands (
    match_id UUID NOT NULL REFERENCES tournament_matches(id) ON DELETE RESTRICT,
    command_id UUID NOT NULL,
    user_id UUID REFERENCES users(id) ON DELETE SET NULL,
    payload JSONB NOT NULL,
    accepted_version INTEGER NOT NULL,
    PRIMARY KEY (match_id, command_id)
);
CREATE TABLE tournament_match_awards (
    match_id UUID NOT NULL REFERENCES tournament_matches(id) ON DELETE RESTRICT,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    experience_awarded INTEGER NOT NULL CHECK (experience_awarded >= 0),
    awarded_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (match_id, user_id)
);
CREATE TABLE tournament_admin_audit (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    tournament_id UUID NOT NULL REFERENCES tournaments(id) ON DELETE RESTRICT,
    actor_id UUID REFERENCES users(id) ON DELETE SET NULL,
    action TEXT NOT NULL,
    details JSONB NOT NULL DEFAULT '{}',
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX tournament_admin_audit_event ON tournament_admin_audit(tournament_id, id DESC);
