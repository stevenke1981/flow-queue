'use strict';
// Shared helpers for the Flow Queue bridge: paths, token, HTTP client, daemon launcher, image loading.
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { spawn } = require('child_process');

const VERSION = require('./package.json').version;
const DEFAULT_PORT = 17345;
const EXT_ORIGIN_DEFAULT = 'chrome-extension://ofbmccbjodncofoookgajjnodeamnada';
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;   // DESIGN §7
const MAX_BODY_BYTES = 32 * 1024 * 1024;    // DESIGN §7: HTTP body and WS frame cap
const TOKEN_RE = /^[0-9a-f]{64}$/i;

// ---------- stable error codes (DESIGN §10) ----------
const ERROR_CODES = [
  // bridge-side
  'daemon_unreachable', 'extension_not_connected', 'timeout', 'busy', 'extension_error',
  // thrown by the extension (err.code), passed through unchanged
  'no_flow_tab', 'multiple_flow_tabs', 'not_found', 'invalid_argument', 'confirm_required', 'unknown_requires_confirm',
];

class FQError extends Error {
  constructor(code, message, extra) {
    super(message);
    this.code = typeof code === 'string' && /^[a-z][a-z0-9_]{0,39}$/.test(code) ? code : 'extension_error';
    if (extra) Object.assign(this, extra);
  }
}
const usageError = (message) => new FQError('invalid_argument', message, { usage: true });

// Maps an error message coming from the extension to a stable code (explicit e.code from the extension wins).
function classifyExtensionError(message, code) {
  if (typeof code === 'string' && /^[a-z][a-z0-9_]{0,39}$/.test(code)) return code; // extension-supplied code wins
  const m = String(message || '');
  if (/no flow tab|flow tab|flow 分頁|開啟 ?(google )?flow|\/project\//i.test(m)) return 'no_flow_tab';
  if (/not found|no such|找不到|不存在/i.test(m)) return 'not_found';
  if (/timed? ?out|逾時/i.test(m)) return 'timeout';
  if (/busy|already running|執行中|忙碌|冷卻|cooldown/i.test(m)) return 'busy';
  if (/invalid|must be|required|缺少|無效|不合法/i.test(m)) return 'invalid_argument';
  return 'extension_error';
}

// Normalizes any thrown value into {code, error}.
function toErrorInfo(e) {
  if (e instanceof FQError) return { code: e.code, error: e.message };
  if (e && typeof e.code === 'string' && /^[a-z][a-z0-9_]{0,39}$/.test(e.code) && !/^E[A-Z]/.test(e.code)) return { code: e.code, error: String(e.message || e) };
  return { code: 'extension_error', error: String((e && e.message) || e) };
}

function hmacHex(token, text) {
  return crypto.createHmac('sha256', Buffer.from(String(token), 'utf8')).update(String(text), 'utf8').digest('hex');
}

function getPort() {
  const p = parseInt(process.env.FLOW_QUEUE_PORT || '', 10);
  return p > 0 && p < 65536 ? p : DEFAULT_PORT;
}

function getExtOrigin() {
  return process.env.FLOW_QUEUE_EXT_ORIGIN || EXT_ORIGIN_DEFAULT;
}

function configDir() {
  return path.join(os.homedir(), '.flow-queue');
}

function tokenPath() {
  return path.join(configDir(), 'token');
}

function logPath() {
  return path.join(configDir(), 'daemon.log');
}

function readToken() {
  try {
    const t = fs.readFileSync(tokenPath(), 'utf8').trim();
    return TOKEN_RE.test(t) ? t.toLowerCase() : '';
  } catch (e) {
    return '';
  }
}

// Returns the token, creating ~/.flow-queue/token (mode 600) when it is missing or malformed.
function ensureToken() {
  const existing = readToken();
  if (existing) return existing;
  fs.mkdirSync(configDir(), { recursive: true, mode: 0o700 });
  const token = crypto.randomBytes(32).toString('hex');
  const file = tokenPath();
  try {
    fs.writeFileSync(file, token + '\n', { mode: 0o600, flag: 'wx' });
  } catch (e) {
    if (e.code !== 'EEXIST') throw e;
    const raced = readToken();
    if (raced) return raced; // another process created it first
    fs.writeFileSync(file, token + '\n', { mode: 0o600 });
  }
  try { fs.chmodSync(file, 0o600); } catch (e) { /* not supported on this FS */ }
  return token;
}

function request({ port, method, urlPath, headers, body, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const data = body == null ? null : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
    const req = http.request({
      host: '127.0.0.1',
      port,
      method,
      path: urlPath,
      headers: {
        Host: '127.0.0.1:' + port,
        ...(data ? { 'Content-Type': 'application/json', 'Content-Length': data.length } : {}),
        ...(headers || {}),
      },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch (e) { /* non-JSON */ }
        resolve({ status: res.statusCode, json, text });
      });
      res.on('error', reject);
    });
    req.on('error', reject);
    if (timeoutMs) {
      req.setTimeout(timeoutMs, () => req.destroy(Object.assign(new Error('request timed out'), { code: 'ETIMEDOUT' })));
    }
    if (data) req.write(data);
    req.end();
  });
}

