#!/usr/bin/env node
'use strict';
// Flow Queue MCP server (stdio, JSON-RPC 2.0, newline-delimited). Zero dependencies. Logs go to stderr only.
const lib = require('./lib');

const PROTOCOL = '2025-06-18';
const SUPPORTED = ['2025-06-18', '2025-03-26', '2024-11-05'];
const PORT = lib.getPort();
const WAIT_SLICE_SEC = 45; // DESIGN §7: flow_wait must return within 50 s per call (45 s + one poll round trip)
const elog = (...a) => process.stderr.write('[flow-queue-mcp] ' + a.join(' ') + '\n');

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
    if (/daemon is not running/.test(e.message)) { // daemon died since: restart once
      daemonReady = null;
      await ensureDaemon();
      return lib.httpCall(method, params, { port: PORT });
    }
    throw e;
  }
}

// ---------- tool definitions ----------
const strArr = (description) => ({ type: 'array', items: { type: 'string' }, description });
const STATUSES = ['pending', 'running', 'done', 'failed', 'unknown', 'stopped'];
const noArgs = { type: 'object', properties: {}, additionalProperties: false };

const TOOLS = [
  {
    name: 'flow_status',
    description: 'Get Flow Queue status: run state, settings, item counts by status, open Google Flow tabs, and bridge connection.',
    inputSchema: noArgs,
    run: () => call('status', {}),
  },
  {
    name: 'flow_add_prompts',
    description: 'Add prompts to the Flow Queue. Each prompt may be a string or an object with its own reference images/characters/assets. ' +
      'Top-level images/characters/assets apply to every prompt in the batch. images are local file paths or http(s) URLs (image/*, at most 10 MB each; URLs must be public http(s)); ' +
      'characters and assets are names of existing assets in the Flow project. Set start=true to start the queue afterwards.',
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
                  images: strArr('Reference images for this prompt (local paths or http(s) URLs).'),
                  characters: strArr('Flow character names to attach to this prompt.'),
                  assets: strArr('Flow asset titles to attach to this prompt.'),
                },
                required: ['prompt'],
                additionalProperties: false,
              },
            ],
          },
        },
        images: strArr('Reference images attached to every prompt (local paths or http(s) URLs).'),
        characters: strArr('Flow character names attached to every prompt.'),
        assets: strArr('Flow asset titles attached to every prompt.'),
        to_top: { type: 'boolean', description: 'Insert before other pending items instead of appending.' },
        start: { type: 'boolean', description: 'Start the queue after adding.' },
        request_id: { type: 'string', description: 'Optional idempotency key. Re-sending the same request_id within 10 minutes returns the first result instead of adding the prompts again.' },
      },
      required: ['prompts'],
      additionalProperties: false,
    },
    run: async (a) => {
      const params = await lib.buildAddParams({ prompts: a.prompts, images: a.images, characters: a.characters, assets: a.assets, toTop: !!a.to_top, requestId: a.request_id }, call);
      const r = await call('add', params);
      r.request_id = params.requestId;
      // 已成功加入後啟動失敗，不能回報整體失敗，否則代理重試會重複加入
      if (a.start) {
        try { r.started = await call('start', {}); } catch (e) { r.startError = String((e && e.message) || e); }
      }
      return r;
    },
  },
  {
    name: 'flow_list_queue',
    description: 'List queue items (newest data from the extension), optionally filtered by status.',
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
    description: 'Get one queue item by id, including status, error and results.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'], additionalProperties: false },
    run: (a) => call('get', { id: a.id }),
  },
  {
    name: 'flow_start',
    description: 'Start (or resume) processing the queue in a Google Flow tab. Auto-picks the tab when tab_id is omitted.',
    inputSchema: { type: 'object', properties: { tab_id: { type: 'integer', description: 'Chrome tab id of a Flow tab (see flow_status).' } }, additionalProperties: false },
    run: (a) => call('start', a.tab_id != null ? { tabId: a.tab_id } : {}),
  },
  {
    name: 'flow_pause',
    description: 'Pause the queue after the current item(s).',
    inputSchema: noArgs,
    run: () => call('pause', {}),
  },
  {
    name: 'flow_stop',
    description: 'Stop the queue now.',
    inputSchema: noArgs,
    run: () => call('stop', {}),
  },
  {
    name: 'flow_retry',
    description: 'Reset items back to pending. With ids: those items; otherwise all items whose status is in statuses (default failed, unknown, stopped).',
    inputSchema: {
      type: 'object',
      properties: { ids: strArr('Item ids to retry.'), statuses: { type: 'array', items: { type: 'string', enum: STATUSES } } },
      additionalProperties: false,
    },
    run: (a) => call('retry', pick(a, ['ids', 'statuses'])),
  },
  {
    name: 'flow_remove',
    description: 'Remove items by id (running items cannot be removed).',
    inputSchema: { type: 'object', properties: { ids: { ...strArr('Item ids to remove.'), minItems: 1 } }, required: ['ids'], additionalProperties: false },
    run: (a) => call('remove', { ids: a.ids }),
  },
  {
    name: 'flow_clear',
    description: 'Clear finished items: done, failed, or all (running items are kept).',
    inputSchema: { type: 'object', properties: { mode: { type: 'string', enum: ['done', 'failed', 'all'] } }, required: ['mode'], additionalProperties: false },
    run: (a) => call('clear', { mode: a.mode }),
  },
  {
    name: 'flow_settings',
    description: 'Read settings, or update them with patch (e.g. {"maxConcurrent":2,"retries":1,"autoDownload":true}).',
    inputSchema: {
      type: 'object',
      properties: { patch: { type: 'object', description: 'Settings keys to change.', additionalProperties: true } },
      additionalProperties: false,
    },
    run: (a) => call('settings', a.patch ? { patch: a.patch } : {}),
  },
  {
    name: 'flow_logs',
    description: 'Recent Flow Queue log lines (newest last).',
    inputSchema: { type: 'object', properties: { limit: { type: 'integer', minimum: 1, maximum: 300, default: 50 } }, additionalProperties: false },
    run: (a) => call('logs', pick(a, ['limit'])),
  },
  {
    name: 'flow_list_assets',
    description: 'List assets (images, characters, videos, uploads) in the open Google Flow project, to use as characters/assets references.',
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
    description: 'Wait until the queue has no pending/running items (or until the given ids are finished), polling every 5 s. ' +
      'Each call returns within ' + WAIT_SLICE_SEC + ' s so client tool timeouts are not hit: if the result has done:false, call flow_wait again ' +
      '(keep track of the overall timeout_sec yourself). When done:true the summary includes item results.',
    inputSchema: {
      type: 'object',
      properties: {
        timeout_sec: { type: 'integer', minimum: 0, default: 1800, description: 'Overall wait budget; a single call never waits longer than ' + WAIT_SLICE_SEC + ' s.' },
        ids: strArr('Only wait for these item ids.'),
      },
      additionalProperties: false,
    },
    run: (a, ctx) => {
      let n = 0;
      return lib.waitForQueue(call, {
        timeoutSec: Math.min(WAIT_SLICE_SEC, a.timeout_sec == null ? 1800 : Math.max(0, Number(a.timeout_sec) || 0)),
        ids: a.ids,
        onTick: ({ items, status }) => {
          if (ctx.progressToken == null) return;
          const c = status && status.counts;
          const message = c ? 'pending ' + (c.pending || 0) + ', running ' + (c.running || 0) + ', done ' + (c.done || 0) + ', failed ' + (c.failed || 0)
            : items.map((it) => (it && it.id) + ':' + (it && it.status)).join(', ');
          notify('notifications/progress', { progressToken: ctx.progressToken, progress: ++n, message });
        },
      });
    },
  },
];
const TOOL_MAP = new Map(TOOLS.map((t) => [t.name, t]));

function pick(o, keys) {
  const r = {};
  for (const k of keys) if (o && o[k] !== undefined) r[k] = o[k];
  return r;
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
        instructions: 'Controls the Flow Queue Chrome extension (Google Flow prompt queue). Typical use: flow_status → flow_add_prompts (start=true) → flow_wait. ' +
          'flow_wait returns within 50 s; call it again while done is false. Use flow_list_assets to find character/asset names. ' +
          'Chrome must be open with the extension enabled and paired (flowq pair).',
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
        const result = await tool.run(args, ctx);
        return ok(id, { content: [{ type: 'text', text: JSON.stringify(result == null ? {} : result, null, 2) }], isError: false });
      } catch (e) {
        elog(name, 'failed:', e.message);
        return ok(id, { content: [{ type: 'text', text: 'Error: ' + e.message }], isError: true });
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
