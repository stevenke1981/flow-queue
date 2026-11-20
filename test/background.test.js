// 背景腳本（佇列狀態機、素材、FQ 橋接 API）的模擬測試：node test/background.test.js

const fs = require('fs'), vm = require('vm'), crypto = require('crypto');
const store = {}; const listeners = {};
const ev = (name) => ({ addListener: (f) => (listeners[name] = listeners[name] || []).push(f) });
const chrome = {
  runtime: { id: 'ext', onInstalled: ev('installed'), onStartup: ev('startup'), onMessage: ev('msg') },
  storage: { local: { get: async (keys) => { const o = {}; for (const k of [].concat(keys)) if (k in store) o[k] = JSON.parse(JSON.stringify(store[k])); return o; }, set: async (o) => Object.assign(store, JSON.parse(JSON.stringify(o))) } },
  sidePanel: { setPanelBehavior: async () => {} },
  tabs: { get: async (id) => ({ id, url: 'https://flow.google.com/project/abc', title: 'Flow' }), sendMessage: async () => ({ ok: true }), query: async () => [{ id: 7, url: 'https://flow.google.com/project/abc', title: 'Flow' }], onRemoved: ev('removed'), onUpdated: ev('updated') },
  scripting: { executeScript: async () => {} },
  debugger: { onDetach: ev('detach'), attach: async () => {}, detach: async () => {}, sendCommand: async () => {} },
  alarms: { create: () => {}, clear: async () => {}, onAlarm: ev('alarm') },
  downloads: { download: async () => 1 },
};
chrome.storage.session = { _d: {}, get: async (k) => ({ [k]: chrome.storage.session._d[k] }), set: async (o) => Object.assign(chrome.storage.session._d, o) };
chrome.storage.local.remove = async (keys) => { for (const k of [].concat(keys)) delete store[k]; };
const ctx = vm.createContext({ chrome, crypto: { randomUUID: () => crypto.randomUUID(), subtle: crypto.webcrypto.subtle }, atob, setTimeout, clearTimeout, console, Promise, Uint8Array, Map, Set });
const target = process.argv[2] || require('path').join(__dirname, '..', 'flow-queue', 'background.js');
ctx.importScripts = () => {};
vm.runInContext(fs.readFileSync(target, 'utf8'), ctx);
const send = (msg, tabId = 7) => new Promise((res) => listeners.msg[0](msg, { id: 'ext', tab: { id: tabId, url: 'https://flow.google.com/project/abc' } }, res));
const assert = (c, m) => { if (!c) { console.log('FAIL', m); process.exitCode = 1; } else console.log('ok  ', m); };
(async () => {
  await listeners.installed[0]();
  await send({ type: 'ADD_ITEMS', prompts: ['a cat', 'a dog', ' ', 'a bird'] });
  assert(store.queue.length === 3, 'adds 3 non-empty prompts');
  let r = await send({ type: 'CLAIM_NEXT' });
  assert(r.item === null, 'no claim while idle');
  await send({ type: 'START', tabId: 7 });
  assert(store.run.state === 'running' && store.run.projectId === 'abc', 'start sets running + projectId');
  r = await send({ type: 'START', tabId: 8 });
  assert(!r.ok, 'start on other tab refused while running');
  r = await send({ type: 'CLAIM_NEXT' }, 8);
  assert(r.item === null, 'other tab cannot claim');
  const a = (await send({ type: 'CLAIM_NEXT' })).item;
  assert(a.prompt === 'a cat' && a.claimId, 'claims first with claimId');
  r = await send({ type: 'UPDATE_ITEM', id: a.id, claimId: 'stale', patch: { status: 'done' } });
  assert(r.ignored, 'stale claimId ignored');
  await send({ type: 'UPDATE_ITEM', id: a.id, claimId: a.claimId, patch: { submittedAt: 1, status: 'done', attempts: 99 } });
  const sa = store.queue.find(x => x.id === a.id);
  assert(sa.status === 'done' && sa.attempts === 1, 'valid update applied, non-whitelisted key dropped');
  const b = (await send({ type: 'CLAIM_NEXT' })).item;
  r = await send({ type: 'ITEM_FAILED', id: b.id, claimId: b.claimId, error: 'x', retryable: true });
  assert(r.willRetry && store.queue.find(x => x.id === b.id).status === 'pending', 'fail with retries left -> pending');
  const b2 = (await send({ type: 'CLAIM_NEXT' })).item;
  assert(b2.id === b.id && b2.claimId !== b.claimId, 'reclaim gets new claimId');
  r = await send({ type: 'ITEM_FAILED', id: b.id, claimId: b.claimId, error: 'late' });
  assert(r.ignored, 'late failure from old claim ignored');
  await send({ type: 'ITEM_FAILED', id: b.id, claimId: b2.claimId, error: 'y' });
  assert(store.queue.find(x => x.id === b.id).status === 'failed', 'retries exhausted -> failed');
  const c = (await send({ type: 'CLAIM_NEXT' })).item;
  await send({ type: 'UPDATE_ITEM', id: c.id, claimId: c.claimId, patch: { submittedAt: 5 } });
  await send({ type: 'STOP' });
  const sc = store.queue.find(x => x.id === c.id);
  assert(store.run.state === 'idle' && sc.status === 'unknown', 'stop: submitted running item -> unknown');
  await send({ type: 'RETRY_ITEMS', statuses: ['failed'] });
  assert(store.queue.find(x => x.id === b.id).status === 'pending' && sc.status === 'unknown' && store.queue.find(x => x.id === c.id).status === 'unknown', 'retry failed leaves unknown alone');
  await send({ type: 'START', tabId: 7 });
  const d1 = (await send({ type: 'CLAIM_NEXT' })).item;
  await send({ type: 'SET_RUN', patch: { state: 'idle' } });
  assert(store.queue.find(x => x.id === d1.id).status === 'pending', 'SET_RUN idle releases unsubmitted running item');
  await send({ type: 'START', tabId: 7 });
  await listeners.updated[0](7, { url: 'https://flow.google.com/project/other' });
  await new Promise(r => setTimeout(r, 20));
  assert(store.run.state === 'idle', 'navigating to another project stops');
  await send({ type: 'SET_SETTINGS', patch: { maxConcurrent: 99, delayMin: 9, delayMax: 2, downloadFolder: '../x:y' } });
  assert(store.settings.maxConcurrent === 10 && store.settings.delayMax === 9 && store.settings.downloadFolder === 'x y', 'settings sanitized: ' + JSON.stringify(store.settings));
  // ---- v1.1: files, refs, FQ API ----
  const png = Buffer.concat([Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]), Buffer.alloc(32, 7)]).toString('base64');
  let f = await send({ type: 'ADD_FILE', name: 'ref.png', mime: 'text/plain', base64: png });
  assert(f.ok && /^[0-9a-f]{16}$/.test(f.fileId) && f.mime === 'image/png', 'ADD_FILE sniffs png and returns fileId');
  const bad = await send({ type: 'ADD_FILE', name: 'x.png', mime: 'image/png', base64: Buffer.from('hello world').toString('base64') });
  assert(!bad.ok, 'ADD_FILE rejects non-image bytes');
  const fileRef = { type: 'file', fileId: f.fileId, name: 'ref.png', mime: 'image/png' };
  r = await send({ type: 'ADD_ITEMS', prompts: ['p1', { prompt: 'p2', refs: [{ type: 'character', name: 'Bob' }] }, { prompt: '' }], refs: [fileRef, { type: 'asset', name: 'Sky', category: 'Bogus' }, { type: 'evil' }] });
  const p1 = store.queue.find(x => x.prompt === 'p1'), p2 = store.queue.find(x => x.prompt === 'p2');
  assert(r.added === 2 && r.ids.length === 2, 'ADD_ITEMS accepts string + object prompts, drops empty');
  assert(p1.refs.length === 2 && p1.refs[1].category === 'All' && p2.refs.length === 3 && p2.refs[2].name === 'Bob', 'refs normalized, batch refs prepended');
  r = await send({ type: 'ADD_ITEMS', prompts: ['p3'], refs: [{ type: 'file', fileId: '0123456789abcdef', name: 'ghost' }] });
  assert(!r.ok, 'unknown fileId rejected');
  await send({ type: 'REMOVE_ITEMS', ids: [p1.id, p2.id] });
  assert(store['file:' + f.fileId], 'GC keeps recently added file (grace period)');
  store.meta.files[f.fileId] = Date.now() - 11 * 60 * 1000;
  await send({ type: 'CLEAR', mode: 'all' });
  assert(!store['file:' + f.fileId], 'GC removes unreferenced old file');
  await send({ type: 'SET_SETTINGS', patch: { bridgeToken: 'A'.repeat(64), evilKey: 1 } });
  assert(store.settings.bridgeToken === 'a'.repeat(64) && !('evilKey' in store.settings), 'token normalized, unknown settings key dropped');
  const FQ = ctx.FQ;
  const st = await FQ.call('status');
  assert(!('bridgeToken' in st.settings) && st.settings.bridgePaired === true, 'FQ status hides token');
  await FQ.call('settings', { patch: { bridgeEnabled: true, bridgeToken: '', retries: 3 } });
  assert(store.settings.bridgeEnabled === false && store.settings.bridgeToken === 'a'.repeat(64) && store.settings.retries === 3, 'bridge cannot change bridge settings');
  const [a1, a2] = await Promise.all([FQ.call('add', { prompts: ['dup'], requestId: 'r1' }), FQ.call('add', { prompts: ['dup'], requestId: 'r1' })]);
  assert(store.queue.filter(x => x.prompt === 'dup').length === 1 && a1.ids[0] === a2.ids[0], 'concurrent duplicate requestId adds once');
  const a3 = await FQ.call('add', { prompts: ['dup'], requestId: 'r1' });
  assert(a3.ids[0] === a1.ids[0], 'repeated requestId returns first result');
  const lst = await FQ.call('list', { status: 'pending' });
  assert(lst.total >= 1, 'FQ list by status');
  await listeners.startup[0]();
  assert(store.run.state === 'idle' && store.run.tabId === null, 'startup resets run');
})();
