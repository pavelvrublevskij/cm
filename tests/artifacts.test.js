const { test, before } = require('node:test');
const assert = require('node:assert');
const request = require('supertest');
const fs = require('fs');
const path = require('path');
const { app, paths } = require('./helpers/app');

function toolUseLine({ id, timestamp, gitBranch, input }) {
  return JSON.stringify({
    type: 'assistant',
    timestamp,
    gitBranch,
    message: { role: 'assistant', content: [{ type: 'tool_use', id, name: 'Artifact', input }] }
  });
}

function toolResultLine({ id, timestamp, result, content }) {
  return JSON.stringify({
    type: 'user',
    timestamp,
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: content || 'ok' }] },
    toolUseResult: result
  });
}

before(() => {
  fs.mkdirSync(paths.PROJECTS_DIR, { recursive: true });

  // Project with one published artifact whose branch carries a ticket code.
  const slug = 'artifact-proj-alpha';
  const projDir = path.join(paths.PROJECTS_DIR, slug);
  fs.mkdirSync(projDir, { recursive: true });
  const lines = [
    toolUseLine({
      id: 'toolu_1',
      timestamp: '2026-03-01T10:00:00Z',
      gitBranch: 'TAMS-10187-aeoi-active-process-review',
      input: { title: 'AEOI Process Review', description: 'Review for TAMS-10187', favicon: '🗂' }
    }),
    toolResultLine({
      id: 'toolu_1',
      timestamp: '2026-03-01T10:00:05Z',
      result: { url: 'https://claude.ai/artifact/abc123', artifact_id: 'art-1', title: 'AEOI Process Review', updated: false }
    }),
    // A later update to the same artifact — should collapse to a single record with a fresher updatedAt.
    toolUseLine({
      id: 'toolu_2',
      timestamp: '2026-03-02T09:00:00Z',
      gitBranch: 'TAMS-10187-aeoi-active-process-review',
      input: { title: 'AEOI Process Review', description: 'Review for TAMS-10187', favicon: '🗂' }
    }),
    toolResultLine({
      id: 'toolu_2',
      timestamp: '2026-03-02T09:00:05Z',
      result: { url: 'https://claude.ai/artifact/abc123', artifact_id: 'art-1', title: 'AEOI Process Review', updated: true }
    }),
    // A second, unrelated artifact with no ticket in its branch.
    toolUseLine({
      id: 'toolu_3',
      timestamp: '2026-03-03T10:00:00Z',
      gitBranch: 'main',
      input: { title: 'Scratch Notes', description: '', favicon: '📝' }
    }),
    toolResultLine({
      id: 'toolu_3',
      timestamp: '2026-03-03T10:00:05Z',
      result: { url: 'https://claude.ai/artifact/def456', artifact_id: 'art-2', title: 'Scratch Notes', updated: false }
    }),
    // A non-publish Artifact call (e.g. a "list" action) has no url/artifact_id and must be ignored.
    toolUseLine({ id: 'toolu_4', timestamp: '2026-03-04T10:00:00Z', gitBranch: 'main', input: { action: 'list' } }),
    toolResultLine({ id: 'toolu_4', timestamp: '2026-03-04T10:00:05Z', result: { artifacts: [] } })
  ];
  fs.writeFileSync(path.join(projDir, 'sess-artifacts.jsonl'), lines.join('\n') + '\n');

  // A second project with no artifacts at all.
  const emptySlug = 'artifact-proj-empty';
  const emptyDir = path.join(paths.PROJECTS_DIR, emptySlug);
  fs.mkdirSync(emptyDir, { recursive: true });
  fs.writeFileSync(path.join(emptyDir, 'sess-empty.jsonl'), toolUseLine({
    id: 'toolu_5', timestamp: '2026-03-01T00:00:00Z', gitBranch: 'main', input: { title: 'Unfinished' }
  }) + '\n');
});

