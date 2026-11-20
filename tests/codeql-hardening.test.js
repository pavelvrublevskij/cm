const { test } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const request = require('supertest');
const { app } = require('./helpers/app');
const { safeJoin, isSafeKey } = require('../lib/file-helpers');
const { parseStatus } = require('../lib/git');
const { resolveModelPrice } = require('../lib/pricing');
const { parseMarker } = require('../lib/task-board-runner');
const taskBoard = require('../lib/task-board');

// Fixes for the CodeQL code-scanning findings.

test('safeJoin accepts one plain name and rejects anything that leaves the folder', () => {
  const dir = path.resolve('some-dir');
  assert.strictEqual(safeJoin(dir, 'a.md'), path.join(dir, 'a.md'));
  for (const bad of ['', '.', '..', 'a/b', 'a\\b', '../a', undefined, ['a']]) {
    assert.strictEqual(safeJoin(dir, bad), null, String(bad));
  }
});

test('isSafeKey rejects keys that reach Object.prototype', () => {
  assert.strictEqual(isSafeKey('my-project'), true);
  for (const k of ['__proto__', 'constructor', 'prototype']) assert.strictEqual(isSafeKey(k), false);
});

test('skill and output-style routes reject a name with a path in it', async () => {
  assert.strictEqual((await request(app).get('/api/skills/global/..%2F..%2Fx')).status, 400);
  assert.strictEqual((await request(app).delete('/api/skills/global/a%5Cb')).status, 400);
  const res = await request(app).put('/api/output-styles/global/..%2Fevil.md').send({ content: 'x' });
  assert.strictEqual(res.status, 400);
});

test('resume rejects a session ID that is not a plain ID', async () => {
  const res = await request(app).post('/api/projects/some-project/sessions/a%26b/resume');
  assert.strictEqual(res.status, 400);
});

test('usage summary ignores a date filter sent as an array', async () => {
  const res = await request(app).get('/api/usage/summary?from=2026-01-01&from=2026-02-01');
  assert.strictEqual(res.status, 200);
});

test('a task board lane cannot be keyed by __proto__', () => {
  assert.ok(taskBoard.setLane('__proto__', { parallel: true }).error);
  assert.strictEqual({}.parallel, undefined);
});

test('parseStatus unescapes a quoted path in one pass', () => {
  // git writes a backslash followed by "n" in a file name as "\\\\n": that is a backslash and an n, not a newline.
  const [entry] = parseStatus(' M "a\\\\nb \\"q\\".txt"');
  assert.strictEqual(entry.path, 'a\\nb "q".txt');
});

test('resolveModelPrice still strips a trailing variant like [1m]', () => {
  const map = { 'claude-x': { input: 1 } };
  assert.strictEqual(resolveModelPrice('claude-x[1m]', map), map['claude-x']);
  assert.strictEqual(resolveModelPrice('[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[x', map), null);
});

test('parseMarker strips trailing markdown and surrounding spaces from the message', () => {
  assert.deepStrictEqual({ ...parseMarker('CM-STAGE: needs_input \t pick a db **') }, { status: 'needs_input', message: 'pick a db' });
});

test('safeJoin still accepts names with a double dot inside, like "my..skill"', async () => {
  assert.ok(safeJoin(path.resolve('d'), 'v1..2.md'));
  const put = await request(app).put('/api/skills/global/my..skill').send({ frontmatter: { name: 'x' }, content: 'x' });
  assert.strictEqual(put.status, 200);
  assert.strictEqual((await request(app).delete('/api/skills/global/my..skill')).status, 200);
});

test('file-history diff still rejects a ".." in the session ID or hash', async () => {
  assert.strictEqual((await request(app).get('/api/file-history/a..b/h/diff?from=1&to=2')).status, 400);
  assert.strictEqual((await request(app).get('/api/file-history/s/h..x/diff?from=1&to=2')).status, 400);
});

test('sub-agent route rejects a session ID with a path in it', async () => {
  const res = await request(app).get('/api/projects/some-project/sessions/a%2Fb/subagents/x');
  assert.strictEqual(res.status, 400);
});

test('skill usage counts a skill named "constructor" and refuses __proto__', () => {
  const { recordUsage, readUsage } = require('../lib/skill-usage');
  assert.strictEqual(recordUsage('hardening-proj', 'constructor'), 1);
  assert.strictEqual(readUsage('hardening-proj').constructor, 1);
  assert.throws(() => recordUsage('hardening-proj', '__proto__'));
  assert.throws(() => recordUsage('__proto__', 'x'));
});

test('session colors refuse a __proto__ key', () => {
  const { setSessionColor } = require('../lib/session-colors');
  assert.throws(() => setSessionColor('__proto__', 'id', '#ff0000'));
  assert.throws(() => setSessionColor('proj', '__proto__', '#ff0000'));
});

test('terminal launch never puts the project folder in a command line', () => {
  const { terminalSpawnArgs } = require('../lib/terminal-launch');
  const dir = "/tmp/a'b & c";
  const cmd = 'claude --resume "id"';
  const cases = [['win32'], ['darwin'], ['linux', 'gnome-terminal'], ['linux', 'xterm']];
  for (const [platform, term] of cases) {
    const [, args, opts] = terminalSpawnArgs(platform, dir, cmd, term);
    assert.ok(!args.join(' ').includes(dir), platform + ' ' + term);
    assert.ok(opts.cwd === dir || opts.env.CM_DIR === dir, platform + ' ' + term);
  }
  assert.deepStrictEqual(terminalSpawnArgs('win32', dir, cmd)[1], ['/c', 'start', 'cmd.exe', '/k', cmd]);
  assert.strictEqual(terminalSpawnArgs('darwin', dir, cmd)[2].env.CM_CMD, cmd);
});

test('a URL-hash slug that is not a project slug is dropped', () => {
  const vm = require('vm');
  const fs = require('fs');
  const src = fs.readFileSync(path.join(__dirname, '../public/js/app.js'), 'utf-8') + ';globalThis.App = App;';
  const hash = { value: '' };
  const ctx = vm.createContext({
    window: { get location() { return { hash: hash.value }; }, addEventListener() {} },
    document: { addEventListener() {}, getElementById: () => null, querySelector: () => null, querySelectorAll: () => [] },
    history: { replaceState() {} },
    localStorage: { getItem: () => null, setItem() {} }
  });
  vm.runInContext(src, ctx);
  const calls = [];
  ctx.App.navigate = (view, opts) => calls.push([view, opts.slug]);
  hash.value = '#project-detail/%3Cimg%20src=x%3E';
  ctx.App.restoreRoute();
  hash.value = '#project-detail/C--Users-me-code-cm';
  ctx.App.restoreRoute();
  assert.deepStrictEqual(calls, [['project-detail', undefined], ['project-detail', 'C--Users-me-code-cm']]);
});
