const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const request = require('supertest');
const { app, HOME } = require('./helpers/app');
const { CONTENT_MAX_BYTES } = require('../lib/project-files');

const PROJ_DIR = path.join(HOME, 'pf-test-project');

function slugForPath(p) {
  const win = p.match(/^([A-Za-z]):[\\\/](.*)/);
  if (win) return `${win[1].toUpperCase()}--${win[2].replace(/[\\\/\.]/g, '-')}`;
  return p.replace(/^\//, '').replace(/[\/\.]/g, '-');
}

const SLUG = slugForPath(PROJ_DIR);

before(() => {
  fs.mkdirSync(path.join(PROJ_DIR, 'src', 'nested'), { recursive: true });
  fs.mkdirSync(path.join(PROJ_DIR, 'empty-dir'), { recursive: true });
  fs.writeFileSync(path.join(PROJ_DIR, 'README.md'), '# Readme\n');
  fs.writeFileSync(path.join(PROJ_DIR, 'index.js'), 'console.log(1);\n');
  fs.writeFileSync(path.join(PROJ_DIR, '.env'), 'SECRET=x\n');
  fs.writeFileSync(path.join(PROJ_DIR, 'src', 'app.js'), 'const a = 1;\n');
  fs.writeFileSync(path.join(PROJ_DIR, 'src', 'nested', 'deep.txt'), 'deep\n');
  fs.mkdirSync(path.join(PROJ_DIR, 'chain', 'a', 'b', 'c'), { recursive: true });
  fs.writeFileSync(path.join(PROJ_DIR, 'chain', 'a', 'b', 'c', 'deep.txt'), 'deep\n');
  fs.mkdirSync(path.join(PROJ_DIR, 'forked', 'one'), { recursive: true });
  fs.mkdirSync(path.join(PROJ_DIR, 'forked', 'two'), { recursive: true });
  fs.writeFileSync(path.join(PROJ_DIR, 'binary.dat'), Buffer.from([0x00, 0x01, 0x02, 0xff]));
  fs.writeFileSync(path.join(PROJ_DIR, 'big.txt'), 'x'.repeat(CONTENT_MAX_BYTES + 10));
});

after(() => {
  fs.rmSync(PROJ_DIR, { recursive: true, force: true });
});

// ── tree ──────────────────────────────────────────────────────────────────────

test('tree: lists the project root with dirs before files', async () => {
  const res = await request(app).get(`/api/projects/${SLUG}/files/tree`);
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.path, '');
  const types = res.body.entries.map(e => e.type);
  assert.strictEqual(types.indexOf('file') > types.lastIndexOf('dir'), true, 'dirs must sort before files');
  const names = res.body.entries.map(e => e.name);
  assert.deepStrictEqual(names.filter(n => n === 'src' || n === 'empty-dir').sort(), ['empty-dir', 'src']);
  assert.ok(names.includes('index.js'));
});

test('tree: shows everything, including dotfiles', async () => {
  const res = await request(app).get(`/api/projects/${SLUG}/files/tree`);
  assert.ok(res.body.entries.some(e => e.name === '.env'));
});

test('tree: file entries carry size and mtime, dirs do not', async () => {
  const res = await request(app).get(`/api/projects/${SLUG}/files/tree`);
  const file = res.body.entries.find(e => e.name === 'index.js');
  const dir = res.body.entries.find(e => e.name === 'src');
  assert.strictEqual(file.size, Buffer.byteLength('console.log(1);\n'));
  assert.strictEqual(typeof file.mtime, 'number');
  assert.strictEqual(dir.size, undefined);
});

test('tree: lists a nested directory via ?path', async () => {
  const res = await request(app).get(`/api/projects/${SLUG}/files/tree`).query({ path: 'src' });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.path, 'src');
  assert.deepStrictEqual(res.body.entries.map(e => e.name), ['nested', 'app.js']);
});

test('tree: a chain of single-child folders is merged into one entry', async () => {
  const res = await request(app).get(`/api/projects/${SLUG}/files/tree`);
  const merged = res.body.entries.find(e => e.name.startsWith('chain'));
  assert.strictEqual(merged.name, 'chain/a/b/c', 'the whole empty chain becomes one row');
  assert.strictEqual(merged.type, 'dir');

  const inner = await request(app).get(`/api/projects/${SLUG}/files/tree`).query({ path: merged.name });
  assert.strictEqual(inner.status, 200);
  assert.deepStrictEqual(inner.body.entries.map(e => e.name), ['deep.txt']);
});

test('tree: merging stops at a folder that has files of its own', async () => {
  const res = await request(app).get(`/api/projects/${SLUG}/files/tree`);
  const names = res.body.entries.map(e => e.name);
  assert.ok(names.includes('src'), 'src has app.js, so it is not merged away');
  assert.strictEqual(names.some(n => n.startsWith('src/')), false);
});

test('tree: merging stops at a folder with more than one subfolder', async () => {
  const res = await request(app).get(`/api/projects/${SLUG}/files/tree`).query({ path: 'forked' });
  assert.deepStrictEqual(res.body.entries.map(e => e.name), ['one', 'two']);
});

