const { test, before } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { execFileSync } = require('child_process');
const request = require('supertest');
const { app, HOME } = require('./helpers/app');
const { worktreeStatus, clearWorktreeStatusCache } = require('../lib/git');
const board = require('../lib/task-board');

function slugForPath(p) {
  const win = p.match(/^([A-Za-z]):[\\\/](.*)/);
  if (win) return `${win[1].toUpperCase()}--${win[2].replace(/[\\\/\.]/g, '-')}`;
  return p.replace(/^\//, '').replace(/[\/\.]/g, '-');
}

function run(args, cwd) {
  execFileSync('git', args, { cwd, stdio: 'pipe' });
}

function commit(dir, file, content, message) {
  fs.writeFileSync(path.join(dir, file), content);
  run(['add', '--', file], dir);
  run(['commit', '-q', '-m', message], dir);
}

// A repo on "main" with two worktrees: one holding an uncommitted file and two commits main lacks,
// one with nothing main does not already have.
const REPO = path.join(HOME, 'wt-status-proj');
const DIRTY = path.join(REPO, '.claude', 'worktrees', 'cm-0000dir1');
const CLEAN = path.join(REPO, '.claude', 'worktrees', 'cm-0000cle1');

before(() => {
  fs.rmSync(REPO, { recursive: true, force: true });
  fs.mkdirSync(REPO, { recursive: true });
  run(['init', '-q', '-b', 'main'], REPO);
  run(['config', 'user.email', 'test@example.com'], REPO);
  run(['config', 'user.name', 'test'], REPO);
  run(['config', 'commit.gpgsign', 'false'], REPO);
  fs.writeFileSync(path.join(REPO, '.gitignore'), '.claude/\n');
  commit(REPO, 'a.txt', 'a\n', 'initial');
  run(['worktree', 'add', '-q', '-b', 'worktree-cm-0000dir1', DIRTY, 'main'], REPO);
  run(['worktree', 'add', '-q', '-b', 'worktree-cm-0000cle1', CLEAN, 'main'], REPO);
  commit(DIRTY, 'b.txt', 'b\n', 'add b');
  commit(DIRTY, 'c.txt', 'c\n', 'add c');
  fs.writeFileSync(path.join(DIRTY, 'a.txt'), 'changed\n');
  fs.writeFileSync(path.join(DIRTY, 'new.txt'), 'new\n');
});

test('worktreeStatus lists uncommitted files and the commits base lacks, newest first', async () => {
  const st = await worktreeStatus(DIRTY, 'main');
  assert.strictEqual(st.branch, 'worktree-cm-0000dir1');
  assert.strictEqual(st.base, 'main');
  assert.deepStrictEqual(st.files.map(f => [f.path, f.label]).sort(), [['a.txt', 'modified'], ['new.txt', 'untracked']]);
  assert.strictEqual(st.unmergedCount, 2);
  assert.deepStrictEqual(st.unmerged.map(c => c.subject), ['add c', 'add b']);
});

test('worktreeStatus of a worktree with nothing new is empty', async () => {
  const st = await worktreeStatus(CLEAN, 'main');
  assert.deepStrictEqual(st.files, []);
  assert.strictEqual(st.unmergedCount, 0);
  assert.deepStrictEqual(st.unmerged, []);
});

test('worktreeStatus caps the commit list but counts them all', async () => {
  const st = await worktreeStatus(DIRTY, 'main', 1);
  assert.strictEqual(st.unmerged.length, 1);
  assert.strictEqual(st.unmergedCount, 2);
});

test('worktreeStatus without a base, or with an unknown one, reports no unmerged count', async () => {
  for (const base of [null, 'no-such-branch']) {
    const st = await worktreeStatus(DIRTY, base);
    assert.strictEqual(st.unmerged, null);
    assert.strictEqual(st.unmergedCount, null);
    assert.strictEqual(st.files.length, 2);
  }
});

test('git/worktree reports a linked worktree against the branch the main checkout is on', async () => {
  const res = await request(app).get(`/api/projects/${slugForPath(DIRTY)}/git/worktree`);
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.worktree, true);
  assert.strictEqual(res.body.name, 'cm-0000dir1');
  assert.strictEqual(res.body.branch, 'worktree-cm-0000dir1');
  assert.strictEqual(res.body.base, 'main');
  assert.strictEqual(res.body.files.length, 2);
  assert.strictEqual(res.body.unmergedCount, 2);
});

test('git/worktree on the main checkout or a non-repo says it is no worktree', async () => {
  const main = await request(app).get(`/api/projects/${slugForPath(REPO)}/git/worktree`);
  assert.deepStrictEqual(main.body, { worktree: false });
  const missing = await request(app).get(`/api/projects/${slugForPath(path.join(HOME, 'wt-no-such-dir'))}/git/worktree`);
  assert.deepStrictEqual(missing.body, { worktree: false });
});

