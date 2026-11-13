const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const escapeHtml = t => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const decodeName = slug => slug.replace(/^[A-Za-z]--/, '').split('-').filter(Boolean).slice(-2).join('/');
const read = name => fs.readFileSync(path.join(__dirname, '..', 'public', 'js', name), 'utf-8');
const context = vm.createContext({ escapeHtml, escapeAttr: escapeHtml, decodeName });
vm.runInContext(read('task-board-flow.js') + '\n' + read('task-board.js') + '\nglobalThis._TaskBoard = TaskBoard; globalThis._Flow = TaskBoardFlow;', context);
const TaskBoard = context._TaskBoard;
const Flow = context._Flow;
const plain = v => JSON.parse(JSON.stringify(v));

const BOARD = {
  projects: { 'C--work-zeta': { parallel: true }, 'C--work-alpha': { parallel: false } },
  cards: [
    { id: '1', title: 'Zeta <task>', notes: 'first line\nsecond', project: 'C--work-zeta', column: 'todo', closed: false },
    { id: '2', title: '', notes: 'ABC-7 vibe idea\nmore', project: 'C--work-alpha', column: 'ready', closed: false },
    { id: '3', title: 'Stopped', notes: '', project: 'C--work-zeta', column: 'todo', closed: true }
  ]
};

test('one lane per project, sorted by name', () => {
  assert.deepStrictEqual(Array.from(TaskBoard.laneKeys(BOARD)), ['C--work-alpha', 'C--work-zeta']);
});

test('an empty board says how to start', () => {
  assert.match(TaskBoard.html({ cards: [], projects: {} }, []), /No tickets yet/);
});

test('every lane has the fixed columns around its workflow', () => {
  const ids = Array.from(TaskBoard.laneColumns(BOARD, 'C--work-zeta'), c => c.id);
  assert.deepStrictEqual(ids, ['todo', 'ready', '', 'finalize', 'done']);
  const staged = { projects: { p: { stages: [{ id: 'plan', title: 'Plan' }, { id: 'impl', title: 'Implement' }] } } };
  assert.deepStrictEqual(Array.from(TaskBoard.laneColumns(staged, 'p'), c => c.id), ['todo', 'ready', 'plan', 'impl', 'finalize', 'done']);
});

test('only ToDo ↔ Ready and Done → ToDo are manual moves', () => {
  assert.ok(TaskBoard.canMove({ column: 'todo' }, 'ready'));
  assert.ok(TaskBoard.canMove({ column: 'ready' }, 'todo'));
  assert.ok(!TaskBoard.canMove({ column: 's-b' }, 'done'));
  assert.ok(TaskBoard.canMove({ column: 'done' }, 'done'));
  assert.ok(!TaskBoard.canMove({ column: 'todo' }, 'done'));
  assert.ok(TaskBoard.canMove({ column: 'done' }, 'todo'));
  assert.ok(!TaskBoard.canMove({ column: 'done' }, 'ready'));
  assert.ok(!TaskBoard.canMove({ column: 'ready' }, 'done'));
});

