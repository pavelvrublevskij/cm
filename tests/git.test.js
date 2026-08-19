const { test, before } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const request = require('supertest');
const { app, HOME } = require('./helpers/app');
const { git, gitOk, headInfo, upstreamStatus, unpushedCommits, parseStatus, GIT_ENV, GIT_TIMEOUT_MS } = require('../lib/git');

function slugForPath(p) {
  const win = p.match(/^([A-Za-z]):[\\\/](.*)/);
  if (win) return `${win[1].toUpperCase()}--${win[2].replace(/[\\\/\.]/g, '-')}`;
  return p.replace(/^\//, '').replace(/[\/\.]/g, '-');
}

function run(args, cwd) {
  execFileSync('git', args, { cwd, stdio: 'pipe' });
}

function identity(dir) {
  run(['config', 'user.email', 'test@example.com'], dir);
  run(['config', 'user.name', 'test'], dir);
  run(['config', 'commit.gpgsign', 'false'], dir);
}

function commit(dir, file, content, message) {
  fs.writeFileSync(path.join(dir, file), content);
  run(['add', '--', file], dir);
  run(['commit', '-q', '-m', message], dir);
}

function currentBranch(dir) {
  return execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: dir }).toString().trim();
}

// A bare origin, a clone that ends up 1 ahead / 1 behind it, a second clone used to move origin
// forward, a repo with no remote at all, a detached-HEAD repo, and a plain directory.
const REMOTE = path.join(HOME, 'git-origin.git');
const WORK = path.join(HOME, 'git-work-proj');
const OTHER = path.join(HOME, 'git-other-clone');
const PLAIN = path.join(HOME, 'git-plain-proj');
const DETACHED = path.join(HOME, 'git-detached-proj');
const NOGIT = path.join(HOME, 'git-absent-proj');

before(() => {
  for (const dir of [REMOTE, WORK, OTHER, PLAIN, DETACHED, NOGIT]) {
    fs.rmSync(dir, { recursive: true, force: true });
  }

  // The test home sits inside this repo's own work tree, so an empty directory would still
  // resolve upwards to a real .git. A .git file pointing nowhere makes git refuse the directory,
  // which is what a project without a usable repository looks like.
  fs.mkdirSync(NOGIT, { recursive: true });
  fs.writeFileSync(path.join(NOGIT, 'readme.txt'), 'not a repo\n');
  fs.writeFileSync(path.join(NOGIT, '.git'), 'gitdir: /no/such/gitdir\n');

  fs.mkdirSync(REMOTE, { recursive: true });
  run(['init', '--bare', '-q'], REMOTE);

  fs.mkdirSync(PLAIN, { recursive: true });
  run(['init', '-q'], PLAIN);
  identity(PLAIN);
  commit(PLAIN, 'a.txt', 'one\n', 'baseline');

  run(['clone', '-q', REMOTE, WORK], HOME);
  identity(WORK);
  commit(WORK, 'a.txt', 'one\n', 'baseline');
  const branch = currentBranch(WORK);
  run(['push', '-q', '-u', 'origin', branch], WORK);

  run(['clone', '-q', REMOTE, OTHER], HOME);
  identity(OTHER);
  commit(OTHER, 'b.txt', 'from other clone\n', 'remote-side commit');
  run(['push', '-q'], OTHER);

  run(['fetch', '-q'], WORK);
  commit(WORK, 'c.txt', 'local only\n', 'local-side commit');
  fs.writeFileSync(path.join(WORK, 'dirty.txt'), 'uncommitted\n');

  fs.mkdirSync(DETACHED, { recursive: true });
  run(['init', '-q'], DETACHED);
  identity(DETACHED);
  commit(DETACHED, 'a.txt', 'one\n', 'first');
  commit(DETACHED, 'a.txt', 'two\n', 'second');
  run(['checkout', '-q', '--detach', 'HEAD'], DETACHED);
});

// ── parseStatus ──────────────────────────────────────────────────────────────

