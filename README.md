# Tiletopia API

## Setup

`GET /health/ready` returns 200 only while the API can query PostgreSQL;
otherwise it returns 503. The game uses it for a periodic connection warning.

1. Install dependencies with `npm install`.
2. Create a PostgreSQL database and apply the numbered SQL files in `migrations/` in order through `023_staff_admin.sql` (omit optional `003_test_user.sql` outside development). Existing databases should apply missing migrations in order.
3. Set `DATABASE_URL` and `JWT_SECRET` in `.env`. Use a unique random JWT secret of at least 32 bytes. To enable Google sign in, configure a Google OAuth web client and set `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, and `GOOGLE_REDIRECT_URI` (the exact registered callback URL). See `.env.example`.
4. Run `npm run start`. The start script builds the TypeScript code first.

## Demo data

After applying the setup migrations, run `npm run seed:demo` against your local
development database. This creates `demo.player@example.com` (Demo Player) and
`demo.rival@example.com` (Demo Rival), both with password `TiletopiaDemo2026!`.
They share active game `d39c3622-f70c-4bf6-915e-2b4a0ad36819`, with Demo Player
as owner and current player, and both scores starting at zero. Its state contains
an empty board and placeholder tile IDs for API testing, not a playable Polkabow
match snapshot. Demo Player has `first_hand` and `straight` unlocked; Demo Rival
has `first_hand` unlocked. These are account-level sample unlocks.

Repeated runs preserve passwords, game progress, scores, and existing unlock
timestamps. The script refuses conflicting demo account identities or game
membership and only runs against localhost outside production mode.

## Postman

Import `openapi.json` as an OpenAPI specification. The default server is `http://localhost:3000`; update the server URL in Postman if your `PORT` differs. Use `POST /auth/provisional` to get a device session, then set its access token as a Bearer token for protected requests. Legacy password login remains for existing API clients and the optional test-user migration.

## Authentication

The prototype passwordless API requires migration `022_passwordless_sessions.sql`.
`POST /auth/provisional` creates a generated, unverified account and returns an
access token, opaque `refreshToken`, and user profile. `POST /auth/refresh`
accepts `{ "refreshToken": "..." }` and rotates it; `POST /auth/logout` accepts
the same body and revokes that device session. A revoked session's access token
is rejected by protected routes. Renewal tokens expire after 30 days.

`POST /auth/email/change/request` requires a bearer token and `{ "email": "..." }`.
`POST /auth/email/change/confirm` accepts `{ "email": "...", "code": "..." }`.
`POST /auth/email/sign-in/request` accepts an email and gives a generic response;
`POST /auth/email/sign-in/confirm` accepts email and code and returns a new
session. Codes are single use and expire after 10 minutes. The email actions
need `AUTH_EMAIL_WEBHOOK_URL` and `AUTH_EMAIL_WEBHOOK_KEY`; the relay must accept
an HTTPS JSON POST with `to`, `subject`, and `text` fields. Do not expose these
actions to players until delivery is configured and verified. Use TLS for all
authentication traffic outside local development.

Account avatar upload, download, and removal are available at
`PUT/GET/DELETE /auth/me/avatar` with a bearer token. See
[Avatar API and Godot integration](docs/AVATARS.md) for payloads, limits, errors,
and migration instructions.
`GET /auth/opponents/{userId}/avatar` returns a paired online opponent's
avatar while the lobby or match is active; otherwise it returns 404.

- `POST /auth/register`: `{ "email": "player@example.com", "password": "at-least-12-characters", "displayName": "Player" }`. Returns HTTP 201 with a one-hour JWT and user profile.
- `POST /auth/login`: `{ "email": "player@example.com", "password": "at-least-12-characters" }`. Returns a one-hour JWT and user profile.
- `GET /auth/me`: requires `Authorization: Bearer <token>`.
- `GET /auth/google`: starts Google OpenID Connect sign in. The configured callback is `GET /auth/google/callback`; it returns the same `{ token, user }` response as password login. The authorization code exchange uses PKCE and a short lived, HttpOnly state cookie. Google email addresses must be verified. Existing accounts with a matching email are not automatically linked and return `EMAIL_IN_USE`.

`GET /games/:gameId` and `POST /games/:gameId/turns` require the same bearer token. A game can be read only by a player listed in `game_players`; inaccessible games return 404. A turn can be submitted only by a game member whose user ID matches `games.current_player_id`; nonmembers receive 403. The turn request body contains `turnId`, `expectedVersion`, and `placements`. The server takes the player ID from the token, so clients should omit `playerId`.

