const { Router } = require('express');
const { safeSlug, wrapRoute } = require('../lib/file-helpers');
const { decodeSlug } = require('../lib/slug');
const { git, gitRaw, gitOk, gitInstalled, isSha, headInfo, upstreamStatus, unpushedCommits, logCommits, commitDetail, parseStatus } = require('../lib/git');
const { computeDiff } = require('../lib/diff');
const { resolveProjectPath } = require('../lib/project-files');
const fs = require('fs');

const router = Router();

// Every route answers the same way when git cannot be used, so an action never surfaces a raw
// spawn error like "spawn git ENOENT" to the user.
const GIT_UNAVAILABLE = 'Git is not available for this project';

/** Text read out of git or the working tree that is not text at all. */
function looksBinary(text) {
  return text.indexOf('\u0000') !== -1;
}

/** Why git cannot be used here: no binary on this machine, or a directory that is not a repository. */
async function unavailable(res) {
  const reason = (await gitInstalled()) ? 'not-a-repo' : 'git-missing';
  return res.json({ available: false, reason });
}

router.get('/:slug/git/info', wrapRoute(async (req, res) => {
  if (!safeSlug(req.params.slug)) return res.status(400).json({ error: 'Invalid slug' });
  const projectPath = decodeSlug(req.params.slug);
  if (!projectPath) return unavailable(res);

  if (!(await gitOk(projectPath))) return unavailable(res);

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
  if (!(await gitOk(projectPath))) return res.status(400).json({ error: GIT_UNAVAILABLE });

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
  if (!(await gitOk(resolved.root))) return res.status(400).json({ error: GIT_UNAVAILABLE });

  const sha = (req.query.sha || '').toString();
  if (sha && !isSha(sha)) return res.status(400).json({ error: 'Invalid commit' });

  // A commit diffs against its parent; the working tree diffs against HEAD.
  const before = sha ? `${sha}^:${resolved.rel}` : `HEAD:${resolved.rel}`;
  let oldText = '';
  try { oldText = await gitRaw(['show', before], resolved.root); } catch (_) { /* added in this commit */ }

  let newText = '';
  if (sha) {
    try { newText = await gitRaw(['show', `${sha}:${resolved.rel}`], resolved.root); } catch (_) { /* deleted */ }
  } else if (fs.existsSync(resolved.target) && fs.statSync(resolved.target).isFile()) {
    newText = fs.readFileSync(resolved.target).toString('utf-8');
  }

  if (looksBinary(oldText) || looksBinary(newText)) {
    return res.json({ path: resolved.rel, binary: true, hunks: [], stats: { added: 0, removed: 0 } });
  }

  res.json(Object.assign({ path: resolved.rel, sha: sha || null }, computeDiff(oldText, newText)));
}));

router.get('/:slug/git/log', wrapRoute(async (req, res) => {
  if (!safeSlug(req.params.slug)) return res.status(400).json({ error: 'Invalid slug' });
  const projectPath = decodeSlug(req.params.slug);
  if (!projectPath || !(await gitOk(projectPath))) return res.status(400).json({ error: GIT_UNAVAILABLE });

  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 200);
  const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
  const commits = await logCommits(projectPath, limit, offset);

  res.json({ commits, offset, limit, done: commits.length < limit });
}));

router.get('/:slug/git/commit/:sha', wrapRoute(async (req, res) => {
  if (!safeSlug(req.params.slug)) return res.status(400).json({ error: 'Invalid slug' });
  if (!isSha(req.params.sha)) return res.status(400).json({ error: 'Invalid commit' });
  const projectPath = decodeSlug(req.params.slug);
  if (!projectPath || !(await gitOk(projectPath))) return res.status(400).json({ error: GIT_UNAVAILABLE });

  res.json(await commitDetail(projectPath, req.params.sha));
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
    if (!(await gitOk(projectPath))) return res.status(400).json({ error: GIT_UNAVAILABLE });

    const output = await git(args, projectPath);
    res.json({ ok: true, output });
  }));
}

module.exports = router;
