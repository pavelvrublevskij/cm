const { test, before, after } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const request = require('supertest');
const AdmZip = require('adm-zip');
const { app, HOME, paths } = require('./helpers/app');
const { slugForPath } = require('./helpers/slug');

const SRC_ROOT = path.join(HOME, 'transfer-src');
const DST_ROOT = path.join(HOME, 'transfer-dst');
const SRC = slugForPath(SRC_ROOT);
const DST = slugForPath(DST_ROOT);

const binaryParser = (res, cb) => {
  const chunks = [];
  res.on('data', c => chunks.push(c));
  res.on('end', () => cb(null, Buffer.concat(chunks)));
};

function zipOf(files) {
  const zip = new AdmZip();
  for (const [name, body] of Object.entries(files)) zip.addFile(name, Buffer.from(body));
  return zip.toBuffer();
}

function postZip(url, buf) {
  return request(app).post(url).set('Content-Type', 'application/zip').send(buf);
}

before(() => {
  for (const root of [SRC_ROOT, DST_ROOT]) fs.rmSync(root, { recursive: true, force: true });
  fs.mkdirSync(path.join(SRC_ROOT, '.claude', 'agents'), { recursive: true });
  fs.writeFileSync(path.join(SRC_ROOT, '.claude', 'agents', 'tr-agent.md'), '---\nname: tr-agent\ndescription: d\n---\nbody');
  fs.mkdirSync(path.join(SRC_ROOT, '.claude', 'skills', 'tr-skill', 'refs'), { recursive: true });
  fs.writeFileSync(path.join(SRC_ROOT, '.claude', 'skills', 'tr-skill', 'SKILL.md'), '---\nname: tr-skill\n---\nskill');
  fs.writeFileSync(path.join(SRC_ROOT, '.claude', 'skills', 'tr-skill', 'refs', 'note.txt'), 'extra');
  fs.mkdirSync(DST_ROOT, { recursive: true });
});

after(() => {
  for (const root of [SRC_ROOT, DST_ROOT]) fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(path.join(paths.AGENTS_DIR, 'tr-agent.md'), { force: true });
  fs.rmSync(path.join(paths.SKILLS_DIR, 'tr-skill'), { recursive: true, force: true });
});

// --- Export ---

test('export project agents returns a zip of the .md files', async () => {
  const res = await request(app).get(`/api/agents/export/project/${SRC}`).buffer(true).parse(binaryParser);
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.headers['x-file-count'], '1');
  const names = new AdmZip(res.body).getEntries().map(e => e.entryName);
  assert.deepStrictEqual(names, ['tr-agent.md']);
});

test('export a single project skill includes its supporting files', async () => {
  const res = await request(app).get(`/api/skills/export/project/${SRC}?names=tr-skill`).buffer(true).parse(binaryParser);
  assert.strictEqual(res.status, 200);
  const names = new AdmZip(res.body).getEntries().filter(e => !e.isDirectory).map(e => e.entryName).sort();
  assert.deepStrictEqual(names, ['tr-skill/SKILL.md', 'tr-skill/refs/note.txt']);
});

test('export 404s for an unknown name and when the scope is empty', async () => {
  const missing = await request(app).get(`/api/skills/export/project/${SRC}?names=nope`);
  assert.strictEqual(missing.status, 404);
  const empty = await request(app).get(`/api/agents/export/project/${DST}`);
  assert.strictEqual(empty.status, 404);
});

test('export 400s on a name with path parts', async () => {
  const res = await request(app).get(`/api/agents/export/project/${SRC}?names=..%2Fx.md`);
  assert.strictEqual(res.status, 400);
});

// --- Import ---

test('import agents into a project, 409 on conflict, then overwrite', async () => {
  const buf = zipOf({ 'imp-agent.md': '---\nname: imp-agent\ndescription: d\n---\nv1' });
  const first = await postZip(`/api/agents/import/project/${DST}`, buf);
  assert.strictEqual(first.status, 200);
  assert.strictEqual(first.body.imported, 1);
  const file = path.join(DST_ROOT, '.claude', 'agents', 'imp-agent.md');
  assert.ok(fs.readFileSync(file, 'utf-8').includes('v1'));

  const buf2 = zipOf({ 'imp-agent.md': '---\nname: imp-agent\ndescription: d\n---\nv2' });
  const conflict = await postZip(`/api/agents/import/project/${DST}`, buf2);
  assert.strictEqual(conflict.status, 409);
  assert.deepStrictEqual(conflict.body.conflicts, ['imp-agent.md']);
  assert.ok(fs.readFileSync(file, 'utf-8').includes('v1'));

  const over = await postZip(`/api/agents/import/project/${DST}?overwrite=1`, buf2);
  assert.strictEqual(over.status, 200);
  assert.ok(fs.readFileSync(file, 'utf-8').includes('v2'));
});