test('parseStatus labels each porcelain status code', () => {
  const files = parseStatus([
    ' M src/a.js',
    '?? untracked.js',
    'D  removed.js',
    ' D also-removed.js',
    'A  added.js',
    'MM both-modified.js'
  ].join('\n'));

  assert.deepStrictEqual(files.map(f => [f.path, f.label]), [
    ['src/a.js', 'modified'],
    ['untracked.js', 'untracked'],
    ['removed.js', 'deleted'],
    ['also-removed.js', 'deleted'],
    ['added.js', 'new'],
    ['both-modified.js', 'modified']
  ]);
});

test('parseStatus unquotes paths with spaces and escapes', () => {
  const files = parseStatus('?? "dir/has space.js"\n M "with\\"quote.js"\n M "tab\\there.js"');
  assert.deepStrictEqual(files.map(f => f.path), ['dir/has space.js', 'with"quote.js', 'tab\there.js']);
});

test('parseStatus keeps the destination path of a rename', () => {
  const files = parseStatus('R  old/name.js -> new/name.js');
  assert.strictEqual(files[0].path, 'new/name.js');
});

test('parseStatus drops blank and truncated lines', () => {
  assert.deepStrictEqual(parseStatus(''), []);
  assert.deepStrictEqual(parseStatus('\n\n M x\n M'), [{ path: 'x', xy: ' M', label: 'modified' }]);
});

test('parseStatus handles CRLF-separated output', () => {
  const files = parseStatus(' M a.js\r\n?? b.js\r\n');
  assert.deepStrictEqual(files.map(f => f.path), ['a.js', 'b.js']);
});

// ── non-interactive hardening ────────────────────────────────────────────────

test('GIT_ENV disables every interactive prompt path', () => {
  assert.strictEqual(GIT_ENV.GIT_TERMINAL_PROMPT, '0');
  assert.strictEqual(GIT_ENV.GCM_INTERACTIVE, 'never');
  assert.ok(GIT_ENV.GIT_ASKPASS, 'GIT_ASKPASS must be set so git never opens a credential dialog');
  assert.ok(GIT_ENV.SSH_ASKPASS, 'SSH_ASKPASS must be set for ssh remotes');
  assert.match(GIT_ENV.GIT_SSH_COMMAND, /BatchMode=yes/);
  assert.ok(GIT_ENV.GIT_EDITOR, 'GIT_EDITOR must be set so git never waits on an editor');
});

test('GIT_TIMEOUT_MS is a bounded timeout', () => {
  assert.ok(GIT_TIMEOUT_MS > 1000 && GIT_TIMEOUT_MS <= 60000, `unexpected timeout ${GIT_TIMEOUT_MS}`);
});

test('git() rejects with git stderr, not a bare exit code', async () => {
  await assert.rejects(
    () => git(['rev-parse', '--abbrev-ref', 'no/such/ref'], PLAIN),
    err => err instanceof Error && err.message.length > 0 && !/^Command failed$/.test(err.message)
  );
});

test('git() runs in the given cwd', async () => {
  const out = await git(['rev-parse', '--is-inside-work-tree'], PLAIN);
  assert.strictEqual(out, 'true');
});

// ── gitOk ────────────────────────────────────────────────────────────────────

test('gitOk is true inside a work tree and false without a usable repository', async () => {
  assert.strictEqual(await gitOk(PLAIN), true);
  assert.strictEqual(await gitOk(NOGIT), false);
});

test('gitOk is false for a missing or empty path', async () => {
  assert.strictEqual(await gitOk(''), false);
  assert.strictEqual(await gitOk(null), false);
  assert.strictEqual(await gitOk(path.join(HOME, 'does-not-exist-at-all')), false);
});

// ── headInfo ─────────────────────────────────────────────────────────────────

test('headInfo returns the branch name when HEAD is attached', async () => {
  const info = await headInfo(PLAIN);
  assert.strictEqual(info.detached, false);
  assert.strictEqual(info.branch, currentBranch(PLAIN));
});

