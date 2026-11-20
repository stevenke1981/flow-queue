#!/usr/bin/env node
'use strict';
// Flow Queue bridge daemon: HTTP API for MCP/CLI + a hand-written RFC 6455 WebSocket endpoint for the extension.
// Zero dependencies. Binds 127.0.0.1 only.
const http = require('http');
const crypto = require('crypto');
const lib = require('./lib');

const PORT = lib.getPort();
const EXT_ORIGIN = lib.getExtOrigin();
const TOKEN = lib.ensureToken();
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const PING_MS = 20000;
const DEAD_MS = 65000;          // no frame from the extension for this long → drop it
const STALE_MS = Math.max(100, parseInt(process.env.FLOW_QUEUE_STALE_MS || '', 10) || 45000); // DESIGN §8 (env override for tests)
const AUTH_MS = 10000;          // the extension must answer the challenge within this time
const MAX_MESSAGE = lib.MAX_BODY_BYTES;   // 32 MB (DESIGN §7)
const MAX_BODY = lib.MAX_BODY_BYTES;
const ALLOWED_HOSTS = new Set(['127.0.0.1:' + PORT, 'localhost:' + PORT]);

const log = (...a) => console.log(new Date().toISOString(), ...a);

// ---------- WebSocket connection ----------
class WsConn {
  constructor(socket, onMessage, onClose) {
    this.socket = socket;
    this.onMessage = onMessage;
    this.onClose = onClose;
    this.buf = Buffer.alloc(0);
    this.fragments = null;     // {opcode, parts, size}
    this.closed = false;
    this.lastSeen = Date.now();
    socket.setNoDelay(true);
    socket.setKeepAlive(true, 30000);
    socket.on('data', (d) => this._onData(d));
    socket.on('close', () => this._finish());
    socket.on('end', () => this._finish());
    socket.on('error', () => this._finish());
  }

  _onData(d) {
    this.lastSeen = Date.now();
    this.buf = this.buf.length ? Buffer.concat([this.buf, d]) : d;
    try {
      while (!this.closed && this._parseFrame()) { /* keep parsing */ }
    } catch (e) {
      log('ws protocol error:', e.message);
      this.close(e.wsCode || 1002, e.message);
    }
  }

  _parseFrame() {
    const b = this.buf;
    if (b.length < 2) return false;
    const fin = (b[0] & 0x80) !== 0;
    if (b[0] & 0x70) throw Object.assign(new Error('RSV bits set'), { wsCode: 1002 });
    const opcode = b[0] & 0x0f;
    const masked = (b[1] & 0x80) !== 0;
    let len = b[1] & 0x7f;
    let off = 2;
    if (len === 126) {
      if (b.length < 4) return false;
      len = b.readUInt16BE(2);
      off = 4;
    } else if (len === 127) {
      if (b.length < 10) return false;
      const hi = b.readUInt32BE(2);
      const lo = b.readUInt32BE(6);
      if (hi > 0x1fffff) throw Object.assign(new Error('frame too large'), { wsCode: 1009 });
      len = hi * 0x100000000 + lo;
      off = 10;
    }
    if (!masked) throw Object.assign(new Error('client frame not masked'), { wsCode: 1002 });
    if (len > MAX_MESSAGE) throw Object.assign(new Error('frame too large'), { wsCode: 1009 });
    if (b.length < off + 4 + len) return false;
    const mask = b.subarray(off, off + 4);
    off += 4;
    const payload = Buffer.from(b.subarray(off, off + len));
    for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
    this.buf = b.subarray(off + len);

    if (opcode >= 0x8) {
      if (!fin || len > 125) throw Object.assign(new Error('bad control frame'), { wsCode: 1002 });
      if (opcode === 0x8) {
        const code = payload.length >= 2 ? payload.readUInt16BE(0) : 1000;
        this.close(code === 1005 || code === 1006 ? 1000 : code, '');
      } else if (opcode === 0x9) {
        this._send(0xA, payload);
      } // 0xA pong: lastSeen already updated
      else if (opcode !== 0xA) throw Object.assign(new Error('unknown control opcode'), { wsCode: 1002 });
      return true;
    }

    if (opcode === 0x0) {
      if (!this.fragments) throw Object.assign(new Error('unexpected continuation'), { wsCode: 1002 });
      this.fragments.parts.push(payload);
      this.fragments.size += payload.length;
      if (this.fragments.size > MAX_MESSAGE) throw Object.assign(new Error('message too large'), { wsCode: 1009 });
      if (fin) {
        const { opcode: op, parts } = this.fragments;
        this.fragments = null;
        this._deliver(op, Buffer.concat(parts));
      }
      return true;
    }
    if (opcode !== 0x1 && opcode !== 0x2) throw Object.assign(new Error('unknown opcode ' + opcode), { wsCode: 1002 });
    if (this.fragments) throw Object.assign(new Error('new message inside fragmented message'), { wsCode: 1002 });
    if (fin) this._deliver(opcode, payload);
    else this.fragments = { opcode, parts: [payload], size: payload.length };
    return true;
  }

