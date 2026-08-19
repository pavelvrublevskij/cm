const { Router } = require('express');
const { safeSlug, wrapRoute } = require('../lib/file-helpers');
const { decodeSlug } = require('../lib/slug');
const { git, gitOk, headInfo, upstreamStatus, unpushedCommits, parseStatus } = require('../lib/git');

const router = Router();

router.get('/:slug/git/info', wrapRoute(async (req, res) => {
  if (!safeSlug(req.params.slug)) return res.status(400).json({ error: 'Invalid slug' });
  const projectPath = decodeSlug(req.params.slug);
  if (!projectPath) return res.json({ available: false });

  if (!(await gitOk(projectPath))) return res.json({ available: false });

  const { branch, detached } = await headInfo(projectPath);
  const { upstream, ahead, behind } = await upstreamStatus(projectPath);
  const unpushed = ahead ? await unpushedCommits(projectPath, upstream) : [];

  let hasRemote = false;
  try { hasRemote = (await git(['remote'], projectPath)).length > 0; } catch (_) {}

  let files = [];
  try {
    const raw = await git(['status', '--porcelain'], projectPath);
    files = parseStatus(raw);
  } catch (_) {}

  res.json({ available: true, branch, detached, upstream, ahead, behind, unpushed, hasRemote, files });
}));

router.post('/:slug/git/commit', wrapRoute(async (req, res) => {
  if (!safeSlug(req.params.slug)) return res.status(400).json({ error: 'Invalid slug' });
  const { message, files } = req.body;
  if (!message || !message.trim()) return res.status(400).json({ error: 'Commit message required' });
  if (!Array.isArray(files) || !files.length) return res.status(400).json({ error: 'No files selected' });
  const projectPath = decodeSlug(req.params.slug);
  if (!projectPath) return res.status(400).json({ error: 'Cannot resolve project path' });

  await git(['add', '--', ...files], projectPath);
  const output = await git(['commit', '-m', message.trim()], projectPath);
  res.json({ ok: true, output });
}));

router.post('/:slug/git/push', wrapRoute(async (req, res) => {
  if (!safeSlug(req.params.slug)) return res.status(400).json({ error: 'Invalid slug' });
  const projectPath = decodeSlug(req.params.slug);
  if (!projectPath) return res.status(400).json({ error: 'Cannot resolve project path' });

  const output = await git(['push'], projectPath);
  res.json({ ok: true, output });
}));

module.exports = router;
