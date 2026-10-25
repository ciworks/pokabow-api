extends SceneTree

# Development-only candidate comparison against the reference game.
func _initialize() -> void:
	var args: PackedStringArray = OS.get_cmdline_user_args()
	var input: FileAccess = FileAccess.open(args[0], FileAccess.READ)
	var request: Dictionary = JSON.parse_string(input.get_as_text())
	input.close()
	var rules: TileGenerationRules = load(GameSessionController.TILE_RULES_RESOURCE)
	var session: GameSessionState = GameSessionState.from_snapshot(
		MatchSnapshotDto.from_dictionary(request.snapshot), ScoringRules.create_default(), rules
	)
	var candidates: Array[AiMoveCandidate] = LegalMoveGenerator.generate_with_report(
		session.get_board(), session.deck_for(StringName(request.seat)), {}, 1024
	)
	var keys: Array[String] = []
	for candidate: AiMoveCandidate in candidates:
		keys.append(candidate.move_key)
	print("CANDIDATES=" + JSON.stringify(keys))
	quit(0)
