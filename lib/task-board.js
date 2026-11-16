const crypto = require('crypto');
const { TASK_BOARD_FILE, TASK_BOARD_WORKFLOWS_FILE, APP_CONFIG_FILE } = require('./paths');
const { readJson, writeDataJson, safeSlug } = require('./file-helpers');
const workflow = require('./task-board-workflow');

// Columns every lane has and the user can never remove. The project's workflow stages sit between
// Ready and Done.
const FIXED_COLUMNS = ['todo', 'ready', 'finalize', 'done'];
// Columns a running ticket moves through: its stages, then Finalize (commit, merge in, test).
const inWorkflow = column => column === 'finalize' || !FIXED_COLUMNS.includes(column);
// A worktree ticket that passed Finalize waits there, no longer running, to be merged or sent as a PR.
const isRunning = card => inWorkflow(card.column) && !card.finalized;
// Columns a card can be deleted from — anywhere else it is part of a running workflow. A Finalize
// ticket waiting to be merged can be deleted too.
const DELETABLE_COLUMNS = ['todo', 'done'];
const deletable = card => DELETABLE_COLUMNS.includes(card.column) || (card.column === 'finalize' && !!card.finalized);
// Moves the user may make by hand; every other move belongs to the workflow runner. Done → ToDo
// reopens a ticket whose manual test failed: it runs again in the same worktree.
const USER_MOVES = { todo: ['ready'], ready: ['todo'], done: ['todo'] };
// How many tickets a Parallel lane runs at once (CM Settings); every other lane runs one.
const DEFAULT_MAX_PARALLEL = 3;
const MAX_PARALLEL_LIMIT = 10;
const MAX_TITLE = 300;
const MAX_NOTES = 20000;
const MAX_WORKFLOW_NAME = 60;
// Columns where the user keeps own notes and to-dos on a ticket (never sent to Claude).
const MEMO_COLUMNS = ['finalize', 'done'];
const MAX_MEMO = 5000;
const MAX_TODOS = 50;
const MAX_TODO_TEXT = 300;

function readBoard() {
  const data = readJson(TASK_BOARD_FILE, {});
  const cards = Array.isArray(data.cards) ? data.cards : [];
  // The Move to PR column was removed: tickets left there are finished.
  cards.forEach(c => { if (c.column === 'move-to-pr') c.column = 'done'; });
  return {
    cards,
    projects: data.projects && typeof data.projects === 'object' ? data.projects : {}
  };
}

function writeBoard(board) {
  writeDataJson(TASK_BOARD_FILE, board);
}

function validProject(project) {
  return typeof project === 'string' && project !== '' && !!safeSlug(project);
}

/** Validate the editable card fields. Returns { fields } or { error }. */
function validateFields(body) {
  const title = String(body.title || '').trim();
  const notes = String(body.notes || '');
  if (!title && !notes.trim()) return { error: 'enter a title or a description' };
  if (title.length > MAX_TITLE) return { error: 'title is too long' };
  if (notes.length > MAX_NOTES) return { error: 'description is too long' };
  return { fields: { title, notes } };
}

function ensureLane(board, project) {
  if (!board.projects[project]) board.projects[project] = { parallel: false };
}

function createCard(body) {
  const { fields, error } = validateFields(body);
  if (error) return { error };
  const project = body.project;
  if (!project) return { error: 'project is required' };
  if (!validProject(project)) return { error: 'invalid project' };
  const board = readBoard();
  const now = new Date().toISOString();
  const card = { id: crypto.randomUUID(), ...fields, project, column: 'todo', closed: false, sessionId: null, createdAt: now, updatedAt: now };
  board.cards.push(card);
  ensureLane(board, project);
  writeBoard(board);
  return { card };
}

function updateCard(id, body) {
  const { fields, error } = validateFields(body);
  if (error) return { error };
  const board = readBoard();
  const card = board.cards.find(c => c.id === id);
  if (!card) return { notFound: true };
  if (card.column !== 'todo') return { error: 'A ticket can be edited only in ToDo' };
  Object.assign(card, fields, { updatedAt: new Date().toISOString() });
  writeBoard(board);
  return { card };
}

/** Save the user's own note and to-do list on a ticket in Finalize or Done. */
function updateMemo(id, body) {
  const memo = String(body.memo || '');
  if (memo.length > MAX_MEMO) return { error: 'note is too long' };
  if (!Array.isArray(body.todos || [])) return { error: 'todos must be a list' };
  const todos = (body.todos || []).map(t => ({ text: String((t && t.text) || '').trim(), done: !!(t && t.done) })).filter(t => t.text);
  if (todos.length > MAX_TODOS) return { error: 'too many to-dos' };
  if (todos.some(t => t.text.length > MAX_TODO_TEXT)) return { error: 'to-do is too long' };
  const board = readBoard();
  const card = board.cards.find(c => c.id === id);
  if (!card) return { notFound: true };
  if (!MEMO_COLUMNS.includes(card.column)) return { error: 'notes can be added only in Finalize or Done' };
  Object.assign(card, { memo, todos, updatedAt: new Date().toISOString() });
  writeBoard(board);
  return { card };
}

