const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const request = require('supertest');
const { app } = require('./helpers/app');
const { SCRATCHPAD_ROOT } = require('../lib/scratchpad');

const SLUG = 'sp-test-project';
const SESSION_ID = 'sptest111-1111-1111-1111-111111111111';
const SESSION_DIR = path.join(SCRATCHPAD_ROOT, SLUG, SESSION_ID);
const SCRATCHPAD_DIR = path.join(SESSION_DIR, 'scratchpad');

const EMPTY_SESSION_ID = 'spempty22-2222-2222-2222-222222222222';

before(() => {
  fs.mkdirSync(path.join(SCRATCHPAD_DIR, 'nested'), { recursive: true });
  fs.writeFileSync(path.join(SCRATCHPAD_DIR, 'notes.txt'), 'hello scratchpad');
  fs.writeFileSync(path.join(SCRATCHPAD_DIR, 'nested', 'data.json'), '{"a":1}');
  fs.writeFileSync(path.join(SCRATCHPAD_DIR, 'binary.dat'), Buffer.from([0x00, 0x01, 0x02, 0xff]));
  fs.writeFileSync(path.join(SCRATCHPAD_DIR, 'big.txt'), 'x'.repeat(210 * 1024));
});

after(() => {
  fs.rmSync(path.join(SCRATCHPAD_ROOT, SLUG), { recursive: true, force: true });
});

// ── list endpoint ─────────────────────────────────────────────────────────────

test('scratchpad list: unknown session returns exists=false and empty files', async () => {
  const res = await request(app).get(`/api/projects/${SLUG}/sessions/${EMPTY_SESSION_ID}/scratchpad`);
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.exists, false);
  assert.deepStrictEqual(res.body.files, []);
});

test('scratchpad list: returns files including nested paths', async () => {
  const res = await request(app).get(`/api/projects/${SLUG}/sessions/${SESSION_ID}/scratchpad`);
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.exists, true);
  const paths = res.body.files.map(f => f.path);
  assert.ok(paths.includes('notes.txt'));
  assert.ok(paths.includes('nested/data.json'));
});

test('scratchpad list: each file has size and mtime', async () => {
  const res = await request(app).get(`/api/projects/${SLUG}/sessions/${SESSION_ID}/scratchpad`);
  const notes = res.body.files.find(f => f.path === 'notes.txt');
  assert.ok(notes);
  assert.strictEqual(notes.size, Buffer.byteLength('hello scratchpad'));
  assert.strictEqual(typeof notes.mtime, 'number');
});

test('scratchpad list: invalid slug returns 400', async () => {
  const res = await request(app).get(`/api/projects/..bad/sessions/${SESSION_ID}/scratchpad`);
  assert.strictEqual(res.status, 400);
});

test('scratchpad list: invalid sessionId returns 400', async () => {
  const res = await request(app).get(`/api/projects/${SLUG}/sessions/..bad/scratchpad`);
  assert.strictEqual(res.status, 400);
});

// ── file endpoint ─────────────────────────────────────────────────────────────

test('scratchpad file: returns text content', async () => {
  const res = await request(app)
    .get(`/api/projects/${SLUG}/sessions/${SESSION_ID}/scratchpad/file`)
    .query({ path: 'notes.txt' });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.binary, false);
  assert.strictEqual(res.body.content, 'hello scratchpad');
});

test('scratchpad file: reads nested file by relative path', async () => {
  const res = await request(app)
    .get(`/api/projects/${SLUG}/sessions/${SESSION_ID}/scratchpad/file`)
    .query({ path: 'nested/data.json' });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.content, '{"a":1}');
});

test('scratchpad file: binary file flagged and content omitted', async () => {
  const res = await request(app)
    .get(`/api/projects/${SLUG}/sessions/${SESSION_ID}/scratchpad/file`)
    .query({ path: 'binary.dat' });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.binary, true);
  assert.strictEqual(res.body.content, undefined);
});

test('scratchpad file: oversized file flagged tooLarge', async () => {
  const res = await request(app)
    .get(`/api/projects/${SLUG}/sessions/${SESSION_ID}/scratchpad/file`)
    .query({ path: 'big.txt' });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.tooLarge, true);
});

