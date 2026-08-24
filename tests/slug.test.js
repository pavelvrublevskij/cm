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

after(() => {
  fs.rmSync(TMP_BASE, { recursive: true, force: true });
});
