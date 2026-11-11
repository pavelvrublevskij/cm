const { test, before, beforeEach, after } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const request = require('supertest');
const { app, HOME, paths } = require('./helpers/app');
const runner = require('../lib/task-board-runner');

const PROJECT_ROOT = path.join(HOME, 'runproj');
function buildSlug(fullPath) {
  if (process.platform === 'win32') return fullPath[0] + '--' + fullPath.substring(3).split(path.sep).join('-');
  return fullPath.replace(/^\//, '').split('/').join('-');
}
const SLUG = buildSlug(PROJECT_ROOT);
const SID = '11111111-2222-3333-4444-555555555555';
const wait = ms => new Promise(r => setTimeout(r, ms));

let spawned;
let bound;
let revealed;

function fakeEntry() {
  return {
    writes: [],
    lastOutputAt: 0,
    terminated: false,
    onEnd: null,
    term: { write(s) { this.owner.writes.push(s); } },
    terminate(reason) {
      if (this.terminated) return;
      this.terminated = true;
      if (this.onEnd) this.onEnd(reason || 'terminated');
    }
  };
}

function startDriver(readyDelayMs = 0) {
  runner.init({
    spawn: (projectPath, slug, opts) => {
      const entry = fakeEntry();
      entry.term.owner = entry;
      spawned.push({ projectPath, slug, opts, entry });
      return entry;
    },
    bind: (entry, id) => bound.push(id),
    reveal: (slug, id) => revealed.push([slug, id]),
    url: 'http://127.0.0.1:1',
    idleMs: 1,
    maxWaitMs: 10,
    enterDelayMs: 1,
    submitCheckMs: 1000,
    readyDelayMs
  });
}

const board = async () => (await request(app).get('/api/task-board')).body;
const cardOf = async id => (await board()).cards.find(c => c.id === id);
const pasted = entry => entry.writes.filter(w => w.startsWith('\x1b[200~')).map(w => w.slice(6, -6));

async function addTicket(fields) {
  const res = await request(app).post('/api/task-board/cards').send(Object.assign({ project: SLUG }, fields));
  return res.body.card;
}

async function setStages(titles) {
  await request(app).put('/api/task-board/lanes/' + SLUG).send({});
  const res = await request(app).put(`/api/task-board/lanes/${SLUG}/workflow`)
    .send({ stages: titles.map(t => ({ title: t, type: 'prompt', prompt: 'Do ' + t })) });
  assert.strictEqual(res.status, 200, JSON.stringify(res.body));
  return res.body.stages;
}

function hook(spawnIndex, event, extra) {
  const { opts } = spawned[spawnIndex];
  return request(app).post('/api/task-board/hook').send(Object.assign({
    card: opts.env.CM_BOARD_CARD, token: opts.env.CM_BOARD_TOKEN, event
  }, extra));
}

before(() => {
  fs.mkdirSync(PROJECT_ROOT, { recursive: true });
});

beforeEach(() => {
  runner._reset();
  fs.rmSync(paths.TASK_BOARD_FILE, { force: true });
  spawned = [];
  bound = [];
  revealed = [];
  startDriver();
});

after(() => runner._reset());

test('parseMarker reads the last CM-STAGE line, also inside markdown', () => {
  assert.deepStrictEqual({ ...runner.parseMarker('work\nCM-STAGE: done') }, { status: 'done', message: '' });
  assert.deepStrictEqual({ ...runner.parseMarker('**CM-STAGE: needs_input pick a db**') }, { status: 'needs_input', message: 'pick a db' });
  assert.strictEqual(runner.parseMarker('CM-STAGE: done\nlater\ncm-stage: conflict a.js').status, 'conflict');
  assert.strictEqual(runner.parseMarker('I am done.'), null);
  assert.strictEqual(runner.parseMarker('say CM-STAGE: done at the end'), null);
});

test('stageMessage leads with the ticket on stage 1 and names skills and agents', () => {
  const stages = [
    { title: 'Plan', type: 'skill', ref: 'writing-plans', prompt: 'keep it short' },
    { title: 'Check', type: 'agent', ref: 'tester', prompt: '' },
    { title: 'Ship', type: 'prompt', ref: '', prompt: 'Write the changelog' }
  ];
  const first = runner.stageMessage({ title: 'T', notes: 'ABC-1 fix login' }, stages, 0);
  assert.ok(first.startsWith('ABC-1 fix login\n\n[Task Board · stage 1/3: Plan]'));
  assert.match(first, /Use the "writing-plans" skill for this stage\.\nkeep it short/);
  assert.match(first, /CM-STAGE: done/);
  assert.match(runner.stageMessage({}, stages, 1), /^\[Task Board · stage 2\/3: Check\]\n\nUse the "tester" subagent/);
  assert.match(runner.stageMessage({}, stages, 2), /Write the changelog/);
  assert.strictEqual(runner.stageMessage({ title: 'Only title', notes: '' }, stages, 0).split('\n')[0], 'Only title');
});

test('moving a ticket to Ready starts claude with the hooks settings and enters stage 1', async () => {
  const stages = await setStages(['Plan', 'Build']);
  const card = await addTicket({ notes: 'ABC-1 fix login' });
  await request(app).post(`/api/task-board/cards/${card.id}/move`).send({ column: 'ready' });
  assert.strictEqual(spawned.length, 1);
  assert.strictEqual(spawned[0].projectPath, PROJECT_ROOT);
  assert.deepStrictEqual(spawned[0].opts.args, ['--settings', runner.HOOKS_FILE]);
  assert.strictEqual(spawned[0].opts.env.CM_BOARD_CARD, card.id);
  assert.match(spawned[0].opts.env.CM_BOARD_TOKEN, /^[0-9a-f]{32}$/);
  const hooks = JSON.parse(fs.readFileSync(runner.HOOKS_FILE, 'utf-8')).hooks;
  assert.deepStrictEqual(Object.keys(hooks), runner.HOOK_EVENTS);
  assert.match(hooks.Stop[0].hooks[0].command, /board-hook\.js"$/);
  const c = await cardOf(card.id);
  assert.strictEqual(c.column, stages[0].id);
  assert.strictEqual(c.run.status, 'starting');
});

test('a ticket waits its delay in Ready before it starts, and can be taken back meanwhile', async () => {
  runner._reset();
  startDriver(300);
  await setStages(['Plan']);
  const kept = await addTicket({ notes: 'kept' });
  const undone = await addTicket({ notes: 'undone' });
  await request(app).post(`/api/task-board/cards/${undone.id}/move`).send({ column: 'ready' });
  await request(app).post(`/api/task-board/cards/${undone.id}/move`).send({ column: 'todo' });
  await request(app).post(`/api/task-board/cards/${kept.id}/move`).send({ column: 'ready' });
  const waiting = await cardOf(kept.id);
  assert.strictEqual(waiting.column, 'ready');
  assert.ok(waiting.readyAt);
  assert.strictEqual((await board()).readyDelayMs, 300);
  assert.strictEqual(spawned.length, 0);
  await wait(500);
  assert.strictEqual(spawned.length, 1);
  assert.strictEqual(spawned[0].opts.env.CM_BOARD_CARD, kept.id);
  assert.strictEqual((await cardOf(undone.id)).readyAt, undefined);
});

test('hooks with a wrong token are refused', async () => {
  await setStages(['Plan']);
  const card = await addTicket({ notes: 'x' });
  await request(app).post(`/api/task-board/cards/${card.id}/move`).send({ column: 'ready' });
  const res = await request(app).post('/api/task-board/hook').send({ card: card.id, token: 'nope', event: 'Stop' });
  assert.strictEqual(res.status, 403);
});

test('SessionStart links the session and pastes the description with stage 1', async () => {
  await setStages(['Plan', 'Build']);
  const card = await addTicket({ notes: 'ABC-1 fix login' });
  await request(app).post(`/api/task-board/cards/${card.id}/move`).send({ column: 'ready' });
  await hook(0, 'SessionStart', { sessionId: SID });
  await wait(250);
  assert.deepStrictEqual(bound, [SID]);
  const c = await cardOf(card.id);
  assert.strictEqual(c.sessionId, SID);
  assert.strictEqual(c.run.status, 'running');
  const [first] = pasted(spawned[0].entry);
  assert.match(first, /^ABC-1 fix login\n\n\[Task Board · stage 1\/2: Plan\]/);
  assert.strictEqual(spawned[0].entry.writes[spawned[0].entry.writes.length - 1], '\r');
  await hook(0, 'SessionStart', { sessionId: 'aaaaaaaa-0000-0000-0000-000000000000' });
  assert.deepStrictEqual(bound, [SID], 'a later SessionStart (/clear) changes nothing');
});

test('Enter is pressed again until claude confirms the message was sent', async () => {
  runner._reset();
  runner.init({
    spawn: (projectPath, slug, opts) => { const e = fakeEntry(); e.term.owner = e; spawned.push({ opts, entry: e }); return e; },
    bind: () => {}, url: 'http://127.0.0.1:1', idleMs: 1, maxWaitMs: 10, enterDelayMs: 1, submitCheckMs: 40, readyDelayMs: 0
  });
  await setStages(['Plan']);
  const confirmed = await addTicket({ notes: 'first' });
  await request(app).post(`/api/task-board/cards/${confirmed.id}/move`).send({ column: 'ready' });
  await hook(0, 'SessionStart', { sessionId: SID });
  await wait(20);
  await hook(0, 'UserPromptSubmit', {});
  await wait(200);
  assert.strictEqual(spawned[0].entry.writes.filter(w => w === '\r').length, 1, 'confirmed after the first Enter');

  await request(app).post(`/api/task-board/cards/${confirmed.id}/stop`);
  const lost = await addTicket({ notes: 'second' });
  await request(app).post(`/api/task-board/cards/${lost.id}/move`).send({ column: 'ready' });
  await hook(1, 'SessionStart', { sessionId: 'bbbbbbbb-0000-0000-0000-000000000000' });
  await wait(300);
  assert.strictEqual(spawned[1].entry.writes.filter(w => w === '\r').length, 3);
  const c = await cardOf(lost.id);
  assert.deepStrictEqual([c.run.status, c.run.message], ['needs_input', 'The message was not sent — open the session and press Enter']);
});

test('Stop with CM-STAGE: done moves to the next stage and sends it', async () => {
  const stages = await setStages(['Plan', 'Build']);
  const card = await addTicket({ notes: 'x' });
  await request(app).post(`/api/task-board/cards/${card.id}/move`).send({ column: 'ready' });
  await hook(0, 'SessionStart', { sessionId: SID });
  await wait(250);
  await hook(0, 'Stop', { lastAssistantMessage: 'Plan written.\nCM-STAGE: done' });
  await wait(250);
  assert.strictEqual((await cardOf(card.id)).column, stages[1].id);
  assert.match(pasted(spawned[0].entry)[1], /^\[Task Board · stage 2\/2: Build\]/);
});

test('needs input: no marker, a question, a notification; running again after the answer', async () => {
  await setStages(['Plan']);
  const card = await addTicket({ notes: 'x' });
  await request(app).post(`/api/task-board/cards/${card.id}/move`).send({ column: 'ready' });
  await hook(0, 'SessionStart', { sessionId: SID });
  await hook(0, 'Stop', { lastAssistantMessage: 'Which database?' });
  let c = await cardOf(card.id);
  assert.strictEqual(c.run.status, 'needs_input');
  assert.match(c.run.message, /without reporting/);
  await hook(0, 'UserPromptSubmit', {});
  assert.strictEqual((await cardOf(card.id)).run.status, 'running');
  await hook(0, 'Notification', { message: 'Claude needs your permission to use Bash' });
  c = await cardOf(card.id);
  assert.deepStrictEqual([c.run.status, c.run.message], ['needs_input', 'Claude needs your permission to use Bash']);
  await hook(0, 'Stop', { lastAssistantMessage: 'CM-STAGE: conflict merge conflict in a.js' });
  c = await cardOf(card.id);
  assert.deepStrictEqual([c.run.status, c.run.message], ['conflict', 'merge conflict in a.js']);
});

test('the Stop result is read from the transcript when the hook does not carry it', async () => {
  await setStages(['Plan', 'Build']);
  const card = await addTicket({ notes: 'x' });
  await request(app).post(`/api/task-board/cards/${card.id}/move`).send({ column: 'ready' });
  await hook(0, 'SessionStart', { sessionId: SID });
  const dir = path.join(paths.PROJECTS_DIR, SLUG);
  fs.mkdirSync(dir, { recursive: true });
  const transcript = path.join(dir, SID + '.jsonl');
  fs.writeFileSync(transcript, [
    JSON.stringify({ type: 'user', message: { content: 'go' } }),
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Done.\nCM-STAGE: done' }] } }),
    JSON.stringify({ type: 'system', content: 'x' })
  ].join('\n') + '\n');
  await hook(0, 'Stop', { transcriptPath: transcript });
  assert.strictEqual((await cardOf(card.id)).run.status, 'running');
  assert.strictEqual(runner.lastAssistantText(path.join(HOME, 'outside.jsonl')), '');
});

test('after the last stage the ticket waits in Move to PR, claude ends, the next ticket starts', async () => {
  await setStages(['Plan']);
  const first = await addTicket({ title: 'Fix login', notes: 'ABC-1' });
  const second = await addTicket({ notes: 'ABC-2' });
  await request(app).post(`/api/task-board/cards/${first.id}/move`).send({ column: 'ready' });
  await request(app).post(`/api/task-board/cards/${second.id}/move`).send({ column: 'ready' });
  assert.strictEqual(spawned.length, 1, 'one ticket at a time per lane');
  assert.strictEqual((await cardOf(second.id)).column, 'ready');

  const dir = path.join(paths.PROJECTS_DIR, SLUG);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, SID + '.jsonl'), JSON.stringify({ type: 'user', message: { content: 'ABC-1' } }) + '\n');
  await hook(0, 'SessionStart', { sessionId: SID });
  await hook(0, 'Stop', { lastAssistantMessage: 'CM-STAGE: done' });

  const c = await cardOf(first.id);
  assert.strictEqual(c.column, 'move-to-pr');
  assert.strictEqual(c.run.status, 'done');
  assert.ok(spawned[0].entry.terminated);
  assert.strictEqual(spawned.length, 2);
  assert.strictEqual(spawned[1].opts.env.CM_BOARD_CARD, second.id);
  await wait(1200);
  assert.match(fs.readFileSync(path.join(dir, SID + '.jsonl'), 'utf-8'), /"customTitle":"Fix login"/);
});

