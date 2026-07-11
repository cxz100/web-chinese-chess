/**
 * App controller: home screen, AI games (local clock + worker engine),
 * online PvP games (server-authoritative), clocks with 3s increment.
 */
import {
  initialBoard, legalDests, applyMove, undoMove, inCheck, status as gameStatus,
  positionKey, describeMove, sideOf, opposite, findKing, RED, BLACK,
} from '/shared/xiangqi.js';
import { BoardView } from '/js/board.js';
import { Net } from '/js/net.js';

const $ = (sel) => document.querySelector(sel);

const AI_LEVELS = {
  easy: { timeMs: 250, maxDepth: 2, randomness: 80, label: '简单' },
  medium: { timeMs: 900, maxDepth: 10, randomness: 12, label: '中等' },
  hard: { timeMs: 2600, maxDepth: 24, randomness: 0, label: '困难' },
};

const REASON_TEXT = {
  checkmate: '绝杀',
  stalemate: '困毙（无子可动）',
  timeout: '超时',
  resign: '认输',
  abandon: '对方退出对局',
  repetition: '重复局面',
  agreement: '双方同意和棋',
};

// ---------- Global state ----------

const settings = {
  mode: 'ai',
  tc: 600000,
  aiLevel: 'medium',
  aiSide: 'r', // player's side; 'random'
};

let game = null; // active game state
let boardView = null;
let aiWorker = null;
const net = new Net();

// Remembers an in-progress quick-match request so it can be re-sent if the
// connection drops while waiting in the queue (the server silently removes
// disconnected players from the queue).
let pvpIntent = null; // { type: 'quick', tc }

// ---------- Screens ----------

function showScreen(id) {
  document.querySelectorAll('.screen').forEach((s) => s.classList.remove('active'));
  $(id).classList.add('active');
}

// ---------- Option pickers ----------

function bindOptionRow(rowSel, attr, onPick) {
  const row = $(rowSel);
  row.addEventListener('click', (e) => {
    const btn = e.target.closest('.opt-btn');
    if (!btn) return;
    row.querySelectorAll('.opt-btn').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    onPick(btn.dataset[attr]);
  });
}

bindOptionRow('#tc-options', 'tc', (v) => { settings.tc = Number(v); });
bindOptionRow('#ai-level-options', 'level', (v) => { settings.aiLevel = v; });
bindOptionRow('#ai-side-options', 'side', (v) => { settings.aiSide = v; });

document.querySelectorAll('.mode-tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.mode-tab').forEach((t) => t.classList.remove('active'));
    tab.classList.add('active');
    settings.mode = tab.dataset.mode;
    $('#panel-ai').classList.toggle('active', settings.mode === 'ai');
    $('#panel-pvp').classList.toggle('active', settings.mode === 'pvp');
  });
});

// ---------- Clock helpers ----------

