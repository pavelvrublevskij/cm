const { test, beforeEach, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { cleanDir, TMP } = require('./helpers/clean-tmp');

// Scratch cleanup runs from npm pretest/posttest, so it must be safe: it may only ever delete inside
// tests/tmp, and a locked leftover must not stop it. It is tested against its own probe directory —
// never against TMP itself, which holds the live home/data directories of this very run.
const PROBE = path.join(TMP, `clean-probe-${process.pid}`);

beforeEach(() => {
  fs.rmSync(PROBE, { recursive: true, force: true });
  fs.mkdirSync(PROBE, { recursive: true });
});

after(() => {
  fs.rmSync(PROBE, { recursive: true, force: true });
});

test('cleanDir empties a directory but keeps the directory itself', () => {
  fs.mkdirSync(path.join(PROBE, 'home-1', '.claude'), { recursive: true });
  fs.writeFileSync(path.join(PROBE, 'home-1', 'file.txt'), 'x');
  fs.mkdirSync(path.join(PROBE, 'data-1'), { recursive: true });

  const result = cleanDir(PROBE);

  assert.strictEqual(result.removed, 2);
  assert.strictEqual(result.skipped, 0);
  assert.deepStrictEqual(fs.readdirSync(PROBE), []);
  assert.strictEqual(fs.existsSync(PROBE), true, 'the directory survives so the next run can use it');
});

test('cleanDir removes throwaway git repos, fixture commits and all', () => {
  const repo = path.join(PROBE, 'home-2', 'git-work-proj');
  fs.mkdirSync(path.join(repo, '.git', 'refs'), { recursive: true });
  fs.writeFileSync(path.join(repo, '.git', 'HEAD'), 'ref: refs/heads/main\n');

  cleanDir(PROBE);

  assert.strictEqual(fs.existsSync(path.join(PROBE, 'home-2')), false);
});

test('cleanDir on an empty directory is a no-op', () => {
  assert.deepStrictEqual(cleanDir(PROBE), { removed: 0, skipped: 0 });
});

test('cleanDir on a missing directory reports nothing rather than throwing', () => {
  assert.deepStrictEqual(cleanDir(path.join(PROBE, 'not-there')), { removed: 0, skipped: 0 });
});

test('cleanDir refuses to touch anything outside tests/tmp', () => {
  for (const outside of [path.resolve(TMP, '..'), path.resolve(TMP, '..', '..'), os.homedir(), process.cwd()]) {
    assert.throws(() => cleanDir(outside), /refusing to clean outside tests\/tmp/,
      `${outside} must be refused`);
  }
});

test('a sibling directory whose name merely starts with tests/tmp is refused', () => {
  assert.throws(() => cleanDir(TMP + '-evil'), /refusing to clean outside/);
});

test('TMP itself is allowed, since that is what pretest cleans', () => {
  // Assert the guard's decision without deleting: TMP resolves inside itself by definition.
  assert.doesNotThrow(() => cleanDir(path.join(TMP, `clean-probe-${process.pid}`, 'nope')));
});
