const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DATA_DIR, PROJECTS_DIR } = require('./paths');
const { writeDataJson, safeSlug } = require('./file-helpers');
const { decodeSlug } = require('./slug');
const { gitCommonDir } = require('./worktree-group');
const { git } = require('./git');
const board = require('./task-board');
const { renameSession } = require('./session-rename');

// Runs Task Board tickets: a ticket moved to Ready gets a background claude session that works
// through the lane's stages — one at a time per lane, or up to the parallel limit in a Parallel
// lane, where in a git project each ticket gets its own worktree (claude --worktree). claude
// reports back through hooks loaded with --settings; each stage reply ends with a "CM-STAGE: …"
// line saying whether the stage is done.

const HOOKS_FILE = path.join(DATA_DIR, 'board-hooks.json');
const HOOK_SCRIPT = path.join(__dirname, '..', 'scripts', 'board-hook.js');
const HOOK_EVENTS = ['SessionStart', 'UserPromptSubmit', 'Stop', 'Notification'];
const MARKER_RE = /^[ \t>*_`]*CM-STAGE:\s*(done|needs_input|conflict)\b[ \t]*(.*)$/gim;
const SESSION_ID_RE = /^[A-Za-z0-9-]{8,80}$/;
// A ticket waits this long in Ready before it starts, so a wrong drag can still be undone.
const READY_DELAY_MS = 30000;
// How often one ticket may enter the same stage; conditions can jump back, so this ends a loop.
const MAX_STAGE_VISITS = 3;

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
  const branches = stage.branches || [];
  const finished = branches.length
    ? 'When it is finished, end your reply with the line of the first condition that holds:\n'
      + branches.map((b, i) => `- if ${b.when}: "CM-STAGE: done #${i + 1}"`).join('\n')
      + '\n- otherwise: "CM-STAGE: done"\n'
    : 'When it is finished, end your reply with the line "CM-STAGE: done". ';
  const parts = [
    `[Task Board · stage ${index + 1}/${stages.length}: ${stage.title}]`,
    action + extra,
    'Do only this stage, and never push. ' + finished
      + 'If you need my answer or decision, end with "CM-STAGE: needs_input <short reason>"; '
      + 'for a merge conflict or another blocker, "CM-STAGE: conflict <short reason>".'
  ];
  if (index === 0) parts.unshift((card.notes || '').trim() || card.title);
  return parts.join('\n\n');
}

/** The last CM-STAGE line of a reply: { status, message, branch? }, or null when there is none. */
function parseMarker(text) {
  let last = null;
  for (const m of String(text || '').matchAll(MARKER_RE)) last = m;
  if (!last) return null;
  const result = { status: last[1].toLowerCase(), message: last[2].replace(/[*_`]+$/, '').trim() };
  const branch = result.status === 'done' && /^#(\d+)\b/.exec(result.message);
  if (branch) result.branch = Number(branch[1]);
  return result;
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

/**
 * The project folder (under ~/.claude/projects) a session transcript lives in. A ticket run in a
 * worktree has its session under the worktree's own slug, not the lane's.
 */
function sessionSlugOf(transcriptPath) {
  if (!transcriptPath) return '';
  const resolved = path.resolve(String(transcriptPath));
  const dir = path.dirname(resolved);
  if (path.dirname(dir) !== path.resolve(PROJECTS_DIR)) return '';
  const slug = path.basename(dir);
  return safeSlug(slug) ? slug : '';
}

/** Worktree a ticket of a Parallel lane runs in; stays the same, so a restarted ticket continues there. */
function worktreeName(card) {
  return 'cm-' + card.id.slice(0, 8);
}

const worktreePath = (projectPath, name) => path.join(projectPath, '.claude', 'worktrees', name);
const worktreeBranch = name => 'worktree-' + name;
const firstLine = text => String(text || '').split(/\r?\n/)[0];

/**
 * The ticket's worktree, branched from the branch the project is on now (claude --worktree would
 * branch from the default branch). An existing one is reused, so a restarted ticket continues its work.
 */
