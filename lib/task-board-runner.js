const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DATA_DIR, PROJECTS_DIR } = require('./paths');
const { writeDataJson } = require('./file-helpers');
const { decodeSlug } = require('./slug');
const board = require('./task-board');
const { renameSession } = require('./session-rename');

// Runs Task Board tickets: a ticket moved to Ready gets a background claude session (one at a time
// per lane) that works through the lane's stages. claude reports back through hooks loaded with
// --settings; each stage reply ends with a "CM-STAGE: …" line saying whether the stage is done.

const HOOKS_FILE = path.join(DATA_DIR, 'board-hooks.json');
const HOOK_SCRIPT = path.join(__dirname, '..', 'scripts', 'board-hook.js');
const HOOK_EVENTS = ['SessionStart', 'UserPromptSubmit', 'Stop', 'Notification'];
const MARKER_RE = /^[ \t>*_`]*CM-STAGE:\s*(done|needs_input|conflict)\b[ \t]*(.*)$/gim;
const SESSION_ID_RE = /^[A-Za-z0-9-]{8,80}$/;
// A ticket waits this long in Ready before it starts, so a wrong drag can still be undone.
const READY_DELAY_MS = 30000;

let driver = null;   // { spawn, bind, url, idleMs, maxWaitMs, readyDelayMs } once init() runs; until then nothing starts
const runs = new Map(); // card id -> { token, entry, sessionId, finishing }
let wakeTimer = null;

const fwd = p => p.replace(/\\/g, '/');

function writeHooksFile() {
  const command = `"${fwd(process.execPath)}" "${fwd(HOOK_SCRIPT)}"`;
  const hook = [{ hooks: [{ type: 'command', command, timeout: 10 }] }];
  writeDataJson(HOOKS_FILE, { hooks: Object.fromEntries(HOOK_EVENTS.map(e => [e, hook])) });
}

/** What one stage asks for, and how to report its result. The first stage leads with the ticket. */
function stageMessage(card, stages, index) {
  const stage = stages[index];
  const action = stage.type === 'skill' ? `Use the "${stage.ref}" skill for this stage.`
    : stage.type === 'agent' ? `Use the "${stage.ref}" subagent for this stage.`
    : stage.prompt;
  const extra = stage.type !== 'prompt' && stage.prompt ? '\n' + stage.prompt : '';
  const parts = [
    `[Task Board · stage ${index + 1}/${stages.length}: ${stage.title}]`,
    action + extra,
    'Do only this stage, and never push. When it is finished, end your reply with the line "CM-STAGE: done". '
      + 'If you need my answer or decision, end with "CM-STAGE: needs_input <short reason>"; '
      + 'for a merge conflict or another blocker, "CM-STAGE: conflict <short reason>".'
  ];
  if (index === 0) parts.unshift((card.notes || '').trim() || card.title);
  return parts.join('\n\n');
}

/** The last CM-STAGE line of a reply: { status, message }, or null when there is none. */
function parseMarker(text) {
  let last = null;
  for (const m of String(text || '').matchAll(MARKER_RE)) last = m;
  return last ? { status: last[1].toLowerCase(), message: last[2].replace(/[*_`]+$/, '').trim() } : null;
}

/** Text of the last assistant message in a session transcript under ~/.claude/projects. */
function lastAssistantText(transcriptPath) {
  const resolved = path.resolve(String(transcriptPath || ''));
  if (!resolved.startsWith(path.resolve(PROJECTS_DIR) + path.sep) || !resolved.endsWith('.jsonl')) return '';
  let lines;
  try { lines = fs.readFileSync(resolved, 'utf-8').split('\n'); }
  catch (_) { return ''; }
  for (let i = lines.length - 1; i >= 0; i--) {
    let entry;
    try { entry = JSON.parse(lines[i]); } catch (_) { continue; }
    if (entry.type !== 'assistant' || !entry.message) continue;
    const content = entry.message.content;
    const text = typeof content === 'string' ? content
      : Array.isArray(content) ? content.filter(c => c && c.type === 'text').map(c => c.text).join('\n') : '';
    if (text.trim()) return text;
  }
  return '';
}

function setRun(id, column, status, message) {
  return board.mutateCard(id, card => {
    if (column) card.column = column;
    card.run = { status, message: message || '', updatedAt: new Date().toISOString() };
  });
}

function stagesOf(b, card) {
  return (b.projects[card.project] && b.projects[card.project].stages) || [];
}

