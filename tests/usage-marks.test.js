const { test, before } = require('node:test');
const assert = require('node:assert');
const request = require('supertest');
const fs = require('fs');
const path = require('path');
const { app, paths } = require('./helpers/app');

const SLUG = 'usage-marks-proj';
const OTHER = 'usage-marks-other';

function entry(day, input) {
  return JSON.stringify({
    type: 'assistant',
    timestamp: day + 'T12:00:00Z',
    message: {
      model: 'claude-sonnet-4-6',
      usage: { input_tokens: input, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }
    }
  });
}

before(() => {
  const dir = path.join(paths.PROJECTS_DIR, SLUG);
  fs.mkdirSync(dir, { recursive: true });
  // Before the 2025-06-10 mark: 1000 tokens/day on two days. After: 500 tokens/day on two days.
  fs.writeFileSync(path.join(dir, 's1.jsonl'), [
    entry('2025-06-07', 1000), entry('2025-06-08', 1000),
    entry('2025-06-10', 500), entry('2025-06-11', 500)
  ].join('\n') + '\n');
  fs.mkdirSync(path.join(paths.PROJECTS_DIR, OTHER), { recursive: true });
});

test('POST /api/usage/marks validates date, title and window', async () => {
  let res = await request(app).post('/api/usage/marks').send({ date: '2025/06/10', title: 'x' });
  assert.strictEqual(res.status, 400);
  res = await request(app).post('/api/usage/marks').send({ date: '2025-06-10', title: '  ' });
  assert.strictEqual(res.status, 400);
  res = await request(app).post('/api/usage/marks').send({ date: '2025-06-10', title: 'x', window: 10 });
  assert.strictEqual(res.status, 400);
});

test('POST /api/usage/marks stores the chosen window, defaulting to 7 days', async () => {
  const dflt = await request(app).post('/api/usage/marks').send({ date: '2025-06-10', title: 'Default window' });
  assert.strictEqual(dflt.body.window, 7);
  const custom = await request(app).post('/api/usage/marks').send({ date: '2025-06-10', title: 'Two weeks', window: 14 });
  assert.strictEqual(custom.body.window, 14);
});

test('marks CRUD round-trip', async () => {
  const created = await request(app).post('/api/usage/marks')
    .send({ date: '2025-06-10', title: 'New skill', description: 'code optimization skill', project: SLUG });
  assert.strictEqual(created.status, 200);
  assert.ok(created.body.id);
  assert.strictEqual(created.body.project, SLUG);

  const updated = await request(app).put('/api/usage/marks/' + created.body.id)
    .send({ date: '2025-06-10', title: 'Renamed', description: '', project: SLUG });
  assert.strictEqual(updated.status, 200);
  assert.strictEqual(updated.body.title, 'Renamed');
  assert.strictEqual(updated.body.createdAt, created.body.createdAt);

  const del = await request(app).delete('/api/usage/marks/' + created.body.id);
  assert.strictEqual(del.status, 200);
  const again = await request(app).delete('/api/usage/marks/' + created.body.id);
  assert.strictEqual(again.status, 404);
  const missing = await request(app).put('/api/usage/marks/nope').send({ date: '2025-06-10', title: 'x' });
  assert.strictEqual(missing.status, 404);
});

test('marks are stored in the data dir, not in ~/.claude', async () => {
  await request(app).post('/api/usage/marks').send({ date: '2025-06-01', title: 'Stored' });
  assert.ok(fs.existsSync(paths.USAGE_MARKS_FILE));
  assert.ok(paths.USAGE_MARKS_FILE.startsWith(paths.DATA_DIR));
});

