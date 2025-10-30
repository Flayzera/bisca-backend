import express from "express";
import { createServer } from "http";
import { Server } from "socket.io";
import { createGame, playCard, startGame } from "./gameLogic";
import { GameState, Room, RoomMeta } from "./types";

const app = express();
const httpServer = createServer(app);

// CORS configuration
const allowedOrigins = process.env.ALLOWED_ORIGINS 
  ? process.env.ALLOWED_ORIGINS.split(',').map(origin => origin.trim())
  : ['http://localhost:5173', 'http://localhost:3000'];

const vercelPattern = /\.vercel\.app$/;
const localtunnelPattern = /\.loca\.lt$/;
const tryCloudflarePattern = /\.trycloudflare\.com$/;

function isOriginAllowed(origin: string | undefined): boolean {
  if (!origin) return true;
  if (allowedOrigins.includes('*') || allowedOrigins.includes(origin)) return true;
  if (vercelPattern.test(origin)) return true;
  if (localtunnelPattern.test(origin)) return true;
  if (tryCloudflarePattern.test(origin)) return true;
  return false;
}

const io = new Server(httpServer, { 
  path: '/bisca-socket',
  cors: { 
    origin: (origin, callback) => {
      callback(null, isOriginAllowed(origin));
    },
    methods: ['GET', 'POST'],
    credentials: true
  },
  transports: ['polling'],
  allowUpgrades: false,
  pingTimeout: 120000,
  pingInterval: 20000
});

app.use((req, res, next) => {
  const origin = req.headers.origin as string | undefined;
  if (isOriginAllowed(origin)) {
    res.header('Access-Control-Allow-Origin', origin || '*');
    res.header('Access-Control-Allow-Credentials', 'true');
    res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    const reqHeaders = req.headers['access-control-request-headers'] as string | undefined;
    const defaultHeaders = 'Content-Type, bypass-tunnel-reminder, x-requested-with, authorization';
    res.header('Access-Control-Allow-Headers', reqHeaders || defaultHeaders);
  }
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});

app.get("/", (req, res) => {
  res.json({ status: "ok", message: "Bisca Backend is running" });
});

app.get("/health", (req, res) => {
  res.json({ 
    status: "ok", 
    timestamp: new Date().toISOString(),
    allowedOrigins 
  });
});

// Multi-room state
const rooms = new Map<string, Room>();
const socketIdToRoomId = new Map<string, string>();

function generateRoomId(): string {
  return Math.random().toString(36).slice(2, 8);
}

function cleanupDisconnectedPlayers() {
  const connectedSocketIds = new Set(Array.from(io.sockets.sockets.keys()));
  for (const [roomId, room] of rooms.entries()) {
    const validPlayers = room.game.players.filter(p => connectedSocketIds.has(p.id));
    if (validPlayers.length !== room.game.players.length) {
      room.game.players = validPlayers;
      if (room.game.players.length === 0) {
        rooms.delete(roomId);
      } else if (room.meta.isGameStarted && room.game.players.length < 2) {
        room.meta.isGameStarted = false;
        room.game = createGame();
        io.to(roomId).emit("gameState", room.game);
      }
      io.to(roomId).emit("playersUpdate", room.game.players);
    }
  }
}

