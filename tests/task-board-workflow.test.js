const { test, before, beforeEach } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const request = require('supertest');
const { app, HOME, paths } = require('./helpers/app');
const wf = require('../lib/task-board-workflow');

const PROJECT_ROOT = path.join(HOME, 'wfproj');
const PLUGIN_ROOT = path.join(HOME, 'plugin-install');

function buildSlug(fullPath) {
  if (process.platform === 'win32') return fullPath[0] + '--' + fullPath.substring(3).split(path.sep).join('-');
  return fullPath.replace(/^\//, '').split('/').join('-');
}
const SLUG = buildSlug(PROJECT_ROOT);

function writeSkill(dir, name, description) {
  fs.mkdirSync(path.join(dir, name), { recursive: true });
  fs.writeFileSync(path.join(dir, name, 'SKILL.md'), `---\nname: ${name}\ndescription: ${description}\n---\nbody`);
}

before(() => {
  fs.rmSync(paths.SKILLS_DIR, { recursive: true, force: true });
  writeSkill(paths.SKILLS_DIR, 'code-review', 'Review the diff for bugs');
  writeSkill(path.join(PROJECT_ROOT, '.claude', 'skills'), 'writing-plans', 'Write an implementation plan');
  writeSkill(path.join(PLUGIN_ROOT, 'skills'), 'executing-plans', 'Execute a written plan step by step');
  fs.mkdirSync(path.join(PROJECT_ROOT, '.claude', 'agents'), { recursive: true });
  fs.writeFileSync(path.join(PROJECT_ROOT, '.claude', 'agents', 'tester.md'), '---\nname: tester\ndescription: Runs tests\n---\nbody');
  fs.mkdirSync(paths.PLUGINS_DIR, { recursive: true });
  fs.writeFileSync(path.join(paths.PLUGINS_DIR, 'installed_plugins.json'), JSON.stringify({
    version: 2,
    plugins: {
      'superpowers@market': [{ scope: 'user', installPath: PLUGIN_ROOT }],
      'other@market': [{ scope: 'project', projectPath: path.join(HOME, 'elsewhere'), installPath: PLUGIN_ROOT }]
    }
  }));
});

beforeEach(() => {
  fs.rmSync(paths.TASK_BOARD_FILE, { force: true });
});

const A = (kind, name, description, source = 'global') => ({ kind, name, description, source });

test('recommend picks one skill per phase by name, then description', () => {
  const stages = wf.recommend([
    A('skill', 'brainstorming', 'Explore ideas'),
    A('skill', 'test-driven-development', 'Write tests first'),
    A('skill', 'verification', 'Check work before finishing'),
    A('skill', 'code-review', 'Review changes'),
    A('agent', 'planner', 'Plans')
  ]);
  assert.deepStrictEqual(stages.map(s => [s.title, s.type, s.ref]), [
    ['Plan', 'skill', 'brainstorming'],
    ['Implement', 'skill', 'test-driven-development'],
    ['Test', 'skill', 'verification'],
    ['Review', 'skill', 'code-review']
  ]);
});

test('recommend falls back to prompts and skips Test when no skill name fits', () => {
  const stages = wf.recommend([
    A('skill', 'frontend-design', 'Design and implement UI, then test and review it'),
    A('skill', 'review-kit:helper', 'Helps', 'plugin')
  ]);
  assert.deepStrictEqual(stages.map(s => [s.title, s.type, s.ref]), [
    ['Plan', 'prompt', ''],
    ['Implement', 'prompt', ''],
    ['Review', 'prompt', '']
  ]);
  assert.ok(stages.every(s => s.prompt));
});

test('a matching description breaks a tie between matching names', () => {
  const stages = wf.recommend([A('skill', 'a-review', 'Formats code'), A('skill', 'b-review', 'Review changes for bugs')]);
  assert.strictEqual(stages.find(s => s.title === 'Review').ref, 'b-review');
});

test('recommend prefers a project skill over a global one with the same score', () => {
  const stages = wf.recommend([A('skill', 'b-review', 'x', 'global'), A('skill', 'a-review', 'x', 'plugin'), A('skill', 'z-review', 'x', 'project')]);
  assert.strictEqual(stages.find(s => s.title === 'Review').ref, 'z-review');
});

test('validateStages checks titles, types and references, and keeps valid ids', () => {
  const available = [A('skill', 'code-review', '')];
  assert.match(wf.validateStages('x', available).error, /list/);
  assert.match(wf.validateStages([{ title: '', type: 'prompt', prompt: 'x' }], available).error, /title is required/);
  assert.match(wf.validateStages([{ title: 'A', type: 'bash' }], available).error, /unknown type/);
  assert.match(wf.validateStages([{ title: 'A', type: 'prompt', prompt: ' ' }], available).error, /prompt is required/);
  assert.match(wf.validateStages([{ title: 'A', type: 'skill', ref: 'nope' }], available).error, /not available/);
  assert.match(wf.validateStages(new Array(11).fill({ title: 'A', type: 'prompt', prompt: 'x' }), available).error, /at most 10/);
  const { stages } = wf.validateStages([
    { id: 's-abc12345', title: ' Review ', type: 'skill', ref: 'code-review', prompt: '' },
    { id: 's-abc12345', title: 'Dup', type: 'prompt', ref: 'ignored', prompt: 'do it' },
    { id: 'todo', title: 'Bad id', type: 'prompt', prompt: 'x' }
  ], available);
  assert.strictEqual(stages[0].id, 's-abc12345');
  assert.strictEqual(stages[0].title, 'Review');
  assert.notStrictEqual(stages[1].id, 's-abc12345');
  assert.strictEqual(stages[1].ref, '');
  assert.match(stages[2].id, /^s-[0-9a-f]{8}$/);
});

test('validateStages checks conditions: text, count and a target that is a stage or Done', () => {
  const stage = (id, branches) => ({ id, title: 'A', type: 'prompt', prompt: 'x', branches });
  const err = branches => wf.validateStages([stage('s-aaaaaaaa', branches), stage('s-bbbbbbbb')], []).error;
  assert.match(err('x'), /stage 1: conditions must be a list/);
  assert.match(err([{ when: ' ', to: 'done' }]), /condition 1: text is required/);
  assert.match(err([{ when: 'x'.repeat(201), to: 'done' }]), /too long/);
  assert.match(err([{ when: 'bug', to: 's-cccccccc' }]), /unknown target stage/);
  assert.match(err(new Array(5).fill({ when: 'a', to: 'done' })), /at most 4 conditions/);
  const { stages } = wf.validateStages([
    stage('s-aaaaaaaa', [{ when: ' a bug ', to: 's-bbbbbbbb' }, { when: 'nothing', to: 'done' }]),
    stage('s-bbbbbbbb', [{ when: 'retry', to: 's-aaaaaaaa' }])
  ], []);
  assert.deepStrictEqual(stages[0].branches, [{ when: 'a bug', to: 's-bbbbbbbb' }, { when: 'nothing', to: 'done' }]);
  assert.deepStrictEqual(stages[1].branches, [{ when: 'retry', to: 's-aaaaaaaa' }]);
  assert.deepStrictEqual(wf.validateStages([{ title: 'A', type: 'prompt', prompt: 'x' }], []).stages[0].branches, []);
});

test('missingRefs lists stages whose skill or agent is gone', () => {
  const stages = [{ id: 's1', type: 'skill', ref: 'gone' }, { id: 's2', type: 'prompt', ref: '' }, { id: 's3', type: 'agent', ref: 'tester' }];
  assert.deepStrictEqual(wf.missingRefs(stages, [A('agent', 'tester', '')]), ['s1']);
});

test('available skills: project, global and user-scope plugin skills, plus agents', () => {
  const names = wf.availableFor(SLUG).map(a => `${a.kind}:${a.name}:${a.source}`).sort();
  assert.deepStrictEqual(names, [
    'agent:tester:project',
    'skill:code-review:global',
    'skill:superpowers:executing-plans:plugin',
    'skill:writing-plans:project'
  ]);
});

test('a plugin disabled in settings.json is left out', () => {
  const before = fs.existsSync(paths.SETTINGS_FILE) ? fs.readFileSync(paths.SETTINGS_FILE, 'utf-8') : null;
  fs.writeFileSync(paths.SETTINGS_FILE, JSON.stringify({ enabledPlugins: { 'superpowers@market': false } }));
  try {
    assert.ok(!wf.availableFor(SLUG).some(a => a.source === 'plugin'));
  } finally {
    if (before === null) fs.rmSync(paths.SETTINGS_FILE, { force: true });
    else fs.writeFileSync(paths.SETTINGS_FILE, before);
  }
});

test('GET workflow returns stages, available skills and the recommendation', async () => {
  await request(app).put('/api/task-board/lanes/' + SLUG).send({});
  const res = await request(app).get(`/api/task-board/lanes/${SLUG}/workflow`);
  assert.strictEqual(res.status, 200);
  assert.deepStrictEqual(res.body.stages, []);
  assert.deepStrictEqual(res.body.recommended.map(s => s.ref), ['writing-plans', 'superpowers:executing-plans', 'code-review']);
  assert.strictEqual(res.body.skillsChanged, false);
  assert.strictEqual((await request(app).get('/api/task-board/lanes/C--no-lane/workflow')).status, 404);
});

test('PUT workflow saves stages, which become the lane columns', async () => {
  await request(app).put('/api/task-board/lanes/' + SLUG).send({});
  const res = await request(app).put(`/api/task-board/lanes/${SLUG}/workflow`).send({ stages: [
    { title: 'Plan', type: 'skill', ref: 'writing-plans' },
    { title: 'Check', type: 'agent', ref: 'tester', prompt: 'run all tests' }
  ] });
  assert.strictEqual(res.status, 200, JSON.stringify(res.body));
  const board = (await request(app).get('/api/task-board')).body;
  assert.deepStrictEqual(board.projects[SLUG].stages.map(s => s.title), ['Plan', 'Check']);
  assert.deepStrictEqual(board.status[SLUG], { skillsChanged: false, missing: [] });
  const bad = await request(app).put(`/api/task-board/lanes/${SLUG}/workflow`).send({ stages: [{ title: 'X', type: 'skill', ref: 'nope' }] });
  assert.strictEqual(bad.status, 400);
});

test('a skill added after saving flags the lane until the change is dismissed', async () => {
  await request(app).put('/api/task-board/lanes/' + SLUG).send({});
  await request(app).put(`/api/task-board/lanes/${SLUG}/workflow`).send({ stages: [{ title: 'Plan', type: 'skill', ref: 'writing-plans' }] });
  writeSkill(paths.SKILLS_DIR, 'security-audit', 'Audit for vulnerabilities');
  try {
    let board = (await request(app).get('/api/task-board')).body;
    assert.strictEqual(board.status[SLUG].skillsChanged, true);
    assert.strictEqual((await request(app).post(`/api/task-board/lanes/${SLUG}/workflow/dismiss`)).status, 200);
    board = (await request(app).get('/api/task-board')).body;
    assert.strictEqual(board.status[SLUG].skillsChanged, false);
    assert.deepStrictEqual(board.projects[SLUG].stages.map(s => s.ref), ['writing-plans']);
  } finally {
    fs.rmSync(path.join(paths.SKILLS_DIR, 'security-audit'), { recursive: true, force: true });
  }
});

test('a removed skill marks its stage as missing', async () => {
  writeSkill(paths.SKILLS_DIR, 'temp-review', 'Review');
  await request(app).put('/api/task-board/lanes/' + SLUG).send({});
  const saved = await request(app).put(`/api/task-board/lanes/${SLUG}/workflow`).send({ stages: [{ title: 'Review', type: 'skill', ref: 'temp-review' }] });
  fs.rmSync(path.join(paths.SKILLS_DIR, 'temp-review'), { recursive: true, force: true });
  const board = (await request(app).get('/api/task-board')).body;
  assert.deepStrictEqual(board.status[SLUG].missing, [saved.body.stages[0].id]);
});

test('a stage that still holds tickets cannot be removed', async () => {
  await request(app).put('/api/task-board/lanes/' + SLUG).send({});
  const saved = (await request(app).put(`/api/task-board/lanes/${SLUG}/workflow`).send({ stages: [{ title: 'Plan', type: 'skill', ref: 'writing-plans' }] })).body;
  await request(app).post('/api/task-board/cards').send({ title: 'T', project: SLUG });
  const board = JSON.parse(fs.readFileSync(paths.TASK_BOARD_FILE, 'utf-8'));
  board.cards[0].column = saved.stages[0].id;
  fs.writeFileSync(paths.TASK_BOARD_FILE, JSON.stringify(board));
  const res = await request(app).put(`/api/task-board/lanes/${SLUG}/workflow`).send({ stages: [] });
  assert.strictEqual(res.status, 400);
  assert.match(res.body.error, /still has tickets/);
  const kept = await request(app).put(`/api/task-board/lanes/${SLUG}/workflow`).send({ stages: [Object.assign({}, saved.stages[0], { title: 'Planning' })] });
  assert.strictEqual(kept.status, 200);
});
