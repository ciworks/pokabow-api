ALTER TABLE users
  ADD COLUMN email VARCHAR(254),
  ADD COLUMN password_hash TEXT;

CREATE UNIQUE INDEX users_email_unique
  ON users (email) WHERE email IS NOT NULL;
