#!/usr/bin/env node
'use strict';
// Flow Queue MCP server (stdio, JSON-RPC 2.0, newline-delimited). Zero dependencies. Logs go to stderr only.
const fs = require('fs');
const path = require('path');
const lib = require('./lib');

const PROTOCOL = '2025-06-18';
const SUPPORTED = ['2025-06-18', '2025-03-26', '2024-11-05'];
const PORT = lib.getPort();
const WAIT_SLICE_SEC = 45; // DESIGN §7: flow_wait must return within 50 s per call (45 s + one poll round trip)
const elog = (...a) => process.stderr.write('[flow-queue-mcp] ' + a.join(' ') + '\n');

// DESIGN §10: operating rules come from agent-instructions.md (single source); never crash if it is missing.
const INSTRUCTIONS_FILE = path.join(__dirname, 'agent-instructions.md');
function loadInstructions() {
  try {
    const t = fs.readFileSync(INSTRUCTIONS_FILE, 'utf8').trim();
    if (t) return t;
  } catch (e) { /* fall through */ }
  elog('agent-instructions.md not found; using the short pointer');
  return 'Flow Queue: drive Google Flow prompt queues in the user\'s Chrome. Read ' + INSTRUCTIONS_FILE.replace(/\\/g, '/') +
    ' (or AGENTS.md) before acting; start with flow_doctor. Every generation spends the user\'s Flow credits.';
}
const INSTRUCTIONS = loadInstructions();

// ---------- daemon access ----------
let daemonReady = null;
function ensureDaemon() {
  if (!daemonReady) {
    daemonReady = lib.ensureDaemon({ port: PORT }).catch((e) => { daemonReady = null; throw e; });
  }
  return daemonReady;
}
async function call(method, params) {
  await ensureDaemon();
  try {
    return await lib.httpCall(method, params, { port: PORT });
  } catch (e) {
    if (e.code === 'daemon_unreachable' && e.status !== 401) { // daemon died since: restart once
      daemonReady = null;
      await ensureDaemon();
      return lib.httpCall(method, params, { port: PORT });
    }
    throw e;
  }
}

// ---------- tool definitions ----------
const strArr = (description, extra) => ({ type: 'array', items: { type: 'string' }, description, ...(extra || {}) });
const STATUSES = ['pending', 'running', 'done', 'failed', 'unknown', 'stopped'];
const noArgs = { type: 'object', properties: {}, additionalProperties: false };
const pick = (o, keys) => { const r = {}; for (const k of keys) if (o && o[k] !== undefined) r[k] = o[k]; return r; };

