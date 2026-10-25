# Authoritative live PvP

Apply migration 008_online_play.sql after 007_matchmaking.sql, then run
`npm run start`. The API runs authoritative online rules in TypeScript and does
not need a Godot executable or game checkout.

Run `npm run online:check` before restarting the API. It checks migration 008
and TypeScript match initialization without saving a match. Changes to `.env`
take effect only after restarting the API process.

Historical local activation on 2026-10-13 used Godot 4.6 and a sibling game
checkout, with the API on `192.168.0.215:3000`. The current API no longer uses
those settings.
Two Godot clients in an isolated temporary lobby passed readiness, placement,
board agreement, reconnect and resignation through that running server.
Temporary accounts and the match were removed. Physical-phone validation is
still pending. Local server output is in `.runtime/server.log` and
`.runtime/server-error.log`; the background process ID is in `.runtime/server.pid`.

Online state is isolated from legacy client-owned /games snapshots. The API
preserves the version 3 match snapshot and existing rule version identifiers.
Keep clients on compatible rule versions while matches are active.

Both players POST /matchmaking/tickets/{ticketId}/ready; the final readiness
creates one match with ID equal to the lobby ID. The response and subsequent
heartbeats include status: playing and lobby.matchId. Only the queue's two
accounts can ready up. Leaving or expiry before both are ready prevents startup.

GET /online-games/current returns { match: null | privateState }.
GET /online-games/{matchId} returns the caller's private state. It contains
matchId, version, status, serverTime, deadline, opponent display name and presence,
the public board, own hand, opponent tile count, score ledger, turn, result and
public committed history. Internal human/ai seat names identify first/second
player; both are real accounts. No hidden bag or opponent hand is returned.

POST /online-games/{matchId}/commands accepts one of:

    {"commandId":"<uuid>","expectedVersion":1,"action":"place","placements":[{"tileId":"<own-tile-id>","x":5,"y":5,"rotation":0}]}
    {"commandId":"<uuid>","expectedVersion":1,"action":"swap","tileIds":["<own-tile-id>"]}
    {"commandId":"<uuid>","expectedVersion":1,"action":"resign"}

Rotations are quarter turns 0–3; coordinates are 0–11. Placement legality and
scoring are decided by existing game rules, including opening-hand rules.
The examples describe transport shape, not necessarily a legal opening.

A command returns new private state. HTTP 409 includes error plus current state
for rejected rules, stale versions or command-ID reuse. An identical successful
retry returns current state without applying the command again. HTTP 400 rejects
malformed input; 401 rejects authentication; 404 hides matches from
nonparticipants. Scores, identity, snapshots and timeouts cannot be supplied by
a client command.

The server applies elapsed 60-second deadlines before processing a command.
Timeout transitions persist even when the command subsequently conflicts.
Departure does not pause the clock or automatically forfeit. Resignation and
account deletion end matches using the existing resignation rule.

## Tests

npm test builds and runs route, auth and account tests. Database suites skip
unless their dedicated environment variables are set. Set
ONLINE_TEST_DATABASE_URL to an **empty disposable database**, plus both engine
settings above, then run node --test tests/online-play.test.mjs.
The suite refuses a database already containing public.users.

After that suite, node scripts/smoke-online-http.mjs connects two Godot clients
through a real loopback HTTP server, readies them, submits a legal opening,
compares boards, reconnects and resigns. It requires a local disposable database
named codex_online_<suffix>, clears matchmaking fixtures there and creates then
deletes temporary test accounts. ONLINE_CAPTURE_PATH optionally renders a
360×800 screenshot instead of running headlessly.

Workers time out after 15 seconds and are capped at four per API process.
Ordinary polls do not spawn a worker. Measure worker startup and database-lock
latency under expected load before public hosting; this implementation targets
the first casual live-play delivery.
