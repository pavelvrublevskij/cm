const fs = require('fs');
const path = require('path');

/**
 * Real .git directory shared by every worktree of a repo, or null when the path isn't a git
 * checkout. Reads the on-disk layout directly (.git file/dir, commondir) instead of shelling out
 * to git, so it works whether or not the git binary is installed.
 */
function gitCommonDir(projectPath) {
  const gitPath = path.join(projectPath, '.git');
  let stat;
  try { stat = fs.statSync(gitPath); } catch (_) { return null; }

  if (stat.isDirectory()) {
    try { return fs.realpathSync(gitPath); } catch (_) { return null; }
  }
  if (!stat.isFile()) return null;

  let gitDir;
  try {
    const content = fs.readFileSync(gitPath, 'utf-8');
    const match = content.match(/^gitdir:\s*(.+)$/m);
    if (!match) return null;
    gitDir = path.resolve(projectPath, match[1].trim());
  } catch (_) { return null; }

  try {
    const commondir = fs.readFileSync(path.join(gitDir, 'commondir'), 'utf-8').trim();
    return fs.realpathSync(path.resolve(gitDir, commondir));
  } catch (_) {
    try { return fs.realpathSync(gitDir); } catch (_) { return null; }
  }
}

/** Real filesystem path a project directory resolves to, following symlinks. Falls back to the
 * given path when it doesn't exist or can't be resolved. */
function realProjectPath(projectPath) {
  try { return fs.realpathSync(projectPath); } catch (_) { return projectPath; }
}

/** True when projectPath's own .git is a directory, i.e. it's the main worktree rather than a
 * linked one (whose .git is a file pointing at the common dir). */
function isMainWorktree(projectPath) {
  try { return fs.statSync(path.join(projectPath, '.git')).isDirectory(); } catch (_) { return false; }
}

/** True when projectPath itself is a symlink (as opposed to a real, non-worktree directory whose
 * realpath merely equals itself — every real directory satisfies that trivially). */
function isSymlinkPath(projectPath) {
  try { return fs.lstatSync(projectPath).isSymbolicLink(); } catch (_) { return false; }
}

const SYMLINK_SCAN_SKIP_DIRS = new Set([
  '.git', 'node_modules', '.idea', '.vscode', '.venv', 'venv', 'dist', 'build', '.next', 'target', '__pycache__'
]);
const SYMLINK_SCAN_MAX_DEPTH = 4;
const SYMLINK_SCAN_MAX_ENTRIES = 1000;

/**
 * Every directory symlink found within `rootPath`, a few levels deep, as `{ linkPath, target }`
 * where target is the resolved real path — e.g. a "project-repos/" style folder linking to sibling
 * repos. linkPath is kept because it is where the user actually sees that project living, which is
 * how the sidebar nests it. Bounded (skip list, depth, entry count) since this runs per project on
 * every project list request; a workspace umbrella folder with a handful of linked repos a couple of
 * levels deep is the target case, not an exhaustive crawl. Never descends into a symlinked directory
 * itself, both to avoid cycles and to avoid rescanning what is presumably another project's own tree.
 */
function findSymlinks(rootPath) {
  const results = [];
  let visited = 0;

  function walk(dir, depth) {
    if (depth > SYMLINK_SCAN_MAX_DEPTH || visited > SYMLINK_SCAN_MAX_ENTRIES) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
    for (const entry of entries) {
      if (visited++ > SYMLINK_SCAN_MAX_ENTRIES) return;
      if (SYMLINK_SCAN_SKIP_DIRS.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) {
        try {
          const target = fs.realpathSync(full);
          if (fs.statSync(target).isDirectory()) results.push({ linkPath: full, target });
        } catch (_) { /* broken symlink */ }
        continue;
      }
      if (entry.isDirectory()) walk(full, depth + 1);
    }
  }

  walk(rootPath, 0);
  return results;
}

module.exports = { gitCommonDir, realProjectPath, isMainWorktree, isSymlinkPath, findSymlinks };
