/**
 * Xiangqi (Chinese Chess) rules engine.
 * Shared between browser (UI + AI worker) and Node server (move validation).
 *
 * Board: array of 90 strings, index = row * 9 + col.
 * Row 0 is the top (Black side), row 9 the bottom (Red side).
 * Red pieces are uppercase: K A B N R C P
 * Black pieces are lowercase: k a b n r c p
 * Empty square: '' (empty string).
 * Sides: 'r' (red, moves first) and 'b' (black).
 */

export const ROWS = 10;
export const COLS = 9;
export const SIZE = 90;

export const RED = 'r';
export const BLACK = 'b';

const START = [
  'r', 'n', 'b', 'a', 'k', 'a', 'b', 'n', 'r',
  '', '', '', '', '', '', '', '', '',
  '', 'c', '', '', '', '', '', 'c', '',
  'p', '', 'p', '', 'p', '', 'p', '', 'p',
  '', '', '', '', '', '', '', '', '',
  '', '', '', '', '', '', '', '', '',
  'P', '', 'P', '', 'P', '', 'P', '', 'P',
  '', 'C', '', '', '', '', '', 'C', '',
  '', '', '', '', '', '', '', '', '',
  'R', 'N', 'B', 'A', 'K', 'A', 'B', 'N', 'R',
];

export function initialBoard() {
  return START.slice();
}

export function rc(idx) {
  return [Math.floor(idx / 9), idx % 9];
}

export function idx(row, col) {
  return row * 9 + col;
}

export function sideOf(piece) {
  if (!piece) return null;
  return piece === piece.toUpperCase() ? RED : BLACK;
}

export function opposite(side) {
  return side === RED ? BLACK : RED;
}

function inBoard(r, c) {
  return r >= 0 && r < 10 && c >= 0 && c < 9;
}

function inPalace(r, c, side) {
  if (c < 3 || c > 5) return false;
  return side === RED ? r >= 7 : r <= 2;
}

/** Has this pawn crossed the river? */
function pawnCrossed(r, side) {
  return side === RED ? r <= 4 : r >= 5;
}

/** Own half of the board (for elephants). */
function ownHalf(r, side) {
  return side === RED ? r >= 5 : r <= 4;
}

export function findKing(board, side) {
  const k = side === RED ? 'K' : 'k';
  // Kings live in the palace; scan those 18 squares only.
  const rows = side === RED ? [7, 8, 9] : [0, 1, 2];
  for (const r of rows) {
    for (let c = 3; c <= 5; c++) {
      if (board[r * 9 + c] === k) return r * 9 + c;
    }
  }
  return -1;
}

const ORTHO = [[-1, 0], [1, 0], [0, -1], [0, 1]];
const DIAG = [[-1, -1], [-1, 1], [1, -1], [1, 1]];
const HORSE = [
  // [dr, dc, legDr, legDc]
  [-2, -1, -1, 0], [-2, 1, -1, 0],
  [2, -1, 1, 0], [2, 1, 1, 0],
  [-1, -2, 0, -1], [1, -2, 0, -1],
  [-1, 2, 0, 1], [1, 2, 0, 1],
];

/**
 * Is `side`'s king attacked (including the flying-general rule)?
 */
export function inCheck(board, side) {
  const kIdx = findKing(board, side);
  if (kIdx < 0) return true; // no king: treat as lost
  return isAttacked(board, kIdx, opposite(side));
}

/**
 * Is square `target` attacked by any piece of `by`?
 * Also treats the enemy king "seeing" the square along a file/rank line
 * as an attack (covers the flying-general rule when target is a king square).
 */
