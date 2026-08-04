const os = require('os');
const path = require('path');
const fs = require('fs');

const SCRATCHPAD_ROOT = path.join(os.tmpdir(), 'claude');

/** Resolve the scratchpad dir for a session, or null if slug/sessionId are unsafe. */
function safeScratchpadDir(slug, sessionId) {
  if (!slug || slug.includes('..') || slug.includes('/') || slug.includes('\\')) return null;
  if (!sessionId || sessionId.includes('..') || sessionId.includes('/') || sessionId.includes('\\')) return null;
  return path.join(SCRATCHPAD_ROOT, slug, sessionId, 'scratchpad');
}

/** Recursively list files under dir, returning relative paths (posix-style) with size/mtime. */
function listFiles(dir) {
  const results = [];
  function walk(current, rel) {
    let entries;
    try { entries = fs.readdirSync(current, { withFileTypes: true }); }
    catch (_) { return; }
    for (const entry of entries) {
      const abs = path.join(current, entry.name);
      const relPath = rel ? rel + '/' + entry.name : entry.name;
      if (entry.isDirectory()) {
        walk(abs, relPath);
      } else if (entry.isFile()) {
        try {
          const stat = fs.statSync(abs);
          results.push({ path: relPath, size: stat.size, mtime: stat.mtimeMs });
        } catch (_) {}
      }
    }
  }
  walk(dir, '');
  return results;
}

module.exports = { SCRATCHPAD_ROOT, safeScratchpadDir, listFiles };