async function health(port = getPort(), timeoutMs = 1500) {
  try {
    const r = await request({ port, method: 'GET', urlPath: '/api/health', timeoutMs });
    return r.status === 200 && r.json && r.json.ok ? r.json : null;
  } catch (e) {
    return null;
  }
}

// Calls a background method through the daemon. Resolves with the result, throws Error on failure.
async function httpCall(method, params, opts = {}) {
  const port = opts.port || getPort();
  const token = readToken() || ensureToken();
  const timeoutMs = opts.timeoutMs || (method === 'listAssets' ? 75000 : method === 'download' ? 100000 : 45000);
  let r;
  try {
    r = await request({
      port,
      method: 'POST',
      urlPath: '/api/call',
      headers: { Authorization: 'Bearer ' + token },
      body: { method, params: params || {} },
      timeoutMs,
    });
  } catch (e) {
    if (e.code === 'ETIMEDOUT') throw new FQError('timeout', 'no answer from the bridge daemon within ' + Math.round(timeoutMs / 1000) + ' s (' + method + ')');
    throw new FQError('daemon_unreachable', 'Flow Queue bridge daemon is not reachable on 127.0.0.1:' + port + ' (' + (e.code || e.message) + ')');
  }
  const j = r.json;
  if (j && j.ok) return j.result;
  const msg = String((j && j.error) || r.text || ('HTTP ' + r.status));
  let code;
  if (r.status === 503) code = 'extension_not_connected';
  else if (r.status === 504) code = 'timeout';
  else if (r.status === 400 || r.status === 413) code = 'invalid_argument';
  else if (r.status === 401) {
    throw new FQError('daemon_unreachable', 'the daemon rejected ~/.flow-queue/token (the token file changed after the daemon started?) — stop the daemon and run the command again', { status: 401 });
  } else if (r.status !== 200) code = 'daemon_unreachable';
  else code = classifyExtensionError(msg, j && j.code);
  throw new FQError(code, msg, { status: r.status });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Starts server.js detached (no console window) when /api/health does not answer, then waits for it.
async function ensureDaemon(opts = {}) {
  const port = opts.port || getPort();
  const h = await health(port);
  if (h) return h;
  ensureToken();
  let out = 'ignore';
  try {
    fs.mkdirSync(configDir(), { recursive: true, mode: 0o700 });
    out = fs.openSync(logPath(), 'a');
  } catch (e) { /* fall back to ignore */ }
  const child = spawn(process.execPath, [path.join(__dirname, 'server.js')], {
    detached: true,
    windowsHide: true,
    stdio: ['ignore', out, out],
    env: { ...process.env, FLOW_QUEUE_PORT: String(port) },
  });
  let exited = null;
  child.on('exit', (code) => { exited = code; });
  child.on('error', (e) => { exited = e.message; });
  child.unref();
  if (typeof out === 'number') { try { fs.closeSync(out); } catch (e) { /* ignore */ } }
  const deadline = Date.now() + (opts.waitMs || 8000);
  while (Date.now() < deadline) {
    await sleep(200);
    const ok = await health(port, 1000);
    if (ok) return { ...ok, spawned: true, pid: child.pid };
    if (exited !== null) {
      // The child may have lost a race with another daemon that is now up.
      const again = await health(port, 1000);
      if (again) return again;
      throw new FQError('daemon_unreachable', 'Flow Queue daemon exited (' + exited + '); see ' + logPath());
    }
  }
  throw new FQError('daemon_unreachable', 'Flow Queue daemon did not answer on 127.0.0.1:' + port + '; see ' + logPath());
}

// ---------- images ----------
const EXT_MIME = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif',
  '.bmp': 'image/bmp', '.avif': 'image/avif', '.heic': 'image/heic', '.heif': 'image/heif', '.tif': 'image/tiff',
  '.tiff': 'image/tiff', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
};

