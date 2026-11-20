#!/usr/bin/env node
'use strict';
// Smoke test for flow-queue-bridge: daemon HTTP API, WS pairing handshake, bridge-client.js (in a vm with a fake
// chrome.* API), MCP stdio session and CLI. Run: node test/smoke.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const net = require('net');
const vm = require('vm');
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const { spawn, execFile } = require('child_process');

const ROOT = path.join(__dirname, '..');
const BRIDGE_CLIENT = path.join(ROOT, '..', 'flow-queue', 'bridge-client.js');
const ORIGIN = 'chrome-extension://smoketestextensionid';
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'fq-smoke-'));
const ENV = { ...process.env, HOME, USERPROFILE: HOME, FLOW_QUEUE_EXT_ORIGIN: ORIGIN };
const children = [];
const extraPids = [];
let passed = 0;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hmac = (key, text) => crypto.createHmac('sha256', key).update(text).digest('hex');
function ok(name) { passed++; console.log('  ok  ' + name); }

async function until(fn, ms = 8000, what = 'condition') {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('timed out waiting for ' + what);
    await sleep(50);
  }
}

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
    s.on('error', reject);
  });
}

function req(port, { method = 'GET', path: p = '/api/health', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
    const r = http.request({ host: '127.0.0.1', port, method, path: p,
      headers: { Host: '127.0.0.1:' + port, ...(data ? { 'Content-Type': 'application/json', 'Content-Length': data.length } : {}), ...headers } }, (res) => {
      let t = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (t += c));
      res.on('end', () => { let j = null; try { j = JSON.parse(t); } catch (e) { /* */ } resolve({ status: res.statusCode, json: j, text: t }); });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

// ---------- fake extension: bridge-client.js inside a vm with a fake chrome API ----------
function makeExtension({ port, token, wsOrigin, fq, instanceId, extra }) {
  const store = { settings: { bridgeEnabled: true, bridgePort: port, bridgeToken: token }, ...(extra || {}) };
  if (instanceId) store.bridgeInstanceId = instanceId;
  const sockets = { opened: 0, closeCodes: [] };
  const changeListeners = [];
  const alarmListeners = [];
  const startupListeners = [];
  const alarms = new Map();
  const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
  const chrome = {
    runtime: { id: ORIGIN.split('//')[1], lastError: undefined, getManifest: () => ({ version: '1.1.0' }), onStartup: { addListener: (f) => startupListeners.push(f) } },
    storage: {
      local: {
        get: async (keys) => {
          const ks = typeof keys === 'string' ? [keys] : Array.isArray(keys) ? keys : Object.keys(store);
          const o = {};
          for (const k of ks) if (k in store) o[k] = clone(store[k]);
          return o;
        },
        set: async (obj) => {
          const changes = {};
          for (const [k, v] of Object.entries(obj)) { changes[k] = { oldValue: clone(store[k]), newValue: clone(v) }; store[k] = clone(v); }
          for (const l of changeListeners) l(clone(changes), 'local');
        },
      },
      onChanged: { addListener: (f) => changeListeners.push(f) },
    },
    alarms: {
      onAlarm: { addListener: (f) => alarmListeners.push(f) },
      get: (name, cb) => cb(alarms.get(name)),
      create: (name, info) => alarms.set(name, { name, ...info }),
    },
  };
  class ExtWebSocket extends WebSocket {
    constructor(url) {
      super(url, { headers: { Origin: wsOrigin || ORIGIN } });
      sockets.opened++;
      this.addEventListener('close', (ev) => sockets.closeCodes.push(ev.code));
    }
  }
  const sandbox = {
    chrome, WebSocket: ExtWebSocket, crypto: globalThis.crypto, TextEncoder, TextDecoder,
    setTimeout, clearTimeout, setInterval, clearInterval, console, FQ: { call: fq },
  };
  sandbox.globalThis = sandbox;
  sandbox.__skew = 0;
  vm.createContext(sandbox);
  // injectable clock: lets the test jump past the 60 s busy-retry spacing without waiting
  vm.runInContext('(() => { const real = Date.now.bind(Date); Date.now = () => real() + (globalThis.__skew || 0); })()', sandbox);
  vm.runInContext(fs.readFileSync(BRIDGE_CLIENT, 'utf8'), sandbox, { filename: 'bridge-client.js' });
  return {
    store, alarms, sandbox, sockets,
    instance: () => store.bridgeInstanceId,
    skew: (ms) => { sandbox.__skew += ms; },
    takeover: () => sandbox.FQBridge.reconnect({ takeover: true }),
    bridge: () => store.bridge || {},
    setSettings: (patch) => chrome.storage.local.set({ settings: { ...store.settings, ...patch } }),
    fireAlarm: (name) => alarmListeners.forEach((f) => f({ name })),
    fireStartup: () => startupListeners.forEach((f) => f()),
  };
}

// ---------- minimal fake daemon (server side of RFC 6455) used to test the extension's welcome check ----------
function startFakeDaemon(port, onFrame) {
  const server = http.createServer((q, s) => { s.writeHead(404); s.end(); });
  const conns = [];
  server.on('upgrade', (q, socket) => {
    const accept = crypto.createHash('sha1').update(q.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n');
    const c = {
      socket, closed: null,
      closeWith(code) {
        socket.write(Buffer.from([0x88, 2, code >> 8, code & 255]));
        socket.end();
      },
      send(obj) {
        const p = Buffer.from(JSON.stringify(obj));
        const h = p.length < 126 ? Buffer.from([0x81, p.length]) : Buffer.from([0x81, 126, p.length >> 8, p.length & 255]);
        socket.write(Buffer.concat([h, p]));
      },
    };
    conns.push(c);
    let buf = Buffer.alloc(0);
    socket.on('error', () => {});
    socket.on('close', () => { if (!c.closed) c.closed = { code: 1006 }; });
    socket.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      while (buf.length >= 2) {
        let len = buf[1] & 0x7f, off = 2;
        if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
        if (buf.length < off + 4 + len) return;
        const mask = buf.subarray(off, off + 4);
        const pl = Buffer.from(buf.subarray(off + 4, off + 4 + len));
        for (let i = 0; i < pl.length; i++) pl[i] ^= mask[i & 3];
        const opcode = buf[0] & 0x0f;
        buf = buf.subarray(off + 4 + len);
        if (opcode === 0x8) { c.closed = { code: pl.length >= 2 ? pl.readUInt16BE(0) : 1005 }; socket.end(); return; }
        if (opcode === 0x1) onFrame(c, JSON.parse(pl.toString('utf8')));
      }
    });
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve({ server, conns })));
}

// ---------- raw extension client (hand-driven handshake) ----------
function rawExt(port, token, { instanceId = '', takeover = false, fq = async () => ({ raw: true }) } = {}) {
  const o = { welcomed: false };
  let resolveReady, resolveClosed;
  o.ready = new Promise((r) => (resolveReady = r));     // 'welcome' or the close code
  o.closed = new Promise((r) => (resolveClosed = r));   // close code
  const ws = new WebSocket('ws://127.0.0.1:' + port + '/ext', { headers: { Origin: ORIGIN } });
  o.ws = ws;
  let nonce = '';
  ws.onerror = () => {};
  ws.onmessage = async (ev) => {
    const m = JSON.parse(ev.data);
    if (m.type === 'challenge') {
      nonce = crypto.randomBytes(32).toString('hex');
      ws.send(JSON.stringify({ type: 'hello', version: 'raw', extensionId: 'raw', instanceId, takeover, nonce, mac: hmac(token, 'ext:' + m.nonce) }));
    } else if (m.type === 'welcome') {
      o.welcomed = m.mac === hmac(token, 'daemon:' + nonce);
      resolveReady(o.welcomed ? 'welcome' : 'bad-welcome');
    } else if (m.type === 'busy' || m.type === 'taken') {
      o.signal = m.mac === hmac(token, m.type + ':' + nonce) ? m.type : 'bad-' + m.type;
    } else if (m.type === 'req') {
      ws.send(JSON.stringify({ type: 'res', id: m.id, ok: true, result: await fq(m.method, m.params) }));
    }
  };
  ws.onclose = (ev) => { resolveReady(ev.code); resolveClosed(ev.code); };
  return o;
}
const within = (p, ms) => Promise.race([p, sleep(ms).then(() => 'pending')]);

// ---------- MCP stdio client ----------
function startMcp(port) {
  const child = spawn(process.execPath, [path.join(ROOT, 'mcp.js')], { env: { ...ENV, FLOW_QUEUE_PORT: String(port) }, stdio: ['pipe', 'pipe', 'pipe'] });
  children.push(child);
  const waiters = new Map();
  const stray = [];
  let buf = '';
  let stderr = '';
  child.stderr.on('data', (d) => (stderr += d));
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      const msg = JSON.parse(line); // stdout must contain only JSON-RPC
      if (msg.id != null && waiters.has(msg.id)) { waiters.get(msg.id)(msg); waiters.delete(msg.id); } else stray.push(msg);
    }
  });
  let nextId = 1;
  return {
    child, stray, stderr: () => stderr,
    request(method, params) {
      const id = nextId++;
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
      return new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('MCP ' + method + ' timed out')), 20000);
        waiters.set(id, (m) => { clearTimeout(t); resolve(m); });
      });
    },
    notify(method, params) { child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n'); },
  };
}

