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
    readyDelayMs,
    cleanupDelayMs: 1
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

test('after the last stage the ticket goes to Done, claude ends, the next ticket starts', async () => {
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
  assert.strictEqual(c.column, 'done');
  assert.strictEqual(c.run.status, 'done');
  assert.ok(spawned[0].entry.terminated);
  assert.strictEqual(spawned.length, 2);
  assert.strictEqual(spawned[1].opts.env.CM_BOARD_CARD, second.id);
  await wait(1200);
  assert.match(fs.readFileSync(path.join(dir, SID + '.jsonl'), 'utf-8'), /"customTitle":"Fix login"/);
});

test('parseMarker reads the condition number of a done line', () => {
  assert.strictEqual(runner.parseMarker('CM-STAGE: done #2').branch, 2);
  assert.strictEqual(runner.parseMarker('**CM-STAGE: done #1**').branch, 1);
  assert.strictEqual(runner.parseMarker('CM-STAGE: done').branch, undefined);
  assert.strictEqual(runner.parseMarker('CM-STAGE: needs_input #2 which').branch, undefined);
});

test('stageMessage lists the conditions with their done lines and the otherwise line', () => {
  const stages = [{ title: 'Triage', type: 'prompt', prompt: 'Look at it', branches: [{ when: 'it is a bug', to: 'done' }, { when: 'docs only', to: 'done' }] }];
  const msg = runner.stageMessage({}, stages, 0);
  assert.match(msg, /- if it is a bug: "CM-STAGE: done #1"\n- if docs only: "CM-STAGE: done #2"\n- otherwise: "CM-STAGE: done"/);
  assert.ok(!msg.includes('end your reply with the line "CM-STAGE: done"'));
});

/** Triage → Feature → Bugfix, where Triage jumps to Bugfix for a bug and Bugfix can loop back to itself. */
async function setBranchingStages() {
  await request(app).put('/api/task-board/lanes/' + SLUG).send({});
  const res = await request(app).put(`/api/task-board/lanes/${SLUG}/workflow`).send({ stages: [
    { id: 's-triage00', title: 'Triage', type: 'prompt', prompt: 'Triage', branches: [{ when: 'it is a bug', to: 's-bugfix00' }, { when: 'nothing to do', to: 'done' }] },
    { id: 's-feature0', title: 'Feature', type: 'prompt', prompt: 'Build it' },
    { id: 's-bugfix00', title: 'Bugfix', type: 'prompt', prompt: 'Fix it', branches: [{ when: 'tests still fail', to: 's-bugfix00' }] }
  ] });
  assert.strictEqual(res.status, 200, JSON.stringify(res.body));
}

async function startTicket() {
  const card = await addTicket({ notes: 'x' });
  await request(app).post(`/api/task-board/cards/${card.id}/move`).send({ column: 'ready' });
  await hook(0, 'SessionStart', { sessionId: SID });
  return card;
}

test('a condition jumps to its target stage and the card shows it', async () => {
  await setBranchingStages();
  const card = await startTicket();
  await hook(0, 'Stop', { lastAssistantMessage: 'A bug.\nCM-STAGE: done #1' });
  const c = await cardOf(card.id);
  assert.strictEqual(c.column, 's-bugfix00');
  assert.deepStrictEqual(c.branch, { from: 'Triage', when: 'it is a bug' });
  await wait(250);
  assert.match(pasted(spawned[0].entry)[1], /^\[Task Board · stage 3\/3: Bugfix\]/);
});

test('without a condition number the ticket goes to the next stage', async () => {
  await setBranchingStages();
  const card = await startTicket();
  await hook(0, 'Stop', { lastAssistantMessage: 'CM-STAGE: done' });
  const c = await cardOf(card.id);
  assert.strictEqual(c.column, 's-feature0');
  assert.strictEqual(c.branch, null);
});

test('a condition can send the ticket straight to Done', async () => {
  await setBranchingStages();
  const card = await startTicket();
  await hook(0, 'Stop', { lastAssistantMessage: 'CM-STAGE: done #2' });
  assert.strictEqual((await cardOf(card.id)).column, 'done');
  assert.ok(spawned[0].entry.terminated);
});

