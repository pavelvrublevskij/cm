const { test, before, after } = require('node:test');
const assert = require('node:assert');
const request = require('supertest');
const fs = require('fs');
const path = require('path');
const { app, paths } = require('./helpers/app');
const insights = require('../lib/usage-insights');
const { buildIndex } = require('../lib/usage-index');

const SLUG = 'usage-insights-proj';
const realRun = insights.runClaude;

function entry(day, model, usage) {
  return JSON.stringify({
    type: 'assistant',
    timestamp: day + 'T12:00:00Z',
    message: { model, usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, ...usage } }
  });
}

before(() => {
  const dir = path.join(paths.PROJECTS_DIR, SLUG);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'a.jsonl'), [
    entry('2025-08-01', 'claude-sonnet-4-6', { input_tokens: 100, cache_read_input_tokens: 800, cache_creation_input_tokens: 100, output_tokens: 50 })
  ].join('\n') + '\n');
  fs.writeFileSync(path.join(dir, 'b.jsonl'), [
    entry('2025-08-02', 'claude-opus-4-6', { input_tokens: 1000, output_tokens: 500 })
  ].join('\n') + '\n');
});

after(() => { insights.runClaude = realRun; });

test('buildInsightStats aggregates scope, ratios, models, sessions and daily trend', () => {
  const stats = insights.buildInsightStats(buildIndex(), { projects: new Set([SLUG]), from: '2025-08-01', to: '2025-08-31', today: '2025-08-31' });
  assert.strictEqual(stats.sessions.count, 2);
  assert.strictEqual(stats.models.length, 2);
  assert.strictEqual(stats.models[0].model, 'claude-opus-4-6');
  assert.strictEqual(stats.totals.cache_read_input_tokens, 800);
  assert.strictEqual(stats.totals.cacheHitRatio, Number((800 / 2000).toFixed(3)));
  assert.deepStrictEqual(stats.daily.map(d => d.day), ['2025-08-01', '2025-08-02']);
  assert.strictEqual(stats.sessions.mostExpensive[0].mainModel, 'claude-opus-4-6');
  assert.strictEqual(stats.scope.from, '2025-08-01');
});

test('buildInsightStats includes marks in range with before/after averages', async () => {
  await request(app).post('/api/usage/marks').send({ date: '2025-08-02', title: 'Switched to Opus', project: SLUG });
  await request(app).post('/api/usage/marks').send({ date: '2024-01-01', title: 'Out of range', project: SLUG });
  const stats = insights.buildInsightStats(buildIndex(), { projects: new Set([SLUG]), from: '2025-08-01', to: '2025-08-31', today: '2025-08-31' });
  assert.deepStrictEqual(stats.marks.map(m => m.title), ['Switched to Opus']);
  assert.strictEqual(stats.marks[0].avgTokensPerDayBefore, 1050);
  assert.strictEqual(stats.marks[0].avgTokensPerDayAfter, 1500);
});

test('buildInsightStats honours the models filter', () => {
  const stats = insights.buildInsightStats(buildIndex(), { projects: new Set([SLUG]), models: new Set(['claude-sonnet-4-6']), from: '2025-08-01', to: '2025-08-31', today: '2025-08-31' });
  assert.strictEqual(stats.sessions.count, 1);
  assert.deepStrictEqual(stats.models.map(m => m.model), ['claude-sonnet-4-6']);
  assert.deepStrictEqual(stats.scope.models, ['claude-sonnet-4-6']);
});

test('POST /api/usage/insights applies the same model filter as the usage page', async () => {
  let seenPrompt = null;
  insights.runClaude = async (prompt) => { seenPrompt = prompt; return 'ok'; };
  const res = await request(app).post('/api/usage/insights?projects=' + SLUG + '&models=claude-sonnet-4-6&from=2025-08-01&to=2025-08-31');
  assert.strictEqual(res.status, 200);
  assert.ok(seenPrompt.includes('claude-sonnet-4-6'));
  assert.ok(!seenPrompt.includes('claude-opus-4-6'));
});

