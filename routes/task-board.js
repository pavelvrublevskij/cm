const router = require('express').Router();
const { wrapRoute } = require('../lib/file-helpers');
const board = require('../lib/task-board');

function send(res, result) {
  if (result.notFound) return res.status(404).json({ error: 'Not found' });
  if (result.error) return res.status(400).json({ error: result.error });
  res.json(result);
}

/** GET /api/task-board — all cards, project lanes, and per-lane workflow status */
router.get('/', wrapRoute((req, res) => {
  const data = board.readBoard();
  res.json({ ...data, status: board.laneStatus(data) });
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
  send(res, board.moveCard(req.params.id, String(column || ''), index));
}));

/** DELETE /api/task-board/cards/:id — only from ToDo or Done; the card's session stays in history */
router.delete('/cards/:id', wrapRoute((req, res) => {
  send(res, board.deleteCard(req.params.id));
}));

/** PUT /api/task-board/lanes/:slug — add a project lane or change its settings ({ parallel }) */
router.put('/lanes/:slug', wrapRoute((req, res) => {
  send(res, board.setLane(req.params.slug, req.body || {}));
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
