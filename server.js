'use strict';

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const Chess = require('chess.js').Chess;

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

// rooms: Map<roomId, RoomState>
const rooms = new Map();

/*
  RoomState {
    id: string,
    status: 'waiting' | 'choosing_opponent' | 'waiting_for_second' | 'choosing_time' | 'playing' | 'finished',
    mode: null | 'ai' | 'human',
    players: { white: socketId|null, black: socketId|null|'ai' },
    game: Chess | null,
    timers: { w: seconds, b: seconds } | null,
    initialTime: number | null,
    timeoutHandle: Timeout | null,
    turnStartTime: number | null,  // Date.now() when current turn started
  }
*/

function getOrCreateRoom(roomId) {
  if (!rooms.has(roomId)) {
    rooms.set(roomId, {
      id: roomId,
      status: 'waiting',
      mode: null,
      players: { white: null, black: null },
      game: null,
      timers: null,
      initialTime: null,
      timeoutHandle: null,
      turnStartTime: null,
    });
  }
  return rooms.get(roomId);
}

function getRoomForSocket(socketId) {
  for (const room of rooms.values()) {
    if (room.players.white === socketId || room.players.black === socketId) {
      return room;
    }
  }
  return null;
}

function getPlayerColor(room, socketId) {
  if (room.players.white === socketId) return 'w';
  if (room.players.black === socketId) return 'b';
  return null;
}

// ── AI (minimax with alpha-beta pruning) ─────────────────────────────────────

const PIECE_VALUES = { p: 100, n: 320, b: 330, r: 500, q: 900, k: 20000 };

// Piece-square tables (from white's perspective; row 0 = rank 8)
const PST = {
  p: [
    [  0,  0,  0,  0,  0,  0,  0,  0],
    [ 50, 50, 50, 50, 50, 50, 50, 50],
    [ 10, 10, 20, 30, 30, 20, 10, 10],
    [  5,  5, 10, 25, 25, 10,  5,  5],
    [  0,  0,  0, 20, 20,  0,  0,  0],
    [  5, -5,-10,  0,  0,-10, -5,  5],
    [  5, 10, 10,-20,-20, 10, 10,  5],
    [  0,  0,  0,  0,  0,  0,  0,  0],
  ],
  n: [
    [-50,-40,-30,-30,-30,-30,-40,-50],
    [-40,-20,  0,  0,  0,  0,-20,-40],
    [-30,  0, 10, 15, 15, 10,  0,-30],
    [-30,  5, 15, 20, 20, 15,  5,-30],
    [-30,  0, 15, 20, 20, 15,  0,-30],
    [-30,  5, 10, 15, 15, 10,  5,-30],
    [-40,-20,  0,  5,  5,  0,-20,-40],
    [-50,-40,-30,-30,-30,-30,-40,-50],
  ],
  b: [
    [-20,-10,-10,-10,-10,-10,-10,-20],
    [-10,  0,  0,  0,  0,  0,  0,-10],
    [-10,  0,  5, 10, 10,  5,  0,-10],
    [-10,  5,  5, 10, 10,  5,  5,-10],
    [-10,  0, 10, 10, 10, 10,  0,-10],
    [-10, 10, 10, 10, 10, 10, 10,-10],
    [-10,  5,  0,  0,  0,  0,  5,-10],
    [-20,-10,-10,-10,-10,-10,-10,-20],
  ],
  r: [
    [  0,  0,  0,  0,  0,  0,  0,  0],
    [  5, 10, 10, 10, 10, 10, 10,  5],
    [ -5,  0,  0,  0,  0,  0,  0, -5],
    [ -5,  0,  0,  0,  0,  0,  0, -5],
    [ -5,  0,  0,  0,  0,  0,  0, -5],
    [ -5,  0,  0,  0,  0,  0,  0, -5],
    [ -5,  0,  0,  0,  0,  0,  0, -5],
    [  0,  0,  0,  5,  5,  0,  0,  0],
  ],
  q: [
    [-20,-10,-10, -5, -5,-10,-10,-20],
    [-10,  0,  0,  0,  0,  0,  0,-10],
    [-10,  0,  5,  5,  5,  5,  0,-10],
    [ -5,  0,  5,  5,  5,  5,  0, -5],
    [  0,  0,  5,  5,  5,  5,  0, -5],
    [-10,  5,  5,  5,  5,  5,  0,-10],
    [-10,  0,  5,  0,  0,  0,  0,-10],
    [-20,-10,-10, -5, -5,-10,-10,-20],
  ],
  k: [
    [-30,-40,-40,-50,-50,-40,-40,-30],
    [-30,-40,-40,-50,-50,-40,-40,-30],
    [-30,-40,-40,-50,-50,-40,-40,-30],
    [-30,-40,-40,-50,-50,-40,-40,-30],
    [-20,-30,-30,-40,-40,-30,-30,-20],
    [-10,-20,-20,-20,-20,-20,-20,-10],
    [ 20, 20,  0,  0,  0,  0, 20, 20],
    [ 20, 30, 10,  0,  0, 10, 30, 20],
  ],
};