test('a stage that loops stops at the visit limit and waits for the user', async () => {
  await setBranchingStages();
  const card = await startTicket();
  await hook(0, 'Stop', { lastAssistantMessage: 'CM-STAGE: done #1' });
  for (let i = 1; i < runner.MAX_STAGE_VISITS; i++) await hook(0, 'Stop', { lastAssistantMessage: 'CM-STAGE: done #1' });
  assert.strictEqual((await cardOf(card.id)).visits['s-bugfix00'], runner.MAX_STAGE_VISITS);
  await hook(0, 'Stop', { lastAssistantMessage: 'CM-STAGE: done #1' });
  const c = await cardOf(card.id);
  assert.strictEqual(c.column, 's-bugfix00');
  assert.strictEqual(c.run.status, 'needs_input');
  assert.match(c.run.message, /Loop limit: stage "Bugfix" already ran 3 times/);
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

// ── Parallel lanes ──────────────────────────────────────────────────────────

const GIT_ROOT = path.join(HOME, 'gitproj');
const GIT_SLUG = buildSlug(GIT_ROOT);

async function parallelLane(slug, titles) {
  await request(app).put('/api/task-board/lanes/' + slug).send({ parallel: true });
  const res = await request(app).put(`/api/task-board/lanes/${slug}/workflow`)
    .send({ stages: titles.map(t => ({ title: t, type: 'prompt', prompt: 'Do ' + t })) });
  assert.strictEqual(res.status, 200, JSON.stringify(res.body));
}

async function readyTickets(slug, count) {
  const cards = [];
  for (let i = 0; i < count; i++) {
    const card = (await request(app).post('/api/task-board/cards').send({ project: slug, notes: 'ticket ' + i })).body.card;
    await request(app).post(`/api/task-board/cards/${card.id}/move`).send({ column: 'ready' });
    cards.push(card);
  }
  return cards;
}

function resetMaxParallel() {
  const config = JSON.parse(fs.existsSync(paths.APP_CONFIG_FILE) ? fs.readFileSync(paths.APP_CONFIG_FILE, 'utf-8') : '{}');
  delete config.boardMaxParallel;
  fs.writeFileSync(paths.APP_CONFIG_FILE, JSON.stringify(config));
}

test('the parallel limit is a CM setting: 3 by default, 1 to 10', async () => {
  resetMaxParallel();
  assert.deepStrictEqual((await request(app).get('/api/task-board/settings')).body, { maxParallel: 3 });
  for (const bad of [0, 11, 2.5, 'x']) {
    assert.strictEqual((await request(app).put('/api/task-board/settings').send({ maxParallel: bad })).status, 400);
  }
  assert.deepStrictEqual((await request(app).put('/api/task-board/settings').send({ maxParallel: 5 })).body, { maxParallel: 5 });
  assert.strictEqual((await request(app).get('/api/task-board/settings')).body.maxParallel, 5);
  resetMaxParallel();
});

const { execFileSync } = require('node:child_process');
const sh = (args, cwd) => execFileSync('git', args, { cwd, encoding: 'utf-8' }).trim();

/** A real repo checked out on "feature-x" (not the default branch), so worktrees must start from it. */
function makeRepo() {
  fs.rmSync(GIT_ROOT, { recursive: true, force: true });
  fs.mkdirSync(GIT_ROOT, { recursive: true });
  sh(['init', '-q', '-b', 'main'], GIT_ROOT);
  sh(['config', 'user.email', 'cm@test.local'], GIT_ROOT);
  sh(['config', 'user.name', 'CM Test'], GIT_ROOT);
  fs.writeFileSync(path.join(GIT_ROOT, 'base.txt'), 'base\n');
  sh(['add', '.'], GIT_ROOT);
  sh(['commit', '-q', '-m', 'init'], GIT_ROOT);
  sh(['checkout', '-q', '-b', 'feature-x'], GIT_ROOT);
  fs.writeFileSync(path.join(GIT_ROOT, 'feature.txt'), 'feature\n');
  sh(['add', '.'], GIT_ROOT);
  sh(['commit', '-q', '-m', 'feature work'], GIT_ROOT);
}

async function until(check, ms = 5000) {
  const end = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > end) throw new Error('timed out');
    await wait(20);
  }
}

const spawnOf = card => spawned.findIndex(s => s.opts.env.CM_BOARD_CARD === card.id);
const wtDir = card => path.join(GIT_ROOT, '.claude', 'worktrees', 'cm-' + card.id.slice(0, 8));

/** claude's side of a ticket in its worktree: some committed work. */
function workIn(card, file) {
  fs.writeFileSync(path.join(wtDir(card), file), 'ticket\n');
  sh(['add', file], wtDir(card));
  sh(['commit', '-q', '-m', 'ticket work'], wtDir(card));
}

