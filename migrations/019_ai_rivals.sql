-- Managed AI identities. Matches snapshot display fields so later edits do not rename past rivals.
CREATE TABLE ai_rivals (
    id TEXT PRIMARY KEY CHECK (id ~ '^rival_(0[1-9]|1[0-5])$'),
    display_name TEXT NOT NULL CHECK (char_length(trim(display_name)) BETWEEN 1 AND 40),
    avatar_key TEXT NOT NULL UNIQUE CHECK (avatar_key ~ '^rival_(0[1-9]|1[0-5])$'),
    difficulty INTEGER NOT NULL CHECK (difficulty BETWEEN 0 AND 2),
    enabled BOOLEAN NOT NULL DEFAULT TRUE,
    sort_order INTEGER NOT NULL UNIQUE,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO ai_rivals (id, display_name, avatar_key, difficulty, sort_order) VALUES
('rival_01', 'Pippa', 'rival_01', 0, 1),
('rival_02', 'Milo', 'rival_02', 0, 2),
('rival_03', 'Nia', 'rival_03', 0, 3),
('rival_04', 'Theo', 'rival_04', 0, 4),
('rival_05', 'Zuri', 'rival_05', 0, 5),
('rival_06', 'Ada', 'rival_06', 1, 6),
('rival_07', 'Hugo', 'rival_07', 1, 7),
('rival_08', 'Iris', 'rival_08', 1, 8),
('rival_09', 'Luca', 'rival_09', 1, 9),
('rival_10', 'Mina', 'rival_10', 1, 10),
('rival_11', 'Arlo', 'rival_11', 2, 11),
('rival_12', 'Cleo', 'rival_12', 2, 12),
('rival_13', 'Kai', 'rival_13', 2, 13),
('rival_14', 'Nova', 'rival_14', 2, 14),
('rival_15', 'Soren', 'rival_15', 2, 15);

ALTER TABLE verified_ai_matches
    ADD COLUMN rival_id TEXT REFERENCES ai_rivals(id),
    ADD COLUMN rival_name TEXT,
    ADD COLUMN rival_avatar_key TEXT;
