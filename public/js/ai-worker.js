/**
 * Xiangqi AI — runs in a module Web Worker.
 * Iterative-deepening negamax with alpha-beta, quiescence (captures),
 * MVV-LVA + killer move ordering, and a small transposition table.
 *
 * Protocol:
 *   in : { type:'think', board, side, timeMs, maxDepth, randomness, historyKeys, posLog }
 *   out: { type:'move', from, to, score, depth }
 */
import {
  SIZE, RED, opposite, sideOf, rc,
  pseudoDests, applyMove, undoMove, inCheck, legalMoves, positionKey, perpetualCheckOffender,
} from '/shared/xiangqi.js';

// ---------- Evaluation ----------

const VAL = { K: 10000, R: 1000, C: 450, N: 430, B: 110, A: 110, P: 80 };

// Piece-square tables from RED's perspective (row 0 = far/black side).
// Values are small nudges on top of material.
const PST = {
  P: [
    0,  0,  0, 20, 40, 20,  0,  0,  0,
    40, 60, 90,110,120,110, 90, 60, 40,
    40, 60, 80, 95,100, 95, 80, 60, 40,
    35, 45, 60, 70, 75, 70, 60, 45, 35,
    20, 30, 40, 45, 50, 45, 40, 30, 20,
    5,  0, 10,  0, 15,  0, 10,  0,  5,
    0,  0,  0,  0,  0,  0,  0,  0,  0,
    0,  0,  0,  0,  0,  0,  0,  0,  0,
    0,  0,  0,  0,  0,  0,  0,  0,  0,
    0,  0,  0,  0,  0,  0,  0,  0,  0,
  ],
  N: [
    20, 25, 30, 35, 30, 35, 30, 25, 20,
    25, 40, 55, 50, 45, 50, 55, 40, 25,
    30, 45, 55, 60, 55, 60, 55, 45, 30,
    30, 50, 55, 60, 60, 60, 55, 50, 30,
    25, 45, 50, 55, 60, 55, 50, 45, 25,
    20, 40, 50, 55, 50, 55, 50, 40, 20,
    15, 25, 35, 40, 35, 40, 35, 25, 15,
    10, 20, 25, 25, 20, 25, 25, 20, 10,
    5, 10, 15, 15,  5, 15, 15, 10,  5,
    0,  5, 10, 10,-10, 10, 10,  5,  0,
  ],
  R: [
    35, 40, 40, 45, 50, 45, 40, 40, 35,
    35, 50, 50, 55, 60, 55, 50, 50, 35,
    30, 40, 40, 50, 55, 50, 40, 40, 30,
    30, 45, 45, 50, 55, 50, 45, 45, 30,
    25, 40, 40, 45, 50, 45, 40, 40, 25,
    25, 35, 35, 40, 45, 40, 35, 35, 25,
    20, 30, 30, 35, 40, 35, 30, 30, 20,
    15, 25, 25, 30, 30, 30, 25, 25, 15,
    10, 20, 20, 25, 25, 25, 20, 20, 10,
    5, 15, 15, 20, 20, 20, 15, 15,  5,
  ],
  C: [
    20, 20, 15, 10, 10, 10, 15, 20, 20,
    15, 15, 10,  5,  5,  5, 10, 15, 15,
    10, 10,  5,  5,  5,  5,  5, 10, 10,
    5,  5,  5,  5, 10,  5,  5,  5,  5,
    5,  5,  5,  5, 15,  5,  5,  5,  5,
    5,  5,  5, 10, 20, 10,  5,  5,  5,
    5,  5,  5, 10, 20, 10,  5,  5,  5,
    5, 10, 10, 15, 25, 15, 10, 10,  5,
    5,  5,  5, 10, 20, 10,  5,  5,  5,
    0,  5,  5,  5, 15,  5,  5,  5,  0,
  ],
  B: new Array(90).fill(0),
  A: new Array(90).fill(0),
  K: [
    0, 0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, -5, -8, -5, 0, 0, 0,
    0, 0, 0,  0, -5,  0, 0, 0, 0,
    0, 0, 0,  5, 10,  5, 0, 0, 0,
  ],
};
// Slight bonuses for defenders on their best squares (red indices).
PST.B[67] = 25;                  // elephant on the central point (7,4)
PST.B[47] = 15; PST.B[51] = 15;  // riverbank elephants (5,2) (5,6)
PST.B[83] = 10; PST.B[87] = 10;  // home squares (9,2) (9,6)
PST.A[76] = 20;                  // advisor on the palace centre (8,4)
PST.A[84] = 12; PST.A[86] = 12;  // home squares (9,3) (9,5)