/**
 * Paste text into claude once its screen has settled, then press Enter. An Enter that follows the
 * paste too closely can be taken by the input box (autocomplete) instead of sending, so it waits a
 * moment, and presses again until claude's UserPromptSubmit hook confirms the message went out.
 */
function sendWhenIdle(run, cardId, text) {
  const { idleMs, maxWaitMs, enterDelayMs, submitCheckMs, submitTries } = driver;
  const startedAt = Date.now();
  const write = s => { try { run.entry.term.write(s); } catch (_) { /* the pty is gone; onEnd handles the card */ } };
  const press = tries => {
    if (run.entry.terminated || !run.awaitingSubmit) return;
    if (tries === submitTries) {
      setRun(cardId, null, 'needs_input', 'The message was not sent — open the session and press Enter');
      return;
    }
    write('\r');
    setTimeout(() => press(tries + 1), submitCheckMs);
  };
  const tick = () => {
    if (run.entry.terminated) return;
    const idle = Date.now() - run.entry.lastOutputAt >= idleMs;
    if (!idle && Date.now() - startedAt < maxWaitMs) { setTimeout(tick, Math.min(200, idleMs)); return; }
    run.awaitingSubmit = true;
    write('\x1b[200~' + text.replace(/\r\n/g, '\n') + '\x1b[201~');
    setTimeout(() => press(0), enterDelayMs);
  };
  tick();
}

function closeCard(id, message) {
  board.mutateCard(id, card => {
    card.column = 'todo';
    card.closed = true;
    card.run = { status: 'closed', message, updatedAt: new Date().toISOString() };
  });
}

function start(card, stages) {
  const projectPath = decodeSlug(card.project);
  if (!fs.existsSync(projectPath)) { closeCard(card.id, 'Project folder not found: ' + projectPath); return; }
  const token = crypto.randomBytes(16).toString('hex');
  let entry;
  try {
    writeHooksFile();
    entry = driver.spawn(projectPath, card.project, {
      args: ['--settings', HOOKS_FILE],
      env: { CM_BOARD_URL: driver.url, CM_BOARD_CARD: card.id, CM_BOARD_TOKEN: token }
    });
  } catch (e) {
    closeCard(card.id, 'Could not start claude: ' + e.message);
    return;
  }
  const run = { token, entry, sessionId: '', finishing: false, awaitingSubmit: false };
  runs.set(card.id, run);
  entry.onEnd = reason => onEnded(card.id, reason);
  board.mutateCard(card.id, c => {
    c.column = stages[0].id;
    c.closed = false;
    c.sessionId = null;
    c.run = { status: 'starting', message: '', updatedAt: new Date().toISOString() };
  });
}

/**
 * Start the first Ready ticket of every lane that has nothing running, once it has waited its
 * delay in Ready; wakes up again when the next waiting ticket is due.
 */
function schedule() {
  if (!driver) return;
  clearTimeout(wakeTimer);
  wakeTimer = null;
  const b = board.readBoard();
  let nextDue = Infinity;
  for (const [slug, lane] of Object.entries(b.projects)) {
    const stages = lane.stages || [];
    if (!stages.length) continue;
    const cards = b.cards.filter(c => c.project === slug);
    if (cards.some(c => runs.has(c.id) || stages.some(s => s.id === c.column))) continue;
    const next = cards.find(c => c.column === 'ready');
    if (!next) continue;
    const due = (Date.parse(next.readyAt) || 0) + driver.readyDelayMs;
    if (due <= Date.now()) start(next, stages);
    else nextDue = Math.min(nextDue, due);
  }
  if (nextDue !== Infinity) {
    wakeTimer = setTimeout(schedule, nextDue - Date.now());
    if (wakeTimer.unref) wakeTimer.unref();
  }
}

function finish(id, run) {
  run.finishing = true;
  runs.delete(id);
  const card = setRun(id, 'move-to-pr', 'done', '');
  run.entry.terminate('Workflow finished — the ticket is in Move to PR.');
  if (card && card.title && card.sessionId) {
    // After claude has exited, so the title line is not written while it still appends to the file.
    setTimeout(() => { try { renameSession(card.project, card.sessionId, card.title); } catch (_) {} }, 1000);
  }
  schedule();
}