test('the board renders chips, lanes, escaped cards and the closed badge', () => {
  const html = TaskBoard.html(BOARD, []);
  assert.strictEqual((html.match(/class="tb-lane"/g) || []).length, 2);
  assert.match(html, /Zeta &lt;task&gt;/);
  assert.match(html, /first line</);
  assert.ok(!html.includes('second'));
  assert.match(html, /tb-badge--closed" title="">closed/);
  assert.match(html, /No workflow yet/);
  assert.strictEqual((html.match(/\+ Ticket/g) || []).length, 2);
});

test('every lane has a Parallel checkbox reflecting the lane setting', () => {
  const html = TaskBoard.html(BOARD, []);
  assert.strictEqual((html.match(/tb-parallel/g) || []).length, 2);
  assert.match(html, /<input type="checkbox" checked onchange="TaskBoard.setParallel\('C--work-zeta'/);
});

test('an empty project lane can be removed, a lane with cards cannot', () => {
  const html = TaskBoard.html({ projects: Object.assign({ 'C--work-empty': { parallel: false } }, BOARD.projects), cards: BOARD.cards }, []);
  assert.match(html, /TaskBoard.removeLane\('C--work-empty'\)/);
  assert.ok(!html.includes("TaskBoard.removeLane('C--work-alpha')"));
  assert.ok(!html.includes("TaskBoard.removeLane('C--work-zeta')"));
});

test('hidden lanes are left out and their chip is inactive', () => {
  const html = TaskBoard.html(BOARD, ['C--work-zeta']);
  assert.strictEqual((html.match(/class="tb-lane"/g) || []).length, 1);
  assert.ok(!html.includes('Zeta &lt;task&gt;'));
  assert.match(html, /class="tb-chip" onclick="TaskBoard.toggleLaneVisible\('C--work-zeta'\)"/);
});

test('a card without a title shows the first description line as its heading', () => {
  const html = TaskBoard.cardHtml({ id: 'x', title: '', notes: 'ABC-7 vibe idea\nmore detail\nhidden', column: 'todo' });
  assert.match(html, /tb-card-title">ABC-7 vibe idea</);
  assert.match(html, /tb-card-notes">more detail</);
  assert.ok(!html.includes('hidden'));
});

const STAGED = {
  projects: { p: { parallel: false, stages: [{ id: 's-a', title: 'Plan' }, { id: 's-b', title: 'Build' }, { id: 's-c', title: 'Review' }] } },
  cards: [{ id: 'w', title: 'Working', notes: '', project: 'p', column: 's-b', closed: false }],
  status: { p: { skillsChanged: true, missing: ['s-a'] } }
};

test('compact mode folds the stages into one In progress column', () => {
  assert.deepStrictEqual(Array.from(TaskBoard.laneColumns(STAGED, 'p', true), c => c.title), ['ToDo', 'Ready', 'In progress', 'Finalize', 'Done']);
  assert.match(TaskBoard.html(STAGED, [], true), /In progress <span class="tb-col-count">1</);
});

test('compact is the default until it is switched off', () => {
  const store = {};
  context.localStorage = { getItem: k => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = v; } };
  assert.strictEqual(TaskBoard.compact(), true);
  store[TaskBoard.COMPACT_KEY] = '0';
  assert.strictEqual(TaskBoard.compact(), false);
  store[TaskBoard.COMPACT_KEY] = '1';
  assert.strictEqual(TaskBoard.compact(), true);
  delete context.localStorage;
});

test('full mode shows one column per stage and no step bar', () => {
  const html = TaskBoard.html(STAGED, [], false);
  assert.match(html, /data-column="s-b"/);
  assert.match(html, /Build <span class="tb-col-count">1</);
  assert.ok(!html.includes('tb-steps'));
});

test('a lane shows its workflow button and skill flags', () => {
  const html = TaskBoard.html(STAGED, [], false);
  assert.match(html, /TaskBoard.openWorkflow\('p'\)">Workflow · 3</);
  assert.match(html, /Missing skill/);
  assert.match(html, /Skills changed/);
  const plain = TaskBoard.html(BOARD, [], false);
  assert.match(plain, /Set up/);
  assert.ok(!plain.includes('Skills changed'));
});

const WF = {
  slug: 'p',
  stages: [
    { id: 's-a', title: 'Plan', type: 'skill', ref: 'gone-skill', prompt: '' },
    { id: 's-b', title: 'Do <it>', type: 'prompt', ref: '', prompt: 'Implement it' }
  ],
  available: [
    { kind: 'skill', name: 'writing-plans', source: 'project' },
    { kind: 'agent', name: 'tester', source: 'global' }
  ],
  recommended: [{ title: 'Plan', type: 'skill', ref: 'writing-plans', prompt: '' }],
  missing: ['s-a'],
  skillsChanged: true,
  diff: false
};
Flow.prepare(WF);

test('the workflow editor draws Ready, the stages and Done, with arrows between them', () => {
  const html = TaskBoard.workflowHtml(WF);
  assert.match(html, /data-node="ready"/);
  assert.match(html, /data-node="done"/);
  assert.strictEqual((html.match(/tbf-node--stage/g) || []).length, 2);
  assert.match(html, /Do &lt;it&gt;/);
  assert.match(html, /tbf-node--stage tbf-node--missing" data-node="s-a"/);
  assert.match(html, /data-edge="ready\|start"/);
  assert.match(html, /data-edge="s-a\|next"/);
  assert.match(html, /data-edge="s-b\|next"/);
  assert.match(html, /Compare with recommended/);
  assert.match(html, /Auto-layout/);
});

test('an older workflow gets default arrows along the list and a left-to-right layout', () => {
  const wf = { stages: [{ id: 's-a', title: 'A' }, { id: 's-b', title: 'B' }] };
  Flow.prepare(wf);
  assert.deepStrictEqual(wf.stages.map(s => s.next), ['s-b', 'done']);
  assert.ok(wf.stages[1].pos.x > wf.stages[0].pos.x);
  assert.strictEqual(wf.stages[0].pos.y, wf.stages[1].pos.y);
  const done = Flow.nodes(wf).find(n => n.id === 'done');
  assert.ok(done.x > wf.stages[1].pos.x);
});

test('the stage panel shows type, reference with missing marker, and delete', () => {
  const html = Flow.panelHtml(Object.assign({}, WF, { sel: { node: 's-a' } }));
  assert.match(html, /value="Plan"/);
  assert.match(html, /tb-wf-ref--missing/);
  assert.match(html, /gone-skill \(missing\)/);
  assert.match(html, /writing-plans · project/);
  assert.ok(!html.includes('tester · global'), 'agents are not offered for a skill stage');
  assert.match(html, /Delete stage/);
  assert.match(Flow.panelHtml(Object.assign({}, WF, { sel: null })), /Drag<\/strong> a stage to move it/);
});

test('the diff view shows current and recommended stages side by side', () => {
  const html = TaskBoard.workflowHtml(Object.assign({}, WF, { diff: true }));
  assert.match(html, /<h4>Current<\/h4>/);
  assert.match(html, /<h4>Recommended<\/h4>/);
  assert.match(html, /skill: writing-plans/);
  assert.match(html, /Use recommended/);
  assert.match(html, /Keep current/);
});

test('an empty workflow invites Recommend', () => {
  const html = TaskBoard.workflowHtml(Object.assign({}, WF, { stages: [], skillsChanged: false }));
  assert.match(html, /No stages yet/);
  assert.ok(!html.includes('Compare with recommended'));
  assert.ok(!html.includes('data-edge'));
});

test('compact cards are one line: heading, closed badge and stage dots', () => {
  const html = TaskBoard.html(STAGED, [], true);
  assert.match(html, /tb-card tb-card--line" draggable="true" data-id="w" title="Working"/);
  assert.match(html, /tb-line-text">Working</);
  assert.match(html, /tb-line-steps" title="Build \(2\/3\)"/);
  assert.strictEqual((html.match(/class="tb-dot/g) || []).length, 3);
  assert.ok(!html.includes('tb-card-notes'));
  const todo = TaskBoard.cardHtml({ id: 'x', title: '', notes: 'ABC-7 idea\nmore', column: 'todo', closed: true }, null, true);
  assert.match(todo, /tb-line-text">ABC-7 idea</);
  assert.match(todo, /tb-badge--closed/);
  assert.ok(!todo.includes('more'));
  assert.ok(!todo.includes('tb-line-steps'));
});

test('a ticket in the workflow shows its run status, and why it waits', () => {
  const card = { id: 'r', title: 'T', notes: '', project: 'p', column: 's-b', closed: false, run: { status: 'needs_input', message: 'Pick a <db>' } };
  assert.ok(TaskBoard.inWorkflow(card));
  const html = TaskBoard.cardHtml(card, null, false);
  assert.match(html, /tb-badge tb-badge--needs_input" title="Pick a &lt;db&gt;">needs input</);
  assert.match(html, /tb-card-run">Pick a &lt;db&gt;</);
  assert.match(html, /onclick="TaskBoard.openCard\('r'\)"/);
  assert.match(TaskBoard.cardHtml(card, null, true), /needs input</);
  assert.match(TaskBoard.badgeHtml(Object.assign({}, card, { run: { status: 'running' } })), /tb-badge--running" title="">running/);
});

test('no run badge outside the workflow; a closed ticket says why on hover', () => {
  assert.ok(!TaskBoard.inWorkflow({ column: 'done' }));
  assert.strictEqual(TaskBoard.badgeHtml({ column: 'done', run: { status: 'done' } }), '');
  assert.ok(!TaskBoard.badgeHtml({ column: 'ready', readyAt: new Date().toISOString(), run: { status: 'running' } }).includes('running'));
  const closed = TaskBoard.badgeHtml({ column: 'todo', closed: true, run: { status: 'closed', message: 'Session ended: exited (code 1)' } });
  assert.match(closed, /title="Session ended: exited \(code 1\)">closed/);
  assert.ok(!TaskBoard.cardHtml({ id: 'c', title: 'x', notes: '', column: 'todo', closed: true, run: { message: 'gone' } }, null, false).includes('tb-card-run'));
});

test('only ToDo and Done cards have a delete icon, in both card modes', () => {
  for (const compact of [false, true]) {
    for (const column of ['todo', 'done']) {
      const html = TaskBoard.cardHtml({ id: 'd', title: 'x', notes: '', column }, null, compact);
      assert.match(html, /tb-card-delete" draggable="false"/);
      assert.match(html, /event.stopPropagation\(\); TaskBoard.confirmDelete\('d'\)/);
    }
    for (const column of ['ready', 's-b']) {
      assert.ok(!TaskBoard.cardHtml({ id: 'd', title: 'x', notes: '', column }, null, compact).includes('tb-card-delete'));
    }
  }
});

test('a ticket in Ready counts down to its start, then shows queued', () => {
  const t0 = Date.parse('2026-11-11T10:00:00Z');
  const card = { column: 'ready', readyAt: '2026-11-11T10:00:00Z' };
  assert.match(TaskBoard.badgeHtml(card, t0 + 4500, 30000), />starts in 26s</);
  assert.match(TaskBoard.badgeHtml(card, t0 + 31000, 30000), />queued</);
});

test('attention: the toast counts waiting tickets and a waiting session gets its badge', () => {
  assert.strictEqual(TaskBoard.attentionMessage(1), 'Task Board: 1 ticket needs your input');
  assert.strictEqual(TaskBoard.attentionMessage(3), 'Task Board: 3 tickets need your input');
  TaskBoard.attention = [{ id: 'a', sessionId: 's1', status: 'needs_input', message: 'Pick <one>' }];
  assert.strictEqual(TaskBoard.attentionBadgeHtml('s1'), '<span class="tb-badge tb-badge--needs_input" title="Pick &lt;one&gt;">needs input</span>');
  assert.strictEqual(TaskBoard.attentionBadgeHtml('s2'), '');
  TaskBoard.attention = [];
});

test('all done: only when the last running ticket finishes into Done', () => {
  assert.ok(TaskBoard.allDone({ active: 2, done: 1 }, { active: 0, done: 3 }));
  assert.ok(!TaskBoard.allDone(null, { active: 0, done: 3 }), 'not on the first check');
  assert.ok(!TaskBoard.allDone({ active: 1, done: 1 }, { active: 0, done: 1 }), 'stopped, not done');
  assert.ok(!TaskBoard.allDone({ active: 2, done: 1 }, { active: 1, done: 2 }), 'one still running');
  assert.ok(!TaskBoard.allDone({ active: 0, done: 1 }, { active: 0, done: 2 }));
});

test('the session banner names the ticket and its stage', () => {
  const html = TaskBoard.sessionInfoHtml({ title: 'Fix <login>', notes: '', column: 's1', run: { status: 'running' } }, { index: 1, total: 3, title: 'Build' });
  assert.match(html, /<strong>Fix &lt;login&gt;<\/strong> · stage 2\/3: Build\./);
  assert.match(TaskBoard.sessionInfoHtml({ title: '', notes: 'first line\nmore', column: 's1' }, null), /<strong>first line<\/strong>\./);
});

function flowWf() {
  const wf = { available: [], missing: [], stages: [
    { id: 's-a', title: 'Triage', type: 'prompt', prompt: 'x', next: 's-b', branches: [{ when: 'a <bug>', to: 'done' }] },
    { id: 's-b', title: 'Fix', type: 'prompt', prompt: 'y', next: 'done', branches: [] }
  ] };
  Flow.prepare(wf);
  return wf;
}

test('a condition arrow carries its text; the default arrow then says otherwise', () => {
  const wf = flowWf();
  const html = Flow.svgHtml(wf, null);
  assert.match(html, /data-edge="s-a\|0"/);
  assert.match(html, /tbf-edge tbf-edge--branch/);
  assert.match(html, /a &lt;bug&gt;<title>/);
  assert.match(html, /tbf-label tbf-label--dim[^>]*>otherwise/);
  wf.sel = { edge: 's-a|0' };
  const panel = Flow.panelHtml(wf);
  assert.match(panel, /value="a &lt;bug&gt;"/);
  assert.match(panel, /<option value="done" selected>Done<\/option>/);
  assert.match(panel, /Make default/);
});

test('drawing arrows: Ready picks the first stage, a stage without a default gets it, then conditions', () => {
  const wf = flowWf();
  assert.strictEqual(Flow.connect(wf, 'ready', 's-b'), true);
  assert.deepStrictEqual(wf.stages.map(s => s.id), ['s-b', 's-a']);
  assert.strictEqual(Flow.connect(wf, 'ready', 'done'), false);
  assert.strictEqual(Flow.connect(wf, 's-a', 'ready'), false);
  const c = Flow.newStage(wf, 's-c');
  assert.strictEqual(c.next, '');
  assert.match(Flow.svgHtml(wf, null), /tbf-node--open" data-node="s-c"/);
  Flow.connect(wf, 's-c', 's-a');
  assert.strictEqual(c.next, 's-a');
  Flow.connect(wf, 's-c', 'done');
  assert.deepStrictEqual(plain(c.branches), [{ when: '', to: 'done' }]);
  assert.deepStrictEqual(plain(wf.sel), { edge: 's-c|0' });
  for (let i = 0; i < 3; i++) Flow.connect(wf, 's-c', 's-c');
  assert.strictEqual(Flow.connect(wf, 's-c', 's-b'), 'limit');
});

test('make default swaps a condition with the default arrow; arrows into a deleted stage go with it', () => {
  const wf = flowWf();
  Flow.makeDefault(wf, 's-a|0');
  assert.strictEqual(wf.stages[0].next, 'done');
  assert.deepStrictEqual(plain(wf.stages[0].branches), [{ when: 'a <bug>', to: 's-b' }]);
  Flow.removeStage(wf, 's-b');
  assert.deepStrictEqual(plain(wf.stages[0].branches), []);
  Flow.removeEdge(wf, 's-a|next');
  assert.strictEqual(wf.stages[0].next, '');
  assert.match(Flow.svgHtml(wf, null), /tbf-node--stage tbf-node--open/);
  Flow.removeEdge(wf, 'ready|start');
  assert.strictEqual(Flow.edges(wf)[0].kind, 'start', 'Ready always has its arrow');
});

test('an arrow can be pointed elsewhere: the Ready arrow, a default arrow and a condition', () => {
  const wf = flowWf();
  Flow.setTarget(wf, 'ready|start', 's-b');
  assert.strictEqual(wf.stages[0].id, 's-b');
  Flow.setTarget(wf, 's-a|next', 'done');
  assert.strictEqual(Flow.stageById(wf, 's-a').next, 'done');
  Flow.setTarget(wf, 's-a|0', 's-a');
  assert.strictEqual(Flow.stageById(wf, 's-a').branches[0].to, 's-a');
  wf.sel = { edge: 's-a|next' };
  assert.match(Flow.panelHtml(wf), /Default path from <strong>Triage<\/strong>/);
});

test('arrows bend apart between the same boxes, and loops go over the top', () => {
  const a = { x: 0, y: 100 };
  const b = { x: 300, y: 100 };
  assert.notStrictEqual(Flow.edgePath(a, b, 0).ly, Flow.edgePath(a, b, 1).ly);
  assert.ok(Flow.edgePath(a, a, 0).ly < a.y);
  assert.ok(Flow.edgePath(b, a, 0).ly < a.y, 'a backward arrow goes over the top');
});

test('Recommend loads a chain of stages ending in Done', () => {
  const render = TaskBoard.renderWorkflow;
  TaskBoard.renderWorkflow = () => {};
  context.toast = () => {};
  TaskBoard._wf = { stages: [], recommended: [{ title: 'Plan', type: 'prompt', ref: '', prompt: 'p' }, { title: 'Build', type: 'prompt', ref: '', prompt: 'b' }] };
  TaskBoard.wfRecommend();
  const [s1, s2] = TaskBoard._wf.stages;
  assert.match(s1.id, /^s-[a-z0-9]{8}$/);
  assert.strictEqual(s1.next, s2.id);
  assert.strictEqual(s2.next, 'done');
  TaskBoard._wf = null;
  TaskBoard.renderWorkflow = render;
  delete context.toast;
});

test('deleting a Done ticket with a worktree says the worktree and branch go too', () => {
  assert.match(TaskBoard.deleteMessageHtml({ column: 'done', worktree: 'cm-ab12' }), /<code>\.claude\/worktrees\/cm-ab12<\/code> and branch <code>worktree-cm-ab12<\/code> are removed too/);
  assert.ok(!TaskBoard.deleteMessageHtml({ column: 'todo', worktree: 'cm-ab12' }).includes('worktree'));
  assert.ok(!TaskBoard.deleteMessageHtml({ column: 'done' }).includes('worktree'));
});

test('the sidebar shows how many tickets are in workflow progress, hidden at zero', async () => {
  const badges = { 'nav-task-board-attention': { style: {} }, 'nav-task-board-progress': { style: {} } };
  const progress = badges['nav-task-board-progress'];
  Object.assign(context, {
    document: { getElementById: id => badges[id] },
    ActiveSessionsBar: { _render() {}, _renderSidebar() {} },
    App: { currentView: 'task-board' },
    toast() {}
  });
  context.api = async () => ({ waiting: [], active: 3, inProgress: 2, done: 0 });
  await TaskBoard.refreshAttention();
  assert.strictEqual(progress.textContent, 2);
  assert.strictEqual(progress.style.display, '');
  context.api = async () => ({ waiting: [], active: 0, inProgress: 0, done: 0 });
  await TaskBoard.refreshAttention();
  assert.strictEqual(progress.style.display, 'none');
  TaskBoard._progress = null;
});

test('a newly waiting ticket raises a 15s toast that opens its session on click', async () => {
  const toasts = [];
  Object.assign(context, {
    document: { getElementById: () => null },
    ActiveSessionsBar: { _render() {}, _renderSidebar() {} },
    App: { currentView: 'sessions' },
    toast: (msg, type, opts) => toasts.push({ msg, type, opts })
  });
  const opened = [];
  const openSession = TaskBoard.openSession;
  TaskBoard.openSession = card => opened.push(card.id);
  TaskBoard.attention = [{ id: 'a', sessionId: 's1' }];
  const waiting = [{ id: 'a', sessionId: 's1' }, { id: 'b', sessionId: 's2', sessionSlug: 'C--work-b' }];
  context.api = async () => ({ waiting, active: 2, inProgress: 2, done: 0 });
  await TaskBoard.refreshAttention();
  assert.strictEqual(toasts.length, 1);
  assert.strictEqual(toasts[0].msg, 'Task Board: 2 tickets need your input');
  assert.strictEqual(toasts[0].opts.duration, 15000);
  toasts[0].opts.onClick();
  assert.deepStrictEqual(opened, ['b']);
  context.api = async () => ({ waiting: [...waiting, { id: 'c', sessionId: '' }], active: 3, inProgress: 3, done: 0 });
  await TaskBoard.refreshAttention();
  assert.strictEqual(toasts[1].opts.onClick, undefined, 'no session yet: nothing to open');
  TaskBoard.openSession = openSession;
  TaskBoard.attention = [];
  TaskBoard._progress = null;
});

test('a ticket that took a condition shows it on its card', () => {
  const card = { id: 'r', title: 'T', notes: '', project: 'p', column: 's-b', closed: false, run: { status: 'running' }, branch: { from: 'Triage', when: 'a <bug>' } };
  assert.match(TaskBoard.cardHtml(card, null, false), /tb-card-branch" title="Condition taken after Triage">If a &lt;bug&gt;</);
  assert.ok(!TaskBoard.cardHtml(Object.assign({}, card, { column: 'done' }), null, false).includes('tb-card-branch'));
});

test('a ticket with a worktree shows its branch on the card, in compact mode on hover, and in the session banner', () => {
  const card = { id: 'g', title: 'Fix login', notes: '', project: 'p', column: 'done', worktree: 'cm-ab12', gitBranch: 'worktree-cm-ab12' };
  assert.match(TaskBoard.cardHtml(card, null, false), /class="tb-card-git" title="Worktree branch">&#5833; worktree-cm-ab12</);
  assert.match(TaskBoard.cardHtml(card, null, true), /title="Fix login\nBranch: worktree-cm-ab12"/);
  assert.match(TaskBoard.sessionInfoHtml(card, null), /on branch <code>worktree-cm-ab12<\/code>/);
  assert.strictEqual(TaskBoard.gitBranchOf({ worktree: 'cm-old' }), 'worktree-cm-old', 'tickets from before gitBranch was stored');
  assert.ok(!TaskBoard.cardHtml({ id: 'n', title: 'x', notes: '', column: 'todo' }, null, false).includes('tb-card-git'));
});

test('a ticket in Finalize is still in the workflow and says so in the session banner', () => {
  assert.ok(TaskBoard.inWorkflow({ column: 'finalize' }));
  assert.ok(!TaskBoard.canMove({ column: 'finalize' }, 'done'));
  assert.match(TaskBoard.sessionInfoHtml({ title: 'T', notes: '', column: 'finalize' }, { finalize: true, title: 'Finalize' }), /<strong>T<\/strong> · Finalize\./);
});
