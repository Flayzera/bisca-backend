import express from "express";
import { createServer } from "http";
import { Server } from "socket.io";
import { createGame, playCard, startGame } from "./gameLogic";
import { GameState, Room, RoomMeta } from "./types";

const app = express();
const httpServer = createServer(app);

// CORS configuration - allow frontend URLs
const allowedOrigins = process.env.ALLOWED_ORIGINS 
  ? process.env.ALLOWED_ORIGINS.split(',').map(origin => origin.trim())
  : ['http://localhost:5173', 'http://localhost:3000'];

// Padrões para permitir automaticamente
const vercelPattern = /\.vercel\.app$/;
const localtunnelPattern = /\.loca\.lt$/;

console.log(`[CORS] Allowed origins:`, allowedOrigins);

// Função helper para verificar se origin é permitida
function isOriginAllowed(origin: string | undefined): boolean {
  if (!origin) return true; // Permitir requisições sem origin
  
  // Verificar lista explícita
  if (allowedOrigins.includes('*') || allowedOrigins.includes(origin)) {
    return true;
  }
  
  // Permitir qualquer domínio .vercel.app (automaticamente)
  if (vercelPattern.test(origin)) {
    console.log(`[CORS] Permitting Vercel domain: ${origin}`);
    return true;
  }
  
  // Permitir domínios localtunnel (se estiver usando)
  if (localtunnelPattern.test(origin)) {
    console.log(`[CORS] Permitting localtunnel domain: ${origin}`);
    return true;
  }
  
  return false;
}

const io = new Server(httpServer, { 
  cors: { 
    origin: (origin, callback) => {
      if (isOriginAllowed(origin)) {
        return callback(null, true);
      }
      
      console.log(`[CORS] Origin bloqueado: ${origin}`);
      console.log(`[CORS] Origins permitidos:`, allowedOrigins);
      return callback(new Error('Not allowed by CORS'));
    },
    methods: ['GET', 'POST'],
    credentials: true
  },
  // Permitir polling e websocket - pode ajudar com localtunnel
  transports: ['polling', 'websocket'],
  // Aumentar timeout para conexões através de túneis
  pingTimeout: 60000,
  pingInterval: 25000
});

// Middleware Express para CORS também (para requisições HTTP normais)
app.use((req, res, next) => {
  const origin = req.headers.origin as string | undefined;
  if (isOriginAllowed(origin)) {
    res.header('Access-Control-Allow-Origin', origin || '*');
    res.header('Access-Control-Allow-Credentials', 'true');
    res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type');
  }
  
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});

// Health check endpoint
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

// Função para limpar jogadores desconectados
function cleanupDisconnectedPlayers() {
  try {
    const connectedSocketIds = new Set(Array.from(io.sockets.sockets.keys()));
    for (const [roomId, room] of rooms.entries()) {
      const beforeCount = room.game.players.length;
      const validPlayers = room.game.players.filter(p => connectedSocketIds.has(p.id));
      if (validPlayers.length !== room.game.players.length) {
        console.log(`[CLEANUP][${roomId}] ${beforeCount} → ${validPlayers.length}`);
        room.game.players = validPlayers;
        if (room.game.players.length === 0) {
          rooms.delete(roomId);
          console.log(`[CLEANUP][${roomId}] Room empty, deleted`);
        } else if (room.meta.isGameStarted && room.game.players.length < 2) {
          // Stop game if not enough players
          room.meta.isGameStarted = false;
          room.game = createGame();
          io.to(roomId).emit("gameState", room.game);
        }
        io.to(roomId).emit("playersUpdate", room.game.players);
      }
    }
  } catch (error) {
    console.error(`[ERROR] Erro em cleanupDisconnectedPlayers:`, error);
    throw error;
  }
}

// Tratamento de erros globais para evitar crashes
process.on('uncaughtException', (error) => {
  console.error('[FATAL] Uncaught Exception:', error);
  console.error('[FATAL] Stack:', error.stack);
  // Não encerrar o processo, apenas logar
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('[FATAL] Unhandled Rejection at:', promise, 'reason:', reason);
});

// Log de TODAS as conexões no nível do engine
io.engine.on("connection", (socket) => {
  console.log(`[ENGINE] Nova conexão no engine Socket.io`);
});

