const { test, beforeEach } = require('node:test');
const assert = require('node:assert');
const request = require('supertest');
const fs = require('fs');
const { app, paths } = require('./helpers/app');

const SLUG = 'C--work-task-board-proj';

beforeEach(() => {
  fs.rmSync(paths.TASK_BOARD_FILE, { force: true });
});

async function addCard(body) {
  const res = await request(app).post('/api/task-board/cards').send(body);
  assert.strictEqual(res.status, 200, JSON.stringify(res.body));
  return res.body.card;
}

function move(id, column, index) {
  return request(app).post(`/api/task-board/cards/${id}/move`).send({ column, index });
}

test('GET /api/task-board starts empty', async () => {
  const res = await request(app).get('/api/task-board');
  assert.strictEqual(res.status, 200);
  assert.deepStrictEqual(res.body, { cards: [], projects: {}, status: {} });
});

test('a new card lands in ToDo and adds its project lane', async () => {
  const card = await addCard({ title: ' Fix login ', notes: 'ABC-1 details', project: SLUG });
  assert.strictEqual(card.column, 'todo');
  assert.strictEqual(card.title, 'Fix login');
  assert.strictEqual(card.closed, false);
  assert.strictEqual(card.sessionId, null);
  const board = (await request(app).get('/api/task-board')).body;
  assert.strictEqual(board.cards.length, 1);
  assert.deepStrictEqual(board.projects[SLUG], { parallel: false });
});

test('title and description are optional, but a card cannot be empty', async () => {
  const titleOnly = await addCard({ title: 'Try an idea', project: SLUG });
  assert.strictEqual(titleOnly.notes, '');
  const notesOnly = await addCard({ notes: 'only notes', project: SLUG });
  assert.strictEqual(notesOnly.title, '');
  const res = await request(app).post('/api/task-board/cards').send({ title: ' ', notes: '  ', project: SLUG });
  assert.strictEqual(res.status, 400);
});

test('a card needs a project', async () => {
  const res = await request(app).post('/api/task-board/cards').send({ title: 'x' });
  assert.strictEqual(res.status, 400);
  assert.match(res.body.error, /project is required/);
});

test('an unsafe project slug is rejected', async () => {
  const res = await request(app).post('/api/task-board/cards').send({ title: 'x', project: '../etc' });
  assert.strictEqual(res.status, 400);
  assert.strictEqual((await request(app).put('/api/task-board/lanes/..%2Fetc').send({})).status, 400);
});

test('editing a card changes its fields but keeps its column and project', async () => {
  const card = await addCard({ title: 'Old', project: SLUG });
  const res = await request(app).put('/api/task-board/cards/' + card.id).send({ title: 'New', notes: 'n', project: null });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.card.title, 'New');
  assert.strictEqual(res.body.card.project, SLUG);
  assert.strictEqual(res.body.card.column, 'todo');
  assert.strictEqual((await request(app).put('/api/task-board/cards/nope').send({ title: 'x' })).status, 404);
});

test('by hand a card moves ToDo → Ready and back, never into the workflow or Done', async () => {
  const card = await addCard({ title: 'Task', project: SLUG });
  assert.strictEqual((await move(card.id, 'move-to-pr')).status, 400);
  assert.strictEqual((await move(card.id, 'done')).status, 400);
  assert.strictEqual((await move(card.id, 'nowhere')).status, 400);
  let res = await move(card.id, 'ready');
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.card.column, 'ready');
  res = await move(card.id, 'todo');
  assert.strictEqual(res.body.card.column, 'todo');
});

test('moving a closed card to Ready clears the closed mark', async () => {
  const card = await addCard({ title: 'Task', project: SLUG });
  const board = JSON.parse(fs.readFileSync(paths.TASK_BOARD_FILE, 'utf-8'));
  board.cards[0].closed = true;
  fs.writeFileSync(paths.TASK_BOARD_FILE, JSON.stringify(board));
  const res = await move(card.id, 'ready');
  assert.strictEqual(res.body.card.closed, false);
});

test('Move to PR → Done is allowed by hand', async () => {
  const card = await addCard({ title: 'Task', project: SLUG });
  const board = JSON.parse(fs.readFileSync(paths.TASK_BOARD_FILE, 'utf-8'));
  board.cards[0].column = 'move-to-pr';
  fs.writeFileSync(paths.TASK_BOARD_FILE, JSON.stringify(board));
  const res = await move(card.id, 'done');
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.card.column, 'done');
});

test('reordering inside a column puts the card at the given index within its lane', async () => {
  const a = await addCard({ title: 'A', project: SLUG });
  const other = await addCard({ title: 'Other lane', project: 'C--work-other' });
  const b = await addCard({ title: 'B', project: SLUG });
  const c = await addCard({ title: 'C', project: SLUG });
  await move(c.id, 'todo', 0);
  let titles = (await request(app).get('/api/task-board')).body.cards.filter(x => x.project === SLUG).map(x => x.title);
  assert.deepStrictEqual(titles, ['C', 'A', 'B']);
  await move(c.id, 'todo', 5);
  titles = (await request(app).get('/api/task-board')).body.cards.filter(x => x.project === SLUG).map(x => x.title);
  assert.deepStrictEqual(titles, ['A', 'B', 'C']);
  assert.ok(a && b && other);
});

test('cards are deleted only from ToDo or Done', async () => {
  const card = await addCard({ title: 'Task', project: SLUG });
  await move(card.id, 'ready');
  let res = await request(app).delete('/api/task-board/cards/' + card.id);
  assert.strictEqual(res.status, 400);
  await move(card.id, 'todo');
  res = await request(app).delete('/api/task-board/cards/' + card.id);
  assert.strictEqual(res.status, 200);
  assert.strictEqual((await request(app).get('/api/task-board')).body.cards.length, 0);
  assert.strictEqual((await request(app).delete('/api/task-board/cards/' + card.id)).status, 404);
});

test('lanes: add, set parallel, and remove only when empty', async () => {
  let res = await request(app).put('/api/task-board/lanes/' + SLUG).send({});
  assert.deepStrictEqual(res.body.lane, { parallel: false });
  res = await request(app).put('/api/task-board/lanes/' + SLUG).send({ parallel: true });
  assert.deepStrictEqual(res.body.lane, { parallel: true });
  const card = await addCard({ title: 'Task', project: SLUG });
  assert.strictEqual((await request(app).delete('/api/task-board/lanes/' + SLUG)).status, 400);
  await request(app).delete('/api/task-board/cards/' + card.id);
  assert.strictEqual((await request(app).delete('/api/task-board/lanes/' + SLUG)).status, 200);
  assert.deepStrictEqual((await request(app).get('/api/task-board')).body.projects, {});
});

test('the board is stored in data/, not in ~/.claude', async () => {
  await addCard({ title: 'Task', project: SLUG });
  assert.ok(fs.existsSync(paths.TASK_BOARD_FILE));
  assert.ok(paths.TASK_BOARD_FILE.startsWith(paths.DATA_DIR));
});
