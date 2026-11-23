const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const escapeHtml = t => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const decodeName = slug => slug.replace(/^[A-Za-z]--/, '').split('-').filter(Boolean).slice(-2).join('/');
const read = name => fs.readFileSync(path.join(__dirname, '..', 'public', 'js', name), 'utf-8');
const context = vm.createContext({ escapeHtml, escapeAttr: escapeHtml, decodeName });
vm.runInContext(read('worktree-changes.js') + '\n' + read('task-board-flow.js') + '\n' + read('task-board.js') + '\nglobalThis._TaskBoard = TaskBoard; globalThis._Flow = TaskBoardFlow;', context);
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

test('switching a stage to Workflow drops its reference and fills the default prompt once', () => {
  const wf = { available: WF.available, stages: [{ id: 's-w', title: 'Deep review', type: 'skill', ref: 'writing-plans', prompt: '' }], sel: { node: 's-w' } };
  TaskBoard._wf = wf;
  const render = Flow.render;
  Flow.render = () => {};
  Flow.setStage('s-w', 'type', 'workflow');
  const s = wf.stages[0];
  assert.deepStrictEqual([s.ref, s.prompt], ['', Flow.WORKFLOW_PROMPT]);
  s.prompt = 'Mine';
  Flow.setStage('s-w', 'type', 'workflow');
  assert.strictEqual(s.prompt, 'Mine');
  const html = Flow.panelHtml(wf);
  assert.match(html, /<option value="workflow" selected>Workflow<\/option>/);
  assert.match(html, /What the workflow should do/);
  assert.ok(!html.includes('writing-plans · project'), 'no skill or agent picker');
  assert.strictEqual(TaskBoard.stageLabel(s), 'workflow: Mine');
  Flow.render = render;
  TaskBoard._wf = null;
});

test('the diff view shows current and recommended stages side by side', () => {
  const html = TaskBoard.workflowHtml(Object.assign({}, WF, { diff: true }));
  assert.match(html, /<h4>Current<\/h4>/);
  assert.match(html, /<h4>Recommended<\/h4>/);
  assert.match(html, /skill: writing-plans/);
  assert.match(html, /Use recommended/);
  assert.match(html, /Keep current/);
});