function fmtClock(ms) {
  ms = Math.max(0, ms);
  const total = Math.ceil(ms / 1000);
  if (ms < 10000) {
    return `0:0${(ms / 1000).toFixed(1)}`;
  }
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function displayedClocks() {
  const clocks = { ...game.clocks };
  if (!game.over && game.started && game.turnStart) {
    clocks[game.turn] = clocks[game.turn] - (Date.now() - game.turnStart);
  }
  return clocks;
}

function renderClocks() {
  if (!game) return;
  const clocks = displayedClocks();
  const mySide = game.mySide;
  const bottom = clocks[mySide];
  const top = clocks[opposite(mySide)];
  const elBottom = $('#clock-bottom');
  const elTop = $('#clock-top');
  elBottom.textContent = fmtClock(bottom);
  elTop.textContent = fmtClock(top);
  for (const [el, side, val] of [[elBottom, mySide, bottom], [elTop, opposite(mySide), top]]) {
    const active = !game.over && game.started && game.turn === side;
    el.classList.toggle('running', active && val >= 30000);
    el.classList.toggle('low', active && val < 30000);
  }
}

function startClockLoop() {
  stopClockLoop();
  game.clockInterval = setInterval(() => {
    renderClocks();
    // Local flag-fall detection (authoritative only in AI mode).
    if (game.kind === 'ai' && !game.over && game.started) {
      const clocks = displayedClocks();
      if (clocks[game.turn] <= 0) {
        game.clocks[game.turn] = 0;
        finishAiGame(opposite(game.turn), 'timeout');
      }
    }
  }, 100);
}

function stopClockLoop() {
  if (game && game.clockInterval) clearInterval(game.clockInterval);
}

// ---------- Rendering helpers ----------

function refreshBoard(extra = {}) {
  const checkedKing = !game.over && inCheck(game.board, game.turn)
    ? findKing(game.board, game.turn) : -1;
  boardView.setState({
    board: game.board,
    selected: game.selected,
    legalDests: game.selected >= 0 ? legalDests(game.board, game.selected) : [],
    lastMove: game.lastMove,
    checkedKing,
    flipped: game.mySide === BLACK,
    ...extra,
  });
}

function setStatus(text) {
  $('#status-line').textContent = text;
}

function appendMoveToList(desc, side, moveNo) {
  const list = $('#move-list');
  if (side === RED) {
    const li = document.createElement('li');
    li.innerHTML = `<span class="mv-no">${moveNo}.</span><span class="mv-red"></span><span class="mv-black"></span>`;
    li.querySelector('.mv-red').textContent = desc;
    list.appendChild(li);
  } else {
    let li = list.lastElementChild;
    if (!li || li.querySelector('.mv-black').textContent) {
      li = document.createElement('li');
      li.innerHTML = `<span class="mv-no">${moveNo}.</span><span class="mv-red">…</span><span class="mv-black"></span>`;
      list.appendChild(li);
    }
    li.querySelector('.mv-black').textContent = desc;
  }
  list.scrollTop = list.scrollHeight;
}

function rebuildMoveList(moves) {
  $('#move-list').innerHTML = '';
  moves.forEach((m, i) => {
    appendMoveToList(m.desc, i % 2 === 0 ? RED : BLACK, Math.floor(i / 2) + 1);
  });
}

let toastTimer = null;
function toast(text, ms = 1100) {
  const el = $('#board-toast');
  el.textContent = text;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, ms);
}

function setPlayerBars() {
  const mySide = game.mySide;
  const oppSide = opposite(mySide);
  const myRed = mySide === RED;
  $('#bottom-piece').textContent = myRed ? '帅' : '将';
  $('#bottom-piece').classList.toggle('red', myRed);
  $('#top-piece').textContent = myRed ? '将' : '帅';
  $('#top-piece').classList.toggle('red', !myRed);
  $('#bottom-name').textContent = `我（${myRed ? '红方' : '黑方'}）`;
  if (game.kind === 'ai') {
    $('#top-name').textContent = `电脑 · ${AI_LEVELS[game.aiLevel].label}`;
  } else {
    $('#top-name').textContent = `对手（${myRed ? '黑方' : '红方'}）`;
  }
  $('#top-conn').hidden = true;
  const mins = game.tc / 60000;
  $('#game-meta').textContent =
    `${game.kind === 'ai' ? '人机对战' : '在线对战'} · ${mins} 分钟 + 3 秒/步`;
  void oppSide;
}

function showResult(winner, reason) {
  const title = $('#result-title');
  const sub = $('#result-sub');
  if (winner === null) {
    title.textContent = '和棋';
    title.style.color = 'var(--wood)';
  } else if (winner === game.mySide) {
    title.textContent = '你赢了！';
    title.style.color = '#6fcf7c';
  } else {
    title.textContent = '你输了';
    title.style.color = '#ff8a7a';
  }
  sub.textContent = REASON_TEXT[reason] || reason || '';
  $('#rematch-hint').hidden = true;
  $('#btn-rematch').disabled = false;
  $('#result-overlay').hidden = false;
}