async function prepareWorktree(projectPath, card) {
  const name = worktreeName(card);
  const branch = worktreeBranch(name);
  const dir = worktreePath(projectPath, name);
  const base = await git(['rev-parse', '--abbrev-ref', 'HEAD'], projectPath);
  if (base === 'HEAD') throw new Error('the project is on a detached HEAD — check out a branch first');
  if (!fs.existsSync(dir)) {
    let hasBranch = true;
    try { await git(['rev-parse', '--verify', '--quiet', 'refs/heads/' + branch], projectPath); } catch (_) { hasBranch = false; }
    await git(hasBranch ? ['worktree', 'add', dir, branch] : ['worktree', 'add', '-b', branch, dir, base], projectPath);
  }
  return { name, branch, dir, base };
}

/**
 * Put the ticket into stage 1 and start its claude. In a Parallel lane of a git project it runs in
 * its own worktree, which is created first.
 */
function start(card, stages, lane) {
  const projectPath = decodeSlug(card.project);
  if (!fs.existsSync(projectPath)) { closeCard(card.id, 'Project folder not found: ' + projectPath); return; }
  board.mutateCard(card.id, c => {
    c.column = stages[0].id;
    c.closed = false;
    c.sessionId = null;
    c.sessionSlug = null;
    c.worktree = null;
    c.baseBranch = null;
    c.visits = { [stages[0].id]: 1 };
    c.branch = null;
    c.run = { status: 'starting', message: '', updatedAt: new Date().toISOString() };
  });
  if (!(lane.parallel && gitCommonDir(projectPath))) { launch(card, projectPath); return; }
  prepareWorktree(projectPath, card).then(wt => {
    const now = board.mutateCard(card.id, c => { c.worktree = wt.name; c.gitBranch = wt.branch; c.baseBranch = wt.base; });
    // Stopped while the worktree was being made.
    if (now && !now.closed && board.inWorkflow(now.column)) launch(card, wt.dir);
  }).catch(e => { closeCard(card.id, 'Could not create the worktree: ' + firstLine(e.message)); schedule(); });
}

function launch(card, cwd) {
  const token = crypto.randomBytes(16).toString('hex');
  let entry;
  try {
    writeHooksFile();
    entry = driver.spawn(cwd, card.project, {
      args: ['--settings', HOOKS_FILE],
      env: { CM_BOARD_URL: driver.url, CM_BOARD_CARD: card.id, CM_BOARD_TOKEN: token }
    });
  } catch (e) {
    closeCard(card.id, 'Could not start claude: ' + e.message);
    return;
  }
  const run = { token, entry, sessionId: '', finishing: false, awaitingSubmit: false, finishStep: false };
  runs.set(card.id, run);
  entry.onEnd = reason => onEnded(card.id, reason);
}

/**
 * Start Ready tickets in board order while their lane has room (one running ticket, or the
 * parallel limit in a Parallel lane), each once it has waited its delay in Ready; wakes up again
 * when the next waiting ticket is due.
 */
function schedule() {
  if (!driver) return;
  clearTimeout(wakeTimer);
  wakeTimer = null;
  const b = board.readBoard();
  const limit = board.maxParallel();
  let nextDue = Infinity;
  for (const [slug, lane] of Object.entries(b.projects)) {
    const stages = lane.stages || [];
    if (!stages.length) continue;
    const cards = b.cards.filter(c => c.project === slug);
    const room = (lane.parallel ? limit : 1) - cards.filter(c => runs.has(c.id) || board.inWorkflow(c.column)).length;
    for (const next of cards.filter(c => c.column === 'ready').slice(0, Math.max(room, 0))) {
      const due = (Date.parse(next.readyAt) || 0) + driver.readyDelayMs;
      if (due > Date.now()) { nextDue = Math.min(nextDue, due); break; }
      start(next, stages, lane);
    }
  }
  if (nextDue !== Infinity) {
    wakeTimer = setTimeout(schedule, nextDue - Date.now());
    if (wakeTimer.unref) wakeTimer.unref();
  }
}

function finish(id, run, message) {
  run.finishing = true;
  runs.delete(id);
  const card = setRun(id, 'done', 'done', message);
  run.entry.terminate('Workflow finished — the ticket is in Done.');
  if (card && card.title && card.sessionId) {
    // After claude has exited, so the title line is not written while it still appends to the file.
    setTimeout(() => { try { renameSession(card.sessionSlug || card.project, card.sessionId, card.title); } catch (_) {} }, driver.cleanupDelayMs);
  }
  schedule();
}