function laneColumns(board, project) {
  const stages = (board.projects[project] && board.projects[project].stages) || [];
  return ['todo', 'ready'].concat(stages.map(s => s.id), ['finalize', 'done']);
}

/**
 * Move a card by hand to `column` at position `index` among that lane's cards in the column
 * (appended when omitted). Reordering within a column is always allowed; changing column only along
 * USER_MOVES. Moving back to Ready clears the closed mark.
 */
function moveCard(id, column, index) {
  const board = readBoard();
  const card = board.cards.find(c => c.id === id);
  if (!card) return { notFound: true };
  if (!laneColumns(board, card.project).includes(column)) return { error: 'unknown column' };
  if (column !== card.column && !(USER_MOVES[card.column] || []).includes(column)) {
    return { error: `cannot move a card from ${card.column} to ${column}` };
  }
  if (column === 'ready' && !(board.projects[card.project].stages || []).length) {
    return { error: 'set up the workflow for this project first' };
  }
  board.cards = board.cards.filter(c => c !== card);
  if (column !== card.column) {
    card.column = column;
    card.updatedAt = new Date().toISOString();
    if (column === 'ready') {
      card.closed = false;
      card.readyAt = card.updatedAt;
    } else {
      delete card.readyAt;
    }
  }
  const peers = board.cards.filter(c => c.project === card.project && c.column === column);
  const at = Number.isInteger(index) && index >= 0 && index < peers.length ? board.cards.indexOf(peers[index]) : -1;
  if (at === -1) board.cards.push(card);
  else board.cards.splice(at, 0, card);
  writeBoard(board);
  return { card };
}

function deleteCard(id) {
  const board = readBoard();
  const card = board.cards.find(c => c.id === id);
  if (!card) return { notFound: true };
  if (!deletable(card)) return { error: 'only cards in ToDo, Done or waiting in Finalize can be deleted' };
  board.cards = board.cards.filter(c => c !== card);
  writeBoard(board);
  return { ok: true, card };
}

function setLane(project, body) {
  if (!validProject(project)) return { error: 'invalid project' };
  const board = readBoard();
  ensureLane(board, project);
  if (body.parallel !== undefined) board.projects[project].parallel = !!body.parallel;
  writeBoard(board);
  return { lane: board.projects[project] };
}

function removeLane(project) {
  const board = readBoard();
  if (!board.projects[project]) return { notFound: true };
  if (board.cards.some(c => c.project === project)) return { error: 'the lane still has cards' };
  delete board.projects[project];
  writeBoard(board);
  return { ok: true };
}

/** Per lane: whether its skills or agents changed since the workflow was saved, and stages whose skill is gone. */
function laneStatus(board) {
  const status = {};
  for (const [slug, lane] of Object.entries(board.projects)) {
    const available = workflow.availableFor(slug);
    const snapshot = workflow.snapshotOf(available);
    status[slug] = {
      skillsChanged: Array.isArray(lane.skillsSnapshot) && lane.skillsSnapshot.join('|') !== snapshot.join('|'),
      missing: workflow.missingRefs(lane.stages, available)
    };
  }
  return status;
}

function getWorkflow(project) {
  if (!validProject(project)) return { error: 'invalid project' };
  const board = readBoard();
  const lane = board.projects[project];
  if (!lane) return { notFound: true };
  const available = workflow.availableFor(project);
  return {
    stages: lane.stages || [],
    available,
    recommended: workflow.recommend(available),
    skillsChanged: laneStatus({ projects: { [project]: lane } })[project].skillsChanged,
    missing: workflow.missingRefs(lane.stages, available),
    saved: savedWorkflows(project)
  };
}

/**
 * Validate stages that come from a saved or imported workflow. A skill or agent the project does not
 * have is kept and reported in `missing`, for the editor to mark until the user picks another.
 */
function checkStages(project, input) {
  if (!validProject(project)) return { error: 'invalid project' };
  const available = workflow.availableFor(project);
  const refs = (Array.isArray(input) ? input : [])
    .filter(s => s && workflow.STAGE_TYPES.includes(s.type) && s.type !== 'prompt')
    .map(s => ({ kind: s.type, name: String(s.ref || '').trim() }))
    .filter(a => a.name);
  const { stages, error } = workflow.validateStages(input, available.concat(refs));
  if (error) return { error };
  return { stages, missing: workflow.missingRefs(stages, available) };
}

/** Named workflows saved for a project; they stay when its lane is removed. */
function savedWorkflows(project) {
  const list = readJson(TASK_BOARD_WORKFLOWS_FILE, {})[project];
  return Array.isArray(list) ? list : [];
}

