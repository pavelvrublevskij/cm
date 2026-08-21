const { test, before } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const request = require('supertest');
const { app, HOME } = require('./helpers/app');
const { git, gitRaw, gitOk, gitInstalled, headInfo, upstreamStatus, unpushedCommits, incomingCommits, parseStatus, GIT_ENV, GIT_TIMEOUT_MS } = require('../lib/git');

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

test('git/info expands an untracked directory into its individual files', async () => {
  const dir = path.join(PLAIN, 'untracked-dir');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'one.txt'), 'one\n');
  fs.writeFileSync(path.join(dir, 'two.txt'), 'two\n');

  const res = await request(app).get(`/api/projects/${slugForPath(PLAIN)}/git/info`);
  assert.strictEqual(res.status, 200);
  const paths = res.body.files.map(f => f.path);
  assert.ok(paths.includes('untracked-dir/one.txt'), 'first file in the untracked dir must be listed');
  assert.ok(paths.includes('untracked-dir/two.txt'), 'second file in the untracked dir must be listed');
  assert.ok(!paths.includes('untracked-dir/'), 'the directory itself must not collapse the files into one entry');

  fs.rmSync(dir, { recursive: true, force: true });
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

// ── incoming commits ─────────────────────────────────────────────────────────

test('incomingCommits lists what a pull would bring in, newest first', async () => {
  const commits = await incomingCommits(WORK, `origin/${currentBranch(WORK)}`);
  assert.strictEqual(commits.length, 1, 'WORK is one commit behind');
  assert.strictEqual(commits[0].subject, 'remote-side commit');
  assert.match(commits[0].sha, /^[0-9a-f]{7,}$/);
});

test('incomingCommits is empty without an upstream', async () => {
  assert.deepStrictEqual(await incomingCommits(PLAIN, null), []);
});

test('git/info carries the incoming commits when the branch is behind, without moving HEAD', async () => {
  const res = await request(app).get(`/api/projects/${slugForPath(WORK)}/git/info`);
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.behind, 1);
  assert.strictEqual(res.body.incoming.length, 1);
  assert.strictEqual(res.body.incoming[0].subject, 'remote-side commit');
  assert.strictEqual(res.body.branch, currentBranch(WORK), 'reading incoming commits must not check anything out');
});

test('git/info returns no incoming commits for a branch that is level', async () => {
  const res = await request(app).get(`/api/projects/${slugForPath(PLAIN)}/git/info`);
  assert.deepStrictEqual(res.body.incoming, []);
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

test('a remote operation on a directory with no repository is refused, not attempted', async () => {
  const res = await request(app).post(`/api/projects/${slugForPath(NOGIT)}/git/fetch`);
  assert.strictEqual(res.status, 400);
  assert.strictEqual(res.body.error, 'Git is not available for this project');
});

// ── file diff ────────────────────────────────────────────────────────────────
// HEAD versus the working tree: exactly what committing the file would record.

const DIFFPROJ = path.join(HOME, 'git-diff-proj');

function diffOf(slug, filePath) {
  return request(app).get(`/api/projects/${slug}/git/diff`).query({ path: filePath });
}

before(() => {
  fs.rmSync(DIFFPROJ, { recursive: true, force: true });
  fs.mkdirSync(path.join(DIFFPROJ, 'lib'), { recursive: true });
  run(['init', '-q'], DIFFPROJ);
  identity(DIFFPROJ);
  fs.writeFileSync(path.join(DIFFPROJ, 'lib', 'a.txt'), 'one\ntwo\nthree\n');
  fs.writeFileSync(path.join(DIFFPROJ, 'gone.txt'), 'delete me\n');
  fs.writeFileSync(path.join(DIFFPROJ, 'same.txt'), 'unchanged\n');
  fs.writeFileSync(path.join(DIFFPROJ, 'binary.bin'), Buffer.from([0x41, 0x00, 0x42, 0x00]));
  run(['add', '-A'], DIFFPROJ);
  run(['commit', '-q', '-m', 'baseline'], DIFFPROJ);

  fs.writeFileSync(path.join(DIFFPROJ, 'lib', 'a.txt'), 'one\nTWO\nthree\n');
  fs.writeFileSync(path.join(DIFFPROJ, 'fresh.txt'), 'brand new\nsecond line\n');
  fs.rmSync(path.join(DIFFPROJ, 'gone.txt'));
});

test('diff of a modified file reports the changed lines only', async () => {
  const res = await diffOf(slugForPath(DIFFPROJ), 'lib/a.txt');

  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.path, 'lib/a.txt');
  assert.deepStrictEqual(res.body.stats, { added: 1, removed: 1 });
  const kinds = res.body.hunks[0].lines.map(l => l.type + l.content);
  assert.ok(kinds.includes('-two'), 'the old line is shown as removed');
  assert.ok(kinds.includes('+TWO'), 'and the new one as added');
});

test('an unchanged file reports no hunks, not a phantom last line', async () => {
  const res = await diffOf(slugForPath(DIFFPROJ), 'same.txt');

  assert.strictEqual(res.status, 200);
  assert.deepStrictEqual(res.body.hunks, [], 'trimming HEAD would have invented a change here');
  assert.deepStrictEqual(res.body.stats, { added: 0, removed: 0 });
});

test('an untracked file reads as all added', async () => {
  const res = await diffOf(slugForPath(DIFFPROJ), 'fresh.txt');

  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.stats.added, 2);
  assert.strictEqual(res.body.stats.removed, 0);
});