test('import skills writes whole folders and overwrite replaces the folder', async () => {
  const buf = zipOf({ 'imp-skill/SKILL.md': '---\nname: imp-skill\n---\nv1', 'imp-skill/a/b.txt': 'old' });
  const res = await postZip(`/api/skills/import/project/${DST}`, buf);
  assert.strictEqual(res.status, 200);
  const dir = path.join(DST_ROOT, '.claude', 'skills', 'imp-skill');
  assert.strictEqual(fs.readFileSync(path.join(dir, 'a', 'b.txt'), 'utf-8'), 'old');

  const buf2 = zipOf({ 'imp-skill/SKILL.md': '---\nname: imp-skill\n---\nv2' });
  const over = await postZip(`/api/skills/import/project/${DST}?overwrite=1`, buf2);
  assert.strictEqual(over.status, 200);
  assert.ok(fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf-8').includes('v2'));
  assert.ok(!fs.existsSync(path.join(dir, 'a', 'b.txt')));
});

test('import skills rejects paths that climb out of the folder', async () => {
  const zip = new AdmZip();
  zip.addFile('evil/SKILL.md', Buffer.from('x'));
  zip.addFile('evil/placeholder', Buffer.from('x'));
  zip.getEntry('evil/placeholder').entryName = 'evil/../../escape.txt';
  const res = await postZip(`/api/skills/import/project/${DST}`, zip.toBuffer());
  assert.strictEqual(res.status, 400);
  assert.ok(!fs.existsSync(path.join(DST_ROOT, '.claude', 'escape.txt')));
});

test('import rejects names Windows cannot store, before touching existing items', async () => {
  const dir = path.join(DST_ROOT, '.claude', 'skills', 'keep-skill');
  fs.mkdirSync(path.join(dir, 'refs'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), 'old');
  fs.writeFileSync(path.join(dir, 'refs', 'r.txt'), 'old ref');
  const buf = zipOf({ 'keep-skill/SKILL.md': 'new', 'keep-skill/notes?.md': 'x' });
  const res = await postZip(`/api/skills/import/project/${DST}?overwrite=1`, buf);
  assert.strictEqual(res.status, 400);
  assert.strictEqual(fs.readFileSync(path.join(dir, 'refs', 'r.txt'), 'utf-8'), 'old ref');

  for (const bad of ['a:b.md', 'a|b.md', 'a"b.md']) {
    const r = await postZip(`/api/agents/import/project/${DST}`, zipOf({ [bad]: 'x' }));
    assert.strictEqual(r.status, 400, bad);
  }
});

test('overwriting several skills backs up each whole folder', async () => {
  const skills = path.join(DST_ROOT, '.claude', 'skills');
  for (const n of ['bk-one', 'bk-two']) {
    fs.mkdirSync(path.join(skills, n, 'refs'), { recursive: true });
    fs.writeFileSync(path.join(skills, n, 'SKILL.md'), `old ${n}`);
    fs.writeFileSync(path.join(skills, n, 'refs', 'r.txt'), `ref ${n}`);
  }
  const buf = zipOf({ 'bk-one/SKILL.md': 'new', 'bk-two/SKILL.md': 'new' });
  const res = await postZip(`/api/skills/import/project/${DST}?overwrite=1`, buf);
  assert.strictEqual(res.status, 200);
  for (const n of ['bk-one', 'bk-two']) {
    const backups = fs.readdirSync(paths.BACKUPS_DIR).filter(f => f.startsWith(n + '.'));
    assert.strictEqual(backups.length, 1, n);
    const b = path.join(paths.BACKUPS_DIR, backups[0]);
    assert.strictEqual(fs.readFileSync(path.join(b, 'SKILL.md'), 'utf-8'), `old ${n}`);
    assert.strictEqual(fs.readFileSync(path.join(b, 'refs', 'r.txt'), 'utf-8'), `ref ${n}`);
  }
  assert.ok(!fs.readdirSync(skills).some(f => f.startsWith('.import-')));
});

test('export of one skill whose name contains a comma', async () => {
  const dir = path.join(SRC_ROOT, '.claude', 'skills', 'a,b');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), 'x');
  const res = await request(app).get(`/api/skills/export/project/${SRC}?names=${encodeURIComponent('a,b')}`).buffer(true).parse(binaryParser);
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.headers['x-file-count'], '1');
  fs.rmSync(dir, { recursive: true });
});