test('a session that ends on its own sends the ticket back to ToDo, closed', async () => {
  await setStages(['Plan']);
  const card = await addTicket({ notes: 'x' });
  await request(app).post(`/api/task-board/cards/${card.id}/move`).send({ column: 'ready' });
  spawned[0].entry.terminate('exited (code 1)');
  const c = await cardOf(card.id);
  assert.strictEqual(c.column, 'todo');
  assert.strictEqual(c.closed, true);
  assert.match(c.run.message, /exited \(code 1\)/);
});

test('stop ends the session; the ticket goes back to ToDo, closed', async () => {
  await setStages(['Plan']);
  const card = await addTicket({ notes: 'x' });
  await request(app).post(`/api/task-board/cards/${card.id}/move`).send({ column: 'ready' });
  await hook(0, 'SessionStart', { sessionId: SID });
  assert.strictEqual((await request(app).get('/api/task-board/session/' + SID)).body.card.id, card.id);
  const res = await request(app).post(`/api/task-board/cards/${card.id}/stop`);
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.card.column, 'todo');
  assert.strictEqual(res.body.card.closed, true);
  assert.ok(spawned[0].entry.terminated);
  assert.strictEqual((await request(app).get('/api/task-board/session/' + SID)).body.card, null);
  assert.strictEqual((await request(app).post(`/api/task-board/cards/${card.id}/stop`)).status, 400);
});