test('buildPrompt embeds the stats JSON and asks for gaps and suggestions', () => {
  const prompt = insights.buildPrompt({ hello: 'world' });
  assert.ok(prompt.includes('"hello": "world"'));
  assert.ok(prompt.includes('## Efficiency gaps'));
  assert.ok(prompt.includes('## Suggestions'));
  assert.ok(prompt.includes('## Marks'));
});

test('claudeEnv strips parent session variables and disables claude.ai MCP servers', () => {
  const env = insights.claudeEnv({ PATH: 'x', CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: 'abc' });
  assert.strictEqual(env.PATH, 'x');
  assert.strictEqual(env.CLAUDECODE, undefined);
  assert.strictEqual(env.CLAUDE_CODE_SESSION_ID, undefined);
  assert.strictEqual(env.ENABLE_CLAUDEAI_MCP_SERVERS, 'false');
});

test('POST /api/usage/insights returns the claude report for the filtered scope', async () => {
  let seenPrompt = null;
  insights.runClaude = async (prompt) => { seenPrompt = prompt; return '## Summary\nAll good'; };
  const res = await request(app).post('/api/usage/insights?projects=' + SLUG + '&from=2025-08-01&to=2025-08-31');
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.report, '## Summary\nAll good');
  assert.ok(res.body.generatedAt);
  assert.ok(seenPrompt.includes('claude-opus-4-6'));
});

test('claudeArgs passes model and effort only when not default', () => {
  const base = insights.claudeArgs();
  assert.ok(base.includes('--no-session-persistence'));
  assert.ok(!base.includes('--model'));
  assert.ok(!base.includes('--effort'));
  const both = insights.claudeArgs({ model: 'sonnet', effort: 'high' });
  assert.deepStrictEqual(both.slice(-4), ['--model', 'sonnet', '--effort', 'high']);
  assert.ok(!insights.claudeArgs({ model: 'default', effort: 'default' }).includes('--model'));
});

test('POST /api/usage/insights forwards model and effort to claude', async () => {
  let seenOpts = null;
  insights.runClaude = async (prompt, opts) => { seenOpts = opts; return 'ok'; };
  const res = await request(app).post('/api/usage/insights?projects=' + SLUG + '&from=2025-08-01&to=2025-08-31')
    .send({ model: 'haiku', effort: 'low' });
  assert.strictEqual(res.status, 200);
  assert.deepStrictEqual(seenOpts, { model: 'haiku', effort: 'low' });
  assert.strictEqual(res.body.model, 'haiku');
  assert.strictEqual(res.body.effort, 'low');
});

test('POST /api/usage/insights rejects unknown model or effort without running claude', async () => {
  let called = false;
  insights.runClaude = async () => { called = true; return 'x'; };
  const q = '?projects=' + SLUG + '&from=2025-08-01&to=2025-08-31';
  let res = await request(app).post('/api/usage/insights' + q).send({ model: 'gpt-4' });
  assert.strictEqual(res.status, 400);
  res = await request(app).post('/api/usage/insights' + q).send({ effort: 'insane' });
  assert.strictEqual(res.status, 400);
  res = await request(app).post('/api/usage/insights' + q).send({ model: 'sonnet; rm -rf /' });
  assert.strictEqual(res.status, 400);
  assert.strictEqual(called, false);
});

test('POST /api/usage/insights with no usage in scope returns 400 without running claude', async () => {
  let called = false;
  insights.runClaude = async () => { called = true; return 'x'; };
  const res = await request(app).post('/api/usage/insights?projects=' + SLUG + '&from=2020-01-01&to=2020-01-02');
  assert.strictEqual(res.status, 400);
  assert.strictEqual(called, false);
});

test('POST /api/usage/insights surfaces claude failures as 500', async () => {
  insights.runClaude = async () => { throw new Error('claude: command not found'); };
  const res = await request(app).post('/api/usage/insights?projects=' + SLUG + '&from=2025-08-01&to=2025-08-31');
  assert.strictEqual(res.status, 500);
  assert.match(res.body.error, /command not found/);
});