test('GET /api/usage/marks returns global marks plus marks of filtered projects only', async () => {
  const g = await request(app).post('/api/usage/marks').send({ date: '2025-06-02', title: 'Global one' });
  const p = await request(app).post('/api/usage/marks').send({ date: '2025-06-03', title: 'Proj one', project: SLUG });
  const o = await request(app).post('/api/usage/marks').send({ date: '2025-06-04', title: 'Other one', project: OTHER });

  const all = await request(app).get('/api/usage/marks');
  const allIds = all.body.marks.map(m => m.id);
  assert.ok(allIds.includes(g.body.id) && allIds.includes(p.body.id) && allIds.includes(o.body.id));

  const scoped = await request(app).get('/api/usage/marks?projects=' + SLUG);
  const ids = scoped.body.marks.map(m => m.id);
  assert.ok(ids.includes(g.body.id));
  assert.ok(ids.includes(p.body.id));
  assert.ok(!ids.includes(o.body.id));

  const dates = scoped.body.marks.map(m => m.date);
  assert.deepStrictEqual(dates, [...dates].sort());
});

test('mark impact compares the mark window before vs after, scoped to the mark project', async () => {
  const m = await request(app).post('/api/usage/marks').send({ date: '2025-06-10', title: 'Impact', project: SLUG });
  const res = await request(app).get('/api/usage/marks?projects=' + SLUG + '&from=2025-06-01&to=2025-06-30');
  const mark = res.body.marks.find(x => x.id === m.body.id);
  assert.strictEqual(mark.impact.window, 7);
  assert.strictEqual(mark.impact.before.from, '2025-06-03');
  assert.strictEqual(mark.impact.before.to, '2025-06-09');
  assert.strictEqual(mark.impact.after.from, '2025-06-10');
  assert.strictEqual(mark.impact.after.to, '2025-06-16');
  assert.strictEqual(mark.impact.after.partial, false);
  assert.strictEqual(mark.impact.before.activeDays, 2);
  assert.strictEqual(mark.impact.before.avgTokensPerDay, 1000);
  assert.strictEqual(mark.impact.after.activeDays, 2);
  assert.strictEqual(mark.impact.after.avgTokensPerDay, 500);
  assert.strictEqual(mark.impact.tokensChangePct, -50);
  assert.strictEqual(mark.projectName.length > 0, true);
});

test('mark impact with no usage before the mark reports null change', async () => {
  const m = await request(app).post('/api/usage/marks').send({ date: '2025-06-10', title: 'Empty', project: OTHER });
  const res = await request(app).get('/api/usage/marks?projects=' + OTHER);
  const mark = res.body.marks.find(x => x.id === m.body.id);
  assert.strictEqual(mark.impact.before.activeDays, 0);
  assert.strictEqual(mark.impact.tokensChangePct, null);
});

test('mark impact uses the window chosen for the mark, not the page period', async () => {
  const m = await request(app).post('/api/usage/marks').send({ date: '2025-06-10', title: 'Fortnight', project: SLUG, window: 14 });
  const res = await request(app).get('/api/usage/marks?projects=' + SLUG + '&from=2025-06-09&to=2025-06-12');
  const mark = res.body.marks.find(x => x.id === m.body.id);
  assert.strictEqual(mark.impact.window, 14);
  assert.strictEqual(mark.impact.before.from, '2025-05-27');
  assert.strictEqual(mark.impact.after.to, '2025-06-23');
  assert.strictEqual(mark.impact.before.activeDays, 2);
});

test('mark impact cuts the after window at today and flags it as partial', async () => {
  const d = new Date();
  d.setDate(d.getDate() - 2);
  const date = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  const m = await request(app).post('/api/usage/marks').send({ date, title: 'Recent' });
  const res = await request(app).get('/api/usage/marks');
  const mark = res.body.marks.find(x => x.id === m.body.id);
  assert.strictEqual(mark.impact.after.partial, true);
  assert.ok(mark.impact.after.to < '9999');
});

test('GET /api/usage/marks leaves out marks outside the period', async () => {
  const inside = await request(app).post('/api/usage/marks').send({ date: '2025-07-15', title: 'Inside' });
  const outside = await request(app).post('/api/usage/marks').send({ date: '2025-08-15', title: 'Outside' });
  const res = await request(app).get('/api/usage/marks?from=2025-07-01&to=2025-07-31');
  const ids = res.body.marks.map(x => x.id);
  assert.ok(ids.includes(inside.body.id));
  assert.ok(!ids.includes(outside.body.id));
});
