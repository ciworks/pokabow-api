# TypeScript authoritative rules port

The API uses the TypeScript runner in `src/game/online-rules.ts`. Its rule
modules live in `src/game/rules/`. Godot is used only to capture development
reference fixtures and in the optional Godot-client HTTP smoke script.

## Reference contract

`tests/fixtures/online-rules-godot-v3.json` records deterministic Godot outputs
for creation, rejected commands, swapping, resignation, a legal opening, and the
three AI difficulties. Refresh it with `npm run build` followed by
`node scripts/capture-online-rules-fixtures.mjs` while the matching Pokabow
checkout and Godot 4.6 are available. Fixture capture is a development tool;
ordinary builds and tests do not need Godot.

The stored snapshot schema is version 3. It includes the full 52-tile bag and
draw position, decks, committed board, move history, scoring ledger, rule
versions, and turn position. Preserve this format for active matches or introduce
an explicit snapshot migration before switching runners. The `human` and `ai`
seat names are also used for real PvP players, so they must stay stable at the
API boundary.

## Port status

The live runner covers creation, placement, scoring, swapping, resignation,
turn completion, legal moves, and Easy, Medium, and Hard AI. The stored Godot
cases exercise each command, including all three AI difficulties. The runner
checks snapshot rule versions, generated tiles, unique ownership, and board
occupancy before accepting a command.

The fixture suite does not cover every board shape. Differential checks against
the reference worker and database integration tests remain useful release gates
when rules change. The database tests require `ONLINE_TEST_DATABASE_URL`
pointing to a disposable database.
The saved regression fingerprints cover 35 commands across five seeds. The
development comparison script also matched a complete seed 1 match of 36
commands, ending in tile source exhaustion. Run `node scripts/compare-online-rules.mjs`
with the two Godot paths set
only when intentionally checking against the reference checkout.

`npm test` includes the independent port parity tests. Database integration
tests still require their existing disposable database configuration.
