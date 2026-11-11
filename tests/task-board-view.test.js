const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const escapeHtml = t => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const decodeName = slug => slug.replace(/^[A-Za-z]--/, '').split('-').filter(Boolean).slice(-2).join('/');
const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'task-board.js'), 'utf-8');
const context = vm.createContext({ escapeHtml, escapeAttr: escapeHtml, decodeName });
vm.runInContext(src + '\nglobalThis._TaskBoard = TaskBoard;', context);
const TaskBoard = context._TaskBoard;

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
  assert.deepStrictEqual(ids, ['todo', 'ready', '', 'move-to-pr', 'done']);
  const staged = { projects: { p: { stages: [{ id: 'plan', title: 'Plan' }, { id: 'impl', title: 'Implement' }] } } };
  assert.deepStrictEqual(Array.from(TaskBoard.laneColumns(staged, 'p'), c => c.id), ['todo', 'ready', 'plan', 'impl', 'move-to-pr', 'done']);
});

test('only ToDo ↔ Ready and Move to PR → Done are manual moves', () => {
  assert.ok(TaskBoard.canMove({ column: 'todo' }, 'ready'));
  assert.ok(TaskBoard.canMove({ column: 'ready' }, 'todo'));
  assert.ok(TaskBoard.canMove({ column: 'move-to-pr' }, 'done'));
  assert.ok(TaskBoard.canMove({ column: 'done' }, 'done'));
  assert.ok(!TaskBoard.canMove({ column: 'todo' }, 'done'));
  assert.ok(!TaskBoard.canMove({ column: 'done' }, 'todo'));
  assert.ok(!TaskBoard.canMove({ column: 'ready' }, 'move-to-pr'));
});

test('the board renders chips, lanes, escaped cards and the closed badge', () => {
  const html = TaskBoard.html(BOARD, []);
  assert.strictEqual((html.match(/class="tb-lane"/g) || []).length, 2);
  assert.match(html, /Zeta &lt;task&gt;/);
  assert.match(html, /first line</);
  assert.ok(!html.includes('second'));
  assert.match(html, /tb-badge--closed">closed/);
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
  assert.deepStrictEqual(Array.from(TaskBoard.laneColumns(STAGED, 'p', true), c => c.title), ['ToDo', 'Ready', 'In progress', 'Move to PR', 'Done']);
  assert.match(TaskBoard.html(STAGED, [], true), /In progress <span class="tb-col-count">1</);
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

test('the workflow editor lists stages with type, reference and missing marker', () => {
  const html = TaskBoard.workflowHtml(WF);
  assert.strictEqual((html.match(/class="tb-wf-row"/g) || []).length, 2);
  assert.match(html, /value="Do &lt;it&gt;"/);
  assert.match(html, /tb-wf-ref tb-wf-ref--missing/);
  assert.match(html, /gone-skill \(missing\)/);
  assert.match(html, /writing-plans · project/);
  assert.ok(!html.includes('tester · global'), 'agents are not offered for a skill stage');
  assert.match(html, /Compare with recommended/);
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
