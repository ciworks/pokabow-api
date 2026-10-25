export interface TilePlacement {
  tileId: string;
  x: number;
  y: number;
}

export interface SubmitTurnRequest {
  turnId: string;

  // Version the client believes it is playing against.
  expectedVersion: number;

  placements: TilePlacement[];
}

export interface GameState {
  board: unknown;
  tileBag: string[];
  playerRacks: Record<string, string[]>;
}