io.on("connection", (socket) => {
  const totalSockets = io.sockets.sockets.size;
  console.log(`[CONNECTION] Socket conectado: ${socket.id}`);
  console.log(`[CONNECTION] Total de sockets conectados: ${totalSockets}`);
  
  // Create room
  socket.on("createRoom", ({ capacity, nickname, totalRounds }: { capacity: number; nickname: string; totalRounds?: number }) => {
    try {
      capacity = Math.max(2, Math.min(4, Math.floor(capacity || 2)));
      if (!nickname || typeof nickname !== 'string') {
        socket.emit('roomError', 'Nickname inválido');
        return;
      }
      
      const roomId = generateRoomId();
      const rounds = Math.max(1, Math.min(20, Math.floor(totalRounds || 1)));
      const meta: RoomMeta = { id: roomId, capacity, ownerId: socket.id, isGameStarted: false, totalRounds: rounds, currentRound: 1 };
      const game: GameState = createGame();
      game.players.push({ id: socket.id, nickname: nickname.trim(), hand: [], score: 0, capturedCards: [], chips: 0 });
      
      const room: Room = { meta, game };
      rooms.set(roomId, room);
      socket.join(roomId);
      socketIdToRoomId.set(socket.id, roomId);
      
      console.log(`[CREATE_ROOM] Sala ${roomId} criada por ${nickname} (${socket.id}), capacidade: ${capacity}, rodadas: ${rounds}`);
      
      socket.emit('roomCreated', { roomId, capacity, totalRounds: rounds });
      socket.emit('playersUpdate', room.game.players);
      socket.emit('gameState', room.game);
      io.to(roomId).emit('playersUpdate', room.game.players);
    } catch (e) {
      console.error(`[ERROR] Erro ao criar sala:`, e);
      socket.emit('roomError', 'Erro ao criar sala');
    }
  });

  // Join room
  socket.on("joinRoom", ({ roomId, nickname }: { roomId: string; nickname: string }) => {
    try {
      const room = rooms.get(roomId);
      if (!room) {
        console.log(`[JOIN_ROOM] Sala ${roomId} não encontrada (${socket.id})`);
        socket.emit('roomError', 'Sala não encontrada');
        return;
      }
      
      if (room.meta.isGameStarted) {
        console.log(`[JOIN_ROOM] Tentativa de entrar na sala ${roomId} já iniciada (${socket.id})`);
        socket.emit('roomError', 'Jogo já iniciado');
        return;
      }
      
      cleanupDisconnectedPlayers();
      
      const connectedSocketIds = new Set(Array.from(io.sockets.sockets.keys()));
      room.game.players = room.game.players.filter(p => connectedSocketIds.has(p.id));
      
      if (room.game.players.length >= room.meta.capacity) {
        console.log(`[JOIN_ROOM] Sala ${roomId} cheia (${room.game.players.length}/${room.meta.capacity})`);
        socket.emit('roomFull');
        return;
      }
      
      if (!nickname || typeof nickname !== 'string') {
        socket.emit('roomError', 'Nickname inválido');
        return;
      }
      
      // Check if already in room
      if (room.game.players.some(p => p.id === socket.id)) {
        console.log(`[JOIN_ROOM] Socket ${socket.id} já está na sala ${roomId}`);
        socket.emit('roomJoined', { roomId, capacity: room.meta.capacity, ownerId: room.meta.ownerId });
        socket.emit('playersUpdate', room.game.players);
        socket.emit('gameState', room.game);
        return;
      }
      
      room.game.players.push({ id: socket.id, nickname: nickname.trim(), hand: [], score: 0, capturedCards: [], chips: 0 });
      socket.join(roomId);
      socketIdToRoomId.set(socket.id, roomId);
      
      console.log(`[JOIN_ROOM] ${nickname} (${socket.id}) entrou na sala ${roomId}. Total: ${room.game.players.length}/${room.meta.capacity}`);
      
      // Enviar primeiro para o novo jogador
      socket.emit('roomJoined', { roomId, capacity: room.meta.capacity, ownerId: room.meta.ownerId });
      socket.emit('playersUpdate', room.game.players);
      socket.emit('gameState', room.game);
      
      // Depois enviar para todos na sala (incluindo o novo jogador, mas garantindo que todos recebam)
      setTimeout(() => {
        io.to(roomId).emit('playersUpdate', room.game.players);
        io.to(roomId).emit('gameState', room.game);
        console.log(`[JOIN_ROOM] Eventos broadcast enviados para sala ${roomId}`);
      }, 100);
    } catch (e) {
      console.error(`[ERROR] Erro ao entrar na sala:`, e);
      socket.emit('roomError', 'Erro ao entrar na sala');
    }
  });

  // Start room
  socket.on("startRoom", ({ roomId }: { roomId: string }) => {
    try {
      const room = rooms.get(roomId);
      if (!room) {
        socket.emit('roomError', 'Sala não encontrada');
        return;
      }
      if (room.meta.ownerId !== socket.id) {
        socket.emit('roomError', 'Apenas o dono pode iniciar');
        return;
      }
      const playerCount = room.game.players.length;
      if (playerCount < 2 || playerCount > room.meta.capacity) {
        socket.emit('roomError', 'Número de jogadores inválido');
        return;
      }
      room.game = startGame(room.game);
      room.meta.isGameStarted = true;
      io.to(roomId).emit('gameState', room.game);
      io.to(roomId).emit('gameStarted');
    } catch (e) {
      socket.emit('roomError', 'Erro ao iniciar jogo');
    }
  });

  // Play card
  socket.on("playCard", (card: string) => {
    try {
      if (!card || typeof card !== 'string') return;
      const roomId = socketIdToRoomId.get(socket.id);
      if (!roomId) return;
      const room = rooms.get(roomId);
      if (!room) return;
      
      const beforeTableCount = room.game.table.length;
      const beforeRoundNumber = room.game.roundNumber;
      room.game = playCard(room.game, socket.id, card);
      io.to(roomId).emit("gameState", room.game);

      // Se completou uma vaza (table esvaziou e roundNumber incrementou), emitir evento
      const justCompletedTrick = beforeTableCount + 1 === room.meta.capacity && room.game.table.length === 0 && room.game.roundNumber === beforeRoundNumber + 1;
      if (justCompletedTrick && room.game.lastTrickWinnerId && room.game.lastTrickCards) {
        const winner = room.game.players.find(p => p.id === room.game.lastTrickWinnerId);
        io.to(roomId).emit('trickWon', {
          winnerId: room.game.lastTrickWinnerId,
          winnerNickname: winner?.nickname || '—',
          cards: room.game.lastTrickCards,
          roundNumber: room.game.roundNumber - 1,
        });
      }

      // Verificar fim da rodada (todos sem cartas)
      const playersWithCards = room.game.players.filter(p => p.hand.length > 0);
      if (playersWithCards.length === 0) {
        // Calcular fichas desta rodada
        const trumpSuit = room.game.trumpCard.slice(-1);
        const trump2 = '2' + trumpSuit;
        const trump7 = '7' + trumpSuit;
        const trumpA = 'A' + trumpSuit;
        const trumpK = 'K' + trumpSuit;

        // Vencedor da última vaza jogou K de trunfo e nenhum adversário jogou A/7 de trunfo
        const lastTrick = room.game.lastTrickCards || [];
        const lastTrickWinnerId = room.game.lastTrickWinnerId;
        const lastTrickWinnerPlayedKTrump = lastTrick.some(t => t.playerId === lastTrickWinnerId && t.card === trumpK);
        const opponentsPlayedAor7Trump = lastTrick.some(t => t.card === trumpA || t.card === trump7);

        // Determinar maior pontuação
        const maxScore = Math.max(...room.game.players.map(p => p.score));

        const chipsAwarded: { playerId: string; delta: number }[] = [];
        room.game.players.forEach(p => {
          let delta = 0;
          const captured = new Set(p.capturedCards);
          if (captured.has(trump2)) delta += 1; // tirou o 2 do trunfo
          if (captured.has(trumpA) && captured.has(trump7)) delta += 1; // A e 7 do trunfo (conjuntos)
          if (p.score === maxScore && maxScore > 0) delta += 1; // maior pontuação
          if (p.id === lastTrickWinnerId && lastTrickWinnerPlayedKTrump && !opponentsPlayedAor7Trump) delta += 1; // rei no final
          if (delta > 0) chipsAwarded.push({ playerId: p.id, delta });
        });

        // Aplicar fichas
        room.game.players = room.game.players.map(p => {
          const add = chipsAwarded.find(c => c.playerId === p.id)?.delta || 0;
          const chips = (p.chips ?? 0) + add;
          return { ...p, chips };
        });

        io.to(roomId).emit('roundFinished', {
          scores: room.game.players.map(p => ({ id: p.id, nickname: p.nickname, score: p.score })),
          chipsAwarded,
          totalChips: room.game.players.map(p => ({ id: p.id, nickname: p.nickname, chips: p.chips ?? 0 })),
          trumpCard: room.game.trumpCard,
        });

        // Avançar rodada do match
        room.meta.currentRound = (room.meta.currentRound || 1) + 1;
        const totalRounds = room.meta.totalRounds || 1;
        const matchOver = (room.meta.currentRound || 1) > totalRounds;

        if (matchOver) {
          const maxChips = Math.max(...room.game.players.map(p => p.chips ?? 0));
          const winners = room.game.players.filter(p => (p.chips ?? 0) === maxChips).map(p => ({ id: p.id, nickname: p.nickname, chips: p.chips ?? 0 }));
          io.to(roomId).emit('matchFinished', {
            winners,
            standings: room.game.players.map(p => ({ id: p.id, nickname: p.nickname, chips: p.chips ?? 0 })),
          });
          // Reset estado do jogo para lobby
          room.meta.isGameStarted = false;
          room.game = createGame();
          // manter jogadores com chips
          const playersSnapshot = room.game.players; // createGame esvazia
          // repovoar com lista de sockets presentes? manteremos pela lista anterior do room via socket map
          // Como createGame limpou, re-adicionar apenas ids conectados atuais sem cartas
          const connectedSocketIds = new Set(Array.from(io.sockets.sockets.keys()));
          const previousPlayers = Array.from(connectedSocketIds).filter(id => room.game.players.findIndex(p => p.id === id) >= -1);
          // Simplesmente emitir estado vazio; jogadores continuarão na sala, fichas preservadas em memória se iniciarmos novo jogo futuramente
          io.to(roomId).emit('gameState', room.game);
        } else {
          // Iniciar próxima rodada automaticamente com mesmos jogadores e fichas preservadas
          const preserved = room.game.players.map(p => ({ id: p.id, nickname: p.nickname, hand: [], score: 0, capturedCards: [], chips: p.chips ?? 0 }));
          const nextGame = createGame();
          nextGame.players = preserved as any;
          room.game = startGame(nextGame);
          room.meta.isGameStarted = true;
          io.to(roomId).emit('gameState', room.game);
          io.to(roomId).emit('gameStarted');
        }
      }
    } catch (error) {
      // Silent fail
    }
  });

  // Disconnect
  socket.on("disconnect", (reason) => {
    try {
      console.log(`[DISCONNECT] Socket ${socket.id} desconectou, motivo: ${reason}`);
      console.log(`[DISCONNECT] Total de sockets conectados agora: ${io.sockets.sockets.size}`);
      
      const roomId = socketIdToRoomId.get(socket.id);
      if (!roomId) {
        console.log(`[DISCONNECT] Socket ${socket.id} não estava em nenhuma sala`);
        return;
      }
      const room = rooms.get(roomId);
      if (!room) {
        console.log(`[DISCONNECT] Sala ${roomId} não encontrada`);
        return;
      }
      
      socket.leave(roomId);
      socketIdToRoomId.delete(socket.id);
      const beforeCount = room.game.players.length;
      room.game.players = room.game.players.filter((p) => p.id !== socket.id);
      
      console.log(`[DISCONNECT] Socket ${socket.id} saiu da sala ${roomId}. Jogadores: ${beforeCount} → ${room.game.players.length}`);
      
      io.to(roomId).emit("playersUpdate", room.game.players);
      
      if (room.game.players.length === 0) {
        rooms.delete(roomId);
        console.log(`[DISCONNECT] Sala ${roomId} vazia, removida`);
      } else if (room.meta.isGameStarted && room.game.players.length < 2) {
        room.meta.isGameStarted = false;
        room.game = createGame();
        io.to(roomId).emit("gameState", room.game);
      }
    } catch (error) {
      console.error(`[ERROR] Erro em disconnect:`, error);
    }
  });
});

// Cleanup periódico
setInterval(() => {
  try {
    cleanupDisconnectedPlayers();
  } catch (error) {
    // Silent fail
  }
}, 30000);

// Debug endpoint
app.get("/debug", (req, res) => {
  const connectedSocketIds = new Set(Array.from(io.sockets.sockets.keys()));
  const roomsDebug = Array.from(rooms.entries()).map(([roomId, room]) => {
    const players = room.game.players.map(p => ({
      id: p.id,
      nickname: p.nickname,
      connected: connectedSocketIds.has(p.id)
    }));
    return {
      roomId,
      capacity: room.meta.capacity,
      started: room.meta.isGameStarted,
      ownerId: room.meta.ownerId,
      playersInList: room.game.players.length,
      playersActuallyConnected: players.filter(p => p.connected).length,
      players
    };
  });
  res.json({
    totalRooms: rooms.size,
    totalSocketsConnected: connectedSocketIds.size,
    rooms: roomsDebug,
    timestamp: new Date().toISOString()
  });
});

const PORT = process.env.PORT || 3000;

httpServer.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});
