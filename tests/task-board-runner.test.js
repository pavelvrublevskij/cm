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

function startDriver(readyDelayMs = 0, extra = {}) {
  runner.init(Object.assign({
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
  }, extra));
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
  assert.ok(first.startsWith('T\n\nABC-1 fix login\n\n[Task Board · stage 1/3: Plan]'));
  assert.ok(runner.stageMessage({ title: '', notes: 'Only notes' }, stages, 0).startsWith('Only notes\n\n[Task Board'));
  assert.match(first, /Use the "writing-plans" skill for this stage\.\nkeep it short/);
  assert.match(first, /CM-STAGE: done/);
  assert.match(first, /"CM-TYPE: <type>".*bug, feature, question, other/);
  assert.ok(!runner.stageMessage({}, stages, 1).includes('CM-TYPE'));
  assert.match(runner.stageMessage({}, stages, 1), /^\[Task Board · stage 2\/3: Check\]\n\nUse the "tester" subagent/);
  assert.match(runner.stageMessage({}, stages, 2), /Write the changelog/);
  assert.strictEqual(runner.stageMessage({ title: 'Only title', notes: '' }, stages, 0).split('\n')[0], 'Only title');
});

test('stageMessage asks a workflow stage to use the Workflow tool and wait for it', () => {
  const stages = [{ title: 'Deep review', type: 'workflow', ref: '', prompt: 'Review by dimension' }];
  assert.match(runner.stageMessage({}, stages, 0), /Use a workflow \(the Workflow tool\) for this stage, and wait for it to finish before you end this stage\.\nReview by dimension/);
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
  assert.strictEqual(hooks.PreToolUse[1].matcher, 'AskUserQuestion');
  assert.match(hooks.PreToolUse[1].hooks[0].command, /question-hook\.js"$/);
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
  assert.strictEqual(spawned.length, 0);
  assert.strictEqual((await board()).readyDelayMs, 300);
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

test('a ticket with an end-of-paste sequence is pasted without ESC', async () => {
  await setStages(['Plan']);
  const card = await addTicket({ notes: 'hi\x1b[201~\rmore' });
  await request(app).post(`/api/task-board/cards/${card.id}/move`).send({ column: 'ready' });
  await hook(0, 'SessionStart', { sessionId: SID });
  await wait(250);
  const first = spawned[0].entry.writes.find(w => w.startsWith('\x1b[200~'));
  assert.ok(first.startsWith('\x1b[200~hi[201~\rmore\n\n[Task Board'));
  assert.strictEqual(first.indexOf('\x1b', 1), first.length - 6);
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

test('parseType reads the last known CM-TYPE line', () => {
  assert.strictEqual(runner.parseType('x\nCM-TYPE: Bug\nCM-STAGE: done'), 'bug');
  assert.strictEqual(runner.parseType('**CM-TYPE: question**'), 'question');
  assert.strictEqual(runner.parseType('CM-TYPE: feature\nCM-TYPE: other'), 'other');
  assert.strictEqual(runner.parseType('CM-TYPE: chore'), null);
  assert.strictEqual(runner.parseType('no type here'), null);
});

test('Stop with a CM-TYPE line stores the ticket type; a restart clears it', async () => {
  await setStages(['Plan', 'Build']);
  const card = await addTicket({ notes: 'x' });
  await request(app).post(`/api/task-board/cards/${card.id}/move`).send({ column: 'ready' });
  await hook(0, 'SessionStart', { sessionId: SID });
  await hook(0, 'Stop', { lastAssistantMessage: 'Which database?\nCM-TYPE: feature' });
  assert.strictEqual((await cardOf(card.id)).kind, 'feature');
  await hook(0, 'Stop', { lastAssistantMessage: 'CM-TYPE: bug\nCM-STAGE: done' });
  await wait(250);
  assert.strictEqual((await cardOf(card.id)).kind, 'bug');
  await request(app).post(`/api/task-board/cards/${card.id}/stop`);
  await request(app).post(`/api/task-board/cards/${card.id}/move`).send({ column: 'ready' });
  assert.strictEqual((await cardOf(card.id)).kind, null);
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

test('a working subagent keeps the ticket running through Stop and idle notifications', async () => {
  await setStages(['Plan']);
  const card = await addTicket({ notes: 'x' });
  await request(app).post(`/api/task-board/cards/${card.id}/move`).send({ column: 'ready' });
  await hook(0, 'SessionStart', { sessionId: SID });
  await hook(0, 'SubagentStart', { agentId: 'agent-1' });
  await hook(0, 'Stop', { lastAssistantMessage: 'Waiting for the subagent.' });
  assert.strictEqual((await cardOf(card.id)).run.status, 'running');
  await hook(0, 'Notification', { notificationType: 'idle_prompt', message: 'Claude is waiting for your input' });
  assert.strictEqual((await cardOf(card.id)).run.status, 'running');
  await hook(0, 'Notification', { notificationType: 'permission_prompt', message: 'Claude needs your permission to use Bash' });
  assert.strictEqual((await cardOf(card.id)).run.status, 'needs_input');
  await hook(0, 'SubagentStop', { agentId: 'agent-1' });
  await hook(0, 'Stop', { lastAssistantMessage: 'Waiting.' });
  const c = await cardOf(card.id);
  assert.deepStrictEqual([c.run.status, c.run.message], ['needs_input', 'Claude stopped without reporting the stage result']);
  await hook(0, 'Notification', { notificationType: 'idle_prompt', message: 'Claude is waiting for your input' });
  assert.strictEqual((await cardOf(card.id)).run.message, 'Claude is waiting for your input');
});

test('subagents: one of two stopping keeps running; a stage result advances and forgets them', async () => {
  const stages = await setStages(['Plan', 'Build']);
  const card = await addTicket({ notes: 'x' });
  await request(app).post(`/api/task-board/cards/${card.id}/move`).send({ column: 'ready' });
  await hook(0, 'SessionStart', { sessionId: SID });
  await hook(0, 'SubagentStart', { agentId: 'agent-1' });
  await hook(0, 'SubagentStart', { agentId: 'agent-2' });
  await hook(0, 'SubagentStop', { agentId: 'agent-1' });
  await hook(0, 'Stop', { lastAssistantMessage: 'Waiting.' });
  assert.strictEqual((await cardOf(card.id)).run.status, 'running');
  await hook(0, 'Stop', { lastAssistantMessage: 'CM-STAGE: done' });
  assert.strictEqual((await cardOf(card.id)).column, stages[1].id);
  await hook(0, 'Stop', { lastAssistantMessage: 'Which database?' });
  assert.strictEqual((await cardOf(card.id)).run.status, 'needs_input');
});

test('subagents: a needs_input result forgets them; an auth notification keeps the ticket running', async () => {
  await setStages(['Plan']);
  const card = await addTicket({ notes: 'x' });
  await request(app).post(`/api/task-board/cards/${card.id}/move`).send({ column: 'ready' });
  await hook(0, 'SessionStart', { sessionId: SID });
  await hook(0, 'Notification', { notificationType: 'auth_success', message: 'Logged in' });
  assert.strictEqual((await cardOf(card.id)).run.status, 'running');
  await hook(0, 'SubagentStart', { agentId: 'agent-1' });
  await hook(0, 'Stop', { lastAssistantMessage: 'CM-STAGE: needs_input which database' });
  await hook(0, 'UserPromptSubmit');
  await hook(0, 'Notification', { notificationType: 'idle_prompt', message: 'Claude is waiting for your input' });
  assert.strictEqual((await cardOf(card.id)).run.status, 'needs_input');
});

test('subagents: a later SessionStart (/clear, compaction) forgets them', async () => {
  await setStages(['Plan']);
  const card = await addTicket({ notes: 'x' });
  await request(app).post(`/api/task-board/cards/${card.id}/move`).send({ column: 'ready' });
  await hook(0, 'SessionStart', { sessionId: SID });
  await hook(0, 'SubagentStart', { agentId: 'agent-1' });
  await hook(0, 'SessionStart', { sessionId: SID });
  await hook(0, 'Stop', { lastAssistantMessage: 'Which database?' });
  assert.strictEqual((await cardOf(card.id)).run.status, 'needs_input');
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

test('after the last stage the ticket runs the tests in Finalize, then goes to Done, claude ends, the next ticket starts', async () => {
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
  const f = await cardOf(first.id);
  assert.deepStrictEqual([f.column, f.run.message], ['finalize', 'Run the tests']);
  const finalize = pasted(spawned[0].entry)[1];
  assert.match(finalize, /^\[Task Board · Finalize\]/);
  assert.match(finalize, /Run the project's tests/);
  assert.ok(!/git merge/.test(finalize), 'no merge outside a worktree');
  assert.strictEqual(spawned.length, 1, 'Finalize still holds the lane');
  assert.deepStrictEqual((await request(app).get('/api/task-board/session/' + SID)).body.stage, { finalize: true, title: 'Finalize' });
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
  assert.strictEqual((await cardOf(card.id)).column, 'finalize', 'Done always goes through Finalize');
  await hook(0, 'Stop', { lastAssistantMessage: 'CM-STAGE: done' });
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

test('the default arrow decides the next stage, and the board orders stages along it', async () => {
  await request(app).put('/api/task-board/lanes/' + SLUG).send({});
  const res = await request(app).put(`/api/task-board/lanes/${SLUG}/workflow`).send({ stages: [
    { id: 's-plan0000', title: 'Plan', type: 'prompt', prompt: 'Plan', next: 's-review00' },
    { id: 's-build000', title: 'Build', type: 'prompt', prompt: 'Build', next: 'done' },
    { id: 's-review00', title: 'Review', type: 'prompt', prompt: 'Review', next: 's-build000' }
  ] });
  assert.strictEqual(res.status, 200, JSON.stringify(res.body));
  assert.deepStrictEqual((await board()).projects[SLUG].stages.map(s => s.title), ['Plan', 'Review', 'Build']);
  const card = await startTicket();
  await hook(0, 'Stop', { lastAssistantMessage: 'CM-STAGE: done' });
  assert.strictEqual((await cardOf(card.id)).column, 's-review00');
  await wait(250);
  assert.match(pasted(spawned[0].entry)[1], /^\[Task Board · stage 2\/3: Review\]/);
  await hook(0, 'Stop', { lastAssistantMessage: 'CM-STAGE: done' });
  assert.strictEqual((await cardOf(card.id)).column, 's-build000');
  await hook(0, 'Stop', { lastAssistantMessage: 'CM-STAGE: done' });
  assert.strictEqual((await cardOf(card.id)).column, 'finalize', 'the last default arrow leads through Finalize');
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

test('on start-up, a ticket with a session resumes it and runs its stage again', async () => {
  const stages = await setStages(['Plan', 'Build']);
  const [card] = await readyTickets(SLUG, 1);
  await hook(0, 'SessionStart', { sessionId: SID });
  await hook(0, 'Stop', { lastAssistantMessage: 'CM-TYPE: bug\nCM-STAGE: done' });
  runner._reset();
  spawned = [];
  startDriver();
  let c = await cardOf(card.id);
  assert.deepStrictEqual([c.column, c.closed, c.kind, c.run.status], [stages[1].id, false, 'bug', 'starting']);
  assert.deepStrictEqual(spawned[0].opts.args.slice(-2), ['--resume', SID]);
  await hook(0, 'SessionStart', { sessionId: SID });
  await wait(30);
  const text = pasted(spawned[0].entry)[0];
  assert.match(text, /CM was restarted/);
  assert.match(text, /\[Task Board · stage 2\/2: Build\]/);
  c = await cardOf(card.id);
  assert.deepStrictEqual([c.run.status, c.run.message, c.visits[c.column]], ['running', 'Resumed after CM restart', 1]);
  await hook(0, 'Stop', { lastAssistantMessage: 'CM-STAGE: done' });
  await hook(0, 'UserPromptSubmit');
  c = await cardOf(card.id);
  assert.deepStrictEqual([c.column, c.run.message], ['finalize', 'Run the tests']);
});

test('on start-up, a ticket stuck on a notification resumes and gets its stage again', async () => {
  await setStages(['Plan']);
  const [card] = await readyTickets(SLUG, 1);
  await hook(0, 'SessionStart', { sessionId: SID });
  await hook(0, 'Notification', { message: 'Claude needs your permission' });
  runner._reset();
  spawned = [];
  startDriver();
  await hook(0, 'SessionStart', { sessionId: SID });
  await wait(30);
  assert.match(pasted(spawned[0].entry)[0], /\[Task Board · stage 1\/1: Plan\]/);
  assert.strictEqual((await cardOf(card.id)).run.status, 'running');
});

test('on start-up, a worktree ticket resolving Merge conflicts resumes that, with its merge', async () => {
  await setStages(['Plan']);
  const [card] = await readyTickets(SLUG, 1);
  await hook(0, 'SessionStart', { sessionId: SID });
  const dir = path.join(PROJECT_ROOT, '.claude', 'worktrees', 'cm-merge');
  fs.mkdirSync(dir, { recursive: true });
  const data = JSON.parse(fs.readFileSync(paths.TASK_BOARD_FILE, 'utf-8'));
  Object.assign(data.cards.find(c => c.id === card.id), { column: 'finalize', worktree: 'cm-merge', baseBranch: 'main', autoMerge: true });
  fs.writeFileSync(paths.TASK_BOARD_FILE, JSON.stringify(data));
  runner._reset();
  spawned = [];
  startDriver();
  assert.strictEqual(spawned[0].projectPath, dir);
  const newSid = '99999999-2222-3333-4444-555555555555';
  await hook(0, 'SessionStart', { sessionId: newSid });
  await wait(30);
  assert.match(pasted(spawned[0].entry)[0], /\[Task Board · Merge conflicts\]/);
  const c = await cardOf(card.id);
  assert.deepStrictEqual([c.sessionId, c.run.message], [newSid, 'Resolving conflicts with main']);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('on start-up, a ticket whose folder is gone is closed instead of resumed', async () => {
  await setStages(['Plan']);
  const [card] = await readyTickets(SLUG, 1);
  await hook(0, 'SessionStart', { sessionId: SID });
  const data = JSON.parse(fs.readFileSync(paths.TASK_BOARD_FILE, 'utf-8'));
  data.cards.find(c => c.id === card.id).worktree = 'cm-gone';
  fs.writeFileSync(paths.TASK_BOARD_FILE, JSON.stringify(data));
  runner._reset();
  spawned = [];
  startDriver();
  const c = await cardOf(card.id);
  assert.deepStrictEqual([c.column, c.closed, c.run.message], ['todo', true, 'Stopped: CM was restarted']);
  assert.strictEqual(spawned.length, 0);
});

test('on start-up, a ticket that waited for the user resumes and keeps waiting', async () => {
  await setStages(['Plan']);
  const [card] = await readyTickets(SLUG, 1);
  await hook(0, 'SessionStart', { sessionId: SID });
  await hook(0, 'Stop', { lastAssistantMessage: 'CM-STAGE: needs_input pick a db' });
  runner._reset();
  spawned = [];
  startDriver();
  await hook(0, 'SessionStart', { sessionId: SID });
  await wait(30);
  assert.deepStrictEqual(pasted(spawned[0].entry), []);
  assert.strictEqual((await cardOf(card.id)).sessionId, SID);
  const c = await cardOf(card.id);
  assert.deepStrictEqual([c.run.status, c.run.message], ['needs_input', 'pick a db']);
  await hook(0, 'Stop', { lastAssistantMessage: 'CM-STAGE: done' });
  assert.strictEqual((await cardOf(card.id)).column, 'finalize');
});

test('on start-up, a ticket in Finalize resumes the Finalize step', async () => {
  await setStages(['Plan']);
  const [card] = await readyTickets(SLUG, 1);
  await hook(0, 'SessionStart', { sessionId: SID });
  await hook(0, 'Stop', { lastAssistantMessage: 'CM-STAGE: done' });
  runner._reset();
  spawned = [];
  startDriver();
  await hook(0, 'SessionStart', { sessionId: SID });
  await wait(30);
  assert.match(pasted(spawned[0].entry)[0], /\[Task Board · Finalize\]/);
  await hook(0, 'Stop', { lastAssistantMessage: 'CM-STAGE: done' });
  assert.strictEqual((await cardOf(card.id)).column, 'done');
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
  // Per-ticket message: two tickets committing in the same second must not make the same commit.
  sh(['commit', '-q', '-m', 'ticket work ' + card.id], wtDir(card));
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
    assert.deepStrictEqual([c.worktree, c.gitBranch, c.baseBranch], ['cm-' + card.id.slice(0, 8), 'worktree-cm-' + card.id.slice(0, 8), 'feature-x']);
    assert.ok(fs.existsSync(path.join(wtDir(card), 'feature.txt')), 'branched from feature-x, not main');
  }
  assert.strictEqual((await cardOf(cards[2].id)).column, 'ready');
  resetMaxParallel();
});

test('the board lists the current git branch of each lane, empty without git', async () => {
  makeRepo();
  await request(app).put('/api/task-board/lanes/' + GIT_SLUG).send({});
  fs.mkdirSync(PROJECT_ROOT, { recursive: true });
  await request(app).put('/api/task-board/lanes/' + SLUG).send({});
  // The test HOME sits inside this repo: keep git from finding it above the plain project.
  process.env.GIT_CEILING_DIRECTORIES = HOME;
  try {
    const { projectBranches } = await board();
    assert.strictEqual(projectBranches[GIT_SLUG], 'feature-x');
    assert.strictEqual(projectBranches[SLUG], '');
  } finally {
    delete process.env.GIT_CEILING_DIRECTORIES;
  }
});

/** Run a started worktree ticket through its one stage and Finalize until it waits there on its branch. */
async function toWaitingInFinalize(card, index, branchName, file = 'ticket.txt') {
  await hook(index, 'SessionStart', { sessionId: '1111111' + index + '-2222-3333-4444-555555555555' });
  workIn(card, file);
  await hook(index, 'Stop', { lastAssistantMessage: 'CM-STAGE: done' });
  if (branchName) sh(['branch', '-m', branchName], wtDir(card));
  await hook(index, 'Stop', { lastAssistantMessage: 'CM-STAGE: done' });
  await until(async () => (await cardOf(card.id)).finalized === true);
  return cardOf(card.id);
}

test('finishing a worktree ticket: claude merges its base in and names the branch, the ticket waits in Finalize on it, Merge lands it without squashing', async () => {
  makeRepo();
  await parallelLane(GIT_SLUG, ['Plan']);
  const [card] = await readyTickets(GIT_SLUG, 1);
  await until(() => spawned.length === 1);
  await hook(0, 'SessionStart', { sessionId: SID });
  workIn(card, 'ticket.txt');

  await hook(0, 'Stop', { lastAssistantMessage: 'CM-STAGE: done' });
  await until(() => pasted(spawned[0].entry).length === 2);
  const finishing = pasted(spawned[0].entry)[1];
  assert.match(finishing, /^\[Task Board · Finalize\]/);
  assert.match(finishing, /git merge feature-x/);
  assert.match(finishing, /branch naming rules .*git branch -m feature\/<short-name>/);
  assert.match(finishing, /Run the project's tests/);
  assert.strictEqual((await cardOf(card.id)).column, 'finalize');

  // The base branch moved meanwhile: claude is sent to merge it in again first.
  fs.writeFileSync(path.join(GIT_ROOT, 'later.txt'), 'later\n');
  sh(['add', 'later.txt'], GIT_ROOT);
  sh(['commit', '-q', '-m', 'later on feature-x'], GIT_ROOT);
  await hook(0, 'Stop', { lastAssistantMessage: 'CM-STAGE: done' });
  await until(() => pasted(spawned[0].entry).length === 3);
  assert.match((await cardOf(card.id)).run.message, /feature-x has new changes/);

  sh(['merge', '-q', '--no-edit', 'feature-x'], wtDir(card));
  sh(['branch', '-m', 'feature/ticket-0'], wtDir(card));
  await hook(0, 'Stop', { lastAssistantMessage: 'CM-STAGE: done' });
  await until(async () => (await cardOf(card.id)).finalized === true);
  const waiting = await cardOf(card.id);
  assert.deepStrictEqual([waiting.column, waiting.gitBranch, waiting.baseBranch], ['finalize', 'feature/ticket-0', 'feature-x']);
  assert.strictEqual(waiting.run.message, 'Ready: merge feature/ticket-0 into feature-x or create a PR');
  assert.ok(spawned[0].entry.terminated);
  assert.ok(!fs.existsSync(path.join(GIT_ROOT, 'ticket.txt')), 'nothing lands by itself');
  assert.strictEqual((await request(app).get('/api/task-board/attention')).body.inProgress, 0);

  const res = await request(app).post(`/api/task-board/cards/${card.id}/merge`);
  assert.strictEqual(res.status, 200, JSON.stringify(res.body));
  const done = await cardOf(card.id);
  assert.deepStrictEqual([done.column, done.finalized, done.run.message], ['done', false, 'Merged into feature-x']);
  assert.strictEqual(sh(['log', '-1', '--format=%s%n%b'], GIT_ROOT), "Merge branch 'feature/ticket-0' into feature-x\nticket 0");
  assert.strictEqual(sh(['rev-list', '--parents', '-n', '1', 'HEAD'], GIT_ROOT).split(' ').length, 3, 'a merge commit, not a squash');
  sh(['merge-base', '--is-ancestor', 'feature/ticket-0', 'HEAD'], GIT_ROOT);
  assert.ok(fs.existsSync(path.join(GIT_ROOT, 'ticket.txt')));
  assert.ok(fs.existsSync(wtDir(card)), 'kept for a failed manual test');
  assert.strictEqual((await request(app).post(`/api/task-board/cards/${card.id}/merge`)).status, 400, 'only once');

  const del = await request(app).delete('/api/task-board/cards/' + card.id);
  assert.deepStrictEqual(del.body, { ok: true, warning: '' });
  assert.ok(!fs.existsSync(wtDir(card)));
  assert.match(sh(['branch', '--list', 'feature/ticket-0'], GIT_ROOT), /feature\/ticket-0/, 'the branch stays');
});

test('a ticket deleted from ToDo loses its worktree; its branch stays', async () => {
  makeRepo();
  await parallelLane(GIT_SLUG, ['Plan']);
  const [card] = await readyTickets(GIT_SLUG, 1);
  await until(() => spawned.length === 1);
  await toWaitingInFinalize(card, 0, 'feature/back');
  await request(app).post(`/api/task-board/cards/${card.id}/merge`);
  assert.strictEqual((await request(app).post(`/api/task-board/cards/${card.id}/move`).send({ column: 'todo' })).status, 200);

  const del = await request(app).delete('/api/task-board/cards/' + card.id);
  assert.deepStrictEqual(del.body, { ok: true, warning: '' });
  assert.ok(!fs.existsSync(wtDir(card)));
  assert.match(sh(['branch', '--list', 'feature/back'], GIT_ROOT), /feature\/back/);
});

test('a worktree with uncommitted changes is kept on delete and reported; the ticket still goes', async () => {
  makeRepo();
  await parallelLane(GIT_SLUG, ['Plan']);
  const [card] = await readyTickets(GIT_SLUG, 1);
  await until(() => spawned.length === 1);
  await toWaitingInFinalize(card, 0, 'feature/dirty');
  fs.writeFileSync(path.join(wtDir(card), 'wip.txt'), 'wip\n');

  const del = await request(app).delete('/api/task-board/cards/' + card.id);
  assert.strictEqual(del.body.ok, true);
  assert.match(del.body.warning, /^The worktree \.claude\/worktrees\/cm-\w{8} was kept: /);
  assert.deepStrictEqual([del.body.project, del.body.worktree], [GIT_SLUG, 'cm-' + card.id.slice(0, 8)]);
  assert.ok(fs.existsSync(wtDir(card)));
  assert.strictEqual(await cardOf(card.id), undefined);

  const forced = await request(app).post('/api/task-board/worktrees/force-remove').send({ project: del.body.project, worktree: del.body.worktree });
  assert.deepStrictEqual(forced.body, { ok: true });
  assert.ok(!fs.existsSync(wtDir(card)));
  const again = await request(app).post('/api/task-board/worktrees/force-remove').send({ project: del.body.project, worktree: del.body.worktree });
  assert.strictEqual(again.body.error, 'No kept worktree with that name');
  assert.match(sh(['branch', '--list', 'feature/dirty'], GIT_ROOT), /feature\/dirty/, 'the branch stays');
});

test('force-remove accepts only a ticket worktree name and a valid project', async () => {
  const forceRemove = body => request(app).post('/api/task-board/worktrees/force-remove').send(body);
  for (const worktree of ['../x', 'cm-zz', 'cm-0123456789', 'other', '', 5]) {
    assert.strictEqual((await forceRemove({ project: GIT_SLUG, worktree })).status, 400, 'worktree ' + worktree);
  }
  for (const project of ['', '..', 'a/b', 5]) {
    assert.strictEqual((await forceRemove({ project, worktree: 'cm-0123abcd' })).status, 400, 'project ' + project);
  }
  const missing = await forceRemove({ project: 'C--no-such-folder-cm-test', worktree: 'cm-0123abcd' });
  assert.deepStrictEqual([missing.status, missing.body.error], [400, 'Project folder not found']);
  makeRepo();
  const unknown = await forceRemove({ project: GIT_SLUG, worktree: 'cm-0123abcd' });
  assert.deepStrictEqual([unknown.status, unknown.body.error], [400, 'No kept worktree with that name']);
});

test('force-remove refuses the worktree of a ticket still on the board', async () => {
  makeRepo();
  await parallelLane(GIT_SLUG, ['Plan']);
  const [card] = await readyTickets(GIT_SLUG, 1);
  await until(() => spawned.length === 1);
  await until(async () => !!(await cardOf(card.id)).worktree);
  const worktree = (await cardOf(card.id)).worktree;
  const res = await request(app).post('/api/task-board/worktrees/force-remove').send({ project: GIT_SLUG, worktree });
  assert.deepStrictEqual([res.status, res.body.error], [400, 'The worktree belongs to a ticket on the board']);
  assert.ok(fs.existsSync(wtDir(card)));
});

test('three tickets at once end in Finalize on three branches, each from the parent branch', async () => {
  resetMaxParallel();
  makeRepo();
  await parallelLane(GIT_SLUG, ['Plan']);
  const cards = await readyTickets(GIT_SLUG, 3);
  await until(() => spawned.length === 3);
  const base = sh(['rev-parse', 'feature-x'], GIT_ROOT);
  const branches = [];
  for (const card of cards) {
    const i = spawnOf(card);
    const c = await toWaitingInFinalize(card, i, 'feature/ticket-' + i, 'ticket' + i + '.txt');
    assert.deepStrictEqual([c.column, c.baseBranch], ['finalize', 'feature-x']);
    assert.strictEqual(sh(['merge-base', 'feature-x', c.gitBranch], GIT_ROOT), base);
    branches.push(c.gitBranch);
  }
  assert.strictEqual(new Set(branches).size, 3);
  assert.strictEqual(sh(['rev-parse', 'HEAD'], GIT_ROOT), base, 'the parent branch is untouched');
});

test('a git lane that is not Parallel also runs each ticket in its own worktree', async () => {
  makeRepo();
  await request(app).put('/api/task-board/lanes/' + GIT_SLUG).send({});
  await request(app).put(`/api/task-board/lanes/${GIT_SLUG}/workflow`).send({ stages: [{ title: 'Plan', type: 'prompt', prompt: 'Do Plan' }] });
  const cards = await readyTickets(GIT_SLUG, 2);
  await until(() => spawned.length === 1);
  assert.strictEqual(spawned[0].projectPath, wtDir(cards[0]));
  await toWaitingInFinalize(cards[0], 0, 'fix/one');
  await until(() => spawned.length === 2);
  assert.strictEqual(spawned[1].projectPath, wtDir(cards[1]), 'a ticket waiting in Finalize frees the lane');
});

test('a Done ticket moved back to ToDo reruns in the same worktree and renamed branch and merges only the fix', async () => {
  makeRepo();
  await parallelLane(GIT_SLUG, ['Plan']);
  const [card] = await readyTickets(GIT_SLUG, 1);
  await until(() => spawned.length === 1);
  await toWaitingInFinalize(card, 0, 'feature/login');
  await request(app).post(`/api/task-board/cards/${card.id}/merge`);

  assert.strictEqual((await request(app).post(`/api/task-board/cards/${card.id}/move`).send({ column: 'todo' })).status, 200);
  await request(app).post(`/api/task-board/cards/${card.id}/move`).send({ column: 'ready' });
  await until(() => spawned.length === 2);
  assert.strictEqual(spawned[1].projectPath, wtDir(card));
  assert.strictEqual((await cardOf(card.id)).gitBranch, 'feature/login');
  sh(['merge', '-q', '--no-edit', 'feature-x'], wtDir(card));
  await toWaitingInFinalize(card, 1, null, 'fix.txt');
  assert.strictEqual((await request(app).post(`/api/task-board/cards/${card.id}/merge`)).status, 200);
  assert.strictEqual(sh(['diff', '--name-only', 'HEAD^1', 'HEAD'], GIT_ROOT), 'fix.txt', 'only the fix lands');
});

test('Merge is refused while the project folder is off the base branch; the ticket keeps waiting', async () => {
  makeRepo();
  await parallelLane(GIT_SLUG, ['Plan']);
  const [card] = await readyTickets(GIT_SLUG, 1);
  await until(() => spawned.length === 1);
  await toWaitingInFinalize(card, 0, 'fix/x');
  sh(['checkout', '-q', 'main'], GIT_ROOT);
  const res = await request(app).post(`/api/task-board/cards/${card.id}/merge`);
  assert.strictEqual(res.status, 400);
  assert.match(res.body.error, /on "main": switch it to "feature-x" first/);
  assert.strictEqual((await cardOf(card.id)).column, 'finalize');
  assert.ok(!fs.existsSync(path.join(GIT_ROOT, 'ticket.txt')));

  sh(['checkout', '-q', 'feature-x'], GIT_ROOT);
  assert.strictEqual((await request(app).post(`/api/task-board/cards/${card.id}/merge`)).status, 200);
  assert.strictEqual((await cardOf(card.id)).column, 'done');
});

test('a Merge whose base conflicts with the ticket branch resumes its session to resolve them, then lands by itself', async () => {
  makeRepo();
  await parallelLane(GIT_SLUG, ['Plan']);
  const cards = await readyTickets(GIT_SLUG, 2);
  await until(() => spawned.length === 2);
  for (const card of cards) await toWaitingInFinalize(card, spawnOf(card), 'feature/same-' + spawnOf(card), 'same.txt');
  fs.writeFileSync(path.join(wtDir(cards[1]), 'same.txt'), 'other\n');
  sh(['commit', '-q', '-am', 'other'], wtDir(cards[1]));
  assert.strictEqual((await request(app).post(`/api/task-board/cards/${cards[0].id}/merge`)).status, 200);
  const head = sh(['rev-parse', 'HEAD'], GIT_ROOT);
  const res = await request(app).post(`/api/task-board/cards/${cards[1].id}/merge`);
  assert.strictEqual(res.status, 200, JSON.stringify(res.body));
  const resolving = res.body.card;
  assert.deepStrictEqual([resolving.column, resolving.finalized, resolving.run.status, resolving.run.message],
    ['finalize', false, 'running', 'Resolving conflicts with feature-x']);
  assert.strictEqual(sh(['rev-parse', 'HEAD'], GIT_ROOT), head, 'the base is untouched');
  assert.strictEqual(sh(['diff', '--name-only', '--diff-filter=U'], wtDir(cards[1])), 'same.txt', 'the conflicts wait in the worktree');

  const i = spawned.length - 1;
  const resumed = spawned[i];
  assert.strictEqual(resumed.projectPath, wtDir(cards[1]));
  assert.deepStrictEqual(resumed.opts.args, ['--settings', runner.HOOKS_FILE, '--resume', resolving.sessionId]);
  await hook(i, 'SessionStart', { sessionId: resolving.sessionId });
  await until(() => pasted(resumed.entry).length === 1);
  assert.match(pasted(resumed.entry)[0], /^\[Task Board · Merge conflicts\]\n\nMerging the latest "feature-x" into this branch stopped with conflicts/);
  await hook(i, 'UserPromptSubmit');

  await hook(i, 'Stop', { lastAssistantMessage: 'CM-STAGE: needs_input which wording to keep?' });
  const asking = await cardOf(cards[1].id);
  assert.deepStrictEqual([asking.run.status, asking.run.message], ['needs_input', 'which wording to keep?']);
  assert.strictEqual((await request(app).get('/api/task-board/attention')).body.waiting[0].id, cards[1].id);

  fs.writeFileSync(path.join(wtDir(cards[1]), 'same.txt'), 'both\n');
  sh(['add', 'same.txt'], wtDir(cards[1]));
  sh(['commit', '-q', '--no-edit'], wtDir(cards[1]));
  await hook(i, 'Stop', { lastAssistantMessage: 'CM-STAGE: done' });
  await until(async () => (await cardOf(cards[1].id)).column === 'done');
  assert.strictEqual((await cardOf(cards[1].id)).run.message, 'Merged into feature-x');
  assert.ok(resumed.entry.terminated);
  assert.strictEqual(fs.readFileSync(path.join(GIT_ROOT, 'same.txt'), 'utf-8').trim(), 'both');
});

test('Merge pulls the base from its upstream first and merges it into the ticket branch', async () => {
  makeRepo();
  const origin = path.join(HOME, 'pullorigin.git');
  const clone = path.join(HOME, 'pullclone');
  fs.rmSync(origin, { recursive: true, force: true });
  fs.rmSync(clone, { recursive: true, force: true });
  sh(['init', '-q', '--bare', origin], HOME);
  sh(['remote', 'add', 'origin', origin], GIT_ROOT);
  sh(['push', '-q', '-u', 'origin', 'feature-x'], GIT_ROOT);
  await parallelLane(GIT_SLUG, ['Plan']);
  const [card] = await readyTickets(GIT_SLUG, 1);
  await until(() => spawned.length === 1);
  await toWaitingInFinalize(card, 0, 'feature/pulled');

  sh(['clone', '-q', '-b', 'feature-x', origin, clone], HOME);
  sh(['config', 'user.email', 'cm@test.local'], clone);
  sh(['config', 'user.name', 'CM Test'], clone);
  fs.writeFileSync(path.join(clone, 'remote.txt'), 'remote\n');
  sh(['add', 'remote.txt'], clone);
  sh(['commit', '-q', '-m', 'pushed by someone else'], clone);
  sh(['push', '-q'], clone);

  const res = await request(app).post(`/api/task-board/cards/${card.id}/merge`);
  assert.strictEqual(res.status, 200, JSON.stringify(res.body));
  assert.strictEqual((await cardOf(card.id)).column, 'done');
  assert.ok(fs.existsSync(path.join(GIT_ROOT, 'remote.txt')));
  assert.ok(fs.existsSync(path.join(GIT_ROOT, 'ticket.txt')));
  sh(['merge-base', '--is-ancestor', 'origin/feature-x', 'feature/pulled'], GIT_ROOT);
});

/** A commit on the base branch in the project folder that conflicts with the ticket's ticket.txt. */
function conflictOnBase() {
  fs.writeFileSync(path.join(GIT_ROOT, 'ticket.txt'), 'base side\n');
  sh(['add', 'ticket.txt'], GIT_ROOT);
  sh(['commit', '-q', '-m', 'conflicting base work'], GIT_ROOT);
}

test('an auto-merge that fails after the conflicts are resolved leaves the ticket waiting in Finalize with why', async () => {
  makeRepo();
  await parallelLane(GIT_SLUG, ['Plan']);
  const [card] = await readyTickets(GIT_SLUG, 1);
  await until(() => spawned.length === 1);
  await toWaitingInFinalize(card, 0, 'feature/later');
  conflictOnBase();
  const res = await request(app).post(`/api/task-board/cards/${card.id}/merge`);
  assert.strictEqual(res.body.card.run.message, 'Resolving conflicts with feature-x');
  await hook(1, 'SessionStart', { sessionId: res.body.card.sessionId });
  await hook(1, 'UserPromptSubmit', {});
  assert.strictEqual((await cardOf(card.id)).run.message, 'Resolving conflicts with feature-x', 'the status stays while claude works');

  fs.writeFileSync(path.join(wtDir(card), 'ticket.txt'), 'both\n');
  sh(['add', 'ticket.txt'], wtDir(card));
  sh(['commit', '-q', '--no-edit'], wtDir(card));
  sh(['checkout', '-q', 'main'], GIT_ROOT);
  await hook(1, 'Stop', { lastAssistantMessage: 'CM-STAGE: done' });
  await until(async () => /^Merge failed: /.test((await cardOf(card.id)).run.message));
  const c = await cardOf(card.id);
  assert.deepStrictEqual([c.column, c.finalized], ['finalize', true]);
  assert.match(c.run.message, /on "main": switch it to "feature-x" first/);

  sh(['checkout', '-q', 'feature-x'], GIT_ROOT);
  assert.strictEqual((await request(app).post(`/api/task-board/cards/${card.id}/merge`)).status, 200);
  assert.strictEqual((await cardOf(card.id)).column, 'done');
});

test('Merge conflicts are not resolved while the lane runs another ticket: the merge is undone and the ticket keeps waiting', async () => {
  makeRepo();
  await request(app).put('/api/task-board/lanes/' + GIT_SLUG).send({});
  await request(app).put(`/api/task-board/lanes/${GIT_SLUG}/workflow`).send({ stages: [{ title: 'Plan', type: 'prompt', prompt: 'Do Plan' }] });
  const cards = await readyTickets(GIT_SLUG, 2);
  await until(() => spawned.length === 1);
  await toWaitingInFinalize(cards[0], 0, 'fix/busy');
  await until(() => spawned.length === 2);
  conflictOnBase();
  const res = await request(app).post(`/api/task-board/cards/${cards[0].id}/merge`);
  assert.strictEqual(res.status, 400);
  assert.match(res.body.error, /feature-x conflicts with fix\/busy and the lane is busy/);
  assert.strictEqual(spawned.length, 2, 'no second claude in the lane');
  assert.strictEqual(sh(['status', '--porcelain', '--untracked-files=no'], wtDir(cards[0])), '', 'the merge was undone');
  const c = await cardOf(cards[0].id);
  assert.deepStrictEqual([c.column, c.finalized], ['finalize', true]);
});

test('Merge reports a pull that cannot fast-forward and changes nothing', async () => {
  makeRepo();
  const origin = path.join(HOME, 'pullorigin.git');
  const clone = path.join(HOME, 'pullclone');
  fs.rmSync(origin, { recursive: true, force: true });
  fs.rmSync(clone, { recursive: true, force: true });
  sh(['init', '-q', '--bare', origin], HOME);
  sh(['remote', 'add', 'origin', origin], GIT_ROOT);
  sh(['push', '-q', '-u', 'origin', 'feature-x'], GIT_ROOT);
  await parallelLane(GIT_SLUG, ['Plan']);
  const [card] = await readyTickets(GIT_SLUG, 1);
  await until(() => spawned.length === 1);
  await toWaitingInFinalize(card, 0, 'feature/diverged');

  sh(['clone', '-q', '-b', 'feature-x', origin, clone], HOME);
  sh(['config', 'user.email', 'cm@test.local'], clone);
  sh(['config', 'user.name', 'CM Test'], clone);
  fs.writeFileSync(path.join(clone, 'remote.txt'), 'remote\n');
  sh(['add', 'remote.txt'], clone);
  sh(['commit', '-q', '-m', 'pushed by someone else'], clone);
  sh(['push', '-q'], clone);
  fs.writeFileSync(path.join(GIT_ROOT, 'local.txt'), 'local\n');
  sh(['add', 'local.txt'], GIT_ROOT);
  sh(['commit', '-q', '-m', 'local only'], GIT_ROOT);
  const head = sh(['rev-parse', 'HEAD'], GIT_ROOT);

  const res = await request(app).post(`/api/task-board/cards/${card.id}/merge`);
  assert.strictEqual(res.status, 400);
  assert.match(res.body.error, /^Could not pull feature-x: /);
  assert.strictEqual(sh(['rev-parse', 'HEAD'], GIT_ROOT), head);
  assert.strictEqual((await cardOf(card.id)).finalized, true);
});

test('Create PR pushes the ticket branch and opens a PR into its base; the ticket goes to Done with the PR link', async () => {
  const ghCalls = [];
  let ghFails = true;
  runner._reset();
  startDriver(0, { gh: async (args, cwd) => {
    ghCalls.push({ args, cwd });
    if (ghFails) throw new Error('gh: not logged in');
    return 'Creating pull request\nhttps://github.com/o/r/pull/7\n';
  } });
  makeRepo();
  const origin = path.join(HOME, 'gitorigin.git');
  fs.rmSync(origin, { recursive: true, force: true });
  sh(['init', '-q', '--bare', origin], HOME);
  sh(['remote', 'add', 'origin', origin], GIT_ROOT);
  await parallelLane(GIT_SLUG, ['Plan']);
  const [card] = await readyTickets(GIT_SLUG, 1);
  await until(() => spawned.length === 1);
  await toWaitingInFinalize(card, 0, 'feature/pr-me');

  let res = await request(app).post(`/api/task-board/cards/${card.id}/pr`);
  assert.strictEqual(res.status, 400);
  assert.match(res.body.error, /Could not create the PR: gh: not logged in/);
  assert.strictEqual((await cardOf(card.id)).column, 'finalize');

  ghFails = false;
  res = await request(app).post(`/api/task-board/cards/${card.id}/pr`);
  assert.strictEqual(res.status, 200, JSON.stringify(res.body));
  assert.deepStrictEqual(ghCalls[1].args, ['pr', 'create', '--base', 'feature-x', '--head', 'feature/pr-me', '--title', 'ticket 0', '--body', 'ticket 0']);
  assert.strictEqual(ghCalls[1].cwd, GIT_ROOT);
  assert.strictEqual(sh(['rev-parse', 'feature/pr-me'], origin), sh(['rev-parse', 'feature/pr-me'], GIT_ROOT));
  const done = await cardOf(card.id);
  assert.deepStrictEqual([done.column, done.prUrl, done.run.message], ['done', 'https://github.com/o/r/pull/7', 'PR created into feature-x']);
  assert.ok(!fs.existsSync(path.join(GIT_ROOT, 'ticket.txt')), 'nothing merged locally');
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

test('every hook event of a ticket session is forwarded for the message box; only a question changes the ticket', async () => {
  runner._reset();
  const tracked = [];
  runner.init({
    spawn: (projectPath, slug, opts) => { const e = fakeEntry(); e.term.owner = e; spawned.push({ opts, entry: e }); return e; },
    bind: () => {}, trackHook: (entry, body) => tracked.push({ entry, event: body.event, toolName: body.toolName }),
    url: 'http://127.0.0.1:1', idleMs: 1, maxWaitMs: 10, enterDelayMs: 1, submitCheckMs: 40, readyDelayMs: 0
  });
  await setStages(['Plan']);
  const card = await addTicket({ notes: 'track' });
  await request(app).post(`/api/task-board/cards/${card.id}/move`).send({ column: 'ready' });
  const i = spawned.length - 1;
  await hook(i, 'SessionStart', { sessionId: SID });
  await hook(i, 'UserPromptSubmit', {});
  await hook(i, 'PreToolUse', { toolUseId: 'q1', toolName: 'AskUserQuestion' });
  assert.deepStrictEqual(tracked.map(t => [t.event, t.toolName]),
    [['SessionStart', undefined], ['UserPromptSubmit', undefined], ['PreToolUse', 'AskUserQuestion']]);
  assert.ok(tracked.every(t => t.entry === spawned[i].entry));
  const run = (await cardOf(card.id)).run;
  assert.deepStrictEqual([run.status, run.message], ['needs_input', 'Claude asks a question']);
  await hook(i, 'PostToolUse', { toolUseId: 'q1', toolName: 'AskUserQuestion' });
  assert.strictEqual((await cardOf(card.id)).run.status, 'running', 'answered');
  await hook(i, 'PreToolUse', { toolUseId: 'b1', toolName: 'Bash' });
  await hook(i, 'PostToolUse', { toolUseId: 'b1', toolName: 'Bash' });
  assert.strictEqual((await cardOf(card.id)).run.status, 'running', 'another tool does not change the ticket');
  assert.match(spawned[i].entry.boardToken, /^[0-9a-f]{32}$/, 'its question hook reaches CM with the run token');
  await request(app).post(`/api/task-board/cards/${card.id}/stop`);
});
