const express = require('express');
const { wrapRoute } = require('../lib/file-helpers');
const { validateTerminal, ptyAvailable, shellCommand, hasShellTerminal } = require('../lib/terminal-server');

const router = express.Router({ mergeParams: true });

router.get('/:slug/terminal/info', wrapRoute((req, res) => {
  const sessionId = (req.query.sessionId || '').toString();
  const mode = req.query.mode === 'shell' ? 'shell' : 'claude';
  const result = validateTerminal(req.params.slug, sessionId, mode);
  if (!result.ok) return res.status(result.status).json({ error: result.error });
  res.json({
    available: ptyAvailable(),
    projectPath: result.projectPath,
    sessionId: result.sessionId,
    mode: result.mode,
    shell: mode === 'shell' ? shellCommand().cmd : undefined,
    running: mode === 'shell' ? hasShellTerminal(req.params.slug) : undefined
  });
}));

module.exports = router;
