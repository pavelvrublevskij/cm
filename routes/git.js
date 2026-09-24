const { Router } = require('express');
const { safeSlug, wrapRoute } = require('../lib/file-helpers');
const { decodeSlug, encodeSlug } = require('../lib/slug');
const { git, gitRaw, gitOk, gitInstalled, isSha, headInfo, upstreamStatus, unpushedCommits, incomingCommits, logCommits, commitDetail, parseStatus, diffNumstat, isValidBranchName, worktreeAdd } = require('../lib/git');
const { computeDiff } = require('../lib/diff');
const { resolveProjectPath } = require('../lib/project-files');
const { launchTerminal } = require('../lib/os-terminal');
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
async function attachFileStats(files, projectPath) {
  if (!files.length) return files;
  const numstat = await diffNumstat(projectPath);
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

  const { branch, detached } = await headInfo(projectPath);
  const { upstream, ahead, behind } = await upstreamStatus(projectPath);
  const unpushed = ahead ? await unpushedCommits(projectPath, upstream) : [];
  const incoming = behind ? await incomingCommits(projectPath, upstream) : [];

  let hasRemote = false;
  try { hasRemote = (await git(['remote'], projectPath)).length > 0; } catch (_) {}

  let files = [];
  try {
    const raw = await git(['status', '--porcelain', '--untracked-files=all'], projectPath);
    files = await attachFileStats(parseStatus(raw), projectPath);
  } catch (_) {}

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

/** Sibling folder for a new worktree: the repo's own folder name plus the branch, with any slash
 * in the branch (e.g. "fix/123") flattened so it can't create a nested directory. */
function deriveWorktreePath(projectPath, branch) {
  const repoName = path.basename(projectPath);
  const flatBranch = branch.replace(/[\\/]/g, '-');
  return path.join(path.dirname(projectPath), `${repoName}-${flatBranch}`);
}

/** Real path on disk, or the given path unchanged when it can't be resolved (e.g. doesn't exist). */
function realpathOrSelf(target) {
  try { return fs.realpathSync(target); } catch (_) { return target; }
}

/**
 * The slug the new worktree directory would resolve back to, or null when encoding it can't be
 * trusted — decodeSlug is a fuzzy, disk-based reverse of the same substitution, so the forward
 * encoding is verified by decoding it right back and checking it lands on the same directory
 * before it's ever handed to the terminal websocket.
 */
function verifiedSlug(worktreePath) {
  const candidate = encodeSlug(worktreePath);
  const decoded = decodeSlug(candidate);
  return decoded && realpathOrSelf(decoded) === realpathOrSelf(worktreePath) ? candidate : null;
}

/**
 * Creates a sibling git worktree on a new branch, so a second ticket can be worked in parallel
 * with no git commands typed by the user. Prefers handing back a slug the client can open as a
 * browser terminal, same as any other project's "New Session"; when that can't be verified, falls
 * back to opening an OS terminal directly, same as the existing OS-terminal session launcher.
 */
router.post('/:slug/git/worktree', wrapRoute(async (req, res) => {
  if (!safeSlug(req.params.slug)) return res.status(400).json({ error: 'Invalid slug' });
  const projectPath = decodeSlug(req.params.slug);
  if (!projectPath) return res.status(400).json({ error: 'Cannot resolve project path' });
  if (!(await gitOk(projectPath))) return res.status(400).json({ error: GIT_UNAVAILABLE });

  const branch = (req.body.branch || '').toString().trim();
  if (!isValidBranchName(branch)) return res.status(400).json({ error: 'Invalid branch name' });

  const worktreePath = deriveWorktreePath(projectPath, branch);
  if (fs.existsSync(worktreePath)) {
    return res.status(400).json({ error: `${worktreePath} already exists` });
  }

  try {
    await worktreeAdd(projectPath, worktreePath, branch);
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }

  const slug = verifiedSlug(worktreePath);
  if (slug) return res.json({ ok: true, path: worktreePath, slug });

  let terminalError;
  try { launchTerminal(worktreePath, 'claude'); } catch (e) { terminalError = e.message; }
  res.json({ ok: true, path: worktreePath, terminalError });
}));

module.exports = router;