const TOOLS = [
  {
    name: 'flow_doctor',
    description: 'Diagnose the whole chain before doing anything else, and whenever another tool fails with daemon_unreachable / extension_not_connected / no_flow_tab. ' +
      'Read-only, free (no Flow credits); starts the local bridge daemon if it is down and says so in the "daemon" check. ' +
      'Returns {ok, checks:[{name: daemon|extension|flow_tab|queue, ok, code?, detail, fix, fix_en}]}. For each failed check relay "fix" (Traditional Chinese) to the user verbatim, ' +
      'wait for them to do it, then call flow_doctor again. Proceed only when ok is true.',
    inputSchema: noArgs,
    run: () => lib.doctor({ port: PORT, autoStart: true }),
  },
  {
    name: 'flow_status',
    description: 'Snapshot of the queue: run state (idle/running/paused, tab, cooldown), settings, item counts by status, open Google Flow tabs and bridge connection. ' +
      'Read-only and free. Use it to check progress or before deciding what to do after an error; use flow_doctor for setup problems.',
    inputSchema: noArgs,
    run: () => call('status', {}),
  },
  {
    name: 'flow_add_prompts',
    description: 'Queue prompts for Google Flow. Only queues them — nothing is generated until flow_start; but once started EVERY prompt spends the user\'s Flow credits, ' +
      'so tell the user how many prompts you are adding. Batches above the extension limit (default 20) fail with confirm_required: ask the user, and only after they agree resend with confirm: true. ' +
      'ALWAYS pass your own stable request_id and reuse the SAME request_id when retrying after a timeout/error — the extension then returns the first result instead of adding duplicates. ' +
      'Each prompt is a string or {prompt, images?, characters?, assets?}; top-level images/characters/assets apply to every prompt. characters/assets must be exact titles from flow_list_assets ' +
      '(a missing/ambiguous name fails that item without spending credits). images: local paths or public http(s) URLs, image/*, ≤ 10 MB each (each is uploaded once). ' +
      'Returns {added, ids, request_id, deduped?}. Keep the ids; next call flow_start (or pass start: true), then flow_wait with those ids, then flow_download.',
    inputSchema: {
      type: 'object',
      properties: {
        prompts: {
          type: 'array',
          minItems: 1,
          description: 'Prompts to queue, in order.',
          items: {
            anyOf: [
              { type: 'string' },
              {
                type: 'object',
                properties: {
                  prompt: { type: 'string', description: 'Prompt text.' },
                  images: strArr('Reference images for this prompt (local paths or public http(s) URLs).'),
                  characters: strArr('Exact Flow character titles to attach to this prompt.'),
                  assets: strArr('Exact Flow asset titles to attach to this prompt.'),
                },
                required: ['prompt'],
                additionalProperties: false,
              },
            ],
          },
        },
        images: strArr('Reference images attached to every prompt (local paths or public http(s) URLs).'),
        characters: strArr('Exact Flow character titles attached to every prompt.'),
        assets: strArr('Exact Flow asset titles attached to every prompt.'),
        request_id: { type: 'string', maxLength: 100, description: 'Your own idempotency key for this batch (e.g. a UUID). Always set it; reuse it verbatim when retrying the same batch. Same id within 10 minutes → first result is returned, nothing is added twice.' },
        confirm: { type: 'boolean', description: 'Set true ONLY after the user explicitly approved a batch larger than the limit (after a confirm_required error).' },
        to_top: { type: 'boolean', description: 'Insert before other pending items instead of appending.' },
        start: { type: 'boolean', description: 'Call flow_start right after adding (same auto tab choice; may fail with multiple_flow_tabs / no_flow_tab).' },
      },
      required: ['prompts'],
      additionalProperties: false,
    },
    run: async (a) => {
      const params = await lib.buildAddParams({
        prompts: a.prompts, images: a.images, characters: a.characters, assets: a.assets,
        toTop: !!a.to_top, requestId: a.request_id, confirm: a.confirm === true,
      }, call);
      const r = await call('add', params);
      r.request_id = params.requestId;
      if (a.start) r.started = await call('start', {});
      return r;
    },
  },
  {
    name: 'flow_list_queue',
    description: 'List queue items (id, status, prompt, error, results), optionally filtered by status, paginated. Read-only and free. ' +
      'Use it before re-adding anything after an error (to avoid duplicates) and to find ids for flow_retry / flow_download / flow_remove.',
    inputSchema: {
      type: 'object',
      properties: {
        status: {
          description: 'Status filter: one status or a list.',
          anyOf: [{ type: 'string', enum: STATUSES }, { type: 'array', items: { type: 'string', enum: STATUSES } }],
        },
        limit: { type: 'integer', minimum: 1, maximum: 1000, default: 100 },
        offset: { type: 'integer', minimum: 0, default: 0 },
      },
      additionalProperties: false,
    },
    run: (a) => call('list', pick(a, ['status', 'limit', 'offset'])),
  },
  {
    name: 'flow_get_item',
    description: 'Get one queue item by id: status, attempts, error, refs and results. Read-only and free. Fails with not_found for an unknown id.',
    inputSchema: { type: 'object', properties: { id: { type: 'string', minLength: 1 } }, required: ['id'], additionalProperties: false },
    run: (a) => call('get', { id: a.id }),
  },
  {
    name: 'flow_start',
    description: 'Start (or resume) processing pending items in a Google Flow project tab. SPENDS FLOW CREDITS for every item it submits. ' +
      'It uses the model / aspect ratio / output count currently selected in the Flow UI — if those matter, ask the user to set them first. ' +
      'Without tab_id it reuses the last run tab or the only open Flow project tab; if several project tabs are open it fails with multiple_flow_tabs listing them — ask the user which one and call again with tab_id. ' +
      'no_flow_tab → ask the user to open a Flow project. Returns {tabId, title, url, projectId}. Next: flow_wait with the ids you added.',
    inputSchema: { type: 'object', properties: { tab_id: { type: 'integer', description: 'Chrome tab id of a Flow project tab (from flow_status.flowTabs or the multiple_flow_tabs error).' } }, additionalProperties: false },
    run: (a) => call('start', a.tab_id != null ? { tabId: a.tab_id } : {}),
  },
  {
    name: 'flow_pause',
    description: 'Pause the queue: items already submitted to Flow finish, no new ones are submitted. Free. Resume with flow_start.',
    inputSchema: noArgs,
    run: () => call('pause', {}),
  },
  {
    name: 'flow_stop',
    description: 'Stop the queue now. Items in flight are marked unknown/stopped (credits for them may already be spent). Use only when the user asks to stop; prefer flow_pause otherwise.',
    inputSchema: noArgs,
    run: () => call('stop', {}),
  },
  {
    name: 'flow_retry',
    description: 'Put items back to pending so the next flow_start submits them again — this SPENDS CREDITS again. ' +
      'Default (no ids, no statuses): all "failed" items only. "unknown" items (sent, result not confirmed — they may already have generated and spent credits) are NEVER retried by default: ' +
      'ask the user to check Flow first, then pass their explicit ids AND confirm_unknown: true (otherwise unknown_requires_confirm). Returns {retried}. Next: flow_start, then flow_wait.',
    inputSchema: {
      type: 'object',
      properties: {
        ids: strArr('Item ids to retry.'),
        statuses: { type: 'array', items: { type: 'string', enum: ['failed', 'stopped', 'unknown'] }, description: 'Statuses to retry when no ids are given (default ["failed"]).' },
        confirm_unknown: { type: 'boolean', description: 'Required (true) to retry "unknown" items; set only after the user checked Flow and agreed.' },
      },
      additionalProperties: false,
    },
    run: (a) => {
      const p = {};
      if (a.ids && a.ids.length) p.ids = a.ids;
      else p.statuses = a.statuses && a.statuses.length ? a.statuses : ['failed'];
      if (a.confirm_unknown === true) p.confirmUnknown = true;
      return call('retry', p);
    },
  },
  {
    name: 'flow_remove',
    description: 'Delete items (and their result records) by id; running items are kept. Irreversible — flow_download results you still need first. Returns {removed}.',
    inputSchema: { type: 'object', properties: { ids: strArr('Item ids to remove.', { minItems: 1 }) }, required: ['ids'], additionalProperties: false },
    run: (a) => call('remove', { ids: a.ids }),
  },
  {
    name: 'flow_clear',
    description: 'Bulk-delete finished items: mode "done", "failed" or "all" (running items are kept). Irreversible — download results first. Only when the user asks. Returns {removed}.',
    inputSchema: { type: 'object', properties: { mode: { type: 'string', enum: ['done', 'failed', 'all'] } }, required: ['mode'], additionalProperties: false },
    run: (a) => call('clear', { mode: a.mode }),
  },
  {
    name: 'flow_settings',
    description: 'Read the queue settings, or change some with patch (e.g. {"maxConcurrent":2,"retries":1,"autoDownload":true,"delayMin":3,"delayMax":8}). ' +
      'Bridge settings (enable/port/token) cannot be changed here. Change settings only when the user asks. Returns {settings}.',
    inputSchema: {
      type: 'object',
      properties: { patch: { type: 'object', description: 'Settings keys to change.', additionalProperties: true } },
      additionalProperties: false,
    },
    run: (a) => call('settings', a.patch ? { patch: a.patch } : {}),
  },
  {
    name: 'flow_logs',
    description: 'Recent Flow Queue log lines (newest last): submissions, failures, rate limits, cooldowns. Read-only and free; use it to explain errors or stalls.',
    inputSchema: { type: 'object', properties: { limit: { type: 'integer', minimum: 1, maximum: 300, default: 50 } }, additionalProperties: false },
    run: (a) => call('logs', pick(a, ['limit'])),
  },
  {
    name: 'flow_list_assets',
    description: 'List assets in the open Google Flow project (images, characters, videos, uploads) with their exact titles — use those titles for characters/assets in flow_add_prompts. ' +
      'Read-only and free, but it scrolls the Flow tab\'s asset panel and can take up to ~60 s. Needs a Flow project tab (no_flow_tab / multiple_flow_tabs → pass tab_id).',
    inputSchema: {
      type: 'object',
      properties: {
        category: { type: 'string', enum: ['All', 'Images', 'Characters', 'Videos', 'Uploads'] },
        search: { type: 'string', description: 'Filter by title.' },
        tab_id: { type: 'integer' },
      },
      additionalProperties: false,
    },
    run: (a) => {
      const p = pick(a, ['category', 'search']);
      if (a.tab_id != null) p.tabId = a.tab_id;
      return call('listAssets', p);
    },
  },
  {
    name: 'flow_wait',
    description: 'Wait for the items you added (pass the ids returned by flow_add_prompts) to finish. Free. Each call returns within ~' + WAIT_SLICE_SEC + ' s: ' +
      'repeat while done is false. Returns {done, timedOut, stalled?, next?, run:{state,...}, counts (for those ids), items (only those ids, with results/errors)}. ' +
      'If stalled is set do NOT keep waiting blindly: paused → ask the user / flow_start; idle_not_started → flow_start; stopped → ask the user, flow_retry those ids; ' +
      'cooldown → Flow rate-limited, it resumes by itself (calling again later is fine). When done: flow_download the done ids and report failed/unknown ones to the user. ' +
      'whole_queue: true waits for the entire queue instead (only if you really mean everything).',
    inputSchema: {
      type: 'object',
      properties: {
        ids: strArr('Item ids to wait for (from flow_add_prompts). Required unless whole_queue is true.', { minItems: 1 }),
        whole_queue: { type: 'boolean', description: 'Wait for every pending/running item in the queue instead of specific ids.' },
        timeout_sec: { type: 'integer', minimum: 0, maximum: WAIT_SLICE_SEC, description: 'Max seconds for this call (capped at ' + WAIT_SLICE_SEC + ').' },
      },
      additionalProperties: false,
    },
    run: (a, ctx) => {
      if (!a.whole_queue && !(Array.isArray(a.ids) && a.ids.length)) {
        throw new lib.FQError('invalid_argument', 'ids is required: pass the ids returned by flow_add_prompts (or whole_queue: true)');
      }
      let n = 0;
      return lib.waitForQueue(call, {
        timeoutSec: Math.min(WAIT_SLICE_SEC, a.timeout_sec == null ? WAIT_SLICE_SEC : Math.max(0, Number(a.timeout_sec) || 0)),
        ids: a.whole_queue ? null : a.ids,
        wholeQueue: !!a.whole_queue,
        onTick: ({ counts }) => {
          if (ctx.progressToken == null || !counts) return;
          const message = 'pending ' + (counts.pending || 0) + ', running ' + (counts.running || 0) + ', done ' + (counts.done || 0) + ', failed ' + (counts.failed || 0);
          notify('notifications/progress', { progressToken: ctx.progressToken, progress: ++n, message });
        },
      });
    },
  },
  {
    name: 'flow_download',
    description: 'Download the results of finished ("done") items to the user\'s Chrome download folder and return absolute file paths. Free (no credits). ' +
      'Pass ids (usually the done ids from flow_wait) or all_done: true. Files already downloaded are reused (reused: true) instead of duplicated. ' +
      'wait (default true) waits up to ~60 s for Chrome to finish so the paths exist. Returns {files:[{id, seq, index, filename, path?, state, reused?}], errors:[{id, error}]}. ' +
      'Report the paths and any errors to the user. Download before flow_clear / flow_remove.',
    inputSchema: {
      type: 'object',
      properties: {
        ids: strArr('Item ids whose results to download.'),
        all_done: { type: 'boolean', description: 'Download every done item instead of specific ids.' },
        wait: { type: 'boolean', default: true, description: 'Wait for Chrome to finish the downloads (≤ 60 s) and return absolute paths.' },
      },
      additionalProperties: false,
    },
    run: (a) => {
      const hasIds = Array.isArray(a.ids) && a.ids.length;
      if (!hasIds && a.all_done !== true) throw new lib.FQError('invalid_argument', 'pass ids (from flow_wait / flow_list_queue) or all_done: true');
      const p = { wait: a.wait !== false };
      if (hasIds) p.ids = a.ids; else p.allDone = true;
      return call('download', p);
    },
  },
];
const TOOL_MAP = new Map(TOOLS.map((t) => [t.name, t]));

