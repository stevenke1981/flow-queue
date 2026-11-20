(() => {
'use strict';
const FLOW_RE = /^https:\/\/(?:flow\.google(?:\.com)?|labs\.google)\//i;
const PROJECT_RE = /\/project\//;                 // 與 background pickFlowTab 一致
const FLOW_HOME = 'https://labs.google/fx/tools/flow';
const STATUS_LABEL = { pending: '待處理', running: '執行中', done: '完成', failed: '失敗', unknown: '未確認', stopped: '未確認' };
const RUN_LABEL = { idle: '閒置', running: '執行中', paused: '已暫停' };
const UNKNOWN_SET = new Set(['unknown', 'stopped']); // stopped 為舊版狀態，視同未確認
const FILTERS = { all: null, pending: ['pending'], running: ['running'], done: ['done'], failed: ['failed'], unknown: ['unknown', 'stopped'] };
const FILTER_LABEL = { all: '全部', pending: '待處理', running: '執行中', done: '完成', failed: '失敗', unknown: '未確認' };
const CAT_LABEL = { All: '全部', Images: '圖片', Uploads: '上傳', Videos: '影片', Characters: '角色' };
const $ = (id) => document.getElementById(id);
const DEFAULTS = { maxConcurrent: 1, delayMin: 3, delayMax: 8, timeoutMin: 10, retries: 1, cooldownSec: 120, trustedClick: true, autoDownload: false, downloadFolder: 'FlowQueue', splitMode: 'blank', clearIngredients: true, bridgeEnabled: false, bridgePort: 17345, bridgeToken: '' };
const MAX_FILE = 10 * 1024 * 1024; // 與 background.js MAX_FILE_BYTES 一致（DESIGN §7）
const TOKEN_RE = /^[0-9a-f]{64}$/i;
const STRIP_CELLS_MAX = 120;       // 超過就改成按比例的分段條
const UNDO_MS = 5000;
const BANNER_KEY = 'fq.dismissedRunMsg';

let state = { queue: [], settings: { ...DEFAULTS }, run: { state: 'idle', tabId: null, cooldownUntil: 0, message: '' }, logs: [] };
let bridge = null;
let loaded = false;
let matFiles = [];                 // [{ file, url }]
const tokens = { chars: [], assets: [] }; // [{ name, category? }]
let picker = { kind: null, category: null, titles: [] };
let editingId = null;
let focusEditor = false;
let tabTitleFor = null;
let filter = 'all';
let activeTab = 'queue';
let logsSeenT = 0;
let composerOpen = null;           // null = 自動；true/false = 使用者手動
const expanded = new Set();        // 展開全文的列
const pendingDeletes = new Set();  // 刪除後 5 秒內可復原
let deleteTimer = null;

// ---------------------------------------------------------------- dom helpers
function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}
function setText(node, v) { v = String(v); if (node.textContent !== v) node.textContent = v; }
function setHidden(node, h) { h = !!h; if (node.hidden !== h) node.hidden = h; }
function setAttr(node, k, v) { v = String(v); if (node.getAttribute(k) !== v) node.setAttribute(k, v); }

const SVGNS = 'http://www.w3.org/2000/svg';
const ICONS = {
  up: 'M8 12.5v-9M4.5 7 8 3.5 11.5 7',
  down: 'M8 3.5v9M4.5 9 8 12.5 11.5 9',
  top: 'M3.5 2.5h9M8 13.5V6M4.5 9.5 8 6l3.5 3.5',
  edit: 'M2.5 13.5h3l7.2-7.2a1.4 1.4 0 0 0 0-2l-1-1a1.4 1.4 0 0 0-2 0L2.5 10.5v3z',
  retry: 'M13 8a5 5 0 1 1-1.6-3.7M13.2 2.6v2.9h-2.9',
  trash: 'M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8.5h5.8l.6-8.5',
  download: 'M8 2.5v8M4.5 7 8 10.5 11.5 7M3 13.5h10',
  x: 'M4.5 4.5l7 7M11.5 4.5l-7 7',
  check: 'M3.5 8.5l3 3 6-7',
  person: 'M8 7.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5zM3 13.5c.6-2.4 2.6-3.6 5-3.6s4.4 1.2 5 3.6',
  asset: 'M2.5 3.5h11v9h-11zM2.5 10.5l3-3 2.5 2.5 2-2 3.5 3.5',
  file: 'M10 4.5 5.3 9.2a1.5 1.5 0 0 0 2.1 2.1l5-5a3 3 0 0 0-4.2-4.2l-5 5a4.5 4.5 0 0 0 6.4 6.4l4-4',
  play: 'M5.5 3.5v9l7-4.5z',
  alert: 'M8 2.5 14 13H2zM8 6.5v3M8 11.3v.2',
  info: 'M8 2.5a5.5 5.5 0 1 0 0 11 5.5 5.5 0 0 0 0-11zM8 7.5v3.5M8 5.3v.2',
  s_pending: 'M8 2.5a5.5 5.5 0 1 0 0 11 5.5 5.5 0 0 0 0-11z',
  s_running: 'M8 2.5a5.5 5.5 0 1 1-5.5 5.5',
  s_done: 'M8 2.5a5.5 5.5 0 1 0 0 11 5.5 5.5 0 0 0 0-11zM5.5 8.2l1.8 1.8 3.3-3.6',
  s_failed: 'M8 2.5a5.5 5.5 0 1 0 0 11 5.5 5.5 0 0 0 0-11zM8 5.2v3.3M8 10.6v.2',
  s_unknown: 'M8 2.5a5.5 5.5 0 1 0 0 11 5.5 5.5 0 0 0 0-11zM6.4 6.4a1.7 1.7 0 1 1 2.2 1.6c-.4.2-.6.5-.6.9v.3M8 10.8v.2',
  s_stopped: 'M8 2.5a5.5 5.5 0 1 0 0 11 5.5 5.5 0 0 0 0-11zM6.4 6.4a1.7 1.7 0 1 1 2.2 1.6c-.4.2-.6.5-.6.9v.3M8 10.8v.2'
};
function icon(name, cls) {
  const s = document.createElementNS(SVGNS, 'svg');
  s.setAttribute('viewBox', '0 0 16 16');
  s.setAttribute('aria-hidden', 'true');
  s.setAttribute('class', 'ico' + (cls ? ' ' + cls : ''));
  const p = document.createElementNS(SVGNS, 'path');
  p.setAttribute('d', ICONS[name] || '');
  s.appendChild(p);
  return s;
}
function iconBtn(name, label, fn, act, extraCls) {
  const b = el('button', 'icon-btn' + (extraCls ? ' ' + extraCls : ''));
  b.type = 'button';
  b.setAttribute('aria-label', label);
  b.title = label;
  if (act) b.dataset.act = act;
  b.appendChild(icon(name));
  b.addEventListener('click', fn);
  return b;
}

// ---------------------------------------------------------------- toasts
// 兩個常駐的 live region：#toast（成功，role=status，自動消失）與 #alertToast（錯誤，role=alert，需手動關閉）
let okTimer = null;
let okOnExpire = null;
function clearToast(box) {
  if (box.id === 'toast') { clearTimeout(okTimer); okTimer = null; okOnExpire = null; }
  box.replaceChildren();
}
function fillToast(box, msg, opts) {
  const nodes = [el('span', 'toast-msg', msg)];
  if (opts.action) {
    const a = el('button', 'toast-act', opts.action.label);
    a.type = 'button';
    a.addEventListener('click', () => { clearToast(box); opts.action.fn(); });
    nodes.push(a);
  }
  nodes.push(iconBtn('x', '關閉提示', () => clearToast(box)));
  box.replaceChildren(...nodes);
}
function toast(msg, ok, opts) {
  opts = opts || {};
  if (ok) {
    const box = $('toast');
    clearToast(box);
    fillToast(box, msg, opts);
    okTimer = setTimeout(() => clearToast(box), opts.ms || 3000);
  } else {
    fillToast($('alertToast'), msg, opts);
  }
}

async function send(msg, quiet) {
  try {
    const r = await chrome.runtime.sendMessage(msg);
    if (!r || !r.ok) {
      if (!quiet) toast((r && r.error) || '操作失敗');
      return quiet ? { ok: false, error: (r && r.error) || '操作失敗' } : null;
    }
    return r;
  } catch (e) {
    const m = String((e && e.message) || e);
    if (!quiet) toast(m);
    return quiet ? { ok: false, error: m } : null;
  }
}

// ---------------------------------------------------------------- composer
function splitPrompts(text, mode) {
  const t = String(text || '').replace(/\r\n?/g, '\n');
  const parts = mode === 'line' ? t.split('\n') : t.split(/\n\s*\n/);
  return parts.map((s) => s.trim()).filter(Boolean);
}
function matTotal() { return tokens.chars.length + tokens.assets.length + matFiles.length; }
function updateCount() {
  const n = splitPrompts($('input').value, $('splitMode').value).length;
  const m = matTotal();
  setText($('count'), '將加入 ' + n + ' 筆' + (n && m ? '，每筆附 ' + m + ' 個素材' : ''));
}
function parseNames(text) {
  return String(text || '').split(/[,，、\n]/).map((s) => s.trim()).filter(Boolean);
}
function updateMatCount() {
  const n = matTotal();
  const b = $('matCount');
  setText(b, n);
  b.dataset.zero = n ? '0' : '1';
  updateCount();
}
function readBase64(file) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => { const s = String(fr.result || ''); const i = s.indexOf(','); resolve(i >= 0 ? s.slice(i + 1) : s); };
    fr.onerror = () => reject(fr.error || new Error('讀取失敗'));
    fr.readAsDataURL(file);
  });
}