export function isAttacked(board, target, by) {
  const [tr, tc] = rc(target);
  const enemyRook = by === RED ? 'R' : 'r';
  const enemyCannon = by === RED ? 'C' : 'c';
  const enemyHorse = by === RED ? 'N' : 'n';
  const enemyPawn = by === RED ? 'P' : 'p';
  const enemyKing = by === RED ? 'K' : 'k';

  // Rook / king along orthogonal rays; cannon with exactly one screen.
  for (const [dr, dc] of ORTHO) {
    let r = tr + dr, c = tc + dc;
    let screen = false;
    while (inBoard(r, c)) {
      const p = board[r * 9 + c];
      if (p) {
        if (!screen) {
          if (p === enemyRook || p === enemyKing) return true;
          screen = true;
        } else {
          if (p === enemyCannon) return true;
          break;
        }
      }
      r += dr;
      c += dc;
    }
  }

  // Horse: from the target's perspective the blocking leg sits next to the
  // horse, one orthogonal step toward the target.
  for (const [dr, dc, , ] of HORSE) {
    const hr = tr + dr, hc = tc + dc;
    if (!inBoard(hr, hc)) continue;
    if (board[hr * 9 + hc] !== enemyHorse) continue;
    // Leg square: one step from the horse toward the target along the
    // 2-length axis of the move.
    const legR = hr + (Math.abs(dr) === 2 ? (dr > 0 ? -1 : 1) : 0);
    const legC = hc + (Math.abs(dc) === 2 ? (dc > 0 ? -1 : 1) : 0);
    if (!board[legR * 9 + legC]) return true;
  }

  // Pawn: red pawns attack upward (decreasing row), black downward.
  const fwd = by === RED ? 1 : -1; // pawn sits "behind" the target
  const pr = tr + fwd;
  if (inBoard(pr, tc) && board[pr * 9 + tc] === enemyPawn) return true;
  for (const dc of [-1, 1]) {
    const c = tc + dc;
    if (!inBoard(tr, c)) continue;
    if (board[tr * 9 + c] === enemyPawn && pawnCrossed(tr, by)) return true;
  }

  return false;
}

/**
 * Pseudo-legal moves for the piece at `from` (does not test own-king safety).
 * Returns array of destination indices.
 */
export function pseudoDests(board, from) {
  const piece = board[from];
  if (!piece) return [];
  const side = sideOf(piece);
  const [r, c] = rc(from);
  const dests = [];
  const push = (rr, cc) => {
    if (!inBoard(rr, cc)) return false;
    const t = board[rr * 9 + cc];
    if (!t) {
      dests.push(rr * 9 + cc);
      return true; // empty, ray may continue
    }
    if (sideOf(t) !== side) dests.push(rr * 9 + cc);
    return false; // blocked
  };

  switch (piece.toUpperCase()) {
    case 'R': {
      for (const [dr, dc] of ORTHO) {
        let rr = r + dr, cc = c + dc;
        while (inBoard(rr, cc) && push(rr, cc)) {
          rr += dr;
          cc += dc;
        }
      }
      break;
    }
    case 'C': {
      for (const [dr, dc] of ORTHO) {
        let rr = r + dr, cc = c + dc;
        // Sliding (non-capture) part.
        while (inBoard(rr, cc) && !board[rr * 9 + cc]) {
          dests.push(rr * 9 + cc);
          rr += dr;
          cc += dc;
        }
        // Jump over the screen, then capture the first piece beyond it.
        rr += dr;
        cc += dc;
        while (inBoard(rr, cc)) {
          const t = board[rr * 9 + cc];
          if (t) {
            if (sideOf(t) !== side) dests.push(rr * 9 + cc);
            break;
          }
          rr += dr;
          cc += dc;
        }
      }
      break;
    }
    case 'N': {
      for (const [dr, dc, legDr, legDc] of HORSE) {
        const lr = r + legDr, lc = c + legDc;
        if (!inBoard(lr, lc) || board[lr * 9 + lc]) continue; // leg blocked
        push(r + dr, c + dc);
      }
      break;
    }
    case 'B': {
      for (const [dr, dc] of DIAG) {
        const rr = r + 2 * dr, cc = c + 2 * dc;
        if (!inBoard(rr, cc) || !ownHalf(rr, side)) continue;
        if (board[(r + dr) * 9 + (c + dc)]) continue; // eye blocked
        push(rr, cc);
      }
      break;
    }
    case 'A': {
      for (const [dr, dc] of DIAG) {
        const rr = r + dr, cc = c + dc;
        if (!inPalace(rr, cc, side)) continue;
        push(rr, cc);
      }
      break;
    }
    case 'K': {
      for (const [dr, dc] of ORTHO) {
        const rr = r + dr, cc = c + dc;
        if (!inPalace(rr, cc, side)) continue;
        push(rr, cc);
      }
      break;
    }
    case 'P': {
      const fwd = side === RED ? -1 : 1;
      push(r + fwd, c);
      if (pawnCrossed(r, side)) {
        push(r, c - 1);
        push(r, c + 1);
      }
      break;
    }
  }
  return dests;
}

