/**
 * PvP server integration test.
 * Usage: node test/pvp.test.js [wsUrl]   (default ws://localhost:3000/ws)
 * Simulates two clients: room create/join, moves, clocks with increment,
 * illegal move rejection, resign, rematch, draw agreement, quick match, rejoin.
 */
import WebSocket from 'ws';
import { idx, RED } from '../shared/xiangqi.js';

const URL = process.argv[2] || 'ws://localhost:3000/ws';
let failures = 0;

function check(name, cond, detail = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ` (${detail})` : ''}`);
  if (!cond) failures++;
}

class Client {
  constructor(name) {
    this.name = name;
    this.ws = new WebSocket(URL);
    this.queue = [];
    this.waiters = [];
    this.ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      const w = this.waiters.findIndex((x) => x.type === msg.type);
      if (w >= 0) {
        const { resolve } = this.waiters.splice(w, 1)[0];
        resolve(msg);
      } else {
        this.queue.push(msg);
      }
    });
    this.open = new Promise((res) => this.ws.on('open', res));
  }

  send(msg) {
    this.ws.send(JSON.stringify(msg));
  }

  expect(type, timeoutMs = 4000) {
    const i = this.queue.findIndex((m) => m.type === type);
    if (i >= 0) return Promise.resolve(this.queue.splice(i, 1)[0]);
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`${this.name}: timeout waiting for '${type}'`)), timeoutMs);
      this.waiters.push({ type, resolve: (m) => { clearTimeout(t); resolve(m); } });
    });
  }

  close() {
    try { this.ws.close(); } catch { /* ignore */ }
  }
}

const sq = (r, c) => idx(r, c);

async function main() {
  // ---- Scenario 1: create/join, moves, clocks ----
  const a = new Client('A');
  await a.open;
  a.send({ type: 'create', tc: 300000 });
  const created = await a.expect('created');
  check('room created with 6-char code', created.code && created.code.length === 6, created.code);

  const b = new Client('B');
  await b.open;
  b.send({ type: 'join', code: created.code });
  const joinedB = await b.expect('joined');
  check('B joined with opposite side', joinedB.side !== created.side, `${created.side} vs ${joinedB.side}`);

  const startA = await a.expect('start');
  const startB = await b.expect('start');
  check('both got start, tc 5min', startA.tc === 300000 && startB.tc === 300000);

  const red = startA.side === RED ? a : b;
  const black = red === a ? b : a;

  // Wrong player tries to move.
  black.send({ type: 'move', from: sq(7, 7), to: sq(7, 4) });
  const err1 = await black.expect('error');
  check('move out of turn rejected', !!err1.message);

  // Illegal move by red.
  red.send({ type: 'move', from: sq(9, 0), to: sq(5, 0) }); // rook through pawn? (9,0)->(5,0) blocked by pawn (6,0)
  const err2 = await red.expect('error');
  check('illegal move rejected', !!err2.message);

  // Legal move: cannon to center.
  await new Promise((r) => setTimeout(r, 1200)); // burn some clock
  red.send({ type: 'move', from: sq(7, 7), to: sq(7, 4) });
  const mvA = await a.expect('moved');
  const mvB = await b.expect('moved');
  check('move broadcast to both', mvA.from === sq(7, 7) && mvB.to === sq(7, 4));
  const redClock = mvA.clocks.r;
  check('increment applied (clock > 300000 - elapsed + 2s)', redClock > 300000 + 3000 - 1200 - 800 && redClock <= 303000, String(redClock));
  check('turn passed to black', mvA.turn === 'b');
  check('move described', mvA.desc === '炮二平五', mvA.desc);

  // Black replies.
  black.send({ type: 'move', from: sq(0, 1), to: sq(2, 2) }); // 马2进3-ish
  const mv2 = await a.expect('moved');
  await b.expect('moved');
  check('black moved, turn red', mv2.turn === 'r');

  // Resign.
  black.send({ type: 'resign' });
  const overA = await a.expect('gameOver');
  await b.expect('gameOver');
  check('resign ends game, red wins', overA.winner === 'r' && overA.reason === 'resign');

  // Rematch with side swap.
  a.send({ type: 'rematch' });
  await b.expect('rematchOffered');
  b.send({ type: 'rematch' });
  const restartA = await a.expect('start');
  await b.expect('start');
  check('rematch swaps sides', restartA.side !== startA.side, `${startA.side} -> ${restartA.side}`);

  // Draw agreement.
  const red2 = restartA.side === RED ? a : b;
  const black2 = red2 === a ? b : a;
  red2.send({ type: 'drawOffer' });
  await black2.expect('drawOffered');
  black2.send({ type: 'drawResponse', accept: true });
  const drawA = await a.expect('gameOver');
  await b.expect('gameOver');
  check('draw agreed', drawA.winner === null && drawA.reason === 'agreement');

  // ---- Scenario 2: rejoin after disconnect ----
  a.send({ type: 'rematch' });
  b.send({ type: 'rematch' });
  await a.expect('start');
  await b.expect('start');
  const tokenA = created.token;
  a.ws.terminate();
  await b.expect('opponentDisconnected', 6000);
  const a2 = new Client('A2');
  await a2.open;
  a2.send({ type: 'rejoin', code: created.code, token: tokenA });
  const state = await a2.expect('state');
  check('rejoin returns full state', state.board && state.board.length === 90 && state.started === true);
  await b.expect('opponentReconnected');
  check('opponent notified of reconnection', true);

  a2.close();
  b.close();

  // ---- Scenario 3: quick match pairing ----
  const q1 = new Client('Q1');
  const q2 = new Client('Q2');
  await q1.open;
  q1.send({ type: 'quick', tc: 600000 });
  await q1.expect('waiting');
  await q2.open;
  q2.send({ type: 'quick', tc: 600000 });
  await q2.expect('joined');
  const qs1 = await q1.expect('start');
  const qs2 = await q2.expect('start');
  check('quick match pairs and starts', qs1.tc === 600000 && qs1.side !== qs2.side);
  q1.close();
  q2.close();

  // ---- Scenario 4: invalid tc rejected ----
  const x = new Client('X');
  await x.open;
  x.send({ type: 'create', tc: 123 });
  const errTc = await x.expect('error');
  check('invalid time control rejected', !!errTc.message);
  x.close();

  console.log(failures === 0 ? '\nAll PvP tests passed.' : `\n${failures} PvP test(s) FAILED.`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('FATAL:', e.message);
  process.exit(1);
});