function sniffMime(buf) {
  if (buf.length >= 8 && buf.readUInt32BE(0) === 0x89504e47) return 'image/png';
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length >= 6 && buf.toString('ascii', 0, 4) === 'GIF8') return 'image/gif';
  if (buf.length >= 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  if (buf.length >= 2 && buf[0] === 0x42 && buf[1] === 0x4d) return 'image/bmp';
  if (buf.length >= 12 && buf.toString('ascii', 4, 8) === 'ftyp') {
    const brand = buf.toString('ascii', 8, 12);
    if (brand === 'avif' || brand === 'avis') return 'image/avif';
    if (/^(heic|heix|mif1|msf1)$/.test(brand)) return 'image/heic';
  }
  return '';
}

// ---------- SSRF guard for URL images ----------
const net = require('net');
const dns = require('dns');

function ipv4ToInt(ip) {
  return ip.split('.').reduce((a, o) => a * 256 + Number(o), 0);
}
const V4_BLOCKS = [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24],
  ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
].map(([a, bits]) => [ipv4ToInt(a), bits]);

// true for loopback, private, link-local, CGNAT, multicast, reserved and unspecified addresses
function isPrivateIp(ip) {
  ip = String(ip).replace(/^\[|\]$/g, '').split('%')[0];
  if (net.isIPv4(ip)) {
    const n = ipv4ToInt(ip);
    return V4_BLOCKS.some(([base, bits]) => Math.floor(n / 2 ** (32 - bits)) === Math.floor(base / 2 ** (32 - bits)));
  }
  if (!net.isIPv6(ip)) return true;
  const low = ip.toLowerCase();
  const mapped = /^(?:0*:)*:?ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(low) || /^::(\d+\.\d+\.\d+\.\d+)$/.exec(low);
  if (mapped) return isPrivateIp(mapped[1]);
  const hexMapped = /^(?:0*:)*:?ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(low);
  if (hexMapped) {
    const hi = parseInt(hexMapped[1], 16), lo = parseInt(hexMapped[2], 16);
    return isPrivateIp([hi >> 8, hi & 255, lo >> 8, lo & 255].join('.'));
  }
  // expand to the first hextet
  const first = low.startsWith('::') ? 0 : parseInt(low.split(':')[0] || '0', 16);
  if (low === '::' || low === '::1' || /^(0+:){7}0*1?$/.test(low)) return true;
  if ((first & 0xfe00) === 0xfc00) return true;   // fc00::/7 unique local
  if ((first & 0xffc0) === 0xfe80) return true;   // fe80::/10 link-local
  if ((first & 0xffc0) === 0xfec0) return true;   // fec0::/10 site-local (deprecated)
  if ((first & 0xff00) === 0xff00) return true;   // multicast
  if (low.startsWith('64:ff9b:')) return true;    // NAT64 can reach IPv4 private space
  if (low.startsWith('2001:db8:')) return true;   // documentation
  return false;
}