// token inputs：類別在建立 token 時就記下來，之後切換下拉選單不影響已加入的素材
const TOKEN_UI = {
  chars: { wrap: 'charTokens', input: 'charInput', icon: 'person', label: '角色', field: 'charField', btn: 'loadChars' },
  assets: { wrap: 'assetTokens', input: 'assetInput', icon: 'asset', label: '素材', field: 'assetField', btn: 'loadAssets' }
};
const hasToken = (kind, name) => tokens[kind].some((t) => t.name === name);
function addToken(kind, name, category) {
  if (hasToken(kind, name)) return false;
  tokens[kind].push(kind === 'assets' ? { name, category: category || 'All' } : { name });
  return true;
}
function commitToken(kind) {
  const input = $(TOKEN_UI[kind].input);
  const names = parseNames(input.value);
  if (!names.length) { if (input.value) input.value = ''; return; }
  input.value = '';
  const cat = kind === 'assets' ? $('matCat').value : null;
  let added = false;
  for (const n of names) if (addToken(kind, n, cat)) added = true;
  if (added) renderTokens(kind);
}
function removeToken(kind, name) {
  const before = tokens[kind].length;
  tokens[kind] = tokens[kind].filter((t) => t.name !== name);
  if (tokens[kind].length !== before) renderTokens(kind);
}
function renderTokens(kind) {
  const ui = TOKEN_UI[kind];
  const wrap = $(ui.wrap);
  const input = $(ui.input);
  wrap.querySelectorAll('.token').forEach((n) => n.remove());
  for (const tk of tokens[kind]) {
    const t = el('span', 'token');
    t.appendChild(icon(ui.icon));
    const nm = el('span', 'token-name', tk.name);
    nm.title = tk.name;
    t.appendChild(nm);
    if (tk.category && tk.category !== 'All') t.appendChild(el('span', 'token-cat', CAT_LABEL[tk.category] || tk.category));
    const x = el('button', 'token-x');
    x.type = 'button';
    x.setAttribute('aria-label', '移除' + ui.label + '：' + tk.name);
    x.appendChild(icon('x'));
    x.addEventListener('click', () => { removeToken(kind, tk.name); input.focus(); });
    t.appendChild(x);
    wrap.insertBefore(t, input);
  }
  if (picker.kind === kind) syncPickerPressed();
  updateMatCount();
}
function setupTokens(kind) {
  const ui = TOKEN_UI[kind];
  const wrap = $(ui.wrap);
  const input = $(ui.input);
  wrap.addEventListener('mousedown', (e) => { if (e.target === wrap) { e.preventDefault(); input.focus(); } });
  input.addEventListener('keydown', (e) => {
    if (e.isComposing || e.keyCode === 229) return; // 中文輸入法選字中，不攔截 Enter
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault();
      commitToken(kind);
    } else if (e.key === 'Backspace' && !input.value && tokens[kind].length) {
      e.preventDefault();
      tokens[kind].pop();
      renderTokens(kind);
    }
  });
  input.addEventListener('input', (e) => {
    if (e.isComposing) return;
    if (/[,，、\n]/.test(input.value)) commitToken(kind);
  });
  input.addEventListener('blur', () => commitToken(kind));
}

// 從 Flow 載入清單：結果顯示在對應欄位正下方
function pickerFilterMatch(title) {
  const q = $('pickerFilter').value.trim().toLowerCase();
  return !q || title.toLowerCase().includes(q);
}
function renderPicker() {
  const box = $('assetChips');
  const frag = document.createDocumentFragment();
  let shown = 0;
  for (const title of picker.titles) {
    if (!pickerFilterMatch(title)) continue;
    shown++;
    const c = el('button', 'pchip');
    c.type = 'button';
    c.dataset.title = title;
    c.title = title;
    c.appendChild(icon('check'));
    c.appendChild(el('span', null, title));
    c.setAttribute('aria-pressed', String(hasToken(picker.kind, title)));
    c.addEventListener('click', () => {
      const kind = picker.kind;
      if (hasToken(kind, title)) removeToken(kind, title);
      else { addToken(kind, title, picker.category); renderTokens(kind); }
    });
    frag.appendChild(c);
  }
  if (!shown) frag.appendChild(el('p', 'picker-empty', picker.titles.length ? '沒有符合篩選的項目' : 'Flow 沒有符合的素材'));
  box.replaceChildren(frag);
}
function syncPickerPressed() {
  for (const c of $('assetChips').querySelectorAll('.pchip')) {
    c.setAttribute('aria-pressed', String(hasToken(picker.kind, c.dataset.title)));
  }
}
function closePicker() {
  picker = { kind: null, category: null, titles: [] };
  $('picker').hidden = true;
  $('assetChips').replaceChildren();
}
async function loadAssets(kind) {
  const ui = TOKEN_UI[kind];
  const category = kind === 'chars' ? 'Characters' : $('matCat').value;
  const btn = $(ui.btn);
  const label = btn.textContent;
  $(ui.field).after($('picker'));
  picker = { kind, category, titles: [] };
  $('pickerTitle').textContent = kind === 'chars' ? '角色清單' : '素材清單（' + (CAT_LABEL[category] || category) + '）';
  $('pickerFilter').hidden = true;
  $('assetChips').replaceChildren();
  $('pickerLoading').hidden = false;
  $('picker').hidden = false;
  btn.disabled = true;
  btn.textContent = '載入中…';
  btn.setAttribute('aria-busy', 'true');
  let r;
  try { r = await send({ type: 'LIST_ASSETS', category }); }
  finally {
    btn.disabled = false;
    btn.textContent = label;
    btn.removeAttribute('aria-busy');
    $('pickerLoading').hidden = true;
  }
  if (picker.kind !== kind || picker.category !== category) return; // 期間已關閉或改載別的清單
  if (!r) { closePicker(); btn.focus(); return; }
  const seen = new Set();
  for (const a of (Array.isArray(r.assets) ? r.assets : [])) {
    const title = a && typeof a.title === 'string' ? a.title.trim() : '';
    if (title) seen.add(title);
  }
  picker.titles = Array.from(seen);
  $('pickerTitle').textContent = kind === 'chars'
    ? '點選加入角色（' + seen.size + '）'
    : '點選加入素材（' + (CAT_LABEL[category] || category) + '，' + seen.size + '）';
  $('pickerFilter').value = '';
  $('pickerFilter').hidden = seen.size < 10;
  renderPicker();
  const first = !$('pickerFilter').hidden ? $('pickerFilter') : $('assetChips').querySelector('.pchip');
  (first || $('pickerClose')).focus();
}

