/**
 * Web Xiangqi server.
 * - Serves the static client (public/) and the shared rules engine (shared/).
 * - Hosts online PvP over WebSocket: rooms with invite codes, quick match,
 *   server-authoritative clocks (5/10/15 min + 3s increment), reconnection.
 */
import express from 'express';
import http from 'http';
import crypto from 'crypto';
import path from 'path';
import dns from 'dns';
import { fileURLToPath } from 'url';
import { WebSocketServer } from 'ws';
import nodemailer from 'nodemailer';
import {
  initialBoard, isLegalMove, applyMove, inCheck, status as gameStatus,
  positionKey, describeMove, opposite, perpetualCheckOffender, RED, BLACK,
} from '../shared/xiangqi.js';

// Some hosts (Render's free tier included) advertise IPv6 in DNS but can't
// actually route outbound IPv6 traffic, so an SMTP connection to Gmail
// resolves to an AAAA address and then fails with ENETUNREACH. Prefer IPv4
// resolution process-wide to avoid that trap.
dns.setDefaultResultOrder('ipv4first');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;
const INCREMENT_MS = 3000;
const TIME_CONTROLS = new Set([5 * 60000, 10 * 60000, 15 * 60000]);
const RECONNECT_GRACE_MS = 60000;
const ROOM_IDLE_SWEEP_MS = 10 * 60000;

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '10kb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));
app.use('/shared', express.static(path.join(__dirname, '..', 'shared')));
app.get('/healthz', (_req, res) => res.json({ ok: true }));

// Counters since server start (reset on restart/redeploy).
const stats = {
  startedAt: Date.now(),
  totalConnections: 0,
  gamesStarted: 0,
};

// Presence heartbeat: every open page pings periodically, so "online" also
// counts visitors browsing the menu or playing against the AI (who never
// open a game WebSocket).
const PRESENCE_TTL_MS = 75000;
const presence = new Map(); // visitorId -> lastSeen
const visitorsEver = new Set(); // unique visitor ids since server start

app.post('/presence', (req, res) => {
  const id = String(req.query.id || '').slice(0, 40);
  if (id) {
    presence.set(id, Date.now());
    visitorsEver.add(id);
  }
  res.json({ ok: true });
});

function onlineCount() {
  const cutoff = Date.now() - PRESENCE_TTL_MS;
  let n = 0;
  for (const t of presence.values()) if (t >= cutoff) n++;
  return n;
}

app.get('/stats', (_req, res) => {
  let playing = 0;
  for (const room of rooms.values()) {
    if (room.started && !room.over) playing++;
  }
  res.json({
    online: onlineCount(),
    playing,
    waitingQuick: quickQueue.size,
    uniqueVisitors: visitorsEver.size,
    totalConnections: stats.totalConnections,
    gamesStarted: stats.gamesStarted,
    uptimeMinutes: Math.floor((Date.now() - stats.startedAt) / 60000),
  });
});

// Player feedback -> emailed to the site owner via Gmail SMTP. Credentials
// and the destination address live only in Render environment variables,
// never in source (the repo is public), so the address is never exposed.
// With no credentials configured, feedback is still accepted and logged
// server-side so nothing is lost while waiting on setup.
let mailer = null;
if (process.env.GMAIL_USER && process.env.GMAIL_APP_PASSWORD) {
  mailer = nodemailer.createTransport({
    host: 'smtp.gmail.com',
    port: 465,
    secure: true,
    family: 4, // belt-and-suspenders alongside dns.setDefaultResultOrder above
    auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASSWORD },
  });
} else {
  log('feedback: GMAIL_USER/GMAIL_APP_PASSWORD not set -- feedback will be logged only, not emailed');
}

const FEEDBACK_MAX_LEN = 2000;
const FEEDBACK_WINDOW_MS = 60 * 60000;
const FEEDBACK_MAX_PER_WINDOW = 5;
const feedbackRate = new Map(); // ip -> timestamps[]

