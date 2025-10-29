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
    console.log(`[CONNECTION] ====================`);
    console.log(`[CONNECTION] Novo socket conectado: ${socket.id}`);
    console.log(`[CONNECTION] Total de sockets conectados AGORA: ${io.sockets.sockets.size}`);
    console.log(`[CONNECTION] Estado atual do jogo: ${game.players.length} jogadores, isGameStarted: ${game.isGameStarted}`);
    console.log(`[CONNECTION] Lista de jogadores atual:`, game.players.map(p => `${p.nickname}(${p.id})`).join(', '));
    
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
      const existingPlayerIndex = game.players.findIndex(p => p.id === socket.id);
      if (existingPlayerIndex !== -1) {
        console.log(`[RECONNECTION] Removendo jogador duplicado ${socket.id} antes de reconectar`);
        game.players.splice(existingPlayerIndex, 1);
        io.emit("playersUpdate", game.players);
      }
    } catch (error) {
      console.error(`[ERROR] Erro ao verificar reconexão:`, error);
    }
    
    // Log de eventos do socket para debug
    socket.onAny((eventName, ...args) => {
      console.log(`[SOCKET EVENT] Socket ${socket.id} emitiu evento: ${eventName}`, args);
    });

    socket.on("joinGame", (nickname: string) => {
      try {
        console.log(`[JOIN EVENT] Evento joinGame recebido para socket ${socket.id}, nickname:`, nickname);
        console.log(`[JOIN EVENT] Tipo do nickname:`, typeof nickname);
        console.log(`[JOIN EVENT] Estado do jogo antes de processar:`, {
          playersCount: game.players.length,
          players: game.players.map(p => ({ nickname: p.nickname, id: p.id })),
          isGameStarted: game.isGameStarted
        });
        
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
        
        // Obter lista de sockets realmente conectados (inclui o socket atual tentando entrar)
        const connectedSocketIds = new Set(Array.from(io.sockets.sockets.keys()));
        
        // Filtrar jogadores que realmente estão conectados (exclui o novo socket se não estiver na lista ainda)
        const actuallyConnectedPlayers = game.players.filter(p => connectedSocketIds.has(p.id));
        
        console.log(`[JOIN DEBUG] Jogadores na lista: ${game.players.length}`);
        console.log(`[JOIN DEBUG] Jogadores realmente conectados: ${actuallyConnectedPlayers.length}`);
        console.log(`[JOIN DEBUG] Total de sockets conectados no servidor: ${connectedSocketIds.size}`);
        console.log(`[JOIN DEBUG] Socket tentando entrar: ${socket.id}`);
        console.log(`[JOIN DEBUG] Sockets IDs conectados:`, Array.from(connectedSocketIds));
        
        // Atualizar lista removendo jogadores desconectados ANTES de qualquer verificação
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
        
        // Contar quantos jogadores REALMENTE conectados temos (DEPOIS da limpeza, ANTES de adicionar o novo)
        const playersActuallyConnectedBeforeJoin = game.players.length; // Já foi filtrada acima
        
        console.log(`[ROOM_CHECK] Jogadores na lista após limpeza: ${game.players.length}`);
        console.log(`[ROOM_CHECK] Jogadores realmente conectados (antes de adicionar novo): ${playersActuallyConnectedBeforeJoin}`);
        console.log(`[ROOM_CHECK] Sockets conectados no servidor: ${connectedSocketIds.size}`);
        console.log(`[ROOM_CHECK] Tentando adicionar jogador: ${nickname} (${socket.id})`);
        
        // Verificar se após adicionar este jogador, ainda temos espaço (max 4)
        // Como ainda não adicionamos o novo jogador, verificamos se temos menos de 4
        console.log(`[ROOM_CHECK FINAL] Verificando limite...`);
        console.log(`[ROOM_CHECK FINAL] playersActuallyConnectedBeforeJoin = ${playersActuallyConnectedBeforeJoin}`);
        console.log(`[ROOM_CHECK FINAL] game.players.length = ${game.players.length}`);
        console.log(`[ROOM_CHECK FINAL] connectedSocketIds.size = ${connectedSocketIds.size}`);
        
        if (playersActuallyConnectedBeforeJoin >= 4) {
          const playersInfo = game.players.map(p => ({ 
            id: p.id, 
            nickname: p.nickname,
            connected: connectedSocketIds.has(p.id)
          }));
          console.log(`[ROOM_FULL] ==================== SALA CHEIA ====================`);
          console.log(`[ROOM_FULL] Socket ${socket.id} (${nickname}) NÃO pode entrar!`);
          console.log(`[ROOM_FULL] Jogadores na lista: ${playersActuallyConnectedBeforeJoin}/4`);
          console.log(`[ROOM_FULL] Detalhes dos jogadores:`, JSON.stringify(playersInfo, null, 2));
          console.log(`[ROOM_FULL] Todos os sockets conectados:`, Array.from(connectedSocketIds));
          console.log(`[ROOM_FULL] ====================================================`);
          socket.emit("roomFull");
          return;
        }
        
        console.log(`[ROOM_CHECK FINAL] ✓ Há espaço! Permitindo entrada (${playersActuallyConnectedBeforeJoin}/4)`);
        
        
        // Se o jogo já começou, não pode entrar
        if (game.isGameStarted) {
          console.log(`Jogo já iniciado, não é possível entrar agora`);
          socket.emit("gameStarted");
          return;
        }
        
        // Adicionar jogador
        game.players.push({ id: socket.id, nickname: nickname.trim(), hand: [], score: 0, capturedCards: [] });
        console.log(`[JOIN SUCCESS] Jogador ${nickname} (${socket.id}) entrou com sucesso!`);
        console.log(`[JOIN SUCCESS] Total de jogadores agora: ${game.players.length}/4`);
        console.log(`[JOIN SUCCESS] Lista completa:`, game.players.map(p => `${p.nickname}(${p.id.substring(0, 8)}...)`).join(', '));
        
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
