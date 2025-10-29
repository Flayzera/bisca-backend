import { GameState } from "./types";

const SUITS = ['S', 'H', 'D', 'C'];
const VALUES = ['A', '2', '3', '4', '5', '6', '7', 'J', 'Q', 'K'];

const CARD_POINTS: Record<string, number> = {
  '7': 11,
  'A': 10,
  'J': 3,
  'Q': 2,
  'K': 4,
};

export function createDeck(): string[] {
  const deck: string[] = [];
  for (const suit of SUITS) {
    for (const value of VALUES) {
      deck.push(value + suit);
    }
  }
  return deck;
}

export function shuffleDeck(deck: string[]): string[] {
  const shuffled = [...deck];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled;
}

export function createGame(): GameState {
  return {
    players: [],
    table: [],
    turn: 0,
    trumpCard: '',
    deck: [],
    roundNumber: 0,
    isGameStarted: false,
  };
}

export function startGame(game: GameState): GameState {
  if (game.players.length < 2 || game.players.length > 4) return game;
  
  const shuffled = shuffleDeck(createDeck());
  const trumpCard = shuffled[0];
  const deck = shuffled.slice(1); // remove trump from the dealing deck
  
  const numPlayers = game.players.length;
  const cardsPerPlayer = 10;
  const totalToDeal = numPlayers * cardsPerPlayer;
  
  // Round-robin dealing to balance distribution
  const hands: string[][] = Array.from({ length: numPlayers }, () => []);
  for (let i = 0; i < totalToDeal; i++) {
    const playerIdx = i % numPlayers;
    hands[playerIdx].push(deck[i]);
  }
  
  const newPlayers = game.players.map((player, index) => {
    return { ...player, hand: hands[index], score: 0, capturedCards: [] };
  });
  
  const remainingDeck = deck.slice(totalToDeal);
  
  return {
    ...game,
    players: newPlayers,
    trumpCard,
    deck: remainingDeck,
    turn: 0,
    roundNumber: 1,
    isGameStarted: true,
    table: [],
  };
}

function getCardValue(card: string): string {
  return card.slice(0, -1);
}

function getCardSuit(card: string): string {
  return card.slice(-1);
}

function getTrumpSuit(card: string): string {
  return card.slice(-1);
}

function getCardPoints(card: string): number {
  const value = getCardValue(card);
  return CARD_POINTS[value] || 0;
}

function isMarriage(sevenCard: string, aceCard: string): boolean {
  const sevenSuit = getCardSuit(sevenCard);
  const aceSuit = getCardSuit(aceCard);
  const aceValue = getCardValue(aceCard);
  return sevenSuit === aceSuit && aceValue === 'A';
}

// Ordem de valores: A > 7 > K > J > Q > 6 > 5 > 4 > 3 > 2
function getCardOrder(value: string): number {
  const order: Record<string, number> = {
    'A': 10,
    '7': 9,
    'K': 8,
    'J': 7,
    'Q': 6,
    '6': 5,
    '5': 4,
    '4': 3,
    '3': 2,
    '2': 1,
  };
  return order[value] || 0;
}

export function determineRoundWinner(game: GameState): number | null {
  if (game.table.length === 0) return null;
  if (game.table.length < game.players.length) return null;
  
  const trumpSuit = getTrumpSuit(game.trumpCard);
  let winner = 0;
  let highestCard = game.table[0].card;
  const firstCardSuit = getCardSuit(game.table[0].card);
  
  for (let i = 1; i < game.table.length; i++) {
    const currentCard = game.table[i].card;
    const currentValue = getCardValue(currentCard);
    const highestValue = getCardValue(highestCard);
    
    if (highestValue === '7' && currentValue === 'A' && isMarriage(highestCard, currentCard)) {
      winner = i;
      highestCard = currentCard;
      continue;
    }
    if (currentValue === '7' && highestValue === 'A' && isMarriage(currentCard, highestCard)) {
      continue;
    }
    
    const currentSuit = getCardSuit(currentCard);
    const highestSuit = getCardSuit(highestCard);
    
    const isCurrentTrump = currentSuit === trumpSuit;
    const isHighestTrump = highestSuit === trumpSuit;
    
    // Trunfo sempre vence não-trunfo
    if (isCurrentTrump && !isHighestTrump) {
      winner = i;
      highestCard = currentCard;
      continue;
    }
    if (!isCurrentTrump && isHighestTrump) {
      continue; // highest já é trunfo, não muda
    } 
    // Ambos são trunfos: comparar pelo valor (ordem A > K > J > Q > 7 > 6 > 5 > 4 > 3 > 2)
    else if (isCurrentTrump && isHighestTrump) {
      if (getCardOrder(currentValue) > getCardOrder(highestValue)) {
        winner = i;
        highestCard = currentCard;
      }
    }
    // Ambos não são trunfos, verificar se seguem o naipe inicial
    else if (!isCurrentTrump && !isHighestTrump) {
      const followsInitialSuit = currentSuit === firstCardSuit;
      const highestFollowsInitialSuit = highestSuit === firstCardSuit;
      
      // Se current segue o naipe e highest não, current vence
      if (followsInitialSuit && !highestFollowsInitialSuit) {
        winner = i;
        highestCard = currentCard;
      } 
      // Se ambos seguem o naipe, comparar valores
      else if (followsInitialSuit && highestFollowsInitialSuit) {
        if (getCardOrder(currentValue) > getCardOrder(highestValue)) {
          winner = i;
          highestCard = currentCard;
        }
      }
      // Se nem current nem highest seguem o naipe, não muda winner
    }
  }
  console.log('[DetermineWinner]', {
    table: game.table.map(p => p.card),
    trumpSuit,
    firstCardSuit,
    winnerIndexInTable: winner,
    winningCard: highestCard,
  });
  return winner;
}

