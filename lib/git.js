const { execFile } = require('child_process');

const GIT_TIMEOUT_MS = 15000;
const GIT_MAX_BUFFER = 10 * 1024 * 1024;

// These calls have no TTY behind them, so any credential or editor prompt would block until the
// timeout instead of failing. Force git (and the common credential helpers) to give up instead.
const GIT_ENV = {
  GIT_TERMINAL_PROMPT: '0',
  GIT_ASKPASS: 'echo',
  SSH_ASKPASS: 'echo',
  GIT_SSH_COMMAND: 'ssh -oBatchMode=yes',
  GCM_INTERACTIVE: 'never',
  GIT_EDITOR: 'true',
  GIT_PAGER: 'cat'
};

function run(args, cwd, trim) {
  return new Promise((resolve, reject) => {
    const opts = {
      cwd,
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: GIT_MAX_BUFFER,
      windowsHide: true,
      env: Object.assign({}, process.env, GIT_ENV)
    };
    execFile('git', args, opts, (err, stdout, stderr) => {
      if (!err) return resolve(trim ? stdout.trimEnd() : stdout);
      if (err.killed || err.code === 'ETIMEDOUT' || err.signal) {
        return reject(new Error(
          `git ${args[0]} timed out after ${Math.round(GIT_TIMEOUT_MS / 1000)}s — ` +
          'it may be waiting for credentials. Run it in the terminal.'
        ));
      }
      reject(new Error(stderr.trim() || err.message));
    });
  });
}

/** Trailing whitespace trimmed, which is what every caller reading a value or a status wants. */
function git(args, cwd) {
  return run(args, cwd, true);
}

/**
 * Byte-for-byte stdout. File content must not be trimmed: comparing a trimmed HEAD against an
 * untrimmed working tree reports a phantom change on the last line of every file.
 */
function gitRaw(args, cwd) {
  return run(args, cwd, false);
}

/** True when cwd is inside a git work tree and the git binary is usable. */
async function gitOk(cwd) {
  if (!cwd) return false;
  try {
    await git(['rev-parse', '--git-dir'], cwd);
    return true;
  } catch (_) {
    return false;
  }
}

/** Upstream tracking branch plus commits ahead/behind it. Nulls when there is no upstream. */
async function upstreamStatus(cwd) {
  let upstream;
  try {
    upstream = await git(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], cwd);
  } catch (_) {
    return { upstream: null, ahead: null, behind: null };
  }
  try {
    const raw = await git(['rev-list', '--left-right', '--count', `${upstream}...HEAD`], cwd);
    const [behind, ahead] = raw.split(/\s+/).map(Number);
    return { upstream, ahead, behind };
  } catch (_) {
    return { upstream, ahead: null, behind: null };
  }
}

const UNIT_SEP = '\x1f';

/** The commits a push would send: HEAD..upstream, newest first. Empty without an upstream. */
async function unpushedCommits(cwd, upstream, limit = 20) {
  if (!upstream) return [];
  try {
    const raw = await git(['log', `--format=%h${UNIT_SEP}%s`, '-n', String(limit), `${upstream}..HEAD`], cwd);
    if (!raw) return [];
    return raw.split(/\r?\n/).filter(Boolean).map(line => {
      const idx = line.indexOf(UNIT_SEP);
      return { sha: line.slice(0, idx), subject: line.slice(idx + 1) };
    });
  } catch (_) {
    return [];
  }
}

/** Current branch name, or the short SHA when HEAD is detached. */
async function headInfo(cwd) {
  let branch = null;
  try { branch = await git(['rev-parse', '--abbrev-ref', 'HEAD'], cwd); } catch (_) {}
  if (branch !== 'HEAD') return { branch, detached: false };
  let sha = null;
  try { sha = await git(['rev-parse', '--short', 'HEAD'], cwd); } catch (_) {}
  return { branch: sha, detached: true };
}

function parseStatus(porcelain) {
  return porcelain.split(/\r?\n/).filter(Boolean).map(line => {
    if (line.length < 4) return null;
    const xy = line.slice(0, 2);
    let file = line.slice(3);

    // git quotes paths with special chars/spaces — strip quotes and unescape
    if (file.startsWith('"') && file.endsWith('"')) {
      file = file.slice(1, -1)
        .replace(/\\"/g, '"')
        .replace(/\\\\/g, '\\')
        .replace(/\\n/g, '\n')
        .replace(/\\t/g, '\t');
    }

    // For renames take destination path after " -> "
    const arrowIdx = file.indexOf(' -> ');
    if (arrowIdx !== -1) file = file.slice(arrowIdx + 4);

    let label;
    if (xy === '??') label = 'untracked';
    else if (xy[0] === 'D' || xy[1] === 'D') label = 'deleted';
    else if (xy[0] === 'A') label = 'new';
    else label = 'modified';
    return { path: file, xy, label };
  }).filter(Boolean);
}

module.exports = { git, gitRaw, gitOk, upstreamStatus, unpushedCommits, headInfo, parseStatus, GIT_ENV, GIT_TIMEOUT_MS };