Game CRUD endpoints use the same bearer token: `POST /games` creates a game with the caller as creator, player, and first player; `GET /games` lists games the caller belongs to; `GET /games/:gameId` reads one; `PATCH /games/:gameId` updates `state` and/or `status` using `expectedVersion`; and `DELETE /games/:gameId` removes the game and its turns/memberships. Only the creator can update or delete. Successful updates increment the version. Status is `active` or `completed`; completing a game sets `completed_at`.

Polkabow clients create one API game per local match, submit committed lines
through `POST /games/:gameId/turns`, then use `PATCH /games/:gameId` to mirror
the full latest local match snapshot and status. The client includes its own
`clientMatchId` and monotonically increasing `syncRevision` inside the JSON
`state` object so it can find the server record and reconcile a lost PATCH
response. This state mirror does not make the API authoritative for game rules
or gameplay restoration.

When the client finds that the current player has no legal move, call `POST /games/:gameId/pass` with a unique `turnId` and the current `expectedVersion`. The API records the pass, changes `games.current_player_id` to the other player, increments the game version, and returns `notification: "No valid move available, now opponents turn"` for the client to show as a toast. The pass endpoint currently supports two player games; the current game engine does not yet provide server side legal move validation.

## Staff support views

Dedicated staff sessions can inspect players and games through read-only routes
under `/admin/api`. These routes require the staff cookie, return `Cache-Control:
no-store`, and do not accept player bearer tokens.

- `GET /admin/api/players?search=&page=` searches by display name, email, or exact
  player ID and returns 25 accounts per page.
- `GET /admin/api/players/{playerId}` returns profile and verification status,
  avatar presence, Gem balance, progression, active session count, and the most
  recent 30 achievements, tournament entries, and Gem transactions.
- `GET /admin/api/games?kind=&playerId=&page=` lists 25 games per page. `kind` is
  `client`, `online`, `ai`, or `tournament`.
- `GET /admin/api/games/{kind}/{gameId}` returns a metadata summary and linked
  players. Client-synced games are unverified. Raw game state and commands are
  intentionally omitted from these support projections.

All pages are capped at page 100. These routes cannot change accounts, sessions,
balances, results, or match state.

## Achievements

`GET /achievements` returns enabled achievement definitions with an
`unlocked` boolean and `unlocked_at` timestamp for the authenticated account.
`POST /achievements/unlocks` accepts `{ "achievementIds": ["first_hand"] }`
and permanently unlocks known IDs. Repeated requests are safe: newly inserted
IDs are returned in `unlocked`, while existing ones are returned in
`alreadyUnlocked`. Unknown IDs reject the whole request. The endpoint authenticates
the account but trusts the game client to report qualifying gameplay; the API
does not yet verify match evidence or replay Polkabow rules.

## Gems

Tournament entry debits, withdrawal/cancellation refunds, and champion prizes are
recorded in the same confirmed wallet ledger. Apply migration 021 before starting
this API version. See [Tournament API](docs/TOURNAMENTS.md) for the player and
administrator endpoints, request bodies, and scheduler behavior.

`GET /gems/me` returns the authenticated account's confirmed integer balance and
up to 50 newest immutable transactions. The match Gem pot is never a balance.
Newly completed authoritative online matches settle the pot and, for a normal
finish, 10 completion Gems per participant in the terminal match transaction.
Resignation grants the opponent the pot only. All normal finishes qualify,
including short matches. Existing completed matches are not backfilled.
Newly created server-verified AI matches credit the human's capped pot on a win
or half on a draw; losses and resignations credit zero. The cap follows the
lowest difficulty used (20/40/80). Existing AI matches and client-supplied
game snapshots are ineligible. Apply migrations 013 through 015 before deploying
this API version.

The optional Shop reward grants 20 Gems after a signed AdMob server-side
verification callback. Apply migration 017, set `ADMOB_REWARDED_AD_UNITS` to the
production Android/iOS rewarded unit IDs, configure each unit's reward amount
as 20, and set its SSV callback URL to
`https://YOUR_API/gems/rewarded-ad/callback`. The client requests an authenticated
session from `POST /gems/rewarded-ad/session` and displays availability from
`GET /gems/rewarded-ad/status`. The server grants at most once per account per
rolling 24 hours. An ad dismissal or unverified client callback grants nothing.

