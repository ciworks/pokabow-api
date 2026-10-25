extends SceneTree

# Fixture capture helper. Run with --path pointing at the reference game checkout.
func _initialize() -> void:
	var rules: TileGenerationRules = load(GameSessionController.TILE_RULES_RESOURCE)
	var session: GameSessionState = GameSessionState.create(&"00000000-0000-4000-8000-000000000042", 42, ScoringRules.create_default(), rules)
	TurnManager.setup(session)
	var candidates: Array[AiMoveCandidate] = LegalMoveGenerator.generate_with_report(session.get_board(), session.deck_for(&"human"), {}, 1)
	if candidates.is_empty():
		quit(1)
		return
	var placements: Array = []
	for tile: TileSnapshot in candidates[0].snapshots:
		placements.append({"tileId": String(tile.get_tile_id()), "x": tile.get_cell().x, "y": tile.get_cell().y, "rotation": tile.get_rotation()})
	print(JSON.stringify(placements))
	var all_candidates: Array[AiMoveCandidate] = LegalMoveGenerator.generate_with_report(session.get_board(), session.deck_for(&"human"), {}, 1024)
	var keys: Array[String] = []
	for candidate: AiMoveCandidate in all_candidates:
		keys.append(candidate.move_key)
	print("CANDIDATES=" + JSON.stringify(keys))
	quit(0)