io.on("connection", (socket) => {
  try {
    console.log(`[CONNECTION] ====================`);
    console.log(`[CONNECTION] Novo socket conectado: ${socket.id}`);
    console.log(`[CONNECTION] Total de sockets conectados AGORA: ${io.sockets.sockets.size}`);
    console.log(`[CONNECTION] Estado atual: ${rooms.size} sala(s)`);
    for (const [rid, room] of rooms.entries()) {
      console.log(`[CONNECTION][${rid}] players=${room.game.players.length}, started=${room.meta.isGameStarted}`);
    }
    
    // Log de TODOS os sockets conectados
    const allSocketIds = Array.from(io.sockets.sockets.keys());
    console.log(`[CONNECTION] Todos os sockets conectados:`, allSocketIds);
    
    // Limpar jogadores desconectados ao conectar (incluindo este se já existir)
    try {
      cleanupDisconnectedPlayers();
    } catch (error) {
      console.error(`[ERROR] Erro em cleanupDisconnectedPlayers:`, error);
    }
    
    // IMPORTANTE: Remover este socket da lista se já existir (reconexão)
    try {
      // No-op for multi-room; handled on joinRoom
    } catch (error) {
      console.error(`[ERROR] Erro ao verificar reconexão:`, error);
    }
    
    // Log de eventos do socket para debug - ANTES de registrar handlers
    socket.onAny((eventName, ...args) => {
      console.log(`[SOCKET EVENT] Socket ${socket.id} emitiu evento: ${eventName}`, args);
    });
    
    // Log de erros do socket
    socket.on("error", (error) => {
      console.error(`[SOCKET ERROR] Socket ${socket.id} erro:`, error);
    });
    
    // Verificar se socket está realmente conectado após um pequeno delay
    setTimeout(() => {
      console.log(`[CONNECTION CHECK] Socket ${socket.id} ainda conectado? ${socket.connected}`);
      console.log(`[CONNECTION CHECK] Socket ${socket.id} transport:`, socket.conn?.transport?.name || 'unknown');
      
      // Multi-room: checagens específicas são feitas nos handlers de sala
    }, 1000);

    // Room APIs
    console.log(`[HANDLER SETUP] Registrando handlers de sala para socket ${socket.id}`);

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
        socket.emit('roomCreated', { roomId, capacity });
        io.to(roomId).emit('playersUpdate', room.game.players);
        socket.emit('gameState', room.game);
      } catch (e) {
        socket.emit('roomError', 'Erro ao criar sala');
      }
    });

    // Join room
    socket.on("joinRoom", ({ roomId, nickname }: { roomId: string; nickname: string }) => {
      try {
        const room = rooms.get(roomId);
        if (!room) { socket.emit('roomError', 'Sala não encontrada'); return; }
        if (room.meta.isGameStarted) { socket.emit('roomError', 'Jogo já iniciado'); return; }
        const connectedSocketIds = new Set(Array.from(io.sockets.sockets.keys()));
        room.game.players = room.game.players.filter(p => connectedSocketIds.has(p.id));
        if (room.game.players.length >= room.meta.capacity) { socket.emit('roomFull'); return; }
        if (!nickname || typeof nickname !== 'string') { socket.emit('roomError', 'Nickname inválido'); return; }
        room.game.players.push({ id: socket.id, nickname: nickname.trim(), hand: [], score: 0, capturedCards: [] });
        socket.join(roomId);
        socketIdToRoomId.set(socket.id, roomId);
        socket.emit('roomJoined', { roomId, capacity: room.meta.capacity, ownerId: room.meta.ownerId });
        io.to(roomId).emit('playersUpdate', room.game.players);
        socket.emit('gameState', room.game);
      } catch (e) {
        socket.emit('roomError', 'Erro ao entrar na sala');
      }
    });

    // Start room
    socket.on("startRoom", ({ roomId }: { roomId: string }) => {
      const room = rooms.get(roomId);
      if (!room) { socket.emit('roomError', 'Sala não encontrada'); return; }
      if (room.meta.ownerId !== socket.id) { socket.emit('roomError', 'Apenas o dono pode iniciar'); return; }
      const playerCount = room.game.players.length;
      if (playerCount < 2 || playerCount > room.meta.capacity) { socket.emit('roomError', 'Número de jogadores inválido'); return; }
      room.game = startGame(room.game);
      room.meta.isGameStarted = true;
      io.to(roomId).emit('gameState', room.game);
      io.to(roomId).emit('gameStarted');
    });

    // Legacy single-room join support (fallback)
  socket.on("joinGame", (nickname: string) => {
      try {
        console.log(`[JOIN EVENT] Evento joinGame recebido para socket ${socket.id}, nickname:`, nickname);
        console.log(`[JOIN EVENT] Tipo do nickname:`, typeof nickname);
        console.log(`[JOIN EVENT] Salas existentes: ${rooms.size}`);
        
        if (!nickname || typeof nickname !== 'string') {
          console.error(`[ERROR] Nickname inválido:`, nickname);
          socket.emit("error", "Nickname inválido");
          return;
        }

        console.log(`[JOIN] Tentativa de entrada: ${nickname} (${socket.id})`);
        console.log(`[DEBUG] Estado antes: ${rooms.size} sala(s)`);
        
        // Limpar jogadores desconectados ANTES de qualquer verificação
        try {
          cleanupDisconnectedPlayers();
        } catch (error) {
          console.error(`[ERROR] Erro em cleanupDisconnectedPlayers:`, error);
        }
        
        // Obter lista de sockets realmente conectados (inclui o socket atual tentando entrar)
        const connectedSocketIds = new Set(Array.from(io.sockets.sockets.keys()));
        
        // Legacy flow não usa lista global.
        
        // Verificar se o socket já está no jogo (evitar duplicatas)
        const alreadyInGame = socketIdToRoomId.has(socket.id);
        
        if (alreadyInGame) {
          console.log(`[JOIN] Jogador ${socket.id} já está em uma sala`);
          const rid = socketIdToRoomId.get(socket.id)!;
          const r = rooms.get(rid);
          if (r) {
            socket.emit("gameState", r.game);
            socket.emit("playersUpdate", r.game.players);
          }
          return;
        }
        
        // Use a default lobby room "lobby" as a fallback for legacy flows
        const roomId = 'lobby';
        let room = rooms.get(roomId);
        if (!room) {
          room = { meta: { id: roomId, capacity: 4, ownerId: socket.id, isGameStarted: false }, game: createGame() };
          rooms.set(roomId, room);
        }
        const game = room.game;
        const playersActuallyConnectedBeforeJoin = game.players.length;
        
        console.log(`[ROOM_CHECK][${roomId}] lista: ${game.players.length}, conectados: ${playersActuallyConnectedBeforeJoin}, sockets: ${connectedSocketIds.size}`);
        console.log(`[ROOM_CHECK][${roomId}] Tentando adicionar jogador: ${nickname} (${socket.id})`);
        
        // Verificar se após adicionar este jogador, ainda temos espaço (max 4)
        // Como ainda não adicionamos o novo jogador, verificamos se temos menos de 4
        console.log(`[ROOM_CHECK FINAL][${roomId}] Verificando limite... cap=${room.meta.capacity}`);
        
        if (playersActuallyConnectedBeforeJoin >= room.meta.capacity) {
          const playersInfo = game.players.map(p => ({ 
            id: p.id, 
            nickname: p.nickname,
            connected: connectedSocketIds.has(p.id)
          }));
          console.log(`[ROOM_FULL] ==================== SALA CHEIA ====================`);
          console.log(`[ROOM_FULL] Socket ${socket.id} (${nickname}) NÃO pode entrar!`);
          console.log(`[ROOM_FULL] Jogadores na lista: ${playersActuallyConnectedBeforeJoin}/${room.meta.capacity}`);
          console.log(`[ROOM_FULL] Detalhes dos jogadores:`, JSON.stringify(playersInfo, null, 2));
          console.log(`[ROOM_FULL] Todos os sockets conectados:`, Array.from(connectedSocketIds));
          console.log(`[ROOM_FULL] ====================================================`);
      socket.emit("roomFull");
      return;
    }
        
        console.log(`[ROOM_CHECK FINAL][${roomId}] ✓ Há espaço! (${playersActuallyConnectedBeforeJoin}/${room.meta.capacity})`);
        
        
        // Se o jogo já começou, não pode entrar
        if (room.meta.isGameStarted) {
          console.log(`Jogo já iniciado, não é possível entrar agora`);
          socket.emit("gameStarted");
          return;
        }
    
    // Adicionar jogador
        game.players.push({ id: socket.id, nickname: nickname.trim(), hand: [], score: 0, capturedCards: [] });
        socket.join(roomId);
        socketIdToRoomId.set(socket.id, roomId);
        console.log(`[JOIN SUCCESS] Jogador ${nickname} (${socket.id}) entrou com sucesso!`);
        console.log(`[JOIN SUCCESS][${roomId}] Total: ${game.players.length}/${room.meta.capacity}`);
        console.log(`[JOIN SUCCESS][${roomId}] Lista:`, game.players.map(p => `${p.nickname}(${p.id.substring(0, 8)}...)`).join(', '));
        
    socket.emit("gameState", game);
        io.to(roomId).emit("playersUpdate", game.players);
    
    // Se tiver 2 ou 4 jogadores, inicia o jogo automaticamente
        // Legacy flow: do not auto-start here; start is explicit in room flow
      } catch (error) {
        console.error(`[ERROR] Erro em joinGame:`, error);
        if (error instanceof Error) {
          console.error(`[ERROR] Stack:`, error.stack);
        }
        socket.emit("error", "Erro ao entrar no jogo");
    }
  });

  socket.on("playCard", (card: string) => {
      try {
        if (!card || typeof card !== 'string') {
          console.error(`[ERROR] Card inválido:`, card);
          return;
        }
        const roomId = socketIdToRoomId.get(socket.id);
        if (!roomId) return;
        const room = rooms.get(roomId);
        if (!room) return;
        room.game = playCard(room.game, socket.id, card);
        io.to(roomId).emit("gameState", room.game);
    
    // Verificar se o jogo terminou
        const playersWithCards = room.game.players.filter(p => p.hand.length > 0);
    if (playersWithCards.length === 0) {
          io.to(roomId).emit("gameFinished");
        }
      } catch (error) {
        console.error(`[ERROR] Erro em playCard:`, error);
        if (error instanceof Error) {
          console.error(`[ERROR] Stack:`, error.stack);
        }
      }
    });

    socket.on("disconnect", (reason) => {
      try {
        console.log(`[DISCONNECT] Jogador saiu: ${socket.id}, motivo: ${reason}`);
        const roomId = socketIdToRoomId.get(socket.id);
        if (!roomId) return;
        const room = rooms.get(roomId);
        if (!room) return;
        socket.leave(roomId);
        socketIdToRoomId.delete(socket.id);
        const beforeCount = room.game.players.length;
        room.game.players = room.game.players.filter((p) => p.id !== socket.id);
        console.log(`[DISCONNECT][${roomId}] Jogadores: ${beforeCount} → ${room.game.players.length}`);
        io.to(roomId).emit("playersUpdate", room.game.players);
        if (room.game.players.length === 0) {
          rooms.delete(roomId);
          console.log(`[DISCONNECT][${roomId}] Room empty, deleted`);
        } else if (room.meta.isGameStarted && room.game.players.length < 2) {
          room.meta.isGameStarted = false;
          room.game = createGame();
          io.to(roomId).emit("gameState", room.game);
        }
      } catch (error) {
        console.error(`[ERROR] Erro em disconnect:`, error);
        if (error instanceof Error) {
          console.error(`[ERROR] Stack:`, error.stack);
        }
      }
    });
  } catch (error) {
    console.error(`[ERROR] Erro na conexão do socket:`, error);
    if (error instanceof Error) {
      console.error(`[ERROR] Stack:`, error.stack);
    }
  }
});

