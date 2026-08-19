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

let hasSymlinkSupport = false;

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

  try {
    fs.symlinkSync(
      path.join(PROJ_DIR, 'src'),
      path.join(PROJ_DIR, 'linked-dir'),
      process.platform === 'win32' ? 'junction' : 'dir'
    );
    hasSymlinkSupport = true;
  } catch (_) {
    hasSymlinkSupport = false;
  }

  // Fixtures for the "pr" word-start matching rules: contiguous substrings match regardless of
  // case; non-contiguous matches only land on word-start letters (start of name, after a
  // separator, or a camelCase hump) — never on a letter merely sitting mid-word.
  const caseDir = path.join(PROJ_DIR, 'search-cases');
  fs.mkdirSync(caseDir, { recursive: true });
  ['PowerRanger.txt', 'P-Runner.txt', 'project-files.test.txt', 'printer.txt', 'supreme.txt', 'xxxpr.txt',
    'typeRunner.txt', 'Player.txt', 'pursue.txt',
    'Uncommitted_changes_before_Checkout_at_4_7_2026_10_43_AM__Changes_.xml'
  ].forEach(name => fs.writeFileSync(path.join(caseDir, name), 'x'));

  // Fixtures for content search: the filename itself never matches "needle" in any of these.
  const contentDir = path.join(PROJ_DIR, 'content-search');
  fs.mkdirSync(contentDir, { recursive: true });
  fs.writeFileSync(path.join(contentDir, 'unrelated-name.txt'), 'line one\nhas a NEEDLE in it\nline three\n');
  fs.writeFileSync(path.join(contentDir, 'no-match.txt'), 'nothing of interest here\n');
  fs.writeFileSync(path.join(contentDir, 'binary-file.bin'), Buffer.concat([
    Buffer.from([0x00, 0x01, 0x02]), Buffer.from('needle')
  ]));
  fs.writeFileSync(path.join(contentDir, 'oversized-file.txt'), 'needle'.padEnd(CONTENT_MAX_BYTES + 10, 'x'));
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

test('tree: a linked directory appears as a dir entry', async (t) => {
  if (!hasSymlinkSupport) return t.skip('symlinks unsupported in this environment');
  const res = await request(app).get(`/api/projects/${SLUG}/files/tree`);
  const linked = res.body.entries.find(e => e.name === 'linked-dir');
  assert.ok(linked, 'linked-dir should be listed');
  assert.strictEqual(linked.type, 'dir');
});

test('tree: contents of a linked directory are listed', async (t) => {
  if (!hasSymlinkSupport) return t.skip('symlinks unsupported in this environment');
  const res = await request(app).get(`/api/projects/${SLUG}/files/tree`).query({ path: 'linked-dir' });
  assert.strictEqual(res.status, 200);
  assert.deepStrictEqual(res.body.entries.map(e => e.name), ['nested', 'app.js']);
});

// ── search ────────────────────────────────────────────────────────────────────

test('search: a substring match is case-insensitive', async () => {
  const res = await request(app).get(`/api/projects/${SLUG}/files/search`).query({ q: 'read' });
  assert.strictEqual(res.status, 200);
  const paths = res.body.matches.map(m => m.path);
  assert.ok(paths.includes('README.md'));
});

test('search: only the first letter of an all-caps word is a matchable anchor', async () => {
  const res = await request(app).get(`/api/projects/${SLUG}/files/search`).query({ q: 'rme' });
  const paths = res.body.matches.map(m => m.path);
  assert.strictEqual(paths.includes('README.md'), false, 'R is a hump start but M and E mid-word are not');
});

test('search: matches directory names too, not just files', async () => {
  const res = await request(app).get(`/api/projects/${SLUG}/files/search`).query({ q: 'nest' });
  const match = res.body.matches.find(m => m.path === 'src/nested');
  assert.ok(match);
  assert.strictEqual(match.type, 'dir');
});

test('search: finds nested files by real filesystem path, ignoring tree merge display', async () => {
  const res = await request(app).get(`/api/projects/${SLUG}/files/search`).query({ q: 'deep' });
  const paths = res.body.matches.map(m => m.path);
  assert.ok(paths.includes('src/nested/deep.txt'));
  assert.ok(paths.includes('chain/a/b/c/deep.txt'));
});

test('search: "pr" matches a contiguous run regardless of case, in any position', async () => {
  const res = await request(app).get(`/api/projects/${SLUG}/files/search`).query({ q: 'pr' });
  const paths = res.body.matches.map(m => m.path);
  assert.ok(paths.includes('search-cases/printer.txt'), 'pr.. — contiguous at the start');
  assert.ok(paths.includes('search-cases/supreme.txt'), '..pr.. — contiguous in the middle');
  assert.ok(paths.includes('search-cases/xxxpr.txt'), '..pr — contiguous at the end');
});

test('search: "pr" matches non-contiguous letters when both land on word starts', async () => {
  const res = await request(app).get(`/api/projects/${SLUG}/files/search`).query({ q: 'pr' });
  const paths = res.body.matches.map(m => m.path);
  assert.ok(paths.includes('search-cases/PowerRanger.txt'), 'P..R.. — both letters are camelCase humps');
  assert.ok(paths.includes('search-cases/P-Runner.txt'), 'P..-R.. — a separator also marks a word start');
});

test('search: "pf" matches lowercase word initials split by a separator, not just camelCase humps', async () => {
  const res = await request(app).get(`/api/projects/${SLUG}/files/search`).query({ q: 'pf' });
  const paths = res.body.matches.map(m => m.path);
  assert.ok(paths.includes('search-cases/project-files.test.txt'), 'the p of "project" and the f right after the dash in "files"');
});

