const router = require('express').Router();
const { wrapRoute } = require('../lib/file-helpers');
const board = require('../lib/task-board');
const runner = require('../lib/task-board-runner');

function send(res, result) {
  if (result.notFound) return res.status(404).json({ error: 'Not found' });
  if (result.error) return res.status(400).json({ error: result.error });
  res.json(result);
}

/** GET /api/task-board — all cards, project lanes, and per-lane workflow status */
router.get('/', wrapRoute((req, res) => {
  const data = board.readBoard();
  res.json({ ...data, status: board.laneStatus(data), readyDelayMs: runner.readyDelayMs() });
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

/**
 * DELETE /api/task-board/cards/:id — only from ToDo or Done; the card's session stays in history.
 * Deleting a Done ticket also removes its worktree and branch: { ok, warning } when they had to stay.
 */
router.delete('/cards/:id', wrapRoute(async (req, res) => {
  const result = board.deleteCard(req.params.id);
  if (result.error || result.notFound) return send(res, result);
  const { card } = result;
  const warning = card.column === 'done' && card.worktree ? await runner.removeWorktree(card) : '';
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

module.exports = router;
