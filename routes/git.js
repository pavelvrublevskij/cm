const { Router } = require('express');
const { safeSlug, wrapRoute } = require('../lib/file-helpers');
const { decodeSlug } = require('../lib/slug');
const { git, gitRaw, gitOk, gitInstalled, isSha, headInfo, upstreamStatus, unpushedCommits, incomingCommits, logCommits, commitDetail, parseStatus, diffNumstat, listBranches, listStashes } = require('../lib/git');
const { computeDiff } = require('../lib/diff');
const commitMessage = require('../lib/commit-message');
const insights = require('../lib/usage-insights');
const { resolveProjectPath } = require('../lib/project-files');
const fs = require('fs');
const path = require('path');

const router = Router();

// Every route answers the same way when git cannot be used, so an action never surfaces a raw
// spawn error like "spawn git ENOENT" to the user.
const GIT_UNAVAILABLE = 'Git is not available for this project';

// Above this, an untracked file's line count isn't worth reading synchronously on every panel
// refresh — same "too large to preview inline" cutoff used elsewhere for file content.
const UNTRACKED_STAT_MAX_BYTES = 1024 * 1024;

/** Text read out of git or the working tree that is not text at all. */
function looksBinary(text) {
  return text.indexOf('\u0000') !== -1;
}

/**
 * Attach an { added, removed } or { binary: true } stat to every file the status list reports, so
 * the "to commit" list can show it without a click. Tracked files come from one `git diff --numstat`
 * call; untracked files have no HEAD side for git to diff against, so their "added" count is just
 * their own line count, read directly (skipped past UNTRACKED_STAT_MAX_BYTES or when unreadable).
 */
function attachFileStats(files, projectPath, numstat) {
  if (!files.length) return files;
  for (const file of files) {
    file.stat = file.label === 'untracked'
      ? untrackedFileStat(path.join(projectPath, file.path))
      : (numstat[file.path] || null);
  }
  return files;
}