// dns lookup that refuses private addresses; used at connect time so DNS rebinding cannot slip through
function safeLookup(hostname, options, cb) {
  if (typeof options === 'function') { cb = options; options = {}; }
  dns.lookup(hostname, { all: true, family: options.family || 0 }, (err, addrs) => {
    if (err) return cb(err);
    const bad = addrs.find((a) => isPrivateIp(a.address));
    if (bad || !addrs.length) {
      const e = new Error('blocked private/loopback address for ' + hostname + (bad ? ' (' + bad.address + ')' : ''));
      e.code = 'EBLOCKED';
      return cb(e);
    }
    if (options.all) return cb(null, addrs);
    cb(null, addrs[0].address, addrs[0].family);
  });
}

function fetchPublic(urlStr, hops = 0) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(urlStr); } catch (e) { return reject(new FQError('invalid_argument', 'bad image URL: ' + urlStr)); }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return reject(new FQError('invalid_argument', 'only http(s) image URLs are allowed: ' + urlStr));
    const host = u.hostname.replace(/^\[|\]$/g, '');
    if (net.isIP(host) && isPrivateIp(host)) return reject(new FQError('invalid_argument', 'blocked private/loopback address: ' + host));
    if (/^localhost$|\.localhost$/i.test(host)) return reject(new FQError('invalid_argument', 'blocked private/loopback address: ' + host));
    const mod = u.protocol === 'https:' ? require('https') : http;
    const req = mod.get(u, { lookup: safeLookup, headers: { 'User-Agent': 'flow-queue-bridge', Accept: 'image/*' }, timeout: 30000 }, (res) => {
      const status = res.statusCode || 0;
      if (status >= 300 && status < 400 && res.headers.location) {
        res.resume();
        if (hops >= 5) return reject(new FQError('invalid_argument', 'too many redirects: ' + urlStr));
        let next;
        try { next = new URL(res.headers.location, u).toString(); } catch (e) { return reject(new FQError('invalid_argument', 'bad redirect from ' + urlStr)); }
        return fetchPublic(next, hops + 1).then(resolve, reject);
      }
      if (status !== 200) { res.resume(); return reject(new FQError('invalid_argument', 'image download failed (HTTP ' + status + '): ' + urlStr)); }
      if (Number(res.headers['content-length'] || 0) > MAX_IMAGE_BYTES) { res.destroy(); return reject(new FQError('invalid_argument', 'image larger than 10 MB: ' + urlStr)); }
      const chunks = [];
      let size = 0;
      res.on('data', (c) => {
        size += c.length;
        if (size > MAX_IMAGE_BYTES) { res.destroy(); reject(new FQError('invalid_argument', 'image larger than 10 MB: ' + urlStr)); return; }
        chunks.push(c);
      });
      res.on('end', () => resolve({ buf: Buffer.concat(chunks), mime: String(res.headers['content-type'] || '').split(';')[0].trim().toLowerCase(), url: u }));
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error('image download timed out: ' + urlStr)));
    req.on('error', reject);
  });
}

// Loads a local path, file:// URL or http(s) URL → {name, mime, base64}. Enforces image/* and ≤ 10 MB.
async function loadImage(src) {
  src = String(src || '').trim();
  if (!src) throw new FQError('invalid_argument', 'empty image path');
  let buf, name, mime = '';
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(src) && !/^file:\/\//i.test(src)) {
    const r = await fetchPublic(src).catch((e) => { throw e instanceof FQError ? e : new FQError('invalid_argument', 'image download failed: ' + src + ' (' + (e.message || e.code) + ')'); });
    buf = r.buf;
    let p = '';
    try { p = decodeURIComponent(r.url.pathname); } catch (e) { /* ignore */ }
    name = path.posix.basename(p) || 'image';
    mime = sniffMime(buf) || (r.mime.startsWith('image/') ? r.mime : '') || EXT_MIME[path.extname(name).toLowerCase()] || r.mime;
    if (!path.extname(name) && mime.startsWith('image/')) name += '.' + mime.split('/')[1].replace('jpeg', 'jpg').replace(/\+.*/, '');
  } else {
    let file = src;
    if (/^file:\/\//i.test(file)) file = require('url').fileURLToPath(file);
    if (file === '~' || file.startsWith('~/') || file.startsWith('~\\')) file = path.join(os.homedir(), file.slice(1));
    file = path.resolve(file);
    const st = await fs.promises.stat(file).catch(() => null);
    if (!st || !st.isFile()) throw new FQError('invalid_argument', 'image file not found: ' + src);
    if (st.size > MAX_IMAGE_BYTES) throw new FQError('invalid_argument', 'image larger than 10 MB: ' + src);
    buf = await fs.promises.readFile(file);
    name = path.basename(file);
    mime = sniffMime(buf) || EXT_MIME[path.extname(file).toLowerCase()] || '';
  }
  if (buf.length > MAX_IMAGE_BYTES) throw new FQError('invalid_argument', 'image larger than 10 MB: ' + src);
  if (!mime.startsWith('image/')) throw new FQError('invalid_argument', 'not an image (' + (mime || 'unknown type') + '): ' + src);
  // 與擴充功能相同：只接受實際內容可辨識的格式
  const real = sniffMime(buf);
  if (!real || real === 'image/bmp') throw new FQError('invalid_argument', 'unsupported image format (use png / jpg / webp / gif / avif / heic): ' + src);
  return { name, mime: real, base64: buf.toString('base64') };
}