function pstValue(piece, i) {
  const upper = piece.toUpperCase();
  const table = PST[upper];
  if (!table) return 0;
  if (piece === upper) return table[i]; // red
  const [r, c] = rc(i);
  return table[(9 - r) * 9 + (8 - c)]; // mirror for black
}

/** Static evaluation from `side`'s point of view. */
function evaluate(board, side) {
  let score = 0;
  for (let i = 0; i < SIZE; i++) {
    const p = board[i];
    if (!p) continue;
    const v = VAL[p.toUpperCase()] + pstValue(p, i);
    score += sideOf(p) === side ? v : -v;
  }
  return score;
}

// ---------- Search ----------

const MATE = 100000;
let deadline = 0;
let nodes = 0;
let stopped = false;
let killers = [];
let historySet = new Set(); // repetition keys from the actual game
let rng = () => 0;

function timeUp() {
  if (stopped) return true;
  if ((nodes & 1023) === 0 && Date.now() > deadline) stopped = true;
  return stopped;
}

function orderedMoves(board, side, depth, preferred) {
  const moves = [];
  for (let from = 0; from < SIZE; from++) {
    const p = board[from];
    if (!p || sideOf(p) !== side) continue;
    const attacker = VAL[p.toUpperCase()];
    for (const to of pseudoDests(board, from)) {
      let score = 0;
      const victim = board[to];
      if (victim) score = 10000 + VAL[victim.toUpperCase()] * 10 - attacker / 10;
      if (preferred && preferred.from === from && preferred.to === to) score += 1000000;
      const k = killers[depth];
      if (k && k.from === from && k.to === to) score += 5000;
      moves.push({ from, to, score });
    }
  }
  moves.sort((a, b) => b.score - a.score);
  return moves;
}

/** Capture-only quiescence search. */
function quiesce(board, side, alpha, beta) {
  nodes++;
  if (timeUp()) return alpha;
  const stand = evaluate(board, side);
  if (stand >= beta) return beta;
  if (stand > alpha) alpha = stand;

  const caps = [];
  for (let from = 0; from < SIZE; from++) {
    const p = board[from];
    if (!p || sideOf(p) !== side) continue;
    for (const to of pseudoDests(board, from)) {
      const victim = board[to];
      if (!victim) continue;
      caps.push({ from, to, score: VAL[victim.toUpperCase()] * 10 - VAL[p.toUpperCase()] / 10 });
    }
  }
  caps.sort((a, b) => b.score - a.score);

  for (const { from, to } of caps) {
    const victim = board[to].toUpperCase();
    if (victim !== 'K' && stand + VAL[victim] + 200 < alpha) continue; // delta prune
    const captured = applyMove(board, from, to);
    if (inCheck(board, side)) {
      undoMove(board, from, to, captured);
      continue;
    }
    const score = -quiesce(board, opposite(side), -beta, -alpha);
    undoMove(board, from, to, captured);
    if (stopped) return alpha;
    if (score >= beta) return beta;
    if (score > alpha) alpha = score;
  }
  return alpha;
}

