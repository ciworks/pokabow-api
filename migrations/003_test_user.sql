-- Development/test account. Apply only to databases where this account is wanted.
-- Login: test.user@example.com / TiletopiaTest2026!
INSERT INTO users (email, display_name, password_hash)
VALUES (
  'admin@tiletopia.com',
  'Admin User',
  'scrypt:d545f9031f197c3d051e1c2614dadf61:76e4af8767f9a74771ba203585b0525bc34e21c5d79984add65fcfece32c7514ad7e3ef47a07c3564d047360e9718d4db23cca8f34ed7384d680a36e7d3ec086'
)
ON CONFLICT DO NOTHING;
