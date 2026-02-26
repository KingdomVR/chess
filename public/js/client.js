'use strict';

// ── Unicode piece map ──────────────────────────────────────────────────────────
const PIECE_UNICODE = {
  wp: '♙', wn: '♘', wb: '♗', wr: '♖', wq: '♕', wk: '♔',
  bp: '♟', bn: '♞', bb: '♝', br: '♜', bq: '♛', bk: '♚',
};

// ── State ──────────────────────────────────────────────────────────────────────
const state = {
  roomId:        null,
  myColor:       null,   // 'w' | 'b' | null (spectator)
  fen:           null,
  timers:        null,   // { w: seconds, b: seconds }
  currentTurn:   null,
  serverTime:    null,
  selectedSq:    null,   // currently selected square name
  pendingPromo:  null,   // { from, to } awaiting promotion choice
  gameMode:      null,   // 'ai' | 'human'
  isSpectator:   false,
};

let timerRafId   = null;
let chessClient  = null;  // chess.js instance (for highlighting), may be null if CDN fails

// ── Socket ────────────────────────────────────────────────────────────────────
const socket = io();

// ── Init ──────────────────────────────────────────────────────────────────────
window.addEventListener('DOMContentLoaded', () => {
  const params = new URLSearchParams(window.location.search);
  state.roomId = (params.get('room') || 'default').trim();
  document.getElementById('room-display').textContent = state.roomId;
  document.getElementById('share-link').textContent  = window.location.href;

  bindUI();

  socket.emit('join_room', { roomId: state.roomId });
});

// ── Utility: show a named screen ──────────────────────────────────────────────
function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.add('hidden'));
  document.getElementById(id).classList.remove('hidden');
}

// ── UI event bindings ─────────────────────────────────────────────────────────
function bindUI() {
  // Opponent selection: single AI button; actual AI level chosen on the time screen
  const btnAi = document.getElementById('btn-ai');
  if (btnAi) btnAi.addEventListener('click', () => {
    state.pendingAi = true;
    socket.emit('choose_opponent', { type: 'ai' });
  });

  const btnHuman = document.getElementById('btn-human');
  if (btnHuman) btnHuman.addEventListener('click', () => {
    state.pendingAi = false;
    socket.emit('choose_opponent', { type: 'human' });
  });

  document.querySelectorAll('.time-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const minutes = Number(btn.dataset.minutes);
      // If this is an AI flow, include the selected AI level so server gets the intended rating.
      if (state.pendingAi) {
        const level = state.chosenAiLevel || (document.querySelector('input[name="ai-level"]:checked') ? Number(document.querySelector('input[name="ai-level"]:checked').value) : 900);
        console.log('[client] emitting choose_time (AI)', { minutes, level, pendingAi: state.pendingAi });
        socket.emit('choose_time', { minutes, level });
      } else {
        // Human flow: second player presses a time button to start
        console.log('[client] emitting choose_time (human)', { minutes });
        socket.emit('choose_time', { minutes });
      }
    });
  });

  // AI start/cancel handlers (on choose-time screen)
  const aiStart = document.getElementById('ai-start');
  const aiCancel = document.getElementById('ai-cancel');
  if (aiStart) aiStart.addEventListener('click', () => {
    const timeEl = document.querySelector('input[name="ai-time"]:checked');
    const lvlEl = document.querySelector('input[name="ai-level"]:checked');
    const minutes = timeEl ? Number(timeEl.value) : 5;
    const level = lvlEl ? Number(lvlEl.value) : 900;
    state.chosenAiLevel = level;
    console.log('[client] ai-start emitting choose_time', { minutes, level });
    socket.emit('choose_time', { minutes, level });
    // clear pending flag once we've started the AI game
    state.pendingAi = false;
  });
  if (aiCancel) aiCancel.addEventListener('click', () => {
    state.pendingAi = false;
    // go back to opponent selection
    showScreen('screen-choose-opponent');
  });

  const btnCopy = document.getElementById('btn-copy');
  if (btnCopy) btnCopy.addEventListener('click', () => {
    navigator.clipboard.writeText(window.location.href).then(() => {
      btnCopy.textContent = '✓ Copied';
      setTimeout(() => { btnCopy.textContent = 'Copy'; }, 1500);
    });
  });

  const btnResign = document.getElementById('btn-resign');
  if (btnResign) btnResign.addEventListener('click', () => {
    if (confirm('Resign this game?')) socket.emit('resign');
  });

  const btnNew = document.getElementById('btn-new-game');
  if (btnNew) btnNew.addEventListener('click', () => {
    window.location.reload();
  });
}

