#!/usr/bin/env node
'use strict';
// flowq — command-line client for the Flow Queue bridge daemon (same HTTP transport as the MCP server).
// Output: JSON on stdout when stdout is not a TTY (agents, pipes); text on a terminal. --json / --human override.
// Exit codes: 0 ok · 1 error (JSON {ok:false, code, error}) · 2 usage error (code invalid_argument).
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const lib = require('./lib');

const HELP = `flowq — control the Flow Queue Chrome extension (Google Flow prompt queue)

Usage: flowq <command> [options] [--json | --human]

Setup / diagnostics
  doctor [--no-start]          check daemon → extension → Flow tab → queue (starts the daemon unless --no-start)
  pair --copy                  copy the pairing code to the clipboard (paste it into the side panel)
  pair                         print the pairing code (humans only — never paste it into chats)
  install-mcp [claude|codex|agy|all] [--dry-run]
                               register the MCP server in Claude Code / Codex CLI / Antigravity
  agent-guide                  print the operating rules for AI agents (agent-instructions.md)

Queue
  status                       run state, counts, Flow tabs, bridge
  add <prompt...>              queue prompts (each argument is one prompt); prints {added, ids, request_id}
      -f, --file <path|->      read prompts from a file (- = stdin)
      --split blank|line       how to split the file (default blank: separated by empty lines)
      --image <path|url>       reference image for every prompt (repeatable)
      --character <name>       Flow character for every prompt (repeatable)
      --asset <name>           Flow asset title for every prompt (repeatable)
      --request-id <id>        idempotency key; reuse it when retrying the same batch
      --confirm                allow a batch above the limit (only after the user agreed)
      --top                    insert before other pending items
      --start                  start the queue afterwards
  start [--tab <id>]           start / resume (several Flow project tabs → pass --tab)
  pause | stop
  list [--status s[,s]] [--limit n] [--offset n]
  get <id>
  retry [ids...] [--status s] [--confirm-unknown]
                               default: failed items only; "unknown" needs ids + --confirm-unknown
  remove <ids...>
  clear <done|failed|all>
  assets [--category c] [--search s] [--tab id]
  logs [--limit n]
  wait <ids...> | --all [--timeout sec]
                               wait until those items finish (default 1800 s); exit 1 if not done
  download [ids...] | --all-done [--no-wait]
                               download results; prints absolute paths
  settings [key=value...]      show or change settings

Environment: FLOW_QUEUE_PORT (default 17345)
`;

// ---------- argv parsing ----------
const VALUE_FLAGS = new Set(['file', 'split', 'image', 'character', 'asset', 'status', 'limit', 'offset', 'category', 'search', 'timeout', 'tab', 'request-id']);
const BOOL_FLAGS = new Set(['json', 'human', 'help', 'top', 'start', 'confirm', 'confirm-unknown', 'all', 'all-done', 'no-wait', 'no-start', 'dry-run', 'copy']);
const ALIASES = { f: 'file', h: 'help', j: 'json' };
function parse(argv) {
  const pos = [];
  const opt = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') { pos.push(...argv.slice(i + 1)); break; }
    const m = /^--([^=]+)(?:=(.*))?$/.exec(a) || (/^-([a-z])$/i.exec(a) && [a, a.slice(1)]);
    if (!m) { pos.push(a); continue; }
    const key = ALIASES[m[1]] || m[1];
    let val = m[2];
    if (VALUE_FLAGS.has(key)) {
      if (val === undefined) {
        if (i + 1 >= argv.length) throw lib.usageError('--' + key + ' needs a value');
        val = argv[++i];
      }
      (opt[key] = opt[key] || []).push(val);
    } else if (BOOL_FLAGS.has(key)) {
      if (val !== undefined && !/^(true|false|1|0)$/i.test(val)) throw lib.usageError('--' + key + ' does not take a value');
      opt[key] = val === undefined ? true : /^(true|1)$/i.test(val);
    } else {
      throw lib.usageError('unknown option ' + a + ' (flowq help)');
    }
  }
  return { pos, opt };
}
const one = (opt, k) => (opt[k] ? opt[k][opt[k].length - 1] : undefined);
const many = (opt, k) => (opt[k] || []).flatMap((v) => String(v).split(',')).map((s) => s.trim()).filter(Boolean);
const ids = (pos) => pos.flatMap((v) => v.split(',')).map((s) => s.trim()).filter(Boolean);
function intOpt(opt, k) {
  const v = one(opt, k);
  if (v === undefined) return undefined;
  if (!/^\d+$/.test(v)) throw lib.usageError('--' + k + ' must be a non-negative integer');
  return Number(v);
}

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

