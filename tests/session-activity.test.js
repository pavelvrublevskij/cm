const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { collectFromJsonl, collectFromDir } = require('../lib/session-activity');

// ── helpers ───────────────────────────────────────────────────────────────────

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sa-test-'));
}

function writeJsonl(filePath, entries) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, entries.map(e => JSON.stringify(e)).join('\n'));
}

function assistantEntry(tools, timestamp) {
  return {
    type: 'assistant',
    timestamp: timestamp || '2026-01-01T10:00:00Z',
    message: { content: tools.map(t => ({ type: 'tool_use', name: t.name, input: t.input || {} })) }
  };
}

// ── getCategory (via collectFromJsonl results) ────────────────────────────────

test('collectFromJsonl: Bash → category shell', () => {
  const dir = tmpDir();
  const f = path.join(dir, 'test.jsonl');
  writeJsonl(f, [assistantEntry([{ name: 'Bash', input: { command: 'ls' } }])]);
  const items = collectFromJsonl(f, null);
  assert.strictEqual(items[0].category, 'shell');
});

test('collectFromJsonl: PowerShell → category shell', () => {
  const dir = tmpDir();
  const f = path.join(dir, 'test.jsonl');
  writeJsonl(f, [assistantEntry([{ name: 'PowerShell', input: { command: 'dir' } }])]);
  const items = collectFromJsonl(f, null);
  assert.strictEqual(items[0].category, 'shell');
});

test('collectFromJsonl: Read/Write/Edit/MultiEdit/Glob/Grep/NotebookEdit → category file', () => {
  const fileTools = ['Read', 'Write', 'Edit', 'MultiEdit', 'Glob', 'Grep', 'NotebookEdit'];
  const dir = tmpDir();
  const f = path.join(dir, 'test.jsonl');
  writeJsonl(f, [assistantEntry(fileTools.map(name => ({ name, input: { file_path: '/a', pattern: 'x', notebook_path: '/nb' } })))]);
  const items = collectFromJsonl(f, null);
  for (const item of items) assert.strictEqual(item.category, 'file', `${item.tool} should be file`);
  assert.strictEqual(items.length, fileTools.length);
});

test('collectFromJsonl: WebFetch/WebSearch → category web', () => {
  const dir = tmpDir();
  const f = path.join(dir, 'test.jsonl');
  writeJsonl(f, [assistantEntry([
    { name: 'WebFetch', input: { url: 'https://example.com' } },
    { name: 'WebSearch', input: { query: 'nodejs' } }
  ])]);
  const items = collectFromJsonl(f, null);
  assert.ok(items.every(i => i.category === 'web'));
});

test('collectFromJsonl: Agent/Task/TaskCreate → category agent', () => {
  const dir = tmpDir();
  const f = path.join(dir, 'test.jsonl');
  writeJsonl(f, [assistantEntry([
    { name: 'Agent', input: { description: 'do work' } },
    { name: 'Task', input: {} },
    { name: 'TaskCreate', input: {} }
  ])]);
  const items = collectFromJsonl(f, null);
  assert.ok(items.every(i => i.category === 'agent'));
});

test('collectFromJsonl: unknown tool → category other', () => {
  const dir = tmpDir();
  const f = path.join(dir, 'test.jsonl');
  writeJsonl(f, [assistantEntry([{ name: 'UnknownTool', input: { x: 1 } }])]);
  const items = collectFromJsonl(f, null);
  assert.strictEqual(items[0].category, 'other');
});

// ── getLabel (via collectFromJsonl results) ───────────────────────────────────

test('collectFromJsonl: Bash label is command', () => {
  const dir = tmpDir();
  const f = path.join(dir, 'test.jsonl');
  writeJsonl(f, [assistantEntry([{ name: 'Bash', input: { command: 'npm test' } }])]);
  assert.strictEqual(collectFromJsonl(f, null)[0].label, 'npm test');
});

test('collectFromJsonl: WebSearch label is query', () => {
  const dir = tmpDir();
  const f = path.join(dir, 'test.jsonl');
  writeJsonl(f, [assistantEntry([{ name: 'WebSearch', input: { query: 'react docs' } }])]);
  assert.strictEqual(collectFromJsonl(f, null)[0].label, 'react docs');
});

test('collectFromJsonl: WebFetch label is url', () => {
  const dir = tmpDir();
  const f = path.join(dir, 'test.jsonl');
  writeJsonl(f, [assistantEntry([{ name: 'WebFetch', input: { url: 'https://example.com' } }])]);
  assert.strictEqual(collectFromJsonl(f, null)[0].label, 'https://example.com');
});

test('collectFromJsonl: Agent label is description', () => {
  const dir = tmpDir();
  const f = path.join(dir, 'test.jsonl');
  writeJsonl(f, [assistantEntry([{ name: 'Agent', input: { description: 'run subtask' } }])]);
  assert.strictEqual(collectFromJsonl(f, null)[0].label, 'run subtask');
});