// 參考圖
function addRefFiles(list) {
  let added = 0;
  for (const f of Array.from(list || [])) {
    if (!f.type || !f.type.startsWith('image/')) { toast('不是圖片：' + (f.name || '剪貼簿內容')); continue; }
    if (f.size > MAX_FILE) { toast('圖片超過 10 MB：' + f.name); continue; }
    if (matFiles.some((m) => m.file.name === f.name && m.file.size === f.size && m.file.lastModified === f.lastModified)) continue;
    matFiles.push({ file: f, url: URL.createObjectURL(f) });
    added++;
  }
  if (added) {
    composerOpen = true;
    renderComposer();
    $('mat').open = true;
    renderThumbs();
  }
  return added;
}
function renderThumbs() {
  const box = $('matThumbs');
  const frag = document.createDocumentFragment();
  matFiles.forEach((m) => {
    const t = el('figure', 'thumb');
    const img = el('img');
    img.src = m.url; img.title = m.file.name; img.alt = m.file.name;
    const x = el('button', 'token-x');
    x.type = 'button';
    x.setAttribute('aria-label', '移除參考圖：' + m.file.name);
    x.appendChild(icon('x'));
    x.addEventListener('click', () => {
      URL.revokeObjectURL(m.url);
      matFiles = matFiles.filter((o) => o !== m);
      renderThumbs();
      $('drop').focus();
    });
    t.appendChild(img); t.appendChild(x);
    frag.appendChild(t);
  });
  box.replaceChildren(frag);
  updateMatCount();
}
function clearMat() {
  tokens.chars = []; tokens.assets = [];
  $('charInput').value = ''; $('assetInput').value = '';
  for (const m of matFiles) URL.revokeObjectURL(m.url);
  matFiles = [];
  closePicker();
  renderTokens('chars'); renderTokens('assets');
  renderThumbs();
}

async function addItems(toTop) {
  commitToken('chars'); commitToken('assets');
  const prompts = splitPrompts($('input').value, $('splitMode').value);
  if (!prompts.length) { toast('沒有可加入的提示詞'); $('input').focus(); return; }
  const refs = [];
  for (const t of tokens.chars) refs.push({ type: 'character', name: t.name });
  for (const t of tokens.assets) refs.push({ type: 'asset', name: t.name, category: t.category || 'All' });
  const addBtn = $('add');
  const btns = [addBtn, $('addTop')];
  btns.forEach((b) => { b.disabled = true; });
  addBtn.setAttribute('aria-busy', 'true');
  let r = null;
  try {
    const total = matFiles.length;
    for (let i = 0; i < total; i++) {
      const f = matFiles[i].file;
      setText(addBtn, '上傳參考圖 ' + (i + 1) + '/' + total + '…');
      if (!f.type || !f.type.startsWith('image/')) { toast('不是圖片：' + f.name); return; }
      if (f.size > MAX_FILE) { toast('圖片超過 10 MB：' + f.name); return; }
      let b64;
      try { b64 = await readBase64(f); } catch (e) { toast('讀取參考圖失敗：' + f.name); return; }
      const fr = await send({ type: 'ADD_FILE', name: f.name, mime: f.type, base64: b64 });
      if (!fr) return;
      refs.push({ type: 'file', fileId: fr.fileId, name: fr.name || f.name, mime: fr.mime || f.type });
    }
    setText(addBtn, '加入中…');
    const msg = { type: 'ADD_ITEMS', prompts, refs };
    if (toTop) msg.toTop = true;
    r = await send(msg);
  } finally {
    btns.forEach((b) => { b.disabled = false; });
    addBtn.removeAttribute('aria-busy');
    setText(addBtn, '加入佇列');
  }
  if (r) {
    $('input').value = '';
    if (!$('matKeep').checked) clearMat();
    updateCount();
    toast('已加入 ' + (r.added != null ? r.added : prompts.length) + ' 筆' + (toTop ? '（插到最前）' : ''), true);
  }
}

async function importTxt(f) {
  try {
    const text = await f.text();
    const ta = $('input');
    ta.value = ta.value ? ta.value.replace(/\s+$/, '') + ($('splitMode').value === 'line' ? '\n' : '\n\n') + text : text;
    composerOpen = true;
    renderComposer();
    updateCount();
    toast('已匯入 ' + f.name, true);
  } catch (err) { toast('讀取檔案失敗：' + err.message); }
}

// 執行中自動收合成一行，避免佇列被擠到下面；有草稿或焦點在裡面時不收
function composerIsOpen() {
  if (state.run.state !== 'running') return true;
  if (composerOpen != null) return composerOpen;
  return !!($('input').value.trim() || matTotal() || $('composerBody').contains(document.activeElement));
}
function renderComposer() {
  const running = state.run.state === 'running';
  if (!running) composerOpen = null;
  const open = composerIsOpen();
  setHidden($('composerToggle'), !running);
  setHidden($('composerBody'), !open);
  setAttr($('composerToggle'), 'aria-expanded', open);
  setText($('composerToggleLabel'), open ? '收合新增區' : '新增提示詞');
}

// ---------------------------------------------------------------- run control
async function findFlowTab(requireProject) {
  const ok = (t) => t && FLOW_RE.test(t.url || '') && (!requireProject || PROJECT_RE.test(t.url || ''));
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
  try { tab = await findFlowTab(true); } catch (e) {}
  if (!tab) { toast('請先開啟 Google Flow 專案頁面', false, { action: { label: '開啟 Flow', fn: openFlow } }); return; }
  await send({ type: 'START', tabId: tab.id });
}
async function onStop() {
  const c = counts();
  if (c.running && !confirm('有 ' + c.running + ' 筆正在生成，停止後會標為「未確認」。確定要停止嗎？')) return;
  await send({ type: 'STOP' });
}
async function openFlow() {
  try {
    const t = (await findFlowTab(true)) || (await findFlowTab(false));
    if (t) {
      await chrome.tabs.update(t.id, { active: true });
      if (t.windowId != null && chrome.windows) chrome.windows.update(t.windowId, { focused: true }).catch(() => {});
    } else {
      await chrome.tabs.create({ url: FLOW_HOME });
    }
  } catch (e) { toast('無法開啟 Flow：' + ((e && e.message) || e)); }
}

