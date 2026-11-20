const fs = require('fs');
const { decodeSlug, parentSlug } = require('./slug');
const { PROJECTS_DIR, DATA_DIR } = require('./paths');

/** Claude Code's project folder name for a directory: every non-alphanumeric character becomes '-'. */
function slugForPath(dirPath) {
  return dirPath.replace(/[^a-zA-Z0-9]/g, '-');
}

/**
 * The app's own data dir becomes a Claude project once "Analyze efficiency" runs claude there.
 * It belongs to CM, not to the user, so it is left on disk but kept out of the project list.
 */
function isAppDataSlug(slug) {
  const own = slugForPath(DATA_DIR);
  return process.platform === 'win32' ? slug.toLowerCase() === own.toLowerCase() : slug === own;
}

/**
 * Every registered project as `{ slug, path }` — one entry per directory Claude Code has created
 * under ~/.claude/projects, with the slug decoded back to its filesystem path. Returns an empty
 * list when the projects directory is missing, so a fresh install reads as "no projects" rather
 * than throwing.
 */
function listProjectDirs() {
  try {
    return fs.readdirSync(PROJECTS_DIR, { withFileTypes: true })
      .filter(d => d.isDirectory() && !isAppDataSlug(d.name))
      .map(d => ({ slug: d.name, path: decodeSlug(d.name) }));
  } catch (_) {
    return [];
  }
}

/**
 * Claude worktrees (<project>/.claude/worktrees/<name>) whose folder is gone while their project is
 * still listed. They are kept out of the project list; their sessions are shown with the project.
 */
function removedWorktreeSlugs(projects) {
  const slugs = new Set(projects.map(p => p.slug));
  return new Set(projects
    .filter(p => parentSlug(p.slug) !== p.slug && slugs.has(parentSlug(p.slug)) && !fs.existsSync(p.path))
    .map(p => p.slug));
}

module.exports = { listProjectDirs, removedWorktreeSlugs, isAppDataSlug, slugForPath };
