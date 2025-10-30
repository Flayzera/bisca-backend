export interface Player {
  id: string;
  nickname: string;
  hand: string[];
  score: number;
  capturedCards: string[]; // Cartas capturadas pelo jogador
  chips?: number; // Fichas acumuladas ao longo do match
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
  // Histórico mínimo para regras de fichas na última vaza
  lastTrickWinnerId?: string;
  lastTrickCards?: TablePlay[];
  // Sinalizadores para regras de fichas
  playedTrumpAByPlayerId?: Record<string, boolean>;
  capturedOppTrump7ByPlayerId?: Record<string, boolean>;
}

export interface RoomMeta {
  id: string;
  capacity: number; // 2 to 4
  ownerId: string; // socket id
  isGameStarted: boolean;
  totalRounds?: number; // Quantidade de rodadas do match
  currentRound?: number; // Rodada atual (1..totalRounds)
}

export interface Room {
  meta: RoomMeta;
  game: GameState;
}