// ---------------------------------------------------------------- header
function renderHeader(c) {
  const run = state.run;
  const rs = RUN_LABEL[run.state] ? run.state : 'idle';
  const pill = $('runPill');
  if (pill.className !== 'pill run-' + rs) pill.className = 'pill run-' + rs;
  setText($('runLabel'), RUN_LABEL[run.state] || run.state);
  const msg = run.message || '';
  setText($('runMsg'), run.state !== 'idle' && msg && msg !== RUN_LABEL[run.state] && !msg.startsWith('冷卻中') ? msg : '');
  tickCooldown();
  const tt = $('tabTitle');
  if (run.tabId != null && run.state !== 'idle') {
    if (tabTitleFor !== run.tabId) {
      tabTitleFor = run.tabId;
      tt.hidden = false;
      tt.textContent = '目標分頁：…';
      chrome.tabs.get(run.tabId).then((t) => {
        if (tabTitleFor === run.tabId) { tt.textContent = '目標分頁：' + (t.title || t.url || run.tabId); tt.title = t.url || ''; }
      }).catch(() => { tt.textContent = '目標分頁已不存在'; });
    }
  } else {
    tabTitleFor = null;
    setHidden(tt, true);
  }
  const s = state.settings;
  const dl = $('dlState');
  setText(dl, s.autoDownload ? '自動下載：開（' + (s.downloadFolder || 'FlowQueue') + '）' : '自動下載：關');
  dl.dataset.on = s.autoDownload ? '1' : '0';

  const running = run.state === 'running';
  const focused = document.activeElement;
  setText($('startLabel'), run.state === 'paused' ? '繼續' : '開始');
  setHidden($('start'), running);
  setHidden($('pause'), !running);
  const noWork = run.state !== 'paused' && c.pending === 0;
  $('start').disabled = noWork;
  $('start').title = noWork ? '佇列沒有待處理的項目' : '';
  $('stop').disabled = run.state === 'idle';
  // 鍵盤使用者按下開始／暫停後，焦點移到接手的那顆按鈕
  if (focused === $('start') && running) $('pause').focus();
  else if ((focused === $('pause') && !running) || (focused === $('stop') && run.state === 'idle')) {
    if (!$('start').disabled) $('start').focus(); else $('input').focus();
  }
  renderBanner();
  renderComposer();
}
function tickCooldown() {
  const cd = $('cooldown');
  const left = Math.ceil(((state.run.cooldownUntil || 0) - Date.now()) / 1000);
  if (left > 0 && state.run.state !== 'idle') { setHidden(cd, false); setText(cd, '限流冷卻，' + left + ' 秒後繼續'); }
  else setHidden(cd, true);
}

// 閒置時的 run.message（停止原因、完成）以可關閉的橫幅顯示；警告用 role=alert
let bannerSig = '';
function bannerKind(msg) {
  if (msg === '已停止') return 'info';
  if (/全部處理完成|已完成/.test(msg)) return 'ok';
  return 'warn';
}
function renderBanner() {
  const run = state.run;
  if (run.state !== 'idle') { try { localStorage.removeItem(BANNER_KEY); } catch (e) {} }
  let dismissed = null;
  try { dismissed = localStorage.getItem(BANNER_KEY); } catch (e) {}
  const msg = run.state === 'idle' ? String(run.message || '') : '';
  const show = !!msg && msg !== dismissed;
  const kind = show ? bannerKind(msg) : '';
  const sig = show ? kind + '\u0001' + msg : '';
  if (sig === bannerSig) return;
  bannerSig = sig;
  const box = $('runBanner');
  if (!show) { box.replaceChildren(); setHidden(box, true); return; }
  const b = el('div', 'banner banner-' + kind);
  b.setAttribute('role', kind === 'warn' ? 'alert' : 'status');
  b.appendChild(icon(kind === 'warn' ? 'alert' : kind === 'ok' ? 'check' : 'info'));
  b.appendChild(el('span', 'banner-msg', msg));
  b.appendChild(iconBtn('x', '關閉訊息', () => {
    try { localStorage.setItem(BANNER_KEY, msg); } catch (e) {}
    renderBanner();
    if (!$('start').disabled) $('start').focus();
  }));
  box.replaceChildren(b);
  setHidden(box, false);
}

// ---------------------------------------------------------------- counts / strip / bulk
function liveQueue() { return pendingDeletes.size ? state.queue.filter((i) => !pendingDeletes.has(i.id)) : state.queue; }
function counts() {
  const c = { total: 0, pending: 0, running: 0, done: 0, failed: 0, unknown: 0, files: 0 };
  for (const it of liveQueue()) {
    c.total++;
    if (UNKNOWN_SET.has(it.status)) c.unknown++;
    else if (it.status in c) c[it.status]++;
    if (it.status === 'done' && Array.isArray(it.results)) c.files += it.results.filter((r) => r && r.src).length;
  }
  return c;
}
let stripSig = '';
function renderStats(c) {
  const q = liveQueue();
  setText($('sTotal'), c.total);
  setText($('sDone'), c.done);
  const tf = $('tallyFailed');
  setHidden(tf, !c.failed);
  setText(tf, c.failed + ' 失敗');
  setAttr(tf, 'aria-label', '篩選 ' + c.failed + ' 筆失敗');
  const tu = $('tallyUnknown');
  setHidden(tu, !c.unknown);
  setText(tu, c.unknown + ' 未確認');
  setAttr(tu, 'aria-label', '篩選 ' + c.unknown + ' 筆未確認');
  setText($('tabQueueCount'), c.total);
  setText($('fcAll'), c.total);
  setText($('fcPending'), c.pending);
  setText($('fcRunning'), c.running);
  setText($('fcDone'), c.done);
  setText($('fcFailed'), c.failed);
  setText($('fcUnknown'), c.unknown);

  const strip = $('strip');
  setAttr(strip, 'aria-valuemax', c.total);
  setAttr(strip, 'aria-valuenow', c.done);
  setAttr(strip, 'aria-valuetext', c.total
    ? '完成 ' + c.done + ' / ' + c.total + '，執行中 ' + c.running + '，失敗 ' + c.failed + '，未確認 ' + c.unknown + '，待處理 ' + c.pending
    : '佇列是空的');
  const dense = c.total > STRIP_CELLS_MAX;
  const sig = !c.total ? 'e' : dense
    ? [c.done, c.failed, c.unknown, c.running, c.pending].join(',')
    : q.map((i) => i.status).join(',');
  if (sig !== stripSig) {
    stripSig = sig;
    const frag = document.createDocumentFragment();
    if (!c.total) frag.appendChild(el('span', 'c-empty'));
    else if (!dense) for (const it of q) frag.appendChild(el('span', 'c-' + (UNKNOWN_SET.has(it.status) ? 'unknown' : it.status)));
    else {
      for (const [k, n] of [['done', c.done], ['failed', c.failed], ['unknown', c.unknown], ['running', c.running], ['pending', c.pending]]) {
        if (!n) continue;
        const s = el('span', 'c-' + k);
        s.style.flexGrow = String(n);
        frag.appendChild(s);
      }
    }
    strip.classList.toggle('dense', dense);
    strip.replaceChildren(frag);
  }

  // 批次操作只顯示有對象的按鈕，數字與上方計數一致
  setHidden($('filters'), !c.total);
  setHidden($('bulk'), !c.total);
  setHidden($('retryFailed'), !c.failed); setText($('nRetry'), c.failed);
  setHidden($('copyFailed'), !c.failed); setText($('nCopy'), c.failed);
  setHidden($('dlDone'), !c.files); setText($('nDl'), c.files);
  setHidden($('clrDone'), !c.done); setText($('nClrDone'), c.done);
  setHidden($('clrFailed'), !(c.failed + c.unknown)); setText($('nClrFailed'), c.failed + c.unknown);
}