  _deliver(opcode, data) {
    if (opcode !== 0x1) return; // binary frames are not part of the protocol
    let msg;
    try { msg = JSON.parse(data.toString('utf8')); } catch (e) { log('ws: ignoring non-JSON text frame'); return; }
    try { this.onMessage(msg); } catch (e) { log('ws handler error:', e.message); }
  }

  _send(opcode, payload) {
    if (this.closed || this.socket.destroyed) return false;
    const len = payload.length;
    let header;
    if (len < 126) {
      header = Buffer.from([0x80 | opcode, len]);
    } else if (len < 65536) {
      header = Buffer.alloc(4);
      header[0] = 0x80 | opcode; header[1] = 126; header.writeUInt16BE(len, 2);
    } else {
      header = Buffer.alloc(10);
      header[0] = 0x80 | opcode; header[1] = 127;
      header.writeUInt32BE(Math.floor(len / 0x100000000), 2);
      header.writeUInt32BE(len >>> 0, 6);
    }
    this.socket.write(Buffer.concat([header, payload]));
    return true;
  }

  sendJson(obj) {
    return this._send(0x1, Buffer.from(JSON.stringify(obj), 'utf8'));
  }

  close(code = 1000, reason = '') {
    if (this.closed) return;
    const r = Buffer.from(String(reason).slice(0, 120), 'utf8');
    const p = Buffer.alloc(2 + r.length);
    p.writeUInt16BE(code, 0);
    r.copy(p, 2);
    this._send(0x8, p);
    this.closed = true;
    this.socket.end();
    setTimeout(() => this.socket.destroy(), 1000).unref();
    this._finish();
  }

  _finish() {
    if (this._done) return;
    this._done = true;
    this.closed = true;
    if (!this.socket.destroyed) setTimeout(() => this.socket.destroy(), 1000).unref();
    this.onClose();
  }
}

// ---------- extension link ----------
let ext = null;        // current WsConn
let extInfo = null;    // hello payload
let seq = 0;
const pending = new Map(); // id -> {resolve, timer, conn}

function rejectPendingFor(conn, why) {
  for (const [id, p] of pending) {
    if (p.conn !== conn) continue;
    clearTimeout(p.timer);
    pending.delete(id);
    p.resolve({ status: 503, body: { ok: false, error: why } });
  }
}

function callExtension(method, params) {
  return new Promise((resolve) => {
    if (!ext) return resolve({ status: 503, body: { ok: false, error: 'Flow Queue extension is not connected' } });
    const id = String(++seq);
    const ms = method === 'listAssets' ? 60000 : 30000;
    const conn = ext;
    const timer = setTimeout(() => {
      pending.delete(id);
      resolve({ status: 504, body: { ok: false, error: 'extension did not answer "' + method + '" within ' + ms / 1000 + ' s' } });
    }, ms);
    pending.set(id, { resolve, timer, conn });
    if (!conn.sendJson({ type: 'req', id, method, params: params == null ? {} : params })) {
      clearTimeout(timer);
      pending.delete(id);
      resolve({ status: 503, body: { ok: false, error: 'Flow Queue extension is not connected' } });
    }
  });
}

const short = (id) => (id ? String(id).slice(0, 8) : null);

