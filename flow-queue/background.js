// Flow Queue — service worker
try { importScripts('bridge-client.js'); } catch (e) { console.warn('bridge-client.js 載入失敗', e); }
// 單一寫入者：所有佇列 / 設定 / 執行狀態的修改都經過這裡，避免側邊面板與內容腳本互相覆蓋。

const FLOW_URL_RE = /^https:\/\/(?:flow\.google(?:\.com)?\/|labs\.google\/fx\/)/i;
const projectOf = (url) => { const m = String(url || '').match(/\/project\/([A-Za-z0-9_-]+)/); return m ? m[1] : ''; };
const ITEM_PATCH_KEYS = new Set(['status', 'submittedAt', 'finishedAt', 'results', 'error']);
const withTimeout = (p, ms, what) => {
  let timer;
  const t = new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(what + ' 逾時')), ms); });
  return Promise.race([p, t]).finally(() => clearTimeout(timer));
};

const DEFAULT_SETTINGS = Object.freeze({
  maxConcurrent: 1,      // 同時在 Flow 生成中的提示詞數量
  delayMin: 3,           // 每次送出之間的最短間隔（秒）
  delayMax: 8,           // 每次送出之間的最長間隔（秒）
  timeoutMin: 10,        // 單一提示詞等待完成的上限（分鐘）
  retries: 1,            // 失敗後自動重試次數
  cooldownSec: 120,      // 遇到限流 / 異常活動時暫停多久（秒）
  trustedClick: true,    // 用 chrome.debugger 送出真實滑鼠點擊
  autoDownload: false,   // 完成後自動下載
  downloadFolder: 'FlowQueue',
  splitMode: 'blank',    // blank：以空行分隔；line：每行一個
  clearIngredients: true, // 有素材的項目先清空 Flow 提示詞框上的既有素材
  bridgeEnabled: false,  // 允許本機 AI 代理（Claude / Codex / agy）透過橋接控制（需配對碼）
  bridgePort: 17345,
  bridgeToken: ''        // 與 ~/.flow-queue/token 相同的配對碼，用來雙向驗證橋接程式
});
const MAX_FILE_BYTES = 10 * 1024 * 1024;

function sniffImage(bytes) {
  const b = (i) => bytes[i];
  if (b(0) === 0x89 && b(1) === 0x50 && b(2) === 0x4e && b(3) === 0x47) return 'image/png';
  if (b(0) === 0xff && b(1) === 0xd8 && b(2) === 0xff) return 'image/jpeg';
  if (b(0) === 0x47 && b(1) === 0x49 && b(2) === 0x46) return 'image/gif';
  if (b(0) === 0x52 && b(1) === 0x49 && b(2) === 0x46 && b(3) === 0x46 && b(8) === 0x57 && b(9) === 0x45 && b(10) === 0x42 && b(11) === 0x50) return 'image/webp';
  const brand = String.fromCharCode(b(8), b(9), b(10), b(11));
  if (String.fromCharCode(b(4), b(5), b(6), b(7)) === 'ftyp') {
    if (/^(avif|avis)$/.test(brand)) return 'image/avif';
    if (/^(heic|heix|mif1|msf1|heim|heis)$/.test(brand)) return 'image/heic';
  }
  return '';
}
const FILE_GC_GRACE_MS = 10 * 60 * 1000;
const REF_CATEGORIES = new Set(['Images', 'Characters', 'Videos', 'Uploads', 'All']);

function normalizeRefs(refs) {
  const out = [];
  for (const r of Array.isArray(refs) ? refs : []) {
    if (!r || typeof r !== 'object') continue;
    const name = String(r.name || '').trim().slice(0, 200);
    if (r.type === 'character' && name) out.push({ type: 'character', name });
    else if (r.type === 'asset' && name) out.push({ type: 'asset', name, category: REF_CATEGORIES.has(r.category) ? r.category : 'All' });
    else if (r.type === 'file' && /^[0-9a-f]{16}$/.test(String(r.fileId || ''))) {
      out.push({ type: 'file', fileId: r.fileId, name: name || r.fileId, mime: String(r.mime || 'image/png') });
    }
  }
  return out.slice(0, 20);
}

async function storeFile(d, { name, mime, base64 }) {
  base64 = String(base64 || '').replace(/^data:[^,]*,/, '');
  const bin = atob(base64);
  if (!bin.length) throw new Error('檔案是空的');
  if (bin.length > MAX_FILE_BYTES) throw new Error('檔案超過 10 MB');
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  // 以檔案內容判斷格式，不相信宣告的 mime
  mime = sniffImage(bytes);
  if (!mime) throw new Error('只支援圖片檔（png / jpg / webp / gif / avif / heic）');
  const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map((b) => b.toString(16).padStart(2, '0')).join('');
  const fileId = hash.slice(0, 16);
  const key = 'file:' + fileId;
  const safe = String(name || fileId).replace(/[\u0000-\u001f]/g, '').slice(0, 120);
  if (!(d.meta.files || {})[fileId]) {
    await chrome.storage.local.set({ [key]: { name: safe, mime, base64, size: bin.length, createdAt: Date.now() } });
  }
  d.meta.files = { ...(d.meta.files || {}), [fileId]: Date.now() };
  return { fileId, name: safe, mime, size: bin.length };
}