test('import 400s on empty body, bad zip and a zip with nothing to import', async () => {
  const empty = await postZip(`/api/agents/import/global`, Buffer.alloc(0));
  assert.strictEqual(empty.status, 400);
  const bad = await postZip(`/api/agents/import/global`, Buffer.from('not a zip'));
  assert.strictEqual(bad.status, 400);
  const none = await postZip(`/api/skills/import/global`, zipOf({ 'loose.md': 'x' }));
  assert.strictEqual(none.status, 400);
});

// --- Copy ---

test('copy a project agent to global', async () => {
  const res = await request(app).post(`/api/agents/copy/project/${SRC}/tr-agent.md`).send({ target: 'global' });
  assert.strictEqual(res.status, 200);
  assert.ok(fs.existsSync(path.join(paths.AGENTS_DIR, 'tr-agent.md')));
});

test('copy a project skill to another project with its files, 409 then overwrite', async () => {
  const url = `/api/skills/copy/project/${SRC}/tr-skill`;
  const res = await request(app).post(url).send({ target: DST });
  assert.strictEqual(res.status, 200);
  const dir = path.join(DST_ROOT, '.claude', 'skills', 'tr-skill');
  assert.strictEqual(fs.readFileSync(path.join(dir, 'refs', 'note.txt'), 'utf-8'), 'extra');

  const again = await request(app).post(url).send({ target: DST });
  assert.strictEqual(again.status, 409);
  assert.deepStrictEqual(again.body.conflicts, ['tr-skill']);

  const over = await request(app).post(url + '?overwrite=1').send({ target: DST });
  assert.strictEqual(over.status, 200);
});

test('copy a global skill to a project', async () => {
  fs.mkdirSync(path.join(paths.SKILLS_DIR, 'tr-skill'), { recursive: true });
  fs.writeFileSync(path.join(paths.SKILLS_DIR, 'tr-skill', 'SKILL.md'), '---\nname: tr-skill\n---\nglobal');
  fs.rmSync(path.join(DST_ROOT, '.claude', 'skills', 'tr-skill'), { recursive: true, force: true });
  const res = await request(app).post(`/api/skills/copy/global/tr-skill`).send({ target: DST });
  assert.strictEqual(res.status, 200);
  assert.ok(fs.readFileSync(path.join(DST_ROOT, '.claude', 'skills', 'tr-skill', 'SKILL.md'), 'utf-8').includes('global'));
});

test('copy 404s for a missing item, 400s without target or onto itself', async () => {
  const missing = await request(app).post(`/api/agents/copy/project/${SRC}/nope.md`).send({ target: DST });
  assert.strictEqual(missing.status, 404);
  const noTarget = await request(app).post(`/api/agents/copy/project/${SRC}/tr-agent.md`).send({});
  assert.strictEqual(noTarget.status, 400);
  const same = await request(app).post(`/api/agents/copy/project/${SRC}/tr-agent.md`).send({ target: SRC });
  assert.strictEqual(same.status, 400);
});

test('sameDir sees one folder through another letter case (Windows) and through a link', () => {
  const { sameDir } = require('../lib/config-transfer');
  const real = path.join(SRC_ROOT, '.claude', 'agents');
  if (process.platform === 'win32') assert.ok(sameDir(real, real.toUpperCase()));
  const link = path.join(HOME, 'transfer-link');
  fs.rmSync(link, { recursive: true, force: true });
  fs.symlinkSync(SRC_ROOT, link, 'junction');
  try {
    assert.ok(sameDir(real, path.join(link, '.claude', 'agents')));
    assert.ok(!sameDir(real, path.join(DST_ROOT, '.claude', 'agents')));
  } finally { fs.unlinkSync(link); }
});

test('an item called "export" still opens through the regular route', async () => {
  fs.mkdirSync(path.join(SRC_ROOT, '.claude', 'skills', 'export'), { recursive: true });
  fs.writeFileSync(path.join(SRC_ROOT, '.claude', 'skills', 'export', 'SKILL.md'), '---\nname: export\n---\nx');
  const res = await request(app).get(`/api/skills/project/${SRC}/export`);
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.name, 'export');
});