/**
 * A Done ticket was deleted: its worktree and branch go. The worktree stays as it was merged until
 * then, so a ticket moved back to ToDo after a failed manual test is fixed on the same branch.
 * Returns '' or why something had to stay (e.g. uncommitted changes in the worktree).
 */
async function removeWorktree(card) {
  const projectPath = decodeSlug(card.project);
  const dir = worktreePath(projectPath, card.worktree);
  try {
    // claude --worktree locks the worktrees it makes.
    try { await git(['worktree', 'unlock', dir], projectPath); } catch (_) { /* not locked */ }
    if (fs.existsSync(dir)) await git(['worktree', 'remove', dir], projectPath);
    await git(['branch', '-D', worktreeBranch(card.worktree)], projectPath);
    return '';
  } catch (e) {
    return `The worktree .claude/worktrees/${card.worktree} or its branch was kept: ${firstLine(e.message)}`;
  }
}

/**
 * The Finalize step every ticket goes through before Done: the project's tests run and pass. A
 * worktree ticket first commits its own changes and merges in the latest of its base branch.
 */
function finalizeMessage(card) {
  const tests = 'Run the project\'s tests (find the test command in package.json, a Makefile, CLAUDE.md or similar) '
    + 'and fix what this ticket broke until they pass. If the project has no tests, say so.';
  const parts = ['[Task Board · Finalize]'];
  if (card.worktree) {
    parts.push('Commit only the changes that belong to this ticket on this branch; leave anything unrelated uncommitted. '
      + `Then run "git merge ${card.baseBranch}" here to bring in the latest changes of the branch this ticket started from, `
      + 'resolve any conflicts and commit the result. Do not switch branches, and never push.',
    tests + ' Commit any fixes.');
  } else {
    parts.push(tests + ' Never push.');
  }
  parts.push('When everything passes, end your reply with the line "CM-STAGE: done". '
    + 'If you cannot resolve a conflict or a failing test, or need my decision, end with "CM-STAGE: conflict <short reason>" or "CM-STAGE: needs_input <short reason>".');
  return parts.join('\n\n');
}

/**
 * Squash the ticket's branch into its base branch in the project folder, as one local commit. Only
 * when the branch already holds the latest base (otherwise claude merges it in first), the project
 * folder is on the base branch and nothing is staged there; anything else waits for the user.
 */
async function mergeBack(id, run) {
  const card = board.readBoard().cards.find(c => c.id === id);
  if (!card) return;
  const projectPath = decodeSlug(card.project);
  const branch = worktreeBranch(card.worktree);
  const wait = why => setRun(id, null, 'needs_input', why + ' Then tell Claude to finish again.');
  setRun(id, null, 'running', 'Merging into ' + card.baseBranch);
  try {
    const head = await git(['rev-parse', '--abbrev-ref', 'HEAD'], projectPath);
    if (head !== card.baseBranch) return wait(`Your project folder is on "${head}": switch it back to "${card.baseBranch}".`);
    try { await git(['merge-base', '--is-ancestor', card.baseBranch, branch], projectPath); }
    catch (_) {
      setRun(id, null, 'running', `${card.baseBranch} has new changes; merging them in first`);
      sendWhenIdle(run, id, finalizeMessage(card));
      return;
    }
    try { await git(['diff', '--cached', '--quiet'], projectPath); }
    catch (_) { return wait('Your project folder has staged changes: commit or unstage them.'); }
    try { await git(['merge', '--squash', branch], projectPath); }
    catch (e) { return wait(`Could not merge into ${card.baseBranch}: ${firstLine(e.message)}.`); }
    let staged = false;
    try { await git(['diff', '--cached', '--quiet'], projectPath); } catch (_) { staged = true; }
    if (staged) await git(['commit', '-m', card.title || firstLine((card.notes || '').trim()) || 'Task Board ticket'], projectPath);
  } catch (e) {
    return wait(`Merging into ${card.baseBranch} failed: ${firstLine(e.message)}.`);
  }
  if (runs.get(id) === run) finish(id, run, 'Merged into ' + card.baseBranch);
}

/**
 * Go on from the finished stage: to the target of the condition claude picked (#n), otherwise along
 * its default arrow (a workflow saved before arrows: the next stage, or Done after the last one).
 */
