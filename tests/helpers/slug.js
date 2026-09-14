/**
 * Encode a filesystem path the way Claude Code names its ~/.claude/projects directories — the
 * inverse of lib/slug.js's decodeSlug. Separators and dots both become dashes, which is exactly why
 * decoding needs the directory listing to disambiguate.
 *
 * Several older test files still carry their own copy of this; new tests should use this one.
 */
function slugForPath(fullPath) {
  const win = fullPath.match(/^([A-Za-z]):[\\/](.*)/);
  if (win) return `${win[1].toUpperCase()}--${win[2].replace(/[\\/.]/g, '-')}`;
  return fullPath.replace(/^\//, '').replace(/[/.]/g, '-');
}

module.exports = { slugForPath };
