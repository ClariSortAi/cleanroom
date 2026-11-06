import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseTokens, parseContext, frontmatter, overlayFor, applySwitches, revertSwitches,
  resolveRefs, parseRunOutput, describeMcpConfig, deferredNameTokens, mcpToolPrefix, parseArgs,
  checkInventoryId, offKeysFromSettings, categoryRows, userScopeRejections,
} from '../scripts/cleanroom.mjs';

const CONTEXT_MD = `## Context Usage

**Model:** claude-opus-5-5
**Tokens:** 37.2k / 660k (6%)

### Estimated usage by category

| Category | Tokens | Percentage |
|----------|--------|------------|
| System prompt | 2.8k | 0.4% |
| MCP tools | 614 | 0.1% |
| MCP tools (deferred) | 192.7k | 29.2% |
| Skills | 10k | 1.5% |
| Free space | 589.8k | 89.4% |

### MCP Tools

| Tool | Server | Tokens |
|------|--------|--------|
| mcp__claude_ai_Docs__read | claude_ai_Docs | 297 |
| mcp__alpha__ping | alpha | 1.2k |

### Custom Agents

| Agent Type | Source | Tokens |
|------------|--------|--------|
| helper | User | 153 |

### Memory Files

| Type | Path | Tokens |
|------|------|--------|
| User | C:\\Users\\x\\.claude\\CLAUDE.md | 1.2k |

### Skills

| Skill | Source | Tokens |
|-------|--------|--------|
| archify | User | ~220 |
| tiny | User | < 20 |
| pdf | claude.ai sync | < 20 |
| setup:recommender | Plugin (setup) | ~140 |
| dataviz | Built-in | ~480 |
`;

test('parseTokens handles k, ~, < and plain numbers', () => {
  assert.equal(parseTokens('37.2k').tokens, 37200);
  assert.equal(parseTokens('~220').tokens, 220);
  assert.equal(parseTokens('614').tokens, 614);
  assert.deepEqual(parseTokens('< 20'), { tokens: 10, approx: true, below: 20 });
  assert.equal(parseTokens('1.5m').tokens, 1500000);
  assert.equal(parseTokens('n/a').tokens, 0);
});

test('parseContext reads totals and every table', () => {
  const c = parseContext(CONTEXT_MD);
  assert.equal(c.used, 37200);
  assert.equal(c.window, 660000);
  assert.equal(c.categories['MCP tools'], 614);
  assert.equal(c.categories['MCP tools (deferred)'], 192700);
  assert.equal(c.mcpTools.length, 2);
  assert.deepEqual(c.mcpTools[1], { tool: 'mcp__alpha__ping', server: 'alpha', tokens: 1200 });
  assert.equal(c.agents[0].name, 'helper');
  assert.equal(c.memory[0].tokens, 1200);
  assert.equal(c.skills.length, 5);
  assert.equal(c.skills.find(s => s.name === 'tiny').below, 20);
  assert.equal(c.skills.find(s => s.name === 'pdf').source, 'claude.ai sync');
});

test('frontmatter reads plain, quoted, escaped and folded values', () => {
  const fm = frontmatter('---\nname: x\ndescription: "Use when \\"SEO\\" is said"\nother: >\n  folded line one\n  line two\n---\nbody');
  assert.equal(fm.name, 'x');
  assert.equal(fm.description, 'Use when "SEO" is said');
  assert.equal(fm.other, 'folded line one line two');
  assert.deepEqual(frontmatter('no frontmatter'), {});
});

test('mcp helpers sanitize names and estimate deferred name cost', () => {
  assert.equal(mcpToolPrefix('claude.ai Claude Docs'), 'claude_ai_Claude_Docs');
  assert.equal(mcpToolPrefix('my-local-server'), 'my-local-server');
  assert.equal(deferredNameTokens([{ tool: 'mcp__a__b' }]), 4);
});

test('describeMcpConfig never leaks secrets', () => {
  assert.equal(describeMcpConfig({ url: 'https://api.example.com/mcp?key=SECRET', headers: { Authorization: 'Bearer x' } }), 'remote api.example.com');
  assert.equal(describeMcpConfig({ type: 'http', url: 'https://api.example.com/mcp' }), 'http api.example.com');
  const d = describeMcpConfig({ command: 'C:\\tools\\node.exe', args: ['C:\\srv\\index.js', '--api-key=SECRET', 'abcdefghijklmnopqrstuvwxyz0123456789ABCD', '--token', '/c'], env: { TOKEN: 'x' } });
  assert.ok(!/SECRET|abcdefghij|token/i.test(d), d);
  assert.match(d, /^stdio node\.exe index\.js/);
  assert.match(describeMcpConfig({ command: 'cmd.exe', args: ['/d', '/c', 'npx'] }), /\/d \/c npx/);
});

test('overlayFor maps each kind to its settings key', () => {
  const o = overlayFor([
    { kind: 'plugin', key: 'pw@official' },
    { kind: 'mcp', key: 'claude.ai PostHog' },
    { kind: 'skill', key: 'anthropic-skills:pdf' },
  ]);
  assert.deepEqual(o, {
    enabledPlugins: { 'pw@official': false },
    deniedMcpServers: [{ serverName: 'claude.ai PostHog' }],
    skillOverrides: { 'anthropic-skills:pdf': 'off' },
  });
});