function copyToClipboard(text) {
  const custom = process.env.FLOW_QUEUE_CLIPBOARD_CMD; // tests: a .js script that receives the text on stdin
  const tries = custom ? [[process.execPath, [custom]]]
    : process.platform === 'win32' ? [['clip', []]]
    : process.platform === 'darwin' ? [['pbcopy', []]]
    : [['wl-copy', []], ['xclip', ['-selection', 'clipboard']], ['xsel', ['--clipboard', '--input']]];
  for (const [cmd, args] of tries) {
    const r = spawnSync(cmd, args, { input: text, windowsHide: true, stdio: ['pipe', 'ignore', 'ignore'], timeout: 10000 });
    if (!r.error && r.status === 0) return cmd;
  }
  return null;
}

// ---------- human output ----------
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
function printDoctor(r) {
  for (const c of r.checks) {
    console.log((c.ok ? '[ok] ' : '[!!] ') + c.name.padEnd(9) + ' ' + c.detail + (c.code ? '  (' + c.code + ')' : ''));
    if (c.fix) console.log('             → ' + c.fix);
  }
  console.log(r.ok ? '\nall checks passed' : '\nsome checks failed');
}

// ---------- main ----------
let jsonMode = !process.stdout.isTTY;

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--human')) jsonMode = false;
  if (argv.includes('--json')) jsonMode = true;
  const { pos, opt } = parse(argv);
  const cmd = pos.shift();
  if (opt.help || cmd === 'help') { process.stdout.write(HELP); return; }
  if (!cmd) { process.stderr.write(HELP); throw lib.usageError('missing command'); }
  const out = (r, human) => { if (jsonMode || !human) console.log(JSON.stringify(r, null, 2)); else human(r); };
  const port = lib.getPort();
  let daemonUp = false;
  const call = async (m, p) => {
    if (!daemonUp) { await lib.ensureDaemon({ port }); daemonUp = true; }
    return lib.httpCall(m, p, { port });
  };

  switch (cmd) {
    case 'pair': {
      const token = lib.ensureToken();
      if (opt.copy) {
        const via = copyToClipboard(token);
        if (!via) throw new lib.FQError('extension_error', 'could not copy to the clipboard (no clip/pbcopy/wl-copy/xclip/xsel); run "flowq pair" in a terminal and copy it by hand');
        return out({ ok: true, copied: true, via: path.basename(via), path: lib.tokenPath() }, () =>
          console.log('配對碼已複製到剪貼簿。請貼到 Flow Queue 側邊面板 →「設定」→「AI 代理橋接」→「配對碼」，並勾選「允許 AI 代理控制」。\n(The pairing code was copied to the clipboard.)'));
      }
      if (jsonMode && !opt.json) {
        // never dump the secret into a pipe/agent transcript by accident
        throw lib.usageError('refusing to print the pairing code to a non-terminal; use "flowq pair --copy" (or --human to force)');
      }
      if (jsonMode) { console.log(JSON.stringify({ token, path: lib.tokenPath() })); return; }
      console.log(token);
      process.stderr.write('\n↑ 配對碼（存放於 ' + lib.tokenPath() + '）。建議改用 flowq pair --copy 直接複製到剪貼簿。\n');
      return;
    }
    case 'agent-guide': {
      const f = path.join(__dirname, 'agent-instructions.md');
      let text;
      try { text = fs.readFileSync(f, 'utf8'); } catch (e) { throw new lib.FQError('not_found', 'agent-instructions.md not found next to cli.js'); }
      if (opt.json) console.log(JSON.stringify({ ok: true, path: f.replace(/\\/g, '/'), text }));
      else process.stdout.write(text.endsWith('\n') ? text : text + '\n');
      return;
    }
    case 'doctor': {
      const r = await lib.doctor({ port, autoStart: !opt['no-start'] });
      out(r, printDoctor);
      if (!r.ok) process.exitCode = 1;
      return;
    }
    case 'install-mcp': {
      const { installMcp } = require('./install');
      const targets = pos.length ? pos : ['all'];
      const r = installMcp({ targets, dryRun: !!opt['dry-run'] });
      out(r, (x) => {
        console.log((x.dryRun ? '[dry run] ' : '') + 'MCP server: ' + x.server.command + ' ' + x.server.args.join(' '));
        for (const it of x.results) {
          console.log('  ' + it.target.padEnd(11) + it.status.padEnd(13) + (it.file ? it.file + '  ' : '') + it.detail);
          if (it.backup) console.log('             backup: ' + it.backup);
        }
      });
      if (!r.ok) process.exitCode = 1;
      return;
    }
    case 'status':
      return out(await call('status', {}), printStatus);
    case 'add': {
      let prompts = pos.slice();
      const file = one(opt, 'file');
      if (file) {
        let text;
        try { text = file === '-' ? fs.readFileSync(0, 'utf8') : fs.readFileSync(file, 'utf8'); } catch (e) { throw new lib.FQError('invalid_argument', 'cannot read ' + file + ': ' + e.message); }
        const split = one(opt, 'split') || 'blank';
        if (!['blank', 'line'].includes(split)) throw lib.usageError('--split must be blank or line');
        prompts.push(...splitPrompts(text, split));
      }
      prompts = prompts.map((p) => p.trim()).filter(Boolean);
      if (!prompts.length) throw lib.usageError('no prompts given (flowq add "a prompt" or -f prompts.txt)');
      const params = await lib.buildAddParams({
        prompts, images: opt.image || [], characters: opt.character || [], assets: opt.asset || [], toTop: !!opt.top,
        requestId: one(opt, 'request-id'), confirm: !!opt.confirm,
      }, call);
      const r = await call('add', params);
      r.request_id = params.requestId;
      if (opt.start) r.started = await call('start', {});
      return out(r, (x) => console.log('added ' + x.added + (x.deduped ? ' (duplicate request_id: first result returned)' : '') +
        ' — ids: ' + (x.ids || []).join(' ') + '\nrequest_id: ' + x.request_id + (x.started ? '\nstarted on tab ' + x.started.tabId + ' ' + (x.started.title || '') : '')));
    }
    case 'start': {
      const tab = one(opt, 'tab');
      if (tab !== undefined && !/^\d+$/.test(tab)) throw lib.usageError('--tab must be a tab id (number)');
      return out(await call('start', tab ? { tabId: Number(tab) } : {}), (x) => console.log('started on tab ' + x.tabId + (x.title ? ' 「' + x.title + '」' : '') + (x.projectId ? ' project ' + x.projectId : '')));
    }
    case 'pause':
    case 'stop':
      return out(await call(cmd, {}), () => console.log(cmd === 'pause' ? 'paused' : 'stopped'));
    case 'list': {
      const p = {};
      const st = many(opt, 'status');
      if (st.length) p.status = st.length === 1 ? st[0] : st;
      if (intOpt(opt, 'limit') !== undefined) p.limit = intOpt(opt, 'limit');
      if (intOpt(opt, 'offset') !== undefined) p.offset = intOpt(opt, 'offset');
      return out(await call('list', p), (x) => { printItems(x.items); if (x.total > x.items.length) console.log('… ' + x.total + ' total'); });
    }
    case 'get': {
      if (!pos[0]) throw lib.usageError('usage: flowq get <id>');
      return out(await call('get', { id: pos[0] }), (x) => console.log(JSON.stringify(x.item, null, 2)));
    }
    case 'retry': {
      const list = ids(pos);
      const p = list.length ? { ids: list } : { statuses: many(opt, 'status').length ? many(opt, 'status') : ['failed'] };
      if (opt['confirm-unknown']) p.confirmUnknown = true;
      return out(await call('retry', p), (x) => console.log('retried ' + x.retried));
    }
    case 'remove': {
      const list = ids(pos);
      if (!list.length) throw lib.usageError('usage: flowq remove <ids...>');
      return out(await call('remove', { ids: list }), (x) => console.log('removed ' + x.removed));
    }
    case 'clear': {
      const mode = pos[0];
      if (!['done', 'failed', 'all'].includes(mode)) throw lib.usageError('usage: flowq clear <done|failed|all>');
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
      const p = intOpt(opt, 'limit') !== undefined ? { limit: intOpt(opt, 'limit') } : {};
      return out(await call('logs', p), (x) => {
        for (const l of x.logs || []) console.log(new Date(l.t).toLocaleString() + '  ' + (l.level && l.level !== 'info' ? '[' + l.level + '] ' : '') + l.text);
      });
    }
    case 'wait': {
      const list = ids(pos);
      if (!list.length && !opt.all) throw lib.usageError('usage: flowq wait <ids...> (the ids printed by flowq add) or flowq wait --all');
      const timeoutSec = intOpt(opt, 'timeout') !== undefined ? intOpt(opt, 'timeout') : 1800;
      const r = await lib.waitForQueue(call, {
        timeoutSec, ids: list.length ? list : null, wholeQueue: !list.length,
        onTick: ({ counts }) => {
          if (jsonMode || !counts) return;
          process.stderr.write('\rpending ' + (counts.pending || 0) + '  running ' + (counts.running || 0) + '  done ' + (counts.done || 0) + '  failed ' + (counts.failed || 0) + '   ');
        },
      });
      if (!jsonMode) process.stderr.write('\n');
      if (r.done) return out(r, (x) => { console.log('finished'); printItems(x.items); });
      process.exitCode = 1;
      const err = { ok: false, code: r.stalled && r.stalled !== 'cooldown' ? 'stalled' : 'timeout', error: r.next, ...r };
      return out(err, (x) => { console.log((x.stalled ? 'stalled: ' + x.stalled : 'timed out') + ' — ' + x.next); printItems(x.items); });
    }
    case 'download': {
      const list = ids(pos);
      if (!list.length && !opt['all-done']) throw lib.usageError('usage: flowq download <ids...> or flowq download --all-done');
      const p = { wait: !opt['no-wait'] };
      if (list.length) p.ids = list; else p.allDone = true;
      const r = await call('download', p);
      if (r && r.errors && r.errors.length && !(r.files && r.files.length)) process.exitCode = 1;
      return out(r, (x) => {
        for (const f of x.files || []) console.log((f.path || f.filename) + (f.reused ? '  (already downloaded)' : '') + (f.state && f.state !== 'complete' ? '  [' + f.state + ']' : ''));
        for (const e of x.errors || []) console.log('error ' + e.id + (e.index ? '#' + e.index : '') + ': ' + e.error);
        if (!(x.files || []).length && !(x.errors || []).length) console.log('(nothing to download)');
      });
    }
    case 'settings': {
      const patch = {};
      for (const kv of pos) {
        const i = kv.indexOf('=');
        if (i <= 0) throw lib.usageError('settings expects key=value, got: ' + kv);
        patch[kv.slice(0, i)] = parseValue(kv.slice(i + 1));
      }
      const r = await call('settings', Object.keys(patch).length ? { patch } : {});
      return out(r, (x) => console.log(JSON.stringify(x.settings, null, 2)));
    }
    default:
      throw lib.usageError('unknown command: ' + cmd + ' (flowq help)');
  }
}

main().catch((e) => {
  const info = lib.toErrorInfo(e);
  if (jsonMode) console.log(JSON.stringify({ ok: false, code: info.code, error: info.error }));
  else console.error('flowq: [' + info.code + '] ' + info.error);
  process.exitCode = e && e.usage ? 2 : 1;
});