// ── Socket event handlers ──────────────────────────────────────────────────────

// join_room is emitted once from DOMContentLoaded; socket.io buffers it
// until the connection is established, so no need to re-emit on 'connect'.

socket.on('choose_opponent', () => {
  state.myColor = 'w';
  console.log('[client] choose_opponent (you are white)');
  showScreen('screen-choose-opponent');
});

socket.on('choose_time', ({ role }) => {
  if (role === 'black') state.myColor = 'b';
  console.log('[client] choose_time role=', role);
  // If we're selecting time as white and a pending AI flow exists, show AI radio selectors
  const aiDiv = document.getElementById('ai-config');
  const timeGrid = document.querySelector('.time-grid');
  if (state.pendingAi && role === 'white') {
    if (aiDiv) aiDiv.classList.remove('hidden');
    if (timeGrid) timeGrid.classList.add('hidden');
    // default selection
    state.chosenAiLevel = state.chosenAiLevel || 900;
    // set radio defaults
    const lvl = document.querySelector('input[name="ai-level"][value="' + state.chosenAiLevel + '"]');
    if (lvl) lvl.checked = true;
    const time = document.querySelector('input[name="ai-time"][value="5"]');
    if (time) time.checked = true;
  } else {
    if (aiDiv) aiDiv.classList.add('hidden');
    if (timeGrid) timeGrid.classList.remove('hidden');
  }
  showScreen('screen-choose-time');
});

socket.on('waiting_for_opponent', () => {
  console.log('[client] waiting_for_opponent');
  showScreen('screen-waiting');
});

socket.on('opponent_joined', () => {
  document.getElementById('waiting-msg').textContent =
    'Opponent joined — waiting for time selection…';
  console.log('[client] opponent_joined');
});

socket.on('opponent_left', () => {
  showScreen('screen-choose-opponent');
});

socket.on('game_start', (data) => {
  console.log('[client] game_start', data);
  // Determine our colour from the players map
  if (data.players.white === socket.id)      state.myColor = 'w';
  else if (data.players.black === socket.id) state.myColor = 'b';
  else if (!state.myColor)                   state.myColor = 'w';

  state.fen         = data.fen;
  state.timers      = Object.assign({}, data.timers);
  state.currentTurn = data.currentTurn;
  state.serverTime  = data.serverTime;
  state.gameMode    = data.mode;
  state.isSpectator = false;

  setPlayerNames(data);
  showScreen('screen-game');
  renderBoard('board');
  setStatus(state.currentTurn === state.myColor ? 'Your turn' : "Opponent's turn");
  startTimerLoop();
});

socket.on('move_made', (data) => {
  console.log('[client] move_made', data.move || data);
  state.fen         = data.fen;
  state.timers      = Object.assign({}, data.timers);
  state.currentTurn = data.currentTurn;
  state.serverTime  = data.serverTime;
  state.selectedSq  = null;

  renderBoard('board', data.move);
  const myTurn = !state.isSpectator && state.currentTurn === state.myColor;
  setStatus(myTurn ? 'Your turn' : "Opponent's turn");
});

socket.on('invalid_move', () => {
  console.log('[client] invalid_move');
  state.selectedSq = null;
  renderBoard('board');
});