function macOk(expectedHex, gotHex) {
  const a = Buffer.from(String(expectedHex), 'utf8');
  const b = Buffer.from(typeof gotHex === 'string' ? gotHex.toLowerCase() : '', 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// Mutual authentication (DESIGN §7): challenge → hello{mac} → welcome{mac}. Only an authenticated
// connection becomes the extension link. When one already exists (DESIGN §8, several Chrome profiles):
// same instanceId or stale existing socket → replace (4000); takeover:true → replace (old gets 4003);
// otherwise the newcomer is rejected with 4002 'busy' and the existing link is left untouched.
// 4002/4003 are preceded by {type:'busy'|'taken', mac: HMAC(token, kind + ':' + extNonce)} so the extension can tell
// that the close really comes from a daemon holding the pairing token.
function onExtMessage(conn, msg) {
  if (!msg || typeof msg !== 'object') return;
  if (!conn.authed) {
    if (msg.type === 'ping') { conn.sendJson({ type: 'pong' }); return; }
    if (msg.type !== 'hello') return; // ignore everything else before authentication
    const extNonce = typeof msg.nonce === 'string' ? msg.nonce : '';
    if (!macOk(lib.hmacHex(TOKEN, 'ext:' + conn.nonce), msg.mac) || !/^[0-9a-f]{16,256}$/i.test(extNonce)) {
      log('extension failed authentication (wrong pairing token?)');
      conn.close(4001, 'authentication failed');
      return;
    }
    clearTimeout(conn.authTimer);
    const instanceId = typeof msg.instanceId === 'string' ? msg.instanceId.slice(0, 100) : '';
    let replaceCode = 0;
    if (ext && ext !== conn) {
      const idle = Date.now() - ext.lastSeen;
      if (instanceId && ext.instanceId === instanceId) replaceCode = 4000;      // same profile, SW restart
      else if (idle > STALE_MS) replaceCode = 4000;                            // old socket is dead
      else if (msg.takeover === true) replaceCode = 4003;                      // user-initiated takeover
      else {
        log('rejected extension instance ' + short(instanceId) + ': bridge busy (held by ' + short(ext.instanceId) + ')');
        conn.sendJson({ type: 'busy', mac: lib.hmacHex(TOKEN, 'busy:' + extNonce) }); // signed, so the ext trusts it
        conn.close(4002, 'busy');
        return;
      }
    }
    conn.authed = true;
    conn.instanceId = instanceId;
    conn.extNonce = extNonce;
    conn.sendJson({ type: 'welcome', mac: lib.hmacHex(TOKEN, 'daemon:' + extNonce) });
    if (replaceCode) {
      const old = ext;
      ext = conn;
      rejectPendingFor(old, replaceCode === 4003 ? 'Flow Queue extension connection was taken over' : 'Flow Queue extension connection was replaced');
      if (replaceCode === 4003) old.sendJson({ type: 'taken', mac: lib.hmacHex(TOKEN, 'taken:' + old.extNonce) });
      old.close(replaceCode, replaceCode === 4003 ? 'taken over' : 'replaced');
      log('instance ' + short(old.instanceId) + ' ' + (replaceCode === 4003 ? 'taken over' : 'replaced') + ' by ' + short(instanceId));
    }
    ext = conn;
    extInfo = { version: msg.version, extensionId: msg.extensionId, instanceId };
    log('extension authenticated', JSON.stringify({ version: msg.version, extensionId: msg.extensionId, instance: short(instanceId) }));
    return;
  }
  if (msg.type === 'res') {
    const p = pending.get(String(msg.id));
    if (!p || p.conn !== conn) return;
    clearTimeout(p.timer);
    pending.delete(String(msg.id));
    p.resolve(msg.ok
      ? { status: 200, body: { ok: true, result: msg.result === undefined ? null : msg.result } }
      : { status: 200, body: { ok: false, error: String(msg.error || 'extension call failed') } });
  } else if (msg.type === 'ping') {
    conn.sendJson({ type: 'pong' });
  } // 'pong' only refreshes lastSeen
}

setInterval(() => {
  if (!ext) return;
  if (Date.now() - ext.lastSeen > DEAD_MS) {
    log('extension connection timed out');
    ext.close(1001, 'timeout');
    return;
  }
  ext.sendJson({ type: 'ping' });
}, PING_MS).unref();

// ---------- HTTP ----------
function send(res, status, obj) {
  const body = Buffer.from(JSON.stringify(obj));
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(body);
}

function hostOk(req) {
  return ALLOWED_HOSTS.has(String(req.headers.host || '').toLowerCase());
}

function tokenOk(req) {
  const m = /^Bearer\s+(\S+)$/i.exec(String(req.headers.authorization || ''));
  if (!m) return false;
  const a = Buffer.from(m[1]);
  const b = Buffer.from(TOKEN);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(Object.assign(new Error('request body too large'), { status: 413 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.headers.origin !== undefined) return send(res, 403, { ok: false, error: 'requests with an Origin header are not allowed' });
    if (!hostOk(req)) return send(res, 403, { ok: false, error: 'bad Host header' });
    const url = (req.url || '/').split('?')[0];

    if (url === '/api/health') {
      if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, { ok: false, error: 'method not allowed' });
      return send(res, 200, { ok: true, extensionConnected: !!ext, version: lib.VERSION, instance: ext ? short(ext.instanceId) : null });
    }

    if (url === '/api/call') {
      if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'method not allowed' });
      if (!tokenOk(req)) return send(res, 401, { ok: false, error: 'missing or invalid bearer token (~/.flow-queue/token)' });
      let body;
      try {
        body = JSON.parse(await readBody(req));
      } catch (e) {
        return send(res, e.status || 400, { ok: false, error: e.status ? e.message : 'body must be JSON {method, params}' });
      }
      if (!body || typeof body.method !== 'string' || !body.method) return send(res, 400, { ok: false, error: 'missing "method"' });
      if (!ext) return send(res, 503, { ok: false, error: 'Flow Queue extension is not connected (open Chrome, enable the AI bridge in the side panel and paste the token from "flowq pair")' });
      const r = await callExtension(body.method, body.params);
      return send(res, r.status, r.body);
    }

    return send(res, 404, { ok: false, error: 'not found' });
  } catch (e) {
    log('http error:', e.stack || e.message);
    if (!res.headersSent) send(res, 500, { ok: false, error: String(e.message || e) });
  }
});

