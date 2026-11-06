#!/usr/bin/env node
/**
 * cleanroom CLI: inventory, forecast, apply, restore.
 *
 *   node cleanroom.mjs inventory --project <dir> [--fast] [--no-hooks]
 *   node cleanroom.mjs forecast  --project <dir> --disable P1,M2,S3 [--no-hooks]
 *   node cleanroom.mjs apply     --project <dir> --disable P1,M2,S3
 *   node cleanroom.mjs restore   --project <dir>
 *
 * Context is measured with headless `claude -p /context`, a local command:
 * no model call is made and no tokens are billed. Plans are measured by
 * passing a temporary `--settings` overlay, so forecasting writes nothing.
 * `apply` writes only <project>/.claude/settings.local.json and logs every
 * change so `restore` can undo exactly what it did.
 */
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const SELF = 'cleanroom';
const HOME = os.homedir();
const IS_WIN = process.platform === 'win32';
const RUN_TIMEOUT_MS = 180_000;
const DEFAULT_WAIT_MS = 20_000; // time for stdio MCP servers to connect before /context
const CONCURRENCY = 4;
const SESSION_REQUESTS = 50; // requests per session used in the projection
const CANDIDATE_SKILL_SOURCES = new Set(['User', 'Project', 'claude.ai sync']);

const warnings = [];
export function warn(msg, err) {
  const line = err ? `${msg}: ${err.message ?? err}` : msg;
  warnings.push(line);
  process.stderr.write(`[cleanroom] ${line}\n`);
}

/* ------------------------------------------------------------------ */
/* Parsing                                                             */
/* ------------------------------------------------------------------ */

/** "37.2k" -> 37200, "~220" -> 220, "< 20" -> 10 (approx), "614" -> 614 */
export function parseTokens(raw) {
  const s = String(raw ?? '').trim();
  const lt = s.match(/^<\s*(\d+)/);
  if (lt) return { tokens: Math.round(Number(lt[1]) / 2), approx: true, below: Number(lt[1]) };
  const m = s.replace(/[~,\s]/g, '').match(/^([\d.]+)([km])?$/i);
  if (!m) return { tokens: 0, approx: true };
  let n = parseFloat(m[1]);
  const unit = (m[2] || '').toLowerCase();
  if (unit === 'k') n *= 1e3;
  else if (unit === 'm') n *= 1e6;
  return { tokens: Math.round(n), approx: s.startsWith('~') || unit !== '' };
}