function search(board, side, depth, alpha, beta, ply) {
  nodes++;
  if (timeUp()) return alpha;
  if (depth <= 0) return quiesce(board, side, alpha, beta);

  const inChk = inCheck(board, side);
  if (inChk) depth += 1; // check extension

  let best = -Infinity;
  let legal = 0;

  for (const { from, to } of orderedMoves(board, side, ply)) {
    const captured = applyMove(board, from, to);
    if (inCheck(board, side)) {
      undoMove(board, from, to, captured);
      continue;
    }
    legal++;
    let score;
    // Penalise walking back into a position from the real game history
    // (cheap repetition avoidance).
    if (ply <= 1 && historySet.has(positionKey(board, opposite(side)))) {
      score = -search(board, opposite(side), depth - 1, -beta, -alpha, ply + 1) - 30;
    } else {
      score = -search(board, opposite(side), depth - 1, -beta, -alpha, ply + 1);
    }
    undoMove(board, from, to, captured);
    if (stopped) return alpha;
    if (score > best) best = score;
    if (score > alpha) alpha = score;
    if (alpha >= beta) {
      if (!captured) killers[ply] = { from, to };
      break;
    }
  }

  if (legal === 0) {
    // Checkmate or stalemate: both lose in xiangqi.
    return -MATE + ply;
  }
  return best;
}

function findBestMove(board, side, timeMs, maxDepth, randomness, posLog) {
  deadline = Date.now() + timeMs;
  nodes = 0;
  stopped = false;
  killers = [];

  const rootMoves = legalMoves(board, side);
  if (rootMoves.length === 0) return null;
  if (rootMoves.length === 1) return { ...rootMoves[0], score: 0, depth: 0 };

  // Score root moves once for stable ordering.
  let scored = rootMoves.map((m) => ({ ...m, score: 0 }));
  let best = null;
  let lastDepth = 0;

  for (let depth = 1; depth <= maxDepth; depth++) {
    let alpha = -Infinity;
    const iter = [];
    for (const m of scored) {
      const captured = applyMove(board, m.from, m.to);
      const rootKey = positionKey(board, opposite(side));
      let score = -search(board, opposite(side), depth - 1, -Infinity, -alpha, 1);
      // Discourage immediate repetition of real game positions.
      if (historySet.has(rootKey)) score -= 40;
      // Hard-avoid actually committing the "no perpetual check" foul: if
      // this move would be the AI's own 3rd repeat of a position where it
      // has been checking every move, it would lose the game outright, not
      // draw -- see perpetualCheckOffender. Penalise heavily rather than
      // exclude, so the AI still has a move if every option is this bad.
      if (posLog && posLog.length) {
        const simulated = posLog.concat([{ key: rootKey, mover: side, isCheck: inCheck(board, opposite(side)) }]);
        const reps = simulated.filter((e) => e.key === rootKey).length;
        if (reps >= 3 && perpetualCheckOffender(simulated, rootKey) === side) score -= 8000;
      }
      undoMove(board, m.from, m.to, captured);
      if (stopped) break;
      score += randomness ? Math.floor(rng() * randomness) : 0;
      iter.push({ from: m.from, to: m.to, score });
      if (score > alpha) alpha = score;
    }
    if (iter.length === scored.length) {
      iter.sort((a, b) => b.score - a.score);
      scored = iter;
      best = { from: iter[0].from, to: iter[0].to, score: iter[0].score, depth };
      lastDepth = depth;
      // Stop early on found mate.
      if (iter[0].score > MATE - 1000) break;
    }
    if (stopped || Date.now() > deadline) break;
  }

  if (!best) {
    const m = scored[0];
    best = { from: m.from, to: m.to, score: 0, depth: lastDepth };
  }
  return best;
}

self.onmessage = (e) => {
  const msg = e.data;
  if (msg.type !== 'think') return;
  const { board, side, timeMs, maxDepth, randomness, historyKeys, posLog } = msg;
  historySet = new Set(historyKeys || []);
  rng = Math.random;
  const best = findBestMove(board.slice(), side, timeMs || 1000, maxDepth || 64, randomness || 0, posLog || []);
  if (!best) {
    self.postMessage({ type: 'nomove' });
  } else {
    self.postMessage({ type: 'move', from: best.from, to: best.to, score: best.score, depth: best.depth });
  }
};