// ---------- minimal JSON-Schema argument check (types, required, enum, additionalProperties) ----------
function typeOk(v, t) {
  if (t === 'integer') return Number.isInteger(v);
  if (t === 'number') return typeof v === 'number' && isFinite(v);
  if (t === 'array') return Array.isArray(v);
  if (t === 'object') return v !== null && typeof v === 'object' && !Array.isArray(v);
  return typeof v === t;
}
function check(schema, v, where) {
  if (!schema) return;
  if (schema.anyOf) {
    const errs = [];
    for (const s of schema.anyOf) { try { check(s, v, where); return; } catch (e) { errs.push(e.message); } }
    throw new lib.FQError('invalid_argument', where + ': ' + errs[0]);
  }
  if (schema.type && !typeOk(v, schema.type)) throw new lib.FQError('invalid_argument', where + ' must be ' + schema.type);
  if (schema.enum && !schema.enum.includes(v)) throw new lib.FQError('invalid_argument', where + ' must be one of ' + schema.enum.join(', '));
  if (schema.type === 'string' && schema.minLength && v.length < schema.minLength) throw new lib.FQError('invalid_argument', where + ' must not be empty');
  if (schema.type === 'integer' || schema.type === 'number') {
    if (schema.minimum != null && v < schema.minimum) throw new lib.FQError('invalid_argument', where + ' must be ≥ ' + schema.minimum);
    if (schema.maximum != null && v > schema.maximum) throw new lib.FQError('invalid_argument', where + ' must be ≤ ' + schema.maximum);
  }
  if (schema.type === 'array') {
    if (schema.minItems && v.length < schema.minItems) throw new lib.FQError('invalid_argument', where + ' must have at least ' + schema.minItems + ' item(s)');
    v.forEach((x, i) => check(schema.items, x, where + '[' + i + ']'));
  }
  if (schema.type === 'object' && schema.properties) {
    for (const r of schema.required || []) if (v[r] === undefined) throw new lib.FQError('invalid_argument', 'missing required argument ' + (where ? where + '.' : '') + r);
    for (const [k, x] of Object.entries(v)) {
      if (schema.properties[k]) check(schema.properties[k], x, where ? where + '.' + k : k);
      else if (schema.additionalProperties === false) throw new lib.FQError('invalid_argument', 'unknown argument ' + (where ? where + '.' : '') + k);
    }
  }
}

