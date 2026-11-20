// Flow Queue — AI bridge client (runs in the service worker via importScripts; classic script).
// Connects to the local bridge daemon (ws://127.0.0.1:<port>/ext), authenticates both ways with the pairing
// token (DESIGN §7), then forwards {type:'req'} frames to globalThis.FQ.call(method, params).
// Several Chrome profiles can share one daemon (DESIGN §8): each profile has a persistent instanceId; a profile
// that finds the bridge busy (4002) retries only on the 'bridge' alarm, and one that was taken over (4003)
// stays offline until the user takes over again or changes the bridge settings.
(function () {
  'use strict';
  if (globalThis.__fqBridgeLoaded) return;
  globalThis.__fqBridgeLoaded = true;

  const DEFAULT_PORT = 17345;
  const ALARM = 'bridge';
  const HANDSHAKE_MS = 10000;
  const BACKOFF_MIN = 1000;
  const BACKOFF_MAX = 30000;
  const BUSY_RETRY_MS = 60000;
  const TOKEN_RE = /^[0-9a-f]{64}$/i;
  const MSG = {
    auth: '橋接程式驗證失敗（配對碼不符）',
    rejected: '橋接程式拒絕配對碼（請貼上 flowq pair 顯示的配對碼）',
    noToken: '尚未設定配對碼（在終端機執行 flowq pair 取得）',
    busy: '另一個 Chrome 設定檔正在使用橋接',
    taken: '已被另一個 Chrome 設定檔接管',
    lost: '與橋接程式的連線中斷',
    timeout: '橋接程式沒有完成驗證（逾時）',
  };

  let cfg = { enabled: false, port: DEFAULT_PORT, token: '' };
  let instanceId = '';
  let ws = null;
  let gen = 0;               // increments per socket; stale socket events are ignored
  let authed = false;
  let extNonce = '';
  let takeoverNext = false;  // send takeover:true in the next hello (user-initiated)
  let block = '';            // '' | 'busy' | 'taken' — suppresses automatic reconnects
  let blockedAt = 0;
  let backoff = BACKOFF_MIN;
  let retryTimer = null;
  let handshakeTimer = null;
  let lastWritten = '';
  let current = { connected: false, code: 'disabled', lastError: '' };
  let keyPromise = null;     // {token, key} cache for HMAC
  let loaded = null;
  let waiters = [];          // resolvers waiting for the outcome of a reconnect()
  let closeSignal = null;    // Promise<'busy'|'taken'|''> from a signed busy/taken frame on the current socket

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
  const sameCfg = (a, b) => a.enabled === b.enabled && a.port === b.port && a.token === b.token;

  async function loadCfg() {
    try {
      const d = await chrome.storage.local.get('settings');
      cfg = readCfg(d.settings);
    } catch (e) { /* keep previous */ }
    return cfg;
  }

  async function loadInstanceId() {
    if (instanceId) return instanceId;
    try {
      const d = await chrome.storage.local.get('bridgeInstanceId');
      instanceId = typeof d.bridgeInstanceId === 'string' && d.bridgeInstanceId ? d.bridgeInstanceId : '';
      if (!instanceId) {
        instanceId = crypto.randomUUID();
        await chrome.storage.local.set({ bridgeInstanceId: instanceId });
      }
    } catch (e) {
      if (!instanceId) instanceId = crypto.randomUUID();
    }
    return instanceId;
  }

  // A 4000 'replaced' while authenticated means another live socket uses our instanceId (e.g. a cloned profile
  // directory): take a fresh id so the next attempt is answered 'busy' instead of evicting it again.
  async function regenerateInstanceId() {
    instanceId = crypto.randomUUID();
    try { await chrome.storage.local.set({ bridgeInstanceId: instanceId }); } catch (e) { /* keep in memory */ }
  }

  function setStatus(connected, code, lastError) {
    current = { connected: !!connected, code: code || '', lastError: lastError || '' };
    const sig = JSON.stringify([current.connected, current.code, current.lastError, cfg.port]);
    if (sig !== lastWritten) {
      lastWritten = sig;
      try {
        const p = chrome.storage.local.set({ bridge: { connected: current.connected, code: current.code, lastError: current.lastError, at: Date.now(), port: cfg.port } });
        if (p && p.catch) p.catch(() => { lastWritten = ''; });
      } catch (e) { lastWritten = ''; }
    }
    const w = waiters;
    waiters = [];
    for (const f of w) f();
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
    retryTimer = null;
    if (!cfg.enabled || !cfg.token || block) return;
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
        const takeover = takeoverNext;
        takeoverNext = false; // a takeover request is used for exactly one hello
        send({ type: 'hello', version, extensionId: chrome.runtime.id, instanceId, takeover, nonce: extNonce, mac });
        return;
      }
      case 'welcome': {
        if (authed || !extNonce) return;
        const ok = await macVerify(token, 'daemon:' + extNonce, msg.mac).catch(() => false);
        if (myGen !== gen) return;
        if (!ok) {
          disconnect(4001, 'daemon authentication failed');
          setStatus(false, 'auth', MSG.auth);
          scheduleReconnect();
          return;
        }
        authed = true;
        block = '';
        clearTimeout(handshakeTimer); handshakeTimer = null;
        backoff = BACKOFF_MIN;
        setStatus(true, '', '');
        return;
      }
      case 'busy':
      case 'taken': {
        // Only a daemon that knows the token can make us stop retrying (DESIGN §8).
        if (!extNonce) return;
        const kind = msg.type;
        closeSignal = macVerify(token, kind + ':' + extNonce, msg.mac).then((ok) => (ok ? kind : ''), () => '');
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
          if (e && typeof e.code === 'string' && e.code) res.code = e.code; // stable error code (DESIGN §10)
        }
        if (myGen !== gen) return;
        send(res);
        return;
      }
      default:
        return;
    }
  }

  function connect() {
    if (!cfg.enabled) { setStatus(false, 'disabled', ''); return; }
    if (!cfg.token) { setStatus(false, 'no-token', MSG.noToken); return; }
    if (ws) return;
    clearTimeout(retryTimer); retryTimer = null;
    const myGen = ++gen;
    const url = 'ws://127.0.0.1:' + cfg.port + '/ext';
    let sock;
    try {
      sock = new WebSocket(url);
    } catch (e) {
      takeoverNext = false;
      setStatus(false, 'offline', String(e.message || e));
      scheduleReconnect();
      return;
    }
    ws = sock;
    authed = false;
    extNonce = '';
    closeSignal = null;
    sock.onopen = () => {
      if (myGen !== gen) return;
      handshakeTimer = setTimeout(() => {
        if (myGen !== gen || authed) return;
        takeoverNext = false;
        disconnect(4010, 'handshake timeout');
        setStatus(false, 'offline', MSG.timeout);
        scheduleReconnect();
      }, HANDSHAKE_MS);
    };
    sock.onmessage = (ev) => { onMessage(myGen, ev.data); };
    // Connection refused is expected while the daemon is not running: no console output from us.
    sock.onerror = () => {};
    sock.onclose = async (ev) => {
      if (myGen !== gen) return;
      const wasAuthed = authed;
      const code = ev ? ev.code : 0;
      const signalP = closeSignal;
      ws = null;
      authed = false;
      takeoverNext = false;
      closeSignal = null;
      clearTimeout(handshakeTimer); handshakeTimer = null;
      // 4002/4003 are honoured only when preceded by a frame signed with the pairing token
      const signal = (code === 4002 || code === 4003) && signalP ? await signalP : '';
      if (myGen !== gen) return; // a manual reconnect happened meanwhile
      if (code === 4002 && signal === 'busy') {        // another profile holds the bridge: retry on the alarm only
        block = 'busy';
        blockedAt = Date.now();
        setStatus(false, 'busy', MSG.busy);
        return;
      }
      if (code === 4003 && signal === 'taken') {       // taken over by another profile: stay offline
        block = 'taken';
        blockedAt = Date.now();
        setStatus(false, 'taken', MSG.taken);
        return;
      }
      if (code === 4000 && wasAuthed) await regenerateInstanceId();
      if (myGen !== gen) return;
      if (code === 4001) setStatus(false, 'auth', MSG.rejected);
      else if (code === 4000) setStatus(false, 'offline', MSG.lost);   // replaced: normal reconnect
      else setStatus(false, 'offline', wasAuthed ? MSG.lost : '無法連線到橋接程式（127.0.0.1:' + cfg.port + '）');
      scheduleReconnect();
    };
  }

  // Re-ensures the desired state (startup, alarm, settings change, manual reconnect).
  // reason: 'startup' | 'alarm' | 'settings' | 'manual'
  async function ensure(reason, opts) {
    const before = cfg;
    await loadCfg();
    await loadInstanceId();
    const changed = !sameCfg(before, cfg);
    if (reason === 'startup') {
      // Survive service-worker restarts: keep a 'taken' block and the busy retry spacing.
      try {
        const { bridge } = await chrome.storage.local.get('bridge');
        if (bridge && bridge.port === cfg.port && (bridge.code === 'taken' || bridge.code === 'busy')) {
          block = bridge.code;
          blockedAt = Number(bridge.at) || 0;
          current = { connected: false, code: bridge.code, lastError: bridge.lastError || '' };
          lastWritten = JSON.stringify([false, bridge.code, bridge.lastError || '', cfg.port]);
        }
      } catch (e) { /* ignore */ }
    }
    if (!cfg.enabled || !cfg.token) {
      clearTimers();
      disconnect(1000, 'disabled');
      block = '';
      setStatus(false, cfg.enabled ? 'no-token' : 'disabled', cfg.enabled ? MSG.noToken : '');
      return;
    }
    if (reason === 'manual' || (reason === 'settings' && (changed || (opts && opts.edited)))) {
      block = '';
      takeoverNext = reason === 'manual' && !!(opts && opts.takeover);
      clearTimers();
      disconnect(1000, 'reconnect');
      backoff = BACKOFF_MIN;
    }
    if (block === 'taken') return;
    if (block === 'busy') {
      if (ws || Date.now() - blockedAt < BUSY_RETRY_MS) return;
      if (reason !== 'alarm' && reason !== 'startup') return;
    }
    if (!ws && !retryTimer) connect();
  }

  try {
    chrome.alarms.onAlarm.addListener((alarm) => {
      if (!alarm || alarm.name !== ALARM) return;
      (loaded || Promise.resolve()).then(() => ensure('alarm')).catch(() => {});
    });
    chrome.alarms.get(ALARM, (a) => {
      if (chrome.runtime.lastError) { /* ignore */ }
      if (!a) chrome.alarms.create(ALARM, { periodInMinutes: 0.5 });
    });
  } catch (e) { /* alarms unavailable */ }

  try {
    // Browser restart: forget a stored 'taken' state. The retry carries takeover:false, so it cannot evict
    // the other profile; at worst it is answered 'busy'.
    chrome.runtime.onStartup.addListener(() => {
      (loaded || Promise.resolve()).then(() => {
        if (block !== 'taken') return;
        block = '';
        ensure('alarm').catch(() => {});
      }).catch(() => {});
    });
  } catch (e) { /* ignore */ }

  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local' || !changes.settings) return;
      const next = readCfg(changes.settings.newValue);
      const edited = !sameCfg(readCfg(changes.settings.oldValue), next);
      if (!edited && sameCfg(next, cfg)) return;
      (loaded || Promise.resolve()).then(() => ensure('settings', { edited })).catch(() => {});
    });
  } catch (e) { /* ignore */ }

  function status() {
    return { connected: current.connected && authed, code: current.code, lastError: current.lastError, port: cfg.port, enabled: cfg.enabled, instance: instanceId ? instanceId.slice(0, 8) : null };
  }

  // Handle for the background (BRIDGE_TAKEOVER) / side panel. reconnect({takeover:true}) takes the bridge over
  // from another profile; resolves with the status once the attempt settles (or after 8 s).
  globalThis.FQBridge = {
    status,
    reconnect: async (opts) => {
      await (loaded || Promise.resolve());
      const settled = new Promise((resolve) => {
        const t = setTimeout(resolve, 8000);
        waiters.push(() => { clearTimeout(t); resolve(); });
      });
      await ensure('manual', opts || {});
      if (!ws) return status();             // disabled / no token: already settled synchronously
      await settled;
      return status();
    },
  };

  loaded = ensure('startup').catch(() => {});
})();
