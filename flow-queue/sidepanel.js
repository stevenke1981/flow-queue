(() => {
'use strict';
const FLOW_RE = /^https:\/\/(?:flow\.google(?:\.com)?|labs\.google)\//i;
const STATUS_LABEL = { pending: '待處理', running: '執行中', done: '完成', failed: '失敗', unknown: '未確認', stopped: '已停止' };
const RUN_LABEL = { idle: '閒置', running: '執行中', paused: '已暫停' };
const $ = (id) => document.getElementById(id);
const DEFAULTS = { maxConcurrent: 1, delayMin: 3, delayMax: 8, timeoutMin: 10, retries: 1, cooldownSec: 120, trustedClick: true, autoDownload: false, downloadFolder: 'FlowQueue', splitMode: 'blank' };

let state = { queue: [], settings: { ...DEFAULTS }, run: { state: 'idle', tabId: null, cooldownUntil: 0, message: '' }, logs: [] };
let editingId = null;
let tabTitleFor = null;

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

let toastTimer;
function toast(msg, ok) {
  const t = $('toast');
  t.textContent = msg;
  t.className = 'toast' + (ok ? ' ok' : '');
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, ok ? 2500 : 6000);
}

async function send(msg) {
  try {
    const r = await chrome.runtime.sendMessage(msg);
    if (!r || !r.ok) {
      toast((r && r.error) || '操作失敗');
      return null;
    }
    return r;
  } catch (e) {
    toast(String((e && e.message) || e));
    return null;
  }
}

function splitPrompts(text, mode) {
  const t = String(text || '').replace(/\r\n?/g, '\n');
  const parts = mode === 'line' ? t.split('\n') : t.split(/\n\s*\n/);
  return parts.map((s) => s.trim()).filter(Boolean);
}
function updateCount() {
  $('count').textContent = '將加入 ' + splitPrompts($('input').value, $('splitMode').value).length + ' 筆';
}

async function addItems(toTop) {
  const prompts = splitPrompts($('input').value, $('splitMode').value);
  if (!prompts.length) { toast('沒有可加入的提示詞'); return; }
  const msg = { type: 'ADD_ITEMS', prompts };
  if (toTop) msg.toTop = true;
  const r = await send(msg);
  if (r) {
    $('input').value = '';
    updateCount();
    toast('已加入 ' + (r.added != null ? r.added : prompts.length) + ' 筆', true);
  }
}

async function findFlowTab() {
  const ok = (t) => t && FLOW_RE.test(t.url || '');
  const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (ok(active)) return active;
  const inWin = (await chrome.tabs.query({ currentWindow: true })).find(ok);
  if (inWin) return inWin;
  return (await chrome.tabs.query({})).find(ok) || null;
}
async function onStart() {
  // 暫停後繼續：沿用原本的分頁，不重新挑選
  if (state.run.state === 'paused' && state.run.tabId != null) {
    await send({ type: 'START', tabId: state.run.tabId });
    return;
  }
  let tab = null;
  try { tab = await findFlowTab(); } catch (e) {}
  if (!tab) { toast('請先開啟 Google Flow 專案頁面'); return; }
  await send({ type: 'START', tabId: tab.id });
}

function renderHeader() {
  const run = state.run;
  const chip = $('chip');
  chip.textContent = RUN_LABEL[run.state] || run.state;
  chip.className = 'chip ' + run.state;
  $('runMsg').textContent = run.message || '';
  tickCooldown();
  const tt = $('tabTitle');
  if (run.tabId != null && run.state !== 'idle') {
    if (tabTitleFor !== run.tabId) {
      tabTitleFor = run.tabId;
      tt.hidden = false;
      tt.textContent = '目標分頁：…';
      chrome.tabs.get(run.tabId).then((t) => {
        if (tabTitleFor === run.tabId) tt.textContent = '目標分頁：' + (t.title || t.url || run.tabId);
      }).catch(() => { tt.textContent = '目標分頁已不存在'; });
    }
  } else {
    tabTitleFor = null;
    tt.hidden = true;
  }
  $('start').textContent = run.state === 'paused' ? '繼續' : '開始';
  $('start').disabled = run.state === 'running';
  $('pause').disabled = run.state !== 'running';
  $('stop').disabled = run.state === 'idle';
}
function tickCooldown() {
  const c = $('cooldown');
  const left = Math.ceil(((state.run.cooldownUntil || 0) - Date.now()) / 1000);
  if (left > 0) { c.hidden = false; c.textContent = '冷卻中 ' + left + ' 秒'; }
  else c.hidden = true;
}

function renderStats() {
  const cnt = { pending: 0, running: 0, done: 0, failed: 0 };
  for (const it of state.queue) {
    const s = it.status === 'unknown' || it.status === 'stopped' ? 'failed' : it.status;
    if (s in cnt) cnt[s]++;
  }
  const total = state.queue.length;
  $('sTotal').textContent = total;
  $('sPending').textContent = cnt.pending;
  $('sRunning').textContent = cnt.running;
  $('sDone').textContent = cnt.done;
  $('sFailed').textContent = cnt.failed;
  $('barFill').style.width = (total ? Math.round(cnt.done / total * 100) : 0) + '%';
}

function actBtn(label, fn, title) {
  const b = el('button', 'btn small', label);
  if (title) b.title = title;
  b.addEventListener('click', fn);
  return b;
}

function buildItem(it) {
  const row = el('div', 'item');
  const head = el('div', 'item-head');
  head.appendChild(el('span', 'seq', '#' + it.seq));
  head.appendChild(el('span', 'badge st-' + it.status, STATUS_LABEL[it.status] || it.status));
  if ((it.attempts || 0) > 1) head.appendChild(el('span', 'muted small', '嘗試 ' + it.attempts + ' 次'));
  row.appendChild(head);

  if (editingId === it.id) {
    const box = el('div', 'edit');
    const ta = el('textarea');
    ta.value = it.prompt;
    box.appendChild(ta);
    const acts = el('div', 'acts');
    acts.appendChild(actBtn('儲存', async () => {
      const v = ta.value.trim();
      if (!v) { toast('提示詞不可為空'); return; }
      const r = await send({ type: 'EDIT_ITEM', id: it.id, prompt: v });
      if (r) closeEditor();
    }));
    acts.appendChild(actBtn('取消', closeEditor));
    box.appendChild(acts);
    row.appendChild(box);
    setTimeout(() => ta.focus(), 0);
    return row;
  }

  const p = el('div', 'prompt', it.prompt);
  p.title = it.prompt;
  row.appendChild(p);
  if (it.error) row.appendChild(el('div', 'err', it.error));
  if (it.status === 'done' && it.results && it.results.length) {
    const res = el('div', 'res');
    res.appendChild(el('span', 'muted', '結果 ' + it.results.length + ' 個：'));
    it.results.forEach((r, i) => {
      const a = el('a', null, (r.isVideo ? '影片' : '圖片') + (i + 1));
      a.title = r.src;
      a.addEventListener('click', () => chrome.tabs.create({ url: r.src }));
      res.appendChild(a);
    });
    row.appendChild(res);
  }
  const acts = el('div', 'acts');
  acts.appendChild(actBtn('↑', () => send({ type: 'MOVE_ITEM', id: it.id, delta: -1 }), '上移'));
  acts.appendChild(actBtn('↓', () => send({ type: 'MOVE_ITEM', id: it.id, delta: 1 }), '下移'));
  acts.appendChild(actBtn('置頂', () => send({ type: 'MOVE_ITEM', id: it.id, to: 'top' })));
  if (it.status !== 'running') acts.appendChild(actBtn('編輯', () => { editingId = it.id; renderList(true); }));
  if (['failed', 'unknown', 'stopped', 'done'].includes(it.status))
    acts.appendChild(actBtn('重試', () => send({ type: 'RETRY_ITEMS', ids: [it.id] })));
  acts.appendChild(actBtn('刪除', () => send({ type: 'REMOVE_ITEMS', ids: [it.id] })));
  row.appendChild(acts);
  return row;
}

function closeEditor() {
  editingId = null;
  renderList(true);
}

function renderList(force) {
  if (editingId && !force) return;
  if (editingId && !state.queue.some((i) => i.id === editingId)) editingId = null;
  const list = $('list');
  const top = list.scrollTop;
  const frag = document.createDocumentFragment();
  for (const it of state.queue) frag.appendChild(buildItem(it));
  list.replaceChildren(frag);
  list.scrollTop = top;
  $('empty').hidden = state.queue.length > 0;
}

const SETTING_IDS = ['maxConcurrent', 'delayMin', 'delayMax', 'timeoutMin', 'retries', 'cooldownSec', 'downloadFolder'];
const SETTING_CHK = ['trustedClick', 'autoDownload'];
function renderSettings() {
  const s = state.settings;
  for (const k of SETTING_IDS) { const e = $(k); if (document.activeElement !== e) e.value = s[k]; }
  for (const k of SETTING_CHK) $(k).checked = !!s[k];
  if (document.activeElement !== $('splitMode')) $('splitMode').value = s.splitMode;
  updateCount();
}

function fmtTime(t) {
  const d = new Date(t);
  const p = (n) => String(n).padStart(2, '0');
  return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
}
function renderLogs() {
  const box = $('logs');
  const frag = document.createDocumentFragment();
  for (let i = state.logs.length - 1; i >= 0; i--) {
    const l = state.logs[i];
    const d = el('div', 'lv-' + (['warn', 'error'].includes(l.level) ? l.level : 'info'));
    d.appendChild(el('span', 't', fmtTime(l.t)));
    d.appendChild(document.createTextNode(l.text));
    frag.appendChild(d);
  }
  box.replaceChildren(frag);
}

function renderAll() {
  renderHeader(); renderStats(); renderList(); renderSettings(); renderLogs();
}

async function load() {
  const d = await chrome.storage.local.get(['queue', 'settings', 'run', 'logs']);
  if (Array.isArray(d.queue)) state.queue = d.queue;
  if (d.settings) state.settings = { ...DEFAULTS, ...d.settings };
  if (d.run) state.run = { ...state.run, ...d.run };
  if (Array.isArray(d.logs)) state.logs = d.logs;
  renderAll();
}
let pending = null;
chrome.storage.onChanged.addListener((c, area) => {
  if (area !== 'local') return;
  let any = false;
  if (c.queue) { state.queue = c.queue.newValue || []; any = true; }
  if (c.settings) { state.settings = { ...DEFAULTS, ...(c.settings.newValue || {}) }; any = true; }
  if (c.run) { state.run = { state: 'idle', tabId: null, cooldownUntil: 0, message: '', ...(c.run.newValue || {}) }; any = true; }
  if (c.logs) { state.logs = c.logs.newValue || []; any = true; }
  if (!any || pending) return;
  pending = requestAnimationFrame(() => { pending = null; renderAll(); });
});

async function saveSetting(patch) {
  const r = await send({ type: 'SET_SETTINGS', patch });
  if (r && r.settings) { state.settings = { ...DEFAULTS, ...r.settings }; renderSettings(); }
}

$('input').addEventListener('input', updateCount);
$('input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); addItems(false); }
});
$('splitMode').addEventListener('change', () => { updateCount(); saveSetting({ splitMode: $('splitMode').value }); });
$('add').addEventListener('click', () => addItems(false));
$('addTop').addEventListener('click', () => addItems(true));
$('file').addEventListener('change', async (e) => {
  const f = e.target.files && e.target.files[0];
  e.target.value = '';
  if (!f) return;
  try {
    const text = await f.text();
    const ta = $('input');
    ta.value = ta.value ? ta.value.replace(/\s+$/, '') + (state.settings.splitMode === 'line' ? '\n' : '\n\n') + text : text;
    updateCount();
  } catch (err) { toast('讀取檔案失敗：' + err.message); }
});
$('start').addEventListener('click', onStart);
$('pause').addEventListener('click', () => send({ type: 'PAUSE' }));
$('stop').addEventListener('click', () => send({ type: 'STOP' }));
$('clrDone').addEventListener('click', () => send({ type: 'CLEAR', mode: 'done' }));
$('retryFailed').addEventListener('click', () => send({ type: 'RETRY_ITEMS', statuses: ['failed'] }));
$('clrFailed').addEventListener('click', () => send({ type: 'CLEAR', mode: 'failed' }));
$('clrAll').addEventListener('click', () => {
  if (confirm('確定要清空全部佇列嗎？（執行中的項目會保留）')) send({ type: 'CLEAR', mode: 'all' });
});
$('copyFailed').addEventListener('click', async () => {
  const txt = state.queue.filter((i) => i.status === 'failed').map((i) => i.prompt).join('\n\n');
  if (!txt) { toast('沒有失敗的提示詞'); return; }
  try { await navigator.clipboard.writeText(txt); toast('已複製失敗提示詞', true); }
  catch (e) { toast('複製失敗：' + e.message); }
});
$('clrLogs').addEventListener('click', () => send({ type: 'CLEAR_LOGS' }));
for (const k of SETTING_IDS) {
  $(k).addEventListener('change', () => {
    const v = $(k).value;
    if (k !== 'downloadFolder' && v === '') { renderSettings(); return; }
    saveSetting({ [k]: k === 'downloadFolder' ? v : Number(v) });
  });
}
for (const k of SETTING_CHK) $(k).addEventListener('change', () => saveSetting({ [k]: $(k).checked }));

setInterval(tickCooldown, 1000);
load();
})();