function hideOverlays() {
  $('#result-overlay').hidden = true;
  $('#draw-overlay').hidden = true;
}

// ---------- Common game setup ----------

function baseGame(kind, mySide, tc) {
  return {
    kind,
    mySide,
    tc,
    board: initialBoard(),
    turn: RED,
    started: true,
    over: false,
    selected: -1,
    lastMove: null,
    moves: [],
    clocks: { [RED]: tc, [BLACK]: tc },
    turnStart: Date.now(),
    clockInterval: null,
    repetition: new Map(),
    undoStack: [],
  };
}

function enterGameScreen() {
  hideOverlays();
  $('#move-list').innerHTML = '';
  $('#room-banner').hidden = true;
  showScreen('#screen-game');
  // The canvas just became visible: measure it synchronously so the first
  // paint and input mapping use the real size.
  boardView.resize();
  setPlayerBars();
  refreshBoard();
  renderClocks();
  startClockLoop();
}

// ---------- AI game ----------

function startAiGame() {
  const mySide = settings.aiSide === 'random'
    ? (Math.random() < 0.5 ? RED : BLACK)
    : settings.aiSide;
  game = baseGame('ai', mySide, settings.tc);
  game.aiLevel = settings.aiLevel;
  game.repetition.set(positionKey(game.board, RED), 1);

  if (!aiWorker) {
    aiWorker = new Worker('/js/ai-worker.js', { type: 'module' });
    aiWorker.onmessage = (e) => onAiMessage(e.data);
  }

  $('#btn-undo').hidden = false;
  $('#btn-draw').hidden = true;
  enterGameScreen();
  setStatus(game.turn === game.mySide ? '轮到你走棋' : '电脑思考中…');
  if (game.turn !== game.mySide) requestAiMove();
}

function requestAiMove() {
  if (!game || game.over || game.kind !== 'ai') return;
  const cfg = AI_LEVELS[game.aiLevel];
  const remaining = displayedClocks()[game.turn];
  // Don't let the AI think itself out of time.
  const budget = Math.max(80, Math.min(cfg.timeMs, remaining / 8));
  game.aiThinking = true;
  setStatus('电脑思考中…');
  aiWorker.postMessage({
    type: 'think',
    board: game.board,
    side: game.turn,
    timeMs: budget,
    maxDepth: cfg.maxDepth,
    randomness: cfg.randomness,
    historyKeys: [...game.repetition.keys()],
  });
}

function onAiMessage(msg) {
  if (!game || game.kind !== 'ai' || game.over) return;
  game.aiThinking = false;
  if (msg.type === 'nomove') {
    // Engine found no legal move — should already be caught as mate/stalemate.
    const st = gameStatus(game.board, game.turn);
    finishAiGame(st === 'ongoing' ? null : opposite(game.turn), st === 'ongoing' ? 'agreement' : st);
    return;
  }
  if (msg.type === 'move') {
    performLocalMove(msg.from, msg.to);
  }
}

/** Apply a move in the local (AI-mode) game, handling clocks and endings. */
function performLocalMove(from, to) {
  const side = game.turn;
  const now = Date.now();
  const elapsed = now - game.turnStart;
  const left = game.clocks[side] - elapsed;
  if (left <= 0) {
    game.clocks[side] = 0;
    finishAiGame(opposite(side), 'timeout');
    return;
  }
  game.clocks[side] = left + 3000; // +3s increment

  const desc = describeMove(game.board, from, to);
  const captured = applyMove(game.board, from, to);
  game.undoStack.push({ from, to, captured });
  game.moves.push({ from, to, desc });
  game.lastMove = { from, to };
  game.turn = opposite(side);
  game.turnStart = now;
  game.selected = -1;

  const key = positionKey(game.board, game.turn);
  game.repetition.set(key, (game.repetition.get(key) || 0) + 1);

  appendMoveToList(desc, side, Math.ceil(game.moves.length / 2));
  refreshBoard();
  renderClocks();

  const st = gameStatus(game.board, game.turn);
  if (st !== 'ongoing') {
    finishAiGame(opposite(game.turn), st);
    return;
  }
  if (game.repetition.get(key) >= 3) {
    finishAiGame(null, 'repetition');
    return;
  }
  if (inCheck(game.board, game.turn)) toast('将军！');

  if (game.turn === game.mySide) {
    setStatus('轮到你走棋');
  } else {
    requestAiMove();
  }
}

