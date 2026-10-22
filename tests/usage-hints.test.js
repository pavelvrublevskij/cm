const { test, before } = require('node:test');
const assert = require('node:assert');
const request = require('supertest');
const fs = require('fs');
const path = require('path');
const { app, paths } = require('./helpers/app');

const SLUG = 'usage-hints-proj';

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
  // One big Opus session with a poor cache hit: 2M uncached input, 1M cache writes, 1M cache reads.
  fs.writeFileSync(path.join(dir, 'big.jsonl'), entry('2025-09-01', 'claude-opus-4-6', {
    input_tokens: 2_000_000, cache_creation_input_tokens: 1_000_000, cache_read_input_tokens: 21_000_000, output_tokens: 10_000
  }) + '\n');
  fs.writeFileSync(path.join(dir, 'cold.jsonl'), entry('2025-09-02', 'claude-opus-4-6', {
    input_tokens: 3_000_000, cache_creation_input_tokens: 2_000_000, output_tokens: 1000
  }) + '\n');
});

function hintsFor(q) {
  return request(app).get('/api/usage/hints?projects=' + SLUG + q);
}

test('GET /api/usage/hints flags cache, Opus share, expensive and long sessions', async () => {
  const res = await hintsFor('&from=2025-09-01&to=2025-09-30');
  assert.strictEqual(res.status, 200);
  const ids = res.body.hints.map(h => h.id);
  assert.ok(ids.includes('cache-hit'), 'cache hit below 80%');
  assert.ok(ids.includes('opus-share'));
  assert.ok(ids.includes('expensive-sessions'));
  assert.ok(ids.includes('long-sessions'));
  for (const h of res.body.hints) {
    assert.ok(['warn', 'info'].includes(h.level));
    assert.ok(h.title && h.detail);
  }
});

test('GET /api/usage/hints follows the period filter', async () => {
  const res = await hintsFor('&from=2025-09-01&to=2025-09-01');
  const ids = res.body.hints.map(h => h.id);
  assert.ok(!ids.includes('cache-hit'), 'the big session alone has a good cache hit');
  assert.ok(ids.includes('long-sessions'));
});

test('GET /api/usage/hints returns nothing without usage', async () => {
  const res = await hintsFor('&from=2020-01-01&to=2020-01-02');
  assert.deepStrictEqual(res.body.hints, []);
});