test('collectFromJsonl: Agent with no description falls back to prompt (truncated to 200)', () => {
  const dir = tmpDir();
  const f = path.join(dir, 'test.jsonl');
  const long = 'x'.repeat(300);
  writeJsonl(f, [assistantEntry([{ name: 'Agent', input: { prompt: long } }])]);
  assert.strictEqual(collectFromJsonl(f, null)[0].label, 'x'.repeat(200));
});

test('collectFromJsonl: NotebookEdit label is notebook_path', () => {
  const dir = tmpDir();
  const f = path.join(dir, 'test.jsonl');
  writeJsonl(f, [assistantEntry([{ name: 'NotebookEdit', input: { notebook_path: '/nb.ipynb' } }])]);
  assert.strictEqual(collectFromJsonl(f, null)[0].label, '/nb.ipynb');
});

test('collectFromJsonl: Grep label is pattern', () => {
  const dir = tmpDir();
  const f = path.join(dir, 'test.jsonl');
  writeJsonl(f, [assistantEntry([{ name: 'Grep', input: { pattern: 'foo.*bar' } }])]);
  assert.strictEqual(collectFromJsonl(f, null)[0].label, 'foo.*bar');
});

test('collectFromJsonl: unknown tool label is JSON-serialized input (truncated to 200)', () => {
  const dir = tmpDir();
  const f = path.join(dir, 'test.jsonl');
  writeJsonl(f, [assistantEntry([{ name: 'SpecialTool', input: { key: 'val' } }])]);
  const label = collectFromJsonl(f, null)[0].label;
  assert.ok(label.includes('key'));
  assert.ok(label.includes('val'));
});

// ── collectFromJsonl: entry filtering ────────────────────────────────────────

test('collectFromJsonl: skips non-assistant entries', () => {
  const dir = tmpDir();
  const f = path.join(dir, 'test.jsonl');
  writeJsonl(f, [
    { type: 'user', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'whoops' } }] } },
    assistantEntry([{ name: 'Read', input: { file_path: '/src/index.js' } }])
  ]);
  const items = collectFromJsonl(f, null);
  assert.strictEqual(items.length, 1);
  assert.strictEqual(items[0].tool, 'Read');
});

test('collectFromJsonl: skips entries where content is a string not an array', () => {
  const dir = tmpDir();
  const f = path.join(dir, 'test.jsonl');
  writeJsonl(f, [
    { type: 'assistant', timestamp: '2026-01-01T10:00:00Z', message: { content: 'plain text response' } }
  ]);
  assert.deepStrictEqual(collectFromJsonl(f, null), []);
});

test('collectFromJsonl: skips malformed JSON lines without throwing', () => {
  const dir = tmpDir();
  const f = path.join(dir, 'test.jsonl');
  fs.writeFileSync(f, '{"type":"assistant","timestamp":"2026-01-01T10:00:00Z","message":{"content":[{"type":"tool_use","name":"Bash","input":{"command":"ls"}}]}}\nNOT_JSON\n');
  const items = collectFromJsonl(f, null);
  assert.strictEqual(items.length, 1);
  assert.strictEqual(items[0].tool, 'Bash');
});

test('collectFromJsonl: returns empty array for missing file', () => {
  assert.deepStrictEqual(collectFromJsonl('/nonexistent/path.jsonl', null), []);
});

test('collectFromJsonl: timestamp is preserved from entry', () => {
  const dir = tmpDir();
  const f = path.join(dir, 'test.jsonl');
  writeJsonl(f, [assistantEntry([{ name: 'Bash', input: { command: 'ls' } }], '2026-03-15T12:00:00Z')]);
  assert.strictEqual(collectFromJsonl(f, null)[0].timestamp, '2026-03-15T12:00:00Z');
});

// ── collectFromJsonl: agentId handling ───────────────────────────────────────

test('collectFromJsonl: agentId=null means agentId and agentLabel are null', () => {
  const dir = tmpDir();
  const f = path.join(dir, 'test.jsonl');
  writeJsonl(f, [assistantEntry([{ name: 'Bash', input: { command: 'ls' } }])]);
  const item = collectFromJsonl(f, null)[0];
  assert.strictEqual(item.agentId, null);
  assert.strictEqual(item.agentLabel, null);
});

test('collectFromJsonl: agentId set → items carry that agentId and extract first user text as agentLabel', () => {
  const dir = tmpDir();
  const f = path.join(dir, 'subagent.jsonl');
  writeJsonl(f, [
    { type: 'user', message: { content: 'analyze this data' } },
    assistantEntry([{ name: 'Read', input: { file_path: '/data.csv' } }])
  ]);
  const items = collectFromJsonl(f, 'subagent');
  assert.strictEqual(items[0].agentId, 'subagent');
  assert.strictEqual(items[0].agentLabel, 'analyze this data');
});

test('collectFromJsonl: agentLabel extracted from array content blocks', () => {
  const dir = tmpDir();
  const f = path.join(dir, 'sa.jsonl');
  writeJsonl(f, [
    { type: 'user', message: { content: [{ type: 'text', text: 'array prompt' }] } },
    assistantEntry([{ name: 'Bash', input: { command: 'ls' } }])
  ]);
  const items = collectFromJsonl(f, 'myagent');
  assert.strictEqual(items[0].agentLabel, 'array prompt');
});