test('tree: an empty directory returns an empty entry list', async () => {
  const res = await request(app).get(`/api/projects/${SLUG}/files/tree`).query({ path: 'empty-dir' });
  assert.strictEqual(res.status, 200);
  assert.deepStrictEqual(res.body.entries, []);
});

test('tree: path traversal is rejected', async () => {
  const res = await request(app).get(`/api/projects/${SLUG}/files/tree`).query({ path: '../..' });
  assert.strictEqual(res.status, 400);
});

test('tree: invalid slug is rejected', async () => {
  const res = await request(app).get('/api/projects/..bad/files/tree');
  assert.strictEqual(res.status, 400);
});

test('tree: unknown project returns 404', async () => {
  const res = await request(app).get('/api/projects/no-such-project-slug-here/files/tree');
  assert.strictEqual(res.status, 404);
});

test('tree: pointing at a file returns 404', async () => {
  const res = await request(app).get(`/api/projects/${SLUG}/files/tree`).query({ path: 'index.js' });
  assert.strictEqual(res.status, 404);
});

// ── content: read ─────────────────────────────────────────────────────────────

test('content: returns text with size and mtime', async () => {
  const res = await request(app).get(`/api/projects/${SLUG}/files/content`).query({ path: 'src/app.js' });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.content, 'const a = 1;\n');
  assert.strictEqual(res.body.path, 'src/app.js');
  assert.strictEqual(res.body.binary, false);
  assert.strictEqual(typeof res.body.mtime, 'number');
});

test('content: binary files are flagged, not returned', async () => {
  const res = await request(app).get(`/api/projects/${SLUG}/files/content`).query({ path: 'binary.dat' });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.binary, true);
  assert.strictEqual(res.body.content, undefined);
});

test('content: oversized files are flagged, not returned', async () => {
  const res = await request(app).get(`/api/projects/${SLUG}/files/content`).query({ path: 'big.txt' });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.tooLarge, true);
  assert.strictEqual(res.body.content, undefined);
});

test('content: missing file returns 404', async () => {
  const res = await request(app).get(`/api/projects/${SLUG}/files/content`).query({ path: 'nope.js' });
  assert.strictEqual(res.status, 404);
});

test('content: a directory is not readable as content', async () => {
  const res = await request(app).get(`/api/projects/${SLUG}/files/content`).query({ path: 'src' });
  assert.strictEqual(res.status, 404);
});

test('content: empty path is rejected', async () => {
  const res = await request(app).get(`/api/projects/${SLUG}/files/content`);
  assert.strictEqual(res.status, 400);
});

test('content: path traversal is rejected', async () => {
  const res = await request(app).get(`/api/projects/${SLUG}/files/content`).query({ path: '../../.claude/settings.json' });
  assert.strictEqual(res.status, 400);
});

// ── content: write ────────────────────────────────────────────────────────────

test('write: saves new content and reports the new size and mtime', async () => {
  const res = await request(app)
    .put(`/api/projects/${SLUG}/files/content`)
    .send({ path: 'src/app.js', content: 'const a = 2;\n' });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.ok, true);
  assert.strictEqual(res.body.size, Buffer.byteLength('const a = 2;\n'));
  assert.strictEqual(typeof res.body.mtime, 'number');
  assert.strictEqual(fs.readFileSync(path.join(PROJ_DIR, 'src', 'app.js'), 'utf-8'), 'const a = 2;\n');
});

test('write: an empty string clears the file', async () => {
  fs.writeFileSync(path.join(PROJ_DIR, 'clearme.txt'), 'content');
  const res = await request(app)
    .put(`/api/projects/${SLUG}/files/content`)
    .send({ path: 'clearme.txt', content: '' });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(fs.readFileSync(path.join(PROJ_DIR, 'clearme.txt'), 'utf-8'), '');
});

test('write: non-string content is rejected', async () => {
  const res = await request(app)
    .put(`/api/projects/${SLUG}/files/content`)
    .send({ path: 'index.js', content: { nope: true } });
  assert.strictEqual(res.status, 400);
  assert.strictEqual(fs.readFileSync(path.join(PROJ_DIR, 'index.js'), 'utf-8'), 'console.log(1);\n');
});

test('write: missing file is not created', async () => {
  const res = await request(app)
    .put(`/api/projects/${SLUG}/files/content`)
    .send({ path: 'created-by-put.js', content: 'x' });
  assert.strictEqual(res.status, 404);
  assert.strictEqual(fs.existsSync(path.join(PROJ_DIR, 'created-by-put.js')), false);
});

test('write: path traversal is rejected', async () => {
  const res = await request(app)
    .put(`/api/projects/${SLUG}/files/content`)
    .send({ path: '../../.claude/settings.json', content: '{}' });
  assert.strictEqual(res.status, 400);
});

test('write: invalid slug is rejected', async () => {
  const res = await request(app)
    .put('/api/projects/..bad/files/content')
    .send({ path: 'index.js', content: 'x' });
  assert.strictEqual(res.status, 400);
});

test('write: directory target is rejected', async () => {
  const res = await request(app)
    .put(`/api/projects/${SLUG}/files/content`)
    .send({ path: 'src', content: 'x' });
  assert.strictEqual(res.status, 404);
});