test('on start-up, tickets left inside a workflow are closed and Ready ones start', async () => {
  const stages = await setStages(['Plan']);
  const stale = await addTicket({ notes: 'stale' });
  const waiting = await addTicket({ notes: 'waiting' });
  const data = JSON.parse(fs.readFileSync(paths.TASK_BOARD_FILE, 'utf-8'));
  data.cards.find(c => c.id === stale.id).column = stages[0].id;
  data.cards.find(c => c.id === waiting.id).column = 'ready';
  fs.writeFileSync(paths.TASK_BOARD_FILE, JSON.stringify(data));
  runner._reset();
  startDriver();
  const s = await cardOf(stale.id);
  assert.deepStrictEqual([s.column, s.closed, s.run.message], ['todo', true, 'Stopped: CM was restarted']);
  assert.strictEqual(spawned.length, 1);
  assert.strictEqual(spawned[0].opts.env.CM_BOARD_CARD, waiting.id);
});

test('the hook script reports a claude event to CM', async () => {
  await setStages(['Plan']);
  const card = await addTicket({ notes: 'x' });
  await request(app).post(`/api/task-board/cards/${card.id}/move`).send({ column: 'ready' });
  const server = app.listen(0, '127.0.0.1');
  await new Promise(r => server.once('listening', r));
  try {
    const env = Object.assign({}, process.env, spawned[0].opts.env, { CM_BOARD_URL: `http://127.0.0.1:${server.address().port}` });
    const child = spawn(process.execPath, [path.join(__dirname, '..', 'scripts', 'board-hook.js')], { env });
    child.stdin.end(JSON.stringify({ hook_event_name: 'Notification', session_id: SID, message: 'Waiting for permission' }));
    const code = await new Promise(r => child.on('exit', r));
    assert.strictEqual(code, 0);
    const c = await cardOf(card.id);
    assert.deepStrictEqual([c.run.status, c.run.message], ['needs_input', 'Waiting for permission']);
  } finally {
    server.close();
  }
});

test('the hook script does nothing outside a Task Board session', async () => {
  const env = Object.assign({}, process.env);
  delete env.CM_BOARD_URL;
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'scripts', 'board-hook.js')], { env });
  child.stdin.end('{}');
  assert.strictEqual(await new Promise(r => child.on('exit', r)), 0);
});

test('opening a running ticket reveals its session', async () => {
  await setStages(['Plan']);
  const card = await addTicket({ notes: 'x' });
  await request(app).post(`/api/task-board/cards/${card.id}/move`).send({ column: 'ready' });
  await hook(0, 'SessionStart', { sessionId: SID });
  assert.strictEqual((await request(app).post(`/api/task-board/cards/${card.id}/reveal`)).status, 200);
  assert.deepStrictEqual(revealed, [[SLUG, SID]]);
  assert.strictEqual((await request(app).post('/api/task-board/cards/nope/reveal')).status, 404);
});
