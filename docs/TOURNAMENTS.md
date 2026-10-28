# Tournament API

Apply `migrations/021_tournaments.sql` after the earlier numbered migrations and
run the API server continuously. Its five-second scheduler starts due full
brackets, cancels and refunds underfilled ones, and resolves join and turn
deadlines. Time decisions use the PostgreSQL server clock. Run only one migration
sequence per database; the scheduler is safe across multiple API instances.

All routes require `Authorization: Bearer <token>`. Player routes are under
`/tournaments`; management routes are under `/admin/api/tournaments` and require
the same `ADMIN_EMAILS` allowlist as achievement administration. Responses carry
`Cache-Control: no-store`. Errors use `{ "error": "CODE" }` and an appropriate
HTTP status. All times are ISO UTC instants; clients should display their local
time and zone.

## Player routes

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/tournaments/` | Published tournaments and the caller's entry summary. |
| GET | `/tournaments/{id}` | Published rules, place count, own entry, eligibility and server time. |
| GET | `/tournaments/{id}/eligibility` | Caller-specific requirements, balance and registration decision. |
| POST | `/tournaments/{id}/register` | Reserve one seat and debit the stake. Body: `{ "requestId": "UUID" }`; retry with the same UUID is safe. |
| POST | `/tournaments/{id}/withdraw` | Full refund before the published start; forfeit afterward. Empty body. |
| GET | `/tournaments/{id}/bracket` | Draw and match state. Before the draw, matches and identities are hidden. |
| GET | `/tournaments/{id}/leaderboard` | Champion and shared round placements. |
| GET | `/tournaments/{id}/entrants/{registrationId}/avatar` | Public PNG after the draw, or 404 if absent. |
| GET | `/tournaments/matches/current` | Caller's current tournament match, if any. |
| GET | `/tournaments/matches/{matchId}` | Caller-private match projection. |
| POST | `/tournaments/matches/{matchId}/join` | Join a ready match within five minutes. Empty body. |
| POST | `/tournaments/matches/{matchId}/commands` | Submit a server-validated move or resignation. |

Command bodies use a UUID `commandId`, integer `expectedVersion`, and an
`action` of `place`, `swap`, or `resign`. A place adds `placements` with `tileId`,
`x`, `y`, and quarter-turn `rotation` (0–3); a swap adds `tileIds`. A repeated
command ID with the same payload returns its previous result. The match view
includes server time and the current deadline so a client can show a countdown.
The server owns the game state; client moves never determine scores or awards.

## Administrator routes

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/admin/api/tournaments/` | List drafts and published tournaments. |
| POST | `/admin/api/tournaments/` | Create draft. |
| GET | `/admin/api/tournaments/{id}` | Rules, entrants, bracket and audit trail. |
| PATCH | `/admin/api/tournaments/{id}` | Replace draft configuration. Published rules are locked. |
| POST | `/admin/api/tournaments/{id}/publish` | Open registration under a versioned rules snapshot. |
| POST | `/admin/api/tournaments/{id}/start` | Start only once the published start time has arrived. |
| POST | `/admin/api/tournaments/{id}/cancel` | Cancel and refund all paid extant accounts once. |

Create and draft update bodies contain `name`, `registrationOpensAt`, `startsAt`,
`capacity` (4, 8, or 16), `entryStake`, `championPrize`, `minTableLevel`,
`minOnlineWins`, `minGemBalance`, and `turnLimitSeconds` (60, 120, or 300).
All numeric amounts are nonnegative integers. Publish, start and cancel use an
empty body. A tournament that does not fill by its scheduled start cancels and
refunds automatically. Entry stakes are spent, not a prize pool. Only the
champion receives the fixed prize, once. A later cancellation refunds stakes
without reversing a confirmed prize or completed XP and rating changes.

The management API is ready for a staff web interface; this repository does not
currently contain that interface. The Godot tournament destination also still
needs to consume these endpoints. The opt-in integration suite runs against an
empty disposable PostgreSQL database with `TOURNAMENT_TEST_DATABASE_URL` set:
`node --test tests/tournaments-postgres.test.mjs`.
