const { Router } = require('express');
const { safeSlug, wrapRoute } = require('../lib/file-helpers');
const { decodeSlug } = require('../lib/slug');
const { git, gitRaw, gitOk, headInfo, upstreamStatus, unpushedCommits, parseStatus } = require('../lib/git');
const { computeDiff } = require('../lib/diff');
const { resolveProjectPath } = require('../lib/project-files');
const fs = require('fs');

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

/**
 * What committing this file would record: HEAD versus the working tree, which is what the panel
 * stages. An untracked file has no HEAD side and reads as all added; a deleted one has no working
 * side and reads as all removed. Binary content is reported rather than rendered as garbage.
 */
router.get('/:slug/git/diff', wrapRoute(async (req, res) => {
  const filePath = (req.query.path || '').toString();
  if (!filePath) return res.status(400).json({ error: 'Invalid file path' });

  const resolved = resolveProjectPath(req.params.slug, filePath);
  if (resolved.error) return res.status(resolved.status).json({ error: resolved.error });
  if (!(await gitOk(resolved.root))) return res.status(400).json({ error: 'Not a git repository' });

  let head = '';
  try { head = await gitRaw(['show', `HEAD:${resolved.rel}`], resolved.root); } catch (_) { /* untracked */ }

  let working = '';
  if (fs.existsSync(resolved.target) && fs.statSync(resolved.target).isFile()) {
    const buffer = fs.readFileSync(resolved.target);
    if (buffer.subarray(0, 8000).includes(0)) {
      return res.json({ path: resolved.rel, binary: true, hunks: [], stats: { added: 0, removed: 0 } });
    }
    working = buffer.toString('utf-8');
  }

  res.json(Object.assign({ path: resolved.rel }, computeDiff(head, working)));
}));

/**
 * The remote operations differ only by their argv, so they share one handler. Each is the safe
 * variant on purpose: pull refuses to create a merge commit, fetch prunes refs deleted upstream.
 * Anything that rewrites history stays in the shell, where the user can see and answer git.
 */
const REMOTE_OPS = {
  push: ['push'],
  pull: ['pull', '--ff-only'],
  fetch: ['fetch', '--prune'],
};

for (const [op, args] of Object.entries(REMOTE_OPS)) {
  router.post(`/:slug/git/${op}`, wrapRoute(async (req, res) => {
    if (!safeSlug(req.params.slug)) return res.status(400).json({ error: 'Invalid slug' });
    const projectPath = decodeSlug(req.params.slug);
    if (!projectPath) return res.status(400).json({ error: 'Cannot resolve project path' });

    const output = await git(args, projectPath);
    res.json({ ok: true, output });
  }));
}

module.exports = router;