function finishAiGame(winner, reason) {
  if (game.over) return;
  game.over = true;
  stopClockLoop();
  renderClocks();
  refreshBoard();
  setStatus(winner === null ? '和棋' : winner === game.mySide ? '你获胜' : '你落败');
  showResult(winner, reason);
}

function undoAiMove() {
  if (!game || game.kind !== 'ai' || game.over || game.aiThinking) return;
  if (game.turn !== game.mySide) return;
  // Undo AI's reply and the player's own move.
  let undone = 0;
  while (undone < 2 && game.undoStack.length > 0) {
    const m = game.undoStack.pop();
    // Remove the repetition count added by this move.
    const key = positionKey(game.board, game.turn);
    const cnt = game.repetition.get(key);
    if (cnt > 1) game.repetition.set(key, cnt - 1);
    else game.repetition.delete(key);
    undoMove(game.board, m.from, m.to, m.captured);
    game.moves.pop();
    game.turn = opposite(game.turn);
    undone++;
  }
  if (undone === 0) return;
  game.turnStart = Date.now();
  game.selected = -1;
  game.lastMove = game.moves.length
    ? { from: game.moves[game.moves.length - 1].from, to: game.moves[game.moves.length - 1].to }
    : null;
  rebuildMoveList(game.moves);
  refreshBoard();
  renderClocks();
  setStatus('轮到你走棋');
}

// ---------- PvP game ----------

function pvpStatus(text) {
  $('#pvp-status').textContent = text;
}

function setMatching(active) {
  $('#btn-cancel-match').hidden = !active;
  $('#btn-quick-match').disabled = active;
}

function startPvpGame(mySide, tc, fromState) {
  game = baseGame('pvp', mySide, tc);
  if (fromState) {
    game.board = fromState.board;
    game.turn = fromState.turn;
    game.moves = fromState.moves || [];
    game.clocks = fromState.clocks;
    game.turnStart = Date.now();
    game.started = fromState.started;
    game.over = fromState.over;
    if (game.moves.length) {
      const last = game.moves[game.moves.length - 1];
      game.lastMove = { from: last.from, to: last.to };
    }
  }
  $('#btn-undo').hidden = true;
  $('#btn-draw').hidden = false;
  enterGameScreen();
  rebuildMoveList(game.moves);
  const session = net.getSession();
  if (session && session.code) {
    $('#room-banner').hidden = false;
    $('#room-code-label').textContent = session.code;
  }
  setStatus(game.over
    ? '对局已结束'
    : game.turn === game.mySide ? '轮到你走棋' : '等待对方走棋…');
  if (fromState && fromState.over && fromState.result) {
    stopClockLoop();
    showResult(fromState.result.winner, fromState.result.reason);
  }
}

