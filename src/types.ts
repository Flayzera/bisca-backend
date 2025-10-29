export interface Player {
  id: string;
  nickname: string;
  hand: string[];
  score: number;
  capturedCards: string[]; // Cartas capturadas pelo jogador
}

export interface TablePlay {
  playerId: string;
  nickname: string;
  card: string;
}

export interface GameState {
  players: Player[];
  table: TablePlay[];
  turn: number;
  trumpCard: string;
  deck: string[];
  roundNumber: number;
  isGameStarted: boolean;
}
