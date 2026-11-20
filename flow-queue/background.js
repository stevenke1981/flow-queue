// Flow Queue — service worker
// 單一寫入者：所有佇列 / 設定 / 執行狀態的修改都經過這裡，避免側邊面板與內容腳本互相覆蓋。

const FLOW_URL_RE = /^https:\/\/(?:flow\.google(?:\.com)?\/|labs\.google\/fx\/)/i;
const projectOf = (url) => { const m = String(url || '').match(/\/project\/([A-Za-z0-9_-]+)/); return m ? m[1] : ''; };
const ITEM_PATCH_KEYS = new Set(['status', 'submittedAt', 'finishedAt', 'results', 'error']);
const withTimeout = (p, ms, what) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(what + ' 逾時')), ms))]);

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
  splitMode: 'blank'     // blank：以空行分隔；line：每行一個
});
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
    const prompts = (Array.isArray(msg.prompts) ? msg.prompts : [])
      .map((p) => String(p || '').trim())
      .filter(Boolean);
    const now = Date.now();
    const items = prompts.map((prompt) => ({
      id: crypto.randomUUID(),
      seq: ++d.meta.seq,
      prompt,
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
    if (items.length) addLog(d, '已加入 ' + items.length + ' 筆提示詞');
    return { added: items.length };
  }),

  REMOVE_ITEMS: (msg) => mutate((d) => {
    const ids = new Set(msg.ids || []);
    const before = d.queue.length;
    d.queue = d.queue.filter((it) => !ids.has(it.id) || it.status === 'running');
    if (before - d.queue.length < ids.size) addLog(d, '執行中的項目無法刪除，請先停止', 'warn');
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
    const ids = msg.ids ? new Set(msg.ids) : null;
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

  CLEAR: (msg) => mutate((d) => {
    const mode = msg.mode || 'done';
    const keep = (it) => {
      if (it.status === 'running') return true;
      if (mode === 'all') return false;
      if (mode === 'failed') return !['failed', 'unknown', 'stopped'].includes(it.status);
      return it.status !== 'done';
    };
    const before = d.queue.length;
    d.queue = d.queue.filter(keep);
    return { removed: before - d.queue.length };
  }),

  CLEAR_LOGS: () => mutate((d) => { d.logs = []; return {}; }),

  SET_SETTINGS: (msg) => mutate((d) => {
    const s = { ...d.settings, ...(msg.patch || {}) };
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
    d.settings = s;
    return { settings: s };
  }),

  LOG: (msg) => mutate((d) => { addLog(d, msg.text, msg.level); return {}; }),

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

  DOWNLOAD: async (msg) => {
    const d = withDefaults(await chrome.storage.local.get(['settings']));
    const folder = safeFolder(d.settings.downloadFolder) || 'FlowQueue';
    const filename = folder + '/' + safeName(msg.name, 120) + '.' + (String(msg.ext || 'jpg').replace(/[^a-z0-9]/gi, '').slice(0, 5) || 'jpg');
    const downloadId = await chrome.downloads.download({ url: msg.url, filename, conflictAction: 'uniquify', saveAs: false });
    return { downloadId, filename };
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