test('headInfo reports a detached HEAD as a short SHA', async () => {
  const info = await headInfo(DETACHED);
  assert.strictEqual(info.detached, true);
  assert.match(info.branch, /^[0-9a-f]{7,40}$/);
});

// ── upstreamStatus ───────────────────────────────────────────────────────────

test('upstreamStatus is all null when the branch has no upstream', async () => {
  assert.deepStrictEqual(await upstreamStatus(PLAIN), { upstream: null, ahead: null, behind: null });
});

test('upstreamStatus counts commits ahead and behind the upstream', async () => {
  const status = await upstreamStatus(WORK);
  assert.match(status.upstream, /^origin\//);
  assert.strictEqual(status.ahead, 1);
  assert.strictEqual(status.behind, 1);
});

// ── GET /git/info ────────────────────────────────────────────────────────────

test('git/info reports upstream tracking, dirty files and remote presence', async () => {
  const res = await request(app).get(`/api/projects/${slugForPath(WORK)}/git/info`);
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.available, true);
  assert.strictEqual(res.body.branch, currentBranch(WORK));
  assert.strictEqual(res.body.detached, false);
  assert.match(res.body.upstream, /^origin\//);
  assert.strictEqual(res.body.ahead, 1);
  assert.strictEqual(res.body.behind, 1);
  assert.strictEqual(res.body.hasRemote, true);
  const dirty = res.body.files.find(f => f.path === 'dirty.txt');
  assert.ok(dirty, 'an untracked file must be listed');
  assert.strictEqual(dirty.label, 'untracked');
});

test('git/info on a repo without a remote returns null tracking info', async () => {
  const res = await request(app).get(`/api/projects/${slugForPath(PLAIN)}/git/info`);
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.available, true);
  assert.strictEqual(res.body.hasRemote, false);
  assert.strictEqual(res.body.upstream, null);
  assert.strictEqual(res.body.ahead, null);
  assert.strictEqual(res.body.behind, null);
});

test('git/info flags a detached HEAD', async () => {
  const res = await request(app).get(`/api/projects/${slugForPath(DETACHED)}/git/info`);
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.detached, true);
  assert.match(res.body.branch, /^[0-9a-f]{7,40}$/);
});

test('git/info reports unavailable when the project has no usable repository', async () => {
  const res = await request(app).get(`/api/projects/${slugForPath(NOGIT)}/git/info`);
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.available, false);
});

test('git/info rejects a traversal slug', async () => {
  const res = await request(app).get('/api/projects/bad..slug/git/info');
  assert.strictEqual(res.status, 400);
  assert.strictEqual(res.body.error, 'Invalid slug');
});

// ── unpushed commits ─────────────────────────────────────────────────────────

test('unpushedCommits lists what a push would send, newest first', async () => {
  const commits = await unpushedCommits(WORK, `origin/${currentBranch(WORK)}`);
  assert.strictEqual(commits.length, 1, 'WORK is one commit ahead');
  assert.strictEqual(commits[0].subject, 'local-side commit');
  assert.match(commits[0].sha, /^[0-9a-f]{7,}$/);
});

test('unpushedCommits is empty without an upstream', async () => {
  assert.deepStrictEqual(await unpushedCommits(PLAIN, null), []);
});

test('unpushedCommits keeps a subject containing the record separator safe', async () => {
  const dir = path.join(HOME, 'git-sep-proj');
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  run(['init', '-q'], dir);
  identity(dir);
  commit(dir, 'a.txt', 'x\n', 'first');
  const base = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir }).toString().trim();
  commit(dir, 'a.txt', 'y\n', 'subject with a dash - and: punctuation');

  const commits = await unpushedCommits(dir, base);
  assert.strictEqual(commits.length, 1);
  assert.strictEqual(commits[0].subject, 'subject with a dash - and: punctuation');
});

