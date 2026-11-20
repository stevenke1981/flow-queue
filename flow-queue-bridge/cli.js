#!/usr/bin/env node
'use strict';
// flowq — command-line client for the Flow Queue bridge daemon (same HTTP transport as the MCP server).
const fs = require('fs');
const lib = require('./lib');

const HELP = `flowq — control the Flow Queue Chrome extension

Usage: flowq <command> [options] [--json]

  pair                         print the pairing token to paste into the side panel (creates it if missing)
  status                       run state, counts, Flow tabs, bridge
  add <prompt...>              queue prompts (each argument is one prompt)
      -f, --file <path|->      read prompts from a file (- = stdin)
      --split blank|line       how to split the file (default blank: separated by empty lines)
      --image <path|url>       reference image for every prompt (repeatable)
      --character <name>       Flow character for every prompt (repeatable)
      --asset <name>           Flow asset title for every prompt (repeatable)
      --top                    insert before other pending items
      --start                  start the queue afterwards
  start [--tab <id>]           start / resume
  pause | stop
  list [--status s[,s]] [--limit n] [--offset n]
  get <id>
  retry [ids...]               default: all failed/unknown/stopped
  remove <ids...>
  clear <done|failed|all>
  assets [--category c] [--search s]
  logs [--limit n]
  wait [--timeout sec] [ids...] wait until nothing is pending/running (default 1800 s)
  settings [key=value...]      show or change settings

Environment: FLOW_QUEUE_PORT (default 17345)
`;

// ---------- argv parsing ----------
const VALUE_FLAGS = new Set(['file', 'split', 'image', 'character', 'asset', 'status', 'limit', 'offset', 'category', 'search', 'timeout', 'tab']);
const ALIASES = { f: 'file', h: 'help', j: 'json' };
function parse(argv) {
  const pos = [];
  const opt = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') { pos.push(...argv.slice(i + 1)); break; }
    let m = /^--([^=]+)(?:=(.*))?$/.exec(a) || (/^-([a-z])$/i.exec(a) && [a, a.slice(1)]);
    if (!m) { pos.push(a); continue; }
    const key = ALIASES[m[1]] || m[1];
    let val = m[2];
    if (VALUE_FLAGS.has(key)) {
      if (val === undefined) {
        if (i + 1 >= argv.length) throw new Error('--' + key + ' needs a value');
        val = argv[++i];
      }
      (opt[key] = opt[key] || []).push(val);
    } else {
      opt[key] = val === undefined ? true : val;
    }
  }
  return { pos, opt };
}
const one = (opt, k) => (opt[k] ? opt[k][opt[k].length - 1] : undefined);
const many = (opt, k) => (opt[k] || []).flatMap((v) => String(v).split(',')).map((s) => s.trim()).filter(Boolean);
const ids = (pos) => pos.flatMap((v) => v.split(',')).map((s) => s.trim()).filter(Boolean);

function splitPrompts(text, mode) {
  text = String(text).replace(/\r\n?/g, '\n');
  const parts = mode === 'line' ? text.split('\n') : text.split(/\n\s*\n/);
  return parts.map((s) => s.trim()).filter(Boolean);
}

function parseValue(v) {
  if (v === 'true') return true;
  if (v === 'false') return false;
  if (v !== '' && !isNaN(Number(v))) return Number(v);
  try { return JSON.parse(v); } catch (e) { return v; }
}