// ---------- shared high-level operations (MCP + CLI) ----------
const asList = (v) => (v == null ? [] : (Array.isArray(v) ? v : [v])).map((x) => String(x).trim()).filter(Boolean);

// spec: {prompts: (string|{prompt, images?, characters?, assets?})[], images?, characters?, assets?, toTop?}
// → params for the background "add" method (DESIGN §7): every image is sent with its own uploadFile call, one at a
// time, and referenced by fileId; add itself carries only refs plus a fresh requestId for dedupe.
async function buildAddParams(spec, call) {
  const prompts = Array.isArray(spec.prompts) ? spec.prompts : asList(spec.prompts);
  if (!prompts.length) throw new FQError('invalid_argument', 'prompts is empty');
  for (const p of prompts) {
    if (typeof p === 'string') continue;
    if (!p || typeof p !== 'object' || !String(p.prompt || '').trim()) throw new FQError('invalid_argument', 'each prompt needs a non-empty "prompt"');
  }
  const uploaded = new Map(); // src -> ref
  const fileRef = async (src) => {
    if (!uploaded.has(src)) {
      const img = await loadImage(src);
      const r = await call('uploadFile', img);
      if (!r || !r.fileId) throw new FQError('extension_error', 'uploadFile returned no fileId for ' + src);
      uploaded.set(src, { type: 'file', fileId: r.fileId, name: r.name || img.name, mime: r.mime || img.mime });
    }
    return uploaded.get(src);
  };
  const named = (chars, assets) => [
    ...asList(chars).map((name) => ({ type: 'character', name })),
    ...asList(assets).map((name) => ({ type: 'asset', name })),
  ];
  const refs = named(spec.characters, spec.assets);
  for (const src of asList(spec.images)) refs.push(await fileRef(src));
  const items = [];
  for (const p of prompts) {
    if (typeof p === 'string') { if (p.trim()) items.push(p.trim()); continue; }
    const itemRefs = named(p.characters, p.assets);
    for (const src of asList(p.images)) itemRefs.push(await fileRef(src));
    items.push(itemRefs.length ? { prompt: String(p.prompt).trim(), refs: itemRefs } : String(p.prompt).trim());
  }
  if (!items.length) throw new FQError('invalid_argument', 'prompts is empty');
  const params = { prompts: items, requestId: spec.requestId ? String(spec.requestId).slice(0, 100) : crypto.randomUUID() };
  if (refs.length) params.refs = refs;
  if (spec.toTop) params.toTop = true;
  if (spec.confirm === true) params.confirm = true;
  return params;
}

const ACTIVE = new Set(['pending', 'running']);