test('collectFromJsonl: agentLabel is null when no user messages exist', () => {
  const dir = tmpDir();
  const f = path.join(dir, 'nouser.jsonl');
  writeJsonl(f, [assistantEntry([{ name: 'Bash', input: { command: 'ls' } }])]);
  const items = collectFromJsonl(f, 'myagent');
  assert.strictEqual(items[0].agentLabel, null);
});

// ── collectFromDir ────────────────────────────────────────────────────────────

test('collectFromDir: collects tool calls from all jsonl files in directory', () => {
  const dir = tmpDir();
  writeJsonl(path.join(dir, 'a.jsonl'), [assistantEntry([{ name: 'Bash', input: { command: 'ls' } }])]);
  writeJsonl(path.join(dir, 'b.jsonl'), [assistantEntry([{ name: 'Read', input: { file_path: '/x' } }])]);
  const items = collectFromDir(dir, 10);
  assert.strictEqual(items.length, 2);
  const tools = items.map(i => i.tool).sort();
  assert.deepStrictEqual(tools, ['Bash', 'Read']);
});

test('collectFromDir: skips journal.jsonl', () => {
  const dir = tmpDir();
  writeJsonl(path.join(dir, 'journal.jsonl'), [assistantEntry([{ name: 'Bash', input: { command: 'should-skip' } }])]);
  writeJsonl(path.join(dir, 'real.jsonl'), [assistantEntry([{ name: 'Read', input: { file_path: '/x' } }])]);
  const items = collectFromDir(dir, 10);
  assert.strictEqual(items.length, 1);
  assert.strictEqual(items[0].tool, 'Read');
});

test('collectFromDir: respects maxFiles limit', () => {
  const dir = tmpDir();
  for (let i = 0; i < 5; i++) {
    writeJsonl(path.join(dir, `f${i}.jsonl`), [assistantEntry([{ name: 'Bash', input: { command: String(i) } }])]);
  }
  const items = collectFromDir(dir, 3);
  assert.ok(items.length <= 3, `expected at most 3 items, got ${items.length}`);
});

test('collectFromDir: skips files over 2MB', () => {
  const dir = tmpDir();
  const big = path.join(dir, 'big.jsonl');
  fs.writeFileSync(big, 'x'.repeat(2 * 1024 * 1024 + 1));
  const small = path.join(dir, 'small.jsonl');
  writeJsonl(small, [assistantEntry([{ name: 'Read', input: { file_path: '/f' } }])]);
  const items = collectFromDir(dir, 10);
  assert.strictEqual(items.length, 1);
  assert.strictEqual(items[0].tool, 'Read');
});

test('collectFromDir: walks subdirectories', () => {
  const dir = tmpDir();
  const sub = path.join(dir, 'subdir');
  fs.mkdirSync(sub, { recursive: true });
  writeJsonl(path.join(sub, 'nested.jsonl'), [assistantEntry([{ name: 'WebSearch', input: { query: 'hi' } }])]);
  const items = collectFromDir(dir, 10);
  assert.strictEqual(items.length, 1);
  assert.strictEqual(items[0].tool, 'WebSearch');
});

test('collectFromDir: returns empty array for missing directory', () => {
  assert.deepStrictEqual(collectFromDir('/nonexistent/dir', 10), []);
});

test('collectFromDir: non-jsonl files are ignored', () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'readme.txt'), 'hello');
  fs.writeFileSync(path.join(dir, 'data.json'), '{}');
  assert.deepStrictEqual(collectFromDir(dir, 10), []);
});

// ── client: copy button on shell commands ─────────────────────────────────────

function loadActivityClient() {
  const vm = require('vm');
  const src = 'const Sessions = {};\n'
    + fs.readFileSync(path.join(__dirname, '../public/js/session-activity.js'), 'utf-8')
    + '\nglobalThis._Sessions = Sessions;';
  const ctx = vm.createContext({ escapeHtml: s => String(s).split('"').join('&quot;').split('<').join('&lt;') });
  vm.runInContext(src, ctx);
  return ctx._Sessions;
}

test('_renderActivityItem: shell items get a copy button carrying the full command', () => {
  const S = loadActivityClient();
  const cmd = 'git log --oneline "a b" ' + 'x'.repeat(120);
  const html = S._renderActivityItem({ tool: 'Bash', category: 'shell', label: cmd }, 0);
  assert.ok(html.includes('activity-copy-btn'));
  assert.ok(html.includes(`data-copy="${cmd.split('"').join('&quot;')}"`));
  assert.ok(html.includes("copyToClipboard(this.dataset.copy, 'Command copied')"));
});

test('_renderActivityItem: non-shell items have no copy button', () => {
  const S = loadActivityClient();
  const html = S._renderActivityItem({ tool: 'Read', category: 'file', label: '/a/b.js' }, 0);
  assert.strictEqual(html.includes('activity-copy-btn'), false);
});