test('a deleted file reads as all removed', async () => {
  const res = await diffOf(slugForPath(DIFFPROJ), 'gone.txt');

  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.stats.removed, 1);
  assert.strictEqual(res.body.stats.added, 0);
});

test('a binary file is flagged rather than diffed', async () => {
  const res = await diffOf(slugForPath(DIFFPROJ), 'binary.bin');

  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.binary, true);
  assert.deepStrictEqual(res.body.hunks, []);
});

test('diff requires a path', async () => {
  const res = await request(app).get(`/api/projects/${slugForPath(DIFFPROJ)}/git/diff`);
  assert.strictEqual(res.status, 400);
  assert.strictEqual(res.body.error, 'Invalid file path');
});

test('diff refuses a path that escapes the project', async () => {
  const res = await diffOf(slugForPath(DIFFPROJ), '../../../etc/passwd');
  assert.strictEqual(res.status, 400);
  assert.ok(res.body.error);
});

test('diff refuses a project that is not a repository', async () => {
  const res = await diffOf(slugForPath(NOGIT), 'readme.txt');
  assert.strictEqual(res.status, 400);
  assert.strictEqual(res.body.error, 'Git is not available for this project');
});

test('gitRaw keeps file bytes while git trims values', async () => {
  const raw = await gitRaw(['show', 'HEAD:same.txt'], DIFFPROJ);
  const trimmed = await git(['show', 'HEAD:same.txt'], DIFFPROJ);

  assert.strictEqual(raw, 'unchanged\n');
  assert.strictEqual(trimmed, 'unchanged', 'which is why the diff route uses the raw form');
});

// ── history ──────────────────────────────────────────────────────────────────
// A sha is the one piece of user input that reaches git as a revision, so it is validated hard:
// anything that is not a hex sha is refused rather than handed to git as an argument.

const HISTPROJ = path.join(HOME, 'git-hist-proj');

before(() => {
  fs.rmSync(HISTPROJ, { recursive: true, force: true });
  fs.mkdirSync(path.join(HISTPROJ, 'src'), { recursive: true });
  run(['init', '-q'], HISTPROJ);
  identity(HISTPROJ);
  for (let i = 1; i <= 4; i++) {
    fs.writeFileSync(path.join(HISTPROJ, 'src', 'a.txt'), `version ${i}\n`);
    run(['add', '-A'], HISTPROJ);
    run(['commit', '-q', '-m', `commit ${i}`], HISTPROJ);
  }
  run(['tag', 'v1'], HISTPROJ);
});

test('log returns commits newest first with author, age and refs', async () => {
  const res = await request(app).get(`/api/projects/${slugForPath(HISTPROJ)}/git/log`).query({ limit: 10 });

  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.commits.length, 4);
  assert.strictEqual(res.body.commits[0].subject, 'commit 4', 'newest first');
  assert.strictEqual(res.body.commits[0].author, 'test');
  assert.match(res.body.commits[0].when, /ago|second|minute/);
  assert.ok(res.body.commits[0].refs.some(r => r.includes('v1')), 'tags and branches are reported');
  assert.strictEqual(res.body.commits[0].isMerge, false);
  assert.strictEqual(res.body.done, true, 'fewer than a page means the end');
});

