'use strict';
// flowq install-mcp: idempotent registration of the Flow Queue MCP server in Claude Code, Codex CLI and Antigravity (agy).
// Edited config files are backed up as <file>.bak-<timestamp> first. Never prints secrets.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SERVER_NAME = 'flow-queue';
const slash = (p) => p.replace(/\\/g, '/');

function serverSpec() {
  return { command: slash(process.execPath), args: [slash(path.join(__dirname, 'mcp.js'))] };
}

const stamp = () => new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, '').replace('T', '-');

function backup(file) {
  if (!fs.existsSync(file)) return null;
  let b = file + '.bak-' + stamp();
  for (let i = 1; fs.existsSync(b); i++) b = file + '.bak-' + stamp() + '-' + i;
  fs.copyFileSync(file, b);
  return b;
}

function writeFileSafe(file, text, dryRun) {
  if (dryRun) return { backup: null };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const b = backup(file);
  fs.writeFileSync(file, text);
  return { backup: b };
}

// ---------- claude ----------
function findOnPath(name) {
  const exts = process.platform === 'win32' ? (process.env.PATHEXT || '.EXE;.CMD;.BAT;.COM').split(';').filter(Boolean) : [''];
  for (const dir of String(process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of process.platform === 'win32' ? exts.concat(['']) : exts) {
      const p = path.join(dir.replace(/^"|"$/g, ''), name + ext.toLowerCase());
      try { if (fs.statSync(p).isFile()) return p; } catch (e) { /* next */ }
    }
  }
  return null;
}

function runClaude(bin, args) {
  // FLOW_QUEUE_CLAUDE_BIN may point to a .js file (tests); .cmd/.bat need a shell on Windows.
  let r;
  if (/\.(c?js|mjs)$/i.test(bin)) r = spawnSync(process.execPath, [bin, ...args], { encoding: 'utf8', windowsHide: true, timeout: 60000 });
  else if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(bin)) {
    const q = (s) => '"' + String(s).replace(/"/g, '""') + '"';
    r = spawnSync([q(bin), ...args.map(q)].join(' '), { encoding: 'utf8', windowsHide: true, shell: true, timeout: 60000 });
  } else r = spawnSync(bin, args, { encoding: 'utf8', windowsHide: true, timeout: 60000 });
  return { code: r.status, out: String(r.stdout || '') + String(r.stderr || ''), error: r.error };
}

function installClaude({ dryRun }) {
  const spec = serverSpec();
  const addArgs = ['mcp', 'add', '--scope', 'user', SERVER_NAME, '--', spec.command, ...spec.args];
  const manual = 'claude ' + addArgs.map((a) => (/\s/.test(a) ? '"' + a + '"' : a)).join(' ');
  const bin = process.env.FLOW_QUEUE_CLAUDE_BIN || findOnPath('claude');
  if (!bin) return { target: 'claude', status: 'skipped', detail: 'claude CLI not found on PATH; run manually: ' + manual };
  const get = runClaude(bin, ['mcp', 'get', SERVER_NAME]);
  if (get.error) return { target: 'claude', status: 'error', detail: 'could not run ' + bin + ': ' + get.error.message };
  const exists = get.code === 0;
  if (exists && get.out.includes(spec.args[0]) && (get.out.includes(spec.command) || get.out.includes(path.basename(spec.command)))) {
    return { target: 'claude', status: 'unchanged', command: manual, detail: 'already registered (user scope)' };
  }
  const status = exists ? 'updated' : 'added';
  if (dryRun) return { target: 'claude', status: 'would_' + (exists ? 'update' : 'add'), command: manual, detail: (exists ? 'would remove the existing "flow-queue" entry and ' : 'would ') + 'run: ' + manual };
  if (exists) {
    // the entry may live in any scope; remove it from user scope first, fall back to default scope
    let rm = runClaude(bin, ['mcp', 'remove', SERVER_NAME, '--scope', 'user']);
    if (rm.code !== 0) rm = runClaude(bin, ['mcp', 'remove', SERVER_NAME]);
    if (rm.code !== 0) return { target: 'claude', status: 'error', detail: 'claude mcp remove failed: ' + rm.out.trim().slice(0, 300) };
  }
  const add = runClaude(bin, addArgs);
  if (add.code !== 0) return { target: 'claude', status: 'error', command: manual, detail: 'claude mcp add failed: ' + add.out.trim().slice(0, 300) };
  return { target: 'claude', status, command: manual, detail: 'registered in user scope via the claude CLI' };
}

// ---------- codex (~/.codex/config.toml) ----------
const tomlStr = (s) => '"' + String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';

function codexBlock(spec) {
  return {
    command: 'command = ' + tomlStr(spec.command),
    args: 'args = [' + spec.args.map(tomlStr).join(', ') + ']',
  };
}

