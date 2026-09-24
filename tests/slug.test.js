const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { decodeSlug } = require('../lib/slug');

const TMP_BASE = path.join(__dirname, 'tmp', `slug-test-${process.pid}`);

function mkTmpRoot(name) {
  const dir = path.join(TMP_BASE, name);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

test('decodeSlug resolves underscores in directory names, not just dots', () => {
  const root = mkTmpRoot('underscore');
  const projectDir = path.join(root, 'my_project');
  fs.mkdirSync(projectDir, { recursive: true });

  const isWin = process.platform === 'win32';
  const slug = isWin
    ? `${root[0].toUpperCase()}--${root.slice(3).replace(/[\\/]/g, '-')}-my-project`
    : `${root.replace(/^\//, '').replace(/\//g, '-')}-my-project`;

  const resolved = decodeSlug(slug);
  assert.strictEqual(path.resolve(resolved), path.resolve(projectDir));
});

test('decodeSlug still resolves dots in directory names', () => {
  const root = mkTmpRoot('dot');
  const projectDir = path.join(root, 'my.project');
  fs.mkdirSync(projectDir, { recursive: true });

  const isWin = process.platform === 'win32';
  const slug = isWin
    ? `${root[0].toUpperCase()}--${root.slice(3).replace(/[\\/]/g, '-')}-my-project`
    : `${root.replace(/^\//, '').replace(/\//g, '-')}-my-project`;

  const resolved = decodeSlug(slug);
  assert.strictEqual(path.resolve(resolved), path.resolve(projectDir));
});

test('decodeSlug prefers the longest matching sibling when one directory name prefixes another', () => {
  // The default git-worktree naming convention is "<repo>-<branch>", so "main-repo" and
  // "main-repo-hotfix" commonly exist side by side. A greedy-shortest match would commit to
  // "main-repo" first and strand "hotfix" as a bogus nested path.
  const root = mkTmpRoot('prefix-collision');
  const repoDir = path.join(root, 'main-repo');
  const worktreeDir = path.join(root, 'main-repo-hotfix');
  fs.mkdirSync(repoDir, { recursive: true });
  fs.mkdirSync(worktreeDir, { recursive: true });

  const isWin = process.platform === 'win32';
  const toSlug = full => isWin
    ? `${full[0].toUpperCase()}--${full.slice(3).replace(/[\\/]/g, '-')}`
    : full.replace(/^\//, '').replace(/\//g, '-');

  assert.strictEqual(path.resolve(decodeSlug(toSlug(repoDir))), path.resolve(repoDir));
  assert.strictEqual(path.resolve(decodeSlug(toSlug(worktreeDir))), path.resolve(worktreeDir));
});

test('decodeSlug resolves a path running through a symlinked directory', () => {
  // A Dirent reports a symlink as a link, never as a directory, so a listing that filters on
  // isDirectory() alone would fail to match here — and project paths legitimately run through
  // symlinked folders (see lib/project-grouping.js).
  const root = mkTmpRoot('symlinked');
  const real = path.join(root, 'real-target');
  fs.mkdirSync(path.join(real, 'inner'), { recursive: true });
  const link = path.join(root, 'via-link');
  try {
    fs.symlinkSync(real, link, 'junction');
  } catch (_) {
    return;   // symlink creation can need elevated privileges; skip where unavailable
  }

  const isWin = process.platform === 'win32';
  const target = path.join(link, 'inner');
  const slug = isWin
    ? `${target[0].toUpperCase()}--${target.slice(3).replace(/[\\/]/g, '-')}`
    : target.replace(/^\//, '').replace(/\//g, '-');

  assert.strictEqual(path.resolve(decodeSlug(slug)), path.resolve(target));
});

after(() => {
  fs.rmSync(TMP_BASE, { recursive: true, force: true });
});
