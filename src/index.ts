import express from "express";
import { createServer } from "http";
import { Server } from "socket.io";
import { createGame, playCard, startGame } from "./gameLogic";
import { GameState } from "./types";

const app = express();
const httpServer = createServer(app);

// CORS configuration - allow frontend URLs
const allowedOrigins = process.env.ALLOWED_ORIGINS 
  ? process.env.ALLOWED_ORIGINS.split(',')
  : ['http://localhost:5173', 'http://localhost:3000'];

const io = new Server(httpServer, { 
  cors: { 
    origin: allowedOrigins,
    methods: ['GET', 'POST'],
    credentials: true
  } 
});

let game: GameState = createGame();

// Função para limpar jogadores desconectados
function cleanupDisconnectedPlayers() {
  const connectedSocketIds = new Set(Array.from(io.sockets.sockets.keys()));
  const validPlayers = game.players.filter(p => connectedSocketIds.has(p.id));
  
  if (validPlayers.length !== game.players.length) {
    console.log(`Limpando jogadores desconectados. De ${game.players.length} para ${validPlayers.length}`);
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
  console.log(`Jogador conectado: ${socket.id}`);
  
  // Limpar jogadores desconectados ao conectar
  cleanupDisconnectedPlayers();

  socket.on("joinGame", (nickname: string) => {
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
      console.log(`Sala cheia. Jogadores atuais: ${game.players.length}`, game.players.map(p => ({ id: p.id, nickname: p.nickname })));
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

  socket.on("disconnect", () => {
    console.log(`Jogador saiu: ${socket.id}`);
    const playerLeft = game.players.find(p => p.id === socket.id);
    
    // Remover jogador
    game.players = game.players.filter((p) => p.id !== socket.id);
    console.log(`Jogadores restantes: ${game.players.length}`);
    
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
