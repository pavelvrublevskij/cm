const { test, before } = require('node:test');
const assert = require('node:assert');
const request = require('supertest');
const fs = require('fs');
const path = require('path');
const { app, paths } = require('./helpers/app');

before(() => {
  fs.mkdirSync(paths.PROJECTS_DIR, { recursive: true });

  const slug = 'usage-proj-gamma';
  const projDir = path.join(paths.PROJECTS_DIR, slug);
  fs.mkdirSync(projDir, { recursive: true });
  const sessionId = 'sess-001';
  const line = JSON.stringify({
    type: 'assistant',
    timestamp: '2026-03-01T12:00:00Z',
    message: {
      model: 'claude-sonnet-4-6',
      usage: {
        input_tokens: 100,
        output_tokens: 50,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0
      }
    }
  });
  fs.writeFileSync(path.join(projDir, sessionId + '.jsonl'), line + '\n');

  // Seed a session with duplicate requestIds to test deduplication.
  // Claude Code splits one API response into multiple JSONL entries (thinking,
  // text, tool_use blocks) each sharing the same requestId and identical usage.
  // Only one entry per requestId should be counted.
  const dedupSlug = 'usage-proj-dedup';
  const dedupDir = path.join(paths.PROJECTS_DIR, dedupSlug);
  fs.mkdirSync(dedupDir, { recursive: true });
  const makeEntry = (requestId, contentType) => JSON.stringify({
    type: 'assistant',
    requestId,
    timestamp: '2026-03-01T10:00:00Z',
    message: {
      model: 'claude-sonnet-4-6',
      content: [{ type: contentType }],
      usage: { input_tokens: 100, output_tokens: 50, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }
    }
  });
  const dedupLines = [
    makeEntry('req-aaa', 'thinking'),  // \
    makeEntry('req-aaa', 'text'),      //  } same API call — only count once
    makeEntry('req-aaa', 'tool_use'),  // /
    makeEntry('req-bbb', 'text'),      // different API call — count separately
  ];
  fs.writeFileSync(path.join(dedupDir, 'sess-dedup.jsonl'), dedupLines.join('\n') + '\n');

  // Seed a session where the main turn runs on one model but a background Agent-tool
  // subagent resolves to a different model. The subagent never appears as an 'assistant'
  // entry in the parent transcript — only via toolUseResult.resolvedModel (keyed by agentId)
  // and a later task-notification carrying a lump-sum <subagent_tokens> count.
  const subagentSlug = 'usage-proj-subagent';
  const subagentDir = path.join(paths.PROJECTS_DIR, subagentSlug);
  fs.mkdirSync(subagentDir, { recursive: true });
  const subagentLines = [
    JSON.stringify({
      type: 'assistant',
      timestamp: '2026-03-01T12:00:00Z',
      message: {
        model: 'claude-sonnet-4-6',
        usage: { input_tokens: 10, output_tokens: 20, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }
      }
    }),
    JSON.stringify({
      type: 'user',
      timestamp: '2026-03-01T12:00:05Z',
      toolUseResult: { isAsync: true, agentId: 'agent-xyz', resolvedModel: 'claude-haiku-4-5' }
    }),
    JSON.stringify({
      type: 'attachment',
      timestamp: '2026-03-01T12:00:10Z',
      attachment: {
        commandMode: 'task-notification',
        prompt: '<task-notification>\n<task-id>agent-xyz</task-id>\n<status>completed</status>\n<usage><subagent_tokens>500</subagent_tokens></usage>\n</task-notification>'
      }
    })
  ];
  fs.writeFileSync(path.join(subagentDir, 'sess-subagent.jsonl'), subagentLines.join('\n') + '\n');

  // Newer Claude Code versions deliver the same task-notification as a plain 'user' message
  // whose content is a raw string, instead of an 'attachment' entry with a commandMode.
  const subagentSlug2 = 'usage-proj-subagent-plain';
  const subagentDir2 = path.join(paths.PROJECTS_DIR, subagentSlug2);
  fs.mkdirSync(subagentDir2, { recursive: true });
  const subagentLines2 = [
    JSON.stringify({
      type: 'assistant',
      timestamp: '2026-03-01T12:00:00Z',
      message: {
        model: 'claude-sonnet-4-6',
        usage: { input_tokens: 10, output_tokens: 20, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }
      }
    }),
    JSON.stringify({
      type: 'user',
      timestamp: '2026-03-01T12:00:05Z',
      toolUseResult: { isAsync: true, agentId: 'agent-plain', resolvedModel: 'claude-opus-4-6' }
    }),
    JSON.stringify({
      type: 'user',
      timestamp: '2026-03-01T12:00:10Z',
      message: {
        role: 'user',
        content: '<task-notification>\n<task-id>agent-plain</task-id>\n<status>completed</status>\n<usage><subagent_tokens>300</subagent_tokens></usage>\n</task-notification>'
      }
    })
  ];
  fs.writeFileSync(path.join(subagentDir2, 'sess-subagent-plain.jsonl'), subagentLines2.join('\n') + '\n');
});