// ---------------------------------------------------------------- downloads
function slug(s) {
  return String(s || '').replace(/[\\/:*?"<>|\r\n\t]+/g, ' ').trim().replace(/\s+/g, '_').replace(/^[_.]+|[_.]+$/g, '').slice(0, 30);
}
function dlName(it, i, n) {
  const s = slug(it.prompt);
  return String(it.seq).padStart(4, '0') + (s ? '_' + s : '') + (n > 1 ? '_' + (i + 1) : '');
}
async function downloadItems(items) {
  let ok = 0;
  const errs = [];
  for (const it of items) {
    const rs = Array.isArray(it.results) ? it.results : [];
    for (let i = 0; i < rs.length; i++) {
      const r = rs[i];
      if (!r || !r.src) continue;
      const res = await send({ type: 'DOWNLOAD', url: r.src, name: dlName(it, i, rs.length), ext: r.isVideo ? 'mp4' : 'jpg' }, true);
      if (res && res.ok) ok++; else errs.push('#' + it.seq + '：' + (res && res.error));
    }
  }
  if (ok) toast('已開始下載 ' + ok + ' 個檔案到「' + (state.settings.downloadFolder || 'FlowQueue') + '」', true);
  if (errs.length) toast(errs.length + ' 個檔案下載失敗（' + errs[0] + '）');
}

// ---------------------------------------------------------------- queue list
const rowCache = new Map(); // id -> { sig, node }
function itemSig(it) {
  return [it.seq, it.status, it.prompt, it.attempts || 0, it.error || '',
    JSON.stringify(it.refs || []),
    (it.results || []).map((r) => (r && r.isVideo ? 'v' : 'i') + (r && r.src)).join('\n')].join('\u0001');
}

function buildEditor(it, row) {
  const box = el('div', 'edit');
  const ta = el('textarea');
  ta.value = it.prompt;
  ta.setAttribute('aria-label', '編輯 #' + it.seq + ' 的提示詞');
  box.appendChild(ta);
  const acts = el('div', 'edit-acts');
  acts.appendChild(el('span', 'edit-hint', 'Ctrl+Enter 儲存，Esc 取消'));
  const save = async () => {
    const v = ta.value.trim();
    if (!v) { toast('提示詞不可為空'); return; }
    const r = await send({ type: 'EDIT_ITEM', id: it.id, prompt: v });
    if (r) closeEditor(it.id);
  };
  const cancel = el('button', 'btn btn-s', '取消');
  cancel.type = 'button';
  cancel.addEventListener('click', () => closeEditor(it.id));
  const ok = el('button', 'btn btn-s btn-primary', '儲存');
  ok.type = 'button';
  ok.addEventListener('click', save);
  ta.addEventListener('keydown', (e) => {
    if (e.isComposing) return;
    if (e.key === 'Escape') { e.preventDefault(); closeEditor(it.id); }
    else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); save(); }
  });
  acts.appendChild(cancel); acts.appendChild(ok);
  box.appendChild(acts);
  row.appendChild(box);
}

function retryItem(it) {
  if (it.status !== 'failed' &&
      !confirm('#' + it.seq + ' 可能已經生成過，重送會再扣點數。確定要重試嗎？')) return;
  send({ type: 'RETRY_ITEMS', ids: [it.id] });
}

// 刪除：先從畫面移除，5 秒內可復原，之後才真正送出 REMOVE_ITEMS
function flushDeletes() {
  clearTimeout(deleteTimer);
  deleteTimer = null;
  if (!pendingDeletes.size) return;
  const ids = Array.from(pendingDeletes);
  pendingDeletes.clear();
  send({ type: 'REMOVE_ITEMS', ids }).then(() => renderAll());
}
function deleteItem(it) {
  pendingDeletes.add(it.id);
  clearTimeout(deleteTimer);
  deleteTimer = setTimeout(flushDeletes, UNDO_MS);
  const n = pendingDeletes.size;
  toast(n > 1 ? '已刪除 ' + n + ' 筆' : '已刪除 #' + it.seq, true, {
    ms: UNDO_MS,
    action: { label: '復原', fn: undoDeletes }
  });
  renderAll();
}
function undoDeletes() {
  clearTimeout(deleteTimer);
  deleteTimer = null;
  const first = Array.from(pendingDeletes)[0];
  pendingDeletes.clear();
  renderAll();
  const c = first && rowCache.get(first);
  const b = c && c.node.isConnected && c.node.querySelector('[data-act="trash"]');
  if (b) b.focus();
}

