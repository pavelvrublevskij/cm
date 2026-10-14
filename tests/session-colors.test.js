const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const request = require('supertest');
const { app, paths } = require('./helpers/app');

const SLUG = 'colors-test-proj';
const SESSION_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const COLORS_FILE = path.join(paths.DATA_DIR, 'session-colors.json');
const PROJECT_DIR = path.join(paths.PROJECTS_DIR, SLUG);

fs.mkdirSync(PROJECT_DIR, { recursive: true });
fs.writeFileSync(path.join(PROJECT_DIR, SESSION_A + '.jsonl'),
  JSON.stringify({ type: 'user', uuid: 'u1', timestamp: '2026-01-01T10:00:00Z', message: { content: 'hi' } }) + '\n');

after(() => {
  fs.rmSync(PROJECT_DIR, { recursive: true, force: true });
  require('../lib/active-sessions')._reset();
});

test('POST /color stores the color, lowercased', async () => {
  const res = await request(app).post(`/api/projects/${SLUG}/sessions/${SESSION_A}/color`).send({ color: '#A371F7' });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.color, '#a371f7');
  const stored = JSON.parse(fs.readFileSync(COLORS_FILE, 'utf-8'));
  assert.strictEqual(stored[SLUG][SESSION_A], '#a371f7');
});

test('GET /active returns the stored color', async () => {
  const activeSessions = require('../lib/active-sessions');
  activeSessions._reset();
  activeSessions.register(SLUG, SESSION_A, 'os-terminal');
  const res = await request(app).get('/api/projects/active');
  const entry = res.body.find(s => s.slug === SLUG && s.sessionId === SESSION_A);
  assert.strictEqual(entry.color, '#a371f7');
});

test('POST /color with null resets to the default', async () => {
  const res = await request(app).post(`/api/projects/${SLUG}/sessions/${SESSION_A}/color`).send({ color: null });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.color, null);
  const stored = JSON.parse(fs.readFileSync(COLORS_FILE, 'utf-8'));
  assert.strictEqual(stored[SLUG], undefined);

  const active = await request(app).get('/api/projects/active');
  const entry = active.body.find(s => s.slug === SLUG && s.sessionId === SESSION_A);
  assert.strictEqual(entry.color, null);
});

test('POST /color rejects a non-hex value', async () => {
  const res = await request(app).post(`/api/projects/${SLUG}/sessions/${SESSION_A}/color`).send({ color: 'red;background:url(x)' });
  assert.strictEqual(res.status, 400);
});

test('POST /color rejects an invalid slug and session id', async () => {
  assert.strictEqual((await request(app).post('/api/projects/bad..slug/sessions/x/color').send({ color: null })).status, 400);
  assert.strictEqual((await request(app).post(`/api/projects/${SLUG}/sessions/a..b/color`).send({ color: null })).status, 400);
});

test('GET /session-colors returns every stored color', async () => {
  await request(app).post(`/api/projects/${SLUG}/sessions/${SESSION_A}/color`).send({ color: '#3fb950' });
  const res = await request(app).get('/api/projects/session-colors');
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body[SLUG][SESSION_A], '#3fb950');
  await request(app).post(`/api/projects/${SLUG}/sessions/${SESSION_A}/color`).send({ color: null });
});