/** Parse the markdown printed by /context into structured tables. */
export function parseContext(md) {
  const out = { used: 0, window: 0, categories: {}, mcpTools: [], agents: [], memory: [], skills: [] };
  const total = md.match(/\*\*Tokens:\*\*\s*([^\s/]+)\s*\/\s*([^\s(]+)/);
  if (total) {
    out.used = parseTokens(total[1]).tokens;
    out.window = parseTokens(total[2]).tokens;
  }
  let section = '';
  for (const line of md.split(/\r?\n/)) {
    const h = line.match(/^#{2,4}\s+(.*)$/);
    if (h) { section = h[1].trim(); continue; }
    if (!line.trim().startsWith('|')) continue;
    const cells = line.trim().split('|').slice(1, -1).map(c => c.trim());
    if (cells.every(c => /^:?-+:?$/.test(c))) continue; // separator
    if (cells.includes('Tokens')) continue; // header
    const tok = parseTokens(cells[cells.length - 1]);
    if (section.startsWith('Estimated usage by category')) {
      out.categories[cells[0]] = parseTokens(cells[1]).tokens;
    } else if (section === 'MCP Tools') {
      out.mcpTools.push({ tool: cells[0], server: cells[1], tokens: tok.tokens });
    } else if (section === 'Custom Agents') {
      out.agents.push({ name: cells[0], source: cells[1], tokens: tok.tokens });
    } else if (section === 'Memory Files') {
      out.memory.push({ type: cells[0], path: cells[1], tokens: tok.tokens });
    } else if (section === 'Skills') {
      out.skills.push({ name: cells[0], source: cells[1], tokens: tok.tokens, approx: tok.approx, below: tok.below });
    }
  }
  return out;
}

/** Minimal YAML frontmatter reader: top-level scalar keys, folded/literal blocks. */
export function frontmatter(text) {
  const m = String(text).match(/^﻿?---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return {};
  const out = {};
  const lines = m[1].split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const kv = lines[i].match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!kv) continue;
    let value = kv[2].trim();
    if (/^[>|][+-]?$/.test(value) || value === '') {
      const block = [];
      while (i + 1 < lines.length && /^\s+\S/.test(lines[i + 1])) block.push(lines[++i].trim());
      value = block.join(' ');
    }
    const quoted = value.match(/^(["'])([\s\S]*)\1$/);
    out[kv[1]] = quoted ? (quoted[1] === '"' ? quoted[2].replace(/\\"/g, '"') : quoted[2].replace(/''/g, "'")) : value;
  }
  return out;
}

export function mcpToolPrefix(serverName) {
  return serverName.replace(/[^A-Za-z0-9_-]/g, '_');
}

/**
 * Deferred MCP tools are listed by name in every request, but /context does
 * not count that list. Estimate it from the names (~3 chars per token + newline).
 */
export function deferredNameTokens(tools) {
  return tools.reduce((a, t) => a + Math.ceil(t.tool.length / 3) + 1, 0);
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    if (e.code !== 'ENOENT') warn(`could not read ${file}`, e);
    return fallback;
  }
}

function readText(file, max) {
  try {
    const t = fs.readFileSync(file, 'utf8');
    return max ? t.slice(0, max) : t;
  } catch (e) {
    if (e.code !== 'ENOENT') warn(`could not read ${file}`, e);
    return null;
  }
}

function listDir(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    if (e.code !== 'ENOENT') warn(`could not list ${dir}`, e);
    return [];
  }
}

function oneLine(s, max = 220) {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

function fmtTok(n, approx) {
  if (n == null) return '?';
  const s = n >= 1000 ? `${(n / 1000).toFixed(n >= 100000 ? 0 : 1).replace(/\.0$/, '')}k` : String(n);
  return approx ? `~${s}` : s;
}

/* ------------------------------------------------------------------ */
/* Running claude                                                      */
/* ------------------------------------------------------------------ */

let resolvedBin;
function resolveClaude() {
  if (resolvedBin) return resolvedBin;
  const override = process.env.CLEANROOM_CLAUDE_BIN;
  if (override) return (resolvedBin = { cmd: override, shell: IS_WIN && !/\.exe$/i.test(override) });
  if (!IS_WIN) return (resolvedBin = { cmd: 'claude', shell: false });
  try {
    const hits = execFileSync('where.exe', ['claude'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
      .split(/\r?\n/).map(s => s.trim()).filter(Boolean);
    const exe = hits.find(h => /\.exe$/i.test(h));
    if (exe) return (resolvedBin = { cmd: exe, shell: false });
    const cmd = hits.find(h => /\.(cmd|bat)$/i.test(h));
    if (cmd) return (resolvedBin = { cmd, shell: true });
  } catch (e) {
    warn('where.exe could not find claude; falling back to PATH lookup through the shell', e);
  }
  return (resolvedBin = { cmd: 'claude', shell: true });
}

function quoteForShell(arg) {
  if (IS_WIN) return /[\s"^&|<>()%!]/.test(arg) ? `"${arg.replace(/"/g, '""')}"` : arg;
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}

/** Parse stream-json lines from a headless run into {init, markdown, ctx}. */
export function parseRunOutput(stdout) {
  const msgs = [];
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.startsWith('{')) continue;
    try {
      msgs.push(JSON.parse(line));
    } catch (e) {
      warn('skipped an unparseable output line from claude', e);
    }
  }
  const init = msgs.find(m => m.type === 'system' && m.subtype === 'init');
  const result = msgs.find(m => m.type === 'result');
  if (!init) throw new Error('init message missing from claude output');
  if (!result?.result) throw new Error('/context result missing from claude output');
  if ((result.num_turns ?? 0) > 0 || (result.total_cost_usd ?? 0) > 0) {
    throw new Error('Claude Code sent /context to the model instead of running it locally; stopping so no more billed calls are made');
  }
  return { init, markdown: result.result, ctx: parseContext(result.result) };
}

/**
 * Run `/context` headlessly in projectDir with an optional settings overlay.
 * The prompt is sent over stream-json stdin after `waitMs`, so stdio MCP
 * servers have time to connect and their tools are counted.
 */
export function runContext(projectDir, overlay = {}, { noHooks = false, waitMs = DEFAULT_WAIT_MS } = {}) {
  const settings = { ...overlay };
  if (noHooks) settings.disableAllHooks = true;
  // default permission mode: in -p, any tool that needs approval is denied, so a
  // stray model turn could not act. /context itself is local and makes no call.
  const args = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--no-session-persistence', '--permission-mode', 'default'];
  let tmp = null;
  if (Object.keys(settings).length) {
    tmp = path.join(os.tmpdir(), `cleanroom-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
    fs.writeFileSync(tmp, JSON.stringify(settings));
    args.push('--settings', tmp);
  }
  const bin = resolveClaude();
  const env = { ...process.env, MSYS_NO_PATHCONV: '1' };
  const prompt = `${JSON.stringify({ type: 'user', message: { role: 'user', content: '/context' } })}\n`;
  return new Promise((resolve, reject) => {
    const child = bin.shell
      ? spawn([bin.cmd, ...args].map(quoteForShell).join(' '), { cwd: projectDir, shell: true, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
      : spawn(bin.cmd, args, { cwd: projectDir, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    let out = '';
    let err = '';
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(sendTimer);
      clearTimeout(killTimer);
      if (tmp) fs.rmSync(tmp, { force: true });
      if (child.exitCode === null) child.kill();
      fn(value);
    };
    const sendTimer = setTimeout(() => {
      child.stdin.write(prompt);
      child.stdin.end();
    }, waitMs);
    const killTimer = setTimeout(
      () => finish(reject, new Error(`/context run timed out after ${(waitMs + RUN_TIMEOUT_MS) / 1000}s`)),
      waitMs + RUN_TIMEOUT_MS,
    );
    child.stdin.on('error', e => warn('could not write the /context prompt to claude', e));
    child.stdout.on('data', d => {
      out += d;
      if (/"type":"result"/.test(d.toString())) {
        try {
          finish(resolve, parseRunOutput(out));
        } catch (e) {
          finish(reject, new Error(`could not read /context output: ${e.message}`));
        }
      }
    });
    child.stderr.on('data', d => { err += d; });
    child.on('error', e => finish(reject, e));
    child.on('close', code => {
      if (settled) return;
      try {
        finish(resolve, parseRunOutput(out));
      } catch (e) {
        finish(reject, new Error(`claude exited (${code}) before /context finished: ${e.message}. stderr: ${oneLine(err, 400)}`));
      }
    });
  });
}

async function pool(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}

/* ------------------------------------------------------------------ */
/* Project and harness discovery                                       */
/* ------------------------------------------------------------------ */

export function stateDir(projectDir) {
  const slug = path.resolve(projectDir).replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return path.join(HOME, '.claude', SELF, slug);
}

function settingsFiles(projectDir) {
  return {
    local: path.join(projectDir, '.claude', 'settings.local.json'),
    project: path.join(projectDir, '.claude', 'settings.json'),
    user: path.join(HOME, '.claude', 'settings.json'),
  };
}

/** Which settings scope decides whether a plugin is enabled (highest precedence first). */
function pluginScope(projectDir, id) {
  const files = settingsFiles(projectDir);
  for (const scope of ['local', 'project', 'user']) {
    const s = readJson(files[scope], null);
    if (s?.enabledPlugins && Object.hasOwn(s.enabledPlugins, id)) return scope;
  }
  return 'default';
}

function git(projectDir, args) {
  return execFileSync('git', ['-C', projectDir, ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
}

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next', 'out', 'venv', '.venv', '__pycache__', 'target', '.turbo', '.cache', 'coverage', 'vendor', 'bin', 'obj', '.claude']);

function walkFiles(root, cap = 5000) {
  const files = [];
  const stack = [['', 0]];
  while (stack.length && files.length < cap) {
    const [rel, depth] = stack.pop();
    for (const ent of listDir(path.join(root, rel))) {
      const r = rel ? `${rel}/${ent.name}` : ent.name;
      if (ent.isDirectory()) {
        if (!SKIP_DIRS.has(ent.name) && depth < 6) stack.push([r, depth + 1]);
      } else files.push(r);
    }
  }
  return files;
}

function manifestDeps(projectDir, files) {
  const out = [];
  const add = (file, kind, names) => {
    const uniq = [...new Set(names.filter(Boolean))];
    if (uniq.length) out.push(`${file} (${kind}): ${uniq.slice(0, 40).join(', ')}${uniq.length > 40 ? ` (+${uniq.length - 40} more)` : ''}`);
    else out.push(`${file}`);
  };
  const shallow = files.filter(f => f.split('/').length <= 2 && !f.includes('node_modules/'));
  for (const f of shallow.filter(f => /(^|\/)package\.json$/.test(f)).slice(0, 6)) {
    const pj = readJson(path.join(projectDir, f), {});
    add(f, 'npm', [...Object.keys(pj.dependencies || {}), ...Object.keys(pj.devDependencies || {})]);
  }
  for (const f of shallow.filter(f => /(^|\/)requirements[^/]*\.txt$/.test(f)).slice(0, 3)) {
    add(f, 'pip', (readText(path.join(projectDir, f)) || '').split(/\r?\n/).map(l => l.match(/^\s*([A-Za-z0-9_.-]+)/)?.[1]));
  }
  for (const f of shallow.filter(f => /(^|\/)pyproject\.toml$/.test(f)).slice(0, 3)) {
    add(f, 'python', (readText(path.join(projectDir, f)) || '').split(/\r?\n/).map(l => l.match(/^\s*"([A-Za-z0-9_.-]+)/)?.[1]));
  }
  for (const f of shallow.filter(f => /(^|\/)go\.mod$/.test(f)).slice(0, 2)) {
    add(f, 'go', (readText(path.join(projectDir, f)) || '').split(/\r?\n/).map(l => l.match(/^\s*(?:require\s+)?([a-z0-9.-]+\.[a-z]+\/[^\s]+)\s+v/)?.[1]));
  }
  for (const f of shallow.filter(f => /(^|\/)Cargo\.toml$/.test(f)).slice(0, 2)) {
    const t = readText(path.join(projectDir, f)) || '';
    const deps = t.split(/\[dependencies\]/)[1]?.split(/\n\[/)[0] || '';
    add(f, 'cargo', deps.split(/\r?\n/).map(l => l.match(/^\s*([A-Za-z0-9_-]+)\s*=/)?.[1]));
  }
  for (const f of shallow.filter(f => /(^|\/)Gemfile$/.test(f)).slice(0, 2)) {
    add(f, 'ruby', (readText(path.join(projectDir, f)) || '').split(/\r?\n/).map(l => l.match(/^\s*gem\s+['"]([^'"]+)/)?.[1]));
  }
  for (const f of shallow.filter(f => /(^|\/)composer\.json$/.test(f)).slice(0, 2)) {
    add(f, 'php', Object.keys(readJson(path.join(projectDir, f), {}).require || {}));
  }
  return out;
}

export function fingerprint(projectDir) {
  const fp = { path: projectDir, git: false, remote: null, recentCommits: [], topLevel: [], fileCount: 0, extensions: [], manifests: [], claudeMd: null, readme: null, empty: false };
  let files = null;
  try {
    files = git(projectDir, ['ls-files']).split(/\r?\n/).filter(Boolean);
    fp.git = true;
  } catch (e) {
    warn(`not a git repo (or git missing) at ${projectDir}; walking the folder instead`, { message: oneLine(e.stderr || e.message, 120) });
  }
  if (fp.git) {
    try {
      fp.remote = git(projectDir, ['remote', 'get-url', 'origin']).trim().replace(/\/\/[^@/]+@/, '//');
    } catch (e) {
      warn('no git remote named origin', { message: oneLine(e.stderr || e.message, 120) });
    }
    try {
      fp.recentCommits = git(projectDir, ['log', '-12', '--format=%s']).split(/\r?\n/).filter(Boolean);
    } catch (e) {
      warn('could not read git log', { message: oneLine(e.stderr || e.message, 120) });
    }
    if (!files.length) files = walkFiles(projectDir);
  } else {
    files = walkFiles(projectDir);
  }
  files = files.filter(f => !f.startsWith('.claude/') && !f.startsWith('.git/'));
  fp.fileCount = files.length;
  fp.empty = files.length < 3;
  fp.topLevel = listDir(projectDir).filter(e => e.name !== '.git').slice(0, 60).map(e => (e.isDirectory() ? `${e.name}/` : e.name));
  const ext = {};
  for (const f of files) {
    const e = path.extname(f).toLowerCase() || path.basename(f);
    ext[e] = (ext[e] || 0) + 1;
  }
  fp.extensions = Object.entries(ext).sort((a, b) => b[1] - a[1]).slice(0, 18).map(([e, n]) => `${e} ${n}`);
  fp.manifests = manifestDeps(projectDir, files);
  for (const f of ['CLAUDE.md', '.claude/CLAUDE.md', 'AGENTS.md']) {
    const t = readText(path.join(projectDir, f), 2500);
    if (t) { fp.claudeMd = { file: f, head: t }; break; }
  }
  for (const f of ['README.md', 'readme.md', 'README.rst', 'README.txt', 'README']) {
    const t = readText(path.join(projectDir, f), 1500);
    if (t) { fp.readme = { file: f, head: t }; break; }
  }
  return fp;
}

/** name -> description for every skill/command Claude Code could list. */
function buildDescriptionIndex(projectDir, plugins) {
  const idx = new Map();
  const put = (key, desc, file) => { if (key && !idx.has(key)) idx.set(key, { desc: desc || '', file }); };
  const skillDir = (root, prefix = '') => {
    for (const ent of listDir(root)) {
      if (!ent.isDirectory() && !ent.isSymbolicLink()) continue;
      const file = path.join(root, ent.name, 'SKILL.md');
      const text = readText(file);
      if (!text) continue;
      const fm = frontmatter(text);
      put(prefix + (fm.name || ent.name), fm.description, file);
      put(prefix + ent.name, fm.description, file);
    }
  };
  const commandDir = (root, prefix = '') => {
    for (const ent of listDir(root)) {
      if (!ent.isFile() || !ent.name.endsWith('.md')) continue;
      const file = path.join(root, ent.name);
      const text = readText(file) || '';
      const fm = frontmatter(text);
      const body = text.replace(/^﻿?---[\s\S]*?\n---\r?\n?/, '');
      put(prefix + ent.name.slice(0, -3), fm.description || body.split(/\r?\n/).find(l => l.trim()), file);
    }
  };
  skillDir(path.join(projectDir, '.claude', 'skills'));
  commandDir(path.join(projectDir, '.claude', 'commands'));
  skillDir(path.join(HOME, '.claude', 'skills'));
  commandDir(path.join(HOME, '.claude', 'commands'));
  for (const ent of listDir(path.join(HOME, '.claude', 'skills', 'synced'))) {
    if (!ent.isDirectory()) continue;
    const root = path.join(HOME, '.claude', 'skills', 'synced', ent.name);
    skillDir(root, 'anthropic-skills:');
    skillDir(root);
  }
  for (const p of plugins) {
    if (!p.path) continue;
    skillDir(path.join(p.path, 'skills'), `${p.name}:`);
    commandDir(path.join(p.path, 'commands'), `${p.name}:`);
  }
  return idx;
}

function projectKeyMatch(obj, projectDir) {
  if (!obj) return null;
  const want = path.resolve(projectDir).replace(/\\/g, '/').toLowerCase();
  const key = Object.keys(obj).find(k => k.replace(/\\/g, '/').toLowerCase() === want);
  return key ? obj[key] : null;
}

/** Describe an MCP server's transport without exposing env, headers or secret-looking args. */
export function describeMcpConfig(cfg) {
  if (!cfg) return '';
  if (cfg.url) {
    try {
      return `${cfg.type || 'http'} ${new URL(cfg.url).host}`;
    } catch (e) {
      warn('MCP server has an unparseable url', e);
      return cfg.type || 'http';
    }
  }
  if (cfg.command) {
    const safe = (cfg.args || [])
      .filter(a => typeof a === 'string' && !/(key|token|secret|pass|auth|bearer)/i.test(a) && !/^[A-Za-z0-9_\-+/=]{28,}$/.test(a) && !a.includes('='))
      .slice(0, 3)
      .map(a => (/^[A-Za-z]:[\\/]|[\\/][^\\/]+[\\/]/.test(a) ? path.basename(a) : a));
    return `stdio ${path.basename(cfg.command)} ${safe.join(' ')}`.trim();
  }
  return cfg.type || '';
}

/* ------------------------------------------------------------------ */
/* Inventory                                                           */
/* ------------------------------------------------------------------ */

function buildItems(projectDir, run) {
  const { init, ctx } = run;
  const plugins = (init.plugins || []).map(p => ({ ...p }));
  const descIdx = buildDescriptionIndex(projectDir, plugins);
  const claudeJson = readJson(path.join(HOME, '.claude.json'), {});
  const projectEntry = projectKeyMatch(claudeJson.projects, projectDir) || {};
  const mcpJson = readJson(path.join(projectDir, '.mcp.json'), {});
  const toolsByServer = new Map();
  for (const t of ctx.mcpTools) {
    if (!toolsByServer.has(t.server)) toolsByServer.set(t.server, []);
    toolsByServer.get(t.server).push(t);
  }

  const items = [];
  const info = { builtinSkills: [], otherSkills: [], agents: ctx.agents, memory: ctx.memory, inlinePlugins: [], self: null };

  // Plugins
  for (const p of plugins) {
    const id = p.source || p.name;
    const manifest = p.path ? readJson(path.join(p.path, '.claude-plugin', 'plugin.json'), {}) : {};
    const skills = ctx.skills.filter(s => s.source === `Plugin (${p.name})`);
    const mcp = (init.mcp_servers || []).filter(m => m.source === 'plugin' && (m.name === p.name || m.name.startsWith(`plugin:${p.name}:`)));
    const agents = p.path ? listDir(path.join(p.path, 'agents')).filter(e => e.name.endsWith('.md')).map(e => e.name.slice(0, -3)) : [];
    const hooks = p.path ? fs.existsSync(path.join(p.path, 'hooks', 'hooks.json')) || !!manifest.hooks : false;
    const mcpTools = mcp.flatMap(m => toolsByServer.get(mcpToolPrefix(m.name)) || []);
    const nameTokens = deferredNameTokens(mcpTools);
    const entry = {
      kind: 'plugin', key: id, name: p.name, scope: pluginScope(projectDir, id),
      contextTokens: skills.reduce((a, s) => a + s.tokens, 0), nameTokens,
      tokens: 0, approx: true, measured: false,
      onDemand: mcpTools.reduce((a, t) => a + t.tokens, 0),
      desc: oneLine(manifest.description || '', 260),
      detail: [
        skills.length ? `skills: ${skills.map(s => s.name.split(':').pop()).join(', ')}` : '',
        agents.length ? `agents: ${agents.join(', ')}` : '',
        mcp.length ? `mcp: ${mcp.map(m => `${m.name} (${(toolsByServer.get(mcpToolPrefix(m.name)) || []).length} tools)`).join(', ')}` : '',
        hooks ? 'hooks: yes' : '',
      ].filter(Boolean).join('; '),
    };
    if (p.name === SELF) { info.self = entry; continue; }
    if (/@inline$/.test(id)) { info.inlinePlugins.push(entry); continue; }
    entry.askOnly = entry.scope === 'project' || entry.scope === 'local';
    items.push(entry);
  }

  // MCP servers that are not owned by a plugin
  for (const m of init.mcp_servers || []) {
    if (m.source === 'plugin') continue;
    const tools = toolsByServer.get(mcpToolPrefix(m.name)) || [];
    let cfg = null;
    if (m.source === 'user') cfg = claudeJson.mcpServers?.[m.name];
    else if (m.source === 'local') cfg = projectEntry.mcpServers?.[m.name];
    else if (m.source === 'project') cfg = mcpJson.mcpServers?.[m.name];
    items.push({
      kind: 'mcp', key: m.name, name: m.name, scope: m.source, status: m.status,
      contextTokens: 0, nameTokens: deferredNameTokens(tools),
      tokens: 0, approx: true, measured: false,
      onDemand: tools.reduce((a, t) => a + t.tokens, 0),
      askOnly: m.source === 'project' || m.source === 'local',
      desc: m.source === 'claudeai' ? 'claude.ai connector' : describeMcpConfig(cfg),
      detail: tools.length
        ? `${tools.length} tools: ${tools.slice(0, 14).map(t => t.tool.split('__').pop()).join(', ')}${tools.length > 14 ? ', …' : ''}`
        : `no tools listed (status: ${m.status})`,
    });
  }

  // Standalone skills and commands
  const initSkills = init.skills || [];
  for (const s of ctx.skills) {
    if (s.source.startsWith('Plugin (')) continue;
    if (s.source === 'Built-in') { info.builtinSkills.push(s); continue; }
    if (!CANDIDATE_SKILL_SOURCES.has(s.source)) { info.otherSkills.push(s); continue; }
    let key = s.name;
    if (s.source === 'claude.ai sync' && !s.name.includes(':')) {
      key = initSkills.find(n => n.includes(':') && n.split(':').pop() === s.name) || `anthropic-skills:${s.name}`;
    }
    const d = descIdx.get(key) || descIdx.get(s.name);
    if (!d) warn(`no description found for skill ${key}`);
    items.push({
      kind: 'skill', key, name: key, scope: s.source === 'claude.ai sync' ? 'claude.ai' : s.source.toLowerCase(),
      contextTokens: s.tokens, nameTokens: 0,
      tokens: s.tokens, approx: s.approx, below: s.below, measured: true,
      askOnly: s.source === 'Project',
      desc: oneLine(d?.desc || '', 260),
    });
  }

  for (const it of items) if (it.kind !== 'skill') it.tokens = it.contextTokens + it.nameTokens;
  const order = { plugin: 0, mcp: 1, skill: 2 };
  items.sort((a, b) => order[a.kind] - order[b.kind] || a.name.localeCompare(b.name));
  const counters = { plugin: 0, mcp: 0, skill: 0 };
  const prefix = { plugin: 'P', mcp: 'M', skill: 'S' };
  for (const it of items) it.ref = `${prefix[it.kind]}${++counters[it.kind]}`;
  return { items, info };
}

export function overlayFor(items) {
  const overlay = {};
  for (const it of items) {
    if (it.kind === 'plugin') (overlay.enabledPlugins ??= {})[it.key] = false;
    else if (it.kind === 'mcp') (overlay.deniedMcpServers ??= []).push({ serverName: it.key });
    else if (it.kind === 'skill') (overlay.skillOverrides ??= {})[it.key] = 'off';
  }
  return overlay;
}

async function measureEach(projectDir, baselineUsed, items, opts) {
  const targets = items.filter(it => it.kind !== 'skill');
  if (!targets.length) return;
  process.stderr.write(`[cleanroom] measuring ${targets.length} plugins/MCP servers one at a time (${CONCURRENCY} in parallel)\n`);
  await pool(targets, CONCURRENCY, async it => {
    try {
      const run = await runContext(projectDir, overlayFor([it]), opts);
      const delta = baselineUsed - run.ctx.used;
      it.contextTokens = Math.max(0, delta);
      it.tokens = it.contextTokens + it.nameTokens;
      it.approx = true;
      it.measured = true;
      if (delta < 0) it.noisy = true;
    } catch (e) {
      warn(`could not measure ${it.kind} ${it.key}; keeping the estimate`, e);
    }
  });
}

function categoriesLine(ctx) {
  const skip = new Set(['Free space', 'Autocompact buffer', 'Messages']);
  return Object.entries(ctx.categories)
    .filter(([k, v]) => !skip.has(k) && !/deferred/i.test(k) && v > 0)
    .map(([k, v]) => `${k} ${fmtTok(v)}`).join(', ');
}

function renderInventory(inv) {
  const { fp, baseline, items, info, state, previous } = inv;
  const L = [];
  L.push('# Cleanroom inventory', '');
  L.push(`Inventory id: ${inv.id} (pass --inv ${inv.id} to forecast and apply; refs are renumbered on every inventory)`);
  L.push(`Project: ${fp.path}`);
  L.push(`Git: ${fp.git ? `yes${fp.remote ? `, origin ${fp.remote}` : ', no origin'}` : 'no'} | tracked files: ${fp.fileCount}${fp.empty ? ' | EMPTY PROJECT: auto-remove nothing' : ''}`);
  const names = items.reduce((a, it) => a + (it.nameTokens || 0), 0);
  L.push(`Always-on context now: ${fmtTok(baseline.used)} of ${fmtTok(baseline.window)} (${categoriesLine(baseline)})${names ? ` + ~${fmtTok(names)} deferred MCP tool names that /context does not count` : ''}`);
  L.push(`State folder: ${state}`);
  if (previous) L.push(`Earlier cleanroom changes still active in this project: ${previous} (undo with: restore)`);
  L.push('', '## Project signals');
  L.push(`Top level: ${fp.topLevel.join('  ') || '(nothing)'}`);
  if (fp.extensions.length) L.push(`File types: ${fp.extensions.join(', ')}`);
  for (const m of fp.manifests) L.push(`Manifest ${m}`);
  if (fp.recentCommits.length) L.push(`Recent commits: ${fp.recentCommits.map(c => oneLine(c, 80)).join(' | ')}`);
  if (fp.claudeMd) L.push('', `### ${fp.claudeMd.file} (head)`, '```', fp.claudeMd.head.trim(), '```');
  if (fp.readme) L.push('', `### ${fp.readme.file} (head)`, '```', fp.readme.head.trim(), '```');
  L.push('', '## Candidates');
  L.push('Format: ref | kind | scope | always-on tokens per request | name: what it is. `ask-only` = declared for this project; never auto-remove.');
  L.push('Skill numbers are each skill\'s share of a fixed listing budget: removing one skill frees little, removing many shrinks the listing and un-truncates the rest. Plugin/MCP numbers were measured one at a time.', '');
  for (const it of items) {
    const tok = it.below ? `<${it.below}` : `${fmtTok(it.tokens, it.approx)}${it.nameTokens ? ` (incl. ~${fmtTok(it.nameTokens)} tool names)` : ''}`;
    const flags = [it.askOnly ? 'ask-only' : '', it.noisy ? 'noisy-measure' : '', it.measured ? '' : 'estimated', it.status && it.status !== 'connected' ? `status ${it.status}` : ''].filter(Boolean).join(', ');
    const onDemand = it.onDemand ? ` | +${fmtTok(it.onDemand)} on demand` : '';
    L.push(`${it.ref} | ${it.kind} | ${it.scope} | ${tok}${onDemand}${flags ? ` | ${flags}` : ''} | ${it.name}: ${it.desc || '(no description)'}${it.detail ? ` [${it.detail}]` : ''}`);
  }
  L.push('', '## Not switchable per project (report only)');
  const sum = arr => arr.reduce((a, x) => a + (x.tokens || 0), 0);
  if (info.builtinSkills.length) L.push(`- Built-in skills: ${info.builtinSkills.length}, ~${fmtTok(sum(info.builtinSkills))}`);
  if (info.otherSkills.length) L.push(`- Other skills: ${info.otherSkills.map(s => `${s.name} (${s.source})`).join(', ')}`);
  if (info.agents.length) L.push(`- Custom agents: ${info.agents.map(a => `${a.name} (${a.source}, ${fmtTok(a.tokens)})`).join(', ')}`);
  if (info.memory.length) L.push(`- Memory files: ${info.memory.map(m => `${m.path} (${fmtTok(m.tokens)})`).join(', ')}`);
  if (info.inlinePlugins.length) L.push(`- Plugins loaded by a launch flag: ${info.inlinePlugins.map(p => p.name).join(', ')}`);
  if (warnings.length) L.push('', '## Warnings', ...warnings.map(w => `- ${w}`));
  return L.join('\n');
}

async function cmdInventory(projectDir, opts) {
  const state = stateDir(projectDir);
  fs.mkdirSync(state, { recursive: true });
  const waitSec = Number(opts.wait);
  const runOpts = { noHooks: !!opts['no-hooks'], waitMs: Number.isFinite(waitSec) && waitSec >= 0 ? waitSec * 1000 : DEFAULT_WAIT_MS };
  process.stderr.write(`[cleanroom] measuring the current context with /context (no model call; waits ${runOpts.waitMs / 1000}s for MCP servers)\n`);
  const run = await runContext(projectDir, {}, runOpts);
  const { items, info } = buildItems(projectDir, run);
  if (!opts.fast) await measureEach(projectDir, run.ctx.used, items, runOpts);
  const fp = fingerprint(projectDir);
  const undo = readJson(path.join(state, 'undo.json'), []);
  const previous = undo.reduce((a, b) => a + b.changes.length, 0);
  const inv = {
    id: Date.now().toString(36).slice(-6),
    createdAt: new Date().toISOString(), projectDir, noHooks: runOpts.noHooks, waitMs: runOpts.waitMs, fp,
    baseline: {
      used: run.ctx.used, window: run.ctx.window, categories: run.ctx.categories,
      skillsListed: run.ctx.skills.length, skillsNameOnly: run.ctx.skills.filter(s => s.below).length,
    },
    items, info, state, previous,
  };
  fs.writeFileSync(path.join(state, 'inventory.json'), JSON.stringify(inv, null, 2));
  console.log(renderInventory(inv));
}

/* ------------------------------------------------------------------ */
/* Forecast / apply / restore                                          */
/* ------------------------------------------------------------------ */

export function checkInventoryId(inv, invId) {
  if (typeof invId !== 'string' || !invId) throw new Error('missing --inv <id>; copy it from the inventory report header');
  if (invId !== inv.id) {
    throw new Error(`--inv ${invId} does not match the latest inventory (${inv.id}); refs may now point to different items. Use the refs from the latest inventory.`);
  }
}

function loadInventory(projectDir, invId) {
  const file = path.join(stateDir(projectDir), 'inventory.json');
  const inv = readJson(file, null);
  if (!inv) throw new Error(`no inventory at ${file}; run inventory first`);
  checkInventoryId(inv, invId);
  return inv;
}

export function resolveRefs(inv, refsArg) {
  const refs = String(refsArg || '').split(/[\s,]+/).map(s => s.trim()).filter(Boolean);
  const byRef = new Map(inv.items.map(it => [it.ref.toUpperCase(), it]));
  const unknown = refs.filter(r => !byRef.has(r.toUpperCase()));
  if (unknown.length) throw new Error(`unknown refs: ${unknown.join(', ')}`);
  return [...new Set(refs.map(r => byRef.get(r.toUpperCase())))];
}

async function cmdForecast(projectDir, opts) {
  const inv = loadInventory(projectDir, opts.inv);
  const chosen = resolveRefs(inv, opts.disable);
  const run = await runContext(projectDir, overlayFor(chosen), { noHooks: inv.noHooks, waitMs: inv.waitMs ?? DEFAULT_WAIT_MS });
  const before = inv.baseline;
  const after = run.ctx;
  const measured = Math.max(0, before.used - after.used);
  const names = chosen.reduce((a, it) => a + (it.nameTokens || 0), 0);
  const saved = measured + names;
  const pct = before.used ? Math.round((saved / (before.used + inv.items.reduce((a, it) => a + (it.nameTokens || 0), 0))) * 100) : 0;
  const onDemandDropped = chosen.reduce((a, it) => a + (it.onDemand || 0), 0);
  const result = {
    createdAt: new Date().toISOString(), disabled: chosen.map(it => it.ref),
    before: before.used, after: after.used, window: before.window, measured, names, saved, pct,
    perSession: saved * SESSION_REQUESTS, onDemandDropped,
    skills: {
      listedBefore: before.skillsListed, listedAfter: after.skills.length,
      nameOnlyBefore: before.skillsNameOnly, nameOnlyAfter: after.skills.filter(s => s.below).length,
    },
    categories: Object.keys({ ...before.categories, ...after.categories })
      .filter(k => !['Free space', 'Autocompact buffer'].includes(k))
      .map(k => ({ name: k, before: before.categories[k] || 0, after: after.categories[k] || 0 }))
      .filter(c => c.before !== c.after),
  };
  fs.writeFileSync(path.join(inv.state, 'forecast.json'), JSON.stringify(result, null, 2));
  const L = ['# Forecast (measured with /context)', ''];
  L.push(`Items switched off: ${chosen.length} (${chosen.map(it => `${it.ref} ${it.name}`).join(', ') || 'none'})`);
  L.push(`Measured by /context: ${fmtTok(before.used)} -> ${fmtTok(after.used)} (${fmtTok(measured)} less)`);
  if (names) L.push(`Deferred MCP tool names /context does not count (estimated): ~${fmtTok(names)}`);
  L.push(`Total: ~${fmtTok(saved)} fewer always-on tokens on every request (${pct}% of the always-on load)`);
  L.push(`Context window freed: ${before.window ? ((saved / before.window) * 100).toFixed(1) : '?'}% of ${fmtTok(before.window)}`);
  L.push(`Per ${SESSION_REQUESTS}-request session: ~${fmtTok(saved * SESSION_REQUESTS)} fewer input tokens (mostly cache reads)`);
  if (onDemandDropped) L.push(`On-demand MCP tool schemas no longer reachable: ${fmtTok(onDemandDropped)} (only paid when a tool is loaded)`);
  const sk = result.skills;
  if (chosen.some(it => it.kind === 'skill') && sk.listedBefore != null) {
    L.push(`Skills listed: ${sk.listedBefore} -> ${sk.listedAfter}; listed by name only because the description budget ran out: ${sk.nameOnlyBefore} -> ${sk.nameOnlyAfter}`);
    // The skill listing is counted partly under "Skills" and partly under "System tools".
    const listing = c => (c.Skills || 0) + (c['System tools'] || 0);
    if (listing(before.categories) - listing(after.categories) < 200) {
      L.push('The skill listing is still at its budget, so removed skills freed room for fuller descriptions of the remaining ones instead of saving tokens.');
    }
  }
  if (result.categories.length) {
    L.push('', '| Category | Before | After |', '|---|---|---|');
    for (const c of result.categories) L.push(`| ${c.name} | ${fmtTok(c.before)} | ${fmtTok(c.after)} |`);
  }
  L.push('', 'Per item (measured alone; the combined total above is the authoritative number):');
  for (const it of chosen) L.push(`- ${it.ref} ${it.kind} ${it.name}: ${it.below ? `<${it.below}` : fmtTok(it.tokens, it.approx)}`);
  L.push('', 'Note: skill descriptions share a listing budget, so removing skills lets the remaining ones show fuller descriptions. That is why per-item numbers do not add up exactly.');
  if (warnings.length) L.push('', '## Warnings', ...warnings.map(w => `- ${w}`));
  console.log(L.join('\n'));
}

/** Merge switches into a settings object; returns the change log. Mutates `settings`. */
export function applySwitches(settings, items) {
  const changes = [];
  for (const it of items) {
    if (it.kind === 'plugin' || it.kind === 'skill') {
      const container = it.kind === 'plugin' ? 'enabledPlugins' : 'skillOverrides';
      const value = it.kind === 'plugin' ? false : 'off';
      const created = !settings[container];
      settings[container] ??= {};
      const before = Object.hasOwn(settings[container], it.key) ? settings[container][it.key] : undefined;
      if (before === value) continue;
      settings[container][it.key] = value;
      changes.push({ ref: it.ref, kind: it.kind, name: it.name, container, key: it.key, before, after: value, created });
    } else if (it.kind === 'mcp') {
      const created = !Array.isArray(settings.deniedMcpServers);
      if (created) settings.deniedMcpServers = [];
      if (settings.deniedMcpServers.some(d => d?.serverName === it.key)) continue;
      settings.deniedMcpServers.push({ serverName: it.key });
      changes.push({ ref: it.ref, kind: it.kind, name: it.name, container: 'deniedMcpServers', key: it.key, added: true, created });
    }
  }
  return changes;
}

/** Undo a change log against a settings object. Returns {reverted, skipped}. Mutates `settings`. */
export function revertSwitches(settings, changes) {
  const reverted = [];
  const skipped = [];
  for (const c of [...changes].reverse()) {
    if (c.container === 'deniedMcpServers') {
      const arr = settings.deniedMcpServers;
      const i = Array.isArray(arr) ? arr.findIndex(d => d?.serverName === c.key) : -1;
      if (i < 0) { skipped.push({ ...c, why: 'already removed' }); continue; }
      arr.splice(i, 1);
      if (c.created && !arr.length) delete settings.deniedMcpServers;
      reverted.push(c);
    } else {
      const obj = settings[c.container];
      if (!obj || obj[c.key] !== c.after) { skipped.push({ ...c, why: 'changed since apply; left as is' }); continue; }
      if (c.before === undefined) delete obj[c.key];
      else obj[c.key] = c.before;
      if (c.created && !Object.keys(obj).length) delete settings[c.container];
      reverted.push(c);
    }
  }
  return { reverted, skipped };
}

function writeJsonAtomic(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.cleanroom-${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`);
  fs.renameSync(tmp, file);
}

function readSettingsForWrite(file) {
  if (!fs.existsSync(file)) return {};
  const text = fs.readFileSync(file, 'utf8');
  try {
    return text.trim() ? JSON.parse(text) : {};
  } catch (e) {
    throw new Error(`${file} is not valid JSON (${e.message}); fix it before applying`);
  }
}

function gitIgnoreNote(projectDir, file) {
  try {
    git(projectDir, ['rev-parse', '--is-inside-work-tree']);
  } catch (e) {
    warn('not a git repo; skipped the .gitignore check', { message: oneLine(e.stderr || e.message, 80) });
    return '';
  }
  try {
    git(projectDir, ['check-ignore', '-q', file]);
    return '';
  } catch (e) {
    if (e.status === 1) return `Note: ${path.relative(projectDir, file)} is not git-ignored here; keep it out of commits.`;
    warn('git check-ignore failed', { message: oneLine(e.stderr || e.message, 80) });
    return '';
  }
}

function cmdApply(projectDir, opts) {
  const inv = loadInventory(projectDir, opts.inv);
  const chosen = resolveRefs(inv, opts.disable);
  const file = settingsFiles(projectDir).local;
  const settings = readSettingsForWrite(file);
  const changes = applySwitches(settings, chosen);
  if (!changes.length) {
    console.log('Nothing to change: every requested item is already switched off.');
    return;
  }
  const undoFile = path.join(inv.state, 'undo.json');
  const undo = readJson(undoFile, []);
  undo.push({ at: new Date().toISOString(), file, changes });
  writeJsonAtomic(file, settings);
  writeJsonAtomic(undoFile, undo);
  const L = [`Switched off ${changes.length} item(s) for this project in ${file}:`];
  for (const c of changes) L.push(`- ${c.ref} ${c.kind} ${c.name} (${c.container})`);
  L.push('Takes effect in the next Claude Code session in this project. Undo with: restore');
  const note = gitIgnoreNote(projectDir, file);
  if (note) L.push(note);
  console.log(L.join('\n'));
}

function cmdRestore(projectDir) {
  const state = stateDir(projectDir);
  const undoFile = path.join(state, 'undo.json');
  const undo = readJson(undoFile, []);
  if (!undo.length) {
    console.log('Nothing to restore: cleanroom has no active changes in this project.');
    return;
  }
  const file = undo[undo.length - 1].file || settingsFiles(projectDir).local;
  const settings = readSettingsForWrite(file);
  const all = undo.flatMap(b => b.changes);
  const { reverted, skipped } = revertSwitches(settings, all);
  writeJsonAtomic(file, settings);
  fs.renameSync(undoFile, path.join(state, `undo.restored-${Date.now()}.json`));
  const L = [`Restored ${reverted.length} item(s) in ${file}:`];
  for (const c of reverted) L.push(`- ${c.kind} ${c.name}`);
  for (const c of skipped) L.push(`- skipped ${c.kind} ${c.name}: ${c.why}`);
  L.push('Takes effect in the next Claude Code session in this project.');
  console.log(L.join('\n'));
}

/* ------------------------------------------------------------------ */
/* Entry                                                               */
/* ------------------------------------------------------------------ */

export function parseArgs(argv) {
  const [cmd, ...rest] = argv;
  const opts = {};
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (!a.startsWith('--')) continue;
    const k = a.slice(2);
    const next = rest[i + 1];
    opts[k] = next !== undefined && !next.startsWith('--') ? rest[++i] : true;
  }
  return { cmd, opts };
}

const USAGE = [
  'usage: cleanroom.mjs <command> --project <dir> [options]',
  '  inventory [--fast] [--no-hooks] [--wait <seconds>]',
  '  forecast  --inv <id> --disable P1,M2,S3',
  '  apply     --inv <id> --disable P1,M2,S3',
  '  restore',
].join('\n');

async function main() {
  const { cmd, opts } = parseArgs(process.argv.slice(2));
  const projectDir = path.resolve(typeof opts.project === 'string' ? opts.project : process.cwd());
  if (!fs.existsSync(projectDir)) throw new Error(`project folder not found: ${projectDir}`);
  switch (cmd) {
    case 'inventory': return cmdInventory(projectDir, opts);
    case 'forecast': return cmdForecast(projectDir, opts);
    case 'apply': return cmdApply(projectDir, opts);
    case 'restore': return cmdRestore(projectDir);
    default: console.error(USAGE); process.exitCode = 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(e => {
    console.error(`[cleanroom] error: ${e.message}`);
    process.exitCode = 1;
  });
}
