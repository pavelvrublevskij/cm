const { test, before } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const request = require('supertest');
const { app, HOME, paths } = require('./helpers/app');

function buildSlug(fullPath) {
  if (process.platform === 'win32') return fullPath[0] + '--' + fullPath.substring(3).split(path.sep).join('-');
  return fullPath.replace(/^\//, '').split('/').join('-');
}

const PROJECT = path.join(HOME, 'agents-traversal-proj');
const SLUG = buildSlug(PROJECT);

before(() => {
  fs.rmSync(paths.AGENTS_DIR, { recursive: true, force: true });
  fs.mkdirSync(path.join(PROJECT, '.claude', 'agents'), { recursive: true });
  fs.writeFileSync(path.join(PROJECT, 'secret.md'), '---\nname: x\n---\nnot an agent');
});

const AGENT = {
  frontmatter: { name: 'code-reviewer', description: 'Reviews code for quality; use after code changes.', model: 'sonnet', effort: 'high', color: 'blue' },
  content: 'You are a careful reviewer.'
};

test('GET /api/agents/global is empty when ~/.claude/agents does not exist', async () => {
  const res = await request(app).get('/api/agents/global');
  assert.strictEqual(res.status, 200);
  assert.deepStrictEqual(res.body, []);
});

test('a global agent is created in ~/.claude/agents and listed with clean frontmatter', async () => {
  const put = await request(app).put('/api/agents/global/code-reviewer.md').send(AGENT);
  assert.strictEqual(put.status, 200);
  const file = path.join(paths.AGENTS_DIR, 'code-reviewer.md');
  assert.ok(fs.existsSync(file));
  const text = fs.readFileSync(file, 'utf-8');
  assert.match(text, /name: code-reviewer/);
  assert.match(text, /model: sonnet/);
  assert.match(text, /effort: high/);

  const list = await request(app).get('/api/agents/global');
  const a = list.body.find(x => x.filename === 'code-reviewer.md');
  assert.strictEqual(a.name, 'code-reviewer');
  assert.strictEqual(a.content, 'You are a careful reviewer.');
  assert.ok(!('content' in a.frontmatter) && !('filename' in a.frontmatter), 'frontmatter holds only YAML keys');

  const one = await request(app).get('/api/agents/global/code-reviewer.md');
  assert.strictEqual(one.body.frontmatter.color, 'blue');
});

test('saving an agent without a name or description is refused', async () => {
  let res = await request(app).put('/api/agents/global/x.md').send({ frontmatter: { description: 'd' }, content: '' });
  assert.strictEqual(res.status, 400);
  assert.match(res.body.error, /name is required/);
  res = await request(app).put('/api/agents/global/x.md').send({ frontmatter: { name: 'x', description: ' ' }, content: '' });
  assert.strictEqual(res.status, 400);
  assert.match(res.body.error, /description is required/);
  assert.ok(!fs.existsSync(path.join(paths.AGENTS_DIR, 'x.md')));
});

test('agent file names cannot leave the agents folder (global and project)', async () => {
  for (const bad of ['..%2Fsecret.md', '..%5Csecret.md', 'agent.txt']) {
    assert.strictEqual((await request(app).get('/api/agents/global/' + bad)).status, 400, 'global GET ' + bad);
    assert.strictEqual((await request(app).get(`/api/agents/project/${SLUG}/${bad}`)).status, 400, 'project GET ' + bad);
    assert.strictEqual((await request(app).delete(`/api/agents/project/${SLUG}/${bad}`)).status, 400, 'project DELETE ' + bad);
    assert.strictEqual((await request(app).put(`/api/agents/project/${SLUG}/${bad}`).send(AGENT)).status, 400, 'project PUT ' + bad);
  }
  assert.ok(fs.existsSync(path.join(PROJECT, 'secret.md')), 'the file outside the agents folder is untouched');
});

test('a global agent can be deleted', async () => {
  await request(app).put('/api/agents/global/temp.md').send(AGENT);
  const del = await request(app).delete('/api/agents/global/temp.md');
  assert.strictEqual(del.status, 200);
  assert.ok(!fs.existsSync(path.join(paths.AGENTS_DIR, 'temp.md')));
  assert.strictEqual((await request(app).delete('/api/agents/global/temp.md')).status, 404);
});
