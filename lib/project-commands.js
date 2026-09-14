const fs = require('fs');
const path = require('path');
const { readFrontmatterFile } = require('./frontmatter');

// Custom slash commands live as plain .md files under .claude/commands/. A file in a subdirectory
// is namespaced the way Claude Code invokes it: commands/git/commit.md -> /git:commit.
const NAMESPACE_SEP = ':';

function listCommands(dir, prefix = '') {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...listCommands(full, prefix + entry.name + NAMESPACE_SEP));
      continue;
    }
    if (!entry.name.endsWith('.md')) continue;
    const name = prefix + entry.name.slice(0, -3);
    try {
      const { frontmatter } = readFrontmatterFile(full);
      out.push({ name, description: String(frontmatter.description || '') });
    } catch (_) {
      out.push({ name, description: '' });
    }
  }
  return out;
}

/** Resolve a command name back to its file, or null when it does not exist or escapes `dir`. */
function commandFile(dir, name) {
  if (!name || name.includes('/') || name.includes('\\')) return null;
  const file = path.join(dir, ...name.split(NAMESPACE_SEP)) + '.md';
  if (!path.resolve(file).startsWith(path.resolve(dir) + path.sep)) return null;
  return fs.existsSync(file) ? file : null;
}

module.exports = { listCommands, commandFile };