function buildItem(it) {
  const row = el('div', 'row st-' + it.status);
  row.setAttribute('role', 'listitem');
  row.dataset.id = it.id;
  const label = STATUS_LABEL[it.status] || it.status;
  row.setAttribute('aria-label', '#' + it.seq + ' ' + label);

  const head = el('div', 'row-head');
  head.appendChild(el('span', 'row-seq', '#' + it.seq));
  const st = el('span', 'row-status');
  st.appendChild(icon(ICONS['s_' + it.status] ? 's_' + it.status : 's_pending'));
  st.appendChild(el('span', null, label));
  head.appendChild(st);
  if ((it.attempts || 0) > 1) head.appendChild(el('span', 'row-try', '第 ' + it.attempts + ' 次嘗試'));

  const editing = editingId === it.id;
  const hasResults = Array.isArray(it.results) && it.results.some((r) => r && r.src);
  if (!editing) {
    const acts = el('div', 'row-acts');
    const n = ' #' + it.seq;
    // 只有待處理的項目會影響送出順序，排序按鈕只放在這些列上（也讓窄面板的一列放得下）
    if (it.status === 'pending') {
      acts.appendChild(iconBtn('up', '上移' + n, () => send({ type: 'MOVE_ITEM', id: it.id, delta: -1 }), 'up'));
      acts.appendChild(iconBtn('down', '下移' + n, () => send({ type: 'MOVE_ITEM', id: it.id, delta: 1 }), 'down'));
      acts.appendChild(iconBtn('top', '移到最前' + n, () => send({ type: 'MOVE_ITEM', id: it.id, to: 'top' }), 'top'));
    }
    if (it.status !== 'running') acts.appendChild(iconBtn('edit', '編輯' + n, () => openEditor(it.id), 'edit'));
    if (it.status === 'done' && hasResults) acts.appendChild(iconBtn('download', '下載' + n + ' 的結果', () => downloadItems([it]), 'download'));
    if (['failed', 'unknown', 'stopped', 'done'].includes(it.status))
      acts.appendChild(iconBtn('retry', '重試' + n, () => retryItem(it), 'retry'));
    if (it.status !== 'running') acts.appendChild(iconBtn('trash', '刪除' + n, () => deleteItem(it), 'trash', 'danger'));
    head.appendChild(acts);
  }
  row.appendChild(head);

  if (editing) { buildEditor(it, row); return row; }

  const p = el('p', 'row-prompt' + (expanded.has(it.id) ? ' is-open' : ''), it.prompt);
  p.title = '點一下展開／收合全文';
  p.addEventListener('click', () => {
    const sel = window.getSelection && window.getSelection();
    if (sel && String(sel)) return; // 正在選取文字時不切換
    if (expanded.has(it.id)) expanded.delete(it.id); else expanded.add(it.id);
    p.classList.toggle('is-open', expanded.has(it.id));
  });
  row.appendChild(p);

  if (Array.isArray(it.refs) && it.refs.length) {
    const rc = el('div', 'row-refs');
    for (const r of it.refs) {
      const kind = r.type === 'character' ? ['person', '角色'] : r.type === 'file' ? ['file', '參考圖'] : ['asset', '素材'];
      const c = el('span', 'ref');
      c.title = kind[1] + '：' + (r.name || '') + (r.type === 'asset' && r.category && r.category !== 'All' ? '（' + (CAT_LABEL[r.category] || r.category) + '）' : '');
      c.appendChild(icon(kind[0]));
      c.appendChild(el('span', null, r.name || ''));
      rc.appendChild(c);
    }
    row.appendChild(rc);
  }
  if (it.error) {
    const e = el('div', 'row-err');
    e.appendChild(icon('alert'));
    e.appendChild(el('span', null, it.error));
    row.appendChild(e);
  }
  if (hasResults) {
    const res = el('div', 'row-results');
    it.results.forEach((r, i) => {
      if (!r || !r.src) return;
      const kindName = r.isVideo ? '影片' : '圖片';
      const b = el('button', 'res');
      b.type = 'button';
      b.title = r.src;
      b.setAttribute('aria-label', '開啟結果 ' + (i + 1) + '（' + kindName + '）');
      if (r.isVideo) {
        const v = el('span', 'res-video');
        v.appendChild(icon('play', 'fill'));
        v.appendChild(el('span', null, '影片'));
        b.appendChild(v);
      } else {
        const img = el('img');
        img.alt = '';
        img.loading = 'lazy';
        img.decoding = 'async';
        img.addEventListener('error', () => { img.replaceWith(icon('asset')); }, { once: true });
        img.src = r.src;
        b.appendChild(img);
      }
      if (it.results.length > 1) b.appendChild(el('span', 'res-n', String(i + 1)));
      b.addEventListener('click', () => chrome.tabs.create({ url: r.src }));
      res.appendChild(b);
    });
    row.appendChild(res);
  }
  return row;
}

function openEditor(id) {
  editingId = id;
  focusEditor = true;
  renderList();
}
function closeEditor(id) {
  if (id && editingId !== id) return;
  editingId = null;
  renderList();
  const c = id && rowCache.get(id);
  const b = c && c.node.isConnected && c.node.querySelector('[data-act="edit"]');
  if (b) b.focus();
}

// 只重建內容有變動的列，其餘節點原地沿用（圖片不會重新載入、焦點不會跑掉）
function renderList() {
  const q = liveQueue();
  if (editingId && !q.some((i) => i.id === editingId && i.status !== 'running')) editingId = null;
  const want = FILTERS[filter];
  const items = want ? q.filter((i) => want.includes(i.status)) : q;
  const list = $('list');

  const ae = document.activeElement;
  const inList = ae && ae !== list && list.contains(ae);
  const aeRow = inList ? ae.closest('[data-id]') : null;
  const aeInfo = aeRow ? { id: aeRow.dataset.id, act: ae.dataset.act || '' } : null;
  let sel = null;
  if (inList && ae.tagName === 'TEXTAREA') sel = [ae.selectionStart, ae.selectionEnd];

  const nodes = [];
  const alive = new Set();
  for (const it of items) {
    const sig = editingId === it.id ? '\u0002edit' : itemSig(it);
    let c = rowCache.get(it.id);
    if (!c || c.sig !== sig) {
      c = { sig, node: buildItem(it) };
      rowCache.set(it.id, c);
    }
    nodes.push(c.node);
    alive.add(it.id);
  }
  for (const id of Array.from(rowCache.keys())) if (!alive.has(id)) rowCache.delete(id);
  for (const id of Array.from(expanded)) if (!state.queue.some((i) => i.id === id)) expanded.delete(id);

  const keep = new Set(nodes);
  for (const ch of Array.from(list.children)) if (!keep.has(ch)) ch.remove();
  nodes.forEach((n, i) => {
    const cur = list.children[i];
    if (cur !== n) list.insertBefore(n, cur || null);
  });

  if (inList) {
    if (ae.isConnected && document.activeElement !== ae) {
      ae.focus({ preventScroll: true });
      if (sel) try { ae.setSelectionRange(sel[0], sel[1]); } catch (e) {}
    } else if (!ae.isConnected && aeInfo) {
      const c = rowCache.get(aeInfo.id);
      const target = c && c.node.isConnected &&
        ((aeInfo.act && c.node.querySelector('[data-act="' + aeInfo.act + '"]')) || c.node.querySelector('button'));
      if (target) target.focus({ preventScroll: true });
      else list.focus({ preventScroll: true });
    }
  }
  if (focusEditor && editingId) {
    focusEditor = false;
    const c = rowCache.get(editingId);
    const ta = c && c.node.querySelector('textarea');
    if (ta) { ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); }
  }

  const empty = q.length === 0;
  setHidden($('empty'), !(loaded && empty));
  const fe = $('filterEmpty');
  setHidden(fe, empty || items.length > 0);
  if (!fe.hidden) setText(fe, '沒有「' + FILTER_LABEL[filter] + '」的項目');
}

function setFilter(f) {
  if (!(f in FILTERS)) return;
  filter = f;
  for (const b of $('filters').querySelectorAll('.fchip')) b.setAttribute('aria-pressed', String(b.dataset.f === f));
  renderList();
}
function jumpToFilter(f) {
  if (activeTab !== 'queue') selectTab('queue');
  setFilter(f);
  const target = f === 'failed' && !$('retryFailed').hidden ? $('retryFailed') : $('filters').querySelector('[data-f="' + f + '"]');
  if (target) target.focus();
}

// ---------------------------------------------------------------- settings
const SETTING_IDS = ['maxConcurrent', 'delayMin', 'delayMax', 'timeoutMin', 'retries', 'cooldownSec', 'downloadFolder', 'bridgePort'];
const SETTING_CHK = ['trustedClick', 'autoDownload', 'clearIngredients', 'bridgeEnabled'];
function renderSettings() {
  const s = state.settings;
  for (const k of SETTING_IDS) { const e = $(k); if (document.activeElement !== e && e.value !== String(s[k])) e.value = s[k]; }
  for (const k of SETTING_CHK) { if ($(k).checked !== !!s[k]) $(k).checked = !!s[k]; }
  const tk = $('bridgeToken');
  if (document.activeElement !== tk && tk.value !== (s.bridgeToken || '')) { tk.value = s.bridgeToken || ''; validateTokenField(); }
  if (document.activeElement !== $('splitMode') && $('splitMode').value !== s.splitMode) $('splitMode').value = s.splitMode;
  updateCount();
  renderBridge();
}

