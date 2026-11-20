// Flow Queue — AI bridge client (runs in the service worker via importScripts; classic script).
// Connects to the local bridge daemon (ws://127.0.0.1:<port>/ext), authenticates both ways with the pairing
// token (DESIGN §7), then forwards {type:'req'} frames to globalThis.FQ.call(method, params).
(function () {
  'use strict';
  if (globalThis.__fqBridgeLoaded) return;
  globalThis.__fqBridgeLoaded = true;

  const DEFAULT_PORT = 17345;
  const ALARM = 'bridge';
  const HANDSHAKE_MS = 10000;
  const BACKOFF_MIN = 1000;
  const BACKOFF_MAX = 30000;
  const TOKEN_RE = /^[0-9a-f]{64}$/i;
  const ERR_AUTH = '橋接程式驗證失敗（配對碼不符）';
  const ERR_REJECTED = '橋接程式拒絕配對碼（請貼上 flowq pair 顯示的配對碼）';
  const ERR_NO_TOKEN = '尚未設定配對碼（在終端機執行 flowq pair 取得）';

  let cfg = { enabled: false, port: DEFAULT_PORT, token: '' };
  let ws = null;
  let gen = 0;               // increments per socket; stale socket events are ignored
  let authed = false;
  let extNonce = '';
  let backoff = BACKOFF_MIN;
  let retryTimer = null;
  let handshakeTimer = null;
  let lastWritten = '';
  let current = { connected: false, lastError: '' };
  let keyPromise = null;     // {token, key} cache for HMAC
  let loaded = null;

  const hex = (buf) => Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');
  const unhex = (s) => {
    const out = new Uint8Array(s.length / 2);
    for (let i = 0; i < out.length; i++) out[i] = parseInt(s.substr(i * 2, 2), 16);
    return out;
  };
  const randomHex = (n) => hex(crypto.getRandomValues(new Uint8Array(n)));

  function hmacKey(token) {
    if (!keyPromise || keyPromise.token !== token) {
      keyPromise = {
        token,
        key: crypto.subtle.importKey('raw', new TextEncoder().encode(token), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']),
      };
    }
    return keyPromise.key;
  }
  async function macHex(token, text) {
    return hex(await crypto.subtle.sign('HMAC', await hmacKey(token), new TextEncoder().encode(text)));
  }
  async function macVerify(token, text, macHexStr) {
    if (typeof macHexStr !== 'string' || !/^[0-9a-f]{64}$/i.test(macHexStr)) return false;
    return crypto.subtle.verify('HMAC', await hmacKey(token), unhex(macHexStr.toLowerCase()), new TextEncoder().encode(text));
  }

  function readCfg(settings) {
    const s = settings || {};
    const p = parseInt(s.bridgePort, 10);
    const token = typeof s.bridgeToken === 'string' ? s.bridgeToken.trim().toLowerCase() : '';
    return {
      enabled: s.bridgeEnabled === true,
      port: p > 0 && p < 65536 ? p : DEFAULT_PORT,
      token: TOKEN_RE.test(token) ? token : '',
    };
  }

  async function loadCfg() {
    try {
      const d = await chrome.storage.local.get('settings');
      cfg = readCfg(d.settings);
    } catch (e) { /* keep previous */ }
    return cfg;
  }

  function setStatus(connected, lastError) {
    current = { connected: !!connected, lastError: lastError || '' };
    const sig = JSON.stringify([current.connected, current.lastError, cfg.port]);
    if (sig === lastWritten) return;
    lastWritten = sig;
    try {
      const p = chrome.storage.local.set({ bridge: { connected: current.connected, lastError: current.lastError, at: Date.now(), port: cfg.port } });
      if (p && p.catch) p.catch(() => { lastWritten = ''; });
    } catch (e) { lastWritten = ''; }
  }

  function clearTimers() {
    clearTimeout(retryTimer); retryTimer = null;
    clearTimeout(handshakeTimer); handshakeTimer = null;
  }

  function disconnect(code, reason) {
    gen++;
    authed = false;
    clearTimeout(handshakeTimer); handshakeTimer = null;
    const old = ws;
    ws = null;
    if (old) {
      old.onopen = old.onmessage = old.onerror = old.onclose = null;
      try { old.close(code || 1000, reason || ''); } catch (e) { /* ignore */ }
    }
  }

  function scheduleReconnect() {
    clearTimeout(retryTimer);
    if (!cfg.enabled || !cfg.token) return;
    const wait = backoff;
    backoff = Math.min(BACKOFF_MAX, backoff * 2);
    retryTimer = setTimeout(() => { retryTimer = null; connect(); }, wait);
  }

  function send(obj) {
    if (!ws || ws.readyState !== 1) return false;
    try { ws.send(JSON.stringify(obj)); return true; } catch (e) { return false; }
  }

  async function onMessage(myGen, raw) {
    if (myGen !== gen) return;
    let msg;
    try { msg = JSON.parse(typeof raw === 'string' ? raw : ''); } catch (e) { return; }
    if (!msg || typeof msg !== 'object') return;
    const token = cfg.token;

    switch (msg.type) {
      case 'ping':
        send({ type: 'pong' });
        return;
      case 'challenge': {
        if (authed || typeof msg.nonce !== 'string' || !msg.nonce) return;
        extNonce = randomHex(32);
        const mac = await macHex(token, 'ext:' + msg.nonce);
        if (myGen !== gen) return;
        let version = '';
        try { version = chrome.runtime.getManifest().version; } catch (e) { /* ignore */ }
        send({ type: 'hello', version, extensionId: chrome.runtime.id, nonce: extNonce, mac });
        return;
      }
      case 'welcome': {
        if (authed || !extNonce) return;
        const ok = await macVerify(token, 'daemon:' + extNonce, msg.mac).catch(() => false);
        if (myGen !== gen) return;
        if (!ok) {
          disconnect(4001, 'daemon authentication failed');
          setStatus(false, ERR_AUTH);
          scheduleReconnect();
          return;
        }
        authed = true;
        clearTimeout(handshakeTimer); handshakeTimer = null;
        backoff = BACKOFF_MIN;
        setStatus(true, '');
        return;
      }
      case 'req': {
        if (!authed) return; // never act on requests from an unverified daemon
        const id = msg.id;
        let res;
        try {
          const fq = globalThis.FQ;
          if (!fq || typeof fq.call !== 'function') throw new Error('Flow Queue 背景程式尚未就緒');
          const result = await fq.call(String(msg.method || ''), msg.params == null ? {} : msg.params);
          res = { type: 'res', id, ok: true, result: result === undefined ? null : result };
        } catch (e) {
          res = { type: 'res', id, ok: false, error: String((e && e.message) || e || 'error') };
        }
        if (myGen !== gen) return;
        if (!send(res)) return;
        return;
      }
      default:
        return;
    }
  }

  function connect() {
    if (!cfg.enabled) { setStatus(false, ''); return; }
    if (!cfg.token) { setStatus(false, ERR_NO_TOKEN); return; }
    if (ws) return;
    clearTimeout(retryTimer); retryTimer = null;
    const myGen = ++gen;
    const url = 'ws://127.0.0.1:' + cfg.port + '/ext';
    let sock;
    try {
      sock = new WebSocket(url);
    } catch (e) {
      setStatus(false, String(e.message || e));
      scheduleReconnect();
      return;
    }
    ws = sock;
    authed = false;
    extNonce = '';
    sock.onopen = () => {
      if (myGen !== gen) return;
      handshakeTimer = setTimeout(() => {
        if (myGen !== gen || authed) return;
        disconnect(4002, 'handshake timeout');
        setStatus(false, '橋接程式沒有完成驗證（逾時）');
        scheduleReconnect();
      }, HANDSHAKE_MS);
    };
    sock.onmessage = (ev) => { onMessage(myGen, ev.data); };
    // Connection refused is expected while the daemon is not running: no console output from us.
    sock.onerror = () => {};
    sock.onclose = (ev) => {
      if (myGen !== gen) return;
      const wasAuthed = authed;
      ws = null;
      authed = false;
      clearTimeout(handshakeTimer); handshakeTimer = null;
      let err;
      if (ev && ev.code === 4001) err = ERR_REJECTED;
      else if (ev && ev.code === 4000) err = '已被另一個連線取代';
      else if (wasAuthed) err = '與橋接程式的連線中斷';
      else err = '無法連線到橋接程式（127.0.0.1:' + cfg.port + '）';
      setStatus(false, err);
      if (ev && ev.code === 4000) backoff = BACKOFF_MAX; // another browser profile owns the bridge: back off
      scheduleReconnect();
    };
  }

  // Re-ensures the desired state (used at startup, on alarms and on settings changes).
  async function ensure(force) {
    const before = JSON.stringify(cfg);
    await loadCfg();
    const changed = before !== JSON.stringify(cfg);
    if (!cfg.enabled || !cfg.token) {
      clearTimers();
      disconnect(1000, 'disabled');
      setStatus(false, cfg.enabled ? ERR_NO_TOKEN : '');
      return;
    }
    if (changed || force) {
      clearTimers();
      disconnect(1000, 'settings changed');
      backoff = BACKOFF_MIN;
    }
    if (!ws && !retryTimer) connect();
  }

  try {
    chrome.alarms.onAlarm.addListener((alarm) => {
      if (!alarm || alarm.name !== ALARM) return;
      (loaded || Promise.resolve()).then(() => ensure(false)).catch(() => {});
    });
    chrome.alarms.get(ALARM, (a) => {
      if (chrome.runtime.lastError) { /* ignore */ }
      if (!a) chrome.alarms.create(ALARM, { periodInMinutes: 0.5 });
    });
  } catch (e) { /* alarms unavailable */ }

  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local' || !changes.settings) return;
      const next = readCfg(changes.settings.newValue);
      if (next.enabled === cfg.enabled && next.port === cfg.port && next.token === cfg.token) return;
      ensure(false).catch(() => {});
    });
  } catch (e) { /* ignore */ }

  // Small handle for the background / side panel (status + manual reconnect).
  globalThis.FQBridge = {
    status: () => ({ connected: current.connected && authed, lastError: current.lastError, port: cfg.port, enabled: cfg.enabled }),
    reconnect: () => ensure(true),
  };

  loaded = ensure(false).catch(() => {});
})();
