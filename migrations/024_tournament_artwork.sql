-- Presentation metadata stays separate from published gameplay rules.
-- Empty metadata makes every existing tournament use the bundled default.
ALTER TABLE tournaments ADD COLUMN artwork JSONB NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(artwork) = 'object');

CREATE TABLE tournament_artwork (
    tournament_id UUID NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK (kind IN ('badge', 'background')),
    png BYTEA NOT NULL CHECK (octet_length(png) BETWEEN 1 AND 8388608),
    PRIMARY KEY (tournament_id, kind)
);
