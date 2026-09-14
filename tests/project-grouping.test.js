const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { computeGroups } = require('../lib/project-grouping');

const TMP_BASE = path.join(__dirname, 'tmp', `project-grouping-${process.pid}`);

function mkRoot(name) {
  const dir = path.join(TMP_BASE, name);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function makeWorktreePair(rootName) {
  const main = mkRoot(`${rootName}-main`);
  const gitDir = path.join(main, '.git');
  const worktreesDir = path.join(gitDir, 'worktrees', 'feature');
  fs.mkdirSync(worktreesDir, { recursive: true });
  fs.writeFileSync(path.join(worktreesDir, 'commondir'), '../..\n');
  const linked = mkRoot(`${rootName}-feature`);
  fs.writeFileSync(path.join(linked, '.git'), `gitdir: ${worktreesDir}\n`);
  return { main, linked };
}

test('computeGroups groups worktrees of the same repo and picks the main worktree as primary', () => {
  const { main, linked } = makeWorktreePair('repo');
  const result = computeGroups([
    { slug: 'main-slug', path: main },
    { slug: 'linked-slug', path: linked }
  ]);

  const mainEntry = result.get('main-slug');
  const linkedEntry = result.get('linked-slug');
  assert.ok(mainEntry && linkedEntry);
  assert.strictEqual(mainEntry.groupId, linkedEntry.groupId);
  assert.strictEqual(mainEntry.groupPrimary, true);
  assert.strictEqual(linkedEntry.groupPrimary, false);
  assert.strictEqual(mainEntry.groupLabel, path.basename(main));
});

test('computeGroups leaves a lone git project ungrouped', () => {
  const solo = mkRoot('solo-repo');
  fs.mkdirSync(path.join(solo, '.git'), { recursive: true });
  const result = computeGroups([{ slug: 'solo', path: solo }]);
  assert.strictEqual(result.has('solo'), false);
});

test('computeGroups leaves unrelated projects ungrouped', () => {
  const a = mkRoot('unrelated-a');
  const b = mkRoot('unrelated-b');
  const result = computeGroups([{ slug: 'ua', path: a }, { slug: 'ub', path: b }]);
  assert.strictEqual(result.has('ua'), false);
  assert.strictEqual(result.has('ub'), false);
});

test('computeGroups labels a group after its primary, not whichever member was visited first', () => {
  const { main, linked } = makeWorktreePair('labelled');
  // Passing the linked worktree first would previously have named the group after it.
  const result = computeGroups([{ slug: 'linked-slug', path: linked }, { slug: 'main-slug', path: main }]);
  assert.strictEqual(result.get('linked-slug').groupLabel, path.basename(main));
  assert.strictEqual(result.get('main-slug').groupLabel, path.basename(main));
});

test('computeGroups auto-groups a project with another one it symlinks to, preferring the referrer as primary', () => {
  const hub = mkRoot('symlink-hub');
  fs.mkdirSync(path.join(hub, '.git'), { recursive: true });
  const target = mkRoot('symlink-target');
  fs.mkdirSync(path.join(target, '.git'), { recursive: true });
  const linkDir = path.join(hub, 'linked-repos');
  fs.mkdirSync(linkDir, { recursive: true });
  fs.symlinkSync(target, path.join(linkDir, 'ref'), 'junction');

  const result = computeGroups([{ slug: 'hub', path: hub }, { slug: 'target', path: target }]);
  const hubEntry = result.get('hub');
  const targetEntry = result.get('target');
  assert.ok(hubEntry && targetEntry);
  assert.strictEqual(hubEntry.groupId, targetEntry.groupId);
  assert.strictEqual(hubEntry.groupPrimary, true, 'the project containing the symlink is the hub');
  assert.strictEqual(targetEntry.groupPrimary, false);
});

test('computeGroups does not walk through a symlink to find links one more hop away', () => {
  // hub -> alias -> target -> inner -> unrelated. "target" is deliberately NOT itself a
  // registered project, so the only way to reach "unrelated" from "hub" is by recursing through
  // the resolved "alias" symlink into target's own tree — which the scan must not do, both to
  // avoid cycles and to avoid silently pulling in an otherwise-unrelated project two hops away.
  const hub = mkRoot('scan-hub');
  const target = mkRoot('scan-target');
  const unrelated = mkRoot('scan-unrelated');
  fs.symlinkSync(unrelated, path.join(target, 'inner'), 'junction');
  fs.symlinkSync(target, path.join(hub, 'alias'), 'junction');

  const result = computeGroups([{ slug: 'hub', path: hub }, { slug: 'unrelated', path: unrelated }]);
  assert.strictEqual(result.has('hub'), false);
  assert.strictEqual(result.has('unrelated'), false);
});

after(() => {
  fs.rmSync(TMP_BASE, { recursive: true, force: true });
});