function summarizeItem(it) {
  if (!it) return it;
  const o = { id: it.id, status: it.status, prompt: it.prompt };
  if (it.error) o.error = it.error;
  if (it.results && it.results.length) o.results = it.results;
  if (it.refs && it.refs.length) o.refs = it.refs.map((r) => (r.type === 'file' ? 'file:' + r.name : r.type + ':' + r.name));
  if (it.finishedAt) o.finishedAt = new Date(it.finishedAt).toISOString();
  return o;
}

// Fetches the given ids with as few 'list' calls as possible → Map(id → item).
async function fetchItems(call, ids) {
  const want = new Set(ids);
  const found = new Map();
  for (let offset = 0; ; offset += 1000) {
    const r = await call('list', { limit: 1000, offset });
    for (const it of (r && r.items) || []) if (want.has(it.id)) found.set(it.id, it);
    if (found.size === want.size || !r || !r.items || !r.items.length || offset + r.items.length >= (r.total || 0)) break;
  }
  return found;
}

const STALL_HINT = {
  paused: 'the queue is paused: ask the user, then flow_start to resume',
  idle_not_started: 'the queue is not running: call flow_start (ask the user which tab if there are several)',
  cooldown: 'Flow rate-limited the queue; it resumes by itself after the cooldown: call flow_wait again later',
  stopped: 'some of these items were stopped: flow_retry them (ids) if the user wants, then flow_start',
};

// Waits for the given ids (or, with wholeQueue, for the whole queue) to finish. Polls every intervalMs.
// Returns {done, timedOut, stalled?, next?, run, counts, items}. stalled ∈ 'paused' | 'idle_not_started' | 'cooldown' | 'stopped':
// paused / idle_not_started / stopped return immediately (nothing progresses on its own); cooldown keeps waiting.
async function waitForQueue(call, { timeoutSec = 1800, ids = null, wholeQueue = false, intervalMs = 5000, onTick } = {}) {
  const wanted = [...new Set(asList(ids))];
  if (!wholeQueue && !wanted.length) throw new FQError('invalid_argument', 'ids is required (the ids returned by flow_add_prompts); pass whole_queue: true to wait for the entire queue');
  const deadline = Date.now() + Math.max(0, Number(timeoutSec) || 0) * 1000;
  for (;;) {
    const status = await call('status', {});
    const run = (status && status.run) || {};
    let counts, items = [], active, stoppedLeft = false;
    if (wanted.length) {
      const found = await fetchItems(call, wanted);
      if (!found.size) throw new FQError('not_found', 'none of the given ids exist in the queue: ' + wanted.slice(0, 5).join(', '));
      counts = { total: wanted.length, pending: 0, running: 0, done: 0, failed: 0, unknown: 0, stopped: 0, missing: 0 };
      for (const id of wanted) {
        const it = found.get(id);
        if (!it) { counts.missing++; items.push({ id, status: 'missing' }); continue; }
        if (it.status in counts) counts[it.status]++;
        items.push(it);
      }
      active = counts.pending + counts.running;
      stoppedLeft = counts.stopped > 0;
    } else {
      counts = (status && status.counts) || {};
      active = (counts.pending || 0) + (counts.running || 0);
    }
    const cooling = Number(run.cooldownUntil || 0) > Date.now();
    let stalled = '';
    if (active) {
      if (run.state === 'paused') stalled = 'paused';
      else if (run.state === 'idle' || !run.state) stalled = 'idle_not_started';
      else if (cooling) stalled = 'cooldown';
    } else if (stoppedLeft) stalled = 'stopped';
    const done = !active && !stoppedLeft;
    if (onTick) { try { onTick({ items, status, counts }); } catch (e) { /* ignore */ } }
    const outOfTime = !done && Date.now() >= deadline;
    if (done || outOfTime || (stalled && stalled !== 'cooldown')) {
      if (!wanted.length && done) {
        const r = await call('list', { status: ['done', 'failed', 'unknown', 'stopped'], limit: 200 }).catch(() => null);
        items = r ? r.items : [];
      }
      const out = {
        done,
        timedOut: outOfTime && (!stalled || stalled === 'cooldown'),
        run: { state: run.state, tabId: run.tabId == null ? null : run.tabId, message: run.message || '', cooldownUntil: run.cooldownUntil || 0 },
        counts,
        items: items.map(summarizeItem),
      };
      if (stalled) out.stalled = stalled;
      if (!done) out.next = STALL_HINT[stalled] || 'still running: call flow_wait again with the same ids';
      return out;
    }
    await sleep(Math.min(intervalMs, Math.max(50, deadline - Date.now())));
  }
}