`GET /ai-rivals/` returns the enabled database roster as `{ rivals: [{ id, displayName, avatarKey, difficulty }] }`. The 15 seeded IDs and avatar keys correspond to the bundled cartoon portraits. `POST /ai-games/` with `{ "requestId": "<uuid>", "difficulty": 0|1|2, "rivalId": "rival_01" }`
starts a distinct server-owned AI match. Repeating the same `requestId` returns
that match for safe retry. `GET /ai-games/active` lists every resumable AI match;
`GET /ai-games/current` returns the newest active match and
`GET /ai-games/:matchId` restores a specific private player view. Submit `place`,
`swap`, or `resign` commands to
`POST /ai-games/:matchId/commands` with a UUID `commandId` and
`expectedVersion`. The server validates that the selected rival is enabled and belongs to the requested difficulty. It snapshots the name and avatar key on the match; changing the catalogue later does not rename existing matches. A missing `rivalId` selects a random enabled rival in that tier for older clients. Difficulty commands on roster matches return `RIVAL_DIFFICULTY_FIXED`; legacy matches retain their existing behavior. The server creates the seed, evaluates the human move,
chooses the AI move and preserves the player's turn until a legal action. Apply migrations 014 through 020
before enabling it.

The original user rows have no email or password after migration. They cannot log in until credentials are assigned through a separate account recovery or migration process.

The optional test-user migration creates `test.user@example.com` with password `TiletopiaTest2026!` and display name `Test User`. Do not apply it to a production database. It is safe to rerun; an existing user with that email is left unchanged.

## Matchmaking and lobbies

Apply migrations 007 and 008 before running this version. The authenticated
`/matchmaking` routes pair two accounts into an unranked lobby. Both choose Ready
to start live PvP using server-side Godot rules. Configure the engine and rules
checkout as described in [Online play](docs/ONLINE_PLAY.md).

- `POST /matchmaking/tickets`: `{ "requestId": "<uuid>", "rulesVersion": "pokabow-v3" }`.
  Use one request ID across retries and a new one for each explicit new search.
- `GET /matchmaking/tickets/current`: recover the caller's active ticket (or null).
- `POST /matchmaking/tickets/:ticketId/heartbeat`: renew presence and read status.
- `POST /matchmaking/tickets/:ticketId/ready`: ready up and start when both are ready.
- `DELETE /matchmaking/tickets/:ticketId`: cancel searching or leave the lobby.
- `DELETE /matchmaking/requests/:requestId`: cancel a join whose reply was lost;
  this records a tombstone so a delayed POST cannot recreate the search.

Poll every two seconds. Searching and matched tickets expire after 30 seconds
without renewal. Departures, expiry and account deletion notify the other player
with `opponent_left` on their next heartbeat. Pairing and cancellation serialize
through a PostgreSQL transaction lock shared by all API instances, and a
partial unique index enforces one active ticket per user. Only the caller's
opponent ID and public display name are exposed. Tickets retain terminal states
for idempotency; set a retention policy and public-launch abuse controls before
exposing this queue at scale. See `openapi.json` for response schemas.

`npm test` runs authentication/validation checks. To include concurrent pairing
and lifecycle tests, set `MATCHMAKING_TEST_DATABASE_URL` to an **empty disposable**
PostgreSQL database and run `npm run build` followed by
`node --test tests/matchmaking.test.mjs`. The suite installs its own schema and
refuses a database containing `public.users`; it must not use your application DB.

## Game PATCH database regression test

The game update query explicitly casts the shared status parameter to `varchar`
for both the assignment and completion-time comparison. This prevents PostgreSQL
error `42P08` (`text versus character varying`) without a schema migration.
Restart the API after rebuilding so the running process loads the corrected query.

To run the PostgreSQL regression, set `GAME_CRUD_TEST_DATABASE_URL` to a local
test database, run `npm run build`, then `node --test tests/game-crud.test.mjs`.
It creates only connection-local temporary tables from migrations 001, 002 and
005, with the search path restricted to `pg_temp`; closing the connection removes
them. It covers state-only updates, completion, repeated completion, reopening,
stale versions, ownership and missing games. Without the environment variable,
this database test is skipped by `npm test`.

### Progress milestones and catalogue administration