// 刪掉沒有任何佇列項目引用、且超過寬限時間的參考圖（寬限避免剛上傳、還沒加入佇列就被刪）
async function gcFiles(d) {
  const used = new Set();
  for (const it of d.queue) for (const r of it.refs || []) if (r.type === 'file') used.add(r.fileId);
  const files = d.meta.files || {};
  const now = Date.now();
  const drop = Object.keys(files).filter((id) => !used.has(id) && now - files[id] > FILE_GC_GRACE_MS);
  if (!drop.length) return;
  await chrome.storage.local.remove(drop.map((id) => 'file:' + id));
  for (const id of drop) delete files[id];
  d.meta.files = files;
}
const DEFAULT_RUN = Object.freeze({ state: 'idle', tabId: null, cooldownUntil: 0, message: '' });
const KEYS = ['queue', 'settings', 'run', 'logs', 'meta'];
const MAX_LOGS = 300;

// ---------- storage helpers ----------
function withDefaults(d) {
  d.queue = Array.isArray(d.queue) ? d.queue : [];
  d.settings = { ...DEFAULT_SETTINGS, ...(d.settings || {}) };
  d.run = { ...DEFAULT_RUN, ...(d.run || {}) };
  d.logs = Array.isArray(d.logs) ? d.logs : [];
  d.meta = { seq: 0, ...(d.meta || {}) };
  return d;
}

let chain = Promise.resolve();
function mutate(fn) {
  const p = chain.then(async () => {
    const d = withDefaults(await chrome.storage.local.get(KEYS));
    const result = await fn(d);
    d.logs = d.logs.slice(-MAX_LOGS);
    await chrome.storage.local.set(d);
    return result;
  });
  chain = p.catch(() => {});
  return p;
}

function addLog(d, text, level = 'info') {
  d.logs.push({ t: Date.now(), text: String(text).slice(0, 500), level });
}

function findItem(d, id) {
  return d.queue.find((it) => it.id === id) || null;
}

// 把「執行中」但已失去追蹤的項目整理掉：已送出的標為「未確認」，未送出的退回待處理。
function releaseRunning(d, note) {
  for (const it of d.queue) {
    if (it.status !== 'running') continue;
    if (it.submittedAt) {
      it.status = 'unknown';
      it.error = note;
    } else {
      it.status = 'pending';
      it.attempts = Math.max(0, (it.attempts || 1) - 1);
    }
    it.claimId = '';
  }
}

// 每次認領都有唯一 claimId；過期的訊息（來自已被撤銷的認領）一律忽略
const claimMatches = (it, msg) => msg.claimId == null || msg.claimId === it.claimId;

async function init() {
  // 瀏覽器重啟或擴充功能更新後，舊的 tabId 可能被重用：一律回到閒置
  await mutate((d) => {
    if (d.run.state !== 'idle' || d.queue.some((it) => it.status === 'running')) {
      releaseRunning(d, '瀏覽器或擴充功能已重新啟動，無法確認結果');
      addLog(d, '擴充功能重新啟動，佇列已回到閒置', 'warn');
    }
    d.run = { ...DEFAULT_RUN };
  });
  try { await chrome.alarms.clear('tick'); } catch (e) {}
  try { await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }); } catch (e) {}
}
chrome.runtime.onInstalled.addListener(init);
chrome.runtime.onStartup.addListener(init);

// ---------- content script ----------
async function ensureContentScript(tabId) {
  try {
    const r = await chrome.tabs.sendMessage(tabId, { type: 'PING' });
    if (r && r.ok) return;
  } catch (e) {}
  await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
}

// ---------- trusted click (chrome.debugger) ----------
const debuggerTabs = new Map(); // tabId -> detach timer
const clickChains = new Map();

async function detachDebugger(tabId) {
  clearTimeout(debuggerTabs.get(tabId));
  debuggerTabs.delete(tabId);
  try { await chrome.debugger.detach({ tabId }); } catch (e) {}
}

chrome.debugger.onDetach.addListener((source, reason) => {
  if (source && source.tabId != null) {
    clearTimeout(debuggerTabs.get(source.tabId));
    debuggerTabs.delete(source.tabId);
  }
  if (reason === 'canceled_by_user') {
    // 使用者按了「取消」偵錯提示：關閉真實點擊，避免每次點擊都再跳出
    mutate((d) => {
      d.settings.trustedClick = false;
      addLog(d, '你取消了偵錯連線，已關閉「真實點擊」（改用一般點擊）', 'warn');
    });
  }
});