test('unpushedCommits caps the list at the requested limit', async () => {
  const dir = path.join(HOME, 'git-many-proj');
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  run(['init', '-q'], dir);
  identity(dir);
  commit(dir, 'a.txt', '0\n', 'base');
  const base = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir }).toString().trim();
  for (let i = 1; i <= 5; i++) commit(dir, 'a.txt', `${i}\n`, `commit ${i}`);

  const commits = await unpushedCommits(dir, base, 3);
  assert.strictEqual(commits.length, 3);
  assert.strictEqual(commits[0].subject, 'commit 5', 'newest first');
});

test('git/info carries the unpushed commits when the branch is ahead', async () => {
  const res = await request(app).get(`/api/projects/${slugForPath(WORK)}/git/info`);
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.ahead, 1);
  assert.strictEqual(res.body.unpushed.length, 1);
  assert.strictEqual(res.body.unpushed[0].subject, 'local-side commit');
});

test('git/info returns no unpushed commits for a branch that is level', async () => {
  const res = await request(app).get(`/api/projects/${slugForPath(PLAIN)}/git/info`);
  assert.deepStrictEqual(res.body.unpushed, []);
});

// ── remote operations ────────────────────────────────────────────────────────
// Pull is fast-forward only and fetch prunes: the safe variants. A pull that would need a merge is
// refused and left to the shell rather than quietly creating a merge commit.

test('fetch --prune drops a remote-tracking ref whose branch is gone', async () => {
  const branch = currentBranch(WORK);
  run(['push', '-q', 'origin', `${branch}:doomed`], WORK);
  run(['fetch', '-q'], WORK);
  assert.ok(
    execFileSync('git', ['branch', '-r'], { cwd: WORK }).toString().includes('origin/doomed'),
    'the tracking ref exists to begin with'
  );

  run(['push', '-q', 'origin', '--delete', 'doomed'], WORK);
  const res = await request(app).post(`/api/projects/${slugForPath(WORK)}/git/fetch`);

  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.ok, true);
  assert.ok(
    !execFileSync('git', ['branch', '-r'], { cwd: WORK }).toString().includes('origin/doomed'),
    'and is pruned afterwards'
  );
});

test('pull fast-forwards a branch that is only behind', async () => {
  // A clone that is purely behind: origin moved on, this one has no local commits.
  const behind = path.join(HOME, 'git-behind-proj');
  fs.rmSync(behind, { recursive: true, force: true });
  run(['clone', '-q', REMOTE, behind], HOME);
  identity(behind);
  commit(OTHER, 'pull-me.txt', 'from the remote\n', 'commit to be pulled');
  run(['push', '-q'], OTHER);

  const res = await request(app).post(`/api/projects/${slugForPath(behind)}/git/pull`);

  assert.strictEqual(res.status, 200);
  assert.strictEqual(fs.existsSync(path.join(behind, 'pull-me.txt')), true, 'the commit arrived');
});

test('pull refuses to merge diverged history instead of creating a merge commit', async () => {
  // WORK is one ahead and one behind, so a fast-forward is impossible.
  const before = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: WORK }).toString().trim();
  const res = await request(app).post(`/api/projects/${slugForPath(WORK)}/git/pull`);

  assert.strictEqual(res.status, 500, 'the failure is reported, not swallowed');
  assert.ok(res.body.error && res.body.error.length > 0);
  const after = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: WORK }).toString().trim();
  assert.strictEqual(after, before, 'HEAD is untouched — no merge was made');
});

test('pull and fetch reject a traversal slug', async () => {
  for (const op of ['pull', 'fetch']) {
    const res = await request(app).post(`/api/projects/bad..slug/git/${op}`);
    assert.strictEqual(res.status, 400, `${op} must validate the slug`);
    assert.strictEqual(res.body.error, 'Invalid slug');
  }
});

test('a remote operation on a directory with no repository fails rather than hanging', async () => {
  const res = await request(app).post(`/api/projects/${slugForPath(NOGIT)}/git/fetch`);
  assert.strictEqual(res.status, 500);
  assert.ok(res.body.error);
});