function advance(id, run, branchNo) {
  const b = board.readBoard();
  const card = b.cards.find(c => c.id === id);
  if (!card) return;
  const stages = stagesOf(b, card);
  const at = stages.findIndex(s => s.id === card.column);
  // Finalize passed: a worktree ticket lands in its base branch on the way to Done.
  if (run.finishStep) { if (card.worktree) mergeBack(id, run); else finish(id, run, ''); return; }
  if (at === -1) { toFinalize(id, run, card); return; }
  const branch = branchNo ? (stages[at].branches || [])[branchNo - 1] : null;
  const to = branch ? branch.to : stages[at].next || (at === stages.length - 1 ? 'done' : stages[at + 1].id);
  if (to === 'done') { toFinalize(id, run, card); return; }
  const next = stages.findIndex(s => s.id === to);
  const visits = (card.visits && card.visits[to]) || 0;
  if (visits >= MAX_STAGE_VISITS) {
    setRun(id, null, 'needs_input', `Loop limit: stage "${stages[next].title}" already ran ${visits} times`);
    return;
  }
  board.mutateCard(id, c => {
    c.column = to;
    c.visits = Object.assign({}, c.visits, { [to]: visits + 1 });
    c.branch = branch ? { from: stages[at].title, when: branch.when } : null;
    c.run = { status: 'running', message: '', updatedAt: new Date().toISOString() };
  });
  sendWhenIdle(run, id, stageMessage(card, stages, next));
}

/** On the way to Done every ticket goes through Finalize. */
function toFinalize(id, run, card) {
  run.finishStep = true;
  setRun(id, 'finalize', 'running', card.worktree ? 'Commit, merge in ' + card.baseBranch + ', run the tests' : 'Run the tests');
  sendWhenIdle(run, id, finalizeMessage(card));
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
    const sessionSlug = sessionSlugOf(body.transcriptPath) || card.project;
    run.entry.slug = sessionSlug;
    driver.bind(run.entry, body.sessionId);
    board.mutateCard(card.id, c => {
      c.sessionId = body.sessionId;
      c.sessionSlug = sessionSlug;
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
    else if (result.status === 'done') advance(card.id, run, result.branch);
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
    if (!board.inWorkflow(card.column)) return { error: 'the ticket is not running' };
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
  if (run && run.sessionId) driver.reveal(run.entry.slug, run.sessionId);
  return { ok: true };
}

/** Hide and keep running: the opened session goes back out of the active-session lists. */
function hide(id) {
  const run = runs.get(id);
  if (!board.readBoard().cards.some(c => c.id === id)) return { notFound: true };
  if (run && run.sessionId) driver.hide(run.entry.slug, run.sessionId);
  return { ok: true };
}

/** The running ticket a session belongs to, or null. */
function cardForSession(sessionId) {
  const card = board.readBoard().cards.find(c => c.sessionId === sessionId && runs.has(c.id));
  return card || null;
}

/** The stage a running ticket is in: { index, total, title }, or null. */
function stageOf(card) {
  const stages = stagesOf(board.readBoard(), card);
  if (card.column === 'finalize') return { finalize: true, title: 'Finalize' };
  const index = stages.findIndex(s => s.id === card.column);
  return index === -1 ? null : { index, total: stages.length, title: stages[index].title };
}

/**
 * Turn the runner on. Tickets left inside a workflow by a previous CM process lost their session
 * with it, so they go back to ToDo marked closed; then waiting Ready tickets start.
 */
function init(opts) {
  driver = Object.assign({
    idleMs: 800, maxWaitMs: 15000, enterDelayMs: 1000, submitCheckMs: 3000, submitTries: 3, readyDelayMs: READY_DELAY_MS,
    cleanupDelayMs: 1500
  }, opts);
  const b = board.readBoard();
  for (const card of b.cards) {
    if (!runs.has(card.id) && board.inWorkflow(card.column)) closeCard(card.id, 'Stopped: CM was restarted');
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
  HOOKS_FILE, HOOK_EVENTS, MAX_STAGE_VISITS, readyDelayMs,
  init, schedule, handleHook, stop, reveal, hide, cardForSession, stageOf, removeWorktree, stageMessage, parseMarker, lastAssistantText, sessionSlugOf, _reset
};