function bindNetHandlers() {
  net.on('created', (msg) => {
    pvpStatus(`房间已创建，房号：${msg.code} —— 把房号发给好友，等待加入…`);
  });

  net.on('waiting', () => {
    pvpStatus('正在匹配对手…');
  });

  net.on('joined', () => {
    pvpStatus('已加入房间，开始对局！');
  });

  net.on('start', (msg) => {
    pvpIntent = null;
    pvpStatus('');
    setMatching(false);
    startPvpGame(msg.side, msg.tc);
  });

  net.on('state', (msg) => {
    if (!msg.board) return; // game not started yet, nothing to restore
    // Rejoined an existing game (reconnect / page refresh).
    startPvpGame(msg.side, msg.tc, msg);
    // Server clocks are authoritative; active side's clock resumes from now.
    $('#top-conn').hidden = msg.opponentConnected;
  });

  net.on('moved', (msg) => {
    if (!game || game.kind !== 'pvp') return;
    const desc = describeMove(game.board, msg.from, msg.to);
    applyMove(game.board, msg.from, msg.to);
    game.moves.push({ from: msg.from, to: msg.to, desc });
    game.lastMove = { from: msg.from, to: msg.to };
    game.turn = msg.turn;
    game.clocks = msg.clocks;
    game.turnStart = Date.now();
    game.selected = -1;
    appendMoveToList(desc, msg.by, Math.ceil(game.moves.length / 2));
    refreshBoard();
    renderClocks();
    if (msg.check) toast('将军！');
    setStatus(game.turn === game.mySide ? '轮到你走棋' : '等待对方走棋…');
  });

  net.on('gameOver', (msg) => {
    if (!game || game.kind !== 'pvp') return;
    game.over = true;
    game.clocks = msg.clocks || game.clocks;
    stopClockLoop();
    renderClocks();
    refreshBoard();
    showResult(msg.winner, msg.reason);
  });

  net.on('drawOffered', () => {
    if (game && !game.over) $('#draw-overlay').hidden = false;
  });

  net.on('drawDeclined', () => {
    toast('对方拒绝和棋', 1400);
  });

  net.on('rematchOffered', () => {
    if (game && game.over) {
      $('#rematch-hint').hidden = false;
      $('#rematch-hint').textContent = '对方想再来一局，点击“再来一局”开始';
    }
  });

  net.on('opponentDisconnected', () => {
    $('#top-conn').hidden = false;
    toast('对方已断线，等待重连…', 1600);
  });

  net.on('opponentReconnected', () => {
    $('#top-conn').hidden = true;
    toast('对方已重连', 1200);
  });

  net.on('opponentLeft', () => {
    $('#top-conn').hidden = false;
  });

  net.on('error', (msg) => {
    if (msg.code === 'ROOM_GONE') {
      // Our old room vanished (e.g. we were dropped from the quick-match
      // queue while disconnected, or the server restarted). If we were
      // queueing, just queue again.
      if (pvpIntent && pvpIntent.type === 'quick' && (!game || game.over)) {
        net.send({ type: 'quick', tc: pvpIntent.tc });
        pvpStatus('正在匹配对手…');
      }
      return;
    }
    if ($('#screen-home').classList.contains('active')) {
      pvpStatus(msg.message || '出错了');
    } else {
      toast(msg.message || '出错了', 1400);
    }
  });

  net.on('_close', () => {
    if (game && game.kind === 'pvp' && !game.over) {
      setStatus('连接已断开，正在重连…');
    } else if (pvpIntent) {
      pvpStatus('连接中断，正在重连…');
    }
  });

  net.on('_open', () => {
    if (game && game.kind === 'pvp' && !game.over) {
      setStatus('已重新连接');
    } else if (pvpIntent && pvpIntent.type === 'quick' && !net.getSession()) {
      // Reconnected with no room to rejoin: re-enter the queue.
      net.send({ type: 'quick', tc: pvpIntent.tc });
      pvpStatus('正在匹配对手…');
    }
  });
}

// ---------- Board interaction ----------

function onSquareClick(sq) {
  if (!game || game.over || !game.started) return;
  if (game.turn !== game.mySide) return;
  if (game.kind === 'ai' && game.aiThinking) return;

  const piece = game.board[sq];
  if (game.selected >= 0 && legalDests(game.board, game.selected).includes(sq)) {
    const from = game.selected;
    game.selected = -1;
    if (game.kind === 'ai') {
      performLocalMove(from, sq);
    } else {
      net.send({ type: 'move', from, to: sq });
      refreshBoard();
    }
    return;
  }
  if (piece && sideOf(piece) === game.mySide) {
    game.selected = game.selected === sq ? -1 : sq;
  } else {
    game.selected = -1;
  }
  refreshBoard();
}

