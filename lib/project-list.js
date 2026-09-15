const fs = require('fs');
const { decodeSlug } = require('./slug');
const { PROJECTS_DIR } = require('./paths');

/**
 * Every registered project as `{ slug, path }` — one entry per directory Claude Code has created
 * under ~/.claude/projects, with the slug decoded back to its filesystem path. Returns an empty
 * list when the projects directory is missing, so a fresh install reads as "no projects" rather
 * than throwing.
 */
function listProjectDirs() {
  try {
    return fs.readdirSync(PROJECTS_DIR, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => ({ slug: d.name, path: decodeSlug(d.name) }));
  } catch (_) {
    return [];
  }
}

module.exports = { listProjectDirs };