async function dispatchClick(tabId, x, y) {
  const target = { tabId };
  if (await attachDebugger(tabId)) await new Promise((r) => setTimeout(r, 400));
  clearTimeout(debuggerTabs.get(tabId));
  try {
    const base = { x, y, button: 'left', clickCount: 1 };
    const cmd = (p) => withTimeout(chrome.debugger.sendCommand(target, 'Input.dispatchMouseEvent', p), 3000, '滑鼠事件');
    await cmd({ type: 'mouseMoved', x, y });
    await cmd({ ...base, type: 'mousePressed', buttons: 1 });
    await cmd({ ...base, type: 'mouseReleased', buttons: 0 });
  } catch (e) {
    await detachDebugger(tabId);
    throw e;
  }
  // 執行期間保持連線（反覆連線會讓「正在偵錯」提示列跳動、使座標偏移）；閒置 10 分鐘才自動解除
  debuggerTabs.set(tabId, setTimeout(() => detachDebugger(tabId), 600000));
}

async function attachDebugger(tabId) {
  if (debuggerTabs.has(tabId)) return false;
  try {
    await withTimeout(chrome.debugger.attach({ tabId }, '1.3'), 3000, 'debugger attach');
  } catch (e) {
    const m = String(e && e.message);
    if (/another debugger/i.test(m)) throw new Error('此分頁已被其他偵錯工具連線（請關閉 DevTools 或其他擴充功能的偵錯）');
    if (!/already attached/i.test(m)) throw e;
  }
  debuggerTabs.set(tabId, setTimeout(() => detachDebugger(tabId), 600000));
  return true;
}

function trustedClick(tabId, x, y) {
  const prev = clickChains.get(tabId) || Promise.resolve();
  const next = prev.catch(() => {}).then(() => dispatchClick(tabId, x, y));
  clickChains.set(tabId, next);
  return next.finally(() => { if (clickChains.get(tabId) === next) clickChains.delete(tabId); });
}