// ---------- output ----------
const short = (s, n = 70) => { s = String(s || '').replace(/\s+/g, ' '); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
function printItems(items) {
  if (!items || !items.length) { console.log('(no items)'); return; }
  for (const it of items) {
    let line = it.id + '  ' + String(it.status).padEnd(8) + '  ' + short(it.prompt);
    if (it.error) line += '\n    error: ' + short(it.error, 120);
    if (it.results && it.results.length) line += '\n    results: ' + it.results.length;
    console.log(line);
  }
}
function printStatus(s) {
  const c = s.counts || {};
  console.log('run:     ' + (s.run ? s.run.state + (s.run.tabId != null ? ' (tab ' + s.run.tabId + ')' : '') + (s.run.message ? ' — ' + s.run.message : '') : '?'));
  console.log('queue:   total ' + (c.total || 0) + ', pending ' + (c.pending || 0) + ', running ' + (c.running || 0) + ', done ' + (c.done || 0) +
    ', failed ' + (c.failed || 0) + ', unknown ' + (c.unknown || 0) + ', stopped ' + (c.stopped || 0));
  const tabs = s.flowTabs || [];
  console.log('flow tabs: ' + (tabs.length ? '' : '(none)'));
  for (const t of tabs) console.log('  [' + t.tabId + '] ' + short(t.title, 50) + '  ' + t.url);
}

// ---------- main ----------
async function main() {
  const { pos, opt } = parse(process.argv.slice(2));
  const cmd = pos.shift();
  if (!cmd || opt.help || cmd === 'help') { process.stdout.write(HELP); return; }
  const json = !!opt.json;
  const out = (r, human) => { if (json || !human) console.log(JSON.stringify(r, null, 2)); else human(r); };

  if (cmd === 'pair') {
    const token = lib.ensureToken();
    if (json) { console.log(JSON.stringify({ token, path: lib.tokenPath() })); return; }
    console.log(token);
    process.stderr.write('\n↑ 配對碼（存放於 ' + lib.tokenPath() + '）\n  請貼到 Flow Queue 側邊面板的「AI 橋接」配對碼欄位並啟用橋接。\n' +
      '  Paste this token into the Flow Queue side panel (AI bridge → pairing token) and enable the bridge.\n');
    return;
  }

  const port = lib.getPort();
  await lib.ensureDaemon({ port });
  const call = (m, p) => lib.httpCall(m, p, { port });

  switch (cmd) {
    case 'status':
      return out(await call('status', {}), printStatus);
    case 'add': {
      let prompts = pos.slice();
      const file = one(opt, 'file');
      if (file) {
        const text = file === '-' ? fs.readFileSync(0, 'utf8') : fs.readFileSync(file, 'utf8');
        prompts.push(...splitPrompts(text, one(opt, 'split') || 'blank'));
      }
      prompts = prompts.map((p) => p.trim()).filter(Boolean);
      if (!prompts.length) throw new Error('no prompts given (flowq add "a prompt" or -f prompts.txt)');
      const params = await lib.buildAddParams({
        prompts, images: opt.image || [], characters: opt.character || [], assets: opt.asset || [], toTop: !!opt.top,
        requestId: one(opt, 'request-id'),
      }, call);
      const r = await call('add', params);
      if (opt.start) {
        try { r.started = await call('start', {}); } catch (e) { r.startError = String((e && e.message) || e); console.error('added, but start failed: ' + r.startError); }
      }
      return out(r, (x) => console.log('added ' + x.added + (x.started ? '; started on tab ' + x.started.tabId : '')));
    }
    case 'start': {
      const tab = one(opt, 'tab');
      return out(await call('start', tab ? { tabId: Number(tab) } : {}), (x) => console.log('started on tab ' + x.tabId));
    }
    case 'pause':
    case 'stop':
      return out(await call(cmd, {}), () => console.log(cmd === 'pause' ? 'paused' : 'stopped'));
    case 'list': {
      const p = {};
      const st = many(opt, 'status');
      if (st.length) p.status = st.length === 1 ? st[0] : st;
      if (one(opt, 'limit')) p.limit = Number(one(opt, 'limit'));
      if (one(opt, 'offset')) p.offset = Number(one(opt, 'offset'));
      return out(await call('list', p), (x) => { printItems(x.items); if (x.total > x.items.length) console.log('… ' + x.total + ' total'); });
    }
    case 'get': {
      if (!pos[0]) throw new Error('usage: flowq get <id>');
      return out(await call('get', { id: pos[0] }), (x) => console.log(JSON.stringify(x.item, null, 2)));
    }
    case 'retry': {
      const list = ids(pos);
      return out(await call('retry', list.length ? { ids: list } : {}), (x) => console.log('retried ' + x.retried));
    }
    case 'remove': {
      const list = ids(pos);
      if (!list.length) throw new Error('usage: flowq remove <ids...>');
      return out(await call('remove', { ids: list }), (x) => console.log('removed ' + x.removed));
    }
    case 'clear': {
      const mode = pos[0];
      if (!['done', 'failed', 'all'].includes(mode)) throw new Error('usage: flowq clear <done|failed|all>');
      return out(await call('clear', { mode }), (x) => console.log('removed ' + x.removed));
    }
    case 'assets': {
      const p = {};
      if (one(opt, 'category')) p.category = one(opt, 'category');
      if (one(opt, 'search')) p.search = one(opt, 'search');
      if (one(opt, 'tab')) p.tabId = Number(one(opt, 'tab'));
      return out(await call('listAssets', p), (x) => {
        if (!x.assets || !x.assets.length) return console.log('(no assets)');
        for (const a of x.assets) console.log(String(a.type || '').padEnd(10) + '  ' + a.title);
      });
    }
    case 'logs': {
      const p = one(opt, 'limit') ? { limit: Number(one(opt, 'limit')) } : {};
      return out(await call('logs', p), (x) => {
        for (const l of x.logs || []) console.log(new Date(l.t).toLocaleString() + '  ' + (l.level && l.level !== 'info' ? '[' + l.level + '] ' : '') + l.text);
      });
    }
    case 'wait': {
      const timeoutSec = one(opt, 'timeout') ? Number(one(opt, 'timeout')) : 1800;
      const list = ids(pos);
      const r = await lib.waitForQueue(call, {
        timeoutSec, ids: list.length ? list : null,
        onTick: ({ status }) => {
          if (json || !status) return;
          const c = status.counts || {};
          process.stderr.write('\rpending ' + (c.pending || 0) + '  running ' + (c.running || 0) + '  done ' + (c.done || 0) + '  failed ' + (c.failed || 0) + '   ');
        },
      });
      if (!json) process.stderr.write('\n');
      out(r, (x) => {
        console.log(x.done ? 'finished' : 'timed out');
        printItems(x.items);
      });
      if (!r.done) process.exitCode = 2;
      return;
    }
    case 'settings': {
      const patch = {};
      for (const kv of pos) {
        const i = kv.indexOf('=');
        if (i <= 0) throw new Error('settings expects key=value, got: ' + kv);
        patch[kv.slice(0, i)] = parseValue(kv.slice(i + 1));
      }
      const r = await call('settings', Object.keys(patch).length ? { patch } : {});
      return out(r, (x) => console.log(JSON.stringify(x.settings, null, 2)));
    }
    default:
      throw new Error('unknown command: ' + cmd + ' (flowq help)');
  }
}

main().catch((e) => {
  console.error('flowq: ' + e.message);
  process.exitCode = 1;
});
