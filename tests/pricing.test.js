const { test } = require('node:test');
const assert = require('node:assert');
const request = require('supertest');
const { app } = require('./helpers/app');
const { parsePricingFromHtml } = require('../lib/pricing');

function pricingRow(cells) {
  return '<tr>' + cells.map(c => `<td class="p-2">${c}</td>`).join('') + '</tr>';
}

test('parsePricingFromHtml: model name split across <br/> from a dated pricing tier does not glue onto the qualifier', () => {
  // Real markup captured from the pricing page for a model with an introductory tier
  // followed by a standard tier starting on a later date.
  const html = pricingRow([
    'Claude Sonnet 5<br/><a class="inline-link" href="#x">through August 31, 2026</a>',
    '$2 / MTok', '$2.50 / MTok', '$4 / MTok', '$0.20 / MTok', '$10 / MTok'
  ]) + pricingRow([
    'Claude Sonnet 5<br/>starting September 1, 2026',
    '$3 / MTok', '$3.75 / MTok', '$6 / MTok', '$0.30 / MTok', '$15 / MTok'
  ]);

  const models = parsePricingFromHtml(html);
  assert.ok(models['claude-sonnet-5'], 'clean claude-sonnet-5 key present');
  assert.strictEqual(Object.keys(models).some(k => k.includes('through') || k.includes('starting')), false,
    'no garbled qualifier-suffixed key leaked into the result');
});

test('parsePricingFromHtml: first tier row wins when a model has multiple dated pricing rows', () => {
  const html = pricingRow([
    'Claude Sonnet 5<br/>through August 31, 2026',
    '$2 / MTok', '$2.50 / MTok', '$4 / MTok', '$0.20 / MTok', '$10 / MTok'
  ]) + pricingRow([
    'Claude Sonnet 5<br/>starting September 1, 2026',
    '$3 / MTok', '$3.75 / MTok', '$6 / MTok', '$0.30 / MTok', '$15 / MTok'
  ]);

  const models = parsePricingFromHtml(html);
  assert.strictEqual(models['claude-sonnet-5'].input, 2);
  assert.strictEqual(models['claude-sonnet-5'].output, 10);
});

test('parsePricingFromHtml: single-row model without a pricing tier still parses normally', () => {
  const html = pricingRow([
    'Claude Haiku 4.5',
    '$1 / MTok', '$1.25 / MTok', '$2 / MTok', '$0.10 / MTok', '$5 / MTok'
  ]);

  const models = parsePricingFromHtml(html);
  assert.ok(models['claude-haiku-4-5']);
  assert.strictEqual(models['claude-haiku-4-5'].input, 1);
  assert.strictEqual(models['claude-haiku-4-5'].output, 5);
});

test('GET /api/pricing returns current pricing and source metadata', async () => {
  const res = await request(app).get('/api/pricing');
  assert.strictEqual(res.status, 200);
  assert.ok(res.body.current, 'current present');
  assert.strictEqual(typeof res.body.current, 'object');
  assert.ok('lastFetched' in res.body);
  assert.strictEqual(typeof res.body.source, 'string');
  assert.strictEqual(typeof res.body.historyCount, 'number');
});

test('GET /api/pricing/history returns an array of entries', async () => {
  const res = await request(app).get('/api/pricing/history');
  assert.strictEqual(res.status, 200);
  assert.ok(Array.isArray(res.body));
});

test('GET /api/pricing/config returns a url string', async () => {
  const res = await request(app).get('/api/pricing/config');
  assert.strictEqual(res.status, 200);
  assert.strictEqual(typeof res.body.url, 'string');
  assert.ok(res.body.url.length > 0);
});

test('PUT /api/pricing/config writes a url, GET returns it', async () => {
  const url = 'https://example.invalid/pricing-test-' + Date.now();
  const putRes = await request(app).put('/api/pricing/config').send({ url });
  assert.strictEqual(putRes.status, 200);
  assert.strictEqual(putRes.body.ok, true);
  const getRes = await request(app).get('/api/pricing/config');
  assert.strictEqual(getRes.status, 200);
  assert.strictEqual(getRes.body.url, url);
});

test('PUT /api/pricing/config rejects invalid url', async () => {
  const res = await request(app).put('/api/pricing/config').send({ url: null });
  assert.strictEqual(res.status, 500);
  assert.ok(res.body.error);
});

test('POST /api/pricing/manual adds a history entry', async () => {
  const before = await request(app).get('/api/pricing/history');
  const beforeCount = before.body.length;
  const fetchedAt = '2000-01-01T00:00:00.000Z';
  const models = {
    'claude-test-model-1': { input: 1.23, output: 4.56, cache_write: 1.5, cache_read: 0.1 }
  };
  const res = await request(app).post('/api/pricing/manual').send({ models, fetchedAt });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.ok, true);
  const after = await request(app).get('/api/pricing/history');
  assert.strictEqual(after.status, 200);
  assert.ok(after.body.length >= beforeCount + 1);
  const added = after.body.find(e => e.models && e.models['claude-test-model-1']);
  assert.ok(added, 'manual entry visible in history');
  assert.strictEqual(added.source, 'manual');
});

test('POST /api/pricing/manual rejects empty body', async () => {
  const res = await request(app).post('/api/pricing/manual').send({});
  assert.strictEqual(res.status, 400);
  assert.ok(res.body.error);
});

test('PUT /api/pricing/history/:index updates an existing entry', async () => {
  const addRes = await request(app).post('/api/pricing/manual').send({
    models: { 'claude-put-target': { input: 1, output: 2, cache_write: 1, cache_read: 0.1 } },
    fetchedAt: '2000-01-02T00:00:00.000Z'
  });
  assert.strictEqual(addRes.status, 200);
  const list = await request(app).get('/api/pricing/history');
  const idx = list.body.findIndex(e => e.models && e.models['claude-put-target']);
  assert.ok(idx >= 0, 'target entry exists');

  const updated = {
    'claude-put-target': { input: 9, output: 99, cache_write: 9, cache_read: 0.9 }
  };
  const putRes = await request(app).put('/api/pricing/history/' + idx).send({ models: updated });
  assert.strictEqual(putRes.status, 200);
  assert.strictEqual(putRes.body.ok, true);

  const after = await request(app).get('/api/pricing/history');
  const replaced = after.body.find(e => e.models && e.models['claude-put-target']);
  assert.ok(replaced);
  assert.strictEqual(replaced.models['claude-put-target'].input, 9);
  assert.strictEqual(replaced.source, 'manual');
});

test('PUT /api/pricing/history/:index rejects out-of-range index', async () => {
  const res = await request(app).put('/api/pricing/history/99999').send({
    models: { 'x-bad': { input: 1, output: 1, cache_write: 1, cache_read: 0.1 } }
  });
  assert.strictEqual(res.status, 500);
  assert.ok(res.body.error);
});

test('POST /api/pricing/fetch SKIPPED: hits Anthropic pricing page over the network', { skip: true }, () => {});