test('applySwitches + revertSwitches round-trip and keep unrelated settings', () => {
  const original = {
    permissions: { allow: ['Bash(ls:*)'] },
    skillOverrides: { keepme: 'off', archify: 'on' },
    deniedMcpServers: [{ serverName: 'already' }],
  };
  const s = structuredClone(original);
  const items = [
    { ref: 'P1', kind: 'plugin', key: 'pw@official', name: 'pw' },
    { ref: 'M1', kind: 'mcp', key: 'rea', name: 'rea' },
    { ref: 'M2', kind: 'mcp', key: 'already', name: 'already' },
    { ref: 'S1', kind: 'skill', key: 'archify', name: 'archify' },
    { ref: 'S2', kind: 'skill', key: 'keepme', name: 'keepme' },
  ];
  const changes = applySwitches(s, items);
  assert.equal(changes.length, 3, 'already-off items are not logged');
  assert.equal(s.enabledPlugins['pw@official'], false);
  assert.equal(s.skillOverrides.archify, 'off');
  assert.equal(s.deniedMcpServers.length, 2);
  const { reverted, skipped } = revertSwitches(s, changes);
  assert.equal(reverted.length, 3);
  assert.equal(skipped.length, 0);
  assert.deepEqual(s, original);
});

test('revertSwitches leaves values the user changed after apply', () => {
  const s = {};
  const changes = applySwitches(s, [{ ref: 'S1', kind: 'skill', key: 'x', name: 'x' }]);
  s.skillOverrides.x = 'on';
  const { reverted, skipped } = revertSwitches(s, changes);
  assert.equal(reverted.length, 0);
  assert.equal(skipped.length, 1);
  assert.equal(s.skillOverrides.x, 'on');
});

test('resolveRefs accepts case-insensitive refs and rejects unknown ones', () => {
  const inv = { items: [{ ref: 'S1', name: 'a' }, { ref: 'M2', name: 'b' }] };
  assert.deepEqual(resolveRefs(inv, 's1, M2').map(i => i.name), ['a', 'b']);
  assert.deepEqual(resolveRefs(inv, ''), []);
  assert.throws(() => resolveRefs(inv, 'S1,X9'), /unknown refs: X9/);
});

test('parseRunOutput picks init and result out of stream-json lines', () => {
  const lines = [
    JSON.stringify({ type: 'system', subtype: 'hook_started' }),
    'not json',
    JSON.stringify({ type: 'system', subtype: 'init', skills: ['a'] }),
    JSON.stringify({ type: 'result', subtype: 'success', result: CONTEXT_MD }),
  ].join('\n');
  const r = parseRunOutput(lines);
  assert.deepEqual(r.init.skills, ['a']);
  assert.equal(r.ctx.used, 37200);
  assert.throws(() => parseRunOutput(JSON.stringify({ type: 'result', result: 'x' })), /init message missing/);
});

test('parseRunOutput refuses a run where /context reached the model', () => {
  const lines = [
    JSON.stringify({ type: 'system', subtype: 'init', skills: [] }),
    JSON.stringify({ type: 'result', subtype: 'success', num_turns: 1, total_cost_usd: 0.02, result: 'I cannot run /context.' }),
  ].join('\n');
  assert.throws(() => parseRunOutput(lines), /sent \/context to the model/);
});

test('checkInventoryId rejects missing or stale ids', () => {
  const inv = { id: 'abc123' };
  assert.doesNotThrow(() => checkInventoryId(inv, 'abc123'));
  assert.throws(() => checkInventoryId(inv, undefined), /missing --inv/);
  assert.throws(() => checkInventoryId(inv, true), /missing --inv/);
  assert.throws(() => checkInventoryId(inv, 'zzz999'), /does not match the latest inventory \(abc123\)/);
});

test('parseArgs reads flags with and without values', () => {
  assert.deepEqual(parseArgs(['apply', '--project', 'C:\\x', '--disable', 'S1,M2', '--fast']), {
    cmd: 'apply', opts: { project: 'C:\\x', disable: 'S1,M2', fast: true },
  });
});

test('offKeysFromSettings lists exactly what a settings file switches off', () => {
  assert.deepEqual(offKeysFromSettings({
    enabledPlugins: { 'a@m': false, 'b@m': true },
    skillOverrides: { x: 'off', y: 'on', z: 'user-invocable-only' },
    deniedMcpServers: [{ serverName: 'rea' }, {}],
  }), ['plugin:a@m', 'skill:x', 'mcp:rea']);
  assert.deepEqual(offKeysFromSettings(undefined), []);
});

test('categoryRows merges the split skill listing into one row', () => {
  const rows = categoryRows(
    { Skills: 9900, 'System tools': 5700, 'MCP tools': 672, 'Free space': 1 },
    { Skills: 4900, 'System tools': 10700, 'MCP tools': 0, 'Free space': 2 },
  );
  assert.deepEqual(rows, [{ name: 'MCP tools', before: 672, after: 0 }]);
  const shrink = categoryRows({ Skills: 9000, 'System tools': 5000 }, { Skills: 3000, 'System tools': 5000 });
  assert.deepEqual(shrink, [{ name: 'Skills + System tools (skill listing)', before: 14000, after: 8000 }]);
});

test('userScopeRejections blocks MCP servers and project-only items', () => {
  const out = userScopeRejections([
    { ref: 'P1', kind: 'plugin', scope: 'user', name: 'p' },
    { ref: 'S1', kind: 'skill', scope: 'user', name: 's' },
    { ref: 'S2', kind: 'skill', scope: 'project', name: 'proj-skill' },
    { ref: 'M1', kind: 'mcp', scope: 'user', name: 'rea' },
  ]);
  assert.equal(out.length, 2);
  assert.match(out[0], /^S2 proj-skill: declared for this project only/);
  assert.match(out[1], /^M1 rea: MCP servers are not switched off at user scope/);
});