test('the toolbar has the Saved menu, Export and Import', () => {
  const none = TaskBoard.workflowHtml(WF);
  assert.match(none, />Saved <span class="dd-arrow">/);
  assert.match(none, /No saved workflows/);
  assert.match(none, /TaskBoard.wfSaveAs\(\)/);
  assert.match(none, /TaskBoard.wfExport\(\)"[^>]*>Export</);
  assert.match(none, /id="tb-wf-file"[^>]*onchange="TaskBoard.wfImportFile\(this\)"/);
  const html = TaskBoard.workflowHtml(Object.assign({}, WF, { saved: [{ name: 'Std <x>', stages: [] }, { name: 'Bugfix', stages: [] }] }));
  assert.match(html, />Saved · 2 </);
  assert.match(html, /TaskBoard.wfLoad\(0\)" title="Load into the editor">Std &lt;x&gt;</);
  assert.match(html, /TaskBoard.wfDeleteSaved\(1\)/);
  assert.ok(!html.includes('No saved workflows'));
});

test('the Saved menu marks the saved workflow the stages match, ignoring box positions', () => {
  const copy = WF.stages.map(s => Object.assign({}, s, { pos: { x: 999, y: 999 } }));
  const changed = WF.stages.map((s, i) => Object.assign({}, s, i ? { prompt: 'Other' } : {}));
  const html = TaskBoard.workflowHtml(Object.assign({}, WF, { saved: [{ name: 'Bugfix', stages: [] }, { name: 'Std <x>', stages: copy }] }));
  assert.match(html, />Saved: Std &lt;x&gt; </);
  assert.match(html, /id="tb-wf-saved-menu" data-active="1"/);
  assert.match(html, /tb-wf-saved-row active" aria-current="true">\s*<button[^>]*TaskBoard.wfLoad\(1\)" title="In use">&#10003; Std &lt;x&gt;</);
  assert.strictEqual((html.match(/tb-wf-saved-row active/g) || []).length, 1);
  const none = TaskBoard.workflowHtml(Object.assign({}, WF, { saved: [{ name: 'Std', stages: changed }] }));
  assert.match(none, />Saved · 1 </);
  assert.match(none, /data-active="-1"/);
  assert.ok(!none.includes('tb-wf-saved-row active'));
});

test('export keeps the stage fields and drops editor state', () => {
  const data = plain(TaskBoard.exportData(Object.assign({}, WF, { slug: 'C--work-alpha' })));
  assert.strictEqual(data.name, 'work/alpha');
  assert.deepStrictEqual(Object.keys(data.stages[0]).sort(), ['branches', 'id', 'next', 'pos', 'prompt', 'ref', 'title', 'type']);
  assert.deepStrictEqual(data.stages.map(s => s.title), ['Plan', 'Do <it>']);
});

test('an empty workflow invites Recommend', () => {
  const html = TaskBoard.workflowHtml(Object.assign({}, WF, { stages: [], skillsChanged: false }));
  assert.match(html, /No stages yet/);
  assert.ok(!html.includes('Compare with recommended'));
  assert.ok(!html.includes('data-edge'));
});

test('compact cards are one line: heading, closed badge and stage dots', () => {
  const html = TaskBoard.html(STAGED, [], true);
  assert.match(html, /tb-card tb-card--line" draggable="true" data-id="w"\s/);
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

test('deleting a ticket with a worktree says the worktree goes and the branch is kept', () => {
  for (const column of ['todo', 'finalize', 'done']) {
    assert.match(TaskBoard.deleteMessageHtml({ column, worktree: 'cm-ab12' }), /<code>\.claude\/worktrees\/cm-ab12<\/code> is removed; branch <code>worktree-cm-ab12<\/code> is kept/);
  }
  assert.ok(!TaskBoard.deleteMessageHtml({ column: 'done' }).includes('worktree'));
  assert.match(TaskBoard.deleteMessageHtml({ column: 'finalize', finalized: true, worktree: 'cm-ab12', gitBranch: 'feature/login' }), /branch <code>feature\/login<\/code> is kept/);
  assert.match(TaskBoard.deleteMessageHtml({ column: 'done', worktree: 'cm-ab12' }), /uncommitted changes, it is kept and you can force-remove it, which discards them/);
});

test('a Finalize ticket waiting on its branch: merge or PR badge, deletable, no longer in the workflow', () => {
  const card = { id: 'w', title: 'Fix login', notes: '', project: 'p', column: 'finalize', finalized: true, worktree: 'cm-ab12',
    gitBranch: 'fix/login', baseBranch: 'main', run: { status: 'done', message: 'Ready: merge fix/login into main or create a PR' } };
  assert.ok(!TaskBoard.inWorkflow(card));
  assert.ok(TaskBoard.canDelete(card));
  assert.ok(!TaskBoard.canDelete({ column: 'finalize' }));
  const html = TaskBoard.cardHtml(card, null, false);
  assert.match(html, /tb-badge--ready[^>]*>merge or PR</);
  assert.match(html, /&#5833; fix\/login &larr; main</);
  assert.match(html, /tb-card-run">Ready: merge fix\/login into main or create a PR</);
  assert.match(html, /tb-card-delete/);
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

test('the tab badge counts waiting tickets plus waiting browser-terminal sessions', async () => {
  const counts = [];
  Object.assign(context, {
    document: { getElementById: () => null },
    ActiveSessionsBar: { _render() {}, _renderSidebar() {} },
    App: { currentView: 'task-board' },
    TabBadge: { set: n => counts.push(n) }
  });
  context.api = async url => (url === '/api/terminal/attention'
    ? { waiting: 2 }
    : { waiting: [{ id: 'a', sessionId: 's1' }], active: 1, inProgress: 1, done: 0 });
  await TaskBoard.refreshAttention();
  context.api = async url => {
    if (url === '/api/terminal/attention') throw new Error('down');
    return { waiting: [], active: 0, inProgress: 0, done: 0 };
  };
  await TaskBoard.refreshAttention();
  context.api = async url => {
    if (url === '/api/terminal/attention') return { waiting: 1 };
    throw new Error('down');
  };
  TaskBoard.attention = [{ id: 'b', sessionId: 's2' }];
  await TaskBoard.refreshAttention();
  assert.deepStrictEqual(counts, [3, 0, 2], 'a failed ticket call still updates the sessions count');
  delete context.TabBadge;
  TaskBoard.attention = [];
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

test('a re-render keeps each lane\'s horizontal scroll position', () => {
  const lanes = keys => keys.map(k => { const cols = { scrollLeft: 0 }; return { dataset: { lane: k }, cols, querySelector: () => cols }; });
  let current = lanes(['C--work-alpha', 'C--work-zeta']);
  const body = {
    querySelectorAll: () => current,
    set innerHTML(_) { current = lanes(['C--work-alpha', 'C--work-zeta']); }
  };
  Object.assign(context, { document: { getElementById: id => (id === 'task-board-body' ? body : null) } });
  context.localStorage = { getItem: k => (k === TaskBoard.COMPACT_KEY ? '0' : null), setItem() {} };
  const board = TaskBoard.board;
  TaskBoard.board = BOARD;
  current[1].cols.scrollLeft = 240;
  TaskBoard.render();
  assert.strictEqual(current[0].cols.scrollLeft, 0);
  assert.strictEqual(current[1].cols.scrollLeft, 240);
  delete context.localStorage;
  TaskBoard.board = board;
});

test('a ticket that took a condition shows it on its card', () => {
  const card = { id: 'r', title: 'T', notes: '', project: 'p', column: 's-b', closed: false, run: { status: 'running' }, branch: { from: 'Triage', when: 'a <bug>' } };
  assert.match(TaskBoard.cardHtml(card, null, false), /tb-card-branch" title="Condition taken after Triage">If a &lt;bug&gt;</);
  assert.ok(!TaskBoard.cardHtml(Object.assign({}, card, { column: 'done' }), null, false).includes('tb-card-branch'));
});

test('a recognised ticket type shows its icon before the heading, in both card modes', () => {
  const card = { id: 'k', title: 'Fix login', notes: '', column: 'done', kind: 'bug' };
  assert.match(TaskBoard.cardHtml(card, null, false), /<div class="tb-card-title"><span class="tb-card-kind tb-card-kind--bug" title="Bug"[^]*?<\/span>Fix login<\/div>/);
  assert.match(TaskBoard.cardHtml(card, null, true), /<span class="tb-line-text"><span class="tb-card-kind tb-card-kind--bug"/);
  for (const kind of ['feature', 'question', 'other']) assert.match(TaskBoard.kindIconHtml({ kind }), new RegExp('tb-card-kind--' + kind));
  assert.strictEqual(TaskBoard.kindIconHtml({}), '');
  assert.strictEqual(TaskBoard.kindIconHtml({ kind: 'chore' }), '');
});

test('a ticket with a worktree shows its branch on the card, in the hover preview header, and in the session banner', () => {
  const card = { id: 'g', title: 'Fix login', notes: '', project: 'p', column: 'done', worktree: 'cm-ab12', gitBranch: 'worktree-cm-ab12' };
  assert.match(TaskBoard.cardHtml(card, null, false), /class="tb-card-git" title="Ticket branch">&#5833; worktree-cm-ab12</);
  assert.ok(!/data-id="g" title=/.test(TaskBoard.cardHtml(card, null, true)), 'no card tooltip in compact mode');
  assert.strictEqual(TaskBoard.previewHeadHtml(card), '<div class="tb-preview-head"><div class="tb-preview-title">Fix login</div><div class="tb-preview-branch">Branch: worktree-cm-ab12</div></div>');
  assert.match(TaskBoard.sessionInfoHtml(card, null), /on branch <code>worktree-cm-ab12<\/code>/);
  assert.strictEqual(TaskBoard.gitBranchOf({ worktree: 'cm-old' }), 'worktree-cm-old', 'tickets from before gitBranch was stored');
  assert.ok(!TaskBoard.cardHtml({ id: 'n', title: 'x', notes: '', column: 'todo' }, null, false).includes('tb-card-git'));
});

test('a worktree ticket shows its uncommitted and unmerged changes on the card, in every column', () => {
  const saved = TaskBoard.board;
  try {
    TaskBoard.board = { cards: [], projects: {}, worktreeStatus: {
      w: { base: 'main', files: [{ path: 'a.txt', label: 'modified' }], unmerged: [], unmergedCount: 0 },
      gone: { missing: true }
    } };
    const card = { id: 'w', title: 'Fix', notes: '', project: 'C--p', column: 'done', worktree: 'cm-ab12' };
    const out = TaskBoard.cardHtml(card, null, false);
    assert.match(out, /<div class="tb-card-wt"><span class="wt-changes wt-changes--pending"/);
    assert.match(out, /1 uncommitted/);
    assert.match(out, /data-slug="C--p--claude-worktrees-cm-ab12"/);
    assert.match(TaskBoard.cardHtml({ ...card, id: 'gone', column: 'todo' }, null, false), /worktree removed/);
    assert.ok(!TaskBoard.cardHtml({ ...card, id: 'unknown' }, null, false).includes('tb-card-wt'), 'no status yet');
    assert.ok(!TaskBoard.cardHtml({ id: 'n', title: 'x', notes: '', column: 'done' }, null, false).includes('tb-card-wt'), 'no worktree');
  } finally {
    TaskBoard.board = saved;
  }
});

test('a ticket in Finalize is still in the workflow and says so in the session banner', () => {
  assert.ok(TaskBoard.inWorkflow({ column: 'finalize' }));
  assert.ok(!TaskBoard.canMove({ column: 'finalize' }, 'done'));
  assert.match(TaskBoard.sessionInfoHtml({ title: 'T', notes: '', column: 'finalize' }, { finalize: true, title: 'Finalize' }), /<strong>T<\/strong> · Finalize\./);
});

test('a lane shows the project branch only when git gives one', () => {
  const withBranch = Object.assign({}, BOARD, { projectBranches: { 'C--work-zeta': 'feature/<x>', 'C--work-alpha': '' } });
  assert.match(TaskBoard.laneHtml(withBranch, 'C--work-zeta'), /class="tb-card-git tb-lane-git"[^>]*>&#5833; feature\/&lt;x&gt;</);
  assert.doesNotMatch(TaskBoard.laneHtml(withBranch, 'C--work-alpha'), /tb-lane-git/);
  assert.doesNotMatch(TaskBoard.laneHtml(BOARD, 'C--work-zeta'), /tb-lane-git/);
});

test('Finalize and Done cards show a notes button with done/total to-dos', () => {
  const card = { id: '9', title: 'T', notes: '', project: 'C--work-zeta', column: 'done', closed: false, memo: 'wait\nmore', todos: [{ text: 'a', done: true }, { text: 'b', done: false }] };
  const html = TaskBoard.cardHtml(card, [], false);
  assert.match(html, /tb-card-memo tb-card-memo--has tb-card-memo--open/);
  assert.match(html, /1\/2/);
  assert.match(html, /title="wait"/);
  assert.match(TaskBoard.cardHtml(card, [], true), /tb-card-memo/);
  assert.doesNotMatch(TaskBoard.cardHtml({ ...card, column: 'todo' }, [], false), /tb-card-memo/);
  assert.doesNotMatch(TaskBoard.memoIconHtml({ ...card, memo: '', todos: [] }), /--has/);
});

test('a kept worktree on delete opens the Force remove dialog, which posts project and worktree', async () => {
  const load = TaskBoard.load;
  const modals = [];
  const calls = [];
  const toasts = [];
  let deleted = { ok: true, warning: 'The worktree .claude/worktrees/cm-ab12cd34 was kept: dirty', project: 'p', worktree: 'cm-ab12cd34' };
  let fail = false;
  TaskBoard.load = async () => {};
  Object.assign(context, {
    openModal: m => { modals.push(m); },
    api: async (url, opts) => {
      calls.push({ url, opts });
      if (opts.method === 'DELETE') return deleted;
      if (fail) throw new Error('nope');
      return { ok: true };
    },
    toast: (msg, type) => toasts.push({ msg, type })
  });
  TaskBoard.board = { projects: {}, cards: [{ id: 'x', project: 'p', column: 'done', worktree: 'cm-ab12cd34' }] };
  try {
    TaskBoard.confirmDelete('x');
    await modals[0].buttons[0].onClick();
    assert.strictEqual(modals.length, 2);
    assert.strictEqual(modals[1].title, 'Worktree kept');
    assert.match(modals[1].body, /was kept: dirty/);
    assert.strictEqual(modals[1].buttons[0].label, 'Force remove');
    assert.strictEqual(toasts.length, 0, 'a dialog, not a toast');

    await modals[1].buttons[0].onClick();
    assert.deepStrictEqual(plain(calls[1]), { url: '/api/task-board/worktrees/force-remove', opts: { method: 'POST', body: { project: 'p', worktree: 'cm-ab12cd34' } } });
    fail = true;
    await modals[1].buttons[0].onClick();
    assert.deepStrictEqual(plain(toasts), [{ msg: 'nope', type: 'error' }]);

    deleted = { ok: true, warning: '' };
    TaskBoard.confirmDelete('x');
    await modals[2].buttons[0].onClick();
    assert.strictEqual(modals.length, 3, 'removed worktree: no dialog');
  } finally {
    TaskBoard.load = load;
  }
});

test('a ticket moved back to ToDo opens with a follow-up question and its notes to edit', () => {
  let modal = null;
  Object.assign(context, {
    openModal: m => { modal = m; },
    formGroup: (label, input) => `<label>${label}</label>${input}`,
    setTimeout: () => {},
    Projects: { data: [] }
  });
  TaskBoard.board = BOARD;
  TaskBoard.openEditor('1', null, true);
  assert.strictEqual(modal.title, 'Follow up ticket');
  assert.match(modal.body, /^<p class="tb-editor-question">What should change\?/);
  assert.match(modal.body, /<textarea id="tb-notes"[^>]*>first line\nsecond<\/textarea>/);
  assert.doesNotMatch(modal.body, /readonly/);
  TaskBoard.openEditor('1');
  assert.strictEqual(modal.title, 'Edit ticket');
  assert.doesNotMatch(modal.body, /tb-editor-question/);
});

test('dropping a ticket from Done into ToDo opens the follow-up dialog, other drops (Ready to ToDo too) do not', async () => {
  const load = TaskBoard.load;
  const openEditor = TaskBoard.openEditor;
  const opened = [];
  let fail = false;
  TaskBoard.load = async () => {};
  TaskBoard.openEditor = (...args) => opened.push(args);
  Object.assign(context, {
    api: async () => { if (fail) throw new Error('nope'); },
    toast: () => {}
  });
  const drop = async (card, column) => {
    TaskBoard._drag = card;
    const col = { dataset: { lane: card.project, column }, classList: { remove() {} }, querySelectorAll: () => [] };
    await TaskBoard.onDrop({ currentTarget: col, clientY: 0, preventDefault() {} });
  };
  try {
    await drop({ id: 'd', project: 'p', column: 'done' }, 'todo');
    await drop({ id: 'r', project: 'p', column: 'ready' }, 'todo');
    await drop({ id: 't', project: 'p', column: 'todo' }, 'ready');
    await drop({ id: 'k', project: 'p', column: 'todo' }, 'todo');
    fail = true;
    await drop({ id: 'f', project: 'p', column: 'done' }, 'todo');
  } finally {
    TaskBoard.load = load;
    TaskBoard.openEditor = openEditor;
  }
  assert.deepStrictEqual(plain(opened), [['d', null, true]]);
});

/** The preview's message list: its innerHTML is the shown conversation. */
function fakeList() {
  return {
    innerHTML: '',
    insertAdjacentHTML(pos, h) { this.innerHTML += h; },
    querySelector() { const el = this; return el.innerHTML.includes('tb-preview-loader') ? { remove() { el.innerHTML = el.innerHTML.replace(/<div class="loading tb-preview-loader">.*?Loading\.\.\.<\/div>/, ''); } } : null; }
  };
}

function previewEnv({ cards, api }) {
  const timers = [];
  const appended = [];
  const anchor = { getBoundingClientRect: () => ({ top: 100, left: 50, right: 250 }) };
  Object.assign(context, {
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    clearTimeout: id => { if (id) timers[id - 1].cleared = true; },
    CSS: { escape: s => s },
    window: { innerWidth: 1600, innerHeight: 900 },
    document: {
      activeElement: null,
      querySelector: () => anchor,
      createElement: () => {
        const text = { value: '', disabled: true };
        const note = { textContent: '' };
        const list = fakeList();
        const input = { querySelector: s => (s === 'textarea' ? text : note) };
        return {
          style: {}, offsetWidth: 520, offsetHeight: 480, scrollTop: 0, clientHeight: 480, scrollHeight: 2000,
          list, text, note,
          contains: () => false,
          remove() { this.removed = true; },
          querySelector: s => (s === '.tb-preview-list' ? list : s === '.tb-preview-input textarea' ? text : s === '.tb-preview-input' ? input : null)
        };
      },
      body: { appendChild: el => appended.push(el) }
    },
    showLoading: (el, text) => { el.innerHTML = 'LOADING ' + text; },
    addCodeCopyButtons: () => {},
    Sessions: { renderMessage: m => `<msg>${m.text}</msg>` },
    SessionInput: { NOTES: { none: 'no pty', busy: 'working', question: 'answer first', ready: '' } },
    toast: () => {},
    api: (url, opts) => (url.endsWith('/input-state') || url.endsWith('/input') ? Promise.resolve({ state: 'none' }) : api(url, opts))
  });
  TaskBoard.board = { cards, projects: {} };
  TaskBoard._drag = null;
  TaskBoard._preview = { id: null };
  return { timers, appended };
}

test('hovering a ticket with a session shows its last messages after a second, loading first', async () => {
  const calls = [];
  let release;
  const gate = new Promise(r => { release = r; });
  const { timers, appended } = previewEnv({
    cards: [{ id: 'a', project: 'C--p', sessionSlug: 'C--p-wt', sessionId: 's1' }],
    api: async url => {
      calls.push(url);
      await gate;
      return { total: 25, messages: [{ text: 'newest' }, { text: 'older' }] };
    }
  });
  TaskBoard.hoverCard('a');
  assert.strictEqual(timers.length, 1);
  assert.strictEqual(timers[0].ms, 1000);
  assert.strictEqual(appended.length, 0);
  const shown = timers[0].fn();
  assert.match(appended[0].list.innerHTML, /LOADING/);
  assert.strictEqual(appended[0].style.left, '258px');
  release();
  await shown;
  assert.deepStrictEqual(calls, ['/api/projects/C--p-wt/sessions/s1?offset=0&limit=20']);
  assert.strictEqual(appended[0].list.innerHTML, '<msg>newest</msg><msg>older</msg>');
});

test('leaving a ticket before a second shows no preview', () => {
  const { timers } = previewEnv({ cards: [{ id: 'a', project: 'p', sessionId: 's1' }], api: async () => ({}) });
  TaskBoard.hoverCard('a');
  TaskBoard.leavePreview();
  assert.ok(timers[0].cleared);
  assert.strictEqual(TaskBoard._preview.id, null);
});

test('a ticket without a session shows a header-only preview and loads nothing', async () => {
  const calls = [];
  const { timers, appended } = previewEnv({
    cards: [{ id: 'b', project: 'p', title: 'Plan <x>', notes: '', worktree: 'cm-1', gitBranch: 'worktree-cm-1' }],
    api: async url => { calls.push(url); return {}; }
  });
  TaskBoard.hoverCard('b');
  assert.strictEqual(timers[0].ms, 1000);
  await timers[0].fn();
  const el = appended[0];
  assert.strictEqual(el.className, 'tb-preview tb-preview--head');
  assert.strictEqual(el.innerHTML, '<div class="tb-preview-top"><div class="tb-preview-head"><div class="tb-preview-title">Plan &lt;x&gt;</div><div class="tb-preview-branch">Branch: worktree-cm-1</div></div></div>');
  assert.strictEqual(el.style.left, '258px');
  assert.deepStrictEqual(calls, []);
});

test('a header-only preview becomes a full one when its ticket gets a session while hovered', async () => {
  const calls = [];
  const { timers, appended } = previewEnv({
    cards: [{ id: 'b', project: 'p', title: 'T', notes: '' }],
    api: async url => { calls.push(url); return { total: 0, messages: [] }; }
  });
  context.document.elementFromPoint = () => ({ closest: () => ({ dataset: { id: 'b' } }) });
  TaskBoard.onPointerMove({ clientX: 1, clientY: 2 });
  TaskBoard.hoverCard('b');
  await timers[0].fn();
  TaskBoard.checkPreview();
  assert.strictEqual(appended.length, 1, 'no session yet: preview kept as is');
  TaskBoard.board.cards[0].sessionId = 's9';
  await TaskBoard.checkPreview();
  assert.ok(appended[0].removed);
  assert.strictEqual(appended.length, 2);
  assert.strictEqual(appended[1].className, 'tb-preview');
  assert.strictEqual(TaskBoard._preview.id, 'b');
  assert.ok(!TaskBoard._preview.headOnly);
});

test('a ticket with a session shows the header above the message box', async () => {
  const { timers, appended } = previewEnv({
    cards: [{ id: 'a', project: 'p', sessionId: 's1', title: '', notes: 'First line\nsecond' }],
    api: async () => ({ total: 0, messages: [] })
  });
  TaskBoard.hoverCard('a');
  await timers[0].fn();
  assert.match(appended[0].innerHTML, /^<div class="tb-preview-top"><div class="tb-preview-head"><div class="tb-preview-title">First line<\/div><\/div><div class="tb-preview-input">/);
  assert.ok(!appended[0].innerHTML.includes('tb-preview-branch'));
  assert.strictEqual(appended[0].className, 'tb-preview');
});

test('a preview whose ticket was left before it loaded is not filled', async () => {
  const { timers, appended } = previewEnv({
    cards: [{ id: 'a', project: 'p', sessionId: 's1' }],
    api: async () => ({ total: 3, messages: [{ text: 'x' }] })
  });
  TaskBoard.hoverCard('a');
  const shown = timers[0].fn();
  TaskBoard.hidePreview();
  await shown;
  assert.ok(appended[0].removed);
  assert.match(appended[0].list.innerHTML, /LOADING/);
});

test('a shown preview stays while the pointer moves into it and closes after leaving it', async () => {
  const { timers, appended } = previewEnv({
    cards: [{ id: 'a', project: 'p', sessionId: 's1' }],
    api: async () => ({ total: 0, messages: [] })
  });
  TaskBoard.hoverCard('a');
  await timers[0].fn();
  assert.match(appended[0].list.innerHTML, /No messages/);
  TaskBoard.leavePreview();
  appended[0].onmouseenter();
  assert.ok(timers[1].cleared);
  appended[0].onmouseleave();
  assert.strictEqual(timers[2].ms, 600);
  context.document.elementFromPoint = () => null;
  timers[2].fn();
  assert.ok(appended[0].removed);
});

test('passing over other cards keeps the open preview; once it closes, the card under the pointer starts its own', async () => {
  const { timers, appended } = previewEnv({
    cards: [{ id: 'a', project: 'p', sessionId: 's1' }, { id: 'b', project: 'p', sessionId: 's2' }],
    api: async () => ({ total: 0, messages: [] })
  });
  TaskBoard.hoverCard('a');
  await timers[0].fn();
  TaskBoard.leavePreview();
  TaskBoard.hoverCard('b');
  assert.strictEqual(TaskBoard._preview.id, 'a');
  assert.ok(!appended[0].removed);
  TaskBoard.onPointerMove({ clientX: 1, clientY: 2 });
  context.document.elementFromPoint = () => ({ closest: () => ({ dataset: { id: 'b' } }) });
  timers[1].fn();
  assert.ok(appended[0].removed);
  assert.strictEqual(TaskBoard._preview.id, 'b');
  assert.strictEqual(timers[2].ms, 1000);
});

test('pointer events only start or leave a preview when crossing a card edge', () => {
  const { timers } = previewEnv({ cards: [{ id: 'a', project: 'p', sessionId: 's1' }], api: async () => ({}) });
  const inner = {};
  const card = { dataset: { id: 'a' }, contains: n => n === inner };
  const target = { closest: () => card };
  TaskBoard.onCardOver({ target, relatedTarget: inner });
  assert.strictEqual(timers.length, 0);
  TaskBoard.onCardOver({ target, relatedTarget: null });
  assert.strictEqual(TaskBoard._preview.id, 'a');
  TaskBoard.onCardOut({ target, relatedTarget: inner });
  assert.strictEqual(TaskBoard._preview.id, 'a');
  TaskBoard.onCardOut({ target, relatedTarget: {} });
  assert.strictEqual(TaskBoard._preview.id, null);
  TaskBoard.onCardOver({ target: { closest: () => null }, relatedTarget: null });
  assert.strictEqual(TaskBoard._preview.id, null);
});

test('after a re-render the preview stays only while the pointer is on its card or in it', async () => {
  const { timers, appended } = previewEnv({ cards: [{ id: 'a', project: 'p', sessionId: 's1' }], api: async () => ({ total: 0, messages: [] }) });
  let under = null;
  context.document.elementFromPoint = () => under;
  TaskBoard.onPointerMove({ clientX: 10, clientY: 20 });
  TaskBoard.hoverCard('a');
  await timers[0].fn();
  under = { closest: () => ({ dataset: { id: 'a' } }) };
  TaskBoard.checkPreview();
  assert.strictEqual(TaskBoard._preview.id, 'a');
  appended[0].contains = n => n === under;
  under = { closest: () => null };
  TaskBoard.checkPreview();
  assert.strictEqual(TaskBoard._preview.id, 'a');
  appended[0].contains = () => false;
  TaskBoard.checkPreview();
  assert.strictEqual(TaskBoard._preview.id, null);
  assert.ok(appended[0].removed);
});

test('opening or dragging a ticket closes its preview', () => {
  const { timers } = previewEnv({ cards: [], api: async () => ({}) });
  TaskBoard.board.cards = [{ id: 'a', project: 'p', sessionId: 's1', column: 'todo' }];
  TaskBoard.hoverCard('a');
  TaskBoard.onDragStart({ target: { closest: () => null } });
  assert.ok(timers[0].cleared);
  TaskBoard.hoverCard('a');
  const openEditor = TaskBoard.openEditor;
  TaskBoard.openEditor = () => {};
  TaskBoard.openCard('a');
  TaskBoard.openEditor = openEditor;
  assert.ok(timers[1].cleared);
  assert.strictEqual(TaskBoard._preview.id, null);
});

test('scrolling a preview near its end loads the older messages below, with a loader meanwhile', async () => {
  const calls = [];
  let release;
  const { timers, appended } = previewEnv({
    cards: [{ id: 'a', project: 'p', sessionId: 's1' }],
    api: async url => {
      calls.push(url);
      if (url.includes('offset=0&')) return { total: 30, hasMore: true, messages: [{ text: 'new' }, { text: 'mid' }] };
      await new Promise(r => { release = r; });
      return { total: 30, hasMore: false, messages: [{ text: 'old' }] };
    }
  });
  TaskBoard.hoverCard('a');
  await timers[0].fn();
  const el = appended[0];
  assert.strictEqual(el.list.innerHTML, '<msg>new</msg><msg>mid</msg>');
  el.onscroll();
  assert.strictEqual(calls.length, 1);
  el.scrollTop = 1300;
  const more = TaskBoard.loadPreviewPage(TaskBoard._preview);
  el.onscroll();
  assert.match(el.list.innerHTML, /tb-preview-loader/);
  release();
  await more;
  assert.deepStrictEqual(calls, ['/api/projects/p/sessions/s1?offset=0&limit=20', '/api/projects/p/sessions/s1?offset=2&limit=20']);
  assert.strictEqual(el.list.innerHTML, '<msg>new</msg><msg>mid</msg><msg>old</msg>');
  el.onscroll();
  assert.strictEqual(calls.length, 2);
});

test('new ticket and add lane use the shared project select', () => {
  const calls = [];
  let modal = null;
  Object.assign(context, {
    openModal: m => { modal = m; },
    formGroup: (label, input) => `<label>${label}</label>${input}`,
    setTimeout: () => {},
    toast: () => {},
    Projects: {
      data: [{ slug: 'C--work-zeta' }, { slug: 'C--work-alpha' }, { slug: 'C--work-new' }],
      selectHtml: (...args) => { calls.push(args); return `<select id="${args[0]}"></select>`; }
    }
  });
  TaskBoard.board = BOARD;
  TaskBoard.openEditor(null, 'C--work-alpha');
  assert.match(modal.body, /<select id="tb-project">/);
  assert.deepStrictEqual(calls[0].slice(0, 2), ['tb-project', 'C--work-alpha']);

  TaskBoard.openAddLane();
  assert.match(modal.body, /<select id="tb-lane-project">/);
  const [id, , { filter }] = calls[1];
  assert.strictEqual(id, 'tb-lane-project');
  assert.ok(filter('C--work-new'));
  assert.ok(!filter('C--work-zeta'));
});

test('add lane says so when every project already has one', () => {
  const toasts = [];
  let modal = null;
  Object.assign(context, {
    openModal: m => { modal = m; },
    toast: (...a) => toasts.push(a),
    Projects: { data: [{ slug: 'C--work-zeta' }], selectHtml: () => '' }
  });
  TaskBoard.board = BOARD;
  TaskBoard.openAddLane();
  assert.strictEqual(modal, null);
  assert.strictEqual(toasts[0][0], 'Every project already has a lane');
});

test('the preview message box sends to the ticket session, also while Claude works; Shift+Enter does not send', async () => {
  const { timers, appended } = previewEnv({ cards: [{ id: 'a', project: 'C--p', sessionSlug: 'C--p-wt', sessionId: 's1' }], api: async () => ({}) });
  const calls = [];
  let state = 'busy';
  context.api = async (url, opts) => {
    calls.push([url, opts && opts.body && opts.body.text]);
    if (url.endsWith('/input-state')) return { state };
    if (url.endsWith('/input')) return { ok: true };
    return { total: 0, messages: [] };
  };
  TaskBoard.hoverCard('a');
  await timers[0].fn();
  await new Promise(r => setImmediate(r));
  const el = appended[0];
  assert.strictEqual(el.text.disabled, false, 'busy: a message can still be sent');
  assert.strictEqual(el.note.textContent, 'working');
  el.text.value = 'line\nmore';
  let prevented = 0;
  el.text.onkeydown({ key: 'Enter', shiftKey: true, preventDefault: () => prevented++ });
  assert.strictEqual(prevented, 0);
  el.text.onkeydown({ key: 'Enter', shiftKey: false, preventDefault: () => prevented++ });
  await new Promise(r => setImmediate(r));
  assert.strictEqual(prevented, 1);
  assert.deepStrictEqual(calls.filter(c => c[1]), [['/api/projects/C--p-wt/sessions/s1/input', 'line\nmore']]);
  assert.strictEqual(el.text.value, '');
  state = 'question';
  await TaskBoard.loadPreviewInput(TaskBoard._preview);
  assert.strictEqual(el.text.disabled, true);
  assert.strictEqual(el.note.textContent, 'answer first');
});

test('the preview stays open while its message box has focus', async () => {
  const { timers, appended } = previewEnv({ cards: [{ id: 'a', project: 'p', sessionId: 's1' }], api: async () => ({ total: 0, messages: [] }) });
  TaskBoard.hoverCard('a');
  await timers[0].fn();
  const el = appended[0];
  context.document.activeElement = el.text;
  el.contains = n => n === el.text;
  context.document.elementFromPoint = () => null;
  TaskBoard.leavePreview();
  TaskBoard.checkPreview();
  assert.strictEqual(TaskBoard._preview.id, 'a');
  assert.ok(!el.removed);
  context.document.activeElement = null;
  el.text.onblur();
  assert.ok(el.removed, 'closes once the box loses focus with the pointer outside');
});