/** Save the stages under a name; an existing workflow with that name is replaced. */
function saveNamedWorkflow(project, name, input) {
  name = String(name || '').trim();
  if (!name) return { error: 'enter a name' };
  if (name.length > MAX_WORKFLOW_NAME) return { error: 'name is too long' };
  const { stages, error } = checkStages(project, input);
  if (error) return { error };
  const all = readJson(TASK_BOARD_WORKFLOWS_FILE, {});
  const list = savedWorkflows(project).filter(w => w.name !== name);
  list.push({ name, stages, savedAt: new Date().toISOString() });
  list.sort((a, b) => a.name.localeCompare(b.name));
  all[project] = list;
  writeDataJson(TASK_BOARD_WORKFLOWS_FILE, all);
  return { saved: list };
}

function deleteNamedWorkflow(project, name) {
  if (!validProject(project)) return { error: 'invalid project' };
  const all = readJson(TASK_BOARD_WORKFLOWS_FILE, {});
  const list = savedWorkflows(project);
  if (!list.some(w => w.name === name)) return { notFound: true };
  all[project] = list.filter(w => w.name !== name);
  if (!all[project].length) delete all[project];
  writeDataJson(TASK_BOARD_WORKFLOWS_FILE, all);
  return { saved: all[project] || [] };
}

/** Replace the lane's stages. A stage that still holds tickets cannot be removed. */
function saveWorkflow(project, input) {
  if (!validProject(project)) return { error: 'invalid project' };
  const board = readBoard();
  const lane = board.projects[project];
  if (!lane) return { notFound: true };
  const available = workflow.availableFor(project);
  const { stages, error } = workflow.validateStages(input, available);
  if (error) return { error };
  const kept = new Set(stages.map(s => s.id));
  const stranded = (lane.stages || []).find(s => !kept.has(s.id) && board.cards.some(c => c.project === project && c.column === s.id));
  if (stranded) return { error: `stage "${stranded.title}" still has tickets` };
  lane.stages = stages;
  lane.skillsSnapshot = workflow.snapshotOf(available);
  writeBoard(board);
  return { stages };
}

/** Keep the current stages but stop flagging the skill change. */
function dismissSkillsChange(project) {
  if (!validProject(project)) return { error: 'invalid project' };
  const board = readBoard();
  const lane = board.projects[project];
  if (!lane) return { notFound: true };
  lane.skillsSnapshot = workflow.snapshotOf(workflow.availableFor(project));
  writeBoard(board);
  return { ok: true };
}

/** Change a card in place (for the workflow runner). Returns the updated card, or null when it is gone. */
function mutateCard(id, fn) {
  const board = readBoard();
  const card = board.cards.find(c => c.id === id);
  if (!card) return null;
  fn(card, board);
  card.updatedAt = new Date().toISOString();
  writeBoard(board);
  return card;
}

/**
 * What the board needs from the user, watched from every view: tickets in a stage waiting for them
 * (Claude asked something or hit a conflict), how many are still in Ready or a stage, how many are in a stage,
 * and how many are Done.
 */
function attention(board) {
  const inStage = c => isRunning(c) && !c.closed;
  return {
    waiting: board.cards
      .filter(c => inStage(c) && c.run && ['needs_input', 'conflict'].includes(c.run.status))
      .map(c => ({ id: c.id, project: c.project, sessionId: c.sessionId || '', sessionSlug: c.sessionSlug || '', status: c.run.status, message: c.run.message || '' })),
    active: board.cards.filter(c => c.column === 'ready' || inStage(c)).length,
    inProgress: board.cards.filter(inStage).length,
    done: board.cards.filter(c => c.column === 'done').length
  };
}

function maxParallel() {
  const n = readJson(APP_CONFIG_FILE, {}).boardMaxParallel;
  return Number.isInteger(n) && n >= 1 && n <= MAX_PARALLEL_LIMIT ? n : DEFAULT_MAX_PARALLEL;
}

function setMaxParallel(value) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > MAX_PARALLEL_LIMIT) {
    return { error: `Parallel tickets per project must be a whole number from 1 to ${MAX_PARALLEL_LIMIT}` };
  }
  const config = readJson(APP_CONFIG_FILE, {});
  config.boardMaxParallel = n;
  writeDataJson(APP_CONFIG_FILE, config);
  return { maxParallel: n };
}

module.exports = {
  FIXED_COLUMNS, DELETABLE_COLUMNS, MEMO_COLUMNS, USER_MOVES, DEFAULT_MAX_PARALLEL, inWorkflow, isRunning,
  readBoard, createCard, updateCard, updateMemo, moveCard, deleteCard, setLane, removeLane,
  laneStatus, getWorkflow, saveWorkflow, dismissSkillsChange, checkStages, savedWorkflows, saveNamedWorkflow, deleteNamedWorkflow, mutateCard, attention, maxParallel, setMaxParallel
};
