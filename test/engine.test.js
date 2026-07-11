/**
 * Engine correctness tests.
 * Perft node counts from the standard xiangqi starting position are
 * well-known reference values (44 / 1920 / 79666 / 3290240).
 */
import {
  initialBoard, legalMoves, applyMove, undoMove, sideOf, opposite,
  inCheck, status, RED, BLACK, idx, describeMove,
} from '../shared/xiangqi.js';

let failures = 0;
function check(name, actual, expected) {
  const ok = actual === expected;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}: got ${actual}, expected ${expected}`);
  if (!ok) failures++;
}

function perft(board, side, depth) {
  if (depth === 0) return 1;
  let nodes = 0;
  for (const { from, to } of legalMoves(board, side)) {
    const captured = applyMove(board, from, to);
    nodes += perft(board, opposite(side), depth - 1);
    undoMove(board, from, to, captured);
  }
  return nodes;
}

const board = initialBoard();
console.time('perft');
check('perft(1)', perft(board, RED, 1), 44);
check('perft(2)', perft(board, RED, 2), 1920);
check('perft(3)', perft(board, RED, 3), 79666);
check('perft(4)', perft(board, RED, 4), 3290240);
console.timeEnd('perft');

// --- Rule-specific scenarios ---

// Flying general: kings on the same open file may not face each other.
{
  const b = new Array(90).fill('');
  b[idx(0, 4)] = 'k';
  b[idx(9, 4)] = 'K';
  b[idx(5, 5)] = 'R';
  // Red king may not move sideways off the file? Actually it must NOT stay
  // facing: here they already face each other, so any red move must resolve
  // it. Moving the king to col 3/5 is legal; staying put along the file
  // is not a move. Check that king cannot move within the same file only
  // when it keeps facing — i.e. red king at (9,4) can't exist facing black.
  check('facing kings: red is "in check"', inCheck(b, RED), true);
  check('facing kings: black is "in check"', inCheck(b, BLACK), true);
}

// Flying general blocked by a screen piece: not facing.
{
  const b = new Array(90).fill('');
  b[idx(0, 4)] = 'k';
  b[idx(9, 4)] = 'K';
  b[idx(5, 4)] = 'p';
  check('screened kings: red not in check', inCheck(b, RED), false);
}

// Horse leg blocking.
{
  const b = new Array(90).fill('');
  b[idx(9, 4)] = 'K';
  b[idx(0, 3)] = 'k'; // off the red king's file to avoid flying-general
  b[idx(7, 5)] = 'n'; // black horse attacks (9,4) via leg (8,5)
  check('horse checks king', inCheck(b, RED), true);
  b[idx(8, 5)] = 'P'; // block the leg
  check('blocked horse does not check', inCheck(b, RED), false);
}

// Cannon check over one screen.
{
  const b = new Array(90).fill('');
  b[idx(9, 4)] = 'K';
  b[idx(0, 4)] = 'k';
  b[idx(0, 3)] = 'c';
  b[idx(9, 3)] = 'K' === '' ? '' : ''; // no-op, keep file 3 clear
  b[idx(2, 4)] = 'c'; // cannon on king file, no screen -> no check
  check('cannon without screen: no check', inCheck(b, RED), false);
  b[idx(5, 4)] = 'p'; // add a screen
  check('cannon with one screen: check', inCheck(b, RED), true);
  b[idx(6, 4)] = 'P'; // second screen
  check('cannon with two screens: no check', inCheck(b, RED), false);
}

// Pawn attacks: red pawn attacks forward; sideways only after crossing.
{
  const b = new Array(90).fill('');
  b[idx(0, 4)] = 'k';
  b[idx(9, 4)] = 'K';
  b[idx(9, 3)] = '' || '';
  b[idx(1, 4)] = 'P'; // red pawn directly below black king
  check('red pawn checks black king from below', inCheck(b, BLACK), true);
  b[idx(1, 4)] = '';
  b[idx(0, 3)] = 'P'; // beside the king, crossed river -> attacks sideways
  check('crossed red pawn checks sideways', inCheck(b, BLACK), true);
}

// Simple checkmate: 双车错 style mate.
{
  const b = new Array(90).fill('');
  b[idx(0, 4)] = 'k';
  b[idx(9, 3)] = 'K';
  b[idx(0, 0)] = 'R'; // rook on back rank
  b[idx(1, 8)] = 'R'; // rook covering rank 1
  check('two-rook mate', status(b, BLACK), 'checkmate');
}

// Stalemate (困毙): black king trapped but not in check -> still a loss.
{
  const b = new Array(90).fill('');
  b[idx(0, 3)] = 'k';
  b[idx(9, 4)] = 'K';
  b[idx(2, 2)] = 'R'; // covers col 3 rows? No: covers row 2 and col 2.
  // Build precisely: black king at (0,3). Moves: (0,4)? palace ok; (1,3).
  // Red rook at (1,4) would give check? (1,4) attacks (0,4) and (1,3) but
  // not (0,3). King at (0,3): dest (0,4) attacked by rook via col? rook at
  // (1,4) attacks (0,4) yes; dest (1,3) attacked along row 1 yes. Not in
  // check now. That's stalemate with just K+R.
  b[idx(2, 2)] = '';
  b[idx(1, 4)] = 'R';
  b[idx(9, 4)] = '';
  b[idx(9, 3)] = 'K'; // keep kings off shared file (col 3 vs king col 3? k at col3)
  b[idx(9, 3)] = '';
  b[idx(9, 5)] = 'K'; // red king col 5, black king col 3, no facing
  check('stalemate is detected', status(b, BLACK), 'stalemate');
}

// Move description sanity.
{
  const b = initialBoard();
  check('describe 炮二平五', describeMove(b, idx(7, 7), idx(7, 4)), '炮二平五');
  check('describe 马8进7 (black)', describeMove(b, idx(0, 7), idx(2, 6)), '马8进7');
}

console.log(failures === 0 ? '\nAll tests passed.' : `\n${failures} test(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