test('log pages with limit and offset', async () => {
  const slug = slugForPath(HISTPROJ);
  const first = await request(app).get(`/api/projects/${slug}/git/log`).query({ limit: 2, offset: 0 });
  const second = await request(app).get(`/api/projects/${slug}/git/log`).query({ limit: 2, offset: 2 });

  assert.deepStrictEqual(first.body.commits.map(c => c.subject), ['commit 4', 'commit 3']);
  assert.deepStrictEqual(second.body.commits.map(c => c.subject), ['commit 2', 'commit 1']);
  assert.strictEqual(first.body.done, false, 'a full page means there may be more');
});

test('log clamps a silly limit instead of trusting it', async () => {
  const res = await request(app).get(`/api/projects/${slugForPath(HISTPROJ)}/git/log`).query({ limit: 100000 });
  assert.strictEqual(res.status, 200);
  assert.ok(res.body.limit <= 200);
});

test('log on a repo with no commits is empty, not an error', async () => {
  const unborn = path.join(HOME, 'git-unborn-proj');
  fs.rmSync(unborn, { recursive: true, force: true });
  fs.mkdirSync(unborn, { recursive: true });
  run(['init', '-q'], unborn);

  const res = await request(app).get(`/api/projects/${slugForPath(unborn)}/git/log`);
  assert.strictEqual(res.status, 200);
  assert.deepStrictEqual(res.body.commits, []);
});

test('commit detail reports the message body and the files touched', async () => {
  const slug = slugForPath(HISTPROJ);
  const log = await request(app).get(`/api/projects/${slug}/git/log`).query({ limit: 1 });
  const sha = log.body.commits[0].sha;

  const res = await request(app).get(`/api/projects/${slug}/git/commit/${sha}`);
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.subject, 'commit 4');
  assert.strictEqual(res.body.author, 'test');
  assert.strictEqual(res.body.email, 'test@example.com');
  assert.deepStrictEqual(res.body.files, [{ status: 'M', path: 'src/a.txt' }]);
  assert.ok(res.body.sha.startsWith(sha), 'the full sha is returned');
});

test('the first commit reports its files as added', async () => {
  const slug = slugForPath(HISTPROJ);
  const log = await request(app).get(`/api/projects/${slug}/git/log`).query({ limit: 10 });
  const first = log.body.commits[log.body.commits.length - 1];

  const res = await request(app).get(`/api/projects/${slug}/git/commit/${first.sha}`);
  assert.deepStrictEqual(res.body.files, [{ status: 'A', path: 'src/a.txt' }]);
});

test('a commit sha that is not a sha is refused, not passed to git', async () => {
  const slug = slugForPath(HISTPROJ);
  for (const bad of ['HEAD', '--upload-pack=evil', 'v1', '../../etc', 'zzzz']) {
    const res = await request(app).get(`/api/projects/${slug}/git/commit/${encodeURIComponent(bad)}`);
    assert.strictEqual(res.status, 400, `${bad} must be refused`);
    assert.strictEqual(res.body.error, 'Invalid commit');
  }
});

test('diff of a file at a commit compares it against its parent', async () => {
  const slug = slugForPath(HISTPROJ);
  const log = await request(app).get(`/api/projects/${slug}/git/log`).query({ limit: 1 });
  const sha = log.body.commits[0].sha;

  const res = await request(app).get(`/api/projects/${slug}/git/diff`)
    .query({ path: 'src/a.txt', sha });

  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.sha, sha);
  const lines = res.body.hunks[0].lines.map(l => l.type + l.content);
  assert.ok(lines.includes('-version 3'), 'the parent version is the old side');
  assert.ok(lines.includes('+version 4'), 'and this commit is the new side');
});

test('diff at the first commit reads as all added, with no parent to compare', async () => {
  const slug = slugForPath(HISTPROJ);
  const log = await request(app).get(`/api/projects/${slug}/git/log`).query({ limit: 10 });
  const first = log.body.commits[log.body.commits.length - 1];

  const res = await request(app).get(`/api/projects/${slug}/git/diff`)
    .query({ path: 'src/a.txt', sha: first.sha });

  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.stats.removed, 0);
  assert.strictEqual(res.body.stats.added, 1);
});

test('diff refuses a sha-shaped argument that is not hex', async () => {
  const res = await request(app).get(`/api/projects/${slugForPath(HISTPROJ)}/git/diff`)
    .query({ path: 'src/a.txt', sha: 'HEAD~1' });
  assert.strictEqual(res.status, 400);
  assert.strictEqual(res.body.error, 'Invalid commit');
});