test('GET /api/usage/summary returns aggregated shape', async () => {
  const res = await request(app).get('/api/usage/summary');
  assert.strictEqual(res.status, 200);
  const b = res.body;
  assert.ok(b.totals, 'totals present');
  assert.strictEqual(typeof b.totals.input_tokens, 'number');
  assert.strictEqual(typeof b.totals.output_tokens, 'number');
  assert.ok(b.byModel);
  assert.ok(b.cost);
  assert.strictEqual(typeof b.sessionCount, 'number');
  assert.strictEqual(typeof b.projectCount, 'number');
  assert.ok(Array.isArray(b.allModels));
  assert.ok(Array.isArray(b.allProjects));
  assert.ok(b.modelPricing);
  assert.ok('pricingSource' in b);
});

test('GET /api/usage/summary reflects seeded session tokens', async () => {
  const res = await request(app).get('/api/usage/summary');
  assert.strictEqual(res.status, 200);
  assert.ok(res.body.totals.input_tokens >= 100);
  assert.ok(res.body.totals.output_tokens >= 50);
  assert.ok(res.body.sessionCount >= 1);
  assert.ok(res.body.projectCount >= 1);
  assert.ok(res.body.byModel['claude-sonnet-4-6'], 'seeded model present');
});

test('GET /api/usage/by-period returns periods array', async () => {
  const res = await request(app).get('/api/usage/by-period?group=month');
  assert.strictEqual(res.status, 200);
  assert.ok(Array.isArray(res.body.periods));
  if (res.body.periods.length) {
    const p = res.body.periods[0];
    assert.strictEqual(typeof p.label, 'string');
    assert.strictEqual(typeof p.input_tokens, 'number');
    assert.strictEqual(typeof p.cost, 'number');
  }
});

test('GET /api/usage/by-period?group=day groups by local day', async () => {
  const res = await request(app).get('/api/usage/by-period?group=day');
  assert.strictEqual(res.status, 200);
  assert.ok(Array.isArray(res.body.periods));
  // Server converts the UTC hour key to local date, so the expected label depends
  // on the timezone where tests run (2026-03-01T12:00:00Z = local day on that machine).
  const seededTs = new Date('2026-03-01T12:00:00Z');
  const localDay = seededTs.getFullYear() + '-' + String(seededTs.getMonth() + 1).padStart(2, '0') + '-' + String(seededTs.getDate()).padStart(2, '0');
  const dayEntry = res.body.periods.find(p => p.label === localDay);
  assert.ok(dayEntry, 'day label from seeded session should exist as local date ' + localDay);
});

test('GET /api/usage/by-project returns projects array', async () => {
  const res = await request(app).get('/api/usage/by-project');
  assert.strictEqual(res.status, 200);
  assert.ok(Array.isArray(res.body.projects));
  const entry = res.body.projects.find(p => p.slug === 'usage-proj-gamma');
  assert.ok(entry, 'seeded project should appear');
  assert.strictEqual(typeof entry.sessionCount, 'number');
  assert.strictEqual(typeof entry.cost, 'number');
  assert.ok(entry.byModel);
});

test('GET /api/usage/project/:slug returns project totals', async () => {
  const res = await request(app).get('/api/usage/project/usage-proj-gamma');
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.slug, 'usage-proj-gamma');
  assert.ok(res.body.totals);
  assert.ok(res.body.byModel);
  assert.ok(res.body.cost);
  assert.strictEqual(typeof res.body.sessionCount, 'number');
  assert.ok(res.body.sessionCount >= 1);
});

test('GET /api/usage/project/:slug for unknown slug returns zeroed totals', async () => {
  const res = await request(app).get('/api/usage/project/no-such-slug-xyz');
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.slug, 'no-such-slug-xyz');
  assert.strictEqual(res.body.sessionCount, 0);
  assert.strictEqual(res.body.totals.input_tokens, 0);
  assert.strictEqual(res.body.totals.output_tokens, 0);
});

test('GET /api/usage/by-period?group=hour returns hourly buckets', async () => {
  const res = await request(app).get('/api/usage/by-period?group=hour');
  assert.strictEqual(res.status, 200);
  assert.ok(Array.isArray(res.body.periods));
  // Server converts UTC hour key to local time, so expected label depends on test machine timezone.
  const seededTs = new Date('2026-03-01T12:00:00Z');
  const localDay = seededTs.getFullYear() + '-' + String(seededTs.getMonth() + 1).padStart(2, '0') + '-' + String(seededTs.getDate()).padStart(2, '0');
  const localHour = String(seededTs.getHours()).padStart(2, '0');
  const expectedLabel = localDay + ' ' + localHour + ':00';
  const hourEntry = res.body.periods.find(p => p.label === expectedLabel);
  assert.ok(hourEntry, 'hourly label from seeded session should exist as local time ' + expectedLabel);
  assert.ok(hourEntry.input_tokens >= 100);
});