// ---------- downloads ----------
function safeName(s, max = 80) {
  return String(s || '')
    .replace(/[\u0000-\u001f<>:"/\\|?*\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max)
    .replace(/[. ]+$/, '') || 'flow';
}

function safeFolder(s) {
  return String(s || '')
    .split(/[\\/]+/)
    .filter((p) => p.trim() && !/^\.+$/.test(p.trim()))
    .map((p) => safeName(p, 60))
    .join('/');
}

// ---------- message handlers ----------
const handlers = {
  PING: async () => ({}),

  GET_TAB_ID: async (msg, sender) => ({ tabId: sender.tab ? sender.tab.id : null }),

  ADD_ITEMS: (msg) => mutate((d) => {
    const batchRefs = normalizeRefs(msg.refs);
    const entries = (Array.isArray(msg.prompts) ? msg.prompts : [])
      .map((p) => (p && typeof p === 'object')
        ? { prompt: String(p.prompt || '').trim(), refs: normalizeRefs([...batchRefs, ...(p.refs || [])]) }
        : { prompt: String(p || '').trim(), refs: batchRefs })
      .filter((e) => e.prompt);
    const known = d.meta.files || {};
    for (const e of entries) {
      const missing = e.refs.find((r) => r.type === 'file' && !known[r.fileId]);
      if (missing) throw new Error('參考圖不存在，請重新附加：' + missing.name);
    }
    const now = Date.now();
    const items = entries.map(({ prompt, refs }) => ({
      id: crypto.randomUUID(),
      seq: ++d.meta.seq,
      prompt,
      refs,
      status: 'pending',
      attempts: 0,
      error: '',
      results: [],
      createdAt: now
    }));
    if (msg.toTop) {
      const firstPending = d.queue.findIndex((it) => it.status === 'pending');
      d.queue.splice(firstPending < 0 ? d.queue.length : firstPending, 0, ...items);
    } else {
      d.queue.push(...items);
    }
    if (items.length) addLog(d, '已加入 ' + items.length + ' 筆提示詞' + (batchRefs.length ? '（每筆 ' + batchRefs.length + ' 個素材）' : ''));
    return { added: items.length, ids: items.map((it) => it.id) };
  }),

  REMOVE_ITEMS: (msg) => mutate(async (d) => {
    const ids = new Set(msg.ids || []);
    const before = d.queue.length;
    d.queue = d.queue.filter((it) => !ids.has(it.id) || it.status === 'running');
    if (before - d.queue.length < ids.size) addLog(d, '執行中的項目無法刪除，請先停止', 'warn');
    await gcFiles(d);
    return { removed: before - d.queue.length };
  }),

  MOVE_ITEM: (msg) => mutate((d) => {
    const i = d.queue.findIndex((it) => it.id === msg.id);
    if (i < 0) return {};
    const [it] = d.queue.splice(i, 1);
    let j;
    if (msg.to === 'top') j = Math.max(0, d.queue.findIndex((x) => x.status === 'pending'));
    else if (msg.to === 'bottom') j = d.queue.length;
    else j = Math.max(0, Math.min(d.queue.length, i + (Number(msg.delta) || 0)));
    d.queue.splice(j, 0, it);
    return {};
  }),

  EDIT_ITEM: (msg) => mutate((d) => {
    const it = findItem(d, msg.id);
    const prompt = String(msg.prompt || '').trim();
    if (!it || !prompt) return {};
    if (it.status === 'running') throw new Error('執行中的項目不能修改');
    it.prompt = prompt;
    return {};
  }),

  RETRY_ITEMS: (msg) => mutate((d) => {
    const ids = Array.isArray(msg.ids) && msg.ids.length ? new Set(msg.ids) : null;
    const statuses = new Set(msg.statuses || ['failed', 'unknown', 'stopped']);
    let n = 0;
    for (const it of d.queue) {
      if (it.status === 'running') continue;
      if (ids ? ids.has(it.id) : statuses.has(it.status)) {
        Object.assign(it, { status: 'pending', attempts: 0, error: '', results: [], submittedAt: 0, finishedAt: 0, claimId: '' });
        n++;
      }
    }
    return { retried: n };
  }),

  CLEAR: (msg) => mutate(async (d) => {
    const mode = msg.mode || 'done';
    const keep = (it) => {
      if (it.status === 'running') return true;
      if (mode === 'all') return false;
      if (mode === 'failed') return !['failed', 'unknown', 'stopped'].includes(it.status);
      return it.status !== 'done';
    };
    const before = d.queue.length;
    d.queue = d.queue.filter(keep);
    await gcFiles(d);
    return { removed: before - d.queue.length };
  }),

  CLEAR_LOGS: () => mutate((d) => { d.logs = []; return {}; }),

  SET_SETTINGS: (msg) => mutate((d) => {
    const patch = {};
    for (const [k, v] of Object.entries(msg.patch || {})) if (k in DEFAULT_SETTINGS) patch[k] = v;
    const s = { ...d.settings, ...patch };
    const num = (v, lo, hi, def) => {
      const n = Number(v);
      return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : def;
    };
    s.maxConcurrent = Math.round(num(s.maxConcurrent, 1, 10, 1));
    s.delayMin = num(s.delayMin, 0, 600, 3);
    s.delayMax = Math.max(s.delayMin, num(s.delayMax, 0, 600, 8));
    s.timeoutMin = num(s.timeoutMin, 1, 120, 10);
    s.retries = Math.round(num(s.retries, 0, 10, 1));
    s.cooldownSec = num(s.cooldownSec, 10, 3600, 120);
    s.trustedClick = !!s.trustedClick;
    s.autoDownload = !!s.autoDownload;
    s.downloadFolder = safeFolder(s.downloadFolder) || 'FlowQueue';
    s.splitMode = s.splitMode === 'line' ? 'line' : 'blank';
    s.clearIngredients = s.clearIngredients !== false;
    s.bridgeEnabled = !!s.bridgeEnabled;
    s.bridgePort = Math.round(num(s.bridgePort, 1024, 65535, 17345));
    s.bridgeToken = /^[0-9a-f]{64}$/i.test(String(s.bridgeToken || '').trim()) ? String(s.bridgeToken).trim().toLowerCase() : '';
    d.settings = s;
    return { settings: s };
  }),

  LOG: (msg) => mutate((d) => { addLog(d, msg.text, msg.level); return {}; }),

  ADD_FILE: (msg) => mutate((d) => storeFile(d, msg)),

  GET_FILE: async (msg) => {
    const key = 'file:' + String(msg.fileId || '');
    const r = await chrome.storage.local.get(key);
    if (!r[key]) throw new Error('找不到檔案');
    return { file: r[key] };
  },

  LIST_ASSETS: async (msg) => {
    const tabId = msg.tabId != null ? Number(msg.tabId) : await pickFlowTab();
    if (tabId == null) throw new Error('請先開啟 Google Flow 專案頁面');
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (!tab || !FLOW_URL_RE.test(tab.url || '')) throw new Error('指定的分頁不是 Google Flow');
    await ensureContentScript(tabId);
    const r = await withTimeout(chrome.tabs.sendMessage(tabId, { type: 'LIST_ASSETS', category: msg.category || 'All', search: msg.search || '' }), 50000, '讀取素材清單');
    if (!r || !r.ok) throw new Error((r && r.error) || 'Flow 分頁沒有回應');
    return { assets: r.assets || [] };
  },

  BRIDGE_STATUS: async () => ({ bridge: (await chrome.storage.local.get('bridge')).bridge || { connected: false } }),

  // 在頁面主世界攔截 file input 的 click：不跳出系統檔案視窗，只標記該欄位，讓內容腳本直接放入檔案
  HOLD_FILE_CHOOSER: async (msg, sender) => {
    const tabId = sender.tab && sender.tab.id;
    if (tabId == null || !FLOW_URL_RE.test(sender.tab.url || '')) throw new Error('不是 Flow 分頁');
    await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: () => {
        const proto = HTMLInputElement.prototype;
        if (proto.click.__fqHeld) return;
        const original = proto.click;
        const held = function (...args) {
          if (this.type !== 'file') return original.apply(this, args);
          this.setAttribute('data-fq-upload-target', String(Date.now()));
          if (proto.click === held) proto.click = original; // 只攔截一次
        };
        held.__fqHeld = true;
        proto.click = held;
        const originalPicker = proto.showPicker;
        if (originalPicker) {
          proto.showPicker = function (...args) {
            if (this.type !== 'file') return originalPicker.apply(this, args);
            this.setAttribute('data-fq-upload-target', String(Date.now()));
            proto.showPicker = originalPicker;
          };
        }
        setTimeout(() => {
          if (proto.click === held) proto.click = original;
          if (originalPicker) proto.showPicker = originalPicker;
        }, 15000);
      }
    });
    return {};
  },

  // 內容腳本：取出下一筆待處理並標記為執行中（原子操作）
  CLAIM_NEXT: (msg, sender) => mutate((d) => {
    if (d.run.state !== 'running' || d.run.tabId !== (sender.tab && sender.tab.id)) return { item: null };
    const it = d.queue.find((x) => x.status === 'pending');
    if (!it) return { item: null };
    it.status = 'running';
    it.attempts = (it.attempts || 0) + 1;
    it.startedAt = Date.now();
    it.submittedAt = 0;
    it.error = '';
    it.claimId = crypto.randomUUID();
    return { item: { ...it } };
  }),

  // 只接受同一次嘗試的更新；未確認(unknown)的項目可以被晚到的結果補成完成
  UPDATE_ITEM: (msg) => mutate((d) => {
    const it = findItem(d, msg.id);
    const patch = {};
    for (const [k, v] of Object.entries(msg.patch || {})) if (ITEM_PATCH_KEYS.has(k)) patch[k] = v;
    const sameAttempt = it && claimMatches(it, msg);
    const ok = it && sameAttempt && (it.status === 'running' || (it.status === 'unknown' && patch.status === 'done'));
    if (!ok) return { ignored: true };
    Object.assign(it, patch);
    if (msg.log) addLog(d, msg.log, msg.level);
    return {};
  }),

  // 退回待處理，不計入嘗試次數（暫停、限流、或確定沒有送出時使用）
  UNCLAIM: (msg) => mutate((d) => {
    const it = findItem(d, msg.id);
    if (!it || it.status !== 'running' || !claimMatches(it, msg)) return { ignored: true };
    Object.assign(it, { status: 'pending', attempts: Math.max(0, (it.attempts || 1) - 1), submittedAt: 0, error: msg.reason || '', claimId: '' });
    if (msg.log) addLog(d, msg.log, msg.level);
    return {};
  }),

  ITEM_FAILED: (msg) => mutate((d) => {
    const it = findItem(d, msg.id);
    if (!it || it.status !== 'running' || !claimMatches(it, msg)) return { ignored: true };
    it.claimId = '';
    const canRetry = msg.retryable !== false && (it.attempts || 0) <= d.settings.retries && d.run.state !== 'idle';
    it.error = String(msg.error || '失敗');
    it.finishedAt = Date.now();
    if (canRetry) {
      it.status = 'pending';
      addLog(d, '#' + it.seq + ' 失敗，稍後重試（第 ' + it.attempts + ' 次）：' + it.error, 'warn');
    } else {
      it.status = 'failed';
      addLog(d, '#' + it.seq + ' 失敗：' + it.error, 'error');
    }
    return { willRetry: canRetry };
  }),

  SET_RUN: async (msg) => {
    let tabId = null;
    await mutate((d) => {
      d.run = { ...d.run, ...(msg.patch || {}) };
      if (d.run.state === 'idle') {
        tabId = d.run.tabId;
        releaseRunning(d, '佇列已結束，無法確認結果');
      }
      if (msg.log) addLog(d, msg.log, msg.level);
    });
    if (tabId != null) {
      try { await chrome.alarms.clear('tick'); } catch (e) {}
      await detachDebugger(tabId);
    }
    return {};
  },

  DEBUGGER_PREPARE: async (msg, sender) => {
    const tabId = sender.tab && sender.tab.id;
    if (tabId == null || !FLOW_URL_RE.test(sender.tab.url || '')) throw new Error('不是 Flow 分頁');
    return { attachedNow: await attachDebugger(tabId) };
  },

  // 內容腳本重新載入後，先前追蹤中的項目已無法確認
  // keepIds：重新載入後仍在 Flow 生成中、已被內容腳本重新接手的項目
  RELEASE_ORPHANS: (msg, sender) => mutate((d) => {
    if (d.run.tabId !== (sender.tab && sender.tab.id)) return {};
    const keep = new Set(msg.keepIds || []);
    const saved = d.queue.filter((it) => keep.has(it.id) && it.status === 'running');
    saved.forEach((it) => { it.status = '__keep'; });
    releaseRunning(d, '頁面重新載入，無法確認結果');
    saved.forEach((it) => { it.status = 'running'; });
    if (saved.length) addLog(d, '頁面重新載入，重新接手 ' + saved.length + ' 筆生成中的項目');
    return {};
  }),

  GET_RUNNING: () => mutate((d) => ({ items: d.queue.filter((it) => it.status === 'running') })),

  START: async (msg) => {
    const tabId = Number(msg.tabId);
    const tab = await chrome.tabs.get(tabId);
    if (!FLOW_URL_RE.test(tab.url || '')) throw new Error('請先在這個分頁開啟 Google Flow 專案');
    await mutate((d) => {
      if (d.run.state === 'running') {
        if (d.run.tabId === tabId) return; // 已在執行：只需喚醒
        throw new Error('佇列正在另一個分頁執行，請先停止');
      }
      const resumingSameTab = d.run.state === 'paused' && d.run.tabId === tabId;
      if (d.run.state === 'paused' && !resumingSameTab) throw new Error('佇列在另一個分頁暫停中，請先停止');
      if (!resumingSameTab) releaseRunning(d, '上次執行中斷，無法確認結果');
      d.run = { ...d.run, state: 'running', tabId, projectId: projectOf(tab.url), cooldownUntil: 0, message: '執行中' };
      addLog(d, resumingSameTab ? '繼續執行' : '開始執行（分頁：' + (tab.title || tabId) + '）');
    });
    chrome.alarms.create('tick', { periodInMinutes: 0.5 });
    await ensureContentScript(tabId);
    try { await chrome.tabs.sendMessage(tabId, { type: 'KICK' }); } catch (e) {}
    return {};
  },

  PAUSE: () => mutate((d) => {
    if (d.run.state === 'running') {
      d.run.state = 'paused';
      d.run.message = '已暫停（生成中的項目仍會繼續追蹤）';
      addLog(d, '已暫停');
    }
    return {};
  }),

  STOP: async (msg) => {
    let tabId = null;
    await mutate((d) => {
      tabId = d.run.tabId;
      releaseRunning(d, '已停止；Flow 可能仍在生成');
      d.run = { ...d.run, state: 'idle', cooldownUntil: 0, message: msg.reason || '已停止' };
      addLog(d, msg.reason || '已停止', msg.level || 'info');
    });
    try { await chrome.alarms.clear('tick'); } catch (e) {}
    if (tabId != null) {
      try { await chrome.tabs.sendMessage(tabId, { type: 'STOP' }); } catch (e) {}
      await detachDebugger(tabId);
    }
    return {};
  },

  TRUSTED_CLICK: async (msg, sender) => {
    const tabId = sender.tab && sender.tab.id;
    if (tabId == null || !FLOW_URL_RE.test(sender.tab.url || '')) throw new Error('不是 Flow 分頁');
    const x = Number(msg.x), y = Number(msg.y);
    if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0) throw new Error('座標錯誤');
    await withTimeout(trustedClick(tabId, x, y), 10000, '真實點擊');
    return {};
  },

  // blob: 網址只在 Flow 頁面內有效：交給該分頁的內容腳本讀出內容後再下載
  DOWNLOAD: async (msg, sender) => {
    const d = withDefaults(await chrome.storage.local.get(['settings', 'queue']));
    let url = String(msg.url || '');
    let ext = msg.ext;
    if (!/^(https:|data:|blob:)/i.test(url)) throw new Error('不支援的下載網址');
    if (/^blob:/i.test(url) || msg.fetchViaTab) {
      let mediaId = String(msg.mediaId || '');
      let isVideo = String(ext || '') === 'mp4';
      let project = '';
      for (const it of d.queue) {
        const hit = (it.results || []).find((r) => r.src === url);
        if (hit) { mediaId = mediaId || hit.mediaId || ''; isVideo = !!hit.isVideo; project = hit.projectId || ''; break; }
      }
      const fromTab = sender && sender.tab && FLOW_URL_RE.test(sender.tab.url || '') ? sender.tab.id : null;
      let tabId = fromTab;
      if (tabId == null && msg.tabId != null) {
        const t = await chrome.tabs.get(Number(msg.tabId)).catch(() => null);
        if (!t || !FLOW_URL_RE.test(t.url || '')) throw new Error('指定的分頁不是 Google Flow');
        tabId = t.id;
      }
      if (tabId == null) tabId = await pickFlowTab(project);
      if (tabId == null) throw new Error('這個結果是 Flow 頁面內的暫存網址，請先開啟該 Flow 專案分頁再下載');
      await ensureContentScript(tabId);
      const r = await withTimeout(chrome.tabs.sendMessage(tabId, { type: 'FETCH_MEDIA', src: url, mediaId, isVideo }), 90000, '從 Flow 分頁取得檔案');
      if (!r || !r.ok) throw new Error((r && r.error) || 'Flow 分頁沒有回應');
      url = String(r.dataUrl || r.url || '');
      ext = r.ext || ext;
      // 分頁回傳的內容也要再檢查一次，只接受 https 或 data:
      if (!/^(https:|data:(image|video)\/)/i.test(url)) throw new Error('無法取得檔案內容');
    }
    const folder = safeFolder(d.settings.downloadFolder) || 'FlowQueue';
    const cleanExt = String(ext || '').toLowerCase().replace('jpeg', 'jpg');
    const safeExt = ['png', 'jpg', 'webp', 'gif', 'mp4', 'webm', 'mov'].includes(cleanExt) ? cleanExt : 'jpg';
    const filename = folder + '/' + safeName(msg.name, 120) + '.' + safeExt;
    const downloadId = await chrome.downloads.download({ url, filename, conflictAction: 'uniquify', saveAs: false });
    return { downloadId, filename };
  },

  BRIDGE_TAKEOVER: async (msg, sender) => {
    if (sender && sender.tab) throw new Error('只能從側邊面板接管橋接');
    const b = globalThis.FQBridge;
    if (!b || typeof b.reconnect !== 'function') throw new Error('橋接模組尚未載入');
    const status = await b.reconnect({ takeover: true });
    if (status && status.connected === false && status.lastError) throw new Error('接管失敗：' + status.lastError);
    return { bridge: status || null };
  }
};

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id) return false;
  const h = msg && handlers[msg.type];
  if (!h) return false;
  Promise.resolve()
    .then(() => h(msg, sender))
    .then((r) => sendResponse({ ok: true, ...(r || {}) }))
    .catch((e) => sendResponse({ ok: false, error: String((e && e.message) || e) }));
  return true;
});