test('a Parallel git lane runs up to the limit at once, each ticket in a worktree from the current branch', async () => {
  makeRepo();
  await request(app).put('/api/task-board/settings').send({ maxParallel: 2 });
  await parallelLane(GIT_SLUG, ['Plan']);
  const cards = await readyTickets(GIT_SLUG, 3);
  await until(() => spawned.length === 2);
  for (const card of cards.slice(0, 2)) {
    const s = spawned[spawnOf(card)];
    assert.strictEqual(s.projectPath, wtDir(card));
    assert.deepStrictEqual(s.opts.args, ['--settings', runner.HOOKS_FILE]);
    const c = await cardOf(card.id);
    assert.deepStrictEqual([c.worktree, c.baseBranch], ['cm-' + card.id.slice(0, 8), 'feature-x']);
    assert.ok(fs.existsSync(path.join(wtDir(card), 'feature.txt')), 'branched from feature-x, not main');
  }
  assert.strictEqual((await cardOf(cards[2].id)).column, 'ready');
  resetMaxParallel();
});

test('finishing a worktree ticket: claude commits and merges its base in, CM squashes it into the base and cleans up', async () => {
  runner._reset();
  startDriver();
  makeRepo();
  await parallelLane(GIT_SLUG, ['Plan']);
  const [card] = await readyTickets(GIT_SLUG, 1);
  await until(() => spawned.length === 1);
  await hook(0, 'SessionStart', { sessionId: SID });
  workIn(card, 'ticket.txt');

  await hook(0, 'Stop', { lastAssistantMessage: 'CM-STAGE: done' });
  await until(() => pasted(spawned[0].entry).length === 2);
  const finishing = pasted(spawned[0].entry)[1];
  assert.match(finishing, /^\[Task Board · finishing\]/);
  assert.match(finishing, /git merge feature-x/);
  assert.strictEqual((await cardOf(card.id)).column, (await board()).projects[GIT_SLUG].stages[0].id);

  // The base branch moved meanwhile: claude is sent to merge it in again before anything lands.
  fs.writeFileSync(path.join(GIT_ROOT, 'later.txt'), 'later\n');
  sh(['add', 'later.txt'], GIT_ROOT);
  sh(['commit', '-q', '-m', 'later on feature-x'], GIT_ROOT);
  await hook(0, 'Stop', { lastAssistantMessage: 'CM-STAGE: done' });
  await until(() => pasted(spawned[0].entry).length === 3);
  assert.match((await cardOf(card.id)).run.message, /feature-x has new changes/);

  sh(['merge', '-q', '--no-edit', 'feature-x'], wtDir(card));
  await hook(0, 'Stop', { lastAssistantMessage: 'CM-STAGE: done' });
  await until(async () => (await cardOf(card.id)).column === 'done');
  const done = await cardOf(card.id);
  assert.strictEqual(done.run.message, 'Merged into feature-x');
  assert.strictEqual(sh(['log', '-1', '--format=%s'], GIT_ROOT), 'ticket 0');
  assert.strictEqual(sh(['rev-list', '--count', 'HEAD'], GIT_ROOT), '4', 'one squashed commit on top');
  assert.ok(fs.existsSync(path.join(GIT_ROOT, 'ticket.txt')));
  assert.ok(spawned[0].entry.terminated);
  assert.ok(fs.existsSync(wtDir(card)), 'kept for a failed manual test');

  const del = await request(app).delete('/api/task-board/cards/' + card.id);
  assert.deepStrictEqual(del.body, { ok: true, warning: '' });
  assert.ok(!fs.existsSync(wtDir(card)));
  assert.strictEqual(sh(['branch', '--list', 'worktree-cm-*'], GIT_ROOT), '');
});

test('a Done ticket moved back to ToDo reruns in the same worktree and lands only the fix', async () => {
  makeRepo();
  await parallelLane(GIT_SLUG, ['Plan']);
  const [card] = await readyTickets(GIT_SLUG, 1);
  await until(() => spawned.length === 1);
  await hook(0, 'SessionStart', { sessionId: SID });
  workIn(card, 'ticket.txt');
  await hook(0, 'Stop', { lastAssistantMessage: 'CM-STAGE: done' });
  await hook(0, 'Stop', { lastAssistantMessage: 'CM-STAGE: done' });
  await until(async () => (await cardOf(card.id)).column === 'done');

  assert.strictEqual((await request(app).post(`/api/task-board/cards/${card.id}/move`).send({ column: 'todo' })).status, 200);
  await request(app).post(`/api/task-board/cards/${card.id}/move`).send({ column: 'ready' });
  await until(() => spawned.length === 2);
  assert.strictEqual(spawned[1].projectPath, wtDir(card));
  await hook(1, 'SessionStart', { sessionId: '22222222-3333-4444-5555-666666666666' });
  sh(['merge', '-q', '--no-edit', 'feature-x'], wtDir(card));
  workIn(card, 'fix.txt');
  await hook(1, 'Stop', { lastAssistantMessage: 'CM-STAGE: done' });
  await hook(1, 'Stop', { lastAssistantMessage: 'CM-STAGE: done' });
  await until(async () => (await cardOf(card.id)).column === 'done');
  assert.strictEqual(sh(['rev-list', '--count', 'HEAD'], GIT_ROOT), '4', 'two squashed commits on top');
  assert.strictEqual(sh(['show', '--name-only', '--format=', 'HEAD'], GIT_ROOT), 'fix.txt', 'only the fix lands');
});