function evaluateBoard(chess) {
  if (chess.in_checkmate()) {
    return chess.turn() === 'w' ? -30000 : 30000;
  }
  if (chess.in_draw()) return 0;

  let score = 0;
  const board = chess.board();
  for (let r = 0; r < 8; r++) {
    for (let c = 0; c < 8; c++) {
      const piece = board[r][c];
      if (!piece) continue;
      const val = PIECE_VALUES[piece.type];
      const pstRow = piece.color === 'w' ? r : 7 - r;
      const pstVal = PST[piece.type][pstRow][c];
      if (piece.color === 'w') {
        score += val + pstVal;
      } else {
        score -= val + pstVal;
      }
    }
  }
  return score;
}

function minimax(chess, depth, alpha, beta, maximizing) {
  if (depth === 0 || chess.game_over()) {
    return evaluateBoard(chess);
  }
  const moves = chess.moves();
  if (maximizing) {
    let best = -Infinity;
    for (const move of moves) {
      chess.move(move);
      best = Math.max(best, minimax(chess, depth - 1, alpha, beta, false));
      chess.undo();
      alpha = Math.max(alpha, best);
      if (beta <= alpha) break;
    }
    return best;
  } else {
    let best = Infinity;
    for (const move of moves) {
      chess.move(move);
      best = Math.min(best, minimax(chess, depth - 1, alpha, beta, true));
      chess.undo();
      beta = Math.min(beta, best);
      if (beta <= alpha) break;
    }
    return best;
  }
}

function getBestMove(chess) {
  const moves = chess.moves();
  if (moves.length === 0) return null;

  // Shuffle for variety among equal moves
  for (let i = moves.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [moves[i], moves[j]] = [moves[j], moves[i]];
  }

  // AI is black → minimise score
  let bestMove = null;
  let bestVal = Infinity;
  for (const move of moves) {
    chess.move(move);
    const val = minimax(chess, 2, -Infinity, Infinity, true);
    chess.undo();
    if (val < bestVal) {
      bestVal = val;
      bestMove = move;
    }
  }
  return bestMove;
}

// ── Timer helpers ────────────────────────────────────────────────────────────

function startTimeout(room) {
  if (room.timeoutHandle) clearTimeout(room.timeoutHandle);
  const turn = room.game.turn();
  const timeLeft = Math.max(0, room.timers[turn]) * 1000;
  room.turnStartTime = Date.now();
  room.timeoutHandle = setTimeout(() => {
    if (room.status !== 'playing') return;
    const winner = turn === 'w' ? 'b' : 'w';
    endGame(room, winner, 'timeout');
  }, timeLeft);
}

function clearRoomTimeout(room) {
  if (room.timeoutHandle) {
    clearTimeout(room.timeoutHandle);
    room.timeoutHandle = null;
  }
}

// Returns a snapshot of timers with the active player's elapsed time deducted
function getTimerSnapshot(room) {
  const timers = Object.assign({}, room.timers);
  if (room.status === 'playing' && room.turnStartTime) {
    const elapsed = (Date.now() - room.turnStartTime) / 1000;
    const turn = room.game.turn();
    timers[turn] = Math.max(0, timers[turn] - elapsed);
  }
  return timers;
}

// ── Game lifecycle ────────────────────────────────────────────────────────────