// 背景分頁的計時器會被節流；每 30 秒從背景喚醒執行器一次
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== 'tick') return;
  const { run } = await chrome.storage.local.get('run');
  if (!run || run.state === 'idle' || run.tabId == null) { chrome.alarms.clear('tick'); return; }
  try { await ensureContentScript(run.tabId); await chrome.tabs.sendMessage(run.tabId, { type: 'KICK' }); } catch (e) {}
});

// Flow 是單頁應用：離開原本的專案就停止，避免把提示詞送進別的專案
chrome.tabs.onUpdated.addListener(async (tabId, info) => {
  if (!info.url) return;
  const { run } = await chrome.storage.local.get('run');
  if (!run || run.tabId !== tabId || run.state === 'idle') return;
  if (!FLOW_URL_RE.test(info.url) || (run.projectId && projectOf(info.url) !== run.projectId)) {
    await handlers.STOP({ reason: 'Flow 分頁已離開原本的專案，已停止', level: 'warn' });
  }
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  const { run } = await chrome.storage.local.get('run');
  if (run && run.tabId === tabId && run.state !== 'idle') {
    await handlers.STOP({ reason: '目標 Flow 分頁已關閉，已停止', level: 'warn' });
  }
});

// ---------- target tab ----------
async function pickFlowTab(preferProject = '') {
  const ok = (t) => t && FLOW_URL_RE.test(t.url || '') && /\/project\//.test(t.url || '');
  if (preferProject) {
    const same = (await chrome.tabs.query({})).find((t) => ok(t) && projectOf(t.url) === preferProject);
    if (same) return same.id;
  }
  const { run } = await chrome.storage.local.get('run');
  if (run && run.tabId != null) {
    try { const t = await chrome.tabs.get(run.tabId); if (ok(t)) return t.id; } catch (e) {}
  }
  const [active] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (ok(active)) return active.id;
  const any = (await chrome.tabs.query({})).find(ok);
  return any ? any.id : null;
}