let bridgeSig = '';
function renderBridge() {
  const s = state.settings;
  const b = bridge;
  let kind, text;
  if (!s.bridgeEnabled) { kind = 'off'; text = '未啟用：AI 代理無法操作佇列'; }
  else if (!s.bridgeToken) { kind = 'warn'; text = '請貼上配對碼後才會連線'; }
  else if (b && b.connected) { kind = 'ok'; text = '已連線' + (b.port ? '（埠 ' + b.port + '）' : ''); }
  else { kind = 'err'; text = '未連線' + (b && b.lastError ? '：' + b.lastError : '，請確認已在終端機啟動橋接程式'); }
  const at = b && b.at && (kind === 'ok' || kind === 'err') ? '更新於 ' + fmtTime(b.at) : '';
  const sig = kind + '\u0001' + text + '\u0001' + at;
  if (sig === bridgeSig) return; // 只在真的有變化時才更新 live region
  bridgeSig = sig;
  const box = $('bridgeStatus');
  box.dataset.kind = kind;
  const dot = el('span', 'bdot');
  dot.setAttribute('aria-hidden', 'true');
  const nodes = [dot, el('span', null, text)];
  if (at) nodes.push(el('span', 'bridge-at', at));
  box.replaceChildren(...nodes);
  setHidden($('bridgeTabDot'), !(kind === 'err' || kind === 'warn'));
}

function validateTokenField() {
  const inp = $('bridgeToken');
  const v = inp.value.trim();
  const bad = !!v && !TOKEN_RE.test(v);
  setAttr(inp, 'aria-invalid', bad);
  const err = $('tokenErr');
  setText(err, bad ? '配對碼需為 64 個 0–9、a–f 字元（目前 ' + v.length + ' 個）' : '');
  setHidden(err, !bad);
  return !bad;
}

async function saveSetting(patch) {
  const r = await send({ type: 'SET_SETTINGS', patch });
  if (r && r.settings) { state.settings = { ...DEFAULTS, ...r.settings }; renderSettings(); renderHeader(counts()); }
  return r;
}

// ---------------------------------------------------------------- logs
function fmtTime(t) {
  const d = new Date(t);
  const p = (n) => String(n).padStart(2, '0');
  return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
}
let logsSig = '';
function renderLogs() {
  const logs = state.logs;
  const last = logs.length ? logs[logs.length - 1] : null;
  if (activeTab !== 'logs') {
    const fresh = logs.some((l) => l.t > logsSeenT && (l.level === 'warn' || l.level === 'error'));
    setHidden($('logDot'), !fresh);
    return; // 不在畫面上就不重建
  }
  logsSeenT = last ? last.t : logsSeenT;
  setHidden($('logDot'), true);
  const sig = logs.length + ':' + (last ? last.t + last.text : '');
  if (sig === logsSig) return;
  logsSig = sig;
  const box = $('logs');
  const frag = document.createDocumentFragment();
  for (let i = logs.length - 1; i >= 0; i--) {
    const l = logs[i];
    const d = el('div', 'log lv-' + (['warn', 'error'].includes(l.level) ? l.level : 'info'));
    d.appendChild(el('span', 'log-t', fmtTime(l.t)));
    d.appendChild(el('span', null, l.text));
    frag.appendChild(d);
  }
  box.replaceChildren(frag);
  setHidden($('logsEmpty'), logs.length > 0);
}

// ---------------------------------------------------------------- tabs
const TABS = ['queue', 'settings', 'logs'];
function selectTab(name, focus) {
  activeTab = name;
  for (const t of TABS) {
    const tab = $('tab-' + t);
    const on = t === name;
    tab.setAttribute('aria-selected', String(on));
    tab.tabIndex = on ? 0 : -1;
    $('panel-' + t).hidden = !on;
  }
  if (focus) $('tab-' + name).focus();
  if (name === 'logs') renderLogs();
  window.scrollTo(0, 0);
}

// ---------------------------------------------------------------- data flow
function renderAll() {
  const c = counts();
  renderStats(c); renderHeader(c); renderList(); renderSettings(); renderLogs();
}

async function load() {
  try {
    const d = await chrome.storage.local.get(['queue', 'settings', 'run', 'logs', 'bridge']);
    bridge = d.bridge || null;
    if (Array.isArray(d.queue)) state.queue = d.queue;
    if (d.settings) state.settings = { ...DEFAULTS, ...d.settings };
    if (d.run) state.run = { ...state.run, ...d.run };
    if (Array.isArray(d.logs)) state.logs = d.logs;
    const last = state.logs[state.logs.length - 1];
    logsSeenT = last ? last.t : 0;
  } catch (e) {
    toast('讀取佇列失敗：' + ((e && e.message) || e) + '。請關閉面板後重新開啟');
  }
  loaded = true;
  renderAll();
}
let pending = null;
chrome.storage.onChanged.addListener((c, area) => {
  if (area !== 'local') return;
  let any = false;
  if (c.queue) { state.queue = c.queue.newValue || []; any = true; }
  if (c.settings) { state.settings = { ...DEFAULTS, ...(c.settings.newValue || {}) }; any = true; }
  if (c.run) { state.run = { state: 'idle', tabId: null, cooldownUntil: 0, message: '', ...(c.run.newValue || {}) }; any = true; }
  if (c.bridge) { bridge = c.bridge.newValue || null; any = true; }
  if (c.logs) { state.logs = c.logs.newValue || []; any = true; }
  if (!any || pending) return;
  pending = requestAnimationFrame(() => { pending = null; renderAll(); });
});

// ---------------------------------------------------------------- events
$('input').addEventListener('input', updateCount);
$('input').addEventListener('keydown', (e) => {
  if (e.isComposing) return;
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); addItems(e.shiftKey); }
});
$('splitMode').addEventListener('change', () => { updateCount(); saveSetting({ splitMode: $('splitMode').value }); });
$('add').addEventListener('click', () => addItems(false));
$('addTop').addEventListener('click', () => addItems(true));
$('importTxt').addEventListener('click', () => $('file').click());
$('file').addEventListener('change', (e) => {
  const f = e.target.files && e.target.files[0];
  e.target.value = '';
  if (f) importTxt(f);
});
$('composerToggle').addEventListener('click', () => {
  composerOpen = !composerIsOpen();
  renderComposer();
  if (composerOpen) $('input').focus();
});

setupTokens('chars');
setupTokens('assets');
$('loadChars').addEventListener('click', () => loadAssets('chars'));
$('loadAssets').addEventListener('click', () => loadAssets('assets'));
$('matCat').addEventListener('change', () => { if (picker.kind === 'assets') closePicker(); });
$('pickerFilter').addEventListener('input', renderPicker);
$('pickerClose').addEventListener('click', () => {
  const kind = picker.kind;
  closePicker();
  if (kind) $(TOKEN_UI[kind].input).focus();
});

