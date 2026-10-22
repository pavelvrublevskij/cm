const { test, before } = require('node:test');
const assert = require('node:assert');
const request = require('supertest');
const fs = require('fs');
const path = require('path');
const { app, paths } = require('./helpers/app');
const { modelSwitchSuggestions } = require('../lib/usage-mark-suggestions');

function today() {
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

before(() => {
  fs.mkdirSync(paths.PLUGINS_DIR, { recursive: true });
  fs.writeFileSync(path.join(paths.PLUGINS_DIR, 'installed_plugins.json'), JSON.stringify({
    version: 2,
    plugins: {
      'alpha@market': [{ scope: 'user', installedAt: '2025-05-10T09:00:00.000Z' }],
      'beta@market': [{ scope: 'user', installedAt: '2025-05-10T10:00:00.000Z' }],
      'gamma@market': [{ scope: 'user', installedAt: '2025-05-20T10:00:00.000Z' }]
    }
  }));
  fs.mkdirSync(path.join(paths.SKILLS_DIR, 'suggest-skill'), { recursive: true });
  fs.writeFileSync(path.join(paths.SKILLS_DIR, 'suggest-skill', 'SKILL.md'), '---\nname: suggest-skill\n---\n');
});

async function list(q) {
  const res = await request(app).get('/api/usage/mark-suggestions' + q);
  assert.strictEqual(res.status, 200);
  return res.body.suggestions;
}

test('plugin installs are suggested, same-day installs grouped into one', async () => {
  const s = await list('?from=2025-05-01&to=2025-05-31');
  const plugins = s.filter(x => x.type === 'plugin');
  assert.deepStrictEqual(plugins.map(x => x.title), ['Installed plugin gamma', 'Installed 2 plugins']);
  assert.strictEqual(plugins[1].description, 'alpha, beta');
  assert.strictEqual(plugins[1].project, null);
});

test('a changed skill is suggested on the day its SKILL.md changed', async () => {
  const s = await list('?from=' + today() + '&to=' + today());
  assert.ok(s.some(x => x.type === 'skill' && x.title.includes('suggest-skill')));
});

test('suggestions outside the period are left out', async () => {
  const s = await list('?from=2025-06-01&to=2025-06-30');
  assert.ok(!s.some(x => x.type === 'plugin'));
});

test('a dismissed suggestion stays hidden', async () => {
  const s = await list('?from=2025-05-20&to=2025-05-20');
  const gamma = s.find(x => x.title === 'Installed plugin gamma');
  const res = await request(app).post('/api/usage/mark-suggestions/dismiss').send({ key: gamma.key });
  assert.strictEqual(res.status, 200);
  const after = await list('?from=2025-05-20&to=2025-05-20');
  assert.ok(!after.some(x => x.key === gamma.key));
  const bad = await request(app).post('/api/usage/mark-suggestions/dismiss').send({});
  assert.strictEqual(bad.status, 400);
});

test('a suggestion that already has a mark is left out', async () => {
  const s = await list('?from=2025-05-10&to=2025-05-10');
  const grouped = s.find(x => x.title === 'Installed 2 plugins');
  await request(app).post('/api/usage/marks').send({ date: grouped.date, title: grouped.title });
  const after = await list('?from=2025-05-10&to=2025-05-10');
  assert.ok(!after.some(x => x.key === grouped.key));
});

test('a main-model switch is suggested only when the new model holds', () => {
  const hour = (day, model, input) => ({ [day + 'T12']: { [model]: { input_tokens: input, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } } });
  const index = { sessions: {
    a: { slug: 'p', hourly: { ...hour('2025-04-01', 'claude-opus-4-6', 1000) } },
    b: { slug: 'p', hourly: { ...hour('2025-04-02', 'claude-sonnet-4-6', 1000) } },
    c: { slug: 'p', hourly: { ...hour('2025-04-03', 'claude-sonnet-4-6', 1000) } },
    d: { slug: 'p', hourly: { ...hour('2025-04-04', 'claude-opus-4-6', 1000) } },
    e: { slug: 'p', hourly: { ...hour('2025-04-05', 'claude-sonnet-4-6', 1000) } }
  } };
  const out = modelSwitchSuggestions(index, new Set());
  assert.strictEqual(out.length, 1, 'the one-day Opus blip on 04-04 is not a switch');
  assert.strictEqual(out[0].title, 'Main model switched to sonnet-4-6');
});

test('a model switch is scoped to the project when exactly one is selected', () => {
  const hour = (day, model) => ({ [day + 'T12']: { [model]: { input_tokens: 1000, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } } });
  const index = { sessions: {
    a: { slug: 'p', hourly: hour('2025-04-01', 'claude-opus-4-6') },
    b: { slug: 'p', hourly: hour('2025-04-02', 'claude-sonnet-4-6') },
    c: { slug: 'p', hourly: hour('2025-04-03', 'claude-sonnet-4-6') },
    d: { slug: 'q', hourly: hour('2025-04-02', 'claude-opus-4-6') }
  } };
  const one = modelSwitchSuggestions(index, new Set(['p']));
  assert.strictEqual(one.length, 1);
  assert.strictEqual(one[0].project, 'p');
  const many = modelSwitchSuggestions(index, new Set(['p', 'q']));
  assert.ok(many.every(s => s.project === null), 'several projects: global, across all projects');
});