function rejectUpgrade(socket, status, text) {
  socket.end('HTTP/1.1 ' + status + ' ' + text + '\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
  setTimeout(() => socket.destroy(), 500).unref();
}

server.on('upgrade', (req, socket, head) => {
  socket.on('error', () => {});
  const url = (req.url || '/').split('?')[0];
  if (url !== '/ext') return rejectUpgrade(socket, 404, 'Not Found');
  if (req.headers.origin !== EXT_ORIGIN) {
    log('rejected WebSocket from origin', JSON.stringify(req.headers.origin || null));
    return rejectUpgrade(socket, 403, 'Forbidden');
  }
  if (!hostOk(req)) return rejectUpgrade(socket, 403, 'Forbidden');
  const key = req.headers['sec-websocket-key'];
  if (req.method !== 'GET' || String(req.headers.upgrade || '').toLowerCase() !== 'websocket' || !key ||
      String(req.headers['sec-websocket-version'] || '') !== '13') {
    return rejectUpgrade(socket, 400, 'Bad Request');
  }
  const accept = crypto.createHash('sha1').update(key + WS_GUID).digest('base64');
  socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n');

  const conn = new WsConn(socket, (msg) => onExtMessage(conn, msg), () => {
    clearTimeout(conn.authTimer);
    rejectPendingFor(conn, 'Flow Queue extension disconnected');
    if (ext === conn) { ext = null; extInfo = null; log('extension disconnected'); }
  });
  conn.authed = false;
  conn.nonce = crypto.randomBytes(32).toString('hex');
  conn.authTimer = setTimeout(() => {
    if (!conn.authed) { log('extension did not authenticate in time'); conn.close(4001, 'authentication timeout'); }
  }, AUTH_MS);
  conn.authTimer.unref();
  conn.sendJson({ type: 'challenge', nonce: conn.nonce });
  log('extension socket opened; challenge sent');
  if (head && head.length) conn._onData(head);
});

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') log('port ' + PORT + ' is already in use; is another Flow Queue daemon running?');
  else log('server error:', e.message);
  process.exit(1);
});

server.listen(PORT, '127.0.0.1', () => {
  log('Flow Queue bridge v' + lib.VERSION + ' listening on 127.0.0.1:' + PORT + ' (extension origin ' + EXT_ORIGIN + ')');
});

for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => process.exit(0));