app.post('/api/feedback', async (req, res) => {
  const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || 'unknown';
  const now = Date.now();
  const hits = (feedbackRate.get(ip) || []).filter((t) => now - t < FEEDBACK_WINDOW_MS);
  if (hits.length >= FEEDBACK_MAX_PER_WINDOW) {
    return res.status(429).json({ ok: false, message: '提交太频繁，请稍后再试' });
  }
  const message = String(req.body?.message || '').trim().slice(0, FEEDBACK_MAX_LEN);
  const contact = String(req.body?.contact || '').trim().slice(0, 200);
  if (!message) return res.status(400).json({ ok: false, message: '反馈内容不能为空' });

  hits.push(now);
  feedbackRate.set(ip, hits);
  log(`feedback received (${message.length} chars)${contact ? ', contact provided' : ''}`);

  if (mailer) {
    try {
      await mailer.sendMail({
        from: process.env.GMAIL_USER,
        to: process.env.FEEDBACK_TO || process.env.GMAIL_USER,
        subject: `[中国象棋反馈] ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`,
        text: `反馈内容：\n${message}\n\n联系方式：${contact || '（未填写）'}\nIP: ${ip}`,
      });
    } catch (err) {
      log('feedback: email send failed:', err.message, '-- content was:', message.slice(0, 300));
    }
  } else {
    log('feedback (no mailer configured) --', message.slice(0, 500), contact ? `| contact: ${contact}` : '');
  }
  res.json({ ok: true });
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

/** code -> room */
const rooms = new Map();
/** tc(ms) -> waiting room code for quick match */
const quickQueue = new Map();

function makeCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  do {
    code = Array.from(crypto.randomBytes(6)).map((b) => alphabet[b % alphabet.length]).join('');
  } while (rooms.has(code));
  return code;
}

function log(...args) {
  console.log(new Date().toISOString(), ...args);
}

function makeRoom(tc, isQuick) {
  const room = {
    code: makeCode(),
    tc,
    isQuick: !!isQuick,
    players: [], // { token, side, ws, graceTimer }
    board: null,
    turn: RED,
    moves: [],
    posLog: [], // { key, mover, isCheck }[] -- for repetition + perpetual-check detection
    clocks: { [RED]: tc, [BLACK]: tc },
    turnStart: 0,
    flagTimer: null,
    started: false,
    over: false,
    result: null, // { winner: 'r'|'b'|null, reason }
    drawOfferBy: null,
    rematchVotes: new Set(),
    lastActivity: Date.now(),
  };
  rooms.set(room.code, room);
  return room;
}

function send(ws, msg) {
  if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
}

function broadcast(room, msg) {
  for (const p of room.players) send(p.ws, msg);
}

function playerBySide(room, side) {
  return room.players.find((p) => p.side === side);
}

function currentClocks(room) {
  const clocks = { ...room.clocks };
  if (room.started && !room.over && room.turnStart) {
    clocks[room.turn] = Math.max(0, clocks[room.turn] - (Date.now() - room.turnStart));
  }
  return clocks;
}

function fullState(room, forPlayer) {
  return {
    type: 'state',
    code: room.code,
    tc: room.tc,
    incrementMs: INCREMENT_MS,
    side: forPlayer.side,
    started: room.started,
    over: room.over,
    result: room.result,
    board: room.board,
    turn: room.turn,
    moves: room.moves,
    clocks: currentClocks(room),
    opponentConnected: room.players.some((p) => p !== forPlayer && p.ws),
    drawOfferBy: room.drawOfferBy,
  };
}

function startGame(room) {
  stats.gamesStarted++;
  room.board = initialBoard();
  room.turn = RED;
  room.moves = [];
  room.posLog = [{ key: positionKey(room.board, RED), mover: null, isCheck: false }];
  room.clocks = { [RED]: room.tc, [BLACK]: room.tc };
  room.started = true;
  room.over = false;
  room.result = null;
  room.drawOfferBy = null;
  room.rematchVotes.clear();
  room.turnStart = Date.now();
  armFlagTimer(room);
  for (const p of room.players) {
    send(p.ws, { type: 'start', side: p.side, tc: room.tc, incrementMs: INCREMENT_MS, code: room.code });
  }
}

function armFlagTimer(room) {
  clearTimeout(room.flagTimer);
  if (!room.started || room.over) return;
  const remaining = room.clocks[room.turn];
  room.flagTimer = setTimeout(() => {
    if (room.over || !room.started) return;
    room.clocks[room.turn] = 0;
    endGame(room, opposite(room.turn), 'timeout');
  }, remaining + 50);
}

function endGame(room, winner, reason) {
  log(`room ${room.code}: game over, winner=${winner || 'draw'}, reason=${reason}`);
  room.over = true;
  room.result = { winner, reason };
  clearTimeout(room.flagTimer);
  room.turnStart = 0;
  broadcast(room, { type: 'gameOver', winner, reason, clocks: room.clocks });
  room.lastActivity = Date.now();
}

function handleMove(room, player, from, to) {
  if (!room.started || room.over) return send(player.ws, { type: 'error', message: '对局未在进行中' });
  if (player.side !== room.turn) return send(player.ws, { type: 'error', message: '还没轮到你走棋' });
  if (!isLegalMove(room.board, player.side, from, to)) {
    return send(player.ws, { type: 'error', message: '不合法的走法' });
  }

  // Clock accounting.
  const now = Date.now();
  const elapsed = now - room.turnStart;
  const left = room.clocks[player.side] - elapsed;
  if (left <= 0) {
    room.clocks[player.side] = 0;
    return endGame(room, opposite(player.side), 'timeout');
  }
  room.clocks[player.side] = left + INCREMENT_MS;

  const desc = describeMove(room.board, from, to);
  const captured = applyMove(room.board, from, to);
  room.moves.push({ from, to, desc });
  room.turn = opposite(room.turn);
  room.turnStart = now;
  room.drawOfferBy = null;
  room.lastActivity = now;

  const key = positionKey(room.board, room.turn);
  const isCheckMove = inCheck(room.board, room.turn);
  room.posLog.push({ key, mover: player.side, isCheck: isCheckMove });
  const reps = room.posLog.filter((e) => e.key === key).length;

  broadcast(room, {
    type: 'moved',
    from,
    to,
    desc,
    captured,
    by: player.side,
    turn: room.turn,
    clocks: currentClocks(room),
    check: isCheckMove,
  });

  const st = gameStatus(room.board, room.turn);
  if (st !== 'ongoing') {
    // Checkmate and stalemate both lose for the side to move.
    return endGame(room, opposite(room.turn), st);
  }
  if (reps >= 3) {
    // Repetition alone isn't automatically a draw: whichever side has been
    // checking on every one of its moves throughout the repeated span is
    // committing 长将 (perpetual check) and loses outright.
    const offender = perpetualCheckOffender(room.posLog, key);
    return offender
      ? endGame(room, opposite(offender), 'perpetual-check')
      : endGame(room, null, 'repetition');
  }
  armFlagTimer(room);
}

function detachPlayer(room, player) {
  player.ws = null;
  broadcast(room, { type: 'opponentDisconnected', graceMs: RECONNECT_GRACE_MS });
  clearTimeout(player.graceTimer);
  player.graceTimer = setTimeout(() => {
    if (player.ws) return;
    if (room.started && !room.over) {
      const other = room.players.find((p) => p !== player);
      endGame(room, other ? other.side : null, 'abandon');
    }
    maybeDeleteRoom(room);
  }, RECONNECT_GRACE_MS);
}

function maybeDeleteRoom(room) {
  const anyConnected = room.players.some((p) => p.ws);
  if (!anyConnected && (room.over || !room.started)) {
    clearTimeout(room.flagTimer);
    for (const p of room.players) clearTimeout(p.graceTimer);
    rooms.delete(room.code);
    if (quickQueue.get(room.tc) === room.code) quickQueue.delete(room.tc);
  }
}

// Periodic sweep of dead/idle rooms and stale presence entries.
setInterval(() => {
  const now = Date.now();
  for (const [id, t] of presence) {
    if (now - t > PRESENCE_TTL_MS * 2) presence.delete(id);
  }
  for (const [ip, hits] of feedbackRate) {
    const fresh = hits.filter((t) => now - t < FEEDBACK_WINDOW_MS);
    if (fresh.length === 0) feedbackRate.delete(ip);
    else feedbackRate.set(ip, fresh);
  }
  for (const room of rooms.values()) {
    const idle = now - room.lastActivity > ROOM_IDLE_SWEEP_MS;
    const anyConnected = room.players.some((p) => p.ws);
    if (!anyConnected && idle) {
      clearTimeout(room.flagTimer);
      for (const p of room.players) clearTimeout(p.graceTimer);
      rooms.delete(room.code);
      if (quickQueue.get(room.tc) === room.code) quickQueue.delete(room.tc);
    }
  }
}, 60000).unref();

wss.on('connection', (ws) => {
  stats.totalConnections++;
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  let room = null;
  let player = null;

  const joinAsSecond = (r) => {
    const taken = r.players[0].side;
    player = { token: crypto.randomUUID(), side: opposite(taken), ws, graceTimer: null };
    r.players.push(player);
    room = r;
    send(ws, { type: 'joined', code: r.code, token: player.token, side: player.side, tc: r.tc });
    startGame(r);
  };

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return send(ws, { type: 'error', message: '消息格式错误' });
    }

    switch (msg.type) {
      case 'create': {
        const tc = Number(msg.tc);
        if (!TIME_CONTROLS.has(tc)) return send(ws, { type: 'error', message: '无效的时间设置' });
        if (room) return;
        room = makeRoom(tc, false);
        const side = Math.random() < 0.5 ? RED : BLACK;
        player = { token: crypto.randomUUID(), side, ws, graceTimer: null };
        room.players.push(player);
        send(ws, { type: 'created', code: room.code, token: player.token, side, tc });
        break;
      }

      case 'join': {
        if (room) return;
        const code = String(msg.code || '').trim().toUpperCase();
        const r = rooms.get(code);
        if (!r) return send(ws, { type: 'error', message: '房间不存在' });
        if (r.players.length >= 2) return send(ws, { type: 'error', message: '房间已满' });
        joinAsSecond(r);
        break;
      }

      case 'quick': {
        if (room) return;
        const tc = Number(msg.tc);
        if (!TIME_CONTROLS.has(tc)) return send(ws, { type: 'error', message: '无效的时间设置' });
        const waitingCode = quickQueue.get(tc);
        const waiting = waitingCode ? rooms.get(waitingCode) : null;
        if (waiting && waiting.players.length === 1 && waiting.players[0].ws) {
          quickQueue.delete(tc);
          log(`quick match: paired into room ${waiting.code} (tc=${tc})`);
          joinAsSecond(waiting);
        } else {
          room = makeRoom(tc, true);
          const side = Math.random() < 0.5 ? RED : BLACK;
          player = { token: crypto.randomUUID(), side, ws, graceTimer: null };
          room.players.push(player);
          quickQueue.set(tc, room.code);
          log(`quick match: waiting in room ${room.code} (tc=${tc})`);
          send(ws, { type: 'waiting', code: room.code, token: player.token, tc });
        }
        break;
      }

      case 'rejoin': {
        if (room) return;
        const r = rooms.get(String(msg.code || '').toUpperCase());
        if (!r) return send(ws, { type: 'error', code: 'ROOM_GONE', message: '对局已结束或不存在' });
        const p = r.players.find((pl) => pl.token === msg.token);
        if (!p) return send(ws, { type: 'error', code: 'ROOM_GONE', message: '无法加入该对局' });
        if (p.ws && p.ws !== ws) {
          try { p.ws.close(); } catch { /* ignore */ }
        }
        clearTimeout(p.graceTimer);
        p.ws = ws;
        room = r;
        player = p;
        if (!r.started) {
          // Still waiting for an opponent: confirm the queue/room instead of
          // sending a (nonexistent) game state.
          send(ws, {
            type: r.isQuick ? 'waiting' : 'created',
            code: r.code,
            token: p.token,
            side: p.side,
            tc: r.tc,
          });
        } else {
          send(ws, fullState(r, p));
          const other = r.players.find((pl) => pl !== p);
          if (other) send(other.ws, { type: 'opponentReconnected' });
        }
        break;
      }

      case 'move': {
        if (!room || !player) return;
        handleMove(room, player, Number(msg.from), Number(msg.to));
        break;
      }

      case 'resign': {
        if (!room || !player || !room.started || room.over) return;
        endGame(room, opposite(player.side), 'resign');
        break;
      }

      case 'drawOffer': {
        if (!room || !player || !room.started || room.over) return;
        if (room.drawOfferBy && room.drawOfferBy !== player.side) {
          return endGame(room, null, 'agreement');
        }
        room.drawOfferBy = player.side;
        const other = room.players.find((p) => p !== player);
        if (other) send(other.ws, { type: 'drawOffered' });
        break;
      }

      case 'drawResponse': {
        if (!room || !player || !room.started || room.over) return;
        if (room.drawOfferBy && room.drawOfferBy !== player.side) {
          if (msg.accept) return endGame(room, null, 'agreement');
          room.drawOfferBy = null;
          const other = room.players.find((p) => p !== player);
          if (other) send(other.ws, { type: 'drawDeclined' });
        }
        break;
      }

      case 'rematch': {
        if (!room || !player || !room.over) return;
        room.rematchVotes.add(player.token);
        const other = room.players.find((p) => p !== player);
        if (room.rematchVotes.size >= 2 && room.players.every((p) => p.ws)) {
          // Swap sides for fairness.
          for (const p of room.players) p.side = opposite(p.side);
          startGame(room);
        } else if (other) {
          send(other.ws, { type: 'rematchOffered' });
        }
        break;
      }

      case 'leave': {
        if (!room || !player) return;
        const r = room;
        const other = r.players.find((p) => p !== player);
        if (r.started && !r.over && other) {
          endGame(r, other.side, 'abandon');
        }
        r.players = r.players.filter((p) => p !== player);
        if (other) send(other.ws, { type: 'opponentLeft' });
        if (quickQueue.get(r.tc) === r.code) quickQueue.delete(r.tc);
        room = null;
        player = null;
        maybeDeleteRoom(r);
        break;
      }

      default:
        send(ws, { type: 'error', message: '未知消息类型' });
    }
  });

  ws.on('close', () => {
    if (room && player && player.ws === ws) {
      log(`room ${room.code}: player (${player.side}) disconnected, started=${room.started}, over=${room.over}`);
      if (!room.started || room.over) {
        room.players = room.players.filter((p) => p !== player);
        if (quickQueue.get(room.tc) === room.code && room.players.length === 0) quickQueue.delete(room.tc);
        const other = room.players.find((p) => p !== player);
        if (other && !room.started) send(other.ws, { type: 'opponentLeft' });
        maybeDeleteRoom(room);
      } else {
        detachPlayer(room, player);
      }
    }
  });
});

// Heartbeat: drop dead sockets so grace timers kick in.
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) {
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    ws.ping();
  }
}, 30000).unref();

server.listen(PORT, () => {
  console.log(`Xiangqi server listening on http://localhost:${PORT}`);
});
