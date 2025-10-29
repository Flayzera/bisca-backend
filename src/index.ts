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

io.on("connection", (socket) => {
  console.log(`Jogador conectado: ${socket.id}`);

  socket.on("joinGame", (nickname: string) => {
    if (game.players.length >= 4) {
      socket.emit("roomFull");
      return;
    }
    
    // Adicionar jogador
    game.players.push({ id: socket.id, nickname, hand: [], score: 0, capturedCards: [] });
    socket.emit("gameState", game);
    io.emit("playersUpdate", game.players);
    
    // Se tiver 2 ou 4 jogadores, inicia o jogo automaticamente
    if (game.players.length === 2 || game.players.length === 4) {
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
    game.players = game.players.filter((p) => p.id !== socket.id);
    io.emit("playersUpdate", game.players);
    
    // Se restaram menos de 2 jogadores, reseta o jogo
    if (game.players.length < 2) {
      game = createGame();
      io.emit("gameState", game);
    }
  });
});

const PORT = process.env.PORT || 3000;

httpServer.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});