socket.on('game_over', (data) => {
  console.log('[client] game_over', data);
  stopTimerLoop();
  state.fen    = data.fen;
  state.timers = Object.assign({}, data.timers);

  // Final board position on the result screen
  renderBoard('final-board');

  const REASONS = {
    checkmate:             'by checkmate',
    stalemate:             'by stalemate',
    insufficient_material: 'by insufficient material',
    threefold_repetition:  'by threefold repetition',
    fifty_move_rule:       'by the 50-move rule',
    timeout:               'on time',
    resignation:           'by resignation',
    disconnect:            '— opponent disconnected',
  };
  const reasonText = REASONS[data.reason] || data.reason;

  let title;
  if (!data.winner) {
    title = 'Draw';
  } else if (!state.isSpectator && data.winner === state.myColor) {
    title = '🏆 You Win!';
  } else if (!state.isSpectator) {
    title = 'You Lose';
  } else {
    title = data.winner === 'w' ? 'White wins' : 'Black wins';
  }

  document.getElementById('result-title').textContent  = title;
  document.getElementById('result-reason').textContent = reasonText;
  showScreen('screen-gameover');
});

socket.on('spectator', (data) => {
  console.log('[client] spectator', data);
  state.isSpectator = true;
  state.myColor     = 'w';
  if (data.fen) {
    state.fen         = data.fen;
    state.timers      = data.timers || { w: 0, b: 0 };
    state.currentTurn = data.currentTurn;
    state.serverTime  = data.serverTime;
    setPlayerNames({ players: data.players || {}, mode: 'human' });
    showScreen('screen-game');
    renderBoard('board');
    setStatus('Spectating');
    if (data.status === 'playing') startTimerLoop();
  } else {
    setStatus('Spectating (game not started)');
    showScreen('screen-game');
  }
});

socket.on('room_full', () => {
  alert('This room is already full.');
  console.log('[client] room_full');
});

// ── Board rendering ────────────────────────────────────────────────────────────

/**
 * Parse a FEN board string into an 8×8 array.
 * [0][0] = a8, [7][7] = h1  (same as chess.js .board() layout)
 */
function parseFEN(fen) {
  const grid = Array.from({ length: 8 }, () => Array(8).fill(null));
  const rows = fen.split(' ')[0].split('/');
  for (let r = 0; r < 8; r++) {
    let c = 0;
    for (const ch of rows[r]) {
      if (ch >= '1' && ch <= '8') {
        c += parseInt(ch, 10);
      } else {
        grid[r][c] = {
          color: ch === ch.toUpperCase() ? 'w' : 'b',
          type:  ch.toLowerCase(),
        };
        c++;
      }
    }
  }
  return grid;
}

/**
 * Return an array of valid target square names for the piece on `square`,
 * using the chess.js client instance if available.
 */
function getValidTargets(square) {
  if (typeof Chess === 'undefined' || !state.fen) return [];
  try {
    if (!chessClient) chessClient = new Chess(state.fen);
    else chessClient.load(state.fen);
    return chessClient
      .moves({ square, verbose: true })
      .map(m => m.to);
  } catch (e) {
    return [];
  }
}

function squareName(boardRow, boardCol) {
  return String.fromCharCode(97 + boardCol) + (8 - boardRow);
}

/**
 * Render the chess board into the element with the given id.
 * @param {string} boardId  — 'board' or 'final-board'
 * @param {object} lastMove — optional { from, to } to highlight last move
 */
