const router = require('express').Router();
const { wrapRoute } = require('../lib/file-helpers');
const { runHealthCheck } = require('../lib/health-check');
const mcpLive = require('../lib/mcp-live-check');

/** GET /api/health — read-only checks of the Claude Code setup (JSON, MCP, skills, CLAUDE.md, memories) */
router.get('/', wrapRoute((req, res) => {
  res.json(runHealthCheck());
}));

/**
 * POST /api/health/mcp-live — live MCP status via `claude mcp list` (connects to each server, no
 * model call). A POST because it starts the servers rather than just reading files.
 */
router.post('/mcp-live', wrapRoute(async (req, res) => {
  res.json(await mcpLive.liveMcpCheck());
}));

module.exports = router;
