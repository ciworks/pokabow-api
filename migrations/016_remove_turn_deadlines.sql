-- Existing active matches remain playable when the move timer is removed.
UPDATE online_matches SET deadline_at = NULL WHERE deadline_at IS NOT NULL;
UPDATE verified_ai_matches SET deadline_at = NULL WHERE deadline_at IS NOT NULL;
