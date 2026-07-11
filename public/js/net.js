/**
 * WebSocket client with auto-reconnect + session rejoin.
 * Stores the current room (code + token) in sessionStorage so a page
 * refresh or dropped connection can resume the game.
 */
const SESSION_KEY = 'xq_session';

export class Net {
  constructor() {
    this.ws = null;
    this.handlers = new Map();
    this.connected = false;
    this.shouldReconnect = false;
    this.retryDelay = 500;
    this.pending = []; // messages queued while the socket is connecting
  }

  on(type, fn) {
    this.handlers.set(type, fn);
  }

  emit(type, msg) {
    const fn = this.handlers.get(type);
    if (fn) fn(msg);
  }

  url() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    return `${proto}://${location.host}/ws`;
  }

  connect() {
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      return;
    }
    this.shouldReconnect = true;
    const ws = new WebSocket(this.url());
    this.ws = ws;

    ws.onopen = () => {
      this.connected = true;
      this.retryDelay = 500;
      this.emit('_open');
      const session = this.getSession();
      if (session) this.send({ type: 'rejoin', code: session.code, token: session.token });
      const queued = this.pending.splice(0);
      for (const m of queued) this.send(m);
    };

    ws.onmessage = (e) => {
      let msg;
      try {
        msg = JSON.parse(e.data);
      } catch {
        return;
      }
      // Session bookkeeping.
      if ((msg.type === 'created' || msg.type === 'joined' || msg.type === 'waiting') && msg.token) {
        this.setSession({ code: msg.code, token: msg.token });
      }
      if (msg.type === 'error' && msg.code === 'ROOM_GONE') this.clearSession();
      this.emit(msg.type, msg);
    };

    ws.onclose = () => {
      this.connected = false;
      this.emit('_close');
      if (this.shouldReconnect) {
        setTimeout(() => this.connect(), this.retryDelay);
        this.retryDelay = Math.min(this.retryDelay * 2, 8000);
      }
    };

    ws.onerror = () => {
      try { ws.close(); } catch { /* ignore */ }
    };
  }

  disconnect() {
    this.shouldReconnect = false;
    this.pending = [];
    this.clearSession();
    if (this.ws) {
      try { this.ws.close(); } catch { /* ignore */ }
    }
    this.ws = null;
    this.connected = false;
  }

  send(msg) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
      return true;
    }
    return false;
  }

  /** Send now if connected, otherwise queue until the socket opens. */
  sendWhenReady(msg) {
    if (!this.send(msg)) this.pending.push(msg);
  }

  getSession() {
    try {
      const raw = sessionStorage.getItem(SESSION_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  }

  setSession(s) {
    try { sessionStorage.setItem(SESSION_KEY, JSON.stringify(s)); } catch { /* ignore */ }
  }

  clearSession() {
    try { sessionStorage.removeItem(SESSION_KEY); } catch { /* ignore */ }
  }
}