test('GET /api/artifacts/summary reports total and per-project counts', async () => {
  const res = await request(app).get('/api/artifacts/summary');
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.total, 2);
  assert.strictEqual(res.body.bySlug['artifact-proj-alpha'], 2);
  assert.strictEqual(res.body.bySlug['artifact-proj-empty'], undefined);
});

test('GET /api/artifacts dedupes republished artifacts and extracts ticket from branch', async () => {
  const res = await request(app).get('/api/artifacts');
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.length, 2);

  const reviewed = res.body.find(a => a.artifactId === 'art-1');
  assert.ok(reviewed, 'republished artifact should collapse to one record');
  assert.strictEqual(reviewed.ticket, 'TAMS-10187');
  assert.strictEqual(reviewed.url, 'https://claude.ai/artifact/abc123');
  assert.strictEqual(reviewed.slug, 'artifact-proj-alpha');
  assert.strictEqual(reviewed.firstPublishedAt, '2026-03-01T10:00:00Z');
  assert.strictEqual(reviewed.updatedAt, '2026-03-02T09:00:05Z');
  assert.strictEqual(reviewed.updated, true);

  const scratch = res.body.find(a => a.artifactId === 'art-2');
  assert.ok(scratch);
  assert.strictEqual(scratch.ticket, null);
});

test('GET /api/artifacts orders newest updatedAt first', async () => {
  const res = await request(app).get('/api/artifacts');
  const idx1 = res.body.findIndex(a => a.artifactId === 'art-1');
  const idx2 = res.body.findIndex(a => a.artifactId === 'art-2');
  assert.ok(idx2 < idx1, 'art-2 (2026-03-03) should sort before art-1 (2026-03-02)');
});

test('GET /api/projects/:slug/artifacts groups by ticket, untagged last', async () => {
  const res = await request(app).get('/api/projects/artifact-proj-alpha/artifacts');
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.total, 2);
  assert.strictEqual(res.body.groups.length, 2);
  assert.strictEqual(res.body.groups[0].ticket, 'TAMS-10187');
  assert.strictEqual(res.body.groups[0].artifacts.length, 1);
  assert.strictEqual(res.body.groups[1].ticket, null);
});

test('GET /api/projects/:slug/artifacts returns empty groups for a project with no publishes', async () => {
  const res = await request(app).get('/api/projects/artifact-proj-empty/artifacts');
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.total, 0);
  assert.deepStrictEqual(res.body.groups, []);
});

test('GET /api/projects/:slug/artifacts rejects a path-traversal slug', async () => {
  const res = await request(app).get('/api/projects/..%2F..%2Fetc/artifacts');
  assert.strictEqual(res.status, 400);
});

test('GET /api/projects/:slug/sessions/with-artifacts returns the deduped session IDs that published something', async () => {
  const res = await request(app).get('/api/projects/artifact-proj-alpha/sessions/with-artifacts');
  assert.strictEqual(res.status, 200);
  assert.deepStrictEqual(res.body, ['sess-artifacts']);
});

test('GET /api/projects/:slug/sessions/with-artifacts returns empty array for a project with no publishes', async () => {
  const res = await request(app).get('/api/projects/artifact-proj-empty/sessions/with-artifacts');
  assert.strictEqual(res.status, 200);
  assert.deepStrictEqual(res.body, []);
});

test('GET /api/projects/:slug/sessions/:sessionId/artifacts returns that session\'s own artifacts, newest first', async () => {
  const res = await request(app).get('/api/projects/artifact-proj-alpha/sessions/sess-artifacts/artifacts');
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.length, 2);
  assert.strictEqual(res.body[0].artifactId, 'art-2');
  assert.strictEqual(res.body[1].artifactId, 'art-1');
});

test('GET /api/projects/:slug/sessions/:sessionId/artifacts returns empty array for a session with no publishes', async () => {
  const res = await request(app).get('/api/projects/artifact-proj-empty/sessions/sess-empty/artifacts');
  assert.strictEqual(res.status, 200);
  assert.deepStrictEqual(res.body, []);
});
