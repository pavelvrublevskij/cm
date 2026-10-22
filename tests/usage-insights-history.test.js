const { test, before, after } = require('node:test');
const assert = require('node:assert');
const request = require('supertest');
const fs = require('fs');
const path = require('path');
const { app, paths } = require('./helpers/app');
const insights = require('../lib/usage-insights');
const history = require('../lib/usage-insights-history');

const SLUG = 'usage-history-proj';
const realRun = insights.runClaude;

before(() => {
  const dir = path.join(paths.PROJECTS_DIR, SLUG);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'sess-hist-1.jsonl'), JSON.stringify({
    type: 'assistant',
    timestamp: '2025-07-01T12:00:00Z',
    message: { model: 'claude-sonnet-4-6', usage: { input_tokens: 100, output_tokens: 50, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } }
  }) + '\n');
  insights.runClaude = async () => 'Look at `sess-hist-1` first.';
});

after(() => { insights.runClaude = realRun; });

const Q = '?projects=' + SLUG + '&from=2025-07-01&to=2025-07-31';

test('an analysis is saved to history with its scope, model and session links', async () => {
  const run = await request(app).post('/api/usage/insights' + Q).send({ model: 'sonnet', effort: 'low' });
  assert.strictEqual(run.status, 200);
  assert.ok(run.body.id);
  assert.deepStrictEqual(run.body.sessionLinks, [{ sessionId: 'sess-hist-1', slug: SLUG }]);
  assert.strictEqual(run.body.scope.from, '2025-07-01');

  const list = await request(app).get('/api/usage/insights/history');
  const meta = list.body.reports.find(r => r.id === run.body.id);
  assert.strictEqual(meta.model, 'sonnet');
  assert.strictEqual(meta.effort, 'low');
  assert.strictEqual(meta.report, undefined, 'list leaves out the report text');

  const full = await request(app).get('/api/usage/insights/history/' + run.body.id);
  assert.strictEqual(full.body.report, 'Look at `sess-hist-1` first.');
  assert.deepStrictEqual(full.body.sessionLinks, run.body.sessionLinks);
});

test('history is newest first and deletable', async () => {
  const a = await request(app).post('/api/usage/insights' + Q).send({});
  const b = await request(app).post('/api/usage/insights' + Q).send({});
  const list = await request(app).get('/api/usage/insights/history');
  const ids = list.body.reports.map(r => r.id);
  assert.ok(ids.indexOf(b.body.id) < ids.indexOf(a.body.id));

  const del = await request(app).delete('/api/usage/insights/history/' + a.body.id);
  assert.strictEqual(del.status, 200);
  const gone = await request(app).get('/api/usage/insights/history/' + a.body.id);
  assert.strictEqual(gone.status, 404);
  const again = await request(app).delete('/api/usage/insights/history/' + a.body.id);
  assert.strictEqual(again.status, 404);
});

test('history keeps only the newest reports', () => {
  for (let i = 0; i < history.MAX_REPORTS + 3; i++) {
    history.saveReport({ report: 'r' + i, model: 'default', effort: 'default', scope: {}, sessionLinks: [], generatedAt: new Date().toISOString() });
  }
  assert.strictEqual(history.listReports().length, history.MAX_REPORTS);
  assert.ok(fs.existsSync(paths.INSIGHTS_HISTORY_FILE));
  assert.ok(paths.INSIGHTS_HISTORY_FILE.startsWith(paths.DATA_DIR));
});

test('a failed analysis is not saved', async () => {
  const before = history.listReports().length;
  insights.runClaude = async () => { throw new Error('boom'); };
  const res = await request(app).post('/api/usage/insights' + Q).send({});
  assert.strictEqual(res.status, 500);
  assert.strictEqual(history.listReports().length, before);
  insights.runClaude = async () => 'ok';
});