const drop = $('drop');
drop.addEventListener('click', () => $('matFiles').click());
drop.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); $('matFiles').click(); }
});
$('matFiles').addEventListener('change', (e) => {
  const files = Array.from(e.target.files || []);
  e.target.value = '';
  addRefFiles(files);
});
const hasFiles = (e) => !!(e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files'));
for (const type of ['dragenter', 'dragover']) {
  drop.addEventListener(type, (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    drop.classList.add('is-over');
  });
}
drop.addEventListener('dragleave', (e) => { if (!drop.contains(e.relatedTarget)) drop.classList.remove('is-over'); });
drop.addEventListener('drop', (e) => {
  e.preventDefault();
  e.stopPropagation();
  drop.classList.remove('is-over');
  const n = addRefFiles(e.dataTransfer.files);
  if (n) toast('已加入 ' + n + ' 張參考圖', true);
});
// 面板其他地方：圖片當參考圖、.txt 匯入提示詞；避免拖放檔案時面板被導向該檔案
document.addEventListener('dragover', (e) => { if (hasFiles(e)) e.preventDefault(); });
document.addEventListener('drop', (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  const files = Array.from(e.dataTransfer.files || []);
  const txt = files.find((f) => f.type === 'text/plain' || /\.txt$/i.test(f.name));
  const imgs = files.filter((f) => f.type && f.type.startsWith('image/'));
  if (activeTab !== 'queue') selectTab('queue');
  if (txt) importTxt(txt);
  if (imgs.length) { const n = addRefFiles(imgs); if (n) toast('已加入 ' + n + ' 張參考圖', true); }
  if (!txt && !imgs.length) toast('只接受圖片或 .txt 檔');
});
document.addEventListener('paste', (e) => {
  if (activeTab !== 'queue' || !e.clipboardData) return;
  const t = e.target;
  const editable = t && (t.isContentEditable || t.tagName === 'TEXTAREA' || t.tagName === 'INPUT');
  if (editable && Array.from(e.clipboardData.types || []).includes('text/plain')) return; // 文字照常貼上
  const imgs = Array.from(e.clipboardData.files || []).filter((f) => f.type && f.type.startsWith('image/'));
  if (!imgs.length) return;
  e.preventDefault();
  const n = addRefFiles(imgs);
  if (n) toast('已從剪貼簿加入 ' + n + ' 張參考圖', true);
});

$('start').addEventListener('click', onStart);
$('pause').addEventListener('click', () => send({ type: 'PAUSE' }));
$('stop').addEventListener('click', onStop);
$('tallyFailed').addEventListener('click', () => jumpToFilter('failed'));
$('tallyUnknown').addEventListener('click', () => jumpToFilter('unknown'));
$('dlState').addEventListener('click', () => { selectTab('settings'); $('autoDownload').focus(); });

$('filters').addEventListener('click', (e) => {
  const b = e.target.closest('.fchip');
  if (b) setFilter(b.dataset.f);
});
$('openFlow').addEventListener('click', openFlow);
$('focusInput').addEventListener('click', () => $('input').focus());

$('clrDone').addEventListener('click', () => send({ type: 'CLEAR', mode: 'done' }));
$('retryFailed').addEventListener('click', async () => {
  const r = await send({ type: 'RETRY_ITEMS', statuses: ['failed'] });
  if (r && r.retried != null) toast('已重新排入 ' + r.retried + ' 筆', true);
});
$('clrFailed').addEventListener('click', () => {
  const c = counts();
  if (!confirm('清除 ' + c.failed + ' 筆失敗與 ' + c.unknown + ' 筆未確認的項目？未確認的項目可能已經生成。')) return;
  send({ type: 'CLEAR', mode: 'failed' });
});
$('clrAll').addEventListener('click', () => {
  if (confirm('確定要清空全部佇列嗎？（執行中的項目會保留）')) send({ type: 'CLEAR', mode: 'all' });
});
$('copyFailed').addEventListener('click', async () => {
  const txt = liveQueue().filter((i) => i.status === 'failed').map((i) => i.prompt).join('\n\n');
  if (!txt) { toast('沒有失敗的提示詞'); return; }
  try { await navigator.clipboard.writeText(txt); toast('已複製失敗提示詞', true); }
  catch (e) { toast('複製失敗：' + e.message); }
});
$('dlDone').addEventListener('click', () => {
  const items = liveQueue().filter((i) => i.status === 'done' && Array.isArray(i.results) && i.results.some((r) => r && r.src));
  const n = counts().files;
  if (n > 20 && !confirm('將下載 ' + n + ' 個檔案到「' + (state.settings.downloadFolder || 'FlowQueue') + '」，確定嗎？')) return;
  downloadItems(items);
});
$('clrLogs').addEventListener('click', () => send({ type: 'CLEAR_LOGS' }));

for (const t of TABS) $('tab-' + t).addEventListener('click', () => selectTab(t));
document.querySelector('.tabs').addEventListener('keydown', (e) => {
  const i = TABS.indexOf(activeTab);
  let j = null;
  if (e.key === 'ArrowRight') j = (i + 1) % TABS.length;
  else if (e.key === 'ArrowLeft') j = (i + TABS.length - 1) % TABS.length;
  else if (e.key === 'Home') j = 0;
  else if (e.key === 'End') j = TABS.length - 1;
  if (j == null) return;
  e.preventDefault();
  selectTab(TABS[j], true);
});

for (const k of SETTING_IDS) {
  $(k).addEventListener('change', async () => {
    const v = $(k).value;
    if (k !== 'downloadFolder' && v === '') { renderSettings(); return; }
    if (k === 'bridgePort') {
      const n = Number(v);
      if (!Number.isInteger(n) || n < 1024 || n > 65535) { toast('橋接埠需介於 1024–65535'); renderSettings(); return; }
    }
    const want = k === 'downloadFolder' ? v : Number(v);
    const r = await saveSetting({ [k]: want });
    if (r && r.settings && String(r.settings[k]) !== String(want)) toast('已調整為 ' + r.settings[k], true);
  });
}
for (const k of SETTING_CHK) $(k).addEventListener('change', () => saveSetting({ [k]: $(k).checked }));

$('bridgeToken').addEventListener('input', validateTokenField);
$('bridgeToken').addEventListener('change', async () => {
  const v = $('bridgeToken').value.trim();
  if (!validateTokenField()) return; // 欄位下方已顯示原因
  const r = await saveSetting({ bridgeToken: v.toLowerCase() });
  if (r) toast(v ? '已儲存配對碼' : '已清除配對碼', true);
});
$('tokenToggle').addEventListener('click', () => {
  const inp = $('bridgeToken');
  const show = inp.type === 'password';
  inp.type = show ? 'text' : 'password';
  const b = $('tokenToggle');
  b.setAttribute('aria-pressed', String(show));
  b.setAttribute('aria-label', show ? '隱藏配對碼' : '顯示配對碼');
  b.title = show ? '隱藏配對碼' : '顯示配對碼';
});
$('tokenToggle').title = '顯示配對碼';

// 面板關閉時，還在等待復原的刪除直接送出
window.addEventListener('pagehide', () => {
  if (!pendingDeletes.size) return;
  try { chrome.runtime.sendMessage({ type: 'REMOVE_ITEMS', ids: Array.from(pendingDeletes) }); } catch (e) {}
  pendingDeletes.clear();
});

setInterval(tickCooldown, 1000);
load();
})();
