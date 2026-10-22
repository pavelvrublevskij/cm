const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const request = require('supertest');
const { app, HOME } = require('./helpers/app');
const insights = require('../lib/usage-insights');
const { cleanMessage, buildPrompt } = require('../lib/commit-message');

function slugForPath(p) {
  const win = p.match(/^([A-Za-z]):[\\\/](.*)/);
  if (win) return `${win[1].toUpperCase()}--${win[2].replace(/[\\\/\.]/g, '-')}`;
  return p.replace(/^\//, '').replace(/[\/\.]/g, '-');
}

function run(args, cwd) {
  return execFileSync('git', args, { cwd, stdio: 'pipe' }).toString();
}

const REPO = path.join(HOME, 'commit-msg-proj');
const FRESH = path.join(HOME, 'commit-msg-fresh');
const realRun = insights.runClaude;
let seen = null;

before(() => {
  for (const dir of [REPO, FRESH]) {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    run(['init', '-q'], dir);
    run(['config', 'user.email', 'test@example.com'], dir);
    run(['config', 'user.name', 'test'], dir);
    run(['config', 'commit.gpgsign', 'false'], dir);
  }
  fs.writeFileSync(path.join(REPO, 'app.js'), 'const a = 1;\n');
  run(['add', 'app.js'], REPO);
  run(['commit', '-q', '-m', 'Add app entry point'], REPO);
  fs.writeFileSync(path.join(REPO, 'app.js'), 'const a = 2;\n');
  fs.writeFileSync(path.join(REPO, 'new-helper.js'), 'module.exports = () => 42;\n');
  fs.writeFileSync(path.join(REPO, 'untouched.js'), 'ignored\n');

  fs.writeFileSync(path.join(FRESH, 'first.txt'), 'hello\n');

  insights.runClaude = async (prompt, opts) => { seen = { prompt, opts }; return '```\nUpdate app constant\n\nAlso add a helper.\n```'; };
});

after(() => { insights.runClaude = realRun; });

function post(dir, body) {
  return request(app).post(`/api/projects/${slugForPath(dir)}/git/commit-message`).send(body);
}

test('commit-message sends the selected files\' diff and new files to claude', async () => {
  const res = await post(REPO, { files: ['app.js', 'new-helper.js'], model: 'haiku', effort: 'low' });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.message, 'Update app constant\n\nAlso add a helper.');
  assert.match(seen.prompt, /-const a = 1;\n\+const a = 2;/);
  assert.match(seen.prompt, /New file new-helper\.js:\nmodule\.exports = \(\) => 42;/);
  assert.match(seen.prompt, /Recent commit subjects:\n- Add app entry point/);
  assert.ok(!seen.prompt.includes('untouched.js'), 'unselected files stay out');
  assert.deepStrictEqual(seen.opts, { model: 'haiku', effort: 'low' });
});

test('commit-message leaves the index untouched', async () => {
  await post(REPO, { files: ['app.js', 'new-helper.js'] });
  assert.strictEqual(run(['diff', '--cached', '--name-only'], REPO).trim(), '');
  assert.match(run(['status', '--porcelain'], REPO), /\?\? new-helper\.js/);
});

test('commit-message works in a repository without commits', async () => {
  const res = await post(FRESH, { files: ['first.txt'] });
  assert.strictEqual(res.status, 200);
  assert.match(seen.prompt, /This repository has no commits yet\./);
  assert.match(seen.prompt, /New file first\.txt:\nhello/);
});

test('commit-message rejects bad requests without running claude', async () => {
  seen = null;
  assert.strictEqual((await post(REPO, { files: [] })).status, 400);
  assert.strictEqual((await post(REPO, { files: ['app.js'], model: 'gpt-4' })).status, 400);
  assert.strictEqual((await post(REPO, { files: ['app.js'], effort: 'huge' })).status, 400);
  const clean = await post(REPO, { files: ['no-such-file.js'] });
  assert.strictEqual(clean.status, 400);
  assert.match(clean.body.error, /no changes/);
  assert.strictEqual(seen, null);
});

test('cleanMessage strips code fences and wrapping quotes only', () => {
  assert.strictEqual(cleanMessage('```text\nFix bug\n```'), 'Fix bug');
  assert.strictEqual(cleanMessage('"Fix bug"'), 'Fix bug');
  assert.strictEqual(cleanMessage('Fix "quoted" thing'), 'Fix "quoted" thing');
  assert.strictEqual(cleanMessage('  Fix bug\n\nBody  '), 'Fix bug\n\nBody');
});

test('buildPrompt asks for a short imperative subject and only the message', () => {
  const p = buildPrompt('diff here', ['One', 'Two']);
  assert.match(p, /at most 72 characters, imperative mood/);
  assert.match(p, /Output only the commit message/);
  assert.match(p, /- One\n- Two/);
  assert.ok(p.endsWith('diff here'));
});
