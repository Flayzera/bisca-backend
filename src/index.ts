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

function isOriginAllowed(origin: string | undefined): boolean {
  if (!origin) return true;
  if (allowedOrigins.includes('*') || allowedOrigins.includes(origin)) return true;
  if (vercelPattern.test(origin)) return true;
  if (localtunnelPattern.test(origin)) return true;
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
  socket.on("createRoom", ({ capacity, nickname }: { capacity: number; nickname: string }) => {
    try {
      capacity = Math.max(2, Math.min(4, Math.floor(capacity || 2)));
      if (!nickname || typeof nickname !== 'string') {
        socket.emit('roomError', 'Nickname inválido');
        return;
      }
      
      const roomId = generateRoomId();
      const meta: RoomMeta = { id: roomId, capacity, ownerId: socket.id, isGameStarted: false };
      const game: GameState = createGame();
      game.players.push({ id: socket.id, nickname: nickname.trim(), hand: [], score: 0, capturedCards: [] });
      
      const room: Room = { meta, game };
      rooms.set(roomId, room);
      socket.join(roomId);
      socketIdToRoomId.set(socket.id, roomId);
      
      console.log(`[CREATE_ROOM] Sala ${roomId} criada por ${nickname} (${socket.id}), capacidade: ${capacity}`);
      
      socket.emit('roomCreated', { roomId, capacity });
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
      
      room.game.players.push({ id: socket.id, nickname: nickname.trim(), hand: [], score: 0, capturedCards: [] });
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
      
      room.game = playCard(room.game, socket.id, card);
      io.to(roomId).emit("gameState", room.game);
      
      const playersWithCards = room.game.players.filter(p => p.hand.length > 0);
      if (playersWithCards.length === 0) {
        io.to(roomId).emit("gameFinished");
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