test('a worktree ticket waits for the user when the project folder left its base branch', async () => {
  makeRepo();
  await parallelLane(GIT_SLUG, ['Plan']);
  const [card] = await readyTickets(GIT_SLUG, 1);
  await until(() => spawned.length === 1);
  await hook(0, 'SessionStart', { sessionId: SID });
  workIn(card, 'ticket.txt');
  await hook(0, 'Stop', { lastAssistantMessage: 'CM-STAGE: done' });
  sh(['checkout', '-q', 'main'], GIT_ROOT);
  await hook(0, 'Stop', { lastAssistantMessage: 'CM-STAGE: done' });
  await until(async () => (await cardOf(card.id)).run.status === 'needs_input');
  assert.match((await cardOf(card.id)).run.message, /on "main": switch it back to "feature-x"/);
  assert.ok(!fs.existsSync(path.join(GIT_ROOT, 'ticket.txt')));

  sh(['checkout', '-q', 'feature-x'], GIT_ROOT);
  await hook(0, 'Stop', { lastAssistantMessage: 'CM-STAGE: done' });
  await until(async () => (await cardOf(card.id)).column === 'done');
});

test('a Parallel lane without git runs tickets at once in the project folder', async () => {
  await parallelLane(SLUG, ['Plan']);
  await readyTickets(SLUG, 2);
  assert.strictEqual(spawned.length, 2);
  for (const s of spawned) {
    assert.strictEqual(s.projectPath, PROJECT_ROOT);
    assert.deepStrictEqual(s.opts.args, ['--settings', runner.HOOKS_FILE]);
  }
});

test('turning Parallel on starts waiting tickets right away', async () => {
  await setStages(['Plan']);
  await readyTickets(SLUG, 2);
  assert.strictEqual(spawned.length, 1);
  await request(app).put('/api/task-board/lanes/' + SLUG).send({ parallel: true });
  assert.strictEqual(spawned.length, 2);
});

test('a worktree session is tracked under the worktree slug its transcript lives in', async () => {
  const wtSlug = SLUG + '--claude-worktrees-cm-abc';
  await setStages(['Plan']);
  const [card] = await readyTickets(SLUG, 1);
  await hook(0, 'SessionStart', { sessionId: SID, transcriptPath: path.join(paths.PROJECTS_DIR, wtSlug, SID + '.jsonl') });
  assert.strictEqual(spawned[0].entry.slug, wtSlug);
  assert.strictEqual((await cardOf(card.id)).sessionSlug, wtSlug);
  await request(app).post(`/api/task-board/cards/${card.id}/reveal`);
  assert.deepStrictEqual(revealed, [[wtSlug, SID]]);
  assert.strictEqual(runner.sessionSlugOf(path.join(HOME, 'elsewhere', 'x.jsonl')), '');
  assert.strictEqual(runner.sessionSlugOf(''), '');
});

test('a running ticket\'s session tells its stage, and hide keeps it running out of sight', async () => {
  runner._reset();
  const hidden = [];
  runner.init({
    spawn: (projectPath, slug, opts) => { const e = fakeEntry(); e.term.owner = e; spawned.push({ opts, entry: e }); return e; },
    bind: () => {}, reveal: () => {}, hide: (slug, id) => hidden.push([slug, id]),
    url: 'http://127.0.0.1:1', idleMs: 1, maxWaitMs: 10, enterDelayMs: 1, submitCheckMs: 1000, readyDelayMs: 0
  });
  await setStages(['Plan', 'Build']);
  const [card] = await readyTickets(SLUG, 1);
  await hook(0, 'SessionStart', { sessionId: SID });
  const info = (await request(app).get('/api/task-board/session/' + SID)).body;
  assert.strictEqual(info.card.id, card.id);
  assert.deepStrictEqual(info.stage, { index: 0, total: 2, title: 'Plan' });
  assert.strictEqual((await request(app).post(`/api/task-board/cards/${card.id}/hide`)).status, 200);
  assert.deepStrictEqual(hidden, [[SLUG, SID]]);
  assert.ok(!spawned[0].entry.terminated);
  assert.strictEqual((await request(app).post('/api/task-board/cards/nope/hide')).status, 404);
  assert.deepStrictEqual((await request(app).get('/api/task-board/session/unknown-session')).body, { card: null, stage: null });
});
