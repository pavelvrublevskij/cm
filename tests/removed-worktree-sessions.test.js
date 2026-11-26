const { test, before, after } = require('node:test');
const assert = require('node:assert');
const request = require('supertest');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { app, HOME, paths } = require('./helpers/app');
const { slugForPath } = require('./helpers/slug');

// Outside HOME: tests may run from a Claude worktree, and a second worktree marker in the slug would
// make the project look like part of that worktree.
const PROJECT = path.join(fs.realpathSync.native(os.tmpdir()), `removed-wt-project-${process.pid}`);
const LIVE_WT = path.join(PROJECT, '.claude', 'worktrees', 'cm-live');
let projectSlug, removedSlug, liveSlug, orphanSlug;

function seedSession(slug, sessionId, text) {
  fs.mkdirSync(path.join(paths.PROJECTS_DIR, slug), { recursive: true });
  const line = JSON.stringify({ type: 'user', timestamp: new Date().toISOString(), message: { content: text } });
  fs.writeFileSync(path.join(paths.PROJECTS_DIR, slug, `${sessionId}.jsonl`), line + '\n');
}

before(() => {
  fs.mkdirSync(LIVE_WT, { recursive: true });
  projectSlug = slugForPath(PROJECT);
  removedSlug = slugForPath(path.join(PROJECT, '.claude', 'worktrees', 'cm-gone'));
  liveSlug = slugForPath(LIVE_WT);
  orphanSlug = slugForPath(path.join(HOME, 'removed-wt-unlisted', '.claude', 'worktrees', 'cm-x'));
  seedSession(projectSlug, 'rw-own', 'own session');
  seedSession(removedSlug, 'rw-removed', 'flux capacitor in a removed worktree');
  seedSession(liveSlug, 'rw-live', 'live worktree session');
  seedSession(orphanSlug, 'rw-orphan', 'worktree of an unlisted project');
});

test('a removed Claude worktree is kept out of the project list; live ones and orphans stay', async () => {
  const res = await request(app).get('/api/projects');
  assert.strictEqual(res.status, 200);
  const slugs = res.body.map(p => p.slug);
  assert.ok(slugs.includes(projectSlug));
  assert.ok(!slugs.includes(removedSlug), 'removed worktree is hidden');
  assert.ok(slugs.includes(liveSlug), 'live worktree is still listed');
  assert.ok(slugs.includes(orphanSlug), 'worktree whose project is not listed stays visible');
});

test("a removed worktree's sessions are always listed with its project", async () => {
  const res = await request(app).get(`/api/projects/${projectSlug}/sessions`);
  assert.strictEqual(res.status, 200);
  const ids = res.body.map(s => s.sessionId);
  assert.ok(ids.includes('rw-own'));
  assert.ok(ids.includes('rw-removed'));
  assert.ok(!ids.includes('rw-live'), 'live worktree sessions stay behind the Subprojects filter');
  assert.strictEqual(res.body.find(s => s.sessionId === 'rw-removed').slug, removedSlug);
});

test("a removed worktree's sessions are searched with its project", async () => {
  const res = await request(app).get(`/api/projects/${projectSlug}/sessions/search`).query({ q: 'flux capacitor' });
  assert.strictEqual(res.status, 200);
  assert.deepStrictEqual(res.body.map(s => s.sessionId), ['rw-removed']);
  assert.strictEqual(res.body[0].slug, removedSlug);
});

after(() => {
  fs.rmSync(PROJECT, { recursive: true, force: true });
});
