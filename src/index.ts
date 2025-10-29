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
  } 
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

let game: GameState = createGame();

// Função para limpar jogadores desconectados
function cleanupDisconnectedPlayers() {
  try {
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

io.on("connection", (socket) => {
  try {
    console.log(`[CONNECTION] Jogador conectado: ${socket.id}`);
    console.log(`[DEBUG] Estado atual: ${game.players.length} jogadores, isGameStarted: ${game.isGameStarted}`);
    
    // Limpar jogadores desconectados ao conectar (incluindo este se já existir)
    try {
      cleanupDisconnectedPlayers();
    } catch (error) {
      console.error(`[ERROR] Erro em cleanupDisconnectedPlayers:`, error);
    }
    
    // IMPORTANTE: Remover este socket da lista se já existir (reconexão)
    try {
      const existingPlayerIndex = game.players.findIndex(p => p.id === socket.id);
      if (existingPlayerIndex !== -1) {
        console.log(`[RECONNECTION] Removendo jogador duplicado ${socket.id} antes de reconectar`);
        game.players.splice(existingPlayerIndex, 1);
        io.emit("playersUpdate", game.players);
      }
    } catch (error) {
      console.error(`[ERROR] Erro ao verificar reconexão:`, error);
    }

    socket.on("joinGame", (nickname: string) => {
      try {
        if (!nickname || typeof nickname !== 'string') {
          console.error(`[ERROR] Nickname inválido:`, nickname);
          socket.emit("error", "Nickname inválido");
          return;
        }

        console.log(`[JOIN] Tentativa de entrada: ${nickname} (${socket.id})`);
        console.log(`[DEBUG] Estado antes: ${game.players.length} jogadores`);
        
        // Limpar jogadores desconectados ANTES de qualquer verificação
        try {
          cleanupDisconnectedPlayers();
        } catch (error) {
          console.error(`[ERROR] Erro em cleanupDisconnectedPlayers:`, error);
        }
        
        // Verificar quantos sockets estão REALMENTE conectados
        const connectedSocketIds = new Set(Array.from(io.sockets.sockets.keys()));
        const actuallyConnectedPlayers = game.players.filter(p => connectedSocketIds.has(p.id));
        
        console.log(`[JOIN DEBUG] Jogadores na lista: ${game.players.length}`);
        console.log(`[JOIN DEBUG] Jogadores realmente conectados: ${actuallyConnectedPlayers.length}`);
        console.log(`[JOIN DEBUG] Total de sockets conectados: ${connectedSocketIds.size}`);
        console.log(`[JOIN DEBUG] Sockets IDs:`, Array.from(connectedSocketIds));
        
        // Atualizar lista removendo jogadores desconectados - FORÇADO
        if (actuallyConnectedPlayers.length !== game.players.length) {
          console.log(`[JOIN] Limpando jogadores desconectados durante join: ${game.players.length} → ${actuallyConnectedPlayers.length}`);
          game.players = actuallyConnectedPlayers;
          
          // Se havia jogadores órfãos e agora está vazio, resetar
          if (game.players.length === 0 && !game.isGameStarted) {
            console.log(`[JOIN] Lista estava com jogadores órfãos, resetando jogo`);
            game = createGame();
          }
          
          io.emit("playersUpdate", game.players);
          io.emit("gameState", game);
        }
        
        // Verificar se o socket já está no jogo (evitar duplicatas)
        const alreadyInGame = game.players.some(p => p.id === socket.id);
        
        if (alreadyInGame) {
          console.log(`[JOIN] Jogador ${socket.id} já está no jogo`);
          socket.emit("gameState", game);
          socket.emit("playersUpdate", game.players);
          return;
        }
        
        // Verificar se a sala está cheia (usando jogadores realmente conectados)
        const currentPlayerCount = game.players.length;
        const actuallyConnectedCount = actuallyConnectedPlayers.length;
        
        // Se há jogadores órfãos e menos de 4 realmente conectados, permitir entrada
        if (currentPlayerCount >= 4 && actuallyConnectedCount < 4) {
          console.log(`[ROOM_FULL FIX] Sala parecia cheia mas tem jogadores órfãos!`);
          console.log(`[ROOM_FULL FIX] Limpando e permitindo entrada...`);
          game.players = actuallyConnectedPlayers;
          io.emit("playersUpdate", game.players);
          // Continua para adicionar o novo jogador
        }
        else if (currentPlayerCount >= 4 && actuallyConnectedCount >= 4) {
          const playersInfo = game.players.map(p => ({ 
            id: p.id, 
            nickname: p.nickname,
            connected: connectedSocketIds.has(p.id)
          }));
          console.log(`[ROOM_FULL] Sala realmente cheia! Jogadores na lista: ${currentPlayerCount}`);
          console.log(`[ROOM_FULL] Jogadores realmente conectados: ${actuallyConnectedCount}`);
          console.log(`[ROOM_FULL] Detalhes:`, playersInfo);
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
        game.players.push({ id: socket.id, nickname: nickname.trim(), hand: [], score: 0, capturedCards: [] });
        console.log(`Jogador ${nickname} (${socket.id}) entrou. Total: ${game.players.length}`);
        
        socket.emit("gameState", game);
        io.emit("playersUpdate", game.players);
        
        // Se tiver 2 ou 4 jogadores, inicia o jogo automaticamente
        if (game.players.length === 2 || game.players.length === 4) {
          try {
            console.log(`Iniciando jogo com ${game.players.length} jogadores`);
            game = startGame(game);
            io.emit("gameState", game);
            io.emit("gameStarted");
          } catch (error) {
            console.error(`[ERROR] Erro ao iniciar jogo:`, error);
            if (error instanceof Error) {
              console.error(`[ERROR] Stack:`, error.stack);
            }
            socket.emit("error", "Erro ao iniciar o jogo");
          }
        }
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
        game = playCard(game, socket.id, card);
        io.emit("gameState", game);
        
        // Verificar se o jogo terminou
        const playersWithCards = game.players.filter(p => p.hand.length > 0);
        if (playersWithCards.length === 0) {
          io.emit("gameFinished");
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
    const beforeCount = game.players.length;
    cleanupDisconnectedPlayers();
    if (beforeCount !== game.players.length) {
      console.log(`[AUTO-CLEANUP] Limpeza automática executada`);
    }
  } catch (error) {
    console.error(`[AUTO-CLEANUP] Erro:`, error);
  }
}, 30000); // 30 segundos

// Endpoint de debug para verificar estado do jogo
app.get("/debug", (req, res) => {
  const connectedSocketIds = new Set(Array.from(io.sockets.sockets.keys()));
  const actuallyConnected = game.players.filter(p => connectedSocketIds.has(p.id));
  
  res.json({
    gameState: {
      playersInList: game.players.length,
      playersActuallyConnected: actuallyConnected.length,
      totalSocketsConnected: connectedSocketIds.size,
      players: game.players.map(p => ({ 
        id: p.id, 
        nickname: p.nickname, 
        connected: connectedSocketIds.has(p.id) 
      })),
      connectedSocketIds: Array.from(connectedSocketIds),
      isGameStarted: game.isGameStarted
    },
    needsCleanup: game.players.length !== actuallyConnected.length,
    timestamp: new Date().toISOString()
  });
});

// Endpoint para forçar limpeza manual
app.get("/cleanup", (req, res) => {
  const beforeCount = game.players.length;
  cleanupDisconnectedPlayers();
  const afterCount = game.players.length;
  
  res.json({
    success: true,
    removed: beforeCount - afterCount,
    playersBefore: beforeCount,
    playersAfter: afterCount,
    timestamp: new Date().toISOString()
  });
});

const PORT = process.env.PORT || 3000;

httpServer.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});
