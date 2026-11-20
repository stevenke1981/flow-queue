// Flow Queue — content script（在 Google Flow 分頁內執行排隊）
(() => {
  if (window.__FLOW_QUEUE_CS__ && chrome.runtime && chrome.runtime.id) return;
  window.__FLOW_QUEUE_CS__ = true;

  // 擴充功能重新載入後，舊的內容腳本會失聯：通知舊實例讓位
  let dead = false;
  const alive = () => !dead && !!(chrome.runtime && chrome.runtime.id);
  document.dispatchEvent(new CustomEvent('flowqueue:takeover'));
  setTimeout(() => document.addEventListener('flowqueue:takeover', () => { dead = true; stopFlag = true; }), 0);

  // ---------------- utilities ----------------
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const norm = (s) => String(s || '')
    .replace(/[\u200b-\u200d\ufeff]/g, '')
    .replace(/\u00a0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
  const visible = (el) => !!el && el.isConnected && el.getClientRects().length > 0 &&
    getComputedStyle(el).visibility !== 'hidden';
  const rand = (a, b) => a + Math.random() * Math.max(0, b - a);

  async function send(msg) {
    try {
      return (await chrome.runtime.sendMessage(msg)) || { ok: false, error: 'no response' };
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) };
    }
  }
  const log = (text, level = 'info') => send({ type: 'LOG', text, level });

  class StopError extends Error {}
  let stopFlag = false;
  const checkStop = () => { if (stopFlag || !alive()) throw new StopError('已停止'); };
  async function waitFor(fn, timeout = 5000, step = 150) {
    const end = Date.now() + timeout;
    for (;;) {
      checkStop();
      const v = fn();
      if (v) return v;
      if (Date.now() >= end) return null;
      await sleep(step);
    }
  }

  // ---------------- Flow DOM ----------------
  function promptBox() {
    const boxes = [...document.querySelectorAll('.base-prompt-box')];
    return boxes.find(visible) || boxes[0] || document;
  }

  const EDITOR_SEL = 'flow-rich-text-editor .ProseMirror[contenteditable="true"], .ProseMirror[contenteditable="true"]';
  function editor() {
    const inBox = [...promptBox().querySelectorAll(EDITOR_SEL)].find(visible);
    if (inBox) return inBox;
    return [...document.querySelectorAll(EDITOR_SEL + ', [role="textbox"][contenteditable="true"]')].find(visible) || null;
  }

  function editorText(el = editor()) {
    if (!el) return '';
    const c = el.cloneNode(true);
    c.querySelectorAll('.prosemirror-placeholder, .ProseMirror-widget, [data-placeholder]').forEach((n) => {
      if (n !== c) n.remove();
    });
    c.querySelectorAll('br').forEach((n) => n.replaceWith('\n'));
    c.querySelectorAll('p, div, li, h1, h2, h3, h4, h5, h6, blockquote, pre').forEach((n) => n.append('\n'));
    return String(c.textContent || '').trim();
  }

  function generateButton() {
    const box = promptBox();
    const sels = [
      'button[aria-label="Start generation"]',
      'flow-generate-icon-button button',
      'button[type="submit"]'
    ];
    for (const s of sels) {
      const b = [...box.querySelectorAll(s)].find(visible);
      if (b) return b;
    }
    return null;
  }
  const isDisabled = (b) => !b || b.disabled || b.getAttribute('aria-disabled') === 'true' ||
    b.classList.contains('mat-mdc-button-disabled');

  function overlayOpen() {
    return [...document.querySelectorAll('.cdk-overlay-container .cdk-overlay-pane')].some((p) =>
      p.children.length && !p.querySelector('[role="tooltip"], .mat-mdc-tooltip, [class*="tooltip"]'));
  }
  async function closeOverlays() {
    for (let i = 0; i < 5 && overlayOpen(); i++) {
      const target = document.activeElement || document.body;
      target.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, bubbles: true }));
      await sleep(200);
      if (!overlayOpen()) break;
      const backdrop = document.querySelector('.cdk-overlay-backdrop');
      if (backdrop) backdrop.click();
      await sleep(250);
    }
  }

  const pendingTiles = () => [...document.querySelectorAll('flow-pending-tile')];
  const errorTiles = () => [...document.querySelectorAll('flow-error-tile')];

  const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
  // 只認主機或路徑本身：flow-content.google 網域，或 Flow 的 media.getMediaUrlRedirect 端點
  const DURABLE_RE = /^https:\/\/(?:flow-content\.google\/|(?:[a-z0-9-]+\.)*(?:flow\.google(?:\.com)?|labs\.google)\/[^?#\s]*getMediaUrlRedirect)/i;

  // Flow 有時用 blob: 網址顯示結果（只在這一頁有效、重新整理就失效）；盡量找出可長期使用的網址
  function durableSource(root, isVideo, mediaId) {
    const attrs = [];
    const push = (v) => { if (v && typeof v === 'string') attrs.push(v); };
    if (isVideo) {
      root.querySelectorAll('video, video source').forEach((v) => { push(v.currentSrc); push(v.getAttribute('src')); push(v.getAttribute('data-src')); });
    } else {
      root.querySelectorAll('img').forEach((i) => { push(i.currentSrc); push(i.getAttribute('src')); push(i.getAttribute('data-src')); });
    }
    root.querySelectorAll('a[href]').forEach((a) => push(a.href));
    const durable = attrs.find((u) => DURABLE_RE.test(u) && (!isVideo || !/thumbnail|image/i.test(u) || /video/i.test(u)));
    if (durable) return durable;
    if (isVideo && mediaId) {
      // 影片可能經由 MediaSource 播放：從已載入的影片資源中找含有同一個 media id 的網址（排除縮圖）
      const hit = performance.getEntriesByType('resource')
        .filter((e) => /^(video|fetch|xmlhttprequest|other)$/.test(e.initiatorType || ''))
        .map((e) => e.name).reverse()
        .find((n) => DURABLE_RE.test(n) && n.includes(mediaId) && !/thumbnail|image|poster/i.test(n));
      if (hit) return hit;
    }
    return '';
  }

  function mediaOf(root) {
    const video = root.querySelector('video');
    const img = root.querySelector('img[data-media-id]') || root.querySelector('img');
    const isVideo = !!root.querySelector('flow-video-tile') || !!video;
    const rawSrc = (isVideo && video && (video.currentSrc || video.src)) ||
      (img && (img.currentSrc || img.src)) || '';
    // 不從 blob: 網址取 UUID（那是 blob 自己的 id）；優先 data-media-id、?name=、/edit/<id>
    const idMatch = (s) => {
      s = String(s || '');
      if (!s || /^blob:/i.test(s)) return '';
      const named = s.match(/[?&]name=([0-9a-f-]{36})/i);
      if (named) return named[1].toLowerCase();
      const m = s.match(UUID_RE);
      return m ? m[0].toLowerCase() : '';
    };
    const editLink = root.querySelector('a[href*="/edit/"]');
    const editId = editLink ? ((editLink.getAttribute('href') || '').match(/\/edit\/([0-9a-f-]{36})/i) || [])[1] || '' : '';
    const mediaId = String((img && img.getAttribute('data-media-id')) || idMatch(img && img.getAttribute('src')) ||
      idMatch(video && video.getAttribute('src')) || editId || '').toLowerCase();
    const src = /^blob:/i.test(rawSrc) ? (durableSource(root, isVideo, mediaId) || rawSrc) : rawSrc;
    const loaded = isVideo ? !!src : !!(img && img.complete && img.naturalWidth > 0);
    return { src, isVideo, loaded, mediaId, id: mediaId || src.split('?')[0] || src };
  }

  function mediaTiles() {
    const tiles = [...document.querySelectorAll('flow-grid-tile-container')]
      .filter((t) => !t.querySelector('flow-collection-tile, flow-pending-tile, flow-error-tile'));
    let list = tiles.map((t) => ({ tile: t, ...mediaOf(t) }));
    if (!tiles.length) {
      // 備援：沒有網格容器時直接找媒體元素
      list = [...document.querySelectorAll('img[src*="getMediaUrlRedirect"], img[src*="flow-content.google"], video[src]')]
        .map((el) => ({ tile: el, ...mediaOf(el.parentElement || el) }));
    }
    return list.filter((m) => m.id && m.src);
  }

  const TOAST_SEL = '[role="alert"], mat-snack-bar-container, .mat-mdc-snack-bar-container, flow-toast';
  const toastTexts = () => [...document.querySelectorAll(TOAST_SEL)]
    .filter(visible)
    .map((e) => norm(e.innerText || e.textContent))
    .filter(Boolean);

  function classify(text) {
    const t = norm(text);
    if (!t) return null;
    if (/unusual activity|異常活動|异常活动|不尋常的活動/.test(t)) return 'unusual';
    if (/policy|violat|not allowed|blocked|safety|政策|違反|违反|不允許|不允许|安全/.test(t)) return 'policy';
    if (/rate limit|too many|try again later|high demand|wait a moment|usage limit|limit reached|請稍後|请稍后|過於頻繁|太頻繁|需求量大/.test(t)) return 'rate';
    if (/(credit|點數|积分|額度|配額|quota)/.test(t) && /(insufficient|out of|not enough|exhaust|不足|用完|用盡|耗盡)/.test(t)) return 'credits';
    if (/failed|went wrong|couldn.t|could not|unable to|失敗|失败|出錯|錯誤|错误|無法|无法/.test(t)) return 'failed';
    return null;
  }

  // ---------------- prompt entry ----------------
  function caretToEnd(el) {
    try {
      const sel = window.getSelection();
      const r = document.createRange();
      r.selectNodeContents(el);
      r.collapse(false);
      sel.removeAllRanges();
      sel.addRange(r);
    } catch (e) {}
  }
  function selectAll(el) {
    try {
      const sel = window.getSelection();
      const r = document.createRange();
      r.selectNodeContents(el);
      sel.removeAllRanges();
      sel.addRange(r);
    } catch (e) {}
  }

  async function clearEditor() {
    for (let i = 0; i < 3; i++) {
      const ed = editor();
      if (!ed || !editorText(ed)) return true;
      ed.focus();
      selectAll(ed);
      try { document.execCommand('delete', false, null); } catch (e) {}
      await sleep(120);
      if (!editorText(editor())) return true;
      const ed2 = editor();
      if (!ed2) return false;
      ed2.focus();
      selectAll(ed2);
      ed2.dispatchEvent(new InputEvent('beforeinput', { inputType: 'deleteContentBackward', bubbles: true, cancelable: true }));
      await sleep(150);
    }
    return !editorText(editor());
  }

  function textMatches(want) {
    const got = norm(editorText(editor()));
    if (got === want) return true;
    // Flow 可能自動轉換部分字元；開頭吻合且長度相近即視為成功
    const head = want.slice(0, 60);
    return got.startsWith(head) && Math.abs(got.length - want.length) <= Math.max(3, want.length * 0.05);
  }

  async function setPrompt(text) {
    const want = norm(text);
    const strategies = [
      (ed) => {
        const dt = new DataTransfer();
        dt.setData('text/plain', text);
        ed.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
      },
      () => document.execCommand('insertText', false, text),
      (ed) => ed.dispatchEvent(new InputEvent('beforeinput', { inputType: 'insertText', data: text, bubbles: true, cancelable: true }))
    ];
    for (const apply of strategies) {
      checkStop();
      await clearEditor();
      const ed = editor();
      if (!ed) throw new Error('找不到 Flow 的提示詞輸入框');
      ed.focus();
      caretToEnd(ed);
      try { apply(ed); } catch (e) {}
      await sleep(300);
      if (textMatches(want)) return true;
    }
    return false;
  }

  // ---------------- pressing Generate ----------------
  async function pressGenerate(btn, settings) {
    if (settings.trustedClick) {
      // 先連上 debugger：「正在偵錯」提示列出現會改變視窗高度，之後才量座標
      const prep = await send({ type: 'DEBUGGER_PREPARE' });
      if (prep.ok && prep.attachedNow) await sleep(500);
      if (!prep.ok) log('無法使用真實點擊：' + prep.error, 'warn');
    }
    try { btn.scrollIntoView({ block: 'center', inline: 'center' }); } catch (e) {}
    await sleep(150);
    const r = btn.getBoundingClientRect();
    const x = r.left + r.width / 2;
    const y = r.top + r.height / 2;
    const top = document.elementFromPoint(x, y);
    const reachable = top && (top === btn || btn.contains(top));
    if (settings.trustedClick && reachable && r.width > 0 && r.height > 0) {
      const res = await send({ type: 'TRUSTED_CLICK', x, y });
      if (res.ok) return 'trusted';
      log('真實點擊失敗（' + res.error + '），改用一般點擊', 'warn');
    } else if (settings.trustedClick && !reachable) {
      log('「開始生成」按鈕被遮住，改用一般點擊', 'warn');
    }
    btn.click();
    return 'dom';
  }

  function pressEnter() {
    const ed = editor();
    if (!ed) return;
    ed.focus();
    const o = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true };
    ed.dispatchEvent(new KeyboardEvent('keydown', o));
    ed.dispatchEvent(new KeyboardEvent('keypress', o));
    ed.dispatchEvent(new KeyboardEvent('keyup', o));
  }

  async function waitStarted(prefix, base, timeout, want) {
    const end = Date.now() + timeout;
    for (;;) {
      checkStop();
      const pend = pendingTiles();
      if (pend.some((t) => !base.pending.has(t) && norm(t.innerText).includes(prefix))) return { ok: true };
      if (pend.some((t) => !base.pending.has(t))) return { ok: true };
      const err = errorTiles().find((t) => !base.errors.has(t));
      if (err) return { ok: false, kind: 'failed', text: errorText(err) };
      const toast = toastTexts().find((t) => !base.toasts.has(t));
      if (toast) {
        const k = classify(toast);
        // 一般「失敗」提示只有在提示詞仍留在輸入框（代表沒送出）時才算這筆失敗
        if (k && (k !== 'failed' || textMatches(want))) return { ok: false, kind: k, text: toast };
      }
      if (!editorText(editor()) && isDisabled(generateButton())) return { ok: true, weak: true };
      // 在迴圈最後檢查期限：背景分頁的 sleep 可能遠超過期限，必須先做完上面的檢查
      if (Date.now() >= end) return { ok: false };
      await sleep(200);
    }
  }

  function errorText(tile) {
    const t = tile.querySelector('.error-message-text');
    return norm((t && t.textContent) || tile.innerText).slice(0, 200) || 'Flow 生成失敗';
  }


  // ---------------- ingredients（參考圖 / 角色 / 素材） ----------------
  const overlayRoot = () => document.querySelector('.cdk-overlay-container');
  const picker = () => (overlayRoot() || document).querySelector('flow-add-menu-popover-content, .mobile-add-menu-container');
  const projectId = () => { const m = location.pathname.match(/\/project\/([A-Za-z0-9_-]+)/); return m ? m[1] : ''; };

  function addIngredientButton() {
    const box = promptBox();
    return [...box.querySelectorAll('button[aria-label="Add ingredients to the prompt box"], flow-add-menu button.add-menu-trigger')].find(visible) || null;
  }
  const chips = () => [...promptBox().querySelectorAll('flow-ingredient-bar flow-ingredient-chip, flow-ingredient-bar flow-image-ingredient-chip, flow-ingredient-bar button.chip-container')]
    .map((c) => c.closest('flow-ingredient-chip, flow-image-ingredient-chip') || c)
    .filter((c, i, a) => a.indexOf(c) === i);
  const chipsBusy = () => [...promptBox().querySelectorAll('flow-ingredient-bar button.chip-container')]
    .some((c) => c.getAttribute('aria-busy') === 'true' || c.querySelector('mat-progress-spinner, mat-spinner'));
  const iconText = (el) => norm([...el.querySelectorAll('mat-icon, i, .material-symbols-outlined, .google-symbols')].map((i) => i.textContent).join(' '));

  async function openPicker() {
    const open = picker();
    if (open) return open;
    await closeOverlays();
    const btn = addIngredientButton();
    if (!btn) throw new Error('找不到 Flow 的「新增素材」按鈕（目前模式可能不支援素材）');
    btn.click();
    const p = await waitFor(picker, 5000, 150);
    if (!p) throw new Error('Flow 素材選擇器沒有打開');
    await sleep(400);
    return p;
  }

  const CATEGORY_WORDS = {
    All: ['all', '全部', '所有'],
    Images: ['images', 'image', '圖片', '图片', '圖像'],
    Characters: ['characters', 'character', '角色', '人物'],
    Videos: ['videos', 'video', '影片', '视频', '視訊'],
    Uploads: ['uploads', 'upload', '上傳', '上传', '已上傳']
  };
  const isCategory = (el, cat) => {
    const t = norm(el.textContent);
    return (CATEGORY_WORDS[cat] || [norm(cat)]).some((w) => t === w || t.startsWith(w + ' ') || t.startsWith(w + '('));
  };

  const assetRows = (p = picker()) => [...(p ? p.querySelectorAll('button.asset-item') : [])].map((btn) => {
    const img = btn.querySelector('img');
    const titleEl = btn.querySelector('.asset-title');
    return {
      btn,
      title: String((titleEl && titleEl.textContent) || btn.getAttribute('title') || btn.getAttribute('aria-label') || '').trim(),
      type: String((btn.querySelector('.type-subtitle') || {}).textContent || '').trim(),
      src: (img && img.src) || ''
    };
  });

  async function waitListChange(p, before, ms = 3000) {
    await waitFor(() => {
      const now = [...p.querySelectorAll('button.asset-item')];
      if (p.querySelector('.empty-state')) return true;
      if (!before.size) return now.length > 0;
      return now.some((b) => !before.has(b)) || now.every((b) => !b.isConnected) ? true : null;
    }, ms, 120);
    await sleep(250);
  }

  async function selectCategory(p, cat) {
    if (!cat || cat === 'All') cat = 'All';
    const before = new Set(p.querySelectorAll('button.asset-item'));
    const filter = p.querySelector('button[aria-label="Filter by category"]') ||
      [...p.querySelectorAll('button')].find((b) => iconText(b) === 'filter_list');
    if (filter) {
      if (isCategory(filter, cat)) return true;
      filter.click();
      const panel = await waitFor(() => (overlayRoot() || document).querySelector('.filter-panel'), 3000, 100);
      if (!panel) return false;
      const opt = [...panel.querySelectorAll('[role="option"], button, mat-option')].find((o) => isCategory(o, cat));
      if (!opt) { await closeTopOverlay(); return false; }
      opt.click();
      await waitListChange(p, before);
      return true;
    }
    const tabs = [...p.querySelectorAll('[role="tab"], mat-list-item[role="tab"]')];
    const tab = tabs.find((t) => isCategory(t, cat));
    if (!tab) return cat === 'All';
    if (tab.getAttribute('aria-selected') === 'true') return true;
    tab.click();
    await waitListChange(p, before);
    return true;
  }

  async function closeTopOverlay() {
    (document.activeElement || document.body).dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, bubbles: true }));
    await sleep(250);
  }

  async function searchAssets(p, text) {
    const input = p.querySelector('input[aria-label="Search assets"], input.search-input, input[type="search"]');
    if (!input) return false;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    const before = new Set(p.querySelectorAll('button.asset-item'));
    input.focus();
    setter.call(input, text);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    await sleep(500);
    await waitListChange(p, before, 2500);
    return true;
  }

  function scroller(p) {
    const root = p.querySelector('flow-add-menu-asset-list, cdk-virtual-scroll-viewport, .asset-list-viewport') || p;
    return [root, ...root.querySelectorAll('*')].find((el) => {
      const s = getComputedStyle(el);
      return /(auto|scroll)/.test(s.overflowY) && el.scrollHeight > el.clientHeight + 10;
    }) || null;
  }

  const cleanTitle = (s) => norm(s).replace(/(…|\.\.\.)+$/, '').replace(/\.(png|jpe?g|webp|gif|heic|mp4|webm)$/i, '').trim();
  function titleScore(rowTitle, want) {
    const a = cleanTitle(rowTitle), b = cleanTitle(want);
    if (!a || !b) return 0;
    if (a === b) return 3;
    const truncated = /(…|\.\.\.)$/.test(String(rowTitle).trim());
    if (truncated && a.length >= 6 && b.startsWith(a)) return 2;
    if (b.length >= 6 && a.startsWith(b) && !/^[\p{L}\p{N}]/u.test(a.slice(b.length))) return 1;
    return 0;
  }

  // 掃完整個（虛擬化）清單，收集最高分的所有候選；同分且是不同圖片時視為名稱不唯一
  async function findAsset(p, name, { scroll = true } = {}) {
    let bestScore = 0;
    const cands = new Map(); // key -> row
    const collect = () => {
      for (const r of assetRows(p)) {
        const s = titleScore(r.title, name);
        if (!s || s < bestScore) continue;
        if (s > bestScore) { bestScore = s; cands.clear(); }
        cands.set(r.src || r.title, { ...r, score: s });
      }
    };
    collect();
    const sc = scroll && scroller(p);
    if (sc) {
      sc.scrollTop = 0;
      sc.dispatchEvent(new Event('scroll'));
      await sleep(300);
      for (let i = 0; i < 60; i++) {
        checkStop();
        collect();
        const prev = sc.scrollTop;
        sc.scrollTop = prev + Math.max(200, sc.clientHeight * 0.8);
        sc.dispatchEvent(new Event('scroll'));
        await sleep(300);
        if (sc.scrollTop === prev) { collect(); break; }
      }
    }
    if (!cands.size) return null;
    if (cands.size > 1) {
      const err = new Error('名稱「' + name + '」對應到多個素材（' + [...cands.values()].slice(0, 5).map((r) => r.title).join('、') + '），請改用完整且唯一的名稱');
      err.ambiguous = true;
      throw err;
    }
    const hit = [...cands.values()][0];
    // 節點可能被虛擬清單回收：點擊前重新找到同一個項目
    if (!hit.btn.isConnected) {
      const again = assetRows(p).find((r) => (r.src || r.title) === (hit.src || hit.title));
      if (!again) {
        if (sc) { sc.scrollTop = 0; await sleep(300); }
        const third = assetRows(p).find((r) => (r.src || r.title) === (hit.src || hit.title));
        return third ? { ...third, score: hit.score } : null;
      }
      return { ...again, score: hit.score };
    }
    return hit;
  }

  async function clickAssetIntoPrompt(row) {
    const before = chips().length;
    try { row.btn.scrollIntoView({ block: 'center' }); } catch (e) {}
    row.btn.click();
    await sleep(500);
    const addBtn = (overlayRoot() || document).querySelector('button.detail-add-to-prompt-btn') ||
      [...(overlayRoot() || document).querySelectorAll('button')].find((b) => visible(b) && /add to prompt|加入提示|新增至提示|添加到提示/i.test(b.textContent || ''));
    if (addBtn && !isDisabled(addBtn)) { addBtn.click(); await sleep(300); }
    const ok = await waitFor(() => chips().length > before || null, 6000, 150);
    await waitFor(() => !chipsBusy() || null, 10000, 200);
    if (picker()) await closeOverlays();
    return !!ok;
  }

  async function attachByName(name, category) {
    const p = await openPicker();
    let hit = null;
    const cats = category === 'Characters' ? ['Characters'] : [...new Set([category || 'All', 'All'])];
    for (const cat of cats) {
      if (!(await selectCategory(p, cat)) && cat !== 'All') continue;
      await searchAssets(p, name);
      hit = await findAsset(p, name);
      if (hit) break;
      await searchAssets(p, '');
      hit = await findAsset(p, name);
      if (hit) break;
      if (cat === 'All') break;
    }
    if (!hit) { await closeOverlays(); return false; }
    return clickAssetIntoPrompt(hit);
  }

  async function clearIngredients() {
    for (let i = 0; i < 15; i++) {
      checkStop();
      const list = chips();
      if (!list.length) return true;
      const chip = list[0];
      const n = list.length;
      const x = chip.querySelector('.hover-icon-overlay, mat-icon, button[aria-label*="emove" i], button[aria-label*="lose" i]');
      (x || chip).click();
      await sleep(250);
      if (chips().length < n) continue;
      const btn = chip.querySelector('button.chip-container') || chip;
      btn.click();
      await sleep(250);
      const menuItem = [...(overlayRoot() || document).querySelectorAll('[role="menuitem"], button')]
        .find((e) => visible(e) && /^(remove|移除|從提示詞移除|移出|remove from prompt)$/i.test(norm(e.textContent).replace(/^(close|delete|remove_circle|cancel)\s+/, '')));
      if (menuItem) menuItem.click(); else await closeOverlays();
      await sleep(300);
      if (chips().length >= n) { log('無法移除 Flow 上既有的素材，將保留', 'warn'); return false; }
    }
    return !chips().length;
  }

  async function readFile(fileId) {
    const key = 'file:' + fileId;
    const d = await chrome.storage.local.get(key);
    if (!d[key]) throw new Error('找不到已儲存的參考圖（可能已被清除）');
    return d[key];
  }

  async function uploadFile(ref) {
    const rec = await readFile(ref.fileId);
    const ext = (rec.mime.split('/')[1] || 'png').replace('jpeg', 'jpg').replace(/[^a-z0-9]/g, '') || 'png';
    const uploadName = 'fq_' + ref.fileId + '.' + ext;
    const hold = await send({ type: 'HOLD_FILE_CHOOSER' });
    if (!hold.ok) throw new Error('無法準備上傳：' + hold.error);
    const p = await openPicker();
    await selectCategory(p, 'Uploads');
    const up = [...(overlayRoot() || document).querySelectorAll('button')].find((b) =>
      visible(b) && !b.closest('[role="tab"], [role="option"], .filter-panel') && b.getAttribute('role') !== 'tab' && (/upload media|上傳媒體|上传媒体|上傳|上传|upload/i.test(b.innerText || '') || iconText(b) === 'upload'));
    if (!up) throw new Error('找不到 Flow 的「上傳」按鈕');
    document.querySelectorAll('input[type="file"][data-fq-upload-target]').forEach((i) => i.removeAttribute('data-fq-upload-target'));
    const beforeSrc = new Set(assetRows(p).map((r) => r.src).filter(Boolean));
    const beforeToasts = new Set(toastTexts());
    up.click();
    const input = await waitFor(() => document.querySelector('input[type="file"][data-fq-upload-target]'), 4000, 120);
    if (!input) throw new Error('Flow 沒有開啟上傳欄位（如果跳出了檔案視窗，請關閉它）');
    input.removeAttribute('data-fq-upload-target');
    const bin = atob(rec.base64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const dt = new DataTransfer();
    dt.items.add(new File([bytes], uploadName, { type: rec.mime }));
    input.files = dt.files;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    const base = uploadName.replace(/\.[a-z0-9]+$/i, '');
    const row = await waitFor(() => {
      const t = toastTexts().find((x) => !beforeToasts.has(x) && classify(x));
      if (t) return { refused: t };
      const pk = picker();
      if (!pk) return null;
      const fresh = assetRows(pk).filter((r) => /^https?:/i.test(r.src) && !beforeSrc.has(r.src));
      const named = fresh.find((r) => norm(r.title).includes(norm(base)));
      if (named) return { ...named, exact: true };
      // 標題看不出來時，只有在「剛好一個新項目」才接受，且不寫入快取
      return fresh.length === 1 ? { ...fresh[0], exact: false } : null;
    }, 90000, 500);
    if (!row) throw new Error('上傳的參考圖 90 秒內沒有出現在 Flow');
    if (row.refused) throw new Error('Flow 拒絕上傳：' + row.refused.slice(0, 120));
    const title = row.title || base;
    if (row.exact) {
      const pid = projectId();
      const { uploadCache = {} } = await chrome.storage.local.get('uploadCache');
      uploadCache[pid] = { ...(uploadCache[pid] || {}), [ref.fileId]: title };
      await chrome.storage.local.set({ uploadCache });
    }
    log('已上傳參考圖「' + (ref.name || uploadName) + '」');
    // 上傳後若沒有自動加入提示詞框，就從清單點選加入
    await sleep(800);
    return { title, row };
  }

  async function attachRef(ref) {
    const label = ref.name || ref.fileId || '';
    if (ref.type === 'character') {
      if (!(await attachByName(ref.name, 'Characters'))) throw new Error('找不到角色「' + label + '」');
      return;
    }
    if (ref.type === 'asset') {
      if (!(await attachByName(ref.name, ref.category || 'All'))) throw new Error('找不到素材「' + label + '」');
      return;
    }
    if (ref.type === 'file') {
      const pid = projectId();
      const { uploadCache = {} } = await chrome.storage.local.get('uploadCache');
      const cached = (uploadCache[pid] || {})[ref.fileId];
      if (cached && (await attachByName(cached, 'Uploads'))) return;
      const before = chips().length;
      const { title, row } = await uploadFile(ref);
      if (chips().length > before) { await waitFor(() => !chipsBusy() || null, 10000, 200); await closeOverlays(); return; }
      if (picker() && row.btn.isConnected && (await clickAssetIntoPrompt(row))) return;
      if (await attachByName(title, 'Uploads')) return;
      throw new Error('參考圖「' + label + '」已上傳，但無法加入提示詞框');
    }
    throw new Error('不支援的素材類型：' + ref.type);
  }

  async function applyRefs(refs, settings) {
    if (!refs || !refs.length) return;
    if (settings.clearIngredients !== false && !(await clearIngredients())) throw new Error('無法清除 Flow 提示詞框上的既有素材（上傳後重試）');
    for (const ref of refs) {
      checkStop();
      await attachRef(ref);
    }
    await closeOverlays();
    await sleep(500);
  }

  async function listAssets({ category = 'All', search = '' } = {}) {
    const p = await openPicker();
    try {
      await selectCategory(p, category);
      if (search) await searchAssets(p, search);
      const seen = new Map();
      const collect = () => assetRows(p).forEach((r) => { if (r.title && !seen.has(r.title)) seen.set(r.title, { title: r.title, type: r.type, src: r.src.slice(0, 500) }); });
      collect();
      const sc = scroller(p);
      if (sc) {
        sc.scrollTop = 0;
        await sleep(300);
        for (let i = 0; i < 30 && seen.size < 300; i++) {
          collect();
          const prev = sc.scrollTop;
          sc.scrollTop = prev + Math.max(200, sc.clientHeight * 0.8);
          await sleep(300);
          if (sc.scrollTop === prev) break;
        }
        collect();
      }
      return [...seen.values()];
    } finally {
      await closeOverlays();
    }
  }

  // 同一時間只允許一個流程操作 Flow 介面（送出 vs. 列出素材）
  let domLockChain = Promise.resolve();
  let domBusy = 0;
  function withDomLock(fn) {
    const wrapped = async () => { domBusy++; try { return await fn(); } finally { domBusy--; } };
    const run = domLockChain.then(wrapped, wrapped);
    domLockChain = run.catch(() => {});
    return run;
  }

  // ---------------- runner ----------------
  let myTabId = null;
  let loopActive = false;
  let nextSubmitAt = 0;
  let hiddenWarned = false;
  const inflight = new Map(); // id -> tracking record
  const claimedMedia = new Set();
  let seenToasts = new Set();

  async function getState() {
    const d = await chrome.storage.local.get(['run', 'settings']);
    return { run: d.run || { state: 'idle' }, settings: d.settings || {} };
  }

  function snapshot() {
    return {
      pending: new Set(pendingTiles()),
      errors: new Set(errorTiles()),
      media: new Set(mediaTiles().map((m) => m.id)),
      toasts: new Set(toastTexts())
    };
  }

  async function startCooldown(settings, text, kind) {
    const sec = kind === 'unusual' ? Math.max(settings.cooldownSec || 120, 180) : (settings.cooldownSec || 120);
    await send({
      type: 'SET_RUN',
      patch: { cooldownUntil: Date.now() + sec * 1000, message: '冷卻中：' + text.slice(0, 80) },
      log: 'Flow 要求放慢速度，暫停送出 ' + sec + ' 秒：' + text.slice(0, 120),
      level: 'warn'
    });
  }

  async function failItem(id, error, retryable = true, claimId) {
    await send({ type: 'ITEM_FAILED', id, error, retryable, claimId });
    nextSubmitAt = Math.max(nextSubmitAt, Date.now() + 3000);
  }
  const unclaim = (item, reason, logText, level) =>
    send({ type: 'UNCLAIM', id: item.id, claimId: item.claimId, reason, log: logText, level });
  const stopRun = (reason) => send({ type: 'STOP', reason, level: 'error' });

  async function submitItem(item, settings) {
    const label = '#' + item.seq;
    const ed = await waitFor(() => editor(), 20000, 300);
    if (!ed) throw new Error('找不到 Flow 的提示詞輸入框（請確認已開啟專案頁面）');
    await closeOverlays();

    if (item.refs && item.refs.length) {
      log(label + ' 加入 ' + item.refs.length + ' 個素材…');
      try {
        weAttached = true;
        await applyRefs(item.refs, settings);
        if (chips().length < item.refs.length) throw new Error('Flow 提示詞框上的素材數量不符（預期至少 ' + item.refs.length + ' 個）');
        // 上傳的參考圖可能出現在專案網格：先認領，避免被其他生成中項目當成結果
        for (const m of mediaTiles()) if (/fq_[0-9a-f]{16}/i.test(m.tile.innerText || '') || /fq_[0-9a-f]{16}/i.test(m.src)) claimedMedia.add(m.id);
      } catch (e) {
        if (e instanceof StopError) throw e;
        await closeOverlays();
        if (settings.clearIngredients !== false) await clearIngredients().catch(() => {});
        return { ok: false, error: String((e && e.message) || e), retryable: /上傳|沒有打開|沒有出現|無法加入/.test(String(e && e.message)) };
      }
    }

    else if (weAttached && settings.clearIngredients !== false) {
      // 上一筆由佇列加入的素材不能帶到沒有素材的這一筆
      if (!(await clearIngredients())) return { ok: false, error: '無法清除上一筆的素材，為避免送出錯誤素材已暫停此筆', retryable: true };
      weAttached = false;
    }

    // 快照要在加入素材之後：上傳的參考圖也會出現在專案網格，不能被當成生成結果
    const base = snapshot();
    if (!(await setPrompt(item.prompt))) throw new Error('無法把提示詞填入 Flow 輸入框');

    const btn = await waitFor(() => { const b = generateButton(); return b && !isDisabled(b) ? b : null; }, 6000, 200);
    if (!btn) throw new Error('Flow 的「開始生成」按鈕無法使用（可能點數不足或輸入不被接受）');

    // 點擊前再確認一次：使用者可能剛按了暫停 / 停止
    const { run } = await getState();
    if (run.state !== 'running' || run.tabId !== myTabId) {
      await clearEditor();
      await unclaim(item, '', label + ' 已退回待處理（暫停）');
      return { ok: true, handled: true };
    }

    const prefix = norm(item.prompt).slice(0, 30);
    // 先記錄「已送出」：若中途當掉，不會被當成未送出而重複扣點數
    const mark = await send({ type: 'UPDATE_ITEM', id: item.id, claimId: item.claimId, patch: { submittedAt: Date.now() } });
    if (!mark.ok || mark.ignored) {
      // 這次認領已被撤銷（例如剛按了停止再開始），不要點擊
      await clearEditor();
      return { ok: true, handled: true };
    }
    const how = await pressGenerate(btn, settings);
    const want = norm(item.prompt);
    let started = await waitStarted(prefix, base, 8000, want);
    if (!started.ok && !started.kind && textMatches(want)) {
      // 只有在輸入框內容仍在、且沒有任何生成跡象時才補按 Enter，避免重複送出
      log(label + ' 點擊後未開始，改用 Enter 重試', 'warn');
      pressEnter();
      started = await waitStarted(prefix, base, 6000, want);
    }
    if (!started.ok && !started.kind && !textMatches(want)) {
      // 輸入框已被 Flow 清空：視為已送出並繼續追蹤，絕不重送（避免重複扣點數）
      started = { ok: true, weak: true };
    }
    if (!started.ok) {
      if (started.kind === 'rate') {
        await startCooldown(settings, started.text, started.kind);
        await unclaim(item, 'Flow 限流，稍後重送');
        return { ok: true, handled: true };
      }
      if (started.kind === 'unusual') {
        await failItem(item.id, 'Flow 回報異常活動：' + started.text, false, item.claimId);
        await stopRun('Flow 回報異常活動，為保護帳號已停止佇列；請稍候再手動繼續');
        return { ok: true, handled: true };
      }
      if (started.kind === 'credits') {
        await failItem(item.id, '點數不足：' + started.text, false, item.claimId);
        await stopRun('Flow 點數不足，已停止佇列');
        return { ok: true, handled: true };
      }
      if (started.kind === 'policy') {
        return { ok: false, error: 'Flow 拒絕此提示詞：' + started.text, retryable: false };
      }
      return { ok: false, error: started.text ? 'Flow 拒絕：' + started.text : '送出後 Flow 沒有開始生成', retryable: true };
    }

    const now = Date.now();
    inflight.set(item.id, {
      id: item.id,
      claimId: item.claimId,
      stableTicks: 0,
      seq: item.seq,
      prompt: item.prompt,
      prefix,
      submittedAt: now,
      lastPendingAt: 0,
      sawPending: false,
      base
    });
    await send({
      type: 'UPDATE_ITEM',
      id: item.id,
      claimId: item.claimId,
      patch: { submittedAt: now },
      log: label + ' 已送出（' + (how === 'trusted' ? '真實點擊' : '一般點擊') + '）'
    });
    nextSubmitAt = Math.max(nextSubmitAt, now + rand(settings.delayMin, settings.delayMax) * 1000);
    return { ok: true };
  }

  function slug(s) {
    return String(s || '').replace(/[\u0000-\u001f<>:"/\\|?*]+/g, ' ').replace(/\s+/g, '_').slice(0, 40);
  }

  const EXT_BY_TYPE = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif', 'video/mp4': 'mp4', 'video/webm': 'webm', 'video/quicktime': 'mov' };
  const MAX_FETCH_BYTES = 25 * 1024 * 1024; // 轉成 base64 後約 33 MB，留在擴充功能訊息上限內

  async function blobToDataUrl(src) {
    const res = await fetch(src);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const blob = await res.blob();
    if (!blob.size) throw new Error('空的檔案');
    if (blob.size > MAX_FETCH_BYTES) throw new Error('檔案太大（' + Math.round(blob.size / 1048576) + ' MB），請在 Flow 手動下載');
    const dataUrl = await new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => resolve(fr.result);
      fr.onerror = () => reject(fr.error);
      fr.readAsDataURL(blob);
    });
    return { dataUrl, mime: blob.type, ext: EXT_BY_TYPE[blob.type] || '' };
  }

  // 取得可下載的內容：先試存下的 blob 網址；失效時依 mediaId 在目前頁面找回該結果
  async function fetchMedia({ src = '', mediaId = '', isVideo = false } = {}) {
    const fallbackExt = isVideo ? 'mp4' : 'jpg';
    const errors = [];
    if (/^blob:/i.test(src)) {
      try { const r = await blobToDataUrl(src); return { ...r, ext: r.ext || fallbackExt }; } catch (e) { errors.push('暫存網址已失效'); }
    } else if (src) {
      return { url: src, ext: fallbackExt };
    }
    const id = String(mediaId || '').toLowerCase();
    if (id) {
      const m = mediaTiles().find((t) => t.mediaId && t.mediaId.toLowerCase() === id);
      if (m) {
        if (!/^blob:/i.test(m.src)) return { url: m.src, ext: m.isVideo ? 'mp4' : 'jpg' };
        try { const r = await blobToDataUrl(m.src); return { ...r, ext: r.ext || (m.isVideo ? 'mp4' : 'jpg') }; } catch (e) { errors.push(String(e.message || e)); }
      } else {
        errors.push('目前頁面找不到這個結果（請捲動到該結果或打開它所在的專案）');
      }
    }
    throw new Error('無法取得檔案：' + (errors.join('；') || '沒有可用的網址'));
  }

  async function completeItem(rec, media, settings) {
    const results = media.map((m) => ({ src: m.src.slice(0, 4000), isVideo: m.isVideo, mediaId: m.mediaId || '', projectId: projectId() }));
    await send({
      type: 'UPDATE_ITEM',
      id: rec.id,
      claimId: rec.claimId,
      patch: { status: 'done', finishedAt: Date.now(), results, error: results.length ? '' : '已完成，但未偵測到輸出媒體' },
      log: '#' + rec.seq + ' 完成（' + results.length + ' 個結果）'
    });
    nextSubmitAt = Math.max(nextSubmitAt, Date.now() + rand(settings.delayMin, settings.delayMax) * 1000);
    if (!settings.autoDownload) return;
    for (let k = 0; k < media.length; k++) {
      const m = media[k];
      try {
        const got = await fetchMedia({ src: m.src, mediaId: m.mediaId, isVideo: m.isVideo });
        const name = String(rec.seq).padStart(3, '0') + '_' + slug(rec.prompt) + (media.length > 1 ? '_' + (k + 1) : '');
        const r = await send({ type: 'DOWNLOAD', url: got.dataUrl || got.url, name, ext: got.ext, mediaId: m.mediaId });
        if (!r.ok) log('#' + rec.seq + ' 下載失敗：' + r.error, 'warn');
      } catch (e) {
        log('#' + rec.seq + ' 下載失敗：' + (e && e.message), 'warn');
      }
    }
  }

  async function track(settings) {
    const now = Date.now();

    // 全域提示（限流 / 異常活動 / 點數）
    const toasts = toastTexts();
    for (const t of toasts) {
      if (seenToasts.has(t)) continue;
      const k = classify(t);
      if (k === 'rate') await startCooldown(settings, t, k);
      else if (k === 'unusual') {
        await stopRun('Flow 回報異常活動，為保護帳號已停止佇列：' + t.slice(0, 100));
        return;
      } else if (k === 'credits') {
        await stopRun('Flow 點數不足，已停止佇列：' + t.slice(0, 100));
        return;
      }
    }
    seenToasts = new Set(toasts);

    if (!inflight.size) return;
    const pend = pendingTiles();
    const pendTexts = pend.map((t) => norm(t.innerText));
    const errors = errorTiles();
    const media = mediaTiles();
    const single = inflight.size === 1;

    // 依送出順序處理，較早送出的先認領新結果
    const recs = [...inflight.values()].sort((a, b) => a.submittedAt - b.submittedAt);
    for (const rec of recs) {
      const mine = pendTexts.filter((t) => t.includes(rec.prefix)).length;
      const anyNewPending = pend.some((t) => !rec.base.pending.has(t));
      const stillPending = mine > 0 || (single && anyNewPending && !pendTexts.some(Boolean));
      if (stillPending) { rec.sawPending = true; rec.lastPendingAt = now; rec.goneTicks = 0; }

      const newErrors = errors.filter((e) => !rec.base.errors.has(e) && !e.__flowQueueClaimed);
      const myErr = newErrors.find((e) => norm(e.innerText).includes(rec.prefix)) ||
        (single && !stillPending ? newErrors[0] : null);
      if (myErr) {
        myErr.__flowQueueClaimed = true;
        inflight.delete(rec.id);
        const txt = errorText(myErr);
        const kind = classify(txt);
        if (kind === 'rate') await startCooldown(settings, txt, kind);
        await failItem(rec.id, 'Flow 生成失敗：' + txt, kind !== 'unusual' && kind !== 'policy', rec.claimId);
        if (kind === 'unusual') await stopRun('Flow 回報異常活動，為保護帳號已停止佇列');
        continue;
      }

      if (!stillPending) {
        const fresh = media.filter((m) => m.loaded && !rec.base.media.has(m.id) && !claimedMedia.has(m.id));
        const sinceGone = rec.sawPending ? now - rec.lastPendingAt : 0;
        const settled = rec.sawPending ? sinceGone > 2500 : now - rec.submittedAt > 15000;
        // 連續兩次檢查都穩定才算完成（避免多張輸出只抓到一部分）
        rec.stableTicks = settled && fresh.length && fresh.length === rec.lastFresh ? rec.stableTicks + 1 : 0;
        rec.lastFresh = fresh.length;
        if (settled && fresh.length && rec.stableTicks >= 1) {
          fresh.forEach((m) => claimedMedia.add(m.id));
          inflight.delete(rec.id);
          await completeItem(rec, fresh, settings);
          continue;
        }
        rec.goneTicks = rec.sawPending ? (rec.goneTicks || 0) + 1 : 0;
        // 用「實際觀察到的檢查次數」判斷，避免長時間上傳期間沒有檢查、一回來就誤判為無結果
        if (rec.sawPending && sinceGone > 12000 && rec.goneTicks >= 8) {
          inflight.delete(rec.id);
          await completeItem(rec, [], settings);
          continue;
        }
      }

      if (now - rec.submittedAt > (settings.timeoutMin || 10) * 60000) {
        // 逾時不自動重試：Flow 可能仍在生成，重送會重複扣點數
        inflight.delete(rec.id);
        await send({
          type: 'UPDATE_ITEM', id: rec.id, claimId: rec.claimId,
          patch: { status: 'unknown', finishedAt: now, error: '等待逾時（' + settings.timeoutMin + ' 分鐘），請到 Flow 確認' },
          log: '#' + rec.seq + ' 等待逾時，標記為未確認', level: 'warn'
        });
      }
    }
  }

  let weAttached = false; // 提示詞框上的素材是佇列加入的
  let ready = false; // 初始化（含重新載入後的接手）完成前不啟動執行器
  async function loop() {
    if (loopActive || !ready) return;
    loopActive = true;
    stopFlag = false;
    try {
      for (;;) {
        if (!alive()) break;
        const { run, settings } = await getState();
        if (run.tabId !== myTabId || run.state === 'idle') {
          inflight.clear();
          break;
        }
        if (document.hidden && !hiddenWarned) {
          hiddenWarned = true;
          log('Flow 分頁目前在背景，瀏覽器可能降低執行速度；建議讓分頁保持顯示', 'warn');
        }
        if (!document.hidden) hiddenWarned = false;

        await track(settings);

        const fresh = await getState();
        const canSubmit = fresh.run.state === 'running' && fresh.run.tabId === myTabId &&
          !(fresh.run.cooldownUntil > Date.now()) &&
          inflight.size < (settings.maxConcurrent || 1) &&
          Date.now() >= nextSubmitAt;

        if (fresh.run.state === 'running' && fresh.run.cooldownUntil && fresh.run.cooldownUntil <= Date.now()) {
          await send({ type: 'SET_RUN', patch: { cooldownUntil: 0, message: '執行中' }, log: '冷卻結束，繼續送出' });
        }

        if (canSubmit) {
          const claim = await send({ type: 'CLAIM_NEXT' });
          if (claim.ok && claim.item) {
            const item = claim.item;
            try {
              const r = await withDomLock(() => submitItem(item, settings));
              if (!r.ok) await failItem(item.id, r.error, r.retryable, item.claimId);
            } catch (e) {
              if (e instanceof StopError) break;
              await failItem(item.id, String((e && e.message) || e), true, item.claimId);
            }
            continue;
          }
          if (claim.ok && !claim.item && inflight.size === 0) {
            const { run: r2 } = await getState();
            if (r2.state === 'running') {
              await send({ type: 'SET_RUN', patch: { state: 'idle', message: '佇列已全部處理完成' }, log: '佇列已全部處理完成' });
            }
            break;
          }
        }
        await sleep(1000);
      }
    } catch (e) {
      if (!(e instanceof StopError)) log('執行器錯誤：' + ((e && e.message) || e), 'error');
    } finally {
      loopActive = false;
    }
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (sender.id !== chrome.runtime.id || !msg) return false;
    if (msg.type === 'PING') { sendResponse({ ok: true, editor: !!editor() }); return false; }
    if (msg.type === 'KICK') { stopFlag = false; loop(); sendResponse({ ok: true }); return false; }
    if (msg.type === 'STOP') { stopFlag = true; inflight.clear(); sendResponse({ ok: true }); return false; }
    if (msg.type === 'FETCH_MEDIA') {
      fetchMedia(msg)
        .then((r) => sendResponse({ ok: true, ...r }))
        .catch((e) => sendResponse({ ok: false, error: String((e && e.message) || e) }));
      return true;
    }
    if (msg.type === 'LIST_ASSETS') {
      if (domBusy) { sendResponse({ ok: false, error: '佇列正在操作 Flow 介面，請稍後再試（或先暫停）' }); return false; }
      withDomLock(() => listAssets(msg))
        .then((assets) => sendResponse({ ok: true, assets }))
        .catch((e) => sendResponse({ ok: false, error: String((e && e.message) || e) }));
      return true;
    }
    return false;
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes.run) return;
    const run = changes.run.newValue || {};
    if (run.tabId === myTabId && run.state !== 'idle') { stopFlag = false; loop(); }
  });

  (async () => {
    const r = await send({ type: 'GET_TAB_ID' });
    myTabId = r.ok ? r.tabId : null;
    const { run } = await getState();
    if (myTabId != null && run.tabId === myTabId && run.state !== 'idle') {
      // 頁面重新載入：仍在 Flow 生成中的項目重新接手，其餘標記為未確認
      await waitFor(() => editor(), 30000, 500).catch(() => null);
      await sleep(2000);
      const running = await send({ type: 'GET_RUNNING' });
      const keepIds = [];
      const base = snapshot();
      for (const it of (running.ok ? running.items : [])) {
        const prefix = norm(it.prompt).slice(0, 30);
        if (!it.submittedAt || !pendingTiles().some((t) => norm(t.innerText).includes(prefix))) continue;
        keepIds.push(it.id);
        inflight.set(it.id, {
          id: it.id, claimId: it.claimId, stableTicks: 0, seq: it.seq, prompt: it.prompt, prefix,
          submittedAt: it.submittedAt, lastPendingAt: Date.now(), sawPending: true, base
        });
      }
      await send({ type: 'RELEASE_ORPHANS', keepIds });
    }
    ready = true;
    const { run: now } = await getState();
    if (myTabId != null && now.tabId === myTabId && now.state !== 'idle') loop();
  })();
})();
