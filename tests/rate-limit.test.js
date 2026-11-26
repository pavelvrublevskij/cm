const { test } = require('node:test');
const assert = require('node:assert');
const request = require('supertest');

// Own process per test file, so this small cap doesn't affect other tests.
process.env.CM_RATE_LIMIT = '3';
const { app } = require('./helpers/app');

test('API requests under the limit pass, the next one gets 429', async () => {
  for (let i = 0; i < 3; i++) {
    const res = await request(app).get('/api/health');
    assert.notStrictEqual(res.status, 429);
  }
  const res = await request(app).get('/api/health');
  assert.strictEqual(res.status, 429);
  assert.deepStrictEqual(res.body, { error: 'Too many requests' });
});

test('Non-API requests are not rate-limited', async () => {
  const res = await request(app).get('/js/utils.js');
  assert.strictEqual(res.status, 200);
});

test('Board hooks are not rate-limited', async () => {
  const res = await request(app).post('/api/task-board/hook').send({});
  assert.notStrictEqual(res.status, 429);
});

test('Session hooks are not rate-limited', async () => {
  const res = await request(app).post('/api/terminal/hook').send({});
  assert.notStrictEqual(res.status, 429);
});