export function playCard(game: GameState, playerId: string, card: string): GameState {
  if (!game.isGameStarted) return game;
  
  const playerIndex = game.players.findIndex((p) => p.id === playerId);
  if (playerIndex === -1 || playerIndex !== game.turn) return game;
  
  const player = game.players[playerIndex];
  
  if (!player.hand.includes(card)) return game;
  
  // Validar se o jogador deve seguir o naipe da rodada (deve seguir se tiver; se não tiver, pode jogar qualquer carta)
  if (game.table.length > 0) {
    const firstCardSuit = getCardSuit(game.table[0].card);
    const playedCardSuit = getCardSuit(card);
    const hasInitialSuit = player.hand.some(c => getCardSuit(c) === firstCardSuit);
    
    if (hasInitialSuit && playedCardSuit !== firstCardSuit) {
      console.log(`Jogada inválida: deve seguir o naipe ${firstCardSuit}`);
      return game; // Bloquear jogada inválida
    }
  }
  
  const newPlayers = game.players.map(p => {
    if (p.id === playerId) {
      return { ...p, hand: p.hand.filter(c => c !== card) };
    }
    return p;
  });
  
  const newTable = [...game.table, { 
    playerId, 
    nickname: player.nickname,
    card 
  }];
  
  let newTurn = game.turn;
  let newRoundNumber = game.roundNumber;
  let updatedPlayers = newPlayers;
  
  if (newTable.length === game.players.length) {
    const winnerIndex = determineRoundWinner({ ...game, table: newTable, players: newPlayers });
    
    if (winnerIndex !== null) {
      // winnerIndex é relativo ao primeiro a jogar na vaza. No momento do término,
      // game.turn aponta para o último jogador que jogou. Portanto, o início da vaza é:
      const lastPlayerIndex = game.turn;
      const playersCount = game.players.length;
      const startingPlayerIndex = (lastPlayerIndex - (newTable.length - 1) + playersCount) % playersCount;
      const absoluteWinnerPlayerIndex = (startingPlayerIndex + winnerIndex) % playersCount;
      const winner = game.players[absoluteWinnerPlayerIndex];
      console.log('[Trick Map]', {
        table: newTable.map(p => p.card),
        winnerIndexInTable: winnerIndex,
        startingPlayerIndex,
        lastPlayerIndex,
        absoluteWinnerPlayerIndex,
        winnerId: winner.id,
      });
      // Capturar todas as cartas da mesa
      const capturedCards = newTable.map(play => play.card);
      const roundPoints = newTable.reduce((sum, play) => sum + getCardPoints(play.card), 0);
      console.log('[Trick End]', {
        tableCards: capturedCards,
        points: roundPoints,
        winner: winner.nickname,
      });
      
      updatedPlayers = newPlayers.map(p => {
        if (p.id === winner.id) {
          return { 
            ...p, 
            score: p.score + roundPoints,
            capturedCards: [...p.capturedCards, ...capturedCards]
          };
        }
        return p;
      });
      
      newTurn = absoluteWinnerPlayerIndex;
      newRoundNumber++;
      
      return { ...game, players: updatedPlayers, table: [], turn: newTurn, roundNumber: newRoundNumber };
    }
  } else {
    newTurn = (game.turn + 1) % game.players.length;
  }
  
  return {
    ...game,
    players: updatedPlayers,
    table: newTable,
    turn: newTurn,
    roundNumber: newRoundNumber,
  };
}

