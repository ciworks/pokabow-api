-- Dedicated staff identity. Legacy player actor columns remain for historical rows.
CREATE TABLE staff_accounts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email VARCHAR(254) NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  totp_secret_encrypted TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('viewer', 'operator', 'emergency_operator')),
  active BOOLEAN NOT NULL DEFAULT TRUE,
  totp_last_step BIGINT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE staff_sessions (
  token_hash TEXT PRIMARY KEY,
  staff_id UUID NOT NULL REFERENCES staff_accounts(id) ON DELETE CASCADE,
  csrf_hash TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  revoked_at TIMESTAMPTZ
);
CREATE INDEX staff_sessions_staff_id_idx ON staff_sessions(staff_id);

CREATE TABLE staff_recovery_codes (
  staff_id UUID NOT NULL REFERENCES staff_accounts(id) ON DELETE CASCADE,
  code_hash TEXT NOT NULL,
  used_at TIMESTAMPTZ,
  PRIMARY KEY (staff_id, code_hash)
);

ALTER TABLE tournaments ADD COLUMN created_by_staff UUID REFERENCES staff_accounts(id) ON DELETE SET NULL;
ALTER TABLE tournament_admin_audit ADD COLUMN staff_actor_id UUID REFERENCES staff_accounts(id) ON DELETE SET NULL;
ALTER TABLE tournament_admin_audit ADD COLUMN reason TEXT;

CREATE TABLE staff_audit (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  staff_id UUID REFERENCES staff_accounts(id) ON DELETE SET NULL,
  action TEXT NOT NULL,
  target_type TEXT,
  target_id TEXT,
  details JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