function runCli(port, args) {
  return new Promise((resolve) => {
    execFile(process.execPath, [path.join(ROOT, 'cli.js'), ...args], { env: { ...ENV, FLOW_QUEUE_PORT: String(port) }, windowsHide: true },
      (err, stdout, stderr) => resolve({ code: err ? err.code : 0, stdout, stderr }));
  });
}

// ---------- main ----------
async function main() {
  const port = await freePort();
  console.log('flow-queue-bridge smoke test — port ' + port + ', temp home ' + HOME);

  const daemon = spawn(process.execPath, [path.join(ROOT, 'server.js')], { env: { ...ENV, FLOW_QUEUE_PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(daemon);
  let daemonLog = '';
  daemon.stdout.on('data', (d) => (daemonLog += d));
  daemon.stderr.on('data', (d) => (daemonLog += d));

  // 1. health (no auth)
  const h0 = await until(async () => { try { const r = await req(port); return r.status === 200 && r.json; } catch (e) { return null; } }, 8000, 'daemon health');
  assert.deepStrictEqual({ ok: h0.ok, ext: h0.extensionConnected }, { ok: true, ext: false });
  assert.ok(h0.version);
  ok('GET /api/health → ok, extensionConnected:false, version ' + h0.version);

  const tokenFile = path.join(HOME, '.flow-queue', 'token');
  const token = fs.readFileSync(tokenFile, 'utf8').trim();
  assert.match(token, /^[0-9a-f]{64}$/);
  ok('token created in temp home (' + tokenFile + ')');
  const auth = { Authorization: 'Bearer ' + token };

  // 2. auth / origin / host guards
  let r = await req(port, { method: 'POST', path: '/api/call', body: { method: 'status' } });
  assert.strictEqual(r.status, 401); ok('POST /api/call without token → 401');
  r = await req(port, { method: 'POST', path: '/api/call', headers: { Authorization: 'Bearer ' + 'f'.repeat(64) }, body: { method: 'status' } });
  assert.strictEqual(r.status, 401); ok('POST /api/call with wrong token → 401');
  r = await req(port, { method: 'POST', path: '/api/call', headers: { ...auth, Origin: 'https://evil.example' }, body: { method: 'status' } });
  assert.strictEqual(r.status, 403); ok('POST /api/call with Origin header → 403');
  r = await req(port, { headers: { Origin: 'https://evil.example' } });
  assert.strictEqual(r.status, 403); ok('GET /api/health with Origin header → 403');
  r = await req(port, { headers: { Host: 'evil.example:' + port } });
  assert.strictEqual(r.status, 403); ok('GET /api/health with foreign Host → 403 (DNS-rebinding guard)');
  r = await req(port, { headers: { Host: 'localhost:' + port } });
  assert.strictEqual(r.status, 200); ok('Host localhost:<port> accepted');
  r = await req(port, { method: 'POST', path: '/api/call', headers: auth, body: { method: 'status' } });
  assert.strictEqual(r.status, 503); ok('POST /api/call with no extension → 503');

  // 3. WebSocket guards
  const wsResult = (url, origin, onMsg) => new Promise((resolve) => {
    const ws = new WebSocket(url, { headers: origin ? { Origin: origin } : {} });
    let opened = false;
    ws.onopen = () => { opened = true; };
    ws.onmessage = (ev) => onMsg && onMsg(ws, JSON.parse(ev.data));
    ws.onerror = () => {};
    ws.onclose = (ev) => resolve({ opened, code: ev.code });
  });
  let w = await wsResult('ws://127.0.0.1:' + port + '/ext', 'https://evil.example');
  assert.strictEqual(w.opened, false); ok('WS /ext with wrong Origin → upgrade rejected');
  w = await wsResult('ws://localhost:' + port + '/ext', null);
  assert.strictEqual(w.opened, false); ok('WS /ext without Origin → upgrade rejected');
  const wrongToken = crypto.randomBytes(32).toString('hex');
  let sawChallenge = false;
  w = await wsResult('ws://127.0.0.1:' + port + '/ext', ORIGIN, (ws, m) => {
    if (m.type === 'challenge') {
      sawChallenge = /^[0-9a-f]{64}$/.test(m.nonce);
      ws.send(JSON.stringify({ type: 'hello', version: 'x', extensionId: 'x', nonce: crypto.randomBytes(32).toString('hex'), mac: hmac(wrongToken, 'ext:' + m.nonce) }));
    }
  });
  assert.ok(sawChallenge, 'challenge received');
  assert.strictEqual(w.code, 4001);
  ok('WS hello with wrong pairing token → challenge then close 4001');
  r = await req(port);
  assert.strictEqual(r.json.extensionConnected, false); ok('failed handshake does not count as connected');

  // 4. real bridge-client.js as the extension
  const calls = [];
  const fq = async (method, params) => {
    params = JSON.parse(JSON.stringify(params === undefined ? null : params)); // vm realm → main realm
    calls.push({ method, params });
    switch (method) {
      case 'status': return { run: { state: 'idle', tabId: null, message: '' }, settings: { maxConcurrent: 1 }, counts: { total: 1, pending: 0, running: 0, done: 1, failed: 0, unknown: 0, stopped: 0 }, flowTabs: [{ tabId: 7, title: 'Flow', url: 'https://labs.google/fx/tools/flow/project/abc' }], bridge: { connected: true } };
      case 'uploadFile': return { fileId: crypto.createHash('sha256').update(Buffer.from(params.base64, 'base64')).digest('hex').slice(0, 16), name: params.name, mime: params.mime, size: Buffer.from(params.base64, 'base64').length };
      case 'add': return { added: params.prompts.length, ids: params.prompts.map((_, i) => 'id' + i) };
      case 'start': return { tabId: 7 };
      case 'list': return { items: [{ id: 'id0', status: 'done', prompt: 'a cat', results: ['https://example.com/v.mp4'] }], total: 1 };
      case 'boom': throw new Error('boom from extension');
      default: return { echo: method, params };
    }
  };
  const ext = makeExtension({ port, token, fq });
  await until(() => ext.bridge().connected === true, 8000, 'bridge-client to authenticate');
  assert.strictEqual(ext.bridge().lastError, '');
  assert.strictEqual(ext.bridge().port, port);
  assert.ok(ext.alarms.get('bridge') && ext.alarms.get('bridge').periodInMinutes === 0.5);
  ok('bridge-client.js connected + mutual HMAC verified; storage.bridge = ' + JSON.stringify(ext.bridge()));
  r = await req(port);
  assert.strictEqual(r.json.extensionConnected, true); ok('health → extensionConnected:true');

  r = await req(port, { method: 'POST', path: '/api/call', headers: auth, body: { method: 'status', params: {} } });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.json.ok, true);
  assert.strictEqual(r.json.result.counts.done, 1);
  ok('POST /api/call status round trip → ' + JSON.stringify(r.json.result.counts));
  r = await req(port, { method: 'POST', path: '/api/call', headers: auth, body: { method: 'boom' } });
  assert.deepStrictEqual(r.json, { ok: false, error: 'boom from extension' }); ok('extension error propagates as {ok:false,error}');
  r = await req(port, { method: 'POST', path: '/api/call', headers: auth, body: '{not json' });
  assert.strictEqual(r.status, 400); ok('malformed body → 400');

  // 5. CLI
  let c = await runCli(port, ['status', '--json']);
  assert.strictEqual(c.code, 0, c.stderr);
  assert.strictEqual(JSON.parse(c.stdout).flowTabs[0].tabId, 7); ok('flowq status --json');
  c = await runCli(port, ['pair']);
  assert.strictEqual(c.stdout.trim(), token); ok('flowq pair prints the token');
  c = await runCli(port, ['add', 'one prompt', 'two prompt', '--character', 'Hero', '--top', '--json']);
  assert.strictEqual(c.code, 0, c.stderr);
  const cliAdd = calls.filter((x) => x.method === 'add').pop().params;
  assert.deepStrictEqual(cliAdd.prompts, ['one prompt', 'two prompt']);
  assert.deepStrictEqual(cliAdd.refs, [{ type: 'character', name: 'Hero' }]);
  assert.strictEqual(cliAdd.toTop, true);
  assert.match(cliAdd.requestId, /^[0-9a-f-]{36}$/);
  ok('flowq add → add{prompts, refs, toTop, requestId}');

  // 6. MCP stdio session
  const mcp = startMcp(port);
  let m = await mcp.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'smoke', version: '0' } });
  assert.strictEqual(m.result.protocolVersion, '2025-06-18');
  assert.ok(m.result.capabilities.tools);
  mcp.notify('notifications/initialized');
  ok('MCP initialize → ' + m.result.serverInfo.name + ' ' + m.result.serverInfo.version);
  m = await mcp.request('tools/list', {});
  const names = m.result.tools.map((t) => t.name);
  for (const n of ['flow_status', 'flow_add_prompts', 'flow_list_queue', 'flow_get_item', 'flow_start', 'flow_pause', 'flow_stop', 'flow_retry',
    'flow_remove', 'flow_clear', 'flow_settings', 'flow_logs', 'flow_list_assets', 'flow_wait']) assert.ok(names.includes(n), n);
  assert.ok(m.result.tools.every((t) => t.inputSchema && t.inputSchema.type === 'object'));
  ok('MCP tools/list → ' + names.length + ' tools with JSON Schemas');
  m = await mcp.request('tools/call', { name: 'flow_status', arguments: {} });
  assert.strictEqual(m.result.isError, false);
  assert.strictEqual(JSON.parse(m.result.content[0].text).counts.total, 1);
  ok('MCP tools/call flow_status → isError:false, counts.total 1');

  const png = path.join(HOME, 'ref.png');
  fs.writeFileSync(png, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64'));
  const before = calls.length;
  m = await mcp.request('tools/call', { name: 'flow_add_prompts', arguments: { prompts: ['plain', { prompt: 'with image', images: [png], assets: ['Castle'] }], characters: ['Hero'], start: true } });
  assert.strictEqual(m.result.isError, false, m.result.content[0].text);
  const seqd = calls.slice(before).map((x) => x.method);
  assert.deepStrictEqual(seqd, ['uploadFile', 'add', 'start']);
  const mcpAdd = calls.slice(before).find((x) => x.method === 'add').params;
  assert.strictEqual(mcpAdd.files, undefined);
  assert.deepStrictEqual(mcpAdd.refs, [{ type: 'character', name: 'Hero' }]);
  assert.strictEqual(mcpAdd.prompts[0], 'plain');
  assert.deepStrictEqual(mcpAdd.prompts[1].refs.map((x) => x.type), ['asset', 'file']);
  assert.strictEqual(mcpAdd.prompts[1].refs[1].mime, 'image/png');
  assert.match(mcpAdd.requestId, /^[0-9a-f-]{36}$/);
  ok('MCP flow_add_prompts → uploadFile, add{refs incl. file ref, requestId}, start');

  m = await mcp.request('tools/call', { name: 'flow_add_prompts', arguments: { prompts: ['x'], images: ['http://127.0.0.1:' + port + '/api/health'] } });
  assert.strictEqual(m.result.isError, true);
  assert.match(m.result.content[0].text, /blocked/);
  ok('MCP image URL to loopback blocked (SSRF guard): ' + m.result.content[0].text);
  m = await mcp.request('tools/call', { name: 'flow_add_prompts', arguments: { prompts: ['x'], images: ['http://localhost:' + port + '/x.png'] } });
  assert.strictEqual(m.result.isError, true); ok('MCP image URL to localhost blocked');

  const t0 = Date.now();
  m = await mcp.request('tools/call', { name: 'flow_wait', arguments: { timeout_sec: 1800 } });
  const waited = JSON.parse(m.result.content[0].text);
  assert.strictEqual(waited.done, true);
  assert.ok(Date.now() - t0 < 5000);
  ok('MCP flow_wait → done:true with ' + waited.items.length + ' item(s)');
  m = await mcp.request('tools/call', { name: 'nope', arguments: {} });
  assert.strictEqual(m.error.code, -32602); ok('MCP unknown tool → JSON-RPC error -32602');
  m = await mcp.request('ping', {});
  assert.deepStrictEqual(m.result, {}); ok('MCP ping');

  // 7. disable via settings → disconnect → 503 (storage.onChanged path)
  await ext.setSettings({ bridgeEnabled: false });
  await until(async () => (await req(port)).json.extensionConnected === false, 5000, 'disconnect after disabling');
  assert.strictEqual(ext.bridge().connected, false);
  r = await req(port, { method: 'POST', path: '/api/call', headers: auth, body: { method: 'status' } });
  assert.strictEqual(r.status, 503); ok('bridgeEnabled:false → extension disconnects, /api/call → 503');
  m = await mcp.request('tools/call', { name: 'flow_status', arguments: {} });
  assert.strictEqual(m.result.isError, true); ok('MCP flow_status while disconnected → isError:true (' + m.result.content[0].text + ')');
  await ext.setSettings({ bridgeEnabled: true });
  await until(() => ext.bridge().connected === true, 8000, 'reconnect after re-enabling');
  ok('bridgeEnabled:true → reconnects');
  // 7b. several Chrome profiles (DESIGN §8)
  const instA = ext.instance();
  assert.match(instA, /^[0-9a-f-]{36}$/);
  r = await req(port);
  assert.strictEqual(r.json.instance, instA.slice(0, 8));
  ok('instanceId persisted in storage; /api/health instance = ' + r.json.instance);

  const ext2 = makeExtension({ port, token, fq: async () => ({ second: true }) });
  await until(() => ext2.bridge().code === 'busy', 8000, 'second profile to be told busy');
  assert.notStrictEqual(ext2.instance(), instA);
  assert.strictEqual(ext2.bridge().lastError, '另一個 Chrome 設定檔正在使用橋接');
  assert.deepStrictEqual(ext2.sockets.closeCodes, [4002]);
  assert.strictEqual(ext.bridge().connected, true);
  assert.deepStrictEqual(ext.sockets.closeCodes.filter((c) => c !== 1000), []);
  r = await req(port, { method: 'POST', path: '/api/call', headers: auth, body: { method: 'status' } });
  assert.strictEqual(r.json.result.counts.total, 1);
  assert.strictEqual((await req(port)).json.instance, instA.slice(0, 8));
  ok('second profile (other instanceId) → 4002 busy; first stays connected and keeps serving /api/call');

  await sleep(2500);
  assert.strictEqual(ext2.sockets.opened, 1);
  ext2.fireAlarm('bridge');
  await sleep(500);
  assert.strictEqual(ext2.sockets.opened, 1);
  ok('busy profile does not retry on backoff, nor on an alarm < 60 s later');
  ext2.skew(61000);
  ext2.fireAlarm('bridge');
  await until(() => ext2.sockets.opened === 2 && ext2.sockets.closeCodes.length === 2, 5000, 'busy retry on alarm');
  assert.strictEqual(ext2.bridge().code, 'busy');
  assert.strictEqual(ext.bridge().connected, true);
  ok('busy profile retries on the alarm after ≥ 60 s (still busy, first untouched)');

  const tk = await ext2.takeover();
  assert.strictEqual(tk.connected, true, JSON.stringify(tk));
  await until(() => ext.bridge().code === 'taken', 5000, 'first profile to be taken over');
  assert.strictEqual(ext.bridge().lastError, '已被另一個 Chrome 設定檔接管');
  assert.strictEqual(ext.sockets.closeCodes[ext.sockets.closeCodes.length - 1], 4003);
  r = await req(port, { method: 'POST', path: '/api/call', headers: auth, body: { method: 'anything' } });
  assert.deepStrictEqual(r.json.result, { second: true });
  assert.strictEqual((await req(port)).json.instance, ext2.instance().slice(0, 8));
  const openedA = ext.sockets.opened;
  await sleep(2500);
  ext.skew(61000);
  ext.fireAlarm('bridge');
  await sleep(500);
  assert.strictEqual(ext.sockets.opened, openedA);
  assert.strictEqual(ext.bridge().code, 'taken');
  ok('FQBridge.reconnect({takeover:true}) → old profile gets 4003 "taken" and does not auto-reconnect');

  // the taken profile takes the bridge back; then the other one waits as busy and inherits it on disconnect
  assert.strictEqual((await ext.takeover()).connected, true);
  await until(() => ext2.bridge().code === 'taken', 5000, 'ext2 taken');
  await ext2.setSettings({ bridgePort: port, bridgeEnabled: false });
  await ext2.setSettings({ bridgeEnabled: true });               // settings change clears 'taken'
  await until(() => ext2.bridge().code === 'busy', 5000, 'ext2 busy after settings change');
  ok('changing bridge settings clears "taken"; profile then waits as busy');
  await ext.setSettings({ bridgeEnabled: false });
  await until(async () => (await req(port)).json.extensionConnected === false, 5000, 'first profile to disconnect');
  ext2.skew(61000);
  ext2.fireAlarm('bridge');
  await until(() => ext2.bridge().connected === true, 5000, 'busy profile to take over on its alarm');
  ok('busy profile takes over automatically on its alarm once the other profile disconnects');

  // same instanceId (service-worker restart of the same profile) replaces with 4000
  const oldId2 = ext2.instance();
  const raw = rawExt(port, token, { instanceId: oldId2 });
  assert.strictEqual(await within(raw.ready, 5000), 'welcome');
  await until(() => ext2.sockets.closeCodes.includes(4000), 5000, 'ext2 socket replaced with 4000');
  ok('same instanceId → existing socket closed with 4000 (replaced)');
  await until(() => ext2.bridge().code === 'busy', 6000, 'ext2 to come back as busy under a new instanceId');
  assert.notStrictEqual(ext2.instance(), oldId2);
  assert.strictEqual(await within(raw.closed, 2000), 'pending');
  ok('4000 while authenticated → bridge-client takes a new instanceId, reconnects, gets busy (holder kept)');
  raw.ws.close();
  await ext2.setSettings({ bridgeEnabled: false });
  await until(async () => (await req(port)).json.extensionConnected === false, 5000, 'bridge free');

  // cloned profiles sharing one instanceId must not evict each other forever
  const cloneId = crypto.randomUUID();
  const clone1 = makeExtension({ port, token, instanceId: cloneId, fq: async () => ({ clone: 1 }) });
  await until(() => clone1.bridge().connected === true, 5000, 'clone1 connected');
  const clone2 = makeExtension({ port, token, instanceId: cloneId, fq: async () => ({ clone: 2 }) });
  await until(() => clone2.bridge().connected === true, 5000, 'clone2 connected');
  await until(() => clone1.bridge().code === 'busy', 6000, 'clone1 to settle as busy');
  await sleep(3000);
  assert.strictEqual(clone2.bridge().connected, true);
  assert.deepStrictEqual(clone2.sockets.closeCodes, []);
  assert.deepStrictEqual(clone1.sockets.closeCodes, [4000, 4002]);
  assert.notStrictEqual(clone1.instance(), cloneId);
  r = await req(port, { method: 'POST', path: '/api/call', headers: auth, body: { method: 'x' } });
  assert.deepStrictEqual(r.json.result, { clone: 2 });
  ok('cloned profiles (same instanceId): one 4000, the evicted clone re-ids and stays busy — no flip-flop');
  await clone1.setSettings({ bridgeEnabled: false });
  await clone2.setSettings({ bridgeEnabled: false });

  // stale existing socket is replaced (second daemon with a short stale threshold)
  const port3 = await freePort();
  const d3 = spawn(process.execPath, [path.join(ROOT, 'server.js')], { env: { ...ENV, FLOW_QUEUE_PORT: String(port3), FLOW_QUEUE_STALE_MS: '800' }, stdio: 'ignore' });
  children.push(d3);
  await until(async () => { try { return (await req(port3)).status === 200; } catch (e) { return false; } }, 8000, 'stale-test daemon');
  const holder = rawExt(port3, token, { instanceId: 'profile-holder' });
  assert.strictEqual(await within(holder.ready, 5000), 'welcome');
  const fresh = rawExt(port3, token, { instanceId: 'profile-fresh' });
  assert.strictEqual(await within(fresh.ready, 5000), 4002);
  assert.strictEqual(fresh.signal, 'busy');
  ok('(stale-test daemon) live holder → newcomer gets signed {type:"busy"} frame + 4002');
  await sleep(1200);                                            // holder silent > FLOW_QUEUE_STALE_MS
  const late = rawExt(port3, token, { instanceId: 'profile-late' });
  assert.strictEqual(await within(late.ready, 5000), 'welcome');
  assert.strictEqual(await within(holder.closed, 3000), 4000);
  assert.strictEqual((await req(port3)).json.instance, 'profile-');
  r = await req(port3, { method: 'POST', path: '/api/call', headers: auth, body: { method: 'x' } });
  assert.deepStrictEqual(r.json.result, { raw: true });
  ok('stale existing socket (silent > threshold) → replaced with 4000; newcomer serves /api/call');
  late.ws.close();

  // 8. the extension must reject a daemon whose welcome mac is wrong
  const fakePort = await freePort();
  let helloOk = false, reqAnswered = false;
  const fake = await startFakeDaemon(fakePort, (conn, msg) => {
    if (msg.type === 'hello') {
      helloOk = msg.mac === hmac(token, 'ext:' + conn.nonce) && /^[0-9a-f]{64}$/.test(msg.nonce);
      conn.send({ type: 'welcome', mac: hmac(wrongToken, 'daemon:' + msg.nonce) });
      conn.send({ type: 'req', id: '1', method: 'status', params: {} });
    } else if (msg.type === 'res') reqAnswered = true;
  });
  fake.server.on('upgrade', () => setImmediate(() => { const c = fake.conns[fake.conns.length - 1]; c.nonce = crypto.randomBytes(32).toString('hex'); c.send({ type: 'challenge', nonce: c.nonce }); }));
  const fqCalls = [];
  const ext3 = makeExtension({ port: fakePort, token, fq: async (mth) => { fqCalls.push(mth); return {}; } });
  await until(() => ext3.bridge().lastError === '橋接程式驗證失敗（配對碼不符）', 8000, 'extension to reject bad welcome');
  await until(() => fake.conns[0] && fake.conns[0].closed, 3000, 'extension to close the socket');
  await sleep(300);
  assert.ok(helloOk, 'extension hello mac is HMAC(token, "ext:"+nonce)');
  assert.strictEqual(ext3.bridge().connected, false);
  assert.strictEqual(reqAnswered, false);
  assert.deepStrictEqual(fqCalls, []);
  ok('extension rejects daemon with wrong welcome mac (closed ' + fake.conns[0].closed.code + ', lastError set, req ignored)');
  await ext3.setSettings({ bridgeEnabled: false });
  fake.server.close();

  // 8b. a takeover attempt while the daemon is down must not leave takeover:true for later automatic retries
  const tkPort = await freePort();
  const ext6 = makeExtension({ port: tkPort, token, fq: async () => ({}) });
  await until(() => ext6.bridge().code === 'offline', 5000, 'ext6 offline (no daemon)');
  const st6 = await ext6.takeover();
  assert.strictEqual(st6.connected, false);
  const hellos = [];
  const fake2 = await startFakeDaemon(tkPort, (conn, msg) => { if (msg.type === 'hello') hellos.push(msg); });
  fake2.server.on('upgrade', () => setImmediate(() => { const c2 = fake2.conns[fake2.conns.length - 1]; c2.send({ type: 'challenge', nonce: crypto.randomBytes(32).toString('hex') }); }));
  await until(() => hellos.length >= 1, 8000, 'automatic retry hello');
  assert.strictEqual(hellos[0].takeover, false);
  ok('takeover attempt while daemon down → later automatic retry sends takeover:false');
  // explicit takeover sends takeover:true exactly once
  hellos.length = 0;
  ext6.takeover();
  await until(() => hellos.length >= 1, 5000, 'takeover hello');
  assert.strictEqual(hellos[0].takeover, true);
  ok('FQBridge.reconnect({takeover:true}) sends takeover:true in its hello');
  await ext6.setSettings({ bridgeEnabled: false });
  fake2.server.close();

  // 8c. unsigned 4002 / 4003 are not trusted: treated as offline with normal backoff
  const usPort = await freePort();
  let usN = 0;
  const fake3 = await startFakeDaemon(usPort, (conn, msg) => {
    if (msg.type !== 'hello') return;
    usN++;
    if (usN === 1) conn.closeWith(4002);                                   // unsigned busy
    else if (usN === 2) {                                                  // authenticated, then unsigned 4003
      conn.send({ type: 'welcome', mac: hmac(token, 'daemon:' + msg.nonce) });
      setTimeout(() => conn.closeWith(4003), 200);
    } else if (usN === 3) {                                                // forged busy frame (wrong key)
      conn.send({ type: 'busy', mac: hmac(wrongToken, 'busy:' + msg.nonce) });
      conn.closeWith(4002);
    }
  });
  fake3.server.on('upgrade', () => setImmediate(() => { const c3 = fake3.conns[fake3.conns.length - 1]; c3.nonce = crypto.randomBytes(32).toString('hex'); c3.send({ type: 'challenge', nonce: c3.nonce }); }));
  const ext7 = makeExtension({ port: usPort, token, fq: async () => ({}) });
  await until(() => usN >= 4, 15000, 'retries after unsigned/forged closes');
  assert.deepStrictEqual(ext7.sockets.closeCodes.slice(0, 3), [4002, 4003, 4002]);
  assert.notStrictEqual(ext7.bridge().code, 'busy');
  assert.notStrictEqual(ext7.bridge().code, 'taken');
  ok('unsigned/forged 4002 and unsigned 4003 → treated as offline, keeps retrying with backoff');
  await ext7.setSettings({ bridgeEnabled: false });
  fake3.server.close();

  // 9. bridge-client without token does not connect
  const ext4 = makeExtension({ port, token: '', fq: async () => ({}) });
  await until(() => ext4.bridge().lastError, 3000, 'no-token status');
  assert.strictEqual(ext4.bridge().connected, false);
  ok('bridge-client with empty token stays offline: ' + ext4.bridge().lastError);
  await ext4.setSettings({ bridgeEnabled: false });

  // 9b. a service-worker restart keeps the 'taken' state (no automatic reconnect)
  const ext5 = makeExtension({ port, token, fq: async () => ({}), extra: { bridge: { connected: false, code: 'taken', lastError: '已被另一個 Chrome 設定檔接管', at: Date.now(), port } } });
  await sleep(1500);
  ext5.fireAlarm('bridge');
  await sleep(300);
  assert.strictEqual(ext5.sockets.opened, 0);
  assert.strictEqual(ext5.bridge().code, 'taken');
  ok('after a service-worker restart a "taken" profile stays offline');
  ext5.fireStartup();                                    // browser restart
  await until(() => ext5.bridge().connected === true, 5000, 'taken state cleared on runtime.onStartup');
  ok('chrome.runtime.onStartup clears a stored "taken" state and reconnects');
  await ext5.setSettings({ bridgeEnabled: false });

  // 10. ensureDaemon spawns a detached daemon when none answers
  process.env.HOME = HOME; process.env.USERPROFILE = HOME;
  const lib = require(path.join(ROOT, 'lib.js'));
  const port2 = await freePort();
  const h2 = await lib.ensureDaemon({ port: port2 });
  extraPids.push(h2.pid);
  assert.strictEqual(h2.ok, true);
  assert.strictEqual(h2.spawned, true);
  ok('lib.ensureDaemon spawned a detached daemon on port ' + port2 + ' (pid ' + h2.pid + ')');

  console.log('\nall ' + passed + ' checks passed');
  if (process.env.SMOKE_VERBOSE) console.log('\n--- daemon log ---\n' + daemonLog + '\n--- mcp stderr ---\n' + mcp.stderr());
}

function cleanup() {
  for (const ch of children) { try { ch.kill(); } catch (e) { /* */ } }
  for (const pid of extraPids) { try { process.kill(pid); } catch (e) { /* */ } }
  setTimeout(() => { try { fs.rmSync(HOME, { recursive: true, force: true }); } catch (e) { /* */ } }, 300);
}

main().then(() => { cleanup(); setTimeout(() => process.exit(0), 600); }, (e) => {
  console.error('\nFAILED: ' + (e && e.stack || e));
  cleanup();
  setTimeout(() => process.exit(1), 600);
});