// ---------- JSON-RPC plumbing ----------
function write(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n');
}
function notify(method, params) {
  write({ jsonrpc: '2.0', method, params });
}
const ok = (id, result) => ({ jsonrpc: '2.0', id, result });
const fail = (id, code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });

async function handle(msg) {
  if (!msg || typeof msg !== 'object' || msg.jsonrpc !== '2.0') return fail(msg && msg.id != null ? msg.id : null, -32600, 'Invalid Request');
  const { id, method, params } = msg;
  const isNotification = id === undefined;
  if (typeof method !== 'string') {
    return isNotification ? null : (('result' in msg || 'error' in msg) ? null : fail(id, -32600, 'Invalid Request'));
  }
  if (isNotification) {
    if (method === 'notifications/initialized') {
      ensureDaemon().catch((e) => elog('daemon not available yet:', e.message));
    }
    return null; // notifications/cancelled etc. are ignored
  }
  switch (method) {
    case 'initialize': {
      const want = params && params.protocolVersion;
      return ok(id, {
        protocolVersion: SUPPORTED.includes(want) ? want : PROTOCOL,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'flow-queue', title: 'Flow Queue', version: lib.VERSION },
        instructions: INSTRUCTIONS,
      });
    }
    case 'ping':
      return ok(id, {});
    case 'tools/list':
      return ok(id, { tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) });
    case 'tools/call': {
      const name = params && params.name;
      const tool = TOOL_MAP.get(name);
      if (!tool) return fail(id, -32602, 'Unknown tool: ' + name);
      const args = (params && params.arguments) || {};
      const ctx = { progressToken: params && params._meta ? params._meta.progressToken : undefined };
      try {
        check(tool.inputSchema, args, '');
        const result = await tool.run(args, ctx);
        return ok(id, { content: [{ type: 'text', text: JSON.stringify(result == null ? {} : result, null, 2) }], isError: false });
      } catch (e) {
        const info = lib.toErrorInfo(e);
        elog(name, 'failed [' + info.code + ']:', info.error);
        return ok(id, { content: [{ type: 'text', text: 'Error [' + info.code + ']: ' + info.error }], structuredContent: info, isError: true });
      }
    }
    case 'resources/list':
      return ok(id, { resources: [] });
    case 'prompts/list':
      return ok(id, { prompts: [] });
    default:
      return fail(id, -32601, 'Method not found: ' + method);
  }
}

async function dispatch(line) {
  let msg;
  try { msg = JSON.parse(line); } catch (e) { write(fail(null, -32700, 'Parse error')); return; }
  if (Array.isArray(msg)) {
    const out = (await Promise.all(msg.map((m) => handle(m).catch((e) => fail(m && m.id, -32603, e.message))))).filter(Boolean);
    if (out.length) write(out);
    return;
  }
  let res;
  try { res = await handle(msg); } catch (e) { res = fail(msg && msg.id != null ? msg.id : null, -32603, e.message); }
  if (res) write(res);
}

let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buf += chunk;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (line) dispatch(line);
  }
});
process.stdin.on('end', () => {
  if (buf.trim()) dispatch(buf.trim());
  setTimeout(() => process.exit(0), 100).unref();
});
process.stdout.on('error', () => process.exit(0));
elog('ready (daemon port ' + PORT + ')');
