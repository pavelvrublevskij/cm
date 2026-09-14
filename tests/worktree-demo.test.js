const { test, before, after } = require('node:test');
const assert = require('node:assert');
const request = require('supertest');
const fs = require('fs');
const path = require('path');
const { app, HOME, paths } = require('./helpers/app');
const { buildWorktreeDemo } = require('./helpers/worktree-demo');
const { slugForPath } = require('./helpers/slug');

// End-to-end coverage for the three ways a related project directory shows up around one main
// workspace repo (see tests/helpers/worktree-demo.js), exercised through the real GET /api/projects
// route — including lib/slug.js's decodeSlug, which a computeGroups-only unit test can't reach. This
// is also the scenario that exposed the decodeSlug greedy-shortest-match bug: "workspace-demo" and
// "workspace-demo-hotfix" are siblings where one name hyphen-prefixes the other, the default
// git-worktree naming convention.
//
// Because grouping is transitive (a union of any two auto-detected edges merges the whole set),
// and workspace-demo both worktrees-with and symlinks-into the other two pairs, all five demo
// projects end up in ONE group — workspace-demo is the natural hub, so it's the primary.

const DEMO_PARENT = path.join(HOME, 'worktree-demo');
let demo;

function seed(p) {
  const slug = slugForPath(p);
  fs.mkdirSync(path.join(paths.PROJECTS_DIR, slug), { recursive: true });
  return slug;
}

/** Write a minimal session transcript into a project so search has something to find. */
function seedSession(slug, sessionId, text) {
  const line = JSON.stringify({
    type: 'user',
    timestamp: new Date().toISOString(),
    message: { content: text }
  });
  fs.writeFileSync(path.join(paths.PROJECTS_DIR, slug, `${sessionId}.jsonl`), line + '\n');
}

const slugs = {};

before(() => {
  demo = buildWorktreeDemo(DEMO_PARENT);
  for (const [key, p] of Object.entries(demo)) slugs[key] = seed(p);
});

test('all five related projects auto-group into one component, workspace-demo as primary', async () => {
  const res = await request(app).get('/api/projects');
  assert.strictEqual(res.status, 200);
  const bySlug = Object.fromEntries(Object.entries(slugs).map(([key, slug]) => [key, res.body.find(p => p.slug === slug)]));
  for (const [key, entry] of Object.entries(bySlug)) assert.ok(entry, `${key} should be registered`);

  const groupId = bySlug.workspaceDemo.groupId;
  assert.ok(groupId, 'workspace-demo should be auto-grouped');
  assert.strictEqual(bySlug.workspaceDemoHotfix.groupId, groupId, 'git worktree pair merges in');
  assert.strictEqual(bySlug.noGitSubproject.groupId, groupId, 'nested non-git alias merges in');
  assert.strictEqual(bySlug.noGitSubprojectSymlink.groupId, groupId, 'nested non-git alias merges in');
  assert.strictEqual(bySlug.standaloneService.groupId, groupId, 'symlinked-in independent repo merges in');

  assert.strictEqual(bySlug.workspaceDemo.groupLabel, 'workspace-demo');
  assert.strictEqual(bySlug.workspaceDemo.groupPrimary, true);
  assert.strictEqual(bySlug.workspaceDemoHotfix.groupPrimary, false);
  assert.strictEqual(bySlug.standaloneService.groupPrimary, false);
});

test('members nest by real folder hierarchy, with unregistered folders folded into the relative path', async () => {
  const res = await request(app).get('/api/projects');
  const bySlug = Object.fromEntries(Object.entries(slugs).map(([key, slug]) => [key, res.body.find(p => p.slug === slug)]));

  // The workspace is the root of the tree; its git worktree is a sibling on disk, so it stays a
  // root too rather than being nested under it.
  assert.strictEqual(bySlug.workspaceDemo.groupParentSlug, null);
  assert.strictEqual(bySlug.workspaceDemoHotfix.groupParentSlug, null);

  // Both genuinely live inside the workspace directory.
  assert.strictEqual(bySlug.noGitSubproject.groupParentSlug, slugs.workspaceDemo);
  assert.strictEqual(bySlug.noGitSubproject.groupRelPath, 'no-git-subproject');
  assert.strictEqual(bySlug.noGitSubprojectSymlink.groupParentSlug, slugs.workspaceDemo);
  assert.strictEqual(bySlug.noGitSubprojectSymlink.groupRelPath, 'no-git-subproject-symlink');

  // Lives outside the workspace on disk, but is symlinked in at linked-repos/independent-service —
  // it nests where the user sees it, and "linked-repos" (not a project itself) is part of the path
  // rather than a node of its own.
  assert.strictEqual(bySlug.standaloneService.groupParentSlug, slugs.workspaceDemo);
  assert.strictEqual(bySlug.standaloneService.groupRelPath, 'linked-repos/independent-service');
});