function endGame(room, winner, reason) {
  clearRoomTimeout(room);
  room.status = 'finished';
  const timers = getTimerSnapshot(room);
  io.to(room.id).emit('game_over', { winner, reason, fen: room.game.fen(), timers });
  // Keep the room around briefly so late-arriving clients can see the result
  setTimeout(() => rooms.delete(room.id), 60000);
}

function startGame(room) {
  room.game = new Chess();
  room.status = 'playing';

  io.to(room.id).emit('game_start', {
    fen: room.game.fen(),
    mode: room.mode,
    timers: Object.assign({}, room.timers),
    players: room.players,
    currentTurn: 'w',
    serverTime: Date.now(),
  });

  startTimeout(room);
}

// ── Socket.IO ────────────────────────────────────────────────────────────────

io.on('connection', (socket) => {
  console.log(`[connect] ${socket.id}`);

  // ── join_room ──────────────────────────────────────────────────────────────
  socket.on('join_room', ({ roomId }) => {
    if (!roomId || typeof roomId !== 'string') return;
    const room = getOrCreateRoom(roomId);

    if (room.status === 'playing' || room.status === 'finished') {
      socket.join(roomId);
      socket.emit('spectator', {
        fen: room.game ? room.game.fen() : null,
        timers: getTimerSnapshot(room),
        status: room.status,
        players: room.players,
        currentTurn: room.game ? room.game.turn() : null,
        serverTime: Date.now(),
      });
      return;
    }

    if (!room.players.white) {
      // First player — always white
      room.players.white = socket.id;
      socket.join(roomId);
      room.status = 'choosing_opponent';
      socket.emit('choose_opponent', { roomId });
    } else if (room.status === 'waiting_for_second' && !room.players.black) {
      // Second player joining a human game
      room.players.black = socket.id;
      socket.join(roomId);
      room.status = 'choosing_time';
      io.to(room.players.white).emit('opponent_joined');
      socket.emit('choose_time', { role: 'black', roomId });
    } else {
      // Room already has the slots filled; join as spectator
      socket.join(roomId);
      socket.emit('spectator', {
        fen: room.game ? room.game.fen() : null,
        status: room.status,
      });
    }
  });

  // ── choose_opponent ────────────────────────────────────────────────────────
  socket.on('choose_opponent', ({ type }) => {
    const room = getRoomForSocket(socket.id);
    if (!room || room.status !== 'choosing_opponent') return;
    if (room.players.white !== socket.id) return;

    room.mode = type;
    if (type === 'ai') {
      room.status = 'choosing_time';
      socket.emit('choose_time', { role: 'white', roomId: room.id });
    } else {
      room.status = 'waiting_for_second';
      socket.emit('waiting_for_opponent', { roomId: room.id });
    }
  });

  // ── choose_time ────────────────────────────────────────────────────────────
  socket.on('choose_time', ({ minutes }) => {
    const room = getRoomForSocket(socket.id);
    if (!room || room.status !== 'choosing_time') return;
    if (typeof minutes !== 'number' || minutes <= 0) return;

    // Only the white player can set time for AI mode;
    // only the black player sets it for human-vs-human
    if (room.mode === 'ai' && room.players.white !== socket.id) return;
    if (room.mode === 'human' && room.players.black !== socket.id) return;

    const seconds = minutes * 60;
    room.initialTime = seconds;
    room.timers = { w: seconds, b: seconds };

    if (room.mode === 'ai') {
      room.players.black = 'ai';
    }
    startGame(room);
  });

  // ── make_move ──────────────────────────────────────────────────────────────
  socket.on('make_move', ({ from, to, promotion }) => {
    const room = getRoomForSocket(socket.id);
    if (!room || room.status !== 'playing') return;

    const playerColor = getPlayerColor(room, socket.id);
    if (!playerColor || playerColor !== room.game.turn()) return;

    // Deduct time the player spent thinking
    const elapsed = (Date.now() - room.turnStartTime) / 1000;
    room.timers[playerColor] -= elapsed;

    if (room.timers[playerColor] <= 0) {
      room.timers[playerColor] = 0;
      endGame(room, playerColor === 'w' ? 'b' : 'w', 'timeout');
      return;
    }

    // Attempt the move
    const moveObj = { from, to };
    if (promotion) moveObj.promotion = promotion;
    const moveResult = room.game.move(moveObj);

    if (!moveResult) {
      // Restore thinking time — the move was illegal
      room.timers[playerColor] += elapsed;
      socket.emit('invalid_move', { from, to });
      return;
    }

    clearRoomTimeout(room);

    const over = room.game.game_over();
    const moveMadePayload = {
      move: moveResult,
      fen: room.game.fen(),
      timers: Object.assign({}, room.timers),
      currentTurn: room.game.turn(),
      serverTime: Date.now(),
    };

    if (over) {
      io.to(room.id).emit('move_made', moveMadePayload);
      endGame(room, getCheckmateWinner(room.game), getGameEndReason(room.game));
      return;
    }

    room.turnStartTime = Date.now();
    io.to(room.id).emit('move_made', moveMadePayload);
    startTimeout(room);

    // AI response (only when it's the AI's turn)
    if (room.mode === 'ai' && room.game.turn() === 'b') {
      scheduleAiMove(room);
    }
  });

  // ── resign ─────────────────────────────────────────────────────────────────
  socket.on('resign', () => {
    const room = getRoomForSocket(socket.id);
    if (!room || room.status !== 'playing') return;
    const color = getPlayerColor(room, socket.id);
    if (!color) return;
    endGame(room, color === 'w' ? 'b' : 'w', 'resignation');
  });

  // ── disconnect ─────────────────────────────────────────────────────────────
  socket.on('disconnect', () => {
    console.log(`[disconnect] ${socket.id}`);
    const room = getRoomForSocket(socket.id);
    if (!room) return;

    if (room.status === 'playing') {
      const color = getPlayerColor(room, socket.id);
      if (color) endGame(room, color === 'w' ? 'b' : 'w', 'disconnect');
      return;
    }

    // Game not started yet — clean up the slot
    clearRoomTimeout(room);
    let otherSocket = null;
    if (room.players.white === socket.id) {
      room.players.white = null;
      if (room.players.black && room.players.black !== 'ai') {
        otherSocket = room.players.black;
      }
    } else if (room.players.black === socket.id) {
      room.players.black = null;
      if (room.players.white) {
        otherSocket = room.players.white;
      }
    }

    if (otherSocket) {
      io.to(otherSocket).emit('opponent_left');
      // Reset so the remaining player can restart
      room.status = 'choosing_opponent';
      room.mode = null;
      room.players = { white: otherSocket, black: null };
    } else {
      rooms.delete(room.id);
    }
  });
});

