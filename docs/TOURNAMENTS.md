# Tournament API

## Tournament artwork

**Implemented in source; migration required:** apply
`migrations/024_tournament_artwork.sql` after migration 023. Existing tournaments
start with no custom artwork. No gameplay or wallet data is changed.

Every tournament in player/admin list and detail responses includes:

```json
{
  "artwork": {
    "fallback": "trophy-confetti",
    "badge": null,
    "background": null
  }
}
```

A custom asset replaces its null slot with
`{ "url": "...", "contentType": "image/png", "width": 512, "height": 512, "version": "SHA256" }`.
URLs are API-origin-relative and versioned. Player responses use
`/tournaments/{id}/artwork/{kind}?v={version}`; admin responses use
`/admin/api/tournaments/{id}/artwork/{kind}?v={version}` so drafts can be previewed.
Use the corresponding bearer or staff-cookie authentication. Artwork bytes do
not appear in lists/details.

| Method | Path | Purpose |
| --- | --- | --- |
| PUT | `/admin/api/tournaments/{id}/artwork/{kind}` | Upload or replace draft badge/background. |
| DELETE | `/admin/api/tournaments/{id}/artwork/{kind}` | Remove one draft asset; returns updated artwork metadata. |
| GET | `/admin/api/tournaments/{id}/artwork/{kind}` | Staff preview, including drafts. |
| GET | `/tournaments/{id}/artwork/{kind}` | Authenticated player image read; draft assets return 404. |

`kind` is `badge` or `background`. PUT takes
`{ "contentType": "image/png", "data": "<canonical base64>" }`, also accepting
`image/jpeg`. Upload raw base64 without a data-URI prefix. Both mutations require
a staff operator session and CSRF token; viewers can preview only. Mutations
return `{ "artwork": { ... } }`. Create/update draft configuration bodies remain
unchanged; create the draft first, then upload its assets.

Maximum source size is 2 MiB; each input side must be 32–2048px.
Only single-image PNG/JPEG inputs matching the declared type are accepted.
Images are fully decoded and re-encoded as PNG, removing source metadata,
preserving transparency and aspect ratio, and fitting within 512px for badges
or 1536px for backgrounds without enlargement. Normalized output is capped at
8 MiB. Both assets are optional and independent. Recommended authored assets:
a square transparent badge and a transparent motif with space for panel text.
The client controls background clipping, fade and low opacity; opacity is not
baked into every upload.

The bundled `trophy-confetti` identity is the default, not a remotely uploaded
image. Clients use the built-in trophy for a missing/failed badge and the
built-in trophy/confetti motif for a missing/failed background, independently.
Clients predating this field should continue working; new clients also treat
an absent `artwork` field as the default. The API does not generate background
art from a badge. Upload a coordinated pair for themed tournaments.

Uploads/removals lock the tournament row, commit bytes, metadata and an audit
entry atomically, and are allowed on drafts only, matching existing published
configuration restrictions. They do not increment the gameplay rules version.
Publishing races serialize against artwork changes. Replacing an image changes
its SHA-256 version; a stale version URL returns 404 rather than different bytes.
Reads use `Cache-Control: no-store` and `X-Content-Type-Options: nosniff`.

Errors include `INVALID_REQUEST` (400), `INVALID_ARTWORK` (400),
`INVALID_ARTWORK_DIMENSIONS` (400), `ARTWORK_TOO_LARGE` (413),
`ARTWORK_NOT_FOUND` (404), `TOURNAMENT_NOT_FOUND` (404), and
`PUBLISHED_RULES_LOCKED` (409), plus existing staff-auth/CSRF errors.
An oversized HTTP body also returns the standard Fastify 413 error.

The sibling admin draft editor now provides badge/background file pickers,
a composed panel preview, and independent Remove controls. Upload after draft
creation and save art before publishing. The Godot client loads published
versioned textures and bundles trophy/confetti fallback assets. The backend
provides the contract and storage; it does not ship those UI assets.

Verification on 2026-10-30: TypeScript build passed. The standard API suite passed
48 tests with five opt-in database tests skipped. The tournament PostgreSQL suite
also passed separately in an isolated disposable database, including migration
024, upload/removal, private draft and published image reads, list/detail metadata
consistency, preservation across draft configuration updates, and published
mutation locks alongside the existing registration/bracket/prize/refund lifecycle.
No migration was applied to the application database. Admin/browser and mobile
rendering remain unimplemented and untested for this feature.

Apply `migrations/021_tournaments.sql` after the earlier numbered migrations and
run the API server continuously. Its five-second scheduler starts due full
brackets, cancels and refunds underfilled ones, and resolves join and turn
deadlines. Time decisions use the PostgreSQL server clock. Run only one migration
sequence per database; the scheduler is safe across multiple API instances.

Player routes require `Authorization: Bearer <token>`. Management routes are under
`/admin/api/tournaments` and require a dedicated staff session cookie obtained
through `/admin/api/auth/login`; mutations also require `x-csrf-token`. Responses carry
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
| GET | `/admin/api/tournaments/` | List drafts and published tournaments, 50 per page. Optional `status`, `search`, and `cursor` query parameters. |
| POST | `/admin/api/tournaments/` | Create draft. |
| GET | `/admin/api/tournaments/{id}` | Rules, entrants, bracket and audit trail. |
| GET | `/admin/api/tournaments/{id}/finance` | Staff-only Gem entry, refund and prize totals with reconciliation issues. |
| PATCH | `/admin/api/tournaments/{id}` | Replace draft configuration. Published rules are locked. |
| POST | `/admin/api/tournaments/{id}/publish` | Open registration under a versioned rules snapshot. |
| POST | `/admin/api/tournaments/{id}/start` | Start only once the published start time has arrived. |
| POST | `/admin/api/tournaments/{id}/cancel` | Cancel a draft/open event; live cancellation needs the emergency-operator role, a reason and a fresh `totp` code. Completed events are locked. |

Create and draft update bodies contain `name`, `registrationOpensAt`, `startsAt`,
`capacity` (4, 8, or 16), `entryStake`, `championPrize`, `minTableLevel`,
`minOnlineWins`, `minGemBalance`, and `turnLimitSeconds` (60, 120, or 300).
All numeric amounts are nonnegative integers. Publish and start use an empty
body. Routine cancel accepts `{}`; live cancel requires
`{ "reason": "...", "totp": "123456" }`. A tournament that does not fill by its scheduled start cancels and
refunds automatically. Entry stakes are spent, not a prize pool. Only the
champion receives the fixed prize, once. Emergency cancellation of a live event
refunds paid stakes without reversing completed XP and rating changes.

The management website is in the sibling `pokabow-admin` repository. The Godot tournament destination also still
needs to consume these endpoints. The opt-in integration suite runs against an
empty disposable PostgreSQL database with `TOURNAMENT_TEST_DATABASE_URL` set:
`node --test tests/tournaments-postgres.test.mjs`.