function untrackedFileStat(fullPath) {
  try {
    const st = fs.statSync(fullPath);
    if (!st.isFile() || st.size > UNTRACKED_STAT_MAX_BYTES) return null;
    const text = fs.readFileSync(fullPath, 'utf-8');
    if (looksBinary(text)) return { binary: true };
    if (!text) return { added: 0, removed: 0 };
    return { added: text.split('\n').length - (text.endsWith('\n') ? 1 : 0), removed: 0 };
  } catch (_) {
    return null;
  }
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

  // Each git call is a process spawn (slow on Windows), so independent ones run concurrently.
  const [{ branch, detached }, upstreamInfo, hasRemote, files] = await Promise.all([
    headInfo(projectPath),
    upstreamStatus(projectPath),
    git(['remote'], projectPath).then(out => out.length > 0, () => false),
    Promise.all([git(['status', '--porcelain', '--untracked-files=all'], projectPath), diffNumstat(projectPath)])
      .then(([raw, numstat]) => attachFileStats(parseStatus(raw), projectPath, numstat))
      .catch(() => [])
  ]);
  const { upstream, ahead, behind } = upstreamInfo;
  const [unpushed, incoming] = await Promise.all([
    ahead ? unpushedCommits(projectPath, upstream) : [],
    behind ? incomingCommits(projectPath, upstream) : []
  ]);

  res.json({ available: true, branch, detached, upstream, ahead, behind, unpushed, incoming, hasRemote, files });
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
 * POST { files, model, effort } — a commit message for the ticked files, written by the user's own
 * claude CLI from what committing them would record. Nothing is staged or committed here.
 */
router.post('/:slug/git/commit-message', wrapRoute(async (req, res) => {
  if (!safeSlug(req.params.slug)) return res.status(400).json({ error: 'Invalid slug' });
  const { files } = req.body || {};
  const model = (req.body && req.body.model) || 'default';
  const effort = (req.body && req.body.effort) || 'default';
  if (!Array.isArray(files) || !files.length) return res.status(400).json({ error: 'No files selected' });
  if (!insights.INSIGHT_MODELS.includes(model)) return res.status(400).json({ error: 'Unknown model: ' + model });
  if (!insights.INSIGHT_EFFORTS.includes(effort)) return res.status(400).json({ error: 'Unknown effort: ' + effort });
  const projectPath = decodeSlug(req.params.slug);
  if (!projectPath) return res.status(400).json({ error: 'Cannot resolve project path' });
  if (!(await gitOk(projectPath))) return res.status(400).json({ error: GIT_UNAVAILABLE });

  const changes = await commitMessage.collectChanges(projectPath, files);
  if (!changes.trim()) return res.status(400).json({ error: 'The selected files have no changes' });
  const subjects = await commitMessage.recentSubjects(projectPath);
  const text = await insights.runClaude(commitMessage.buildPrompt(changes, subjects), { model, effort });
  res.json({ message: commitMessage.cleanMessage(text) });
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

/** The project's repository path, or null once the refusal has already been sent. */
async function repoPath(req, res) {
  if (!safeSlug(req.params.slug)) { res.status(400).json({ error: 'Invalid slug' }); return null; }
  const projectPath = decodeSlug(req.params.slug);
  if (!projectPath || !(await gitOk(projectPath))) { res.status(400).json({ error: GIT_UNAVAILABLE }); return null; }
  return projectPath;
}

router.get('/:slug/git/branches', wrapRoute(async (req, res) => {
  const projectPath = await repoPath(req, res);
  if (!projectPath) return;
  res.json(await listBranches(projectPath));
}));

/**
 * Switch to a local branch, or to a remote one by creating the local branch that tracks it. Only a
 * name the branch list itself reports is accepted, so nothing user-typed reaches git as an argument.
 * With `stash`, uncommitted work (untracked files included) is stashed first; without it, git carries
 * the changes over or refuses when they would be overwritten.
 */
router.post('/:slug/git/checkout', wrapRoute(async (req, res) => {
  const projectPath = await repoPath(req, res);
  if (!projectPath) return;
  const { branch, remote, stash } = req.body;

  const { local, remote: remotes } = await listBranches(projectPath);
  const known = remote ? remotes.some(b => b.name === branch) : local.some(b => b.name === branch);
  if (!known) return res.status(400).json({ error: `Unknown branch: ${branch}` });

  const outputs = [];
  if (stash) outputs.push(await git(['stash', 'push', '-u', '-m', `Auto-stash before switching to ${branch}`], projectPath));
  outputs.push(await git(remote ? ['switch', '--track', branch] : ['switch', branch], projectPath));
  res.json({ ok: true, output: outputs.filter(Boolean).join('\n') });
}));

/** Create a branch from HEAD and switch to it; uncommitted changes come along. */
router.post('/:slug/git/branch', wrapRoute(async (req, res) => {
  const projectPath = await repoPath(req, res);
  if (!projectPath) return;
  const name = (req.body.name || '').trim();
  const valid = name && !name.startsWith('-')
    && await git(['check-ref-format', '--branch', name], projectPath).then(() => true, () => false);
  if (!valid) return res.status(400).json({ error: `Invalid branch name: ${name}` });

  const output = await git(['switch', '-c', name], projectPath);
  res.json({ ok: true, output });
}));

router.get('/:slug/git/stashes', wrapRoute(async (req, res) => {
  const projectPath = await repoPath(req, res);
  if (!projectPath) return;
  res.json({ stashes: await listStashes(projectPath) });
}));

router.post('/:slug/git/stash', wrapRoute(async (req, res) => {
  const projectPath = await repoPath(req, res);
  if (!projectPath) return;
  const message = (req.body.message || '').trim();
  const args = ['stash', 'push'];
  if (req.body.untracked) args.push('-u');
  if (message) args.push('-m', message);

  const output = await git(args, projectPath);
  res.json({ ok: true, output });
}));

const STASH_REF_RE = /^stash@\{\d+\}$/;

for (const op of ['apply', 'pop', 'drop']) {
  router.post(`/:slug/git/stash/${op}`, wrapRoute(async (req, res) => {
    const projectPath = await repoPath(req, res);
    if (!projectPath) return;
    const ref = req.body.ref;
    if (typeof ref !== 'string' || !STASH_REF_RE.test(ref)) return res.status(400).json({ error: 'Invalid stash' });

    const output = await git(['stash', op, ref], projectPath);
    res.json({ ok: true, output });
  }));
}

/** A branch with no upstream yet needs `-u origin <branch>` to set one on its first push. */
router.post('/:slug/git/push', wrapRoute(async (req, res) => {
  if (!safeSlug(req.params.slug)) return res.status(400).json({ error: 'Invalid slug' });
  const projectPath = decodeSlug(req.params.slug);
  if (!projectPath) return res.status(400).json({ error: 'Cannot resolve project path' });
  if (!(await gitOk(projectPath))) return res.status(400).json({ error: GIT_UNAVAILABLE });

  const { upstream } = await upstreamStatus(projectPath);
  let args = ['push'];
  if (!upstream) {
    const { branch } = await headInfo(projectPath);
    args = ['push', '-u', 'origin', branch];
  }

  const output = await git(args, projectPath);
  res.json({ ok: true, output });
}));

module.exports = router;
