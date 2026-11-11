const crypto = require('crypto');
const { TASK_BOARD_FILE } = require('./paths');
const { readJson, writeDataJson, safeSlug } = require('./file-helpers');

// Columns every lane has and the user can never remove. The project's workflow stages sit between
// Ready and Move to PR.
const FIXED_COLUMNS = ['todo', 'ready', 'move-to-pr', 'done'];
// Columns a card can be deleted from — anywhere else it is part of a running or finished workflow.
const DELETABLE_COLUMNS = ['todo', 'done'];
// Moves the user may make by hand; every other move belongs to the workflow runner.
const USER_MOVES = { todo: ['ready'], ready: ['todo'], 'move-to-pr': ['done'] };
const MAX_TITLE = 300;
const MAX_NOTES = 20000;

function readBoard() {
  const data = readJson(TASK_BOARD_FILE, {});
  return {
    cards: Array.isArray(data.cards) ? data.cards : [],
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
  Object.assign(card, fields, { updatedAt: new Date().toISOString() });
  writeBoard(board);
  return { card };
}

function laneColumns(board, project) {
  const stages = (board.projects[project] && board.projects[project].stages) || [];
  return ['todo', 'ready'].concat(stages.map(s => s.id), ['move-to-pr', 'done']);
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
  board.cards = board.cards.filter(c => c !== card);
  if (column !== card.column) {
    card.column = column;
    if (column === 'ready') card.closed = false;
    card.updatedAt = new Date().toISOString();
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

module.exports = {
  FIXED_COLUMNS, DELETABLE_COLUMNS, USER_MOVES,
  readBoard, createCard, updateCard, moveCard, deleteCard, setLane, removeLane
};