// Limpeza automática periódica de jogadores desconectados (a cada 30 segundos)
setInterval(() => {
  try {
    const beforeRooms = Array.from(rooms.keys());
    cleanupDisconnectedPlayers();
    const afterRooms = Array.from(rooms.keys());
    if (beforeRooms.length !== afterRooms.length) {
      console.log(`[AUTO-CLEANUP] Rooms: ${beforeRooms.length} → ${afterRooms.length}`);
    }
  } catch (error) {
    console.error(`[AUTO-CLEANUP] Erro:`, error);
  }
}, 30000); // 30 segundos

// Endpoint de debug para verificar estado do jogo
app.get("/debug", (req, res) => {
  const connectedSocketIds = new Set(Array.from(io.sockets.sockets.keys()));
  const roomsDebug = Array.from(rooms.entries()).map(([roomId, room]) => {
    const players = room.game.players.map(p => ({
      id: p.id,
      nickname: p.nickname,
      connected: connectedSocketIds.has(p.id)
    }));
    const actuallyConnected = players.filter(p => p.connected).length;
    return {
      roomId,
      capacity: room.meta.capacity,
      started: room.meta.isGameStarted,
      ownerId: room.meta.ownerId,
      playersInList: room.game.players.length,
      playersActuallyConnected: actuallyConnected,
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

// Endpoint para forçar limpeza manual
app.get("/cleanup", (req, res) => {
  const before = Array.from(rooms.entries()).map(([id, r]) => ({ id, players: r.game.players.length }));
  cleanupDisconnectedPlayers();
  const after = Array.from(rooms.entries()).map(([id, r]) => ({ id, players: r.game.players.length }));
  res.json({
    success: true,
    roomsBefore: before,
    roomsAfter: after,
    timestamp: new Date().toISOString()
  });
});

const PORT = process.env.PORT || 3000;

httpServer.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});
