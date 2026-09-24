const path = require('path');
const fs = require('fs');

/**
 * Decode a Claude project slug back to a filesystem path.
 * Windows: C--Users-Name-code -> C:\Users\Name\code
 * Linux/Mac: home-user-code -> /home/user/code
 */
function decodeSlug(slug) {
  const winMatch = slug.match(/^([A-Za-z])--(.*)/i);
  if (winMatch) {
    return resolveSlugParts(winMatch[1] + ':\\', winMatch[2].split('-'), 0);
  }
  return resolveSlugParts('/', slug.split('-'), 0);
}

/**
 * Greedily matches the LONGEST run of remaining segments against a real directory entry before
 * falling back to a shorter one. Two sibling directories where one name is a hyphen-bounded prefix
 * of the other (e.g. "main-repo" and "main-repo-hotfix" — the default git-worktree naming pattern)
 * would otherwise resolve to the shorter one first and strand the rest as a bogus nested path.
 */
function resolveSlugParts(resolved, parts, index) {
  if (index >= parts.length) return resolved;

  // One listing per level, reused across every candidate length — decodeSlug runs for every project
  // on every project-list request, so re-reading the directory per candidate would be O(segments²)
  // syscalls on a deep path.
  const names = subdirNames(resolved);
  for (let end = parts.length; end > index; end--) {
    const candidate = parts.slice(index, end).join('-');
    const match = matchName(names, candidate);
    if (match) return resolveSlugParts(path.join(resolved, match), parts, end);
  }

  // Nothing on disk matches any combination of the remaining segments (e.g. the directory was
  // moved or deleted since the project was registered) — fall back to one literal joined segment.
  return path.join(resolved, parts.slice(index).join('-'));
}

/**
 * Names of the directories directly inside `dir`, or [] when it can't be read. Symlinks are
 * resolved rather than skipped: a Dirent reports a symlink as a link, not a directory, and project
 * paths legitimately run through symlinked folders.
 */
function subdirNames(dir) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return []; }

  return entries
    .filter(d => d.isDirectory() || (d.isSymbolicLink() && isDirectory(path.join(dir, d.name))))
    .map(d => d.name);
}

function isDirectory(fullPath) {
  try { return fs.statSync(fullPath).isDirectory(); } catch (_) { return false; }
}

/** Match a slug segment to a directory name, accounting for . _ and whitespace -> - encoding. */
function matchName(names, slug) {
  if (names.includes(slug)) return slug;
  return names.find(n => n.replace(/[._]/g, '-').replace(/\s/g, '-') === slug) || null;
}

module.exports = { decodeSlug };
