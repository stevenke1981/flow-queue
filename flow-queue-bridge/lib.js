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
  const timeoutMs = opts.timeoutMs || (method === 'listAssets' ? 75000 : 45000);
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
    if (e.code === 'ECONNREFUSED') throw new Error('Flow Queue bridge daemon is not running on 127.0.0.1:' + port);
    throw e;
  }
  const j = r.json;
  if (j && j.ok) return j.result;
  const msg = (j && j.error) || r.text || ('HTTP ' + r.status);
  const err = new Error(String(msg));
  err.status = r.status;
  throw err;
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
      throw new Error('Flow Queue daemon exited (' + exited + '); see ' + logPath());
    }
  }
  throw new Error('Flow Queue daemon did not answer on 127.0.0.1:' + port + '; see ' + logPath());
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
    try { u = new URL(urlStr); } catch (e) { return reject(new Error('bad image URL: ' + urlStr)); }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return reject(new Error('only http(s) image URLs are allowed: ' + urlStr));
    const host = u.hostname.replace(/^\[|\]$/g, '');
    if (net.isIP(host) && isPrivateIp(host)) return reject(new Error('blocked private/loopback address: ' + host));
    if (/^localhost$|\.localhost$/i.test(host)) return reject(new Error('blocked private/loopback address: ' + host));
    const mod = u.protocol === 'https:' ? require('https') : http;
    const req = mod.get(u, { lookup: safeLookup, headers: { 'User-Agent': 'flow-queue-bridge', Accept: 'image/*' }, timeout: 30000 }, (res) => {
      const status = res.statusCode || 0;
      if (status >= 300 && status < 400 && res.headers.location) {
        res.resume();
        if (hops >= 5) return reject(new Error('too many redirects: ' + urlStr));
        let next;
        try { next = new URL(res.headers.location, u).toString(); } catch (e) { return reject(new Error('bad redirect from ' + urlStr)); }
        return fetchPublic(next, hops + 1).then(resolve, reject);
      }
      if (status !== 200) { res.resume(); return reject(new Error('image download failed (HTTP ' + status + '): ' + urlStr)); }
      if (Number(res.headers['content-length'] || 0) > MAX_IMAGE_BYTES) { res.destroy(); return reject(new Error('image larger than 10 MB: ' + urlStr)); }
      const chunks = [];
      let size = 0;
      res.on('data', (c) => {
        size += c.length;
        if (size > MAX_IMAGE_BYTES) { res.destroy(); reject(new Error('image larger than 10 MB: ' + urlStr)); return; }
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
  if (!src) throw new Error('empty image path');
  let buf, name, mime = '';
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(src) && !/^file:\/\//i.test(src)) {
    const r = await fetchPublic(src);
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
    if (!st || !st.isFile()) throw new Error('image file not found: ' + src);
    if (st.size > MAX_IMAGE_BYTES) throw new Error('image larger than 10 MB: ' + src);
    buf = await fs.promises.readFile(file);
    name = path.basename(file);
    mime = sniffMime(buf) || EXT_MIME[path.extname(file).toLowerCase()] || '';
  }
  if (buf.length > MAX_IMAGE_BYTES) throw new Error('image larger than 10 MB: ' + src);
  if (!mime.startsWith('image/')) throw new Error('not an image (' + (mime || 'unknown type') + '): ' + src);
  // 與擴充功能相同：只接受實際內容可辨識的格式
  const real = sniffMime(buf);
  if (!real || real === 'image/bmp') throw new Error('unsupported image format (use png / jpg / webp / gif / avif / heic): ' + src);
  return { name, mime: real, base64: buf.toString('base64') };
}

// ---------- shared high-level operations (MCP + CLI) ----------
const asList = (v) => (v == null ? [] : (Array.isArray(v) ? v : [v])).map((x) => String(x).trim()).filter(Boolean);

// spec: {prompts: (string|{prompt, images?, characters?, assets?})[], images?, characters?, assets?, toTop?}
// → params for the background "add" method (DESIGN §7): every image is sent with its own uploadFile call, one at a
// time, and referenced by fileId; add itself carries only refs plus a fresh requestId for dedupe.
async function buildAddParams(spec, call) {
  const prompts = Array.isArray(spec.prompts) ? spec.prompts : asList(spec.prompts);
  if (!prompts.length) throw new Error('prompts is empty');
  for (const p of prompts) {
    if (typeof p === 'string') continue;
    if (!p || typeof p !== 'object' || !String(p.prompt || '').trim()) throw new Error('each prompt needs a non-empty "prompt"');
  }
  const uploaded = new Map(); // src -> ref
  const fileRef = async (src) => {
    if (!uploaded.has(src)) {
      const img = await loadImage(src);
      const r = await call('uploadFile', img);
      if (!r || !r.fileId) throw new Error('uploadFile returned no fileId for ' + src);
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
  if (!items.length) throw new Error('prompts is empty');
  const params = { prompts: items, requestId: spec.requestId ? String(spec.requestId).slice(0, 100) : crypto.randomUUID() };
  if (refs.length) params.refs = refs;
  if (spec.toTop) params.toTop = true;
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

// Polls until nothing is pending/running (or the given ids are finished). onTick(status) is called each poll.
async function waitForQueue(call, { timeoutSec = 1800, ids = null, intervalMs = 5000, onTick } = {}) {
  const wanted = asList(ids);
  const deadline = Date.now() + Math.max(0, Number(timeoutSec) || 0) * 1000;
  for (;;) {
    let done, items = [], status = null;
    if (wanted.length) {
      items = [];
      for (const id of wanted) {
        try { items.push((await call('get', { id })).item); } catch (e) { items.push({ id, status: 'missing', error: e.message }); }
      }
      done = items.every((it) => !it || !ACTIVE.has(it.status));
    } else {
      status = await call('status', {});
      const c = (status && status.counts) || {};
      done = !(c.pending || 0) && !(c.running || 0);
    }
    if (onTick) { try { onTick({ items, status }); } catch (e) { /* ignore */ } }
    const timedOut = !done && Date.now() >= deadline;
    if (done || timedOut) {
      if (!status) status = await call('status', {}).catch(() => null);
      if (!wanted.length && done) {
        const r = await call('list', { status: ['done', 'failed', 'unknown', 'stopped'], limit: 200 }).catch(() => null);
        items = r ? r.items : [];
      }
      return {
        done,
        timedOut,
        counts: status ? status.counts : undefined,
        run: status ? status.run : undefined,
        items: items.map(summarizeItem),
      };
    }
    await sleep(Math.min(intervalMs, Math.max(50, deadline - Date.now())));
  }
}

module.exports = {
  VERSION, DEFAULT_PORT, EXT_ORIGIN_DEFAULT, MAX_IMAGE_BYTES, MAX_BODY_BYTES, TOKEN_RE, hmacHex, isPrivateIp, fetchPublic,
  getPort, getExtOrigin, configDir, tokenPath, logPath,
  readToken, ensureToken, request, health, httpCall, ensureDaemon,
  loadImage, sniffMime, buildAddParams, waitForQueue, summarizeItem, asList, sleep,
};