/** Apply a move, returning the captured piece ('' if none). */
export function applyMove(board, from, to) {
  const captured = board[to];
  board[to] = board[from];
  board[from] = '';
  return captured;
}

/** Undo a move previously applied with applyMove. */
export function undoMove(board, from, to, captured) {
  board[from] = board[to];
  board[to] = captured;
}

/** Legal destinations for the piece at `from`. */
export function legalDests(board, from) {
  const piece = board[from];
  if (!piece) return [];
  const side = sideOf(piece);
  const out = [];
  for (const to of pseudoDests(board, from)) {
    const captured = applyMove(board, from, to);
    if (!inCheck(board, side)) out.push(to);
    undoMove(board, from, to, captured);
  }
  return out;
}

/** All legal moves for `side`: array of {from, to}. */
export function legalMoves(board, side) {
  const moves = [];
  for (let from = 0; from < SIZE; from++) {
    const piece = board[from];
    if (!piece || sideOf(piece) !== side) continue;
    for (const to of legalDests(board, from)) moves.push({ from, to });
  }
  return moves;
}

export function isLegalMove(board, side, from, to) {
  if (from < 0 || from >= SIZE || to < 0 || to >= SIZE) return false;
  const piece = board[from];
  if (!piece || sideOf(piece) !== side) return false;
  return legalDests(board, from).includes(to);
}

/**
 * Game status for the side to move.
 * 'ongoing' | 'checkmate' | 'stalemate'
 * (In xiangqi both checkmate and stalemate lose for the side to move.)
 */
export function status(board, sideToMove) {
  if (legalMoves(board, sideToMove).length > 0) return 'ongoing';
  return inCheck(board, sideToMove) ? 'checkmate' : 'stalemate';
}

/** Compact position key (board + side to move) for repetition detection. */
export function positionKey(board, sideToMove) {
  let s = sideToMove;
  for (let i = 0; i < SIZE; i++) s += board[i] || '.';
  return s;
}

/** Chinese notation-ish description of a move, for the move list UI. */
const PIECE_NAMES = {
  K: '帅', A: '仕', B: '相', N: '马', R: '车', C: '炮', P: '兵',
  k: '将', a: '士', b: '象', n: '马', r: '车', c: '炮', p: '卒',
};
const CN_DIGITS = ['一', '二', '三', '四', '五', '六', '七', '八', '九'];

export function describeMove(board, from, to) {
  const piece = board[from];
  if (!piece) return '';
  const side = sideOf(piece);
  const [fr, fc] = rc(from);
  const [tr, tc] = rc(to);
  const name = PIECE_NAMES[piece] || piece;
  // File numbers: red counts 1..9 right-to-left, black 1..9 left-to-right.
  const fileFrom = side === RED ? CN_DIGITS[8 - fc] : String(fc + 1);
  const fileTo = side === RED ? CN_DIGITS[8 - tc] : String(tc + 1);
  const fwd = side === RED ? fr - tr : tr - fr; // >0 means forward
  let action, arg;
  if (tr === fr) {
    action = '平';
    arg = fileTo;
  } else {
    action = fwd > 0 ? '进' : '退';
    if (tc === fc) {
      const steps = Math.abs(tr - fr);
      arg = side === RED ? CN_DIGITS[steps - 1] : String(steps);
    } else {
      arg = fileTo; // diagonal movers name the destination file
    }
  }
  return `${name}${fileFrom}${action}${arg}`;
}