Apply `migrations/010_achievement_progress.sql` after migration 009 before
running a client that submits progress events. `GET /achievements` now includes
`metric`, `target`, `progress`, and `badgeKey` for each enabled achievement.
`POST /achievements/progress` accepts up to 50 `{ eventId, metric }` records,
where metric is `two_pair_scored` or `perfect_match_scored`. The API stores each
account/event ID once and returns `accepted`, `unlocked`, `unlockedDetails`
(names, descriptions and badge keys), and `counts`. The
client queues stable event IDs offline and retries the same IDs. Progress for a
new catalogue entry includes events received by the API after its creation;
offline events from earlier play may count when later submitted. Stored match
history is not
backfilled. Client reports remain unverified gameplay evidence, as with the
original unlock endpoint.

Achievement catalogue API routes now use dedicated staff sessions under
`/admin/api/achievements`. The older player-email allowlist and HTML page are
retired. Only registered metric types can be selected. Creating an achievement
fixes its ID, metric, target and start date; title, description, category, badge
key and enabled status may be edited. A badge key works only when the game ships
matching artwork; other keys display the generic star.

## Staff administration

Apply migration 023 and set `STAFF_ENCRYPTION_KEY` to 32 random bytes encoded
as 64 hex characters. For the first local staff account, temporarily set
`STAFF_BOOTSTRAP_EMAIL` and `STAFF_BOOTSTRAP_PASSWORD` (16+ characters) and run
`npm run staff:bootstrap`. Add the printed `otpauth://` secret to an authenticator
app, then remove the bootstrap credentials from the environment. Bootstrap
also prints ten single-use recovery codes; save them privately. It refuses to
run once a staff account exists.
If the authenticator is lost or a session must be revoked, use the local
`npm run staff:manage` command with `STAFF_MANAGE_EMAIL`,
`STAFF_MANAGE_PASSWORD` and `STAFF_MANAGE_ACTION` (`reset-totp`, `revoke`, or
`disable`). It revokes active sessions and records the action. Keep these
temporary values out of production environment files after running the command.

Staff sign in at `POST /admin/api/auth/login` with `{ email, password, totp }`.
The `totp` field accepts a six-digit authenticator code or one unused recovery
code. Emergency live cancellation always requires an authenticator code.
The response sets an HttpOnly session cookie and returns a CSRF token. Send that
token in `x-csrf-token` on staff mutations. `GET /admin/api/auth/me` restores
the token after page reload; `POST /admin/api/auth/logout` revokes the session.
Staff routes reject player JWTs. `STAFF_ORIGIN` must match the admin website's
origin (default `http://127.0.0.1:5173` for development). Set `HOST` to the
desired API bind address; it defaults to `0.0.0.0`.

Tournament staff routes are under `/admin/api/tournaments`. Routine cancellation
works for drafts and open events. Cancelling a live tournament requires the
emergency-operator role, a reason of at least 10 characters and a fresh TOTP
code. Completed tournaments cannot be cancelled. The staff website lives in
the sibling `pokabow-admin` project.

### Engagement milestones

Apply `migrations/011_engagement_achievements.sql` before deploying a client that
calls `POST /achievements/check-in`. This authenticated endpoint uses the database
clock to record at most one visit per UTC calendar day and returns the current
total and consecutive-day counts with newly unlocked achievement details. It is
safe to retry after a lost response or from another device. First Login unlocks
on the first recorded authenticated visit, Streak Starter on seven consecutive
UTC days, and Loyal User on 100 distinct UTC days. Existing account creation
dates do not prove earlier visits, so activity before this migration is not
backfilled. The admin catalogue may add more thresholds for `active_days` or
`login_streak`; the client progress endpoint does not accept either metric.

### Table Level and Online Tier

Apply `migrations/012_player_progression.sql` before starting an API build that
uses rating-aware matchmaking. `GET /progression/me` returns the authenticated
player's Table Level, cumulative XP, level boundaries, Online Tier and rated
match count. A completed, server-verified online match awards 100 XP to each
participant, regardless of win, draw or loss. A unique match/player award key
prevents duplicate awards. AI games and achievement submissions award no XP.

Online skill is independent of XP. Glicko-2 updates rating, uncertainty and
volatility after completed online matches; the queue considers rating distance
with a search window that widens while players wait. The opponent's public tier
appears in lobby responses. Tournament and mystery-tile unlock rules are not
implemented. Match lifecycle integration tests require an empty disposable
PostgreSQL database via `MATCHMAKING_TEST_DATABASE_URL`.