// ── AI move scheduling ────────────────────────────────────────────────────────

function scheduleAiMove(room) {
  // Small delay so the AI doesn't appear to move instantly
  setTimeout(() => {
    if (room.status !== 'playing') return;

    const aiStart = Date.now();
    const aiMove = getBestMove(room.game);
    if (!aiMove) return;

    const aiElapsed = (Date.now() - aiStart) / 1000;
    room.timers.b = Math.max(0, room.timers.b - aiElapsed);

    room.game.move(aiMove);
    clearRoomTimeout(room);

    const over = room.game.game_over();
    const payload = {
      move: { san: aiMove, from: null, to: null },
      fen: room.game.fen(),
      timers: Object.assign({}, room.timers),
      currentTurn: room.game.turn(),
      serverTime: Date.now(),
    };

    if (over) {
      io.to(room.id).emit('move_made', payload);
      endGame(room, getCheckmateWinner(room.game), getGameEndReason(room.game));
      return;
    }

    room.turnStartTime = Date.now();
    io.to(room.id).emit('move_made', payload);
    startTimeout(room);
  }, 400);
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function getCheckmateWinner(chess) {
  if (chess.in_checkmate()) {
    // The player whose turn it is has been checkmated — the other player wins
    return chess.turn() === 'w' ? 'b' : 'w';
  }
  return null; // draw
}

function getGameEndReason(chess) {
  if (chess.in_checkmate()) return 'checkmate';
  if (chess.in_stalemate()) return 'stalemate';
  if (chess.insufficient_material()) return 'insufficient_material';
  if (chess.in_threefold_repetition()) return 'threefold_repetition';
  if (chess.in_draw()) return 'fifty_move_rule';
  return 'draw';
}

// ── Start server ──────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Chess server running at http://localhost:${PORT}`);
  console.log('Usage: visit http://localhost:' + PORT + '/?room=<room-name>');
});
