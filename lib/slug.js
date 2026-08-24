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
    return resolveSlugParts(winMatch[1] + ':\\', winMatch[2].split('-'), 0, '');
  }
  return resolveSlugParts('/', slug.split('-'), 0, '');
}

function resolveSlugParts(resolved, parts, index, buffer) {
  if (index >= parts.length) {
    if (!buffer) return resolved;
    const match = findDirEntry(resolved, buffer);
    return path.join(resolved, match || buffer);
  }

  const segment = parts[index];
  const newBuffer = buffer ? buffer + '-' + segment : segment;

  if (buffer) {
    const match = findDirEntry(resolved, buffer);
    if (match) {
      const result = resolveSlugParts(path.join(resolved, match), parts, index, '');
      if (result) return result;
    }
  }

  return resolveSlugParts(resolved, parts, index + 1, newBuffer);
}

/** Match a slug segment to an actual directory entry, accounting for . and _ -> - encoding. */
function findDirEntry(dir, slug) {
  try {
    const entries = fs.readdirSync(dir);
    if (entries.includes(slug)) {
      const full = path.join(dir, slug);
      if (fs.statSync(full).isDirectory()) return slug;
    }
    for (const entry of entries) {
      const normalized = entry.replace(/[._]/g, '-').replace(/\s/g, '-');
      if (normalized === slug) {
        const full = path.join(dir, entry);
        if (fs.statSync(full).isDirectory()) return entry;
      }
    }
  } catch (_) { /* directory may not exist */ }
  return null;
}

module.exports = { decodeSlug };