// ---------- doctor (DESIGN §10) ----------
const FIX = {
  daemon: '在終端機執行 flowq status 啟動橋接程式；若仍失敗，請查看 ~/.flow-queue/daemon.log',
  token: '橋接程式使用的配對碼和 ~/.flow-queue/token 不一致：請結束 node server.js 程序後重新執行 flowq status',
  extension: '開啟 Chrome 的 Flow Queue 側邊面板 →「設定」→「AI 代理橋接」：勾選「允許 AI 代理控制」，並在「配對碼」貼上配對碼（在終端機執行 flowq pair --copy 複製）',
  busyProfile: '若側邊面板顯示「另一個 Chrome 設定檔正在使用橋接」，請在要使用的設定檔按「改用這個設定檔」',
  flowTab: '在 Chrome 開啟 Google Flow（https://labs.google/fx/tools/flow）並進入一個專案（網址含 /project/）',
  cooldown: 'Flow 回報限流或異常活動，佇列暫停冷卻中；冷卻結束後會自動繼續，請稍候',
  failed: '有失敗的項目，可用 flow_retry（flowq retry）重試；「未確認」項目可能已經扣點，請先到 Flow 確認再決定是否重試',
  reload: '請到 chrome://extensions 重新載入 Flow Queue 擴充功能後再試一次',
};
FIX.extension += '。' + FIX.busyProfile;
const FIX_EN = {
  daemon: 'Run "flowq status" in a terminal to start the bridge daemon; if it still fails, check ~/.flow-queue/daemon.log',
  token: 'The running daemon uses a different token than ~/.flow-queue/token: stop the "node server.js" process and run "flowq status" again',
  extension: 'Open the Flow Queue side panel in Chrome → 設定 → AI 代理橋接: tick 「允許 AI 代理控制」 and paste the pairing code (copy it with "flowq pair --copy") into 「配對碼」. If the panel says another Chrome profile is using the bridge, click 「改用這個設定檔」 in the profile you want to use',
  flowTab: 'Open Google Flow (https://labs.google/fx/tools/flow) in Chrome and enter a project (URL contains /project/)',
  cooldown: 'Flow reported rate limiting / unusual activity; the queue is cooling down and resumes automatically — wait',
  failed: 'Some items failed: flow_retry retries them ("unknown" items may already have spent credits — ask the user to check Flow first)',
  reload: 'Reload the Flow Queue extension at chrome://extensions and try again',
};