// ---------- Buttons ----------

$('#btn-start-ai').addEventListener('click', () => {
  pvpIntent = null;
  net.disconnect();
  setMatching(false);
  startAiGame();
});

$('#btn-quick-match').addEventListener('click', () => {
  net.clearSession();
  net.connect();
  pvpIntent = { type: 'quick', tc: settings.tc };
  pvpStatus('正在匹配对手…');
  setMatching(true);
  net.sendWhenReady({ type: 'quick', tc: settings.tc });
});

$('#btn-cancel-match').addEventListener('click', () => {
  pvpIntent = null;
  net.send({ type: 'leave' });
  net.disconnect();
  pvpStatus('已取消匹配');
  setMatching(false);
});

$('#btn-create-room').addEventListener('click', () => {
  net.clearSession();
  net.connect();
  pvpStatus('正在创建房间…');
  net.sendWhenReady({ type: 'create', tc: settings.tc });
});

$('#btn-join-room').addEventListener('click', () => {
  const code = $('#input-room-code').value.trim().toUpperCase();
  if (code.length < 4) {
    pvpStatus('请输入正确的房号');
    return;
  }
  net.clearSession();
  net.connect();
  pvpStatus('正在加入房间…');
  net.sendWhenReady({ type: 'join', code });
});

$('#btn-resign').addEventListener('click', () => {
  if (!game || game.over) return;
  if (!confirm('确定认输吗？')) return;
  if (game.kind === 'ai') {
    finishAiGame(opposite(game.mySide), 'resign');
  } else {
    net.send({ type: 'resign' });
  }
});

$('#btn-draw').addEventListener('click', () => {
  if (!game || game.over || game.kind !== 'pvp') return;
  net.send({ type: 'drawOffer' });
  toast('已发出求和请求', 1200);
});

$('#btn-draw-accept').addEventListener('click', () => {
  $('#draw-overlay').hidden = true;
  net.send({ type: 'drawResponse', accept: true });
});

$('#btn-draw-decline').addEventListener('click', () => {
  $('#draw-overlay').hidden = true;
  net.send({ type: 'drawResponse', accept: false });
});

$('#btn-undo').addEventListener('click', undoAiMove);

$('#btn-rematch').addEventListener('click', () => {
  if (!game) return;
  if (game.kind === 'ai') {
    hideOverlays();
    startAiGame();
  } else {
    net.send({ type: 'rematch' });
    $('#btn-rematch').disabled = true;
    $('#rematch-hint').hidden = false;
    $('#rematch-hint').textContent = '等待对方同意…';
  }
});

function goHome() {
  if (game) {
    if (game.kind === 'pvp') net.send({ type: 'leave' });
    stopClockLoop();
  }
  net.disconnect();
  game = null;
  pvpIntent = null;
  hideOverlays();
  pvpStatus('');
  setMatching(false);
  showScreen('#screen-home');
}

$('#btn-back-home').addEventListener('click', goHome);

$('#btn-home').addEventListener('click', () => {
  if (game && !game.over) {
    if (!confirm('对局尚未结束，退出将视为认输，确定退出吗？')) return;
  }
  goHome();
});

$('#btn-copy-code').addEventListener('click', async () => {
  const code = $('#room-code-label').textContent;
  try {
    await navigator.clipboard.writeText(code);
    toast('房号已复制', 900);
  } catch {
    toast(code, 1500);
  }
});

$('#input-room-code').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') $('#btn-join-room').click();
});

// ---------- Init ----------

boardView = new BoardView($('#board'), onSquareClick);
bindNetHandlers();

// Debug/testing hook (harmless in production).
window.__xq = {
  get game() { return game; },
  get boardView() { return boardView; },
  net,
  click: (sq) => onSquareClick(sq),
};

// Resume a PvP session after page refresh.
if (net.getSession()) {
  net.connect();
}