function renderBoard(boardId, lastMove) {
  const boardEl = document.getElementById(boardId);
  if (!boardEl) return;
  boardEl.innerHTML = '';

  const grid    = parseFEN(state.fen);
  const flipped = state.myColor === 'b';

  // Valid-move hints for the selected square
  const hints = new Set(
    (boardId === 'board' && state.selectedSq)
      ? getValidTargets(state.selectedSq)
      : []
  );

  // Normalise lastMove: handle either {from,to} or the SAN-only form from AI
  const lf = lastMove && lastMove.from ? lastMove.from : null;
  const lt = lastMove && lastMove.to   ? lastMove.to   : null;

  for (let vr = 0; vr < 8; vr++) {
    for (let vc = 0; vc < 8; vc++) {
      const br = flipped ? 7 - vr : vr;
      const bc = flipped ? 7 - vc : vc;

      const sqName  = squareName(br, bc);
      const piece   = grid[br][bc];
      const isLight = (br + bc) % 2 === 0;

      const sqEl = document.createElement('div');
      sqEl.className = 'sq ' + (isLight ? 'light' : 'dark');
      sqEl.dataset.sq = sqName;

      if (sqName === state.selectedSq) sqEl.classList.add('sel');
      if (sqName === lf || sqName === lt) sqEl.classList.add(sqName === lf ? 'last-from' : 'last-to');

      if (hints.has(sqName)) {
        sqEl.classList.add('hint');
        if (piece) sqEl.classList.add('occupied');
      }

      // Coordinate labels
      if (vc === 0) {
        const rank = document.createElement('span');
        rank.className = 'coord-rank';
        rank.textContent = 8 - br;
        sqEl.appendChild(rank);
      }
      if (vr === 7) {
        const file = document.createElement('span');
        file.className = 'coord-file';
        file.textContent = String.fromCharCode(97 + bc);
        sqEl.appendChild(file);
      }

      // Piece (image with unicode fallback)
      if (piece) {
        const pieceEl = document.createElement('div');
        pieceEl.className = 'piece piece-' + piece.color;

        const img = document.createElement('img');
        img.src = `/img/${piece.color}${piece.type}.svg`;
        img.alt = piece.color + piece.type;
        img.addEventListener('error', () => {
          pieceEl.textContent = PIECE_UNICODE[piece.color + piece.type] || '?';
        });
        pieceEl.appendChild(img);
        sqEl.appendChild(pieceEl);
      }

      // Click handler only on the live board
      if (boardId === 'board') {
        sqEl.addEventListener('click', () => onSquareClick(sqName));
      }

      boardEl.appendChild(sqEl);
    }
  }
}

// ── Move input ────────────────────────────────────────────────────────────────

function onSquareClick(sq) {
  if (state.isSpectator) return;
  if (state.currentTurn !== state.myColor) return;

  const grid = parseFEN(state.fen);
  const bc   = sq.charCodeAt(0) - 97;
  const br   = 8 - parseInt(sq[1], 10);
  const piece = grid[br][bc];

  if (!state.selectedSq) {
    // Nothing selected yet — pick a piece of our colour
    if (piece && piece.color === state.myColor) {
      state.selectedSq = sq;
      renderBoard('board');
    }
    return;
  }

  if (state.selectedSq === sq) {
    // Clicked same square — deselect
    state.selectedSq = null;
    renderBoard('board');
    return;
  }

  // Clicked on another own piece — re-select
  if (piece && piece.color === state.myColor) {
    state.selectedSq = sq;
    renderBoard('board');
    return;
  }

  // Attempt a move
  const from = state.selectedSq;
  const to   = sq;
  state.selectedSq = null;

  // Check for pawn promotion
  const srcBc = from.charCodeAt(0) - 97;
  const srcBr = 8 - parseInt(from[1], 10);
  const srcPiece = grid[srcBr][srcBc];
  const isPawnPromo =
    srcPiece && srcPiece.type === 'p' &&
    ((srcPiece.color === 'w' && parseInt(to[1], 10) === 8) ||
     (srcPiece.color === 'b' && parseInt(to[1], 10) === 1));

  if (isPawnPromo) {
    state.pendingPromo = { from, to };
    showPromoModal();
  } else {
    socket.emit('make_move', { from, to });
    renderBoard('board');
  }
}

// ── Promotion modal ────────────────────────────────────────────────────────────

