const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { gitCommonDir, realProjectPath, isMainWorktree, isSymlinkPath, findSymlinks } = require('../lib/worktree-group');

const TMP_BASE = path.join(__dirname, 'tmp', `worktree-group-${process.pid}`);

function mkRoot(name) {
  const dir = path.join(TMP_BASE, name);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

test('gitCommonDir returns null for a non-git directory', () => {
  const dir = mkRoot('plain');
  assert.strictEqual(gitCommonDir(dir), null);
});

test('gitCommonDir resolves the main worktree .git directory', () => {
  const dir = mkRoot('main-repo');
  const gitDir = path.join(dir, '.git');
  fs.mkdirSync(gitDir, { recursive: true });
  assert.strictEqual(gitCommonDir(dir), fs.realpathSync(gitDir));
  assert.strictEqual(isMainWorktree(dir), true);
});

test('gitCommonDir resolves a linked worktree to the same common dir as its main worktree', () => {
  const main = mkRoot('worktree-main');
  const gitDir = path.join(main, '.git');
  const worktreesDir = path.join(gitDir, 'worktrees', 'feature');
  fs.mkdirSync(worktreesDir, { recursive: true });
  fs.writeFileSync(path.join(worktreesDir, 'commondir'), '../..\n');

  const linked = mkRoot('worktree-feature');
  fs.writeFileSync(path.join(linked, '.git'), `gitdir: ${worktreesDir}\n`);

  assert.strictEqual(gitCommonDir(linked), fs.realpathSync(gitDir));
  assert.strictEqual(gitCommonDir(linked), gitCommonDir(main));
  assert.strictEqual(isMainWorktree(linked), false);
});

test('gitCommonDir returns null when the .git file is malformed', () => {
  const dir = mkRoot('malformed');
  fs.writeFileSync(path.join(dir, '.git'), 'not a gitdir line\n');
  assert.strictEqual(gitCommonDir(dir), null);
});

test('realProjectPath resolves a symlink to its real target', () => {
  const target = mkRoot('link-target');
  const linkPath = path.join(TMP_BASE, 'link-alias');
  try {
    fs.symlinkSync(target, linkPath, 'junction');
  } catch (_) {
    return; // symlink creation can require elevated privileges; skip where unavailable
  }
  assert.strictEqual(realProjectPath(linkPath), fs.realpathSync(target));
});

test('realProjectPath falls back to the given path when it does not exist', () => {
  const missing = path.join(TMP_BASE, 'does-not-exist');
  assert.strictEqual(realProjectPath(missing), missing);
});

/** Create a directory symlink, returning false where the OS won't allow one. */
function trySymlink(target, linkPath) {
  try {
    fs.symlinkSync(target, linkPath, 'junction');
    return true;
  } catch (_) {
    return false;   // symlink creation can need elevated privileges
  }
}

test('isSymlinkPath distinguishes a symlink from the real directory it points at', () => {
  const real = mkRoot('symlink-check-real');
  const link = path.join(TMP_BASE, 'symlink-check-link');
  if (!trySymlink(real, link)) return;

  assert.strictEqual(isSymlinkPath(link), true);
  assert.strictEqual(isSymlinkPath(real), false, 'a real directory is never reported as a symlink');
});

test('findSymlinks reports each link with both where it sits and what it resolves to', () => {
  const root = mkRoot('scan-basic');
  const target = mkRoot('scan-basic-target');
  const linkDir = path.join(root, 'linked-repos');
  fs.mkdirSync(linkDir, { recursive: true });
  const link = path.join(linkDir, 'service');
  if (!trySymlink(target, link)) return;

  const found = findSymlinks(root);
  assert.strictEqual(found.length, 1);
  assert.strictEqual(path.resolve(found[0].linkPath), path.resolve(link));
  assert.strictEqual(found[0].target, fs.realpathSync(target));
});

test('findSymlinks skips .git and node_modules, which hold links that are not projects', () => {
  const root = mkRoot('scan-skips');
  const target = mkRoot('scan-skips-target');
  for (const noisy of ['.git', 'node_modules']) {
    fs.mkdirSync(path.join(root, noisy), { recursive: true });
    if (!trySymlink(target, path.join(root, noisy, 'link'))) return;
  }

  assert.deepStrictEqual(findSymlinks(root), []);
});

test('findSymlinks ignores a broken symlink rather than throwing', () => {
  const root = mkRoot('scan-broken');
  if (!trySymlink(path.join(TMP_BASE, 'does-not-exist'), path.join(root, 'dangling'))) return;

  assert.deepStrictEqual(findSymlinks(root), []);
});

after(() => {
  fs.rmSync(TMP_BASE, { recursive: true, force: true });
});
