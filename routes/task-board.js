const router = require('express').Router();
const { wrapRoute } = require('../lib/file-helpers');
const board = require('../lib/task-board');
const runner = require('../lib/task-board-runner');
const { headInfo } = require('../lib/git');
const { decodeSlug } = require('../lib/slug');

function send(res, result) {
  if (result.notFound) return res.status(404).json({ error: 'Not found' });
  if (result.error) return res.status(400).json({ error: result.error });
  res.json(result);
}

/** Each lane's current git branch ('' without git or on a detached HEAD): where worktree tickets merge back. */
async function projectBranches(data) {
  const slugs = Object.keys(data.projects || {});
  const branches = await Promise.all(slugs.map(async slug => {
    const projectPath = decodeSlug(slug);
    if (!projectPath) return '';
    const { branch, detached } = await headInfo(projectPath);
    return detached ? '' : (branch || '');
  }));
  return Object.fromEntries(slugs.map((slug, i) => [slug, branches[i]]));
}

/** GET /api/task-board — all cards, project lanes, per-lane workflow status and current git branch */
router.get('/', wrapRoute(async (req, res) => {
  const data = board.readBoard();
  res.json({ ...data, status: board.laneStatus(data), projectBranches: await projectBranches(data), readyDelayMs: runner.readyDelayMs() });
}));

/** GET /api/task-board/attention — { waiting: tickets that need the user, active: tickets in Ready or a stage, inProgress: tickets in a stage, done } */
router.get('/attention', wrapRoute((req, res) => {
  res.json(board.attention(board.readBoard()));
}));

/** POST /api/task-board/cards — new card in ToDo */
router.post('/cards', wrapRoute((req, res) => {
  send(res, board.createCard(req.body || {}));
}));

/** PUT /api/task-board/cards/:id — edit title and description */
router.put('/cards/:id', wrapRoute((req, res) => {
  send(res, board.updateCard(req.params.id, req.body || {}));
}));

/** PUT /api/task-board/cards/:id/memo — { memo, todos: [{ text, done }] }: the user's own notes in Finalize or Done */
router.put('/cards/:id/memo', wrapRoute((req, res) => {
  send(res, board.updateMemo(req.params.id, req.body || {}));
}));

/** POST /api/task-board/cards/:id/move — { column, index } */
router.post('/cards/:id/move', wrapRoute((req, res) => {
  const { column, index } = req.body || {};
  const result = board.moveCard(req.params.id, String(column || ''), index);
  send(res, result);
  if (!result.error && !result.notFound) runner.schedule();
}));

/** POST /api/task-board/cards/:id/stop — end a running ticket's session; it goes back to ToDo, closed */
router.post('/cards/:id/stop', wrapRoute((req, res) => {
  send(res, runner.stop(req.params.id));
}));

/** POST /api/task-board/cards/:id/reveal — the ticket's session is being opened: list it like any running session */
router.post('/cards/:id/reveal', wrapRoute((req, res) => {
  send(res, runner.reveal(req.params.id));
}));

/** POST /api/task-board/cards/:id/hide — hide the opened session again; the ticket keeps running */
router.post('/cards/:id/hide', wrapRoute((req, res) => {
  send(res, runner.hide(req.params.id));
}));

/** GET /api/task-board/session/:sessionId — the running ticket this session belongs to and its stage, if any */
router.get('/session/:sessionId', wrapRoute((req, res) => {
  const card = runner.cardForSession(req.params.sessionId);
  res.json({ card, stage: card ? runner.stageOf(card) : null });
}));

/** POST /api/task-board/hook — events from scripts/board-hook.js, authenticated by the run's token */
router.post('/hook', wrapRoute((req, res) => {
  const result = runner.handleHook(req.body || {});
  if (result.error) return res.status(result.status).json({ error: result.error });
  res.json(result);
}));

/** POST /api/task-board/cards/:id/merge — merge a Finalize ticket's branch into its base (no squash); it goes to Done */
router.post('/cards/:id/merge', wrapRoute(async (req, res) => {
  send(res, await runner.merge(req.params.id));
}));

/** POST /api/task-board/cards/:id/pr — push a Finalize ticket's branch and create a PR into its base; it goes to Done */
router.post('/cards/:id/pr', wrapRoute(async (req, res) => {
  send(res, await runner.createPr(req.params.id));
}));

/**
 * DELETE /api/task-board/cards/:id — only from ToDo, Done or waiting in Finalize; the card's session
 * stays in history. Deleting a Finalize or Done ticket also removes its worktree and branch:
 * { ok, warning } when they had to stay.
 */
router.delete('/cards/:id', wrapRoute(async (req, res) => {
  const result = board.deleteCard(req.params.id);
  if (result.error || result.notFound) return send(res, result);
  const { card } = result;
  const warning = ['finalize', 'done'].includes(card.column) && card.worktree ? await runner.removeWorktree(card) : '';
  res.json({ ok: true, warning });
}));

/** PUT /api/task-board/lanes/:slug — add a project lane or change its settings ({ parallel }) */
router.put('/lanes/:slug', wrapRoute((req, res) => {
  const result = board.setLane(req.params.slug, req.body || {});
  send(res, result);
  if (!result.error && !result.notFound) runner.schedule();
}));

/** GET /api/task-board/settings — { maxParallel }: tickets a Parallel lane runs at once */
router.get('/settings', wrapRoute((req, res) => {
  res.json({ maxParallel: board.maxParallel() });
}));

/** PUT /api/task-board/settings — { maxParallel } */
router.put('/settings', wrapRoute((req, res) => {
  const result = board.setMaxParallel((req.body || {}).maxParallel);
  send(res, result);
  if (!result.error) runner.schedule();
}));

/** DELETE /api/task-board/lanes/:slug — only an empty lane */
router.delete('/lanes/:slug', wrapRoute((req, res) => {
  send(res, board.removeLane(req.params.slug));
}));

/** GET /api/task-board/lanes/:slug/workflow — stages, available skills/agents, recommended flow */
router.get('/lanes/:slug/workflow', wrapRoute((req, res) => {
  send(res, board.getWorkflow(req.params.slug));
}));

/** PUT /api/task-board/lanes/:slug/workflow — { stages } */
router.put('/lanes/:slug/workflow', wrapRoute((req, res) => {
  send(res, board.saveWorkflow(req.params.slug, (req.body || {}).stages));
}));

/** POST /api/task-board/lanes/:slug/workflow/dismiss — keep the stages after a skill change */
router.post('/lanes/:slug/workflow/dismiss', wrapRoute((req, res) => {
  send(res, board.dismissSkillsChange(req.params.slug));
}));

/** POST /api/task-board/lanes/:slug/workflow/check — { stages } from a saved or imported workflow → { stages, missing } */
router.post('/lanes/:slug/workflow/check', wrapRoute((req, res) => {
  send(res, board.checkStages(req.params.slug, (req.body || {}).stages));
}));

/** POST /api/task-board/lanes/:slug/workflows — { name, stages }: save a named workflow (replaces one of that name) */
router.post('/lanes/:slug/workflows', wrapRoute((req, res) => {
  const body = req.body || {};
  send(res, board.saveNamedWorkflow(req.params.slug, body.name, body.stages));
}));

/** DELETE /api/task-board/lanes/:slug/workflows/:name — remove a named workflow */
router.delete('/lanes/:slug/workflows/:name', wrapRoute((req, res) => {
  send(res, board.deleteNamedWorkflow(req.params.slug, req.params.name));
}));

module.exports = router;