// ---------- API for the local bridge (bridge-client.js) ----------
function unwrap(r) {
  if (!r || r.ok === false) throw new Error((r && r.error) || '失敗');
  const { ok, ...rest } = r;
  return rest;
}
const callHandler = async (type, msg = {}) => unwrap(await handlers[type]({ type, ...msg }, { id: chrome.runtime.id })
  .then((r) => ({ ok: true, ...(r || {}) }), (e) => ({ ok: false, error: String((e && e.message) || e) })));
// 配對碼不能透過橋接回傳給 AI 代理，也不能被代理修改
const publicSettings = (s) => { const { bridgeToken, ...rest } = s || {}; return { ...rest, bridgePaired: !!bridgeToken }; };
const BRIDGE_LOCKED_KEYS = new Set(['bridgeEnabled', 'bridgePort', 'bridgeToken']);
const stripItem = (it) => ({ ...it, results: (it.results || []).map((r) => ({ src: r.src, isVideo: r.isVideo })) });

const recentAdds = new Map(); // requestId -> {at, result}：避免代理重試造成重複加入
globalThis.FQ = {
  async call(method, params = {}) {
    params = params && typeof params === 'object' ? params : {};
    switch (method) {
      case 'status': {
        const d = withDefaults(await chrome.storage.local.get([...KEYS, 'bridge']));
        const counts = { total: d.queue.length, pending: 0, running: 0, done: 0, failed: 0, unknown: 0, stopped: 0 };
        for (const it of d.queue) if (it.status in counts) counts[it.status]++;
        const flowTabs = (await chrome.tabs.query({})).filter((t) => FLOW_URL_RE.test(t.url || ''))
          .map((t) => ({ tabId: t.id, title: t.title, url: t.url }));
        return { run: d.run, settings: publicSettings(d.settings), counts, flowTabs, bridge: d.bridge || null };
      }
      case 'list': {
        const { queue = [] } = await chrome.storage.local.get('queue');
        const want = params.status ? new Set([].concat(params.status)) : null;
        const all = want ? queue.filter((it) => want.has(it.status)) : queue;
        const offset = Math.max(0, Number(params.offset) || 0);
        const limit = Math.min(1000, Math.max(1, Number(params.limit) || 100));
        return { items: all.slice(offset, offset + limit).map(stripItem), total: all.length };
      }
      case 'get': {
        const { queue = [] } = await chrome.storage.local.get('queue');
        const it = queue.find((x) => x.id === params.id);
        if (!it) throw new Error('找不到項目：' + params.id);
        return { item: stripItem(it) };
      }
      case 'uploadFile': return callHandler('ADD_FILE', params);
      case 'add': {
        const rid = typeof params.requestId === 'string' ? params.requestId.slice(0, 100) : '';
        // 同步檢查並登記（中間不能有 await），同時到達的重複請求才會共用同一個結果
        if (rid && recentAdds.has(rid)) return recentAdds.get(rid).promise;
        const work = (async () => {
        if (rid) {
          const persisted = (await chrome.storage.session.get('recentAdds')).recentAdds || {};
          if (persisted[rid] && Date.now() - persisted[rid].at < 600000) return { ...persisted[rid].result, deduped: true };
        }
        const refs = Array.isArray(params.refs) ? [...params.refs] : [];
        for (const f of Array.isArray(params.files) ? params.files : []) {
          const r = await callHandler('ADD_FILE', f);
          refs.push({ type: 'file', fileId: r.fileId, name: r.name, mime: r.mime });
        }
        return callHandler('ADD_ITEMS', { prompts: params.prompts, refs, toTop: !!params.toTop });
        })();
        if (!rid) return work;
        const now = Date.now();
        for (const [k, v] of recentAdds) if (now - v.at > 600000) recentAdds.delete(k);
        recentAdds.set(rid, { at: now, promise: work });
        try {
          const result = await work;
          const persisted = (await chrome.storage.session.get('recentAdds')).recentAdds || {};
          for (const k of Object.keys(persisted)) if (now - persisted[k].at > 600000) delete persisted[k];
          persisted[rid] = { at: now, result };
          await chrome.storage.session.set({ recentAdds: persisted });
          return result;
        } catch (e) {
          recentAdds.delete(rid);
          throw e;
        }
      }
      case 'start': {
        const tabId = params.tabId != null ? Number(params.tabId) : await pickFlowTab();
        if (tabId == null) throw new Error('沒有開啟的 Google Flow 專案分頁');
        await callHandler('START', { tabId });
        return { tabId };
      }
      case 'pause': return callHandler('PAUSE');
      case 'stop': return callHandler('STOP', { reason: params.reason });
      // 預設不重試「未確認」：那些可能已經在 Flow 生成過，重送會重複扣點數
      case 'retry': return callHandler('RETRY_ITEMS', { ids: params.ids, statuses: params.statuses || ['failed', 'stopped'] });
      case 'remove': return callHandler('REMOVE_ITEMS', { ids: params.ids || [] });
      case 'clear': return callHandler('CLEAR', { mode: params.mode || 'done' });
      case 'move': return callHandler('MOVE_ITEM', params);
      case 'settings': {
        const patch = {};
        for (const [k, v] of Object.entries(params.patch || {})) if (!BRIDGE_LOCKED_KEYS.has(k)) patch[k] = v;
        if (Object.keys(patch).length) return { settings: publicSettings((await callHandler('SET_SETTINGS', { patch })).settings) };
        return { settings: publicSettings(withDefaults(await chrome.storage.local.get(['settings'])).settings) };
      }
      case 'logs': {
        const { logs = [] } = await chrome.storage.local.get('logs');
        return { logs: logs.slice(-Math.min(300, Math.max(1, Number(params.limit) || 50))) };
      }
      case 'listAssets': return callHandler('LIST_ASSETS', params);
      default: throw new Error('未知的方法：' + method);
    }
  }
};