test('scratchpad file: missing file returns 404', async () => {
  const res = await request(app)
    .get(`/api/projects/${SLUG}/sessions/${SESSION_ID}/scratchpad/file`)
    .query({ path: 'does-not-exist.txt' });
  assert.strictEqual(res.status, 404);
});

test('scratchpad file: path traversal returns 400', async () => {
  const res = await request(app)
    .get(`/api/projects/${SLUG}/sessions/${SESSION_ID}/scratchpad/file`)
    .query({ path: '../../../etc/passwd' });
  assert.strictEqual(res.status, 400);
});

test('scratchpad file: missing path query returns 400', async () => {
  const res = await request(app).get(`/api/projects/${SLUG}/sessions/${SESSION_ID}/scratchpad/file`);
  assert.strictEqual(res.status, 400);
});

// ── open-folder endpoint ──────────────────────────────────────────────────────

test('scratchpad open-folder: invalid params return 400', async () => {
  const res = await request(app).post(`/api/projects/..bad/sessions/${SESSION_ID}/scratchpad/open-folder`);
  assert.strictEqual(res.status, 400);
});

test('scratchpad open-folder: missing folder on disk returns 404', async () => {
  const res = await request(app).post(`/api/projects/${SLUG}/sessions/${EMPTY_SESSION_ID}/scratchpad/open-folder`);
  assert.strictEqual(res.status, 404);
});

test('scratchpad open-folder SKIPPED: spawns OS file explorer (side-effect)', { skip: true }, () => {});

// ── open-file endpoint ────────────────────────────────────────────────────────

test('scratchpad open-file: invalid params return 400', async () => {
  const res = await request(app)
    .post(`/api/projects/..bad/sessions/${SESSION_ID}/scratchpad/open-file`)
    .send({ path: 'notes.txt' });
  assert.strictEqual(res.status, 400);
});

test('scratchpad open-file: missing path returns 400', async () => {
  const res = await request(app)
    .post(`/api/projects/${SLUG}/sessions/${SESSION_ID}/scratchpad/open-file`)
    .send({});
  assert.strictEqual(res.status, 400);
});

test('scratchpad open-file: path traversal returns 400', async () => {
  const res = await request(app)
    .post(`/api/projects/${SLUG}/sessions/${SESSION_ID}/scratchpad/open-file`)
    .send({ path: '../../../etc/passwd' });
  assert.strictEqual(res.status, 400);
});

test('scratchpad open-file: missing file returns 404', async () => {
  const res = await request(app)
    .post(`/api/projects/${SLUG}/sessions/${SESSION_ID}/scratchpad/open-file`)
    .send({ path: 'does-not-exist.txt' });
  assert.strictEqual(res.status, 404);
});

test('scratchpad open-file SKIPPED: spawns OS default app (side-effect)', { skip: true }, () => {});

// ── reveal-file endpoint ──────────────────────────────────────────────────────

test('scratchpad reveal-file: invalid params return 400', async () => {
  const res = await request(app)
    .post(`/api/projects/..bad/sessions/${SESSION_ID}/scratchpad/reveal-file`)
    .send({ path: 'notes.txt' });
  assert.strictEqual(res.status, 400);
});

test('scratchpad reveal-file: missing path returns 400', async () => {
  const res = await request(app)
    .post(`/api/projects/${SLUG}/sessions/${SESSION_ID}/scratchpad/reveal-file`)
    .send({});
  assert.strictEqual(res.status, 400);
});

test('scratchpad reveal-file: path traversal returns 400', async () => {
  const res = await request(app)
    .post(`/api/projects/${SLUG}/sessions/${SESSION_ID}/scratchpad/reveal-file`)
    .send({ path: '../../../etc/passwd' });
  assert.strictEqual(res.status, 400);
});

test('scratchpad reveal-file: missing file returns 404', async () => {
  const res = await request(app)
    .post(`/api/projects/${SLUG}/sessions/${SESSION_ID}/scratchpad/reveal-file`)
    .send({ path: 'does-not-exist.txt' });
  assert.strictEqual(res.status, 404);
});

test('scratchpad reveal-file SKIPPED: spawns OS file explorer (side-effect)', { skip: true }, () => {});