function showPromoModal() {
  const modal = document.getElementById('promo-modal');
  const choices = document.getElementById('promo-choices');
  choices.innerHTML = '';

  const col  = state.myColor;
  const pieces = ['q', 'r', 'b', 'n'];
  pieces.forEach(type => {
    const el = document.createElement('div');
    el.className = 'promo-piece';
    const img = document.createElement('img');
    img.src = `/img/${col}${type}.svg`;
    img.alt = col + type;
    img.addEventListener('error', () => {
      el.textContent = PIECE_UNICODE[col + type];
    });
    el.appendChild(img);
    el.addEventListener('click', () => {
      if (state.pendingPromo) {
        socket.emit('make_move', {
          from:      state.pendingPromo.from,
          to:        state.pendingPromo.to,
          promotion: type,
        });
        state.pendingPromo = null;
      }
      hidePromoModal();
    });
    choices.appendChild(el);
  });

  modal.classList.remove('hidden');
}

function hidePromoModal() {
  document.getElementById('promo-modal').classList.add('hidden');
  state.pendingPromo = null;
}

// ── Timers ────────────────────────────────────────────────────────────────────

function formatTime(secs) {
  secs = Math.max(0, Math.floor(secs));
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
}

function updateTimerDisplay() {
  if (!state.timers) return;

  const elapsed = state.serverTime
    ? (Date.now() - state.serverTime) / 1000
    : 0;

  const timers = Object.assign({}, state.timers);
  if (state.currentTurn && state.status !== 'gameover') {
    timers[state.currentTurn] = Math.max(
      0,
      timers[state.currentTurn] - elapsed
    );
  }

  const myT   = timers[state.myColor]                          || 0;
  const oppT  = timers[state.myColor === 'w' ? 'b' : 'w']     || 0;

  const botEl = document.getElementById('timer-bottom');
  const topEl = document.getElementById('timer-top');

  botEl.textContent = formatTime(myT);
  topEl.textContent = formatTime(oppT);

  // Active timer highlight
  botEl.classList.toggle('active', state.currentTurn === state.myColor);
  topEl.classList.toggle('active', state.currentTurn !== state.myColor);

  // Low-time warning (< 10 s)
  botEl.classList.toggle('low', myT  < 10);
  topEl.classList.toggle('low', oppT < 10);
}

function startTimerLoop() {
  stopTimerLoop();
  function tick() {
    updateTimerDisplay();
    timerRafId = requestAnimationFrame(tick);
  }
  timerRafId = requestAnimationFrame(tick);
}

function stopTimerLoop() {
  if (timerRafId !== null) {
    cancelAnimationFrame(timerRafId);
    timerRafId = null;
  }
}

// ── Misc helpers ───────────────────────────────────────────────────────────────

function setStatus(msg) {
  const el = document.getElementById('game-status');
  if (el) el.textContent = msg;
}

function setPlayerNames(data) {
  const topEl  = document.getElementById('name-top');
  const botEl  = document.getElementById('name-bottom');
  const oppColor = state.myColor === 'w' ? 'b' : 'w';
  // Show AI label including elo when applicable
  let oppLabel = 'Opponent';
  if (data.mode === 'ai') {
    const elo = data.aiLevel || data.aiLevel === 0 ? data.aiLevel : (state.chosenAiLevel || 900);
    oppLabel = `AI (${elo})`;
  }

  if (state.myColor === 'w') {
    botEl.textContent = 'You (White)';
    topEl.textContent = oppLabel + ' (Black)';
  } else {
    botEl.textContent = 'You (Black)';
    topEl.textContent = oppLabel + ' (White)';
  }
}

function highlightAiLevel(level) {
  ['400','900','1300'].forEach(l => {
    const el = document.getElementById('ai-level-' + l);
    if (!el) return;
    // For radio inputs, toggle a 'selected' class on the parent label if present
    const label = el.closest('label') || el;
    label.classList.toggle('selected', String(level) === l);
  });
}