test('unrelated project stays out of the group', async () => {
  const unrelated = path.join(HOME, 'worktree-demo-unrelated');
  fs.rmSync(unrelated, { recursive: true, force: true });
  fs.mkdirSync(unrelated, { recursive: true });
  const unrelatedSlug = seed(unrelated);

  const res = await request(app).get('/api/projects');
  const entry = res.body.find(p => p.slug === unrelatedSlug);
  assert.strictEqual(entry.groupId, null);

  fs.rmSync(unrelated, { recursive: true, force: true });
});

test('scope=group lists sessions from every project in the group', async () => {
  seedSession(slugs.workspaceDemo, 'list-hub', 'hub session');
  seedSession(slugs.standaloneService, 'list-service', 'service session');

  const own = await request(app).get(`/api/projects/${slugs.workspaceDemo}/sessions`);
  assert.strictEqual(own.status, 200);
  assert.ok(own.body.every(s => s.slug === slugs.workspaceDemo), 'default scope lists only this project');
  assert.ok(!own.body.some(s => s.sessionId === 'list-service'));

  const group = await request(app)
    .get(`/api/projects/${slugs.workspaceDemo}/sessions`)
    .query({ scope: 'group' });
  assert.strictEqual(group.status, 200);
  const ids = group.body.map(s => s.sessionId);
  assert.ok(ids.includes('list-hub'), 'own sessions still listed');
  assert.ok(ids.includes('list-service'), 'sibling project sessions folded in');
  // Each entry says which project it belongs to, so the UI can badge it and open it correctly.
  assert.strictEqual(group.body.find(s => s.sessionId === 'list-service').slug, slugs.standaloneService);
});

test('scope=group searches sessions across every project in the group', async () => {
  seedSession(slugs.workspaceDemo, 'sess-hub', 'investigating the flux capacitor in the hub');
  seedSession(slugs.workspaceDemoHotfix, 'sess-hotfix', 'flux capacitor hotfix work');
  seedSession(slugs.standaloneService, 'sess-service', 'flux capacitor in the linked service');

  const scoped = await request(app)
    .get(`/api/projects/${slugs.workspaceDemo}/sessions/search`)
    .query({ q: 'flux capacitor' });
  assert.strictEqual(scoped.status, 200);
  assert.deepStrictEqual(scoped.body.map(s => s.sessionId), ['sess-hub'], 'default scope stays in this project');

  const group = await request(app)
    .get(`/api/projects/${slugs.workspaceDemo}/sessions/search`)
    .query({ q: 'flux capacitor', scope: 'group' });
  assert.strictEqual(group.status, 200);
  const ids = group.body.map(s => s.sessionId).sort();
  assert.deepStrictEqual(ids, ['sess-hotfix', 'sess-hub', 'sess-service']);

  // Each hit says which project it came from, so the UI can badge and navigate to it.
  const service = group.body.find(s => s.sessionId === 'sess-service');
  assert.strictEqual(service.slug, slugs.standaloneService);
  assert.ok(service.snippets.length > 0);
});

test('scope=group from an ungrouped project searches only itself', async () => {
  const lonely = path.join(HOME, 'worktree-demo-lonely');
  fs.rmSync(lonely, { recursive: true, force: true });
  fs.mkdirSync(lonely, { recursive: true });
  const lonelySlug = seed(lonely);
  seedSession(lonelySlug, 'sess-lonely', 'flux capacitor all alone');

  const res = await request(app)
    .get(`/api/projects/${lonelySlug}/sessions/search`)
    .query({ q: 'flux capacitor', scope: 'group' });
  assert.strictEqual(res.status, 200);
  assert.deepStrictEqual(res.body.map(s => s.sessionId), ['sess-lonely']);

  fs.rmSync(lonely, { recursive: true, force: true });
});

after(() => {
  fs.rmSync(DEMO_PARENT, { recursive: true, force: true });
});