test('git/worktree on a submodule says it is no worktree', async () => {
  const SUB_SRC = path.join(HOME, 'wt-sub-src');
  const SUPER = path.join(HOME, 'wt-super');
  for (const d of [SUB_SRC, SUPER]) {
    fs.rmSync(d, { recursive: true, force: true });
    fs.mkdirSync(d, { recursive: true });
    run(['init', '-q', '-b', 'main'], d);
    run(['config', 'user.email', 'test@example.com'], d);
    run(['config', 'user.name', 'test'], d);
    run(['config', 'commit.gpgsign', 'false'], d);
  }
  commit(SUB_SRC, 's.txt', 's\n', 'sub');
  commit(SUPER, 'x.txt', 'x\n', 'super');
  run(['-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', SUB_SRC, 'sub'], SUPER);
  const res = await request(app).get(`/api/projects/${slugForPath(path.join(SUPER, 'sub'))}/git/worktree`);
  assert.deepStrictEqual(res.body, { worktree: false });
});

test('a git action through CM drops the cached worktree statuses', async () => {
  const slug = slugForPath(DIRTY);
  const before = await request(app).get(`/api/projects/${slug}/git/worktree`);
  assert.strictEqual(before.body.files.length, 2);
  fs.writeFileSync(path.join(DIRTY, 'another.txt'), 'x\n');
  const cached = await request(app).get(`/api/projects/${slug}/git/worktree`);
  assert.strictEqual(cached.body.files.length, 2, 'reused within the cache time');
  await request(app).post(`/api/projects/${slug}/git/fetch`);
  const after = await request(app).get(`/api/projects/${slug}/git/worktree`);
  assert.strictEqual(after.body.files.length, 3);
  fs.rmSync(path.join(DIRTY, 'another.txt'));
  clearWorktreeStatusCache();
});

test('git/worktree rejects a traversal slug', async () => {
  const res = await request(app).get('/api/projects/..%2F..%2Fetc/git/worktree');
  assert.strictEqual(res.status, 400);
});

test('the board carries each worktree ticket\'s changes, and marks a removed worktree', async () => {
  const project = slugForPath(REPO);
  const make = (worktree) => {
    const { card } = board.createCard({ project, notes: 'wt ' + worktree });
    board.mutateCard(card.id, c => { c.worktree = worktree; c.baseBranch = 'main'; });
    return card.id;
  };
  const dirty = make('cm-0000dir1');
  const clean = make('cm-0000cle1');
  const gone = make('cm-0000gone');
  const res = await request(app).get('/api/task-board');
  const st = res.body.worktreeStatus;
  assert.strictEqual(st[dirty].files.length, 2);
  assert.strictEqual(st[dirty].unmergedCount, 2);
  assert.strictEqual(st[clean].unmergedCount, 0);
  assert.deepStrictEqual(st[gone], { missing: true });
});

// --- Rendering ---

const escapeHtml = t => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const context = vm.createContext({ escapeHtml, escapeAttr: escapeHtml });
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'worktree-changes.js'), 'utf-8')
  + '\nglobalThis._html = worktreeChangesHtml; globalThis._has = worktreeHasChanges;', context);
const html = context._html;
const has = context._has;

const PENDING = { base: 'main', files: [{ path: 'a.txt', label: 'modified' }], unmerged: [{ sha: 'abc1234', subject: 'add b' }], unmergedCount: 1 };

test('pending worktree changes show both counts with the files and commits in the tooltip', () => {
  const out = html(PENDING);
  assert.match(out, /wt-changes--pending/);
  assert.match(out, /1 uncommitted · 1 unmerged into main/);
  assert.match(out, /title="Uncommitted:\n  modified: a\.txt\nNot merged into main:\n  abc1234 add b"/);
  assert.ok(has(PENDING));
});

test('a worktree with nothing new reads as all merged', () => {
  const st = { base: 'main', files: [], unmerged: [], unmergedCount: 0 };
  assert.match(html(st), /wt-changes--clean" title="Everything in this worktree is in main">&#10003; all merged into main</);
  assert.ok(!has(st));
});

test('without a known base only uncommitted files show, and a clean one shows nothing', () => {
  assert.match(html({ base: null, files: [{ path: 'a.txt', label: 'new' }], unmerged: null, unmergedCount: null }), />&#9679; 1 uncommitted</);
  assert.strictEqual(html({ base: null, files: [], unmerged: null, unmergedCount: null }), '');
});

test('a removed worktree says so, and no status shows nothing', () => {
  assert.match(html({ missing: true }), /worktree removed/);
  assert.ok(!has({ missing: true }));
  assert.strictEqual(html(undefined), '');
});

test('with a slug the counts open the worktree\'s git panel', () => {
  const out = html(PENDING, { slug: 'C--p--claude-worktrees-cm-1' });
  assert.match(out, /role="button" data-slug="C--p--claude-worktrees-cm-1"/);
  assert.match(out, /git-window\.html\?slug=/);
  assert.match(out, /Click to open its git panel/);
});
