const { test, before } = require('node:test');
const assert = require('node:assert');
const request = require('supertest');
const fs = require('fs');
const path = require('path');
const { app, paths } = require('./helpers/app');
const { parentSlug } = require('../lib/slug');

// Claude worktree sessions (<project>/.claude/worktrees/<name>) count under their parent project,
// worked out from the slug alone so it still holds after the worktree directory is gone.

const PARENT = 'C--code-wt-usage-parent';
const WORKTREE = PARENT + '--claude-worktrees-cm-1a2b3c4d';

function seed(slug, sessionId, input) {
  const dir = path.join(paths.PROJECTS_DIR, slug);
  fs.mkdirSync(dir, { recursive: true });
  const line = JSON.stringify({
    type: 'assistant',
    timestamp: '2025-07-15T12:00:00Z',
    message: { model: 'claude-sonnet-4-6', usage: { input_tokens: input, output_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } }
  });
  fs.writeFileSync(path.join(dir, sessionId + '.jsonl'), line + '\n');
}

before(() => {
  seed(PARENT, 'wt-parent-sess', 100);
  seed(WORKTREE, 'wt-child-sess', 200);
});

test('parentSlug strips a Claude worktree suffix and leaves other slugs alone', () => {
  assert.strictEqual(parentSlug('C--Users-me-code-app--claude-worktrees-cm-904b541d'), 'C--Users-me-code-app');
  assert.strictEqual(parentSlug('-home-me-app--claude-worktrees-feature-x-y'), '-home-me-app');
  assert.strictEqual(parentSlug('C--Users-me-code-app'), 'C--Users-me-code-app');
  assert.strictEqual(parentSlug('-home-me-app--claude-settings'), '-home-me-app--claude-settings');
});

test('summary lists only the parent project and counts worktree sessions under it', async () => {
  const res = await request(app).get('/api/usage/summary').query({ projects: PARENT });
  assert.strictEqual(res.status, 200);
  const slugs = res.body.allProjects.map(p => p.slug);
  assert.ok(slugs.includes(PARENT));
  assert.ok(!slugs.includes(WORKTREE));
  assert.strictEqual(res.body.sessionCount, 2);
  assert.strictEqual(res.body.projectCount, 1);
  assert.strictEqual(res.body.totals.input_tokens, 300);
});

test('by-project merges worktree sessions into the parent row', async () => {
  const res = await request(app).get('/api/usage/by-project');
  const rows = res.body.projects.filter(p => p.slug === PARENT || p.slug === WORKTREE);
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].slug, PARENT);
  assert.strictEqual(rows[0].sessionCount, 2);
  assert.strictEqual(rows[0].input_tokens, 300);
});

test('project/:slug for the parent includes worktree sessions', async () => {
  const res = await request(app).get('/api/usage/project/' + PARENT);
  assert.strictEqual(res.body.sessionCount, 2);
  assert.strictEqual(res.body.totals.input_tokens, 300);
});

test('by-period filtered to the parent includes worktree sessions', async () => {
  const res = await request(app).get('/api/usage/by-period').query({ group: 'month', projects: PARENT, from: '2025-07-01', to: '2025-07-31' });
  const total = res.body.periods.reduce((sum, p) => sum + p.input_tokens, 0);
  assert.strictEqual(total, 300);
});

test('project/:slug for a live worktree project still returns its own sessions', async () => {
  const res = await request(app).get('/api/usage/project/' + WORKTREE);
  assert.strictEqual(res.body.sessionCount, 1);
  assert.strictEqual(res.body.totals.input_tokens, 200);
});