test('a merge commit is flagged and reports no files of its own', async () => {
  const slug = slugForPath(HISTPROJ);
  const main = currentBranch(HISTPROJ);
  run(['checkout', '-q', '-b', 'side', 'HEAD~2'], HISTPROJ);
  fs.writeFileSync(path.join(HISTPROJ, 'side.txt'), 'from the side\n');
  run(['add', '-A'], HISTPROJ);
  run(['commit', '-q', '-m', 'side commit'], HISTPROJ);
  run(['checkout', '-q', main], HISTPROJ);
  run(['merge', '-q', '--no-ff', '-m', 'merge side', 'side'], HISTPROJ);

  const log = await request(app).get(`/api/projects/${slug}/git/log`).query({ limit: 1 });
  const merge = log.body.commits[0];
  assert.strictEqual(merge.isMerge, true);
  assert.strictEqual(merge.subject, 'merge side');

  const detail = await request(app).get(`/api/projects/${slug}/git/commit/${merge.sha}`);
  assert.deepStrictEqual(detail.body.files, [], 'diff-tree reports nothing for a merge, rather than one side');
});

// ── git absent from the machine ──────────────────────────────────────────────
// The app must work on a PC with no git at all. PATH is emptied so nothing named git can be found,
// which is what execFile sees on such a machine: every route must answer the same way, and none may
// leak a raw "spawn git ENOENT" to the user.

function withoutGit(fn) {
  const saved = { PATH: process.env.PATH, Path: process.env.Path };
  process.env.PATH = '';
  process.env.Path = '';
  return Promise.resolve().then(fn).finally(() => {
    process.env.PATH = saved.PATH;
    if (saved.Path === undefined) delete process.env.Path; else process.env.Path = saved.Path;
  });
}

test('gitOk and gitInstalled are both false when git cannot be found', async () => {
  await withoutGit(async () => {
    assert.strictEqual(await gitOk(PLAIN), false, 'a real repo is still unusable without the binary');
    assert.strictEqual(await gitInstalled(), false);
  });
});

test('gitInstalled is true on a machine that has git, in any directory', async () => {
  assert.strictEqual(await gitInstalled(), true);
});

test('git/info reports git-missing rather than blaming the project', async () => {
  await withoutGit(async () => {
    const res = await request(app).get(`/api/projects/${slugForPath(PLAIN)}/git/info`);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.available, false);
    assert.strictEqual(res.body.reason, 'git-missing');
  });
});

test('git/info reports not-a-repo when git exists but the directory is not one', async () => {
  const res = await request(app).get(`/api/projects/${slugForPath(NOGIT)}/git/info`);
  assert.strictEqual(res.body.available, false);
  assert.strictEqual(res.body.reason, 'not-a-repo');
});

test('every git route refuses cleanly with no git installed', async () => {
  await withoutGit(async () => {
    const slug = slugForPath(PLAIN);
    const calls = [
      request(app).get(`/api/projects/${slug}/git/log`),
      request(app).get(`/api/projects/${slug}/git/diff`).query({ path: 'a.txt' }),
      request(app).get(`/api/projects/${slug}/git/commit/abc1234`),
      request(app).post(`/api/projects/${slug}/git/commit`).send({ message: 'x', files: ['a.txt'] }),
      request(app).post(`/api/projects/${slug}/git/push`),
      request(app).post(`/api/projects/${slug}/git/pull`),
      request(app).post(`/api/projects/${slug}/git/fetch`),
    ];

    for (const res of await Promise.all(calls)) {
      assert.strictEqual(res.status, 400, 'a refusal, not a server error');
      assert.strictEqual(res.body.error, 'Git is not available for this project');
      assert.ok(!/ENOENT|spawn/.test(res.body.error), 'no raw spawn failure reaches the user');
    }
  });
});

test('a commit is not attempted at all when git is missing', async () => {
  await withoutGit(async () => {
    const res = await request(app).post(`/api/projects/${slugForPath(PLAIN)}/git/commit`)
      .send({ message: 'should not happen', files: ['a.txt'] });
    assert.strictEqual(res.status, 400);
  });
  const log = await git(['log', '--format=%s', '-n', '1'], PLAIN);
  assert.strictEqual(log, 'baseline', 'history is untouched');
});

test('the rest of the app is unaffected by git being missing', async () => {
  await withoutGit(async () => {
    for (const url of ['/api/settings', '/api/version', '/api/mcp']) {
      const res = await request(app).get(url);
      assert.strictEqual(res.status, 200, `${url} must not depend on git`);
    }
  });
});
