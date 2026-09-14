const { test, before, after } = require('node:test');
const assert = require('node:assert');
const request = require('supertest');
const fs = require('fs');
const path = require('path');
const { app, paths } = require('./helpers/app');
const { slugForPath } = require('./helpers/slug');

const FIXTURE_ROOT = path.join(__dirname, 'tmp', `projects-fixtures-${process.pid}`);

/** Registers a slug directory under PROJECTS_DIR for a real on-disk project path. */
function seedProject(slug) {
  const projDir = path.join(paths.PROJECTS_DIR, slug);
  fs.mkdirSync(projDir, { recursive: true });
  return projDir;
}

before(() => {
  fs.mkdirSync(paths.PROJECTS_DIR, { recursive: true });
  const slug = 'test-proj-alpha';
  const projDir = path.join(paths.PROJECTS_DIR, slug);
  fs.mkdirSync(projDir, { recursive: true });
  fs.mkdirSync(path.join(projDir, 'memory'), { recursive: true });
  fs.writeFileSync(path.join(projDir, 'memory', 'a.md'), '# A');
  fs.writeFileSync(path.join(projDir, 'memory', 'b.md'), '# B');
  fs.writeFileSync(path.join(projDir, 's1.jsonl'), '');
});

test('GET /api/projects returns an array', async () => {
  const res = await request(app).get('/api/projects');
  assert.strictEqual(res.status, 200);
  assert.ok(Array.isArray(res.body));
});

test('GET /api/projects includes seeded project with expected shape', async () => {
  const res = await request(app).get('/api/projects');
  assert.strictEqual(res.status, 200);
  const found = res.body.find(p => p.slug === 'test-proj-alpha');
  assert.ok(found, 'seeded project should appear');
  assert.strictEqual(found.memoryCount, 2);
  assert.strictEqual(found.hasMemory, true);
  assert.strictEqual(found.sessionCount, 1);
  assert.strictEqual(typeof found.path, 'string');
  assert.strictEqual(typeof found.skillsCount, 'number');
  assert.strictEqual(typeof found.outputStylesCount, 'number');
  assert.strictEqual(typeof found.hasClaudeMd, 'boolean');
  assert.strictEqual(typeof found.hasAiMemory, 'boolean');
});

test('GET /api/projects includes null groupId for an ungrouped project', async () => {
  const res = await request(app).get('/api/projects');
  const found = res.body.find(p => p.slug === 'test-proj-alpha');
  assert.strictEqual(found.groupId, null);
  assert.strictEqual(found.groupLabel, null);
  assert.strictEqual(found.groupPrimary, false);
});

test('POST /api/projects/:slug/open-folder SKIPPED: spawns a shell/explorer (side-effect)', { skip: true }, () => {});

test('GET /api/projects auto-groups git worktrees of the same repo', async () => {
  const main = path.join(FIXTURE_ROOT, 'worktree-repo-main');
  const gitDir = path.join(main, '.git');
  const worktreesDir = path.join(gitDir, 'worktrees', 'feature');
  fs.mkdirSync(worktreesDir, { recursive: true });
  fs.writeFileSync(path.join(worktreesDir, 'commondir'), '../..\n');

  const linked = path.join(FIXTURE_ROOT, 'worktree-repo-feature');
  fs.mkdirSync(linked, { recursive: true });
  fs.writeFileSync(path.join(linked, '.git'), `gitdir: ${worktreesDir}\n`);

  const mainSlug = slugForPath(main);
  const linkedSlug = slugForPath(linked);
  seedProject(mainSlug);
  seedProject(linkedSlug);

  const res = await request(app).get('/api/projects');
  const mainEntry = res.body.find(p => p.slug === mainSlug);
  const linkedEntry = res.body.find(p => p.slug === linkedSlug);
  assert.ok(mainEntry && linkedEntry, 'both worktree slugs should appear');
  assert.ok(mainEntry.groupId, 'main worktree should be grouped');
  assert.strictEqual(mainEntry.groupId, linkedEntry.groupId);
  assert.strictEqual(mainEntry.groupPrimary, true);
  assert.strictEqual(linkedEntry.groupPrimary, false);
});

test('two unrelated plain directories are not grouped together', async () => {
  const a = path.join(FIXTURE_ROOT, 'lonely-a');
  const b = path.join(FIXTURE_ROOT, 'lonely-b');
  fs.mkdirSync(a, { recursive: true });
  fs.mkdirSync(b, { recursive: true });
  const slugA = slugForPath(a);
  const slugB = slugForPath(b);
  seedProject(slugA);
  seedProject(slugB);

  const res = await request(app).get('/api/projects');
  assert.strictEqual(res.body.find(p => p.slug === slugA).groupId, null);
  assert.strictEqual(res.body.find(p => p.slug === slugB).groupId, null);
});

after(() => {
  fs.rmSync(FIXTURE_ROOT, { recursive: true, force: true });
});