test('usage indexer deduplicates entries sharing the same requestId', async () => {
  const res = await request(app).get('/api/usage/project/usage-proj-dedup');
  assert.strictEqual(res.status, 200);
  // 3 entries share req-aaa (input=100, output=50 each) + 1 entry req-bbb (same values).
  // Without dedup: 4 × 100 = 400 input, 4 × 50 = 200 output.
  // With dedup: 2 unique requestIds × 100 = 200 input, 2 × 50 = 100 output.
  assert.strictEqual(res.body.totals.input_tokens, 200);
  assert.strictEqual(res.body.totals.output_tokens, 100);
});

test('usage indexer attributes subagent task-notification tokens to the resolved model', async () => {
  const res = await request(app).get('/api/usage/project/usage-proj-subagent');
  assert.strictEqual(res.status, 200);
  assert.ok(res.body.byModel['claude-sonnet-4-6'], 'parent model present');
  assert.ok(res.body.byModel['claude-haiku-4-5'], 'subagent resolved model present');
  assert.strictEqual(res.body.byModel['claude-haiku-4-5'].output_tokens, 500);
  assert.strictEqual(res.body.totals.output_tokens, 20 + 500);
});

test('usage indexer attributes subagent tokens when the notification is a plain user message', async () => {
  const res = await request(app).get('/api/usage/project/usage-proj-subagent-plain');
  assert.strictEqual(res.status, 200);
  assert.ok(res.body.byModel['claude-sonnet-4-6'], 'parent model present');
  assert.ok(res.body.byModel['claude-opus-4-6'], 'subagent resolved model present');
  assert.strictEqual(res.body.byModel['claude-opus-4-6'].output_tokens, 300);
  assert.strictEqual(res.body.totals.output_tokens, 20 + 300);
});

test('GET /api/usage/summary with fromTime/toTime filters by hour', async () => {
  // fromTime/toTime are local hours; server converts UTC hour keys to local before comparing.
  const seededTs = new Date('2026-03-01T12:00:00Z');
  const localHour = String(seededTs.getHours()).padStart(2, '0');
  const nextHour = String((seededTs.getHours() + 1) % 24).padStart(2, '0');

  const inRange = await request(app).get(`/api/usage/summary?fromTime=${localHour}:00&toTime=${localHour}:59`);
  assert.strictEqual(inRange.status, 200);
  assert.ok(inRange.body.totals.input_tokens >= 100, 'local hour ' + localHour + ' is in range');

  const outRange = await request(app).get(`/api/usage/summary?fromTime=${nextHour}:00&toTime=${nextHour}:59`);
  assert.strictEqual(outRange.status, 200);
  assert.strictEqual(outRange.body.totals.input_tokens, 0, 'local hour ' + localHour + ' excluded when filter is ' + nextHour);
});

// ── Date range filter tests ───────────────────────────────────────────────────
// The client converts local dates to UTC before sending (queryParts in date-filter.js).
// These tests verify the server correctly includes/excludes data based on UTC day keys.

test('summary: from/to filter includes sessions within UTC date range', async () => {
  const res = await request(app).get('/api/usage/summary?from=2026-03-01&to=2026-03-01');
  assert.strictEqual(res.status, 200);
  assert.ok(res.body.totals.input_tokens >= 100, 'session at 2026-03-01T12:00Z should be included');
  assert.ok(res.body.sessionCount >= 1);
});

test('summary: from/to filter excludes sessions outside UTC date range', async () => {
  const res = await request(app).get('/api/usage/summary?from=2026-02-01&to=2026-02-28');
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.totals.input_tokens, 0, 'no sessions in February');
  assert.strictEqual(res.body.sessionCount, 0);
});

test('summary: from filter alone excludes earlier sessions', async () => {
  const res = await request(app).get('/api/usage/summary?from=2026-03-02');
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.totals.input_tokens, 0, 'session on 2026-03-01 excluded when from=2026-03-02');
});

test('summary: to filter alone excludes later sessions', async () => {
  const res = await request(app).get('/api/usage/summary?to=2026-02-28');
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.totals.input_tokens, 0, 'session on 2026-03-01 excluded when to=2026-02-28');
});

test('by-period: date filter excludes out-of-range periods', async () => {
  const res = await request(app).get('/api/usage/by-period?group=day&from=2026-04-01&to=2026-04-30');
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.periods.length, 0, 'no periods in April');
});

test('by-project: date filter scopes project data', async () => {
  const inRange = await request(app).get('/api/usage/by-project?from=2026-03-01&to=2026-03-01');
  assert.strictEqual(inRange.status, 200);
  const proj = inRange.body.projects.find(p => p.slug === 'usage-proj-gamma');
  assert.ok(proj, 'project with March session should appear in March filter');

  const outRange = await request(app).get('/api/usage/by-project?from=2026-02-01&to=2026-02-28');
  assert.strictEqual(outRange.status, 200);
  const proj2 = outRange.body.projects.find(p => p.slug === 'usage-proj-gamma');
  assert.ok(!proj2, 'project should not appear for February filter');
});