// Ordered checks daemon → extension → flow_tab → queue. Never throws.
// opts.autoStart (default true) starts the daemon when it is down and says so in the 'daemon' detail.
async function doctor(opts = {}) {
  const port = opts.port || getPort();
  const checks = [];
  const add = (name, ok, detail, key, code) => {
    const c = { name, ok: !!ok, detail, fix: key ? FIX[key] : '', fix_en: key ? FIX_EN[key] : '' };
    if (!ok) c.code = code || 'extension_error';
    checks.push(c);
  };
  const skip = (name, why, code) => { checks.push({ name, ok: false, code, detail: 'skipped: ' + why, fix: '', fix_en: '', skipped: true }); };

  // 1. daemon
  let h = await health(port);
  let status = null;
  if (!h && opts.autoStart !== false) {
    try {
      const started = await ensureDaemon({ port });
      h = started;
      add('daemon', true, 'daemon was not running; started it now on 127.0.0.1:' + port + (started.pid ? ' (pid ' + started.pid + ')' : '') + ', v' + started.version);
    } catch (e) {
      add('daemon', false, 'daemon not reachable on 127.0.0.1:' + port + ' and auto-start failed: ' + e.message, 'daemon', 'daemon_unreachable');
    }
  } else if (!h) {
    add('daemon', false, 'daemon not reachable on 127.0.0.1:' + port + ' (auto-start disabled)', 'daemon', 'daemon_unreachable');
  }
  let tokenOk = true;
  if (h) {
    // authenticated probe: 401 = token mismatch, 503 = extension down, 200 = status
    try {
      status = await httpCall('status', {}, { port, timeoutMs: 15000 });
    } catch (e) {
      if (e.status === 401) tokenOk = false;
    }
    if (!checks.length) add('daemon', tokenOk, tokenOk ? 'daemon v' + h.version + ' on 127.0.0.1:' + port : 'daemon v' + h.version + ' on 127.0.0.1:' + port + ' rejects ~/.flow-queue/token', tokenOk ? '' : 'token', 'daemon_unreachable');
    else if (!tokenOk) Object.assign(checks[0], { ok: false, code: 'daemon_unreachable', detail: checks[0].detail + '; but it rejects ~/.flow-queue/token', fix: FIX.token, fix_en: FIX_EN.token });
  }

  // 2. extension
  if (!h || !tokenOk) skip('extension', h ? 'daemon rejects the token' : 'daemon not reachable', 'daemon_unreachable');
  else if (!h.extensionConnected) add('extension', false, 'no Chrome profile is connected to the bridge', 'extension', 'extension_not_connected');
  else if (!status) add('extension', false, 'extension connected (instance ' + h.instance + ') but did not answer "status"', 'reload', 'extension_error');
  else add('extension', true, 'connected; holder instance ' + h.instance + (status.bridge && status.bridge.port ? ', port ' + status.bridge.port : ''));

  // 3. flow_tab
  if (!status) skip('flow_tab', 'extension not available', 'extension_not_connected');
  else {
    const tabs = Array.isArray(status.flowTabs) ? status.flowTabs : [];
    const project = tabs.filter((t) => /\/project\//.test(String(t.url || '')));
    if (project.length) add('flow_tab', true, project.length + ' Flow project tab(s): ' + project.map((t) => '[' + t.tabId + '] ' + String(t.title || '').slice(0, 40)).join(', ') + (project.length > 1 ? ' — several are open: pass tab_id to flow_start (ask the user which one)' : ''));
    else add('flow_tab', false, tabs.length ? tabs.length + ' Flow tab(s) open but none inside a project' : 'no Google Flow tab is open', 'flowTab', 'no_flow_tab');
  }

  // 4. queue
  if (!status) skip('queue', 'extension not available', 'extension_not_connected');
  else {
    const c = status.counts || {};
    const run = status.run || {};
    const cd = Number(run.cooldownUntil || 0);
    const parts = ['state ' + (run.state || '?') + (run.tabId != null ? ' (tab ' + run.tabId + ')' : '')];
    parts.push(['pending', 'running', 'done', 'failed', 'unknown', 'stopped'].map((k) => k + ' ' + (c[k] || 0)).join(', '));
    if (run.message) parts.push(String(run.message).slice(0, 120));
    const cooling = cd > Date.now();
    if (cooling) parts.push('cooldown until ' + new Date(cd).toISOString() + ' (' + Math.ceil((cd - Date.now()) / 1000) + ' s left)');
    add('queue', !cooling, parts.join('; '), cooling ? 'cooldown' : ((c.failed || c.unknown) ? 'failed' : ''), 'busy');
  }
  return { ok: checks.every((x) => x.ok), checks };
}

module.exports = {
  ERROR_CODES, FQError, usageError, classifyExtensionError, toErrorInfo, doctor, fetchItems,
  VERSION, DEFAULT_PORT, EXT_ORIGIN_DEFAULT, MAX_IMAGE_BYTES, MAX_BODY_BYTES, TOKEN_RE, hmacHex, isPrivateIp, fetchPublic,
  getPort, getExtOrigin, configDir, tokenPath, logPath,
  readToken, ensureToken, request, health, httpCall, ensureDaemon,
  loadImage, sniffMime, buildAddParams, waitForQueue, summarizeItem, asList, sleep,
};