test('search: "pr" is case-insensitive on the query itself', async () => {
  const paths = {};
  for (const q of ['pr', 'Pr', 'pR', 'PR']) {
    const res = await request(app).get(`/api/projects/${SLUG}/files/search`).query({ q });
    paths[q] = res.body.matches.map(m => m.path).sort();
  }
  assert.deepStrictEqual(paths.pr, paths.Pr);
  assert.deepStrictEqual(paths.pr, paths.pR);
  assert.deepStrictEqual(paths.pr, paths.PR);
});

test('search: "pr" does not match through a letter that is merely sitting mid-word', async () => {
  const res = await request(app).get(`/api/projects/${SLUG}/files/search`).query({ q: 'pr' });
  const paths = res.body.matches.map(m => m.path);
  assert.strictEqual(paths.includes('search-cases/typeRunner.txt'), false, 'p..R.. — the p in "type" is mid-word, not a word start');
  assert.strictEqual(paths.includes('search-cases/Player.txt'), false, 'P..r.. — the r in "Player" is mid-word, not a word start');
  assert.strictEqual(paths.includes('search-cases/pursue.txt'), false, 'p..r — the r in "pursue" is mid-word, not a word start');
});

test('search: an unrelated all-caps token cannot supply an anchor for a later query letter', async () => {
  const res = await request(app).get(`/api/projects/${SLUG}/files/search`).query({ q: 'cm' });
  const paths = res.body.matches.map(m => m.path);
  assert.strictEqual(
    paths.includes('search-cases/Uncommitted_changes_before_Checkout_at_4_7_2026_10_43_AM__Changes_.xml'),
    false,
    'the C in "Checkout" is a real hump start, but the M in "AM" only continues that all-caps run — not a hump start of its own'
  );
});

// ── content search ────────────────────────────────────────────────────────────

test('search: a file whose contents match, but whose name does not, is still found', async () => {
  const res = await request(app).get(`/api/projects/${SLUG}/files/search`).query({ q: 'needle' });
  const match = res.body.matches.find(m => m.path === 'content-search/unrelated-name.txt');
  assert.ok(match);
  assert.strictEqual(match.matchedBy, 'content');
});

test('search: content matching is case-insensitive', async () => {
  const res = await request(app).get(`/api/projects/${SLUG}/files/search`).query({ q: 'NEEDLE' });
  const paths = res.body.matches.map(m => m.path);
  assert.ok(paths.includes('content-search/unrelated-name.txt'));
});

test('search: a name match reports matchedBy "name" even when content also happens to qualify', async () => {
  const res = await request(app).get(`/api/projects/${SLUG}/files/search`).query({ q: 'deep' });
  const match = res.body.matches.find(m => m.path === 'src/nested/deep.txt');
  assert.strictEqual(match.matchedBy, 'name');
});

test('search: content search skips binary files', async () => {
  const res = await request(app).get(`/api/projects/${SLUG}/files/search`).query({ q: 'needle' });
  const paths = res.body.matches.map(m => m.path);
  assert.strictEqual(paths.includes('content-search/binary-file.bin'), false);
});

test('search: content search skips oversized files', async () => {
  const res = await request(app).get(`/api/projects/${SLUG}/files/search`).query({ q: 'needle' });
  const paths = res.body.matches.map(m => m.path);
  assert.strictEqual(paths.includes('content-search/oversized-file.txt'), false);
});

test('search: a file matching neither name nor content is excluded', async () => {
  const res = await request(app).get(`/api/projects/${SLUG}/files/search`).query({ q: 'needle' });
  const paths = res.body.matches.map(m => m.path);
  assert.strictEqual(paths.includes('content-search/no-match.txt'), false);
});

test('search: excludes node_modules and .git from results', async () => {
  fs.mkdirSync(path.join(PROJ_DIR, 'node_modules', 'somepkg'), { recursive: true });
  fs.writeFileSync(path.join(PROJ_DIR, 'node_modules', 'somepkg', 'readme.js'), 'x');
  fs.mkdirSync(path.join(PROJ_DIR, '.git'), { recursive: true });
  fs.writeFileSync(path.join(PROJ_DIR, '.git', 'readme'), 'x');
  const res = await request(app).get(`/api/projects/${SLUG}/files/search`).query({ q: 'readme' });
  const paths = res.body.matches.map(m => m.path);
  assert.ok(!paths.some(p => p.startsWith('node_modules')));
  assert.ok(!paths.some(p => p.startsWith('.git')));
});

test('search: empty query returns no matches', async () => {
  const res = await request(app).get(`/api/projects/${SLUG}/files/search`).query({ q: '' });
  assert.strictEqual(res.status, 200);
  assert.deepStrictEqual(res.body.matches, []);
});

test('search: non-matching query returns no matches', async () => {
  const res = await request(app).get(`/api/projects/${SLUG}/files/search`).query({ q: 'zzzznomatch' });
  assert.deepStrictEqual(res.body.matches, []);
});

test('search: path traversal in slug is rejected', async () => {
  const res = await request(app).get('/api/projects/..bad/files/search').query({ q: 'a' });
  assert.strictEqual(res.status, 400);
});

test('search: finds files inside a linked directory', async (t) => {
  if (!hasSymlinkSupport) return t.skip('symlinks unsupported in this environment');
  const res = await request(app).get(`/api/projects/${SLUG}/files/search`).query({ q: 'app.js' });
  const paths = res.body.matches.map(m => m.path);
  assert.ok(paths.includes('linked-dir/app.js'));
});

test('search: unknown project returns 404', async () => {
  const res = await request(app).get('/api/projects/no-such-project-slug-here/files/search').query({ q: 'a' });
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