function advance(id, run) {
  const b = board.readBoard();
  const card = b.cards.find(c => c.id === id);
  if (!card) return;
  const stages = stagesOf(b, card);
  const at = stages.findIndex(s => s.id === card.column);
  if (at === -1 || at === stages.length - 1) { finish(id, run); return; }
  setRun(id, stages[at + 1].id, 'running', '');
  sendWhenIdle(run, id, stageMessage(card, stages, at + 1));
}

function onEnded(id, reason) {
  const run = runs.get(id);
  if (!run || run.finishing) return;
  runs.delete(id);
  closeCard(id, 'Session ended: ' + reason);
  schedule();
}

/** A hook call from scripts/board-hook.js. Returns { ok } or { status, error }. */
function handleHook(body) {
  const run = runs.get(body.card);
  if (!run || typeof body.token !== 'string' || body.token !== run.token) return { status: 403, error: 'Unknown run' };
  const b = board.readBoard();
  const card = b.cards.find(c => c.id === body.card);
  if (!card) return { status: 404, error: 'Not found' };

  if (body.event === 'SessionStart') {
    // Also fires after /clear or a compaction; only the first one starts the workflow.
    if (run.sessionId || !SESSION_ID_RE.test(body.sessionId || '')) return { ok: true };
    run.sessionId = body.sessionId;
    driver.bind(run.entry, body.sessionId);
    board.mutateCard(card.id, c => {
      c.sessionId = body.sessionId;
      c.run = { status: 'running', message: '', updatedAt: new Date().toISOString() };
    });
    sendWhenIdle(run, card.id, stageMessage(card, stagesOf(b, card), 0));
  } else if (body.event === 'UserPromptSubmit') {
    run.awaitingSubmit = false;
    setRun(card.id, null, 'running', '');
  } else if (body.event === 'Notification') {
    setRun(card.id, null, 'needs_input', String(body.message || 'Claude is waiting for you').slice(0, 300));
  } else if (body.event === 'Stop') {
    const result = parseMarker(body.lastAssistantMessage || lastAssistantText(body.transcriptPath));
    if (!result) setRun(card.id, null, 'needs_input', 'Claude stopped without reporting the stage result');
    else if (result.status === 'done') advance(card.id, run);
    else setRun(card.id, null, result.status, result.message.slice(0, 300));
  }
  return { ok: true };
}

/** Stop a running ticket: its session ends, the ticket goes back to ToDo marked closed. */
function stop(id) {
  const run = runs.get(id);
  if (run) run.entry.terminate('Stopped from the Task Board.');
  else {
    const b = board.readBoard();
    const card = b.cards.find(c => c.id === id);
    if (!card) return { notFound: true };
    if (!stagesOf(b, card).some(s => s.id === card.column)) return { error: 'the ticket is not running' };
    closeCard(id, 'Stopped from the Task Board.');
  }
  return { card: board.readBoard().cards.find(c => c.id === id) };
}

/**
 * A ticket's session runs hidden from the active-session lists; opening it from the board makes
 * it a normal visible session.
 */
function reveal(id) {
  const run = runs.get(id);
  const card = board.readBoard().cards.find(c => c.id === id);
  if (!card) return { notFound: true };
  if (run && run.sessionId) driver.reveal(card.project, run.sessionId);
  return { ok: true };
}

/** The running ticket a session belongs to, or null. */
function cardForSession(sessionId) {
  const card = board.readBoard().cards.find(c => c.sessionId === sessionId && runs.has(c.id));
  return card || null;
}

/**
 * Turn the runner on. Tickets left inside a workflow by a previous CM process lost their session
 * with it, so they go back to ToDo marked closed; then waiting Ready tickets start.
 */
function init(opts) {
  driver = Object.assign({
    idleMs: 800, maxWaitMs: 15000, enterDelayMs: 1000, submitCheckMs: 3000, submitTries: 3, readyDelayMs: READY_DELAY_MS
  }, opts);
  const b = board.readBoard();
  for (const card of b.cards) {
    if (!runs.has(card.id) && stagesOf(b, card).some(s => s.id === card.column)) closeCard(card.id, 'Stopped: CM was restarted');
  }
  schedule();
}

function readyDelayMs() {
  return driver ? driver.readyDelayMs : READY_DELAY_MS;
}

function _reset() {
  clearTimeout(wakeTimer);
  wakeTimer = null;
  driver = null;
  runs.clear();
}

module.exports = {
  HOOKS_FILE, HOOK_EVENTS, readyDelayMs,
  init, schedule, handleHook, stop, reveal, cardForSession, stageMessage, parseMarker, lastAssistantText, _reset
};
