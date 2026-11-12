const crypto = require('crypto');
const { TASK_BOARD_FILE, APP_CONFIG_FILE } = require('./paths');
const { readJson, writeDataJson, safeSlug } = require('./file-helpers');
const workflow = require('./task-board-workflow');

// Columns every lane has and the user can never remove. The project's workflow stages sit between
// Ready and Done.
const FIXED_COLUMNS = ['todo', 'ready', 'done'];
// Columns a card can be deleted from — anywhere else it is part of a running workflow.
const DELETABLE_COLUMNS = ['todo', 'done'];
// Moves the user may make by hand; every other move belongs to the workflow runner.
const USER_MOVES = { todo: ['ready'], ready: ['todo'] };
// How many tickets a Parallel lane runs at once (CM Settings); every other lane runs one.
const DEFAULT_MAX_PARALLEL = 3;
const MAX_PARALLEL_LIMIT = 10;
const MAX_TITLE = 300;
const MAX_NOTES = 20000;

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

function laneColumns(board, project) {
  const stages = (board.projects[project] && board.projects[project].stages) || [];
  return ['todo', 'ready'].concat(stages.map(s => s.id), ['done']);
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
  if (!DELETABLE_COLUMNS.includes(card.column)) return { error: 'only cards in ToDo or Done can be deleted' };
  board.cards = board.cards.filter(c => c !== card);
  writeBoard(board);
  return { ok: true };
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
    missing: workflow.missingRefs(lane.stages, available)
  };
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
 * (Claude asked something or hit a conflict), how many are still in Ready or a stage, and how many are Done.
 */
function attention(board) {
  const inStage = c => !FIXED_COLUMNS.includes(c.column) && !c.closed;
  return {
    waiting: board.cards
      .filter(c => inStage(c) && c.run && ['needs_input', 'conflict'].includes(c.run.status))
      .map(c => ({ id: c.id, project: c.project, sessionId: c.sessionId || '', status: c.run.status, message: c.run.message || '' })),
    active: board.cards.filter(c => c.column === 'ready' || inStage(c)).length,
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
  FIXED_COLUMNS, DELETABLE_COLUMNS, USER_MOVES, DEFAULT_MAX_PARALLEL,
  readBoard, createCard, updateCard, moveCard, deleteCard, setLane, removeLane,
  laneStatus, getWorkflow, saveWorkflow, dismissSkillsChange, mutateCard, attention, maxParallel, setMaxParallel
};
