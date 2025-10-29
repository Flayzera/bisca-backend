import express from "express";
import { createServer } from "http";
import { Server } from "socket.io";
import { createGame, playCard, startGame } from "./gameLogic";
import { GameState } from "./types";

const app = express();
const httpServer = createServer(app);

// CORS configuration - allow frontend URLs
const allowedOrigins = process.env.ALLOWED_ORIGINS 
  ? process.env.ALLOWED_ORIGINS.split(',').map(origin => origin.trim())
  : ['http://localhost:5173', 'http://localhost:3000'];

console.log(`[CORS] Allowed origins:`, allowedOrigins);

const io = new Server(httpServer, { 
  cors: { 
    origin: (origin, callback) => {
      // Permitir requisições sem origin (mobile apps, Postman, etc)
      if (!origin) {
        return callback(null, true);
      }
      
      // Verificar se o origin está na lista ou se é wildcard
      if (allowedOrigins.includes('*') || allowedOrigins.includes(origin)) {
        return callback(null, true);
      }
      
      console.log(`[CORS] Origin bloqueado: ${origin}`);
      console.log(`[CORS] Origins permitidos:`, allowedOrigins);
      return callback(new Error('Not allowed by CORS'));
    },
    methods: ['GET', 'POST'],
    credentials: true
  } 
});

// Middleware Express para CORS também (para requisições HTTP normais)
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (!origin || allowedOrigins.includes('*') || allowedOrigins.includes(origin)) {
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

let game: GameState = createGame();

// Função para limpar jogadores desconectados
function cleanupDisconnectedPlayers() {
  const connectedSocketIds = new Set(Array.from(io.sockets.sockets.keys()));
  const beforeCount = game.players.length;
  const validPlayers = game.players.filter(p => connectedSocketIds.has(p.id));
  
  if (validPlayers.length !== game.players.length) {
    console.log(`[CLEANUP] Limpando jogadores desconectados: ${beforeCount} → ${validPlayers.length}`);
    console.log(`[CLEANUP] Sockets conectados: ${Array.from(connectedSocketIds).join(', ')}`);
    console.log(`[CLEANUP] Jogadores na lista: ${game.players.map(p => `${p.nickname}(${p.id})`).join(', ')}`);
    game.players = validPlayers;
    
    // Se não há jogadores ou menos de 2, resetar o jogo
    if (game.players.length === 0 || (game.players.length < 2 && !game.isGameStarted)) {
      game = createGame();
      io.emit("gameState", game);
      io.emit("playersUpdate", []);
    } else {
      io.emit("playersUpdate", game.players);
    }
  }
}

io.on("connection", (socket) => {
  console.log(`[CONNECTION] Jogador conectado: ${socket.id}`);
  console.log(`[DEBUG] Estado atual: ${game.players.length} jogadores, isGameStarted: ${game.isGameStarted}`);
  
  // Limpar jogadores desconectados ao conectar (incluindo este se já existir)
  cleanupDisconnectedPlayers();
  
  // IMPORTANTE: Remover este socket da lista se já existir (reconexão)
  const existingPlayerIndex = game.players.findIndex(p => p.id === socket.id);
  if (existingPlayerIndex !== -1) {
    console.log(`[RECONNECTION] Removendo jogador duplicado ${socket.id} antes de reconectar`);
    game.players.splice(existingPlayerIndex, 1);
    io.emit("playersUpdate", game.players);
  }

  socket.on("joinGame", (nickname: string) => {
    console.log(`[JOIN] Tentativa de entrada: ${nickname} (${socket.id})`);
    console.log(`[DEBUG] Estado antes: ${game.players.length} jogadores`);
    // Limpar jogadores desconectados antes de verificar
    cleanupDisconnectedPlayers();
    
    // Verificar se o socket já está no jogo (evitar duplicatas)
    const alreadyInGame = game.players.some(p => p.id === socket.id);
    
    if (alreadyInGame) {
      console.log(`Jogador ${socket.id} já está no jogo`);
      socket.emit("gameState", game);
      socket.emit("playersUpdate", game.players);
      return;
    }
    
    // Verificar se a sala está cheia
    if (game.players.length >= 4) {
      const playersInfo = game.players.map(p => ({ id: p.id, nickname: p.nickname }));
      const connectedSockets = Array.from(io.sockets.sockets.keys());
      console.log(`[ROOM_FULL] Sala cheia! Jogadores na lista: ${game.players.length}`);
      console.log(`[ROOM_FULL] Detalhes:`, playersInfo);
      console.log(`[ROOM_FULL] Sockets realmente conectados: ${connectedSockets.length}`, connectedSockets);
      socket.emit("roomFull");
      return;
    }
    
    // Se o jogo já começou, não pode entrar
    if (game.isGameStarted) {
      console.log(`Jogo já iniciado, não é possível entrar agora`);
      socket.emit("gameStarted");
      return;
    }
    
    // Adicionar jogador
    game.players.push({ id: socket.id, nickname, hand: [], score: 0, capturedCards: [] });
    console.log(`Jogador ${nickname} (${socket.id}) entrou. Total: ${game.players.length}`);
    
    socket.emit("gameState", game);
    io.emit("playersUpdate", game.players);
    
    // Se tiver 2 ou 4 jogadores, inicia o jogo automaticamente
    if (game.players.length === 2 || game.players.length === 4) {
      console.log(`Iniciando jogo com ${game.players.length} jogadores`);
      game = startGame(game);
      io.emit("gameState", game);
      io.emit("gameStarted");
    }
  });

  socket.on("playCard", (card: string) => {
    game = playCard(game, socket.id, card);
    io.emit("gameState", game);
    
    // Verificar se o jogo terminou
    const playersWithCards = game.players.filter(p => p.hand.length > 0);
    if (playersWithCards.length === 0) {
      io.emit("gameFinished");
    }
  });

  socket.on("disconnect", (reason) => {
    console.log(`[DISCONNECT] Jogador saiu: ${socket.id}, motivo: ${reason}`);
    const playerLeft = game.players.find(p => p.id === socket.id);
    
    // Remover jogador
    const beforeCount = game.players.length;
    game.players = game.players.filter((p) => p.id !== socket.id);
    console.log(`[DISCONNECT] Jogadores: ${beforeCount} → ${game.players.length}`);
    
    io.emit("playersUpdate", game.players);
    
    // Se não há mais jogadores ou o jogo estava em andamento, reseta
    if (game.players.length === 0) {
      console.log(`Nenhum jogador restante. Resetando jogo...`);
      game = createGame();
      io.emit("gameState", game);
    }
    // Se o jogo estava em andamento e alguém saiu, reseta o jogo
    else if (game.isGameStarted) {
      console.log(`Jogo estava em andamento. Resetando...`);
      game = createGame();
      io.emit("gameState", game);
    }
    // Se restaram menos de 2 jogadores e o jogo não estava iniciado, reseta
    else if (game.players.length < 2) {
      console.log(`Menos de 2 jogadores. Resetando...`);
      game = createGame();
      io.emit("gameState", game);
    }
  });
});

// Endpoint de debug para verificar estado do jogo
app.get("/debug", (req, res) => {
  const connectedSocketIds = new Set(Array.from(io.sockets.sockets.keys()));
  res.json({
    gameState: {
      playersCount: game.players.length,
      players: game.players.map(p => ({ id: p.id, nickname: p.nickname, connected: connectedSocketIds.has(p.id) })),
      isGameStarted: game.isGameStarted,
      connectedSockets: connectedSocketIds.size
    }
  });
});

const PORT = process.env.PORT || 3000;

httpServer.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});