// Updates (or appends) [mcp_servers.flow-queue] keeping any other keys the user added to that table.
function patchCodexToml(text, spec) {
  const want = codexBlock(spec);
  const lines = text.length ? text.replace(/\r\n/g, '\n').split('\n') : [];
  const isHeader = (l) => /^\s*\[\[?[^\]]+\]\]?\s*(#.*)?$/.test(l);
  const isOurs = (l) => /^\s*\[\s*mcp_servers\s*\.\s*(?:flow-queue|"flow-queue"|'flow-queue')\s*\]\s*(#.*)?$/.test(l);
  const start = lines.findIndex(isOurs);
  if (start < 0) {
    const block = ['[mcp_servers.flow-queue]', want.command, want.args, 'tool_timeout_sec = 120'];
    const out = lines.slice();
    while (out.length && out[out.length - 1].trim() === '') out.pop();
    if (out.length) out.push('');
    out.push(...block, '');
    return { text: out.join('\n'), changed: true, created: true };
  }
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) if (isHeader(lines[i])) { end = i; break; }
  const body = lines.slice(start + 1, end);
  const next = [];
  let sawCommand = false, sawArgs = false;
  for (let i = 0; i < body.length; i++) {
    const l = body[i];
    if (/^\s*command\s*=/.test(l)) { next.push(want.command); sawCommand = true; continue; }
    if (/^\s*args\s*=/.test(l)) {
      // skip a multi-line array
      if (l.includes('[') && !l.includes(']')) { while (i + 1 < body.length && !body[i].includes(']')) i++; }
      next.push(want.args); sawArgs = true; continue;
    }
    next.push(l);
  }
  const insertAt = 0;
  if (!sawArgs) next.splice(insertAt, 0, want.args);
  if (!sawCommand) next.splice(insertAt, 0, want.command);
  const out = [...lines.slice(0, start + 1), ...next, ...lines.slice(end)];
  const newText = out.join('\n');
  return { text: newText, changed: newText !== lines.join('\n'), created: false };
}

function installCodex({ dryRun, home }) {
  const file = path.join(home, '.codex', 'config.toml');
  const old = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const r = patchCodexToml(old, serverSpec());
  if (!r.changed) return { target: 'codex', status: 'unchanged', file, detail: '[mcp_servers.flow-queue] already up to date' };
  const status = r.created ? 'added' : 'updated';
  if (dryRun) return { target: 'codex', status: 'would_' + (r.created ? 'add' : 'update'), file, detail: (r.created ? 'would append' : 'would update') + ' [mcp_servers.flow-queue]' };
  const { backup: b } = writeFileSafe(file, r.text, dryRun);
  return { target: 'codex', status, file, backup: b, detail: (r.created ? 'appended' : 'updated') + ' [mcp_servers.flow-queue]' };
}

// ---------- agy (Antigravity CLI) ----------
// Verified: https://antigravity.google/docs/mcp/ — global ~/.gemini/config/mcp_config.json, {"mcpServers": {...}}.
// Older agy builds read ~/.gemini/antigravity-cli/mcp_config.json; that file is updated too when it already exists.
function patchMcpJson(file, spec, dryRun, target) {
  let data = {};
  const exists = fs.existsSync(file);
  if (exists) {
    const raw = fs.readFileSync(file, 'utf8');
    if (raw.trim()) {
      try { data = JSON.parse(raw); } catch (e) {
        return { target, status: 'error', file, detail: 'not valid JSON (' + e.message + '); left untouched — fix it or add the "flow-queue" entry by hand' };
      }
    }
    if (!data || typeof data !== 'object' || Array.isArray(data)) return { target, status: 'error', file, detail: 'top level is not a JSON object; left untouched' };
  }
  const servers = data.mcpServers && typeof data.mcpServers === 'object' ? data.mcpServers : {};
  const cur = servers[SERVER_NAME];
  const next = { ...(cur && typeof cur === 'object' ? cur : {}), command: spec.command, args: spec.args };
  if (cur && JSON.stringify(cur) === JSON.stringify(next)) return { target, status: 'unchanged', file, detail: 'mcpServers["flow-queue"] already up to date' };
  const status = cur ? 'updated' : 'added';
  if (dryRun) return { target, status: 'would_' + (cur ? 'update' : 'add'), file, detail: 'would set mcpServers["flow-queue"]' };
  data.mcpServers = { ...servers, [SERVER_NAME]: next };
  const { backup: b } = writeFileSafe(file, JSON.stringify(data, null, 2) + '\n', dryRun);
  return { target, status, file, backup: b, detail: 'set mcpServers["flow-queue"]' };
}

function installAgy({ dryRun, home }) {
  const spec = serverSpec();
  const out = [patchMcpJson(path.join(home, '.gemini', 'config', 'mcp_config.json'), spec, dryRun, 'agy')];
  const legacy = path.join(home, '.gemini', 'antigravity-cli', 'mcp_config.json');
  if (fs.existsSync(legacy)) out.push(patchMcpJson(legacy, spec, dryRun, 'agy-legacy'));
  return out;
}

const TARGETS = ['claude', 'codex', 'agy'];

function installMcp({ targets = ['all'], dryRun = false } = {}) {
  const list = targets.includes('all') || !targets.length ? TARGETS : targets;
  for (const t of list) if (!TARGETS.includes(t)) throw Object.assign(new Error('unknown target "' + t + '" (use claude, codex, agy or all)'), { code: 'invalid_argument', usage: true });
  const home = os.homedir();
  const results = [];
  for (const t of list) {
    try {
      if (t === 'claude') results.push(installClaude({ dryRun }));
      else if (t === 'codex') results.push(installCodex({ dryRun, home }));
      else results.push(...installAgy({ dryRun, home }));
    } catch (e) {
      results.push({ target: t, status: 'error', detail: e.message });
    }
  }
  return { ok: results.every((r) => r.status !== 'error'), dryRun: !!dryRun, server: serverSpec(), results };
}

module.exports = { installMcp, patchCodexToml, serverSpec };
